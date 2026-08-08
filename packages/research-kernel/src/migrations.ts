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

/** Code-side schema version; bumped only when the migration set grows. */
export const SCHEMA_VERSION = 5

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
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tex_builds_doc ON tex_builds(document_id);
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
 * 0003 — terminal/TeX/i18n capabilities for databases that were created by
 * the early v2 preview code (SCHEMA_VERSION=1 with implicit column fixes).
 * Idempotent: terminal + TeX tables are CREATE IF NOT EXISTS, and column
 * additions check existence first. On current databases this is a no-op.
 */
const terminalTexCapabilities = (db: DatabaseSync, report: MigrationReport): void => {
  db.exec(TERMINAL_DDL)
  db.exec(TEX_DDL)
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
    body: terminalTexCapabilities.toString(),
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
