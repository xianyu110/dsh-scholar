/**
 * Research Kernel unit tests: state machine CAS, gates/decisions, CAS
 * artifacts, durable jobs with idempotency + leases + recovery, claims,
 * manuscript determinism (design §11.1, §11.2).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, KernelError } from '@dsh-scholar/research-kernel'
import { fixtureCorpus, fixtureIdea } from '@dsh-scholar/research-schemas'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kernel-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas') })
}

function makeBrief(overrides: Record<string, unknown> = {}) {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml', ...overrides,
  }
}

describe('project state machine', () => {
  it('creates DRAFT projects with revision 0 and links sessions', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief(), session_id: 's1' })
    expect(project.status).toBe('DRAFT')
    expect(project.revision).toBe(0)
    expect(kernel.getProjectBySession('s1')?.project_id).toBe(project.project_id)
    kernel.close()
  })

  it('transitions only with matching expected_revision (CAS)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    expect(() => kernel.transition(project.project_id, 'SCOPED', 5)).toThrow(KernelError)
    const moved = kernel.transition(project.project_id, 'SCOPED', 0)
    expect(moved.status).toBe('SCOPED')
    expect(moved.revision).toBe(1)
    kernel.close()
  })

  it('rejects illegal transitions', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    expect(() => kernel.transition(project.project_id, 'RELEASED', 0)).toThrow(/not allowed/)
    kernel.close()
  })

  it('walks the golden path state sequence', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const seq = ['SCOPED', 'SURVEYING', 'IDEATING', 'IDEA_APPROVED', 'BASELINE_REPRO', 'CONTRACT_APPROVED', 'EXPERIMENTING', 'EVIDENCE_READY', 'WRITING', 'REVIEWING', 'RELEASE_READY', 'RELEASED']
    let rev = 0
    for (const to of seq) {
      const next = kernel.transition(project.project_id, to, rev)
      expect(next.status).toBe(to)
      rev = next.revision
    }
    const events = kernel.listEvents(project.project_id)
    expect(events.filter(e => e.kind === 'project.transitioned')).toHaveLength(seq.length)
    kernel.close()
  })
})

describe('gates and decisions', () => {
  it('scope gate approval moves DRAFT→SCOPED and records the decision', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief(), session_id: 's' })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope', session_id: 's' })
    const { gate: decided, decision, project: updated } = kernel.decideGate({
      gate_id: gate.gate_id, actor: 'human', decision: 'approved', reason: 'looks good', session_id: 's', event_id: 'evt_x',
    })
    expect(decided.status).toBe('approved')
    expect(decision.actor).toBe('human')
    expect(decision.session_id).toBe('s')
    expect(updated.status).toBe('SCOPED')
    const decisions = kernel.listDecisions(project.project_id)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.reason).toBe('looks good')
    kernel.close()
  })

  it('double decisions are rejected', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: gate.gate_id, actor: 'a', decision: 'approved' })
    expect(() => kernel.decideGate({ gate_id: gate.gate_id, actor: 'b', decision: 'approved' }))
      .toThrow(/already/)
    kernel.close()
  })

  it('budget overrun parks the project in BLOCKED_GATE with a policy event', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({
      name: 't', workspace: '/w', brief: makeBrief(),
      constraints: { max_model_cost_usd: 100, max_gpu_hours: 10, max_parallel_jobs: 2 },
    })
    kernel.recordUsage(project.project_id, { model_cost_usd: 150 })
    expect(kernel.getProject(project.project_id).status).toBe('BLOCKED_GATE')
    const violations = kernel.listEvents(project.project_id).filter(e => e.kind === 'policy.violation')
    expect(violations).toHaveLength(1)
    kernel.close()
  })
})

describe('artifact CAS', () => {
  it('stores content-addressed blobs and dedupes', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const a1 = kernel.registerArtifact({ project_id: project.project_id, kind: 'log', content: 'hello world' })
    const a2 = kernel.registerArtifact({ project_id: project.project_id, kind: 'log', content: 'hello world' })
    expect(a1.artifact_id).toBe(a2.artifact_id) // content-addressed dedup
    expect(a1.artifact_id.startsWith('sha256:')).toBe(true)
    expect(kernel.cas.read(a1.sha256).toString()).toBe('hello world')
    expect(kernel.cas.has(a1.sha256)).toBe(true)
    expect(kernel.verifyArtifactRefs([a1.artifact_id]).ok).toBe(true)
    expect(kernel.verifyArtifactRefs(['sha256:' + '0'.repeat(64)]).ok).toBe(false)
    kernel.close()
  })
})

describe('durable jobs', () => {
  it('submission is idempotent by idempotency_key', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const j1 = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k1', kind: 'echo' })
    const j2 = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k1', kind: 'echo' })
    expect(j1.job_id).toBe(j2.job_id)
    kernel.close()
  })

  it('leases: claim → heartbeat → complete with manifest hash verification', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k2', kind: 'smoke' })
    const claimed = kernel.claimJobs('runner-1', 60, 8)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.status).toBe('running')
    expect(claimed[0]?.lease_owner).toBe('runner-1')
    const heartbeated = kernel.heartbeatJob(job.job_id, 'runner-1')
    expect(heartbeated.heartbeat_at).not.toBeNull()
    // Manifest referencing a missing artifact must be rejected.
    expect(() => kernel.completeJob({
      job_id: job.job_id, owner: 'runner-1', status: 'succeeded',
      run_manifest: { metrics_artifact: 'sha256:' + 'a'.repeat(64) },
    })).toThrow(/missing artifacts/)
    kernel.close()
  })

  it('expired leases recover to retryable and re-claim without duplication', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k3', kind: 'echo' })
    const claimed = kernel.claimJobs('runner-a', 1, 8)
    expect(claimed[0]?.status).toBe('running')
    // Let the lease expire (1s TTL), then recover.
    const recovered = kernel.recoverExpiredLeases(Date.now() + 5000)
    expect(recovered).toBe(1)
    const job = kernel.getJob(claimed[0]!.job_id)
    expect(job.status).toBe('retryable')
    expect(job.attempts).toBe(1)
    const reClaimed = kernel.claimJobs('runner-b', 60, 8)
    expect(reClaimed).toHaveLength(1)
    expect(reClaimed[0]?.lease_owner).toBe('runner-b')
    expect(reClaimed[0]?.attempts).toBe(2)
    kernel.close()
  })

  it('foreign lease owners cannot complete jobs', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k4', kind: 'echo' })
    const [claimed] = kernel.claimJobs('runner-a', 60, 8)
    expect(() => kernel.completeJob({ job_id: claimed!.job_id, owner: 'intruder', status: 'succeeded' }))
      .toThrow(/lease/)
    kernel.close()
  })
})

describe('claims and evidence', () => {
  it('verifyClaim marks supported when CIs exclude zero', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const item = kernel.ingestEvidence({
      project_id: project.project_id, source_type: 'run', run_ids: ['r1'], artifact_refs: ['sha256:' + 'b'.repeat(64)],
      analysis_method: 'bootstrap_95', result: { primary_metric: 'f1', value: 0.9, baseline_value: 0.8, effect_size: 0.1, ci_low: 0.02, ci_high: 0.18, n_seeds: 5 },
    })
    const claim = kernel.createClaim({ project_id: project.project_id, statement: 'A improves B' })
    const verified = kernel.verifyClaim({ claim_id: claim.claim_id, evidence_ids: [item.evidence_id] })
    expect(verified.status).toBe('supported')
    expect(verified.history.at(-1)?.status).toBe('supported')
    kernel.close()
  })

  it('verifyClaim marks contradicted on negative effects', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const item = kernel.ingestEvidence({
      project_id: project.project_id, source_type: 'run', run_ids: ['r1'], artifact_refs: [],
      analysis_method: 'bootstrap_95', result: { primary_metric: 'f1', value: 0.7, baseline_value: 0.8, effect_size: -0.1, ci_low: -0.18, ci_high: -0.02, n_seeds: 5 },
    })
    const claim = kernel.createClaim({ project_id: project.project_id, statement: 'A improves B' })
    expect(kernel.verifyClaim({ claim_id: claim.claim_id, evidence_ids: [item.evidence_id] }).status).toBe('contradicted')
    kernel.close()
  })

  it('verifyClaim rejects missing evidence', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const claim = kernel.createClaim({ project_id: project.project_id, statement: 'x' })
    expect(() => kernel.verifyClaim({ claim_id: claim.claim_id, evidence_ids: ['nope'] })).toThrow(/no resolvable evidence/)
    kernel.close()
  })
})

describe('corpus + ideas + manuscript', () => {
  it('snapshots corpus and builds deterministic manuscripts from the ledger', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const corpus = fixtureCorpus(project.project_id)
    const snapshot = kernel.snapshotCorpus({
      project_id: project.project_id, queries: corpus.queries, papers: corpus.papers,
    })
    expect(snapshot.frozen).toBe(true)
    expect(kernel.listCorpusSnapshots(project.project_id)).toHaveLength(1)

    const idea = fixtureIdea(project.project_id)
    const card = kernel.createIdea({
      project_id: project.project_id, title: idea.title, hypothesis: idea.hypothesis,
      scientific_gap: idea.scientific_gap, nearest_prior_works: idea.nearest_prior_works,
      exact_delta: idea.exact_delta, falsification: idea.falsification,
      minimum_viable_experiment: idea.minimum_viable_experiment, scores: idea.scores,
    })
    expect(kernel.getIdea(card.idea_id).status).toBe('proposed')

    const analysis = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: JSON.stringify({ f1: 0.9 }) })
    const item = kernel.ingestEvidence({
      project_id: project.project_id, source_type: 'run', run_ids: ['r1', 'r2'], artifact_refs: [analysis.artifact_id],
      analysis_method: 'bootstrap_95', result: { primary_metric: 'f1', value: 0.9, baseline_value: 0.8, effect_size: 0.1, ci_low: 0.02, ci_high: 0.18, n_seeds: 2 },
    })
    const claim = kernel.createClaim({ project_id: project.project_id, statement: 'A improves B', scope: { dataset: 'd', split: 'test' } })
    kernel.verifyClaim({ claim_id: claim.claim_id, evidence_ids: [item.evidence_id], analysis_artifact: analysis.artifact_id })

    const draft = kernel.buildManuscript(project.project_id, 'markdown', true)
    expect(draft.text).toContain('# t')
    expect(draft.text).toContain('A improves B')
    expect(draft.artifact_id.startsWith('sha256:')).toBe(true)
    expect(kernel.manuscriptReview(project.project_id).pass).toBe(true)

    const bundle = kernel.releaseBundle(project.project_id)
    expect(bundle.release_gate).toBe('unapproved')
    kernel.close()
  })
})
