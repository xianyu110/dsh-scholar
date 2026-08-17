/**
 * REPRO-01 — paper reproduction contract tests (docs/reproduction-contracts.md).
 *
 * Covers the full contract surface:
 * - Spec strict schema + canonical paper-ref parsing (DOI/arXiv/artifact);
 * - zero-safe per-metric comparator (expected=0, absolute/relative tolerance,
 *   NaN/Infinity, unit/direction/aggregation, missing/duplicate metric);
 * - table row/column, figure data-hash and manuscript TeX/PDF checks
 *   (missing inputs are never a skipped-pass);
 * - report status evaluation — exit 0 is execution_succeeded, out-of-
 *   tolerance is fail/inconclusive, never code_error;
 * - spec create/update/list, attempt lifecycle + fencing (generation/lease
 *   token/idempotency), report → CAS + hash/ref, cross-project 404;
 * - verifier service identity (HTTP), NextAction done semantics.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  KernelError, ResearchKernel,
  compareMetric, compareMetrics, compareTable, compareTables, compareFigure, compareFigures,
  compareManuscript, comparisonGroupChecks, evaluateReportStatus, suggestFailureClass,
  nextActionProjection,
  type NextActionContext, type NextActionReproduction,
} from '@dsh-scholar/research-kernel'
import {
  PaperReproductionSpec, ReproductionReportInput, paperRefFromToken,
  type MetricComparator, type ReportCheck, type ReportCheckStatus,
} from '@dsh-scholar/research-schemas'

const NOW = '2026-08-12T00:00:00.000Z'

function freshKernel(serviceToken?: string): { kernel: ResearchKernel; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reproduction-'))
  const kernel = new ResearchKernel({
    dbPath: join(dir, 'kernel.db'),
    casRoot: join(dir, 'cas'),
    requireSignedManifest: false,
    ...(serviceToken !== undefined ? { serviceToken } : {}),
  })
  return { kernel, dir }
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

function project(kernel: ResearchKernel, name = 'repro-project') {
  return kernel.createProject({ name, workspace: '/w', brief: makeBrief() })
}

/** A registered PDF artifact usable as a scanned-paper artifact. */
function paperArtifact(kernel: ResearchKernel, projectId: string, content = 'PDF-CONTENT-V1') {
  return kernel.registerArtifact({ project_id: projectId, kind: 'pdf', content, media_type: 'application/pdf', file_name: 'paper.pdf' })
}

/** Seed a code workspace + snapshot for the project. */
function codeSnapshot(kernel: ResearchKernel, projectId: string) {
  const info = kernel.workspaceEnsure(projectId, 'code', 'fixture')
  kernel.workspaceWrite(info.workspace_id, 'main.js', 'console.log(1)\n')
  return kernel.snapshotCodeArchive(projectId, info.workspace_id, '', 'repro')
}

function dataArtifact(kernel: ResearchKernel, projectId: string, content = 'DATA-V1') {
  return kernel.registerArtifact({ project_id: projectId, kind: 'data', content })
}

const DOI_REF = { doi: '10.48550/arXiv.2401.12345' }

function specInput(overrides: Record<string, unknown> = {}) {
  return {
    owner: { principal_id: 'pi-1', auth_method: 'dsh-session' },
    paper_ref: DOI_REF,
    claims_to_reproduce: [{ claim_ref: 'primary', statement: 'paper primary result', locator: 'Table 2' }],
    metric_comparators: [{
      metric_id: 'm1', name: 'mAP', expected: 58.4, unit: '%',
      tolerance: { absolute: 0.5, relative: 0.01 },
    }],
    ...overrides,
  }
}

function metric(name: string, expected: number, tolerance: { absolute?: number; relative?: number } = {}, extra: Partial<MetricComparator> = {}): MetricComparator {
  return {
    metric_id: `mid_${name.replace(/\W/g, '_')}`,
    name,
    expected,
    tolerance: { absolute: tolerance.absolute ?? 0, relative: tolerance.relative ?? 0 },
    ...extra,
  }
}

function check(check_id: string, status: ReportCheckStatus, required = true, kind: ReportCheck['kind'] = 'metric'): ReportCheck {
  return { check_id, kind, name: check_id, status, required, detail: '' }
}

// ── paper ref parsing ───────────────────────────────────────────────────────

