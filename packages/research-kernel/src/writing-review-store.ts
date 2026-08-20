/** Append-only persistence for writing-methodology diagnostics and proposals. */

import type { DatabaseSync } from 'node:sqlite'
import {
  MethodTriad,
  MethodTriadDiagnostic,
  SectionGuideActivation,
  WritingPatchApplication,
  WritingPatchProposal,
  WritingReviewerPanelAggregate,
  type MethodTriad as MethodTriadValue,
  type MethodTriadDiagnostic as MethodTriadDiagnosticValue,
  type SectionGuideActivation as SectionGuideActivationValue,
  type WritingPatchApplication as WritingPatchApplicationValue,
  type WritingPatchProposal as WritingPatchProposalValue,
  type WritingReviewerPanelAggregate as WritingReviewerPanelAggregateValue,
} from '@dsh-scholar/research-schemas'

export const WRITING_REVIEW_DDL = `
CREATE TABLE IF NOT EXISTS writing_methodology_events (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN (
    'method_triad', 'section_guide', 'reviewer_panel', 'patch_proposal', 'patch_application'
  )),
  record_id TEXT NOT NULL,
  parent_id TEXT,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision),
  UNIQUE (project_id, event_kind, record_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id)
);
CREATE INDEX IF NOT EXISTS idx_writing_methodology_kind
  ON writing_methodology_events(project_id, event_kind, revision);
CREATE UNIQUE INDEX IF NOT EXISTS idx_writing_patch_application_once
  ON writing_methodology_events(project_id, parent_id)
  WHERE event_kind = 'patch_application';
CREATE TRIGGER IF NOT EXISTS writing_methodology_revision_sequence
BEFORE INSERT ON writing_methodology_events
WHEN NEW.revision != COALESCE((
  SELECT MAX(revision) FROM writing_methodology_events WHERE project_id = NEW.project_id
), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'writing_methodology_revision_sequence');
END;
CREATE TRIGGER IF NOT EXISTS writing_methodology_no_update
BEFORE UPDATE ON writing_methodology_events
BEGIN
  SELECT RAISE(ABORT, 'writing_methodology_append_only');
END;
CREATE TRIGGER IF NOT EXISTS writing_methodology_no_delete
BEFORE DELETE ON writing_methodology_events
BEGIN
  SELECT RAISE(ABORT, 'writing_methodology_append_only');
END;
`

export class WritingReviewStoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'WritingReviewStoreError'
  }
}

export interface WritingReviewRecordView<T> {
  project_id: string
  stream_revision: number
  recorded_revision: number
  record: T
}

export interface WritingReviewRecordList<T> {
  project_id: string
  stream_revision: number
  records: Array<WritingReviewRecordView<T>>
}

export interface StoredMethodTriad {
  triad: MethodTriadValue
  diagnostic: MethodTriadDiagnosticValue
}

type WritingEventKind = 'method_triad' | 'section_guide' | 'reviewer_panel' | 'patch_proposal' | 'patch_application'
interface Row { project_id: string; revision: number; record_json: string }
interface Parser<T> { parse(value: unknown): T }

const StoredMethodTriadParser = {
  parse(value: unknown): StoredMethodTriad {
    if (typeof value !== 'object' || value === null) throw new TypeError('stored MethodTriad must be an object')
    const raw = value as Record<string, unknown>
    const keys = Object.keys(raw).sort()
    if (keys.join(',') !== 'diagnostic,triad') throw new TypeError('stored MethodTriad contains unknown fields')
    const triad = MethodTriad.parse(raw.triad)
    const diagnostic = MethodTriadDiagnostic.parse(raw.diagnostic)
    if (triad.triad_id !== diagnostic.triad_id || JSON.stringify(triad.input_pin) !== JSON.stringify(diagnostic.input_pin)) {
      throw new TypeError('MethodTriad diagnostic pin mismatch')
    }
    return { triad, diagnostic }
  },
}

