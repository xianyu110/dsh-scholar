import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ClaimEvidenceBinding,
  DirectionAdoption,
  DirectionProposal,
  KnowledgeActivationRequest,
  KnowledgePackageEvaluation,
  KnowledgePackageRecord,
  ProtocolRevision,
  ReviewFinding,
  ReverseOutline,
  ResearchSynthesis,
  WritingInputPin,
  type ClaimEvidenceBinding as ClaimEvidenceBindingValue,
  type DirectionAdoption as DirectionAdoptionValue,
  type DirectionProposal as DirectionProposalValue,
  type KnowledgeActivationRequest as KnowledgeActivationRequestValue,
  type KnowledgePackageEvaluation as KnowledgePackageEvaluationValue,
  type KnowledgePackageRecord as KnowledgePackageRecordValue,
  type ProtocolRevision as ProtocolRevisionValue,
  type ReviewFinding as ReviewFindingValue,
  type ReverseOutline as ReverseOutlineValue,
  type ResearchSynthesis as ResearchSynthesisValue,
  type WritingInputPin as WritingInputPinValue,
} from '@dsh-scholar/research-schemas'
import {
  MethodologyStore,
  MethodologyStoreError,
  protocolRevisionCanonicalHash,
} from '../../packages/research-kernel/src/methodology-store.js'

