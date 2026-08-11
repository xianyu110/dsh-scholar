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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import type { ResearchClient } from '@dsh-scholar/research-client'
import type { JobRecord } from '@dsh-scholar/research-schemas'
import { buildExecutionPlan, computeProfileConfigHash, getRunnerProfile, signExecutionPlan, type ExecutionPlan, type RunnerProfile } from '@dsh-scholar/research-schemas'
import { LocalDockerAdapter, buildLocalDockerArgs, type DockerExecContext, type RunOutcome } from './execution-target.js'
import { appendTerminalFramesWithLease } from './kernel-client.js'
import { canonicalJson, signManifest, type RunnerSigningKey } from './manifest-signing.js'
import { materializeCodeSnapshot, unpackCodeSnapshot } from './snapshot-materialize.js'

const execFileAsync = promisify(execFile)

/** §4 P0 (RUN-01): a claimed job carries the durable per-attempt run_id that
 * the kernel wrote into its `runs` ledger at claim time. */
export type ClaimedJobRecord = JobRecord & { run_id?: string | null }

/**
 * appendTerminalFramesWithLease 已迁入 ./kernel-client.js（远端 fleet 服务端
 * 转发 frames 共用同一 lease 头路径），此处保持 re-export。
 */
export { appendTerminalFramesWithLease } from './kernel-client.js'

/**
 * §4 P0 (RUN-02/TEX-02): the TeX build engine is a FIXED enum — a raw string
 * is never spliced into the build script. Mirrors the kernel whitelist.
 */
const TEX_ENGINES: readonly string[] = ['pdflatex', 'lualatex', 'xelatex', 'bibtex', 'biber']

