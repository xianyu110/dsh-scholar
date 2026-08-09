/**
 * Research Kernel unit tests: state machine CAS, gates/decisions, CAS
 * artifacts, durable jobs with idempotency + leases + recovery, claims,
 * manuscript determinism (design §11.1, §11.2), §11.3 code-snapshot archive
 * + §12.2 JobSpec binding + §12.5 metrics-file parsing (SCH-EXEC-002).
 */
import { describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, KernelError } from '@dsh-scholar/research-kernel'
import { fixtureCorpus, fixtureIdea } from '@dsh-scholar/research-schemas'
import { materializeCodeSnapshot, unpackCodeSnapshot } from '@dsh-scholar/runner-gateway'

/** P0 (acceptance-tests.md §4): the exact digests pinned by configs/runner-profiles/images.lock.json. */
const NODE_IMAGE_DIGEST = 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
const TEXLIVE_IMAGE_DIGEST = 'texlive/texlive@sha256:8957c916b8160049f89c24d362a6d86c09d8a04095acde37e88404c4afed85b4'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-kernel-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas') })
}

/** Register a minimal valid §11.3 code-snapshot archive artifact. */
function codeArtifact(kernel: ResearchKernel, projectId: string): import('@dsh-scholar/research-schemas').ArtifactRecord {
  const content = Buffer.from('console.log("train")\n')
  return kernel.registerArtifact({
    project_id: projectId,
    kind: 'code',
    content: JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      files: {
        'train.js': { sha256: createHash('sha256').update(content).digest('hex'), content_base64: content.toString('base64') },
      },
      excludes: ['.git', 'node_modules', '.research-cas'],
    }),
    metadata: { kind: 'code-snapshot-archive' },
  })
}

function makeBrief(overrides: Record<string, unknown> = {}) {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml', ...overrides,
  }
}

/** Assert a KernelError with an exact HTTP status + error code. */
/** P0: register + freeze an approved contract for secure-kind job tests. */
function approvedContract(kernel: ResearchKernel, projectId: string): string {
  const contract = kernel.registerContract({
    project_id: projectId,
    idea_id: 'idea_x', data: { dataset_id: 'd', version: 'v1' }, methods: { baseline: 'b', treatment: 'a' },
    metrics: { primary: 'f1', secondary: [] }, seeds: [1, 2], analysis: {},
    ablations: [], stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 1, stop_on_data_leakage: true },
  })
  kernel.approveContract(contract.contract_id, 'dec_test_gate', 'test-pi')
  return contract.contract_id
}

/** P0: current lease fencing fields of a job (generation, token). */
function fenceArgs(kernel: ResearchKernel, jobId: string): { lease_generation: number | null; lease_token: string | null } {
  const j = kernel.getJob(jobId)
  return { lease_generation: j.lease_generation, lease_token: j.lease_token }
}
function fencePair(kernel: ResearchKernel, jobId: string): [number | null, string | null] {
  const j = kernel.getJob(jobId)
  return [j.lease_generation, j.lease_token]
}

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

  it('renames a project with audit history and revision bump', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'old-name', workspace: '/w', brief: makeBrief() })
    const renamed = kernel.renameProject(project.project_id, 'new-name')
    expect(renamed.name).toBe('new-name')
    expect(renamed.revision).toBe(1)
    expect(renamed.history.at(-1)).toBe('renamed to "new-name"')
    expect(kernel.listProjects()[0]!.name).toBe('new-name')
    expect(() => kernel.renameProject(project.project_id, '   ')).toThrow(KernelError)
    kernel.close()
  })

  it('archives and restores a project (data kept, audited)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const archived = kernel.archiveProject(project.project_id)
    expect(archived.status).toBe('ARCHIVED')
    expect(archived.history.at(-1)).toContain('ARCHIVED')
    const restored = kernel.unarchiveProject(project.project_id)
    expect(restored.status).not.toBe('ARCHIVED')
    expect(restored.history.at(-1)).toBe('ARCHIVED->restored')
    // archive is idempotent
    kernel.archiveProject(project.project_id)
    expect(kernel.archiveProject(project.project_id).status).toBe('ARCHIVED')
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
    const heartbeated = kernel.heartbeatJob(job.job_id, 'runner-1', ...fencePair(kernel, job.job_id))
    expect(heartbeated.heartbeat_at).not.toBeNull()
    // Manifest referencing a missing artifact must be rejected.
    expect(() => kernel.completeJob({
      job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded',
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
    expect(() => kernel.completeJob({ job_id: claimed!.job_id, owner: 'intruder', ...fenceArgs(kernel, claimed!.job_id), status: 'succeeded' }))
      .toThrow(/lease/)
    kernel.close()
  })
})

