/**
 * Strict, revision-bound writing-methodology contracts.
 *
 * These objects are diagnostics and proposals. They never mutate a Project
 * phase, accept Evidence/Claims, approve Gates, or write TeX by themselves.
 */

import { z } from 'zod'
import { AssuranceSemanticReviewReceipt } from './assurance.js'
import { KnowledgeSha256, WritingInputPin } from './knowledge-methodology.js'

export const MethodTriad = z.object({
  triad_id: z.string().regex(/^triad_[a-z0-9_]+$/),
  input_pin: WritingInputPin,
  motivation: z.string().min(1).max(16_384),
  design: z.string().min(1).max(16_384),
  technical_advantage: z.object({
    statement: z.string().min(1).max(16_384),
    measurable_evidence_refs: z.array(z.string().min(1).max(256)).max(1_000),
  }).strict(),
  status: z.literal('diagnostic'),
  created_at: z.string().datetime(),
}).strict()
export type MethodTriad = z.infer<typeof MethodTriad>

export const MethodTriadDiagnostic = z.object({
  triad_id: z.string().regex(/^triad_[a-z0-9_]+$/),
  input_pin: WritingInputPin,
  status: z.enum(['ready', 'diagnostic_gap']),
  gaps: z.array(z.object({
    code: z.literal('technical_advantage_measurable_evidence_missing'),
    missing_evidence_refs: z.array(z.string().min(1).max(256)).min(1).max(1_000),
  }).strict()).max(1),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'ready' && value.gaps.length !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ready MethodTriad cannot have gaps', path: ['gaps'] })
  }
  if (value.status === 'diagnostic_gap' && value.gaps.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'diagnostic MethodTriad requires a typed gap', path: ['gaps'] })
  }
})
export type MethodTriadDiagnostic = z.infer<typeof MethodTriadDiagnostic>

export const SectionGuideKind = z.enum([
  'abstract', 'introduction', 'related-work', 'method', 'experiments',
  'limitations-ethics', 'conclusion', 'appendix-reproducibility', 'reviewer-response',
])
export type SectionGuideKind = z.infer<typeof SectionGuideKind>

export const SectionGuideInput = z.enum([
  'research_problem', 'method_triad', 'protocol', 'accepted_evidence',
  'analysis', 'limitations', 'citations', 'review_findings',
])
export type SectionGuideInput = z.infer<typeof SectionGuideInput>

export const SectionGuideActivationRequest = z.object({
  activation_id: z.string().regex(/^section_guide_[a-z0-9_]+$/),
  input_pin: WritingInputPin,
  section: SectionGuideKind,
  available_inputs: z.array(SectionGuideInput).max(SectionGuideInput.options.length),
  created_at: z.string().datetime(),
}).strict()
export type SectionGuideActivationRequest = z.infer<typeof SectionGuideActivationRequest>

export const SectionGuideActivation = z.object({
  activation_id: z.string().regex(/^section_guide_[a-z0-9_]+$/),
  input_pin: WritingInputPin,
  section: SectionGuideKind,
  guide_id: z.string().regex(/^scholar-native\.[a-z0-9-]+\.v\d+$/),
  channel: z.literal('instruction'),
  required_inputs: z.array(SectionGuideInput).max(SectionGuideInput.options.length),
  available_inputs: z.array(SectionGuideInput).max(SectionGuideInput.options.length),
  missing_inputs: z.array(SectionGuideInput).max(SectionGuideInput.options.length),
  state: z.enum(['active', 'diagnostic_gap']),
  created_at: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (value.state === 'active' && value.missing_inputs.length !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'active SectionGuide cannot have missing inputs', path: ['missing_inputs'] })
  }
  if (value.state === 'diagnostic_gap' && value.missing_inputs.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'diagnostic SectionGuide requires missing inputs', path: ['missing_inputs'] })
  }
})
export type SectionGuideActivation = z.infer<typeof SectionGuideActivation>

export const WritingReviewerRole = z.enum(['claim-evidence', 'citation', 'statistics', 'reproducibility'])
export type WritingReviewerRole = z.infer<typeof WritingReviewerRole>

export const WritingReviewerRoleResult = z.object({
  role: WritingReviewerRole,
  state: z.enum(['complete', 'missing']),
  child_id: z.string().min(1).max(256).nullable(),
  summary: z.string().min(1).max(4_000).nullable(),
  notes: z.array(z.string().min(1).max(2_000)).max(100),
  references: z.array(z.string().min(1).max(512)).max(100),
  output_hash: KnowledgeSha256.nullable(),
}).strict().superRefine((value, ctx) => {
  const complete = value.child_id !== null && value.summary !== null && value.output_hash !== null
  if ((value.state === 'complete') !== complete) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'reviewer role state must match its immutable child output', path: ['state'] })
  }
})
export type WritingReviewerRoleResult = z.infer<typeof WritingReviewerRoleResult>