export class WritingReviewStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(WRITING_REVIEW_DDL)
  }

  private assertProject(projectId: string): void {
    if (this.db.prepare('SELECT 1 FROM projects WHERE project_id = ?').get(projectId) === undefined) {
      throw new WritingReviewStoreError(404, 'writing_project_not_found', `project ${projectId} not found`)
    }
  }

  revision(projectId: string): number {
    this.assertProject(projectId)
    const row = this.db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM writing_methodology_events WHERE project_id = ?')
      .get(projectId) as { revision: number }
    return row.revision
  }

  assertRevision(projectId: string, expectedRevision: number): number {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new WritingReviewStoreError(422, 'writing_revision_invalid', 'expected writing revision must be a nonnegative safe integer')
    }
    const current = this.revision(projectId)
    if (current !== expectedRevision) {
      throw new WritingReviewStoreError(409, 'writing_revision_conflict', `project ${projectId} writing revision ${current} does not match expected ${expectedRevision}`)
    }
    return current
  }

  private rows(projectId: string, kind: WritingEventKind, recordId?: string): Row[] {
    this.assertProject(projectId)
    return (recordId === undefined
      ? this.db.prepare('SELECT project_id, revision, record_json FROM writing_methodology_events WHERE project_id = ? AND event_kind = ? ORDER BY revision').all(projectId, kind)
      : this.db.prepare('SELECT project_id, revision, record_json FROM writing_methodology_events WHERE project_id = ? AND event_kind = ? AND record_id = ? ORDER BY revision').all(projectId, kind, recordId)
    ) as unknown as Row[]
  }

  private list<T>(projectId: string, kind: WritingEventKind, parser: Parser<T>): WritingReviewRecordList<T> {
    const revision = this.revision(projectId)
    return {
      project_id: projectId,
      stream_revision: revision,
      records: this.rows(projectId, kind).map(row => ({
        project_id: projectId,
        stream_revision: revision,
        recorded_revision: row.revision,
        record: parser.parse(JSON.parse(row.record_json)),
      })),
    }
  }

  private get<T>(projectId: string, kind: WritingEventKind, recordId: string, parser: Parser<T>, code: string): WritingReviewRecordView<T> {
    const rows = this.rows(projectId, kind, recordId)
    const row = rows.at(-1)
    if (row === undefined) throw new WritingReviewStoreError(404, code, `${kind} ${recordId} not found`)
    const revision = this.revision(projectId)
    return { project_id: projectId, stream_revision: revision, recorded_revision: row.revision, record: parser.parse(JSON.parse(row.record_json)) }
  }

  private append<T>(input: {
    project_id: string
    expected_revision: number
    kind: WritingEventKind
    record_id: string
    parent_id?: string | null
    record: T
  }): WritingReviewRecordView<T> {
    const current = this.assertRevision(input.project_id, input.expected_revision)
    const next = current + 1
    try {
      this.db.prepare(`INSERT INTO writing_methodology_events
        (project_id, revision, event_kind, record_id, parent_id, record_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(input.project_id, next, input.kind, input.record_id, input.parent_id ?? null, JSON.stringify(input.record), new Date().toISOString())
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) {
        throw new WritingReviewStoreError(409, 'writing_record_conflict', `${input.kind} ${input.record_id} already exists`)
      }
      throw error
    }
    return { project_id: input.project_id, stream_revision: next, recorded_revision: next, record: input.record }
  }

  recordMethodTriad(projectId: string, record: StoredMethodTriad, expectedRevision: number): WritingReviewRecordView<StoredMethodTriad> {
    const parsed = StoredMethodTriadParser.parse(record)
    if (parsed.triad.input_pin.project_id !== projectId) throw new WritingReviewStoreError(422, 'writing_project_mismatch', 'MethodTriad belongs to another project')
    return this.append({ project_id: projectId, expected_revision: expectedRevision, kind: 'method_triad', record_id: parsed.triad.triad_id, parent_id: parsed.triad.input_pin.document_id, record: parsed })
  }

  listMethodTriads(projectId: string): WritingReviewRecordList<StoredMethodTriad> {
    return this.list(projectId, 'method_triad', StoredMethodTriadParser)
  }

  recordSectionGuide(record: SectionGuideActivationValue, expectedRevision: number): WritingReviewRecordView<SectionGuideActivationValue> {
    const parsed = SectionGuideActivation.parse(record)
    return this.append({ project_id: parsed.input_pin.project_id, expected_revision: expectedRevision, kind: 'section_guide', record_id: parsed.activation_id, parent_id: parsed.input_pin.document_id, record: parsed })
  }

  listSectionGuides(projectId: string): WritingReviewRecordList<SectionGuideActivationValue> {
    return this.list(projectId, 'section_guide', SectionGuideActivation)
  }

  recordReviewerPanel(record: WritingReviewerPanelAggregateValue, expectedRevision: number): WritingReviewRecordView<WritingReviewerPanelAggregateValue> {
    const parsed = WritingReviewerPanelAggregate.parse(record)
    return this.append({ project_id: parsed.input_pin.project_id, expected_revision: expectedRevision, kind: 'reviewer_panel', record_id: parsed.aggregate_id, parent_id: parsed.panel_id, record: parsed })
  }

  listReviewerPanels(projectId: string): WritingReviewRecordList<WritingReviewerPanelAggregateValue> {
    return this.list(projectId, 'reviewer_panel', WritingReviewerPanelAggregate)
  }

  getReviewerPanel(projectId: string, aggregateId: string): WritingReviewRecordView<WritingReviewerPanelAggregateValue> {
    return this.get(projectId, 'reviewer_panel', aggregateId, WritingReviewerPanelAggregate, 'writing_reviewer_panel_not_found')
  }

  recordPatchProposal(record: WritingPatchProposalValue, expectedRevision: number): WritingReviewRecordView<WritingPatchProposalValue> {
    const parsed = WritingPatchProposal.parse(record)
    return this.append({ project_id: parsed.project_id, expected_revision: expectedRevision, kind: 'patch_proposal', record_id: parsed.proposal_id, parent_id: parsed.aggregate_id, record: parsed })
  }

  listPatchProposals(projectId: string): WritingReviewRecordList<WritingPatchProposalValue> {
    return this.list(projectId, 'patch_proposal', WritingPatchProposal)
  }

  getPatchProposal(projectId: string, proposalId: string): WritingReviewRecordView<WritingPatchProposalValue> {
    return this.get(projectId, 'patch_proposal', proposalId, WritingPatchProposal, 'writing_patch_not_found')
  }

  recordPatchApplication(record: WritingPatchApplicationValue, expectedRevision: number): WritingReviewRecordView<WritingPatchApplicationValue> {
    const parsed = WritingPatchApplication.parse(record)
    return this.append({ project_id: parsed.project_id, expected_revision: expectedRevision, kind: 'patch_application', record_id: parsed.application_id, parent_id: parsed.proposal_id, record: parsed })
  }

  listPatchApplications(projectId: string): WritingReviewRecordList<WritingPatchApplicationValue> {
    return this.list(projectId, 'patch_application', WritingPatchApplication)
  }
}
