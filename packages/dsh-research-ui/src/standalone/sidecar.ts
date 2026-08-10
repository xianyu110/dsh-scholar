/**
 * Research Kernel lifecycle owned by the standalone DSH Scholar server.
 * The browser never talks to this loopback endpoint directly; all access
 * crosses the standalone BFF.
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
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

export interface UiKernelSidecarOptions {
  host?: string
  port?: number
  dataDir?: string
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
const SERVICE_TOKEN_FILE = 'service-token'
const HANDSHAKE_TIMEOUT_MS = 10_000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class UiKernelSidecar {
  private child: ChildProcess | null = null
  /** pid of the kernel this sidecar spawned (survives child exit, for file ownership). */
  private childPid: number | null = null
  /** Actual bound port once known (always set after a successful spawn). */
  private resolvedPort: number | null = null
  /** Cached value of <dataDir>/service-token (lazy, see ensureServiceToken). */
  private serviceTokenValue: string | undefined
  private readonly require = createRequire(import.meta.url)
  readonly host: string
  /** Configured port; 0 means "ephemeral — resolve from runtime/endpoint.json". */
  readonly port: number
  readonly dataDir: string
  private readonly log: (line: string) => void

  constructor(options: UiKernelSidecarOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 7412
    this.dataDir = resolve(options.dataDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh-scholar-standalone'), 'research-ui-standalone'))
    this.log = options.log ?? (() => undefined)
  }

  /**
   * §4 P0 (API-01/EVID-01): the kernel's INTERNAL-route service identity.
   * The 0600 `<dataDir>/service-token` file is created on first use (random
   * 32 hex) and reused afterwards, so every process of this instance —
   * kernel, runner, BFF proxy — authenticates with the SAME token. The
   * token is only ever passed via env, never argv.
   */
  get serviceToken(): string {
    return this.ensureServiceToken()
  }

  private ensureServiceToken(): string {
    if (this.serviceTokenValue !== undefined) return this.serviceTokenValue
    const file = join(this.dataDir, SERVICE_TOKEN_FILE)
    let existing = false
    try {
      const stat = lstatSync(file)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`service token path must be a regular file: ${file}`)
      }
      existing = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    let token = ''
    if (existing) {
      token = readFileSync(file, 'utf8').trim()
      chmodSync(file, 0o600)
    }
    if (token === '') {
      mkdirSync(this.dataDir, { recursive: true })
      token = randomBytes(16).toString('hex')
      try {
        writeFileSync(file, token, { mode: 0o600, flag: 'wx' })
      } catch {
        // Lost a race with a concurrent sidecar on the same dataDir — the
        // existing file is authoritative (both spawn the same kernel token).
        token = readFileSync(file, 'utf8').trim()
      }
      chmodSync(file, 0o600)
    }
    if (token === '') {
      // Fail-closed: an empty token would lock every internal route behind
      // an unusable credential.
      throw new Error(`service token file must not be empty: ${file}`)
    }
    this.serviceTokenValue = token
    return token
  }

  /**
   * Kernel HTTP endpoint. With `port: 0` it is unavailable until `start()`
   * has resolved the actual port from runtime/endpoint.json.
   */
  get endpoint(): string {
    const port = this.resolvedPort ?? (this.port !== 0 ? this.port : null)
    if (port === null) {
      throw new Error('UiKernelSidecar endpoint is unavailable until start() resolves the actual port (port=0)')
    }
    return `http://${this.host}:${port}`
  }

  private resolveKernelBin(): string {
    const pkgPath = this.require.resolve('@dsh-scholar/research-kernel/package.json')
    return join(dirname(pkgPath), 'lib', 'bin', 'kernel.js')
  }

  private endpointFilePath(): string {
    return join(this.dataDir, 'runtime', 'endpoint.json')
  }

  private async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/v1/health`, { signal: AbortSignal.timeout(1500) })
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
    this.log(`[research-ui] kernel identity verified (database=${String(record.database)}, dataDir=${String(record.dataDir)}, pid=${String(record.pid)})`)
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
        this.log('[research-ui] reusing kernel spawned by this sidecar (in-memory child, no endpoint.json)')
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
        this.log('[research-ui] reusing kernel spawned by this sidecar (in-memory child, no endpoint.json)')
      }
      return true
    }
    if (!(await this.health())) return false
    this.verifyReuseIdentity()
    this.log(`[research-ui] reusing running kernel at ${this.endpoint} (identity verified)`)
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
    this.log(`[research-ui] spawning research kernel: node ${args.join(' ')}`)
    // §4 P0 (API-01/EVID-01): the kernel's internal-route service identity
    // travels via env only (0600 file, never argv / process listings).
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DSH_SCHOLAR_SERVICE_TOKEN: this.serviceToken,
      },
    })
    this.child = child
    this.childPid = child.pid ?? null
    child.stdout?.on('data', (chunk: Buffer) => this.log(`[research-kernel] ${chunk.toString().trimEnd()}`))
    child.stderr?.on('data', (chunk: Buffer) => this.log(`[research-kernel] ${chunk.toString().trimEnd()}`))
    child.on('exit', (code, signal) => {
      this.log(`[research-ui] kernel exited (code=${code}, signal=${signal})`)
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
      this.log(`[research-ui] kernel healthy at ${this.endpoint}`)
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
      child.once('exit', () => { clearTimeout(timer); resolve() })
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
