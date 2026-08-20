/**
 * Append-only SQLite lifecycle for methodology assurance audits.
 *
 * Audit facts and acceptance decisions are immutable events. The per-project
 * event revision is both the read cursor and the compare-and-swap token for
 * the next write; effective freshness remains a pure verifier concern.
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  AssuranceAudit,
  type AssuranceAudit as AssuranceAuditValue,
  type AssuranceVerificationInput as AssuranceVerificationInputValue,
} from '@dsh-scholar/research-schemas'
import {
  verifyAssurance,
  type AssuranceVerificationReport,
} from './assurance.js'

export const ASSURANCE_DDL = `
CREATE TABLE IF NOT EXISTS assurance_events (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('audit_recorded', 'audit_accepted')),
  audit_id TEXT NOT NULL,
  audit_json TEXT,
  findings_artifact_id TEXT,
  actor_ref TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision),
  UNIQUE (project_id, audit_id, event_type),
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (project_id, findings_artifact_id)
    REFERENCES artifacts(project_id, artifact_id),
  CHECK (
    (event_type = 'audit_recorded'
      AND audit_json IS NOT NULL
      AND findings_artifact_id IS NOT NULL
      AND actor_ref IS NULL)
    OR
    (event_type = 'audit_accepted'
      AND audit_json IS NULL
      AND findings_artifact_id IS NULL
      AND actor_ref IS NOT NULL)
  ),
  CHECK (
    event_type != 'audit_recorded'
    OR CASE WHEN json_valid(audit_json) THEN
      json_extract(audit_json, '$.project_id') = project_id
      AND json_extract(audit_json, '$.audit_id') = audit_id
      AND json_extract(audit_json, '$.findings_artifact_id') = findings_artifact_id
      AND COALESCE(json_extract(audit_json, '$.acceptance_status'), '') != 'accepted'
    ELSE 0 END
  )
);
CREATE INDEX IF NOT EXISTS idx_assurance_events_project_audit
  ON assurance_events(project_id, audit_id, revision);
CREATE TRIGGER IF NOT EXISTS assurance_acceptance_requires_audit
BEFORE INSERT ON assurance_events
WHEN NEW.event_type = 'audit_accepted' AND NOT EXISTS (
  SELECT 1 FROM assurance_events
  WHERE project_id = NEW.project_id
    AND audit_id = NEW.audit_id
    AND event_type = 'audit_recorded'
)
BEGIN
  SELECT RAISE(ABORT, 'assurance_acceptance_audit_missing');
END;
CREATE TRIGGER IF NOT EXISTS assurance_events_no_update
BEFORE UPDATE ON assurance_events
BEGIN
  SELECT RAISE(ABORT, 'assurance_events_append_only');
END;
CREATE TRIGGER IF NOT EXISTS assurance_events_no_delete
BEFORE DELETE ON assurance_events
BEGIN
  SELECT RAISE(ABORT, 'assurance_events_append_only');
END;
`

export class AssuranceStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AssuranceStoreError'
  }
}

export interface AssuranceAuditView {
  project_id: string
  /** Current revision of the project's complete assurance event stream. */
  revision: number
  recorded_revision: number
  acceptance_revision: number | null
  accepted_by: string | null
  accepted_at: string | null
  audit: AssuranceAuditValue
}

export interface AssuranceAuditList {
  project_id: string
  revision: number
  audits: AssuranceAuditView[]
}

export interface RecordAssuranceAuditInput {
  audit: AssuranceAuditValue
  expected_revision: number
}

export interface AcceptAssuranceAuditInput {
  project_id: string
  audit_id: string
  expected_revision: number
  accepted_by: string
}

export type AssuranceProjectInput = Omit<AssuranceVerificationInputValue, 'audits'>
export type AssuranceProjectProjection = AssuranceVerificationReport & { revision: number }

interface AuditRow {
  project_id: string
  recorded_revision: number
  audit_json: string
  acceptance_revision: number | null
  accepted_by: string | null
  accepted_at: string | null
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AssuranceStoreError(422, 'assurance_revision_invalid', 'expected_revision must be a non-negative safe integer')
  }
}

