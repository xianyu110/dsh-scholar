/**
 * Analysis Worker unit tests (design §12.5 metrics file, §13.2 RunSet,
 * §13.3 AnalysisPlan, §13.4 EvidenceItem result, §13.6 statistics).
 *
 * Tests run against the built package (lib/), like the other unit suites in
 * this repository; run `pnpm --filter @dsh-scholar/analysis-worker run build`
 * before `pnpm test`.
 */
import { describe, expect, it } from 'vitest'
import {
  computePairedAnalysis,
  holmAdjust,
  parseMetricsFile,
  validateAnalysisPlan,
  validateMetricSpec,
  validateRunSet,
  type AnalysisPlan,
  type PerRunMetric,
} from '../../workers/analysis-worker/lib/index.js'

function run(runId: string, seed: number, value: number): PerRunMetric {
  return { run_id: runId, seed, metric_value: value }
}

function makePlan(overrides: Partial<AnalysisPlan> = {}): AnalysisPlan {
  return {
    analysis_plan_id: 'analysis_plan_001',
    contract_id: 'expc_007',
    metric: { name: 'macro_f1', direction: 'higher_is_better', aggregation: 'mean', unit: 'ratio' },
    paired_by: 'seed',
    baseline_run_set_id: 'runset_baseline_001',
    treatment_run_set_id: 'runset_treatment_001',
    method: { estimator: 'paired_mean_difference', interval: 'bootstrap_95', resamples: 10000 },
    multiple_testing: 'holm',
    minimum_n: 5,
    ...overrides,
  }
}

/** §13.2-style baseline dataset, seeds 1..5. */
function baselineFive(): PerRunMetric[] {
  return [run('b1', 1, 10), run('b2', 2, 20), run('b3', 3, 30), run('b4', 4, 40), run('b5', 5, 50)]
}

/** §13.2-style treatment dataset, seeds 1..5. Diffs vs baseline: 5,3,1,2,5. */
function treatmentFive(): PerRunMetric[] {
  return [run('t1', 1, 15), run('t2', 2, 23), run('t3', 3, 31), run('t4', 4, 42), run('t5', 5, 55)]
}

describe('computePairedAnalysis — paired statistics correctness (§13.4)', () => {
  it('computes means, paired mean difference and effect size on 5 hand-built pairs', () => {
    const result = computePairedAnalysis(makePlan(), baselineFive(), treatmentFive())
    // baseline mean (10+20+30+40+50)/5 = 30; treatment mean (15+23+31+42+55)/5 = 33.2
    expect(result.baseline_mean).toBe(30)
    expect(result.treatment_mean).toBe(33.2)
    // per-seed diffs: 5,3,1,2,5 → mean 3.2
    expect(result.paired_mean_difference).toBeCloseTo(3.2, 10)
    expect(result.effect_size).toBeCloseTo(3.2, 10)
    expect(result.n_pairs).toBe(5)
    expect(result.metric).toBe('macro_f1')
    expect(result.direction).toBe('higher_is_better')
  })

  it('brackets the observed effect with the bootstrap 95% CI, inside the diff range', () => {
    const result = computePairedAnalysis(makePlan(), baselineFive(), treatmentFive())
    expect(result.ci_low).toBeLessThan(result.ci_high)
    expect(result.ci_low).toBeGreaterThanOrEqual(1) // min diff
    expect(result.ci_high).toBeLessThanOrEqual(5) // max diff
    expect(result.ci_low).toBeLessThan(3.2)
    expect(result.ci_high).toBeGreaterThan(3.2)
    expect(result.adjusted_p_value).toBeGreaterThan(0)
    expect(result.adjusted_p_value).toBeLessThanOrEqual(1)
  })

  it('yields an exact CI when all paired differences are identical', () => {
    const baseline = baselineFive()
    const treatment = baselineFive().map((b, i) => run(`t${i + 1}`, b.seed as number, b.metric_value + 2))
    const result = computePairedAnalysis(makePlan(), baseline, treatment)
    expect(result.paired_mean_difference).toBe(2)
    expect(result.ci_low).toBe(2)
    expect(result.ci_high).toBe(2)
    expect(result.direction_ok).toBe(true)
  })

  it('is fully deterministic: repeated runs produce identical results', () => {
    const a = computePairedAnalysis(makePlan(), baselineFive(), treatmentFive())
    const b = computePairedAnalysis(makePlan(), baselineFive(), treatmentFive())
    expect(a).toEqual(b)
    expect(a.ci_low).toBe(b.ci_low)
    expect(a.ci_high).toBe(b.ci_high)
    expect(a.adjusted_p_value).toBe(b.adjusted_p_value)
  })
})

