/**
 * SUBAGENT-01 Topology panel (DOM assembly over topology-model.ts — the
 * pure logic layer, docs/trajectory-subagents.md §3/§6): the exact
 * direct-children tree (lazy expansion per parent), breadcrumb navigation
 * into a child's detail, the read-only per-child history and the one-shot
 * READ-ONLY follow-up (POST /v1/topology/{id}/followup — recorded as a
 * message_id, never activates the child). All chrome copy goes through the
 * `topology` i18n namespace (zh/en parity); label/summary/state/mode are
 * wire values displayed verbatim or through enum keys.
 *
 * Virtualized 10k-node rendering, keyboard/ARIA and browser visual
 * acceptance stay NOT_RUN_MANUAL_PENDING (hardening §5) — the logic layer
 * implements the flatten/expand/breadcrumb/followup state machines; the
 * DOM layer assembles nodes from them.
 */
import { api } from '../api'
import { t } from '../i18n/index'
import { el } from '../ui'
import {
  TOPOLOGY_ROOT_KEY, applyTopologyPage, canLoadMoreTopology, childDetailView,
  childHistoryEntryView, flattenTopologyRows, followupCall, followupReceiptView,
  initialTopologyLevel, nextTopologyCursor, toggleTopologyNode,
  type TopologyLevelState, type TopologyTreeNodeView,
} from '../topology-model'
import type { ChildDetail, ChildHistoryEntry, ChildHistoryPage, FollowupReceipt, TopologyChildren } from '../types'

/** Initial page size (server caps at 500). */
const PAGE_LIMIT = 100

interface TopologyPanelState {
  /** parent_id ('' = roots) → accumulated direct-children level. */
  levels: Record<string, TopologyLevelState>
  expanded: Set<string>
  /** child_id open in the detail view (null = tree view). */
  detail: string | null
  detailStatus: 'idle' | 'loading' | 'ready' | 'error'
  detailData: ChildDetail | null
  history: ChildHistoryEntry[] | null
  historyStatus: 'idle' | 'loading' | 'ready' | 'error'
  followupDraft: string
  followupReceipt: FollowupReceipt | null
  followupError: boolean
}

const panelStates = new Map<string, TopologyPanelState>()

function ensureState(projectId: string): TopologyPanelState {
  let st = panelStates.get(projectId)
  if (st === undefined) {
    st = {
      levels: {},
      expanded: new Set(),
      detail: null,
      detailStatus: 'idle',
      detailData: null,
      history: null,
      historyStatus: 'idle',
      followupDraft: '',
      followupReceipt: null,
      followupError: false,
    }
    panelStates.set(projectId, st)
  }
  return st
}

/** Read-only status tag (resolved copy from the model — never re-derives
 *  enum text through the status namespace, so unknown wire states cannot
 *  produce missing-key reports). */
function stateTag(text: string): HTMLElement {
  const node = el('span')
  node.style.cssText = 'display:inline-flex;align-items:center;gap:5px;font:600 10px/1.6 ui-monospace,Menlo,monospace;letter-spacing:.3px;color:var(--text-3);background:var(--bg-3);border:1px solid var(--border);border-radius:99px;padding:1px 8px;white-space:nowrap;flex-shrink:0'
  node.textContent = text
  return node
}

/** One detail/field row (label + mono value). */
function fieldRow(label: string, value: string): HTMLElement {
  const row = el('div', 'row')
  row.style.cssText = 'padding:3px 0;align-items:flex-start'
  const l = el('span', '', label)
  l.style.cssText = 'width:88px;color:var(--text-3);font-size:11px;flex-shrink:0'
  const v = el('span', 'mono', value)
  v.style.cssText = 'font-size:11px;color:var(--text);word-break:break-word'
  row.append(l, v)
  return row
}

/* ─────────────────────── tree view ─────────────────────── */

