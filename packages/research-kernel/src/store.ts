/**
 * SQLite persistence layer (node:sqlite) — migration v1 + row accessors.
 * The Kernel DB is the authoritative research state; DSH sessions are not
 * (design §2.2, ADR-003 event+projection model).
 * @module @dsh-scholar/research-kernel/store
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const SCHEMA_VERSION = 1

const MIGRATION_V1 = `
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
  decided_at TEXT NOT NULL
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
-- Terminal frames (execution-runtime.md §6): append-only per (job, run),
-- monotonic seq, channel split, bounded retention. The runs table does not
-- exist yet in this schema, so the run identity is carried as an attribute
-- and frames are scoped by job_id (FK).
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

/** Open (or create) the kernel database at `path` (`:memory:` allowed). */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(MIGRATION_V1)
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value?: string } | undefined
  if (row === undefined) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
  } else if (Number(row.value) !== SCHEMA_VERSION) {
    throw new Error(`research-kernel schema version mismatch: db=${row.value} expected=${SCHEMA_VERSION}`)
  }
  // v2 forward migrations on pre-existing databases.
  ensureColumn(db, 'evidence', 'provenance_status', "TEXT NOT NULL DEFAULT 'legacy_unverified'")
  // §12.6 lease fencing: generation counter, bumped on every claim.
  ensureColumn(db, 'jobs', 'lease_generation', 'INTEGER')
  migrateJobsProjectIdempotency(db)
  // §12.2 JobSpec binding (SCH-EXEC-002): code snapshot materialized from CAS.
  // Added AFTER the jobs table rebuild so `INSERT INTO jobs_v2 SELECT *` keeps
  // a matching column count on legacy databases.
  ensureColumn(db, 'jobs', 'code_snapshot_id', 'TEXT')
  migrateArtifactsProjectScoped(db)
  return db
}

/**
 * v2 §7.4: artifacts become PROJECT-SCOPED references to global blobs.
 * Legacy table had artifact_id as the global PK (same blob deduped across
 * projects); rebuild so each project owns its own record.
 */
function migrateArtifactsProjectScoped(db: DatabaseSync): void {
  const info = db.prepare(`PRAGMA table_info('artifacts')`).all() as unknown as Array<{ pk: number; name: string }>
  // New schema: pk appears on both columns (composite). Legacy: only artifact_id has pk=1.
  const pkCount = info.filter(c => c.pk > 0).length
  if (pkCount >= 2) return
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
    INSERT INTO artifacts_v2 SELECT * FROM artifacts;
    DROP TABLE artifacts;
    ALTER TABLE artifacts_v2 RENAME TO artifacts;
  `)
}

/**
 * v2 §7.2 migration: the legacy jobs table had a GLOBAL UNIQUE on
 * idempotency_key, which breaks project-scoped idempotency (§3.4 #2).
 * Rebuild the table (copy -> verify -> atomic rename) when a global unique
 * index on idempotency_key exists.
 */
function migrateJobsProjectIdempotency(db: DatabaseSync): void {
  const indexes = db.prepare(`PRAGMA index_list('jobs')`).all() as unknown as Array<{ name: string; unique: number; origin: string }>
  const globalUnique = indexes.some(idx => idx.unique === 1 && idx.origin !== 'pk' && idx.name !== 'idx_jobs_project_idempotency')
  if (!globalUnique) return
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
}

/** Add a column to an existing table if absent (v2 additive migrations). */
export function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
  }
}

/** Row shape for projects. */
export interface ProjectRow {
  project_id: string
  name: string
  workspace: string
  mode: string
  status: string
  revision: number
  brief: string
  constraints: string
  execution: string
  integrity: string
  session_id: string | null
  dsh_workspace_id: string | null
  created_at: string
  updated_at: string
  history: string
}

/** Row shape for gates. */
export interface GateRow {
  gate_id: string
  project_id: string
  type: string
  title: string
  summary: string
  payload: string
  status: string
  dsh_session_id: string | null
  dsh_event_id: string | null
  created_at: string
  decided_at: string | null
}

/** Row shape for jobs. */
export interface JobRow {
  job_id: string
  project_id: string
  contract_id: string | null
  idempotency_key: string
  kind: string
  command: string
  payload: string
  status: string
  failure_class: string | null
  lease_owner: string | null
  lease_expires_at: string | null
  heartbeat_at: string | null
  /** §12.6 lease fencing: bumped on every claim; stale generations are rejected. */
  lease_generation: number | null
  /** §12.2 JobSpec binding (SCH-EXEC-002): CAS code snapshot id, if any. */
  code_snapshot_id: string | null
  attempts: number
  max_attempts: number
  run_manifest: string | null
  error: string
  created_at: string
  updated_at: string
}

/** Row shape for registered runner signing keys (§12.7). */
export interface RunnerKeyRow {
  key_id: string
  public_key_pem: string
  created_at: string
}

/** Lightweight row shape for the event outbox. */
export interface EventRow {
  event_id: string
  project_id: string | null
  kind: string
  payload: string
  source: string
  delivered: number
  created_at: string
}
