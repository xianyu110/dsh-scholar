/**
 * GUIDE-01 — authoritative structured NextAction projection (design §4.2
 * Projection API, domain-model.md §14, api-contracts.md §21).
 *
 * `nextActionProjection` is a PURE function of the project's authoritative
 * state: it never reads the database, never throws, and deterministically
 * derives one action set per (status, gates, jobs, budget, contracts,
 * ideas, evidence, claims). The Kernel calls it from `projectProjection`
 * and also derives the legacy `next_actions: string[]` from the structured
 * labels so old UI/API consumers keep working (GUIDE-01 "legacy unknown
 * 安全退化"): unknown/future statuses degrade to `code: 'unknown'` with a
 * read-only label, never a mutation CTA.
 *
 * Projection rules:
 * - one base action per project status (the phase's primary next step);
 * - one overlay action per pending gate NOT already referenced by a base
 *   action (budget gates → `budget_resolve`, others → `gate_decide`);
 * - one overlay action per failed/retryable job (`job_retry`, with
 *   attempts-exhausted → blocked + `repair_decision` requirement);
 * - `state` semantics: ready = do now, blocked = preconditions missing
 *   (listed in `required`), done = step already satisfied;
 * - `revision` pins the dependency object revision (project revision for
 *   gate decisions, contract version for run actions, idea version for the
 *   idea gate);
 * - `blocking` marks actions that gate phase completion (pending human
 *   gates, budget exhaustion, phase steps); retry/stop overlays are not
 *   blocking.
 *
 * Intake/Grill overlay actions (ONBOARD-01 landing, 2026-08-11): when the
 * project has an active intake session the projection also emits
 * `intake_resume` (any active status) plus one step overlay per session
 * status (`intake_scan` / `intake_answer` / `intake_propose` /
 * `intake_adopt`), so the UI can guide the human through begin→stage→
 * scan→grill→propose→adopt on every step (see intake-flow.ts client model).
 * @module @dsh-scholar/research-kernel/next-action
 */

import type {
  BudgetRecord,
  Claim,
  CorpusSnapshot,
  EvidenceItem,
  ExperimentContract,
  Gate,
  IdeaCard,
  NextAction,
  NextActionRef,
  ResearchProject,
} from '@dsh-scholar/research-schemas'
import { NEXT_ACTION_UNKNOWN_CODE } from '@dsh-scholar/research-schemas'

/** Minimal durable-job view the projection needs (subset of JobRecord). */
export interface NextActionJob {
  job_id: string
  kind: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'retryable'
  failure_class: string | null
  attempts: number
  max_attempts: number
  contract_id: string | null
  created_at: string
}

/** Intake statuses in which an intake is still recoverable/continuable
 *  (mirrors research-schemas INTAKE_ACTIVE_STATUSES; the projection never
 *  guides a terminal session). */
export const INTAKE_ACTIVE_STATUSES: readonly string[] = [
  'draft', 'uploading', 'scanning', 'needs_input', 'grilling',
  'proposal_ready', 'awaiting_human',
]

/** Minimal durable intake view the projection needs (subset of IntakeSession
 *  + per-session artifact count; the kernel feeds it from listIntakes). */
export interface NextActionIntake {
  intake_id: string
  status: string
  target_phase: string | null
  artifact_count: number
}

/** Authoritative state inputs the projection derives actions from. */
export interface NextActionContext {
  project: ResearchProject
  /** Pending human gates only (decided gates carry no next step). */
  gates: Gate[]
  jobs: NextActionJob[]
  budget: BudgetRecord
  contracts: ExperimentContract[]
  ideas: IdeaCard[]
  evidence: EvidenceItem[]
  claims: Claim[]
  corpus_snapshots: CorpusSnapshot[]
  /** Active intake sessions of the project (ONBOARD-01 overlay; absent when
   *  the caller has no intake view — legacy callers stay compatible). */
  intakes?: NextActionIntake[]
}