const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`
const CREATED_AT = '2026-08-20T02:00:00.000Z'

function protocol(overrides: Partial<ProtocolRevisionValue> = {}): ProtocolRevisionValue {
  const record = ProtocolRevision.parse({
    protocol_id: 'protocol_cnn_1',
    project_id: 'project_a',
    revision: 1,
    supersedes: null,
    status: 'frozen',
    intent: 'confirmatory',
    research_question_ref: 'question:cnn',
    target_claim_ref: 'claim:cnn',
    hypothesis: 'A compact CNN classifies the fixed corpus better than the baseline.',
    prediction: 'Primary accuracy exceeds the pinned baseline by at least two points.',
    variables: {
      manipulated: ['architecture'],
      controlled: ['dataset split', 'optimizer'],
      measured: ['accuracy'],
    },
    metrics: {
      primary: 'accuracy',
      secondary: ['loss'],
      baseline_ref: 'baseline:cnn:v1',
      analysis_plan_artifact_id: 'artifact_analysis_plan',
    },
    pins: {
      contract: { ref: 'contract:cnn:1', sha256: HASH_A },
      code: { ref: 'code:cnn:1', sha256: HASH_A },
      data: { ref: 'data:mnist:1', sha256: HASH_A },
      environment: { ref: 'environment:cuda:1', sha256: HASH_A },
    },
    stopping_conditions: ['Complete three seeded runs.'],
    failure_criteria: ['Any pinned input is unavailable.'],
    allowed_deviations: [],
    deviation_handling: 'Create a new protocol revision before another run.',
    author_principal_id: 'principal_pi',
    created_at: CREATED_AT,
    frozen_at: CREATED_AT,
    canonical_hash: HASH_A,
    ...overrides,
  })
  return overrides.canonical_hash === undefined
    ? { ...record, canonical_hash: protocolRevisionCanonicalHash(record) }
    : record
}

const BASIS = {
  provenance: 'explicit' as const,
  statement: 'The accepted evidence supports continuing the bounded comparison.',
  source_refs: [{ kind: 'evidence' as const, id: 'evidence_accuracy', sha256: HASH_A }],
}

function synthesis(overrides: Partial<ResearchSynthesisValue> = {}): ResearchSynthesisValue {
  return ResearchSynthesis.parse({
    synthesis_id: 'synth_cnn_1',
    project_id: 'project_a',
    window: { from_event_seq: 1, to_event_seq: 8 },
    snapshot_pin: { project_revision: 4, next_action_revision: 2 },
    inputs: {
      accepted_evidence_refs: ['evidence_accuracy'],
      verified_evidence_refs: ['evidence_accuracy'],
      run_refs: ['run_cnn_1'],
      corpus_snapshot_refs: ['corpus_cnn_1'],
    },
    findings: {
      supported: [BASIS],
      contradicted: [],
      negative: [],
      inconclusive: [],
      infrastructure_failures: [],
    },
    patterns: [],
    open_questions: [],
    constraints_learned: [],
    artifact_body_ref: 'artifact_synthesis_cnn_1',
    direction_proposal_id: 'direction_cnn_1',
    confidence: 'medium',
    generated_by: 'human',
    input_hash: HASH_A,
    status: 'reviewed',
    adoption_ref: null,
    created_at: CREATED_AT,
    ...overrides,
  })
}

function proposal(overrides: Partial<DirectionProposalValue> = {}): DirectionProposalValue {
  return DirectionProposal.parse({
    proposal_id: 'direction_cnn_1',
    project_id: 'project_a',
    synthesis_id: 'synth_cnn_1',
    direction: 'deepen',
    rationale_artifact_id: 'artifact_direction_cnn_1',
    basis: [BASIS],
    snapshot_pin: { project_revision: 4, next_action_revision: 2 },
    input_hash: HASH_A,
    status: 'proposed',
    created_at: CREATED_AT,
    ...overrides,
  })
}

function adoption(overrides: Partial<DirectionAdoptionValue> = {}): DirectionAdoptionValue {
  return DirectionAdoption.parse({
    adoption_id: 'adoption_cnn_1',
    proposal_id: 'direction_cnn_1',
    project_id: 'project_a',
    decision: 'adopted',
    actor: { kind: 'human', ref: 'principal_pi' },
    gate_decision_ref: null,
    created_at: CREATED_AT,
    ...overrides,
  })
}

function knowledgePackage(
  overrides: Partial<KnowledgePackageRecordValue> = {},
): KnowledgePackageRecordValue {
  return KnowledgePackageRecord.parse({
    manifest: {
      schema_version: 1,
      name: 'scholar.claim-review',
      version: '1.0.0',
      channel: 'instruction',
      source: {
        transport: 'local',
        origin: 'scholar-native',
        path: 'skills/claim-review',
        revision: 'a'.repeat(40),
      },
      payload_sha256: HASH_A,
      license: {
        status: 'SCHOLAR_OWNED',
        spdx: 'MIT',
        evidence_sha256: HASH_A,
        attribution_refs: [],
      },
      requested_capabilities: [
        'project:read-accepted-evidence',
        'proposal:review-finding',
      ],
      input_schema_id: 'scholar.claim-review.input.v1',
      output_schema_id: 'scholar.claim-review.output.v1',
      side_effect: 'proposal-only',
    },
    manifest_sha256: HASH_B,
    ...overrides,
  })
}

function evaluation(
  overrides: Partial<KnowledgePackageEvaluationValue> = {},
): KnowledgePackageEvaluationValue {
  return KnowledgePackageEvaluation.parse({
    package_name: 'scholar.claim-review',
    package_version: '1.0.0',
    manifest_sha256: HASH_B,
    payload_sha256: HASH_A,
    verdict: 'approved',
    granted_capabilities: [
      'project:read-accepted-evidence',
      'proposal:review-finding',
    ],
    ...overrides,
  })
}

function activationRequest(
  overrides: Partial<KnowledgeActivationRequestValue> = {},
): KnowledgeActivationRequestValue {
  return KnowledgeActivationRequest.parse({
    project_id: 'project_a',
    session_id: 'session_cnn',
    package_name: 'scholar.claim-review',
    package_version: '1.0.0',
    manifest_sha256: HASH_B,
    payload_sha256: HASH_A,
    phase: 'WRITING',
    next_action_revision: 2,
    explicit_human_activation: true,
    principal_capabilities: [
      'project:read-accepted-evidence',
      'proposal:review-finding',
    ],
    next_action_capabilities: [
      'project:read-accepted-evidence',
      'proposal:review-finding',
    ],
    project_policy_capabilities: [
      'project:read-accepted-evidence',
      'proposal:review-finding',
    ],
    ...overrides,
  })
}

function writingPin(overrides: Partial<WritingInputPinValue> = {}): WritingInputPinValue {
  return WritingInputPin.parse({
    project_id: 'project_a',
    document_id: 'paper_cnn',
    document_revision: 3,
    tex_sha256: HASH_A,
    claim_evidence_sha256: HASH_A,
    ...overrides,
  })
}

function reverseOutline(overrides: Partial<ReverseOutlineValue> = {}): ReverseOutlineValue {
  return ReverseOutline.parse({
    outline_id: 'outline_cnn_1',
    input_pin: writingPin(),
    section_ref: 'section:results',
    section_thesis: 'The bounded comparison establishes the result without overstating scope.',
    paragraphs: [{
      paragraph_ref: 'paragraph_results_1',
      role: 'result',
      message: 'Report the primary comparison and its uncertainty.',
      claim_refs: ['claim_cnn'],
      evidence_refs: ['evidence_accuracy'],
      relation_to_thesis: 'supports',
    }],
    issues: [],
    status: 'diagnostic',
    created_at: CREATED_AT,
    ...overrides,
  })
}

function reviewFinding(overrides: Partial<ReviewFindingValue> = {}): ReviewFindingValue {
  return ReviewFinding.parse({
    finding_id: 'finding_cnn_1',
    input_pin: writingPin(),
    kind: 'flow',
    severity: 'minor',
    message: 'State the uncertainty immediately after the primary result.',
    paragraph_ref: 'paragraph_results_1',
    evidence_refs: ['evidence_accuracy'],
    resolution_status: 'open',
    status: 'diagnostic',
    created_at: CREATED_AT,
    ...overrides,
  })
}

function claimEvidence(): ClaimEvidenceBindingValue {
  return ClaimEvidenceBinding.parse({
    claim_ref: 'claim_cnn',
    accepted_evidence_refs: ['evidence_accuracy'],
  })
}

function setup(): { db: DatabaseSync; store: MethodologyStore } {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE projects (project_id TEXT PRIMARY KEY);
    INSERT INTO projects (project_id) VALUES ('project_a'), ('project_b');
  `)
  return {
    db,
    store: new MethodologyStore(db, () => CREATED_AT),
  }
}