export class AssuranceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

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
      throw new AssuranceStoreError(404, 'assurance_project_not_found', `project ${projectId} not found`)
    }
  }

  private revision(projectId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(revision), 0) AS revision FROM assurance_events WHERE project_id = ?',
    ).get(projectId) as { revision: number }
    return row.revision
  }

  private assertCas(projectId: string, expected: number): number {
    assertRevision(expected)
    const current = this.revision(projectId)
    if (current !== expected) {
      throw new AssuranceStoreError(
        409,
        'assurance_revision_conflict',
        `project ${projectId} assurance revision ${current} does not match expected ${expected}`,
      )
    }
    return current
  }

  private rows(projectId: string, auditId?: string): AuditRow[] {
    const where = auditId === undefined
      ? "recorded.project_id = ? AND recorded.event_type = 'audit_recorded'"
      : "recorded.project_id = ? AND recorded.audit_id = ? AND recorded.event_type = 'audit_recorded'"
    return this.db.prepare(`
      SELECT
        recorded.project_id,
        recorded.revision AS recorded_revision,
        recorded.audit_json,
        accepted.revision AS acceptance_revision,
        accepted.actor_ref AS accepted_by,
        accepted.created_at AS accepted_at
      FROM assurance_events AS recorded
      LEFT JOIN assurance_events AS accepted
        ON accepted.project_id = recorded.project_id
       AND accepted.audit_id = recorded.audit_id
       AND accepted.event_type = 'audit_accepted'
      WHERE ${where}
      ORDER BY recorded.revision
    `).all(...(auditId === undefined ? [projectId] : [projectId, auditId])) as unknown as AuditRow[]
  }

  private view(row: AuditRow, revision: number): AssuranceAuditView {
    const recorded = AssuranceAudit.parse(JSON.parse(row.audit_json) as unknown)
    return {
      project_id: row.project_id,
      revision,
      recorded_revision: row.recorded_revision,
      acceptance_revision: row.acceptance_revision,
      accepted_by: row.accepted_by,
      accepted_at: row.accepted_at,
      audit: row.acceptance_revision === null
        ? recorded
        : { ...recorded, acceptance_status: 'accepted' },
    }
  }

  record(input: RecordAssuranceAuditInput): AssuranceAuditView {
    const parsed = AssuranceAudit.parse(input.audit)
    if (parsed.acceptance_status === 'accepted') {
      throw new AssuranceStoreError(
        422,
        'assurance_acceptance_requires_accept',
        'accepted assurance status must be recorded through accept()',
      )
    }
    return this.transaction(() => {
      this.assertProject(parsed.project_id)
      const current = this.assertCas(parsed.project_id, input.expected_revision)
      if (this.db.prepare(
        'SELECT 1 FROM artifacts WHERE project_id = ? AND artifact_id = ?',
      ).get(parsed.project_id, parsed.findings_artifact_id) === undefined) {
        throw new AssuranceStoreError(
          422,
          'assurance_findings_artifact_not_found',
          `findings artifact ${parsed.findings_artifact_id} not found in project ${parsed.project_id}`,
        )
      }
      if (this.db.prepare(
        "SELECT 1 FROM assurance_events WHERE project_id = ? AND audit_id = ? AND event_type = 'audit_recorded'",
      ).get(parsed.project_id, parsed.audit_id) !== undefined) {
        throw new AssuranceStoreError(409, 'assurance_audit_exists', `audit ${parsed.audit_id} already exists`)
      }
      const currentOfKind = this.rows(parsed.project_id)
        .map(row => AssuranceAudit.parse(JSON.parse(row.audit_json) as unknown))
        .filter(audit => audit.audit_kind === parsed.audit_kind)
        .at(-1)
      if (currentOfKind !== undefined && parsed.supersedes === undefined) {
        throw new AssuranceStoreError(
          422,
          'assurance_supersedes_required',
          `audit ${parsed.audit_id} must supersede current ${parsed.audit_kind} audit ${currentOfKind.audit_id}`,
        )
      }
      if (currentOfKind !== undefined && parsed.supersedes !== currentOfKind.audit_id) {
        throw new AssuranceStoreError(
          409,
          'assurance_supersedes_conflict',
          `audit ${parsed.supersedes} is not the current ${parsed.audit_kind} audit`,
        )
      }
      if (parsed.supersedes !== undefined) {
        const superseded = this.db.prepare(
          "SELECT audit_json FROM assurance_events WHERE project_id = ? AND audit_id = ? AND event_type = 'audit_recorded'",
        ).get(parsed.project_id, parsed.supersedes) as { audit_json: string } | undefined
        if (superseded === undefined) {
          throw new AssuranceStoreError(
            422,
            'assurance_superseded_audit_not_found',
            `superseded audit ${parsed.supersedes} not found in project ${parsed.project_id}`,
          )
        }
        if (AssuranceAudit.parse(JSON.parse(superseded.audit_json) as unknown).audit_kind !== parsed.audit_kind) {
          throw new AssuranceStoreError(
            422,
            'assurance_superseded_kind_mismatch',
            `audit ${parsed.audit_id} cannot supersede a different audit kind`,
          )
        }
      }
      const next = current + 1
      this.db.prepare(`
        INSERT INTO assurance_events
          (project_id, revision, event_type, audit_id, audit_json, findings_artifact_id, actor_ref, created_at)
        VALUES (?, ?, 'audit_recorded', ?, ?, ?, NULL, ?)
      `).run(
        parsed.project_id,
        next,
        parsed.audit_id,
        JSON.stringify(parsed),
        parsed.findings_artifact_id,
        this.now(),
      )
      return this.get(parsed.project_id, parsed.audit_id)
    })
  }

  accept(input: AcceptAssuranceAuditInput): AssuranceAuditView {
    if (input.accepted_by.length < 1 || input.accepted_by.length > 256) {
      throw new AssuranceStoreError(422, 'assurance_acceptor_invalid', 'accepted_by must contain 1 to 256 characters')
    }
    return this.transaction(() => {
      this.assertProject(input.project_id)
      const current = this.assertCas(input.project_id, input.expected_revision)
      const existing = this.get(input.project_id, input.audit_id)
      if (existing.acceptance_revision !== null) {
        throw new AssuranceStoreError(409, 'assurance_audit_already_accepted', `audit ${input.audit_id} is already accepted`)
      }
      const currentOfKind = this.list(input.project_id).audits
        .filter(item => item.audit.audit_kind === existing.audit.audit_kind)
        .at(-1)
      if (currentOfKind?.audit.audit_id !== input.audit_id) {
        throw new AssuranceStoreError(
          409,
          'assurance_audit_superseded',
          `audit ${input.audit_id} is no longer the current ${existing.audit.audit_kind} audit`,
        )
      }
      const next = current + 1
      this.db.prepare(`
        INSERT INTO assurance_events
          (project_id, revision, event_type, audit_id, audit_json, findings_artifact_id, actor_ref, created_at)
        VALUES (?, ?, 'audit_accepted', ?, NULL, NULL, ?, ?)
      `).run(input.project_id, next, input.audit_id, input.accepted_by, this.now())
      return this.get(input.project_id, input.audit_id)
    })
  }

  list(projectId: string): AssuranceAuditList {
    this.assertProject(projectId)
    const revision = this.revision(projectId)
    return {
      project_id: projectId,
      revision,
      audits: this.rows(projectId).map(row => this.view(row, revision)),
    }
  }

  get(projectId: string, auditId: string): AssuranceAuditView {
    this.assertProject(projectId)
    const revision = this.revision(projectId)
    const [row] = this.rows(projectId, auditId)
    if (row === undefined) {
      throw new AssuranceStoreError(404, 'assurance_audit_not_found', `audit ${auditId} not found in project ${projectId}`)
    }
    return this.view(row, revision)
  }

  project(input: AssuranceProjectInput): AssuranceProjectProjection {
    const listed = this.list(input.project_id)
    const currentByKind = new Map<AssuranceAuditValue['audit_kind'], AssuranceAuditValue>()
    for (const item of listed.audits) currentByKind.set(item.audit.audit_kind, item.audit)
    return {
      revision: listed.revision,
      ...verifyAssurance({ ...input, audits: [...currentByKind.values()] }),
    }
  }
}
