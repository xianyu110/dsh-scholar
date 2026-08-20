/**
 * Full-auto fixture binding tests (reconstruction-contracts.md §5 /
 * security-baseline.md §1 "full-auto | fixture-only").
 *
 * full-auto mode is ONLY valid for REGISTERED FixtureProfiles: project
 * create and job submit both reject unbound full-auto (422 fixture_required),
 * and fixture jobs must stay inside the profile — pinned image digest
 * (fixture_image_mismatch) and profile data content hashes
 * (fixture_artifact_outside_profile).
 */
import { describe, expect, it } from 'vitest'
import { ResearchKernel, KernelError, startKernelServer } from '@dsh-scholar/research-kernel'
import {
  ExperimentContract,
  FixtureProfile,
  fixtureCorpus,
  fixtureIdea,
  getFixtureProfile,
  RUNNER_PROFILE_IDS,
} from '@dsh-scholar/research-schemas'
import { ConfiguredTestKernel } from './configured-test-kernel.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Assert a KernelError with an exact error code (messages carry no code). */
function expectKernelError(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError)
    expect((error as KernelError).code).toBe(code)
    return
  }
  throw new Error(`expected KernelError with code ${code} but no error was thrown`)
}

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fullauto-'))
  return new ConfiguredTestKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas') })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m1'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'machine-learning',
  }
}

const FIXTURE_ID = 'golden-path-v2'
const RUNNER_PROFILE_ID = RUNNER_PROFILE_IDS.localDockerCpu
const RUNNER_TARGET_ID = 'target_local_docker_v1'

function fullAutoFixtureProject(kernel: ResearchKernel) {
  const project = kernel.createProject({
    name: 'fixture-auto', workspace: '/w/fixture-auto', brief: makeBrief(), mode: 'full-auto',
    execution: {
      fixture_id: FIXTURE_ID,
      runner_profile_id: RUNNER_PROFILE_ID,
      runner_target_id: RUNNER_TARGET_ID,
    },
  })
  kernel.observeRunnerTarget(RUNNER_TARGET_ID, { expected_revision: 1, health: 'online' })
  return project
}

function prepareFullAutoIdeaGate(kernel: ResearchKernel) {
  const project = fullAutoFixtureProject(kernel)
  const scopeGate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope Gate' })
  kernel.decideFullAutoGate({
    project_id: project.project_id,
    gate_id: scopeGate.gate_id,
    expected_project_revision: project.revision,
    idempotency_key: `scope:${project.project_id}`,
  })
  const corpus = fixtureCorpus(project.project_id)
  const snapshot = kernel.snapshotCorpus({
    project_id: project.project_id,
    queries: corpus.queries,
    papers: corpus.papers,
    passages: corpus.passages,
    citation_edges: corpus.citation_edges,
    external_claims: corpus.external_claims,
    source_status: corpus.source_status,
  })
  const surveying = kernel.getProject(project.project_id)
  const fixture = fixtureIdea(project.project_id)
  const [idea] = kernel.createIdeasBatch({
    project_id: project.project_id,
    expected_project_revision: surveying.revision,
    corpus_snapshot_id: snapshot.snapshot_id,
    ideas: [{
      title: fixture.title,
      hypothesis: fixture.hypothesis,
      scientific_gap: fixture.scientific_gap,
      nearest_prior_works: fixture.nearest_prior_works,
      exact_delta: fixture.exact_delta,
      falsification: fixture.falsification,
      minimum_viable_experiment: fixture.minimum_viable_experiment,
      scores: fixture.scores,
      risk_notes: fixture.risk_notes,
    }],
  })
  const prepared = kernel.prepareIdeaGate({
    project_id: project.project_id,
    idea_id: idea!.idea_id,
    expected_project_revision: surveying.revision,
    expected_idea_version: idea!.version,
    novelty_audit: fixture.novelty_audit!,
  })
  return { project, prepared }
}

function contractDraft(idea: ReturnType<typeof fixtureIdea>) {
  return {
    data: { dataset_id: idea.minimum_viable_experiment.dataset, version: 'official', split: 'official' },
    methods: { baseline: idea.minimum_viable_experiment.baseline, treatment: idea.exact_delta },
    metrics: { primary: idea.minimum_viable_experiment.primary_metric, secondary: [] },
    seeds: [11, 23, 47],
    analysis: { effect_size: 'mean_difference' as const, interval: 'bootstrap_95' as const, multiple_testing: 'holm' as const },
    ablations: [],
    stop_conditions: {
      max_gpu_hours: idea.minimum_viable_experiment.estimated_gpu_hours,
      min_completed_seeds: 3,
      stop_on_data_leakage: true,
    },
  }
}

