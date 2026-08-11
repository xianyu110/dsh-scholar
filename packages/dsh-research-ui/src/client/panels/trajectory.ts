/**
 * TRAJ-01 Trajectory panel (DOM assembly over trajectory-model.ts — the
 * pure logic layer, docs/trajectory-subagents.md §1/§6): dual Research /
 * Session lanes, per-lane keyset pagination, server-redacted summaries,
 * and the expandable allowlisted detail. All chrome copy goes through the
 * `trajectory` i18n namespace (zh/en parity); the kernel's redacted
 * summaries and enum wire values are displayed verbatim.
 *
 * Virtualized/scroll-paginated browsing and browser visual acceptance stay
 * NOT_RUN_MANUAL_PENDING (hardening §5) — the logic layer implements the
 * pagination state machine; the DOM layer renders accumulated pages.
 */
import { api } from '../api'
import { t } from '../i18n/index'
import { el } from '../ui'
import {
  applyTrajectoryPage, canLoadMoreTrajectory, initialTrajectoryPageState,
  nextTrajectoryCursor, trajectoryPanelView,
  type TrajectoryEntryView, type TrajectoryPageState,
} from '../trajectory-model'
import type { TrajectoryLaneKey, TrajectoryLanes, TrajectoryPage } from '../types'

/** Initial page size (server caps at 500; 100 keeps the first paint light). */
const PAGE_LIMIT = 100

/** Per-project panel state (survives panel re-renders / locale switches). */
interface TrajectoryPanelState {
  research: TrajectoryPageState
  session: TrajectoryPageState
  inflight: boolean
}

const panelStates = new Map<string, TrajectoryPanelState>()
/** entry_id → detail expanded (module-scoped, ephemeral UI state). */
const expandedDetail = new Set<string>()

function ensureState(projectId: string): TrajectoryPanelState {
  let st = panelStates.get(projectId)
  if (st === undefined) {
    st = { research: initialTrajectoryPageState(), session: initialTrajectoryPageState(), inflight: false }
    panelStates.set(projectId, st)
  }
  return st
}

/** Read-only status tag (resolved copy from the model — never re-derives
 *  enum text through the status namespace, so unknown wire statuses cannot
 *  produce missing-key reports). */
function statusTag(text: string): HTMLElement {
  const node = el('span')
  node.style.cssText = 'display:inline-flex;align-items:center;gap:5px;font:600 10px/1.6 ui-monospace,Menlo,monospace;letter-spacing:.4px;color:var(--text-3);background:var(--bg-3);border:1px solid var(--border);border-radius:99px;padding:1px 8px;white-space:nowrap;flex-shrink:0'
  node.textContent = text
  return node
}

function entryCard(view: TrajectoryEntryView, onToggle: () => void): HTMLElement {
  const card = el('div', 'card')
  card.style.cssText = 'padding:7px 10px;margin:4px 0'
  const row = el('div', 'row')
  const seq = el('span', 'mono', String(view.event_seq))
  seq.style.cssText = 'color:var(--text-3);flex-shrink:0'
  row.appendChild(seq)
  const time = el('span', 'muted', view.timeText)
  time.style.cssText = 'font-size:10px;flex-shrink:0'
  row.appendChild(time)
  const summary = el('span', 'grow', view.summary)
  summary.style.cssText = 'font-size:11.5px;color:var(--text);word-break:break-word'
  row.appendChild(summary)
  if (view.statusText !== '') row.appendChild(statusTag(view.statusText))
  card.appendChild(row)
  if (view.hasDetail) {
    const expanded = expandedDetail.has(view.entry_id)
    const toggle = el('button', 'hbtn', expanded ? '▾' : '▸')
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    toggle.setAttribute('aria-label', expanded
      ? t('trajectory', 'trajectory.collapseDetail')
      : t('trajectory', 'trajectory.expandDetail'))
    toggle.style.cssText = 'padding:0 6px;font-size:10px;flex-shrink:0'
    toggle.onclick = () => {
      if (expandedDetail.has(view.entry_id)) expandedDetail.delete(view.entry_id)
      else expandedDetail.add(view.entry_id)
      onToggle()
    }
    row.appendChild(toggle)
    if (expanded) {
      const detailBox = el('div')
      detailBox.style.cssText = 'margin:6px 0 0;padding:6px 8px;background:var(--bg-3);border:1px solid var(--border-2);border-radius:8px'
      for (const detail of view.details) {
        const drow = el('div', 'row')
        drow.style.cssText = 'padding:2px 0;align-items:flex-start'
        const label = el('span', '', detail.label)
        label.style.cssText = 'width:74px;color:var(--text-3);font-size:10.5px;flex-shrink:0'
        const value = el('span', 'mono', detail.value)
        value.style.cssText = 'font-size:10.5px;color:var(--text);word-break:break-all'
        drow.append(label, value)
        detailBox.appendChild(drow)
      }
      card.appendChild(detailBox)
    }
  }
  return card
}

