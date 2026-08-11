/**
 * SSE-01 Generic SSE stream consumer (fetch ReadableStream): the shared
 * transport underneath the PTY frames stream, the Workspace watch stream and
 * the Trajectory incremental stream (client logic layer — panels/models only
 * assemble; tests inject mock streams).
 *
 * What lives here:
 *
 *  - SSE frame parsing per the WHATWG server-sent-events format: `event:` /
 *    `data:` / `id:` / `retry:` fields, multi-line `data:` joined with '\n',
 *    `:` comment lines (heartbeats), dispatch on the blank line. A `retry:`
 *    field overrides the next reconnect delay (spec behavior).
 *  - the stream lifecycle: connecting → live → reconnecting ⇄ live → closed.
 *    Any stream end, transport error, non-ok HTTP response or heartbeat
 *    timeout (no bytes for heartbeatTimeoutMs) reconnects with exponential
 *    backoff (base * 2^attempt, capped), resuming from the cursor the
 *    CONSUMER folds into its `url()` builder — so reconnect always continues
 *    from the last applied seq/rev, never from the start.
 *  - cancellation: close() aborts the in-flight fetch/read via an internal
 *    AbortController (no reconnect afterwards); `maxReconnectAttempts`
 *    bounds the retry loop and ends with onEnd('max-retries') so models can
 *    fall back to their polling path (PTY after_seq poll / workspace listSince
 *    poll / trajectory pagination — a designed degradation, never a silent
 *    stop).
 *  - injectable transport (`fetchImpl` — the browser fetch wrapper with auth
 *    headers in production, scripted ReadableStreams in Node tests) and an
 *    injectable scheduler (deterministic backoff/heartbeat timers in tests).
 *
 * PURE LOGIC — NO DOM: the fetch function and the timer scheduler are
 * injected, so the whole state machine is unit-testable
 * (tests/unit/sse-client.test.ts) without a browser.
 */
export type SseFetch = (url: string, init: SseRequestInit) => Promise<SseResponse>

/** Minimal RequestInit subset the consumer needs (headers + abort signal). */
export interface SseRequestInit {
  headers?: Record<string, string>
  signal?: AbortSignal
}

/** Minimal Response projection (the browser Response is structurally
 *  compatible; Node tests return plain objects with a mock body). */
export interface SseResponse {
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array> | null
}

/** One parsed SSE dispatch. `event` is the `event:` field ('' = message),
 *  `data` the accumulated `data:` lines joined with '\n', `id` the `id:`
 *  field when present. The consumer parses `data` (JSON) itself. */
export interface SseEvent {
  event: string
  data: string
  id: string | null
}

/** Client-visible stream lifecycle. 'closed' = closed by the consumer or
 *  after max reconnect attempts (models map it onto their disconnected /
 *  fallback copy). */
export type SseClientStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed'

/** Why the stream stopped (models decide fallback vs silence). */
export type SseEndReason =
  | 'aborted'            // consumer closed the client
  | 'stream-end'         // server closed the stream (EOF without error)
  | 'transport-error'    // fetch rejected or non-ok response
  | 'heartbeat-timeout'  // no bytes for heartbeatTimeoutMs
  | 'max-retries'        // reconnect attempts exhausted

export interface SseError {
  code: string
  status: number
  message?: string
}

/** Timer abstraction (global setTimeout in the browser, injected/fake in
 *  tests — same shape as the model schedulers so one fake drives both). */
export interface SseScheduler {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}

const defaultScheduler: SseScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => { clearTimeout(timer as ReturnType<typeof setTimeout>) },
}

/** The browser default scheduler (global setTimeout) — models/panels that
 *  drive their own timers (watch retry, poll fallback) reuse it when no
 *  scheduler is injected. */
export const defaultSseScheduler: SseScheduler = defaultScheduler