function nodeRow(
  row: TopologyTreeNodeView,
  onExpand: () => void,
  onOpen: () => void,
): HTMLElement {
  const wrap = el('div', 'row')
  wrap.style.cssText = `padding:4px 2px;padding-left:${12 + row.depth * 18}px;align-items:center`
  if (row.hasChildren) {
    const caret = el('button', 'hbtn', row.expanded ? '▾' : '▸')
    caret.setAttribute('aria-expanded', row.expanded ? 'true' : 'false')
    caret.setAttribute('aria-label', row.expanded
      ? t('topology', 'topology.collapse')
      : t('topology', 'topology.expand'))
    caret.style.cssText = 'padding:0 5px;font-size:10px;flex-shrink:0'
    if (row.childrenLoading) caret.textContent = '…'
    if (row.childrenError !== null) caret.title = t('topology', 'topology.error')
    caret.onclick = onExpand
    wrap.appendChild(caret)
  } else {
    const spacer = el('span', '', '')
    spacer.style.cssText = 'width:24px;flex-shrink:0'
    wrap.appendChild(spacer)
  }
  const label = el('span', 'grow', row.label)
  label.title = row.label
  label.style.cssText = 'font-size:11.5px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
  wrap.appendChild(label)
  if (row.modeText !== '') {
    const mode = el('span', 'muted', row.modeText)
    mode.style.cssText = 'font-size:9.5px;flex-shrink:0'
    wrap.appendChild(mode)
  }
  wrap.appendChild(stateTag(row.stateText))
  const open = el('button', 'hbtn', '⧉')
  open.title = t('topology', 'topology.openDetail')
  open.setAttribute('aria-label', t('topology', 'topology.openDetail'))
  open.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
  open.onclick = onOpen
  wrap.appendChild(open)
  return wrap
}

function loadMoreButton(label: string, onClick: () => void): HTMLElement {
  const more = el('button', 'hbtn', label)
  more.style.cssText = 'margin:6px 0 6px 40px;display:block'
  more.onclick = onClick
  return more
}

function paintTree(panel: HTMLElement, st: TopologyPanelState, projectId: string, repaint: () => void): void {
  const roots = st.levels[TOPOLOGY_ROOT_KEY]
  panel.appendChild(el('div', 'section-label', t('topology', 'topology.rootsLabel')))
  const hint = el('div', 'muted', t('topology', 'topology.rootsHint'))
  hint.style.cssText = 'font-size:10.5px;margin-bottom:6px;max-width:680px'
  panel.appendChild(hint)
  if (roots === undefined || (!roots.loaded && roots.error === null)) {
    panel.appendChild(el('div', 'empty', t('topology', 'topology.loading')))
    return
  }
  if (roots.error !== null && roots.items.length === 0) {
    panel.appendChild(el('div', 'error-banner', t('topology', 'topology.error')))
    return
  }
  const rows = flattenTopologyRows(st.levels, st.expanded)
  if (rows.length === 0) {
    panel.appendChild(el('div', 'empty', t('topology', 'topology.empty')))
    return
  }
  rows.forEach((row, index) => {
    const next = rows[index + 1]
    panel.appendChild(nodeRow(
      row,
      () => toggleExpand(projectId, st, row, repaint),
      () => openChildDetail(projectId, st, row.child_id, repaint),
    ))
    // Per-level load-more: attach after the level's last visible row.
    const level = st.levels[row.parentKey]
    if (level !== undefined && canLoadMoreTopology(level) && (next === undefined || next.parentKey !== row.parentKey)) {
      const cursor = nextTopologyCursor(level)
      panel.appendChild(loadMoreButton(t('topology', 'topology.loadMore'), () => {
        if (cursor !== null) void loadMoreLevel(projectId, st, row.parentKey, cursor, repaint)
      }))
    }
  })
}

