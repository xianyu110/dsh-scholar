/**
 * @dsh-scholar/analysis-worker — deterministic statistics engine.
 *
 * Implements the Analysis Worker of DSH Scholar v2.0 (design doc §12.5, §13,
 * §17.3): MetricSpec / RunSet / AnalysisPlan validation, fixed-schema metrics
 * file parsing, and a deterministic paired mean-difference analysis with a
 * seeded percentile bootstrap 95% CI.
 *
 * Design constraints honored here:
 *  - One analysis = one contract × one metric (enforced by the API shape:
 *    an AnalysisPlan carries a single contract_id and a single MetricSpec).
 *  - Deterministic: the bootstrap RNG is a mulberry32 stream seeded from the
 *    plan identity, so repeated runs of the same analysis produce identical
 *    results on the same platform.
 *  - Self-contained: this package intentionally does NOT depend on
 *    @dsh-scholar/research-schemas (kernel-side schemas are being refactored
 *    by the main agent); all schema shapes are declared and validated here.
 */

// ---------------------------------------------------------------------------
// Types (design §13.2 RunSet, §13.3 AnalysisPlan, §13.4 EvidenceItem result,
//        §12.5 metrics file)
// ---------------------------------------------------------------------------

export type MetricDirection = 'higher_is_better' | 'lower_is_better'
export type MetricAggregation = 'mean'
export type PairedBy = 'seed'
export type Estimator = 'paired_mean_difference'
export type IntervalMethod = 'bootstrap_95'
export type MultipleTestingMethod = 'holm'

/** §13.3 metric spec embedded in an AnalysisPlan. */
export interface MetricSpec {
  name: string
  direction: MetricDirection
  aggregation: MetricAggregation
  unit?: string
}

/** §13.2 validation flags — provided by the caller, never recomputed here. */
export interface RunSetValidation {
  seeds_unique: boolean
  min_completed_met: boolean
  same_code_snapshot: boolean
  same_data_hash: boolean
}

/** §13.2 RunSet. */
export interface RunSet {
  run_set_id?: string
  project_id?: string
  contract_id: string
  method: string
  metric: string
  runs: string[]
  validation: RunSetValidation
}

/** §13.3 analysis method block. */
export interface AnalysisPlanMethod {
  estimator: Estimator
  interval: IntervalMethod
  resamples: number
}

/** §13.3 AnalysisPlan. */
export interface AnalysisPlan {
  analysis_plan_id?: string
  contract_id: string
  metric: MetricSpec
  paired_by: PairedBy
  baseline_run_set_id: string
  treatment_run_set_id: string
  method: AnalysisPlanMethod
  multiple_testing: MultipleTestingMethod
  minimum_n: number
}

/** A single run's observed metric value, as handed to the statistics core. */
export interface PerRunMetric {
  run_id: string
  seed: number | string
  metric_value: number
}

/**
 * §13.4 EvidenceItem `result` shape produced by computePairedAnalysis, plus
 * `paired_mean_difference` (the estimator's primary output) and
 * `direction_ok` (whether the observed effect is in the direction the metric
 * declares good).
 */
export interface PairedAnalysisResult {
  metric: string
  direction: MetricDirection
  baseline_mean: number
  treatment_mean: number
  paired_mean_difference: number
  effect_size: number
  ci_low: number
  ci_high: number
  n_pairs: number
  adjusted_p_value: number
  direction_ok: boolean
}