describe('analysis pipeline (E5)', () => {
  it('aggregates multi-seed metrics into mean/CI/effect size with baseline', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    // §13.6 matched-seed design: five baseline runs + five formal runs with
    // the SAME seeds — the analysis engine pairs them by seed.
    const values = [0.81, 0.83, 0.79, 0.85, 0.82]
    for (let i = 0; i < values.length; i++) {
      const seed = 10 + i
      const baseArt = kernel.registerArtifact({
        project_id: project.project_id, kind: 'analysis',
        content: JSON.stringify({ metrics: [{ metric: 'f1', value: 0.8, seed }] }),
      })
      const baseJob = kernel.submitJob({ project_id: project.project_id, idempotency_key: `b${i}`, kind: 'baseline', contract_id: approvedContract(kernel, project.project_id), payload: {}, code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
      kernel.claimJobs('r1', 60, 8)
      kernel.completeJob({ job_id: baseJob.job_id, owner: 'r1', ...fenceArgs(kernel, baseJob.job_id), status: 'succeeded', run_manifest: { metrics_artifact: baseArt.artifact_id, run_id: `run_base_${i}` } })
      const art = kernel.registerArtifact({
        project_id: project.project_id, kind: 'analysis',
        content: JSON.stringify({ metrics: [{ metric: 'f1', value: values[i], seed }] }),
      })
      const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: `f${i}`, kind: 'formal', contract_id: approvedContract(kernel, project.project_id), payload: {}, code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
      kernel.claimJobs('r1', 60, 8)
      kernel.completeJob({ job_id: job.job_id, owner: 'r1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: { metrics_artifact: art.artifact_id, run_id: `run_${i}` } })
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

  it('P0: heartbeat/complete without generation/token are rejected (fail-closed)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'f4', kind: 'smoke' })
    kernel.claimJobs('runner-1', 60, 8)
    expectKernelError(() => kernel.heartbeatJob(job.job_id, 'runner-1'), 409, 'lease_stale')
    expectKernelError(() => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', lease_generation: 99, lease_token: 'wrong-token', status: 'succeeded' }), 409, 'lease_stale')
    const h = kernel.heartbeatJob(job.job_id, 'runner-1', ...fencePair(kernel, job.job_id))
    expect(h.heartbeat_at).not.toBeNull()
    const done = kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded' })
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
    const code = codeArtifact(kernel, project.project_id)
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 's1', kind: 'formal', contract_id: approvedContract(kernel, project.project_id), payload: {}, code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
    kernel.claimJobs('runner-1', 60, 8)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const keyId = 'runner-key-test-1'
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    kernel.registerRunnerKey({ key_id: keyId, public_key_pem: publicPem })
    return { kernel, job, metrics, privateKey, keyId }
  }

  it('RUN-01: require_signed_manifest project rejects unsigned manifests', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({
      name: 't', workspace: '/w', brief: makeBrief(),
      integrity: { require_signed_manifest: true },
    })
    expect(project.integrity.require_signed_manifest).toBe(true)
    const metrics = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: JSON.stringify({ metrics: [{ metric: 'm', value: 1, seed: 1 }] }) })
    const code = codeArtifact(kernel, project.project_id)
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'run01', kind: 'formal', contract_id: approvedContract(kernel, project.project_id), payload: {}, code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
    kernel.claimJobs('runner-1', 60, 8)
    // Unsigned manifest -> rejected with the enforcement code.
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: makeManifest(job, metrics.artifact_id) }),
      422, 'manifest_signature_required',
    )
    expect(kernel.getJob(job.job_id).status).toBe('running')
    // A properly signed manifest is accepted.
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const keyId = 'run01-key'
    kernel.registerRunnerKey({ key_id: keyId, public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString() })
    const signed = signManifest(makeManifest(job, metrics.artifact_id), privateKey, keyId)
    const done = kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: signed })
    expect(done.status).toBe('succeeded')
    kernel.close()
  })

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
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: forged }),
      422, 'manifest_signature_invalid',
    )
    expect(kernel.getJob(job.job_id).status).toBe('running')
    // A signature made with a DIFFERENT key is also invalid.
    const otherKey = generateKeyPairSync('ed25519')
    const crossSigned = signManifest(makeManifest(job, metrics.artifact_id), otherKey.privateKey, keyId)
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: crossSigned }),
      422, 'manifest_signature_invalid',
    )
    // Correct signature -> accepted.
    const good = signManifest(makeManifest(job, metrics.artifact_id), privateKey, keyId)
    const done = kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: good })
    expect(done.status).toBe('succeeded')
    expect(done.run_manifest?.signature).toBe(good.signature)
    kernel.close()
  })

  it('payload_sha256 mismatch is rejected even with a valid signature', () => {
    const { kernel, job, metrics, privateKey, keyId } = signedJobSetup()
    const signed = signManifest(makeManifest(job, metrics.artifact_id), privateKey, keyId)
    signed.payload_sha256 = '0'.repeat(64)
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: signed }),
      422, 'manifest_hash_mismatch',
    )
    kernel.close()
  })

  it('signature referencing an unregistered runner key -> 422 manifest_key_unknown', () => {
    const { kernel, job, metrics, privateKey } = signedJobSetup()
    const signed = signManifest(makeManifest(job, metrics.artifact_id), privateKey, 'runner-key-never-registered')
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: signed }),
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
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: { run_id: 'run_x', exit_code: 0 } }),
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
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: { run_id: 'run_x', exit_code: 0 } }),
      422, 'manifest_signature_required',
    )
    kernel.close()
  })

  it('manifest job/project identity mismatch is rejected', () => {
    const { kernel, job, metrics } = signedJobSetup()
    const manifest = makeManifest(job, metrics.artifact_id)
    manifest.job_id = 'job_some_other'
    expectKernelError(
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: manifest }),
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
      () => kernel.completeJob({ job_id: job.job_id, owner: 'runner-1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: signed }),
      422, 'manifest_lease_mismatch',
    )
    kernel.close()
  })
})