async function toggleExpand(projectId: string, st: TopologyPanelState, row: TopologyTreeNodeView, repaint: () => void): Promise<void> {
  const levelKey = row.child_id
  const level = st.levels[levelKey]
  if (level !== undefined && level.loaded) {
    st.expanded = toggleTopologyNode(st.expanded, row.child_id)
    repaint()
    return
  }
  if (level !== undefined && level.loading) return
  // Lazy expand (§3 展开时懒加载直接子项): fetch this parent's direct
  // children on first expand, then show them.
  st.expanded = toggleTopologyNode(st.expanded, row.child_id)
  st.levels[levelKey] = { ...initialTopologyLevel(row.child_id), loading: true }
  repaint()
  const page = await api<TopologyChildren>(`/v1/projects/${encodeURIComponent(projectId)}/topology?parent_id=${encodeURIComponent(row.child_id)}&limit=${PAGE_LIMIT}`)
  if (page === null) {
    st.levels[levelKey] = { ...initialTopologyLevel(row.child_id), error: 'bridge' }
  } else {
    st.levels[levelKey] = applyTopologyPage(initialTopologyLevel(row.child_id), page)
  }
  repaint()
}

async function loadMoreLevel(projectId: string, st: TopologyPanelState, parentKey: string, afterSeq: number, repaint: () => void): Promise<void> {
  const level = st.levels[parentKey]
  if (level === undefined || !canLoadMoreTopology(level)) return
  const parentParam = parentKey === TOPOLOGY_ROOT_KEY ? '' : `&parent_id=${encodeURIComponent(parentKey)}`
  st.levels[parentKey] = { ...level, loading: true }
  repaint()
  const page = await api<TopologyChildren>(`/v1/projects/${encodeURIComponent(projectId)}/topology?limit=${PAGE_LIMIT}&after_seq=${afterSeq}${parentParam}`)
  if (page === null) {
    st.levels[parentKey] = { ...level, loading: false, error: 'bridge' }
  } else {
    st.levels[parentKey] = applyTopologyPage(level, page)
  }
  repaint()
}

/* ─────────────────────── child detail view ─────────────────────── */

function historyRow(entry: ChildHistoryEntry): HTMLElement {
  const view = childHistoryEntryView(entry)
  const row = el('div', 'row')
  row.style.cssText = 'padding:4px 0;border-bottom:1px dashed var(--border-2);align-items:flex-start'
  const seq = el('span', 'mono', String(view.seq))
  seq.style.cssText = 'color:var(--text-3);font-size:10px;flex-shrink:0;width:26px'
  const type = el('span', 'artifact-kind', view.typeText)
  const time = el('span', 'muted', view.timeText)
  time.style.cssText = 'font-size:10px;flex-shrink:0'
  const summary = el('span', 'grow', view.summary)
  summary.style.cssText = 'font-size:11px;color:var(--text);word-break:break-word'
  row.append(seq, type, time, summary)
  return row
}

