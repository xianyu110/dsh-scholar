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

export interface ScholarSessionProjection {
  linked: boolean
  session_id: string
  project?: ScholarProjectSummary
  stages: ScholarStage[]
  next_action?: ScholarNextAction
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

export function buildScholarSessionProjection(sessionId: string, projection?: ProjectionLike | null): ScholarSessionProjection {
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
  return {
    linked: true,
    session_id: sessionId,
    project,
    stages: stagesForProject(project.status, nextAction, projection.pending_gates ?? []),
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
