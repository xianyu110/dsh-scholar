/**
 * Research Kernel unit tests: state machine CAS, gates/decisions, CAS
 * artifacts, durable jobs with idempotency + leases + recovery, claims,
 * manuscript determinism (design §11.1, §11.2).
 */
import { describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
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

/** Assert a KernelError with an exact HTTP status + error code. */
function expectKernelError(fn: () => unknown, status: number, code: string): void {
  try {
    fn()
    throw new Error('expected KernelError to be thrown')
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError)
    expect((error as KernelError).status).toBe(status)
    expect((error as KernelError).code).toBe(code)
  }
}

/**
 * §12.7 signing helper mirroring the runner-gateway contract exactly:
 * payload_sha256 = sha256(canonicalJson(manifest)) BEFORE the envelope is
 * attached; the Ed25519 signature covers canonicalJson(manifest +
 * runner_key_id + payload_sha256); canonicalJson sorts top-level keys.
 * (Uses crypto.sign(null, …) — createSign('ed25519') is rejected on Node ≥ 24.)
 */
function signManifest(manifest: Record<string, unknown>, privateKey: KeyObject, keyId: string): Record<string, unknown> {
  const canonical = (m: Record<string, unknown>): string => JSON.stringify(m, Object.keys(m).sort())
  const payloadSha256 = createHash('sha256').update(canonical(manifest)).digest('hex')
  const signed = { ...manifest, runner_key_id: keyId, payload_sha256: payloadSha256 }
  const signature = sign(null, Buffer.from(canonical(signed), 'utf8'), privateKey).toString('base64')
  return { ...signed, signature }
}

/** A realistic manifest payload (with a nested `resources` object). */
function makeManifest(job: { job_id: string; project_id: string }, metricsArtifact: string): Record<string, unknown> {
  return {
    run_id: 'run_test_1',
    job_id: job.job_id,
    project_id: job.project_id,
    code_commit: 'abc123',
    command: ['python', 'train.py', '--seed', '11'],
    resources: { gpu: 1, cpu: 8, memory_gb: 32 },
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T01:00:00.000Z',
    exit_code: 0,
    metrics_artifact: metricsArtifact,
    log_artifact: metricsArtifact,
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

describe('§12.6 lease fencing (SCH-JOB-001)', () => {
  it('claim returns lease_owner/lease_generation/lease_token; generation bumps on re-claim', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    kernel.submitJob({ project_id: project.project_id, idempotency_key: 'f1', kind: 'smoke' })
    const [first] = kernel.claimJobs('runner-1', 1, 8)
    expect(first?.lease_owner).toBe('runner-1')
    expect(first?.lease_generation).toBe(1)
    expect(first?.lease_token).toMatch(/^lt_/)
    // The opaque token must not leak into the public payload.
    expect(JSON.stringify(first?.payload ?? {})).not.toContain('__lease_token')
    // Expire + re-claim: generation advances, token rotates.
    expect(kernel.recoverExpiredLeases(Date.now() + 5000)).toBe(1)
    const [second] = kernel.claimJobs('runner-1', 60, 8)
    expect(second?.lease_generation).toBe(2)
    expect(second?.lease_token).not.toBe(first?.lease_token)
    kernel.close()
  })

  it('stale-runner-fencing-token-rejected: old generation/token cannot complete the job', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'f2', kind: 'smoke' })
    const [claim1] = kernel.claimJobs('runner-1', 1, 8)
    expect(kernel.recoverExpiredLeases(Date.now() + 5000)).toBe(1)
    // The SAME runner re-claims: old process still holds generation 1 + token 1.
    const [claim2] = kernel.claimJobs('runner-1', 60, 8)
    expect(claim2?.lease_generation).toBe(2)
    // Old credentials -> 409 lease_stale (owner matches, generation/token stale).
    expectKernelError(
      () => kernel.completeJob({
        job_id: job.job_id, owner: 'runner-1', status: 'succeeded',
        lease_generation: claim1?.lease_generation ?? 0, lease_token: claim1?.lease_token ?? '',
      }),
      409, 'lease_stale',
    )
    // Job must still be running — the stale completion changed nothing.
    expect(kernel.getJob(job.job_id).status).toBe('running')
    // Current credentials -> success.
    const done = kernel.completeJob({
      job_id: job.job_id, owner: 'runner-1', status: 'succeeded',
      lease_generation: claim2?.lease_generation ?? 0, lease_token: claim2?.lease_token ?? '',
    })
    expect(done.status).toBe('succeeded')
    kernel.close()
  })

  it('stale heartbeat is rejected with 409 lease_stale; current token renews', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'f3', kind: 'smoke' })
    const [claim1] = kernel.claimJobs('runner-1', 1, 8)
    expect(kernel.recoverExpiredLeases(Date.now() + 5000)).toBe(1)
    const [claim2] = kernel.claimJobs('runner-1', 60, 8)
    expectKernelError(
      () => kernel.heartbeatJob(job.job_id, 'runner-1', claim1?.lease_generation ?? 0, claim1?.lease_token ?? ''),
      409, 'lease_stale',
    )
    const heartbeated = kernel.heartbeatJob(job.job_id, 'runner-1', claim2?.lease_generation ?? 0, claim2?.lease_token ?? '')
    expect(heartbeated.heartbeat_at).not.toBeNull()
    kernel.close()
  })

  it('legacy heartbeat/complete without generation/token keep the owner-only check', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'f4', kind: 'smoke' })
    kernel.claimJobs('runner-1', 60, 8)
    expect(kernel.heartbeatJob(job.job_id, 'runner-1').heartbeat_at).not.toBeNull()
    const done = kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', status: 'succeeded' })
    expect(done.status).toBe('succeeded')
    kernel.close()
  })
})

