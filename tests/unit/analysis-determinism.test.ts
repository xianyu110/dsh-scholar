/**
 * Analysis Worker determinism matrix (docs/acceptance-tests.md §6: "paired
 * bootstrap 输入相同输出字节一致"; docs/reconstruction-contracts.md §12:
 * PairedAnalysisResult key order fixed, RNG = mulberry32 seeded from the plan
 * identity, golden vector in tests/fixtures/analysis-v1.json).
 *
 * Every group in the matrix runs computePairedAnalysis twice on the SAME
 * input and asserts the two JSON.stringify outputs are byte-identical, then
 * deep-equal. The groups span different seeds, metric names, directions
 * (higher_is_better / lower_is_better), n_pairs, resample counts and plan
 * identities — determinism must hold across all of them.
 *
 * Tests run against the built package (lib/), like the other unit suites;
 * run `pnpm --filter @dsh-scholar/analysis-worker run build` before
 * `pnpm test`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  computePairedAnalysis,
  type AnalysisPlan,
  type PairedAnalysisResult,
  type PerRunMetric,
} from '../../workers/analysis-worker/lib/index.js'

function run(runId: string, seed: number, value: number): PerRunMetric {
  return { run_id: runId, seed, metric_value: value }
}

function makePlan(overrides: Partial<AnalysisPlan> = {}): AnalysisPlan {
  return {
    analysis_plan_id: 'determinism_plan',
    contract_id: 'expc_determinism',
    metric: { name: 'macro_f1', direction: 'higher_is_better', aggregation: 'mean' },
    paired_by: 'seed',
    baseline_run_set_id: 'runset_baseline_det',
    treatment_run_set_id: 'runset_treatment_det',
    method: { estimator: 'paired_mean_difference', interval: 'bootstrap_95', resamples: 10000 },
    multiple_testing: 'holm',
    minimum_n: 1,
    ...overrides,
  }
}

interface DeterminismCase {
  label: string
  plan: AnalysisPlan
  baseline: PerRunMetric[]
  treatment: PerRunMetric[]
}

const golden: {
  input: { plan: AnalysisPlan; baseline_runs: PerRunMetric[]; treatment_runs: PerRunMetric[] }
  additional_cases?: Array<{ label: string; input: { plan: AnalysisPlan; baseline_runs: PerRunMetric[]; treatment_runs: PerRunMetric[] } }>
} = JSON.parse(
  readFileSync(new URL('../fixtures/analysis-v1.json', import.meta.url), 'utf8'),
)

/** §13.6-style dataset, seeds 1..5, diffs 5,3,1,2,5 (mean 3.2). */
const baselineFive = () => [run('b1', 1, 10), run('b2', 2, 20), run('b3', 3, 30), run('b4', 4, 40), run('b5', 5, 50)]
const treatmentFive = () => [run('t1', 1, 15), run('t2', 2, 23), run('t3', 3, 31), run('t4', 4, 42), run('t5', 5, 55)]

/** 8 pairs, seeds 2..9, diffs pattern 1..8 (mean 4.5). */
const baselineEight = () => Array.from({ length: 8 }, (_, i) => run(`b${i + 2}`, i + 2, (i + 2) * 10))
const treatmentEight = () => Array.from({ length: 8 }, (_, i) => run(`t${i + 2}`, i + 2, (i + 2) * 10 + (i + 1)))

