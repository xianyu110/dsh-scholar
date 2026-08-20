/**
 * Immutable methodology/knowledge package and revision-bound writing contracts.
 *
 * The package channel is part of the package identity: trusted Scholar-owned
 * instructions can never be reconstructed from external knowledge content.
 */

import { z } from 'zod'

export const KnowledgeSha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/)
export type KnowledgeSha256 = z.infer<typeof KnowledgeSha256>

export const KnowledgePackChannel = z.enum(['instruction', 'external-knowledge'])
export type KnowledgePackChannel = z.infer<typeof KnowledgePackChannel>

export const KnowledgeCapability = z.enum([
  'project:read-brief',
  'project:read-accepted-evidence',
  'project:read-manuscript-snapshot',
  'proposal:manuscript-patch',
  'proposal:review-finding',
  'knowledge:retrieve',
])
export type KnowledgeCapability = z.infer<typeof KnowledgeCapability>

const LocalPackPath = z.string().min(1).max(512).superRefine((value, ctx) => {
  const segments = value.split('/')
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0')
    || segments.includes('') || segments.includes('.') || segments.includes('..')
    || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pack path must be a normalized local relative path' })
  }
})

export const KnowledgePackSource = z.object({
  transport: z.literal('local'),
  origin: z.enum(['scholar-native', 'conceptual-rewrite', 'third-party']),
  path: LocalPackPath,
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  // Attribution metadata only. V1 loaders may read `path`; they never fetch this URL.
  provenance_url: z.string().url().optional(),
}).strict()
export type KnowledgePackSource = z.infer<typeof KnowledgePackSource>

export const KnowledgeLicenseStatus = z.enum([
  'SCHOLAR_OWNED',
  'VENDOR_CLEAR',
  'MIXED_REVIEW',
  'UPSTREAM_AMBIGUOUS',
  'BLOCKED',
])
export type KnowledgeLicenseStatus = z.infer<typeof KnowledgeLicenseStatus>

export const KnowledgeLicense = z.object({
  status: KnowledgeLicenseStatus,
  spdx: z.string().min(1).max(128),
  evidence_sha256: KnowledgeSha256,
  attribution_refs: z.array(z.string().min(1).max(512)).max(100),
}).strict()
export type KnowledgeLicense = z.infer<typeof KnowledgeLicense>

export const KnowledgePackageManifest = z.object({
  schema_version: z.literal(1),
  name: z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/).max(160),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  channel: KnowledgePackChannel,
  source: KnowledgePackSource,
  payload_sha256: KnowledgeSha256,
  license: KnowledgeLicense,
  requested_capabilities: z.array(KnowledgeCapability).max(KnowledgeCapability.options.length),
  input_schema_id: z.string().regex(/^[a-z][a-z0-9.-]+\.v\d+$/).max(160),
  output_schema_id: z.string().regex(/^[a-z][a-z0-9.-]+\.v\d+$/).max(160),
  side_effect: z.enum(['none', 'proposal-only']),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<KnowledgeCapability>()
  for (const [index, capability] of value.requested_capabilities.entries()) {
    if (seen.has(capability)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate requested capability',
        path: ['requested_capabilities', index],
      })
    }
    seen.add(capability)
  }

  if (value.channel === 'instruction') {
    if (value.source.origin === 'third-party') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'third-party content cannot become an Instruction Pack',
        path: ['source', 'origin'],
      })
    }
    if (value.requested_capabilities.includes('knowledge:retrieve')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Instruction Packs cannot retrieve external knowledge',
        path: ['requested_capabilities'],
      })
    }
  } else {
    if (value.requested_capabilities.some(capability => capability !== 'knowledge:retrieve')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'External Knowledge Packs are read-only untrusted references',
        path: ['requested_capabilities'],
      })
    }
    if (value.side_effect !== 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'External Knowledge Packs cannot propose mutations',
        path: ['side_effect'],
      })
    }
  }
})
export type KnowledgePackageManifest = z.infer<typeof KnowledgePackageManifest>

