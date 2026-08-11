/**
 * PTY-01 Interactive Terminal client logic layer (hardening-v0.2-status.md
 * §5 P1, execution-runtime.md §6.1, api-contracts.md §18): the session
 * lifecycle model, control queue and frames consumption for the pty panel
 * (panels/pty.ts).
 *
 * PURE LOGIC — NO DOM: the transport (fetch wrappers) and the timer
 * scheduler are injected, so the whole state machine is unit-testable
 * (tests/unit/pty-client.test.ts) and panels/pty.ts only assembles nodes
 * from this model (same split as trajectory-model.ts / panels).
 *
 * Wire contract (research-schemas/pty.ts, mirrored structurally so the
 * browser bundle stays dependency-light):
 *
 *   open     POST /v1/pty/sessions            → PtySession (lease pinned)
 *   get      GET  /v1/pty/sessions/{id}       → PtySession (generation/state)
 *   control  POST /v1/pty/sessions/{id}/control  (x-pty-lease; client_seq
 *            is the idempotency key — duplicate seq replays as a no-op,
 *            reordered/gapped seq is 409 pty_client_seq_out_of_order)
 *   frames   GET  /v1/pty/sessions/{id}/frames?after_seq= (server_seq
 *            monotonic; gap frame + page.gap when retention evicted)
 *
 * Client session state machine:
 *
 *   idle (no session) ──open()──▶ opening ──ok──▶ open ──detach()──▶ detached
 *        ▲                 │                       │  ▲                │
 *        │ reopen()        │ fail                  │  └──reconnect()───┘
 *        │                 ▼                       ▼ (server closed / close control)
 *        └────────────  error  ◀── lease invalid ──┴──▶ closed
 *
 * - `clientSeq` is monotonic and only ever advances when the server ACKs a
 *   control frame; retries re-send the SAME seq (idempotent — a lost
 *   response never double-applies input).
 * - Only ONE control frame is in flight at a time (the server requires
 *   strict +1 ordering); further frames queue behind it.
 * - `serverSeq` is the after_seq cursor; reconnect replays from it
 *   (generation + after_seq fencing — a new generation marks a new session
 *   period, the cursor still replays without duplicates).
 * - 403 lease_invalid/lease_required is fatal: the session is unusable,
 *   the model lands in `error` and the UI prompts to reopen.
 * - Server-side closes (idle TTL / lease expiry / permission revocation /
 *   adapter failure) are detected by the periodic session refresh and
 *   surface a close-reason notice (pty.notice.* keys).
 *
 * Real browser terminal rendering (ANSI/xterm-class), keyboard input and
 * narrow-viewport acceptance stay NOT_RUN_MANUAL_PENDING (hardening §5) —
 * the output is rendered as plain text only.
 */
import { getLocale, t, type Locale } from './i18n/index'

/* ─────────────────────────── wire shapes (mirrors) ─────────────────────────── */

/** Client view of the session lifecycle (server has open/attached/detached/
 *  closed; the client adds `opening` for the in-flight open and `error` for
 *  fatal client-side failures; `idle` = no session yet). */
export type PtyClientState = 'idle' | 'opening' | 'open' | 'detached' | 'closed' | 'error'

export type PtyPreset = 'sh' | 'bash' | 'zsh' | 'fish'
export type PtySignal = 'INT' | 'TERM' | 'KILL'
export type PtyControlKind = 'bytes' | 'resize' | 'signal' | 'close'
export type PtyCloseReason = 'explicit' | 'idle_ttl' | 'permission_revoked' | 'adapter_failed' | 'lease_expired'

/** POST /v1/pty/sessions body (PtyOpenRequest — profile/target are opaque
 *  ids resolved server-side; cwd is root-relative inside the workspace). */
export interface PtyOpenParams {
  project_id: string
  workspace_id: string
  profile: string
  target: string
  preset: PtyPreset
  cwd: string
  cols: number
  rows: number
  idle_ttl_s?: number
  retention_bytes?: number
}

/** GET session / open response projection (PtySession). */
export interface PtySessionWire {
  pty_session_id: string
  principal_id: string
  tenant_id?: string
  project_id: string
  workspace_id: string
  profile: string
  target: string
  preset: string
  cwd: string
  config_hash: string
  state: 'open' | 'attached' | 'detached' | 'closed'
  generation: number
  lease_token: string | null
  lease_expires_at: string | null
  idle_ttl_s: number
  retention_bytes: number
  retained_from_seq: number
  last_client_seq: number
  last_event_seq: number
  total_bytes: number
  dropped_bytes: number
  adapter_id: string
  open_at: string
  last_activity_at: string
  closed_at: string | null
  close_reason: PtyCloseReason | null
}

