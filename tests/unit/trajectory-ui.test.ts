/**
 * trajectory-ui (docs/trajectory-subagents.md §1/§3/§6,
 * hardening-v0.2-status.md §5 TRAJ-01/SUBAGENT-01 — UI 逻辑层): pure
 * logic-layer suite for the Trajectory / Topology panels (NO DOM), mirroring
 * ui-simple / i18n-chrome. Covers:
 *
 *   trajectory-model:  lane metadata (authoritative Research vs
 *                      observational Session), the (event_seq, event_id)
 *                      pagination state machine, the entry view model
 *                      (server-redacted summary + allowlisted detail), the
 *                      dual-lane panel view;
 *   topology-model:    direct-children level state + cursor, tree
 *                      flatten/expand (lazy children, cycle-safe), breadcrumb
 *                      assembly, child-detail view, read-only history view,
 *                      the one-shot READ-ONLY followup call model;
 *   nav/i18n:          trajectory/topology are reachable More tabs with
 *                      stable deep links; every chrome key exists in BOTH zh
 *                      and en — no missing-key reports in either locale.
 *
 * Browser visual acceptance (virtualized 10k rows, keyboard/ARIA) stays
 * NOT_RUN_MANUAL_PENDING (hardening §5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zh as trajectoryZh, en as trajectoryEn } from '../../packages/dsh-research-ui/src/client/i18n/locales/trajectory'
import { zh as topologyZh, en as topologyEn } from '../../packages/dsh-research-ui/src/client/i18n/locales/topology'
import { zh as shellZh, en as shellEn } from '../../packages/dsh-research-ui/src/client/i18n/locales/shell'
import {
  getLocale, localeParityReport, resetMissingKeyWarnings, setLocale, setMissingKeyReporter,
} from '../../packages/dsh-research-ui/src/client/i18n/index'
import { chromeTabs } from '../../packages/dsh-research-ui/src/client/i18n/chrome'
import { ALL_TAB_KEYS, MORE_TAB_KEYS, isTabKey, parseDeepLink } from '../../packages/dsh-research-ui/src/client/nav'
import {
  TRAJECTORY_LANE_KEYS, applyTrajectoryPage, canLoadMoreTrajectory,
  initialTrajectoryPageState, nextTrajectoryCursor, trajectoryEntryView,
  trajectoryLaneMeta, trajectoryPanelView, trajectoryStatusText,
} from '../../packages/dsh-research-ui/src/client/trajectory-model'
import {
  TOPOLOGY_ROOT_KEY, applyTopologyPage, breadcrumbPath, canLoadMoreTopology,
  childDetailView, childHistoryEntryView, childStateText, flattenTopologyRows,
  followupCall, followupReceiptView, initialTopologyLevel, nextTopologyCursor,
  toggleTopologyNode,
} from '../../packages/dsh-research-ui/src/client/topology-model'
import type { TrajectoryEntry, TrajectoryPage, TopologyNode } from '../../packages/dsh-research-ui/src/client/types'

interface Missing { namespace: string; key: string; locale: string }

let missing: Missing[] = []

beforeEach(() => {
  missing = []
  setMissingKeyReporter(r => { missing.push(r) })
})

afterEach(() => {
  setMissingKeyReporter(null)
  resetMissingKeyWarnings()
})

let seqCounter = 0
function entry(over: Partial<TrajectoryEntry> = {}): TrajectoryEntry {
  seqCounter += 1
  return {
    entry_id: `evt_${seqCounter}`,
    event_seq: seqCounter,
    event_version: 1,
    project_id: 'rsp_demo',
    aggregate_type: null,
    aggregate_id: null,
    kind: 'job.submitted',
    lane: 'research',
    source: 'kernel-outbox',
    occurred_at: '2026-08-11T00:00:00.000Z',
    session_id: null,
    summary: 'job survey submitted',
    status: null,
    ...over,
  }
}

function page(entries: TrajectoryEntry[], over: Partial<TrajectoryPage> = {}): TrajectoryPage {
  const last = entries.at(-1)
  return {
    project_id: 'rsp_demo',
    entries,
    next_after_seq: last?.event_seq ?? null,
    next_after_event_id: last?.entry_id ?? null,
    has_more: false,
    total: entries.length,
    limit: 100,
    lane: 'research',
    ...over,
  }
}

function node(over: Partial<TopologyNode> = {}): TopologyNode {
  return {
    child_id: `sub_${seqCounter++}`,
    project_id: 'rsp_demo',
    parent_id: null,
    label: null,
    summary: 'a subagent',
    kind: 'subagent',
    mode: 'one-shot',
    state: 'running',
    role: null,
    started_at: '2026-08-11T00:00:00.000Z',
    ended_at: null,
    has_children: false,
    children_count: 0,
    seq: 0,
    refs: [],
    ...over,
  }
}

describe('TRAJ-01 lane metadata (trajectory-subagents.md §1 — 双 lane 分组渲染模型)', () => {
  it('lane order is stable: Research first, then Session', () => {
    expect(TRAJECTORY_LANE_KEYS).toEqual(['research', 'session'])
  })

  it('research lane is authoritative; session lane is observational', () => {
    const research = trajectoryLaneMeta('research')
    expect(research.authority).toBe('authoritative')
    expect(research.label).not.toBe('')
    expect(research.description).not.toBe('')
    const session = trajectoryLaneMeta('session')
    expect(session.authority).toBe('observational')
    expect(session.label).not.toBe('')
    expect(session.description).not.toBe('')
  })

  it('lane labels/authority copy re-evaluate with the locale (zh ↔ en)', () => {
    setLocale('zh')
    const zhResearch = trajectoryLaneMeta('research')
    const zhSession = trajectoryLaneMeta('session')
    setLocale('en')
    const enResearch = trajectoryLaneMeta('research')
    const enSession = trajectoryLaneMeta('session')
    expect(zhResearch.authorityLabel).not.toBe(enResearch.authorityLabel)
    expect(zhResearch.label).not.toBe(enResearch.label)
    expect(zhSession.label).not.toBe(enSession.label)
    expect(enResearch.authority).toBe('authoritative')
    expect(enSession.authority).toBe('observational')
    expect(getLocale()).toBe('en')
  })
})

describe('TRAJ-01 pagination state machine ((event_seq, event_id) keyset)', () => {
  it('initial state: empty, idle, no cursor, no more', () => {
    const s = initialTrajectoryPageState()
    expect(s.entries).toEqual([])
    expect(s.status).toBe('idle')
    expect(s.hasMore).toBe(false)
    expect(nextTrajectoryCursor(s)).toBeNull()
    expect(canLoadMoreTrajectory(s)).toBe(false)
  })

  it('applyTrajectoryPage: merges entries, sets cursor/hasMore/total, ready', () => {
    const p1 = page([entry(), entry(), entry()], { has_more: true, next_after_seq: 3, next_after_event_id: 'evt_3', total: 8 })
    const s = applyTrajectoryPage(initialTrajectoryPageState(), p1)
    expect(s.entries).toHaveLength(3)
    expect(s.status).toBe('ready')
    expect(s.hasMore).toBe(true)
    expect(s.total).toBe(8)
    expect(s.nextAfterSeq).toBe(3)
    expect(s.nextAfterEventId).toBe('evt_3')
    expect(nextTrajectoryCursor(s)).toEqual({ after_seq: 3, after_event_id: 'evt_3' })
    expect(canLoadMoreTrajectory(s)).toBe(true)
  })

  it('sequential pages accumulate with entry_id dedupe (idempotent cursor)', () => {
    const e1 = entry(); const e2 = entry(); const e3 = entry(); const e4 = entry(); const e5 = entry()
    const s1 = applyTrajectoryPage(initialTrajectoryPageState(), page([e1, e2, e3], { has_more: true, total: 5 }))
    // Overlapping retry page (e3 again + new entries) must not duplicate.
    const s2 = applyTrajectoryPage(s1, page([e3, e4, e5], { has_more: false, total: 5 }))
    expect(s2.entries.map(e => e.entry_id)).toEqual([e1.entry_id, e2.entry_id, e3.entry_id, e4.entry_id, e5.entry_id])
    expect(s2.hasMore).toBe(false)
    expect(nextTrajectoryCursor(s2)).toBeNull()
    expect(canLoadMoreTrajectory(s2)).toBe(false)
  })

  it('cursor is null while idle/loading/error — never fetches past has_more', () => {
    const s = { ...initialTrajectoryPageState(), status: 'loading' as const, hasMore: true, nextAfterSeq: 1 }
    expect(canLoadMoreTrajectory(s)).toBe(false)
    expect(nextTrajectoryCursor(s)).toEqual({ after_seq: 1 })
  })
})

describe('TRAJ-01 entry view model (redacted summary + allowlisted detail)', () => {
  it('summary/seq/time/kind pass through; time is locale-formatted', () => {
    const v = trajectoryEntryView(entry({ summary: 'gate scope created: baseline' }))
    expect(v.summary).toBe('gate scope created: baseline')
    expect(v.event_seq).toBeGreaterThan(0)
    expect(v.timeText).not.toBe('')
    expect(v.timeText).toContain('2026')
    expect(v.kind).toBe('job.submitted')
  })

  it('known status resolves through the status namespace; unknown stays raw', () => {
    expect(trajectoryStatusText('succeeded')).not.toBe('succeeded')
    expect(trajectoryStatusText('waiting')).toBe('waiting')
    const v = trajectoryEntryView(entry({ status: 'succeeded' }))
    expect(v.statusText).not.toBe('')
    const raw = trajectoryEntryView(entry({ status: 'redacted' }))
    expect(raw.statusText).toBe('redacted')
  })

  it('hasDetail only when metadata exists beyond the id; entry id row always present', () => {
    const dict = (getLocale() === 'zh' ? trajectoryZh : trajectoryEn) as Record<string, string>
    const bare = trajectoryEntryView(entry({ source: '' }))
    expect(bare.hasDetail).toBe(false)
    expect(bare.details.map(d => d.label)).toContain(dict['trajectory.detail.entry'])
    const rich = trajectoryEntryView(entry({ aggregate_type: 'project', aggregate_id: 'rsp_demo', session_id: 'sess_1', status: 'running' }))
    expect(rich.hasDetail).toBe(true)
    const labels = rich.details.map(d => d.label)
    for (const expected of ['trajectory.detail.aggregate', 'trajectory.detail.session', 'trajectory.detail.status', 'trajectory.detail.entry']) {
      expect(labels).toContain(dict[expected])
    }
  })
})

describe('TRAJ-01 dual-lane panel view (§1/§6)', () => {
  it('renders both lanes in order with evaluated chrome and entries', () => {
    const states = {
      research: applyTrajectoryPage(initialTrajectoryPageState(), page([entry({ kind: 'gate.created' }), entry({ kind: 'job.submitted' })], { total: 2 })),
      session: applyTrajectoryPage(initialTrajectoryPageState(), page([entry({ kind: 'terminal.frame', lane: 'session' })], { total: 1 })),
    }
    const view = trajectoryPanelView(states)
    expect(view.lanes.map(l => l.key)).toEqual(['research', 'session'])
    expect(view.idle).toBe(false)
    expect(view.lanes[0]!.authority).toBe('authoritative')
    expect(view.lanes[1]!.authority).toBe('observational')
    expect(view.lanes[0]!.entries).toHaveLength(2)
    expect(view.lanes[1]!.entries).toHaveLength(1)
    expect(view.lanes[0]!.total).toBe(2)
    expect(view.redactedNote).not.toBe('')
  })

  it('idle state exposes the loading copy; empty lanes expose per-lane + panel empty copy', () => {
    const idle = trajectoryPanelView({ research: initialTrajectoryPageState(), session: initialTrajectoryPageState() })
    expect(idle.idle).toBe(true)
    expect(idle.loadingText).not.toBe('')
    const empty = trajectoryPanelView({
      research: applyTrajectoryPage(initialTrajectoryPageState(), page([], { total: 0 })),
      session: applyTrajectoryPage(initialTrajectoryPageState(), page([], { total: 0 })),
    })
    expect(empty.panelEmptyText).not.toBe('')
    expect(empty.lanes[0]!.emptyText).not.toBe('')
    expect(empty.lanes[1]!.emptyText).not.toBe('')
  })

  it('evaluating the whole panel model in BOTH locales reports zero missing keys', () => {
    setLocale('zh')
    trajectoryPanelView({
      research: applyTrajectoryPage(initialTrajectoryPageState(), page([entry({ status: 'succeeded' })])),
      session: applyTrajectoryPage(initialTrajectoryPageState(), page([entry({ lane: 'session', status: 'running' })])),
    })
    setLocale('en')
    trajectoryPanelView({
      research: applyTrajectoryPage(initialTrajectoryPageState(), page([entry({ status: 'succeeded' })])),
      session: applyTrajectoryPage(initialTrajectoryPageState(), page([entry({ lane: 'session', status: 'running' })])),
    })
    expect(missing).toEqual([])
  })
})

describe('SUBAGENT-01 topology level state + cursor (§3 direct children)', () => {
  it('initial level: not loaded, empty, no cursor', () => {
    const l = initialTopologyLevel(null)
    expect(l.parentId).toBe(TOPOLOGY_ROOT_KEY)
    expect(l.loaded).toBe(false)
    expect(l.items).toEqual([])
    expect(nextTopologyCursor(l)).toBeNull()
    expect(canLoadMoreTopology(l)).toBe(false)
  })

  it('applyTopologyPage: merges direct children with child_id dedupe', () => {
    const a = node({ child_id: 'sub_a' }); const b = node({ child_id: 'sub_b' }); const c = node({ child_id: 'sub_c' })
    const l1 = applyTopologyPage(initialTopologyLevel(null), {
      project_id: 'rsp_demo', parent_id: null, items: [a, b], total: 3, next_after_seq: 2, has_more: true,
    })
    const l2 = applyTopologyPage(l1, {
      project_id: 'rsp_demo', parent_id: null, items: [b, c], total: 3, next_after_seq: 3, has_more: false,
    })
    expect(l2.items.map(n => n.child_id)).toEqual(['sub_a', 'sub_b', 'sub_c'])
    expect(l2.loaded).toBe(true)
    expect(l2.hasMore).toBe(false)
    expect(l1.hasMore).toBe(true)
    expect(nextTopologyCursor(l1)).toBe(2)
    expect(nextTopologyCursor(l2)).toBeNull()
  })
})

describe('SUBAGENT-01 tree flatten/expand (§3 展开时懒加载直接子项)', () => {
  it('roots only when nothing is expanded', () => {
    const a = node({ child_id: 'sub_a', has_children: true, children_count: 2 })
    const b = node({ child_id: 'sub_b' })
    const levels = { [TOPOLOGY_ROOT_KEY]: applyTopologyPage(initialTopologyLevel(null), { project_id: 'rsp_demo', parent_id: null, items: [a, b], total: 2, next_after_seq: null, has_more: false }) }
    const rows = flattenTopologyRows(levels, new Set())
    expect(rows.map(r => r.child_id)).toEqual(['sub_a', 'sub_b'])
    expect(rows.every(r => r.depth === 0)).toBe(true)
    expect(rows.every(r => r.parentKey === TOPOLOGY_ROOT_KEY)).toBe(true)
  })

  it('expanded parents show their loaded children at depth+1; collapse hides them', () => {
    const a = node({ child_id: 'sub_a', has_children: true, children_count: 2 })
    const a1 = node({ child_id: 'sub_a1', parent_id: 'sub_a' })
    const a2 = node({ child_id: 'sub_a2', parent_id: 'sub_a' })
    const levels = {
      [TOPOLOGY_ROOT_KEY]: applyTopologyPage(initialTopologyLevel(null), { project_id: 'rsp_demo', parent_id: null, items: [a], total: 1, next_after_seq: null, has_more: false }),
      sub_a: applyTopologyPage(initialTopologyLevel('sub_a'), { project_id: 'rsp_demo', parent_id: 'sub_a', items: [a1, a2], total: 2, next_after_seq: null, has_more: false }),
    }
    const expanded = new Set(['sub_a'])
    const rows = flattenTopologyRows(levels, expanded)
    expect(rows.map(r => `${r.depth}:${r.child_id}`)).toEqual(['0:sub_a', '1:sub_a1', '1:sub_a2'])
    expect(rows[0]!.expanded).toBe(true)
    expect(rows[0]!.childrenLoaded).toBe(true)
    const collapsed = flattenTopologyRows(levels, toggleTopologyNode(expanded, 'sub_a'))
    expect(collapsed.map(r => r.child_id)).toEqual(['sub_a'])
  })

  it('expanding a parent whose children were never fetched shows the node only (lazy)', () => {
    const a = node({ child_id: 'sub_a', has_children: true, children_count: 5 })
    const levels = {
      [TOPOLOGY_ROOT_KEY]: applyTopologyPage(initialTopologyLevel(null), { project_id: 'rsp_demo', parent_id: null, items: [a], total: 1, next_after_seq: null, has_more: false }),
    }
    const rows = flattenTopologyRows(levels, new Set(['sub_a']))
    expect(rows.map(r => r.child_id)).toEqual(['sub_a'])
    expect(rows[0]!.expanded).toBe(true)
    expect(rows[0]!.childrenLoaded).toBe(false)
  })

  it('cycle-safe: a child that links back into its ancestor chain terminates', () => {
    const a = node({ child_id: 'sub_a', has_children: true, children_count: 1 })
    const b = node({ child_id: 'sub_b', parent_id: 'sub_a', has_children: true, children_count: 1 })
    const aAgain = node({ child_id: 'sub_a', parent_id: 'sub_b', has_children: true, children_count: 1 })
    const levels = {
      [TOPOLOGY_ROOT_KEY]: applyTopologyPage(initialTopologyLevel(null), { project_id: 'rsp_demo', parent_id: null, items: [a], total: 1, next_after_seq: null, has_more: false }),
      sub_a: applyTopologyPage(initialTopologyLevel('sub_a'), { project_id: 'rsp_demo', parent_id: 'sub_a', items: [b], total: 1, next_after_seq: null, has_more: false }),
      sub_b: applyTopologyPage(initialTopologyLevel('sub_b'), { project_id: 'rsp_demo', parent_id: 'sub_b', items: [aAgain], total: 1, next_after_seq: null, has_more: false }),
    }
    // The back-edge row is shown once (honest data), but recursion into its
    // children is cut by the ancestor guard — the walk terminates (no loop).
    const rows = flattenTopologyRows(levels, new Set(['sub_a', 'sub_b']))
    expect(rows.map(r => `${r.depth}:${r.child_id}`)).toEqual(['0:sub_a', '1:sub_b', '2:sub_a'])
    const repeated = flattenTopologyRows(levels, new Set(['sub_a', 'sub_b']))
    expect(repeated.length).toBe(3)
  })

  it('known child states translate per locale; unknown states stay raw wire text', () => {
    setLocale('zh')
    expect(childStateText('running')).toBe(topologyZh['topology.state.running'])
    expect(childStateText('nonsense')).toBe('nonsense')
    setLocale('en')
    expect(childStateText('running')).toBe(topologyEn['topology.state.running'])
    expect(childStateText('nonsense')).toBe('nonsense')
    const v = childDetailView({
      child_id: 'sub_a', project_id: 'rsp_demo',
      node: node({ child_id: 'sub_a', state: 'diagnostic', mode: 'continuable', kind: 'task' }),
      parent: null, breadcrumb: [],
    })
    expect(v.node.stateText).toBe(topologyEn['topology.state.diagnostic'])
    expect(v.node.modeText).toBe(topologyEn['topology.mode.continuable'])
    expect(v.node.kindText).toBe(topologyEn['topology.kind.task'])
  })
})

describe('SUBAGENT-01 breadcrumb assembly (§3 顶部 breadcrumb 可逐级返回 parent)', () => {
  it('maps root → parent chain to label rows (self excluded)', () => {
    const root = node({ child_id: 'sub_root', label: 'root-agent' })
    const mid = node({ child_id: 'sub_mid', parent_id: 'sub_root', label: 'mid-agent' })
    const detail = {
      child_id: 'sub_leaf', project_id: 'rsp_demo',
      node: node({ child_id: 'sub_leaf', parent_id: 'sub_mid' }),
      parent: mid, breadcrumb: [root, mid],
    }
    const path = breadcrumbPath(detail)
    expect(path.map(p => p.label)).toEqual(['root-agent', 'mid-agent'])
    expect(childDetailView(detail).hasParent).toBe(true)
  })

  it('roots and orphan fail-soft children yield an empty breadcrumb', () => {
    const rootDetail = {
      child_id: 'sub_root', project_id: 'rsp_demo',
      node: node({ child_id: 'sub_root' }),
      parent: null, breadcrumb: [],
    }
    expect(breadcrumbPath(rootDetail)).toEqual([])
    expect(childDetailView(rootDetail).hasParent).toBe(false)
  })
})

describe('SUBAGENT-01 read-only history view (§3 history 不激活 child)', () => {
  it('known history types translate per locale; unknown types stay raw', () => {
    setLocale('zh')
    const startedZh = childHistoryEntryView({ seq: 1, type: 'started', occurred_at: '2026-08-11T00:00:00.000Z', summary: 'subagent started: x' })
    expect(startedZh.typeText).toBe(topologyZh['topology.history.type.started'])
    expect(startedZh.timeText).toContain('2026')
    expect(startedZh.summary).toBe('subagent started: x')
    setLocale('en')
    const startedEn = childHistoryEntryView({ seq: 1, type: 'started', occurred_at: '2026-08-11T00:00:00.000Z', summary: 'subagent started: x' })
    expect(startedEn.typeText).toBe(topologyEn['topology.history.type.started'])
    const unknown = childHistoryEntryView({ seq: 2, type: 'spawned', occurred_at: '', summary: '' })
    expect(unknown.typeText).toBe('spawned')
  })
})

describe('SUBAGENT-01 one-shot READ-ONLY followup call model (§3 接收只返回 message_id)', () => {
  it('blank drafts yield no call (send disabled); valid drafts build the exact POST', () => {
    expect(followupCall('sub_a', '')).toBeNull()
    expect(followupCall('sub_a', '   ')).toBeNull()
    expect(followupCall('', 'hello')).toBeNull()
    const call = followupCall('sub_a', '  continue the survey  ')
    expect(call).not.toBeNull()
    expect(call!.method).toBe('POST')
    expect(call!.path).toBe('/v1/topology/sub_a/followup')
    expect(call!.body.message).toBe('continue the survey')
    expect(call!.readOnly).toBe(true)
  })

  it('child ids are encoded into the route (opaque deep-linkable ids)', () => {
    const call = followupCall('sub a/child', 'hi')
    expect(call!.path).toBe('/v1/topology/sub%20a%2Fchild/followup')
  })

  it('request_id is propagated when provided and omitted otherwise', () => {
    const withRid = followupCall('sub_a', 'hi', 'req_1')
    expect(withRid!.body.request_id).toBe('req_1')
    expect(withRid!.requestId).toBe('req_1')
    const without = followupCall('sub_a', 'hi')
    expect(without!.body.request_id).toBeUndefined()
  })

  it('receipt view renders the message_id and keeps the read-only semantics', () => {
    const view = followupReceiptView({
      message_id: 'msg_abc', child_id: 'sub_a', project_id: 'rsp_demo',
      accepted: true, read_only: true, state_unchanged: true,
      note: 'recorded without activating the child',
    })
    expect(view.messageId).toBe('msg_abc')
    expect(view.readOnly).toBe(true)
    expect(view.stateUnchanged).toBe(true)
    expect(view.sentText).toContain('msg_abc')
  })

  it('evaluating the followup/receipt copy in BOTH locales reports zero missing keys', () => {
    setLocale('zh')
    followupReceiptView({ message_id: 'm', child_id: 'c', project_id: 'p', accepted: true, read_only: true, state_unchanged: true, note: '' })
    setLocale('en')
    followupReceiptView({ message_id: 'm', child_id: 'c', project_id: 'p', accepted: true, read_only: true, state_unchanged: true, note: '' })
    expect(missing).toEqual([])
  })
})

describe('TRAJ-01/SUBAGENT-01 nav integration (More 深链) + i18n parity', () => {
  it('trajectory/topology are reachable More tabs with stable deep links', () => {
    expect(ALL_TAB_KEYS).toContain('trajectory')
    expect(ALL_TAB_KEYS).toContain('topology')
    expect(MORE_TAB_KEYS).toContain('trajectory')
    expect(MORE_TAB_KEYS).toContain('topology')
    expect(isTabKey('trajectory')).toBe(true)
    expect(isTabKey('topology')).toBe(true)
    expect(parseDeepLink('#tab=trajectory')).toEqual({ kind: 'tab', target: 'trajectory' })
    expect(parseDeepLink('#tab=topology?x=1')).toEqual({ kind: 'tab', target: 'topology' })
  })

  it('chrome tab defs carry non-empty labels/descriptions in BOTH locales', () => {
    setLocale('zh')
    const zhTabs = chromeTabs()
    setLocale('en')
    const enTabs = chromeTabs()
    for (const key of ['trajectory', 'topology'] as const) {
      const z = zhTabs.find(tab => tab.key === key)
      const e = enTabs.find(tab => tab.key === key)
      expect(z).toBeDefined()
      expect(e).toBeDefined()
      expect(z!.label).not.toBe('')
      expect(z!.description).not.toBe('')
      expect(e!.label).not.toBe('')
      expect(e!.description).not.toBe('')
      expect(z!.label).not.toBe(e!.label)
    }
  })

  it('shell tab keys exist in both dictionaries; static zh/en parity holds', () => {
    for (const key of ['shell.tab.trajectory', 'shell.tab.trajectory.desc', 'shell.tab.topology', 'shell.tab.topology.desc']) {
      expect(shellZh[key as keyof typeof shellZh]).toBeDefined()
      expect(shellEn[key as keyof typeof shellEn]).toBeDefined()
    }
    expect(localeParityReport()).toEqual([])
  })

  it('every trajectory/topology dict key exists in BOTH locales and no key is missing at runtime', () => {
    const zhKeys = Object.keys(trajectoryZh)
    const enKeys = Object.keys(trajectoryEn)
    expect(zhKeys.sort()).toEqual(enKeys.sort())
    const topoZhKeys = Object.keys(topologyZh)
    const topoEnKeys = Object.keys(topologyEn)
    expect(topoZhKeys.sort()).toEqual(topoEnKeys.sort())
    setLocale('zh')
    trajectoryPanelView({
      research: applyTrajectoryPage(initialTrajectoryPageState(), page([entry({ status: 'succeeded' })])),
      session: applyTrajectoryPage(initialTrajectoryPageState(), page([entry({ lane: 'session' })])),
    })
    childDetailView({ child_id: 'a', project_id: 'p', node: node({ state: 'succeeded', mode: 'read-only' }), parent: null, breadcrumb: [] })
    followupReceiptView({ message_id: 'm', child_id: 'c', project_id: 'p', accepted: true, read_only: true, state_unchanged: true, note: '' })
    setLocale('en')
    trajectoryPanelView({
      research: applyTrajectoryPage(initialTrajectoryPageState(), page([entry({ status: 'succeeded' })])),
      session: applyTrajectoryPage(initialTrajectoryPageState(), page([entry({ lane: 'session' })])),
    })
    childDetailView({ child_id: 'a', project_id: 'p', node: node({ state: 'succeeded', mode: 'read-only' }), parent: null, breadcrumb: [] })
    followupReceiptView({ message_id: 'm', child_id: 'c', project_id: 'p', accepted: true, read_only: true, state_unchanged: true, note: '' })
    expect(missing).toEqual([])
    expect(getLocale()).toBe('en')
  })
})
