import { describe, expect, it } from 'vitest'
import {
  ReverseOutline,
  ReviewFinding,
  type ReverseOutline as ReverseOutlineValue,
  type ReviewFinding as ReviewFindingValue,
} from '../../packages/research-schemas/src/knowledge-methodology.js'
import {
  assessWritingMethodology,
  writingClaimEvidenceSha256,
  writingTexSha256,
} from '../../packages/research-kernel/src/writing-methodology.js'

const hash = (character: string) => `sha256:${character.repeat(64)}`
const currentInput = {
  project_id: 'rsp_writing',
  document_id: 'doc_paper',
  document_revision: 12,
  tex_sha256: hash('a'),
  claim_evidence_sha256: hash('b'),
} as const

function outline(overrides: Partial<ReverseOutlineValue> = {}): ReverseOutlineValue {
  return ReverseOutline.parse({
    outline_id: 'outline_method_12',
    input_pin: currentInput,
    section_ref: 'sec_method',
    section_thesis: 'The controlled method addresses the stated problem.',
    paragraphs: [{
      paragraph_ref: 'p_method_1',
      role: 'method',
      message: 'The method is evaluated using the frozen protocol.',
      claim_refs: ['claim_method'],
      evidence_refs: ['evidence_method'],
      relation_to_thesis: 'supports',
    }],
    issues: [],
    status: 'diagnostic',
    created_at: '2026-08-20T00:00:00.000Z',
    ...overrides,
  })
}

function finding(overrides: Partial<ReviewFindingValue> = {}): ReviewFindingValue {
  return ReviewFinding.parse({
    finding_id: 'finding_method_12',
    input_pin: currentInput,
    kind: 'claim-evidence',
    severity: 'info',
    message: 'The claim is linked to accepted evidence.',
    paragraph_ref: 'p_method_1',
    claim_ref: 'claim_method',
    evidence_refs: ['evidence_method'],
    resolution_status: 'open',
    status: 'diagnostic',
    created_at: '2026-08-20T00:00:01.000Z',
    ...overrides,
  })
}

