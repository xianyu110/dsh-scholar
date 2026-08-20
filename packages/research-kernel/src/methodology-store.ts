/**
 * Append-only SQLite persistence for non-authoritative methodology records.
 *
 * The store owns no Project phase, Gate, Job, Evidence, Claim or TeX mutation.
 * Every project write shares one project-scoped CAS stream; global knowledge
 * registry facts use a separate global CAS stream on the same SQLite
 * connection supplied by the caller.
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  ClaimEvidenceBinding,
  DirectionAdoption,
  DirectionProposal,
  KnowledgeActivationRequest,
  KnowledgeCapability,
  KnowledgePackChannel,
  KnowledgePackageEvaluation,
  KnowledgePackageRecord,
  ProtocolRevision,
  ResearchRunOutcome,
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
  type ResearchRunOutcome as ResearchRunOutcomeValue,
  type ReviewFinding as ReviewFindingValue,
  type ReverseOutline as ReverseOutlineValue,
  type ResearchSynthesis as ResearchSynthesisValue,
  type WritingInputPin as WritingInputPinValue,
} from '@dsh-scholar/research-schemas'
import { resolveKnowledgeActivation } from './knowledge-registry.js'
import {
  resolveKnowledgeDelivery as resolveDelivery,
  type KnowledgeDeliveryContext,
  type KnowledgeDeliverySnapshot,
} from './knowledge-delivery.js'
import { NATIVE_KNOWLEDGE_PACKS, verifyNativeKnowledgePack } from './native-knowledge-packs.js'
import {
  assessWritingMethodology,
  type WritingMethodologyReport,
} from './writing-methodology.js'

/** Phase-3 terminal Job outcome ledger. It is intentionally a separate
 * append-only auxiliary stream from methodology_project_events: released
 * event-kind CHECK constraints stay immutable, while an upgrade can add this
 * layer without rebuilding or rewriting any prior methodology record. */
export const RESEARCH_RUN_OUTCOME_DDL = `
CREATE TABLE IF NOT EXISTS methodology_run_outcomes (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  run_ref TEXT NOT NULL,
  outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision),
  UNIQUE (project_id, run_ref),
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CHECK (COALESCE(
    json_extract(outcome_json, '$.run.project_id') = project_id
    AND json_extract(outcome_json, '$.run.run_ref') = run_ref,
    0
  ))
);
CREATE INDEX IF NOT EXISTS idx_methodology_run_outcomes_run
  ON methodology_run_outcomes(project_id, run_ref, revision);
CREATE UNIQUE INDEX IF NOT EXISTS idx_methodology_run_outcomes_finding
  ON methodology_run_outcomes(project_id, json_extract(outcome_json, '$.negative_finding.finding_id'))
  WHERE json_extract(outcome_json, '$.negative_finding.finding_id') IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_methodology_run_outcomes_proposal
  ON methodology_run_outcomes(project_id, json_extract(outcome_json, '$.claim_proposal.proposal_id'))
  WHERE json_extract(outcome_json, '$.claim_proposal.proposal_id') IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS methodology_run_outcomes_revision_sequence
BEFORE INSERT ON methodology_run_outcomes
WHEN NEW.revision != COALESCE((
  SELECT MAX(revision) FROM methodology_run_outcomes WHERE project_id = NEW.project_id
), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'methodology_run_outcome_revision_sequence');
END;
CREATE TRIGGER IF NOT EXISTS methodology_run_outcomes_no_update
BEFORE UPDATE ON methodology_run_outcomes
BEGIN
  SELECT RAISE(ABORT, 'methodology_run_outcomes_append_only');
END;
CREATE TRIGGER IF NOT EXISTS methodology_run_outcomes_no_delete
BEFORE DELETE ON methodology_run_outcomes
BEGIN
  SELECT RAISE(ABORT, 'methodology_run_outcomes_append_only');
END;
`

export const METHODOLOGY_DDL = `
CREATE TABLE IF NOT EXISTS methodology_project_events (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'protocol_revision',
    'research_synthesis',
    'direction_proposal',
    'direction_adoption',
    'knowledge_activation',
    'knowledge_deactivation',
    'reverse_outline',
    'review_finding'
  )),
  record_id TEXT NOT NULL,
  parent_id TEXT,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision),
  UNIQUE (project_id, event_kind, record_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CHECK (
    CASE event_kind
      WHEN 'protocol_revision' THEN COALESCE(
        json_extract(record_json, '$.project_id') = project_id
        AND json_extract(record_json, '$.protocol_id') = record_id
        AND (
          (json_type(record_json, '$.supersedes') = 'null' AND parent_id IS NULL)
          OR json_extract(record_json, '$.supersedes') = parent_id
        ),
        0
      )
      WHEN 'research_synthesis' THEN COALESCE(
        json_extract(record_json, '$.project_id') = project_id
        AND json_extract(record_json, '$.synthesis_id') = record_id,
        0
      )
      WHEN 'direction_proposal' THEN COALESCE(
        json_extract(record_json, '$.project_id') = project_id
        AND json_extract(record_json, '$.proposal_id') = record_id
        AND json_extract(record_json, '$.synthesis_id') = parent_id,
        0
      )
      WHEN 'direction_adoption' THEN COALESCE(
        json_extract(record_json, '$.project_id') = project_id
        AND json_extract(record_json, '$.adoption_id') = record_id
        AND json_extract(record_json, '$.proposal_id') = parent_id,
        0
      )
      WHEN 'knowledge_activation' THEN COALESCE(
        json_extract(record_json, '$.project_id') = project_id
        AND json_extract(record_json, '$.activation_id') = record_id,
        0
      )
      WHEN 'knowledge_deactivation' THEN COALESCE(
        json_extract(record_json, '$.project_id') = project_id
        AND json_extract(record_json, '$.deactivation_id') = record_id
        AND json_extract(record_json, '$.activation_id') = parent_id,
        0
      )
      WHEN 'reverse_outline' THEN COALESCE(
        json_extract(record_json, '$.input_pin.project_id') = project_id
        AND json_extract(record_json, '$.outline_id') = record_id
        AND json_extract(record_json, '$.input_pin.document_id') = parent_id,
        0
      )
      WHEN 'review_finding' THEN COALESCE(
        json_extract(record_json, '$.input_pin.project_id') = project_id
        AND json_extract(record_json, '$.finding_id') = record_id
        AND json_extract(record_json, '$.input_pin.document_id') = parent_id,
        0
      )
      ELSE 0
    END
  )
);
CREATE INDEX IF NOT EXISTS idx_methodology_project_events_kind
  ON methodology_project_events(project_id, event_kind, revision);
CREATE UNIQUE INDEX IF NOT EXISTS idx_methodology_direction_adoption_once
  ON methodology_project_events(project_id, parent_id)
  WHERE event_kind = 'direction_adoption';
CREATE TRIGGER IF NOT EXISTS methodology_project_events_revision_sequence
BEFORE INSERT ON methodology_project_events
WHEN NEW.revision != COALESCE((
  SELECT MAX(revision) FROM methodology_project_events WHERE project_id = NEW.project_id
), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'methodology_project_revision_sequence');
END;
CREATE TRIGGER IF NOT EXISTS methodology_project_events_no_update
BEFORE UPDATE ON methodology_project_events
BEGIN
  SELECT RAISE(ABORT, 'methodology_project_events_append_only');
END;
CREATE TRIGGER IF NOT EXISTS methodology_project_events_no_delete
BEFORE DELETE ON methodology_project_events
BEGIN
  SELECT RAISE(ABORT, 'methodology_project_events_append_only');
END;

CREATE TABLE IF NOT EXISTS methodology_registry_events (
  revision INTEGER NOT NULL PRIMARY KEY CHECK (revision > 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('package_registered', 'evaluation_recorded')),
  record_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  package_version TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  created_at TEXT NOT NULL,
  UNIQUE (event_kind, record_id),
  CHECK (
    CASE event_kind
      WHEN 'package_registered' THEN COALESCE(
        json_extract(record_json, '$.manifest.name') = package_name
        AND json_extract(record_json, '$.manifest.version') = package_version
        AND json_extract(record_json, '$.manifest_sha256') = manifest_sha256
        AND json_extract(record_json, '$.manifest.payload_sha256') = payload_sha256,
        0
      )
      WHEN 'evaluation_recorded' THEN COALESCE(
        json_extract(record_json, '$.package_name') = package_name
        AND json_extract(record_json, '$.package_version') = package_version
        AND json_extract(record_json, '$.manifest_sha256') = manifest_sha256
        AND json_extract(record_json, '$.payload_sha256') = payload_sha256,
        0
      )
      ELSE 0
    END
  )
);
CREATE INDEX IF NOT EXISTS idx_methodology_registry_package
  ON methodology_registry_events(package_name, package_version, revision);
CREATE TRIGGER IF NOT EXISTS methodology_registry_events_revision_sequence
BEFORE INSERT ON methodology_registry_events
WHEN NEW.revision != COALESCE((SELECT MAX(revision) FROM methodology_registry_events), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'methodology_registry_revision_sequence');
END;
CREATE TRIGGER IF NOT EXISTS methodology_registry_events_no_update
BEFORE UPDATE ON methodology_registry_events
BEGIN
  SELECT RAISE(ABORT, 'methodology_registry_events_append_only');
END;
CREATE TRIGGER IF NOT EXISTS methodology_registry_events_no_delete
BEFORE DELETE ON methodology_registry_events
BEGIN
  SELECT RAISE(ABORT, 'methodology_registry_events_append_only');
END;
`