describe('paper ref parsing (contract §2.1)', () => {
  it('accepts DOI, arXiv (new/old/prefix) and sha256 artifact ids', () => {
    expect(paperRefFromToken('10.48550/arXiv.2401.12345')).toEqual({ doi: '10.48550/arXiv.2401.12345' })
    expect(paperRefFromToken('2401.12345')).toEqual({ arxiv_id: '2401.12345' })
    expect(paperRefFromToken('arXiv:2401.12345v2')).toEqual({ arxiv_id: '2401.12345v2' })
    expect(paperRefFromToken('cs.AI/9901001')).toEqual({ arxiv_id: 'cs.AI/9901001' })
    expect(paperRefFromToken('sha256:' + 'a'.repeat(64))).toEqual({ artifact_id: 'sha256:' + 'a'.repeat(64) })
  })

  it('rejects non-paper tokens and empty input', () => {
    expect(() => paperRefFromToken('')).toThrow(/empty/)
    expect(() => paperRefFromToken('https://example.com/paper')).toThrow(/invalid paper reference/)
    expect(() => paperRefFromToken('main-branch')).toThrow(/invalid paper reference/)
    expect(() => paperRefFromToken('arxiv:2401')).toThrow(/invalid/)
  })

  it('PaperReproductionSpec schema requires claims and exact git commit', () => {
    const base = {
      spec_id: 'repro_x1', schema_version: 1, project_id: 'rsp_x',
      owner: { principal_id: 'p1' }, paper_ref: DOI_REF, reproduction_level: 'baseline_official',
      claims_to_reproduce: [{ claim_ref: 'c1' }], code_source: null, data_inputs: [],
      execution_binding: null, environment_lock: {}, expected_outputs: [],
      metric_comparators: [], revision: 1, status: 'draft', created_at: NOW, updated_at: NOW,
    }
    expect(PaperReproductionSpec.safeParse(base).success).toBe(true)
    expect(PaperReproductionSpec.safeParse({ ...base, claims_to_reproduce: [] }).success).toBe(false)
    // branch/tag is not executable — the commit regex rejects it.
    expect(PaperReproductionSpec.safeParse({
      ...base,
      code_source: { kind: 'git', repo_url: 'https://github.com/x/y', commit: 'main' },
    }).success).toBe(false)
    expect(PaperReproductionSpec.safeParse({
      ...base,
      code_source: { kind: 'git', repo_url: 'https://github.com/x/y', commit: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0' },
    }).success).toBe(true)
    // Recipe data needs an expected hash.
    expect(PaperReproductionSpec.safeParse({
      ...base,
      data_inputs: [{ kind: 'recipe', acquisition_recipe: 'curl ...' }],
    }).success).toBe(false)
  })
})

// ── comparators (contract §3) ───────────────────────────────────────────────

describe('metric comparator (contract §3 zero-safe rule)', () => {
  it('expected=0: relative part is 0, only absolute tolerance decides', () => {
    const c = metric('loss', 0, { absolute: 0.05, relative: 0.5 })
    expect(compareMetric(c, { name: 'loss', value: 0.04 }).status).toBe('pass')
    expect(compareMetric(c, { name: 'loss', value: 0.06 }).status).toBe('fail')
    // The relative tolerance must not matter for expected=0 (0 * 0.5 = 0).
    const bad = compareMetric(metric('loss', 0, { absolute: 0.05, relative: 0.5 }), { name: 'loss', value: 0.5 })
    expect(bad.status).toBe('fail')
    expect(bad.allowed).toBe(0.05)
  })

  it('allowed = max(absolute, abs(expected)*relative)', () => {
    const c = metric('acc', 100, { absolute: 1, relative: 0.02 }) // allowed = 2
    expect(compareMetric(c, { name: 'acc', value: 101.9 }).status).toBe('pass')
    expect(compareMetric(c, { name: 'acc', value: 102.1 }).status).toBe('fail')
    expect(compareMetric(c, { name: 'acc', value: 102.1 }).allowed).toBe(2)
  })

  it('NaN/Infinity actual never pass', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const result = compareMetric(metric('m', 1, { absolute: 10 }), { name: 'm', value: bad })
      expect(result.status).toBe('fail')
      expect(result.detail).toContain('not finite')
    }
  })

  it('unit/direction/aggregation mismatch never pass (direction is not a substitute for the error comparison)', () => {
    const unit = compareMetric(metric('m', 1, { absolute: 1 }, { unit: '%' }), { name: 'm', value: 1.0, unit: 'points' })
    expect(unit.status).toBe('fail')
    expect(unit.detail).toContain('unit mismatch')
    const direction = compareMetric(
      metric('m', 1, { absolute: 1 }, { direction: 'higher_is_better' }),
      { name: 'm', value: 1.0, direction: 'lower_is_better' },
    )
    expect(direction.status).toBe('fail')
    expect(direction.detail).toContain('direction mismatch')
    const aggregation = compareMetric(
      metric('m', 1, { absolute: 1 }, { aggregation: 'mean' }),
      { name: 'm', value: 1.0, aggregation: 'median' },
    )
    expect(aggregation.status).toBe('fail')
    expect(aggregation.detail).toContain('aggregation mismatch')
  })

  it('missing metric: required → fail, optional → inconclusive', () => {
    const required = compareMetric(metric('m', 1, { absolute: 0.1 }), null)
    expect(required.status).toBe('fail')
    expect(required.detail).toContain('missing metric')
    const optional = compareMetric(metric('m', 1, { absolute: 0.1 }, { required: false }), null)
    expect(optional.status).toBe('inconclusive')
  })

  it('duplicate metric in the actual set never passes; extra actuals are reported', () => {
    const comparators = [metric('m1', 1, { absolute: 0.1 })]
    const { comparisons, extra, duplicate } = compareMetrics(comparators, [
      { name: 'm1', value: 1.0 },
      { name: 'm1', value: 1.1 },
      { name: 'm2', value: 5 },
    ])
    expect(duplicate).toEqual(['m1'])
    expect(comparisons[0]?.status).toBe('fail')
    expect(comparisons[0]?.detail).toContain('duplicate metric')
    expect(extra.map(e => e.name)).toEqual(['m2'])
  })

  it('compareMetrics passes when all actuals match', () => {
    const comparators = [metric('m1', 1, { absolute: 0.1 }), metric('m2', 2, { absolute: 0.1 }, { unit: '%' })]
    const { comparisons } = compareMetrics(comparators, [
      { name: 'm1', value: 1.0 },
      { name: 'm2', value: 2.0, unit: '%' },
    ])
    expect(comparisons.every(c => c.status === 'pass')).toBe(true)
  })
})

describe('table/figure/manuscript comparators (contract §3)', () => {
  it('tables compare on stable row/column keys — missing/extra/cells fail', () => {
    const expected = [{
      table_id: 't1',
      columns: ['method', 'score'],
      rows: [
        { key: 'ours', values: { method: 'ours', score: 58.4 } },
        { key: 'baseline', values: { method: 'baseline', score: 50.0 } },
      ],
    }]
    expect(compareTables(expected, [{ table_id: 't1', columns: ['method', 'score'], rows: [{ key: 'ours', values: { method: 'ours', score: 58.4 } }, { key: 'baseline', values: { method: 'baseline', score: 50.0 } }] }])[0]?.status).toBe('pass')
    expect(compareTables(expected, [{ table_id: 't1', columns: ['method', 'score'], rows: [{ key: 'ours', values: { method: 'ours', score: 58.4 } }] }])[0]?.missing_rows).toEqual(['baseline'])
    expect(compareTables(expected, [{ table_id: 't1', columns: ['method', 'score'], rows: [{ key: 'ours', values: { method: 'ours', score: 58.4 } }, { key: 'baseline', values: { method: 'baseline', score: 50.0 } }, { key: 'extra', values: { method: 'extra', score: 1 } }] }])[0]?.extra_rows).toEqual(['extra'])
    expect(compareTables(expected, [{ table_id: 't1', columns: ['method'], rows: [{ key: 'ours', values: { method: 'ours' } }, { key: 'baseline', values: { method: 'baseline' } }] }])[0]?.missing_columns).toEqual(['score'])
    const mismatch = compareTables(expected, [{ table_id: 't1', columns: ['method', 'score'], rows: [{ key: 'ours', values: { method: 'ours', score: 99.0 } }, { key: 'baseline', values: { method: 'baseline', score: 50.0 } }] }])[0]
    expect(mismatch?.status).toBe('fail')
    expect(mismatch?.cell_mismatches[0]?.row).toBe('ours')
    expect(compareTable(expected[0]!, null).status).toBe('fail')
  })

  it('figures: data hash is authoritative; visual similarity is diagnostic only', () => {
    const hash = 'a'.repeat(64)
    expect(compareFigure({ figure_id: 'f1', data_sha256: hash }, { figure_id: 'f1', data_sha256: hash, visual_similarity: 0.1 }).status).toBe('pass')
    const mismatch = compareFigure({ figure_id: 'f1', data_sha256: hash }, { figure_id: 'f1', data_sha256: 'b'.repeat(64) })
    expect(mismatch.status).toBe('fail')
    expect(mismatch.detail).toContain('hash mismatch')
    expect(compareFigure({ figure_id: 'f1', data_sha256: null }, { figure_id: 'f1', data_sha256: hash }).status).toBe('inconclusive')
    expect(compareFigure({ figure_id: 'f1', data_sha256: hash }, null).status).toBe('fail')
  })

  it('manuscript: TeX/PDF rebuilt with checks; missing inputs are never a skipped-pass', () => {
    const expected = { required: true, tex_required: true, pdf_required: true }
    const ok = compareManuscript(expected, {
      tex_rebuilt: true, pdf_rebuilt: true, structure_ok: true, text_ok: true, fonts_ok: true, page_count_ok: true, inputs_missing: [],
    })
    expect(ok.status).toBe('pass')
    const missingInputs = compareManuscript(expected, {
      tex_rebuilt: true, pdf_rebuilt: true, structure_ok: true, text_ok: true, fonts_ok: true, page_count_ok: true, inputs_missing: ['table-3-source.tex'],
    })
    expect(missingInputs.status).toBe('inconclusive')
    expect(missingInputs.detail).toContain('NOT a skipped-pass')
    const notRebuilt = compareManuscript(expected, {
      tex_rebuilt: false, pdf_rebuilt: false, structure_ok: null, text_ok: null, fonts_ok: null, page_count_ok: null, inputs_missing: [],
    })
    expect(notRebuilt.status).toBe('fail')
  })
})