/** One control frame body (PtyControlRequest — no session id/timestamps;
 *  the server fills them). */
export interface PtyControlFrame {
  client_seq: number
  type: PtyControlKind
  payload: Record<string, unknown>
}

/** One output frame (PtyOutputFrame projection). */
export interface PtyOutputFrame {
  pty_session_id: string
  server_seq: number
  type: 'output' | 'exit' | 'gap'
  payload: Record<string, unknown>
  created_at?: string
}

/** GET frames response projection (PtyFramesPage). */
export interface PtyFramesPageWire {
  pty_session_id: string
  after_seq: number
  retained_from_seq: number
  dropped_bytes: number
  total_bytes: number
  gap: boolean
  frames: PtyOutputFrame[]
}

/** Stable kernel error envelope (ApiErrorEnvelope mirror). */
export interface PtyErrorEnvelope {
  code?: string
  message?: string
  status?: number
  retryable?: boolean
}

export type PtyResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PtyErrorEnvelope }

/** The transport contract panels implement over apiResult() — injected so
 *  tests can drive the model with scripted responses (no fetch/DOM). */
export interface PtyTransport {
  open(params: PtyOpenParams): Promise<PtyResult<PtySessionWire>>
  getSession(sessionId: string, lease: string): Promise<PtyResult<PtySessionWire>>
  control(sessionId: string, lease: string, frame: PtyControlFrame): Promise<PtyResult<{ delivered?: boolean; idempotent?: boolean }>>
  frames(sessionId: string, lease: string, afterSeq: number): Promise<PtyResult<PtyFramesPageWire>>
}

/** Timer abstraction (global setTimeout in the browser, injected/fake in
 *  tests — keeps the model DOM-free and deterministic). */
export interface PtyScheduler {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
}

const defaultScheduler: PtyScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => { clearTimeout(timer as ReturnType<typeof setTimeout>) },
}

export interface PtyClientOptions {
  transport: PtyTransport
  scheduler?: PtyScheduler
  /** Frames poll interval (ms). */
  pollIntervalMs?: number
  /** GET the session row every N polls (server-side close / generation
   *  detection; 0 disables). */
  sessionRefreshEvery?: number
  /** Control retries for transient failures (network/5xx) before the frame
   *  stays queued with lastControlError (same client_seq each retry). */
  maxControlRetries?: number
  /** Display buffer bound (retention hint, never an unbounded DOM). */
  maxDisplayFrames?: number
}

/* ───────────────────────────── display entries ───────────────────────────── */

export type PtyDisplayKind = 'output' | 'exit' | 'gap'

/** One row of the plain-text output buffer (server-sanitized hint: output
 *  bytes are rendered verbatim — ANSI styling is NOT_RUN_MANUAL_PENDING). */
export interface PtyDisplayEntry {
  kind: PtyDisplayKind
  seq: number
  channel?: 'stdout' | 'stderr'
  text?: string
  exitCode?: number | null
  exitSignal?: string | null
  gapFrom?: number
  gapTo?: number
  droppedBytes?: number
  droppedFrames?: number
}

/* ─────────────────────────────── error mapping ─────────────────────────────── */

/** Stable i18n key for a wire error code (never a raw message — the kernel
 *  message is wire data; the UI copy is the mapped key). Unknown codes fall
 *  back to the generic key. */
export function ptyErrorKey(code: string | null | undefined): string {
  switch (code) {
    case 'lease_invalid':
    case 'lease_required':
      return 'pty.error.lease'
    case 'pty_session_not_found':
      return 'pty.error.notFound'
    case 'pty_session_closed':
      return 'pty.error.closed'
    case 'pty_client_seq_out_of_order':
      return 'pty.error.seqOutOfOrder'
    case 'pty_principal_mismatch':
    case 'principal_required':
      return 'pty.error.principal'
    case 'pty_adapter_failed':
    case 'pty_adapter_not_implemented':
      return 'pty.error.adapter'
    case 'project_not_found':
    case 'workspace_not_found':
      return 'pty.error.scope'
    case 'validation_error':
    case 'pty_after_seq_invalid':
    case 'pty_open_invalid':
      return 'pty.error.validation'
    case 'network_error':
      return 'pty.error.network'
    default:
      return 'pty.error.generic'
  }
}

