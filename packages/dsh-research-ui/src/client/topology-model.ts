/**
 * SUBAGENT-01 Topology UI logic layer (docs/trajectory-subagents.md §3/§6,
 * research-schemas/trajectory.ts wire contract): PURE functions that turn
 * the direct-children projection into the panel render model. No DOM —
 * panels/topology.ts only assembles nodes from this model.
 *
 * What lives here:
 *
 *  - the tree model: the server only ever serves EXACT direct children per
 *    parent (roots when parent_id is null). The panel accumulates one
 *    TopologyLevelState per parent (root key ''); `flattenTopologyRows`
 *    walks the expanded set depth-first into visible rows (lazy children
 *    appear only when their level is loaded), cycle-safe via a visited
 *    guard, and `toggleTopologyNode` / `applyTopologyPage` / cursors keep
 *    the expansion + pagination state machine pure.
 *  - breadcrumb assembly: ChildDetail carries root → parent (self excluded);
 *    `breadcrumbPath` maps it to label rows the panel renders top-down, each
 *    clickable to navigate to that ancestor's own detail (§3 顶部 breadcrumb
 *    可逐级返回 parent).
 *  - the follow-up call model: one-shot READ-ONLY (POST /v1/topology/{id}/
 *    followup) — `followupCall` derives the exact request descriptor from
 *    the child id + draft (null while the draft is blank), and
 *    `followupReceiptView` renders the receipt (message_id only — 接收只返回
 *    message_id,不冒充已执行; child state is never touched).
 *
 * Virtualized 10k-node rendering, keyboard/ARIA and browser visual
 * acceptance stay in the DOM layer and are recorded NOT_RUN_MANUAL_PENDING
 * (hardening §5).
 */
import { getLocale, t, type Locale } from './i18n/index'
import { zh as topologyZh, en as topologyEn } from './i18n/locales/topology'
import type { ChildDetail, FollowupReceipt, TopologyChildren, TopologyNode } from './types'

/** Wire child states (research-schemas ChildState) — chrome copy lives in
 *  the topology namespace (zh/en parity); unknown future states render the
 *  raw wire value verbatim (§8 line 115). */
export const CHILD_STATE_VALUES = [
  'running', 'inactive', 'diagnostic', 'succeeded', 'failed', 'cancelled', 'redacted', 'unknown',
] as const

/** Wire child modes (ChildMode) with chrome copy in the topology namespace. */
export const CHILD_MODE_VALUES = ['one-shot', 'continuable', 'read-only'] as const

/** Level key for the root direct-children page (parent_id = null). */
export const TOPOLOGY_ROOT_KEY = ''

export function hasTopologyKey(key: string, locale: Locale): boolean {
  const dict = (locale === 'zh' ? topologyZh : topologyEn) as Record<string, string>
  return dict[key] !== undefined
}

/** Child-state copy: topology.state.* when known, else the raw wire value. */
export function childStateText(state: string | null | undefined, locale: Locale = getLocale()): string {
  if (state === undefined || state === null || state === '') return ''
  const key = `topology.state.${state}`
  if (hasTopologyKey(key, locale)) return t('topology', key)
  return state
}

/** Child-mode copy: topology.mode.* when known, else the raw wire value. */
export function childModeText(mode: string | null | undefined, locale: Locale = getLocale()): string {
  if (mode === undefined || mode === null || mode === '') return ''
  const key = `topology.mode.${mode}`
  if (hasTopologyKey(key, locale)) return t('topology', key)
  return mode
}

/** Child-kind copy: topology.kind.* when known, else the raw wire value. */
export function childKindText(kind: string | null | undefined, locale: Locale = getLocale()): string {
  if (kind === undefined || kind === null || kind === '') return ''
  const key = `topology.kind.${kind}`
  if (hasTopologyKey(key, locale)) return t('topology', key)
  return kind
}

/* ─────────────────────── tree levels & flattening ─────────────────────── */

/** Accumulated direct-children page for ONE parent ('' = roots). */
export interface TopologyLevelState {
  /** Parent child_id ('' = project roots, parent_id null). */
  parentId: string
  items: TopologyNode[]
  nextAfterSeq: number | null
  hasMore: boolean
  total: number
  loaded: boolean
  loading: boolean
  error: string | null
}

export function initialTopologyLevel(parentId: string | null): TopologyLevelState {
  return {
    parentId: parentId ?? TOPOLOGY_ROOT_KEY,
    items: [],
    nextAfterSeq: null,
    hasMore: false,
    total: 0,
    loaded: false,
    loading: false,
    error: null,
  }
}

