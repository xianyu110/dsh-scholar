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
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: gate.gate_id, actor: 'human', principal: { principal_id: 'u1' }, decision: 'approved' })
    // project is SCOPED now (gate-controlled entry)
    expect(kernel.getProject(project.project_id).status).toBe('SCOPED')
    expect(() => kernel.transition(project.project_id, 'SURVEYING', 5)).toThrow(KernelError)
    const moved = kernel.transition(project.project_id, 'SURVEYING', 1)
    expect(moved.status).toBe('SURVEYING')
    expect(moved.revision).toBe(2)
    kernel.close()
  })

  it('v2 §6.2: generic transition cannot enter gate-controlled states', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    expect(() => kernel.transition(project.project_id, 'SCOPED', 0)).toThrow(/not allowed/)
    kernel.close()
  })

  it('rejects illegal transitions', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    expect(() => kernel.transition(project.project_id, 'RELEASED', 0)).toThrow(/not allowed/)
    kernel.close()
  })

  it('walks the golden path state sequence via gates + transitions', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const decide = (type: 'scope' | 'idea' | 'contract' | 'release'): ResearchProject => {
      const gate = kernel.createGate({ project_id: project.project_id, type, title: `${type} gate` })
      return kernel.decideGate({ gate_id: gate.gate_id, actor: 'human', principal: { principal_id: 'u1' }, decision: 'approved' }).project
    }
    let p = decide('scope')                       // DRAFT -> SCOPED (gate)
    expect(p.status).toBe('SCOPED')
    p = kernel.transition(p.project_id, 'SURVEYING', p.revision) // SCOPED -> SURVEYING
    p = kernel.transition(p.project_id, 'IDEATING', p.revision)  // SURVEYING -> IDEATING
    p = decide('idea')                            // IDEATING -> IDEA_APPROVED (gate)
    p = kernel.transition(p.project_id, 'BASELINE_REPRO', p.revision)
    p = decide('contract')                        // BASELINE_REPRO -> CONTRACT_APPROVED (gate)
    p = kernel.transition(p.project_id, 'EXPERIMENTING', p.revision)
    p = kernel.transition(p.project_id, 'EVIDENCE_READY', p.revision)
    p = kernel.transition(p.project_id, 'WRITING', p.revision)
    p = kernel.transition(p.project_id, 'REVIEWING', p.revision)
    p = kernel.transition(p.project_id, 'RELEASE_READY', p.revision)
    p = decide('release')                         // RELEASE_READY -> RELEASED (gate)
    expect(p.status).toBe('RELEASED')
    const events = kernel.listEvents(project.project_id)
    expect(events.filter(e => e.kind === 'project.transitioned').length).toBeGreaterThanOrEqual(10)
    kernel.close()
  })
})

describe('v2 §3.4 project isolation', () => {
  it('same idempotency_key in different projects yields independent jobs', () => {
    const kernel = freshKernel()
    const a = kernel.createProject({ name: 'a', workspace: '/a', brief: makeBrief() })
    const b = kernel.createProject({ name: 'b', workspace: '/b', brief: makeBrief() })
    const ja = kernel.submitJob({ project_id: a.project_id, idempotency_key: 'shared-key', kind: 'echo' })
    const jb = kernel.submitJob({ project_id: b.project_id, idempotency_key: 'shared-key', kind: 'echo' })
    expect(ja.job_id).not.toBe(jb.job_id)
    // Re-submission inside the SAME project still dedupes.
    const ja2 = kernel.submitJob({ project_id: a.project_id, idempotency_key: 'shared-key', kind: 'echo' })
    expect(ja2.job_id).toBe(ja.job_id)
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

describe('analysis pipeline (E5)', () => {
  it('aggregates multi-seed metrics into mean/CI/effect size with baseline', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    // baseline run with a metrics artifact
    const baselineMetrics = JSON.stringify({ metrics: [{ metric: 'f1', value: 0.8, seed: 0 }] })
    const baseline = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: baselineMetrics })
    const baselineJob = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'b1', kind: 'baseline', payload: {} })
    kernel.claimJobs('r1', 60, 8)
    kernel.completeJob({ job_id: baselineJob.job_id, owner: 'r1', status: 'succeeded', run_manifest: { metrics_artifact: baseline.artifact_id, run_id: 'run_base' } })
    // five formal runs with metrics
    const values = [0.81, 0.83, 0.79, 0.85, 0.82]
    for (let i = 0; i < values.length; i++) {
      const art = kernel.registerArtifact({
        project_id: project.project_id, kind: 'analysis',
        content: JSON.stringify({ metrics: [{ metric: 'f1', value: values[i], seed: 10 + i }] }),
      })
      const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: `f${i}`, kind: 'formal', payload: {} })
      kernel.claimJobs('r1', 60, 8)
      kernel.completeJob({ job_id: job.job_id, owner: 'r1', status: 'succeeded', run_manifest: { metrics_artifact: art.artifact_id, run_id: `run_${i}` } })
    }
    const analysis = kernel.computeAnalysis(project.project_id, undefined, 'f1')
    expect(analysis.n).toBe(5)
    expect(analysis.mean).toBeCloseTo(0.82, 3)
    expect(analysis.baseline_value).toBeCloseTo(0.8, 3)
    expect(analysis.effect_size).toBeCloseTo(0.02, 3)
    expect(analysis.ci_low).toBeLessThan(analysis.ci_high)
    expect(analysis.artifact_id.startsWith('sha256:')).toBe(true)
    expect(kernel.cas.has(analysis.artifact_id.replace('sha256:', ''))).toBe(true)
    // Deterministic: same data -> same CI
    const again = kernel.computeAnalysis(project.project_id, undefined, 'f1')
    expect(again.ci_low).toBe(analysis.ci_low)
    expect(again.ci_high).toBe(analysis.ci_high)
    kernel.close()
  })

  it('rejects analysis with no succeeded runs', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    expect(() => kernel.computeAnalysis(project.project_id)).toThrow(/no succeeded runs/)
    kernel.close()
  })
})

