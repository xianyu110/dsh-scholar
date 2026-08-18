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

/** Minimal reproduction view the projection needs (subset of
 *  PaperReproductionSpec + attempt/report counts; fed by the kernel's
 *  reproductionProjectionFor). Absent for legacy callers — the projection
 *  then keeps the pre-reproduction baseline_reproduce semantics. */
export interface NextActionReproduction {
  spec_id: string
  status: string
  revision: number
  attempt_count: number
  report_count: number
  /** 'pass' | 'fail' | 'blocked' | 'inconclusive' | null (no report yet). */
  latest_report_status: string | null
  has_running_attempt: boolean
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
  /** Immutable code snapshots currently available to execution setup. */
  code_snapshots?: Array<{ snapshot_id: string }>
  /** Project default profile+target currently resolve to an enabled target. */
  runner_environment_ready?: boolean
  /** Active intake sessions of the project (ONBOARD-01 overlay; absent when
   *  the caller has no intake view — legacy callers stay compatible). */
  intakes?: NextActionIntake[]
  /** Paper reproduction specs (REPRO-01 overlay; absent for legacy
   *  callers — baseline_reproduce then keeps its job-based semantics). */
  reproductions?: NextActionReproduction[]
}

/** UI tab / operation path an action maps to. */
export type NextActionRoute = 'chat' | 'gates' | 'runs' | 'evidence' | 'manuscript' | 'budget' | 'ideas' | 'contracts' | 'release' | 'overview'

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

/** REPRO-01: a persisted reproduction report in status=pass exists. */
function reproductionPassed(ctx: NextActionContext): boolean {
  return (ctx.reproductions ?? []).some(r => r.latest_report_status === 'pass')
}

/** REPRO-01: the project has reproduction specs (overlay context present). */
function hasReproduction(ctx: NextActionContext): boolean {
  return (ctx.reproductions ?? []).length > 0
}