describe('§12.7 manifest signature (SCH-MANIFEST-001)', () => {
  function signedJobSetup(overrides: { requireSignedManifest?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-kernel-sig-'))
    const kernel = new ResearchKernel({
      dbPath: join(dir, 'kernel.db'),
      casRoot: join(dir, 'cas'),
      requireSignedManifest: overrides.requireSignedManifest,
    })
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const metrics = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: JSON.stringify({ metrics: [{ metric: 'm', value: 1, seed: 1 }] }) })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 's1', kind: 'formal', payload: {} })
    kernel.claimJobs('runner-1', 60, 8)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const keyId = 'runner-key-test-1'
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    kernel.registerRunnerKey({ key_id: keyId, public_key_pem: publicPem })
    return { kernel, job, metrics, privateKey, keyId }
  }

  it('manifest-signature-invalid-rejected: forged signature -> 422; valid signature -> succeeded', () => {
    const { kernel, job, metrics, privateKey, keyId } = signedJobSetup()
    const canonical = (m: Record<string, unknown>): string => JSON.stringify(m, Object.keys(m).sort())
    // Attacker tamper: payload_sha256 is honestly recomputed over the mutated
    // payload (hash check passes), but the signature still covers the ORIGINAL
    // payload -> the Ed25519 verification must fail.
    const forged = signManifest(makeManifest(job, metrics.artifact_id), privateKey, keyId)
    forged.exit_code = 1
    // Recompute the hash over the payload ONLY (envelope fields excluded),
    // exactly like the kernel does — the signature still covers the original.
    const { signature: _sig, runner_key_id: _rid, payload_sha256: _ph, ...payloadOnly } = forged
    forged.payload_sha256 = createHash('sha256').update(canonical(payloadOnly)).digest('hex')
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', status: 'succeeded', run_manifest: forged }),
      422, 'manifest_signature_invalid',
    )
    expect(kernel.getJob(job.job_id).status).toBe('running')
    // A signature made with a DIFFERENT key is also invalid.
    const otherKey = generateKeyPairSync('ed25519')
    const crossSigned = signManifest(makeManifest(job, metrics.artifact_id), otherKey.privateKey, keyId)
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', status: 'succeeded', run_manifest: crossSigned }),
      422, 'manifest_signature_invalid',
    )
    // Correct signature -> accepted.
    const good = signManifest(makeManifest(job, metrics.artifact_id), privateKey, keyId)
    const done = kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', status: 'succeeded', run_manifest: good })
    expect(done.status).toBe('succeeded')
    expect(done.run_manifest?.signature).toBe(good.signature)
    kernel.close()
  })

  it('payload_sha256 mismatch is rejected even with a valid signature', () => {
    const { kernel, job, metrics, privateKey, keyId } = signedJobSetup()
    const signed = signManifest(makeManifest(job, metrics.artifact_id), privateKey, keyId)
    signed.payload_sha256 = '0'.repeat(64)
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', status: 'succeeded', run_manifest: signed }),
      422, 'manifest_hash_mismatch',
    )
    kernel.close()
  })

  it('signature referencing an unregistered runner key -> 422 manifest_key_unknown', () => {
    const { kernel, job, metrics, privateKey } = signedJobSetup()
    const signed = signManifest(makeManifest(job, metrics.artifact_id), privateKey, 'runner-key-never-registered')
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', status: 'succeeded', run_manifest: signed }),
      422, 'manifest_key_unknown',
    )
    kernel.close()
  })

  it('registerRunnerKey rejects non-Ed25519 keys', () => {
    const kernel = freshKernel()
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    expectKernelError(
      () => kernel.registerRunnerKey({ key_id: 'rsa-key', public_key_pem: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString() }),
      422, 'runner_key_invalid',
    )
    expectKernelError(
      () => kernel.registerRunnerKey({ key_id: 'garbage', public_key_pem: 'not a pem' }),
      422, 'runner_key_invalid',
    )
    kernel.close()
  })

  it('requireSignedManifest (kernel option) rejects unsigned manifests', () => {
    const { kernel, job } = signedJobSetup({ requireSignedManifest: true })
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', status: 'succeeded', run_manifest: { run_id: 'run_x', exit_code: 0 } }),
      422, 'manifest_signature_required',
    )
    kernel.close()
  })

  it('project integrity require_signed_manifest rejects unsigned manifests', () => {
    const { kernel, job } = signedJobSetup()
    // Flag stored on the project's integrity record (raw JSON, read verbatim).
    kernel.db.prepare('UPDATE projects SET integrity = ? WHERE project_id = ?')
      .run(JSON.stringify({ require_signed_manifest: true }), job.project_id)
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', status: 'succeeded', run_manifest: { run_id: 'run_x', exit_code: 0 } }),
      422, 'manifest_signature_required',
    )
    kernel.close()
  })

  it('manifest job/project identity mismatch is rejected', () => {
    const { kernel, job, metrics } = signedJobSetup()
    const manifest = makeManifest(job, metrics.artifact_id)
    manifest.job_id = 'job_some_other'
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', status: 'succeeded', run_manifest: manifest }),
      422, 'manifest_job_mismatch',
    )
    kernel.close()
  })

  it('manifest lease generation mismatch is rejected (fencing inside the manifest)', () => {
    const { kernel, job, metrics, privateKey, keyId } = signedJobSetup()
    const manifest = makeManifest(job, metrics.artifact_id)
    manifest.lease = { generation: 99 }
    const signed = signManifest(manifest, privateKey, keyId)
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', status: 'succeeded', run_manifest: signed }),
      422, 'manifest_lease_mismatch',
    )
    kernel.close()
  })
})