describe('report status evaluation (contract §3: exit 0 ≠ pass)', () => {
  it('all required pass → pass; one required fail → fail; only inconclusive → inconclusive; preflight blocked → blocked', () => {
    expect(evaluateReportStatus([check('a', 'pass'), check('b', 'pass')])).toBe('pass')
    expect(evaluateReportStatus([check('a', 'pass'), check('b', 'fail')])).toBe('fail')
    expect(evaluateReportStatus([check('a', 'pass'), check('b', 'inconclusive')])).toBe('inconclusive')
    expect(evaluateReportStatus([check('a', 'pass')], true)).toBe('blocked')
    expect(evaluateReportStatus([check('a', 'fail')], true)).toBe('blocked')
    // No checks → inconclusive (nothing verifies the reproduction).
    expect(evaluateReportStatus([])).toBe('inconclusive')
  })

  it('failure class is scientific, never code_error for out-of-tolerance', () => {
    expect(suggestFailureClass([check('m', 'fail')])).toBe('metric_mismatch')
    expect(suggestFailureClass([check('t', 'fail', true, 'table')])).toBe('table_mismatch')
    expect(suggestFailureClass([{ ...check('r', 'fail'), kind: 'runtime' }])).toBe('runtime_mismatch')
    expect(suggestFailureClass([check('m', 'pass')])).toBeNull()
    expect(suggestFailureClass([check('m', 'fail')])).not.toBe('code_error')
  })

  it('comparisonGroupChecks flattens metrics/tables/figures/manuscript', () => {
    const { comparisons } = compareMetrics([metric('m', 1, { absolute: 0.1 })], [{ name: 'm', value: 5 }])
    const checks = comparisonGroupChecks({ metrics: comparisons, tables: [], figures: [], checks: [] })
    expect(checks.map(c => c.check_id)).toEqual(['metric:mid_m'])
    expect(checks[0]?.status).toBe('fail')
  })
})

// ── spec lifecycle (kernel) ─────────────────────────────────────────────────