describe('§11.3 code snapshot archive (SCH-EXEC-002)', () => {
  it('archives ACTUAL file contents into a code artifact + manifest artifact', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const dir = mkdtempSync(join(tmpdir(), 'dsh-snap-'))
    mkdirSync(join(dir, 'data'), { recursive: true })
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    mkdirSync(join(dir, '.git', 'objects'), { recursive: true })
    writeFileSync(join(dir, 'train.js'), 'console.log("real code")\n')
    writeFileSync(join(dir, 'data', 'seed.json'), '{"baseline":[1,2]}')
    writeFileSync(join(dir, 'node_modules', 'junk.js'), 'ignored')
    writeFileSync(join(dir, '.git', 'objects', 'pack'), 'ignored')

    const snap = kernel.snapshotCodeArchive(project.project_id, dir, 'unit test snapshot')
    expect(snap.files).toBe(2)
    expect(snap.total_bytes).toBe(Buffer.byteLength('console.log("real code")\n') + Buffer.byteLength('{"baseline":[1,2]}'))
    expect(snap.archive_artifact_id.startsWith('sha256:')).toBe(true)
    expect(snap.manifest_artifact_id.startsWith('sha256:')).toBe(true)
    expect(snap.archive_artifact_id).not.toBe(snap.manifest_artifact_id)
    expect(snap.sha256).toBe(snap.archive_artifact_id.replace('sha256:', ''))

    // The archive artifact really contains the file CONTENT (base64) + hashes.
    const archive = JSON.parse(kernel.cas.read(snap.sha256).toString('utf8')) as {
      schema_version: number
      files: Record<string, { sha256: string; content_base64: string }>
    }
    expect(archive.schema_version).toBe(1)
    expect(Buffer.from(archive.files['train.js']!.content_base64, 'base64').toString()).toBe('console.log("real code")\n')
    expect(archive.files['data/seed.json']!.sha256).toBe(createHash('sha256').update('{"baseline":[1,2]}').digest('hex'))

    // STORE-02: submitJob binds a REGISTRY id (code_snap_…) by resolving it
    // to the archive artifact; the job stores the artifact id the Runner
    // materializes from CAS.
    const bound = kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: 'snap-bound',
      kind: 'baseline',
      contract_id: approvedContract(kernel, project.project_id),
      code_snapshot_id: snap.snapshot_id,
      image_digest: NODE_IMAGE_DIGEST,
    })
    expect(bound.code_snapshot_id).toBe(snap.archive_artifact_id)
    expect(bound.code_snapshot_id).not.toBe(snap.snapshot_id)

    // STORE-02: the authoritative registry row exists and matches.
    const snapRow = kernel.getCodeSnapshot(snap.snapshot_id)
    expect(snapRow.archive_artifact_id).toBe(snap.archive_artifact_id)
    expect(snapRow.manifest_artifact_id).toBe(snap.manifest_artifact_id)
    expect(snapRow.sha256).toBe(snap.sha256)
    expect(snapRow.file_count).toBe(2)
    expect(snapRow.source.description).toBe('unit test snapshot')
    expect(archive.files['node_modules/junk.js']).toBeUndefined()
    expect(archive.files['.git/objects/pack']).toBeUndefined()

    // The manifest artifact carries the file list + hashes WITHOUT content.
    const manifest = JSON.parse(kernel.cas.read(snap.manifest_artifact_id!.replace('sha256:', '')).toString('utf8')) as {
      files: Record<string, { sha256: string }>
    }
    expect(manifest.files['train.js']?.sha256).toBe(archive.files['train.js']!.sha256)
    expect(JSON.stringify(manifest)).not.toContain('content_base64')

    // Events recorded (artifact.registered for both artifacts).
    const registered = kernel.listEvents(project.project_id).filter(e => e.kind === 'artifact.registered')
    expect(registered.filter(e => String(e.payload.kind) === 'code').length).toBe(1)
    expect(registered.filter(e => String(e.payload.kind) === 'manifest').length).toBe(1)
    kernel.close()
  })

  it('rejects symlinks escaping the archived root (path escape protection)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const root = mkdtempSync(join(tmpdir(), 'dsh-snap-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'dsh-snap-outside-'))
    writeFileSync(join(root, 'ok.js'), 'fine')
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'))
    expectKernelError(
      () => kernel.snapshotCodeArchive(project.project_id, root, 'escape test'),
      422, 'snapshot_path_escape',
    )
    // A symlink INSIDE the root is followed and archived (after the escaping
    // symlink is removed).
    rmSync(join(root, 'leak.txt'))
    symlinkSync(join(root, 'ok.js'), join(root, 'alias.js'))
    const snap = kernel.snapshotCodeArchive(project.project_id, root, 'escape test')
    expect(snap.files).toBe(2)
    kernel.close()
  })

  it('rejects a missing root with 422 snapshot_root_missing', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    expectKernelError(
      () => kernel.snapshotCodeArchive(project.project_id, join(tmpdir(), 'does-not-exist-' + Date.now())),
      422, 'snapshot_root_missing',
    )
    kernel.close()
  })
})

