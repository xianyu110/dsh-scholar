/**
 * v2 shape alignment group (final-audit-report.md §4 #9, domain-model.md
 * §5/§6/§8/§9/§16): CorpusSnapshot schema_version + source_status, Passage
 * content hash (new-write required, old-read compatible), IdeaCard
 * corpus_snapshot_id with Idea Gate binding validation, extended ArtifactKind
 * (tex-source/bib/compile-log/compile-aux), jobs.created_by_principal_id and
 * BudgetRecord.storage_bytes — plus legacy-data compatibility for every field.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, KernelError } from '@dsh-scholar/research-kernel'
import { ConfiguredTestKernel } from './configured-test-kernel.js'
import { startKernelServer } from '../../packages/research-kernel/lib/server.js'
import { CorpusSnapshot, Passage, IdeaCard, BudgetRecord, ArtifactKind } from '@dsh-scholar/research-schemas'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v2-shape-'))
  return new ConfiguredTestKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief(overrides: Record<string, unknown> = {}) {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml', ...overrides,
  }
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

/** Walk a fresh project to IDEATING (idea gate's from-state). */
function toIdeating(kernel: ResearchKernel, projectId: string): void {
  const scope = kernel.createGate({ project_id: projectId, type: 'scope', title: 'Scope' })
  kernel.decideGate({ gate_id: scope.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
  kernel.transition(projectId, 'SURVEYING', kernel.getProject(projectId).revision)
  kernel.transition(projectId, 'IDEATING', kernel.getProject(projectId).revision)
}

function basicIdeaInput(kernel: ResearchKernel, projectId: string, corpusSnapshotId: string | null | undefined) {
  return {
    project_id: projectId,
    corpus_snapshot_id: corpusSnapshotId ?? undefined,
    title: 'Idea', hypothesis: 'H improves X', scientific_gap: { claims: [], statement: 'gap' },
    nearest_prior_works: [], exact_delta: 'adds H', falsification: { observation: 'X does not improve' },
    minimum_viable_experiment: { dataset: 'd', baseline: 'b', primary_metric: 'm', estimated_gpu_hours: 1 },
    scores: { feasibility: 4, information_gain: 4, reproducibility: 4, cost: 3 },
  }
}

describe('CorpusSnapshot v2 shape (domain-model.md §5)', () => {
  it('snapshotCorpus writes schema_version=1 and source_status=complete by default', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const snapshot = kernel.snapshotCorpus({
      project_id: project.project_id,
      queries: [{ source: 'openalex', query: 'q', run_at: '2026-08-06T00:00:00.000Z' }],
      papers: [{ paper_id: 'doi:10.1/x', title: 'T', source: 'openalex', retrieved_at: '2026-08-06T00:00:00.000Z' }],
    })
    expect(snapshot.schema_version).toBe(1)
    expect(snapshot.source_status).toBe('complete')
    // Round-trip through the store preserves the fields.
    const read = kernel.getCorpusSnapshot(snapshot.snapshot_id)
    expect(read.schema_version).toBe(1)
    expect(read.source_status).toBe('complete')
    kernel.close()
  })

  it('honors an explicit source_status=pending (source failure recorded, never silently dropped)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const snapshot = kernel.snapshotCorpus({
      project_id: project.project_id,
      queries: [{ source: 'arxiv', query: 'q2', run_at: '2026-08-06T00:00:00.000Z' }],
      papers: [],
      source_status: 'pending',
    })
    expect(snapshot.source_status).toBe('pending')
    kernel.close()
  })

  it('legacy snapshot rows (no schema_version/source_status) parse with v2 defaults', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    // A pre-v2 body: no schema_version, no source_status, no content_hash.
    const legacyBody = JSON.stringify({
      snapshot_id: 'corpus_snap_legacy',
      project_id: project.project_id,
      queries: [], papers: [], passages: [
        { passage_id: 'p1', paper_id: 'doi:10.1/x', text: 'legacy text', is_untrusted: true },
      ],
      citation_edges: [], external_claims: [],
      quality: { total_papers: 0 },
      created_at: '2026-01-01T00:00:00.000Z',
      frozen: true,
    })
    kernel.db.prepare('INSERT INTO corpus_snapshots (snapshot_id, project_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run('corpus_snap_legacy', project.project_id, legacyBody, '2026-01-01T00:00:00.000Z')
    const read = kernel.getCorpusSnapshot('corpus_snap_legacy')
    // Schema-level: defaults fill the v2 fields on read.
    const parsed = CorpusSnapshot.parse(read)
    expect(parsed.schema_version).toBe(1)
    expect(parsed.source_status).toBe('complete')
    expect(parsed.passages[0]?.content_hash).toBeUndefined()
    // Old-read compatible: the legacy passage still parses without a hash.
    expect(Passage.parse(read.passages[0]!).content_hash).toBeUndefined()
    kernel.close()
  })
})

