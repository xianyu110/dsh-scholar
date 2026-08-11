/**
 * Explicit, ordered, idempotent schema migrations (storage-migrations.md §8).
 *
 * Every migration has a stable id, a canonical body used for its checksum,
 * and an `up` step that runs inside a transaction. `schema_migrations`
 * records (id, checksum, applied_at, report_json); re-running the same
 * id+checksum is a no-op, a different checksum is a loud fail (released
 * migrations are immutable), and the schema_version meta key is only bumped
 * after every step succeeds. Downgrades are explicit scripts only.
 * @module @dsh-scholar/research-kernel/migrations
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { PTY_DDL, PTY_SESSIONS_TABLE_DDL } from './pty-session.js'
import { WORKSPACE_DDL } from './workspace-store.js'
import { INTAKE_DDL } from './intake.js'
import { TRAJECTORY_DDL } from './trajectory.js'

/** Code-side schema version; bumped only when the migration set grows. */
export const SCHEMA_VERSION = 13

export interface MigrationReport {
  /** Row counts per affected table (legacy import steps). */
  rows?: Record<string, number>
  notes?: string[]
}

export interface Migration {
  id: string
  description: string
  /** Canonical source text for the checksum (SQL text, or the `up` source). */
  body: string
  up: (db: DatabaseSync, report: MigrationReport) => void
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Stable checksum of a migration: id + canonical body. */
export function checksumOf(m: Migration): string {
  return sha256(`${m.id}\n${m.body}`)
}

/** Add a column to an existing table if absent (additive migrations). */
export function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }
}

/** Terminal frames (§4): append-only, monotonic seq, bounded retention. */
export const TERMINAL_DDL = `
CREATE TABLE IF NOT EXISTS terminal_frames (
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  stream_seq INTEGER,
  channel TEXT,
  text TEXT,
  byte_offset INTEGER,
  byte_length INTEGER,
  frame_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  lease_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, run_id, seq),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id),
  CHECK (frame_kind IN ('chunk','gap','exit')),
  CHECK (channel IS NULL OR channel IN ('stdout','stderr')),
  CHECK (
    (frame_kind = 'chunk' AND channel IS NOT NULL AND stream_seq IS NOT NULL AND text IS NOT NULL AND byte_offset IS NOT NULL AND byte_length IS NOT NULL)
    OR
    (frame_kind IN ('gap','exit') AND channel IS NULL AND stream_seq IS NULL AND text IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_terminal_job_seq ON terminal_frames(job_id, seq);
CREATE TABLE IF NOT EXISTS terminal_retention (
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  retained_from_seq INTEGER NOT NULL DEFAULT 1,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  dropped_bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  PRIMARY KEY (job_id, run_id)
);
`

/**
 * TeX workspace tables (§5). Also owned by tex-workspace.ts on its own WAL
 * connection; CREATE IF NOT EXISTS keeps both connections in sync.
 */
export const TEX_DDL = `
CREATE TABLE IF NOT EXISTS tex_documents (
  document_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_file TEXT NOT NULL DEFAULT 'paper.tex',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tex_files (
  document_id TEXT NOT NULL,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, path)
);
CREATE INDEX IF NOT EXISTS idx_tex_files_doc ON tex_files(document_id);
CREATE TABLE IF NOT EXISTS tex_snapshots (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, revision)
);
-- TEX-01 (§4 row 95): frozen, materializable snapshot bytes (parity with the
-- tex-workspace SCHEMA — the Runner compiles these revision-scoped bytes).
CREATE TABLE IF NOT EXISTS tex_snapshot_files (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (document_id, revision, path)
);
CREATE INDEX IF NOT EXISTS idx_tex_snapshot_files_doc ON tex_snapshot_files(document_id, revision);
CREATE TABLE IF NOT EXISTS tex_builds (
  build_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  root_file TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL,
  diagnostics TEXT NOT NULL DEFAULT '[]',
  pdf_artifact TEXT,
  log_artifact TEXT,
  -- TEX-03 (§4 row 96 / execution-runtime.md §12.1): preview flag +
  -- supersede linkage for live preview builds (parity with tex-workspace.ts).
  preview INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tex_builds_doc ON tex_builds(document_id);
-- TEX-03: durable debounced preview request (survives kernel restarts).
CREATE TABLE IF NOT EXISTS tex_preview_pending (
  document_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  root_file TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'pdflatex',
  debounce_ms INTEGER NOT NULL DEFAULT 800,
  requested_at TEXT NOT NULL
);
`

/**
 * 0001 — the full v2 initial schema for an empty database. Kept idempotent
 * (IF NOT EXISTS) so it is also a safe no-op on databases that already
 * carry the v2-preview shape.
 */
