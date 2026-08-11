/**
 * Paper reproduction storage module (docs/reproduction-contracts.md §2/§4).
 *
 * REPRODUCTION_DDL is the DDL authority for the reproduction tables —
 * consumed by migration 0022 (migrations.ts) exactly like INTAKE_DDL/PTY_DDL:
 * the migration's canonical body is the `up` source, which executes this
 * shared constant by name, so released databases stay checksum-stable while
 * new capabilities evolve through new migrations.
 *
 * Storage contract (§4): the immutable ReproducibilityReport body goes into
 * the CAS; the reproduction_reports row keeps only the content hash + cas
 * ref. reproduction_links records source/material links (paper artifact,
 * code snapshot, data artifacts, contracts, run manifests, reports).
 * @module @dsh-scholar/research-kernel/reproduction
 */

import { createHash } from 'node:crypto'

/** Table DDL for the paper reproduction aggregate (contract §4). */
export const REPRODUCTION_DDL = `
CREATE TABLE IF NOT EXISTS reproduction_specs (
  spec_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  owner_principal TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  idempotency_key TEXT,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reproduction_specs_project
  ON reproduction_specs(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reproduction_specs_idem
  ON reproduction_specs(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS reproduction_attempts (
  attempt_id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued',
  spec_revision INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  lease_token_hash TEXT NOT NULL DEFAULT '',
  submitter_principal TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reproduction_attempts_spec
  ON reproduction_attempts(spec_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reproduction_attempts_idem
  ON reproduction_attempts(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS reproduction_reports (
  report_id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  cas_ref TEXT NOT NULL,
  idempotency_key TEXT,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reproduction_reports_spec
  ON reproduction_reports(spec_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reproduction_reports_idem
  ON reproduction_reports(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS reproduction_links (
  spec_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (spec_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_reproduction_links_spec
  ON reproduction_links(spec_id);
`

/**
 * Canonical JSON used for reproduction object hashes — RECURSIVE sorted-key
 * serialization (unlike the manifest hashing helper, which sorts top-level
 * keys only; reproduction objects are nested and re-parsed from the CAS
 * blob, so every level must be key-sorted deterministically). Numbers are
 * serialized by JSON.stringify (NaN/Infinity → null) and strings/booleans
 * verbatim; arrays keep their order.
 */
export function reproductionCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => reproductionCanonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${reproductionCanonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** sha256 hex of a reproduction object's canonical JSON. */
export function reproductionSha256(value: Record<string, unknown>): string {
  return createHash('sha256').update(reproductionCanonicalJson(value), 'utf8').digest('hex')
}
