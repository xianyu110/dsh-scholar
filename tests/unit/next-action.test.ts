/**
 * GUIDE-01 — structured NextAction projection tests (design §4.2, §14).
 *
 * Covers: per-phase base actions, code stability, required-gap semantics,
 * legacy string[] derivation from v2 labels, unknown-state safe degradation,
 * pending-gate and budget-blocking overlay actions, failed-job retry/repair
 * overlay, and kernel-level projectProjection integration.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ResearchKernel, nextActionProjection, legacyNextActionStrings, INTAKE_ACTIVE_STATUSES,
  type NextActionContext, type NextActionIntake, type NextActionJob,
} from '@dsh-scholar/research-kernel'
import {
  NEXT_ACTION_UNKNOWN_CODE, NextAction, ProjectStatus,
  fixtureContract, fixtureEvidence, fixtureIdea, fixtureProject,
  type Gate, type ResearchProject,
} from '@dsh-scholar/research-schemas'

const PROJECT_ID = 'rsp_20260806_001'
const NOW = '2026-08-06T12:00:00.000Z'

function gate(type: Gate['type'], id = `gate_${type}_x1`): Gate {
  return {
    gate_id: id, project_id: PROJECT_ID, type, title: `${type} gate`, summary: '',
    payload: {}, status: 'pending', dsh_session_id: null, dsh_event_id: null,
    created_at: NOW, decided_at: null,
  }
}

function job(partial: Partial<NextActionJob> & { job_id: string; kind: string; status: NextActionJob['status'] }): NextActionJob {
  return { failure_class: null, attempts: 0, max_attempts: 3, contract_id: null, created_at: NOW, ...partial }
}

function intake(partial: Partial<NextActionIntake> & { status: string }): NextActionIntake {
  return { intake_id: 'intk_1', status: partial.status, target_phase: 'experiment', artifact_count: 0, ...partial }
}

/** Minimal authoritative-state context; per-test overrides win. */
function ctx(overrides: Partial<NextActionContext> & { status: ResearchProject['status'] }): NextActionContext {
  const project = fixtureProject({ status: overrides.status, project_id: PROJECT_ID })
  return {
    project,
    gates: [],
    jobs: [],
    budget: { project_id: PROJECT_ID, model_cost_usd: 0, gpu_hours: 0, api_requests: 0, updated_at: NOW },
    contracts: [],
    ideas: [],
    evidence: [],
    claims: [],
    corpus_snapshots: [],
    ...overrides,
  }
}

function freshKernel(): { kernel: ResearchKernel; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-next-action-test-'))
  const kernel = new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
  return { kernel, dir }
}

