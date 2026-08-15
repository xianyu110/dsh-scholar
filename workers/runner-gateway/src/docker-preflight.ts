import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ExecutionPlan } from '@dsh-scholar/research-schemas'

const execFileAsync = promisify(execFile)

export type DockerPreflightCode =
  | 'ready'
  | 'docker_unavailable'
  | 'image_unavailable'
  | 'nvidia_runtime_unavailable'
  | 'nvidia_smi_unavailable'
  | 'gpu_device_unavailable'

export type DockerPreflightReport =
  | { ok: true; code: 'ready'; available_devices?: string[] }
  | { ok: false; code: Exclude<DockerPreflightCode, 'ready'>; available_devices?: string[] }

export type DockerPreflightExec = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>

const defaultExec: DockerPreflightExec = async (file, args) => {
  const result = await execFileAsync(file, args, { timeout: 5_000, encoding: 'utf8' })
  return { stdout: String(result.stdout), stderr: String(result.stderr) }
}

export async function probeNvidiaCapabilities(
  run: DockerPreflightExec = defaultExec,
): Promise<{ toolkit_available: true; devices: string[] } | null> {
  try {
    const runtimes = await run('docker', ['info', '--format', '{{json .Runtimes}}'])
    if (!runtimes.stdout.toLowerCase().includes('nvidia')) return null
    const probe = await run('nvidia-smi', ['--query-gpu=index', '--format=csv,noheader'])
    const devices = probe.stdout.split(/\r?\n/).map(value => value.trim()).filter(value => /^(0|[1-9][0-9]*)$/.test(value))
    return devices.length > 0 ? { toolkit_available: true, devices } : null
  } catch {
    return null
  }
}

/** Fixed-command, safe preflight. Raw stderr is deliberately not returned. */
export async function probeDockerExecutionEnvironment(
  plan: ExecutionPlan,
  run: DockerPreflightExec = defaultExec,
): Promise<DockerPreflightReport> {
  try {
    await run('docker', ['info'])
  } catch {
    return { ok: false, code: 'docker_unavailable' }
  }
  try {
    await run('docker', ['image', 'inspect', plan.image.digest])
  } catch {
    return { ok: false, code: 'image_unavailable' }
  }
  if (plan.compute.mode === 'cpu') return { ok: true, code: 'ready' }

  let available: string[]
  try {
    const runtimes = await run('docker', ['info', '--format', '{{json .Runtimes}}'])
    if (!runtimes.stdout.toLowerCase().includes('nvidia')) return { ok: false, code: 'nvidia_runtime_unavailable' }
  } catch {
    return { ok: false, code: 'nvidia_runtime_unavailable' }
  }
  try {
    const probe = await run('nvidia-smi', ['--query-gpu=index', '--format=csv,noheader'])
    available = probe.stdout.split(/\r?\n/).map(value => value.trim()).filter(value => /^(0|[1-9][0-9]*)$/.test(value))
  } catch {
    return { ok: false, code: 'nvidia_smi_unavailable' }
  }
  if (available.length === 0) return { ok: false, code: 'gpu_device_unavailable', available_devices: [] }
  if (plan.compute.devices !== 'all' && plan.compute.devices.some(device => !available.includes(device))) {
    return { ok: false, code: 'gpu_device_unavailable', available_devices: available }
  }
  return { ok: true, code: 'ready', available_devices: available }
}