/** §4 (TEX-02): shell metacharacters banned from TeX build paths. */
const TEX_SHELL_META = /[;&|`$"'\\ \t\n]/

/** §4 (TEX-02): a TeX build path must be root-relative (inside the frozen
 * workspace), free of `..` segments and shell metacharacters. */
function assertSafeTexPath(path: string): void {
  if (path === '' || path.startsWith('/') || path.split('/').some(part => part === '..')) {
    throw new Error(`tex snapshot contains an unsafe path: ${path}`)
  }
  if (TEX_SHELL_META.test(path)) {
    throw new Error(`tex snapshot path contains shell metacharacters: ${path}`)
  }
}

/**
 * §4 P0 (RUN-02): resolve the output-contract metrics path to a readable file
 * STRICTLY inside the outputs directory. `../` escapes, absolute paths and
 * symlinks pointing outside outputs return null — a malicious job must never
 * read host files through the metrics path. The caller treats null as a
 * failed output-contract validation.
 */
export function resolveMetricsFileWithin(outputsDir: string, metricsPath: string): string | null {
  const rel = metricsPath.replace(/^\/outputs\/?/, '')
  const absOutputs = resolve(outputsDir)
  const target = resolve(absOutputs, rel)
  if (!target.startsWith(`${absOutputs}${sep}`)) return null
  try {
    // realpath re-check: a container-created symlink may resolve outside.
    const real = realpathSync(target)
    if (!real.startsWith(`${realpathSync(absOutputs)}${sep}`)) return null
    return real
  } catch {
    return null // missing/unreadable file
  }
}

export type RunnerMode = 'subprocess' | 'docker'

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
  /** §12.6 lease generation of the claim; carried on terminal frames. */
  leaseGeneration?: number | null
}

/**
 * 一次执行的确定性结果（RunOutcome 定义与 ExecutionTarget port 同文件，
 * 见 execution-target.ts——port 的 wait() 返回同一形状）。
 * 兼容 re-export 保持既有导入路径不变。
 */
export type { RunOutcome } from './execution-target.js'

/**
 * RUN-REMOTE-01（接口层）——ExecutionTarget port 与远端 fleet 的
 * gateway 侧实现。调度/注册表/远端接口见：
 * - execution-target.ts：port + LocalDockerAdapter + buildLocalDockerArgs；
 * - agent-registry.ts：远端 Agent 注册表（注册/心跳/offline 判定）；
 * - remote-agent.ts：RemoteRunnerAgent 代理端（register/heartbeat/claim/
 *   执行/上报/spool；未配置传输时 fail-closed stub）；
 * - remote-fleet-server.ts：RemoteFleetServer 服务端（注册/心跳/claim/
 *   frames/artifacts/complete/CAS + HTTP 路由 + x-service-token）；
 * - agent-spool.ts：代理端有界本地 spool（离线 fail closed，恢复重放）；
 * - in-memory-transport.ts：mock 传输（测试/loopback，不依赖真实远端）。
 */
export {
  LocalDockerAdapter,
  buildLocalDockerArgs,
  deepFreezePlan,
  ExecutionPlanMutationError,
  ExecutionTargetError,
  type ExecutionTarget,
  type ExecutionPreparation,
  type ExecutionRunHandle,
  type ExecutionAttachment,
  type LocalRunHandle,
  type DockerRunFn,
  type CancelRunFn,
  type DockerExecContext,
  type OnChunkFn,
} from './execution-target.js'
export { InMemoryAgentRegistry, localDockerRegistration, type AgentRegistry } from './agent-registry.js'
export {
  createRemoteRunnerAgent,
  RemoteRunnerAgentError,
  RemoteRunnerAgentNotImplementedError,
  RemoteRunnerAgentImpl,
  RemoteWireError,
  HttpRemoteFleetTransport,
  defaultSubprocessExecutor,
  isSpoolableWireError,
  type RemoteRunnerAgent,
  type RemoteFleetTransport,
  type RemoteTransport,
  type AgentExecutor,
  type AgentExecutionContext,
  type AgentRunHandle,
  type RemoteAgentOptions,
} from './remote-agent.js'
export {
  RemoteFleetServer,
  FleetServerError,
  mapKernelError,
  fleetErrorEnvelope,
  createFleetKernelClient,
  attachRemoteFleetRoutes,
  startFleetHttpServer,
  type FleetKernelClient,
  type RemoteFleetServerOptions,
  type RemoteFleetServerStats,
  type RemoteFleetHttpOptions,
} from './remote-fleet-server.js'
export { AgentOutboundSpool, type AgentSpoolEntry, type AgentSpoolOverflowGap } from './agent-spool.js'
export { InMemoryFleetTransport, FailingFleetTransport } from './in-memory-transport.js'

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
 * unpackCodeSnapshot / materializeCodeSnapshot 已迁入 ./snapshot-materialize.js
 * （远端 Agent 的 CAS 输入物化共用同一契约），此处保持 re-export。
 */
export { unpackCodeSnapshot, materializeCodeSnapshot } from './snapshot-materialize.js'

/**
 * §12 (TEX-02): frozen TeX workspace manifest carried in the latex-compile
 * job payload (`payload.tex_snapshot`, produced by POST /v1/documents/:id/
 * builds). §4 row 95 (TEX-01): file CONTENT is fetched from the kernel's
 * SNAPSHOT store at the frozen revision (revision-scoped bytes) and verified
 * against the manifest content_hash before the container sees it — the
 * current file is never read, so a concurrent edit cannot leak into the
 * build (it only moves the document revision ahead for the stale-PDF signal).
 */
export interface TexSnapshotManifest {
  schema_version: number
  document_id: string
  revision: number
  root_file: string
  files: Array<{ path: string; version: number; content_hash: string }>
  frozen_at?: string
}

/**
 * Fetch every file of a frozen TeX snapshot from the kernel's snapshot store
 * into `workDir` (path-traversal protected; hash-verified against the
 * manifest). The bytes are revision-scoped (TEX-01): the materialized
 * workspace is exactly the frozen revision, even if a file changed or was
 * deleted after freeze. Returns the file count; any unreadable or
 * hash-mismatched file is a hard error — never a fallback to current bytes.
 */
export async function materializeTexWorkspace(
  client: Pick<ResearchClient, 'getDocumentSnapshotFile'>,
  manifest: TexSnapshotManifest,
  workDir: string,
): Promise<number> {
  if (typeof manifest.document_id !== 'string' || manifest.document_id === '' || !Array.isArray(manifest.files)) {
    throw new Error('tex snapshot manifest is missing document_id or files')
  }
  if (typeof manifest.root_file !== 'string' || manifest.root_file === '' || /[;&|`$"'\\ \t\n]/.test(manifest.root_file)) {
    throw new Error(`tex snapshot root_file is unsafe for the build script: ${manifest.root_file}`)
  }
  if (!Number.isInteger(manifest.revision) || manifest.revision <= 0) {
    throw new Error(`tex snapshot manifest has an invalid revision: ${String(manifest.revision)}`)
  }
  const absRoot = resolve(workDir)
  let count = 0
  for (const entry of manifest.files) {
    const rel = typeof entry.path === 'string' ? entry.path : ''
    if (rel === '' || rel.startsWith('/') || rel.split('/').some(part => part === '..')) {
      throw new Error(`tex snapshot contains an unsafe path: ${rel}`)
    }
    const file = await client.getDocumentSnapshotFile(manifest.document_id, manifest.revision, rel)
    if (file === null) {
      throw new Error(`tex snapshot file unreadable from kernel: ${rel} (document ${manifest.document_id}, revision ${manifest.revision})`)
    }
    const target = resolve(absRoot, rel)
    if (!target.startsWith(`${absRoot}${sep}`) && target !== absRoot) {
      throw new Error(`tex snapshot path escapes workDir: ${rel}`)
    }
    if (entry.content_hash !== undefined && entry.content_hash !== '') {
      const actual = createHash('sha256').update(file.content).digest('hex')
      if (actual !== entry.content_hash) {
        throw new Error(`tex snapshot integrity mismatch for ${rel}: got ${actual}, manifest claims ${entry.content_hash}`)
      }
    }
    mkdirSync(resolve(target, '..'), { recursive: true })
    chmodSync(resolve(target, '..'), 0o755) // umask defense: dirs need +x for uid 65534
    writeFileSync(target, file.content)
    // Same umask defense as materializeCodeSnapshot (§11.3): the container
    // user (65534) must be able to read the materialized TeX sources.
    chmodSync(target, 0o644)
    count++
  }
  return count
}

