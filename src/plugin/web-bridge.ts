/**
 * Web bridge: exposes the Research Kernel over the DSH web origin under
 * `/research-api/*` (E7 UI data plane). Registered only when the httpServer
 * service is composed (web mode); headless profiles skip it. The kernel
 * stays on 127.0.0.1:7412; the bridge is a same-origin proxy with no
 * credentials and no extra privileges.
 *
 * Security posture (design §15.2/§15.3, SCH-WEB-001/002, SCH-SEC-002):
 * - Token mode: when a bridge token is configured (env
 *   `DSH_SCHOLAR_BRIDGE_TOKEN` or `BridgeSecurityOptions.token`), every
 *   request must present `Authorization: Bearer <token>` or
 *   `X-Research-Token`; otherwise 401. Token mode is opt-in (default off,
 *   fully backward compatible). The token is only ever read from env/config
 *   and is never logged and never put into argv.
 * - CSRF: non-GET requests with an `Origin` header are accepted only when
 *   the origin is 127.0.0.1/localhost on the request's own port (derived
 *   from the `Host` header); otherwise 403.
 * - Body limit: request bodies are capped at 16 MiB; beyond that 413.
 * - Binary streaming: JSON upstream responses are forwarded as text; any
 *   other content type (artifacts, PDFs, images) is streamed through as
 *   raw bytes with content-type/content-length/content-disposition kept.
 * - Error desanitization: upstream failures return only a code plus a
 *   generic message; internal paths/env never leak.
 * - Rate limit: per-client-IP sliding window (default 60 req/min); 429.
 * @module @dsh-scholar/research-plugin/web-bridge
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from 'cordis'
// Module augmentation: ctx.httpServer (web composition, @deepseek-ai/dsh-host-webserver).
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { KernelSidecar } from './sidecar.ts'

/** Max request body forwarded to the kernel (16 MiB). */
export const MAX_BODY_BYTES = 16 * 1024 * 1024

/** Default per-IP sliding window: 60 requests / minute. */
export const DEFAULT_RATE_LIMIT = { windowMs: 60_000, max: 60 } as const

const ALLOWED_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export interface BridgeSecurityOptions {
  /** Bridge auth token; falls back to env DSH_SCHOLAR_BRIDGE_TOKEN. undefined = disabled. */
  token?: string
  /** Per-IP sliding window limits; defaults to 60 req/min. */
  rateLimit?: { windowMs?: number; max?: number }
}

/** true when `bytes` fits the bridge body limit (pure, testable). */
export function withinBodyLimit(bytes: number, limit: number = MAX_BODY_BYTES): boolean {
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= limit
}

/**
 * CSRF origin check (pure, testable): a write request is same-site only when
 * the Origin is http(s)://127.0.0.1|localhost|<same port as Host>.
 * Absent Origin (curl / non-browser clients) is allowed; absent Host is not.
 */
export function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true
  if (host === undefined) return false
  let originPort: string
  try {
    const o = new URL(origin)
    if (o.protocol !== 'http:' && o.protocol !== 'https:') return false
    if (!ALLOWED_ORIGIN_HOSTS.has(o.hostname)) return false
    originPort = o.port === '' ? (o.protocol === 'https:' ? '443' : '80') : o.port
  } catch {
    return false
  }
  let hostPort: string
  try {
    const h = new URL(`http://${host}`)
    hostPort = h.port === '' ? '80' : h.port
  } catch {
    return false
  }
  return originPort === hostPort
}

/** true when the upstream content type is JSON (forward as text, not bytes). */
export function isJsonContentType(contentType: string | null | undefined): boolean {
  if (contentType === undefined || contentType === null) return false
  const base = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  return base === 'application/json' || base.endsWith('+json')
}

/** Constant-time string comparison (token values never appear in logs). */
export function constantTimeEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a.length === 0 || b.length === 0) return false
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** true when the presented credential satisfies the bridge token policy. */
export function verifyBridgeToken(provided: string | undefined, expected: string | undefined): boolean {
  if (expected === undefined) return true // token mode disabled
  return constantTimeEqual(provided, expected)
}

/** Sliding-window per-key rate limiter (pure, testable with `now`). */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly windowMs: number
  private readonly max: number

  constructor(options: { windowMs?: number; max?: number } = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_RATE_LIMIT.windowMs
    this.max = options.max ?? DEFAULT_RATE_LIMIT.max
  }

  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs
    let list = this.hits.get(key)
    if (list === undefined) {
      list = []
      this.hits.set(key, list)
      if (this.hits.size > 10_000) this.prune(now)
    }
    while (list.length > 0 && (list[0] ?? 0) <= cutoff) list.shift()
    if (list.length >= this.max) return false
    list.push(now)
    return true
  }

  /** Drop entries whose window has fully elapsed (bounded memory). */
  prune(now: number = Date.now()): void {
    const cutoff = now - this.windowMs
    for (const [key, list] of this.hits) {
      while (list.length > 0 && (list[0] ?? 0) <= cutoff) list.shift()
      if (list.length === 0) this.hits.delete(key)
    }
  }
}