/** Merge one wire page into a level (dedupe by child_id — idempotent). */
export function applyTopologyPage(prev: TopologyLevelState, page: TopologyChildren): TopologyLevelState {
  const seen = new Set(prev.items.map(n => n.child_id))
  const merged: TopologyNode[] = [...prev.items]
  for (const node of Array.isArray(page.items) ? page.items : []) {
    if (node === null || typeof node !== 'object') continue
    const id = typeof node.child_id === 'string' ? node.child_id : ''
    if (id !== '' && seen.has(id)) continue
    if (id !== '') seen.add(id)
    merged.push(node as TopologyNode)
  }
  return {
    parentId: prev.parentId,
    items: merged,
    nextAfterSeq: typeof page.next_after_seq === 'number' ? page.next_after_seq : null,
    hasMore: page.has_more === true,
    total: typeof page.total === 'number' ? page.total : merged.length,
    loaded: true,
    loading: false,
    error: null,
  }
}

/** Cursor for the next page of one level (null when exhausted). */
export function nextTopologyCursor(state: TopologyLevelState): number | null {
  if (state.hasMore !== true || state.nextAfterSeq === null) return null
  return state.nextAfterSeq
}

export function canLoadMoreTopology(state: TopologyLevelState): boolean {
  return state.loaded === true && state.hasMore === true && state.nextAfterSeq !== null
}

/** Toggle one node's expanded flag (pure set copy). */
export function toggleTopologyNode(expanded: ReadonlySet<string>, childId: string): Set<string> {
  const next = new Set(expanded)
  if (next.has(childId)) next.delete(childId)
  else next.add(childId)
  return next
}

export interface TopologyTreeNodeView {
  child_id: string
  /** Level key the node was listed under ('' = roots; else its parent's
   *  child_id) — lets the DOM layer attach per-level load-more buttons. */
  parentKey: string
  /** Display label: node.label when present, else the opaque child_id. */
  label: string
  summary: string
  state: string
  stateText: string
  mode: string
  modeText: string
  kind: string
  kindText: string
  depth: number
  hasChildren: boolean
  childrenCount: number
  expanded: boolean
  /** Children level fetched at least once (lazy expand contract). */
  childrenLoaded: boolean
  childrenLoading: boolean
  childrenError: string | null
  startedAt: string
  endedAt: string | null
}

/** One node view (used by flatten AND the child-detail inspector). */
export function topologyNodeView(
  node: TopologyNode,
  opts: {
    parentKey: string
    depth: number
    expanded: ReadonlySet<string>
    level?: TopologyLevelState
    locale?: Locale
  },
): TopologyTreeNodeView {
  const locale = opts.locale ?? getLocale()
  const childId = typeof node.child_id === 'string' ? node.child_id : ''
  const hasChildren = node.has_children === true || (typeof node.children_count === 'number' && node.children_count > 0)
  const level = opts.level
  return {
    child_id: childId,
    parentKey: opts.parentKey,
    label: typeof node.label === 'string' && node.label !== '' ? node.label : childId,
    summary: typeof node.summary === 'string' ? node.summary : '',
    state: typeof node.state === 'string' ? node.state : 'unknown',
    stateText: childStateText(node.state, locale),
    mode: typeof node.mode === 'string' ? node.mode : '',
    modeText: childModeText(node.mode, locale),
    kind: typeof node.kind === 'string' ? node.kind : 'subagent',
    kindText: childKindText(node.kind, locale),
    depth: opts.depth,
    hasChildren,
    childrenCount: typeof node.children_count === 'number' ? node.children_count : (hasChildren ? 1 : 0),
    expanded: opts.expanded.has(childId),
    childrenLoaded: level?.loaded === true,
    childrenLoading: level?.loading === true,
    childrenError: level?.error ?? null,
    startedAt: typeof node.started_at === 'string' ? node.started_at : '',
    endedAt: typeof node.ended_at === 'string' && node.ended_at !== '' ? node.ended_at : null,
  }
}

/**
 * Flatten the expanded tree into visible rows (depth-first, root level '').
 * Children rows appear only when their parent's level is loaded (lazy
 * expand contract — §3 展开时懒加载直接子项). Cycle-safe: a node whose
 * ancestor chain already contains it never recurses (orphan/cycle fail-soft).
 */
export function flattenTopologyRows(
  levels: Record<string, TopologyLevelState>,
  expanded: ReadonlySet<string>,
  locale: Locale = getLocale(),
): TopologyTreeNodeView[] {
  const out: TopologyTreeNodeView[] = []
  const walk = (parentKey: string, depth: number, ancestors: ReadonlySet<string>): void => {
    const level = levels[parentKey]
    if (level === undefined || !level.loaded) return
    for (const node of level.items) {
      const childId = typeof node.child_id === 'string' ? node.child_id : ''
      const view = topologyNodeView(node, { parentKey, depth, expanded, level: levels[childId], locale })
      out.push(view)
      if (view.expanded && childId !== '' && !ancestors.has(childId)) {
        walk(childId, depth + 1, new Set([...ancestors, childId]))
      }
    }
  }
  walk(TOPOLOGY_ROOT_KEY, 0, new Set())
  return out
}

/* ─────────────────────── breadcrumb assembly ─────────────────────── */

export interface BreadcrumbItem {
  child_id: string
  label: string
}