function paintTrajectory(body: HTMLElement, st: TrajectoryPanelState, projectId: string): void {
  body.replaceChildren()
  const view = trajectoryPanelView({ research: st.research, session: st.session })
  const panel = el('div')
  if (view.idle) {
    panel.appendChild(el('div', 'empty', view.loadingText))
    body.appendChild(panel)
    return
  }
  if (view.panelEmptyText !== '') {
    panel.appendChild(el('div', 'empty', view.panelEmptyText))
    body.appendChild(panel)
    return
  }
  for (const lane of view.lanes) {
    const section = el('div')
    section.style.cssText = 'margin:0 0 18px'
    const head = el('div', 'row')
    head.style.cssText = 'justify-content:space-between;align-items:flex-start;gap:10px'
    const titleWrap = el('div')
    titleWrap.appendChild(el('div', 'section-label', lane.label))
    const desc = el('div', 'muted', lane.description)
    desc.style.cssText = 'font-size:10.5px;max-width:640px'
    titleWrap.appendChild(desc)
    head.appendChild(titleWrap)
    const badge = el('span', 'artifact-kind', lane.authorityLabel)
    badge.style.cssText += lane.authority === 'authoritative'
      ? ';color:var(--tone-green);border-color:var(--tone-green);flex-shrink:0'
      : ';flex-shrink:0'
    head.appendChild(badge)
    section.appendChild(head)
    const total = el('div', 'muted', t('trajectory', 'trajectory.total', { count: String(lane.total) }))
    total.style.cssText = 'font-size:10px;padding:4px 2px 2px'
    section.appendChild(total)
    if (lane.status === 'loading' && lane.entries.length === 0) {
      section.appendChild(el('div', 'empty', view.loadingText))
    } else if (lane.emptyText !== '') {
      section.appendChild(el('div', 'empty', lane.emptyText))
    } else {
      for (const entry of lane.entries) section.appendChild(entryCard(entry, () => paintTrajectory(body, st, projectId)))
      if (lane.status === 'error' && lane.entries.length > 0) {
        const err = el('div', 'muted', view.errorText)
        err.style.cssText = 'font-size:10px;color:var(--tone-red);padding:2px'
        section.appendChild(err)
      }
      if (lane.hasMore) {
        const more = el('button', 'hbtn', lane.status === 'loading'
          ? t('trajectory', 'trajectory.loadingMore')
          : t('trajectory', 'trajectory.loadMore'))
        more.style.cssText = 'margin:8px auto 0;display:block'
        more.disabled = lane.status === 'loading'
        more.onclick = () => { void loadMoreTrajectory(body, projectId, lane.key, st) }
        section.appendChild(more)
      }
    }
    panel.appendChild(section)
  }
  const note = el('div', 'muted', view.redactedNote)
  note.style.cssText = 'font-size:10px;padding-top:6px;border-top:1px solid var(--border-2)'
  panel.appendChild(note)
  body.appendChild(panel)
}

async function loadMoreTrajectory(body: HTMLElement, projectId: string, laneKey: TrajectoryLaneKey, st: TrajectoryPanelState): Promise<void> {
  const lane = laneKey === 'research' ? st.research : st.session
  if (!canLoadMoreTrajectory(lane)) return
  const cursor = nextTrajectoryCursor(lane)
  if (cursor === null) return
  lane.status = 'loading'
  paintTrajectory(body, st, projectId)
  const params = new URLSearchParams({ lane: laneKey, limit: String(PAGE_LIMIT), after_seq: String(cursor.after_seq) })
  if (cursor.after_event_id !== undefined) params.set('after_event_id', cursor.after_event_id)
  const page = await api<TrajectoryPage>(`/v1/projects/${encodeURIComponent(projectId)}/trajectory?${params.toString()}`)
  if (page === null) {
    lane.status = 'error'
  } else if (laneKey === 'research') {
    st.research = applyTrajectoryPage(lane, page)
  } else {
    st.session = applyTrajectoryPage(lane, page)
  }
  paintTrajectory(body, st, projectId)
}

/** Panel entry (index.ts dispatch): paints the accumulated state, then
 *  fetches the initial dual-lane page when this project was never loaded. */
export async function renderTrajectory(body: HTMLElement, projectId: string): Promise<void> {
  const st = ensureState(projectId)
  paintTrajectory(body, st, projectId)
  if (st.research.status === 'idle' && st.session.status === 'idle' && !st.inflight) {
    st.inflight = true
    st.research.status = 'loading'
    st.session.status = 'loading'
    paintTrajectory(body, st, projectId)
    const lanes = await api<TrajectoryLanes>(`/v1/projects/${encodeURIComponent(projectId)}/trajectory-lanes?limit=${PAGE_LIMIT}`)
    st.inflight = false
    if (lanes === null) {
      st.research.status = 'error'
      st.session.status = 'error'
    } else {
      st.research = applyTrajectoryPage(st.research, lanes.research)
      st.session = applyTrajectoryPage(st.session, lanes.session)
    }
    paintTrajectory(body, st, projectId)
  }
}