function paintDetail(panel: HTMLElement, st: TopologyPanelState, projectId: string, repaint: () => void): void {
  const back = el('button', 'hbtn', t('topology', 'topology.back'))
  back.style.cssText = 'margin-bottom:6px'
  back.onclick = () => {
    st.detail = null
    st.detailStatus = 'idle'
    st.detailData = null
    st.history = null
    st.historyStatus = 'idle'
    st.followupReceipt = null
    st.followupError = false
    repaint()
  }
  panel.appendChild(back)
  const d = st.detailData
  if (d === null) {
    panel.appendChild(el('div', 'empty', st.detailStatus === 'error'
      ? t('topology', 'topology.error')
      : t('topology', 'topology.loading')))
    return
  }
  const view = childDetailView(d)
  panel.appendChild(el('div', 'section-label', t('topology', 'topology.detailTitle')))
  // Breadcrumb (root → parent), each item navigates to that ancestor.
  if (view.breadcrumb.length > 0) {
    const crumb = el('nav')
    crumb.setAttribute('aria-label', t('topology', 'topology.breadcrumb.aria'))
    crumb.style.cssText = 'display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin:6px 0 10px'
    for (const item of view.breadcrumb) {
      const btn = el('button', 'hbtn', item.label)
      btn.style.cssText = 'font-size:10px;padding:1px 8px;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      btn.title = item.label
      btn.onclick = () => openChildDetail(projectId, st, item.child_id, repaint)
      crumb.appendChild(btn)
      const sep = el('span', 'muted', '›')
      sep.style.cssText = 'font-size:10px;flex-shrink:0'
      crumb.appendChild(sep)
    }
    panel.appendChild(crumb)
  }
  // Inspector card (安全摘要 + allowlisted fields, never raw detail).
  const card = el('div', 'card')
  const head = el('div', 'row')
  head.style.cssText = 'align-items:center;gap:8px;margin-bottom:6px'
  head.appendChild(el('span', 'artifact-kind', view.node.kindText))
  const label = el('span', 'pname', view.node.label)
  label.style.cssText = 'font:700 12.5px/1.3 system-ui,sans-serif;color:var(--text)'
  head.appendChild(label)
  head.appendChild(el('span', 'grow'))
  head.appendChild(stateTag(view.node.stateText))
  card.appendChild(head)
  if (view.node.summary !== '') card.appendChild(fieldRow(t('topology', 'topology.field.summary'), view.node.summary))
  card.appendChild(fieldRow(t('topology', 'topology.field.state'), view.node.stateText))
  card.appendChild(fieldRow(t('topology', 'topology.field.mode'), view.node.modeText))
  card.appendChild(fieldRow(t('topology', 'topology.field.kind'), view.node.kindText))
  if (view.node.childrenCount > 0) {
    card.appendChild(fieldRow(t('topology', 'topology.field.children'), String(view.node.childrenCount)))
  }
  card.appendChild(fieldRow(t('topology', 'topology.field.startedAt'), view.node.startedAt))
  if (view.node.endedAt !== null) card.appendChild(fieldRow(t('topology', 'topology.field.endedAt'), view.node.endedAt))
  panel.appendChild(card)
  // Read-only history (never activates the child).
  panel.appendChild(el('div', 'section-label', t('topology', 'topology.history.title')))
  if (st.historyStatus === 'loading') {
    panel.appendChild(el('div', 'empty', t('topology', 'topology.loading')))
  } else if (st.historyStatus === 'error') {
    panel.appendChild(el('div', 'error-banner', t('topology', 'topology.error')))
  } else if ((st.history ?? []).length === 0) {
    panel.appendChild(el('div', 'empty', t('topology', 'topology.history.empty')))
  } else {
    for (const entry of st.history ?? []) panel.appendChild(historyRow(entry))
  }
  // One-shot READ-ONLY follow-up.
  panel.appendChild(el('div', 'section-label', t('topology', 'topology.followup.title')))
  const note = el('div', 'muted', t('topology', 'topology.followup.readOnlyNote'))
  note.style.cssText = 'font-size:10px;margin-bottom:6px;max-width:680px'
  panel.appendChild(note)
  if (st.followupReceipt !== null) {
    const receipt = followupReceiptView(st.followupReceipt)
    const line = el('div', 'muted', receipt.sentText)
    line.style.cssText = 'color:var(--tone-green);font-size:11px;margin-bottom:6px;word-break:break-all'
    panel.appendChild(line)
  }
  if (st.followupError) {
    const err = el('div', 'muted', t('topology', 'topology.followup.failed'))
    err.style.cssText = 'color:var(--tone-red);font-size:11px;margin-bottom:6px'
    panel.appendChild(err)
  }
  const composer = el('div', 'row')
  composer.style.cssText = 'align-items:center;gap:8px'
  const input = el('input', 'picker')
  input.type = 'text'
  input.placeholder = t('topology', 'topology.followup.placeholder')
  input.value = st.followupDraft
  input.style.cssText = 'flex:1;margin:0'
  const childId = st.detail
  const paintSendState = (): void => {
    send.disabled = childId === null || followupCall(childId, st.followupDraft) === null
  }
  input.oninput = () => {
    st.followupDraft = input.value
    paintSendState()
  }
  composer.appendChild(input)
  const send = el('button', 'btn approve', t('topology', 'topology.followup.send'))
  send.style.cssText = 'min-height:30px;padding:5px 14px'
  paintSendState()
  send.onclick = () => { void sendFollowup(projectId, st, childId, repaint) }
  composer.appendChild(send)
  panel.appendChild(composer)
}