describe('GUIDE-01 NextAction projection (pure)', () => {
  it('every known status yields ≥1 schema-valid action; code/id set is deterministic', () => {
    for (const status of ProjectStatus.options) {
      const actions = nextActionProjection(ctx({ status }))
      expect(actions.length).toBeGreaterThanOrEqual(1)
      for (const action of actions) {
        expect(NextAction.safeParse(action).success).toBe(true)
        expect(action.code.length).toBeGreaterThan(0)
        expect(['ready', 'blocked', 'done']).toContain(action.state)
        expect(['human', 'agent', 'runner']).toContain(action.required_by)
      }
      // Same input → identical ids/codes (stable machine projection).
      const again = nextActionProjection(ctx({ status }))
      expect(again.map(a => a.id)).toEqual(actions.map(a => a.id))
      expect(again.map(a => a.code)).toEqual(actions.map(a => a.code))
      // Known statuses never degrade to the unknown fallback.
      expect(actions[0]?.code).not.toBe(NEXT_ACTION_UNKNOWN_CODE)
    }
  })

  it('each phase projects its expected base action code(s)', () => {
    const cases: Array<[ResearchProject['status'], string[]]> = [
      ['DRAFT', ['scope_gate_submit']],
      ['SCOPED', ['survey_run']],
      ['SURVEYING', ['idea_generate']],
      ['IDEATING', ['idea_gate_approve']],
      ['IDEA_APPROVED', ['contract_register']],
      ['CONTRACT_PENDING' as ResearchProject['status'], ['contract_register']],
      ['CONTRACT_APPROVED', ['baseline_reproduce']],
      ['BASELINE_REPRO', ['baseline_reproduce', 'pilot_formal_submit']],
      ['EXPERIMENTING', ['pilot_formal_submit', 'evidence_verify']],
      ['EVIDENCE_READY', ['manuscript_write']],
      ['WRITING', ['reviewer_run']],
      ['REVIEWING', ['release_bundle', 'release_gate']],
      ['RELEASE_READY', ['release_gate']],
      ['BLOCKED_GATE', ['gate_resolve']],
      ['FAILED', ['project_stop']],
      ['ARCHIVED', ['project_archived']],
      ['RELEASED', ['project_released']],
      ['STOPPED', ['project_stopped']],
    ]
    for (const [status, expectedCodes] of cases) {
      const actions = nextActionProjection(ctx({ status }))
      expect(actions.map(a => a.code)).toEqual(expectedCodes)
    }
  })

  it('stops asking to generate ideas once SURVEYING already has proposed candidates', () => {
    const actions = nextActionProjection(ctx({
      status: 'SURVEYING',
      ideas: [{ ...fixtureIdea(PROJECT_ID), status: 'proposed' }],
    }))
    expect(actions[0]).toMatchObject({
      code: 'idea_select',
      route: 'ideas',
      state: 'ready',
      required: true,
      required_by: 'human',
    })
    expect(actions[0]?.refs).toEqual([{ kind: 'idea', id: 'idea_003' }])
    expect(actions.some(action => action.code === 'idea_generate')).toBe(false)
  })

  it('never deadlocks after Idea approval: contract draft is ready before contract-bound baseline', () => {
    const approvedIdea = { ...fixtureIdea(PROJECT_ID), status: 'approved' as const }
    const awaitingContract = nextActionProjection(ctx({ status: 'IDEA_APPROVED', ideas: [approvedIdea] }))
    expect(awaitingContract).toHaveLength(1)
    expect(awaitingContract[0]).toMatchObject({
      code: 'contract_register', state: 'ready', required: true, required_by: 'agent', route: 'contracts',
    })

    const withContract = nextActionProjection(ctx({
      status: 'IDEA_APPROVED', ideas: [approvedIdea], contracts: [fixtureContract()],
    }))
    expect(withContract.some(action => action.state === 'ready')).toBe(true)

    const pending = nextActionProjection(ctx({
      status: 'CONTRACT_PENDING' as ResearchProject['status'],
      ideas: [approvedIdea], contracts: [{ ...fixtureContract(), status: 'draft' }], gates: [gate('contract')],
    }))
    expect(pending.some(action => action.code === 'contract_gate_approve' && action.state === 'ready')).toBe(true)

    const rejected = nextActionProjection(ctx({
      status: 'CONTRACT_PENDING' as ResearchProject['status'],
      ideas: [approvedIdea], contracts: [{ ...fixtureContract(), status: 'draft' }], gates: [],
    }))
    expect(rejected).toContainEqual(expect.objectContaining({ code: 'contract_register', state: 'ready' }))

    const contractApproved = nextActionProjection(ctx({ status: 'CONTRACT_APPROVED', contracts: [fixtureContract()] }))
    expect(contractApproved).toContainEqual(expect.objectContaining({
      code: 'baseline_reproduce', state: 'ready', required: ['baseline_command'],
    }))

    const contractNeedsExecutionInputs = nextActionProjection(ctx({
      status: 'CONTRACT_APPROVED',
      contracts: [{ ...fixtureContract(), baseline_run: undefined, code_snapshot: undefined }],
      code_snapshots: [],
      runner_environment_ready: true,
    }))
    expect(contractNeedsExecutionInputs).toContainEqual(expect.objectContaining({
      code: 'baseline_reproduce',
      state: 'ready',
      required: ['baseline_command', 'code_snapshot'],
    }))

    const repro = nextActionProjection(ctx({ status: 'BASELINE_REPRO', contracts: [fixtureContract()] }))
    expect(repro.find(a => a.code === 'baseline_reproduce')?.state).toBe('ready')
    expect(repro.find(a => a.code === 'pilot_formal_submit')?.state).toBe('blocked')

    const reproDone = nextActionProjection(ctx({
      status: 'BASELINE_REPRO',
      contracts: [fixtureContract()],
      jobs: [job({ job_id: 'job_bl_1', kind: 'baseline', status: 'succeeded', contract_id: 'expc_007' })],
    }))
    expect(reproDone.find(a => a.code === 'baseline_reproduce')?.state).toBe('done')
    expect(reproDone.find(a => a.code === 'pilot_formal_submit')?.state).toBe('ready')
  })

  it('EXPERIMENTING: evidence_verify needs succeeded runs, done after accepted evidence', () => {
    const noRuns = nextActionProjection(ctx({ status: 'EXPERIMENTING', contracts: [fixtureContract()] }))
    expect(noRuns.find(a => a.code === 'evidence_verify')?.state).toBe('blocked')
    expect(noRuns.find(a => a.code === 'evidence_verify')?.required).toEqual(['succeeded_runs'])

    const withRuns = nextActionProjection(ctx({
      status: 'EXPERIMENTING', contracts: [fixtureContract()],
      jobs: [job({ job_id: 'job_f_1', kind: 'formal', status: 'succeeded', contract_id: 'expc_007' })],
    }))
    expect(withRuns.find(a => a.code === 'evidence_verify')?.state).toBe('ready')
    expect(withRuns.find(a => a.code === 'pilot_formal_submit')?.state).toBe('done')

    const withEvidence = nextActionProjection(ctx({
      status: 'EXPERIMENTING', contracts: [fixtureContract()],
      jobs: [job({ job_id: 'job_f_1', kind: 'formal', status: 'succeeded', contract_id: 'expc_007' })],
      evidence: [fixtureEvidence().evidence],
    }))
    expect(withEvidence.find(a => a.code === 'evidence_verify')?.state).toBe('done')
  })

  it('legacy strings are stably derived from the v2 labels (non-done actions only)', () => {
    for (const status of ProjectStatus.options) {
      const actions = nextActionProjection(ctx({ status }))
      const expected = actions.filter(a => a.state !== 'done').map(a => a.label)
      expect(legacyNextActionStrings(actions)).toEqual(expected)
    }
    // Terminal states have no pending work → legacy list is empty (UI shows
    // "no pending actions").
    for (const status of ['ARCHIVED', 'RELEASED', 'STOPPED'] as const) {
      expect(legacyNextActionStrings(nextActionProjection(ctx({ status })))).toEqual([])
    }
  })

  it('unknown/future status degrades safely: code=unknown, no throw, read-only', () => {
    const actions = nextActionProjection(ctx({ status: 'FUTURE_PHASE' as unknown as ResearchProject['status'] }))
    expect(actions).toHaveLength(1)
    expect(actions[0]?.code).toBe(NEXT_ACTION_UNKNOWN_CODE)
    expect(actions[0]?.state).toBe('blocked')
    expect(actions[0]?.required).toEqual(['state_mapping'])
    expect(actions[0]?.blocking).toBe(true)
    expect(actions[0]?.capability).toBeUndefined()
    expect(legacyNextActionStrings(actions)).toEqual(['Unknown project state — inspect project'])
  })

  it('pending budget gate + exhausted budget → blocked budget_resolve; other pending gates → gate_decide', () => {
    const budgetGate = gate('budget')
    const blocked = nextActionProjection(ctx({
      status: 'BLOCKED_GATE',
      gates: [budgetGate],
      budget: { project_id: PROJECT_ID, model_cost_usd: 300, gpu_hours: 10, api_requests: 0, updated_at: NOW },
    }))
    const resolve = blocked.find(a => a.code === 'budget_resolve')
    expect(resolve).toBeDefined()
    expect(resolve?.state).toBe('blocked')
    expect(resolve?.blocking).toBe(true)
    expect(resolve?.required).toEqual(['budget_headroom'])
    expect(resolve?.refs).toContainEqual({ kind: 'gate', id: budgetGate.gate_id })
    expect(resolve?.reason).toContain('budget limits exceeded')
    // The generic gate_resolve base action stays alongside.
    expect(blocked.some(a => a.code === 'gate_resolve')).toBe(true)

    // Pending gates not referenced by a base action → gate_decide each.
    const surveying = nextActionProjection(ctx({ status: 'SURVEYING', gates: [gate('idea'), gate('contract')] }))
    expect(surveying.filter(a => a.code === 'gate_decide')).toHaveLength(2)

    // Base action references its own pending gate → no duplicate gate_decide.
    const draft = nextActionProjection(ctx({ status: 'DRAFT', gates: [gate('scope', 'gate_scope_1')] }))
    expect(draft.filter(a => a.code === 'gate_decide')).toHaveLength(0)
    expect(draft.find(a => a.code === 'scope_gate_submit')?.refs).toContainEqual({ kind: 'gate', id: 'gate_scope_1' })
  })

  it('failed/retryable jobs emit retry actions; exhausted attempts block with repair_decision', () => {
    const retryable = nextActionProjection(ctx({
      status: 'EXPERIMENTING', contracts: [fixtureContract()],
      jobs: [job({ job_id: 'job_b_1', kind: 'baseline', status: 'failed', failure_class: 'environment', attempts: 1 })],
    }))
    const retry = retryable.find(a => a.code === 'job_retry')
    expect(retry?.state).toBe('ready')
    expect(retry?.required).toBe(true)
    expect(retry?.blocking).toBe(false)
    expect(retry?.refs).toContainEqual({ kind: 'job', id: 'job_b_1' })
    expect(retry?.reason).toContain('environment')

    const exhausted = nextActionProjection(ctx({
      status: 'BASELINE_REPRO',
      jobs: [job({ job_id: 'job_b_2', kind: 'baseline', status: 'failed', failure_class: 'code_error', attempts: 3, max_attempts: 3 })],
    }))
    const repair = exhausted.find(a => a.code === 'job_retry')
    expect(repair?.state).toBe('blocked')
    expect(repair?.required).toEqual(['repair_decision'])
    expect(repair?.capability).toBe('pi')
  })
})

