/**
 * SQLite persistence layer (node:sqlite) — explicit migrations + row
 * accessors. The Kernel DB is the authoritative research state; DSH
 * sessions are not (design §2.2, ADR-003 event+projection model).
 * Schema evolution lives in migrations.ts (storage-migrations.md §8):
 * ordered, checksummed, idempotent steps recorded in schema_migrations.
 * @module @dsh-scholar/research-kernel/store
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { runMigrations, SCHEMA_VERSION } from './migrations.js'

export { SCHEMA_VERSION }

/** Open (or create) the kernel database at `path` (`:memory:` allowed). The
 * optional `casRoot` is forwarded to the migration runner so 0017 can
 * materialize legacy log blobs into the content-addressed store. */
export function openDatabase(path: string, log?: (line: string) => void, casRoot?: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  // storage-migrations.md §2: bounded busy retry for concurrent writers —
  // short transactions + Revision CAS already limit contention; busy_timeout
  // (5s) converts SQLITE_BUSY into a bounded wait instead of an immediate
  // throw when another writer holds the (single-writer) lock briefly.
  db.exec('PRAGMA busy_timeout = 5000')
  // storage-migrations.md §8: explicit ordered migrations (checksummed,
  // idempotent, transactional); schema_version only bumps after success.
  runMigrations(db, log, casRoot)
  return db
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
  /** STORE-06 (storage-migrations.md §4): sha256 of the opaque claim token
   * (migration 0014); NULL on legacy rows — the plaintext token is never
   * persisted. */
  lease_token_hash: string | null
  /** v2 shape (domain-model.md §9, migration 0016): durable submitter
   * principal; NULL on legacy rows and internal submissions. */
  created_by_principal_id: string | null
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
