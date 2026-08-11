/**
 * TRAJ-01 Trajectory UI logic layer (docs/trajectory-subagents.md §1/§6,
 * research-schemas/trajectory.ts wire contract): PURE functions that turn
 * the read-only kernel projection (TrajectoryLanes / TrajectoryPage) into
 * the panel render model. No DOM — panels/trajectory.ts only assembles
 * nodes from this model (same split as next-action-cards.ts).
 *
 * What lives here:
 *
 *  - lane metadata: Research = authoritative business facts, Session =
 *    observational subagent/session activity (§1 — UI must mark the two
 *    lanes, never pass Session events off as research facts). Labels are
 *    chrome copy evaluated against the CURRENT locale (trajectory
 *    namespace, zh/en parity enforced).
 *  - the pagination state machine: the server keysets on (event_seq,
 *    event_id); the panel accumulates pages per lane. `applyTrajectoryPage`
 *    merges one wire page into the state with entry_id dedupe (idempotent
 *    cursor contract), and `nextTrajectoryCursor` derives the next
 *    `?lane=&after_seq=&after_event_id=` query (null = no more pages).
 *  - the LIVE stream: `TrajectoryStreamClient` consumes the SSE
 *    incremental stream (GET /v1/projects/{id}/trajectory/stream
 *    ?after_seq=N&lane=research|session — client/sse-client.ts) with
 *    lane filtering and entry_id dedupe (`applyTrajectoryStreamEntries`).
 *    When the stream gives up (max reconnect attempts) the client falls
 *    back to PAGINATION (the same keyset page fetch) — a designed
 *    degradation; both paths merge into the same page state.
 *  - the entry view model: seq/time/redacted-summary/status + the detail
 *    rows available WITHOUT raw payloads (aggregate refs, source, session,
 *    status, ids — the kernel never projects raw detail, so the expandable
 *    detail is exactly the allowlisted metadata, nothing more).
 *
 * Virtualized/scrolled browsing and browser visual acceptance stay in the
 * DOM layer and are recorded NOT_RUN_MANUAL_PENDING (hardening §5).
 */
import { getLocale, t, type Locale } from './i18n/index'
import { zh as trajectoryZh, en as trajectoryEn } from './i18n/locales/trajectory'
import { zh as statusZh, en as statusEn } from './i18n/locales/status'
import { SseClient, defaultSseScheduler, type SseEvent, type SseFetch, type SseScheduler } from './sse-client'
import type { TrajectoryEntry, TrajectoryLaneKey, TrajectoryLanes, TrajectoryPage } from './types'

/** Stable lane order (Research first — authoritative lane on top). */
export const TRAJECTORY_LANE_KEYS: readonly TrajectoryLaneKey[] = ['research', 'session']

/** Authority chrome (trajectory-subagents.md §1: UI 必须明确标记
 *  authoritative 与 observational). */
export type TrajectoryAuthority = 'authoritative' | 'observational'

export interface TrajectoryLaneMeta {
  key: TrajectoryLaneKey
  /** Lane section label (chrome, current locale). */
  label: string
  /** Lane section description (chrome, current locale). */
  description: string
  /** Authority badge copy ('authoritative' | 'observational'). */
  authorityLabel: string
  authority: TrajectoryAuthority
}

/** Evaluated lane chrome in the CURRENT locale. */
export function trajectoryLaneMeta(lane: TrajectoryLaneKey, locale: Locale = getLocale()): TrajectoryLaneMeta {
  const authoritative = lane === 'research'
  return {
    key: lane,
    label: t('trajectory', `trajectory.lane.${lane}`),
    description: t('trajectory', `trajectory.lane.${lane}.desc`),
    authorityLabel: t('trajectory', authoritative ? 'trajectory.authoritative' : 'trajectory.observational'),
    authority: authoritative ? 'authoritative' : 'observational',
  }
}

/* ─────────────────────── pagination state machine ─────────────────────── */

