/**
 * Evidence-layer schemas: EvidenceItem, Claim, and their status rules
 * (design §4.7, §6.5). Writer agents only read; Statistician/Auditor write.
 * @module @dsh-scholar/research-schemas
 */

import { z } from 'zod'

/** A statistical evidence item produced by a deterministic analysis pipeline. */
export const EvidenceItem = z.object({
  evidence_id: z.string().min(1),
  project_id: z.string().min(1),
  source_type: z.enum(['run', 'analysis', 'external-passage', 'reproduction']),
  run_ids: z.array(z.string()).default([]),
  artifact_refs: z.array(z.string()).default([]), // sha256:... of analysis artifacts
  analysis_method: z.string().min(1),
  result: z.object({
    primary_metric: z.string().min(1),
    value: z.number(),
    baseline_value: z.number().optional(),
    effect_size: z.number().optional(),
    ci_low: z.number().optional(),
    ci_high: z.number().optional(),
    p_value: z.number().optional(),
    n_seeds: z.number().int().nonnegative().default(0),
    /** MetricSpec direction (§12): claim verification interprets the sign of
     * the effect relative to this direction (lower-is-better => negative
     * effect is the improvement). */
    direction: z.enum(['higher_is_better', 'lower_is_better']).optional(),
  }),
  uncertainty: z.string().default(''),
  status: z.enum(['accepted', 'conflicted', 'flagged']).default('accepted'),
  generated_by: z.string().default('statistician'),
  created_at: z.string(),
})
export type EvidenceItem = z.infer<typeof EvidenceItem>

/** A scientific claim bound to evidence; status transitions are append-only. */
export const Claim = z.object({
  claim_id: z.string().regex(/^claim_\w+$/),
  project_id: z.string().min(1),
  statement: z.string().min(1),
  scope: z.object({
    dataset: z.string().default(''),
    split: z.string().default(''),
  }).default({}),
  evidence: z.object({
    evidence_ids: z.array(z.string()).default([]),
    analysis_artifact: z.string().optional(),
  }).default({}),
  status: z.enum(['proposed', 'supported', 'contradicted', 'inconclusive', 'retracted']).default('proposed'),
  confidence: z.enum(['low', 'medium', 'high']).default('medium'),
  limitations: z.array(z.string()).default([]),
  history: z.array(z.object({
    status: z.enum(['proposed', 'supported', 'contradicted', 'inconclusive', 'retracted']),
    at: z.string(),
    reason: z.string().default(''),
  })).default([]),  created_at: z.string(),
  updated_at: z.string(),
})
export type Claim = z.infer<typeof Claim>
