/**
 * evidence namespace (gui-plugin-plan §13.1): Evidence tab + claim/evidence
 * detail modals + budget constraints modal. Statements, provenance values
 * and wire content stay raw.
 */
export const zh = {
  'evidence.filterPlaceholder': '🔍 过滤主张与证据…',
  'evidence.claims': '主张 ({count})',
  'evidence.claims.empty': '暂无主张。',
  'evidence.claims.noMatch': '没有匹配 "{query}" 的主张。',
  'evidence.claimDetails': '主张详情',
  'evidence.evidence': '证据 ({count})',
  'evidence.evidence.empty': '暂无已验证证据——只有 Analysis Worker 可以创建它。',
  'evidence.evidence.noMatch': '没有匹配 "{query}" 的证据。',
  'evidence.evidenceDetails': '证据详情',
  'evidence.claim.title': '主张',
  'evidence.claim.supporting': '支持证据',
  'evidence.claim.limitations': '局限',
  'evidence.claim.history': '验证历史',
  'evidence.detail.result': '结果',
  'evidence.detail.provenance': '来源',
  'evidence.budget.usage': '使用',
  'evidence.budget.constraints': '约束',
  'evidence.budget.execution': '执行',
  'evidence.budget.integrity': '完整性',
}

export const en: Record<keyof typeof zh, string> = {
  'evidence.filterPlaceholder': '🔍 Filter claims & evidence…',
  'evidence.claims': 'Claims ({count})',
  'evidence.claims.empty': 'No claims yet.',
  'evidence.claims.noMatch': 'No claims match "{query}".',
  'evidence.claimDetails': 'claim details',
  'evidence.evidence': 'Evidence ({count})',
  'evidence.evidence.empty': 'No verified evidence yet — only the Analysis Worker can create it.',
  'evidence.evidence.noMatch': 'No evidence matches "{query}".',
  'evidence.evidenceDetails': 'evidence details',
  'evidence.claim.title': 'Claim',
  'evidence.claim.supporting': 'Supporting evidence',
  'evidence.claim.limitations': 'Limitations',
  'evidence.claim.history': 'Verification history',
  'evidence.detail.result': 'Result',
  'evidence.detail.provenance': 'Provenance',
  'evidence.budget.usage': 'Usage',
  'evidence.budget.constraints': 'Constraints',
  'evidence.budget.execution': 'Execution',
  'evidence.budget.integrity': 'Integrity',
}