function fullAutoSurveyResult(query: string) {
  const runAt = '2026-08-20T12:00:00.000Z'
  const corpus = fixtureCorpus('rsp_full_auto_survey_fixture')
  return {
    queries: [
      { source: 'openalex' as const, query, run_at: runAt },
      { source: 'crossref' as const, query, run_at: runAt },
      { source: 'arxiv' as const, query, run_at: runAt },
    ],
    papers: corpus.papers,
    passages: corpus.passages,
    citation_edges: corpus.citation_edges,
    source_status: 'complete' as const,
  }
}

describe('FixtureProfile registry (reconstruction-contracts.md §5)', () => {
  it('registers the golden-path-v2 fixture with forced guard rails', () => {
    const profile = getFixtureProfile(FIXTURE_ID)
    expect(profile).not.toBeNull()
    expect(profile?.automatic_release).toBe(false)
    expect(profile?.allow_private_data).toBe(false)
    expect(profile?.allow_external_release).toBe(false)
    expect(profile?.image).toMatch(/^[^\s@]+@sha256:[0-9a-f]{64}$/)
    // The schema FORBIDS overriding the guard rails (z.literal).
    expect(FixtureProfile.safeParse({ ...profile, automatic_release: true }).success).toBe(false)
    expect(FixtureProfile.safeParse({ ...profile, allow_private_data: true }).success).toBe(false)
  })

  it('unknown fixture ids resolve to null', () => {
    expect(getFixtureProfile('not-registered')).toBeNull()
    expect(getFixtureProfile('')).toBeNull()
  })
})

describe('full-auto project create requires a registered fixture', () => {
  it('gate-only projects do not need a fixture', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'g', workspace: '/w/g', brief: makeBrief(), mode: 'gate-only' })
    expect(project.mode).toBe('gate-only')
    expect(project.execution.fixture_id).toBeNull()
  })

  it('full-auto without fixture_id is rejected (422 fixture_required) and nothing is persisted', () => {
    const kernel = freshKernel()
    expectKernelError(() => kernel.createProject({ name: 'f', workspace: '/w/f', brief: makeBrief(), mode: 'full-auto' }), 'fixture_required')
    expect(kernel.listProjects()).toHaveLength(0)
  })

  it('full-auto with an UNREGISTERED fixture_id is rejected', () => {
    const kernel = freshKernel()
    expectKernelError(() => kernel.createProject({
      name: 'f', workspace: '/w/f', brief: makeBrief(), mode: 'full-auto',
      execution: { fixture_id: 'not-registered' },
    }), 'fixture_required')
  })

  it('full-auto with a registered fixture_id is created and persisted', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({
      name: 'f', workspace: '/w/f', brief: makeBrief(), mode: 'full-auto',
      execution: { fixture_id: FIXTURE_ID },
    })
    expect(project.mode).toBe('full-auto')
    expect(project.execution.fixture_id).toBe(FIXTURE_ID)
    // Re-read from the store: the binding is durable.
    expect(kernel.getProject(project.project_id).execution.fixture_id).toBe(FIXTURE_ID)
  })
})

