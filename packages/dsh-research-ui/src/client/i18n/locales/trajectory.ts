/**
 * trajectory namespace (docs/trajectory-subagents.md §6): chrome copy for
 * the Trajectory panel — Research/Session lane headers, authority badges,
 * pagination, empty/error states and the redaction footnote. The kernel's
 * redacted summaries and enum wire values stay verbatim (§8 line 115);
 * EVERY label/tooltip/aria/empty state here must have a zh/en key
 * (localeParityReport / assertLocaleParity). zh/en key sets must stay
 * exactly equal.
 */
export const zh = {
  'trajectory.lane.research': '研究轨迹',
  'trajectory.lane.research.desc': '来自 Kernel Outbox 的权威业务轨迹:Gate、Job、Run、Artifact、Evidence、Manuscript 与 Release。',
  'trajectory.lane.session': '会话轨迹',
  'trajectory.lane.session.desc': '来自 session/subagent 的观察性活动,仅用于观察与导航,不是科研事实。',
  'trajectory.authoritative': '权威',
  'trajectory.observational': '观察',
  'trajectory.empty': '该项目的轨迹为空 — 尚未产生任何事件。',
  'trajectory.lane.empty': '此泳道暂无事件。',
  'trajectory.loading': '正在加载轨迹…',
  'trajectory.error': '轨迹加载失败(桥接错误)。',
  'trajectory.loadMore': '加载更多',
  'trajectory.loadingMore': '加载中…',
  'trajectory.total': '共 {count} 条',
  'trajectory.expandDetail': '展开详情',
  'trajectory.collapseDetail': '收起详情',
  'trajectory.entry.aria': '轨迹条目 {seq} · {summary}',
  'trajectory.detail.aggregate': '聚合',
  'trajectory.detail.source': '来源',
  'trajectory.detail.session': '会话',
  'trajectory.detail.status': '状态',
  'trajectory.detail.entry': '条目 ID',
  'trajectory.detail.time': '时间',
  'trajectory.redactedNote': '摘要与详情已由内核脱敏:原始负载、令牌、密钥与绝对路径不会离开内核。',
} as const

export type TrajectoryKey = keyof typeof zh

export const en: Record<TrajectoryKey, string> = {
  'trajectory.lane.research': 'Research trajectory',
  'trajectory.lane.research.desc': 'Authoritative business trajectory from the Kernel Outbox: gates, jobs, runs, artifacts, evidence, manuscript and release.',
  'trajectory.lane.session': 'Session trajectory',
  'trajectory.lane.session.desc': 'Observational session/subagent activity for navigation only — never research facts.',
  'trajectory.authoritative': 'authoritative',
  'trajectory.observational': 'observational',
  'trajectory.empty': 'The project trajectory is empty — no events have been produced yet.',
  'trajectory.lane.empty': 'No events in this lane yet.',
  'trajectory.loading': 'Loading trajectory…',
  'trajectory.error': 'Failed to load the trajectory (bridge error).',
  'trajectory.loadMore': 'Load more',
  'trajectory.loadingMore': 'Loading…',
  'trajectory.total': '{count} total',
  'trajectory.expandDetail': 'expand details',
  'trajectory.collapseDetail': 'collapse details',
  'trajectory.entry.aria': 'trajectory entry {seq} · {summary}',
  'trajectory.detail.aggregate': 'Aggregate',
  'trajectory.detail.source': 'Source',
  'trajectory.detail.session': 'Session',
  'trajectory.detail.status': 'Status',
  'trajectory.detail.entry': 'Entry ID',
  'trajectory.detail.time': 'Time',
  'trajectory.redactedNote': 'Summaries and details are redacted by the kernel: raw payloads, tokens, secrets and absolute paths never leave it.',
}