/** UI tab / operation path an action maps to. */
export type NextActionRoute = 'gates' | 'runs' | 'evidence' | 'manuscript' | 'budget' | 'ideas' | 'contracts' | 'release' | 'overview'

interface BaseActionSpec {
  code: string
  label: string
  reason: string
  route: NextActionRoute
  state: 'ready' | 'blocked' | 'done'
  required: true | string[]
  required_by: 'human' | 'agent' | 'runner'
  capability?: string
  revision: number | null
  refs: NextActionRef[]
  /** Defaults to `state !== 'done'`; sub-step overlays opt out. */
  blocking?: boolean
}

/** Stable per-instance action id: code + project id (+ ref id for overlays). */
function actionId(projectId: string, code: string, refId?: string): string {
  return refId === undefined ? `${code}:${projectId}` : `${code}:${projectId}:${refId}`
}

function action(projectId: string, spec: BaseActionSpec): NextAction {
  return {
    id: actionId(projectId, spec.code),
    code: spec.code,
    label: spec.label,
    reason: spec.reason,
    required: spec.required,
    route: spec.route,
    capability: spec.capability,
    revision: spec.revision,
    state: spec.state,
    blocking: spec.blocking ?? spec.state !== 'done',
    refs: spec.refs,
    required_by: spec.required_by,
  }
}

/** Highest version among `items`, or null when there are none. */
function latestVersion(contracts: ExperimentContract[]): number | null {
  if (contracts.length === 0) return null
  return contracts.reduce((max, c) => Math.max(max, c.version), 0)
}

/** Highest-version approved contract, or null when none is approved. */
function approvedContract(contracts: ExperimentContract[]): ExperimentContract | null {
  let best: ExperimentContract | null = null
  for (const c of contracts) {
    if (c.status === 'approved' && (best === null || c.version > best.version)) best = c
  }
  return best
}

function succeededJob(jobs: NextActionJob[], kinds: readonly string[]): boolean {
  return jobs.some(j => kinds.includes(j.kind) && j.status === 'succeeded')
}