/** Accumulated panel state for ONE lane (server pages merged in order). */
export interface TrajectoryPageState {
  entries: TrajectoryEntry[]
  /** Cursor of the last applied page (pass to after_seq next call). */
  nextAfterSeq: number | null
  /** Cursor tiebreaker (event_id; required whenever nextAfterSeq is set). */
  nextAfterEventId: string | null
  hasMore: boolean
  total: number
  /** 'idle' = never fetched, 'loading' = fetch in flight, 'ready' = loaded,
   *  'error' = last fetch failed. */
  status: 'idle' | 'loading' | 'ready' | 'error'
}

export function initialTrajectoryPageState(): TrajectoryPageState {
  return { entries: [], nextAfterSeq: null, nextAfterEventId: null, hasMore: false, total: 0, status: 'idle' }
}

/**
 * Merge ONE wire page into the state. Keyset pages never overlap, but the
 * cursor contract is idempotent — dedupe by entry_id anyway so a retried
 * fetch can never duplicate rows. Never throws; malformed pages degrade to
 * their usable fields.
 */
export function applyTrajectoryPage(prev: TrajectoryPageState, page: TrajectoryPage): TrajectoryPageState {
  const seen = new Set(prev.entries.map(e => e.entry_id))
  const merged: TrajectoryEntry[] = [...prev.entries]
  for (const entry of Array.isArray(page.entries) ? page.entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.entry_id === 'string' ? entry.entry_id : ''
    if (id !== '' && seen.has(id)) continue
    if (id !== '') seen.add(id)
    merged.push(entry as TrajectoryEntry)
  }
  return {
    entries: merged,
    nextAfterSeq: typeof page.next_after_seq === 'number' ? page.next_after_seq : null,
    nextAfterEventId: typeof page.next_after_event_id === 'string' && page.next_after_event_id !== '' ? page.next_after_event_id : null,
    hasMore: page.has_more === true,
    total: typeof page.total === 'number' ? page.total : merged.length,
    status: 'ready',
  }
}

/** Next `?lane=&after_seq=&after_event_id=` cursor, or null when the lane is
 *  exhausted (never fetches past the server's has_more flag). */
export function nextTrajectoryCursor(state: TrajectoryPageState): { after_seq: number; after_event_id?: string } | null {
  if (state.hasMore !== true || state.nextAfterSeq === null) return null
  return { after_seq: state.nextAfterSeq, after_event_id: state.nextAfterEventId ?? undefined }
}

/** Whether the lane can be asked for another page right now. */
export function canLoadMoreTrajectory(state: TrajectoryPageState): boolean {
  return state.status === 'ready' && state.hasMore === true && state.nextAfterSeq !== null
}

/**
 * Merge LIVE stream entries into the state (the SSE incremental stream —
 * GET /v1/projects/{id}/trajectory/stream?after_seq=N&lane=). Same entry_id
 * dedupe as pages (idempotent — a reconnect replay can never duplicate a
 * row); the pagination cursor/hasMore fields are preserved (the panel
 * keeps its keyset state; `total` only ever grows). Never throws; malformed
 * entries degrade to their usable fields.
 */
export function applyTrajectoryStreamEntries(prev: TrajectoryPageState, entries: readonly TrajectoryEntry[]): TrajectoryPageState {
  const seen = new Set(prev.entries.map(e => e.entry_id))
  const merged: TrajectoryEntry[] = [...prev.entries]
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.entry_id === 'string' ? entry.entry_id : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    merged.push(entry as TrajectoryEntry)
  }
  if (merged.length === prev.entries.length) return prev
  return { ...prev, entries: merged, total: Math.max(prev.total, merged.length), status: 'ready' }
}

/* ─────────────────────── SSE incremental stream client ─────────────────────── */

/** Stream lifecycle: 'idle' → 'connecting' → 'live' ⇄ 'reconnecting' →
 *  ('disconnected' | 'polling'). 'polling' = the SSE stream gave up and
 *  the client paginates the keyset endpoint (designed fallback). */
export type TrajectoryStreamStatus =
  | 'idle' | 'connecting' | 'live' | 'reconnecting' | 'disconnected' | 'polling' | 'stopped'