interface BodyRead {
  body: string | undefined
  tooLarge: boolean
}

/** Read the request body up to `limit` bytes; 413-sized bodies are flagged. */
function readBody(req: IncomingMessage, limit: number): Promise<BodyRead> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const done = (value: BodyRead): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (!withinBodyLimit(total, limit)) {
        done({ body: undefined, tooLarge: true })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done({ body: chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined, tooLarge: false }))
    req.on('error', () => done({ body: undefined, tooLarge: false }))
    req.on('close', () => done({ body: undefined, tooLarge: false }))
  })
}

/** Extract the bridge credential from Authorization / X-Research-Token. */
function extractToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth)
    if (match !== null) return match[1]?.trim()
  }
  const alt = req.headers['x-research-token']
  return typeof alt === 'string' ? alt.trim() : undefined
}

/** JSON error responses never carry internal paths/env (design §15.2). */
function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify({ error: { code, message } }))
}

/** Forward the upstream response: JSON as text, anything else as bytes. */
async function forwardUpstream(upstream: Response, res: ServerResponse): Promise<void> {
  if (upstream.status >= 500) {
    // Desanitize: never forward the kernel's internal error body.
    sendError(res, upstream.status, 'kernel_error', 'research kernel error')
    return
  }
  const contentType = upstream.headers.get('content-type')
  if (isJsonContentType(contentType)) {
    const text = await upstream.text()
    res.writeHead(upstream.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(text)
    return
  }
  // Binary passthrough (artifacts, PDFs, images): keep the meaningful headers.
  const headers: Record<string, string> = { 'x-content-type-options': 'nosniff' }
  if (contentType !== null) headers['content-type'] = contentType
  const length = upstream.headers.get('content-length')
  if (length !== null) headers['content-length'] = length
  const disposition = upstream.headers.get('content-disposition')
  if (disposition !== null) headers['content-disposition'] = disposition
  res.writeHead(upstream.status, headers)
  if (upstream.body !== null) {
    Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(res)
  } else {
    res.end()
  }
}

/** Register the /research-api prefix route proxying to the kernel sidecar. */
export function registerResearchApiBridge(ctx: Context, sidecar: KernelSidecar, options: BridgeSecurityOptions = {}): void {
  ctx.inject(['httpServer'], httpCtx => {
    const token = options.token ?? process.env.DSH_SCHOLAR_BRIDGE_TOKEN
    const limiter = new SlidingWindowRateLimiter(options.rateLimit)
    httpCtx.effect(() => httpCtx.httpServer.register({
      kind: 'prefix',
      path: '/research-api',
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
          // 1. Rate limit (per client IP, in-memory sliding window).
          if (!limiter.allow(req.socket.remoteAddress ?? 'unknown')) {
            sendError(res, 429, 'rate_limited', 'too many requests — slow down')
            return
          }
          // 2. Token auth (opt-in; §15.3).
          if (!verifyBridgeToken(extractToken(req), token)) {
            res.writeHead(401, {
              'content-type': 'application/json; charset=utf-8',
              'www-authenticate': 'Bearer',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
            })
            res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'missing or invalid bridge token' } }))
            return
          }
          // 3. CSRF: origin check for state-changing requests (§15.2).
          const method = (req.method ?? 'GET').toUpperCase()
          if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
            const origin = req.headers.origin
            if (!isAllowedOrigin(typeof origin === 'string' ? origin : undefined, req.headers.host)) {
              sendError(res, 403, 'forbidden', 'cross-origin write rejected')
              return
            }
          }
          // 4. Strip the bridge prefix; the rest is the kernel path (/v1/...).
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const target = `${sidecar.endpoint}${url.pathname.replace(/^\/research-api/, '')}${url.search}`
          // 5. Read the body under the 16 MiB cap.
          let body: string | undefined
          if (method !== 'GET' && method !== 'HEAD') {
            const read = await readBody(req, MAX_BODY_BYTES)
            if (read.tooLarge) {
              sendError(res, 413, 'payload_too_large', 'request body exceeds 16 MiB limit')
              return
            }
            body = read.body
          }
          // 6. Proxy to the kernel. In token mode the same token authenticates
          //    the bridge -> kernel hop (kernel --token must match).
          const upstreamHeaders: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
          if (token !== undefined) upstreamHeaders.authorization = `Bearer ${token}`
          const upstream = await fetch(target, { method, headers: upstreamHeaders, body })
          await forwardUpstream(upstream, res)
        } catch {
          // Desanitized: no error.message (may embed paths/env) and no endpoint.
          sendError(res, 502, 'kernel_unreachable', 'research kernel unavailable')
        }
      },
    }), 'research-plugin: /research-api bridge')
  })
}