/** Base per-status action(s) — the phase's primary next step (GUIDE-01). */
function baseActions(ctx: NextActionContext): BaseActionSpec[] {
  const { project, contracts, jobs, ideas, evidence, gates } = ctx
  const contract = approvedContract(contracts)
  const contractVersion = contract?.version ?? latestVersion(contracts)
  const proposedIdea = ideas.find(i => i.status === 'proposed')
  const approvedIdea = ideas.find(i => i.status === 'approved')
  const ideaVersion = approvedIdea?.version ?? proposedIdea?.version ?? null
  const ideaRefs: NextActionRef[] = approvedIdea === undefined ? [] : [{ kind: 'idea', id: approvedIdea.idea_id }]
  const contractRefs: NextActionRef[] = contract === null ? [] : [{ kind: 'contract', id: contract.contract_id }]
  const pendingGateOf = (type: Gate['type']): Gate | undefined => gates.find(g => g.type === type)

  switch (project.status) {
    case 'DRAFT': {
      const scopeGate = pendingGateOf('scope')
      return [{
        code: 'scope_gate_submit',
        label: 'Complete Scope Gate',
        reason: scopeGate !== undefined
          ? `scope gate ${scopeGate.gate_id} is pending — approving it moves the project into SCOPED`
          : 'approve the Scope Gate to move the project into SCOPED',
        route: 'gates',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: scopeGate === undefined ? [] : [{ kind: 'gate', id: scopeGate.gate_id }],
      }]
    }
    case 'SCOPED':
      return [{
        code: 'survey_run',
        label: 'Run literature survey → corpus snapshot',
        reason: 'a corpus snapshot is required before idea generation can start',
        route: 'runs',
        state: 'ready',
        required: true,
        required_by: 'agent',
        revision: project.revision,
        refs: [],
      }]
    case 'SURVEYING':
      return [{
        code: 'idea_generate',
        label: 'Generate idea cards + novelty audit',
        reason: 'the survey corpus is ready — produce candidate ideas with novelty audits',
        route: 'ideas',
        state: 'ready',
        required: true,
        required_by: 'agent',
        revision: project.revision,
        refs: [],
      }]
    case 'IDEATING': {
      const ideaGate = pendingGateOf('idea')
      return [{
        code: 'idea_gate_approve',
        label: 'Approve an Idea at the Idea Gate',
        reason: ideaGate !== undefined
          ? `idea gate ${ideaGate.gate_id} is pending — approving it freezes the winning idea`
          : 'an Idea must be approved at the Idea Gate before the baseline phase',
        route: 'gates',
        state: proposedIdea === undefined && ideaGate === undefined ? 'blocked' : 'ready',
        required: proposedIdea === undefined && ideaGate === undefined ? ['proposed_idea'] : true,
        required_by: 'human',
        revision: ideaGate !== undefined ? project.revision : ideaVersion,
        refs: ideaGate !== undefined ? [{ kind: 'gate', id: ideaGate.gate_id }, ...ideaRefs] : ideaRefs,
      }]
    }
    case 'IDEA_APPROVED':
      return [{
        code: 'baseline_reproduce',
        label: 'Reproduce baseline in isolated runner',
        reason: 'the approved idea needs a reproducible baseline before the experiment contract can bind to it',
        route: 'runs',
        state: succeededJob(jobs, ['baseline']) ? 'done' : (contract !== null ? 'ready' : 'blocked'),
        required: contract !== null ? true : ['approved_contract'],
        required_by: 'agent',
        capability: 'researcher',
        revision: contractVersion,
        refs: [...contractRefs, ...ideaRefs],
      }]
    case 'BASELINE_REPRO': {
      const baselineDone = succeededJob(jobs, ['baseline'])
      return [
        {
          code: 'contract_register',
          label: 'Register and approve Experiment Contract',
          reason: 'secure baseline/pilot/formal jobs must bind an approved, gate-frozen contract',
          route: 'contracts',
          state: contract !== null ? 'done' : 'ready',
          required: true,
          required_by: 'human',
          capability: 'researcher',
          revision: contractVersion,
          refs: contractRefs,
        },
        {
          code: 'baseline_reproduce',
          label: 'Reproduce baseline in isolated runner',
          reason: contract !== null
            ? 'run the baseline reproduction bound to the approved contract'
            : 'cannot run the baseline until the Experiment Contract is approved',
          route: 'runs',
          state: baselineDone ? 'done' : (contract !== null ? 'ready' : 'blocked'),
          required: contract !== null ? true : ['approved_contract'],
          required_by: 'agent',
          capability: 'researcher',
          revision: contractVersion,
          refs: contractRefs,
        },
      ]
    }
    case 'CONTRACT_APPROVED':
      return [{
        code: 'pilot_formal_submit',
        label: 'Submit pilot + formal runs per contract',
        reason: 'the approved contract is frozen — submit pilot and formal runs bound to it',
        route: 'runs',
        state: succeededJob(jobs, ['pilot', 'formal']) ? 'done' : 'ready',
        required: true,
        required_by: 'agent',
        capability: 'researcher',
        revision: contractVersion,
        refs: contractRefs,
      }]
    case 'EXPERIMENTING': {
      const runsDone = succeededJob(jobs, ['pilot', 'formal'])
      const evidenceAccepted = evidence.some(e => e.status === 'accepted')
      return [
        {
          code: 'pilot_formal_submit',
          label: 'Submit pilot + formal runs per contract',
          reason: 'keep submitting pilot/formal runs until the contract stop conditions are met',
          route: 'runs',
          state: runsDone ? 'done' : (contract !== null ? 'ready' : 'blocked'),
          required: contract !== null ? true : ['approved_contract'],
          required_by: 'agent',
          capability: 'researcher',
          revision: contractVersion,
          refs: contractRefs,
        },
        {
          code: 'evidence_verify',
          label: 'Build evidence + verify claims',
          reason: 'accepted evidence from succeeded runs is required before the manuscript phase',
          route: 'evidence',
          state: evidenceAccepted ? 'done' : (runsDone ? 'ready' : 'blocked'),
          required: runsDone ? true : ['succeeded_runs'],
          required_by: 'agent',
          capability: 'researcher',
          revision: contractVersion,
          refs: contractRefs,
        },
      ]
    }
    case 'EVIDENCE_READY':
      return [{
        code: 'manuscript_write',
        label: 'Write manuscript from read-only ledger',
        reason: 'evidence and claims are frozen — write the manuscript from the read-only ledger',
        route: 'manuscript',
        state: 'ready',
        required: true,
        required_by: 'agent',
        capability: 'researcher',
        revision: project.revision,
        refs: evidence.filter(e => e.status === 'accepted').map(e => ({ kind: 'evidence', id: e.evidence_id }) as NextActionRef).slice(0, 16),
      }]
    case 'WRITING':
      return [{
        code: 'reviewer_run',
        label: 'Run reviewer panel + reproducibility audit',
        reason: 'the manuscript draft needs an independent reviewer panel and reproducibility audit before release review',
        route: 'runs',
        state: 'ready',
        required: true,
        required_by: 'agent',
        capability: 'researcher',
        revision: project.revision,
        refs: [],
      }]
    case 'REVIEWING':
      return [
        {
          code: 'release_bundle',
          label: 'Finalize release bundle',
          reason: 'the review passed — assemble the self-contained release bundle from the private ledger',
          route: 'release',
          state: 'ready',
          required: true,
          required_by: 'agent',
          capability: 'researcher',
          revision: project.revision,
          refs: [],
        },
        {
          code: 'release_gate',
          label: 'Release Gate stays human — submit for final approval',
          reason: 'public release is gated by a human Release Gate decision',
          route: 'gates',
          state: 'ready',
          required: true,
          required_by: 'human',
          revision: project.revision,
          refs: [],
        },
      ]
    case 'RELEASE_READY': {
      const releaseGate = pendingGateOf('release')
      return [{
        code: 'release_gate',
        label: 'Release Gate stays human — submit for final approval',
        reason: releaseGate !== undefined
          ? `release gate ${releaseGate.gate_id} is pending — the human decision publishes the project`
          : 'a human Release Gate decision is required to publish',
        route: 'gates',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: releaseGate === undefined ? [] : [{ kind: 'gate', id: releaseGate.gate_id }],
      }]
    }
    case 'BLOCKED_GATE':
      return [{
        code: 'gate_resolve',
        label: 'Resolve pending gate or budget decision',
        reason: 'project progress is blocked on a pending human gate or budget decision',
        route: 'gates',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: gates.map(g => ({ kind: 'gate', id: g.gate_id })),
      }]
    case 'FAILED':
      return [{
        code: 'project_stop',
        label: 'Project FAILED — review failure and stop',
        reason: 'a FAILED project has no forward transitions; review the failure evidence and stop the project',
        route: 'overview',
        state: 'ready',
        required: true,
        required_by: 'human',
        capability: 'pi',
        revision: project.revision,
        refs: [],
        blocking: false,
      }]
    case 'ARCHIVED':
      return [{
        code: 'project_archived',
        label: 'Project archived — no pending actions',
        reason: 'the project is archived; no further actions are available',
        route: 'overview',
        state: 'done',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: [],
      }]
    case 'RELEASED':
      return [{
        code: 'project_released',
        label: 'Project released — no pending actions',
        reason: 'the project was published through the Release Gate; no further actions are available',
        route: 'overview',
        state: 'done',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: [],
      }]
    case 'STOPPED':
      return [{
        code: 'project_stopped',
        label: 'Project stopped — no pending actions',
        reason: 'the project is stopped; no further actions are available',
        route: 'overview',
        state: 'done',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: [],
      }]
    default:
      // GUIDE-01 legacy unknown 安全退化: future/unknown statuses degrade to
      // a read-only 'unknown' action — never throw, never a mutation CTA.
      return [{
        code: NEXT_ACTION_UNKNOWN_CODE,
        label: 'Unknown project state — inspect project',
        reason: `status '${project.status}' has no NextAction mapping; treat the project as read-only until the kernel maps this state`,
        route: 'overview',
        state: 'blocked',
        required: ['state_mapping'],
        required_by: 'human',
        revision: project.revision,
        refs: [],
      }]
  }
}