describe('§12.2 JobSpec binding (SCH-EXEC-002)', () => {
  it('formal-class jobs REQUIRE code_snapshot_id (422) and validate it', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    expectKernelError(
      () => kernel.submitJob({ project_id: project.project_id, idempotency_key: 'no-snap', kind: 'baseline', contract_id: approvedContract(kernel, project.project_id) }),
      422, 'code_snapshot_required',
    )
    expectKernelError(
      () => kernel.submitJob({ project_id: project.project_id, idempotency_key: 'no-snap2', kind: 'formal', contract_id: approvedContract(kernel, project.project_id) }),
      422, 'code_snapshot_required',
    )
    expectKernelError(
      () => kernel.submitJob({ project_id: project.project_id, idempotency_key: 'no-snap3', kind: 'pilot', contract_id: approvedContract(kernel, project.project_id) }),
      422, 'code_snapshot_required',
    )
    expectKernelError(
      () => kernel.submitJob({ project_id: project.project_id, idempotency_key: 'no-snap4', kind: 'reproduce', contract_id: approvedContract(kernel, project.project_id) }),
      422, 'code_snapshot_required',
    )
    // Unknown snapshot id -> 422 code_snapshot_unknown.
    expectKernelError(
      () => kernel.submitJob({ project_id: project.project_id, idempotency_key: 'bad-snap', kind: 'formal', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: 'sha256:' + 'a'.repeat(64) }),
      422, 'code_snapshot_unknown',
    )
    // A snapshot from ANOTHER project is also unknown here.
    const other = kernel.createProject({ name: 'o', workspace: '/o', brief: makeBrief() })
    const foreignCode = codeArtifact(kernel, other.project_id)
    expectKernelError(
      () => kernel.submitJob({ project_id: project.project_id, idempotency_key: 'foreign-snap', kind: 'formal', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: foreignCode.artifact_id }),
      422, 'code_snapshot_unknown',
    )
    // smoke/echo stay binding-free.
    const smoke = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'smoke-ok', kind: 'smoke', payload: { script: 'echo hi' } })
    expect(smoke.code_snapshot_id).toBeNull()
    kernel.close()
  })

  it('persists code_snapshot_id column + image_digest/output_contract/data_artifact_ids payload', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    const job = kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: 'bound-1',
      kind: 'formal',
      contract_id: approvedContract(kernel, project.project_id),
      code_snapshot_id: code.artifact_id,
      data_artifact_ids: ['sha256:' + 'b'.repeat(64)],
      image_digest: NODE_IMAGE_DIGEST,
      output_contract: { metrics: '/outputs/metrics.json', logs: '/outputs/run.log' },
    })
    expect(job.code_snapshot_id).toBe(code.artifact_id)
    expect(job.image_digest).toBe(NODE_IMAGE_DIGEST)
    expect(job.output_contract?.metrics).toBe('/outputs/metrics.json')
    expect(job.payload.data_artifact_ids).toEqual(['sha256:' + 'b'.repeat(64)])

    // Survives a read-back from the DB (jobFromRow).
    const reloaded = kernel.getJob(job.job_id)
    expect(reloaded.code_snapshot_id).toBe(code.artifact_id)
    expect(reloaded.image_digest).toBe(NODE_IMAGE_DIGEST)
    expect(reloaded.output_contract?.logs).toBe('/outputs/run.log')

    // P0: secure kinds require the trusted images.lock digest — missing input
    // is rejected, never defaulted to a tag; the exact locked digest binds.
    const defaulted = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'bound-2', kind: 'formal', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
    expect(defaulted.image_digest).toBe(NODE_IMAGE_DIGEST)
    kernel.close()
  })
})