export interface SseClientOptions {
  /** Build the stream URL for EVERY (re)connect — the consumer folds its own
   *  last seq/rev cursor in here, so reconnect resumes from where the stream
   *  stopped (never replays from 0, never drops what was already applied). */
  url: () => string
  /** Event dispatch (data is the raw string; consumers JSON.parse). */
  onEvent: (event: SseEvent) => void
  /** Injectable fetch (default: the global fetch — browser + Node 18+). */
  fetchImpl?: SseFetch
  /** Extra headers per connect (auth / lease headers). */
  headers?: () => Promise<Record<string, string>> | Record<string, string>
  /** Status transitions (models drive status copy from this). */
  onStatus?: (status: SseClientStatus) => void
  /** Terminal stops (incl. transient ones — the client already reconnects;
   *  models use 'max-retries' to switch to their polling fallback). */
  onEnd?: (reason: SseEndReason) => void
  /** Transient errors during connect/read (heartbeat timeouts, HTTP errors). */
  onError?: (error: SseError) => void
  scheduler?: SseScheduler
  /** No bytes for this long → the stream is considered dead and reconnects
   *  (server heartbeats must arrive more often than this). */
  heartbeatTimeoutMs?: number
  /** Reconnect backoff: base * 2^attempt, capped at reconnectMaxMs. */
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  /** Bound on consecutive failed reconnect attempts before
   *  onEnd('max-retries'); 0/undefined = retry forever. */
  maxReconnectAttempts?: number
}

export class SseClient {
  readonly options: SseClientOptions
  private readonly scheduler: SseScheduler
  private readonly fetchImpl: SseFetch
  private readonly heartbeatTimeoutMs: number
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly maxReconnectAttempts: number

  status: SseClientStatus = 'idle'
  /** The `retry:` field of the last SSE dispatch (spec: overrides the next
   *  reconnect delay). */
  private serverRetryMs: number | null = null

  private abort: AbortController | null = null
  private closed = false
  private connectAttempt = 0
  private heartbeatTimer: unknown = null
  private reconnectTimer: unknown = null
  private pollTimer: unknown = null
  private active = false

  constructor(options: SseClientOptions) {
    this.options = options
    this.scheduler = options.scheduler ?? defaultScheduler
    this.fetchImpl = options.fetchImpl ?? defaultFetch
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30_000
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1000
    this.reconnectMaxMs = options.reconnectMaxMs ?? 15_000
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 0
  }

  /* ─────────────────────────── lifecycle ─────────────────────────── */

  /** Start (or restart) the stream: connecting → live. Idempotent when
   *  already live/connecting. */
  open(): void {
    if (this.closed || this.active) return
    this.active = true
    this.connectAttempt = 0
    void this.connect()
  }

  /** Permanently stop the stream: aborts the in-flight fetch/read and
   *  cancels any scheduled reconnect/heartbeat. No further reconnects. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.active = false
    this.clearTimers()
    this.abort?.abort()
    this.abort = null
    this.setStatus('closed')
  }

  private setStatus(status: SseClientStatus): void {
    if (this.status === status) return
    this.status = status
    this.options.onStatus?.(status)
  }

  private clearTimers(): void {
    if (this.heartbeatTimer !== null) {
      this.scheduler.clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.reconnectTimer !== null) {
      this.scheduler.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.pollTimer !== null) {
      this.scheduler.clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  private end(reason: SseEndReason): void {
    if (this.closed) return
    this.clearTimers()
    this.abort?.abort()
    this.abort = null
    if (reason === 'aborted' || this.maxReconnectAttempts > 0 && this.connectAttempt >= this.maxReconnectAttempts) {
      // Give up: consumer closed us, or the retry budget is exhausted.
      this.active = false
      this.setStatus('closed')
      this.options.onEnd?.(reason === 'aborted' ? 'aborted' : 'max-retries')
      return
    }
    // Transient end → exponential backoff reconnect (resumes from the
    // consumer's cursor via url()).
    this.setStatus('reconnecting')
    this.options.onEnd?.(reason)
    // Keep the loop alive for the scheduled reconnect (open() no-ops while
    // a reconnect is already pending).
    this.active = true
    const base = this.serverRetryMs ?? this.reconnectBaseMs
    const delay = Math.min(this.reconnectMaxMs, base * 2 ** Math.max(0, this.connectAttempt - 1))
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null
      if (this.closed) return
      void this.connect()
    }, delay)
  }

  /* ─────────────────────────── connect + read loop ─────────────────────────── */