async function sendFollowup(projectId: string, st: TopologyPanelState, childId: string | null, repaint: () => void): Promise<void> {
  if (childId === null) return
  const call = followupCall(childId, st.followupDraft)
  if (call === null) return
  const receipt = await api<FollowupReceipt>(call.path, {
    method: call.method,
    body: JSON.stringify(call.body),
  })
  if (receipt === null) {
    st.followupError = true
  } else {
    st.followupReceipt = receipt
    st.followupError = false
    st.followupDraft = ''
  }
  repaint()
}

function openChildDetail(projectId: string, st: TopologyPanelState, childId: string, repaint: () => void): void {
  st.detail = childId
  st.detailStatus = 'loading'
  st.detailData = null
  st.history = null
  st.historyStatus = 'idle'
  st.followupDraft = ''
  st.followupReceipt = null
  st.followupError = false
  repaint()
  void loadDetail(projectId, st, childId, repaint)
}

async function loadDetail(projectId: string, st: TopologyPanelState, childId: string, repaint: () => void): Promise<void> {
  const detail = await api<ChildDetail>(`/v1/topology/${encodeURIComponent(childId)}`)
  if (st.detail !== childId) return // user navigated away meanwhile
  if (detail === null) {
    st.detailStatus = 'error'
    repaint()
    return
  }
  st.detailData = detail
  st.detailStatus = 'ready'
  st.historyStatus = 'loading'
  repaint()
  const history = await api<ChildHistoryPage>(`/v1/topology/${encodeURIComponent(childId)}/history?limit=${PAGE_LIMIT}`)
  if (st.detail !== childId) return
  if (history === null) {
    st.historyStatus = 'error'
  } else {
    st.history = history.items
    st.historyStatus = 'ready'
  }
  repaint()
}

function paintTopology(body: HTMLElement, st: TopologyPanelState, projectId: string): void {
  body.replaceChildren()
  const panel = el('div')
  const repaint = (): void => paintTopology(body, st, projectId)
  if (st.detail !== null) paintDetail(panel, st, projectId, repaint)
  else paintTree(panel, st, projectId, repaint)
  body.appendChild(panel)
}

/** Panel entry (index.ts dispatch): paints the current state, then fetches
 *  the root level when this project was never loaded. */
export async function renderTopology(body: HTMLElement, projectId: string): Promise<void> {
  const st = ensureState(projectId)
  const roots = st.levels[TOPOLOGY_ROOT_KEY] ?? initialTopologyLevel(null)
  st.levels[TOPOLOGY_ROOT_KEY] = roots
  paintTopology(body, st, projectId)
  if (!roots.loaded && !roots.loading) {
    st.levels[TOPOLOGY_ROOT_KEY] = { ...roots, loading: true }
    paintTopology(body, st, projectId)
    const page = await api<TopologyChildren>(`/v1/projects/${encodeURIComponent(projectId)}/topology?limit=${PAGE_LIMIT}`)
    if (page === null) {
      st.levels[TOPOLOGY_ROOT_KEY] = { ...initialTopologyLevel(null), error: 'bridge' }
    } else {
      st.levels[TOPOLOGY_ROOT_KEY] = applyTopologyPage(initialTopologyLevel(null), page)
    }
    paintTopology(body, st, projectId)
  }
}
