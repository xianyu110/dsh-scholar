/**
 * status namespace: status pill / sidebar / search-row labels for project
 * phases, gate decisions, job states and evidence claims. EN mirrors the
 * kernel's raw status enums verbatim (acceptance-tests.md §8 line 115 keeps
 * enum/wire text as-is); ZH translates the same keys. zh/en key sets must
 * stay exactly equal (localeParityReport / assertLocaleParity).
 */
export const zh = {
  // project phases
  'status.DRAFT': '草稿',
  'status.SCOPED': '已定范围',
  'status.SURVEYING': '调研中',
  'status.IDEATING': '构思中',
  'status.IDEA_APPROVED': '构思通过',
  'status.BASELINE_REPRO': '基线复现',
  'status.CONTRACT_APPROVED': '契约通过',
  'status.EXPERIMENTING': '实验中',
  'status.EVIDENCE_READY': '证据就绪',
  'status.WRITING': '撰写中',
  'status.REVIEWING': '评审中',
  'status.RELEASE_READY': '发布就绪',
  'status.RELEASED': '已发布',
  'status.BLOCKED_GATE': '门禁阻断',
  'status.ARCHIVED': '已归档',
  // gates
  'status.pending': '待审批',
  'status.approved': '已批准',
  'status.rejected': '已拒绝',
  // jobs
  'status.queued': '排队中',
  'status.running': '运行中',
  'status.succeeded': '已成功',
  'status.failed': '失败',
  'status.cancelled': '已取消',
  'status.retryable': '可重试',
  // claims
  'status.supported': '支持',
  'status.contradicted': '反驳',
  'status.inconclusive': '无定论',
  'status.unverified': '未验证',
  // generic
  'status.none': '—',
} as const

export type StatusKey = keyof typeof zh

export const en: Record<StatusKey, string> = {
  // project phases (raw kernel enum mirrors, kept verbatim)
  'status.DRAFT': 'DRAFT',
  'status.SCOPED': 'SCOPED',
  'status.SURVEYING': 'SURVEYING',
  'status.IDEATING': 'IDEATING',
  'status.IDEA_APPROVED': 'IDEA ✓',
  'status.BASELINE_REPRO': 'BASELINE',
  'status.CONTRACT_APPROVED': 'CONTRACT ✓',
  'status.EXPERIMENTING': 'EXPERIMENT',
  'status.EVIDENCE_READY': 'EVIDENCE',
  'status.WRITING': 'WRITING',
  'status.REVIEWING': 'REVIEW',
  'status.RELEASE_READY': 'RELEASE ✓',
  'status.RELEASED': 'RELEASED',
  'status.BLOCKED_GATE': 'BLOCKED',
  'status.ARCHIVED': 'ARCHIVED',
  // gates
  'status.pending': 'PENDING',
  'status.approved': 'APPROVED',
  'status.rejected': 'REJECTED',
  // jobs
  'status.queued': 'QUEUED',
  'status.running': 'RUNNING',
  'status.succeeded': 'SUCCEEDED',
  'status.failed': 'FAILED',
  'status.cancelled': 'CANCELLED',
  'status.retryable': 'RETRYABLE',
  // claims
  'status.supported': 'SUPPORTED',
  'status.contradicted': 'CONTRADICTED',
  'status.inconclusive': 'INCONCLUSIVE',
  'status.unverified': 'UNVERIFIED',
  // generic
  'status.none': '—',
}