describe('full-auto job submit stays inside the fixture profile', () => {
  function fullAutoProject(kernel: ResearchKernel): string {
    return kernel.createProject({
      name: 'f', workspace: '/w/f', brief: makeBrief(), mode: 'full-auto',
      execution: { fixture_id: FIXTURE_ID },
    }).project_id
  }

  function codeSnapshot(kernel: ResearchKernel, projectId: string): string {
    return kernel.registerArtifact({
      project_id: projectId, kind: 'code', content: 'fixture code archive bytes',
      file_name: 'fixture.tar', media_type: 'application/x-tar',
    }).artifact_id
  }

  function approvedContractId(kernel: ResearchKernel, projectId: string): string {
    const contract = kernel.registerContract({
      project_id: projectId, idea_id: 'idea_x', data: { dataset_id: 'd', version: 'v1' },
      methods: { baseline: 'b', treatment: 'a' }, metrics: { primary: 'm1', secondary: [] },
      seeds: [1], analysis: {}, ablations: [],
      stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 1, stop_on_data_leakage: true },
    })
    kernel.approveContract(contract.contract_id, 'dec_gate', 'pi')
    return contract.contract_id
  }

  it('submission on a project whose fixture binding was lost is rejected (defense in depth)', () => {
    const kernel = freshKernel()
    const projectId = fullAutoProject(kernel)
    kernel.db.prepare('UPDATE projects SET execution = ? WHERE project_id = ?')
      .run(JSON.stringify({ runner_profile_id: 'profile_local_docker_cpu_v1', network_policy: 'allowlist', artifact_store: 'local-cas', fixture_id: null }), projectId)
    expectKernelError(() => kernel.submitJob({
      project_id: projectId, idempotency_key: 'k1', kind: 'echo', command: [],
      payload: { message: 'x' },
    }), 'fixture_required')
  })

  it('a caller-supplied digest that differs from the profile image is rejected (fixture_image_mismatch)', () => {
    const kernel = freshKernel()
    const projectId = fullAutoProject(kernel)
    const contractId = approvedContractId(kernel, projectId)
    const snap = codeSnapshot(kernel, projectId)
    expectKernelError(() => kernel.submitJob({
      project_id: projectId, idempotency_key: 'k1', kind: 'baseline', contract_id: contractId,
      code_snapshot_id: snap, image_digest: 'node@sha256:' + 'b'.repeat(64),
      payload: { repo: 'evals/golden-path-v2/fixture-repo', commit: 'in-repo' },
    }), 'fixture_image_mismatch')
  })

  it('an absent digest is bound to the fixture profile image', () => {
    const kernel = freshKernel()
    const projectId = fullAutoProject(kernel)
    const contractId = approvedContractId(kernel, projectId)
    const snap = codeSnapshot(kernel, projectId)
    const job = kernel.submitJob({
      project_id: projectId, idempotency_key: 'k2', kind: 'baseline', contract_id: contractId,
      code_snapshot_id: snap, payload: { repo: 'evals/golden-path-v2/fixture-repo', commit: 'in-repo' },
    })
    expect(job.image_digest).toBe(getFixtureProfile(FIXTURE_ID)!.image)
    expect(job.payload.image_digest).toBe(getFixtureProfile(FIXTURE_ID)!.image)
  })

  it('data artifacts outside the profile are rejected (fixture_artifact_outside_profile)', () => {
    const kernel = freshKernel()
    const projectId = fullAutoProject(kernel)
    const contractId = approvedContractId(kernel, projectId)
    const snap = codeSnapshot(kernel, projectId)
    // Private data blob: content is NOT among the profile's fixed data inputs.
    const artifact = kernel.registerArtifact({
      project_id: projectId, kind: 'data', content: 'private dataset bytes that must never enter a fixture job',
      file_name: 'private.csv',
    })
    expectKernelError(() => kernel.submitJob({
      project_id: projectId, idempotency_key: 'k3', kind: 'baseline', contract_id: contractId,
      code_snapshot_id: snap, data_artifact_ids: [artifact.artifact_id],
      payload: { repo: 'evals/golden-path-v2/fixture-repo', commit: 'in-repo' },
    }), 'fixture_artifact_outside_profile')
  })

  it('echo jobs in a full-auto project remain allowed', () => {
    const kernel = freshKernel()
    const projectId = fullAutoProject(kernel)
    const job = kernel.submitJob({
      project_id: projectId, idempotency_key: 'k4', kind: 'echo', command: [],
      payload: { message: 'fixture ok' },
    })
    expect(job.status).toBe('queued')
  })
})

