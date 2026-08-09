/**
 * Per-role tool ACL (design §4.1 工具面原则, §1.3 Least privilege).
 * Every research tool declares its allowed roles; a `tools/pre-execute`
 * listener denies calls outside the caller's role. Scholar never executes,
 * Writer never writes evidence, Runner has no DSH credentials.
 * @module @dsh-scholar/research-plugin/acl
 */

export type ResearchRole =
  | 'none'
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
  'none', 'director', 'scholar', 'curator', 'idea-panel', 'architect', 'engineer',
  'operator', 'statistician', 'writer', 'reviewer', 'auditor',
]

/**
 * §17 one-version deprecation aliases: old user-facing names resolve to their
 * canonical counterparts. They stay registered (never "unknown tool") and
 * stay ACL-enforced, but role surfaces are defined on canonical names only.
 */
export const TOOL_ALIASES = {
  claim_verify: 'claim_verify_request',
  analysis_build: 'analysis_request',
  release_bundle: 'release_bundle_request',
} as const

export type ResearchToolAlias = keyof typeof TOOL_ALIASES

/** Research tool names (the plugin's own surface): canonical + aliases. */
export const RESEARCH_TOOLS = [
  'research_project',
  'research_phase',
  'research_gate_request',
  'research_budget',
  'research_status',
  'research_panel',
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
  'evidence_note_create',
  'claim_create',
  'claim_verify_request',
  'analysis_request',
  'workspace_snapshot',
  'patch_apply',
  'baseline_prepare',
  'baseline_verify',
  'test_run',
  'manuscript_build',
  'manuscript_review',
  'release_bundle_request',
  // §17 deprecation aliases (still registered, still ACL-enforced).
  ...Object.keys(TOOL_ALIASES),
] as const

/**
 * Tool surface per role (design §4.1 table) — canonical names only; aliases
 * resolve through {@link TOOL_ALIASES} in `RoleRegistry.allows`.
 */
export const ROLE_TOOLS: Record<ResearchRole, readonly string[]> = {
  none: [],
  director: ['research_project', 'research_phase', 'research_gate_request', 'research_budget', 'research_status', 'research_panel', 'release_bundle_request'],
  scholar: ['literature_search', 'paper_resolve', 'corpus_snapshot', 'passage_lookup', 'research_status'],
  curator: ['literature_search', 'paper_resolve', 'corpus_snapshot', 'passage_lookup', 'research_status'],
  'idea-panel': ['idea_create', 'idea_compare', 'novelty_audit', 'literature_search', 'research_status'],
  architect: ['experiment_register', 'research_status', 'experiment_status'],
  engineer: ['workspace_snapshot', 'patch_apply', 'baseline_prepare', 'baseline_verify', 'test_run', 'research_status', 'experiment_status'],
  operator: ['experiment_submit', 'experiment_status', 'experiment_cancel', 'research_status'],
  statistician: ['evidence_note_create', 'claim_create', 'claim_verify_request', 'analysis_request', 'research_status', 'experiment_status'],
  writer: ['manuscript_build', 'research_status'],
  reviewer: ['manuscript_review', 'claim_verify_request', 'research_status'],
  auditor: ['claim_verify_request', 'manuscript_review', 'research_status'],
}

/** v2 §3.1: unknown/unregistered agents default to `none` (deny), NOT director. */
export const DEFAULT_ROLE: ResearchRole = 'none'

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

  /** Whether the role may call the tool (deprecation aliases resolve to their canonical name). */
  allows(role: ResearchRole, toolName: string): boolean {
    const canonical = TOOL_ALIASES[toolName as ResearchToolAlias] ?? toolName
    return ROLE_TOOLS[role].includes(canonical)
  }
}