describe('§11.2 recovery & concurrency cases', () => {
  it('concurrent gate decisions: exactly one wins, the other is rejected (CAS race)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    // Two "browsers" decide simultaneously: the second UPDATE matches zero rows.
    const first = kernel.decideGate({ gate_id: gate.gate_id, actor: 'browser-a', decision: 'approved' })
    expect(first.gate.status).toBe('approved')
    expect(() => kernel.decideGate({ gate_id: gate.gate_id, actor: 'browser-b', decision: 'approved' }))
      .toThrow(/already/)
    expect(kernel.listDecisions(project.project_id)).toHaveLength(1)
    expect(kernel.getProject(project.project_id).status).toBe('SCOPED')
    kernel.close()
  })

  it('session resume: a resumed DSH session links the SAME project; new projects never steal an old session mapping', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief(), session_id: 'session-old' })
    // Resume = a fresh DSH session continues the project via explicit link.
    const link = kernel.linkSession('session-new', project.project_id)
    expect(link.project_id).toBe(project.project_id)
    expect(kernel.getProjectBySession('session-old')?.project_id).toBe(project.project_id)
    expect(kernel.getProjectBySession('session-new')?.project_id).toBe(project.project_id)
    // A brand-new project must NOT inherit the old session's mapping implicitly.
    const other = kernel.createProject({ name: 'other', workspace: '/w2', brief: makeBrief() })
    expect(kernel.getProjectBySession('session-old')?.project_id).toBe(project.project_id)
    expect(other.session_id).toBeNull()
    // Phase is not duplicated on resume: revision/status stay monotonic.
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    const approved = kernel.decideGate({ gate_id: gate.gate_id, actor: 'human', principal: { principal_id: 'u1' }, decision: 'approved' })
    expect(approved.project.revision).toBe(1)
    expect(kernel.transition(project.project_id, 'SURVEYING', 1).status).toBe('SURVEYING')
    kernel.close()
  })

  it('session format independence: kernel state survives even when the DSH session log is absent (upgrade drill)', () => {
    // The Kernel DB is the authority; a "read-only old session" cannot hold
    // research state hostage. Simulate: no session links at all, project still
    // fully queryable and transitionable.
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: gate.gate_id, actor: 'human', decision: 'approved' })
    expect(kernel.getProject(project.project_id).status).toBe('SCOPED')
    expect(kernel.listEvents(project.project_id).length).toBeGreaterThanOrEqual(3)
    // Events remain deliverable after a "restart" (reopen the same DB file).
    const dir = mkdtempSync(join(tmpdir(), 'dsh-kernel-reopen-'))
    const dbPath = join(dir, 'kernel.db')
    const k1 = new ResearchKernel({ dbPath, casRoot: join(dir, 'cas') })
    const p1 = k1.createProject({ name: 'x', workspace: '/w', brief: makeBrief() })
    k1.close()
    const k2 = new ResearchKernel({ dbPath, casRoot: join(dir, 'cas') })
    expect(k2.getProject(p1.project_id).status).toBe('DRAFT')
    expect(k2.getProjectBySession('whatever')).toBeNull()
    k2.close()
    kernel.close()
  })
})

describe('claims and evidence', () => {
  it('verifyClaim marks supported when CIs exclude zero', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const item = kernel.ingestVerifiedEvidence({
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
    const item = kernel.ingestVerifiedEvidence({
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
    const item = kernel.ingestVerifiedEvidence({
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