describe('full-auto service Gate authority', () => {
  it('atomically approves an allowlisted fixture Gate with a non-Human authority receipt and idempotent replay', () => {
    const kernel = freshKernel()
    const project = fullAutoFixtureProject(kernel)
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope Gate' })

    const first = kernel.decideFullAutoGate({
      project_id: project.project_id,
      gate_id: gate.gate_id,
      expected_project_revision: project.revision,
      idempotency_key: 'full-auto-scope-1',
    })
    expect(first.gate.status).toBe('approved')
    expect(first.project.status).toBe('SCOPED')
    expect(first.decision.principal).toMatchObject({
      principal_id: 'service:research-orchestrator',
      auth_method: 'full-auto-service',
      session_id: null,
    })
    expect(first.receipt).toMatchObject({
      authority: 'full_auto_service',
      project_id: project.project_id,
      project_revision: project.revision,
      gate_id: gate.gate_id,
      gate_type: 'scope',
      fixture: { fixture_id: FIXTURE_ID },
      runner_profile: { profile_id: RUNNER_PROFILE_ID },
      runner_target: { target_id: RUNNER_TARGET_ID, revision: 1 },
      idempotency_key: 'full-auto-scope-1',
    })
    expect(first.receipt.payload_sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first.receipt.fixture.profile_sha256).toMatch(/^sha256:[0-9a-f]{64}$/)

    const replay = kernel.decideFullAutoGate({
      project_id: project.project_id,
      gate_id: gate.gate_id,
      expected_project_revision: project.revision,
      idempotency_key: 'full-auto-scope-1',
    })
    expect(replay).toEqual(first)
    expect(kernel.listDecisions(project.project_id)).toHaveLength(1)
    kernel.close()
  })

  it('fails closed for gate-only, stale, unobserved, malformed payload and non-allowlisted Release gates', () => {
    const gateOnly = freshKernel()
    const ordinary = gateOnly.createProject({
      name: 'ordinary', workspace: '/w/ordinary', brief: makeBrief(), mode: 'gate-only',
      execution: { runner_profile_id: RUNNER_PROFILE_ID, runner_target_id: RUNNER_TARGET_ID },
    })
    const ordinaryGate = gateOnly.createGate({ project_id: ordinary.project_id, type: 'scope', title: 'Scope' })
    expectKernelError(() => gateOnly.decideFullAutoGate({
      project_id: ordinary.project_id, gate_id: ordinaryGate.gate_id,
      expected_project_revision: ordinary.revision, idempotency_key: 'ordinary',
    }), 'full_auto_fixture_required')
    expect(gateOnly.listDecisions(ordinary.project_id)).toHaveLength(0)
    gateOnly.close()

    const kernel = freshKernel()
    const project = kernel.createProject({
      name: 'fixture-auto', workspace: '/w/fixture-auto', brief: makeBrief(), mode: 'full-auto',
      execution: { fixture_id: FIXTURE_ID, runner_profile_id: RUNNER_PROFILE_ID, runner_target_id: RUNNER_TARGET_ID },
    })
    const scope = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    expectKernelError(() => kernel.decideFullAutoGate({
      project_id: project.project_id, gate_id: scope.gate_id,
      expected_project_revision: project.revision, idempotency_key: 'unobserved',
    }), 'full_auto_runner_not_ready')
    expect(kernel.listDecisions(project.project_id)).toHaveLength(0)
    kernel.observeRunnerTarget(RUNNER_TARGET_ID, { expected_revision: 1, health: 'online' })
    expectKernelError(() => kernel.decideFullAutoGate({
      project_id: project.project_id, gate_id: scope.gate_id,
      expected_project_revision: project.revision + 1, idempotency_key: 'stale',
    }), 'revision_conflict')
    expect(kernel.listDecisions(project.project_id)).toHaveLength(0)

    const badScope = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Bad Scope', payload: { injected: true } })
    expectKernelError(() => kernel.decideFullAutoGate({
      project_id: project.project_id, gate_id: badScope.gate_id,
      expected_project_revision: project.revision, idempotency_key: 'bad-payload',
    }), 'full_auto_gate_payload_invalid')
    const release = kernel.createGate({ project_id: project.project_id, type: 'release', title: 'Release' })
    expectKernelError(() => kernel.decideFullAutoGate({
      project_id: project.project_id, gate_id: release.gate_id,
      expected_project_revision: project.revision, idempotency_key: 'release',
    }), 'full_auto_gate_not_allowed')
    expect(kernel.listDecisions(project.project_id)).toHaveLength(0)
    kernel.close()
  })

  it('pins the exact IdeaCard version and hash in the Gate and rejects a changed target with zero decision writes', () => {
    const kernel = freshKernel()
    const { project, prepared } = prepareFullAutoIdeaGate(kernel)
    expect(prepared.gate.payload).toMatchObject({
      idea_id: prepared.idea.idea_id,
      idea_version: prepared.idea.version,
      idea_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(Object.keys(prepared.gate.payload).sort()).toEqual(['idea_id', 'idea_sha256', 'idea_version'])

    kernel.updateIdea(prepared.idea.idea_id, { risk_notes: 'changed after Gate creation' })
    const before = kernel.listDecisions(project.project_id).length
    expectKernelError(() => kernel.decideFullAutoGate({
      project_id: project.project_id,
      gate_id: prepared.gate.gate_id,
      expected_project_revision: prepared.project.revision,
      idempotency_key: 'full-auto-idea-changed',
    }), 'full_auto_gate_target_invalid')
    expect(kernel.listDecisions(project.project_id)).toHaveLength(before)
    expect(kernel.getGate(prepared.gate.gate_id).status).toBe('pending')
    kernel.close()
  })

  it('pins the exact Contract version and hash in the Gate and rejects storage tampering with zero decision writes', () => {
    const kernel = freshKernel()
    const { project, prepared } = prepareFullAutoIdeaGate(kernel)
    const ideaApproved = kernel.decideFullAutoGate({
      project_id: project.project_id,
      gate_id: prepared.gate.gate_id,
      expected_project_revision: prepared.project.revision,
      idempotency_key: 'full-auto-idea-ok',
    })
    const idea = kernel.getIdea(prepared.idea.idea_id)
    const contractPrepared = kernel.prepareContractGate({
      project_id: project.project_id,
      idea_id: idea.idea_id,
      expected_project_revision: ideaApproved.project.revision,
      expected_idea_version: idea.version,
      contract: contractDraft(idea),
    })
    expect(contractPrepared.gate.payload).toMatchObject({
      contract_id: contractPrepared.contract.contract_id,
      contract_version: contractPrepared.contract.version,
      contract_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(Object.keys(contractPrepared.gate.payload).sort()).toEqual(['contract_id', 'contract_sha256', 'contract_version'])

    const tampered = ExperimentContract.parse({
      ...contractPrepared.contract,
      version: contractPrepared.contract.version + 1,
      updated_at: '2026-08-20T12:00:00.000Z',
    })
    kernel.db.prepare('UPDATE contracts SET body = ?, updated_at = ? WHERE contract_id = ?')
      .run(JSON.stringify(tampered), tampered.updated_at, tampered.contract_id)
    const before = kernel.listDecisions(project.project_id).length
    expectKernelError(() => kernel.decideFullAutoGate({
      project_id: project.project_id,
      gate_id: contractPrepared.gate.gate_id,
      expected_project_revision: contractPrepared.project.revision,
      idempotency_key: 'full-auto-contract-changed',
    }), 'full_auto_gate_target_invalid')
    expect(kernel.listDecisions(project.project_id)).toHaveLength(before)
    expect(kernel.getGate(contractPrepared.gate.gate_id).status).toBe('pending')
    kernel.close()
  })

  it('rejects a Budget Gate unless its resume target exactly matches the Kernel-recorded block provenance', () => {
    const kernel = freshKernel()
    const project = fullAutoFixtureProject(kernel)
    kernel.db.prepare("UPDATE projects SET status = 'EXPERIMENTING', constraints = ? WHERE project_id = ?")
      .run(JSON.stringify({ ...project.constraints, max_model_cost_usd: 0 }), project.project_id)
    kernel.recordUsage(project.project_id, { model_cost_usd: 1 })
    const gate = kernel.listGates(project.project_id).find(candidate => candidate.type === 'budget')!
    kernel.db.prepare('UPDATE gates SET payload = ? WHERE gate_id = ?')
      .run(JSON.stringify({ resume_to: 'RELEASED' }), gate.gate_id)
    kernel.db.prepare('UPDATE projects SET constraints = ? WHERE project_id = ?')
      .run(JSON.stringify({ ...project.constraints, max_model_cost_usd: 10 }), project.project_id)

    expectKernelError(() => kernel.decideFullAutoGate({
      project_id: project.project_id,
      gate_id: gate.gate_id,
      expected_project_revision: kernel.getProject(project.project_id).revision,
      idempotency_key: 'budget-provenance-tampered',
    }), 'budget_block_provenance_mismatch')
    expect(kernel.getProject(project.project_id).status).toBe('BLOCKED_GATE')
    expect(kernel.listDecisions(project.project_id)).toEqual([])
    kernel.close()
  })

  it('replays the exact receipt after closing and reopening the same database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-fullauto-reopen-'))
    const options = { dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false }
    const firstKernel = new ConfiguredTestKernel(options)
    const project = fullAutoFixtureProject(firstKernel)
    const gate = firstKernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    const input = {
      project_id: project.project_id, gate_id: gate.gate_id,
      expected_project_revision: project.revision, idempotency_key: 'restart-scope-1',
    }
    const first = firstKernel.decideFullAutoGate(input)
    firstKernel.close()

    const reopened = new ConfiguredTestKernel(options)
    expect(reopened.decideFullAutoGate(input)).toEqual(first)
    expect(reopened.listDecisions(project.project_id)).toHaveLength(1)
    reopened.close()
  })

  it('binds an approval idempotency key globally across Gate, project and restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-fullauto-global-idem-'))
    const options = { dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false }
    const first = new ConfiguredTestKernel(options)
    const projectA = fullAutoFixtureProject(first)
    const projectB = fullAutoFixtureProject(first)
    const gateA = first.createGate({ project_id: projectA.project_id, type: 'scope', title: 'Scope A' })
    const otherGateA = first.createGate({ project_id: projectA.project_id, type: 'scope', title: 'Scope A duplicate' })
    const gateB = first.createGate({ project_id: projectB.project_id, type: 'scope', title: 'Scope B' })
    const key = 'globally-bound-approval-key'
    const approved = first.decideFullAutoGate({
      project_id: projectA.project_id, gate_id: gateA.gate_id,
      expected_project_revision: projectA.revision, idempotency_key: key,
    })

    expectKernelError(() => first.decideFullAutoGate({
      project_id: projectA.project_id, gate_id: otherGateA.gate_id,
      expected_project_revision: projectA.revision, idempotency_key: key,
    }), 'idempotency_conflict')
    expectKernelError(() => first.decideFullAutoGate({
      project_id: projectB.project_id, gate_id: gateB.gate_id,
      expected_project_revision: projectB.revision, idempotency_key: key,
    }), 'idempotency_conflict')
    expectKernelError(() => first.decideFullAutoGate({
      project_id: projectA.project_id, gate_id: gateA.gate_id,
      expected_project_revision: projectA.revision + 1, idempotency_key: key,
    }), 'idempotency_conflict')
    expect(first.listDecisions(projectA.project_id)).toHaveLength(1)
    expect(first.listDecisions(projectB.project_id)).toHaveLength(0)
    first.close()

    const reopened = new ConfiguredTestKernel(options)
    expect(reopened.decideFullAutoGate({
      project_id: projectA.project_id, gate_id: gateA.gate_id,
      expected_project_revision: projectA.revision, idempotency_key: key,
    })).toEqual(approved)
    expectKernelError(() => reopened.decideFullAutoGate({
      project_id: projectB.project_id, gate_id: gateB.gate_id,
      expected_project_revision: projectB.revision, idempotency_key: key,
    }), 'idempotency_conflict')
    expectKernelError(() => reopened.decideFullAutoGate({
      project_id: projectA.project_id, gate_id: gateA.gate_id,
      expected_project_revision: projectA.revision + 1, idempotency_key: key,
    }), 'idempotency_conflict')
    expect(reopened.listDecisions(projectB.project_id)).toHaveLength(0)
    reopened.close()
  })

  it('requires the independent orchestrator credential on the internal Gate endpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-fullauto-http-'))
    const kernel = new ConfiguredTestKernel({
      dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false,
      serviceToken: 'service-secret', orchestratorToken: 'orchestrator-secret',
    })
    const project = fullAutoFixtureProject(kernel)
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    const { server, url } = await startKernelServer({ kernel, port: 0, token: 'kernel-secret' })
    const path = `${url}/internal/projects/${project.project_id}/full-auto-gates/${gate.gate_id}/approve`
    const body = JSON.stringify({ expected_project_revision: project.revision, idempotency_key: 'http-scope-1' })
    const post = (headers: Record<string, string>) => fetch(path, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer kernel-secret', ...headers }, body,
    })
    try {
      expect((await post({})).status).toBe(403)
      expect((await post({ 'x-service-token': 'wrong', 'x-service-principal': 'research-orchestrator' })).status).toBe(403)
      expect((await post({ 'x-service-token': 'service-secret', 'x-service-principal': 'human-pi' })).status).toBe(403)
      expect((await post({ 'x-service-token': 'service-secret', 'x-service-principal': 'research-orchestrator' })).status).toBe(403)
      expect((await post({
        'x-service-token': 'service-secret', 'x-service-principal': 'research-orchestrator',
        'x-orchestrator-token': 'wrong',
      })).status).toBe(403)
      expect(kernel.listDecisions(project.project_id)).toHaveLength(0)
      const approved = await post({
        'x-service-token': 'service-secret', 'x-service-principal': 'research-orchestrator',
        'x-orchestrator-token': 'orchestrator-secret',
      })
      expect(approved.status).toBe(200)
      expect(await approved.json()).toMatchObject({ receipt: { authority: 'full_auto_service', gate_id: gate.gate_id } })
      expect(kernel.listDecisions(project.project_id)).toHaveLength(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })
})