describe('Passage content hash (domain-model.md §5, new-write required)', () => {
  it('snapshotCorpus fills sha256(text) for every passage and every stored passage has a non-empty hash', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const snapshot = kernel.snapshotCorpus({
      project_id: project.project_id,
      queries: [],
      papers: [{ paper_id: 'doi:10.1/x', title: 'T', source: 'user', retrieved_at: '2026-08-06T00:00:00.000Z' }],
      passages: [
        { passage_id: 'p1', paper_id: 'doi:10.1/x', text: 'alpha' },
        { passage_id: 'p2', paper_id: 'doi:10.1/x', text: 'beta', is_untrusted: true },
      ],
    })
    expect(snapshot.passages[0]!.content_hash).toBe(createHash('sha256').update('alpha', 'utf8').digest('hex'))
    expect(snapshot.passages[1]!.content_hash).toBe(createHash('sha256').update('beta', 'utf8').digest('hex'))
    // A caller-supplied content_hash is overridden by the computed one
    // (the kernel is the hash authority — clients never declare hashes).
    const overwritten = kernel.snapshotCorpus({
      project_id: project.project_id,
      queries: [],
      papers: [],
      passages: [{ passage_id: 'p3', paper_id: 'doi:10.1/x', text: 'gamma', content_hash: 'deadbeef' }],
    })
    expect(overwritten.passages[0]!.content_hash).toBe(createHash('sha256').update('gamma', 'utf8').digest('hex'))
    const stored = kernel.getCorpusSnapshot(snapshot.snapshot_id)
    for (const p of stored.passages) {
      expect(typeof p.content_hash).toBe('string')
      expect(p.content_hash!.length).toBe(64)
    }
    kernel.close()
  })

  it('schema-level: a passage without content_hash still parses (old-read compatible)', () => {
    const legacy = Passage.parse({ passage_id: 'p1', paper_id: 'doi:10.1/x', text: 'legacy' })
    expect(legacy.content_hash).toBeUndefined()
    expect(legacy.is_untrusted).toBe(true) // external content default-tagged
  })
})