/**
 * Parse the pdflatex .log into structured diagnostics: '!' errors (with the
 * following context line) and Warning/Overfull lines. Anything else is
 * ignored — raw log bytes stay on the log artifact (gui-plugin-plan §13.4:
 * TeX raw diagnostics are content, not chrome).
 */
export interface LatexDiagnostic { level: 'error' | 'warning' | 'info'; message: string }

export function parseLatexDiagnostics(logText: string): LatexDiagnostic[] {
  const lines = logText.split('\n')
  const out: LatexDiagnostic[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.startsWith('!')) {
      const context = lines[i + 1]?.trim() ?? ''
      out.push({ level: 'error', message: `${line.slice(1).trim()}${context !== '' ? ` — ${context}` : ''}` })
    } else if (/^(.*Warning|Overfull|Underfull).*$/i.test(line) && !/LaTeX Warning: (Citation|Reference)/.test(line)) {
      // Citation/Reference lines are pass-1 noise; skip.
      const msg = line.trim()
      if (msg.startsWith('(') && msg.includes('))')) continue
      out.push({ level: 'warning', message: msg })
    }
  }
  return out.slice(0, 200)
}

/** In-container build script: copy the frozen workspace files (explicit
 * manifest list — never the /work tree, whose /outputs sub-mount would make
 * cp recurse into its own destination) to the writable /outputs/work, then
 * pdflatex (3 passes) + bibtex there. /work is mounted read-only, so
 * compiling in-place would fail on the first .aux write.
 * §4 P0 (RUN-02/TEX-02): `engine` is a FIXED enum and every path is
 * root-relative without shell metacharacters — anything else throws and the
 * job fails before any command line is generated. */
export function buildLatexRunScript(rootFile: string, engine = 'pdflatex', files: string[] = [rootFile]): string {
  if (!TEX_ENGINES.includes(engine)) {
    throw new Error(`latex engine '${engine}' is not in the fixed engine whitelist (${TEX_ENGINES.join('/')})`)
  }
  assertSafeTexPath(rootFile)
  for (const f of files) assertSafeTexPath(f)
  const base = rootFile.replace(/\.tex$/i, '')
  const copyLines = files
    .filter(f => f !== 'outputs' && !f.startsWith('outputs/'))
    .map(f => `cp -R "/work/${f}" "$OUT/work/" 2>/dev/null || exit 9`)
    .join('\n')
  return `#!/bin/sh
set +e
OUT=/outputs
mkdir -p "$OUT/work"
chmod 777 "$OUT/work" 2>/dev/null
${copyLines}
cd "$OUT/work" || exit 1
ROOT="${base}"
${engine} -interaction=nonstopmode -halt-on-error -file-line-error -recorder -no-shell-escape "$ROOT.tex" > "$OUT/pass1.log" 2>&1
BIB=0
if command -v bibtex > /dev/null 2>&1; then bibtex "$ROOT" > "$OUT/bibtex.log" 2>&1; BIB=$?; fi
${engine} -interaction=nonstopmode -halt-on-error -file-line-error -recorder -no-shell-escape "$ROOT.tex" > "$OUT/pass2.log" 2>&1
P2=$?
${engine} -interaction=nonstopmode -halt-on-error -file-line-error -recorder -no-shell-escape "$ROOT.tex" > "$OUT/pass3.log" 2>&1
P3=$?
PASS=$P2
[ "$P3" -gt "$PASS" ] 2>/dev/null && PASS=$P3
if [ -f "$ROOT.pdf" ]; then cp "$ROOT.pdf" "$OUT/paper.pdf"; fi
if [ -f "$ROOT.log" ]; then cp "$ROOT.log" "$OUT/tex.log"; fi
for aux in "$ROOT.aux" "$ROOT.bbl" "$ROOT.blg" "$ROOT.fls"; do
  if [ -f "$aux" ]; then cp "$aux" "$OUT/"; fi
done
printf 'latex pass exit: %s\\nbibtex exit: %s\\n' "$PASS" "$BIB"
exit "$PASS"
`
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
 * canonicalJson / signManifest / RunnerSigningKey 已迁入 ./manifest-signing.js
 * （远端 Agent 的 complete 路径共用同一 canonical 签名规则），此处保持
 * re-export，既有导入路径不变。
 */
export { canonicalJson, signManifest, type RunnerSigningKey } from './manifest-signing.js'

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
  /** execution-runtime.md §6: live terminal frames during execution. */
  onChunk?: (channel: 'stdout' | 'stderr', text: string, byteOffset: number, byteLength: number) => void
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
    let outOffset = 0
    let errOffset = 0
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
      // §6 live terminal frames: emit as they arrive, before buffering.
      options.onChunk?.('stdout', chunk.toString('utf8'), outOffset, chunk.length)
      outOffset += chunk.length
      stdoutChunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      errBytes += chunk.length
      if (errBytes > maxLogBytes) {
        bufferExceeded = true
        killTree()
        return
      }
      options.onChunk?.('stderr', chunk.toString('utf8'), errOffset, chunk.length)
      errOffset += chunk.length
      stderrChunks.push(chunk)
    })
    child.on('error', (error: Error) => { spawnError = error.message })
    child.on('close', (code: number | null) => finish(code === null ? -1 : code))
  })
}

