import { describe, expect, it } from 'vitest'
import {
  AssuranceAudit,
  AssuranceVerificationInput,
  type AssuranceAudit as AssuranceAuditValue,
} from '@dsh-scholar/research-schemas'
import { verifyAssurance } from '@dsh-scholar/research-kernel'

const now = '2026-08-20T00:00:00.000Z'
const inputHash = `sha256:${'a'.repeat(64)}`

function audit(overrides: Partial<AssuranceAuditValue> = {}): AssuranceAuditValue {
  return AssuranceAudit.parse({
    audit_id: 'audit_claim_evidence',
    project_id: 'rsp_assurance',
    audit_kind: 'claim-evidence',
    target_refs: [{ kind: 'claim', id: 'claim_one', revision: 1 }],
    assurance_level: 'submission',
    execution: { status: 'succeeded', run_ref: 'run_audit_one' },
    verdict: 'PASS',
    reason_code: 'claim_supported',
    findings_artifact_id: 'art_findings_one',
    input_pins: [{ ref: 'claim:claim_one', sha256: inputHash }],
    review: {
      method: 'semantic',
      independence: 'cross-family',
      executor_ref: 'model_executor',
      reviewer_ref: 'model_reviewer',
    },
    acceptance_status: 'accepted',
    created_at: now,
    ...overrides,
  })
}

function verify(audits: AssuranceAuditValue[], required = ['claim-evidence'] as const) {
  return verifyAssurance({
    project_id: 'rsp_assurance',
    level: 'submission',
    audits,
    required_audit_kinds: [...required],
    current_input_hashes: { 'claim:claim_one': inputHash },
  })
}

describe('Assurance core', () => {
  it('keeps execution, verdict and acceptance separate', () => {
    const report = verify([audit({ verdict: 'FAIL', reason_code: 'unsupported_claim' })])
    expect(report.audits[0]).toMatchObject({
      execution_status: 'succeeded',
      verdict: 'FAIL',
      effective_acceptance_status: 'rejected',
      blocking: true,
      reasons: ['verdict_blocking'],
    })
    expect(report).toMatchObject({ overall_assurance: 'blocked', submission_ready: false })
  })

  it('distinguishes a fresh NOT_APPLICABLE audit from a missing mandatory audit', () => {
    const notApplicable = verify([
      audit({ verdict: 'NOT_APPLICABLE', reason_code: 'no_citations', acceptance_status: 'accepted' }),
    ])
    expect(notApplicable.missing_audit_kinds).toEqual([])
    expect(notApplicable.submission_ready).toBe(true)

    const missing = verify([])
    expect(missing.missing_audit_kinds).toEqual(['claim-evidence'])
    expect(missing).toMatchObject({ overall_assurance: 'blocked', submission_ready: false })
  })

  it('marks an audit stale when a pinned input is missing or changed without mutating history', () => {
    const original = audit()
    const changed = verifyAssurance({
      project_id: 'rsp_assurance',
      level: 'submission',
      audits: [original],
      required_audit_kinds: ['claim-evidence'],
      current_input_hashes: { 'claim:claim_one': `sha256:${'b'.repeat(64)}` },
    })
    expect(changed.audits[0]).toMatchObject({
      effective_acceptance_status: 'stale',
      reasons: ['input_hash_mismatch'],
    })
    expect(original.acceptance_status).toBe('accepted')

    const missing = verifyAssurance({
      project_id: 'rsp_assurance',
      level: 'submission',
      audits: [original],
      required_audit_kinds: ['claim-evidence'],
      current_input_hashes: {},
    })
    expect(missing.audits[0].reasons).toEqual(['input_missing'])
  })

  it('limits same-model and same-family semantic review to provisional', () => {
    for (const independence of ['same-model', 'same-family'] as const) {
      const report = verify([audit({ review: { method: 'semantic', independence } })])
      expect(report.audits[0]).toMatchObject({
        effective_acceptance_status: 'provisional',
        blocking: false,
        reasons: ['semantic_independence_insufficient'],
      })
      expect(report).toMatchObject({ overall_assurance: 'provisional', submission_ready: false })
    }
  })

  it('rejects a semantic audit that claims deterministic independence', () => {
    const report = verify([audit({ review: { method: 'semantic', independence: 'deterministic' } })])
    expect(report.audits[0]).toMatchObject({
      effective_acceptance_status: 'rejected',
      blocking: true,
      reasons: ['review_method_independence_mismatch'],
    })
  })

  it('accepts a complete cross-family semantic and deterministic submission', () => {
    const releaseHash = `sha256:${'c'.repeat(64)}`
    const report = verifyAssurance({
      project_id: 'rsp_assurance',
      level: 'submission',
      audits: [
        audit(),
        audit({
          audit_id: 'audit_release_integrity',
          audit_kind: 'release-integrity',
          target_refs: [{ kind: 'release-bundle', id: 'bundle_one' }],
          reason_code: 'bundle_verified',
          findings_artifact_id: 'art_release_findings',
          input_pins: [{ ref: 'bundle:bundle_one', sha256: releaseHash }],
          review: { method: 'deterministic', independence: 'deterministic' },
        }),
      ],
      required_audit_kinds: ['claim-evidence', 'release-integrity'],
      current_input_hashes: {
        'claim:claim_one': inputHash,
        'bundle:bundle_one': releaseHash,
      },
    })
    expect(report.missing_audit_kinds).toEqual([])
    expect(report).toMatchObject({ overall_assurance: 'accepted', submission_ready: true })
    expect(report.audits.every(item => item.effective_acceptance_status === 'accepted')).toBe(true)
  })

  it('fails closed on cross-project audits and duplicate required kinds', () => {
    expect(() => AssuranceVerificationInput.parse({
      project_id: 'rsp_assurance',
      level: 'submission',
      audits: [audit({ project_id: 'rsp_other' })],
      required_audit_kinds: ['claim-evidence'],
      current_input_hashes: { 'claim:claim_one': inputHash },
    })).toThrow()

    expect(() => AssuranceVerificationInput.parse({
      project_id: 'rsp_assurance',
      level: 'submission',
      audits: [audit()],
      required_audit_kinds: ['claim-evidence', 'claim-evidence'],
      current_input_hashes: { 'claim:claim_one': inputHash },
    })).toThrow()
  })

  it('uses strict schemas and rejects unknown fields or invalid hashes', () => {
    expect(() => AssuranceAudit.parse({ ...audit(), unexpected: true })).toThrow()
    expect(() => AssuranceAudit.parse({
      ...audit(),
      input_pins: [{ ref: 'claim:claim_one', sha256: 'sha256:not-a-hash' }],
    })).toThrow()
  })
})