export interface TrajectoryStreamOptions {
  projectId: string
  lane: TrajectoryLaneKey
  /** Resolve the CURRENT after_seq cursor at (re)connect/poll time (the
   *  panel folds the last applied event_seq in here). */
  afterSeq: () => number
  /** Inject the stream transport (client/sse-client.ts). */
  fetchImpl?: SseFetch
  /** Extra per-connect headers (auth). */
  headers?: () => Promise<Record<string, string>> | Record<string, string>
  /** Timer scheduler (fake in tests; global setTimeout in the browser). */
  scheduler?: SseScheduler
  /** PAGINATION fallback (the panel wires its authenticated keyset fetch;
   *  absent → the client only reports the 'polling' status). */
  pollPage?: (afterSeq: number) => Promise<TrajectoryPage | null>
  /** Poll cadence (ms) for the fallback, default 5000. */
  pollIntervalMs?: number
  /** Validated entries of THIS lane (lane-filtered + deduped by the
   *  client; the consumer merges them with applyTrajectoryStreamEntries). */
  onEntries: (entries: TrajectoryEntry[]) => void
  onStatus?: (status: TrajectoryStreamStatus) => void
  /** No stream bytes for this long → reconnect (server heartbeats must
   *  arrive more often). Default 30s. */
  heartbeatTimeoutMs?: number
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  /** Consecutive failed connect attempts before the PAGINATION fallback. */
  maxReconnectAttempts?: number
}

/** The trajectory incremental stream consumer for ONE lane. Entries are
 *  lane-filtered (a mislabeled event never leaks into the other lane) and
 *  deduped by entry_id before onEntries. PURE LOGIC — NO DOM: fetch +
 *  scheduler injected. */
export class TrajectoryStreamClient {
  readonly options: TrajectoryStreamOptions
  status: TrajectoryStreamStatus = 'idle'
  private readonly scheduler: SseScheduler
  private sse: SseClient | null = null
  private pollTimer: unknown = null
  private stopped = false

  constructor(options: TrajectoryStreamOptions) {
    this.options = options
    this.scheduler = options.scheduler ?? defaultSseScheduler
  }

  /** Start the stream (idempotent while live/connecting/reconnecting). */
  start(): void {
    if (this.stopped || this.status === 'live' || this.status === 'connecting' || this.status === 'reconnecting') return
    this.stopped = false
    this.connectStream()
  }

  /** Stop the stream (tab leave): aborts the stream and the poll fallback. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.sse?.close()
    this.sse = null
    if (this.pollTimer !== null) {
      this.scheduler.clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    this.setStatus('stopped')
  }

  private setStatus(status: TrajectoryStreamStatus): void {
    if (this.status === status) return
    this.status = status
    this.options.onStatus?.(status)
  }

  private connectStream(): void {
    const { projectId, lane } = this.options
    this.sse?.close()
    const client = new SseClient({
      url: () => `/v1/projects/${encodeURIComponent(projectId)}/trajectory/stream?after_seq=${this.options.afterSeq()}&lane=${lane}`,
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      scheduler: this.options.scheduler,
      heartbeatTimeoutMs: this.options.heartbeatTimeoutMs,
      reconnectBaseMs: this.options.reconnectBaseMs,
      reconnectMaxMs: this.options.reconnectMaxMs,
      maxReconnectAttempts: this.options.maxReconnectAttempts,
      onEvent: (event) => { this.onStreamEvent(event) },
      onStatus: (status) => {
        this.setStatus(status === 'closed' ? 'disconnected' : status)
      },
      onEnd: (reason) => {
        if (reason !== 'max-retries') return
        // The stream gave up → PAGINATION fallback (designed degradation;
        // the after_seq cursor was never lost, so the page fetches resume
        // exactly where the stream stopped).
        this.sse?.close()
        this.sse = null
        this.startPollFallback()
      },
    })
    this.sse = client
    client.open()
  }

  /** Keyset pagination fallback loop (same endpoint as the legacy
   *  load-more path). */
  private startPollFallback(): void {
    if (this.stopped) return
    this.setStatus('polling')
    if (this.options.pollPage === undefined) return
    const tick = (): void => {
      if (this.stopped) return
      if (this.options.pollPage !== undefined) {
        void this.options.pollPage(this.options.afterSeq()).then(page => {
          if (this.stopped) return
          if (page !== null) this.emitEntries(page.entries)
        })
      }
      this.pollTimer = this.scheduler.setTimeout(tick, this.options.pollIntervalMs ?? 5000)
    }
    this.pollTimer = this.scheduler.setTimeout(tick, this.options.pollIntervalMs ?? 5000)
  }