const SCHEMA_V2_INITIAL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  brief TEXT NOT NULL,
  constraints TEXT NOT NULL,
  execution TEXT NOT NULL,
  integrity TEXT NOT NULL,
  session_id TEXT,
  dsh_workspace_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  history TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS gates (
  gate_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  dsh_session_id TEXT,
  dsh_event_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  gate_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  diff TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  event_id TEXT,
  decided_at TEXT NOT NULL,
  -- v2 §6.4 authenticated principal (hardening GOV-01): durable identity of
  -- the human operator behind the decision; NULL for legacy rows.
  principal_id TEXT,
  principal_tenant_id TEXT,
  principal_auth_method TEXT,
  principal_session_id TEXT
);
CREATE TABLE IF NOT EXISTS ideas (
  idea_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contracts (
  contract_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS corpus_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, artifact_id)
);
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  contract_id TEXT,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  command TEXT NOT NULL DEFAULT '[]',
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  failure_class TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  lease_generation INTEGER,
  -- §12.2 JobSpec binding (SCH-EXEC-002): code snapshot materialized by the
  -- Runner from CAS; image_digest/output_contract/data_artifact_ids live in
  -- payload (see ResearchKernel.submitJob).
  code_snapshot_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_manifest TEXT,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runner_keys (
  key_id TEXT PRIMARY KEY,
  public_key_pem TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL,
  provenance_status TEXT NOT NULL DEFAULT 'legacy_unverified',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'kernel',
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_links (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  linked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS budget (
  project_id TEXT PRIMARY KEY,
  model_cost_usd REAL NOT NULL DEFAULT 0,
  gpu_hours REAL NOT NULL DEFAULT 0,
  api_requests INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manuscripts (
  manuscript_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
${TERMINAL_DDL}
CREATE INDEX IF NOT EXISTS idx_gates_project ON gates(project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
-- v2 §3.4 invariant 2: idempotency_key is unique per (project_id, idempotency_key).
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_project_idempotency ON jobs(project_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
CREATE INDEX IF NOT EXISTS idx_ideas_project ON ideas(project_id);
CREATE INDEX IF NOT EXISTS idx_contracts_project ON contracts(project_id);
CREATE INDEX IF NOT EXISTS idx_claims_project ON claims(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id);
`

/**
 * v2 §7.4: artifacts become PROJECT-SCOPED references (the legacy table had
 * artifact_id as the GLOBAL primary key, so the same ID could be reused
 * across projects). Rebuild with a composite PK; colliding IDs get a
 * project-suffixed regeneration so no project loses a record.
 */
function rebuildArtifactsProjectScoped(db: DatabaseSync, report: MigrationReport): void {
  const info = db.prepare(`PRAGMA table_info('artifacts')`).all() as unknown as Array<{ pk: number; name: string }>
  const pkCount = info.filter(c => c.pk > 0).length
  if (pkCount >= 2) return
  const rows = db.prepare('SELECT artifact_id, project_id, kind, size_bytes, sha256, metadata, created_at FROM artifacts').all() as unknown as Array<{
    artifact_id: string; project_id: string; kind: string; size_bytes: number; sha256: string; metadata: string; created_at: string
  }>
  db.exec(`
    DROP TABLE IF EXISTS artifacts_v2;
    CREATE TABLE artifacts_v2 (
      artifact_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, artifact_id)
    );
  `)
  const insert = db.prepare('INSERT INTO artifacts_v2 (artifact_id, project_id, kind, size_bytes, sha256, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const seen = new Set<string>()
  let reborn = 0
  for (const row of rows) {
    let id = row.artifact_id
    const key = `${row.project_id}\u0000${id}`
    if (seen.has(key)) {
      id = `${id}~${sha256(row.project_id).slice(0, 8)}`
      reborn += 1
    }
    seen.add(`${row.project_id}\u0000${id}`)
    insert.run(id, row.project_id, row.kind, row.size_bytes, row.sha256, row.metadata, row.created_at)
  }
  db.exec('DROP TABLE artifacts; ALTER TABLE artifacts_v2 RENAME TO artifacts;')
  if (report.rows === undefined) report.rows = {}
  report.rows.artifacts_migrated = rows.length
  if (reborn > 0) {
    if (report.notes === undefined) report.notes = []
    report.notes.push(`${reborn} cross-project artifact id(s) regenerated with a project suffix`)
  }
}

/**
 * v2 §3.4/§7.2: the v1.5 jobs table carried a GLOBAL unique constraint on
 * idempotency_key, breaking project-scoped idempotency. Rebuild the table
 * (copy -> verify -> atomic rename) when such an index exists; pure v1
 * (3da1392) never had one and is left untouched.
 */
function rebuildJobsProjectScopedUnique(db: DatabaseSync, report: MigrationReport): void {
  const indexes = db.prepare(`PRAGMA index_list('jobs')`).all() as unknown as Array<{ name: string; unique: number; origin: string }>
  const globalUnique = indexes.some(idx => idx.unique === 1 && idx.origin !== 'pk' && idx.name !== 'idx_jobs_project_idempotency')
  if (!globalUnique) return
  const count = (db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n
  db.exec(`
    DROP TABLE IF EXISTS jobs_v2;
    CREATE TABLE jobs_v2 (
      job_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      contract_id TEXT,
      idempotency_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '[]',
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      failure_class TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      run_manifest TEXT,
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      code_snapshot_id TEXT,
      UNIQUE(project_id, idempotency_key)
    );
    INSERT INTO jobs_v2 (job_id, project_id, contract_id, idempotency_key, kind, command, payload, status, failure_class, lease_owner, lease_expires_at, heartbeat_at, attempts, max_attempts, run_manifest, error, created_at, updated_at, lease_generation, code_snapshot_id)
      SELECT job_id, project_id, contract_id, idempotency_key, kind, command, payload, status, failure_class, lease_owner, lease_expires_at, heartbeat_at, attempts, max_attempts, run_manifest, error, created_at, updated_at, COALESCE(lease_generation, 0), code_snapshot_id FROM jobs;
    DROP TABLE jobs;
    ALTER TABLE jobs_v2 RENAME TO jobs;
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_project_idempotency ON jobs(project_id, idempotency_key);
  `)
  if (report.rows === undefined) report.rows = {}
  report.rows.jobs_migrated = count
}

/** §9: legacy manuscript strings become the initial TeX workspace document. */
function convertManuscriptsToTex(db: DatabaseSync, report: MigrationReport): void {
  db.exec(TEX_DDL)
  const rows = db.prepare('SELECT manuscript_id, project_id, body, created_at FROM manuscripts').all() as unknown as Array<{
    manuscript_id: string; project_id: string; body: string; created_at: string
  }>
  let converted = 0
  for (const m of rows) {
    const existing = db.prepare('SELECT 1 AS x FROM tex_documents WHERE project_id = ?').get(m.project_id)
    if (existing !== undefined) continue
    const docId = `doc_${sha256(m.manuscript_id).slice(0, 12)}`
    const body = typeof m.body === 'string' && m.body.trim() !== '' ? m.body : '\\documentclass{article}\n\\begin{document}\n% legacy manuscript body was empty\n\\end{document}\n'
    const at = m.created_at ?? new Date().toISOString()
    db.prepare('INSERT INTO tex_documents (document_id, project_id, root_file, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
      .run(docId, m.project_id, 'paper.tex', at, at)
    db.prepare('INSERT INTO tex_files (document_id, path, version, content, content_hash, created_at) VALUES (?, ?, 1, ?, ?, ?)')
      .run(docId, 'paper.tex', body, sha256(body), at)
    converted += 1
  }
  if (report.rows === undefined) report.rows = {}
  report.rows.manuscripts_converted = converted
}

/**
 * 0002 — import a legacy v1 database (storage-migrations.md §9): durable
 * decision principal, evidence provenance, project-scoped artifacts/jobs,
 * and manuscript strings → initial TeX workspace. Idempotent: every step
 * detects the legacy shape before acting.
 */
const legacyV1Import = (db: DatabaseSync, report: MigrationReport): void => {
  // §9: decisions gain the durable principal; unprovable identities stay NULL.
  ensureColumn(db, 'decisions', 'principal_id', 'TEXT')
  ensureColumn(db, 'decisions', 'principal_tenant_id', 'TEXT')
  ensureColumn(db, 'decisions', 'principal_auth_method', 'TEXT')
  ensureColumn(db, 'decisions', 'principal_session_id', 'TEXT')
  // §9: existing evidence is legacy_unverified.
  ensureColumn(db, 'evidence', 'provenance_status', "TEXT NOT NULL DEFAULT 'legacy_unverified'")
  db.prepare("UPDATE evidence SET provenance_status = 'legacy_unverified' WHERE provenance_status IS NULL OR provenance_status = ''").run()
  // §9: jobs gain lease fencing + snapshot binding, project-scoped idempotency.
  ensureColumn(db, 'jobs', 'lease_generation', 'INTEGER')
  ensureColumn(db, 'jobs', 'code_snapshot_id', 'TEXT')
  rebuildJobsProjectScopedUnique(db, report)
  // §9: artifacts become project-scoped records.
  rebuildArtifactsProjectScoped(db, report)
  // §9: manuscript strings become the initial TeX workspace document.
  convertManuscriptsToTex(db, report)
}

/**
 * FROZEN terminal-DDL snapshot executed by migration 0003 (STORE-08,
 * storage-migrations.md §8.1). 0003's checksum must bind the DDL it ACTUALLY
 * executes — the shared TERMINAL_DDL/TEX_DDL constants evolve with new
 * capabilities (each delta arrives as its own migration), so a released
 * migration can never reference them by name. The canonical body of 0003
 * embeds THIS text; shared-constant evolution therefore cannot silently
 * change what a released migration does, nor invalidate the checksums
 * recorded on existing databases.
 *
 * Freeze rule: this snapshot is the TeX/terminal shape at the time 0003 was
 * released (0010/0011/0012/0013 later brought tex_preview_pending, pty/
 * workspace, intake and trajectory tables on top of it). It is NEVER edited
 * in place — schema growth goes through new migrations + the live stores'
 * own CREATE IF NOT EXISTS convergence (tex-workspace.ts / pty-session.ts).
 */
const TERMINAL_DDL_0003 = `
CREATE TABLE IF NOT EXISTS terminal_frames (
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  stream_seq INTEGER,
  channel TEXT,
  text TEXT,
  byte_offset INTEGER,
  byte_length INTEGER,
  frame_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  lease_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, run_id, seq),
  FOREIGN KEY (job_id) REFERENCES jobs(job_id),
  CHECK (frame_kind IN ('chunk','gap','exit')),
  CHECK (channel IS NULL OR channel IN ('stdout','stderr')),
  CHECK (
    (frame_kind = 'chunk' AND channel IS NOT NULL AND stream_seq IS NOT NULL AND text IS NOT NULL AND byte_offset IS NOT NULL AND byte_length IS NOT NULL)
    OR
    (frame_kind IN ('gap','exit') AND channel IS NULL AND stream_seq IS NULL AND text IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_terminal_job_seq ON terminal_frames(job_id, seq);
CREATE TABLE IF NOT EXISTS terminal_retention (
  job_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  retained_from_seq INTEGER NOT NULL DEFAULT 1,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  dropped_bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  PRIMARY KEY (job_id, run_id)
);
`

/** FROZEN TeX-DDL snapshot executed by migration 0003 (see TERMINAL_DDL_0003
 * for the freeze rule — STORE-08, storage-migrations.md §8.1). */
const TEX_DDL_0003 = `
CREATE TABLE IF NOT EXISTS tex_documents (
  document_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_file TEXT NOT NULL DEFAULT 'paper.tex',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tex_files (
  document_id TEXT NOT NULL,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, path)
);
CREATE INDEX IF NOT EXISTS idx_tex_files_doc ON tex_files(document_id);
CREATE TABLE IF NOT EXISTS tex_snapshots (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, revision)
);
-- TEX-01 (§4 row 95): frozen, materializable snapshot bytes (parity with the
-- tex-workspace SCHEMA — the Runner compiles these revision-scoped bytes).
CREATE TABLE IF NOT EXISTS tex_snapshot_files (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (document_id, revision, path)
);
CREATE INDEX IF NOT EXISTS idx_tex_snapshot_files_doc ON tex_snapshot_files(document_id, revision);
CREATE TABLE IF NOT EXISTS tex_builds (
  build_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  root_file TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL,
  diagnostics TEXT NOT NULL DEFAULT '[]',
  pdf_artifact TEXT,
  log_artifact TEXT,
  -- TEX-03 (§4 row 96 / execution-runtime.md §12.1): preview flag +
  -- supersede linkage for live preview builds (parity with tex-workspace.ts).
  preview INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tex_builds_doc ON tex_builds(document_id);
-- TEX-03: durable debounced preview request (survives kernel restarts).
CREATE TABLE IF NOT EXISTS tex_preview_pending (
  document_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  root_file TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'pdflatex',
  debounce_ms INTEGER NOT NULL DEFAULT 800,
  requested_at TEXT NOT NULL
);
`

/**
 * 0003 — terminal/TeX/i18n capabilities for databases that were created by
 * the early v2 preview code (SCHEMA_VERSION=1 with implicit column fixes).
 * Idempotent: terminal + TeX tables are CREATE IF NOT EXISTS, and column
 * additions check existence first. On current databases this is a no-op.
 *
 * STORE-08: the executed DDL is the FROZEN snapshot above (never the shared
 * TERMINAL_DDL/TEX_DDL constants), and the canonical `body` embeds that
 * snapshot text — so the recorded checksum binds the actual DDL and shared
 * constant evolution cannot weaken the "released migrations are immutable"
 * guarantee.
 */
const terminalTexCapabilities = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(TERMINAL_DDL_0003)
  db.exec(TEX_DDL_0003)
  ensureColumn(db, 'evidence', 'provenance_status', "TEXT NOT NULL DEFAULT 'legacy_unverified'")
  ensureColumn(db, 'decisions', 'principal_id', 'TEXT')
  ensureColumn(db, 'decisions', 'principal_tenant_id', 'TEXT')
  ensureColumn(db, 'decisions', 'principal_auth_method', 'TEXT')
  ensureColumn(db, 'decisions', 'principal_session_id', 'TEXT')
  ensureColumn(db, 'jobs', 'lease_generation', 'INTEGER')
  ensureColumn(db, 'jobs', 'code_snapshot_id', 'TEXT')
  if (report.rows === undefined) report.rows = {}
  report.rows.capability_tables = 0
}

/**
 * 0007 — project idempotency keys (api-contracts.md §4 /v2): the BFF-scoped
 * Idempotency-Key + request hash are persisted so POST /v2/projects replays
 * return the same project/gate/budget/membership while a different request
 * hash under the same key is a 409.
 */
const projectIdempotencyKeys = (db: DatabaseSync, report: MigrationReport): void => {
  ensureColumn(db, 'projects', 'idempotency_key', 'TEXT')
  ensureColumn(db, 'projects', 'request_hash', 'TEXT')
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_idempotency ON projects(idempotency_key) WHERE idempotency_key IS NOT NULL`)
  if (report.rows === undefined) report.rows = {}
  report.rows.projects = (db.prepare('SELECT COUNT(*) AS n FROM projects WHERE idempotency_key IS NOT NULL').get() as { n: number }).n
}

/**
 * 0006 — project membership (API-01 foundation): creator is seeded as the
 * first PI; roles follow reconstruction-contracts.md (last PI cannot be
 * removed or demoted). BFF route-level enforcement lands with the v2
 * migration; the model + APIs are the durable base.
 */
const projectMembers = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('pi','researcher','operator','auditor','viewer')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, principal_id),
      FOREIGN KEY (project_id) REFERENCES projects(project_id)
    );
    CREATE INDEX IF NOT EXISTS idx_members_project ON project_members(project_id);
  `)
  if (report.rows === undefined) report.rows = {}
  report.rows.project_members = (db.prepare('SELECT COUNT(*) AS n FROM project_members').get() as { n: number }).n
}

/**
 * 0005 — authoritative code_snapshots registry (STORE-02): one row per
 * snapshotCodeArchive() call, binding snapshot_id to its archive/manifest
 * artifacts, source description, content hash, file count and size.
 */
const codeSnapshotRegistry = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      archive_artifact_id TEXT NOT NULL,
      manifest_artifact_id TEXT NOT NULL,
      source_json TEXT NOT NULL DEFAULT '{}',
      sha256 TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_code_snapshots_project ON code_snapshots(project_id, created_at DESC);
  `)
  if (report.rows === undefined) report.rows = {}
  report.rows.code_snapshots = (db.prepare('SELECT COUNT(*) AS n FROM code_snapshots').get() as { n: number }).n
}

/**
 * 0004 — artifact media type (ART-02): RFC 2046 media_type served on GET
 * (pdf artifacts are application/pdf) plus a download file_name. Additive;
 * existing rows keep application/octet-stream / NULL.
 */
const artifactMediaType = (db: DatabaseSync, report: MigrationReport): void => {
  ensureColumn(db, 'artifacts', 'media_type', "TEXT NOT NULL DEFAULT 'application/octet-stream'")
  ensureColumn(db, 'artifacts', 'file_name', 'TEXT')
  if (report.rows === undefined) report.rows = {}
  report.rows.artifacts = (db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n
}

/**
 * 0008 — outbox canonical envelope (reconstruction-contracts.md §16,
 * EVENT-01): the append-only events table becomes a durable outbox with
 * per-aggregate `event_seq`, `event_version`, aggregate identity and
 * request/session tracing plus delivery bookkeeping (attempts/last_error/
 * next_attempt_at/dead_lettered_at). Also adds the §3.1 `runs` table (run
 * identity per job attempt — STORE-01 parity) and the durable principal +
 * issuer columns on session_links. Additive and idempotent: fresh databases
 * and databases created by older releases both converge here.
 */
const outboxEnvelope = (db: DatabaseSync, report: MigrationReport): void => {
  // §16 outbox columns (additive; pre-existing rows keep NULLs except the
  // NOT NULL defaults, and event_seq is backfilled below).
  ensureColumn(db, 'events', 'event_seq', 'INTEGER')
  ensureColumn(db, 'events', 'event_version', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn(db, 'events', 'aggregate_type', 'TEXT')
  ensureColumn(db, 'events', 'aggregate_id', 'TEXT')
  ensureColumn(db, 'events', 'aggregate_revision', 'INTEGER')
  ensureColumn(db, 'events', 'request_id', 'TEXT')
  ensureColumn(db, 'events', 'session_id', 'TEXT')
  ensureColumn(db, 'events', 'attempts', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'events', 'last_error', 'TEXT')
  ensureColumn(db, 'events', 'next_attempt_at', 'TEXT')
  ensureColumn(db, 'events', 'dead_lettered_at', 'TEXT')
  // Backfill event_seq for rows written before the outbox envelope (one-time
  // and idempotent: only NULL seqs are touched). Ordering by (created_at,
  // event_id) keeps replays stable across re-runs.
  const rows = db.prepare('SELECT event_id FROM events WHERE event_seq IS NULL ORDER BY created_at, event_id')
    .all() as unknown as Array<{ event_id: string }>
  const updateSeq = db.prepare('UPDATE events SET event_seq = ? WHERE event_id = ?')
  let seq = (db.prepare('SELECT COALESCE(MAX(event_seq), 0) AS m FROM events').get() as { m: number }).m
  for (const row of rows) {
    seq += 1
    updateSeq.run(seq, row.event_id)
  }
  // §16: same-aggregate revisions are ordered by event_seq (per-aggregate
  // monotonic; NULL aggregates are their own bucket — SQLite treats NULLs as
  // distinct in unique indexes, and the kernel allocates max+1 per bucket).
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_aggregate_seq ON events(aggregate_type, aggregate_id, event_seq)')
  // §3.1 parity (STORE-01): runs identity per job attempt; the doc creates
  // one row at claim time and keeps every retry attempt.
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
      contract_id TEXT,
      snapshot_sha256 TEXT NOT NULL,
      manifest_json TEXT,
      signature_status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE (job_id, attempt_no)
    );
    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id);
  `)
  // §3.1 parity: session_links carry the durable principal + issuer (NULL for
  // legacy rows whose identity cannot be proven).
  ensureColumn(db, 'session_links', 'principal_id', 'TEXT')
  ensureColumn(db, 'session_links', 'tenant_id', 'TEXT')
  ensureColumn(db, 'session_links', 'issuer', 'TEXT')
  if (report.rows === undefined) report.rows = {}
  report.rows.events_seq_backfilled = rows.length
  report.rows.runs = (db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n
}

/**
 * 0009 — runs.snapshot_sha256 nullable (RUN-01): the §3.1 runs row is written
 * at CLAIM time, and non-snapshot jobs (echo/smoke) legitimately have no code
 * snapshot. SQLite cannot DROP a NOT NULL constraint in place, so the table
 * is rebuilt with the same shape minus NOT NULL on snapshot_sha256. The
 * rebuild is transactional and idempotent (only runs the first time the
 * constraint is detected).
 */
const runsSnapshotNullable = (db: DatabaseSync, report: MigrationReport): void => {
  const has = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get() as { sql?: string } | undefined
  if (has?.sql !== undefined && /snapshot_sha256\s+TEXT\s+NOT NULL/.test(has.sql)) {
    db.exec(`
      CREATE TABLE runs_new (
        run_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        contract_id TEXT,
        snapshot_sha256 TEXT,
        manifest_json TEXT,
        signature_status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        UNIQUE (job_id, attempt_no)
      );
      INSERT INTO runs_new (run_id, project_id, job_id, attempt_no, contract_id, snapshot_sha256, manifest_json, signature_status, started_at, finished_at)
        SELECT run_id, project_id, job_id, attempt_no, contract_id, snapshot_sha256, manifest_json, signature_status, started_at, finished_at FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_new RENAME TO runs;
    `)
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id)')
  if (report.rows === undefined) report.rows = {}
  report.rows.runs = (db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n
}

/**
 * 0010 — TEX-03 (execution-runtime.md §12.1): live LaTeX preview build
 * records. tex_builds gains the preview flag + supersede linkage
 * (superseded_by/superseded_at) and the durable debounced preview request
 * table (tex_preview_pending) so preview state survives kernel restarts and
 * UI reconnects. Additive and idempotent: columns are ensured by name, the
 * pending table is CREATE IF NOT EXISTS, and existing latex-compile rows
 * stay authoritative (preview=0 default).
 */
const previewBuilds = (db: DatabaseSync, report: MigrationReport): void => {
  ensureColumn(db, 'tex_builds', 'preview', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'tex_builds', 'superseded_by', 'TEXT')
  ensureColumn(db, 'tex_builds', 'superseded_at', 'TEXT')
  db.exec(`
    CREATE TABLE IF NOT EXISTS tex_preview_pending (
      document_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      root_file TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'pdflatex',
      debounce_ms INTEGER NOT NULL DEFAULT 800,
      requested_at TEXT NOT NULL
    );
  `)
  if (report.rows === undefined) report.rows = {}
  report.rows.tex_builds = (db.prepare('SELECT COUNT(*) AS n FROM tex_builds').get() as { n: number }).n
  report.rows.tex_preview_pending = (db.prepare('SELECT COUNT(*) AS n FROM tex_preview_pending').get() as { n: number }).n
}

/**
 * 0011 — PTY-01 + WORK-01 (execution-runtime.md §6.1, api-contracts.md
 * §17/§18): durable Interactive Terminal sessions/frames and the generic
 * VS Code-style workspace (nodes + op ledger). The DDL is shared with the
 * store modules (pty-session.ts / workspace-store.ts) so the kernel
 * migration runner and the stores' own WAL connections converge on the same
 * shape — CREATE IF NOT EXISTS + additive columns keep it idempotent on
 * databases from older releases.
 */
const ptyAndWorkspaceTables = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(PTY_DDL)
  db.exec(WORKSPACE_DDL)
  if (report.rows === undefined) report.rows = {}
  report.rows.pty_sessions = (db.prepare('SELECT COUNT(*) AS n FROM pty_sessions').get() as { n: number }).n
  report.rows.pty_frames = (db.prepare('SELECT COUNT(*) AS n FROM pty_frames').get() as { n: number }).n
  report.rows.workspaces = (db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n
  report.rows.workspace_nodes = (db.prepare('SELECT COUNT(*) AS n FROM workspace_nodes').get() as { n: number }).n
  report.rows.workspace_ops = (db.prepare('SELECT COUNT(*) AS n FROM workspace_ops').get() as { n: number }).n
}

/**
 * 0012 — ONBOARD-01 (research-onboarding.md): Research Intake sessions.
 * Four isolated tables (sessions/artifacts/observations/questions) that the
 * pre-accept pipeline may write — business tables stay untouched until the
 * adoption transaction. DDL shared with kernel.ts via INTAKE_DDL (CREATE IF
 * NOT EXISTS keeps it idempotent on databases from older releases).
 */
const intakeTables = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(INTAKE_DDL)
  if (report.rows === undefined) report.rows = {}
  report.rows.intake_sessions = (db.prepare('SELECT COUNT(*) AS n FROM intake_sessions').get() as { n: number }).n
  report.rows.intake_artifacts = (db.prepare('SELECT COUNT(*) AS n FROM intake_artifacts').get() as { n: number }).n
  report.rows.intake_observations = (db.prepare('SELECT COUNT(*) AS n FROM intake_observations').get() as { n: number }).n
  report.rows.intake_questions = (db.prepare('SELECT COUNT(*) AS n FROM intake_questions').get() as { n: number }).n
}

/**
 * 0013 — TRAJ-01/SUBAGENT-01 (trajectory-subagents.md): standalone safe
 * trajectory projection + subagent topology storage. `child_links` records
 * the durable parent/child topology (research_panel spawns); `child_history`
 * is the append-only per-child ledger (started/state/followup);
 * `child_followups` holds one-shot read-only followup receipts; the
 * `events(project_id,event_seq,event_id)` index keeps 10k-event keyset
 * pagination stable. The projection itself reads the existing `events`
 * outbox — no trajectory copy of business state (Kernel Outbox stays the
 * only authority). DDL shared with trajectory.ts (CREATE IF NOT EXISTS +
 * additive = idempotent on older databases).
 */
const trajectoryAndTopologyTables = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(TRAJECTORY_DDL)
  if (report.rows === undefined) report.rows = {}
  report.rows.child_links = (db.prepare('SELECT COUNT(*) AS n FROM child_links').get() as { n: number }).n
  report.rows.child_history = (db.prepare('SELECT COUNT(*) AS n FROM child_history').get() as { n: number }).n
  report.rows.child_followups = (db.prepare('SELECT COUNT(*) AS n FROM child_followups').get() as { n: number }).n
}

/**
 * 0014 — STORE-06 (storage-migrations.md §4 / domain-model §10.1): lease
 * tokens are stored as sha256 hashes, never plaintext.
 *
 *  - jobs gains `lease_token_hash TEXT`; rows claimed by the PREVIOUS
 *    release carry the plaintext token inside payload.__lease_token, and
 *    0014 backfills the hash from it (existing data is otherwise untouched)
 *    so hash-based fencing covers every leased row.
 *  - pty_sessions is REBUILT (same copy→verify→rename pattern as 0009 for
 *    runs): the released shape had `lease_token TEXT NOT NULL` (plaintext at
 *    rest). The new shape (PTY_SESSIONS_TABLE_DDL, shared with
 *    pty-session.ts) makes the plaintext column nullable — legacy rows keep
 *    their values for audit, with the hash backfilled from them — and adds
 *    `lease_token_hash TEXT NOT NULL DEFAULT ''`, populated at open time.
 *    New sessions persist ONLY the hash; the plaintext token lives in
 *    kernel memory and is handed to the caller at open.
 *
 * Additive + idempotent: fresh databases already carry both shapes (0011
 * executes the CURRENT PTY_DDL, and the pty store does the same on its own
 * connection), so every step detects its precondition before acting.
 */
const leaseTokenHashing = (db: DatabaseSync, report: MigrationReport): void => {
  // jobs: additive hash column + backfill from the legacy payload token.
  ensureColumn(db, 'jobs', 'lease_token_hash', 'TEXT')
  const legacyRows = db.prepare("SELECT job_id, payload FROM jobs WHERE lease_token_hash IS NULL AND payload LIKE '%__lease_token%'")
    .all() as unknown as Array<{ job_id: string; payload: string }>
  const updateHash = db.prepare('UPDATE jobs SET lease_token_hash = ? WHERE job_id = ?')
  let jobsBackfilled = 0
  for (const row of legacyRows) {
    let token: string | null = null
    try {
      const parsed = JSON.parse(row.payload) as { __lease_token?: unknown }
      if (typeof parsed.__lease_token === 'string' && parsed.__lease_token !== '') token = parsed.__lease_token
    } catch {
      // Malformed payload — leave the hash NULL (fencing falls back to the
      // legacy payload-token comparison, which stays a mismatch-free no-op
      // for rows that never carried a token).
    }
    if (token !== null) {
      updateHash.run(sha256(token), row.job_id)
      jobsBackfilled += 1
    }
  }
  // pty_sessions: rebuild only when the legacy plaintext-NOT NULL shape is
  // present (fresh databases already carry PTY_SESSIONS_TABLE_DDL).
  const ptyCols = db.prepare(`PRAGMA table_info('pty_sessions')`).all() as unknown as Array<{ name: string }>
  let ptyRebuilt = 0
  if (!ptyCols.some(c => c.name === 'lease_token_hash')) {
    const legacyPty = db.prepare(
      `SELECT pty_session_id, project_id, workspace_id, principal_id, tenant_id, profile, target, preset, cwd, config_hash,
              state, generation, lease_token, lease_expires_at, idle_ttl_s, retention_bytes, retained_from_seq,
              last_client_seq, last_event_seq, total_bytes, dropped_bytes, adapter_id, open_at, last_activity_at, closed_at, close_reason
       FROM pty_sessions`,
    ).all() as unknown as Array<{
      pty_session_id: string; project_id: string; workspace_id: string; principal_id: string; tenant_id: string
      profile: string; target: string; preset: string; cwd: string; config_hash: string
      state: string; generation: number; lease_token: string | null
      lease_expires_at: string | null; idle_ttl_s: number; retention_bytes: number; retained_from_seq: number
      last_client_seq: number; last_event_seq: number; total_bytes: number; dropped_bytes: number
      adapter_id: string; open_at: string; last_activity_at: string; closed_at: string | null; close_reason: string | null
    }>
    db.exec('DROP TABLE IF EXISTS pty_sessions_new')
    db.exec(PTY_SESSIONS_TABLE_DDL.replace('CREATE TABLE IF NOT EXISTS pty_sessions', 'CREATE TABLE pty_sessions_new'))
    const insert = db.prepare(`INSERT INTO pty_sessions_new (
      pty_session_id, project_id, workspace_id, principal_id, tenant_id, profile, target, preset, cwd, config_hash,
      state, generation, lease_token, lease_token_hash, lease_expires_at, idle_ttl_s, retention_bytes, retained_from_seq,
      last_client_seq, last_event_seq, total_bytes, dropped_bytes, adapter_id, open_at, last_activity_at, closed_at, close_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const r of legacyPty) {
      const token = typeof r.lease_token === 'string' && r.lease_token !== '' ? r.lease_token : null
      insert.run(
        r.pty_session_id, r.project_id, r.workspace_id, r.principal_id, r.tenant_id, r.profile, r.target, r.preset,
        r.cwd, r.config_hash, r.state, r.generation, r.lease_token,
        token !== null ? sha256(token) : '', r.lease_expires_at, r.idle_ttl_s, r.retention_bytes, r.retained_from_seq,
        r.last_client_seq, r.last_event_seq, r.total_bytes, r.dropped_bytes, r.adapter_id, r.open_at,
        r.last_activity_at, r.closed_at, r.close_reason,
      )
    }
    db.exec('DROP TABLE pty_sessions')
    db.exec('ALTER TABLE pty_sessions_new RENAME TO pty_sessions')
    db.exec('CREATE INDEX IF NOT EXISTS idx_pty_sessions_project ON pty_sessions(project_id)')
    ptyRebuilt = legacyPty.length
  }
  if (report.rows === undefined) report.rows = {}
  report.rows.jobs_lease_token_hash_backfilled = jobsBackfilled
  report.rows.pty_sessions_rebuilt = ptyRebuilt
}

