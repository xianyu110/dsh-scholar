import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { ScholarAgentReply } from '@dsh-scholar/research-schemas'

const MAX_BODY_BYTES = 1_048_576

export interface ScholarAgentBridgeEndpoint {
  origin: string
  pid: number
  started_at: string
}

export interface ScholarAgentBridgeOptions {
  dataDir: string
  handler: () => ((payload: unknown, signal?: AbortSignal) => Promise<ScholarAgentReply>) | undefined
  log?: (line: string) => void
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(bytes)
}

async function body(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > MAX_BODY_BYTES) return null
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

function atomicPrivateFile(path: string, value: string): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  writeFileSync(temp, value, { mode: 0o600, flag: 'wx' })
  renameSync(temp, path)
  chmodSync(path, 0o600)
}

function bearer(req: IncomingMessage): string | null {
  const value = req.headers.authorization
  const match = typeof value === 'string' ? /^Bearer\s+(.+)$/i.exec(value) : null
  return match?.[1] ?? null
}

function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false
  const left = Buffer.from(presented)
  const right = Buffer.from(expected)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message === 'Harness model is unavailable') return 'model_stream_unavailable'
  if (message === 'Harness model returned invalid Scholar JSON') return 'invalid_model_json'
  if (message === 'Harness model returned the wrong Scholar operation') return 'wrong_model_operation'
  if (/^Harness model returned \d+ ideas; \d+ required$/.test(message)) return 'wrong_idea_count'
  if (message === 'Harness model returned duplicate ideas') return 'duplicate_ideas'
  if (message === 'Harness model invented a paper outside the frozen corpus') return 'foreign_corpus_reference'
  if (error instanceof Error && error.name === 'ZodError') return 'schema_rejected'
  return 'request_rejected'
}

/** Local authenticated HTTP bridge owned by the DSH plugin fiber. */
export class ScholarAgentBridge {
  private server: Server | null = null
  private token = ''
  private endpoint: ScholarAgentBridgeEndpoint | null = null
  private readonly endpointFile: string
  private readonly tokenFile: string

  constructor(private readonly options: ScholarAgentBridgeOptions) {
    this.endpointFile = join(options.dataDir, 'agent-bridge-endpoint.json')
    this.tokenFile = join(options.dataDir, 'agent-bridge-token')
  }

  async start(): Promise<ScholarAgentBridgeEndpoint> {
    if (this.server !== null && this.endpoint !== null) return this.endpoint
    mkdirSync(this.options.dataDir, { recursive: true })
    this.token = randomBytes(32).toString('hex')
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/turn') {
        json(res, 404, { error: { code: 'not_found', message: 'not found' } })
        return
      }
      if (!tokenMatches(bearer(req), this.token)) {
        json(res, 401, { error: { code: 'unauthorized', message: 'unauthorized' } })
        return
      }
      const bytes = await body(req)
      if (bytes === null) {
        json(res, 413, { error: { code: 'payload_too_large', message: 'payload too large' } })
        return
      }
      let payload: unknown
      try { payload = JSON.parse(bytes.toString('utf8')) } catch {
        json(res, 400, { error: { code: 'invalid_json', message: 'bad request' } })
        return
      }
      const handler = this.options.handler()
      if (handler === undefined) {
        json(res, 503, { error: { code: 'model_unavailable', message: 'Harness model is unavailable' } })
        return
      }
      const controller = new AbortController()
      req.once('aborted', () => controller.abort())
      try {
        json(res, 200, await handler(payload, controller.signal))
      } catch (error) {
        const failureCode = safeFailureCode(error)
        this.options.log?.(`Scholar agent request failed (${failureCode})`)
        // This response is visible only on the authenticated loopback bridge.
        // The standalone BFF deliberately collapses it to model_unavailable.
        json(res, 502, { error: { code: failureCode, message: 'Harness model is unavailable' } })
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close()
      throw new Error('Scholar agent bridge failed to bind loopback')
    }
    this.server = server
    this.endpoint = { origin: `http://127.0.0.1:${address.port}`, pid: process.pid, started_at: new Date().toISOString() }
    atomicPrivateFile(this.tokenFile, this.token)
    atomicPrivateFile(this.endpointFile, JSON.stringify(this.endpoint))
    this.options.log?.('Scholar agent bridge ready')
    return this.endpoint
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server !== null) await new Promise<void>(resolve => server.close(() => resolve()))
    let ownsFiles = false
    try {
      if (existsSync(this.endpointFile) && !lstatSync(this.endpointFile).isSymbolicLink()) {
        const saved = JSON.parse(readFileSync(this.endpointFile, 'utf8')) as { pid?: unknown; origin?: unknown }
        ownsFiles = saved.pid === this.endpoint?.pid && saved.origin === this.endpoint?.origin
      }
    } catch { ownsFiles = false }
    if (ownsFiles) {
      rmSync(this.endpointFile, { force: true })
      rmSync(this.tokenFile, { force: true })
    }
    this.endpoint = null
    this.token = ''
  }
}