describe('GUIDE-01 intake overlay (ONBOARD-01 landing — intake_* actions)', () => {
  it('no active intakes → no intake_* actions (backward compatible)', () => {
    const actions = nextActionProjection(ctx({ status: 'DRAFT' }))
    expect(actions.some(a => a.code.startsWith('intake_'))).toBe(false)
  })

  it('every active intake status projects intake_resume + the status step overlay', () => {
    const cases: Array<[string, string[]]> = [
      ['draft', ['intake_resume']],
      ['uploading', ['intake_resume', 'intake_scan']],
      ['scanning', ['intake_resume']],
      ['needs_input', ['intake_resume', 'intake_answer']],
      ['grilling', ['intake_resume', 'intake_answer']],
      ['proposal_ready', ['intake_resume', 'intake_propose']],
      ['awaiting_human', ['intake_resume', 'intake_adopt']],
    ]
    for (const [status, expected] of cases) {
      const actions = nextActionProjection(ctx({
        status: 'DRAFT',
        intakes: [intake({ status, intake_id: 'intk_1', artifact_count: status === 'uploading' ? 1 : 0 })],
      }))
      const codes = actions.filter(a => a.code.startsWith('intake_')).map(a => a.code)
      expect(codes, status).toEqual(expected)
      for (const action of actions) {
        expect(NextAction.safeParse(action).success).toBe(true)
      }
      // 幂等稳定:同一输入产生同一 id/code 集合
      const again = nextActionProjection(ctx({
        status: 'DRAFT',
        intakes: [intake({ status, intake_id: 'intk_1', artifact_count: status === 'uploading' ? 1 : 0 })],
      }))
      expect(again.map(a => a.id)).toEqual(actions.map(a => a.id))
    }
  })

  it('intake_scan only when artifacts are staged; uploading with 0 files emits resume only', () => {
    const noArtifacts = nextActionProjection(ctx({ status: 'DRAFT', intakes: [intake({ status: 'uploading', artifact_count: 0 })] }))
    expect(noArtifacts.filter(a => a.code.startsWith('intake_')).map(a => a.code)).toEqual(['intake_resume'])
    const withArtifacts = nextActionProjection(ctx({ status: 'DRAFT', intakes: [intake({ status: 'uploading', artifact_count: 3 })] }))
    expect(withArtifacts.filter(a => a.code.startsWith('intake_')).map(a => a.code)).toEqual(['intake_resume', 'intake_scan'])
  })

  it('intake_adopt requires the pi capability and carries intake+project refs', () => {
    const actions = nextActionProjection(ctx({ status: 'DRAFT', intakes: [intake({ status: 'awaiting_human' })] }))
    const adopt = actions.find(a => a.code === 'intake_adopt')
    expect(adopt).toBeDefined()
    expect(adopt?.capability).toBe('pi')
    expect(adopt?.required_by).toBe('human')
    expect(adopt?.blocking).toBe(false)
    expect(adopt?.refs).toContainEqual({ kind: 'intake', id: 'intk_1' })
    expect(adopt?.refs).toContainEqual({ kind: 'project', id: PROJECT_ID })
    expect(adopt?.state).toBe('ready')
    // 每个 active intake 各有一条 resume(ref 绑定)
    const two = nextActionProjection(ctx({
      status: 'DRAFT',
      intakes: [intake({ status: 'draft', intake_id: 'intk_a' }), intake({ status: 'grilling', intake_id: 'intk_b' })],
    }))
    const resumes = two.filter(a => a.code === 'intake_resume')
    expect(resumes.map(a => a.refs.find(r => r.kind === 'intake')?.id)).toEqual(['intk_a', 'intk_b'])
  })

  it('terminal intakes (accepted/rejected/expired/failed) project nothing', () => {
    for (const status of ['accepted', 'rejected', 'expired', 'failed']) {
      const actions = nextActionProjection(ctx({ status: 'DRAFT', intakes: [intake({ status })] }))
      expect(actions.some(a => a.code.startsWith('intake_')), status).toBe(false)
    }
    // INTAKE_ACTIVE_STATUSES 导出与 schema 状态机一致
    expect(INTAKE_ACTIVE_STATUSES).toEqual([
      'draft', 'uploading', 'scanning', 'needs_input', 'grilling',
      'proposal_ready', 'awaiting_human',
    ])
  })
})

