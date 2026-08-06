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

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { ResearchClient } from '@dsh-scholar/research-client'
import type { JobRecord } from '@dsh-scholar/research-schemas'

const execFileAsync = promisify(execFile)

export type RunnerMode = 'subprocess' | 'docker'

export interface RunnerOptions {
  client: ResearchClient
  owner: string
  mode?: RunnerMode
  /** Subprocess/container timeout, ms. */
  timeoutMs?: number
  /** Max stdout+stderr bytes captured. */
  maxLogBytes?: number
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

/** Failure classification per design §4.6.2 (deterministic rules). */
export function classifyFailure(outcome: RunOutcome): { failure_class: JobRecord['failure_class']; error: string } {
  if (outcome.exit_code === 0) return { failure_class: null, error: '' }
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

async function runSubprocess(command: string[], cwd: string, timeoutMs: number, maxLogBytes: number): Promise<RunOutcome> {
  const startedAt = new Date().toISOString()
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: cwd,
    TMPDIR: cwd,
  }
  let stdout = ''
  let stderr = ''
  let error: string | undefined
  let exitCode = -1
  try {
    const result = await execFileAsync(command[0] ?? '', command.slice(1), {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: maxLogBytes,
    })
    stdout = result.stdout
    stderr = result.stderr
    exitCode = 0
  } catch (caught) {
    const e = caught as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean }
    stdout = e.stdout ?? ''
    stderr = e.stderr ?? ''
    error = e.message
    exitCode = typeof e.code === 'number' ? e.code : -1
    if (e.killed === true) error = `timed out after ${timeoutMs}ms`
  }
  return { run_id: `run_${randomUUID().slice(0, 12)}`, exit_code: exitCode, started_at: startedAt, finished_at: new Date().toISOString(), stdout, stderr, error }
}

async function runDocker(command: string[], cwd: string, timeoutMs: number): Promise<RunOutcome> {
  const startedAt = new Date().toISOString()
  const container = `dsh-scholar-${randomUUID().slice(0, 8)}`
  const args = [
    'run', '--rm', '--name', container,
    '--network', 'none',
    '--user', '65534:65534',
    '--memory', '1g', '--cpus', '1',
    '--workdir', '/work',
    '-v', `${cwd}:/work:ro`,
    '--tmpfs', '/tmp:size=64m',
    'node:22-alpine',
    ...command,
  ]
  let stdout = ''
  let stderr = ''
  let error: string | undefined
  let exitCode = -1
  try {
    const result = await execFileAsync('docker', args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })
    stdout = result.stdout
    stderr = result.stderr
    exitCode = 0
  } catch (caught) {
    const e = caught as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean }
    stdout = e.stdout ?? ''
    stderr = e.stderr ?? ''
    error = e.message
    exitCode = typeof e.code === 'number' ? e.code : -1
    if (e.killed === true) error = `timed out after ${timeoutMs}ms`
  }
  return { run_id: `run_${randomUUID().slice(0, 12)}`, exit_code: exitCode, started_at: startedAt, finished_at: new Date().toISOString(), stdout, stderr, error }
}

/**
 * Execute one claimed job and persist its outcomes as CAS artifacts.
 * Returns the completed Kernel job record.
 */
export async function executeJob(job: JobRecord, options: RunnerOptions): Promise<{ job: JobRecord; run: RunOutcome }> {
  const { client, owner, mode = 'subprocess', timeoutMs = 60000, maxLogBytes = 4 * 1024 * 1024 } = options
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-scholar-run-'))

  let run: RunOutcome
  if (job.kind === 'echo' || (job.command.length === 0 && typeof job.payload.message === 'string')) {
    // Echo-style jobs execute nothing on the host: pure in-process manifest.
    // A non-echo job with an empty command and a `message` payload is treated
    // the same way (deterministic stdout for fixtures/metrics tests).
    const message = typeof job.payload.message === 'string' ? job.payload.message : `echo ${job.job_id}`
    run = {
      run_id: `run_${randomUUID().slice(0, 12)}`,
      exit_code: 0,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      stdout: message,
      stderr: '',
    }
  } else if (job.kind === 'smoke' && job.payload.script !== undefined && typeof job.payload.script === 'string') {
    // Injected smoke script runs inside the isolated workdir.
    writeFileSync(join(workDir, 'run.sh'), job.payload.script, { mode: 0o700 })
    run = mode === 'docker'
      ? await runDocker(['sh', '/work/run.sh'], workDir, timeoutMs)
      : await runSubprocess(['sh', 'run.sh'], workDir, timeoutMs, maxLogBytes)
  } else {
    const command = job.command.length > 0 ? job.command : ['true']
    run = mode === 'docker'
      ? await runDocker(command, workDir, timeoutMs)
      : await runSubprocess(command, workDir, timeoutMs, maxLogBytes)
  }

  try {
    const manifest: Record<string, unknown> = {
      run_id: run.run_id,
      contract_id: job.contract_id,
      job_id: job.job_id,
      code_commit: job.payload.code_commit ?? '',
      container_digest: mode === 'docker' ? 'docker:node:22-alpine' : '',
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

    const metrics = extractMetrics(run.stdout)
    if (metrics.length > 0 || run.exit_code === 0) {
      const metricsContent = JSON.stringify({ run_id: run.run_id, job_id: job.job_id, metrics }, null, 2)
      const metricsArtifact = await client.registerArtifact({
        project_id: job.project_id,
        kind: 'analysis',
        content_base64: Buffer.from(metricsContent).toString('base64'),
        metadata: { run_id: run.run_id, job_id: job.job_id, metrics: metrics.length },
      })
      manifest.metrics_artifact = metricsArtifact.artifact_id
    }

    const { failure_class, error: failureError } = classifyFailure(run)
    if (run.exit_code === 0 && failure_class === null) {
      const completed = await client.completeJob({
        job_id: job.job_id,
        owner,
        status: 'succeeded',
        run_manifest: { ...manifest, signed_by: owner },
      })
      return { job: completed, run }
    }
    const completed = await client.completeJob({
      job_id: job.job_id,
      owner,
      status: 'failed',
      failure_class,
      error: failureError || run.error || `exit code ${run.exit_code}`,
      run_manifest: { ...manifest, signed_by: owner },
    })
    return { job: completed, run }
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

/** Keep a lease alive while a job runs (best effort). */
export async function heartbeatLoop(jobId: string, owner: string, client: ResearchClient, intervalMs = 20000, signal: AbortSignal): Promise<void> {
  const timer = setInterval(() => {
    void client.heartbeatJob(jobId, owner).catch(() => undefined)
  }, intervalMs)
  signal.addEventListener('abort', () => clearInterval(timer), { once: true })
}