/** Stable i18n key for a server close reason (idle TTL / lease expiry /
 *  permission revocation / adapter failure / explicit close). */
export function ptyCloseReasonKey(reason: PtyCloseReason | null | undefined): string {
  switch (reason) {
    case 'idle_ttl':
      return 'pty.notice.idleTtl'
    case 'lease_expired':
      return 'pty.notice.leaseExpired'
    case 'permission_revoked':
      return 'pty.notice.permissionRevoked'
    case 'adapter_failed':
      return 'pty.notice.adapterFailed'
    default:
      return 'pty.notice.closed'
  }
}

/** i18n namespace key for a client state ('pty.state.open' …). */
export function ptyStateKey(state: PtyClientState): string {
  return `pty.state.${state}`
}

/** UTF-8 byte length (the wire carries byte_length for exact accounting). */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/* ─────────────────────────────── the model ─────────────────────────────── */

export class PtyClientModel {
  readonly transport: PtyTransport
  readonly pollIntervalMs: number
  readonly sessionRefreshEvery: number
  readonly maxControlRetries: number
  readonly maxDisplayFrames: number
  private readonly scheduler: PtyScheduler

  /** Observable state (the panel renders from these fields). */
  state: PtyClientState = 'idle'
  sessionId: string | null = null
  leaseToken: string | null = null
  leaseExpiresAt: string | null = null
  generation = 0
  /** Last ACKed control seq (next control frame is clientSeq + 1). */
  clientSeq = 0
  /** Last applied output cursor (the after_seq replay cursor). */
  serverSeq = 0
  retainedFromSeq = 0
  droppedBytes = 0
  totalBytes = 0
  idleTtlS: number | null = null
  closeReason: PtyCloseReason | null = null
  exitCode: number | null = null
  exitSignal: string | null = null
  /** Fatal error (state 'error'); code is the wire error code. */
  lastError: { code: string; status: number } | null = null
  /** Transient control-delivery failure (frame kept queued, retryable). */
  lastControlError: { code: string; status: number } | null = null
  /** Bounded plain-text display buffer. */
  display: PtyDisplayEntry[] = []
  /** True when the session refresh saw a generation bump (new session
   *  period — the after_seq cursor still replays without duplicates). */
  generationChanged = false
  /** Last successful open params (reopen() after lease expiry / TTL). */
  lastOpenParams: PtyOpenParams | null = null
  /** Repaint hook (the panel wires a targeted DOM paint here). */
  onChange: (() => void) | null = null

  private pending: PtyControlFrame[] = []
  private inflight: PtyControlFrame | null = null
  private controlAttempts = 0
  private controlRetryTimer: unknown = null
  private pollTimer: unknown = null
  private pollCount = 0
  private pollBackoffMs = 0
  private disposed = false

  constructor(options: PtyClientOptions) {
    this.transport = options.transport
    this.scheduler = options.scheduler ?? defaultScheduler
    this.pollIntervalMs = options.pollIntervalMs ?? 1000
    this.sessionRefreshEvery = options.sessionRefreshEvery ?? 10
    this.maxControlRetries = options.maxControlRetries ?? 3
    this.maxDisplayFrames = options.maxDisplayFrames ?? 3000
  }

  get hasSession(): boolean {
    return this.sessionId !== null
  }

  get polling(): boolean {
    return this.pollTimer !== null
  }

  get hasPendingControls(): boolean {
    return this.pending.length > 0 || this.inflight !== null
  }

  /* ─────────────────────────── lifecycle ─────────────────────────── */

  /** Open a new session (idle/error/closed → opening → open). Returns true
   *  when the session landed in `open`. */
  async open(params: PtyOpenParams): Promise<boolean> {
    if (this.state === 'opening') return false
    this.reset()
    this.lastOpenParams = params
    this.state = 'opening'
    this.notify()
    const result = await this.transport.open(params)
    if (this.disposed || this.state !== 'opening') return false // superseded
    if (!result.ok) {
      this.state = 'error'
      this.lastError = { code: result.error.code ?? 'http_error', status: result.error.status ?? 0 }
      this.notify()
      return false
    }
    this.applySession(result.data)
    return true
  }

