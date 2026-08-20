export type ScholarStageId =
  | 'init'
  | 'survey'
  | 'idea'
  | 'reproduce'
  | 'contract'
  | 'experiment'
  | 'evidence'
  | 'writing'
  | 'review'
  | 'release'

export type ScholarStageState = 'done' | 'current' | 'upcoming' | 'blocked'

export interface ScholarStage {
  id: ScholarStageId
  state: ScholarStageState
}

export interface ScholarNextAction {
  code: string
  label: string
  reason: string
  route: string
  state: 'ready' | 'blocked' | 'done'
  blocking: boolean
  required_by: 'human' | 'agent' | 'runner'
  required: true | string[]
  revision: number | null
}

export interface ScholarProjectSummary {
  project_id: string
  name: string
  status: string
  revision: number
  brief_status?: string
}

export type ScholarMethodologyBlock =
  | 'assurance'
  | 'protocol'
  | 'synthesis'
  | 'knowledge'
  | 'writing'
  | 'manuscript'
  | 'runs'
  | 'topology'
  | 'next_recommendation'

/** Redacted methodology summary carried by the DSH conversation panel.
 *
 * This deliberately mirrors only the compact Kernel projection. Frozen
 * Protocol content, review text, package payloads and Assurance inputs stay
 * behind the project API and never enter the Host browser RPC state.
 */
export interface ScholarMethodologySummary {
  project_id: string
  revision: number
  assurance: { level: 'draft' | 'submission'; ready: boolean; reason_codes: string[] } | null
  protocol: {
    current_id: string
    revision: number
    status: 'draft' | 'frozen'
    intent: 'exploratory' | 'confirmatory'
  } | null
  synthesis: { current_id: string; fresh: boolean; stale_reasons: string[] } | null
  knowledge: {
    active_count: number
    package_names: string[]
    suppressed_count: number
    status: 'delivery-ready' | 'suppressed' | 'inactive'
  }
  writing: { outline_id: string; blocking_count: number; stale: boolean | null; reason_codes: string[] } | null
  manuscript: {
    revision: number
    method_triad: { triad_id: string; status: 'ready' | 'diagnostic_gap'; gap_codes: string[] } | null
    section_guide: {
      activation_id: string
      section: string
      state: 'active' | 'diagnostic_gap'
      missing_inputs: string[]
    } | null
    reviewer_panel: {
      aggregate_id: string
      state: 'complete' | 'partial' | 'missing'
      complete_roles: string[]
      missing_roles: string[]
    } | null
    patches: {
      proposal_count: number
      application_count: number
      latest_proposal_id: string | null
      latest_application_id: string | null
    }
  }
  runs: {
    revision: number
    count: number
    negative_finding_count: number
    claim_proposal_count: number
    latest_run_ref: string | null
  }
  topology: {
    assurance_audit_count: number
    latest_audit_id: string | null
    research_node_count: number
    research_edge_count: number
  }
  next_recommendation: { code: string; label_key: string } | null
  /** Known optional blocks discarded by the local runtime normalizer because
   * their supplied value was malformed. Missing/null legacy blocks are safe
   * defaults and are not reported unavailable. */
  unavailable_blocks?: ScholarMethodologyBlock[]
}

const METHODOLOGY_RECOMMENDATION_LABELS: Readonly<Record<string, string>> = {
  configure_protocol: 'methodology.next.configureProtocol',
  run_synthesis: 'methodology.next.runSynthesis',
  activate_knowledge: 'methodology.next.activateKnowledge',
  review_writing: 'methodology.next.reviewWriting',
  run_assurance: 'methodology.next.runAssurance',
  direction_gate_review: 'methodology.next.directionGateReview',
  direction_deepen_continue: 'methodology.next.directionDeepenContinue',
  direction_broaden_intake: 'methodology.next.directionBroadenIntake',
  direction_pivot_intake: 'methodology.next.directionPivotIntake',
  direction_conclude_prepare: 'methodology.next.directionConcludePrepare',
  direction_pause_review: 'methodology.next.directionPauseReview',
  direction_overlay_stale: 'methodology.next.directionOverlayStale',
  direction_overlay_invalid: 'methodology.next.directionOverlayInvalid',
}

