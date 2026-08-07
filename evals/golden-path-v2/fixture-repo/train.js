#!/usr/bin/env node
/**
 * Golden Path v2 fixture — training script (real code, no echo, no synthetic
 * stdout metrics).
 *
 * Reads the fixture dataset (data/seed-data.json) and COMPUTES deterministic
 * metrics from it:
 *
 *   weighted_sum = Σ baseline[i] * weights[i]          (from the data file)
 *   m1           = 0.5 + seed * 0.01 + 0.1 * weighted_sum   (unit: ratio)
 *   m2           = weighted_sum + seed * 0.02                (unit: ratio)
 *   n_samples    = baseline.length                           (unit: count)
 *
 * The seed term is linear, so every metric is strictly monotone in `seed`
 * given one data file — the orchestrator asserts that to prove the values
 * really come from this computation (not forged/echoed).
 *
 * Output: the fixed-schema metrics file (design §12.5) written to --output:
 *   { "schema_version": 1, "run_id": ..., "contract_id": ...,
 *     "seed": N, "metrics": [ {name, value, unit}, ... ] }
 * The runner (v2 SCH-EXEC-002) reads metrics ONLY from this file — stdout is
 * logs only (no metric lines).
 *
 * Usage: node train.js --seed N --data PATH --output PATH [--contract-id ID]
 *
 * NOTE: ESM on purpose — the repo root package.json is "type":"module", and
 * the orchestrator writes {"type":"module"} into the container /tmp so the
 * script is interpreted identically on host and in the docker container.
 */
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--seed') args.seed = Number(argv[++i])
    else if (a === '--data') args.data = argv[++i]
    else if (a === '--output') args.output = argv[++i]
    else if (a === '--contract-id') args.contract = argv[++i]
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!Number.isInteger(args.seed) || args.seed < 0) {
    console.error('train.js: --seed <non-negative integer> is required')
    process.exit(1)
  }
  if (!args.data || !args.output) {
    console.error('train.js: --data PATH and --output PATH are required')
    process.exit(1)
  }
  const seed = args.seed
  const contractId = args.contract ?? 'golden-v2'

  // Real data read: the metrics MUST be derived from this file.
  const data = JSON.parse(fs.readFileSync(args.data, 'utf8'))
  const baseline = data.baseline
  const weights = data.weights
  if (!Array.isArray(baseline) || baseline.length === 0 ||
      !Array.isArray(weights) || weights.length !== baseline.length) {
    console.error(`train.js: data file must contain equal-length numeric "baseline" and "weights" arrays (got ${JSON.stringify(data)})`)
    process.exit(1)
  }
  for (let i = 0; i < baseline.length; i++) {
    if (typeof baseline[i] !== 'number' || typeof weights[i] !== 'number') {
      console.error(`train.js: non-numeric entry at index ${i}`)
      process.exit(1)
    }
  }

  // Deterministic computation (the "noise" term is data-derived and fixed).
  const weightedSum = baseline.reduce((acc, v, i) => acc + v * weights[i], 0)
  const metrics = [
    { name: 'm1', value: 0.5 + 0.01 * seed + 0.1 * weightedSum, unit: 'ratio' },
    { name: 'm2', value: weightedSum + 0.02 * seed, unit: 'ratio' },
    { name: 'n_samples', value: baseline.length, unit: 'count' },
  ]

  // Fixed-schema metrics file (design §12.5).
  const runId = `train-seed-${seed}`
  const report = {
    schema_version: 1,
    run_id: runId,
    contract_id: contractId,
    seed,
    metrics,
  }
  fs.mkdirSync(path.dirname(args.output), { recursive: true })
  // Compact single-line JSON so the orchestrator can extract and validate the
  // exact §12.5 fixed-schema record from the run log (`cat` of this file).
  fs.writeFileSync(args.output, JSON.stringify(report) + '\n', 'utf8')

  // v2 (SCH-EXEC-002): NO stdout metric lines. Formal metrics are read by the
  // runner ONLY from the fixed-schema metrics file (design §12.5) — stdout is
  // logs only.
}

main()