describe('GUIDE-01 kernel integration (projectProjection)', () => {
  it('DRAFT projects project scope_gate_submit with derived legacy strings', () => {
    const { kernel, dir } = freshKernel()
    try {
      const out = kernel.createProjectWithInitialGate({
        name: 'na', workspace: '/research/na',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        idempotency_key: 'k1', request_hash: 'h1',
      })
      const projection = kernel.projectProjection(out.project.project_id)
      expect(projection.next_actions_v2.length).toBeGreaterThanOrEqual(1)
      expect(projection.next_actions_v2[0]?.code).toBe('scope_gate_submit')
      expect(projection.next_actions_v2[0]?.state).toBe('ready')
      expect(projection.next_actions_v2[0]?.route).toBe('gates')
      // No duplicate gate_decide for the initial scope gate.
      expect(projection.next_actions_v2.filter(a => a.code === 'gate_decide')).toHaveLength(0)
      // Legacy strings equal the labels of non-done structured actions.
      const expectedLegacy = projection.next_actions_v2.filter(a => a.state !== 'done').map(a => a.label)
      expect(projection.next_actions).toEqual(expectedLegacy)
      expect(projection.next_actions).toContain('Complete Scope Gate')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scope approval moves to SCOPED → survey_run; budget exhaustion blocks with budget_resolve', () => {
    const { kernel, dir } = freshKernel()
    try {
      const out = kernel.createProjectWithInitialGate({
        name: 'na', workspace: '/research/na',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        idempotency_key: 'k2', request_hash: 'h2',
      })
      const projectId = out.project.project_id
      kernel.decideGate({ gate_id: out.gate.gate_id, actor: 'human-1', principal: { principal_id: 'human-1' }, decision: 'approved' })

      const scoped = kernel.projectProjection(projectId)
      expect(scoped.project.status).toBe('SCOPED')
      expect(scoped.next_actions_v2[0]?.code).toBe('survey_run')
      expect(scoped.next_actions_v2[0]?.route).toBe('chat')
      expect(scoped.next_actions_v2[0]?.required_by).toBe('agent')
      expect(scoped.next_actions).toEqual(['Run literature survey → corpus snapshot'])

      // Exceed the budget → BLOCKED_GATE + pending Budget Gate.
      kernel.recordUsage(projectId, { model_cost_usd: 300 })
      const blocked = kernel.projectProjection(projectId)
      expect(blocked.project.status).toBe('BLOCKED_GATE')
      const resolve = blocked.next_actions_v2.find(a => a.code === 'budget_resolve')
      expect(resolve).toBeDefined()
      expect(resolve?.state).toBe('blocked')
      expect(resolve?.required).toEqual(['budget_headroom'])
      expect(blocked.next_actions_v2.some(a => a.code === 'gate_resolve')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('freezing the survey corpus advances SCOPED atomically and removes the stale survey_run action', () => {
    const { kernel, dir } = freshKernel()
    try {
      const out = kernel.createProjectWithInitialGate({
        name: 'survey-flow', workspace: '/research/survey-flow',
        brief: { problem: 'object recognition', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        idempotency_key: 'survey-flow', request_hash: 'survey-flow',
      })
      const projectId = out.project.project_id
      kernel.decideGate({ gate_id: out.gate.gate_id, actor: 'human-1', principal: { principal_id: 'human-1' }, decision: 'approved' })
      const before = kernel.getProject(projectId)

      kernel.snapshotCorpus({
        project_id: projectId,
        queries: [{ source: 'openalex', query: 'object recognition', run_at: '2026-08-12T00:00:00.000Z' }],
        papers: [],
        source_status: 'complete',
      })

      const projection = kernel.projectProjection(projectId)
      expect(projection.project.status).toBe('SURVEYING')
      expect(projection.project.revision).toBe(before.revision + 1)
      expect(projection.next_actions_v2[0]?.code).toBe('idea_generate')
      expect(projection.next_actions_v2.some(a => a.code === 'survey_run')).toBe(false)
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an active intake session projects intake_* guidance in the projection', () => {
    const { kernel, dir } = freshKernel()
    try {
      const out = kernel.createProjectWithInitialGate({
        name: 'na', workspace: '/research/na',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        idempotency_key: 'k3', request_hash: 'h3',
      })
      const projectId = out.project.project_id
      const session = kernel.beginIntake({
        project_id: projectId, source_label: 'uploaded-paper', target_phase: 'experiment',
        owner: { principal_id: 'human-1', auth_method: 'dsh-session' },
      })
      // draft → intake_resume
      let projection = kernel.projectProjection(projectId)
      expect(projection.next_actions_v2.find(a => a.code === 'intake_resume')).toBeDefined()
      expect(projection.next_actions_v2.find(a => a.code === 'intake_resume')?.refs)
        .toContainEqual({ kind: 'intake', id: session.intake_id })
      expect(projection.next_actions.some(s => s.startsWith('Resume intake'))).toBe(true)
      // stage a file → uploading → intake_resume + intake_scan
      kernel.stageIntakeArtifact(session.intake_id, { file_name: 'paper.txt', content: 'hello world' })
      projection = kernel.projectProjection(projectId)
      expect(projection.next_actions_v2.filter(a => a.code.startsWith('intake_')).map(a => a.code))
        .toEqual(['intake_resume', 'intake_scan'])
      // scan → needs_input (required questions unanswered) → intake_answer
      kernel.scanIntake(session.intake_id)
      projection = kernel.projectProjection(projectId)
      expect(projection.next_actions_v2.filter(a => a.code.startsWith('intake_')).map(a => a.code))
        .toEqual(['intake_resume', 'intake_answer'])
      // legacy strings derive from the non-done structured actions
      const expectedLegacy = projection.next_actions_v2.filter(a => a.state !== 'done').map(a => a.label)
      expect(projection.next_actions).toEqual(expectedLegacy)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