async function runSubprocess(
  command: string[], cwd: string, timeoutMs: number, maxLogBytes: number, jobId: string, signal?: AbortSignal,
  onChunk?: (channel: 'stdout' | 'stderr', text: string, byteOffset: number, byteLength: number) => void,
  runId = `run_${randomUUID().slice(0, 12)}`,
  runEnv: Record<string, string> = {},
): Promise<RunOutcome> {
  const startedAt = new Date().toISOString()
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: cwd,
    TMPDIR: cwd,
    ...runEnv,
  }
  const result = await spawnCaptured(command, { cwd, env, timeoutMs, maxLogBytes, jobId, signal, onChunk })
  return { run_id: runId, exit_code: result.exitCode, started_at: startedAt, finished_at: new Date().toISOString(), stdout: result.stdout, stderr: result.stderr, error: result.error }
}

/**
 * Docker 执行引擎（RUN-REMOTE-01 适配层边界：被 LocalDockerAdapter 包装，
 * 行为与既有 runDocker 完全一致）。参数从固定 ExecutionPlan 映射——
 * buildLocalDockerArgs（纯函数，可单测）；超时/取消杀进程树、activeRuns
 * 注册、finally docker rm -f 兜底均不变。
 */
async function runDocker(plan: ExecutionPlan, exec: DockerExecContext): Promise<RunOutcome> {
  const { command, cwd, jobId, signal, onChunk, runId, runEnv } = exec
  const startedAt = new Date().toISOString()
  const container = `dsh-scholar-${randomUUID().slice(0, 8)}`
  // §3.2/§12.3 (RUN-02): full container baseline — read-only rootfs,
  // capability drop, no-new-privileges, pids cap. /tmp is a tmpfs and
  // /outputs is the only rw mount, so job payloads must write there.
  // 参数由 plan 固定（limits/image/network），target 不得改写。
  const args = buildLocalDockerArgs({ plan, cwd, containerName: container, env: runEnv, command })
  let result: SpawnResult
  try {
    result = await spawnCaptured(['docker', ...args], {
      timeoutMs: plan.limits.timeout_ms,
      maxLogBytes: plan.limits.max_log_bytes,
      jobId,
      signal,
      container,
      onChunk,
    })
  } finally {
    // `--rm` only cleans up when the docker CLIENT exits normally; if the
    // client is killed (timeout, cancel, gateway crash) the container survives
    // as an orphan. Force-remove it best-effort so runs never leak containers
    // (design §4.6.1 resource limits + cleanup, §12.6 cancel confirmation).
    await execFileAsync('docker', ['rm', '-f', container], { timeout: 10000 }).catch(() => undefined)
  }
  return { run_id: runId, exit_code: result.exitCode, started_at: startedAt, finished_at: new Date().toISOString(), stdout: result.stdout, stderr: result.stderr, error: result.error }
}

/**
 * Execute one claimed job and persist its outcomes as CAS artifacts.
 * Returns the completed Kernel job record.
 */