export interface ScholarSessionProjection {
  linked: boolean
  session_id: string
  project?: ScholarProjectSummary
  stages: ScholarStage[]
  next_action?: ScholarNextAction
  methodology?: ScholarMethodologySummary
  summary: {
    pending_gates: number
    jobs: { total: number; queued: number; running: number; succeeded: number; failed: number }
    counts: Record<string, number>
  }
}

/** Narrow Host view for one DSH conversation.
 *
 * The full Scholar workbench deliberately does not cross this boundary. An
 * unlinked conversation receives only the operator's project summaries so it
 * can choose or create its authoritative project; a linked conversation
 * receives only its stage projection.
 */
export interface ScholarSessionWorkspace {
  session_id: string
  projection: ScholarSessionProjection
  available_projects: ScholarProjectSummary[]
}

export interface ProjectionLike {
  project: {
    project_id: string
    name: string
    status: string
    revision: number
    brief_status?: string
  }
  pending_gates?: Array<{ type?: string }>
  jobs?: Array<{ status?: string }>
  counts?: Record<string, number>
  next_actions_v2?: ScholarNextAction[]
}

export const SCHOLAR_STAGE_IDS: readonly ScholarStageId[] = [
  'init', 'survey', 'idea', 'reproduce', 'contract', 'experiment', 'evidence', 'writing', 'review', 'release',
]

/**
 * DSH session ids cross an Agent boundary and are later used as one HTTP path
 * segment. Keep the accepted alphabet deliberately smaller than a URL: this
 * rejects traversal/delimiter/control characters before any Kernel lookup.
 */
export const DSH_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/

export function normalizeDshSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (normalized !== value) return undefined
  return DSH_SESSION_ID_PATTERN.test(normalized) ? normalized : undefined
}

const STATUS_STAGE: Record<string, ScholarStageId> = {
  DRAFT: 'init',
  SCOPED: 'survey',
  SURVEYING: 'idea',
  IDEATING: 'idea',
  IDEA_APPROVED: 'reproduce',
  BASELINE_REPRO: 'reproduce',
  CONTRACT_APPROVED: 'experiment',
  EXPERIMENTING: 'experiment',
  EVIDENCE_READY: 'writing',
  WRITING: 'writing',
  REVIEWING: 'review',
  RELEASE_READY: 'release',
  ARCHIVED: 'release',
  RELEASED: 'release',
  FAILED: 'release',
  STOPPED: 'release',
}

const ACTION_STAGE: Record<string, ScholarStageId> = {
  intake_resume: 'init', intake_scan: 'init', intake_answer: 'init', intake_propose: 'init', intake_adopt: 'init',
  scope_gate_submit: 'init', survey_run: 'survey', idea_generate: 'idea', idea_select: 'idea', idea_gate_approve: 'idea',
  baseline_reproduce: 'reproduce', contract_register: 'contract', pilot_formal_submit: 'experiment',
  evidence_verify: 'evidence', manuscript_write: 'writing', reviewer_run: 'review',
  release_bundle: 'release', release_gate: 'release', gate_resolve: 'init', gate_decide: 'init', budget_resolve: 'init',
}

const GATE_STAGE: Record<string, ScholarStageId> = {
  scope: 'init',
  idea: 'idea',
  contract: 'contract',
  evidence: 'evidence',
  release: 'release',
  budget: 'experiment',
}

export function stagesForProject(
  status: string,
  nextAction?: Pick<ScholarNextAction, 'code' | 'state'>,
  pendingGates: Array<{ type?: string }> = [],
): ScholarStage[] {
  const blockedGateStage = pendingGates
    .map(gate => gate.type === undefined ? undefined : GATE_STAGE[gate.type])
    .filter((stage): stage is ScholarStageId => stage !== undefined)
    .sort((left, right) => SCHOLAR_STAGE_IDS.indexOf(right) - SCHOLAR_STAGE_IDS.indexOf(left))[0]
  const stageId = status === 'BLOCKED_GATE'
    ? (blockedGateStage ?? (nextAction === undefined ? 'init' : ACTION_STAGE[nextAction.code] ?? 'init'))
    : STATUS_STAGE[status] ?? (nextAction === undefined ? 'init' : ACTION_STAGE[nextAction.code] ?? 'init')
  const current = SCHOLAR_STAGE_IDS.indexOf(stageId)
  const terminal = status === 'ARCHIVED' || status === 'RELEASED' || status === 'STOPPED'
  return SCHOLAR_STAGE_IDS.map((id, index) => ({
    id,
    state: terminal || index < current ? 'done' : index > current ? 'upcoming' : status === 'BLOCKED_GATE' ? 'blocked' : 'current',
  }))
}

