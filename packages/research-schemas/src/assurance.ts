/**
 * Methodology assurance contracts.
 *
 * Execution, verdict and acceptance are intentionally independent axes.
 * These schemas describe immutable audit facts and the pure verifier input;
 * they do not grant any Kernel write or Gate authority.
 * @module @dsh-scholar/research-schemas/assurance
 */

import { z } from 'zod'

export const AssuranceExecutionStatus = z.enum([
  'queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out',
])
export type AssuranceExecutionStatus = z.infer<typeof AssuranceExecutionStatus>

export const AssuranceVerdict = z.enum([
  'PASS', 'WARN', 'FAIL', 'NOT_APPLICABLE', 'BLOCKED', 'ERROR',
])
export type AssuranceVerdict = z.infer<typeof AssuranceVerdict>

export const AssuranceAcceptanceStatus = z.enum([
  'pending', 'provisional', 'accepted', 'rejected', 'stale',
])
export type AssuranceAcceptanceStatus = z.infer<typeof AssuranceAcceptanceStatus>

export const AssuranceLevel = z.enum(['draft', 'submission'])
export type AssuranceLevel = z.infer<typeof AssuranceLevel>

export const AssuranceAuditKind = z.enum([
  'claim-evidence',
  'citation',
  'reproducibility',
  'writing',
  'statistics',
  'license',
  'release-integrity',
])
export type AssuranceAuditKind = z.infer<typeof AssuranceAuditKind>

export const AssuranceReviewMethod = z.enum(['deterministic', 'semantic'])
export type AssuranceReviewMethod = z.infer<typeof AssuranceReviewMethod>

export const AssuranceReviewIndependence = z.enum([
  'deterministic', 'unverified', 'same-model', 'same-family', 'cross-family', 'human',
])
export type AssuranceReviewIndependence = z.infer<typeof AssuranceReviewIndependence>

/** Deterministic producers currently implemented by runWritingAssurance. */
export const WritingAssuranceAuditKind = z.enum(['writing', 'claim-evidence'])
export type WritingAssuranceAuditKind = z.infer<typeof WritingAssuranceAuditKind>

export const AssuranceSha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/)
export type AssuranceSha256 = z.infer<typeof AssuranceSha256>

export const AssuranceTargetRef = z.object({
  kind: z.string().min(1).max(64),
  id: z.string().min(1).max(256),
  revision: z.number().int().nonnegative().optional(),
}).strict()
export type AssuranceTargetRef = z.infer<typeof AssuranceTargetRef>

export const AssuranceInputPin = z.object({
  ref: z.string().min(1).max(512),
  sha256: AssuranceSha256,
}).strict()
export type AssuranceInputPin = z.infer<typeof AssuranceInputPin>

export const AssuranceReview = z.object({
  method: AssuranceReviewMethod,
  independence: AssuranceReviewIndependence,
  executor_ref: z.string().min(1).max(256).optional(),
  reviewer_ref: z.string().min(1).max(256).optional(),
  topology_node_id: z.string().min(1).max(256).optional(),
}).strict()
export type AssuranceReview = z.infer<typeof AssuranceReview>

export const AssuranceAudit = z.object({
  audit_id: z.string().regex(/^audit_[a-z0-9_]+$/),
  project_id: z.string().min(1).max(256),
  audit_kind: AssuranceAuditKind,
  target_refs: z.array(AssuranceTargetRef).min(1).max(100),
  assurance_level: AssuranceLevel,
  execution: z.object({
    status: AssuranceExecutionStatus,
    run_ref: z.string().min(1).max(256).optional(),
  }).strict(),
  verdict: AssuranceVerdict,
  reason_code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  findings_artifact_id: z.string().min(1).max(256),
  input_pins: z.array(AssuranceInputPin).min(1).max(1_000),
  review: AssuranceReview,
  acceptance_status: AssuranceAcceptanceStatus,
  created_at: z.string().datetime(),
  supersedes: z.string().regex(/^audit_[a-z0-9_]+$/).optional(),
}).strict().superRefine((value, ctx) => {
  const refs = new Set<string>()
  for (const [index, pin] of value.input_pins.entries()) {
    if (refs.has(pin.ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate assurance input ref',
        path: ['input_pins', index, 'ref'],
      })
    }
    refs.add(pin.ref)
  }
})
export type AssuranceAudit = z.infer<typeof AssuranceAudit>

/**
 * Redacted proposal-only output from one read-only semantic reviewer child.
 * The child id is verified against the project's StageSubagent topology by
 * the Kernel before any audit is recorded. Semantic text is evidence about
 * a review, never authority to mutate the manuscript or approve a Gate.
 */
