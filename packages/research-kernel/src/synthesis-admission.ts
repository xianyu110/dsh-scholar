/**
 * Authoritative admission for deterministic synthesis fan-in requests.
 *
 * Content remains Human/Agent authored, but the Kernel owns which request it
 * answers. This module binds that content to one live request, its exact
 * event window, Project/NextAction snapshot and classified Run set. It has no
 * persistence side effects, which keeps all zero-write failures testable.
 */
import type {
  NextAction,
  ResearchSynthesis,
  SynthesisRecordRequest,
} from '@dsh-scholar/research-schemas'

export class SynthesisAdmissionError extends Error {
  readonly code: 'synthesis_request_not_pending' | 'synthesis_request_binding_mismatch'

  constructor(code: SynthesisAdmissionError['code'], message: string) {
    super(message)
    this.name = 'SynthesisAdmissionError'
    this.code = code
  }
}

function sameWindow(
  left: { from_event_seq: number; to_event_seq: number },
  right: { from_event_seq: number; to_event_seq: number },
): boolean {
  return left.from_event_seq === right.from_event_seq && left.to_event_seq === right.to_event_seq
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (new Set(left).size !== left.length || new Set(right).size !== right.length) return false
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

export function assertSynthesisRequestAdmission(input: {
  request_id: string
  record: ResearchSynthesis
  pending_requests: readonly SynthesisRecordRequest[]
  current_project_revision: number
  current_actions: readonly NextAction[]
}): SynthesisRecordRequest {
  const request = input.pending_requests.find(candidate => candidate.request_id === input.request_id)
  if (request === undefined) {
    throw new SynthesisAdmissionError(
      'synthesis_request_not_pending',
      `synthesis request ${input.request_id} is not pending`,
    )
  }

  const action = input.current_actions.find(candidate => candidate.code === 'synthesis_record'
    && candidate.state === 'ready'
    && candidate.refs.some(ref => ref.kind === 'synthesis_request' && ref.id === request.request_id))
  const record = input.record
  const bound = record.project_id === request.project_id
    && sameWindow(record.window, request.window)
    && record.snapshot_pin.project_revision === request.snapshot_pin.project_revision
    && record.snapshot_pin.next_action_revision === request.snapshot_pin.next_action_revision
    && input.current_project_revision === request.snapshot_pin.project_revision
    && action?.revision === request.snapshot_pin.next_action_revision
    && sameStringSet(record.inputs.run_refs, request.source_run_refs)
  if (!bound) {
    throw new SynthesisAdmissionError(
      'synthesis_request_binding_mismatch',
      `synthesis ${record.synthesis_id} does not match request ${request.request_id} and its current authority pins`,
    )
  }
  return request
}