  /** One SSE dispatch → entries of THIS lane (defensive: the stream may
   *  carry one entry, a batch ({entries: [...]}), or a bare array). */
  private onStreamEvent(event: SseEvent): void {
    let data: unknown
    try {
      data = JSON.parse(event.data)
    } catch {
      return // malformed frame: skip
    }
    if (event.event === 'heartbeat' || event.event === 'revision') return
    let raw: unknown[] = []
    if (Array.isArray(data)) raw = data
    else if (typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>).entries)) {
      raw = (data as Record<string, unknown>).entries as unknown[]
    } else if (typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).entry_id === 'string') {
      raw = [data]
    } else {
      return // cursor-only / unknown shapes are ignored
    }
    const entries: TrajectoryEntry[] = []
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      // lane filter: a mislabeled event never leaks into the other lane
      if (typeof entry.lane === 'string' && entry.lane !== this.options.lane) continue
      if (typeof entry.entry_id !== 'string' || typeof entry.event_seq !== 'number') continue
      entries.push(entry as unknown as TrajectoryEntry)
    }
    this.emitEntries(entries)
  }

  private emitEntries(entries: TrajectoryEntry[]): void {
    if (this.stopped || entries.length === 0) return
    this.options.onEntries(entries)
  }
}

/* ─────────────────────── entry view model ─────────────────────── */

export interface TrajectoryDetailRow {
  /** Chrome label (trajectory.detail.*, current locale). */
  label: string
  value: string
}

export interface TrajectoryEntryView {
  entry_id: string
  event_seq: number
  kind: string
  occurred_at: string
  /** Locale-formatted time (raw wire string when the date is invalid). */
  timeText: string
  /** Server-redacted summary — shown verbatim, never re-derived. */
  summary: string
  status: string | null
  /** Resolved status copy (status namespace when known, else raw wire). */
  statusText: string
  /** True when the entry carries allowlisted metadata beyond the id
   *  (expandable row). */
  hasDetail: boolean
  /** Allowlisted detail rows for the expanded view (never raw payload). */
  details: TrajectoryDetailRow[]
}

function hasStatusKey(key: string, locale: Locale): boolean {
  const dict = (locale === 'zh' ? statusZh : statusEn) as Record<string, string>
  return dict[key] !== undefined
}

/** Status copy: status-namespace key when present, else the raw wire value
 *  verbatim (§8 line 115 — unknown enums are wire data, never guessed). */
export function trajectoryStatusText(status: string | null | undefined, locale: Locale = getLocale()): string {
  if (status === undefined || status === null || status === '') return ''
  const key = `status.${status}`
  if (hasStatusKey(key, locale)) return t('status', key)
  return status
}

function formatTime(raw: string, locale: Locale): string {
  const ts = Date.parse(raw)
  if (!Number.isFinite(ts)) return raw
  try {
    return new Date(ts).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
  } catch {
    return raw
  }
}

/**
 * One row view of a projected entry. The expandable detail is EXACTLY the
 * allowlisted metadata the kernel projects (aggregate ref, source, session,
 * status — plus the stable entry id) — raw payloads are redacted
 * server-side and never appear here. `hasDetail` is true only when the
 * entry carries at least one metadata row beyond the id (the id row is
 * always available but not itself a reason to expand). Never throws;
 * missing fields degrade to safe empty values.
 */
