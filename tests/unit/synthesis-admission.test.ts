import { describe, expect, it } from 'vitest'
import { NextAction, ResearchSynthesis, SynthesisRecordRequest } from '@dsh-scholar/research-schemas'
import { assertSynthesisRequestAdmission, SynthesisAdmissionError } from '@dsh-scholar/research-kernel'

const NOW = '2026-08-20T12:00:00.000Z'
const HASH = `sha256:${'a'.repeat(64)}` as const

function request() {
  return SynthesisRecordRequest.parse({
    request_id: 'synthesis_request_authority_1', project_id: 'rsp_synthesis', trigger_run_ref: 'run_2',
    source_run_refs: ['run_1', 'run_2'], reasons: ['valid_cycle_threshold'],
    window: { from_event_seq: 10, to_event_seq: 20 },
    snapshot_pin: { project_revision: 3, next_action_revision: 3 }, requested_at: NOW,
  })
}

function synthesis() {
  return ResearchSynthesis.parse({
    synthesis_id: 'synth_authority_1', project_id: 'rsp_synthesis',
    window: { from_event_seq: 10, to_event_seq: 20 },
    snapshot_pin: { project_revision: 3, next_action_revision: 3 },
    inputs: { accepted_evidence_refs: [], verified_evidence_refs: [], run_refs: ['run_2', 'run_1'], corpus_snapshot_refs: [] },
    findings: { supported: [], contradicted: [], negative: [], inconclusive: [], infrastructure_failures: [] },
    patterns: [], open_questions: [], constraints_learned: [], artifact_body_ref: 'artifact:synthesis',
    direction_proposal_id: null, confidence: 'medium', generated_by: 'agent', input_hash: HASH,
    status: 'draft', adoption_ref: null, created_at: NOW,
  })
}

function action() {
  return NextAction.parse({
    id: 'synthesis_record:rsp_synthesis', code: 'synthesis_record', label: 'Record synthesis', reason: 'pending',
    route: 'chat', state: 'ready', required: true, required_by: 'agent', revision: 3,
    refs: [{ kind: 'synthesis_request', id: 'synthesis_request_authority_1' }], blocking: true,
  })
}

describe('synthesis request authority admission', () => {
  it('accepts only the exact pending request and source-run set', () => {
    expect(assertSynthesisRequestAdmission({
      request_id: request().request_id, record: synthesis(), pending_requests: [request()],
      current_project_revision: 3, current_actions: [action()],
    })).toEqual(request())
  })

  it('rejects stale Project or NextAction pins', () => {
    for (const overrides of [
      { current_project_revision: 4, current_actions: [action()] },
      { current_project_revision: 3, current_actions: [{ ...action(), revision: 4 }] },
      { current_project_revision: 3, current_actions: [] },
    ]) {
      expect(() => assertSynthesisRequestAdmission({
        request_id: request().request_id, record: synthesis(), pending_requests: [request()], ...overrides,
      })).toThrowError(expect.objectContaining<Partial<SynthesisAdmissionError>>({
        code: 'synthesis_request_binding_mismatch',
      }))
    }
  })

  it('rejects unknown, stale-window and substituted-source requests', () => {
    expect(() => assertSynthesisRequestAdmission({
      request_id: 'synthesis_request_unknown', record: synthesis(), pending_requests: [request()],
      current_project_revision: 3, current_actions: [action()],
    })).toThrowError(expect.objectContaining<Partial<SynthesisAdmissionError>>({ code: 'synthesis_request_not_pending' }))
    for (const record of [
      { ...synthesis(), window: { from_event_seq: 11, to_event_seq: 20 } },
      { ...synthesis(), inputs: { ...synthesis().inputs, run_refs: ['run_2', 'run_other'] } },
    ]) {
      expect(() => assertSynthesisRequestAdmission({
        request_id: request().request_id, record, pending_requests: [request()],
        current_project_revision: 3, current_actions: [action()],
      })).toThrowError(expect.objectContaining<Partial<SynthesisAdmissionError>>({
        code: 'synthesis_request_binding_mismatch',
      }))
    }
  })
})