export async function executeJob(job: JobRecord, options: RunnerOptions): Promise<{ job: JobRecord; run: RunOutcome }> {
  const { client, owner, mode = 'subprocess', timeoutMs = 60000, maxLogBytes = 4 * 1024 * 1024, signal, signingKey } = options
  // §6 terminal frames: the run identity is fixed BEFORE execution so live
  // chunks can be uploaded while the process is still running. RUN-01 (P0):
  // the run identity is the KERNEL'S durable runs row — claimJobs returns
  // `run_id` (run_<12 hex>, one per attempt) and the manifest, metrics
  // provenance and terminal frames must ALL use it; the runner never mints a
  // parallel run id. (Fallback keeps legacy callers working.)
  const runId = (job as ClaimedJobRecord).run_id ?? `run_${randomUUID().slice(0, 12)}`
  const leaseGeneration = options.leaseGeneration ?? undefined
  const pendingFrames: Array<{
    seq: number; stream_seq?: number | null; channel?: 'stdout' | 'stderr' | null
    text?: string | null; byte_offset?: number | null; byte_length?: number | null
    frame_kind: 'chunk' | 'gap' | 'exit'; lease_generation?: number; payload_json?: string
  }> = []
  let frameSeq = 0
  let streamSeq = 0
  let frameFlushTimer: NodeJS.Timeout | undefined
  const flushFrames = (): void => {
    if (pendingFrames.length === 0) return
    const batch = pendingFrames.splice(0, pendingFrames.length)
    // §4 P0 (TERM-01): frames carry the lease owner + token — the kernel
    // rejects leased-job frames without them (409 lease_stale).
    void appendTerminalFramesWithLease(client, job.job_id, runId, batch, owner, job.lease_token).catch(() => undefined)
  }
  const onChunk = (channel: 'stdout' | 'stderr', text: string, byteOffset: number, byteLength: number): void => {
    frameSeq += 1
    streamSeq += 1
    pendingFrames.push({
      seq: frameSeq, stream_seq: streamSeq, channel, text,
      byte_offset: byteOffset, byte_length: byteLength, frame_kind: 'chunk',
      ...(leaseGeneration !== undefined ? { lease_generation: leaseGeneration } : {}),
    })
    if (pendingFrames.length >= 64) {
      if (frameFlushTimer !== undefined) { clearTimeout(frameFlushTimer); frameFlushTimer = undefined }
      flushFrames()
    } else if (frameFlushTimer === undefined) {
      frameFlushTimer = setTimeout(() => { frameFlushTimer = undefined; flushFrames() }, 200)
    }
  }
  // §3.2 / ADR-004: formal-class jobs must run in a container runtime.
  // Subprocess is only for trusted smoke fixtures and echoes — never for
  // baseline/pilot/formal/reproduce (design §1.2 "明确不做", §12.3).
  // execution-runtime.md §1 (RUN-02): smoke ALSO defaults to container — the
  // isolated subprocess is allowed only for an EXPLICIT trusted-smoke-fixture,
  // i.e. a smoke job whose payload carries trusted_fixture === true.
  const SECURE_KINDS: readonly string[] = ['baseline', 'pilot', 'formal', 'reproduce', 'latex-compile']
  const untrustedSmokeSubprocess = job.kind === 'smoke' && mode !== 'docker'
    && (job.payload as Record<string, unknown>).trusted_fixture !== true
  if ((SECURE_KINDS.includes(job.kind) && mode !== 'docker') || untrustedSmokeSubprocess) {
    const rejected = await client.completeJob({
      job_id: job.job_id,
      owner,
      status: 'failed',
      failure_class: 'environment',
      error: untrustedSmokeSubprocess
        ? 'smoke jobs require container execution unless explicitly marked trusted-smoke-fixture (execution-runtime.md §1); host subprocess is prohibited'
        : `job kind ${job.kind} requires container execution (runner mode=docker); host subprocess is prohibited (v2 §3.2)`,
      // §12.6 fencing (P0): a leased job's completion MUST carry the claim's
      // generation/token or the kernel rejects it (409 lease_stale).
      lease_generation: job.lease_generation,
      lease_token: job.lease_token,
    }).catch(() => null)
    if (rejected !== null) return { job: rejected, run: {
      run_id: `run_${randomUUID().slice(0, 12)}`, exit_code: -1,
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      stdout: '', stderr: '', error: `rejected: ${job.kind} requires container execution`,
    } }
    throw new Error(`job ${job.job_id} rejected before execution (subprocess mode)`)
  }
  // domain-model.md §9.1（审计 §4 #8）: secure jobs 由 kernel submitJob 固定
  // opaque runner profile id + profile config hash（payload.runner_profile_id
  // + payload.profile_config_hash）。Runner 按注册表复算校验：未知 id 或
  // hash 不一致 → environment 失败（fail closed，绝不执行——target 不得
  // 放宽 Job 固定的 profile/config pin）。legacy jobs（无 pin）跳过校验，
  // 执行路径与现状字节级一致。
  const payloadProfileId = typeof job.payload.runner_profile_id === 'string' && job.payload.runner_profile_id !== ''
    ? job.payload.runner_profile_id
    : null
  let resolvedProfile: RunnerProfile | null = null
  if (payloadProfileId !== null) {
    const pinnedHash = typeof job.payload.profile_config_hash === 'string' && job.payload.profile_config_hash !== ''
      ? job.payload.profile_config_hash
      : null
    const candidate = getRunnerProfile(payloadProfileId)
    let profileError: string | null = null
    if (candidate === null) {
      profileError = `runner profile ${JSON.stringify(payloadProfileId)} is not a registered opaque profile id (domain-model.md §9.1)`
    } else {
      const computed = computeProfileConfigHash(candidate)
      if (pinnedHash === null || computed !== pinnedHash) {
        profileError = `runner profile ${JSON.stringify(payloadProfileId)} config hash mismatch: job pins ${pinnedHash ?? '(none)'}, registry computes ${computed} (domain-model.md §9.1)`
      }
    }
    if (profileError !== null) {
      const rejected = await client.completeJob({
        job_id: job.job_id,
        owner,
        status: 'failed',
        failure_class: 'environment',
        error: profileError,
        // §12.6 fencing (P0): a leased job's completion MUST carry the claim's
        // generation/token or the kernel rejects it (409 lease_stale).
        lease_generation: job.lease_generation,
        lease_token: job.lease_token,
      }).catch(() => null)
      if (rejected !== null) return { job: rejected, run: {
        run_id: `run_${randomUUID().slice(0, 12)}`, exit_code: -1,
        started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
        stdout: '', stderr: '', error: `rejected: ${profileError}`,
      } }
      throw new Error(`job ${job.job_id} rejected before execution (runner profile validation)`)
    }
    resolvedProfile = candidate
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
  // §12 (TEX-02): latex-compile binds a FROZEN TeX snapshot — fetch its
  // files from the kernel, hash-verify them against the manifest, and build
  // the fixed-image compile script (pdflatex×3 + bibtex) instead of running
  // job.command. The container only ever sees this materialized workspace.
  const texSnapshot = job.kind === 'latex-compile' ? job.payload.tex_snapshot : undefined
  if (texSnapshot !== undefined) {
    try {
      const manifest = texSnapshot as TexSnapshotManifest
      const materialized = await materializeTexWorkspace(client, manifest, workDir)
      if (materialized === 0) {
        throw new Error(`tex snapshot ${manifest.document_id} materialized zero files`)
      }
      const engine = typeof job.payload.engine === 'string' && job.payload.engine !== '' ? job.payload.engine : 'pdflatex'
      const fileList = manifest.files.map((f: { path: string }) => f.path)
      writeFileSync(join(workDir, 'run.sh'), buildLatexRunScript(manifest.root_file, engine, fileList), { mode: 0o755 })
      // umask may strip the world bits (e.g. 0077 → 0700): the container user
      // (65534) must be able to READ the script — force the mode explicitly.
      chmodSync(join(workDir, 'run.sh'), 0o755)
    } catch (error) {
      rmSync(workDir, { recursive: true, force: true })
      throw error
    }
  }
  // §12.2: image digest from the JobSpec binding (kernel defaults: TeX
  // build image for latex-compile, node:22-alpine otherwise).
  const image = typeof job.payload.image_digest === 'string' && job.payload.image_digest !== ''
    ? job.payload.image_digest
    : (job.kind === 'latex-compile' ? 'texlive/texlive:latest' : 'node:22-alpine')

  let run: RunOutcome
  // §12.5 (P0): the in-container execution receives its run identity so the
  // metrics FILE it writes back can prove run/contract/seed provenance.
  const runEnv: Record<string, string> = {
    DSH_RUN_ID: runId,
    DSH_CONTRACT_ID: job.contract_id ?? '',
    DSH_SEED: typeof (job.payload as Record<string, unknown> | undefined)?.seed === 'number'
      ? String((job.payload as Record<string, unknown>).seed)
      : '',
  }
  if (job.kind === 'echo') {
    // Echo jobs execute nothing: pure in-process fixture (the ONLY kind that
    // may succeed without executing code — §3.2 invariant 1).
    const message = typeof job.payload.message === 'string' ? job.payload.message : `echo ${job.job_id}`
    run = {
      run_id: runId,
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
      run_id: runId,
      exit_code: 2,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      stdout: '',
      stderr: '',
      error: 'empty command: non-echo jobs must execute real code (v2 §3.2)',
    }
  } else {
    // 解析实际执行命令（smoke 注入脚本 / TeX 冻结构建脚本 / job.command），
    // 再收敛到执行路径。docker 分支走 ExecutionTarget port（RUN-REMOTE-01
    // 接口层：LocalDockerAdapter = prepare 校验/冻结 plan + fingerprint
    // 断言 → start → wait，底层仍是既有 runDocker 引擎，行为不变）。
    // subprocess 分支是 trusted-smoke-fixture 专用的非 target 兼容层
    // （execution-runtime.md §1）——远端/调度路径永不产生 subprocess。
    let command: string[]
    let trustedSubprocessCommand: string[]
    if (job.kind === 'smoke' && job.payload.script !== undefined && typeof job.payload.script === 'string') {
      // Injected smoke script runs inside the isolated workdir. Reaching this
      // branch in subprocess mode requires payload.trusted_fixture === true —
      // the untrusted smoke gate above rejects everything else (RUN-02,
      // execution-runtime.md §1).
      writeFileSync(join(workDir, 'run.sh'), job.payload.script, { mode: 0o755 })
      // umask may strip the world bits (e.g. 0077 → 0700): the container user
      // (65534) must be able to READ the script — force the mode explicitly.
      chmodSync(join(workDir, 'run.sh'), 0o755)
      command = ['sh', '/work/run.sh']
      trustedSubprocessCommand = ['sh', 'run.sh']
    } else if (texSnapshot !== undefined) {
      // TEX-02: the frozen-workspace build script is the only thing executed.
      command = ['sh', '/work/run.sh']
      trustedSubprocessCommand = ['sh', 'run.sh']
    } else {
      command = job.command.length > 0 ? job.command : ['true']
      trustedSubprocessCommand = command
    }
    // RUN-REMOTE-01（接口层）：ExecutionPlan 由 Kernel 固定字段派生并签名
    // （有 signingKey 时），target 不得改写（adapter 冻结 + fingerprint 断言）。
    // domain-model.md §9.1：docker 参数来源 = 注册表 profile 记录（limits/
    // network/opaque profile_id + config hash pin）；legacy jobs 缺省值
    // 与现状字节级一致。
    const plan = buildExecutionPlan(job, {
      run_id: runId,
      command,
      lease: {
        owner,
        generation: job.lease_generation ?? 0,
        token: job.lease_token,
        expires_at: job.lease_expires_at,
      },
      image_digest: image,
      timeout_ms: timeoutMs,
      config_pin: null,
      target_id: 'local-docker',
      profile_id: resolvedProfile?.profile_id ?? 'local-docker',
      profile: resolvedProfile ?? undefined,
    })
    const planForExecution = signingKey !== undefined ? signExecutionPlan(plan, signingKey) : plan
    const dockerTarget = new LocalDockerAdapter({ jobId: job.job_id, dockerRun: runDocker, cancel: cancelRun })
    run = mode === 'docker'
      ? await dockerTarget.execute(planForExecution, { cwd: workDir, signal, onChunk, runEnv })
      : await runSubprocess(trustedSubprocessCommand, workDir, timeoutMs, maxLogBytes, job.job_id, signal, onChunk, runId, runEnv)
  }

  // §6 terminal exit frame: the process-side facts (exit code, truncation).
  // The business terminal state is still decided by completeJob below.
  if (frameFlushTimer !== undefined) { clearTimeout(frameFlushTimer); frameFlushTimer = undefined }
  frameSeq += 1
  pendingFrames.push({
    seq: frameSeq,
    frame_kind: 'exit',
    ...(leaseGeneration !== undefined ? { lease_generation: leaseGeneration } : {}),
    payload_json: JSON.stringify({
      exit_code: run.exit_code,
      signal: null,
      timed_out: run.error !== undefined && run.error.includes('timed out'),
      cancelled: cancelledJobs.has(job.job_id),
    }),
  })
  flushFrames()

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
      media_type: 'text/plain; charset=utf-8',
      file_name: `run-${run.run_id}.log`,
    })
    manifest.log_artifact = logArtifact.artifact_id

    // §12 (TEX-02): latex-compile outcome — PDF, full log, structured
    // diagnostics and aux/bbl/blg/fls as content-addressed artifacts
    // (api-contracts.md §builds); the kernel maps them onto the tex_builds
    // row in completeJob.
    if (job.kind === 'latex-compile' && texSnapshot !== undefined) {
      const texManifest = texSnapshot as TexSnapshotManifest
      let pdfArtifact: string | null = null
      let texLogArtifact: string | null = null
      let diagnostics: LatexDiagnostic[] = []
      const pdfPath = join(outputsDir, 'paper.pdf')
      if (existsSync(pdfPath)) {
        const pdf = readFileSync(pdfPath)
        const rec = await client.registerArtifact({
          project_id: job.project_id,
          kind: 'pdf',
          content_base64: pdf.toString('base64'),
          media_type: 'application/pdf',
          file_name: 'paper.pdf',
          metadata: { run_id: run.run_id, job_id: job.job_id, tex_document_id: texManifest.document_id, tex_revision: texManifest.revision },
        })
        pdfArtifact = rec.artifact_id
      }
      const logPath = join(outputsDir, 'tex.log')
      if (existsSync(logPath)) {
        const logText = readFileSync(logPath, 'utf8')
        diagnostics = parseLatexDiagnostics(logText)
        const rec = await client.registerArtifact({
          project_id: job.project_id,
          kind: 'log',
          content_base64: Buffer.from(logText).toString('base64'),
          media_type: 'text/plain; charset=utf-8',
          file_name: `tex-${texManifest.revision}.log`,
          metadata: { run_id: run.run_id, job_id: job.job_id, tex_document_id: texManifest.document_id, tex_revision: texManifest.revision },
        })
        texLogArtifact = rec.artifact_id
      }
      const aux: Record<string, string> = {}
      for (const f of readdirSync(outputsDir)) {
        if (/\\.(aux|bbl|blg|fls)$/.test(f)) aux[f] = readFileSync(join(outputsDir, f), 'base64')
      }
      let auxArtifact: string | null = null
      if (Object.keys(aux).length > 0) {
        const rec = await client.registerArtifact({
          project_id: job.project_id,
          kind: 'data',
          content_base64: Buffer.from(JSON.stringify(aux)).toString('base64'),
          media_type: 'application/json',
          file_name: `tex-${texManifest.revision}-aux.json`,
          metadata: { run_id: run.run_id, job_id: job.job_id },
        })
        auxArtifact = rec.artifact_id
      }
      manifest.tex_pdf_artifact = pdfArtifact
      manifest.tex_log_artifact = texLogArtifact
      manifest.tex_aux_artifact = auxArtifact
      manifest.tex_diagnostics = diagnostics
      manifest.tex = { document_id: texManifest.document_id, revision: texManifest.revision, root_file: texManifest.root_file }
    }

    // §12.5 (SCH-EXEC-002): formal metrics come from the fixed-schema metrics
    // FILE written in-container to the output contract path (host mirror:
    // <workDir>/outputs/<file>). The file is authoritative — stdout is only
    // logs. Legacy stdout JSON-line extraction remains as a fallback ONLY for
    // non-secure kinds (smoke/echo/analysis): P0 (acceptance-tests.md §4)
    // forbids stdout fallback for baseline/pilot/formal/reproduce.
    const SECURE_METRICS_KINDS: readonly string[] = ['baseline', 'pilot', 'formal', 'reproduce']
    let metrics: Array<{ metric: string; value: number; seed?: number }> = []
    let metricsFromFile: MetricsFileRecord | null = null
    let metricsFileError: string | null = null
    const outputContract = job.payload.output_contract
    const metricsPath = typeof outputContract === 'object' && outputContract !== null
      ? (outputContract as Record<string, unknown>).metrics
      : undefined
    if (typeof metricsPath === 'string' && metricsPath !== '') {
      // §4 P0 (RUN-02): the metrics path must resolve STRICTLY INSIDE the
      // outputs directory — `../` escapes, absolute paths and symlink escapes
      // are rejected (never read host files through the metrics path).
      const real = resolveMetricsFileWithin(outputsDir, metricsPath)
      if (real === null) {
        metricsFileError = `metrics path ${metricsPath} escapes the outputs directory or is unreadable (path traversal rejected)`
      } else {
        try {
          const fileContent = readFileSync(real, 'utf8')
          metricsFromFile = parseMetricsFile(fileContent)
          if (metricsFromFile === null) {
            metricsFileError = `metrics file ${metricsPath} is missing or not a MetricsFileV1 (schema_version=1 + non-empty metrics)`
          }
        } catch {
          metricsFileError = `metrics file ${metricsPath} not found after execution (output contract violated)`
        }
      }
    } else if (SECURE_METRICS_KINDS.includes(job.kind)) {
      metricsFileError = 'secure job must declare output_contract.metrics (MetricsFileV1 path)'
    }
    // P0 §12.5: strict provenance validation of the metrics FILE.
    if (metricsFromFile !== null && SECURE_METRICS_KINDS.includes(job.kind)) {
      const problems: string[] = []
      if (metricsFromFile.run_id !== undefined && metricsFromFile.run_id !== run.run_id) {
        problems.push(`run_id mismatch: file '${metricsFromFile.run_id}' != execution '${run.run_id}'`)
      }
      if (job.contract_id !== null && metricsFromFile.contract_id !== undefined && metricsFromFile.contract_id !== job.contract_id) {
        problems.push(`contract_id mismatch: file '${metricsFromFile.contract_id}' != job '${job.contract_id}'`)
      }
      if (metricsFromFile.seed === undefined || !Number.isFinite(metricsFromFile.seed)) {
        problems.push('seed missing or not a finite number')
      } else if (runEnv.DSH_SEED !== '' && metricsFromFile.seed !== Number(runEnv.DSH_SEED)) {
        problems.push(`seed mismatch: file ${metricsFromFile.seed} != job seed ${runEnv.DSH_SEED}`)
      }
      for (const m of metricsFromFile.metrics) {
        if (m.value === undefined || !Number.isFinite(m.value)) {
          problems.push(`non-finite metric value for '${m.name ?? m.metric ?? '?'}'`)
        }
      }
      const names = metricsFromFile.metrics.map(m => m.name ?? m.metric ?? '')
      const dupes = names.filter((n, i) => names.indexOf(n) !== i)
      if (dupes.length > 0) problems.push(`duplicate metric name(s): ${[...new Set(dupes)].join(', ')}`)
      const contractMetrics = (job.payload as Record<string, unknown>).contract_metrics
      if (Array.isArray(contractMetrics)) {
        const allowed = new Set(contractMetrics.filter((x): x is string => typeof x === 'string'))
        const foreign = names.filter(n => n !== '' && !allowed.has(n))
        if (foreign.length > 0) problems.push(`metric(s) not in contract: ${foreign.join(', ')}`)
      }
      if (problems.length > 0) metricsFileError = `MetricsFileV1 validation failed: ${problems.join('; ')}`
    }
    if (metricsFromFile !== null) {
      // Map the §12.5 record into the artifact, injecting the top-level seed
      // into entries that lack their own (fixed-schema record shape).
      metrics = metricsFromFile.metrics.map(m => ({
        metric: m.name ?? m.metric ?? '',
        value: m.value,
        ...(m.seed !== undefined ? { seed: m.seed } : metricsFromFile!.seed !== undefined ? { seed: metricsFromFile!.seed } : {}),
      }))
    } else if (!SECURE_METRICS_KINDS.includes(job.kind)) {
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
    // P0 (acceptance-tests.md §4): a secure job whose metrics file is
    // missing/invalid must NEVER be marked succeeded — force a failed
    // completion even when the process exited 0.
    const metricsFailure = metricsFileError !== null && failure_class === null
      ? { failure_class: 'code_error' as const, error: metricsFileError }
      : null
    // §12.6 fencing: record the claim's generation inside the manifest so the
    // kernel can reject stale runners that somehow complete late.
    manifest.lease = { generation: job.lease_generation, token: job.lease_token }
    // Sign the final manifest (design §12.7): signature over the canonical
    // JSON excluding `signature`; payload_sha256 over the canonical JSON
    // before the signing fields are attached. The kernel verifies both.
    const finalManifest = signingKey !== undefined
      ? signManifest({ ...manifest, signed_by: owner }, signingKey)
      : { ...manifest, signed_by: owner }
    if (run.exit_code === 0 && failure_class === null && metricsFailure === null) {
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
      failure_class: metricsFailure?.failure_class ?? failure_class,
      error: metricsFailure?.error ?? (failureError || run.error || `exit code ${run.exit_code}`),
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
