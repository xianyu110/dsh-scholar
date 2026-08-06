/**
 * Per-role tool ACL (design §4.1 工具面原则, §1.3 Least privilege).
 * Every research tool declares its allowed roles; a `tools/pre-execute`
 * listener denies calls outside the caller's role. Scholar never executes,
 * Writer never writes evidence, Runner has no DSH credentials.
 * @module @dsh-scholar/research-plugin/acl
 */

export type ResearchRole =
  | 'director'
  | 'scholar'
  | 'curator'
  | 'idea-panel'
  | 'architect'
  | 'engineer'
  | 'operator'
  | 'statistician'
  | 'writer'
  | 'reviewer'
  | 'auditor'

export const RESEARCH_ROLES: readonly ResearchRole[] = [
  'director', 'scholar', 'curator', 'idea-panel', 'architect', 'engineer',
  'operator', 'statistician', 'writer', 'reviewer', 'auditor',
]

/** Research tool names (the plugin's own surface). */
export const RESEARCH_TOOLS = [
  'research_project',
  'research_phase',
  'research_gate',
  'research_budget',
  'research_status',
  'literature_search',
  'paper_resolve',
  'corpus_snapshot',
  'passage_lookup',
  'idea_create',
  'idea_compare',
  'novelty_audit',
  'experiment_register',
  'experiment_submit',
  'experiment_status',
  'experiment_cancel',
  'evidence_ingest',
  'claim_create',
  'claim_verify',
  'manuscript_build',
  'manuscript_review',
  'release_bundle',
] as const

/** Tool surface per role (design §4.1 table). */
export const ROLE_TOOLS: Record<ResearchRole, readonly string[]> = {
  director: ['research_project', 'research_phase', 'research_gate', 'research_budget', 'research_status', 'release_bundle'],
  scholar: ['literature_search', 'paper_resolve', 'corpus_snapshot', 'passage_lookup', 'research_status'],
  curator: ['literature_search', 'paper_resolve', 'corpus_snapshot', 'passage_lookup', 'research_status'],
  'idea-panel': ['idea_create', 'idea_compare', 'novelty_audit', 'literature_search', 'research_status'],
  architect: ['experiment_register', 'research_status', 'experiment_status'],
  engineer: ['research_status', 'experiment_status'],
  operator: ['experiment_submit', 'experiment_status', 'experiment_cancel', 'research_status'],
  statistician: ['evidence_ingest', 'claim_create', 'claim_verify', 'research_status', 'experiment_status'],
  writer: ['manuscript_build', 'research_status'],
  reviewer: ['manuscript_review', 'claim_verify', 'research_status'],
  auditor: ['claim_verify', 'manuscript_review', 'research_status'],
}

/** Default role for agents that never declared one. */
export const DEFAULT_ROLE: ResearchRole = 'director'

/** In-memory session → role registry (roles are set per session). */
export class RoleRegistry {
  private readonly roles = new Map<string, ResearchRole>()

  set(sessionId: string, role: ResearchRole): void {
    this.roles.set(sessionId, role)
  }

  get(sessionId: string | undefined): ResearchRole {
    if (sessionId === undefined) return DEFAULT_ROLE
    return this.roles.get(sessionId) ?? DEFAULT_ROLE
  }

  /** Whether the role may call the tool. */
  allows(role: ResearchRole, toolName: string): boolean {
    return ROLE_TOOLS[role].includes(toolName)
  }
}
