/**
 * Analysis Worker unit tests (design §12.5 metrics file, §13.2 RunSet,
 * §13.3 AnalysisPlan, §13.4 EvidenceItem result, §13.6 statistics).
 *
 * Tests run against the built package (lib/), like the other unit suites in
 * this repository; run `pnpm --filter @dsh-scholar/analysis-worker run build`
 * before `pnpm test`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  computePairedAnalysis,
  holmAdjust,
  parseMetricsFile,
  validateAnalysisPlan,
  validateMetricSpec,
  validateRunSet,
  type AnalysisPlan,
  type PairedAnalysisResult,
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
    const zeroResult = computePairedAnalysis(plan, up, zero)
    expect(zeroResult.direction_ok).toBe(false)
    // §12: zero paired difference ⇒ direction_ok=false and raw p=1.
    expect(zeroResult.raw_p_value).toBe(1)
  })

  it('lower_is_better: negative effect is direction_ok, positive/zero is not', () => {
    const plan = makePlan({ minimum_n: 2, metric: { name: 'loss', direction: 'lower_is_better', aggregation: 'mean' } })
    expect(computePairedAnalysis(plan, up, positive).direction_ok).toBe(false)
    expect(computePairedAnalysis(plan, up, negative).direction_ok).toBe(true)
    const zeroResult = computePairedAnalysis(plan, up, zero)
    expect(zeroResult.direction_ok).toBe(false)
    expect(zeroResult.raw_p_value).toBe(1)
  })

  it('reports a two-sided bootstrap raw_p_value in (0,1] with adjusted_p_value == raw_p for one metric', () => {
    const plan = makePlan({ minimum_n: 2 })
    const r = computePairedAnalysis(plan, up, positive)
    expect(r.raw_p_value).toBeGreaterThan(0)
    expect(r.raw_p_value).toBeLessThanOrEqual(1)
    expect(r.adjusted_p_value).toBe(r.raw_p_value) // Holm identity for one metric
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
    ['duplicate metric names', { schema_version: 1, run_id: 'r', contract_id: 'c', seed: 1, metrics: [{ name: 'm', value: 1 }, { name: 'm', value: 2 }] }],
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
    // §12: bootstrap resamples are production-fixed at 10,000.
    expect(() => validateAnalysisPlan(makePlan({ method: { ...plan.method, resamples: 1000 } }))).toThrow(/10000/)
    expect(() => validateAnalysisPlan(makePlan({ method: { ...plan.method, resamples: 10001 } }))).toThrow(/10000/)
    expect(() => validateAnalysisPlan(makePlan({ minimum_n: 0 }))).toThrow(/minimum_n/)
    expect(() => validateAnalysisPlan(makePlan({ baseline_run_set_id: 'same' as never, treatment_run_set_id: 'same' }))).toThrow(/differ/)
    expect(() => validateAnalysisPlan(makePlan({ multiple_testing: 'bonferroni' as never }))).toThrow(/multiple_testing/)
  })
})

describe('holmAdjust', () => {
  it('is the identity for a single p-value', () => {
    expect(holmAdjust([0.05])).toEqual([0.05])
  })

  it('applies the classic Holm step-down adjustment (monotone, capped at 1)', () => {
    // sorted [0.01, 0.04]: steps 2*0.01=0.02, 1*0.04=0.04 → input order [0.02, 0.04]
    expect(holmAdjust([0.01, 0.04])).toEqual([0.02, 0.04])
    // input order: 0.04→0.04, 0.01→0.02
    expect(holmAdjust([0.04, 0.01])).toEqual([0.04, 0.02])
    // steps 2*0.7=1 → cap 1, 1*0.9=0.9 → running max 1
    expect(holmAdjust([0.7, 0.9])).toEqual([1, 1])
    // steps 2*0.4=0.8, 1*0.7=0.7 → monotone max [0.8, 0.8]
    expect(holmAdjust([0.4, 0.7])).toEqual([0.8, 0.8])
  })

  it('breaks ties by metric name ascending and stays monotone (§12)', () => {
    // equal raw p: adjusted values are identical; the order only decides the
    // tie-break, never the values
    expect(holmAdjust([0.01, 0.01], ['z_metric', 'a_metric'])).toEqual([0.02, 0.02])
    expect(() => holmAdjust([0.1], ['a', 'b'])).toThrow(/names/)
  })
})

// ── §6 / §12 determinism + golden vector ─────────────────────────────────────

interface GoldenFixture {
  schema_version: number
  input: { plan: AnalysisPlan; baseline_runs: PerRunMetric[]; treatment_runs: PerRunMetric[] }
  output: { result: PairedAnalysisResult }
  canonical_output: string
  additional_cases?: Array<{
    label: string
    input: { plan: AnalysisPlan; baseline_runs: PerRunMetric[]; treatment_runs: PerRunMetric[] }
    output: { result: PairedAnalysisResult }
    canonical_output: string
  }>
}

/**
 * Loads the committed golden vector (docs/reconstruction-contracts.md §12:
 * "golden vector 存 tests/fixtures/analysis-v1.json"). Path is resolved
 * relative to this test file so the suite runs from any cwd.
 */