  /** Reopen with the last successful open params (lease expiry / fatal
   *  errors — the UI prompts a reopen). */
  async reopen(): Promise<boolean> {
    if (this.lastOpenParams === null) return false
    return this.open(this.lastOpenParams)
  }

  /** Wire down (leaving the tab) — the process keeps running server-side;
   *  reconnect() resumes the after_seq replay. */
  detach(): void {
    if (this.state !== 'open') return
    this.stopPolling()
    this.state = 'detached'
    this.notify()
  }

  /** Wire up again — state → open, polling resumes from serverSeq (the
   *  after_seq replay contract; generation bumps are surfaced as notices). */
  reconnect(): void {
    if (!this.hasSession || this.state === 'error' || this.state === 'closed') return
    this.state = 'open'
    this.controlAttempts = 0
    this.pollCount = 0
    this.notify()
    this.startPolling()
  }

  /** Explicit close control (queue + flush; acked → closed, reason
   *  'explicit'). Returns false when the session is not controllable. */
  close(): boolean {
    return this.enqueueControl({ type: 'close', payload: {} })
  }

  /** Send terminal input bytes (queued control with exact byte_length). */
  sendText(text: string): boolean {
    return this.enqueueControl({
      type: 'bytes',
      payload: { text, byte_length: utf8ByteLength(text) },
    })
  }

  /** Resize the pty (cols 1..500, rows 1..300 — server-enforced too). */
  resize(cols: number, rows: number): boolean {
    const c = Number.isFinite(cols) ? Math.max(1, Math.min(500, Math.floor(cols))) : 80
    const r = Number.isFinite(rows) ? Math.max(1, Math.min(300, Math.floor(rows))) : 24
    return this.enqueueControl({ type: 'resize', payload: { cols: c, rows: r } })
  }

  /** Send an allowlisted signal (INT/TERM/KILL — delivered to the pty's
   *  foreground process group by the adapter). */
  signal(signal: PtySignal): boolean {
    return this.enqueueControl({ type: 'signal', payload: { signal } })
  }

  /** Manual retry after a transient control-delivery failure (the frame is
   *  still queued with its original client_seq). */
  retryControl(): void {
    if (!this.hasPendingControls) return
    this.controlAttempts = 0
    this.lastControlError = null
    this.notify()
    void this.flushControl()
  }

  /** Drop the session and return to idle (keeps lastOpenParams for
   *  reopen()). Stops polling and clears queued controls. */
  reset(): void {
    this.dispose()
    this.state = 'idle'
    this.sessionId = null
    this.leaseToken = null
    this.leaseExpiresAt = null
    this.generation = 0
    this.clientSeq = 0
    this.serverSeq = 0
    this.retainedFromSeq = 0
    this.droppedBytes = 0
    this.totalBytes = 0
    this.idleTtlS = null
    this.closeReason = null
    this.exitCode = null
    this.exitSignal = null
    this.lastError = null
    this.lastControlError = null
    this.generationChanged = false
    this.display = []
    this.pending = []
    this.inflight = null
    this.controlAttempts = 0
    this.pollCount = 0
    this.pollBackoffMs = 0
    this.disposed = false
    this.notify()
  }

  /** Permanent teardown (stop timers; async continuations no-op). */
  dispose(): void {
    this.disposed = true
    this.stopPolling()
    if (this.controlRetryTimer !== null) {
      this.scheduler.clearTimeout(this.controlRetryTimer)
      this.controlRetryTimer = null
    }
  }

  private notify(): void {
    this.onChange?.()
  }

  /** Fold a fresh session row into the model (open response / refresh). */
  private applySession(session: PtySessionWire): void {
    this.sessionId = session.pty_session_id
    this.leaseToken = session.lease_token ?? null
    this.leaseExpiresAt = session.lease_expires_at ?? null
    this.generation = session.generation
    this.clientSeq = session.last_client_seq
    this.idleTtlS = session.idle_ttl_s
    this.retainedFromSeq = session.retained_from_seq
    this.droppedBytes = session.dropped_bytes
    this.totalBytes = session.total_bytes
    this.state = 'open'
    this.notify()
    this.startPolling()
  }

  /* ─────────────────────────── control queue ─────────────────────────── */