describe('computePairedAnalysis — pairing by seed (§13.6)', () => {
  it('pairs only seeds present on both sides and skips unpaired runs', () => {
    const baseline = baselineFive()
    // treatment covers seeds 1,2,3 plus new seeds 6,7 — 4 and 5 are unpaired
    const treatment = [run('t1', 1, 15), run('t2', 2, 23), run('t3', 3, 31), run('t6', 6, 60), run('t7', 7, 70)]
    const result = computePairedAnalysis(makePlan({ minimum_n: 3 }), baseline, treatment)
    expect(result.n_pairs).toBe(3)
    // means over paired seeds only: baseline (10+20+30)/3 = 20; treatment (15+23+31)/3 = 23
    expect(result.baseline_mean).toBe(20)
    expect(result.treatment_mean).toBe(23)
    // diffs 5,3,1 → mean 3
    expect(result.paired_mean_difference).toBeCloseTo(3, 10)
    expect(result.direction_ok).toBe(true)
  })

  it('throws when the number of paired runs is below plan.minimum_n', () => {
    const baseline = [run('b1', 1, 10), run('b2', 2, 20), run('b3', 3, 30)]
    const treatment = [run('t1', 1, 15), run('t2', 2, 23), run('t3', 3, 31)]
    expect(() => computePairedAnalysis(makePlan(), baseline, treatment)).toThrow(/minimum_n/)
  })

  it('throws when no seeds match at all', () => {
    const baseline = [run('b1', 1, 10), run('b2', 2, 20)]
    const treatment = [run('t9', 9, 15), run('t8', 8, 23)]
    expect(() => computePairedAnalysis(makePlan({ minimum_n: 1 }), baseline, treatment)).toThrow(/minimum_n/)
  })

  it('rejects duplicate seeds within one side', () => {
    const baseline = baselineFive()
    const treatment = [...treatmentFive(), run('t1dup', 1, 99)]
    expect(() => computePairedAnalysis(makePlan(), baseline, treatment)).toThrow(/duplicate seed/)
  })
})

describe('computePairedAnalysis — direction (§13.4, §13.5)', () => {
  const up = [run('b1', 1, 10), run('b2', 2, 20)]
  const positive = [run('t1', 1, 12), run('t2', 2, 22)] // effect +2
  const negative = [run('t1', 1, 9), run('t2', 2, 18)] // effect −1.5
  const zero = [run('t1', 1, 10), run('t2', 2, 20)] // effect 0

  it('higher_is_better: positive effect is direction_ok, negative/zero is not', () => {
    const plan = makePlan({ minimum_n: 2 })
    expect(computePairedAnalysis(plan, up, positive).direction_ok).toBe(true)
    expect(computePairedAnalysis(plan, up, negative).direction_ok).toBe(false)
    expect(computePairedAnalysis(plan, up, zero).direction_ok).toBe(false)
  })

  it('lower_is_better: negative effect is direction_ok, positive/zero is not', () => {
    const plan = makePlan({ minimum_n: 2, metric: { name: 'loss', direction: 'lower_is_better', aggregation: 'mean' } })
    expect(computePairedAnalysis(plan, up, positive).direction_ok).toBe(false)
    expect(computePairedAnalysis(plan, up, negative).direction_ok).toBe(true)
    expect(computePairedAnalysis(plan, up, zero).direction_ok).toBe(false)
  })
})

