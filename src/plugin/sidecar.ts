/**
 * Kernel sidecar lifecycle: spawns the Research Kernel as a child process
 * (design §9.1 Local Desktop Profile), waits for health, and tears it down on
 * plugin disposal. The Kernel owns durable state in its SQLite DB, so DSH
 * process restarts never lose research state (design §1.1 goal 3).
 *
 * SIDE-01 (docs/acceptance-tests.md §9): before reusing a kernel found
 * listening on the configured port, the sidecar verifies the 0600
 * `<dataDir>/runtime/endpoint.json` published by that kernel. A missing file
 * means the kernel's identity is unknown → reuse refused
 * (sidecar_identity_unknown); protocol/schema/database/dataDir mismatch →
 * reuse refused (sidecar_identity_mismatch). A foreign kernel is never
 * terminated. With `port: 0` the sidecar passes `--endpoint-file` to the
 * kernel and resolves the actual bound port from that file after spawn; the
 * `endpoint` getter is unavailable until then.
 * @module @dsh-scholar/research-plugin/sidecar
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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

/**
 * Error thrown when an existing kernel on the configured port cannot be
 * proven to be this instance's kernel (SIDE-01). `code` is
 * `sidecar_identity_unknown` (no readable endpoint.json) or
 * `sidecar_identity_mismatch` (identity fields disagree); the message names
 * the failing field. The foreign process is never killed.
 */
export class SidecarIdentityError extends Error {
  readonly code: 'sidecar_identity_unknown' | 'sidecar_identity_mismatch'
  constructor(code: 'sidecar_identity_unknown' | 'sidecar_identity_mismatch', detail: string) {
    super(`${code}: ${detail}`)
    this.code = code
    this.name = 'SidecarIdentityError'
  }
}

/** Shape of `<dataDir>/runtime/endpoint.json` (0600, written by kernel + sidecar). */
export interface EndpointRecord {
  host?: unknown
  port?: unknown
  protocol?: unknown
  schema?: unknown
  database?: unknown
  dataDir?: unknown
  pid?: unknown
  started_at?: unknown
}