describe('full-auto canonical survey executor authority', () => {
  it('atomically snapshots the real connector result, advances once, and replays the durable authority receipt', () => {
    const kernel = freshKernel()
    const project = fullAutoFixtureProject(kernel)
    const scope = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    const scoped = kernel.decideFullAutoGate({
      project_id: project.project_id,
      gate_id: scope.gate_id,
      expected_project_revision: project.revision,
      idempotency_key: 'survey-scope',
    }).project
    const action = kernel.projectProjection(project.project_id).next_actions_v2[0]!
    expect(action).toMatchObject({ code: 'survey_run', state: 'ready', required_by: 'agent', revision: scoped.revision })
    const admittedAuthority = kernel.fullAutoSurveyAuthority({
      project_id: project.project_id,
      expected_project_revision: scoped.revision,
      action_id: action.id,
      action_revision: action.revision!,
    })
    const input = {
      project_id: project.project_id,
      expected_project_revision: scoped.revision,
      action_id: action.id,
      action_revision: action.revision!,
      idempotency_key: 'full-auto-survey-1',
      expected_authority_sha256: admittedAuthority.authority_sha256,
      result: fullAutoSurveyResult(project.brief.problem),
    }

    const first = kernel.executeFullAutoSurvey(input)
    expect(first.project.status).toBe('SURVEYING')
    expect(first.snapshot).toMatchObject({ project_id: project.project_id, frozen: true, source_status: 'complete' })
    expect(first.receipt).toMatchObject({
      authority: 'full_auto_service',
      action: { id: action.id, code: 'survey_run', revision: scoped.revision },
      project_id: project.project_id,
      project_revision: scoped.revision,
      query: project.brief.problem,
      fixture: { fixture_id: FIXTURE_ID },
      runner_profile: { profile_id: RUNNER_PROFILE_ID },
      runner_target: { target_id: RUNNER_TARGET_ID, revision: 1 },
      protocol_pin: null,
      snapshot_id: first.snapshot.snapshot_id,
      idempotency_key: input.idempotency_key,
    })
    expect(kernel.projectProjection(project.project_id).next_actions_v2.some(candidate => candidate.code === 'survey_run')).toBe(false)

    const replay = kernel.executeFullAutoSurvey({ ...input, result: undefined })
    expect(replay).toEqual({ ...first, project: kernel.getProject(project.project_id) })
    expect(kernel.listCorpusSnapshots(project.project_id)).toHaveLength(1)
    kernel.close()
  })

  it('rejects stale action pins and non-Brief connector queries with zero corpus/project writes', () => {
    const kernel = freshKernel()
    const project = fullAutoFixtureProject(kernel)
    const scope = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    const scoped = kernel.decideFullAutoGate({
      project_id: project.project_id,
      gate_id: scope.gate_id,
      expected_project_revision: project.revision,
      idempotency_key: 'survey-scope-negative',
    }).project
    const action = kernel.projectProjection(project.project_id).next_actions_v2[0]!
    const base = {
      project_id: project.project_id,
      expected_project_revision: scoped.revision,
      action_id: action.id,
      action_revision: action.revision!,
      idempotency_key: 'full-auto-survey-negative',
      expected_authority_sha256: kernel.fullAutoSurveyAuthority({
        project_id: project.project_id,
        expected_project_revision: scoped.revision,
        action_id: action.id,
        action_revision: action.revision!,
      }).authority_sha256,
    }
    expectKernelError(() => kernel.executeFullAutoSurvey({
      ...base,
      action_revision: action.revision! + 1,
      result: fullAutoSurveyResult(project.brief.problem),
    }), 'full_auto_action_not_ready')
    expectKernelError(() => kernel.executeFullAutoSurvey({
      ...base,
      result: fullAutoSurveyResult('caller guessed a different query'),
    }), 'full_auto_survey_query_invalid')
    expect(kernel.listCorpusSnapshots(project.project_id)).toHaveLength(0)
    expect(kernel.getProject(project.project_id)).toMatchObject({ status: 'SCOPED', revision: scoped.revision })
    kernel.close()
  })

  it('rejects runner authority drift after admission with zero corpus/project writes', () => {
    const kernel = freshKernel()
    const project = fullAutoFixtureProject(kernel)
    const scope = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    const scoped = kernel.decideFullAutoGate({
      project_id: project.project_id,
      gate_id: scope.gate_id,
      expected_project_revision: project.revision,
      idempotency_key: 'survey-scope-runner-drift',
    }).project
    const action = kernel.projectProjection(project.project_id).next_actions_v2[0]!
    const authority = kernel.fullAutoSurveyAuthority({
      project_id: project.project_id,
      expected_project_revision: scoped.revision,
      action_id: action.id,
      action_revision: action.revision!,
    })
    expect(authority).toMatchObject({
      project_id: project.project_id,
      project_revision: scoped.revision,
      runner_target: { target_id: RUNNER_TARGET_ID, revision: 1 },
      authority_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })

    kernel.updateRunnerTarget(RUNNER_TARGET_ID, { expected_revision: 1, display_name: 'changed after survey admission' })
    kernel.observeRunnerTarget(RUNNER_TARGET_ID, { expected_revision: 2, health: 'online' })
    expectKernelError(() => kernel.executeFullAutoSurvey({
      project_id: project.project_id,
      expected_project_revision: scoped.revision,
      action_id: action.id,
      action_revision: action.revision!,
      expected_authority_sha256: authority.authority_sha256,
      idempotency_key: 'full-auto-survey-runner-drift',
      result: fullAutoSurveyResult(project.brief.problem),
    }), 'full_auto_survey_authority_changed')
    expect(kernel.listCorpusSnapshots(project.project_id)).toHaveLength(0)
    expect(kernel.getProject(project.project_id)).toMatchObject({ status: 'SCOPED', revision: scoped.revision })
    kernel.close()
  })

  it('requires the independent orchestrator credential on both survey endpoints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-fullauto-survey-http-'))
    const kernel = new ConfiguredTestKernel({
      dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false,
      serviceToken: 'service-secret', orchestratorToken: 'orchestrator-secret',
    })
    const project = fullAutoFixtureProject(kernel)
    const scope = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    const scoped = kernel.decideFullAutoGate({
      project_id: project.project_id,
      gate_id: scope.gate_id,
      expected_project_revision: project.revision,
      idempotency_key: 'survey-http-scope',
    }).project
    const action = kernel.projectProjection(project.project_id).next_actions_v2[0]!
    const { server, url } = await startKernelServer({ kernel, port: 0, token: 'kernel-secret' })
    const path = `${url}/internal/projects/${project.project_id}/full-auto-actions/survey-run`
    const authorityPath = `${path}/authority`
    const authorityBody = JSON.stringify({
      expected_project_revision: scoped.revision,
      action_id: action.id,
      action_revision: action.revision,
    })
    const post = (target: string, body: string, headers: Record<string, string>) => fetch(target, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer kernel-secret', ...headers }, body,
    })
    try {
      expect((await post(authorityPath, authorityBody, {})).status).toBe(403)
      expect((await post(authorityPath, authorityBody, { 'x-service-token': 'wrong', 'x-service-principal': 'research-orchestrator' })).status).toBe(403)
      expect((await post(authorityPath, authorityBody, { 'x-service-token': 'service-secret', 'x-service-principal': 'human-pi' })).status).toBe(403)
      expect((await post(authorityPath, authorityBody, { 'x-service-token': 'service-secret', 'x-service-principal': 'research-orchestrator' })).status).toBe(403)
      const admitted = await post(authorityPath, authorityBody, {
        'x-service-token': 'service-secret', 'x-service-principal': 'research-orchestrator',
        'x-orchestrator-token': 'orchestrator-secret',
      })
      expect(admitted.status).toBe(200)
      const authority = await admitted.json() as { authority_sha256: string }
      expect(authority.authority_sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(kernel.listCorpusSnapshots(project.project_id)).toHaveLength(0)
      expect(kernel.getProject(project.project_id)).toMatchObject({ status: 'SCOPED', revision: scoped.revision })

      const body = JSON.stringify({
        expected_project_revision: scoped.revision,
        action_id: action.id,
        action_revision: action.revision,
        expected_authority_sha256: authority.authority_sha256,
        idempotency_key: 'survey-http-action',
        result: fullAutoSurveyResult(project.brief.problem),
      })
      expect((await post(path, body, {})).status).toBe(403)
      expect((await post(path, body, { 'x-service-token': 'wrong', 'x-service-principal': 'research-orchestrator' })).status).toBe(403)
      expect((await post(path, body, { 'x-service-token': 'service-secret', 'x-service-principal': 'human-pi' })).status).toBe(403)
      expect((await post(path, body, { 'x-service-token': 'service-secret', 'x-service-principal': 'research-orchestrator' })).status).toBe(403)
      const executed = await post(path, body, {
        'x-service-token': 'service-secret', 'x-service-principal': 'research-orchestrator',
        'x-orchestrator-token': 'orchestrator-secret',
      })
      expect(executed.status).toBe(200)
      expect(await executed.json()).toMatchObject({
        project: { project_id: project.project_id, status: 'SURVEYING' },
        receipt: { authority: 'full_auto_service', action: { id: action.id, code: 'survey_run' } },
      })
      expect(kernel.listCorpusSnapshots(project.project_id)).toHaveLength(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })
})