/** Base per-status action(s) — the phase's primary next step (GUIDE-01). */
function baseActions(ctx: NextActionContext): BaseActionSpec[] {
  const { project, contracts, jobs, ideas, evidence, gates } = ctx
  const contract = approvedContract(contracts)
  const contractVersion = contract?.version ?? latestVersion(contracts)
  const proposedIdea = ideas.find(i => i.status === 'proposed')
  const proposedIdeaRefs: NextActionRef[] = ideas
    .filter(i => i.status === 'proposed')
    .map(i => ({ kind: 'idea', id: i.idea_id }))
  const approvedIdea = ideas.find(i => i.status === 'approved')
  const ideaVersion = approvedIdea?.version ?? proposedIdea?.version ?? null
  const ideaRefs: NextActionRef[] = approvedIdea === undefined ? [] : [{ kind: 'idea', id: approvedIdea.idea_id }]
  const contractRefs: NextActionRef[] = contract === null ? [] : [{ kind: 'contract', id: contract.contract_id }]
  const latestContract = contracts.length === 0 ? undefined : contracts[contracts.length - 1]
  const latestContractRefs: NextActionRef[] = latestContract === undefined ? [] : [{ kind: 'contract', id: latestContract.contract_id }]
  const pendingGateOf = (type: Gate['type']): Gate | undefined => gates.find(g => g.type === type)

  switch (project.status) {
    case 'DRAFT': {
      // INIT-GRILL-02: a name-only shell has no Scope Gate yet. Its active
      // Init Intake overlays below are the only authoritative next actions.
      if (project.brief_status === 'collecting') return []
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
        // Survey is a connector/Corpus action initiated through the
        // project-scoped Chat slash command, not a Runner Job.
        route: 'chat',
        state: 'ready',
        required: true,
        required_by: 'agent',
        revision: project.revision,
        refs: [],
      }]
    case 'SURVEYING':
      return proposedIdeaRefs.length === 0 ? [{
        code: 'idea_generate',
        label: 'Generate idea cards',
        reason: 'the survey corpus is ready — produce candidate ideas',
        route: 'ideas',
        state: 'ready',
        required: true,
        required_by: 'agent',
        revision: project.revision,
        refs: [],
      }] : [{
        code: 'idea_select',
        label: 'Select an idea → novelty audit + Idea Gate',
        reason: `${proposedIdeaRefs.length} proposed idea(s) are ready — a human must select one for counter-search before the Idea Gate`,
        route: 'ideas',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: proposedIdeaRefs,
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
        state: ideaGate === undefined ? 'blocked' : 'ready',
        required: ideaGate === undefined ? ['pending_idea_gate'] : true,
        required_by: 'human',
        revision: ideaGate !== undefined ? project.revision : ideaVersion,
        refs: ideaGate !== undefined ? [{ kind: 'gate', id: ideaGate.gate_id }, ...ideaRefs] : ideaRefs,
      }]
    }
    case 'IDEA_APPROVED':
      return [{
        code: 'contract_register',
        label: 'Draft Experiment Contract from the approved idea',
        reason: 'freeze the experiment design through a Human Contract Gate before any contract-bound baseline run',
        route: 'contracts',
        state: approvedIdea === undefined ? 'blocked' : 'ready',
        required: approvedIdea === undefined ? ['approved_idea'] : true,
        required_by: 'agent',
        capability: 'researcher',
        revision: ideaVersion,
        refs: ideaRefs,
      }]
    case 'CONTRACT_PENDING': {
      const contractGate = pendingGateOf('contract')
      return contractGate === undefined ? [{
        code: 'contract_register',
        label: 'Revise and resubmit Experiment Contract',
        reason: 'the previous Contract Gate is no longer pending — create a revised contract draft for human review',
        route: 'contracts',
        state: approvedIdea === undefined ? 'blocked' : 'ready',
        required: approvedIdea === undefined ? ['approved_idea'] : true,
        required_by: 'agent',
        capability: 'researcher',
        revision: ideaVersion,
        refs: [...ideaRefs, ...latestContractRefs],
      }] : [{
        code: 'contract_gate_approve',
        label: 'Review the Experiment Contract at the Contract Gate',
        reason: `contract gate ${contractGate.gate_id} is pending — approve or reject the bound draft`,
        route: 'gates',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: project.revision,
        refs: [{ kind: 'gate', id: contractGate.gate_id }, ...latestContractRefs],
      }]
    }
    case 'CONTRACT_APPROVED':
      {
        const baselineGaps: string[] = []
        // `baseline_run` is scientific prose/identity, never executable argv.
        // No command is persisted before the atomic startBaselineRun handoff.
        baselineGaps.push('baseline_command')
        if ((contract?.code_snapshot === undefined || contract.code_snapshot.trim() === '') && (ctx.code_snapshots?.length ?? 0) === 0) {
          baselineGaps.push('code_snapshot')
        }
        if (ctx.runner_environment_ready === false) baselineGaps.push('runner_environment')
        const snapshotRefs: NextActionRef[] = (ctx.code_snapshots ?? []).slice(0, 1).map(snapshot => ({
          kind: 'code_snapshot',
          id: snapshot.snapshot_id,
        }))
      return [{
        code: 'baseline_reproduce',
        label: 'Reproduce baseline in isolated runner',
        reason: baselineGaps.length === 0
          ? 'the approved contract and execution inputs are ready — start its baseline in the configured isolated environment'
          : 'the contract is approved; prepare the missing execution inputs before starting a real baseline job',
        route: 'runs',
        state: 'ready',
        required: baselineGaps.length === 0 ? true : baselineGaps,
        required_by: 'agent',
        capability: 'researcher',
        revision: contractVersion,
        refs: [...contractRefs, ...snapshotRefs],
      }]
      }
    case 'BASELINE_REPRO': {
      const baselineDone = reproductionPassed(ctx) || (!hasReproduction(ctx) && succeededJob(jobs, ['baseline']))
      return [
        {
          code: 'baseline_reproduce',
          label: 'Reproduce baseline in isolated runner',
          reason: baselineDone
            ? 'the contract-bound baseline completed successfully'
            : 'run the approved contract baseline before pilot and formal experiments',
          route: 'runs',
          state: baselineDone ? 'done' : 'ready',
          required: true,
          required_by: 'agent',
          capability: 'researcher',
          revision: contractVersion,
          refs: contractRefs,
        },
        {
          code: 'pilot_formal_submit',
          label: 'Submit pilot + formal runs per contract',
          reason: baselineDone
            ? 'the baseline passed — submit pilot and formal runs bound to the frozen contract'
            : 'pilot and formal runs wait for a successful baseline reproduction',
          route: 'runs',
          state: baselineDone ? (succeededJob(jobs, ['pilot', 'formal']) ? 'done' : 'ready') : 'blocked',
          required: baselineDone ? true : ['baseline_reproduction'],
          required_by: 'agent',
          capability: 'researcher',
          revision: contractVersion,
          refs: contractRefs,
        },
      ]
    }
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
 * REPRO-01 overlay (docs/reproduction-contracts.md §5): per-spec guidance
 * through the reproduction wizard — reproduction_plan_confirm (draft spec,
 * human), reproduction_run (confirmed spec, no attempt yet), 
 * reproduction_compare (attempt in flight/executed, no persisted report),
 * reproduction_report_review (a report exists, not pass), and
 * reproduction_retry_or_repair (fail/inconclusive report → ready; blocked
 * report → blocked with the concrete missing environment gap). A passing
 * report emits NOTHING here — the base baseline_reproduce action turns
 * `done` (contract §3: only a persisted report in status=pass does). All
 * overlays are non-blocking like job_retry/intake overlays.
 */
