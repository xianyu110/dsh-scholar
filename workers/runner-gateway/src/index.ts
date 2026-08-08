/**
 * Runner execution surface (design §4.6.1 Runner safety contract).
 *
 * - The gateway only ever runs jobs it claimed from the Kernel (lease-based).
 * - Echo jobs are pure in-process: they execute nothing on the host.
 * - Smoke/baseline/pilot/formal jobs run under `timeout` in a fresh temp
 *   directory with a scrubbed environment. When a container runtime is
 *   available (`--mode docker`), the same job runs in `docker run` with
 *   `--network none`, non-root user and memory/CPU limits.
 * - Results are registered as content-addressed artifacts BEFORE the job is
 *   completed; the Kernel verifies manifest refs against its CAS.
 * @module @dsh-scholar/runner-gateway
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { createHash, randomUUID, sign, type KeyObject } from 'node:crypto'
import type { ResearchClient } from '@dsh-scholar/research-client'
import type { JobRecord } from '@dsh-scholar/research-schemas'

const execFileAsync = promisify(execFile)

export type RunnerMode = 'subprocess' | 'docker'

export interface RunnerSigningKey {
  /** Stable public identity, e.g. `runner-<hex>`; goes into the manifest as runner_key_id. */
  keyId: string
  /** Ed25519 private key used to sign the canonical RunManifest (design §12.7). */
  privateKey: KeyObject
}

export interface RunnerOptions {
  client: ResearchClient
  owner: string
  mode?: RunnerMode
  /** Subprocess/container timeout, ms. */
  timeoutMs?: number
  /** Max stdout+stderr bytes captured. */
  maxLogBytes?: number
  /** Abort to terminate the active execution (cancel support, design §12.6). */
  signal?: AbortSignal
  /** Ed25519 signing key for the RunManifest (design §12.7). */
  signingKey?: RunnerSigningKey
}

export interface RunOutcome {
  run_id: string
  exit_code: number
  started_at: string
  finished_at: string
  stdout: string
  stderr: string
  error?: string
}

/** Deterministic metrics extraction from stdout JSON-lines (`{"metric":...,"value":...}`). */
export function extractMetrics(stdout: string): Array<{ metric: string; value: number; seed?: number }> {
  const metrics: Array<{ metric: string; value: number; seed?: number }> = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as { metric?: unknown; value?: unknown; seed?: unknown }
      if (typeof parsed.metric === 'string' && typeof parsed.value === 'number') {
        metrics.push({
          metric: parsed.metric,
          value: parsed.value,
          ...typeof parsed.seed === 'number' && { seed: parsed.seed },
        })
      }
    } catch { /* not a metrics line */ }
  }
  return metrics
}

/**
 * §11.3 (SCH-EXEC-002): unpack a code-snapshot archive artifact (JSON
 * `{schema_version: 1, files: {rel: {sha256, content_base64}}}`) into
 * `Map<relativePath, Buffer>`. Verifies each entry's sha256 — a tampered or
 * truncated archive is rejected instead of silently materialized.
 */