  private async connect(): Promise<void> {
    if (this.closed || !this.active) return
    this.connectAttempt += 1
    this.setStatus('connecting')
    const abort = new AbortController()
    this.abort = abort
    const headers = typeof this.options.headers === 'function'
      ? await this.options.headers()
      : (this.options.headers ?? {})
    if (this.closed || !this.active || abort.signal.aborted) return
    let response: SseResponse
    try {
      response = await this.fetchImpl(this.options.url(), { headers, signal: abort.signal })
    } catch {
      if (abort.signal.aborted || this.closed) return // consumer closed mid-fetch
      this.options.onError?.({ code: 'network_error', status: 0, message: 'stream fetch failed' })
      this.end('transport-error')
      return
    }
    if (this.closed || !this.active || abort.signal.aborted) return
    if (!response.ok) {
      this.options.onError?.({ code: 'http_error', status: response.status, message: `stream http ${response.status}` })
      this.end('transport-error')
      return
    }
    if (response.body === null) {
      this.options.onError?.({ code: 'empty_body', status: response.status, message: 'stream body missing' })
      this.end('transport-error')
      return
    }
    this.setStatus('live')
    this.connectAttempt = 0
    await this.readLoop(response.body, abort)
  }

  private async readLoop(body: ReadableStream<Uint8Array>, abort: AbortController): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let parser = createSseParser((event) => {
      this.onDispatch(event)
    })
    try {
      for (;;) {
        // Heartbeat watchdog: any byte resets it; silence past the timeout
        // aborts and reconnects (a half-open stream never hangs forever).
        this.armHeartbeat()
        const { done, value } = await reader.read()
        if (this.closed || !this.active || abort.signal.aborted) return
        if (done) break
        buffer = parser.feed(decoder.decode(value, { stream: true }))
      }
      if (this.closed || !this.active || abort.signal.aborted) return
      this.end('stream-end')
    } catch (error) {
      if (this.closed || !this.active || abort.signal.aborted) return
      this.options.onError?.({
        code: error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'read_error',
        status: 0,
        message: error instanceof Error ? error.message : 'stream read failed',
      })
      this.end('transport-error')
    } finally {
      this.scheduler.clearTimeout(this.heartbeatTimer as ReturnType<typeof setTimeout>)
      this.heartbeatTimer = null
      void buffer
    }
  }

  private armHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.scheduler.clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.heartbeatTimer = this.scheduler.setTimeout(() => {
      this.heartbeatTimer = null
      if (this.closed || !this.active) return
      this.options.onError?.({ code: 'heartbeat_timeout', status: 0, message: 'no stream bytes within heartbeatTimeoutMs' })
      this.end('heartbeat-timeout')
    }, this.heartbeatTimeoutMs)
  }

  /** One parsed SSE dispatch → the consumer callback (retry: honored). */
  private onDispatch(event: SseEvent): void {
    if (event.data === '') return
    // spec: `retry:` overrides the next reconnect delay
    if (event.event === 'retry') {
      const ms = Number(event.data)
      if (Number.isFinite(ms) && ms > 0) this.serverRetryMs = ms
      return
    }
    this.options.onEvent(event)
  }
}

/** The default fetch wrapper (browser + Node 18+ global fetch — the browser
 *  Response is structurally an SseResponse). */
const defaultFetch: SseFetch = async (url, init) => {
  const response = await fetch(url, init as RequestInit)
  return { ok: response.ok, status: response.status, body: response.body }
}

/* ─────────────────────────── SSE frame parser ─────────────────────────── */

export interface SseParser {
  /** Feed one decoded text chunk; returns the carry-over buffer. */
  feed(chunk: string): string
}