  /** Assign the next monotonic seq (clientSeq + queue depth + in-flight),
   *  enqueue and flush. Rejected (false) when the session is not
   *  controllable (idle/opening/closed/error). */
  private enqueueControl(frame: Omit<PtyControlFrame, 'client_seq'>): boolean {
    if (this.state !== 'open' && this.state !== 'detached') return false
    if (this.lastControlError !== null) {
      // a new user action resets the stalled retry state
      this.controlAttempts = 0
      this.lastControlError = null
    }
    // Every queued frame (incl. the one in flight at pending[0]) has
    // consumed a seq — the next one is clientSeq + queue depth + 1.
    const seq = this.clientSeq + this.pending.length + 1
    this.pending.push({ ...frame, client_seq: seq })
    this.notify()
    void this.flushControl()
    return true
  }

  private async flushControl(): Promise<void> {
    if (this.disposed) return
    if (this.inflight !== null || this.pending.length === 0) return
    if (this.state !== 'open' && this.state !== 'detached') return
    if (this.sessionId === null) return
    const frame = this.pending[0]!
    this.inflight = frame
    this.controlAttempts += 1
    const lease = this.leaseToken ?? ''
    const result = await this.transport.control(this.sessionId, lease, frame)
    if (this.disposed || this.inflight !== frame) return // superseded
    if (result.ok) {
      this.inflight = null
      this.pending.shift()
      this.controlAttempts = 0
      this.lastControlError = null
      this.clientSeq = Math.max(this.clientSeq, frame.client_seq)
      if (frame.type === 'close') {
        // close control acked: the server ran the close transition.
        this.stopPolling()
        this.state = 'closed'
        this.closeReason = 'explicit'
        this.pending = []
        this.notify()
        return
      }
      this.notify()
      void this.flushControl()
      return
    }
    const code = result.error.code ?? 'http_error'
    if (code === 'lease_invalid' || code === 'lease_required') {
      // Fatal: the session lease is unusable — prompt to reopen.
      this.failFatal('lease_invalid')
      return
    }
    if (code === 'pty_session_closed' || code === 'pty_session_not_found') {
      this.inflight = null
      this.pending = []
      this.stopPolling()
      this.state = 'closed'
      this.closeReason = null
      this.lastError = { code, status: result.error.status ?? 409 }
      this.notify()
      return
    }
    if (code === 'pty_client_seq_out_of_order') {
      // The server cursor disagrees — resync from the session row before
      // deciding (a lost ack is common; a real desync is fatal).
      this.inflight = null
      void this.resyncAfterOutOfOrder(frame, result.error.status ?? 409)
      return
    }
    // Transient (network / 5xx / retryable): re-send the SAME seq — the
    // server's idempotency key makes a duplicate a no-op.
    if (this.controlAttempts >= this.maxControlRetries) {
      this.inflight = null
      this.lastControlError = { code, status: result.error.status ?? 0 }
      this.notify()
      return
    }
    const delay = Math.min(8000, 500 * 2 ** (this.controlAttempts - 1))
    this.controlRetryTimer = this.scheduler.setTimeout(() => {
      this.controlRetryTimer = null
      this.inflight = null // the frame stays at the head of pending
      void this.flushControl()
    }, delay)
  }

  /** 409 pty_client_seq_out_of_order: rebase against the server cursor. */
  private async resyncAfterOutOfOrder(frame: PtyControlFrame, status: number): Promise<void> {
    if (!this.hasSession || this.sessionId === null) {
      this.failFatal('pty_client_seq_out_of_order')
      return
    }
    const result = await this.transport.getSession(this.sessionId, this.leaseToken ?? '')
    if (this.disposed) return
    if (!result.ok) {
      this.lastError = { code: result.error.code ?? 'http_error', status: result.error.status ?? status }
      this.notify()
      return
    }
    const session = result.data
    if (session.state === 'closed') {
      this.pending = []
      this.stopPolling()
      this.state = 'closed'
      this.closeReason = session.close_reason ?? 'explicit'
      this.notify()
      return
    }
    if (session.last_client_seq >= frame.client_seq) {
      // Already applied server-side (the ack was lost) — advance and move on.
      this.clientSeq = Math.max(this.clientSeq, session.last_client_seq)
      this.pending.shift()
      if (frame.type === 'close') {
        this.stopPolling()
        this.state = 'closed'
        this.closeReason = 'explicit'
        this.pending = []
        this.notify()
        return
      }
      this.notify()
      void this.flushControl()
      return
    }
    // Real desync (server cursor behind our seq): the session cannot take
    // our frames — fatal, prompt to reconnect/reopen.
    this.pending = []
    this.stopPolling()
    this.state = 'error'
    this.lastError = { code: 'pty_client_seq_out_of_order', status }
    this.notify()
  }