/**
 * Breadcrumb path for one child detail: root → parent, self excluded
 * (wire `breadcrumb`), each item clickable to navigate up (§3). Roots and
 * orphan fail-soft children yield an empty breadcrumb.
 */
export function breadcrumbPath(detail: ChildDetail, locale: Locale = getLocale()): BreadcrumbItem[] {
  const items = Array.isArray(detail.breadcrumb) ? detail.breadcrumb : []
  return items.map(node => ({
    child_id: typeof node.child_id === 'string' ? node.child_id : '',
    label: typeof node.label === 'string' && node.label !== '' ? node.label : (typeof node.child_id === 'string' ? node.child_id : ''),
  }))
}

/** Whether the child has a direct parent (non-root, non-orphan). */
export function childHasParent(detail: ChildDetail): boolean {
  return detail.parent !== null && detail.parent !== undefined
}

/* ─────────────────────── history view ─────────────────────── */

export interface ChildHistoryEntryView {
  seq: number
  type: string
  /** type copy: topology.history.type.* when known, else raw wire value. */
  typeText: string
  occurredAt: string
  timeText: string
  summary: string
}

export function childHistoryEntryView(entry: {
  seq: number
  type: string
  occurred_at: string
  summary: string
}, locale: Locale = getLocale()): ChildHistoryEntryView {
  const type = typeof entry.type === 'string' ? entry.type : ''
  const typeKey = `topology.history.type.${type}`
  const typeText = hasTopologyKey(typeKey, locale) ? t('topology', typeKey) : type
  let timeText = typeof entry.occurred_at === 'string' ? entry.occurred_at : ''
  const ts = Date.parse(timeText)
  if (Number.isFinite(ts)) {
    try {
      timeText = new Date(ts).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    } catch { /* keep raw */ }
  }
  return {
    seq: typeof entry.seq === 'number' ? entry.seq : 0,
    type,
    typeText,
    occurredAt: typeof entry.occurred_at === 'string' ? entry.occurred_at : '',
    timeText,
    summary: typeof entry.summary === 'string' ? entry.summary : '',
  }
}

/* ─────────────────────── follow-up (one-shot READ-ONLY) ─────────────────────── */

export interface FollowupCallModel {
  childId: string
  method: 'POST'
  /** Exact route: /v1/topology/{child_id}/followup (SUBAGENT-01 §3/§7). */
  path: string
  body: { message: string; request_id?: string }
  /** One-shot READ-ONLY contract: recorded, never executed, state never
   *  touched (trajectory-subagents.md §3 接收只返回 message_id). */
  readOnly: true
  requestId: string | null
}

/**
 * Derive the follow-up request descriptor from the child id + draft.
 * Returns null while the draft is blank/whitespace (send button disabled).
 */
export function followupCall(childId: string, message: string, requestId?: string): FollowupCallModel | null {
  const msg = typeof message === 'string' ? message.trim() : ''
  if (childId === '' || msg === '') return null
  const body: { message: string; request_id?: string } = { message: msg }
  const rid = typeof requestId === 'string' && requestId !== '' ? requestId : undefined
  if (rid !== undefined) body.request_id = rid
  return {
    childId,
    method: 'POST',
    path: `/v1/topology/${encodeURIComponent(childId)}/followup`,
    body,
    readOnly: true,
    requestId: rid ?? null,
  }
}

export interface FollowupReceiptView {
  messageId: string
  accepted: boolean
  readOnly: boolean
  stateUnchanged: boolean
  /** Whole receipt line: message_id + read-only note (current locale). */
  sentText: string
  note: string
}

/** Render one follow-up receipt (message_id only; child state unchanged). */
export function followupReceiptView(receipt: FollowupReceipt): FollowupReceiptView {
  const messageId = typeof receipt.message_id === 'string' ? receipt.message_id : ''
  const note = typeof receipt.note === 'string' ? receipt.note : ''
  return {
    messageId,
    accepted: receipt.accepted === true,
    readOnly: receipt.read_only === true,
    stateUnchanged: receipt.state_unchanged === true,
    sentText: t('topology', 'topology.followup.sent', { message_id: messageId }),
    note,
  }
}

/* ─────────────────────── child detail view ─────────────────────── */

export interface ChildDetailView {
  childId: string
  node: TopologyTreeNodeView
  breadcrumb: BreadcrumbItem[]
  hasParent: boolean
}

/** One child detail: node inspector + breadcrumb path (§3 点击或 Enter 进入
 *  child 详情,顶部 breadcrumb 可逐级返回 parent). */
export function childDetailView(
  detail: ChildDetail,
  opts: { expanded?: ReadonlySet<string>; locale?: Locale } = {},
): ChildDetailView {
  const locale = opts.locale ?? getLocale()
  return {
    childId: typeof detail.child_id === 'string' ? detail.child_id : '',
    node: topologyNodeView(detail.node, { parentKey: TOPOLOGY_ROOT_KEY, depth: 0, expanded: opts.expanded ?? new Set(), locale }),
    breadcrumb: breadcrumbPath(detail, locale),
    hasParent: childHasParent(detail),
  }
}