function expectStoreError(fn: () => unknown, status: number, code: string): void {
  try {
    fn()
    throw new Error('expected MethodologyStoreError')
  } catch (error) {
    expect(error).toBeInstanceOf(MethodologyStoreError)
    expect(error).toMatchObject({ status, code })
  }
}

describe('MethodologyStore', () => {
  it('records strict immutable Protocol revisions behind project CAS and fail-closed reads', () => {
    const { db, store } = setup()
    try {
      const recorded = store.recordProtocolRevision({
        record: protocol(),
        expected_revision: 0,
      })
      expect(recorded).toMatchObject({
        project_id: 'project_a',
        stream_revision: 1,
        recorded_revision: 1,
        record: { protocol_id: 'protocol_cnn_1', revision: 1 },
      })
      expect(store.getProtocolRevision('project_a', 'protocol_cnn_1')).toEqual(recorded)
      expect(store.listProtocolRevisions('project_a')).toEqual({
        project_id: 'project_a',
        stream_revision: 1,
        records: [recorded],
      })

      expectStoreError(
        () => {
          const signed = protocol({ protocol_id: 'protocol_tampered_1' })
          return store.recordProtocolRevision({
            record: { ...signed, hypothesis: 'Caller changed the hypothesis after hashing.' },
            expected_revision: 1,
          })
        },
        422,
        'methodology_protocol_hash_mismatch',
      )

      expectStoreError(
        () => store.recordProtocolRevision({
          record: protocol({ protocol_id: 'protocol_other_1' }),
          expected_revision: 0,
        }),
        409,
        'methodology_revision_conflict',
      )
      expect(() => store.recordProtocolRevision({
        record: { ...protocol({ protocol_id: 'protocol_invalid_1' }), extra_authority: true } as ProtocolRevisionValue,
        expected_revision: 1,
      })).toThrow()
      expect(store.projectRevision('project_a')).toBe(1)

      expectStoreError(
        () => store.getProtocolRevision('project_b', 'protocol_cnn_1'),
        404,
        'methodology_protocol_not_found',
      )
      expect(() => db.prepare(
        "UPDATE methodology_project_events SET record_id = 'protocol_tampered' WHERE project_id = 'project_a'",
      ).run()).toThrow(/methodology_project_events_append_only/)
      expect(() => db.prepare(
        "DELETE FROM methodology_project_events WHERE project_id = 'project_a'",
      ).run()).toThrow(/methodology_project_events_append_only/)
    } finally {
      db.close()
    }
  })

  it('persists synthesis, direction proposal and one adoption in one project-scoped stream', () => {
    const { db, store } = setup()
    try {
      const recordedSynthesis = store.recordResearchSynthesis({
        record: synthesis(),
        expected_revision: 0,
      })
      expect(recordedSynthesis).toMatchObject({
        stream_revision: 1,
        record: { synthesis_id: 'synth_cnn_1' },
      })

      expectStoreError(
        () => store.recordDirectionProposal({
          record: proposal({ project_id: 'project_b' }),
          expected_revision: 0,
        }),
        404,
        'methodology_synthesis_not_found',
      )
      expect(store.projectRevision('project_b')).toBe(0)

      const recordedProposal = store.recordDirectionProposal({
        record: proposal(),
        expected_revision: 1,
      })
      const recordedAdoption = store.recordDirectionAdoption({
        record: adoption(),
        expected_revision: 2,
      })
      expect(recordedProposal).toMatchObject({
        recorded_revision: 2,
        record: { proposal_id: 'direction_cnn_1', synthesis_id: 'synth_cnn_1' },
      })
      expect(recordedAdoption).toMatchObject({
        recorded_revision: 3,
        record: { adoption_id: 'adoption_cnn_1', proposal_id: 'direction_cnn_1' },
      })
      expect(store.getResearchSynthesis('project_a', 'synth_cnn_1').stream_revision).toBe(3)
      expect(store.getDirectionProposal('project_a', 'direction_cnn_1').stream_revision).toBe(3)
      expect(store.getDirectionAdoption('project_a', 'adoption_cnn_1')).toEqual(recordedAdoption)

      expectStoreError(
        () => store.recordDirectionAdoption({
          record: adoption({ adoption_id: 'adoption_cnn_2', decision: 'rejected' }),
          expected_revision: 3,
        }),
        409,
        'methodology_direction_already_adopted',
      )
      expectStoreError(
        () => store.getDirectionProposal('project_b', 'direction_cnn_1'),
        404,
        'methodology_direction_proposal_not_found',
      )
      expect(store.listResearchSyntheses('project_a').records).toHaveLength(1)
      expect(store.listDirectionProposals('project_a').records).toHaveLength(1)
      expect(store.listDirectionAdoptions('project_a').records).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('registers only strict local packs and persists only activations allowed by the pure resolver', () => {
    const { db, store } = setup()
    try {
      const registered = store.registerKnowledgePackage({
        record: knowledgePackage(),
        expected_revision: 0,
      })
      expect(registered).toMatchObject({
        registry_revision: 1,
        recorded_revision: 1,
        record: { manifest: { name: 'scholar.claim-review', source: { transport: 'local' } } },
      })

      const remoteRecord = {
        ...knowledgePackage(),
        manifest: {
          ...knowledgePackage().manifest,
          source: {
            transport: 'remote',
            origin: 'third-party',
            url: 'https://example.invalid/skill.md',
            revision: 'b'.repeat(40),
          },
        },
      } as unknown as KnowledgePackageRecordValue
      expect(() => store.registerKnowledgePackage({
        record: remoteRecord,
        expected_revision: 1,
      })).toThrow()
      expect(store.registryRevision()).toBe(1)

      const evaluated = store.recordKnowledgeEvaluation({
        record: evaluation(),
        expected_revision: 1,
      })
      expect(evaluated).toMatchObject({ registry_revision: 2, recorded_revision: 2 })

      expectStoreError(
        () => store.activateKnowledgePackage({
          request: activationRequest({ explicit_human_activation: false }),
          expected_revision: 0,
          expected_registry_revision: 2,
        }),
        422,
        'methodology_activation_denied',
      )
      expect(store.projectRevision('project_a')).toBe(0)

      const activated = store.activateKnowledgePackage({
        request: activationRequest(),
        expected_revision: 0,
        expected_registry_revision: 2,
      })
      expect(activated).toMatchObject({
        project_id: 'project_a',
        recorded_revision: 1,
        record: {
          registry_revision: 2,
          request: { package_name: 'scholar.claim-review' },
          resolution: {
            allowed: true,
            injection_mode: 'trusted-instruction-reference',
            effective_capabilities: [
              'project:read-accepted-evidence',
              'proposal:review-finding',
            ],
          },
        },
      })
      expect(store.getKnowledgeActivation(
        'project_a',
        activated.record.activation_id,
      )).toEqual(activated)
      expect(store.listKnowledgePackages()).toMatchObject({
        registry_revision: 2,
        records: [{
          registry_revision: 2,
          recorded_revision: 1,
          record: { manifest: { name: 'scholar.claim-review' } },
        }],
      })
      expect(store.listKnowledgeEvaluations()).toMatchObject({ registry_revision: 2, records: [evaluated] })
      expectStoreError(
        () => store.getKnowledgeActivation('project_b', activated.record.activation_id),
        404,
        'methodology_activation_not_found',
      )

      expect(() => db.prepare(
        "UPDATE methodology_registry_events SET package_version = '9.9.9' WHERE revision = 1",
      ).run()).toThrow(/methodology_registry_events_append_only/)
      expect(() => db.prepare(
        'DELETE FROM methodology_registry_events WHERE revision = 1',
      ).run()).toThrow(/methodology_registry_events_append_only/)
    } finally {
      db.close()
    }
  })

  it('persists writing diagnostics and delegates freshness and claim checks to the pure assessor', () => {
    const { db, store } = setup()
    try {
      const outline = store.recordReverseOutline({
        record: reverseOutline(),
        expected_revision: 0,
      })
      const finding = store.recordReviewFinding({
        record: reviewFinding(),
        expected_revision: 1,
      })
      expect(outline.recorded_revision).toBe(1)
      expect(finding.recorded_revision).toBe(2)

      expect(store.assessWriting({
        project_id: 'project_a',
        outline_id: 'outline_cnn_1',
        finding_ids: ['finding_cnn_1'],
        current_input: writingPin(),
        claim_evidence: [claimEvidence()],
      })).toMatchObject({
        revision: 2,
        project_id: 'project_a',
        outline: { status: 'fresh', reasons: [] },
        findings: [{ finding_id: 'finding_cnn_1', status: 'fresh' }],
        can_apply_review: true,
        claim_evidence_complete: true,
        assurance_blocking: false,
      })

      expect(store.assessWriting({
        project_id: 'project_a',
        outline_id: 'outline_cnn_1',
        current_input: writingPin({ document_revision: 4, tex_sha256: HASH_B }),
        claim_evidence: [claimEvidence()],
      })).toMatchObject({
        revision: 2,
        outline: {
          status: 'stale',
          reasons: ['document_revision_changed', 'tex_hash_changed'],
        },
        findings: [{ status: 'stale' }],
        can_apply_review: false,
        assurance_blocking: true,
      })
      expect(store.getReverseOutline('project_a', 'outline_cnn_1').stream_revision).toBe(2)
      expect(store.getReviewFinding('project_a', 'finding_cnn_1').stream_revision).toBe(2)
      expectStoreError(
        () => store.getReviewFinding('project_b', 'finding_cnn_1'),
        404,
        'methodology_review_finding_not_found',
      )
    } finally {
      db.close()
    }
  })

  it('recovers every methodology and registry record after idempotent DDL and database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-methodology-store-'))
    const databasePath = join(directory, 'kernel.sqlite')
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(databasePath)
      db.exec('PRAGMA foreign_keys = ON')
      db.exec(`
        CREATE TABLE projects (project_id TEXT PRIMARY KEY);
        INSERT INTO projects (project_id) VALUES ('project_a'), ('project_b');
      `)
      let store = new MethodologyStore(db, () => CREATED_AT)
      store.recordProtocolRevision({ record: protocol(), expected_revision: 0 })
      store.recordResearchSynthesis({ record: synthesis(), expected_revision: 1 })
      store.recordDirectionProposal({ record: proposal(), expected_revision: 2 })
      store.recordDirectionAdoption({ record: adoption(), expected_revision: 3 })
      store.registerKnowledgePackage({ record: knowledgePackage(), expected_revision: 0 })
      store.recordKnowledgeEvaluation({ record: evaluation(), expected_revision: 1 })
      const activation = store.activateKnowledgePackage({
        request: activationRequest(),
        expected_revision: 4,
        expected_registry_revision: 2,
      })
      store.recordReverseOutline({ record: reverseOutline(), expected_revision: 5 })
      store.recordReviewFinding({ record: reviewFinding(), expected_revision: 6 })
      const activationId = activation.record.activation_id
      db.close()
      db = undefined

      db = new DatabaseSync(databasePath)
      db.exec('PRAGMA foreign_keys = ON')
      store = new MethodologyStore(db, () => '2026-08-20T03:00:00.000Z')
      expect(store.projectRevision('project_a')).toBe(7)
      expect(store.registryRevision()).toBe(2)
      expect(store.listProtocolRevisions('project_a').records).toHaveLength(1)
      expect(store.listResearchSyntheses('project_a').records).toHaveLength(1)
      expect(store.listDirectionProposals('project_a').records).toHaveLength(1)
      expect(store.listDirectionAdoptions('project_a').records).toHaveLength(1)
      expect(store.listKnowledgePackages().records).toHaveLength(1)
      expect(store.listKnowledgeEvaluations().records).toHaveLength(1)
      expect(store.getKnowledgeActivation('project_a', activationId).record.activated_at).toBe(CREATED_AT)
      expect(store.listReverseOutlines('project_a').records).toHaveLength(1)
      expect(store.listReviewFindings('project_a').records).toHaveLength(1)
      expect(store.assessWriting({
        project_id: 'project_a',
        outline_id: 'outline_cnn_1',
        current_input: writingPin(),
        claim_evidence: [claimEvidence()],
      })).toMatchObject({ revision: 7, can_apply_review: true, assurance_blocking: false })
    } finally {
      db?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