  /** Fatal session failure (lease invalid / unresolvable desync): stop
   *  everything, drop queued controls, land in `error`. */
  private failFatal(code: string): void {
    this.stopPolling()
    this.state = 'error'
    this.lastError = { code, status: 403 }
    this.pending = []
    this.inflight = null
    this.notify()
  }

  /* ─────────────────────────── frames consumption ─────────────────────────── */

  private startPolling(): void {
    if (this.disposed || this.state !== 'open' || this.pollTimer !== null) return
    this.schedulePoll(this.pollBackoffMs > 0 ? this.pollBackoffMs : this.pollIntervalMs)
  }

  private schedulePoll(ms: number): void {
    if (this.disposed || this.state !== 'open' || this.pollTimer !== null) return
    this.pollTimer = this.scheduler.setTimeout(() => {
      this.pollTimer = null
      void this.pollOnce()
    }, ms)
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      this.scheduler.clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** One frames fetch: incremental after_seq pull (polling; SSE is a later
   *  round), gap handling, retention accounting, periodic session refresh. */
  private async pollOnce(): Promise<void> {
    if (this.disposed || this.state !== 'open' || this.sessionId === null) return
    const lease = this.leaseToken ?? ''
    const result = await this.transport.frames(this.sessionId, lease, this.serverSeq)
    if (this.disposed || this.state !== 'open') return // detached/closed in flight
    if (!result.ok) {
      const code = result.error.code ?? 'http_error'
      if (code === 'lease_invalid' || code === 'lease_required') {
        this.failFatal('lease_invalid')
        return
      }
      if (code === 'pty_session_not_found') {
        // The session row is gone server-side — treat as closed.
        this.state = 'closed'
        this.closeReason = null
        this.lastError = { code, status: result.error.status ?? 404 }
        this.notify()
        return
      }
      // Transient: keep the cursor, back off and retry (poll error notice).
      this.lastError = { code, status: result.error.status ?? 0 }
      this.pollBackoffMs = this.pollBackoffMs === 0 ? 1000 : Math.min(10000, this.pollBackoffMs * 2)
      this.notify()
      this.schedulePoll(this.pollBackoffMs)
      return
    }
    this.pollBackoffMs = 0
    this.applyPage(result.data)
    this.pollCount += 1
    if (this.sessionRefreshEvery > 0 && this.pollCount % this.sessionRefreshEvery === 0) {
      await this.refreshSession()
      if (this.disposed || this.state !== 'open') return
    }
    this.notify()
    this.schedulePoll(this.pollIntervalMs)
  }

  /** Fold one frames page into the cursor/display (idempotent on replay:
   *  frames at or below serverSeq are skipped). */
  private applyPage(page: PtyFramesPageWire): void {
    this.retainedFromSeq = page.retained_from_seq
    this.droppedBytes = page.dropped_bytes
    this.totalBytes = page.total_bytes
    if (page.gap) {
      // after_seq fell below retained_from_seq — retention evicted output
      // the client missed. Surface a gap marker (never silent truncation).
      this.display.push({
        kind: 'gap',
        seq: page.retained_from_seq,
        gapFrom: this.serverSeq + 1,
        gapTo: Math.max(0, page.retained_from_seq - 1),
        droppedBytes: page.dropped_bytes,
        droppedFrames: Math.max(0, page.retained_from_seq - 1 - this.serverSeq),
      })
      this.trimDisplay()
    }
    for (const frame of page.frames) {
      if (frame.server_seq <= this.serverSeq) continue // idempotent replay
      if (frame.type === 'output') {
        const payload = frame.payload as { text?: string; byte_length?: number; channel?: 'stdout' | 'stderr' }
        this.display.push({
          kind: 'output',
          seq: frame.server_seq,
          channel: payload.channel ?? 'stdout',
          text: payload.text ?? '',
        })
      } else if (frame.type === 'exit') {
        const payload = frame.payload as { exit_code?: number | null; signal?: string | null }
        this.exitCode = payload.exit_code ?? null
        this.exitSignal = payload.signal ?? null
        this.display.push({ kind: 'exit', seq: frame.server_seq, exitCode: this.exitCode, exitSignal: this.exitSignal })
      } else if (frame.type === 'gap') {
        const payload = frame.payload as { gap_from_seq?: number; gap_to_seq?: number; dropped_bytes?: number; dropped_frames?: number }
        this.display.push({
          kind: 'gap',
          seq: frame.server_seq,
          gapFrom: payload.gap_from_seq ?? 0,
          gapTo: payload.gap_to_seq ?? 0,
          droppedBytes: payload.dropped_bytes ?? 0,
          droppedFrames: payload.dropped_frames ?? 0,
        })
      }
      this.serverSeq = Math.max(this.serverSeq, frame.server_seq)
      this.trimDisplay()
    }
  }

  private trimDisplay(): void {
    if (this.display.length > this.maxDisplayFrames) {
      this.display = this.display.slice(-this.maxDisplayFrames)
    }
  }

  /** Periodic session refresh: closes (idle TTL / lease expiry / permission
   *  revocation / adapter failure) and generation bumps surface here. */
  private async refreshSession(): Promise<void> {
    if (!this.hasSession || this.sessionId === null) return
    const result = await this.transport.getSession(this.sessionId, this.leaseToken ?? '')
    if (this.disposed || !result.ok) return
    const session = result.data
    if (session.generation !== this.generation) {
      this.generation = session.generation
      this.generationChanged = true
    }
    this.idleTtlS = session.idle_ttl_s
    this.leaseExpiresAt = session.lease_expires_at
    if (session.state === 'closed') {
      this.stopPolling()
      this.state = 'closed'
      this.closeReason = session.close_reason ?? 'explicit'
    }
  }
}

/* ───────────────────────────── status view model ───────────────────────────── */

/** Evaluated status-line copy for the CURRENT locale (all keys exist in
 *  both dictionaries — zh/en parity is asserted by the tests). */
export interface PtyStatusView {
  state: PtyClientState
  stateText: string
  seqText: string
  leaseText: string
  generationText: string
  bytesText: string
  noticeText: string
  errorText: string
  controlErrorText: string
  exitText: string
}

export function ptyStatusView(model: PtyClientModel, locale: Locale = getLocale()): PtyStatusView {
  const stateText = t('pty', ptyStateKey(model.state))
  const seqText = model.hasSession
    ? t('pty', 'pty.status.seq', { client: String(model.clientSeq), server: String(model.serverSeq) })
    : ''
  let leaseText = ''
  if (model.hasSession) {
    const lease = model.leaseToken !== null && model.leaseToken !== ''
      ? `${model.leaseToken.slice(0, 8)}…`
      : t('pty', 'pty.status.leaseNone')
    const expires = model.leaseExpiresAt !== null
      ? (new Date(model.leaseExpiresAt).getTime() < Date.now()
          ? t('pty', 'pty.status.leaseExpired')
          : new Date(model.leaseExpiresAt).toLocaleString(locale))
      : t('pty', 'pty.status.leaseNone')
    leaseText = t('pty', 'pty.status.lease', { lease, expires })
  }
  const generationText = model.hasSession
    ? t('pty', 'pty.status.generation', { generation: String(model.generation) })
    : ''
  const bytesText = model.hasSession
    ? t('pty', 'pty.status.bytes', { bytes: String(model.totalBytes) })
    : ''
  let noticeText = ''
  if (model.state === 'closed' && model.closeReason !== null) {
    noticeText = t('pty', ptyCloseReasonKey(model.closeReason), { ttl: String(model.idleTtlS ?? 0) })
  } else if (model.generationChanged && model.hasSession) {
    noticeText = t('pty', 'pty.notice.generationChanged', { generation: String(model.generation) })
  }
  const errorText = model.state === 'error' && model.lastError !== null
    ? t('pty', ptyErrorKey(model.lastError.code), { code: model.lastError.code })
    : ''
  const controlErrorText = model.lastControlError !== null
    ? t('pty', 'pty.error.control', { code: model.lastControlError.code })
    : ''
  const exitText = model.exitCode !== null || model.exitSignal !== null
    ? t('pty', 'pty.exit.line', {
        code: model.exitCode !== null ? t('pty', 'pty.exit.code', { code: String(model.exitCode) }) : '',
        signal: model.exitSignal !== null ? t('pty', 'pty.exit.signal', { signal: model.exitSignal }) : '',
      })
    : ''
  return { state: model.state, stateText, seqText, leaseText, generationText, bytesText, noticeText, errorText, controlErrorText, exitText }
}
