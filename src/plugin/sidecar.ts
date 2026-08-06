/**
 * Kernel sidecar lifecycle: spawns the Research Kernel as a child process
 * (design §9.1 Local Desktop Profile), waits for health, and tears it down on
 * plugin disposal. The Kernel owns durable state in its SQLite DB, so DSH
 * process restarts never lose research state (design §1.1 goal 3).
 * @module @dsh-scholar/research-plugin/sidecar
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

export interface KernelSidecarOptions {
  host?: string
  port?: number
  /** Directory for kernel.db and the CAS. Defaults to $DSH_HOME/research-kernel. */
  dataDir?: string
  /** Optional bearer token for loopback auth. */
  token?: string
  log?: (line: string) => void
}

/** Resolve the dsh home used for persistent kernel data. */
export function resolveDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export class KernelSidecar {
  private child: ChildProcess | null = null
  private readonly require = createRequire(import.meta.url)
  readonly host: string
  readonly port: number
  readonly dataDir: string
  private readonly token: string | undefined
  private readonly log: (line: string) => void

  constructor(options: KernelSidecarOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 7412
    this.dataDir = options.dataDir ?? join(resolveDshHome(), 'research-kernel')
    this.token = options.token
    this.log = options.log ?? (() => undefined)
  }

  get endpoint(): string {
    return `http://${this.host}:${this.port}`
  }

  /** Resolve the installed kernel entry (via the plugin's own node_modules). */
  private resolveKernelBin(): string {
    const pkgPath = this.require.resolve('@dsh-scholar/research-kernel/package.json')
    return join(dirname(pkgPath), 'lib', 'bin', 'kernel.js')
  }

  private async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/v1/health`, {
        headers: this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(1500),
      })
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * Start the kernel sidecar and wait until healthy. If another kernel is
   * already listening on the port (e.g. an earlier DSH process left it
   * running), reuse it — Durable-by-design (§1.3).
   */
  async start(): Promise<void> {
    if (await this.health()) {
      this.log(`[research-plugin] reusing running kernel at ${this.endpoint}`)
      return
    }
    mkdirSync(this.dataDir, { recursive: true })
    const bin = this.resolveKernelBin()
    const dbPath = join(this.dataDir, 'kernel.db')
    const casRoot = join(this.dataDir, 'cas')
    const args = [bin, '--db', dbPath, '--cas', casRoot, '--host', this.host, '--port', String(this.port)]
    if (this.token !== undefined) args.push('--token', this.token)
    this.log(`[research-plugin] spawning research kernel: node ${args.join(' ')}`)
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_SCHOLAR_KERNEL: '1' },
    })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.log(`[research-kernel] ${chunk.toString().trimEnd()}`))
    child.stderr?.on('data', (chunk: Buffer) => this.log(`[research-kernel] ${chunk.toString().trimEnd()}`))
    child.on('exit', (code, signal) => {
      this.log(`[research-plugin] kernel exited (code=${code}, signal=${signal})`)
      if (this.child === child) this.child = null
    })
    // Wait up to 10s for health.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await this.health()) {
        this.log(`[research-plugin] kernel healthy at ${this.endpoint}`)
        return
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`research kernel did not become healthy at ${this.endpoint} (db=${dbPath})`)
  }

  /** Stop the sidecar: SIGTERM, then SIGKILL after a grace period. */
  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    if (child === null || child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