/**
 * Ordered migration registry. Never reorder or edit a released migration:
 * its checksum is recorded in schema_migrations and a mismatch is fatal.
 * New steps append at the end and bump SCHEMA_VERSION.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: '0001_schema_v2_initial',
    description: 'Full v2 initial schema for empty databases (idempotent)',
    body: SCHEMA_V2_INITIAL,
    up: (db) => { db.exec(SCHEMA_V2_INITIAL) },
  },
  {
    id: '0002_import_legacy_v1',
    description: 'Import legacy v1 databases: principal, provenance, project-scoped artifacts/jobs, manuscript → TeX',
    body: legacyV1Import.toString(),
    up: legacyV1Import,
  },
  {
    id: '0003_terminal_tex_i18n_capabilities',
    description: 'Terminal/TeX tables + v2 columns for early v2-preview databases',
    // STORE-08 (storage-migrations.md §8.1): the canonical body is the up
    // source PLUS the frozen inline DDL snapshot the migration executes —
    // the checksum binds the actual DDL, and the shared TERMINAL_DDL/TEX_DDL
    // constants can evolve without invalidating recorded checksums.
    body: `${terminalTexCapabilities.toString()}\n\n${TERMINAL_DDL_0003}\n${TEX_DDL_0003}`,
    up: terminalTexCapabilities,
  },
  {
    id: '0004_artifact_media_type',
    description: 'Artifact media_type + file_name columns (ART-02)',
    body: artifactMediaType.toString(),
    up: artifactMediaType,
  },
  {
    id: '0005_code_snapshots',
    description: 'Authoritative code_snapshots registry (STORE-02)',
    body: codeSnapshotRegistry.toString(),
    up: codeSnapshotRegistry,
  },
  {
    id: '0006_project_members',
    description: 'Project membership model (API-01 foundation)',
    body: projectMembers.toString(),
    up: projectMembers,
  },
  {
    id: '0007_project_idempotency_keys',
    description: 'Project Idempotency-Key + request hash columns (v2)',
    body: projectIdempotencyKeys.toString(),
    up: projectIdempotencyKeys,
  },
  {
    id: '0008_outbox_envelope',
    description: 'Outbox canonical envelope (EVENT-01/§16) + runs table + session_links principal (STORE-01)',
    body: outboxEnvelope.toString(),
    up: outboxEnvelope,
  },
  {
    id: '0009_runs_snapshot_nullable',
    description: 'RUN-01: runs.snapshot_sha256 nullable (echo/smoke jobs have no code snapshot)',
    body: runsSnapshotNullable.toString(),
    up: runsSnapshotNullable,
  },
  {
    id: '0010_preview_builds',
    description: 'TEX-03: tex_builds preview/superseded_by/superseded_at + tex_preview_pending (live LaTeX preview)',
    body: previewBuilds.toString(),
    up: previewBuilds,
  },
  {
    id: '0011_pty_workspace',
    description: 'PTY-01 + WORK-01: pty_sessions/pty_frames + workspaces/workspace_nodes/workspace_ops (interface layer)',
    body: ptyAndWorkspaceTables.toString(),
    up: ptyAndWorkspaceTables,
  },
  {
    id: '0012_intake',
    description: 'ONBOARD-01: intake_sessions/intake_artifacts/intake_observations/intake_questions (Research Intake)',
    body: intakeTables.toString(),
    up: intakeTables,
  },
  {
    id: '0013_trajectory_topology',
    description: 'TRAJ-01/SUBAGENT-01: child_links/child_history/child_followups + events(project_id,event_seq,event_id) index (trajectory projection & subagent topology)',
    body: trajectoryAndTopologyTables.toString(),
    up: trajectoryAndTopologyTables,
  },
  {
    id: '0014_lease_token_hash',
    description: 'STORE-06: jobs.lease_token_hash (+ backfill from legacy payload token) + pty_sessions rebuild with lease_token_hash (no plaintext lease tokens at rest)',
    body: leaseTokenHashing.toString(),
    up: leaseTokenHashing,
  },
]

/**
 * Open an existing database to the code's schema: bootstrap meta +
 * schema_migrations, apply every pending migration in order (each in a
 * transaction with a recorded checksum + report), then bump schema_version.
 * Fails loudly on a checksum mismatch, a version ahead of the code, or any
 * failed step (the failed step is rolled back).
 */