/** Streaming SSE field parser (per the WHATWG eventsource format):
 *  `event:`/`data:`/`id:`/`retry:` fields, `data:` lines accumulated and
 *  joined with '\n', `:` comment lines skipped, dispatch on the blank line.
 *  Returns the unconsumed buffer tail so callers feed it back. */
export function createSseParser(dispatch: (event: SseEvent) => void): SseParser {
  let buffer = ''
  let pendingEvent = ''
  let pendingId: string | null = null
  let pendingData: string[] = []
  let hasFields = false

  const dispatchNow = (): void => {
    if (!hasFields) return
    dispatch({ event: pendingEvent === '' ? 'message' : pendingEvent, data: pendingData.join('\n'), id: pendingId })
    pendingEvent = ''
    pendingId = null
    pendingData = []
    hasFields = false
  }

  return {
    feed(chunk: string): string {
      buffer += chunk
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') {
          dispatchNow()
          continue
        }
        if (line.startsWith(':')) continue // heartbeat comment
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'retry') {
          // `retry:` is a control field: dispatch it immediately so the
          // client can honor the server's requested reconnect delay (it
          // does not contribute to the next data dispatch).
          dispatch({ event: 'retry', data: value, id: null })
          continue
        }
        hasFields = true
        if (field === 'event') pendingEvent = value
        else if (field === 'data') pendingData.push(value)
        else if (field === 'id') pendingId = value
        // unknown fields are ignored (spec)
      }
      return buffer
    },
  }
}

/* ─────────────────────────── test helpers ─────────────────────────── */

/** A scripted ReadableStream that the tests can push into / end / error
 *  later — the mock-body counterpart of the browser's fetch body. */
export class MockSseStream {
  readonly stream: ReadableStream<Uint8Array>
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null

  constructor() {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => { this.controller = controller },
    })
  }

  /** Enqueue one text chunk (UTF-8 encoded). */
  push(text: string): void {
    this.controller?.enqueue(new TextEncoder().encode(text))
  }

  /** Close the stream (server EOF → client reconnects unless closed). */
  end(): void {
    try { this.controller?.close() } catch { /* already closed */ }
  }

  /** Fail the stream with an error (transport fault → client reconnects). */
  error(err: unknown): void {
    try { this.controller?.error(err) } catch { /* already closed */ }
  }
}

/** Scripted fetch for Node tests: maps URLs to a queue of responses
 *  (MockSseStream bodies or HTTP-error projections). */
export class MockSseFetch {
  /** url → queue of response factories (each call shifts one). */
  private queues = new Map<string, Array<() => SseResponse>>()
  calls: Array<{ url: string; signal: AbortSignal | null }> = []

  /** Enqueue one response for a URL (empty body queue → default 200 with an
   *  empty never-ending stream so reads stay pending). */
  enqueue(url: string, response: SseResponse): void {
    const q = this.queues.get(url) ?? []
    q.push(() => response)
    this.queues.set(url, q)
  }

  /** Enqueue a streaming response built from a MockSseStream (returns the
   *  stream so the test can push/end it). */
  enqueueStream(url: string): MockSseStream {
    const mock = new MockSseStream()
    this.enqueue(url, { ok: true, status: 200, body: mock.stream })
    return mock
  }

  enqueueError(url: string, status = 500): void {
    this.enqueue(url, { ok: false, status, body: null })
  }

  /** Re-enqueue the LAST response for the URL (consecutive identical
   *  responses — reconnect loops without scripted variety). */
  repeatLast(url: string): void {
    const q = this.queues.get(url)
    const last = q?.at(-1)
    if (last !== undefined) q!.push(last)
  }

  async fetchImpl(url: string, init: SseRequestInit): Promise<SseResponse> {
    this.calls.push({ url, signal: init.signal ?? null })
    const q = this.queues.get(url)
    if (q === undefined || q.length === 0) {
      // Default: an empty stream that never ends (read stays pending).
      const mock = new MockSseStream()
      return { ok: true, status: 200, body: mock.stream }
    }
    return q.shift()!()
  }
}