const ENDPOINT_PROTOCOL = 'http'
const ENDPOINT_SCHEMA = 'v1'
const DB_FILE_NAME = 'kernel.db'
const HANDSHAKE_TIMEOUT_MS = 10_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Resolve the dsh home used for persistent kernel data. */
export function resolveDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export class KernelSidecar {
  private child: ChildProcess | null = null
  /** pid of the kernel this sidecar spawned (survives child exit, for file ownership). */
  private childPid: number | null = null
  /** Actual bound port once known (always set after a successful spawn). */
  private resolvedPort: number | null = null
  private readonly require = createRequire(import.meta.url)
  readonly host: string
  /** Configured port; 0 means "ephemeral — resolve from runtime/endpoint.json". */
  readonly port: number
  readonly dataDir: string
  private readonly token: string | undefined
  private readonly log: (line: string) => void

  constructor(options: KernelSidecarOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 7412
    this.dataDir = resolve(options.dataDir ?? join(resolveDshHome(), 'research-kernel'))
    this.token = options.token
    this.log = options.log ?? (() => undefined)
  }

  /**
   * Kernel HTTP endpoint. With `port: 0` it is unavailable until `start()`
   * has resolved the actual port from runtime/endpoint.json.
   */
  get endpoint(): string {
    const port = this.resolvedPort ?? (this.port !== 0 ? this.port : null)
    if (port === null) {
      throw new Error('KernelSidecar endpoint is unavailable until start() resolves the actual port (port=0)')
    }
    return `http://${this.host}:${port}`
  }

  /** Resolve the installed kernel entry (via the plugin's own node_modules). */
  private resolveKernelBin(): string {
    const pkgPath = this.require.resolve('@dsh-scholar/research-kernel/package.json')
    return join(dirname(pkgPath), 'lib', 'bin', 'kernel.js')
  }

  private endpointFilePath(): string {
    return join(this.dataDir, 'runtime', 'endpoint.json')
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

  /** Read the published endpoint identity; null when missing/unreadable. */
  private readEndpointRecord(): EndpointRecord | null {
    try {
      const record = JSON.parse(readFileSync(this.endpointFilePath(), 'utf8')) as unknown
      return typeof record === 'object' && record !== null ? record as EndpointRecord : null
    } catch {
      return null
    }
  }

  /**
   * SIDE-01 identity gate: throw unless the kernel on the port is verifiably
   * this instance's (protocol http, schema v1, database kernel.db, dataDir
   * this sidecar's absolute dataDir). Never terminates the foreign kernel.
   */
  private verifyReuseIdentity(): void {
    const record = this.readEndpointRecord()
    if (record === null) {
      throw new SidecarIdentityError(
        'sidecar_identity_unknown',
        `no readable ${this.endpointFilePath()} — refusing to reuse an unidentified kernel`,
      )
    }
    const checks: Array<[field: string, actual: unknown, expected: string]> = [
      ['protocol', record.protocol, ENDPOINT_PROTOCOL],
      ['schema', record.schema, ENDPOINT_SCHEMA],
      ['database', record.database, DB_FILE_NAME],
      ['dataDir', record.dataDir, this.dataDir],
    ]
    for (const [field, actual, expected] of checks) {
      if (actual !== expected) {
        throw new SidecarIdentityError(
          'sidecar_identity_mismatch',
          `${field} mismatch (expected ${expected}, got ${String(actual)}) — refusing to reuse a foreign kernel`,
        )
      }
    }
    this.log(`[research-plugin] kernel identity verified (database=${String(record.database)}, dataDir=${String(record.dataDir)}, pid=${String(record.pid)})`)
  }

  /** Publish this instance's endpoint identity (0600) for future reuse checks. */
  private writeEndpointFile(port: number, pid: number): void {
    const file = this.endpointFilePath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({
      host: this.host,
      port,
      protocol: ENDPOINT_PROTOCOL,
      schema: ENDPOINT_SCHEMA,
      database: DB_FILE_NAME,
      dataDir: this.dataDir,
      pid,
      started_at: new Date().toISOString(),
    }, null, 2) + '\n', { mode: 0o600 })
    chmodSync(file, 0o600)
  }

  /** Remove runtime/endpoint.json only when it is owned by this sidecar's kernel. */
  private removeOwnedEndpointFile(): void {
    if (this.childPid === null) return
    const record = this.readEndpointRecord()
    if (record !== null && record.pid === this.childPid) {
      try {
        unlinkSync(this.endpointFilePath())
      } catch {
        // already gone — fine
      }
    }
  }

  /**
   * Try to reuse an existing healthy kernel. Returns true when reused.
   * A kernel this sidecar spawned earlier in this process (in-memory child
   * record) is trusted directly; the published identity is still verified
   * when the file is available. Any OTHER healthy kernel on the port must
   * pass the endpoint.json identity gate or start() rejects.
   */
  private async tryReuse(): Promise<boolean> {
    const childAlive = this.child !== null && this.child.exitCode === null
    if (this.port === 0) {
      // Ephemeral port: only a kernel this sidecar spawned (in-memory child)
      // can be reused, and only while it still owns the resolved port. With a
      // dead/stale child there is nothing to reuse — clear the resolved port
      // so the next spawn re-resolves from the fresh endpoint.json.
      if (!childAlive) {
        // Dead/stale child: clear the resolved port AND our endpoint record
        // so the next spawn re-resolves from a fresh kernel's endpoint.json
        // instead of trusting the dead kernel's file.
        this.resolvedPort = null
        this.removeOwnedEndpointFile()
        this.childPid = null
        return false
      }
      if (!(await this.health())) {
        await this.killChild()
        this.removeOwnedEndpointFile()
        this.childPid = null
        this.resolvedPort = null
        return false
      }
      if (this.readEndpointRecord() !== null) {
        this.verifyReuseIdentity()
      } else {
        this.log('[research-plugin] reusing kernel spawned by this sidecar (in-memory child, no endpoint.json)')
      }
      return true
    }
    if (childAlive) {
      if (!(await this.health())) {
        // Our own child is gone/unhealthy — clear it before spawning fresh.
        await this.killChild()
        this.removeOwnedEndpointFile()
        this.childPid = null
        return false
      }
      if (this.readEndpointRecord() !== null) {
        this.verifyReuseIdentity()
      } else {
        this.log('[research-plugin] reusing kernel spawned by this sidecar (in-memory child, no endpoint.json)')
      }
      return true
    }
    if (!(await this.health())) return false
    this.verifyReuseIdentity()
    this.log(`[research-plugin] reusing running kernel at ${this.endpoint} (identity verified)`)
    return true
  }

  /**
   * Wait up to 10s for the kernel handshake: for port=0, resolve the actual
   * port from runtime/endpoint.json; then poll /v1/health until OK. Returns
   * false when the child dies or the deadline passes without a handshake.
   */
  private async waitHealthy(timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.child === null || this.child.exitCode !== null) return false
      if (this.port === 0 && this.resolvedPort === null) {
        const record = this.readEndpointRecord()
        // Only trust a record published by the kernel we just spawned (its
        // pid) — a stale file from an older kernel must not pin the port.
        if (record === null || this.childPid === null || record.pid !== this.childPid
          || typeof record.port !== 'number' || !Number.isInteger(record.port) || record.port <= 0) {
          await sleep(100)
          continue
        }
        this.resolvedPort = record.port
        this.writeEndpointFile(this.resolvedPort, this.childPid)
      }
      if (await this.health()) return true
      await sleep(100)
    }
    return false
  }

  /**
   * Start the kernel sidecar and wait until healthy. If another kernel is
   * already listening on the port, reuse it ONLY when its endpoint identity
   * matches this instance (SIDE-01); a foreign kernel is never terminated.
   */
  async start(): Promise<void> {
    if (await this.tryReuse()) return
    mkdirSync(this.dataDir, { recursive: true })
    const bin = this.resolveKernelBin()
    const dbPath = join(this.dataDir, DB_FILE_NAME)
    const casRoot = join(this.dataDir, 'cas')
    const args = [
      bin, '--db', dbPath, '--cas', casRoot, '--host', this.host, '--port', String(this.port),
      '--endpoint-file', this.endpointFilePath(),
    ]
    this.log(`[research-plugin] spawning research kernel: node ${args.join(' ')}`)
    const childEnv = { ...process.env }
    delete childEnv.DSH_SCHOLAR_KERNEL_TOKEN
    if (this.token !== undefined) childEnv.DSH_SCHOLAR_KERNEL_TOKEN = this.token
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...childEnv,
        DSH_SCHOLAR_KERNEL: '1',
      },
    })
    this.child = child
    this.childPid = child.pid ?? null
    child.stdout?.on('data', (chunk: Buffer) => this.log(`[research-kernel] ${chunk.toString().trimEnd()}`))
    child.stderr?.on('data', (chunk: Buffer) => this.log(`[research-kernel] ${chunk.toString().trimEnd()}`))
    child.on('exit', (code, signal) => {
      this.log(`[research-plugin] kernel exited (code=${code}, signal=${signal})`)
      if (this.child === child) this.child = null
    })
    try {
      // Fixed ports publish our identity immediately; port=0 publishes after
      // the actual port is resolved from the kernel's endpoint.json.
      if (this.port !== 0 && this.childPid !== null) this.writeEndpointFile(this.port, this.childPid)
      if (!(await this.waitHealthy())) {
        const hint = this.port === 0 && this.resolvedPort === null
          ? 'research kernel did not publish runtime/endpoint.json with a port within 10s (port=0)'
          : `research kernel did not become healthy at ${this.endpoint} (db=${dbPath})`
        throw new Error(hint)
      }
      this.log(`[research-plugin] kernel healthy at ${this.endpoint}`)
    } catch (error) {
      await this.killChild()
      this.removeOwnedEndpointFile()
      this.childPid = null
      this.resolvedPort = null
      throw error
    }
  }

  /** SIGTERM, then SIGKILL after a grace period. */
  private async killChild(): Promise<void> {
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

  /**
   * Stop the sidecar: remove the endpoint.json owned by our kernel (never a
   * foreign one), then SIGTERM/SIGKILL our child.
   */
  async stop(): Promise<void> {
    this.removeOwnedEndpointFile()
    this.childPid = null
    await this.killChild()
  }
}