describe('parseMetricsFile (§12.5)', () => {
  it('parses a valid fixed-schema metrics file and strips unit', () => {
    const parsed = parseMetricsFile(
      JSON.stringify({
        schema_version: 1,
        run_id: 'run_001',
        contract_id: 'expc_007',
        seed: 11,
        metrics: [
          { name: 'macro_f1', value: 0.812, unit: 'ratio' },
          { name: 'accuracy', value: 0.9, unit: 'ratio' },
        ],
      }),
    )
    expect(parsed).toEqual({
      run_id: 'run_001',
      contract_id: 'expc_007',
      seed: 11,
      metrics: [
        { name: 'macro_f1', value: 0.812 },
        { name: 'accuracy', value: 0.9 },
      ],
    })
  })

  it.each([
    ['invalid JSON', 'this is not json'],
    ['wrong schema_version', { schema_version: 2, run_id: 'r', contract_id: 'c', seed: 1, metrics: [{ name: 'm', value: 1, unit: 'u' }] }],
    ['missing run_id', { schema_version: 1, contract_id: 'c', seed: 1, metrics: [{ name: 'm', value: 1, unit: 'u' }] }],
    ['missing contract_id', { schema_version: 1, run_id: 'r', seed: 1, metrics: [{ name: 'm', value: 1, unit: 'u' }] }],
    ['non-numeric seed', { schema_version: 1, run_id: 'r', contract_id: 'c', seed: 'eleven', metrics: [{ name: 'm', value: 1, unit: 'u' }] }],
    ['metrics not an array', { schema_version: 1, run_id: 'r', contract_id: 'c', seed: 1, metrics: { name: 'm', value: 1 } }],
    ['empty metrics', { schema_version: 1, run_id: 'r', contract_id: 'c', seed: 1, metrics: [] }],
    ['metric without name', { schema_version: 1, run_id: 'r', contract_id: 'c', seed: 1, metrics: [{ value: 1, unit: 'u' }] }],
    ['non-numeric value', { schema_version: 1, run_id: 'r', contract_id: 'c', seed: 1, metrics: [{ name: 'm', value: 'high', unit: 'u' }] }],
    ['top-level array', [1, 2, 3]],
  ])('rejects malformed metrics file: %s', (_label, obj) => {
    const content = typeof obj === 'string' ? obj : JSON.stringify(obj)
    expect(() => parseMetricsFile(content)).toThrow()
  })
})

describe('validation (§13.2, §13.3)', () => {
  it('validateMetricSpec accepts a valid spec and rejects invalid ones', () => {
    const good = { name: 'macro_f1', direction: 'higher_is_better', aggregation: 'mean', unit: 'ratio' }
    expect(validateMetricSpec(good)).toEqual(good)
    expect(() => validateMetricSpec({ name: 'm', direction: 'sideways', aggregation: 'mean' })).toThrow(/direction/)
    expect(() => validateMetricSpec({ name: 'm', direction: 'higher_is_better', aggregation: 'median' })).toThrow(/aggregation/)
    expect(() => validateMetricSpec({ name: '', direction: 'higher_is_better', aggregation: 'mean' })).toThrow(/name/)
    expect(() => validateMetricSpec(null)).toThrow()
  })

  it('validateRunSet accepts a valid run set and rejects invalid ones', () => {
    const good = {
      contract_id: 'expc_007',
      method: 'treatment',
      metric: 'macro_f1',
      runs: ['run_seed_11', 'run_seed_23'],
      validation: { seeds_unique: true, min_completed_met: true, same_code_snapshot: true, same_data_hash: true },
    }
    expect(validateRunSet(good)).toEqual(good)
    expect(() => validateRunSet({ ...good, runs: [] })).toThrow(/runs/)
    expect(() => validateRunSet({ ...good, runs: 'run_seed_11' })).toThrow(/runs/)
    expect(() => validateRunSet({ ...good, contract_id: '' })).toThrow(/contract_id/)
    expect(() =>
      validateRunSet({ ...good, validation: { ...good.validation, min_completed_met: 'yes' } }),
    ).toThrow(/min_completed_met/)
    expect(() => validateRunSet({ ...good, validation: { ...good.validation, seeds_unique: 1 } })).toThrow(/seeds_unique/)
  })

  it('validateAnalysisPlan accepts a valid plan and rejects invalid ones', () => {
    const plan = makePlan()
    expect(validateAnalysisPlan(plan)).toEqual(plan)
    expect(() => validateAnalysisPlan(makePlan({ paired_by: 'run_id' as never }))).toThrow(/paired_by/)
    expect(() => validateAnalysisPlan(makePlan({ method: { ...plan.method, estimator: 'ttest' as never } }))).toThrow(/estimator/)
    expect(() => validateAnalysisPlan(makePlan({ method: { ...plan.method, resamples: 0 } }))).toThrow(/resamples/)
    expect(() => validateAnalysisPlan(makePlan({ minimum_n: 0 }))).toThrow(/minimum_n/)
    expect(() => validateAnalysisPlan(makePlan({ baseline_run_set_id: 'same' as never, treatment_run_set_id: 'same' }))).toThrow(/differ/)
    expect(() => validateAnalysisPlan(makePlan({ multiple_testing: 'bonferroni' as never }))).toThrow(/multiple_testing/)
  })
})

describe('holmAdjust', () => {
  it('is the identity for a single p-value', () => {
    expect(holmAdjust([0.05])).toEqual([0.05])
  })

  it('applies the Holm step-down adjustment', () => {
    expect(holmAdjust([0.01, 0.04])).toEqual([0.02, 0.02])
    expect(holmAdjust([0.04, 0.01])).toEqual([0.02, 0.02])
  })
})