describe('Idea Gate corpus binding (domain-model.md §6)', () => {
  function projectWithSnapshot(kernel: ResearchKernel): { projectId: string; snapshotId: string } {
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const snapshot = kernel.snapshotCorpus({ project_id: project.project_id, queries: [], papers: [] })
    toIdeating(kernel, project.project_id)
    return { projectId: project.project_id, snapshotId: snapshot.snapshot_id }
  }

  it('approves an idea gate when the card binds a same-project corpus snapshot', () => {
    const kernel = freshKernel()
    const { projectId, snapshotId } = projectWithSnapshot(kernel)
    const card = kernel.createIdea(basicIdeaInput(kernel, projectId, snapshotId) as never)
    const gate = kernel.createGate({ project_id: projectId, type: 'idea', title: 'Idea', payload: { idea_id: card.idea_id } })
    kernel.decideGate({ gate_id: gate.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    expect(kernel.getProject(projectId).status).toBe('IDEA_APPROVED')
    kernel.close()
  })

  it('rejects an idea gate when the bound corpus snapshot does not exist (422 idea_corpus_unknown)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    toIdeating(kernel, project.project_id)
    const card = kernel.createIdea(basicIdeaInput(kernel, project.project_id, 'corpus_snap_missing') as never)
    const gate = kernel.createGate({ project_id: project.project_id, type: 'idea', title: 'Idea', payload: { idea_id: card.idea_id } })
    expectKernelError(
      () => kernel.decideGate({ gate_id: gate.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' }),
      422, 'idea_corpus_unknown',
    )
    // The gate stays pending and the project is untouched.
    expect(kernel.getGate(gate.gate_id).status).toBe('pending')
    expect(kernel.getProject(project.project_id).status).toBe('IDEATING')
    kernel.close()
  })

  it('rejects a cross-project corpus binding (422 idea_corpus_foreign)', () => {
    const kernel = freshKernel()
    const { projectId, snapshotId } = projectWithSnapshot(kernel)
    const other = kernel.createProject({ name: 'o', workspace: '/w2', brief: makeBrief() })
    toIdeating(kernel, other.project_id)
    // The card in `other` references the snapshot of `projectId`.
    const card = kernel.createIdea(basicIdeaInput(kernel, other.project_id, snapshotId) as never)
    const gate = kernel.createGate({ project_id: other.project_id, type: 'idea', title: 'Idea', payload: { idea_id: card.idea_id } })
    expectKernelError(
      () => kernel.decideGate({ gate_id: gate.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' }),
      422, 'idea_corpus_foreign',
    )
    expect(kernel.getGate(gate.gate_id).status).toBe('pending')
    kernel.close()
  })

  it('legacy cards without corpus_snapshot_id are NOT intercepted (old-read compatible)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    toIdeating(kernel, project.project_id)
    // No corpus_snapshot_id at all.
    const card = kernel.createIdea(basicIdeaInput(kernel, project.project_id, null) as never)
    expect(card.corpus_snapshot_id).toBeNull()
    const gate = kernel.createGate({ project_id: project.project_id, type: 'idea', title: 'Idea', payload: { idea_id: card.idea_id } })
    kernel.decideGate({ gate_id: gate.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    expect(kernel.getProject(project.project_id).status).toBe('IDEA_APPROVED')
    // A payload-less idea gate (no idea_id) also passes through.
    const gate2 = kernel.createGate({ project_id: project.project_id, type: 'idea', title: 'Idea 2' })
    kernel.decideGate({ gate_id: gate2.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    kernel.close()
  })

  it('schema-level: IdeaCard corpus_snapshot_id is nullable for pre-v2 cards', () => {
    const legacy = IdeaCard.parse({
      idea_id: 'idea_legacy', project_id: 'rsp_x', title: 'T', hypothesis: 'H',
      exact_delta: 'd', falsification: { observation: 'o' },
      minimum_viable_experiment: { dataset: 'd', baseline: 'b', primary_metric: 'm' },
      scores: { feasibility: 1, information_gain: 1, reproducibility: 1, cost: 1 },
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    })
    expect(legacy.corpus_snapshot_id).toBeNull()
  })
})

describe('ArtifactKind v2 extensions (domain-model.md §8)', () => {
  it('registerArtifact accepts tex-source/bib/compile-log/compile-aux and round-trips', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const texSource = kernel.registerArtifact({ project_id: project.project_id, kind: 'tex-source', content: '\\documentclass{article}', file_name: 'paper.tex' })
    const bib = kernel.registerArtifact({ project_id: project.project_id, kind: 'bib', content: '@misc{x}', file_name: 'main.bib' })
    const log = kernel.registerArtifact({ project_id: project.project_id, kind: 'compile-log', content: 'This is pdfTeX', file_name: 'tex.log' })
    const aux = kernel.registerArtifact({ project_id: project.project_id, kind: 'compile-aux', content: '{}', file_name: 'aux.json' })
    for (const kind of ['tex-source', 'bib', 'compile-log', 'compile-aux']) {
      expect(ArtifactKind.safeParse(kind).success).toBe(true)
    }
    const listed = kernel.listArtifacts(project.project_id)
    expect(listed.map(a => a.artifact_id)).toEqual(
      expect.arrayContaining([texSource.artifact_id, bib.artifact_id, log.artifact_id, aux.artifact_id]),
    )
    expect(kernel.getArtifact(project.project_id, log.artifact_id).kind).toBe('compile-log')
    // Legacy kinds still work (backward compatible).
    const legacyLog = kernel.registerArtifact({ project_id: project.project_id, kind: 'log', content: 'x' })
    expect(legacyLog.kind).toBe('log')
    kernel.close()
  })
})

describe('jobs.created_by_principal_id (domain-model.md §9)', () => {
  it('submitJob persists the submitter principal and reads it back', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k1', kind: 'smoke', created_by_principal_id: 'ops-1' })
    expect(job.created_by_principal_id).toBe('ops-1')
    expect(kernel.getJob(job.job_id).created_by_principal_id).toBe('ops-1')
    expect(kernel.listJobs(project.project_id)[0]!.created_by_principal_id).toBe('ops-1')
    // Absent → NULL (legacy/internal submissions stay compatible).
    const legacy = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k2', kind: 'smoke' })
    expect(legacy.created_by_principal_id).toBeNull()
    expect(kernel.getJob(legacy.job_id).created_by_principal_id).toBeNull()
    // The raw column is populated (not just the response object).
    const row = kernel.db.prepare('SELECT created_by_principal_id FROM jobs WHERE job_id = ?').get(job.job_id) as { created_by_principal_id: string | null }
    expect(row.created_by_principal_id).toBe('ops-1')
    kernel.close()
  })
})

describe('BudgetRecord.storage_bytes (domain-model.md §16)', () => {
  it('recordUsage accumulates storage_bytes atomically with the other counters', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const first = kernel.recordUsage(project.project_id, { storage_bytes: 1024, model_cost_usd: 1 })
    expect(first.storage_bytes).toBe(1024)
    expect(first.model_cost_usd).toBe(1)
    const second = kernel.recordUsage(project.project_id, { storage_bytes: 512 })
    expect(second.storage_bytes).toBe(1536)
    expect(kernel.getBudget(project.project_id).storage_bytes).toBe(1536)
    // Schema-level: storage_bytes defaults to 0 on legacy-shaped records.
    const legacy = BudgetRecord.parse({ project_id: project.project_id, updated_at: '2026-01-01T00:00:00.000Z' })
    expect(legacy.storage_bytes).toBe(0)
    // Legacy DB row (pre-migration DEFAULT 0) reads back 0.
    kernel.db.prepare('UPDATE budget SET storage_bytes = 0 WHERE project_id = ?').run(project.project_id)
    expect(kernel.getBudget(project.project_id).storage_bytes).toBe(0)
    kernel.close()
  })
})

describe('HTTP surface (server routes stay in sync)', () => {
  async function withServer(kernel: ResearchKernel, fn: (base: string) => Promise<void>): Promise<void> {
    const { server, port } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  it('artifact route accepts the v2 TeX kinds', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    await withServer(kernel, async (base) => {
      const res = await fetch(`${base}/v1/artifacts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: project.project_id, kind: 'compile-log', content_base64: Buffer.from('log').toString('base64') }),
      })
      expect(res.status).toBe(201)
      const body = await res.json() as { kind: string }
      expect(body.kind).toBe('compile-log')
      // Invalid kind stays rejected.
      const bad = await fetch(`${base}/v1/artifacts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project_id: project.project_id, kind: 'nope', content_base64: Buffer.from('x').toString('base64') }),
      })
      expect(bad.status).toBe(422)
    })
    kernel.close()
  })

  it('job route records x-principal-id as created_by_principal_id; budget route accepts storage_bytes', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    await withServer(kernel, async (base) => {
      const headers = { 'content-type': 'application/json', 'x-principal-id': 'ops-http' }
      const jobRes = await fetch(`${base}/v1/projects/${project.project_id}/jobs`, {
        method: 'POST', headers, body: JSON.stringify({ idempotency_key: 'http-1', kind: 'smoke' }),
      })
      expect(jobRes.status).toBe(201)
      const job = await jobRes.json() as { job_id: string; created_by_principal_id: string | null }
      expect(job.created_by_principal_id).toBe('ops-http')
      // Without any principal → NULL (compat).
      const bare = await fetch(`${base}/v1/projects/${project.project_id}/jobs`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotency_key: 'http-2', kind: 'smoke' }),
      })
      const bareJob = await bare.json() as { created_by_principal_id: string | null }
      expect(bareJob.created_by_principal_id).toBeNull()
      // Baselines are never ordinary jobs: every seed uses the dedicated
      // contract/snapshot/environment-bound endpoint.
      const baseline = await fetch(`${base}/v1/projects/${project.project_id}/jobs`, {
        method: 'POST', headers, body: JSON.stringify({ idempotency_key: 'http-baseline', kind: 'baseline' }),
      })
      expect(baseline.status).toBe(422)
      expect((await baseline.json() as { error: { code: string } }).error.code).toBe('baseline_handoff_required')
      expect(kernel.listJobs(project.project_id)).toHaveLength(2)
      // Budget route: storage_bytes accepted and accumulated.
      const budgetRes = await fetch(`${base}/v1/projects/${project.project_id}/budget`, {
        method: 'POST', headers, body: JSON.stringify({ storage_bytes: 2048 }),
      })
      expect(budgetRes.status).toBe(200)
      const budget = await budgetRes.json() as { storage_bytes: number }
      expect(budget.storage_bytes).toBe(2048)
    })
    kernel.close()
  })
})