describe('PaperReproductionSpec lifecycle (kernel)', () => {
  it('creates a DOI spec with full validation and returns spec_id + revision', () => {
    const { kernel, dir } = freshKernel()
    try {
      const p = project(kernel)
      const art = dataArtifact(kernel, p.project_id)
      const snap = codeSnapshot(kernel, p.project_id)
      const spec = kernel.createReproductionSpec({
        project_id: p.project_id,
        owner: { principal_id: 'pi-1' },
        paper_ref: DOI_REF,
        claims_to_reproduce: [{ claim_ref: 'primary', statement: 'main result' }],
        code_source: { kind: 'snapshot', code_snapshot_id: snap.snapshot_id },
        data_inputs: [{ kind: 'artifact', artifact_id: art.artifact_id }],
        execution_binding: { runner_profile_id: 'profile_local_docker_cpu_v1', target_id: 'target_local_docker_v1' },
        environment_lock: { image_digest: 'sha256:' + 'a'.repeat(64) },
        metric_comparators: [metric('mAP', 58.4, { absolute: 0.5 })],
      })
      expect(spec.spec_id).toMatch(/^repro_/)
      expect(spec.status).toBe('draft')
      expect(spec.revision).toBe(1)
      expect(spec.schema_version).toBe(1)
      expect(spec.paper_ref.doi).toBe('10.48550/arXiv.2401.12345')
      expect(spec.environment_lock).toMatchObject({
        runner_profile_id: 'profile_local_docker_cpu_v1',
        target_id: 'target_local_docker_v1',
        target_revision: '1',
      })
      expect(spec.environment_lock.target_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(kernel.listReproductionSpecs(p.project_id).map(s => s.spec_id)).toEqual([spec.spec_id])
      expect(kernel.getReproductionSpec(p.project_id, spec.spec_id).spec_id).toBe(spec.spec_id)
      // Outbox event emitted with ids only.
      const events = kernel.listEvents(p.project_id)
      expect(events.some(e => e.kind === 'reproduction.spec.created' && e.payload.spec_id === spec.spec_id)).toBe(true)
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid paper refs, empty claims, missing principal, non-executable git and unregistered profiles', () => {
    const { kernel, dir } = freshKernel()
    try {
      const p = project(kernel)
      const expect422 = (code: string, input: Record<string, unknown>) => {
        try {
          kernel.createReproductionSpec({ project_id: p.project_id, owner: { principal_id: 'pi-1' }, ...input } as never)
          throw new Error('expected KernelError')
        } catch (error) {
          expect(error).toBeInstanceOf(KernelError)
          expect((error as KernelError).code).toBe(code)
        }
      }
      expect422('invalid_paper_ref', specInput({ paper_ref: { doi: 'not-a-doi' } }))
      expect422('claims_required', specInput({ claims_to_reproduce: [] }))
      try {
        kernel.createReproductionSpec({ project_id: p.project_id, paper_ref: DOI_REF, claims_to_reproduce: [{ claim_ref: 'c' }] } as never)
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).code).toBe('principal_required')
      }
      // branch/tag git source is refused (exact commit required).
      expect422('invalid_paper_ref', specInput({ paper_ref: { doi: 'x' } })) // already covered above
      try {
        kernel.createReproductionSpec({
          project_id: p.project_id, owner: { principal_id: 'pi-1' },
          paper_ref: DOI_REF, claims_to_reproduce: [{ claim_ref: 'c' }],
          code_source: { kind: 'git', repo_url: 'https://github.com/x/y', commit: 'main' },
        } as never)
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).code).toBe('invalid_paper_ref')
      }
      // unknown runner profile is 422 runner_profile_unknown.
      try {
        kernel.createReproductionSpec({
          project_id: p.project_id, owner: { principal_id: 'pi-1' },
          paper_ref: DOI_REF, claims_to_reproduce: [{ claim_ref: 'c' }],
          execution_binding: { runner_profile_id: 'profile_does_not_exist', target_id: 'tgt-1' },
        })
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).code).toBe('runner_profile_unknown')
      }
      try {
        kernel.createReproductionSpec({
          project_id: p.project_id, owner: { principal_id: 'pi-1' },
          paper_ref: DOI_REF, claims_to_reproduce: [{ claim_ref: 'c' }],
          execution_binding: { runner_profile_id: 'profile_local_docker_cpu_v1', target_id: 'target_does_not_exist' },
        })
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).code).toBe('runner_target_unknown')
      }
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('paper artifact / code snapshot / data artifact refs must belong to the project (cross-project → 404/422)', () => {
    const { kernel, dir } = freshKernel()
    try {
      const a = project(kernel, 'a')
      const b = project(kernel, 'b')
      const foreignArt = paperArtifact(kernel, a.project_id)
      const foreignData = dataArtifact(kernel, a.project_id)
      const foreignSnap = codeSnapshot(kernel, a.project_id)
      // artifact_id paper ref from another project → 404 artifact_not_found.
      try {
        kernel.createReproductionSpec({
          project_id: b.project_id, owner: { principal_id: 'pi-1' },
          paper_ref: { artifact_id: foreignArt.artifact_id },
          claims_to_reproduce: [{ claim_ref: 'c' }],
        })
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).status).toBe(404)
        expect((error as KernelError).code).toBe('artifact_not_found')
      }
      // Own-project artifact ref works.
      const own = paperArtifact(kernel, b.project_id)
      const spec = kernel.createReproductionSpec({
        project_id: b.project_id, owner: { principal_id: 'pi-1' },
        paper_ref: { artifact_id: own.artifact_id },
        claims_to_reproduce: [{ claim_ref: 'c' }],
      })
      expect(spec.source_artifact_id).toBe(own.artifact_id)
      // Foreign data artifact → 404; foreign snapshot → 422 code_snapshot_foreign.
      try {
        kernel.createReproductionSpec({
          project_id: b.project_id, owner: { principal_id: 'pi-1' },
          paper_ref: DOI_REF, claims_to_reproduce: [{ claim_ref: 'c' }],
          data_inputs: [{ kind: 'artifact', artifact_id: foreignData.artifact_id }],
        })
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).status).toBe(404)
      }
      try {
        kernel.createReproductionSpec({
          project_id: b.project_id, owner: { principal_id: 'pi-1' },
          paper_ref: DOI_REF, claims_to_reproduce: [{ claim_ref: 'c' }],
          code_source: { kind: 'snapshot', code_snapshot_id: foreignSnap.snapshot_id },
        })
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).code).toBe('code_snapshot_foreign')
      }
      // Cross-project lookups are the same 404 as unknown ids (no enumeration).
      expect(() => kernel.getReproductionSpec(b.project_id, spec.spec_id)).not.toThrow()
      expect(() => kernel.getReproductionSpec(a.project_id, spec.spec_id)).toThrow(/not found/)
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('idempotent spec creation: same key+hash replays, different hash 409', () => {
    const { kernel, dir } = freshKernel()
    try {
      const p = project(kernel)
      const body = specInput({ idempotency_key: 'spec-idem-1' }) as Record<string, unknown>
      const first = kernel.createReproductionSpec({ project_id: p.project_id, ...body } as never)
      const replay = kernel.createReproductionSpec({
        project_id: p.project_id, ...body,
      } as never)
      expect(replay.spec_id).toBe(first.spec_id)
      expect(kernel.listReproductionSpecs(p.project_id)).toHaveLength(1)
      try {
        kernel.createReproductionSpec({
          project_id: p.project_id, ...specInput({ idempotency_key: 'spec-idem-1', request_hash: 'hash-different' }),
        } as never)
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).status).toBe(409)
        expect((error as KernelError).code).toBe('idempotency_conflict')
      }
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('updateSpec: revision CAS 409, illegal transitions 422, confirm works', () => {
    const { kernel, dir } = freshKernel()
    try {
      const p = project(kernel)
      const spec = kernel.createReproductionSpec({ ...specInput(), project_id: p.project_id } as never)
      // stale revision → 409.
      try {
        kernel.updateReproductionSpec(p.project_id, spec.spec_id, { expected_revision: 99, patch: { status: 'confirmed' } })
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).status).toBe(409)
        expect((error as KernelError).code).toBe('reproduction_revision_conflict')
      }
      // draft → confirmed OK; revision bumps.
      const confirmed = kernel.updateReproductionSpec(p.project_id, spec.spec_id, { expected_revision: 1, patch: { status: 'confirmed' } })
      expect(confirmed.status).toBe('confirmed')
      expect(confirmed.revision).toBe(2)
      // draft → completed (only reachable via report) is illegal.
      try {
        kernel.updateReproductionSpec(p.project_id, spec.spec_id, { expected_revision: 2, patch: { status: 'completed' } })
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).status).toBe(422)
        expect((error as KernelError).code).toBe('reproduction_status_conflict')
      }
      // Invalid patch ref is re-validated.
      try {
        kernel.updateReproductionSpec(p.project_id, spec.spec_id, { expected_revision: 2, patch: { paper_ref: { doi: 'nope' } } })
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).code).toBe('invalid_paper_ref')
      }
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── attempt lifecycle + fencing ─────────────────────────────────────────────

