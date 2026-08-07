---
name: domain-data-science
description: Data-science research domain pack for DSH Research OS — data pipelines, statistical conventions and reproducibility for tabular/analytics research. Use when a Research Project's domain is data-science.
---

# Domain Pack: Data Science

Applies on top of the research-core skill for data-science projects.

## Data conventions

1. Every dataset must be versioned with a content hash (preprocessing hash in
   the ExperimentContract). A change in preprocessing invalidates prior runs.
2. Record the data license and provenance in the corpus/snapshot metadata;
   private data is flagged and never uploaded to external models
   (external_model_upload policy).
3. Splits: record the exact split rule (stratified, temporal, grouped by
   entity). Leakage checks are mandatory before formal runs.

## Statistical conventions

1. Report effect sizes with bootstrap CIs (the analysis pipeline does this);
   never report a bare p-value without an interval.
2. Multiple-testing correction (Holm default) when more than one metric or
   subgroup is compared.
3. Class-imbalanced targets: macro-averaged metrics + class counts.
4. Uncertainty sections must state: seeds, n, CI method, hardware.

## Baseline & comparison

1. Reproduce the baseline first (baseline_prepare + baseline_verify); only
   within-tolerance reproductions may be compared against.
2. Record deviations verbatim in the RunManifest; never adjust official
   baseline numbers.

## Pipeline reproducibility

1. Every transform step must be deterministic (fixed seeds, no
   time-dependent sorting) or have its hash recorded.
2. The release bundle must include: data manifest + hashes, preprocessing
   script, environment lockfile, and the exact analysis commands.
