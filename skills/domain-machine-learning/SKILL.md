---
name: domain-machine-learning
description: "Machine-learning research domain pack for DSH Research OS — dataset/metric/reproducibility conventions for ML projects. Use when a Research Project's domain is machine-learning (the default): survey, idea, baseline, contract, runs and evidence follow these conventions."
---

# Domain Pack: Machine Learning

Applies on top of the research-core skill for ML projects (default domain).

## Survey conventions

1. Prefer benchmarks with official splits (THUMOS14, GLUE, ImageNet, ...) and
   cite the dataset card + license; record the exact split used.
2. Record the hardware/software stack claimed by the baseline (GPU type,
   CUDA, framework versions) — reproduction hinges on it.
3. For every candidate idea, note the compute class it targets: toy
   (minutes), single-GPU (hours), cluster (days).

## Metric conventions

1. State the primary metric and its direction (higher-better / lower-better).
   Report secondary metrics only when measured on the SAME official split.
2. For classification: prefer macro-averaged metrics on class-imbalanced
   benchmarks; always report class counts.
3. Report seeds explicitly (design §6.4 contract seeds list); multi-seed
   results are aggregated by the analysis pipeline (mean, sd, bootstrap CI).

## Baseline & reproduction

1. The baseline MUST be reproduced in the isolated Runner before any claim of
   improvement (reproduce-first, design §1.3). Record deviation vs official
   numbers in the RunManifest.
2. A reproduction is "accepted" when every expected metric is within the
   contract tolerance; otherwise record the deviation and do not compare.

## Experiment contract defaults

- `seeds`: [11, 23, 47, 89, 101]
- `analysis`: effect_size = mean_difference, interval = bootstrap_95,
  multiple_testing = holm (when many metrics)
- `stop_conditions`: max_gpu_hours per the project budget; stop on data
  leakage always.

## Integrity

- No test-set touching during development: the test split is consumed ONLY
  by the final formal runs (contract-frozen).
- Any preprocessing hash change invalidates prior runs (contract data hash).
- Ablations must share seeds and splits with the main comparison.
