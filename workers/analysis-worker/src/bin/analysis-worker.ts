#!/usr/bin/env node
/**
 * Analysis Worker CLI (design DSH_Scholar_v2.0 §13, §17.3 internal API).
 *
 * Reads a single JSON object from stdin:
 *
 *   {
 *     "plan":            AnalysisPlan (§13.3),
 *     "baseline_runs":   PerRunMetric[] | run_id[],
 *     "treatment_runs":  PerRunMetric[] | run_id[],
 *     "metrics_files"?:  string[] | {content: string}[]   // §12.5 files
 *   }
 *
 * When `metrics_files` is provided, each entry is the raw content of a
 * Runner-produced metrics.json; entries are parsed with parseMetricsFile and
 * `baseline_runs` / `treatment_runs` reference them by run_id. When it is
 * absent, both sides are given directly as {run_id, seed, metric_value}.
 *
 * On success prints one JSON object to stdout:
 *   { "result": PairedAnalysisResult, "evidence_draft": {...} }
 * On any error prints a message to stderr and exits with code 1.
 */

import {
  computePairedAnalysis,
  parseMetricsFile,
  validateAnalysisPlan,
  type AnalysisPlan,
  type ParsedMetricsFile,
  type PerRunMetric,
} from '../index.js'

interface CliInput {
  plan: unknown
  baseline_runs: unknown
  treatment_runs: unknown
  metrics_files?: unknown
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function metricValueOf(parsed: ParsedMetricsFile, metricName: string): number {
  for (const m of parsed.metrics) {
    if (m.name === metricName) return m.value
  }
  fail(`metrics file for run ${parsed.run_id} has no metric "${metricName}"`)
}

function fail(message: string): never {
  throw new Error(message)
}

function isPerRunMetricEntry(v: unknown): v is PerRunMetric {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (
    typeof e.run_id === 'string' &&
    e.run_id.length > 0 &&
    (typeof e.seed === 'number' || typeof e.seed === 'string') &&
    typeof e.metric_value === 'number' &&
    Number.isFinite(e.metric_value)
  )
}

async function main(): Promise<void> {
  const raw = await readStdin()
  let input: CliInput
  try {
    input = JSON.parse(raw) as CliInput
  } catch (err) {
    fail(`invalid JSON on stdin: ${(err as Error).message}`)
  }

  const plan: AnalysisPlan = validateAnalysisPlan(input.plan)

  // Optional §12.5 metrics files: parse each and index by run_id.
  const parsedByRunId = new Map<string, PerRunMetric>()
  if (input.metrics_files !== undefined && input.metrics_files !== null) {
    if (!Array.isArray(input.metrics_files)) fail('metrics_files must be an array')
    for (const entry of input.metrics_files) {
      const content = typeof entry === 'string' ? entry : (entry as { content?: unknown } | null)?.content
      if (typeof content !== 'string') {
        fail('metrics_files entries must be file content strings or {content: string} objects')
      }
      const parsed = parseMetricsFile(content)
      parsedByRunId.set(parsed.run_id, {
        run_id: parsed.run_id,
        seed: parsed.seed,
        metric_value: metricValueOf(parsed, plan.metric.name),
      })
    }
  }

  const resolveSide = (side: unknown, label: string): PerRunMetric[] => {
    if (!Array.isArray(side)) fail(`${label} must be an array`)
    const out: PerRunMetric[] = []
    for (const entry of side) {
      if (typeof entry === 'string') {
        const fromFile = parsedByRunId.get(entry)
        if (!fromFile) fail(`${label} run_id "${entry}" not found in metrics_files`)
        out.push(fromFile)
      } else if (isPerRunMetricEntry(entry)) {
        out.push(entry)
      } else {
        fail(`${label} entries must be run_ids (when metrics_files is given) or {run_id, seed, metric_value} objects`)
      }
    }
    return out
  }

  const baselineRuns = resolveSide(input.baseline_runs, 'baseline_runs')
  const treatmentRuns = resolveSide(input.treatment_runs, 'treatment_runs')

  const result = computePairedAnalysis(plan, baselineRuns, treatmentRuns)

  const evidenceDraft = {
    contract_id: plan.contract_id,
    metric: plan.metric.name,
    direction: plan.metric.direction,
    analysis_plan_id: plan.analysis_plan_id ?? null,
    run_set_ids: [plan.baseline_run_set_id, plan.treatment_run_set_id],
    result,
    status: 'draft_unverified',
    provenance: {
      generated_by: 'analysis-worker',
      method: {
        estimator: plan.method.estimator,
        interval: plan.method.interval,
        resamples: plan.method.resamples,
      },
      multiple_testing: plan.multiple_testing,
      minimum_n: plan.minimum_n,
      generated_at: new Date().toISOString(),
    },
  }

  process.stdout.write(`${JSON.stringify({ result, evidence_draft: evidenceDraft }, null, 2)}\n`)
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[analysis-worker] ${message}`)
  process.exitCode = 1
})