export const KnowledgePackageRecord = z.object({
  manifest: KnowledgePackageManifest,
  manifest_sha256: KnowledgeSha256,
}).strict()
export type KnowledgePackageRecord = z.infer<typeof KnowledgePackageRecord>

export const KnowledgeEvaluationVerdict = z.enum(['approved', 'restricted', 'rejected', 'revoked'])
export type KnowledgeEvaluationVerdict = z.infer<typeof KnowledgeEvaluationVerdict>

export const KnowledgePackageEvaluation = z.object({
  package_name: z.string().min(1).max(160),
  package_version: z.string().min(1).max(80),
  manifest_sha256: KnowledgeSha256,
  payload_sha256: KnowledgeSha256,
  verdict: KnowledgeEvaluationVerdict,
  granted_capabilities: z.array(KnowledgeCapability).max(KnowledgeCapability.options.length),
}).strict()
export type KnowledgePackageEvaluation = z.infer<typeof KnowledgePackageEvaluation>

export const KnowledgeActivationRequest = z.object({
  project_id: z.string().min(1).max(256),
  session_id: z.string().min(1).max(256),
  package_name: z.string().min(1).max(160),
  package_version: z.string().min(1).max(80),
  manifest_sha256: KnowledgeSha256,
  payload_sha256: KnowledgeSha256,
  phase: z.string().min(1).max(64),
  next_action_revision: z.number().int().nonnegative(),
  explicit_human_activation: z.boolean(),
  principal_capabilities: z.array(KnowledgeCapability).max(KnowledgeCapability.options.length),
  next_action_capabilities: z.array(KnowledgeCapability).max(KnowledgeCapability.options.length),
  project_policy_capabilities: z.array(KnowledgeCapability).max(KnowledgeCapability.options.length),
}).strict()
export type KnowledgeActivationRequest = z.infer<typeof KnowledgeActivationRequest>

/**
 * Untrusted activation intent accepted at HTTP/DSH boundaries. Project,
 * session, phase, NextAction and all capability sets are deliberately absent:
 * the Kernel derives those authority facts from durable state.
 */
export const KnowledgeActivationIntent = z.object({
  package_name: z.string().min(1).max(160),
  package_version: z.string().min(1).max(80),
  manifest_sha256: KnowledgeSha256,
  payload_sha256: KnowledgeSha256,
  explicit_human_activation: z.literal(true),
  expected_revision: z.number().int().nonnegative().safe(),
  expected_registry_revision: z.number().int().nonnegative().safe(),
  expected_project_revision: z.number().int().nonnegative().safe(),
  expected_next_action_revision: z.number().int().nonnegative().safe(),
}).strict()
export type KnowledgeActivationIntent = z.infer<typeof KnowledgeActivationIntent>

export const KnowledgeRegistryResolutionInput = z.object({
  packages: z.array(KnowledgePackageRecord).max(10_000),
  evaluations: z.array(KnowledgePackageEvaluation).max(10_000),
  request: KnowledgeActivationRequest,
}).strict()
export type KnowledgeRegistryResolutionInput = z.infer<typeof KnowledgeRegistryResolutionInput>

export const WritingInputPin = z.object({
  project_id: z.string().min(1).max(256),
  document_id: z.string().min(1).max(256),
  document_revision: z.number().int().nonnegative(),
  tex_sha256: KnowledgeSha256,
  claim_evidence_sha256: KnowledgeSha256,
}).strict()
export type WritingInputPin = z.infer<typeof WritingInputPin>

export const ReverseOutlineParagraph = z.object({
  paragraph_ref: z.string().min(1).max(256),
  role: z.enum(['motivation', 'background', 'method', 'result', 'limitation', 'transition', 'other']),
  message: z.string().min(1).max(8_192),
  claim_refs: z.array(z.string().min(1).max(256)).max(100),
  evidence_refs: z.array(z.string().min(1).max(256)).max(1_000),
  relation_to_thesis: z.enum(['supports', 'refines', 'contrasts', 'orphan']),
}).strict()
export type ReverseOutlineParagraph = z.infer<typeof ReverseOutlineParagraph>

