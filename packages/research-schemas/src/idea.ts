/**
 * Idea-layer schemas: IdeaCard with gap, nearest prior works, counter-search,
 * falsifiability, MVE and Pareto scores (design §4.5, §6.3).
 * @module @dsh-scholar/research-schemas
 */

import { z } from 'zod'

/** Nearest prior work comparison entry. */
export const NearestPriorWork = z.object({
  paper_id: z.string().min(1),
  same: z.array(z.string()).default([]),
  different: z.array(z.string()).default([]),
})
export type NearestPriorWork = z.infer<typeof NearestPriorWork>

/** Minimum viable experiment definition. */
export const MveDefinition = z.object({
  dataset: z.string().min(1),
  baseline: z.string().min(1),
  primary_metric: z.string().min(1),
  estimated_gpu_hours: z.number().nonnegative().default(1),
  expected_runtime: z.string().default(''),
})
export type MveDefinition = z.infer<typeof MveDefinition>

/** Novelty counter-search record: queries + outcome + unresolved risk. */
export const NoveltyAudit = z.object({
  queries: z.array(z.string()).default([]),
  result: z.enum(['no_direct_match_found', 'overlap_found', 'inconclusive']),
  overlap_papers: z.array(z.string()).default([]),
  unresolved_risk: z.enum(['low', 'medium', 'high']).default('medium'),
  audited_at: z.string(),
})
export type NoveltyAudit = z.infer<typeof NoveltyAudit>

/** A structured, auditable candidate idea. */
export const IdeaCard = z.object({
  idea_id: z.string().regex(/^idea_[a-z0-9_]+$/),
  project_id: z.string().min(1),
  version: z.number().int().positive().default(1),
  title: z.string().min(1),
  hypothesis: z.string().min(1),
  scientific_gap: z.object({
    claims: z.array(z.string()).default([]),
    statement: z.string().default(''),
  }).default({ claims: [] }),
  nearest_prior_works: z.array(NearestPriorWork).default([]),
  exact_delta: z.string().min(1),
  falsification: z.object({
    observation: z.string().min(1),
  }),
  minimum_viable_experiment: MveDefinition,
  novelty_audit: NoveltyAudit.optional(),
  scores: z.object({
    feasibility: z.number().int().min(1).max(5),
    information_gain: z.number().int().min(1).max(5),
    reproducibility: z.number().int().min(1).max(5),
    cost: z.number().int().min(1).max(5),
  }),
  risk_notes: z.string().default(''),
  status: z.enum(['proposed', 'approved', 'rejected', 'archived']).default('proposed'),
  created_at: z.string(),
  updated_at: z.string(),
})
export type IdeaCard = z.infer<typeof IdeaCard>