describe('P0 image digest lock (acceptance-tests.md §4)', () => {
  it('rejects secure jobs with a missing image_digest (422 image_digest_required)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    for (const kind of ['baseline', 'pilot', 'formal', 'reproduce'] as const) {
      expectKernelError(
        () => kernel.submitJob({ project_id: project.project_id, idempotency_key: `no-digest-${kind}`, kind, contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id }),
        422, 'image_digest_required',
      )
    }
    // An explicitly empty digest counts as missing too.
    expectKernelError(
      () => kernel.submitJob({ project_id: project.project_id, idempotency_key: 'empty-digest', kind: 'formal', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id, image_digest: '' }),
      422, 'image_digest_required',
    )
    kernel.close()
  })

  it('rejects tags, latest and foreign digests (422 image_digest_untrusted)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    // tag / latest / well-formed but NOT the locked entry — all must be 422.
    const untrusted = [
      'node:22-alpine',
      'latest',
      'node:latest',
      'node@sha256:' + '0'.repeat(64),
      'node@sha256:' + 'a'.repeat(63) + 'b',
    ]
    for (const digest of untrusted) {
      expectKernelError(
        () => kernel.submitJob({ project_id: project.project_id, idempotency_key: `untrusted-${digest}`, kind: 'formal', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id, image_digest: digest }),
        422, 'image_digest_untrusted',
      )
    }
    kernel.close()
  })

  it('latex-compile injects the locked texlive digest and rejects explicit mismatches', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\begin{document}hi\\end{document}\n')
    const snap = kernel.texSnapshot(doc.document_id)
    // Explicit tag → rejected (never silently replaced).
    expectKernelError(
      () => kernel.submitJob({ project_id: project.project_id, idempotency_key: 'latex-tag', kind: 'latex-compile', image_digest: 'texlive/texlive:latest', payload: { tex_document_id: doc.document_id, tex_revision: snap.revision } }),
      422, 'image_digest_untrusted',
    )
    // Missing digest → the kernel injects the locked texlive entry (the
    // kernel owns the TeX pipeline; injection is not a "missing digest").
    const injected = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'latex-inject', kind: 'latex-compile', payload: { tex_document_id: doc.document_id, tex_revision: snap.revision } })
    expect(injected.image_digest).toBe(TEXLIVE_IMAGE_DIGEST)
    expect((injected.payload as Record<string, unknown>).image_digest).toBe(TEXLIVE_IMAGE_DIGEST)
    // Exact locked digest → accepted.
    const explicit = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'latex-exact', kind: 'latex-compile', image_digest: TEXLIVE_IMAGE_DIGEST, payload: { tex_document_id: doc.document_id, tex_revision: snap.revision } })
    expect(explicit.image_digest).toBe(TEXLIVE_IMAGE_DIGEST)
    kernel.close()
  })

  it('accepts the exact trusted lock digest (P0 success path)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    for (const kind of ['baseline', 'pilot', 'formal', 'reproduce'] as const) {
      const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: `ok-${kind}`, kind, contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
      expect(job.status).toBe('queued')
      expect(job.image_digest).toBe(NODE_IMAGE_DIGEST)
      expect((job.payload as Record<string, unknown>).image_digest).toBe(NODE_IMAGE_DIGEST)
    }
    kernel.close()
  })
})

