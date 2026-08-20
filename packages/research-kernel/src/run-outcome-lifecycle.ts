/**
 * Durable Runner-completion → scientific-classification handoff.
 *
 * The existing Kernel outbox is the append-only observation ledger. This
 * module owns strict decoding and deterministic identities only; it performs
 * no Project/Gate/Evidence/Claim/Release mutation and never infers a
 * ScientificOutcome from process exit facts.
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  RunOutcomeObservation,
  SynthesisRecordRequest,
  canonicalJsonDeep,
  type FrozenProtocolPin,
  type ResearchRunOutcome,
  type RunOutcomeObservation as RunOutcomeObservationValue,
  type SynthesisRecordRequest as SynthesisRecordRequestValue,
} from '@dsh-scholar/research-schemas'

const RESEARCH_OUTCOME_JOB_KINDS = new Set([
  'echo', 'smoke', 'baseline', 'pilot', 'formal', 'analysis', 'reproduce',
])

function sha256Id(prefix: string, parts: readonly (string | number)[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex').slice(0, 24)
  return `${prefix}_${digest}`
}

export function observesResearchOutcome(jobKind: string): boolean {
  return RESEARCH_OUTCOME_JOB_KINDS.has(jobKind)
}

export function canonicalManifestSha256(manifest: Record<string, unknown> | undefined): `sha256:${string}` | null {
  if (manifest === undefined) return null
  const canonical = canonicalJsonDeep(manifest)
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}

export function buildRunOutcomeObservation(input: {
  project_id: string
  job_id: string
  run_id: string
  attempt_no: number
  lease_generation: number
  job_execution: 'succeeded' | 'failed' | 'cancelled' | 'timed_out'
  failure_class: 'environment' | 'resources' | 'code_error' | 'data_issue' | 'no_improvement' | 'unstable_results' | 'budget_exhausted' | 'unknown' | null
  intent: 'exploratory' | 'confirmatory'
  protocol_pin: FrozenProtocolPin | null
  manifest: Record<string, unknown> | undefined
  observed_at: string
}): RunOutcomeObservationValue {
  return RunOutcomeObservation.parse({
    observation_id: sha256Id('run_observation', [input.project_id, input.job_id, input.run_id, input.attempt_no]),
    project_id: input.project_id,
    job_id: input.job_id,
    run_id: input.run_id,
    attempt_no: input.attempt_no,
    lease_generation: input.lease_generation,
    job_execution: input.job_execution,
    failure_class: input.failure_class,
    intent: input.intent,
    protocol_pin: input.protocol_pin,
    manifest_sha256: canonicalManifestSha256(input.manifest),
    observed_at: input.observed_at,
  })
}

interface EventPayloadRow {
  project_id: string | null
  payload: string
}

function eventPayloads(db: DatabaseSync, projectId: string, kind: string): unknown[] {
  const rows = db.prepare(`
    SELECT project_id, payload
    FROM events
    WHERE project_id = ? AND kind = ?
    ORDER BY event_seq, event_id
  `).all(projectId, kind) as unknown as EventPayloadRow[]
  return rows.map(row => {
    if (row.project_id !== projectId) throw new Error('run outcome event crossed project boundary')
    return JSON.parse(row.payload) as unknown
  })
}

export function listRunOutcomeObservationLedger(
  db: DatabaseSync,
  projectId: string,
  outcomes: readonly ResearchRunOutcome[],
): {
  project_id: string
  observations: RunOutcomeObservationValue[]
  pending: RunOutcomeObservationValue[]
  pending_count: number
} {
  const observations = eventPayloads(db, projectId, 'research.run.unclassified')
    .map(payload => RunOutcomeObservation.parse(payload))
  const consumed = new Set(outcomes.map(outcome => outcome.run.run_ref))
  const pending = observations.filter(observation => !consumed.has(observation.run_id))
  return { project_id: projectId, observations, pending, pending_count: pending.length }
}

export function getRunOutcomeObservation(
  db: DatabaseSync,
  projectId: string,
  runId: string,
  outcomes: readonly ResearchRunOutcome[],
): RunOutcomeObservationValue | null {
  return listRunOutcomeObservationLedger(db, projectId, outcomes).observations
    .find(observation => observation.run_id === runId) ?? null
}

export function buildSynthesisRecordRequest(input: {
  project_id: string
  trigger_run_ref: string
  source_run_refs: SynthesisRecordRequestValue['source_run_refs']
  reasons: SynthesisRecordRequestValue['reasons']
  window: SynthesisRecordRequestValue['window']
  snapshot_pin: SynthesisRecordRequestValue['snapshot_pin']
  requested_at: string
}): SynthesisRecordRequestValue {
  return SynthesisRecordRequest.parse({
    request_id: sha256Id('synthesis_request', [
      input.project_id,
      input.trigger_run_ref,
      input.window.from_event_seq,
      input.window.to_event_seq,
    ]),
    ...input,
  })
}

export function listSynthesisRecordRequests(
  db: DatabaseSync,
  projectId: string,
  synthesisWindows: readonly { to_event_seq: number }[],
): {
  project_id: string
  requests: SynthesisRecordRequestValue[]
  pending: SynthesisRecordRequestValue[]
} {
  const requests = eventPayloads(db, projectId, 'research.synthesis.requested')
    .map(payload => SynthesisRecordRequest.parse(payload))
  const coveredThrough = synthesisWindows.reduce((max, window) => Math.max(max, window.to_event_seq), -1)
  return {
    project_id: projectId,
    requests,
    pending: requests.filter(request => request.window.to_event_seq > coveredThrough),
  }
}