export const ReverseOutlineIssue = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  message: z.string().min(1).max(8_192),
  paragraph_ref: z.string().min(1).max(256).optional(),
}).strict()
export type ReverseOutlineIssue = z.infer<typeof ReverseOutlineIssue>

export const ReverseOutline = z.object({
  outline_id: z.string().regex(/^outline_[a-z0-9_]+$/),
  input_pin: WritingInputPin,
  section_ref: z.string().min(1).max(256),
  section_thesis: z.string().min(1).max(16_384),
  paragraphs: z.array(ReverseOutlineParagraph).max(10_000),
  issues: z.array(ReverseOutlineIssue).max(10_000),
  status: z.literal('diagnostic'),
  created_at: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  const paragraphRefs = new Set<string>()
  for (const [index, paragraph] of value.paragraphs.entries()) {
    if (paragraphRefs.has(paragraph.paragraph_ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate reverse-outline paragraph ref',
        path: ['paragraphs', index, 'paragraph_ref'],
      })
    }
    paragraphRefs.add(paragraph.paragraph_ref)
  }
})
export type ReverseOutline = z.infer<typeof ReverseOutline>

export const ReviewFinding = z.object({
  finding_id: z.string().regex(/^finding_[a-z0-9_]+$/),
  input_pin: WritingInputPin,
  kind: z.enum(['flow', 'claim-evidence', 'citation', 'statistics', 'reproducibility', 'method-rigor']),
  severity: z.enum(['info', 'minor', 'major', 'blocking']),
  message: z.string().min(1).max(16_384),
  paragraph_ref: z.string().min(1).max(256).optional(),
  claim_ref: z.string().min(1).max(256).optional(),
  evidence_refs: z.array(z.string().min(1).max(256)).max(1_000),
  resolution_status: z.enum(['open', 'acknowledged', 'resolved', 'dismissed']),
  status: z.literal('diagnostic'),
  created_at: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'claim-evidence' && value.claim_ref === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'claim-evidence finding requires a claim ref',
      path: ['claim_ref'],
    })
  }
})
export type ReviewFinding = z.infer<typeof ReviewFinding>

export const ClaimEvidenceBinding = z.object({
  claim_ref: z.string().min(1).max(256),
  accepted_evidence_refs: z.array(z.string().min(1).max(256)).max(1_000),
}).strict()
export type ClaimEvidenceBinding = z.infer<typeof ClaimEvidenceBinding>

export const WritingMethodologyAssessmentInput = z.object({
  project_id: z.string().min(1).max(256),
  current_input: WritingInputPin,
  outline: ReverseOutline,
  findings: z.array(ReviewFinding).max(10_000),
  claim_evidence: z.array(ClaimEvidenceBinding).max(10_000),
}).strict().superRefine((value, ctx) => {
  if (value.current_input.project_id !== value.project_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'current writing input belongs to another project',
      path: ['current_input', 'project_id'],
    })
  }
  if (value.outline.input_pin.project_id !== value.project_id
    || value.outline.input_pin.document_id !== value.current_input.document_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'reverse outline belongs to another project or document',
      path: ['outline', 'input_pin'],
    })
  }
  const findingIds = new Set<string>()
  for (const [index, finding] of value.findings.entries()) {
    if (finding.input_pin.project_id !== value.project_id
      || finding.input_pin.document_id !== value.current_input.document_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'review finding belongs to another project or document',
        path: ['findings', index, 'input_pin'],
      })
    }
    if (findingIds.has(finding.finding_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate review finding id',
        path: ['findings', index, 'finding_id'],
      })
    }
    findingIds.add(finding.finding_id)
  }
  const claims = new Set<string>()
  for (const [index, binding] of value.claim_evidence.entries()) {
    if (claims.has(binding.claim_ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate claim-evidence binding',
        path: ['claim_evidence', index, 'claim_ref'],
      })
    }
    claims.add(binding.claim_ref)
  }
})
export type WritingMethodologyAssessmentInput = z.infer<typeof WritingMethodologyAssessmentInput>