describe('§12.5 metrics file + code snapshot unpack (SCH-EXEC-002)', () => {
  it('unpackCodeSnapshot round-trips an archived snapshot and rejects tampering', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const dir = mkdtempSync(join(tmpdir(), 'dsh-unpack-'))
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'train.js'), '#!/usr/bin/env node\nconsole.log("hi")\n')
    writeFileSync(join(dir, 'lib', 'util.js'), 'export const f = 1\n')
    const snap = kernel.snapshotCodeArchive(project.project_id, dir, 'unpack test')

    const archiveText = kernel.cas.read(snap.sha256).toString('utf8')
    const files = unpackCodeSnapshot(archiveText)
    expect(files.size).toBe(2)
    expect(files.get('train.js')?.toString()).toBe('#!/usr/bin/env node\nconsole.log("hi")\n')
    expect(files.get('lib/util.js')?.toString()).toBe('export const f = 1\n')

    // Tampered hash -> integrity failure.
    const tampered = JSON.parse(archiveText) as { files: Record<string, { sha256: string; content_base64: string }> }
    tampered.files['train.js']!.sha256 = '0'.repeat(64)
    expect(() => unpackCodeSnapshot(JSON.stringify(tampered))).toThrow(/integrity mismatch/)

    // Unsupported schema_version -> rejected.
    const bad = JSON.parse(archiveText) as { schema_version: number }
    bad.schema_version = 2
    expect(() => unpackCodeSnapshot(JSON.stringify(bad))).toThrow(/schema_version/)

    // Materialization writes real files into a workdir (runner behavior).
    const workDir = mkdtempSync(join(tmpdir(), 'dsh-materialize-'))
    const count = materializeCodeSnapshot(unpackCodeSnapshot(archiveText), workDir)
    expect(count).toBe(2)
    expect(readFileSync(join(workDir, 'train.js'), 'utf8')).toBe('#!/usr/bin/env node\nconsole.log("hi")\n')
    expect(readFileSync(join(workDir, 'lib', 'util.js'), 'utf8')).toBe('export const f = 1\n')
    kernel.close()
  })

  it('computeAnalysis reads §12.5 fixed-schema metrics artifacts (name/value/unit)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const code = codeArtifact(kernel, project.project_id)
    const fileSchema = (seed: number, value: number) => JSON.stringify({
      schema_version: 1, run_id: `run-${seed}`, contract_id: 'expc_x', seed,
      metrics: [{ name: 'f1', value, unit: 'ratio' }],
    })
    const values = [0.81, 0.83, 0.85]
    for (let i = 0; i < values.length; i++) {
      const seed = 11 + i
      const baseline = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: fileSchema(seed, 0.8) })
      const bJob = kernel.submitJob({ project_id: project.project_id, idempotency_key: `fb${i}`, kind: 'baseline', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
      kernel.claimJobs('r1', 60, 8)
      kernel.completeJob({ job_id: bJob.job_id, owner: 'r1', ...fenceArgs(kernel, bJob.job_id), status: 'succeeded', run_manifest: { metrics_artifact: baseline.artifact_id } })
      const art = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: fileSchema(seed, values[i]!) })
      const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: `ff${i}`, kind: 'formal', contract_id: approvedContract(kernel, project.project_id), code_snapshot_id: code.artifact_id, image_digest: NODE_IMAGE_DIGEST })
      kernel.claimJobs('r1', 60, 8)
      kernel.completeJob({ job_id: job.job_id, owner: 'r1', ...fenceArgs(kernel, job.job_id), status: 'succeeded', run_manifest: { metrics_artifact: art.artifact_id } })
    }
    const analysis = kernel.computeAnalysis(project.project_id, undefined, 'f1')
    expect(analysis.n).toBe(3)
    expect(analysis.mean).toBeCloseTo(0.83, 3)
    expect(analysis.baseline_value).toBeCloseTo(0.8, 3)
    expect(analysis.runs.map(r => r.seed).sort()).toEqual([11, 12, 13])
    kernel.close()
  })
})
