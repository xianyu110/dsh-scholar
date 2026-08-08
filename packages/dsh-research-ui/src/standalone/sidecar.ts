/**
 * Research Kernel lifecycle owned by the standalone DSH Scholar server.
 * The browser never talks to this loopback endpoint directly; all access
 * crosses the standalone BFF.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'

export interface UiKernelSidecarOptions {
  host?: string
  port?: number
  dataDir?: string
  log?: (line: string) => void
}

export class UiKernelSidecar {
  private child: ChildProcess | null = null
  private readonly require = createRequire(import.meta.url)
  readonly host: string
  readonly port: number
  readonly dataDir: string
  private readonly log: (line: string) => void

  constructor(options: UiKernelSidecarOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 7412
    this.dataDir = options.dataDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'research-kernel')
    this.log = options.log ?? (() => undefined)
  }

  get endpoint(): string {
    return `http://${this.host}:${this.port}`
  }

  private resolveKernelBin(): string {
    const pkgPath = this.require.resolve('@dsh-scholar/research-kernel/package.json')
    return join(dirname(pkgPath), 'lib', 'bin', 'kernel.js')
  }

  private async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/v1/health`, { signal: AbortSignal.timeout(1500) })
      return response.ok
    } catch {
      return false
    }
  }

  async start(): Promise<void> {
    if (await this.health()) {
      this.log(`[research-ui] reusing running kernel at ${this.endpoint}`)
      return
    }
    mkdirSync(this.dataDir, { recursive: true })
    const bin = this.resolveKernelBin()
    const args = [bin, '--db', join(this.dataDir, 'kernel.db'), '--cas', join(this.dataDir, 'cas'), '--host', this.host, '--port', String(this.port)]
    this.log(`[research-ui] spawning research kernel: node ${args.join(' ')}`)
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.log(`[research-kernel] ${chunk.toString().trimEnd()}`))
    child.stderr?.on('data', (chunk: Buffer) => this.log(`[research-kernel] ${chunk.toString().trimEnd()}`))
    child.on('exit', (code, signal) => {
      this.log(`[research-ui] kernel exited (code=${code}, signal=${signal})`)
      if (this.child === child) this.child = null
    })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await this.health()) {
        this.log(`[research-ui] kernel healthy at ${this.endpoint}`)
        return
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`research kernel did not become healthy at ${this.endpoint}`)
  }

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
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}