function loadGoldenFixture(): GoldenFixture {
  const url = new URL('../fixtures/analysis-v1.json', import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8')) as GoldenFixture
}

describe('computePairedAnalysis — §6 byte determinism & §12 golden vector', () => {
  const fixture = loadGoldenFixture()

  it('identical input twice → JSON.stringify output byte-identical', () => {
    const { plan, baseline_runs: baseline, treatment_runs: treatment } = fixture.input
    const first = computePairedAnalysis(plan, baseline, treatment)
    const second = computePairedAnalysis(plan, baseline, treatment)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(JSON.stringify(first)).toBe(JSON.stringify(first))
  })

  it('matches the committed golden vector canonical_output byte-for-byte (§12)', () => {
    const { plan, baseline_runs: baseline, treatment_runs: treatment } = fixture.input
    const result = computePairedAnalysis(plan, baseline, treatment)
    expect(JSON.stringify(result)).toBe(fixture.canonical_output)
    // every result field is present and in the interface-declared key order
    expect(Object.keys(result)).toEqual([
      'metric',
      'direction',
      'baseline_mean',
      'treatment_mean',
      'paired_mean_difference',
      'effect_size',
      'ci_low',
      'ci_high',
      'n_pairs',
      'raw_p_value',
      'adjusted_p_value',
      'direction_ok',
    ])
    expect(result).toEqual(fixture.output.result)
  })

  it('matches the golden vector additional case (m2 lower_is_better) byte-for-byte', () => {
    const extra = fixture.additional_cases?.[0]
    expect(extra).toBeDefined()
    const result = computePairedAnalysis(extra!.input.plan, extra!.input.baseline_runs, extra!.input.treatment_runs)
    expect(JSON.stringify(result)).toBe(extra!.canonical_output)
    expect(result.direction).toBe('lower_is_better')
    expect(result.direction_ok).toBe(false) // positive effect is bad for lower_is_better
    // §12: key order must match the PairedAnalysisResult interface declaration
    // order for EVERY case, not just the primary one.
    expect(Object.keys(result)).toEqual([
      'metric',
      'direction',
      'baseline_mean',
      'treatment_mean',
      'paired_mean_difference',
      'effect_size',
      'ci_low',
      'ci_high',
      'n_pairs',
      'raw_p_value',
      'adjusted_p_value',
      'direction_ok',
    ])
  })

  it('matches the golden vector additional case (mz zero difference) byte-for-byte', () => {
    const extra = fixture.additional_cases?.[1]
    expect(extra).toBeDefined()
    const result = computePairedAnalysis(extra!.input.plan, extra!.input.baseline_runs, extra!.input.treatment_runs)
    expect(JSON.stringify(result)).toBe(extra!.canonical_output)
    // §12: a zero paired difference forces direction_ok=false and raw p=1.
    expect(result.paired_mean_difference).toBe(0)
    expect(result.raw_p_value).toBe(1)
    expect(result.adjusted_p_value).toBe(1)
    expect(result.direction_ok).toBe(false)
  })

  it('run array order does not change the output bytes (canonicalized by seed)', () => {
    const { plan, baseline_runs: baseline, treatment_runs: treatment } = fixture.input
    const canonical = computePairedAnalysis(plan, baseline, treatment)
    const reversedBaseline = computePairedAnalysis(plan, [...baseline].reverse(), treatment)
    const reversedTreatment = computePairedAnalysis(plan, baseline, [...treatment].reverse())
    const reversedBoth = computePairedAnalysis(plan, [...baseline].reverse(), [...treatment].reverse())
    expect(JSON.stringify(reversedBaseline)).toBe(JSON.stringify(canonical))
    expect(JSON.stringify(reversedTreatment)).toBe(JSON.stringify(canonical))
    expect(JSON.stringify(reversedBoth)).toBe(JSON.stringify(canonical))
  })

  it('run_id assignment order does not change the output bytes (pairing is by seed)', () => {
    const { plan, baseline_runs: baseline, treatment_runs: treatment } = fixture.input
    const canonical = computePairedAnalysis(plan, baseline, treatment)
    // same seeds/values, ids permuted across the array
    const permutedBaseline = [baseline[2]!, baseline[0]!, baseline[1]!]
    const permutedTreatment = [treatment[1]!, treatment[2]!, treatment[0]!]
    expect(JSON.stringify(computePairedAnalysis(plan, permutedBaseline, permutedTreatment))).toBe(
      JSON.stringify(canonical),
    )
  })

  it('differs when the plan identity differs (RNG seed is plan-derived, §12)', () => {
    // §12 canonical seed = FNV-1a(canonical JSON of plan + ordered run IDs +
    // metric values): changing the plan identity must move the mulberry32
    // stream. The golden dataset is too coarse for that to show through the
    // 12-significant-digit rounding (all bootstrap means stay positive, CI
    // quantiles land on the same rounded values), so this assertion uses
    // diffs that straddle zero — the pLow/pHigh tail counts then vary
    // observably with the stream.
    const base = [run('b1', 1, 0.5), run('b2', 2, 0.5), run('b3', 3, 0.5)]
    const treat = [run('t1', 1, 1.0), run('t2', 2, 0.2), run('t3', 3, 0.6)] // diffs 0.5, −0.3, 0.1
    const plan = makePlan({ minimum_n: 3, analysis_plan_id: 'seed_drift_plan' })
    const canonical = computePairedAnalysis(plan, base, treat)
    const otherContract = computePairedAnalysis({ ...plan, contract_id: 'expc_other_contract' }, base, treat)
    const otherMetric = computePairedAnalysis({ ...plan, metric: { ...plan.metric, name: 'other_metric' } }, base, treat)
    const otherRunSets = computePairedAnalysis(
      { ...plan, baseline_run_set_id: 'runset_other_baseline', treatment_run_set_id: 'runset_other_treatment' },
      base,
      treat,
    )
    const outs = [canonical, otherContract, otherMetric, otherRunSets].map((r) => JSON.stringify(r))
    // the four plan identities must produce four distinct byte strings
    expect(new Set(outs).size).toBe(4)
  })
})

describe('computePairedAnalysis — §12 rejection of non-finite / missing / duplicate seeds', () => {
  const plan = makePlan({ minimum_n: 1 })

  it('rejects NaN metric_value in baseline runs', () => {
    const baseline = [run('b1', 1, Number.NaN), run('b2', 2, 20)]
    const treatment = [run('t1', 1, 15), run('t2', 2, 23)]
    expect(() => computePairedAnalysis(plan, baseline, treatment)).toThrow(/finite number/)
  })

  it('rejects Infinity metric_value in treatment runs', () => {
    const baseline = [run('b1', 1, 10), run('b2', 2, 20)]
    const treatment = [run('t1', 1, Number.POSITIVE_INFINITY), run('t2', 2, 23)]
    expect(() => computePairedAnalysis(plan, baseline, treatment)).toThrow(/finite number/)
  })

  it('rejects -Infinity metric_value in baseline runs', () => {
    const baseline = [run('b1', 1, Number.NEGATIVE_INFINITY), run('b2', 2, 20)]
    const treatment = [run('t1', 1, 15), run('t2', 2, 23)]
    expect(() => computePairedAnalysis(plan, baseline, treatment)).toThrow(/finite number/)
  })

  it('rejects a run entry without a seed', () => {
    const baseline = [{ run_id: 'b1', metric_value: 10 }, run('b2', 2, 20)]
    const treatment = [run('t1', 1, 15), run('t2', 2, 23)]
    expect(() => computePairedAnalysis(plan, baseline as PerRunMetric[], treatment)).toThrow(/seed/)
  })

  it('rejects an empty-string seed', () => {
    const baseline = [{ run_id: 'b1', seed: '', metric_value: 10 }, run('b2', 2, 20)]
    const treatment = [run('t1', 1, 15), run('t2', 2, 23)]
    expect(() => computePairedAnalysis(plan, baseline as PerRunMetric[], treatment)).toThrow(/seed/)
  })

  it('rejects duplicate seeds within one side (seeds_unique invariant)', () => {
    const baseline = [run('b1', 1, 10), run('b1dup', 1, 99), run('b2', 2, 20)]
    const treatment = [run('t1', 1, 15), run('t2', 2, 23)]
    expect(() => computePairedAnalysis(plan, baseline, treatment)).toThrow(/duplicate seed/)
  })

  it('rejects non-finite method.resamples in the plan', () => {
    expect(() => computePairedAnalysis({ ...plan, method: { ...plan.method, resamples: Number.NaN } }, baselineFive(), treatmentFive())).toThrow(/resamples/)
    expect(() => computePairedAnalysis({ ...plan, method: { ...plan.method, resamples: Number.POSITIVE_INFINITY } }, baselineFive(), treatmentFive())).toThrow(/resamples/)
  })
})