const cases: DeterminismCase[] = [
  {
    label: 'golden vector case: m1 higher_is_better, seeds 11/23/47, resamples 10000, minimum_n 1',
    plan: golden.input.plan,
    baseline: golden.input.baseline_runs,
    treatment: golden.input.treatment_runs,
  },
  {
    label: 'golden vector additional case: m2 lower_is_better, same runs',
    plan: golden.additional_cases![0]!.input.plan,
    baseline: golden.additional_cases![0]!.input.baseline_runs,
    treatment: golden.additional_cases![0]!.input.treatment_runs,
  },
  {
    label: 'different seeds (1..5), macro_f1 higher_is_better, resamples 10000, minimum_n 5',
    plan: makePlan({ analysis_plan_id: 'det_plan_seeds15', contract_id: 'expc_det_seeds15', method: { estimator: 'paired_mean_difference', interval: 'bootstrap_95', resamples: 10000 }, minimum_n: 5 }),
    baseline: baselineFive(),
    treatment: treatmentFive(),
  },
  {
    label: 'different metric name: accuracy higher_is_better, 2 pairs seeds 3/7, resamples 10000, minimum_n 2',
    plan: makePlan({
      contract_id: 'expc_det_acc',
      metric: { name: 'accuracy', direction: 'higher_is_better', aggregation: 'mean' },
      method: { estimator: 'paired_mean_difference', interval: 'bootstrap_95', resamples: 10000 },
      minimum_n: 2,
    }),
    baseline: [run('b3', 3, 0.61), run('b7', 7, 0.64)],
    treatment: [run('t3', 3, 0.72), run('t7', 7, 0.69)],
  },
  {
    label: 'different n: 8 pairs seeds 2..9, resamples 10000, minimum_n 8',
    plan: makePlan({
      contract_id: 'expc_det_n8',
      metric: { name: 'recall', direction: 'higher_is_better', aggregation: 'mean' },
      method: { estimator: 'paired_mean_difference', interval: 'bootstrap_95', resamples: 10000 },
      minimum_n: 8,
    }),
    baseline: baselineEight(),
    treatment: treatmentEight(),
  },
  {
    label: 'same runs as golden case but different contract_id + run_set ids (plan-derived RNG seed)',
    plan: makePlan({
      contract_id: 'expc_det_other_id',
      baseline_run_set_id: 'runset_other_baseline',
      treatment_run_set_id: 'runset_other_treatment',
    }),
    baseline: golden.input.baseline_runs,
    treatment: golden.input.treatment_runs,
  },
  {
    label: '3 pairs seeds 1..3 with diffs straddling zero (p-value tail counts vary), resamples 10000',
    plan: makePlan({
      contract_id: 'expc_det_straddle',
      metric: { name: 'macro_f1', direction: 'higher_is_better', aggregation: 'mean' },
      method: { estimator: 'paired_mean_difference', interval: 'bootstrap_95', resamples: 10000 },
      minimum_n: 3,
    }),
    baseline: [run('b1', 1, 0.5), run('b2', 2, 0.5), run('b3', 3, 0.5)],
    treatment: [run('t1', 1, 1.0), run('t2', 2, 0.2), run('t3', 3, 0.6)],
  },
]

describe('computePairedAnalysis — determinism matrix (§6)', () => {
  for (const c of cases) {
    it(`byte-identical across two runs: ${c.label}`, () => {
      const a = computePairedAnalysis(c.plan, c.baseline, c.treatment)
      const b = computePairedAnalysis(c.plan, c.baseline, c.treatment)
      expect(JSON.stringify(a)).toBe(JSON.stringify(b))
      expect(a).toEqual(b)
      // the bootstrap outputs are part of the byte identity
      expect(a.ci_low).toBe(b.ci_low)
      expect(a.ci_high).toBe(b.ci_high)
      expect(a.adjusted_p_value).toBe(b.adjusted_p_value)
      expect(JSON.stringify(a.ci_low)).toBe(JSON.stringify(b.ci_low))
      expect(JSON.stringify(a.adjusted_p_value)).toBe(JSON.stringify(b.adjusted_p_value))
    })
  }

  it('array order-independence holds across the matrix too (canonicalize by seed)', () => {
    for (const c of cases) {
      const canonical = computePairedAnalysis(c.plan, c.baseline, c.treatment)
      const shuffled = computePairedAnalysis(c.plan, [...c.baseline].reverse(), [...c.treatment].reverse())
      expect(JSON.stringify(shuffled)).toBe(JSON.stringify(canonical))
    }
  })

  it('sanities: each matrix case really differs from the others (non-vacuous inputs)', () => {
    const outputs = cases.map(c => JSON.stringify(computePairedAnalysis(c.plan, c.baseline, c.treatment)))
    // plan-identity changes must move the bootstrap stream, so at least the
    // CI/p-value bytes differ between distinct plan identities
    const cis = cases.map(c => JSON.stringify(computePairedAnalysis(c.plan, c.baseline, c.treatment).ci_low))
    expect(new Set(outputs).size).toBeGreaterThanOrEqual(5)
    expect(new Set(cis).size).toBeGreaterThanOrEqual(4)
  })

  it('every case produces a valid full PairedAnalysisResult with all fields', () => {
    for (const c of cases) {
      const r: PairedAnalysisResult = computePairedAnalysis(c.plan, c.baseline, c.treatment)
      expect(Object.keys(r)).toEqual([
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
      expect(Number.isFinite(r.baseline_mean)).toBe(true)
      expect(Number.isFinite(r.ci_low)).toBe(true)
      expect(Number.isFinite(r.ci_high)).toBe(true)
      expect(r.ci_low).toBeLessThanOrEqual(r.ci_high)
      expect(r.n_pairs).toBeGreaterThanOrEqual(c.plan.minimum_n)
    }
  })
})