export class MethodologyStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MethodologyStoreError'
  }
}

function canonicalMethodologyJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalMethodologyJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalMethodologyJson(record[key])}`)
      .join(',')}}`
  }
  throw new TypeError('methodology canonical JSON accepts JSON values only')
}

/** Deterministic sha256 over the complete ProtocolRevision except its hash receipt. */
export function protocolRevisionCanonicalHash(record: ProtocolRevisionValue): `sha256:${string}` {
  const { canonical_hash: _receipt, ...payload } = record
  return `sha256:${createHash('sha256').update(canonicalMethodologyJson(payload), 'utf8').digest('hex')}`
}

const ExpectedRevision = z.number().int().nonnegative().safe()
const ProtocolRevisionWrite = z.object({
  record: ProtocolRevision,
  expected_revision: ExpectedRevision,
}).strict()
const ResearchSynthesisWrite = z.object({
  record: ResearchSynthesis,
  expected_revision: ExpectedRevision,
}).strict()
const ResearchRunOutcomeAppend = z.object({
  outcome: ResearchRunOutcome,
  expected_revision: ExpectedRevision,
}).strict()
const DirectionProposalWrite = z.object({
  record: DirectionProposal,
  expected_revision: ExpectedRevision,
}).strict()
const DirectionAdoptionWrite = z.object({
  record: DirectionAdoption,
  expected_revision: ExpectedRevision,
}).strict()
const KnowledgePackageWrite = z.object({
  record: KnowledgePackageRecord,
  expected_revision: ExpectedRevision,
}).strict()
const KnowledgeEvaluationWrite = z.object({
  record: KnowledgePackageEvaluation,
  expected_revision: ExpectedRevision,
}).strict()

const AllowedKnowledgeActivationResolution = z.object({
  allowed: z.literal(true),
  channel: KnowledgePackChannel,
  injection_mode: z.enum(['trusted-instruction-reference', 'untrusted-read-only-reference']),
  effective_capabilities: z.array(KnowledgeCapability).max(KnowledgeCapability.options.length),
  reason_codes: z.array(z.never()).max(0),
  pin: z.object({
    project_id: z.string().min(1).max(256),
    session_id: z.string().min(1).max(256),
    package_name: z.string().min(1).max(160),
    package_version: z.string().min(1).max(80),
    manifest_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    payload_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    phase: z.string().min(1).max(64),
    next_action_revision: z.number().int().nonnegative(),
  }).strict(),
}).strict()

const StoredKnowledgeActivation = z.object({
  activation_id: z.string().regex(/^activation_[a-z0-9_]+$/),
  project_id: z.string().min(1).max(256),
  registry_revision: z.number().int().nonnegative().safe(),
  request: KnowledgeActivationRequest,
  resolution: AllowedKnowledgeActivationResolution,
  activated_at: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (value.request.project_id !== value.project_id
    || value.resolution.pin.project_id !== value.project_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'knowledge activation project identity mismatch',
      path: ['project_id'],
    })
  }
  const request = value.request
  const pin = value.resolution.pin
  if (request.session_id !== pin.session_id
    || request.package_name !== pin.package_name
    || request.package_version !== pin.package_version
    || request.manifest_sha256 !== pin.manifest_sha256
    || request.payload_sha256 !== pin.payload_sha256
    || request.phase !== pin.phase
    || request.next_action_revision !== pin.next_action_revision) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'knowledge activation pin does not match the request',
      path: ['resolution', 'pin'],
    })
  }
})