/**
 * Pending-gate overlay (GUIDE-01): budget gates ALWAYS produce a
 * `budget_resolve` action (they carry the blocked/headroom semantics);
 * other pending gates produce `gate_decide` UNLESS a base action already
 * references that exact gate (so e.g. DRAFT does not emit both
 * `scope_gate_submit` and `gate_decide` for the same scope gate).
 */
function gateOverlay(ctx: NextActionContext): BaseActionSpec[] {
  const { project, gates, budget } = ctx
  const baseRefs = new Set(baseActions(ctx).flatMap(a => a.refs.map(r => `${r.kind}:${r.id}`)))
  const maxCost = project.constraints.max_model_cost_usd
  const maxGpu = project.constraints.max_gpu_hours
  const overBudget = budget.model_cost_usd > maxCost || budget.gpu_hours > maxGpu
  const actions: BaseActionSpec[] = []
  for (const gate of gates) {
    if (gate.type === 'budget') {
      actions.push({
        code: 'budget_resolve',
        label: 'Resolve Budget Gate / budget headroom',
        reason: overBudget
          ? `budget limits exceeded ($${budget.model_cost_usd.toFixed(2)} / $${maxCost} max, ${budget.gpu_hours} / ${maxGpu} GPU-h) — the project is blocked until the Budget Gate is decided or headroom is increased`
          : `budget gate ${gate.gate_id} is pending a human decision`,
        route: 'budget',
        state: overBudget ? 'blocked' : 'ready',
        required: overBudget ? ['budget_headroom'] : true,
        required_by: 'human',
        revision: project.revision,
        refs: [{ kind: 'gate', id: gate.gate_id }, ...(overBudget ? [{ kind: 'budget', id: project.project_id }] : [])],
      })
    } else if (!baseRefs.has(`gate:${gate.gate_id}`)) {
      actions.push({
        code: 'gate_decide',
        label: `Decide pending ${gate.type} gate`,
        reason: `gate ${gate.gate_id} (${gate.type}) is pending a human decision`,
        route: 'gates',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: [{ kind: 'gate', id: gate.gate_id }],
      })
    }
  }
  return actions
}