export function runMigrations(db: DatabaseSync, log?: (line: string) => void): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      report_json TEXT NOT NULL
    );
  `)
  const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value?: string } | undefined
  const current = versionRow === undefined ? 0 : Number(versionRow.value)
  if (!Number.isFinite(current)) {
    throw new Error(`research-kernel: corrupt meta.schema_version '${versionRow?.value ?? ''}'`)
  }
  if (current > SCHEMA_VERSION) {
    throw new Error(`research-kernel schema version mismatch: db=${current} expected=${SCHEMA_VERSION}; downgrade requires an explicit script`)
  }
  const appliedRows = db.prepare('SELECT id, checksum FROM schema_migrations').all() as unknown as Array<{ id: string; checksum: string }>
  const applied = new Map(appliedRows.map(r => [r.id, r.checksum] as const))
  const insertMigration = db.prepare('INSERT INTO schema_migrations (id, checksum, applied_at, report_json) VALUES (?, ?, ?, ?)')
  const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  let migratedAt: string | null = null
  for (const m of MIGRATIONS) {
    const expected = checksumOf(m)
    const existing = applied.get(m.id)
    if (existing !== undefined) {
      if (existing !== expected) {
        throw new Error(`research-kernel migration ${m.id} checksum mismatch: db=${existing} code=${expected}; released migrations are immutable`)
      }
      continue
    }
    const report: MigrationReport = {}
    db.exec('BEGIN IMMEDIATE')
    try {
      m.up(db, report)
      insertMigration.run(m.id, expected, new Date().toISOString(), JSON.stringify(report))
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`research-kernel migration ${m.id} failed: ${(error as Error).message}`)
    }
    migratedAt = new Date().toISOString()
    log?.(`research-kernel: applied migration ${m.id} (${m.description})`)
  }
  if (current !== SCHEMA_VERSION) {
    setMeta.run('schema_version', String(SCHEMA_VERSION))
    if (migratedAt !== null) setMeta.run('last_migrated_at', migratedAt)
    const databaseId = db.prepare('SELECT value FROM meta WHERE key = ?').get('database_id') as { value?: string } | undefined
    if (databaseId === undefined) setMeta.run('database_id', randomUUID())
    const created = db.prepare('SELECT value FROM meta WHERE key = ?').get('created_at') as { value?: string } | undefined
    if (created === undefined) setMeta.run('created_at', new Date().toISOString())
  }
}