const KnowledgeActivationWrite = z.object({
  request: KnowledgeActivationRequest,
  expected_revision: ExpectedRevision,
  expected_registry_revision: ExpectedRevision,
}).strict()
const KnowledgeDeactivationRequest = z.object({
  project_id: z.string().min(1).max(256),
  session_id: z.string().min(1).max(256),
  activation_id: z.string().regex(/^activation_[a-z0-9_]+$/),
  explicit_human_deactivation: z.literal(true),
  reason: z.enum(['user-requested', 'superseded', 'no-longer-needed']),
}).strict()
const KnowledgeDeactivationWrite = z.object({
  request: KnowledgeDeactivationRequest,
  expected_revision: ExpectedRevision,
}).strict()
const StoredKnowledgeDeactivation = z.object({
  deactivation_id: z.string().regex(/^deactivation_[a-z0-9_]+$/),
  project_id: z.string().min(1).max(256),
  session_id: z.string().min(1).max(256),
  activation_id: z.string().regex(/^activation_[a-z0-9_]+$/),
  reason: z.enum(['user-requested', 'superseded', 'no-longer-needed']),
  deactivated_at: z.string().datetime(),
}).strict()
const ReverseOutlineWrite = z.object({
  record: ReverseOutline,
  expected_revision: ExpectedRevision,
}).strict()
const ReviewFindingWrite = z.object({
  record: ReviewFinding,
  expected_revision: ExpectedRevision,
}).strict()
const WritingProjectionInput = z.object({
  project_id: z.string().min(1).max(256),
  outline_id: z.string().regex(/^outline_[a-z0-9_]+$/),
  finding_ids: z.array(z.string().regex(/^finding_[a-z0-9_]+$/)).max(10_000).optional(),
  current_input: WritingInputPin,
  claim_evidence: z.array(ClaimEvidenceBinding).max(10_000),
}).strict()

export type ProtocolRevisionWrite = z.infer<typeof ProtocolRevisionWrite>
export type ResearchSynthesisWrite = z.infer<typeof ResearchSynthesisWrite>
export type ResearchRunOutcomeAppend = z.infer<typeof ResearchRunOutcomeAppend>
export type DirectionProposalWrite = z.infer<typeof DirectionProposalWrite>
export type DirectionAdoptionWrite = z.infer<typeof DirectionAdoptionWrite>
export type KnowledgePackageWrite = z.infer<typeof KnowledgePackageWrite>
export type KnowledgeEvaluationWrite = z.infer<typeof KnowledgeEvaluationWrite>
export type KnowledgeActivationWrite = z.infer<typeof KnowledgeActivationWrite>
export type StoredKnowledgeActivation = z.infer<typeof StoredKnowledgeActivation>
export type KnowledgeDeactivationWrite = z.input<typeof KnowledgeDeactivationWrite>
export type StoredKnowledgeDeactivation = z.infer<typeof StoredKnowledgeDeactivation>
export type ReverseOutlineWrite = z.infer<typeof ReverseOutlineWrite>
export type ReviewFindingWrite = z.infer<typeof ReviewFindingWrite>
export type WritingProjectionInput = z.infer<typeof WritingProjectionInput>
export type MethodologyWritingProjection = WritingMethodologyReport & { revision: number }

export interface MethodologyRecordView<T> {
  project_id: string
  /** Current revision of the complete project methodology event stream. */
  stream_revision: number
  /** Revision at which this immutable record was appended. */
  recorded_revision: number
  record: T
}

export interface MethodologyRecordList<T> {
  project_id: string
  stream_revision: number
  records: Array<MethodologyRecordView<T>>
}

export interface MethodologyRegistryRecordView<T> {
  /** Current revision of the complete global knowledge registry stream. */
  registry_revision: number
  recorded_revision: number
  record: T
}

export interface MethodologyRegistryRecordList<T> {
  registry_revision: number
  records: Array<MethodologyRegistryRecordView<T>>
}

export interface ResearchRunOutcomeView {
  project_id: string
  run_stream_revision: number
  recorded_revision: number
  replayed: boolean
  outcome: ResearchRunOutcomeValue
}

export interface ResearchRunOutcomeList {
  project_id: string
  run_stream_revision: number
  outcomes: ResearchRunOutcomeView[]
}

export interface NegativeFindingList {
  project_id: string
  run_stream_revision: number
  findings: Array<NonNullable<ResearchRunOutcomeValue['negative_finding']>>
}

export interface ResearchClaimProposalList {
  project_id: string
  run_stream_revision: number
  proposals: Array<NonNullable<ResearchRunOutcomeValue['claim_proposal']>>
}

interface ProjectEventRow {
  project_id: string
  revision: number
  record_json: string
}

interface RegistryEventRow {
  revision: number
  record_json: string
}

type RegistryEventKind = 'package_registered' | 'evaluation_recorded'

interface StrictParser<T> {
  parse(value: unknown): T
}

type ProjectEventKind =
  | 'protocol_revision'
  | 'research_synthesis'
  | 'direction_proposal'
  | 'direction_adoption'
  | 'knowledge_activation'
  | 'knowledge_deactivation'
  | 'reverse_outline'
  | 'review_finding'