export const AssuranceSemanticFinding = z.object({
  reviewer_role: z.enum(['claim-evidence', 'citation', 'statistics', 'reproducibility']),
  child_id: z.string().min(1).max(256),
  summary: z.string().min(1).max(4_000),
  notes: z.array(z.string().min(1).max(2_000)).max(100),
  references: z.array(z.string().min(1).max(512)).max(100),
  output_hash: AssuranceSha256,
}).strict()
export type AssuranceSemanticFinding = z.infer<typeof AssuranceSemanticFinding>

/**
 * Immutable fan-in receipt produced from the existing StageSubagent panel.
 * `same-family` is deliberately the only automated independence claim the
 * current runtime can prove; it therefore never yields accepted assurance.
 */
export const AssuranceSemanticReviewReceipt = z.object({
  panel_id: z.string().min(1).max(256),
  project_id: z.string().min(1).max(256),
  session_id: z.string().min(1).max(256),
  project_revision: z.number().int().nonnegative(),
  action_id: z.string().min(1).max(256),
  action_revision: z.number().int().nonnegative().nullable(),
  panel_hash: AssuranceSha256,
  input_hash: AssuranceSha256,
  state: z.enum(['complete', 'partial', 'missing']),
  reviewers: z.array(AssuranceSemanticFinding).max(16),
  failures: z.array(z.string().min(1).max(1_000)).max(32),
  independence: z.literal('same-family'),
}).strict().superRefine((value, ctx) => {
  const reviewerIds = new Set<string>()
  const reviewerRoles = new Set<string>()
  for (const [index, reviewer] of value.reviewers.entries()) {
    if (reviewerIds.has(reviewer.child_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate semantic reviewer child',
        path: ['reviewers', index, 'child_id'],
      })
    }
    reviewerIds.add(reviewer.child_id)
    if (reviewerRoles.has(reviewer.reviewer_role)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate semantic reviewer role',
        path: ['reviewers', index, 'reviewer_role'],
      })
    }
    reviewerRoles.add(reviewer.reviewer_role)
  }
  if (value.state === 'complete' && (value.reviewers.length !== 4 || value.failures.length !== 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'complete semantic review requires all four reviewer roles and no failures', path: ['state'] })
  }
  if (value.state === 'partial' && (value.reviewers.length === 0 || value.failures.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'partial semantic review requires reviewers and failures', path: ['state'] })
  }
  if (value.state === 'missing' && (value.reviewers.length !== 0 || value.failures.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'missing semantic review requires no reviewers and at least one failure', path: ['state'] })
  }
})
export type AssuranceSemanticReviewReceipt = z.infer<typeof AssuranceSemanticReviewReceipt>

/** Strict execution boundary: callers never choose a target or acceptance. */
export const WritingAssuranceExecutionInput = z.discriminatedUnion('mode', [
  z.object({
    project_id: z.string().min(1).max(256),
    expected_revision: z.number().int().nonnegative(),
    audit_kind: WritingAssuranceAuditKind,
    mode: z.literal('deterministic'),
    semantic_review: z.null(),
  }).strict(),
  z.object({
    project_id: z.string().min(1).max(256),
    expected_revision: z.number().int().nonnegative(),
    audit_kind: WritingAssuranceAuditKind,
    mode: z.literal('semantic'),
    semantic_review: AssuranceSemanticReviewReceipt,
  }).strict(),
])
export type WritingAssuranceExecutionInput = z.infer<typeof WritingAssuranceExecutionInput>

export const AssuranceVerificationInput = z.object({
  project_id: z.string().min(1).max(256),
  level: AssuranceLevel,
  audits: z.array(AssuranceAudit).max(100),
  required_audit_kinds: z.array(AssuranceAuditKind).max(AssuranceAuditKind.options.length),
  current_input_hashes: z.record(AssuranceSha256),
}).strict().superRefine((value, ctx) => {
  const auditIds = new Set<string>()
  const auditKinds = new Set<AssuranceAuditKind>()
  for (const [index, audit] of value.audits.entries()) {
    if (audit.project_id !== value.project_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'assurance audit belongs to another project',
        path: ['audits', index, 'project_id'],
      })
    }
    if (auditIds.has(audit.audit_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate assurance audit id',
        path: ['audits', index, 'audit_id'],
      })
    }
    if (auditKinds.has(audit.audit_kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'verification input requires one selected audit per kind',
        path: ['audits', index, 'audit_kind'],
      })
    }
    auditIds.add(audit.audit_id)
    auditKinds.add(audit.audit_kind)
  }

  const required = new Set<AssuranceAuditKind>()
  for (const [index, kind] of value.required_audit_kinds.entries()) {
    if (required.has(kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate required assurance audit kind',
        path: ['required_audit_kinds', index],
      })
    }
    required.add(kind)
  }
})
export type AssuranceVerificationInput = z.infer<typeof AssuranceVerificationInput>
