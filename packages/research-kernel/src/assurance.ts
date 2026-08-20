/**
 * Pure methodology-assurance verifier.
 *
 * The module deliberately has no database, network, model, tool or Kernel
 * dependency. It computes an effective projection from immutable audit facts;
 * callers remain responsible for Project AuthZ and authoritative writes.
 */

import {
  AssuranceVerificationInput,
  type AssuranceAcceptanceStatus,
  type AssuranceAudit,
  type AssuranceAuditKind,
  type AssuranceExecutionStatus,
  type AssuranceVerdict,
  type AssuranceVerificationInput as AssuranceVerificationInputValue,
  type WritingAssuranceAuditKind,
} from '@dsh-scholar/research-schemas'

export interface DeterministicAssuranceCheck {
  check: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

export interface DeterministicAssuranceProducerResult {
  audit_kind: WritingAssuranceAuditKind
  producer: 'kernel:manuscript-review-v1' | 'kernel:claim-evidence-binding-v1'
  applicability: {
    applicable: boolean
    reason_code: 'writing_review_supported' | 'claims_registered' | 'no_claims_registered'
  }
  checks: DeterministicAssuranceCheck[]
}

/**
 * Dispatch one explicitly registered deterministic producer. A missing
 * producer cannot be represented here and therefore remains a missing Audit
 * in verifyAssurance rather than being fabricated as NOT_APPLICABLE.
 */
export function dispatchDeterministicAssuranceProducer(input: {
  audit_kind: WritingAssuranceAuditKind
  claim_count: number
  manuscript_checks: DeterministicAssuranceCheck[]
}): DeterministicAssuranceProducerResult {
  if (input.audit_kind === 'writing') {
    return {
      audit_kind: 'writing',
      producer: 'kernel:manuscript-review-v1',
      applicability: { applicable: true, reason_code: 'writing_review_supported' },
      checks: input.manuscript_checks,
    }
  }
  const checks = input.manuscript_checks.filter(check => check.check === 'claim-evidence binding')
  return {
    audit_kind: 'claim-evidence',
    producer: 'kernel:claim-evidence-binding-v1',
    applicability: input.claim_count === 0
      ? { applicable: false, reason_code: 'no_claims_registered' }
      : { applicable: true, reason_code: 'claims_registered' },
    checks: input.claim_count === 0 ? [] : checks,
  }
}

export type AssuranceReason =
  | 'input_missing'
  | 'input_hash_mismatch'
  | 'review_method_independence_mismatch'
  | 'execution_incomplete'
  | 'verdict_blocking'
  | 'acceptance_rejected'
  | 'acceptance_pending'
  | 'assurance_level_insufficient'
  | 'semantic_independence_insufficient'
  | 'acceptance_provisional'

export interface AssuranceAuditAssessment {
  audit_id: string
  audit_kind: AssuranceAuditKind
  execution_status: AssuranceExecutionStatus
  verdict: AssuranceVerdict
  recorded_acceptance_status: AssuranceAcceptanceStatus
  effective_acceptance_status: AssuranceAcceptanceStatus
  required: boolean
  blocking: boolean
  reasons: AssuranceReason[]
}

export interface AssuranceVerificationReport {
  project_id: string
  level: AssuranceVerificationInputValue['level']
  audits: AssuranceAuditAssessment[]
  missing_audit_kinds: AssuranceAuditKind[]
  overall_assurance: 'blocked' | 'provisional' | 'accepted'
  submission_ready: boolean
}

interface EffectiveAcceptance {
  status: AssuranceAcceptanceStatus
  reasons: AssuranceReason[]
}

function effectiveAcceptance(
  audit: AssuranceAudit,
  input: AssuranceVerificationInputValue,
): EffectiveAcceptance {
  for (const pin of audit.input_pins) {
    const current = input.current_input_hashes[pin.ref]
    if (current === undefined) return { status: 'stale', reasons: ['input_missing'] }
    if (current !== pin.sha256) return { status: 'stale', reasons: ['input_hash_mismatch'] }
  }
  if (audit.acceptance_status === 'stale') return { status: 'stale', reasons: [] }

  const deterministicPair = audit.review.method === 'deterministic'
    && audit.review.independence === 'deterministic'
  const semanticPair = audit.review.method === 'semantic'
    && audit.review.independence !== 'deterministic'
  if (!deterministicPair && !semanticPair) {
    return { status: 'rejected', reasons: ['review_method_independence_mismatch'] }
  }

  if (audit.execution.status !== 'succeeded') {
    const status: AssuranceAcceptanceStatus = audit.execution.status === 'queued'
      || audit.execution.status === 'running'
      ? 'pending'
      : 'rejected'
    return { status, reasons: ['execution_incomplete'] }
  }

  if (audit.verdict === 'FAIL' || audit.verdict === 'BLOCKED' || audit.verdict === 'ERROR') {
    return { status: 'rejected', reasons: ['verdict_blocking'] }
  }
  if (audit.acceptance_status === 'rejected') {
    return { status: 'rejected', reasons: ['acceptance_rejected'] }
  }
  if (audit.acceptance_status === 'pending') {
    return { status: 'pending', reasons: ['acceptance_pending'] }
  }
  if (input.level === 'submission' && audit.assurance_level !== 'submission') {
    return { status: 'provisional', reasons: ['assurance_level_insufficient'] }
  }
  if (audit.review.method === 'semantic'
    && (audit.review.independence === 'unverified'
      || audit.review.independence === 'same-model'
      || audit.review.independence === 'same-family')) {
    return { status: 'provisional', reasons: ['semantic_independence_insufficient'] }
  }
  if (audit.acceptance_status === 'provisional') {
    return { status: 'provisional', reasons: ['acceptance_provisional'] }
  }
  return { status: 'accepted', reasons: [] }
}

/**
 * Verify a caller-selected current audit set. The input schema rejects
 * cross-project or duplicate-kind ambiguity before any projection is made.
 */
export function verifyAssurance(rawInput: AssuranceVerificationInputValue): AssuranceVerificationReport {
  const input = AssuranceVerificationInput.parse(rawInput)
  const required = new Set(input.required_audit_kinds)
  const present = new Set(input.audits.map(audit => audit.audit_kind))
  const missing = input.required_audit_kinds.filter(kind => !present.has(kind))

  const audits = input.audits.map((audit): AssuranceAuditAssessment => {
    const effective = effectiveAcceptance(audit, input)
    const isRequired = required.has(audit.audit_kind)
    const blocking = isRequired && (
      effective.status === 'stale'
      || effective.status === 'rejected'
      || effective.status === 'pending'
    )
    return {
      audit_id: audit.audit_id,
      audit_kind: audit.audit_kind,
      execution_status: audit.execution.status,
      verdict: audit.verdict,
      recorded_acceptance_status: audit.acceptance_status,
      effective_acceptance_status: effective.status,
      required: isRequired,
      blocking,
      reasons: effective.reasons,
    }
  })

  const requiredAudits = audits.filter(audit => audit.required)
  const blocked = missing.length > 0 || requiredAudits.some(audit => audit.blocking)
  const provisional = !blocked && requiredAudits.some(
    audit => audit.effective_acceptance_status === 'provisional',
  )
  const overall: AssuranceVerificationReport['overall_assurance'] = blocked
    ? 'blocked'
    : provisional
      ? 'provisional'
      : 'accepted'

  return {
    project_id: input.project_id,
    level: input.level,
    audits,
    missing_audit_kinds: missing,
    overall_assurance: overall,
    submission_ready: input.level === 'submission' && overall === 'accepted',
  }
}