describe('revision-bound writing methodology', () => {
  it('canonicalizes TeX and Claim-Evidence hashes independent of row order', () => {
    expect(writingTexSha256([
      { path: 'paper.tex', content_hash: 'hash-paper' },
      { path: 'main.bib', content_hash: 'hash-bib' },
    ])).toBe(writingTexSha256([
      { path: 'main.bib', content_hash: 'hash-bib' },
      { path: 'paper.tex', content_hash: 'hash-paper' },
    ]))
    expect(writingClaimEvidenceSha256([
      { claim_ref: 'claim_b', accepted_evidence_refs: ['evidence_2'] },
      { claim_ref: 'claim_a', accepted_evidence_refs: ['evidence_1', 'evidence_1'] },
    ])).toBe(writingClaimEvidenceSha256([
      { claim_ref: 'claim_a', accepted_evidence_refs: ['evidence_1'] },
      { claim_ref: 'claim_b', accepted_evidence_refs: ['evidence_2'] },
    ]))
  })

  it('keeps a current ReverseOutline and finding usable when every claim has accepted evidence', () => {
    const report = assessWritingMethodology({
      project_id: 'rsp_writing',
      current_input: currentInput,
      outline: outline(),
      findings: [finding()],
      claim_evidence: [{ claim_ref: 'claim_method', accepted_evidence_refs: ['evidence_method'] }],
    })

    expect(report.outline).toEqual({ status: 'fresh', reasons: [] })
    expect(report.findings).toEqual([{ finding_id: 'finding_method_12', status: 'fresh', reasons: [] }])
    expect(report.claim_evidence_gaps).toEqual([])
    expect(report).toMatchObject({
      can_apply_review: true,
      claim_evidence_complete: true,
      assurance_blocking: false,
    })
  })

  it('marks both ReverseOutline and ReviewFinding stale after TeX revision or input hash changes', () => {
    const report = assessWritingMethodology({
      project_id: 'rsp_writing',
      current_input: {
        ...currentInput,
        document_revision: 13,
        tex_sha256: hash('c'),
        claim_evidence_sha256: hash('d'),
      },
      outline: outline(),
      findings: [finding()],
      claim_evidence: [{ claim_ref: 'claim_method', accepted_evidence_refs: ['evidence_method'] }],
    })

    const reasons = [
      'document_revision_changed',
      'tex_hash_changed',
      'claim_evidence_hash_changed',
    ]
    expect(report.outline).toEqual({ status: 'stale', reasons })
    expect(report.findings[0]).toEqual({
      finding_id: 'finding_method_12',
      status: 'stale',
      reasons,
    })
    expect(report.can_apply_review).toBe(false)
    expect(report.assurance_blocking).toBe(true)
  })

  it('reports claim-evidence gaps without inventing bindings or accepted Evidence', () => {
    const diagnostic = outline({
      paragraphs: [
        {
          paragraph_ref: 'p_missing_claim',
          role: 'method',
          message: 'Claim has no ledger binding.',
          claim_refs: ['claim_missing'],
          evidence_refs: [],
          relation_to_thesis: 'supports',
        },
        {
          paragraph_ref: 'p_empty_evidence',
          role: 'result',
          message: 'Claim exists but has no accepted Evidence.',
          claim_refs: ['claim_empty'],
          evidence_refs: [],
          relation_to_thesis: 'supports',
        },
        {
          paragraph_ref: 'p_wrong_evidence',
          role: 'result',
          message: 'Paragraph cites a non-accepted Artifact.',
          claim_refs: ['claim_bound'],
          evidence_refs: ['artifact_draft'],
          relation_to_thesis: 'supports',
        },
      ],
    })
    const bindings = [
      { claim_ref: 'claim_empty', accepted_evidence_refs: [] },
      { claim_ref: 'claim_bound', accepted_evidence_refs: ['evidence_accepted'] },
    ]
    const report = assessWritingMethodology({
      project_id: 'rsp_writing',
      current_input: currentInput,
      outline: diagnostic,
      findings: [],
      claim_evidence: bindings,
    })

    expect(report.claim_evidence_gaps).toEqual([
      {
        paragraph_ref: 'p_missing_claim',
        claim_ref: 'claim_missing',
        reason: 'missing_claim_binding',
      },
      {
        paragraph_ref: 'p_empty_evidence',
        claim_ref: 'claim_empty',
        reason: 'missing_accepted_evidence',
      },
      {
        paragraph_ref: 'p_wrong_evidence',
        claim_ref: 'claim_bound',
        reason: 'outline_evidence_not_accepted',
      },
    ])
    expect(report).toMatchObject({ claim_evidence_complete: false, assurance_blocking: true })
    expect(bindings).toEqual([
      { claim_ref: 'claim_empty', accepted_evidence_refs: [] },
      { claim_ref: 'claim_bound', accepted_evidence_refs: ['evidence_accepted'] },
    ])
  })

  it('keeps blocking reviewer findings diagnostic while exposing assurance blocking', () => {
    const report = assessWritingMethodology({
      project_id: 'rsp_writing',
      current_input: currentInput,
      outline: outline(),
      findings: [finding({
        severity: 'blocking',
        message: 'The current conclusion overstates the accepted Evidence.',
      })],
      claim_evidence: [{ claim_ref: 'claim_method', accepted_evidence_refs: ['evidence_method'] }],
    })
    expect(report).toMatchObject({
      can_apply_review: true,
      claim_evidence_complete: true,
      assurance_blocking: true,
    })
  })

  it('fails closed on unknown fields, invalid claim findings and cross-project diagnostics', () => {
    expect(() => ReverseOutline.parse({ ...outline(), extra_authority: 'write-tex' })).toThrow()
    expect(() => ReviewFinding.parse({ ...finding(), claim_ref: undefined })).toThrow()
    expect(() => assessWritingMethodology({
      project_id: 'rsp_other',
      current_input: currentInput,
      outline: outline(),
      findings: [finding()],
      claim_evidence: [],
    })).toThrow()
  })
})