export function trajectoryEntryView(entry: TrajectoryEntry, locale: Locale = getLocale()): TrajectoryEntryView {
  const details: TrajectoryDetailRow[] = []
  const aggregateType = typeof entry.aggregate_type === 'string' && entry.aggregate_type !== '' ? entry.aggregate_type : null
  const aggregateId = typeof entry.aggregate_id === 'string' && entry.aggregate_id !== '' ? entry.aggregate_id : null
  if (aggregateType !== null || aggregateId !== null) {
    details.push({ label: t('trajectory', 'trajectory.detail.aggregate'), value: [aggregateType, aggregateId].filter(Boolean).join(' / ') })
  }
  const source = typeof entry.source === 'string' && entry.source !== '' ? entry.source : null
  if (source !== null) details.push({ label: t('trajectory', 'trajectory.detail.source'), value: source })
  const sessionId = typeof entry.session_id === 'string' && entry.session_id !== '' ? entry.session_id : null
  if (sessionId !== null) details.push({ label: t('trajectory', 'trajectory.detail.session'), value: sessionId })
  const status = typeof entry.status === 'string' && entry.status !== '' ? entry.status : null
  if (status !== null) details.push({ label: t('trajectory', 'trajectory.detail.status'), value: trajectoryStatusText(status, locale) })
  const hasDetail = details.length > 0
  details.push({ label: t('trajectory', 'trajectory.detail.entry'), value: entry.entry_id })
  return {
    entry_id: entry.entry_id,
    event_seq: typeof entry.event_seq === 'number' ? entry.event_seq : 0,
    kind: typeof entry.kind === 'string' ? entry.kind : 'unknown',
    occurred_at: typeof entry.occurred_at === 'string' ? entry.occurred_at : '',
    timeText: formatTime(typeof entry.occurred_at === 'string' ? entry.occurred_at : '', locale),
    summary: typeof entry.summary === 'string' ? entry.summary : '',
    status,
    statusText: trajectoryStatusText(status, locale),
    hasDetail,
    details,
  }
}

/* ─────────────────────── dual-lane panel view ─────────────────────── */

export interface TrajectoryLaneView {
  key: TrajectoryLaneKey
  label: string
  description: string
  authorityLabel: string
  authority: TrajectoryAuthority
  entries: TrajectoryEntryView[]
  total: number
  hasMore: boolean
  status: TrajectoryPageState['status']
  /** Empty-state chrome for this lane ('' when the lane has entries). */
  emptyText: string
}

export interface TrajectoryPanelView {
  lanes: TrajectoryLaneView[]
  /** True when neither lane has been fetched yet. */
  idle: boolean
  /** 'trajectory.empty' when BOTH lanes are loaded and empty. */
  panelEmptyText: string
  /** 'trajectory.loading' while the first fetch is in flight. */
  loadingText: string
  /** 'trajectory.error' when the last fetch failed. */
  errorText: string
  /** Redaction footnote (server-guaranteed, shown as chrome note). */
  redactedNote: string
}

/**
 * Dual-lane render model (trajectory-subagents.md §1/§6): the panel shows
 * Research (authoritative) and Session (observational) lanes side by side,
 * each with its own pagination state. Empty/copy chrome evaluates the
 * CURRENT locale; `locale` only picks the dict used for raw-enum fallbacks.
 */
export function trajectoryPanelView(
  states: Record<TrajectoryLaneKey, TrajectoryPageState>,
  locale: Locale = getLocale(),
): TrajectoryPanelView {
  const idle = states.research.status === 'idle' && states.session.status === 'idle'
  const lanes = TRAJECTORY_LANE_KEYS.map(key => {
    const meta = trajectoryLaneMeta(key, locale)
    const state = states[key]
    const entries = state.entries.map(entry => trajectoryEntryView(entry, locale))
    const emptyText = state.status === 'ready' && entries.length === 0
      ? t('trajectory', 'trajectory.lane.empty')
      : ''
    return {
      key,
      label: meta.label,
      description: meta.description,
      authorityLabel: meta.authorityLabel,
      authority: meta.authority,
      entries,
      total: state.total,
      hasMore: state.hasMore,
      status: state.status,
      emptyText,
    }
  })
  const bothEmpty = states.research.status === 'ready' && states.session.status === 'ready'
    && lanes[0]!.entries.length === 0 && lanes[1]!.entries.length === 0
  return {
    lanes,
    idle,
    panelEmptyText: bothEmpty ? t('trajectory', 'trajectory.empty') : '',
    loadingText: t('trajectory', 'trajectory.loading'),
    errorText: t('trajectory', 'trajectory.error'),
    redactedNote: t('trajectory', 'trajectory.redactedNote'),
  }
}