function jobCount(jobs: Array<{ status?: string }>, status: string): number {
  return jobs.filter(job => job.status === status).length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

const EMPTY_KNOWLEDGE: ScholarMethodologySummary['knowledge'] = {
  active_count: 0, package_names: [], suppressed_count: 0, status: 'inactive',
}
const EMPTY_MANUSCRIPT: ScholarMethodologySummary['manuscript'] = {
  revision: 0,
  method_triad: null,
  section_guide: null,
  reviewer_panel: null,
  patches: { proposal_count: 0, application_count: 0, latest_proposal_id: null, latest_application_id: null },
}
const EMPTY_RUNS: ScholarMethodologySummary['runs'] = {
  revision: 0, count: 0, negative_finding_count: 0, claim_proposal_count: 0, latest_run_ref: null,
}
const EMPTY_TOPOLOGY: ScholarMethodologySummary['topology'] = {
  assurance_audit_count: 0, latest_audit_id: null, research_node_count: 0, research_edge_count: 0,
}
const METHODOLOGY_BLOCKS = new Set<ScholarMethodologyBlock>([
  'assurance', 'protocol', 'synthesis', 'knowledge', 'writing', 'manuscript', 'runs', 'topology', 'next_recommendation',
])

/**
 * Tolerant compact-wire seam shared by the Host producer and browser consumer.
 *
 * Identity and the methodology stream revision fail closed. Optional known
 * blocks are independently decoded; malformed blocks become safe defaults and
 * are named in `unavailable_blocks`. Unknown/additive properties are never
 * copied, which also keeps token/secret/payload/content data out of the Host
 * projection without coupling upgrades to a frozen list of harmless fields.
 */
export function normalizeScholarMethodology(
  value: unknown,
  expectedProjectId: string,
): ScholarMethodologySummary {
  if (!isRecord(value) || value.project_id !== expectedProjectId) {
    throw new Error('Scholar methodology projection does not belong to the linked project')
  }
  if (!isNonnegativeInteger(value.revision)) {
    throw new Error('Scholar methodology projection has an invalid revision')
  }

  const unavailable = new Set<ScholarMethodologyBlock>()
  if (Array.isArray(value.unavailable_blocks)) {
    for (const block of value.unavailable_blocks) {
      if (typeof block === 'string' && METHODOLOGY_BLOCKS.has(block as ScholarMethodologyBlock)) {
        unavailable.add(block as ScholarMethodologyBlock)
      }
    }
  }
  const optional = <T>(
    block: ScholarMethodologyBlock,
    parse: (candidate: Record<string, unknown>) => T | undefined,
    fallback: T,
  ): T => {
    const candidate = value[block]
    if (candidate === undefined || candidate === null) return fallback
    if (!isRecord(candidate)) {
      unavailable.add(block)
      return fallback
    }
    const parsed = parse(candidate)
    if (parsed === undefined) unavailable.add(block)
    return parsed ?? fallback
  }

  const assurance = optional<ScholarMethodologySummary['assurance']>('assurance', candidate => {
    if ((candidate.level !== 'draft' && candidate.level !== 'submission')
      || typeof candidate.ready !== 'boolean' || !isStringArray(candidate.reason_codes)) return undefined
    return { level: candidate.level, ready: candidate.ready, reason_codes: [...candidate.reason_codes] }
  }, null as ScholarMethodologySummary['assurance'])

  const protocol = optional<ScholarMethodologySummary['protocol']>('protocol', candidate => {
    if (typeof candidate.current_id !== 'string' || !isNonnegativeInteger(candidate.revision)
      || (candidate.status !== 'draft' && candidate.status !== 'frozen')
      || (candidate.intent !== 'exploratory' && candidate.intent !== 'confirmatory')) return undefined
    return {
      current_id: candidate.current_id,
      revision: candidate.revision,
      status: candidate.status,
      intent: candidate.intent,
    }
  }, null as ScholarMethodologySummary['protocol'])

  const synthesis = optional<ScholarMethodologySummary['synthesis']>('synthesis', candidate => {
    if (typeof candidate.current_id !== 'string' || typeof candidate.fresh !== 'boolean'
      || !isStringArray(candidate.stale_reasons)) return undefined
    return { current_id: candidate.current_id, fresh: candidate.fresh, stale_reasons: [...candidate.stale_reasons] }
  }, null as ScholarMethodologySummary['synthesis'])

  const knowledge = optional<ScholarMethodologySummary['knowledge']>('knowledge', candidate => {
    if (!isNonnegativeInteger(candidate.active_count) || !isStringArray(candidate.package_names)
      || !isNonnegativeInteger(candidate.suppressed_count)
      || (candidate.status !== 'delivery-ready' && candidate.status !== 'suppressed' && candidate.status !== 'inactive')) {
      return undefined
    }
    return {
      active_count: candidate.active_count,
      package_names: [...candidate.package_names],
      suppressed_count: candidate.suppressed_count,
      status: candidate.status,
    }
  }, EMPTY_KNOWLEDGE)

  const writing = optional<ScholarMethodologySummary['writing']>('writing', candidate => {
    if (typeof candidate.outline_id !== 'string' || !isNonnegativeInteger(candidate.blocking_count)
      || (candidate.stale !== null && typeof candidate.stale !== 'boolean')
      || !isStringArray(candidate.reason_codes)) return undefined
    return {
      outline_id: candidate.outline_id,
      blocking_count: candidate.blocking_count,
      stale: candidate.stale as boolean | null,
      reason_codes: [...candidate.reason_codes],
    }
  }, null as ScholarMethodologySummary['writing'])

  const manuscript = optional<ScholarMethodologySummary['manuscript']>('manuscript', candidate => {
    if (!isNonnegativeInteger(candidate.revision) || !isRecord(candidate.patches)) return undefined
    const triad = candidate.method_triad
    const guide = candidate.section_guide
    const panel = candidate.reviewer_panel
    const patches = candidate.patches
    if (triad !== null && (!isRecord(triad) || typeof triad.triad_id !== 'string'
      || (triad.status !== 'ready' && triad.status !== 'diagnostic_gap') || !isStringArray(triad.gap_codes))) return undefined
    if (guide !== null && (!isRecord(guide) || typeof guide.activation_id !== 'string'
      || typeof guide.section !== 'string' || (guide.state !== 'active' && guide.state !== 'diagnostic_gap')
      || !isStringArray(guide.missing_inputs))) return undefined
    if (panel !== null && (!isRecord(panel) || typeof panel.aggregate_id !== 'string'
      || (panel.state !== 'complete' && panel.state !== 'partial' && panel.state !== 'missing')
      || !isStringArray(panel.complete_roles) || !isStringArray(panel.missing_roles))) return undefined
    if (!isNonnegativeInteger(patches.proposal_count) || !isNonnegativeInteger(patches.application_count)
      || (patches.latest_proposal_id !== null && typeof patches.latest_proposal_id !== 'string')
      || (patches.latest_application_id !== null && typeof patches.latest_application_id !== 'string')) return undefined
    return {
      revision: candidate.revision,
      method_triad: triad === null ? null : {
        triad_id: triad.triad_id as string,
        status: triad.status as 'ready' | 'diagnostic_gap',
        gap_codes: [...(triad.gap_codes as string[])],
      },
      section_guide: guide === null ? null : {
        activation_id: guide.activation_id as string,
        section: guide.section as string,
        state: guide.state as 'active' | 'diagnostic_gap',
        missing_inputs: [...(guide.missing_inputs as string[])],
      },
      reviewer_panel: panel === null ? null : {
        aggregate_id: panel.aggregate_id as string,
        state: panel.state as 'complete' | 'partial' | 'missing',
        complete_roles: [...(panel.complete_roles as string[])],
        missing_roles: [...(panel.missing_roles as string[])],
      },
      patches: {
        proposal_count: patches.proposal_count,
        application_count: patches.application_count,
        latest_proposal_id: patches.latest_proposal_id as string | null,
        latest_application_id: patches.latest_application_id as string | null,
      },
    }
  }, EMPTY_MANUSCRIPT)

  const runs = optional<ScholarMethodologySummary['runs']>('runs', candidate => {
    if (!isNonnegativeInteger(candidate.revision) || !isNonnegativeInteger(candidate.count)
      || !isNonnegativeInteger(candidate.negative_finding_count) || !isNonnegativeInteger(candidate.claim_proposal_count)
      || (candidate.latest_run_ref !== null && typeof candidate.latest_run_ref !== 'string')) return undefined
    return {
      revision: candidate.revision,
      count: candidate.count,
      negative_finding_count: candidate.negative_finding_count,
      claim_proposal_count: candidate.claim_proposal_count,
      latest_run_ref: candidate.latest_run_ref as string | null,
    }
  }, EMPTY_RUNS)

  const topology = optional<ScholarMethodologySummary['topology']>('topology', candidate => {
    if (!isNonnegativeInteger(candidate.assurance_audit_count)
      || (candidate.latest_audit_id !== null && typeof candidate.latest_audit_id !== 'string')
      || !isNonnegativeInteger(candidate.research_node_count) || !isNonnegativeInteger(candidate.research_edge_count)) return undefined
    return {
      assurance_audit_count: candidate.assurance_audit_count,
      latest_audit_id: candidate.latest_audit_id as string | null,
      research_node_count: candidate.research_node_count,
      research_edge_count: candidate.research_edge_count,
    }
  }, EMPTY_TOPOLOGY)

  const nextRecommendation = optional<ScholarMethodologySummary['next_recommendation']>('next_recommendation', candidate => {
    if (typeof candidate.code !== 'string' || typeof candidate.label_key !== 'string') return undefined
    if (METHODOLOGY_RECOMMENDATION_LABELS[candidate.code] !== candidate.label_key) return undefined
    return { code: candidate.code, label_key: candidate.label_key }
  }, null as ScholarMethodologySummary['next_recommendation'])

  return {
    project_id: expectedProjectId,
    revision: value.revision,
    assurance,
    protocol,
    synthesis,
    knowledge,
    writing,
    manuscript,
    runs,
    topology,
    next_recommendation: nextRecommendation,
    ...(unavailable.size === 0 ? {} : { unavailable_blocks: [...unavailable] }),
  }
}

export function buildScholarSessionProjection(
  sessionId: string,
  projection?: ProjectionLike | null,
  methodology?: unknown,
): ScholarSessionProjection {
  if (projection === undefined || projection === null) {
    return {
      linked: false,
      session_id: sessionId,
      stages: stagesForProject('DRAFT'),
      summary: { pending_gates: 0, jobs: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0 }, counts: {} },
    }
  }
  const jobs = projection.jobs ?? []
  const nextAction = projection.next_actions_v2?.find(action => action.state !== 'done') ?? projection.next_actions_v2?.[0]
  const project: ScholarProjectSummary = {
    project_id: projection.project.project_id,
    name: projection.project.name,
    status: projection.project.status,
    revision: projection.project.revision,
    ...(projection.project.brief_status === undefined ? {} : { brief_status: projection.project.brief_status }),
  }
  const normalizedMethodology = methodology === undefined || methodology === null
    ? undefined
    : normalizeScholarMethodology(methodology, project.project_id)
  return {
    linked: true,
    session_id: sessionId,
    project,
    stages: stagesForProject(project.status, nextAction, projection.pending_gates ?? []),
    ...(normalizedMethodology === undefined ? {} : { methodology: normalizedMethodology }),
    ...(nextAction === undefined ? {} : { next_action: {
      code: nextAction.code,
      label: nextAction.label,
      reason: nextAction.reason,
      route: nextAction.route,
      state: nextAction.state,
      blocking: nextAction.blocking,
      required_by: nextAction.required_by,
      required: nextAction.required,
      revision: nextAction.revision,
    } }),
    summary: {
      pending_gates: projection.pending_gates?.length ?? 0,
      jobs: {
        total: jobs.length,
        queued: jobCount(jobs, 'queued') + jobCount(jobs, 'pending'),
        running: jobCount(jobs, 'running') + jobCount(jobs, 'leased'),
        succeeded: jobCount(jobs, 'succeeded'),
        failed: jobCount(jobs, 'failed'),
      },
      counts: { ...(projection.counts ?? {}) },
    },
  }
}