describe('ReproductionAttempt lifecycle + fencing (contract §2.3/§4)', () => {
  it('draft spec cannot start (409 spec_not_confirmed); confirmed spec starts with generation 1 + lease token', () => {
    const { kernel, dir } = freshKernel()
    try {
      const p = project(kernel)
      const spec = kernel.createReproductionSpec({ ...specInput(), project_id: p.project_id } as never)
      try {
        kernel.startReproductionAttempt(p.project_id, spec.spec_id, { submitter_principal: 'pi-1' })
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).code).toBe('spec_not_confirmed')
      }
      kernel.updateReproductionSpec(p.project_id, spec.spec_id, { expected_revision: 1, patch: { status: 'confirmed' } })
      const started = kernel.startReproductionAttempt(p.project_id, spec.spec_id, { submitter_principal: 'pi-1', reason: 'first attempt' })
      expect(started.attempt.attempt_id).toMatch(/^repa_/)
      expect(started.generation).toBe(1)
      expect(started.lease_token).toMatch(/^[0-9a-f]{48}$/)
      expect(started.attempt.spec_revision).toBe(2)
      expect(started.attempt.status).toBe('running')
      expect(started.attempt.submitter_principal).toBe('pi-1')
      expect(started.attempt.reason).toBe('first attempt')
      const readBack = kernel.getReproductionAttempt(p.project_id, started.attempt.attempt_id)
      expect(readBack.attempt_id).toBe(started.attempt.attempt_id)
      // No plaintext token at rest (hash column only).
      const row = kernel.db.prepare('SELECT lease_token_hash FROM reproduction_attempts WHERE attempt_id = ?').get(started.attempt.attempt_id) as { lease_token_hash: string }
      expect(row.lease_token_hash).toBe(createHash('sha256').update(started.lease_token!).digest('hex'))
      expect(row.lease_token_hash).not.toContain(started.lease_token!)
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a confirmed reproduction when its pinned runner target changed', () => {
    const { kernel, dir } = freshKernel()
    try {
      const p = project(kernel)
      const spec = kernel.createReproductionSpec({
        ...specInput(),
        project_id: p.project_id,
        execution_binding: {
          runner_profile_id: 'profile_local_docker_cpu_v1',
          target_id: 'target_local_docker_v1',
        },
      } as never)
      kernel.updateReproductionSpec(p.project_id, spec.spec_id, { expected_revision: 1, patch: { status: 'confirmed' } })
      kernel.updateRunnerTarget('target_local_docker_v1', { expected_revision: 1, display_name: 'changed after confirmation' })
      expect(() => kernel.startReproductionAttempt(p.project_id, spec.spec_id, {
        submitter_principal: 'pi-1', reason: 'must not run stale target pin',
      })).toThrowError(KernelError)
      expect(kernel.listReproductionAttempts(p.project_id, spec.spec_id)).toHaveLength(0)
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('attempt idempotency: same key+hash replays the SAME attempt, different hash 409', () => {
    const { kernel, dir } = freshKernel()
    try {
      const p = project(kernel)
      const spec = kernel.createReproductionSpec({ ...specInput(), project_id: p.project_id } as never)
      kernel.updateReproductionSpec(p.project_id, spec.spec_id, { expected_revision: 1, patch: { status: 'confirmed' } })
      const first = kernel.startReproductionAttempt(p.project_id, spec.spec_id, {
        submitter_principal: 'pi-1', idempotency_key: 'attempt-idem-1', request_hash: 'hash-a',
      })
      const replay = kernel.startReproductionAttempt(p.project_id, spec.spec_id, {
        submitter_principal: 'pi-1', idempotency_key: 'attempt-idem-1', request_hash: 'hash-a',
      })
      expect(replay.attempt.attempt_id).toBe(first.attempt.attempt_id)
      expect(replay.lease_token).toBe(first.lease_token) // same in-memory token
      try {
        kernel.startReproductionAttempt(p.project_id, spec.spec_id, {
          submitter_principal: 'pi-1', idempotency_key: 'attempt-idem-1', request_hash: 'hash-b',
        })
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).status).toBe(409)
        expect((error as KernelError).code).toBe('idempotency_conflict')
      }
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── report: CAS + hash/ref + service identity (kernel) ─────────────────────

function passReportInput() {
  const checks = [check('metric:m1', 'pass')]
  return {
    attempt_generation: 1,
    lease_token: 'unused-direct-call',
    paper_refs: ['10.48550/arXiv.2401.12345'],
    claim_refs: ['primary'],
    status: evaluateReportStatus(checks),
    preflight: { ok: true, checks: ['image digest pinned'], blocked: false, reason: '' },
    runtime_verified: { exit_code: 0, execution_succeeded: true, run_manifest_signed: true, lease_fenced: true },
    environment: { declared: { image_digest: 'sha256:' + 'a'.repeat(64) }, used: { image_digest: 'sha256:' + 'a'.repeat(64) } },
    run_manifest_refs: ['sha256:' + 'b'.repeat(64)],
    paper_comparisons: { metrics: [], tables: [], figures: [], checks: [] },
    run_comparisons: { metrics: [], tables: [], figures: [], checks: [] },
    checks,
    missing_outputs: [],
    extra_outputs: [],
    failure_class: null,
    stable_error_code: '',
    retryable: false,
    generated_by: 'reproduction-verifier',
    tool_versions: { verifier: 'test-1.0' },
  }
}

function reportChecksFor(comparisons: ReturnType<typeof compareMetrics>['comparisons']): ReportCheck[] {
  return comparisons.map(c => ({ check_id: `metric:${c.metric_id}`, kind: 'metric' as const, name: c.name, status: c.status, required: true, detail: c.detail }))
}

describe('ReproducibilityReport (contract §2.3/§4)', () => {
  it('verifier-only ingestion; report body goes to CAS, row keeps hash+ref; attempt → reported, spec → completed', () => {
    const { kernel, dir } = freshKernel()
    try {
      const p = project(kernel)
      const spec = kernel.createReproductionSpec({ ...specInput(), project_id: p.project_id } as never)
      kernel.updateReproductionSpec(p.project_id, spec.spec_id, { expected_revision: 1, patch: { status: 'confirmed' } })
      const { attempt, lease_token: token } = kernel.startReproductionAttempt(p.project_id, spec.spec_id, { submitter_principal: 'pi-1' })
      // Non-verifier service principal → 403.
      try {
        kernel.reportReproductionAttempt({
          attempt_id: attempt.attempt_id, service_principal: 'analysis-worker', request_id: 'r1',
          attempt_generation: 1, lease_token: token!, report: passReportInput() as never,
        })
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).status).toBe(403)
        expect((error as KernelError).code).toBe('service_identity_required')
      }
      // Stale generation / wrong token → 409 lease_stale.
      for (const bad of [
        { generation: 2, token: token! },
        { generation: 1, token: 'wrong-token' },
      ]) {
        try {
          kernel.reportReproductionAttempt({
            attempt_id: attempt.attempt_id, service_principal: 'verifier', request_id: 'r1',
            attempt_generation: bad.generation, lease_token: bad.token, report: passReportInput() as never,
          })
          throw new Error('expected KernelError')
        } catch (error) {
          expect((error as KernelError).status).toBe(409)
          expect((error as KernelError).code).toBe('lease_stale')
        }
      }
      // Unknown attempt → 404.
      try {
        kernel.reportReproductionAttempt({
          attempt_id: 'repa_unknown', service_principal: 'verifier', request_id: 'r1',
          attempt_generation: 1, lease_token: 'x', report: passReportInput() as never,
        })
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).status).toBe(404)
      }
      // Valid verifier report → 201-style storage.
      const report = kernel.reportReproductionAttempt({
        attempt_id: attempt.attempt_id, service_principal: 'verifier', request_id: 'req-1',
        attempt_generation: 1, lease_token: token!, report: passReportInput() as never,
      })
      expect(report.report_id).toMatch(/^repr_/)
      expect(report.status).toBe('pass')
      expect(report.spec_id).toBe(spec.spec_id)
      expect(report.attempt_id).toBe(attempt.attempt_id)
      expect(report.report_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(report.cas_ref).toBe(`sha256:${report.report_hash}`)
      // Row stores hash/ref; CAS blob exists with matching bytes.
      const row = kernel.db.prepare('SELECT body_hash, cas_ref, status FROM reproduction_reports WHERE report_id = ?').get(report.report_id) as { body_hash: string; cas_ref: string; status: string }
      expect(row.body_hash).toBe(report.report_hash)
      expect(row.cas_ref).toBe(report.cas_ref)
      expect(kernel.cas.has(report.report_hash)).toBe(true)
      const blob = kernel.cas.read(report.report_hash).toString('utf8')
      expect(JSON.parse(blob).report_id).toBe(report.report_id)
      // Attempt → reported; spec → completed (revision bumped).
      expect(kernel.getReproductionAttempt(p.project_id, attempt.attempt_id).status).toBe('reported')
      expect(kernel.getReproductionSpec(p.project_id, spec.spec_id).status).toBe('completed')
      // Read-back equals the stored immutable report.
      const readBack = kernel.getReproductionReport(p.project_id, report.report_id)
      expect(readBack.report_id).toBe(report.report_id)
      expect(readBack.paper_refs).toEqual(['10.48550/arXiv.2401.12345'])
      // Links recorded (report + run manifest).
      const links = kernel.db.prepare('SELECT kind, ref FROM reproduction_links WHERE spec_id = ? ORDER BY kind').all(spec.spec_id) as Array<{ kind: string; ref: string }>
      expect(links.map(l => l.kind).sort()).toEqual(['report', 'run_manifest'])
      // Outbox event.
      const events = kernel.listEvents(p.project_id)
      expect(events.some(e => e.kind === 'reproduction.report.recorded' && e.payload.report_id === report.report_id)).toBe(true)
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('report idempotency: same key+hash replays the SAME report, different hash 409', () => {
    const { kernel, dir } = freshKernel()
    try {
      const p = project(kernel)
      const spec = kernel.createReproductionSpec({ ...specInput(), project_id: p.project_id } as never)
      kernel.updateReproductionSpec(p.project_id, spec.spec_id, { expected_revision: 1, patch: { status: 'confirmed' } })
      const { attempt, lease_token: token } = kernel.startReproductionAttempt(p.project_id, spec.spec_id, { submitter_principal: 'pi-1' })
      const base = { attempt_id: attempt.attempt_id, service_principal: 'verifier' as const, request_id: 'r1', attempt_generation: 1, lease_token: token! }
      const first = kernel.reportReproductionAttempt({ ...base, idempotency_key: 'report-idem-1', request_hash: 'hash-x', report: passReportInput() as never })
      const replay = kernel.reportReproductionAttempt({ ...base, idempotency_key: 'report-idem-1', request_hash: 'hash-x', report: passReportInput() as never })
      expect(replay.report_id).toBe(first.report_id)
      expect(kernel.listReproductionReports(p.project_id)).toHaveLength(1)
      try {
        kernel.reportReproductionAttempt({ ...base, idempotency_key: 'report-idem-1', request_hash: 'hash-y', report: passReportInput() as never })
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).status).toBe(409)
        expect((error as KernelError).code).toBe('idempotency_conflict')
      }
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exit 0 + out-of-tolerance → fail report with scientific failure class; blocked preflight → blocked spec', () => {
    const { kernel, dir } = freshKernel()
    try {
      const p = project(kernel)
      const spec = kernel.createReproductionSpec({
        project_id: p.project_id, ...specInput({
          metric_comparators: [metric('mAP', 58.4, { absolute: 0.5 })],
        }),
      } as Record<string, unknown>)
      kernel.updateReproductionSpec(p.project_id, spec.spec_id, { expected_revision: 1, patch: { status: 'confirmed' } })
      const { attempt, lease_token: token } = kernel.startReproductionAttempt(p.project_id, spec.spec_id, { submitter_principal: 'pi-1' })
      const comparisons = compareMetrics(
        [metric('mAP', 58.4, { absolute: 0.5 })],
        [{ name: 'mAP', value: 51.0 }],
      ).comparisons
      const checks = reportChecksFor(comparisons)
      const input = {
        ...passReportInput(),
        status: evaluateReportStatus(checks), // fail
        checks,
        paper_comparisons: { metrics: comparisons, tables: [], figures: [], checks: [] },
        // exit 0 but scientific mismatch — failure_class is metric_mismatch,
        // never code_error; the verifier declares retryability.
        runtime_verified: { exit_code: 0, execution_succeeded: true, run_manifest_signed: true, lease_fenced: true },
        failure_class: suggestFailureClass(checks),
        retryable: true,
      }
      const report = kernel.reportReproductionAttempt({
        attempt_id: attempt.attempt_id, service_principal: 'verifier', request_id: 'r1',
        attempt_generation: 1, lease_token: token!, report: input as never,
      })
      expect(report.status).toBe('fail')
      expect(report.failure_class).toBe('metric_mismatch')
      expect(report.failure_class).not.toBe('code_error')
      expect(report.retryable).toBe(true)
      expect(report.paper_comparisons.metrics[0]?.status).toBe('fail')
      expect(kernel.getReproductionSpec(p.project_id, spec.spec_id).status).toBe('completed')
      // A blocked report keeps the spec blocked (never silently skipped).
      const spec2 = kernel.createReproductionSpec({ project_id: p.project_id, ...specInput({ idempotency_key: undefined }) } as Record<string, unknown>)
      kernel.updateReproductionSpec(p.project_id, spec2.spec_id, { expected_revision: 1, patch: { status: 'confirmed' } })
      const started2 = kernel.startReproductionAttempt(p.project_id, spec2.spec_id, { submitter_principal: 'pi-1' })
      const blockedInput = {
        ...passReportInput(),
        status: 'blocked',
        preflight: { ok: false, checks: [], blocked: true, reason: 'clean-room cannot satisfy the acquisition recipe (expected hash unavailable)' },
        failure_class: 'environment',
      }
      const blocked = kernel.reportReproductionAttempt({
        attempt_id: started2.attempt.attempt_id, service_principal: 'verifier', request_id: 'r2',
        attempt_generation: 1, lease_token: started2.lease_token!, report: blockedInput as never,
      })
      expect(blocked.status).toBe('blocked')
      expect(kernel.getReproductionSpec(p.project_id, spec2.spec_id).status).toBe('blocked')
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cross-project report lookup is 404', () => {
    const { kernel, dir } = freshKernel()
    try {
      const a = project(kernel, 'a')
      const b = project(kernel, 'b')
      const spec = kernel.createReproductionSpec({ ...specInput(), project_id: a.project_id } as never)
      kernel.updateReproductionSpec(a.project_id, spec.spec_id, { expected_revision: 1, patch: { status: 'confirmed' } })
      const { attempt, lease_token: token } = kernel.startReproductionAttempt(a.project_id, spec.spec_id, { submitter_principal: 'pi-1' })
      const report = kernel.reportReproductionAttempt({
        attempt_id: attempt.attempt_id, service_principal: 'verifier', request_id: 'r1',
        attempt_generation: 1, lease_token: token!, report: passReportInput() as never,
      })
      expect(() => kernel.getReproductionReport(a.project_id, report.report_id)).not.toThrow()
      try {
        kernel.getReproductionReport(b.project_id, report.report_id)
        throw new Error('expected KernelError')
      } catch (error) {
        expect((error as KernelError).status).toBe(404)
        expect((error as KernelError).code).toBe('reproduction_report_not_found')
      }
    } finally {
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── NextAction semantics (contract §3/§5) ───────────────────────────────────

function reproView(overrides: Partial<NextActionReproduction> & { spec_id: string }): NextActionReproduction {
  return {
    status: 'draft', revision: 1, attempt_count: 0, report_count: 0,
    latest_report_status: null, has_running_attempt: false,
    ...overrides,
  }
}

function contractFixture() {
  return {
    contract_id: 'expc_1', project_id: 'rsp_x', status: 'approved', version: 1, idea_id: '',
    data: {}, methods: {}, metrics: {}, seeds: [], analysis: {}, ablations: [], stop_conditions: {},
    created_at: NOW, updated_at: NOW,
  }
}

function actionCtx(overrides: Partial<NextActionContext> & { status: 'BASELINE_REPRO' }): NextActionContext {
  return {
    project: {
      project_id: 'rsp_x', name: 'x', workspace: '/w', mode: 'gate-only', status: overrides.status,
      revision: 3, brief: makeBrief() as never, constraints: {} as never, execution: {} as never,
      integrity: {} as never, session_id: null, dsh_workspace_id: null,
      created_at: NOW, updated_at: NOW, history: [],
    },
    gates: [], jobs: [], budget: { project_id: 'rsp_x', model_cost_usd: 0, gpu_hours: 0, api_requests: 0, updated_at: NOW },
    contracts: [], ideas: [], evidence: [], claims: [], corpus_snapshots: [],
    ...overrides,
  }
}

describe('NextAction reproduction semantics', () => {
  it('baseline_reproduce is done ONLY with a persisted pass report; fail/inconclusive reports keep it ready + retry action', () => {
    // Legacy context (no reproductions): job-based semantics unchanged.
    const legacy = nextActionProjection(actionCtx({ status: 'BASELINE_REPRO', jobs: [{ job_id: 'j1', kind: 'baseline', status: 'succeeded', failure_class: null, attempts: 1, max_attempts: 3, contract_id: null, created_at: NOW }] }))
    expect(legacy.find(a => a.code === 'baseline_reproduce')?.state).toBe('done')
    // Pass report → done (even without a baseline job row — the report is authoritative).
    const pass = nextActionProjection(actionCtx({
      status: 'BASELINE_REPRO',
      reproductions: [reproView({ spec_id: 'repro_1', status: 'completed', report_count: 1, latest_report_status: 'pass' })],
    }))
    expect(pass.find(a => a.code === 'baseline_reproduce')?.state).toBe('done')
    // Fail report → NOT done + reproduction_retry_or_repair overlay.
    const fail = nextActionProjection(actionCtx({
      status: 'BASELINE_REPRO',
      contracts: [{ contract_id: 'expc_1', project_id: 'rsp_x', status: 'approved', version: 1, idea_id: '', data: {} as never, methods: {} as never, metrics: {} as never, seeds: [], analysis: {} as never, ablations: [], stop_conditions: {} as never, created_at: NOW, updated_at: NOW }] as never,
      jobs: [{ job_id: 'j1', kind: 'baseline', status: 'succeeded', failure_class: null, attempts: 1, max_attempts: 3, contract_id: 'expc_1', created_at: NOW }],
      reproductions: [reproView({ spec_id: 'repro_1', status: 'completed', report_count: 1, latest_report_status: 'fail', attempt_count: 1 })],
    }))
    expect(fail.find(a => a.code === 'baseline_reproduce')?.state).toBe('ready')
    expect(fail.some(a => a.code === 'reproduction_retry_or_repair' && a.state === 'ready')).toBe(true)
    // Blocked report → blocked retry with the environment gap.
    const blocked = nextActionProjection(actionCtx({
      status: 'BASELINE_REPRO',
      contracts: [contractFixture()] as never,
      reproductions: [reproView({ spec_id: 'repro_1', status: 'blocked', report_count: 1, latest_report_status: 'blocked' })],
    }))
    expect(blocked.find(a => a.code === 'baseline_reproduce')?.state).toBe('ready')
    expect(blocked.find(a => a.code === 'reproduction_retry_or_repair')?.state).toBe('blocked')
    expect(blocked.find(a => a.code === 'reproduction_retry_or_repair')?.required).toEqual(['reproduction_environment'])
  })

  it('wizard overlay: draft → plan_confirm; confirmed → run; running attempt → compare', () => {
    const draft = nextActionProjection(actionCtx({ status: 'BASELINE_REPRO', reproductions: [reproView({ spec_id: 'repro_1', status: 'draft' })] }))
    expect(draft.some(a => a.code === 'reproduction_plan_confirm' && a.required_by === 'human')).toBe(true)
    const confirmed = nextActionProjection(actionCtx({ status: 'BASELINE_REPRO', reproductions: [reproView({ spec_id: 'repro_1', status: 'confirmed' })] }))
    expect(confirmed.some(a => a.code === 'reproduction_run' && a.required_by === 'agent')).toBe(true)
    const running = nextActionProjection(actionCtx({
      status: 'BASELINE_REPRO',
      reproductions: [reproView({ spec_id: 'repro_1', status: 'confirmed', attempt_count: 1, has_running_attempt: true })],
    }))
    expect(running.some(a => a.code === 'reproduction_compare')).toBe(true)
  })
})

// ── HTTP surface (contract §4) ──────────────────────────────────────────────

function addMember(kernel: ResearchKernel, projectId: string, principalId = 'pi-1', role = 'pi'): void {
  const now = new Date().toISOString()
  kernel.db.prepare(`INSERT INTO project_members (project_id, principal_id, tenant_id, role, created_at, updated_at)
    VALUES (?, ?, '', ?, ?, ?) ON CONFLICT(project_id, principal_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`)
    .run(projectId, principalId, role, now, now)
}

describe('reproduction HTTP surface', () => {
  it('POST /v2/projects/{id}/reproduction-specs: 201 with principal, 422 without; spec lookup cross-project 404', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const { kernel, dir } = freshKernel()
    const a = project(kernel, 'a')
    const b = project(kernel, 'b')
    addMember(kernel, a.project_id)
    addMember(kernel, b.project_id)
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}`
      const noPrincipal = await fetch(`${base}/v2/projects/${a.project_id}/reproduction-specs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paper_ref: DOI_REF, claims_to_reproduce: [{ claim_ref: 'c' }] }),
      })
      expect(noPrincipal.status).toBe(422)
      const created = await fetch(`${base}/v2/projects/${a.project_id}/reproduction-specs`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'pi-1' },
        body: JSON.stringify({ paper_ref: DOI_REF, claims_to_reproduce: [{ claim_ref: 'c' }], idempotency_key: 'http-spec-1' }),
      })
      expect(created.status).toBe(201)
      const spec = await created.json() as { spec_id: string }
      const listed = await fetch(`${base}/v2/projects/${a.project_id}/reproduction-specs`, { headers: { 'x-principal-id': 'pi-1' } })
      expect(listed.status).toBe(200)
      expect(((await listed.json()) as Array<{ spec_id: string }>).map(s => s.spec_id)).toContain(spec.spec_id)
      const foreign = await fetch(`${base}/v2/projects/${b.project_id}/reproduction-specs/${spec.spec_id}`, { headers: { 'x-principal-id': 'pi-1' } })
      expect(foreign.status).toBe(404)
      const badPaper = await fetch(`${base}/v2/projects/${a.project_id}/reproduction-specs`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'pi-1' },
        body: JSON.stringify({ paper_ref: { doi: 'nope' }, claims_to_reproduce: [{ claim_ref: 'c' }] }),
      })
      expect(badPaper.status).toBe(422)
      const env = await badPaper.json() as { error?: { code?: string } }
      expect(env.error?.code).toBe('invalid_paper_ref')
    } finally {
      server.close()
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('POST /internal/reproduction-attempts/{attempt}/reports: service token + verifier principal required; GET report 200/404', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const { kernel, dir } = freshKernel('dsh-scholar-eval-service-token')
    const a = project(kernel, 'a')
    const b = project(kernel, 'b')
    addMember(kernel, a.project_id)
    addMember(kernel, b.project_id)
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}`
      const spec = kernel.createReproductionSpec({ ...specInput(), project_id: a.project_id } as never)
      kernel.updateReproductionSpec(a.project_id, spec.spec_id, { expected_revision: 1, patch: { status: 'confirmed' } })
      const started = kernel.startReproductionAttempt(a.project_id, spec.spec_id, { submitter_principal: 'pi-1' })
      const path = `/internal/reproduction-attempts/${started.attempt.attempt_id}/reports`
      const reportBody = { ...passReportInput(), attempt_generation: started.generation, lease_token: started.lease_token! }
      // No service token → 403 service_token_required.
      const noToken = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-service-principal': 'verifier' },
        body: JSON.stringify(reportBody),
      })
      expect(noToken.status).toBe(403)
      expect(((await noToken.json()) as { error?: { code?: string } }).error?.code).toBe('service_token_required')
      // Token but non-verifier principal → 403 service_identity_required.
      const badPrincipal = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': 'dsh-scholar-eval-service-token', 'x-service-principal': 'analysis-worker' },
        body: JSON.stringify(reportBody),
      })
      expect(badPrincipal.status).toBe(403)
      expect(((await badPrincipal.json()) as { error?: { code?: string } }).error?.code).toBe('service_identity_required')
      // Token + verifier → 201, immutable report stored.
      const ok = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': 'dsh-scholar-eval-service-token', 'x-service-principal': 'verifier', 'idempotency-key': 'http-report-1' },
        body: JSON.stringify(reportBody),
      })
      expect(ok.status).toBe(201)
      const report = await ok.json() as { report_id: string; status: string }
      expect(report.status).toBe('pass')
      // Idempotent replay returns the same report.
      const replay = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': 'dsh-scholar-eval-service-token', 'x-service-principal': 'verifier', 'idempotency-key': 'http-report-1' },
        body: JSON.stringify(reportBody),
      })
      expect(replay.status).toBe(201)
      expect(((await replay.json()) as { report_id: string }).report_id).toBe(report.report_id)
      // GET report in-project 200, cross-project 404.
      const get = await fetch(`${base}/v2/projects/${a.project_id}/reproduction-reports/${report.report_id}`, { headers: { 'x-principal-id': 'pi-1' } })
      expect(get.status).toBe(200)
      const foreign = await fetch(`${base}/v2/projects/${b.project_id}/reproduction-reports/${report.report_id}`, { headers: { 'x-principal-id': 'pi-1' } })
      expect(foreign.status).toBe(404)
      // Wrong lease token through HTTP → 409 lease_stale.
      const stale = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': 'dsh-scholar-eval-service-token', 'x-service-principal': 'verifier' },
        body: JSON.stringify({ ...reportBody, lease_token: 'wrong' }),
      })
      expect(stale.status).toBe(409)
      expect(((await stale.json()) as { error?: { code?: string } }).error?.code).toBe('lease_stale')
    } finally {
      server.close()
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('POST /v2/projects/{id}/reproduction-specs/{spec}/attempts starts a fenced attempt', async () => {
    const { startKernelServer } = await import('../../packages/research-kernel/lib/server.js')
    const { kernel, dir } = freshKernel()
    const p = project(kernel)
    addMember(kernel, p.project_id)
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}`
      const created = await fetch(`${base}/v2/projects/${p.project_id}/reproduction-specs`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'pi-1' },
        body: JSON.stringify({ paper_ref: DOI_REF, claims_to_reproduce: [{ claim_ref: 'c' }] }),
      })
      const spec = await created.json() as { spec_id: string }
      await fetch(`${base}/v2/projects/${p.project_id}/reproduction-specs/${spec.spec_id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', 'x-principal-id': 'pi-1' },
        body: JSON.stringify({ expected_revision: 1, patch: { status: 'confirmed' } }),
      })
      const attemptRes = await fetch(`${base}/v2/projects/${p.project_id}/reproduction-specs/${spec.spec_id}/attempts`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'pi-1' },
        body: JSON.stringify({ reason: 'http attempt' }),
      })
      expect(attemptRes.status).toBe(201)
      const started = await attemptRes.json() as { attempt: { attempt_id: string }; generation: number; lease_token: string }
      expect(started.generation).toBe(1)
      expect(started.lease_token).toMatch(/^[0-9a-f]{48}$/)
      const getAttempt = await fetch(`${base}/v2/projects/${p.project_id}/reproduction-attempts/${started.attempt.attempt_id}`, { headers: { 'x-principal-id': 'pi-1' } })
      expect(getAttempt.status).toBe(200)
      expect(((await getAttempt.json()) as { status: string }).status).toBe('running')
    } finally {
      server.close()
      kernel.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ReproductionReportInput rejects an inconsistent status/checks pair (protocol error)', () => {
    const good = passReportInput()
    expect(ReproductionReportInput.safeParse(good).success).toBe(true)
    // status=pass with a required fail check is a protocol error.
    expect(ReproductionReportInput.safeParse({ ...good, status: 'pass', checks: [check('a', 'fail')] }).success).toBe(false)
    expect(ReproductionReportInput.safeParse({ ...good, status: 'fail', checks: [check('a', 'fail')] }).success).toBe(true)
  })
})
