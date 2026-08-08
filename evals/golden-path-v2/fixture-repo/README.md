# golden-path-v2 fixture repository

Small self-contained, deterministic experiment repository for the §19.3
Golden Path v2 eval (`evals/golden-path-v2/run-golden-v2.sh`). No external
dependencies — pure Node.js + a JSON dataset.

## Layout

```
data/seed-data.json   fixture dataset (baseline + weights arrays)
train.js              treatment training script (--seed N --data P --output P)
baseline.js           baseline reference script (same engine, seed 0)
```

## Computation

Both scripts read `data/seed-data.json` and compute, for a given seed:

```
weighted_sum = Σ baseline[i] * weights[i]      (from the data file)
m1           = 0.5 + seed * 0.01 + 0.1 * weighted_sum   (unit: ratio)
m2           = weighted_sum + seed * 0.02                (unit: ratio)
n_samples    = baseline.length                           (unit: count)
```

The seed term is linear, so every metric is strictly monotone in `seed`
given one data file — the orchestrator asserts monotonicity to prove the
values really come from this computation (not forged/echoed).

## Output

Each script writes the fixed-schema metrics file (design §12.5) to
`--output` (compact single-line JSON so the orchestrator can validate the
exact record from the run log):

```json
{"schema_version":1,"run_id":"train-seed-3","contract_id":"golden-v2","seed":3,"metrics":[{"name":"m1","value":0.68,"unit":"ratio"}]}
```

and prints one stdout JSON line per metric (`{"metric": ..., "value": ...,
"seed": ...}`) for the runner's current metrics extraction.
