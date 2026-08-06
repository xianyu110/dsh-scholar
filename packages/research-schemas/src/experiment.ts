/**
 * Experiment-layer schemas: ExperimentContract (pre-registered, frozen after
 * approval), RunManifest (runner-signed), CodeSnapshot (design §4.6, §6.4-6.5).
 * @module @dsh-scholar/research-schemas
 */

import { z } from 'zod'

/** Pre-registered experiment contract; immutable once approved (ADR-004). */
export const ExperimentContract = z.object({
  contract_id: z.string().regex(/^expc_[a-z0-9_]+$/),
  version: z.number().int().positive().default(1),
  project_id: z.string().min(1),
  idea_id: z.string().min(1),
  baseline_run: z.string().optional(),
  code_snapshot: z.string().optional(), // sha256:...
  data: z.object({
    dataset_id: z.string().min(1),
    version: z.string().default('official'),
    split: z.string().default('official'),
    preprocessing_hash: z.string().optional(),
  }),
  methods: z.object({
    baseline: z.string().min(1),
    treatment: z.string().min(1),
  }),
  metrics: z.object({
    primary: z.string().min(1),
    secondary: z.array(z.string()).default([]),
  }),
  seeds: z.array(z.number().int()).default([11, 23, 47, 89, 101]),
  analysis: z.object({
    effect_size: z.string().default('mean_difference'),
    interval: z.string().default('bootstrap_95'),
    multiple_testing: z.string().default('holm'),
  }).default({}),
  ablations: z.array(z.string()).default([]),
  stop_conditions: z.object({
    max_gpu_hours: z.number().nonnegative().default(48),
    min_completed_seeds: z.number().int().nonnegative().default(5),
    stop_on_data_leakage: z.boolean().default(true),
  }).default({}),
  status: z.enum(['draft', 'approved', 'superseded', 'rejected']).default('draft'),
  approval: z.object({
    gate_decision_id: z.string().optional(),
    approved_at: z.string().optional(),
    approved_by: z.string().optional(),
  }).optional(),
  created_at: z.string(),
  updated_at: z.string(),
})
export type ExperimentContract = z.infer<typeof ExperimentContract>

/** Immutable code snapshot reference (content-addressed). */
export const CodeSnapshot = z.object({
  snapshot_id: z.string().min(1),
  project_id: z.string().min(1),
  commit: z.string().min(1),
  hash: z.string().min(1), // sha256:...
  path: z.string().min(1),
  description: z.string().default(''),
  created_at: z.string(),
})
export type CodeSnapshot = z.infer<typeof CodeSnapshot>

/** Job failure classification with automatic decision mapping (design §4.6.2). */
export const FailureClass = z.enum([
  'environment',
  'resources',
  'code_error',
  'data_issue',
  'no_improvement',
  'unstable_results',
  'budget_exhausted',
  'unknown',
])
export type FailureClass = z.infer<typeof FailureClass>

/** Run manifest — generated and signed by the Runner; agents cannot edit (design §6.5). */
export const RunManifest = z.object({
  run_id: z.string().min(1),
  contract_id: z.string().min(1),
  job_id: z.string().min(1),
  code_commit: z.string().min(1),
  container_digest: z.string().default(''),
  data_hash: z.string().default(''),
  command: z.array(z.string()).default([]),
  resources: z.object({
    gpu: z.number().int().nonnegative().default(0),
    cpu: z.number().int().nonnegative().default(1),
    memory_gb: z.number().nonnegative().default(1),
  }).default({}),
  started_at: z.string(),
  finished_at: z.string().optional(),
  exit_code: z.number().int(),
  failure_class: FailureClass.optional(),
  metrics_artifact: z.string().optional(), // sha256:...
  log_artifact: z.string().optional(), // sha256:...
  checkpoint_artifact: z.string().optional(), // sha256:...
  signed_by: z.string().default('runner-gateway'),
})
export type RunManifest = z.infer<typeof RunManifest>