/**
 * Failed/retryable job overlay (GUIDE-01): a retry/repair action per failed
 * job. Attempts exhausted → blocked with `repair_decision` (a PI must
 * repair or cancel the job). Not phase-blocking itself.
 */
function jobOverlay(ctx: NextActionContext): BaseActionSpec[] {
  const { project, jobs } = ctx
  const actions: BaseActionSpec[] = []
  for (const job of jobs) {
    if (job.status !== 'failed' && job.status !== 'retryable') continue
    const exhausted = job.attempts >= job.max_attempts
    const failure = job.failure_class === null || job.failure_class === '' ? 'unknown' : job.failure_class
    actions.push({
      code: 'job_retry',
      label: exhausted ? 'Repair failed job (attempts exhausted)' : 'Retry failed job',
      reason: `job ${job.job_id} [${job.kind}] ${job.status} (${failure})${exhausted ? ` after ${job.attempts} attempts — a PI must repair or cancel it` : ` — retry (${job.attempts}/${job.max_attempts} attempts)`}`,
      route: 'runs',
      state: exhausted ? 'blocked' : 'ready',
      required: exhausted ? ['repair_decision'] : true,
      required_by: 'agent',
      capability: exhausted ? 'pi' : 'researcher',
      revision: null,
      refs: [{ kind: 'job', id: job.job_id }],
      blocking: false,
    })
  }
  return actions
}

