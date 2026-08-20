import { describe, expect, it } from 'vitest'
import {
  MethodTriad,
  SectionGuideActivation,
  WritingReviewerPanelAggregate,
  type AssuranceSemanticReviewReceipt,
  type WritingInputPin,
} from '@dsh-scholar/research-schemas'
import {
  activateSectionGuide,
  aggregateWritingReviewerPanel,
  assessMethodTriad,
  writingFileSha256,
} from '@dsh-scholar/research-kernel'

const hash = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`
const pin: WritingInputPin = {
  project_id: 'rsp_writing_review',
  document_id: 'doc_paper',
  document_revision: 4,
  tex_sha256: hash('a'),
  claim_evidence_sha256: hash('b'),
}

describe('strict writing methodology contracts', () => {
  it('reports a typed MethodTriad gap instead of inventing measurable support', () => {
    const triad = MethodTriad.parse({
      triad_id: 'triad_method_4',
      input_pin: pin,
      motivation: 'Existing methods miss the controlled failure mode.',
      design: 'The method isolates the relevant mechanism.',
      technical_advantage: {
        statement: 'The method improves the primary metric.',
        measurable_evidence_refs: ['evidence_not_accepted'],
      },
      status: 'diagnostic',
      created_at: '2026-08-20T00:00:00.000Z',
    })

    expect(assessMethodTriad(triad, [])).toEqual({
      triad_id: 'triad_method_4',
      input_pin: pin,
      status: 'diagnostic_gap',
      gaps: [{
        code: 'technical_advantage_measurable_evidence_missing',
        missing_evidence_refs: ['evidence_not_accepted'],
      }],
    })
    expect(assessMethodTriad(triad, ['evidence_not_accepted']).status).toBe('ready')
  })

  it('activates only a Scholar-native SectionGuide whose required facts are present', () => {
    const active = activateSectionGuide({
      activation_id: 'section_guide_method_4',
      input_pin: pin,
      section: 'method',
      available_inputs: ['research_problem', 'method_triad', 'protocol', 'accepted_evidence'],
      created_at: '2026-08-20T00:00:00.000Z',
    })
    expect(SectionGuideActivation.parse(active)).toMatchObject({
      guide_id: 'scholar-native.method.v1',
      channel: 'instruction',
      state: 'active',
      missing_inputs: [],
    })

    const diagnostic = activateSectionGuide({
      activation_id: 'section_guide_experiments_4',
      input_pin: pin,
      section: 'experiments',
      available_inputs: ['research_problem', 'protocol'],
      created_at: '2026-08-20T00:00:00.000Z',
    })
    expect(diagnostic).toMatchObject({
      state: 'diagnostic_gap',
      missing_inputs: ['accepted_evidence', 'analysis'],
    })
  })

  it('aggregates exactly four reviewer roles and exposes partial/missing roles', () => {
    const semanticReview: AssuranceSemanticReviewReceipt = {
      panel_id: 'panel_writing_4',
      project_id: pin.project_id,
      session_id: 'session_writing',
      project_revision: 9,
      action_id: 'reviewer_run:9',
      action_revision: 9,
      panel_hash: hash('c'),
      input_hash: hash('d'),
      state: 'partial',
      reviewers: [{
        reviewer_role: 'claim-evidence',
        child_id: 'child_claim',
        summary: 'One claim needs accepted Evidence.',
        notes: [],
        references: ['claim_1'],
        output_hash: hash('e'),
      }, {
        reviewer_role: 'citation',
        child_id: 'child_citation',
        summary: 'Citation coverage is current.',
        notes: [],
        references: [],
        output_hash: hash('f'),
      }],
      failures: ['statistics: unavailable', 'reproducibility: unavailable'],
      independence: 'same-family',
    }

    const aggregate = aggregateWritingReviewerPanel({
      aggregate_id: 'review_panel_4',
      input_pin: pin,
      semantic_review: semanticReview,
      created_at: '2026-08-20T00:00:00.000Z',
    })
    expect(WritingReviewerPanelAggregate.parse(aggregate)).toMatchObject({
      state: 'partial',
      roles: [
        { role: 'claim-evidence', state: 'complete', child_id: 'child_claim' },
        { role: 'citation', state: 'complete', child_id: 'child_citation' },
        { role: 'statistics', state: 'missing', child_id: null },
        { role: 'reproducibility', state: 'missing', child_id: null },
      ],
    })
  })

  it('rejects duplicate role authority and keeps file hashes deterministic', () => {
    expect(writingFileSha256('A\n')).toBe(writingFileSha256('A\n'))
    expect(writingFileSha256('A\n')).not.toBe(writingFileSha256('B\n'))
    const invalid = {
      panel_id: 'panel_duplicate', project_id: pin.project_id, session_id: 'session_writing',
      project_revision: 9, action_id: 'reviewer_run:9', action_revision: 9,
      panel_hash: hash('c'), input_hash: hash('d'), state: 'complete', failures: [], independence: 'same-family',
      reviewers: ['child_1', 'child_2', 'child_3', 'child_4'].map(child_id => ({
        reviewer_role: 'claim-evidence', child_id, summary: 'review', notes: [], references: [], output_hash: hash('e'),
      })),
    }
    expect(() => aggregateWritingReviewerPanel({
      aggregate_id: 'review_panel_duplicate', input_pin: pin,
      semantic_review: invalid as AssuranceSemanticReviewReceipt,
      created_at: '2026-08-20T00:00:00.000Z',
    })).toThrow(/duplicate|role/i)
  })
})