function reproductionOverlay(ctx: NextActionContext): BaseActionSpec[] {
  const { project } = ctx
  const actions: BaseActionSpec[] = []
  for (const repro of ctx.reproductions ?? []) {
    const refs: NextActionRef[] = [
      { kind: 'reproduction_spec', id: repro.spec_id },
      { kind: 'project', id: project.project_id },
    ]
    if (repro.status === 'draft') {
      actions.push({
        code: 'reproduction_plan_confirm',
        label: `Confirm reproduction plan ${repro.spec_id}`,
        reason: `reproduction spec ${repro.spec_id} is draft — a Human confirms the plan/contract before any attempt starts`,
        route: 'runs',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: repro.revision,
        refs,
        blocking: false,
      })
      continue
    }
    if (repro.status === 'confirmed' && repro.attempt_count === 0 && repro.latest_report_status === null) {
      actions.push({
        code: 'reproduction_run',
        label: `Run reproduction ${repro.spec_id}`,
        reason: `reproduction spec ${repro.spec_id} is confirmed — execute the attempt on the bound runner/target`,
        route: 'runs',
        state: 'ready',
        required: true,
        required_by: 'agent',
        revision: repro.revision,
        refs,
        blocking: false,
      })
      continue
    }
    if (repro.has_running_attempt && repro.report_count === 0) {
      actions.push({
        code: 'reproduction_compare',
        label: `Compare + report reproduction ${repro.spec_id}`,
        reason: `an attempt of reproduction spec ${repro.spec_id} is running — compare paper targets and the clean-room vs formal run, then persist the report`,
        route: 'runs',
        state: 'ready',
        required: true,
        required_by: 'agent',
        revision: repro.revision,
        refs,
        blocking: false,
      })
      continue
    }
    if (repro.latest_report_status === 'fail' || repro.latest_report_status === 'inconclusive') {
      actions.push({
        code: 'reproduction_retry_or_repair',
        label: `Repair or retry reproduction ${repro.spec_id}`,
        reason: `reproduction spec ${repro.spec_id} has a persisted report in status '${repro.latest_report_status}' — out-of-tolerance is a scientific result, not code_error; repair inputs or start a new attempt`,
        route: 'runs',
        state: 'ready',
        required: true,
        required_by: 'agent',
        revision: repro.revision,
        refs,
        blocking: false,
      })
      continue
    }
    if (repro.latest_report_status === 'blocked') {
      actions.push({
        code: 'reproduction_retry_or_repair',
        label: `Unblock reproduction ${repro.spec_id}`,
        reason: `reproduction spec ${repro.spec_id} is blocked (e.g. a clean-room cannot satisfy an acquisition recipe) — the block was NOT silently skipped`,
        route: 'runs',
        state: 'blocked',
        required: ['reproduction_environment'],
        required_by: 'agent',
        revision: repro.revision,
        refs,
        blocking: false,
      })
      continue
    }
    if (repro.report_count > 0 && repro.latest_report_status !== 'pass') {
      actions.push({
        code: 'reproduction_report_review',
        label: `Review reproduction report for ${repro.spec_id}`,
        reason: `reproduction spec ${repro.spec_id} has a persisted report in status '${repro.latest_report_status}' — review the comparison details`,
        route: 'runs',
        state: 'ready',
        required: true,
        required_by: 'human',
        revision: repro.revision,
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
  const overlays = [...gateOverlay(ctx), ...jobOverlay(ctx), ...intakeOverlay(ctx), ...reproductionOverlay(ctx)]
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
