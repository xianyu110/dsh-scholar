import { createHash, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

export const MAX_BODY_BYTES = 16 * 1024 * 1024
// Loopback-only UI: the panel polls every 8s and fires parallel fetches per
// render, so 60/min starves an active session. 300/min still bounds abusive
// bursts while keeping the workspace usable (security-baseline.md §loopback).
export const DEFAULT_RATE_LIMIT = { windowMs: 60_000, max: 300 } as const

/** Tokenless standalone mode is only safe on an explicit loopback bind. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === 'localhost.') return true
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
  return isIP(normalized) === 4 && normalized.split('.')[0] === '127'
}

export function withinBodyLimit(bytes: number, limit: number = MAX_BODY_BYTES): boolean {
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= limit
}

export function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true
  if (host === undefined) return false
  try {
    const parsedOrigin = new URL(origin)
    if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') return false
    if (!isLoopbackHost(parsedOrigin.hostname)) return false
    const originPort = parsedOrigin.port === '' ? (parsedOrigin.protocol === 'https:' ? '443' : '80') : parsedOrigin.port
    const parsedHost = new URL(`http://${host}`)
    const hostPort = parsedHost.port === '' ? '80' : parsedHost.port
    return originPort === hostPort
  } catch {
    return false
  }
}

export function isJsonContentType(contentType: string | null | undefined): boolean {
  if (contentType === undefined || contentType === null) return false
  const base = (contentType.split(';')[0] ?? '').trim().toLowerCase()
  return base === 'application/json' || base.endsWith('+json')
}

export function constantTimeEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a.length === 0 || b.length === 0) return false
  const left = createHash('sha256').update(a).digest()
  const right = createHash('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}

export function verifyBridgeToken(provided: string | undefined, expected: string | undefined): boolean {
  return expected === undefined || constantTimeEqual(provided, expected)
}

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

  prune(now: number = Date.now()): void {
    const cutoff = now - this.windowMs
    for (const [key, list] of this.hits) {
      while (list.length > 0 && (list[0] ?? 0) <= cutoff) list.shift()
      if (list.length === 0) this.hits.delete(key)
    }
  }
}