/**
 * Active-intake overlay (ONBOARD-01 landing, 2026-08-11): one `intake_resume`
 * action per active intake session plus the session-status step overlay —
 * `intake_scan` once artifacts are staged, `intake_answer` while questions
 * are open, `intake_propose` when the required answers are in, and
 * `intake_adopt` (PI capability) once the proposal awaits the human. All are
 * non-blocking overlays (like job_retry): the phase's own base action stays
 * authoritative; terminal intakes (accepted/rejected/expired/failed) emit
 * nothing.
 */
function intakeOverlay(ctx: NextActionContext): BaseActionSpec[] {
  const { project, intakes } = ctx
  const actions: BaseActionSpec[] = []
  for (const intake of intakes ?? []) {
    if (!INTAKE_ACTIVE_STATUSES.includes(intake.status)) continue
    const refs: NextActionRef[] = [
      { kind: 'intake', id: intake.intake_id },
      { kind: 'project', id: project.project_id },
    ]
    const target = intake.target_phase === null || intake.target_phase === '' ? '' : ` (${intake.target_phase})`
    actions.push({
      code: 'intake_resume',
      label: `Resume intake ${intake.intake_id}${target}`,
      reason: `intake ${intake.intake_id} is ${intake.status} — continue uploading, scanning, answering or adopting it`,
      route: 'overview',
      state: 'ready',
      required: true,
      required_by: 'human',
      revision: null,
      refs,
      blocking: false,
    })
    if (intake.status === 'uploading' && intake.artifact_count > 0) {
      actions.push({
        code: 'intake_scan',
        label: 'Scan staged intake files',
        reason: `${intake.artifact_count} staged file(s) are waiting for the static security scan`,
        route: 'overview',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: null,
        refs,
        blocking: false,
      })
    }
    if (intake.status === 'needs_input' || intake.status === 'grilling') {
      actions.push({
        code: 'intake_answer',
        label: 'Answer intake Grill questions',
        reason: 'the intake scan is done — required Grill questions still need human answers',
        route: 'overview',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: null,
        refs,
        blocking: false,
      })
    }
    if (intake.status === 'proposal_ready') {
      actions.push({
        code: 'intake_propose',
        label: 'Generate intake phase proposal',
        reason: 'all required Grill questions are answered — generate the phase proposal for human review',
        route: 'overview',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: null,
        refs,
        blocking: false,
      })
    }
    if (intake.status === 'awaiting_human') {
      actions.push({
        code: 'intake_adopt',
        label: 'Adopt intake proposal (PI)',
        reason: `the intake proposal awaits a Human PI decision — adopting imports the material into the project`,
        route: 'overview',
        state: 'ready',
        required: true,
        required_by: 'human',
        capability: 'pi',
        revision: null,
        refs,
        blocking: false,
      })
    }
  }
  return actions
}

/**
 * GUIDE-01 authoritative projection: deterministic structured actions for
 * the current project state. Pure — no DB, no side effects, never throws.
 * Unknown/future statuses degrade to `code: 'unknown'` (read-only).
 */
export function nextActionProjection(ctx: NextActionContext): NextAction[] {
  const base = baseActions(ctx)
  const overlays = [...gateOverlay(ctx), ...jobOverlay(ctx), ...intakeOverlay(ctx)]
  return [...base, ...overlays].map(spec => action(ctx.project.project_id, spec))
}

/**
 * Legacy `next_actions: string[]` derivation (GUIDE-01): the labels of all
 * non-`done` actions in projection order. Stable and derived from the
 * structured actions — never a separate hand-maintained list. A status with
 * no pending work (terminal states) yields `[]`, which UI renders as "no
 * pending actions".
 */
export function legacyNextActionStrings(actions: NextAction[]): string[] {
  return actions.filter(a => a.state !== 'done').map(a => a.label)
}