/** §12.5 fixed metrics-file schema after parsing (unit stripped). */
export interface ParsedMetricsFile {
  run_id: string
  contract_id: string
  seed: number
  metrics: Array<{ name: string; value: number }>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(message)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isPositiveInteger(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 1
}

function mean(values: number[]): number {
  if (values.length === 0) fail('mean of empty sample')
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/** FNV-1a 32-bit string hash — stable across processes and platforms. */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 PRNG — deterministic given the same 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Linear-interpolation percentile (numpy-default style) of sorted data. */
function percentile(sortedAsc: number[], q: number): number {
  const n = sortedAsc.length
  if (n === 0) fail('percentile of empty sample')
  if (n === 1) return sortedAsc[0] as number
  const rank = (q / 100) * (n - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  const vLo = sortedAsc[lo] as number
  if (lo === hi) return vLo
  const vHi = sortedAsc[hi] as number
  return vLo + (vHi - vLo) * (rank - lo)
}

/**
 * Holm step-down multiple-testing adjustment (§13.3 `multiple_testing: holm`,
 * §13.6). For a single comparison (this engine analyzes one contract × one
 * metric at a time) it is the identity — kept for API fidelity so callers can
 * adjust across plans exactly as the design prescribes.
 */
export function holmAdjust(pValues: number[]): number[] {
  if (pValues.length === 0) fail('holmAdjust: empty p-value list')
  const m = pValues.length
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p)
  const adjusted = new Array<number>(m)
  let running = 1
  for (let k = 0; k < m; k++) {
    const entry = indexed[k] as { p: number; i: number }
    const step = Math.min(1, (m - k) * entry.p)
    running = Math.min(running, step)
    adjusted[entry.i] = running
  }
  return adjusted
}

// ---------------------------------------------------------------------------
// Validation (§13.2, §13.3)
// ---------------------------------------------------------------------------

/** Validates a MetricSpec; returns it narrowed, throws on invalid input. */
export function validateMetricSpec(value: unknown): MetricSpec {
  if (!isRecord(value)) fail('metric must be an object')
  if (!isNonEmptyString(value.name)) fail('metric.name must be a non-empty string')
  if (value.direction !== 'higher_is_better' && value.direction !== 'lower_is_better') {
    fail(`metric.direction must be 'higher_is_better' or 'lower_is_better', got ${JSON.stringify(value.direction)}`)
  }
  if (value.aggregation !== 'mean') {
    fail(`metric.aggregation must be 'mean' (only supported aggregation), got ${JSON.stringify(value.aggregation)}`)
  }
  if (value.unit !== undefined && typeof value.unit !== 'string') {
    fail('metric.unit must be a string when present')
  }
  return value as unknown as MetricSpec
}

/**
 * Validates a RunSet. `validation.min_completed_met` (and the other flags)
 * are provided by the caller as booleans — this engine only checks their
 * type, it never recomputes them.
 */
export function validateRunSet(value: unknown): RunSet {
  if (!isRecord(value)) fail('run_set must be an object')
  if (!isNonEmptyString(value.contract_id)) fail('run_set.contract_id must be a non-empty string')
  if (!isNonEmptyString(value.method)) fail('run_set.method must be a non-empty string')
  if (!isNonEmptyString(value.metric)) fail('run_set.metric must be a non-empty string')
  if (!Array.isArray(value.runs) || value.runs.length === 0) {
    fail('run_set.runs must be a non-empty array of run ids')
  }
  for (const r of value.runs) {
    if (!isNonEmptyString(r)) fail('run_set.runs entries must be non-empty strings')
  }
  if (!isRecord(value.validation)) fail('run_set.validation must be an object')
  const v = value.validation
  for (const key of ['seeds_unique', 'min_completed_met', 'same_code_snapshot', 'same_data_hash'] as const) {
    if (typeof v[key] !== 'boolean') {
      fail(`run_set.validation.${key} must be a boolean (caller-provided), got ${JSON.stringify(v[key])}`)
    }
  }
  return value as unknown as RunSet
}

/** Validates an AnalysisPlan; returns it narrowed, throws on invalid input. */
export function validateAnalysisPlan(value: unknown): AnalysisPlan {
  if (!isRecord(value)) fail('analysis_plan must be an object')
  if (!isNonEmptyString(value.contract_id)) fail('analysis_plan.contract_id must be a non-empty string')
  validateMetricSpec(value.metric)
  if (value.paired_by !== 'seed') fail(`analysis_plan.paired_by must be 'seed', got ${JSON.stringify(value.paired_by)}`)
  if (!isNonEmptyString(value.baseline_run_set_id)) fail('analysis_plan.baseline_run_set_id must be a non-empty string')
  if (!isNonEmptyString(value.treatment_run_set_id)) fail('analysis_plan.treatment_run_set_id must be a non-empty string')
  if (value.baseline_run_set_id === value.treatment_run_set_id) {
    fail('analysis_plan.baseline_run_set_id and treatment_run_set_id must differ')
  }
  if (!isRecord(value.method)) fail('analysis_plan.method must be an object')
  const m = value.method
  if (m.estimator !== 'paired_mean_difference') {
    fail(`analysis_plan.method.estimator must be 'paired_mean_difference', got ${JSON.stringify(m.estimator)}`)
  }
  if (m.interval !== 'bootstrap_95') {
    fail(`analysis_plan.method.interval must be 'bootstrap_95', got ${JSON.stringify(m.interval)}`)
  }
  if (!isPositiveInteger(m.resamples)) fail('analysis_plan.method.resamples must be a positive integer')
  if (value.multiple_testing !== 'holm') {
    fail(`analysis_plan.multiple_testing must be 'holm', got ${JSON.stringify(value.multiple_testing)}`)
  }
  if (!isPositiveInteger(value.minimum_n)) fail('analysis_plan.minimum_n must be a positive integer')
  return value as unknown as AnalysisPlan
}

// ---------------------------------------------------------------------------
// Metrics file parsing (§12.5)
// ---------------------------------------------------------------------------

/**
 * Parses a §12.5 fixed-schema metrics file (as produced by a Runner from the
 * container's metrics.json — never from arbitrary stdout text):
 *
 *   { "schema_version": 1, "run_id", "contract_id", "seed",
 *     "metrics": [{"name", "value", "unit"}] }
 *
 * Invalid schemas are rejected with an Error — never silently tolerated.
 * The returned shape strips `unit` (informational only).
 */
export function parseMetricsFile(content: string): ParsedMetricsFile {
  if (typeof content !== 'string') fail('metrics file content must be a string')
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (err) {
    fail(`metrics file is not valid JSON: ${(err as Error).message}`)
  }
  if (!isRecord(raw)) fail('metrics file must be a JSON object')
  if (raw.schema_version !== 1) fail('metrics file schema_version must be 1')
  if (!isNonEmptyString(raw.run_id)) fail('metrics file run_id must be a non-empty string')
  if (!isNonEmptyString(raw.contract_id)) fail('metrics file contract_id must be a non-empty string')
  if (!isFiniteNumber(raw.seed)) fail('metrics file seed must be a finite number')
  if (!Array.isArray(raw.metrics) || raw.metrics.length === 0) {
    fail('metrics file metrics must be a non-empty array')
  }
  const metrics: Array<{ name: string; value: number }> = []
  for (const m of raw.metrics) {
    if (!isRecord(m)) fail('metrics file metric entries must be objects')
    if (!isNonEmptyString(m.name)) fail('metrics file metric name must be a non-empty string')
    if (!isFiniteNumber(m.value)) fail(`metrics file metric "${String(m.name)}" value must be a finite number`)
    if (m.unit !== undefined && typeof m.unit !== 'string') {
      fail(`metrics file metric "${String(m.name)}" unit must be a string`)
    }
    metrics.push({ name: m.name as string, value: m.value as number })
  }
  return {
    run_id: raw.run_id as string,
    contract_id: raw.contract_id as string,
    seed: raw.seed as number,
    metrics,
  }
}

// ---------------------------------------------------------------------------
// Statistics core (§13.3, §13.4, §13.6)
// ---------------------------------------------------------------------------

/** Indexes per-run metrics by seed; rejects malformed entries and duplicates. */
function indexRuns(runs: PerRunMetric[], label: string): Map<string, PerRunMetric> {
  if (!Array.isArray(runs)) fail(`${label} must be an array of per-run metrics`)
  const map = new Map<string, PerRunMetric>()
  for (const run of runs) {
    if (!isRecord(run)) fail(`${label} entries must be objects {run_id, seed, metric_value}`)
    if (!isNonEmptyString(run.run_id)) fail(`${label} entry run_id must be a non-empty string`)
    const seed = run.seed
    if (typeof seed !== 'number' && typeof seed !== 'string') {
      fail(`${label} entry seed must be a number or a string`)
    }
    if (typeof seed === 'string' && seed.length === 0) fail(`${label} entry seed must be a non-empty string`)
    if (!isFiniteNumber(run.metric_value)) fail(`${label} entry metric_value must be a finite number`)
    const key = String(seed)
    if (map.has(key)) fail(`${label} has duplicate seed ${key} (run_set.validation.seeds_unique must be true)`)
    map.set(key, run as PerRunMetric)
  }
  return map
}

/**
 * Deterministic paired analysis of one contract × one metric (§13.6).
 *
 * Pairs baseline and treatment runs by seed, keeping only seeds present on
 * BOTH sides. Throws if the number of paired runs is below `plan.minimum_n`.
 * Computes:
 *   - baseline_mean / treatment_mean over the paired runs;
 *   - paired_mean_difference (mean of per-seed treatment − baseline diffs);
 *   - effect_size — for the paired_mean_difference estimator this IS the mean
 *     paired difference (matches the §13.4 worked example: 0.812 − 0.781);
 *   - percentile bootstrap 95% CI over `plan.method.resamples` resamples,
 *     drawn with a fixed-seed mulberry32 stream (deterministic);
 *   - a two-sided bootstrap p-value, Holm-adjusted (identity for one test);
 *   - direction_ok: effect in the direction the metric declares good
 *     (higher_is_better ⇒ effect > 0; lower_is_better ⇒ effect < 0).
 */
export function computePairedAnalysis(
  plan: AnalysisPlan,
  baselineRuns: PerRunMetric[],
  treatmentRuns: PerRunMetric[],
): PairedAnalysisResult {
  const validatedPlan = validateAnalysisPlan(plan)
  const baseline = indexRuns(baselineRuns, 'baseline_runs')
  const treatment = indexRuns(treatmentRuns, 'treatment_runs')

  // Only seeds present on both sides are paired (§13.6: matched-seed design).
  const pairedSeeds = [...baseline.keys()].filter((seed) => treatment.has(seed)).sort()

  const nPairs = pairedSeeds.length
  if (nPairs < validatedPlan.minimum_n) {
    fail(
      `minimum_n not met: ${nPairs} paired runs found (minimum_n = ${validatedPlan.minimum_n})`,
    )
  }

  const baselineValues: number[] = []
  const treatmentValues: number[] = []
  const diffs: number[] = []
  for (const seed of pairedSeeds) {
    const b = baseline.get(seed) as PerRunMetric
    const t = treatment.get(seed) as PerRunMetric
    baselineValues.push(b.metric_value)
    treatmentValues.push(t.metric_value)
    diffs.push(t.metric_value - b.metric_value)
  }

  const baselineMean = mean(baselineValues)
  const treatmentMean = mean(treatmentValues)
  const pairedMeanDifference = mean(diffs)

  // Seeded percentile bootstrap 95% CI (§13.3 `bootstrap_95`). The seed is a
  // pure function of the plan identity, so the same analysis is bit-for-bit
  // reproducible.
  const rngSeed = fnv1a32(
    `${validatedPlan.contract_id}\u0000${validatedPlan.metric.name}\u0000` +
      `${validatedPlan.baseline_run_set_id}\u0000${validatedPlan.treatment_run_set_id}`,
  )
  const rng = mulberry32(rngSeed)
  const resamples = validatedPlan.method.resamples
  const bootstrapMeans = new Array<number>(resamples)
  let countAtLeastObserved = 0
  for (let r = 0; r < resamples; r++) {
    let sum = 0
    for (let i = 0; i < nPairs; i++) {
      sum += diffs[Math.floor(rng() * nPairs)] as number
    }
    const bootMean = sum / nPairs
    bootstrapMeans[r] = bootMean
    if (Math.abs(bootMean) >= Math.abs(pairedMeanDifference)) countAtLeastObserved++
  }
  bootstrapMeans.sort((a, b) => a - b)
  const ciLow = percentile(bootstrapMeans, 2.5)
  const ciHigh = percentile(bootstrapMeans, 97.5)

  // Two-sided bootstrap p-value (+1 smoothing), Holm-adjusted. With a single
  // comparison Holm is the identity, but the adjustment is applied as §13.6
  // requires so callers can rely on `adjusted_p_value` directly.
  const rawP = (countAtLeastObserved + 1) / (resamples + 1)
  const adjustedP = (holmAdjust([rawP]) as [number])[0] as number

  const direction = validatedPlan.metric.direction
  const directionOk =
    direction === 'higher_is_better' ? pairedMeanDifference > 0 : pairedMeanDifference < 0

  return {
    metric: validatedPlan.metric.name,
    direction,
    baseline_mean: baselineMean,
    treatment_mean: treatmentMean,
    paired_mean_difference: pairedMeanDifference,
    effect_size: pairedMeanDifference,
    ci_low: ciLow,
    ci_high: ciHigh,
    n_pairs: nPairs,
    adjusted_p_value: adjustedP,
    direction_ok: directionOk,
  }
}