export const WritingReviewerPanelAggregate = z.object({
  aggregate_id: z.string().regex(/^review_panel_[a-z0-9_]+$/),
  input_pin: WritingInputPin,
  panel_id: z.string().min(1).max(256),
  panel_hash: KnowledgeSha256,
  state: z.enum(['complete', 'partial', 'missing']),
  roles: z.array(WritingReviewerRoleResult).length(WritingReviewerRole.options.length),
  failures: z.array(z.string().min(1).max(1_000)).max(32),
  independence: z.literal('same-family'),
  created_at: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  const roles = value.roles.map(role => role.role)
  if (new Set(roles).size !== WritingReviewerRole.options.length
    || WritingReviewerRole.options.some(role => !roles.includes(role))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'review panel must contain each reviewer role exactly once', path: ['roles'] })
  }
  const complete = value.roles.filter(role => role.state === 'complete').length
  const expectedState = complete === 0 ? 'missing' : complete === value.roles.length ? 'complete' : 'partial'
  if (value.state !== expectedState) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'review panel state must expose partial or missing roles', path: ['state'] })
  }
})
export type WritingReviewerPanelAggregate = z.infer<typeof WritingReviewerPanelAggregate>

export const WritingReviewerPanelAggregateInput = z.object({
  aggregate_id: z.string().regex(/^review_panel_[a-z0-9_]+$/),
  input_pin: WritingInputPin,
  semantic_review: AssuranceSemanticReviewReceipt,
  created_at: z.string().datetime(),
}).strict()
export type WritingReviewerPanelAggregateInput = z.infer<typeof WritingReviewerPanelAggregateInput>

export const WritingCompilePin = z.object({
  latest_build_id: z.string().min(1).max(256).nullable(),
  latest_build_revision: z.number().int().nonnegative().nullable(),
  latest_build_status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'superseded']).nullable(),
}).strict().superRefine((value, ctx) => {
  const filled = [value.latest_build_id, value.latest_build_revision, value.latest_build_status].filter(item => item !== null).length
  if (filled !== 0 && filled !== 3) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'compile pin must be entirely null or entirely populated' })
  }
})
export type WritingCompilePin = z.infer<typeof WritingCompilePin>

export const WritingPatchProposal = z.object({
  proposal_id: z.string().regex(/^writing_patch_[a-z0-9_]+$/),
  project_id: z.string().min(1).max(256),
  aggregate_id: z.string().regex(/^review_panel_[a-z0-9_]+$/),
  reviewer_role: WritingReviewerRole,
  reviewer_child_id: z.string().min(1).max(256),
  input_pin: WritingInputPin,
  compile_pin: WritingCompilePin,
  file_path: z.string().min(1).max(512),
  expected_file_sha256: KnowledgeSha256,
  replacement_content: z.string().max(10_000_000),
  replacement_sha256: KnowledgeSha256,
  rationale: z.string().min(1).max(16_384),
  status: z.literal('proposed'),
  created_at: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (value.project_id !== value.input_pin.project_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'patch proposal belongs to another project', path: ['input_pin', 'project_id'] })
  }
})
export type WritingPatchProposal = z.infer<typeof WritingPatchProposal>

export const HumanWritingPrincipal = z.object({
  principal_id: z.string().min(1).max(256),
  auth_method: z.enum(['dsh-session', 'sso', 'local-human']),
  session_id: z.string().min(1).max(256).nullable().optional(),
}).strict()
export type HumanWritingPrincipal = z.infer<typeof HumanWritingPrincipal>

export const WritingPatchApplyInput = z.object({
  expected_revision: z.number().int().nonnegative(),
  expected_document_revision: z.number().int().nonnegative(),
  expected_tex_sha256: KnowledgeSha256,
  expected_claim_evidence_sha256: KnowledgeSha256,
  expected_compile_pin: WritingCompilePin,
}).strict()
export type WritingPatchApplyInput = z.infer<typeof WritingPatchApplyInput>

export const WritingPatchApplication = z.object({
  application_id: z.string().regex(/^writing_apply_[a-z0-9_]+$/),
  proposal_id: z.string().regex(/^writing_patch_[a-z0-9_]+$/),
  project_id: z.string().min(1).max(256),
  actor: HumanWritingPrincipal,
  input_pin: WritingInputPin,
  output_pin: WritingInputPin,
  compile_pin: WritingCompilePin,
  file_path: z.string().min(1).max(512),
  file_version: z.number().int().positive(),
  preview_requested_revision: z.number().int().nonnegative(),
  applied_at: z.string().datetime(),
}).strict()
export type WritingPatchApplication = z.infer<typeof WritingPatchApplication>

export const MethodTriadWrite = z.object({
  record: MethodTriad,
  expected_revision: z.number().int().nonnegative().safe(),
}).strict()
export type MethodTriadWrite = z.infer<typeof MethodTriadWrite>

export const SectionGuideActivationWrite = z.object({
  request: SectionGuideActivationRequest,
  expected_revision: z.number().int().nonnegative().safe(),
}).strict()
export type SectionGuideActivationWrite = z.infer<typeof SectionGuideActivationWrite>

export const WritingReviewerPanelWrite = WritingReviewerPanelAggregateInput.extend({
  expected_revision: z.number().int().nonnegative().safe(),
}).strict()
export type WritingReviewerPanelWrite = z.infer<typeof WritingReviewerPanelWrite>

export const WritingPatchProposalWrite = z.object({
  record: WritingPatchProposal,
  expected_revision: z.number().int().nonnegative().safe(),
}).strict()
export type WritingPatchProposalWrite = z.infer<typeof WritingPatchProposalWrite>