export function unpackCodeSnapshot(content: string | Buffer): Map<string, Buffer> {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.isBuffer(content) ? content.toString('utf8') : content)
  } catch (error) {
    throw new Error(`code snapshot archive is not valid JSON: ${(error as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('code snapshot archive must be a JSON object')
  const record = parsed as { schema_version?: unknown; files?: unknown }
  if (record.schema_version !== 1) {
    throw new Error(`code snapshot archive has unsupported schema_version: ${String(record.schema_version)}`)
  }
  if (typeof record.files !== 'object' || record.files === null) {
    throw new Error('code snapshot archive is missing the files map')
  }
  const files = new Map<string, Buffer>()
  for (const [rel, info] of Object.entries(record.files)) {
    if (typeof rel !== 'string' || rel === '' || rel.startsWith('/') || rel.startsWith('..')) {
      throw new Error(`code snapshot archive contains an unsafe path: ${rel}`)
    }
    const entry = info as { sha256?: unknown; content_base64?: unknown }
    if (typeof entry.content_base64 !== 'string') continue
    const buf = Buffer.from(entry.content_base64, 'base64')
    if (typeof entry.sha256 === 'string' && entry.sha256 !== '') {
      const actual = createHash('sha256').update(buf).digest('hex')
      if (actual !== entry.sha256) {
        throw new Error(`code snapshot integrity mismatch for ${rel}: got ${actual}, archive claims ${entry.sha256}`)
      }
    }
    files.set(rel, buf)
  }
  return files
}

/**
 * §11.3 (SCH-EXEC-002): write an unpacked code snapshot into `workDir` with
 * path-traversal protection (every target must resolve inside workDir).
 * The container mounts workDir read-only at /work — this is the ONLY code
 * the Runner executes; agent host dirs are never mounted.
 */
export function materializeCodeSnapshot(files: Map<string, Buffer>, workDir: string): number {
  const absRoot = resolve(workDir)
  let count = 0
  for (const [rel, buf] of files) {
    const target = resolve(absRoot, rel)
    if (!target.startsWith(`${absRoot}${sep}`) && target !== absRoot) {
      throw new Error(`code snapshot path escapes workDir: ${rel}`)
    }
    mkdirSync(resolve(target, '..'), { recursive: true })
    writeFileSync(target, buf)
    count++
  }
  return count
}

/**
 * §12.5 (SCH-EXEC-002): parse the fixed-schema metrics file written
 * in-container to the output contract path:
 * `{schema_version: 1, run_id, contract_id, seed, metrics: [{name, value, unit}]}`.
 * Returns null when the file is absent or does not match the schema (the
 * caller then falls back to legacy stdout extraction).
 */
export interface MetricsFileRecord {
  schema_version: number
  run_id?: string
  contract_id?: string
  seed?: number
  metrics: Array<{ name?: string; metric?: string; value: number; unit?: string; seed?: number }>
}

export function parseMetricsFile(content: string): MetricsFileRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as { schema_version?: unknown; run_id?: unknown; contract_id?: unknown; seed?: unknown; metrics?: unknown }
  if (record.schema_version !== 1 || !Array.isArray(record.metrics)) return null
  const entries = record.metrics
    .map((m): { name?: string; metric?: string; value: number; unit?: string; seed?: number } | null => {
      if (typeof m !== 'object' || m === null) return null
      const entry = m as { name?: unknown; metric?: unknown; value?: unknown; unit?: unknown; seed?: unknown }
      if (typeof entry.value !== 'number') return null
      const name = typeof entry.name === 'string' ? entry.name : typeof entry.metric === 'string' ? entry.metric : undefined
      if (name === undefined) return null
      return {
        name,
        value: entry.value,
        ...typeof entry.unit === 'string' && { unit: entry.unit },
        ...typeof entry.seed === 'number' && { seed: entry.seed },
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
  if (entries.length === 0) return null
  return {
    schema_version: 1,
    ...typeof record.run_id === 'string' && { run_id: record.run_id },
    ...typeof record.contract_id === 'string' && { contract_id: record.contract_id },
    ...typeof record.seed === 'number' && { seed: record.seed },
    metrics: entries,
  }
}

/** Failure classification per design §4.6.2 (deterministic rules). */
export function classifyFailure(outcome: RunOutcome): { failure_class: JobRecord['failure_class']; error: string } {
  if (outcome.exit_code === 0) return { failure_class: null, error: '' }
  if (outcome.error !== undefined && /empty command/i.test(outcome.error)) {
    return { failure_class: 'code_error', error: outcome.error }
  }
  const combined = `${outcome.stderr}\n${outcome.stdout}`.toLowerCase()
  if (outcome.error !== undefined && /timed out|timeout/i.test(outcome.error)) {
    return { failure_class: 'resources', error: `job timed out: ${outcome.error}` }
  }
  if (/out of memory|killed|cannot allocate|no space left/i.test(combined)) {
    return { failure_class: 'resources', error: 'resource exhaustion detected' }
  }
  if (/leak|label shift|test set|train.*test.*overlap/i.test(combined)) {
    return { failure_class: 'data_issue', error: 'possible data leakage detected in output' }
  }
  if (/no module named|command not found|not found|error: cannot|syntaxerror|traceback/i.test(combined)) {
    return { failure_class: 'code_error', error: 'code/dependency error detected in output' }
  }
  if (/budget|quota|cost limit|insufficient funds/i.test(combined)) {
    return { failure_class: 'budget_exhausted', error: 'budget/quota signal detected in output' }
  }
  if (/environment|dependenc|cuda|driver|lib.*so/i.test(combined)) {
    return { failure_class: 'environment', error: 'environment/dependency issue detected in output' }
  }
  return { failure_class: 'unknown', error: `exit code ${outcome.exit_code}` }
}

/**
 * In-flight executions, keyed by job id, so a cancel request (design §12.6)
 * can reach the REAL process/container instead of only the lease.
 */
interface ActiveRun {
  child: ChildProcess
  /** Set when the execution is a `docker run`; `docker rm -f` removes it. */
  container?: string
}
const activeRuns = new Map<string, ActiveRun>()

/** Jobs whose execution was terminated by a cancel request. */
const cancelledJobs = new Set<string>()

/**
 * Terminate the actual execution of a claimed job: SIGKILL the subprocess /
 * docker CLI process tree and force-remove the container when one exists
 * (design §12.6 "Cancel 必须向执行器发送终止信号并确认容器已删除").
 * Executions are spawned as detached process-group leaders, so the SIGKILL
 * reaches the whole tree (`sh run.sh` → `node …`), not just the direct child.
 * Returns true when an execution was in flight.
 */
export function cancelRun(jobId: string): boolean {
  cancelledJobs.add(jobId)
  const entry = activeRuns.get(jobId)
  if (entry === undefined) return false
  const { child, container } = entry
  killProcessTree(child)
  if (container !== undefined) {
    // The docker CLI is already SIGKILLed above, so `--rm` will NOT run:
    // force-remove the container explicitly (idempotent with runDocker's
    // own cleanup in its finally block).
    void execFileAsync('docker', ['rm', '-f', container], { timeout: 10000 }).catch(() => undefined)
  }
  return true
}

/** True when a cancel request terminated this job's execution. */
export function isRunCancelled(jobId: string): boolean {
  return cancelledJobs.has(jobId)
}

/**
 * SIGKILL the whole execution tree. Children are spawned `detached` (process
 * group leaders), so killing the negative pid reaches every descendant
 * (e.g. `sh run.sh` → forked `node …`), with a direct-child fallback.
 */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  try { process.kill(-child.pid, 'SIGKILL') } catch { /* group already gone */ }
  try { child.kill('SIGKILL') } catch { /* already exited */ }
}

/**
 * Canonical JSON for manifest signing (design §12.7): top-level keys sorted,
 * no whitespace. `JSON.stringify(obj, keys)` serializes exactly the listed
 * keys in the given order — the verifier must use the same canonicalization.
 */
export function canonicalJson(manifest: Record<string, unknown>): string {
  return JSON.stringify(manifest, Object.keys(manifest).sort())
}

/** Sign the canonical RunManifest; returns signature/runner_key_id/payload_sha256. */
export function signManifest(manifest: Record<string, unknown>, key: RunnerSigningKey): Record<string, unknown> {
  const payloadSha256 = createHash('sha256').update(canonicalJson(manifest)).digest('hex')
  const signed = { ...manifest, runner_key_id: key.keyId, payload_sha256: payloadSha256 }
  // Ed25519 signs the raw payload directly: the one-shot `sign(null, ...)`
  // API (a digest name like 'ed25519' throws "Invalid digest"; the kernel
  // verifies with the matching `verify(null, ...)`).
  const signature = sign(null, Buffer.from(canonicalJson(signed), 'utf8'), key.privateKey).toString('base64')
  return { ...signed, signature }
}

interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number
  error?: string
}

interface SpawnCaptureOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
  maxLogBytes: number
  jobId: string
  signal?: AbortSignal
  /** Container name when this spawn is `docker run` (registered for cancelRun). */
  container?: string
}

/**
 * Manual spawn + promise wrapper that keeps the ChildProcess handle in
 * `activeRuns` so cancelRun() can SIGKILL it mid-flight (execFileAsync offers
 * no handle). Preserves the execFile semantics the runner relies on:
 * timeout -> SIGKILL + "timed out after Nms" error, maxBuffer -> kill, and
 * spawn failures surface as errors instead of rejects.
 */
function spawnCaptured(command: string[], options: SpawnCaptureOptions): Promise<SpawnResult> {
  const { cwd, env, timeoutMs, maxLogBytes, jobId, signal, container } = options
  return new Promise<SpawnResult>(resolve => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let timedOut = false
    let cancelled = false
    let bufferExceeded = false
    let spawnError: string | undefined
    let settled = false

    const child = spawn(command[0] ?? '', command.slice(1), {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // New process group: a later SIGKILL to -pid terminates the whole
      // execution tree (shell → actual command), not just the direct child.
      detached: true,
    })
    activeRuns.set(jobId, { child, container })

    const killTree = (): void => killProcessTree(child)

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)

    const onAbort = (): void => {
      if (signal?.aborted !== true || settled) return
      cancelled = true
      killTree()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      activeRuns.delete(jobId)
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      let error: string | undefined
      if (timedOut) error = `timed out after ${timeoutMs}ms`
      else if (cancelled) error = 'cancelled: execution terminated by cancel request'
      else if (bufferExceeded) error = `stdout maxBuffer exceeded (${maxLogBytes} bytes)`
      else if (spawnError !== undefined) error = spawnError
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        exitCode,
        error,
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > maxLogBytes) {
        bufferExceeded = true
        killTree()
        return
      }
      stdoutChunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      errBytes += chunk.length
      if (errBytes > maxLogBytes) {
        bufferExceeded = true
        killTree()
        return
      }
      stderrChunks.push(chunk)
    })
    child.on('error', (error: Error) => { spawnError = error.message })
    child.on('close', (code: number | null) => finish(code === null ? -1 : code))
  })
}

async function runSubprocess(command: string[], cwd: string, timeoutMs: number, maxLogBytes: number, jobId: string, signal?: AbortSignal): Promise<RunOutcome> {
  const startedAt = new Date().toISOString()
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: cwd,
    TMPDIR: cwd,
  }
  const result = await spawnCaptured(command, { cwd, env, timeoutMs, maxLogBytes, jobId, signal })
  return { run_id: `run_${randomUUID().slice(0, 12)}`, exit_code: result.exitCode, started_at: startedAt, finished_at: new Date().toISOString(), stdout: result.stdout, stderr: result.stderr, error: result.error }
}

async function runDocker(command: string[], cwd: string, timeoutMs: number, jobId: string, signal?: AbortSignal, image = 'node:22-alpine'): Promise<RunOutcome> {
  const startedAt = new Date().toISOString()
  const container = `dsh-scholar-${randomUUID().slice(0, 8)}`
  const args = [
    'run', '--rm', '--name', container,
    '--network', 'none',
    '--user', '65534:65534',
    '--memory', '1g', '--cpus', '1',
    '--workdir', '/work',
    '-v', `${cwd}:/work:ro`,
    // §12.2/§12.5 (SCH-EXEC-002): output contract — the container writes the
    // fixed-schema metrics file into /outputs (host: <cwd>/outputs, rw; the
    // runner reads it back after execution).
    '-v', `${cwd}/outputs:/outputs`,
    '--tmpfs', '/tmp:size=64m',
    image,
    ...command,
  ]
  let result: SpawnResult
  try {
    result = await spawnCaptured(['docker', ...args], {
      timeoutMs,
      maxLogBytes: 32 * 1024 * 1024,
      jobId,
      signal,
      container,
    })
  } finally {
    // `--rm` only cleans up when the docker CLIENT exits normally; if the
    // client is killed (timeout, cancel, gateway crash) the container survives
    // as an orphan. Force-remove it best-effort so runs never leak containers
    // (design §4.6.1 resource limits + cleanup, §12.6 cancel confirmation).
    await execFileAsync('docker', ['rm', '-f', container], { timeout: 10000 }).catch(() => undefined)
  }
  return { run_id: `run_${randomUUID().slice(0, 12)}`, exit_code: result.exitCode, started_at: startedAt, finished_at: new Date().toISOString(), stdout: result.stdout, stderr: result.stderr, error: result.error }
}

/**
 * Execute one claimed job and persist its outcomes as CAS artifacts.
 * Returns the completed Kernel job record.
 */
export async function executeJob(job: JobRecord, options: RunnerOptions): Promise<{ job: JobRecord; run: RunOutcome }> {
  const { client, owner, mode = 'subprocess', timeoutMs = 60000, maxLogBytes = 4 * 1024 * 1024, signal, signingKey } = options
  // §3.2 / ADR-004: formal-class jobs must run in a container runtime.
  // Subprocess is only for trusted smoke fixtures and echoes — never for
  // baseline/pilot/formal/reproduce (design §1.2 "明确不做", §12.3).
  const SECURE_KINDS: readonly string[] = ['baseline', 'pilot', 'formal', 'reproduce']
  if (SECURE_KINDS.includes(job.kind) && mode !== 'docker') {
    const rejected = await client.completeJob({
      job_id: job.job_id,
      owner,
      status: 'failed',
      failure_class: 'environment',
      error: `job kind ${job.kind} requires container execution (runner mode=docker); host subprocess is prohibited (v2 §3.2)`,
    }).catch(() => null)
    if (rejected !== null) return { job: rejected, run: {
      run_id: `run_${randomUUID().slice(0, 12)}`, exit_code: -1,
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      stdout: '', stderr: '', error: `rejected: ${job.kind} requires container execution`,
    } }
    throw new Error(`formal job ${job.job_id} rejected before execution (subprocess mode)`)
  }
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-scholar-run-'))
  // Container mode runs as a non-root uid (65534): the workdir and the
  // injected script must be world-traversable/readable for the container
  // user to reach them (mkdtempSync defaults to 0700).
  chmodSync(workDir, 0o755)

  // §12.2/§12.5 output contract: the container writes the fixed-schema
  // metrics file into /outputs (rw mount) — the host mirror is
  // <workDir>/outputs. uid 65534 must be able to write into it.
  const outputsDir = join(workDir, 'outputs')
  mkdirSync(outputsDir, { recursive: true })
  chmodSync(outputsDir, 0o777)

  // §11.3 (SCH-EXEC-002): materialize the bound code snapshot from the
  // Artifact Store. The Runner ONLY executes this materialized content —
  // agent host directories are never mounted into the container.
  const codeSnapshotId = (job as JobRecord & { code_snapshot_id?: string | null }).code_snapshot_id
  try {
    if (codeSnapshotId !== null && codeSnapshotId !== undefined && codeSnapshotId !== '') {
      const archiveText = await client.fetchArtifact(job.project_id, codeSnapshotId)
      if (archiveText === null) {
        throw new Error(`code snapshot artifact unreadable from CAS: ${codeSnapshotId} (project ${job.project_id})`)
      }
      const files = unpackCodeSnapshot(archiveText)
      const materialized = materializeCodeSnapshot(files, workDir)
      if (materialized === 0) {
        throw new Error(`code snapshot ${codeSnapshotId} materialized zero files`)
      }
    }
  } catch (error) {
    // Materialization failure: never run the job, clean up the temp dir.
    rmSync(workDir, { recursive: true, force: true })
    throw error
  }
  // §12.2: image digest from the JobSpec binding (kernel default: node:22-alpine).
  const image = typeof job.payload.image_digest === 'string' && job.payload.image_digest !== ''
    ? job.payload.image_digest
    : 'node:22-alpine'

  let run: RunOutcome
  if (job.kind === 'echo') {
    // Echo jobs execute nothing: pure in-process fixture (the ONLY kind that
    // may succeed without executing code — §3.2 invariant 1).
    const message = typeof job.payload.message === 'string' ? job.payload.message : `echo ${job.job_id}`
    run = {
      run_id: `run_${randomUUID().slice(0, 12)}`,
      exit_code: 0,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      stdout: message,
      stderr: '',
    }
  } else if (job.command.length === 0 && !(job.kind === 'smoke' && typeof job.payload.script === 'string')) {
    // §3.2 invariant 2 / P0-2: a non-echo job with no command must FAIL —
    // empty-command or message-only "success" is a synthetic fixture and is
    // prohibited for real experiments.
    run = {
      run_id: `run_${randomUUID().slice(0, 12)}`,
      exit_code: 2,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      stdout: '',
      stderr: '',
      error: 'empty command: non-echo jobs must execute real code (v2 §3.2)',
    }
  } else if (job.kind === 'smoke' && job.payload.script !== undefined && typeof job.payload.script === 'string') {
    // Injected smoke script runs inside the isolated workdir.
    writeFileSync(join(workDir, 'run.sh'), job.payload.script, { mode: 0o755 })
    run = mode === 'docker'
      ? await runDocker(['sh', '/work/run.sh'], workDir, timeoutMs, job.job_id, signal, image)
      : await runSubprocess(['sh', 'run.sh'], workDir, timeoutMs, maxLogBytes, job.job_id, signal)
  } else {
    const command = job.command.length > 0 ? job.command : ['true']
    run = mode === 'docker'
      ? await runDocker(command, workDir, timeoutMs, job.job_id, signal, image)
      : await runSubprocess(command, workDir, timeoutMs, maxLogBytes, job.job_id, signal)
  }

  // Cancel already landed (design §12.6): the kernel holds the authoritative
  // `cancelled` state — never complete it, never re-run the manifest path.
  if (cancelledJobs.has(job.job_id)) {
    const cancelled = await client.getJob(job.job_id).catch(() => job)
    return { job: cancelled, run }
  }

  try {
    const manifest: Record<string, unknown> = {
      run_id: run.run_id,
      project_id: job.project_id,
      // §12.7: contract_id is verified when present — a contract-less job must
      // NOT carry a null contract_id (the kernel treats a present null as a
      // mismatch), so it is emitted only for contract-bound jobs.
      ...job.contract_id !== null && { contract_id: job.contract_id },
      job_id: job.job_id,
      code_commit: job.payload.code_commit ?? '',
      code_snapshot_id: codeSnapshotId,
      container_digest: mode === 'docker' ? `docker:${image}` : '',
      data_hash: job.payload.data_hash ?? '',
      command: job.command,
      resources: { gpu: 0, cpu: 1, memory_gb: 1 },
      started_at: run.started_at,
      finished_at: run.finished_at,
      exit_code: run.exit_code,
    }

    const logContent = `=== dsh-scholar run ${run.run_id} (job ${job.job_id}, kind ${job.kind}) ===\nstarted: ${run.started_at}\nfinished: ${run.finished_at}\nexit: ${run.exit_code}\n\n--- stdout ---\n${run.stdout}\n\n--- stderr ---\n${run.stderr}\n${run.error !== undefined ? `\n--- error ---\n${run.error}\n` : ''}`
    const logArtifact = await client.registerArtifact({
      project_id: job.project_id,
      kind: 'log',
      content_base64: Buffer.from(logContent).toString('base64'),
      metadata: { run_id: run.run_id, job_id: job.job_id },
    })
    manifest.log_artifact = logArtifact.artifact_id

    // §12.5 (SCH-EXEC-002): formal metrics come from the fixed-schema metrics
    // FILE written in-container to the output contract path (host mirror:
    // <workDir>/outputs/<file>). The file is authoritative — stdout is only
    // logs. Legacy stdout JSON-line extraction remains as a fallback for old
    // fixtures that never write the file.
    let metrics: Array<{ metric: string; value: number; seed?: number }> = []
    let metricsFromFile: MetricsFileRecord | null = null
    const outputContract = job.payload.output_contract
    const metricsPath = typeof outputContract === 'object' && outputContract !== null
      ? (outputContract as Record<string, unknown>).metrics
      : undefined
    if (typeof metricsPath === 'string' && metricsPath !== '') {
      const rel = metricsPath.replace(/^\/outputs\/?/, '')
      try {
        const fileContent = readFileSync(join(outputsDir, rel), 'utf8')
        metricsFromFile = parseMetricsFile(fileContent)
      } catch { /* no metrics file written — fall back below */ }
    }
    if (metricsFromFile !== null) {
      // Map the §12.5 record into the artifact, injecting the top-level seed
      // into entries that lack their own (fixed-schema record shape).
      metrics = metricsFromFile.metrics.map(m => ({
        metric: m.name ?? m.metric ?? '',
        value: m.value,
        ...(m.seed !== undefined ? { seed: m.seed } : metricsFromFile!.seed !== undefined ? { seed: metricsFromFile!.seed } : {}),
      }))
    } else {
      metrics = extractMetrics(run.stdout)
    }
    if (metrics.length > 0 || run.exit_code === 0) {
      const metricsContent = metricsFromFile !== null
        ? JSON.stringify({
            schema_version: 1,
            run_id: metricsFromFile.run_id ?? run.run_id,
            job_id: job.job_id,
            contract_id: metricsFromFile.contract_id ?? job.contract_id ?? undefined,
            seed: metricsFromFile.seed,
            metrics: metricsFromFile.metrics.map(m => ({
              name: m.name ?? m.metric ?? '',
              value: m.value,
              unit: m.unit ?? '',
              seed: m.seed ?? metricsFromFile!.seed,
            })),
            source: 'metrics-file',
          }, null, 2)
        : JSON.stringify({ run_id: run.run_id, job_id: job.job_id, metrics }, null, 2)
      const metricsArtifact = await client.registerArtifact({
        project_id: job.project_id,
        kind: 'analysis',
        content_base64: Buffer.from(metricsContent).toString('base64'),
        metadata: {
          run_id: run.run_id, job_id: job.job_id, metrics: metrics.length,
          source: metricsFromFile !== null ? 'metrics-file' : 'stdout-json',
        },
      })
      manifest.metrics_artifact = metricsArtifact.artifact_id
    }

    const { failure_class, error: failureError } = classifyFailure(run)
    // §12.6 fencing: record the claim's generation inside the manifest so the
    // kernel can reject stale runners that somehow complete late.
    manifest.lease = { generation: job.lease_generation, token: job.lease_token }
    // Sign the final manifest (design §12.7): signature over the canonical
    // JSON excluding `signature`; payload_sha256 over the canonical JSON
    // before the signing fields are attached. The kernel verifies both.
    const finalManifest = signingKey !== undefined
      ? signManifest({ ...manifest, signed_by: owner }, signingKey)
      : { ...manifest, signed_by: owner }
    if (run.exit_code === 0 && failure_class === null) {
      const completed = await client.completeJob({
        job_id: job.job_id,
        owner,
        status: 'succeeded',
        run_manifest: finalManifest,
        lease_generation: job.lease_generation,
        lease_token: job.lease_token,
      })
      return { job: completed, run }
    }
    const completed = await client.completeJob({
      job_id: job.job_id,
      owner,
      status: 'failed',
      failure_class,
      error: failureError || run.error || `exit code ${run.exit_code}`,
      run_manifest: finalManifest,
      lease_generation: job.lease_generation,
      lease_token: job.lease_token,
    })
    return { job: completed, run }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

/** Keep a lease alive while a job runs (best effort; §12.6 fencing echoes the claim's generation/token). */
export async function heartbeatLoop(jobId: string, owner: string, client: ResearchClient, intervalMs = 20000, signal: AbortSignal, leaseGeneration?: number | null, leaseToken?: string | null): Promise<void> {
  const timer = setInterval(() => {
    void client.heartbeatJob(jobId, owner, leaseGeneration ?? null, leaseToken ?? null).catch(() => undefined)
  }, intervalMs)
  signal.addEventListener('abort', () => clearInterval(timer), { once: true })
}