export class MethodologyStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.db.exec(METHODOLOGY_DDL)
    this.db.exec(RESEARCH_RUN_OUTCOME_DDL)
  }

  private transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private assertProject(projectId: string): void {
    if (this.db.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(projectId) === undefined) {
      throw new MethodologyStoreError(404, 'methodology_project_not_found', `project ${projectId} not found`)
    }
  }

  projectRevision(projectId: string): number {
    this.assertProject(projectId)
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(revision), 0) AS revision
      FROM methodology_project_events
      WHERE project_id = ?
    `).get(projectId) as { revision: number }
    return row.revision
  }

  runRevision(projectId: string): number {
    this.assertProject(projectId)
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(revision), 0) AS revision
      FROM methodology_run_outcomes
      WHERE project_id = ?
    `).get(projectId) as { revision: number }
    return row.revision
  }

  private assertRunCas(projectId: string, expectedRevision: number): number {
    const expected = ExpectedRevision.parse(expectedRevision)
    const current = this.runRevision(projectId)
    if (current !== expected) {
      throw new MethodologyStoreError(
        409,
        'methodology_run_revision_conflict',
        `project ${projectId} run outcome revision ${current} does not match expected ${expected}`,
      )
    }
    return current
  }

  private assertProjectCas(projectId: string, expectedRevision: number): number {
    const expected = ExpectedRevision.parse(expectedRevision)
    const current = this.projectRevision(projectId)
    if (current !== expected) {
      throw new MethodologyStoreError(
        409,
        'methodology_revision_conflict',
        `project ${projectId} methodology revision ${current} does not match expected ${expected}`,
      )
    }
    return current
  }

  registryRevision(): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(revision), 0) AS revision FROM methodology_registry_events',
    ).get() as { revision: number }
    return row.revision
  }

  private assertRegistryCas(expectedRevision: number): number {
    const expected = ExpectedRevision.parse(expectedRevision)
    const current = this.registryRevision()
    if (current !== expected) {
      throw new MethodologyStoreError(
        409,
        'methodology_registry_revision_conflict',
        `knowledge registry revision ${current} does not match expected ${expected}`,
      )
    }
    return current
  }

  private projectRows(projectId: string, kind: ProjectEventKind, recordId?: string): ProjectEventRow[] {
    const sql = recordId === undefined
      ? `SELECT project_id, revision, record_json
         FROM methodology_project_events
         WHERE project_id = ? AND event_kind = ?
         ORDER BY revision`
      : `SELECT project_id, revision, record_json
         FROM methodology_project_events
         WHERE project_id = ? AND event_kind = ? AND record_id = ?
         ORDER BY revision`
    return this.db.prepare(sql).all(
      ...(recordId === undefined ? [projectId, kind] : [projectId, kind, recordId]),
    ) as unknown as ProjectEventRow[]
  }

  private projectRowsByParent(projectId: string, kind: ProjectEventKind, parentId: string): ProjectEventRow[] {
    return this.db.prepare(`
      SELECT project_id, revision, record_json
      FROM methodology_project_events
      WHERE project_id = ? AND event_kind = ? AND parent_id = ?
      ORDER BY revision
    `).all(projectId, kind, parentId) as unknown as ProjectEventRow[]
  }

  private registryRows(kind: RegistryEventKind, recordId?: string): RegistryEventRow[] {
    const sql = recordId === undefined
      ? `SELECT revision, record_json
         FROM methodology_registry_events
         WHERE event_kind = ?
         ORDER BY revision`
      : `SELECT revision, record_json
         FROM methodology_registry_events
         WHERE event_kind = ? AND record_id = ?
         ORDER BY revision`
    return this.db.prepare(sql).all(
      ...(recordId === undefined ? [kind] : [kind, recordId]),
    ) as unknown as RegistryEventRow[]
  }

  private runOutcomeRows(projectId: string, runRef?: string): Array<{
    project_id: string
    revision: number
    outcome_json: string
  }> {
    const sql = runRef === undefined
      ? `SELECT project_id, revision, outcome_json
         FROM methodology_run_outcomes
         WHERE project_id = ?
         ORDER BY revision`
      : `SELECT project_id, revision, outcome_json
         FROM methodology_run_outcomes
         WHERE project_id = ? AND run_ref = ?
         ORDER BY revision`
    return this.db.prepare(sql).all(...(runRef === undefined ? [projectId] : [projectId, runRef])) as unknown as Array<{
      project_id: string
      revision: number
      outcome_json: string
    }>
  }

  private appendProjectRecord(
    projectId: string,
    expectedRevision: number,
    kind: ProjectEventKind,
    recordId: string,
    parentId: string | null,
    record: unknown,
  ): number {
    const current = this.assertProjectCas(projectId, expectedRevision)
    const next = current + 1
    this.db.prepare(`
      INSERT INTO methodology_project_events
        (project_id, revision, event_kind, record_id, parent_id, record_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(projectId, next, kind, recordId, parentId, JSON.stringify(record), this.now())
    return next
  }

  private appendRegistryRecord(
    expectedRevision: number,
    kind: RegistryEventKind,
    recordId: string,
    identity: {
      package_name: string
      package_version: string
      manifest_sha256: string
      payload_sha256: string
    },
    record: unknown,
  ): number {
    const current = this.assertRegistryCas(expectedRevision)
    const next = current + 1
    this.db.prepare(`
      INSERT INTO methodology_registry_events
        (revision, event_kind, record_id, package_name, package_version,
         manifest_sha256, payload_sha256, record_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      next,
      kind,
      recordId,
      identity.package_name,
      identity.package_version,
      identity.manifest_sha256,
      identity.payload_sha256,
      JSON.stringify(record),
      this.now(),
    )
    return next
  }

  private protocolView(row: ProjectEventRow, streamRevision: number): MethodologyRecordView<ProtocolRevisionValue> {
    return {
      project_id: row.project_id,
      stream_revision: streamRevision,
      recorded_revision: row.revision,
      record: ProtocolRevision.parse(JSON.parse(row.record_json) as unknown),
    }
  }

  private projectView<T>(
    row: ProjectEventRow,
    streamRevision: number,
    parser: StrictParser<T>,
  ): MethodologyRecordView<T> {
    return {
      project_id: row.project_id,
      stream_revision: streamRevision,
      recorded_revision: row.revision,
      record: parser.parse(JSON.parse(row.record_json) as unknown),
    }
  }

  private getProjectRecord<T>(
    projectId: string,
    kind: ProjectEventKind,
    recordId: string,
    parser: StrictParser<T>,
    notFoundCode: string,
    label: string,
    knownStreamRevision?: number,
  ): MethodologyRecordView<T> {
    this.assertProject(projectId)
    const [row] = this.projectRows(projectId, kind, recordId)
    if (row === undefined) {
      throw new MethodologyStoreError(404, notFoundCode, `${label} ${recordId} not found in project ${projectId}`)
    }
    return this.projectView(row, knownStreamRevision ?? this.projectRevision(projectId), parser)
  }

  private listProjectRecords<T>(
    projectId: string,
    kind: ProjectEventKind,
    parser: StrictParser<T>,
  ): MethodologyRecordList<T> {
    const streamRevision = this.projectRevision(projectId)
    return {
      project_id: projectId,
      stream_revision: streamRevision,
      records: this.projectRows(projectId, kind).map(row => this.projectView(row, streamRevision, parser)),
    }
  }

  private registryView<T>(
    row: RegistryEventRow,
    registryRevision: number,
    parser: StrictParser<T>,
  ): MethodologyRegistryRecordView<T> {
    return {
      registry_revision: registryRevision,
      recorded_revision: row.revision,
      record: parser.parse(JSON.parse(row.record_json) as unknown),
    }
  }

  private listRegistryRecords<T>(
    kind: RegistryEventKind,
    parser: StrictParser<T>,
  ): MethodologyRegistryRecordList<T> {
    const registryRevision = this.registryRevision()
    return {
      registry_revision: registryRevision,
      records: this.registryRows(kind).map(row => this.registryView(row, registryRevision, parser)),
    }
  }

  recordProtocolRevision(rawInput: ProtocolRevisionWrite): MethodologyRecordView<ProtocolRevisionValue> {
    const input = ProtocolRevisionWrite.parse(rawInput)
    const record = input.record
    if (record.status === 'frozen' && record.canonical_hash !== protocolRevisionCanonicalHash(record)) {
      throw new MethodologyStoreError(
        422,
        'methodology_protocol_hash_mismatch',
        `frozen protocol ${record.protocol_id} canonical_hash does not match its canonical content`,
      )
    }
    return this.transaction(() => {
      this.assertProjectCas(record.project_id, input.expected_revision)
      if (this.projectRows(record.project_id, 'protocol_revision', record.protocol_id).length !== 0) {
        throw new MethodologyStoreError(
          409,
          'methodology_protocol_exists',
          `protocol revision ${record.protocol_id} already exists in project ${record.project_id}`,
        )
      }
      if (record.supersedes === null) {
        if (record.revision !== 1) {
          throw new MethodologyStoreError(
            422,
            'methodology_protocol_lineage_invalid',
            'a root protocol must have revision 1',
          )
        }
      } else {
        const previous = this.getProtocolRevision(record.project_id, record.supersedes)
        if (record.revision !== previous.record.revision + 1) {
          throw new MethodologyStoreError(
            422,
            'methodology_protocol_lineage_invalid',
            'a protocol revision must immediately follow the revision it supersedes',
          )
        }
      }
      const revision = this.appendProjectRecord(
        record.project_id,
        input.expected_revision,
        'protocol_revision',
        record.protocol_id,
        record.supersedes,
        record,
      )
      return this.getProtocolRevision(record.project_id, record.protocol_id, revision)
    })
  }

  getProtocolRevision(
    projectId: string,
    protocolId: string,
    knownStreamRevision?: number,
  ): MethodologyRecordView<ProtocolRevisionValue> {
    this.assertProject(projectId)
    const [row] = this.projectRows(projectId, 'protocol_revision', protocolId)
    if (row === undefined) {
      throw new MethodologyStoreError(
        404,
        'methodology_protocol_not_found',
        `protocol revision ${protocolId} not found in project ${projectId}`,
      )
    }
    return this.protocolView(row, knownStreamRevision ?? this.projectRevision(projectId))
  }

  listProtocolRevisions(projectId: string): MethodologyRecordList<ProtocolRevisionValue> {
    const streamRevision = this.projectRevision(projectId)
    return {
      project_id: projectId,
      stream_revision: streamRevision,
      records: this.projectRows(projectId, 'protocol_revision')
        .map(row => this.protocolView(row, streamRevision)),
    }
  }

  recordResearchRunOutcome(rawInput: ResearchRunOutcomeAppend): ResearchRunOutcomeView {
    const input = ResearchRunOutcomeAppend.parse(rawInput)
    const projectId = input.outcome.run.project_id
    const runRef = input.outcome.run.run_ref
    return this.transaction(() => {
      this.assertProject(projectId)
      const [existing] = this.runOutcomeRows(projectId, runRef)
      if (existing !== undefined) {
        const stored = ResearchRunOutcome.parse(JSON.parse(existing.outcome_json) as unknown)
        if (canonicalMethodologyJson(stored) !== canonicalMethodologyJson(input.outcome)) {
          throw new MethodologyStoreError(
            409,
            'methodology_run_outcome_conflict',
            `run ${runRef} already has a different immutable outcome`,
          )
        }
        return {
          project_id: projectId,
          run_stream_revision: this.runRevision(projectId),
          recorded_revision: existing.revision,
          replayed: true,
          outcome: stored,
        }
      }
      const current = this.assertRunCas(projectId, input.expected_revision)
      const proposalId = input.outcome.claim_proposal?.proposal_id
      if (proposalId !== undefined) {
        const proposalOwner = this.db.prepare(`
          SELECT run_ref
          FROM methodology_run_outcomes
          WHERE project_id = ?
            AND json_extract(outcome_json, '$.claim_proposal.proposal_id') = ?
        `).get(projectId, proposalId) as { run_ref: string } | undefined
        if (proposalOwner !== undefined) {
          throw new MethodologyStoreError(409, 'methodology_claim_proposal_conflict', `Claim proposal ${proposalId} is already bound to run ${proposalOwner.run_ref}`)
        }
      }
      const revision = current + 1
      this.db.prepare(`
        INSERT INTO methodology_run_outcomes
          (project_id, revision, run_ref, outcome_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(projectId, revision, runRef, JSON.stringify(input.outcome), this.now())
      return {
        project_id: projectId,
        run_stream_revision: revision,
        recorded_revision: revision,
        replayed: false,
        outcome: input.outcome,
      }
    })
  }

  getResearchRunOutcome(projectId: string, runRef: string): ResearchRunOutcomeView {
    this.assertProject(projectId)
    const [row] = this.runOutcomeRows(projectId, runRef)
    if (row === undefined) {
      throw new MethodologyStoreError(404, 'methodology_run_outcome_not_found', `run outcome ${runRef} not found in project ${projectId}`)
    }
    return {
      project_id: projectId,
      run_stream_revision: this.runRevision(projectId),
      recorded_revision: row.revision,
      replayed: false,
      outcome: ResearchRunOutcome.parse(JSON.parse(row.outcome_json) as unknown),
    }
  }

  listResearchRunOutcomes(projectId: string): ResearchRunOutcomeList {
    const revision = this.runRevision(projectId)
    return {
      project_id: projectId,
      run_stream_revision: revision,
      outcomes: this.runOutcomeRows(projectId).map(row => ({
        project_id: projectId,
        run_stream_revision: revision,
        recorded_revision: row.revision,
        replayed: false,
        outcome: ResearchRunOutcome.parse(JSON.parse(row.outcome_json) as unknown),
      })),
    }
  }

  listNegativeFindings(projectId: string): NegativeFindingList {
    const outcomes = this.listResearchRunOutcomes(projectId)
    return {
      project_id: projectId,
      run_stream_revision: outcomes.run_stream_revision,
      findings: outcomes.outcomes.flatMap(item => item.outcome.negative_finding === null ? [] : [item.outcome.negative_finding]),
    }
  }

  listResearchClaimProposals(projectId: string): ResearchClaimProposalList {
    const outcomes = this.listResearchRunOutcomes(projectId)
    return {
      project_id: projectId,
      run_stream_revision: outcomes.run_stream_revision,
      proposals: outcomes.outcomes.flatMap(item => item.outcome.claim_proposal === null ? [] : [item.outcome.claim_proposal]),
    }
  }

  recordResearchSynthesis(rawInput: ResearchSynthesisWrite): MethodologyRecordView<ResearchSynthesisValue> {
    const input = ResearchSynthesisWrite.parse(rawInput)
    const record = input.record
    return this.transaction(() => {
      this.assertProjectCas(record.project_id, input.expected_revision)
      if (this.projectRows(record.project_id, 'research_synthesis', record.synthesis_id).length !== 0) {
        throw new MethodologyStoreError(
          409,
          'methodology_synthesis_exists',
          `research synthesis ${record.synthesis_id} already exists in project ${record.project_id}`,
        )
      }
      const revision = this.appendProjectRecord(
        record.project_id,
        input.expected_revision,
        'research_synthesis',
        record.synthesis_id,
        null,
        record,
      )
      return this.getResearchSynthesis(record.project_id, record.synthesis_id, revision)
    })
  }

  getResearchSynthesis(
    projectId: string,
    synthesisId: string,
    knownStreamRevision?: number,
  ): MethodologyRecordView<ResearchSynthesisValue> {
    return this.getProjectRecord(
      projectId,
      'research_synthesis',
      synthesisId,
      ResearchSynthesis,
      'methodology_synthesis_not_found',
      'research synthesis',
      knownStreamRevision,
    )
  }

  listResearchSyntheses(projectId: string): MethodologyRecordList<ResearchSynthesisValue> {
    return this.listProjectRecords(projectId, 'research_synthesis', ResearchSynthesis)
  }

  recordDirectionProposal(rawInput: DirectionProposalWrite): MethodologyRecordView<DirectionProposalValue> {
    const input = DirectionProposalWrite.parse(rawInput)
    const record = input.record
    return this.transaction(() => {
      this.assertProjectCas(record.project_id, input.expected_revision)
      const parent = this.getResearchSynthesis(record.project_id, record.synthesis_id)
      if (parent.record.direction_proposal_id !== null
        && parent.record.direction_proposal_id !== record.proposal_id) {
        throw new MethodologyStoreError(
          409,
          'methodology_synthesis_direction_conflict',
          `research synthesis ${record.synthesis_id} pins another direction proposal`,
        )
      }
      if (this.projectRows(record.project_id, 'direction_proposal', record.proposal_id).length !== 0) {
        throw new MethodologyStoreError(
          409,
          'methodology_direction_proposal_exists',
          `direction proposal ${record.proposal_id} already exists in project ${record.project_id}`,
        )
      }
      const revision = this.appendProjectRecord(
        record.project_id,
        input.expected_revision,
        'direction_proposal',
        record.proposal_id,
        record.synthesis_id,
        record,
      )
      return this.getDirectionProposal(record.project_id, record.proposal_id, revision)
    })
  }

  getDirectionProposal(
    projectId: string,
    proposalId: string,
    knownStreamRevision?: number,
  ): MethodologyRecordView<DirectionProposalValue> {
    return this.getProjectRecord(
      projectId,
      'direction_proposal',
      proposalId,
      DirectionProposal,
      'methodology_direction_proposal_not_found',
      'direction proposal',
      knownStreamRevision,
    )
  }

  listDirectionProposals(projectId: string): MethodologyRecordList<DirectionProposalValue> {
    return this.listProjectRecords(projectId, 'direction_proposal', DirectionProposal)
  }

  recordDirectionAdoption(rawInput: DirectionAdoptionWrite): MethodologyRecordView<DirectionAdoptionValue> {
    const input = DirectionAdoptionWrite.parse(rawInput)
    const record = input.record
    return this.transaction(() => {
      this.assertProjectCas(record.project_id, input.expected_revision)
      this.getDirectionProposal(record.project_id, record.proposal_id)
      if (this.projectRowsByParent(record.project_id, 'direction_adoption', record.proposal_id).length !== 0) {
        throw new MethodologyStoreError(
          409,
          'methodology_direction_already_adopted',
          `direction proposal ${record.proposal_id} already has an adoption decision`,
        )
      }
      if (this.projectRows(record.project_id, 'direction_adoption', record.adoption_id).length !== 0) {
        throw new MethodologyStoreError(
          409,
          'methodology_direction_adoption_exists',
          `direction adoption ${record.adoption_id} already exists in project ${record.project_id}`,
        )
      }
      const revision = this.appendProjectRecord(
        record.project_id,
        input.expected_revision,
        'direction_adoption',
        record.adoption_id,
        record.proposal_id,
        record,
      )
      return this.getDirectionAdoption(record.project_id, record.adoption_id, revision)
    })
  }

  getDirectionAdoption(
    projectId: string,
    adoptionId: string,
    knownStreamRevision?: number,
  ): MethodologyRecordView<DirectionAdoptionValue> {
    return this.getProjectRecord(
      projectId,
      'direction_adoption',
      adoptionId,
      DirectionAdoption,
      'methodology_direction_adoption_not_found',
      'direction adoption',
      knownStreamRevision,
    )
  }

  listDirectionAdoptions(projectId: string): MethodologyRecordList<DirectionAdoptionValue> {
    return this.listProjectRecords(projectId, 'direction_adoption', DirectionAdoption)
  }

  registerKnowledgePackage(rawInput: KnowledgePackageWrite): MethodologyRegistryRecordView<KnowledgePackageRecordValue> {
    const input = KnowledgePackageWrite.parse(rawInput)
    const record = input.record
    const manifest = record.manifest
    const recordId = [
      'package',
      `${manifest.name}@${manifest.version}`,
      record.manifest_sha256,
      manifest.payload_sha256,
    ].join(':')
    return this.transaction(() => {
      this.assertRegistryCas(input.expected_revision)
      if (this.registryRows('package_registered', recordId).length !== 0) {
        throw new MethodologyStoreError(
          409,
          'methodology_knowledge_package_exists',
          `knowledge package identity ${manifest.name}@${manifest.version} already exists`,
        )
      }
      const revision = this.appendRegistryRecord(
        input.expected_revision,
        'package_registered',
        recordId,
        {
          package_name: manifest.name,
          package_version: manifest.version,
          manifest_sha256: record.manifest_sha256,
          payload_sha256: manifest.payload_sha256,
        },
        record,
      )
      const [row] = this.registryRows('package_registered', recordId)
      if (row === undefined) throw new Error('registered knowledge package was not persisted')
      return this.registryView(row, revision, KnowledgePackageRecord)
    })
  }

  getKnowledgePackage(
    packageName: string,
    packageVersion: string,
    manifestSha256: string,
    payloadSha256: string,
  ): MethodologyRegistryRecordView<KnowledgePackageRecordValue> {
    const registryRevision = this.registryRevision()
    const row = this.db.prepare(`
      SELECT revision, record_json
      FROM methodology_registry_events
      WHERE event_kind = 'package_registered'
        AND package_name = ?
        AND package_version = ?
        AND manifest_sha256 = ?
        AND payload_sha256 = ?
      ORDER BY revision
      LIMIT 1
    `).get(packageName, packageVersion, manifestSha256, payloadSha256) as RegistryEventRow | undefined
    if (row === undefined) {
      throw new MethodologyStoreError(
        404,
        'methodology_knowledge_package_not_found',
        `knowledge package ${packageName}@${packageVersion} with the requested identity was not found`,
      )
    }
    return this.registryView(row, registryRevision, KnowledgePackageRecord)
  }

  listKnowledgePackages(): MethodologyRegistryRecordList<KnowledgePackageRecordValue> {
    return this.listRegistryRecords('package_registered', KnowledgePackageRecord)
  }

  recordKnowledgeEvaluation(
    rawInput: KnowledgeEvaluationWrite,
  ): MethodologyRegistryRecordView<KnowledgePackageEvaluationValue> {
    const input = KnowledgeEvaluationWrite.parse(rawInput)
    const record = input.record
    const recordId = [
      'evaluation',
      `${record.package_name}@${record.package_version}`,
      record.manifest_sha256,
      record.payload_sha256,
      record.verdict,
      [...record.granted_capabilities].sort().join(','),
    ].join(':')
    return this.transaction(() => {
      this.assertRegistryCas(input.expected_revision)
      this.getKnowledgePackage(
        record.package_name,
        record.package_version,
        record.manifest_sha256,
        record.payload_sha256,
      )
      if (this.registryRows('evaluation_recorded', recordId).length !== 0) {
        throw new MethodologyStoreError(
          409,
          'methodology_knowledge_evaluation_exists',
          `knowledge evaluation for ${record.package_name}@${record.package_version} already exists`,
        )
      }
      const revision = this.appendRegistryRecord(
        input.expected_revision,
        'evaluation_recorded',
        recordId,
        {
          package_name: record.package_name,
          package_version: record.package_version,
          manifest_sha256: record.manifest_sha256,
          payload_sha256: record.payload_sha256,
        },
        record,
      )
      const [row] = this.registryRows('evaluation_recorded', recordId)
      if (row === undefined) throw new Error('knowledge evaluation was not persisted')
      return this.registryView(row, revision, KnowledgePackageEvaluation)
    })
  }

  listKnowledgeEvaluations(): MethodologyRegistryRecordList<KnowledgePackageEvaluationValue> {
    return this.listRegistryRecords('evaluation_recorded', KnowledgePackageEvaluation)
  }

  /**
   * Reconcile the built-in Scholar catalog into the append-only Registry.
   * Exact existing records are reused after reopen. Any same-version identity
   * or evaluation conflict aborts without silently replacing history.
   */
  reconcileNativeKnowledgePacks(): { registry_revision: number; package_names: string[] } {
    return this.transaction(() => {
      for (const pack of NATIVE_KNOWLEDGE_PACKS) {
        const integrity = verifyNativeKnowledgePack(pack)
        if (!integrity.ok) {
          throw new MethodologyStoreError(
            500,
            'methodology_native_package_integrity_failed',
            `native package failed deterministic integrity verification: ${integrity.reason_codes.join(',')}`,
          )
        }
        const identity = pack.record.manifest
        const versions = this.listKnowledgePackages().records.filter(item =>
          item.record.manifest.name === identity.name
          && item.record.manifest.version === identity.version)
        if (versions.some(item => item.record.manifest_sha256 !== pack.record.manifest_sha256
          || item.record.manifest.payload_sha256 !== identity.payload_sha256)) {
          throw new MethodologyStoreError(
            409,
            'methodology_native_package_equivocation',
            `native package identity ${identity.name}@${identity.version} conflicts with the immutable catalog`,
          )
        }
        if (versions.length === 0) {
          this.registerKnowledgePackage({
            record: pack.record,
            expected_revision: this.registryRevision(),
          })
        }

        const evaluations = this.listKnowledgeEvaluations().records.filter(item =>
          item.record.package_name === identity.name
          && item.record.package_version === identity.version
          && item.record.manifest_sha256 === pack.record.manifest_sha256
          && item.record.payload_sha256 === identity.payload_sha256)
        const fingerprints = new Set(evaluations.map(item =>
          `${item.record.verdict}:${[...item.record.granted_capabilities].sort().join(',')}`))
        const expectedFingerprint = `approved:${[...pack.evaluation.granted_capabilities].sort().join(',')}`
        const terminalEvaluation = evaluations.some(item => item.record.verdict === 'revoked' || item.record.verdict === 'rejected')
        if (!terminalEvaluation && (fingerprints.size > 1 || (fingerprints.size === 1 && !fingerprints.has(expectedFingerprint)))) {
          throw new MethodologyStoreError(
            409,
            'methodology_native_evaluation_conflict',
            `native package evaluation ${identity.name}@${identity.version} conflicts with the immutable catalog`,
          )
        }
        if (evaluations.length === 0) {
          this.recordKnowledgeEvaluation({
            record: pack.evaluation,
            expected_revision: this.registryRevision(),
          })
        }
      }
      return {
        registry_revision: this.registryRevision(),
        package_names: NATIVE_KNOWLEDGE_PACKS.map(pack => pack.record.manifest.name),
      }
    })
  }

  activateKnowledgePackage(
    rawInput: KnowledgeActivationWrite,
  ): MethodologyRecordView<StoredKnowledgeActivation> {
    const input = KnowledgeActivationWrite.parse(rawInput)
    const request: KnowledgeActivationRequestValue = input.request
    return this.transaction(() => {
      const projectRevision = this.assertProjectCas(request.project_id, input.expected_revision)
      this.assertRegistryCas(input.expected_registry_revision)
      const resolution = resolveKnowledgeActivation({
        packages: this.listKnowledgePackages().records.map(item => item.record),
        evaluations: this.listKnowledgeEvaluations().records.map(item => item.record),
        request,
      })
      if (!resolution.allowed) {
        throw new MethodologyStoreError(
          422,
          'methodology_activation_denied',
          `knowledge activation denied: ${resolution.reason_codes.join(',')}`,
        )
      }
      const allowed = AllowedKnowledgeActivationResolution.parse(resolution)
      const record = StoredKnowledgeActivation.parse({
        activation_id: `activation_${projectRevision + 1}`,
        project_id: request.project_id,
        registry_revision: input.expected_registry_revision,
        request,
        resolution: allowed,
        activated_at: this.now(),
      })
      const revision = this.appendProjectRecord(
        request.project_id,
        input.expected_revision,
        'knowledge_activation',
        record.activation_id,
        `${request.package_name}@${request.package_version}`,
        record,
      )
      return this.getKnowledgeActivation(request.project_id, record.activation_id, revision)
    })
  }

  getKnowledgeActivation(
    projectId: string,
    activationId: string,
    knownStreamRevision?: number,
  ): MethodologyRecordView<StoredKnowledgeActivation> {
    return this.getProjectRecord(
      projectId,
      'knowledge_activation',
      activationId,
      StoredKnowledgeActivation,
      'methodology_activation_not_found',
      'knowledge activation',
      knownStreamRevision,
    )
  }

  listKnowledgeActivations(projectId: string): MethodologyRecordList<StoredKnowledgeActivation> {
    return this.listProjectRecords(projectId, 'knowledge_activation', StoredKnowledgeActivation)
  }

  deactivateKnowledgePackage(
    rawInput: KnowledgeDeactivationWrite,
  ): MethodologyRecordView<StoredKnowledgeDeactivation> {
    const input = KnowledgeDeactivationWrite.parse(rawInput)
    const request = input.request
    return this.transaction(() => {
      const existing = this.listKnowledgeDeactivations(request.project_id).records
        .find(item => item.record.activation_id === request.activation_id)
      if (existing !== undefined) {
        if (existing.record.session_id === request.session_id && existing.record.reason === request.reason) return existing
        throw new MethodologyStoreError(
          409,
          'methodology_activation_already_deactivated',
          `knowledge activation ${request.activation_id} is already deactivated with different immutable facts`,
        )
      }
      const projectRevision = this.assertProjectCas(request.project_id, input.expected_revision)
      const activation = this.getKnowledgeActivation(request.project_id, request.activation_id, projectRevision)
      if (activation.record.request.session_id !== request.session_id) {
        throw new MethodologyStoreError(
          403,
          'methodology_deactivation_session_mismatch',
          'knowledge deactivation requires the exact activation session',
        )
      }
      const record = StoredKnowledgeDeactivation.parse({
        deactivation_id: `deactivation_${projectRevision + 1}`,
        project_id: request.project_id,
        session_id: request.session_id,
        activation_id: request.activation_id,
        reason: request.reason,
        deactivated_at: this.now(),
      })
      const revision = this.appendProjectRecord(
        request.project_id,
        input.expected_revision,
        'knowledge_deactivation',
        record.deactivation_id,
        record.activation_id,
        record,
      )
      return this.getKnowledgeDeactivation(request.project_id, record.deactivation_id, revision)
    })
  }

  getKnowledgeDeactivation(
    projectId: string,
    deactivationId: string,
    knownStreamRevision?: number,
  ): MethodologyRecordView<StoredKnowledgeDeactivation> {
    return this.getProjectRecord(
      projectId,
      'knowledge_deactivation',
      deactivationId,
      StoredKnowledgeDeactivation,
      'methodology_deactivation_not_found',
      'knowledge deactivation',
      knownStreamRevision,
    )
  }

  listKnowledgeDeactivations(projectId: string): MethodologyRecordList<StoredKnowledgeDeactivation> {
    return this.listProjectRecords(projectId, 'knowledge_deactivation', StoredKnowledgeDeactivation)
  }

  resolveKnowledgeDelivery(context: KnowledgeDeliveryContext): KnowledgeDeliverySnapshot {
    this.assertProject(context.project_id)
    return resolveDelivery({
      packages: this.listKnowledgePackages().records.map(item => item.record),
      evaluations: this.listKnowledgeEvaluations().records.map(item => item.record),
      activations: this.listKnowledgeActivations(context.project_id).records.map(item => ({
        activation_id: item.record.activation_id,
        request: item.record.request,
      })),
      deactivations: this.listKnowledgeDeactivations(context.project_id).records.map(item => ({
        deactivation_id: item.record.deactivation_id,
        project_id: item.record.project_id,
        activation_id: item.record.activation_id,
      })),
      context,
    })
  }

  recordReverseOutline(rawInput: ReverseOutlineWrite): MethodologyRecordView<ReverseOutlineValue> {
    const input = ReverseOutlineWrite.parse(rawInput)
    const record = input.record
    return this.transaction(() => {
      this.assertProjectCas(record.input_pin.project_id, input.expected_revision)
      if (this.projectRows(record.input_pin.project_id, 'reverse_outline', record.outline_id).length !== 0) {
        throw new MethodologyStoreError(
          409,
          'methodology_reverse_outline_exists',
          `reverse outline ${record.outline_id} already exists in project ${record.input_pin.project_id}`,
        )
      }
      const revision = this.appendProjectRecord(
        record.input_pin.project_id,
        input.expected_revision,
        'reverse_outline',
        record.outline_id,
        record.input_pin.document_id,
        record,
      )
      return this.getReverseOutline(record.input_pin.project_id, record.outline_id, revision)
    })
  }

  getReverseOutline(
    projectId: string,
    outlineId: string,
    knownStreamRevision?: number,
  ): MethodologyRecordView<ReverseOutlineValue> {
    return this.getProjectRecord(
      projectId,
      'reverse_outline',
      outlineId,
      ReverseOutline,
      'methodology_reverse_outline_not_found',
      'reverse outline',
      knownStreamRevision,
    )
  }

  listReverseOutlines(projectId: string): MethodologyRecordList<ReverseOutlineValue> {
    return this.listProjectRecords(projectId, 'reverse_outline', ReverseOutline)
  }

  recordReviewFinding(rawInput: ReviewFindingWrite): MethodologyRecordView<ReviewFindingValue> {
    const input = ReviewFindingWrite.parse(rawInput)
    const record = input.record
    return this.transaction(() => {
      this.assertProjectCas(record.input_pin.project_id, input.expected_revision)
      if (this.projectRows(record.input_pin.project_id, 'review_finding', record.finding_id).length !== 0) {
        throw new MethodologyStoreError(
          409,
          'methodology_review_finding_exists',
          `review finding ${record.finding_id} already exists in project ${record.input_pin.project_id}`,
        )
      }
      const revision = this.appendProjectRecord(
        record.input_pin.project_id,
        input.expected_revision,
        'review_finding',
        record.finding_id,
        record.input_pin.document_id,
        record,
      )
      return this.getReviewFinding(record.input_pin.project_id, record.finding_id, revision)
    })
  }

  getReviewFinding(
    projectId: string,
    findingId: string,
    knownStreamRevision?: number,
  ): MethodologyRecordView<ReviewFindingValue> {
    return this.getProjectRecord(
      projectId,
      'review_finding',
      findingId,
      ReviewFinding,
      'methodology_review_finding_not_found',
      'review finding',
      knownStreamRevision,
    )
  }

  listReviewFindings(projectId: string): MethodologyRecordList<ReviewFindingValue> {
    return this.listProjectRecords(projectId, 'review_finding', ReviewFinding)
  }

  assessWriting(rawInput: WritingProjectionInput): MethodologyWritingProjection {
    const input = WritingProjectionInput.parse(rawInput)
    const outline = this.getReverseOutline(input.project_id, input.outline_id)
    const findings: ReviewFindingValue[] = input.finding_ids === undefined
      ? this.listReviewFindings(input.project_id).records
        .map(item => item.record)
        .filter(record => record.input_pin.document_id === outline.record.input_pin.document_id)
      : input.finding_ids.map(findingId => this.getReviewFinding(input.project_id, findingId).record)
    const currentInput: WritingInputPinValue = input.current_input
    const claimEvidence: ClaimEvidenceBindingValue[] = input.claim_evidence
    return {
      revision: this.projectRevision(input.project_id),
      ...assessWritingMethodology({
        project_id: input.project_id,
        current_input: currentInput,
        outline: outline.record,
        findings,
        claim_evidence: claimEvidence,
      }),
    }
  }
}
