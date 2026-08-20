/**
 * Pure revision-bound writing methodology assessment.
 *
 * Reverse outlines and reviewer findings are diagnostics over frozen inputs.
 * This module never writes canonical TeX or creates Evidence/Claim facts.
 */

import {
  WritingMethodologyAssessmentInput,
  type ReviewFinding,
  type WritingInputPin,
  type WritingMethodologyAssessmentInput as WritingMethodologyAssessmentInputValue,
} from '@dsh-scholar/research-schemas'
import { createHash } from 'node:crypto'

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new TypeError('writing methodology hashes accept JSON values only')
}

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

/** Hash the complete canonical TeX tree identity, independent of row order. */
export function writingTexSha256(files: ReadonlyArray<{ path: string; content_hash: string }>): `sha256:${string}` {
  return sha256([...files]
    .map(file => ({ path: file.path, content_hash: file.content_hash }))
    .sort((left, right) => left.path.localeCompare(right.path)))
}

/** Hash current Claim → accepted Evidence bindings, independent of row order. */
export function writingClaimEvidenceSha256(bindings: ReadonlyArray<{
  claim_ref: string
  accepted_evidence_refs: readonly string[]
}>): `sha256:${string}` {
  return sha256([...bindings]
    .map(binding => ({
      claim_ref: binding.claim_ref,
      accepted_evidence_refs: [...new Set(binding.accepted_evidence_refs)].sort(),
    }))
    .sort((left, right) => left.claim_ref.localeCompare(right.claim_ref)))
}

export type WritingStaleReason =
  | 'document_revision_changed'
  | 'tex_hash_changed'
  | 'claim_evidence_hash_changed'

export interface WritingFreshnessAssessment {
  status: 'fresh' | 'stale'
  reasons: WritingStaleReason[]
}

export interface ClaimEvidenceGap {
  paragraph_ref: string
  claim_ref: string
  reason: 'missing_claim_binding' | 'missing_accepted_evidence' | 'outline_evidence_not_accepted'
}

export interface WritingMethodologyReport {
  project_id: string
  outline: WritingFreshnessAssessment
  findings: Array<WritingFreshnessAssessment & { finding_id: string }>
  claim_evidence_gaps: ClaimEvidenceGap[]
  can_apply_review: boolean
  claim_evidence_complete: boolean
  assurance_blocking: boolean
}

function freshness(pin: WritingInputPin, current: WritingInputPin): WritingFreshnessAssessment {
  const reasons: WritingStaleReason[] = []
  if (pin.document_revision !== current.document_revision) reasons.push('document_revision_changed')
  if (pin.tex_sha256 !== current.tex_sha256) reasons.push('tex_hash_changed')
  if (pin.claim_evidence_sha256 !== current.claim_evidence_sha256) {
    reasons.push('claim_evidence_hash_changed')
  }
  return { status: reasons.length === 0 ? 'fresh' : 'stale', reasons }
}

function isOpenBlockingFinding(finding: ReviewFinding): boolean {
  return finding.severity === 'blocking'
    && finding.resolution_status !== 'resolved'
    && finding.resolution_status !== 'dismissed'
}

/** Assess freshness and claim support at the sole writing-methodology seam. */
export function assessWritingMethodology(
  rawInput: WritingMethodologyAssessmentInputValue,
): WritingMethodologyReport {
  const input = WritingMethodologyAssessmentInput.parse(rawInput)
  const outline = freshness(input.outline.input_pin, input.current_input)
  const findings = input.findings.map(finding => ({
    finding_id: finding.finding_id,
    ...freshness(finding.input_pin, input.current_input),
  }))
  const acceptedByClaim = new Map(input.claim_evidence.map(binding => (
    [binding.claim_ref, new Set(binding.accepted_evidence_refs)] as const
  )))
  const gaps: ClaimEvidenceGap[] = []

  for (const paragraph of input.outline.paragraphs) {
    for (const claimRef of paragraph.claim_refs) {
      const accepted = acceptedByClaim.get(claimRef)
      if (!accepted) {
        gaps.push({
          paragraph_ref: paragraph.paragraph_ref,
          claim_ref: claimRef,
          reason: 'missing_claim_binding',
        })
        continue
      }
      if (accepted.size === 0) {
        gaps.push({
          paragraph_ref: paragraph.paragraph_ref,
          claim_ref: claimRef,
          reason: 'missing_accepted_evidence',
        })
        continue
      }
      const citedAcceptedEvidence = paragraph.evidence_refs.some(ref => accepted.has(ref))
      if (!citedAcceptedEvidence) {
        gaps.push({
          paragraph_ref: paragraph.paragraph_ref,
          claim_ref: claimRef,
          reason: 'outline_evidence_not_accepted',
        })
      }
    }
  }

  const allFindingsFresh = findings.every(finding => finding.status === 'fresh')
  const freshBlockingFinding = input.findings.some((finding, index) => (
    findings[index]?.status === 'fresh' && isOpenBlockingFinding(finding)
  ))
  return {
    project_id: input.project_id,
    outline,
    findings,
    claim_evidence_gaps: gaps,
    can_apply_review: outline.status === 'fresh' && allFindingsFresh,
    claim_evidence_complete: gaps.length === 0,
    assurance_blocking: outline.status === 'stale'
      || !allFindingsFresh
      || gaps.length > 0
      || freshBlockingFinding,
  }
}
