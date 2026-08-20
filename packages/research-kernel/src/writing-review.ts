/** Pure writing-review methodology evaluators. */

import { createHash } from 'node:crypto'
import {
  MethodTriad,
  MethodTriadDiagnostic,
  SectionGuideActivation,
  SectionGuideActivationRequest,
  WritingReviewerPanelAggregate,
  WritingReviewerPanelAggregateInput,
  WritingReviewerRole,
  type MethodTriad as MethodTriadValue,
  type MethodTriadDiagnostic as MethodTriadDiagnosticValue,
  type SectionGuideActivation as SectionGuideActivationValue,
  type SectionGuideActivationRequest as SectionGuideActivationRequestValue,
  type SectionGuideInput,
  type SectionGuideKind,
  type WritingReviewerPanelAggregate as WritingReviewerPanelAggregateValue,
  type WritingReviewerPanelAggregateInput as WritingReviewerPanelAggregateInputValue,
} from '@dsh-scholar/research-schemas'

const SECTION_REQUIREMENTS: Readonly<Record<SectionGuideKind, readonly SectionGuideInput[]>> = {
  abstract: ['research_problem', 'method_triad', 'accepted_evidence'],
  introduction: ['research_problem', 'method_triad', 'citations'],
  'related-work': ['research_problem', 'citations'],
  method: ['research_problem', 'method_triad', 'protocol', 'accepted_evidence'],
  experiments: ['research_problem', 'protocol', 'accepted_evidence', 'analysis'],
  'limitations-ethics': ['accepted_evidence', 'limitations'],
  conclusion: ['research_problem', 'accepted_evidence', 'limitations'],
  'appendix-reproducibility': ['protocol', 'analysis'],
  'reviewer-response': ['review_findings', 'accepted_evidence'],
}

export function writingFileSha256(content: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
}

export function assessMethodTriad(
  rawTriad: MethodTriadValue,
  acceptedMeasurableEvidenceRefs: readonly string[],
): MethodTriadDiagnosticValue {
  const triad = MethodTriad.parse(rawTriad)
  const accepted = new Set(acceptedMeasurableEvidenceRefs)
  const missing = [...new Set(triad.technical_advantage.measurable_evidence_refs)]
    .filter(ref => !accepted.has(ref))
    .sort()
  if (triad.technical_advantage.measurable_evidence_refs.length === 0) {
    missing.push('measurable_evidence_required')
  }
  return MethodTriadDiagnostic.parse({
    triad_id: triad.triad_id,
    input_pin: triad.input_pin,
    status: missing.length === 0 ? 'ready' : 'diagnostic_gap',
    gaps: missing.length === 0 ? [] : [{
      code: 'technical_advantage_measurable_evidence_missing',
      missing_evidence_refs: missing,
    }],
  })
}

export function activateSectionGuide(
  rawRequest: SectionGuideActivationRequestValue,
): SectionGuideActivationValue {
  const request = SectionGuideActivationRequest.parse(rawRequest)
  const required = [...SECTION_REQUIREMENTS[request.section]]
  const available = [...new Set(request.available_inputs)]
  const availableSet = new Set(available)
  const missing = required.filter(item => !availableSet.has(item))
  return SectionGuideActivation.parse({
    ...request,
    guide_id: `scholar-native.${request.section}.v1`,
    channel: 'instruction',
    required_inputs: required,
    available_inputs: available,
    missing_inputs: missing,
    state: missing.length === 0 ? 'active' : 'diagnostic_gap',
  })
}

export function aggregateWritingReviewerPanel(
  rawInput: WritingReviewerPanelAggregateInputValue,
): WritingReviewerPanelAggregateValue {
  const input = WritingReviewerPanelAggregateInput.parse(rawInput)
  if (input.semantic_review.project_id !== input.input_pin.project_id) {
    throw new Error('semantic review belongs to another project')
  }
  const byRole = new Map(input.semantic_review.reviewers.map(reviewer => [reviewer.reviewer_role, reviewer] as const))
  const roles = WritingReviewerRole.options.map(role => {
    const reviewer = byRole.get(role)
    return reviewer === undefined
      ? { role, state: 'missing' as const, child_id: null, summary: null, notes: [], references: [], output_hash: null }
      : {
          role, state: 'complete' as const, child_id: reviewer.child_id, summary: reviewer.summary,
          notes: reviewer.notes, references: reviewer.references, output_hash: reviewer.output_hash,
        }
  })
  const complete = roles.filter(role => role.state === 'complete').length
  return WritingReviewerPanelAggregate.parse({
    aggregate_id: input.aggregate_id,
    input_pin: input.input_pin,
    panel_id: input.semantic_review.panel_id,
    panel_hash: input.semantic_review.panel_hash,
    state: complete === 0 ? 'missing' : complete === roles.length ? 'complete' : 'partial',
    roles,
    failures: input.semantic_review.failures,
    independence: input.semantic_review.independence,
    created_at: input.created_at,
  })
}
