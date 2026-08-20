import { z } from 'zod'

export const MethodologyRolloutMode = z.enum([
  'internal-fixture',
  'opt-in-dev',
  'opt-in-user',
])
export type MethodologyRolloutMode = z.infer<typeof MethodologyRolloutMode>

export const MethodologyRolloutSha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/)
export type MethodologyRolloutSha256 = z.infer<typeof MethodologyRolloutSha256>

export const MethodologyRolloutPolicy = z.object({
  revision: z.number().int().positive(),
  mode: MethodologyRolloutMode,
  policy_hash: MethodologyRolloutSha256,
  actor_ref: z.string().trim().min(1).max(256),
  created_at: z.string().datetime({ offset: true }),
}).strict()
export type MethodologyRolloutPolicy = z.infer<typeof MethodologyRolloutPolicy>

export const ProjectMethodologyRolloutPin = z.object({
  project_id: z.string().trim().min(1).max(256),
  project_pin_revision: z.number().int().positive(),
  policy_revision: z.number().int().positive(),
  policy_hash: MethodologyRolloutSha256,
  mode: MethodologyRolloutMode,
  actor_ref: z.string().trim().min(1).max(256),
  pinned_at: z.string().datetime({ offset: true }),
}).strict()
export type ProjectMethodologyRolloutPin = z.infer<typeof ProjectMethodologyRolloutPin>

export const MethodologyRolloutConsumptionKind = z.enum([
  'knowledge-activation',
  'assurance-execution',
])
export type MethodologyRolloutConsumptionKind = z.infer<typeof MethodologyRolloutConsumptionKind>

export const MethodologyRolloutConsumptionPin = z.object({
  project_id: z.string().trim().min(1).max(256),
  subject_kind: MethodologyRolloutConsumptionKind,
  subject_id: z.string().trim().min(1).max(256),
  policy_revision: z.number().int().positive(),
  policy_hash: MethodologyRolloutSha256,
  mode: MethodologyRolloutMode,
  pinned_at: z.string().datetime({ offset: true }),
}).strict()
export type MethodologyRolloutConsumptionPin = z.infer<typeof MethodologyRolloutConsumptionPin>

export const MethodologyRolloutPolicyUpdate = z.object({
  mode: MethodologyRolloutMode,
  expected_revision: z.number().int().positive(),
  actor_ref: z.string().trim().min(1).max(256),
}).strict()
export type MethodologyRolloutPolicyUpdate = z.infer<typeof MethodologyRolloutPolicyUpdate>

export const ProjectMethodologyRolloutPinRequest = z.object({
  project_id: z.string().trim().min(1).max(256),
  expected_project_pin_revision: z.number().int().positive(),
  expected_policy_revision: z.number().int().positive(),
  expected_policy_hash: MethodologyRolloutSha256,
  actor_ref: z.string().trim().min(1).max(256),
}).strict()
export type ProjectMethodologyRolloutPinRequest = z.infer<typeof ProjectMethodologyRolloutPinRequest>
