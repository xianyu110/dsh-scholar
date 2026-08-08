#!/usr/bin/env node
/**
 * Regenerates tests/fixtures/databases/v1-kernel.db — the repository's
 * legacy v1 kernel fixture (storage-migrations.md §8: "迁移脚本及旧 fixture
 * DB 是仓库必需资产"). The DDL below is the verbatim MIGRATION_V1 as it
 * shipped at commit 3da1392 (pre-v0.2): global-PK artifacts, jobs without
 * lease_generation/code_snapshot_id, decisions without durable principal,
 * and string manuscripts.
 *
 * Usage: node build-v1-fixture.mjs [out]
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), 'v1-kernel.db')

const V1_DDL = `
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
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS idx_gates_project ON gates(project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
CREATE INDEX IF NOT EXISTS idx_ideas_project ON ideas(project_id);
CREATE INDEX IF NOT EXISTS idx_contracts_project ON contracts(project_id);
CREATE INDEX IF NOT EXISTS idx_claims_project ON claims(project_id);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id);
`

mkdirSync(dirname(OUT), { recursive: true })
rmSync(OUT, { force: true })
rmSync(`${OUT}-wal`, { force: true })
rmSync(`${OUT}-shm`, { force: true })
const db = new DatabaseSync(OUT)
db.exec(V1_DDL)
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run()
const now = new Date().toISOString()

db.prepare(`INSERT INTO projects (project_id, name, workspace, mode, status, revision, brief, constraints, execution, integrity, created_at, updated_at, history)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  'p_legacy1', 'Legacy Study', '/w/legacy1', 'gate-only', 'RELEASED', 3,
  JSON.stringify({ title: 'legacy', hypothesis: 'old' }), '{}', '{}', '{}', now, now, '[]',
)
db.prepare(`INSERT INTO projects (project_id, name, workspace, mode, status, revision, brief, constraints, execution, integrity, created_at, updated_at, history)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  'p_legacy2', 'Legacy Study B', '/w/legacy2', 'gate-only', 'DRAFT', 0,
  JSON.stringify({ title: 'legacy b' }), '{}', '{}', '{}', now, now, '[]',
)
db.prepare(`INSERT INTO gates (gate_id, project_id, type, title, summary, payload, status, dsh_session_id, dsh_event_id, created_at, decided_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  'gate_legacy1', 'p_legacy1', 'scope', 'Scope', '', '{}', 'approved', null, null, now, now,
)
// Legacy decision: actor-only, no durable principal columns.
db.prepare(`INSERT INTO decisions (decision_id, gate_id, project_id, gate_type, actor, decision, reason, diff, session_id, event_id, decided_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  'dec_legacy1', 'gate_legacy1', 'p_legacy1', 'scope', 'legacy-operator', 'approved', 'looks fine', '', null, null, now,
)
// Two projects, each with their own artifact (pure v1: artifact_id is a
// GLOBAL PK, so the same ID can never span projects; the regeneration
// branch in 0002 defends against v1.5 preview databases that could).
db.prepare(`INSERT INTO artifacts (artifact_id, project_id, kind, size_bytes, sha256, metadata, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`).run('art_x', 'p_legacy1', 'table', 1024, 'a'.repeat(64), '{}', now)
db.prepare(`INSERT INTO artifacts (artifact_id, project_id, kind, size_bytes, sha256, metadata, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`).run('art_y', 'p_legacy2', 'chart', 512, 'b'.repeat(64), '{}', now)
// v1 job: no lease_generation, no code_snapshot_id, no composite unique.
db.prepare(`INSERT INTO jobs (job_id, project_id, contract_id, idempotency_key, kind, command, payload, status, failure_class, lease_owner, lease_expires_at, heartbeat_at, attempts, max_attempts, run_manifest, error, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  'job_legacy1', 'p_legacy1', null, 'legacy-key-1', 'baseline', '["node","train.js"]', '{}', 'succeeded', null, null, null, null, 1, 3, null, '', now, now,
)
db.prepare(`INSERT INTO evidence (evidence_id, project_id, body, provenance_status, created_at)
  VALUES (?, ?, ?, ?, ?)`).run('ev_legacy1', 'p_legacy1', JSON.stringify({ effect: 0.2 }), 'legacy_unverified', now)
db.prepare(`INSERT INTO manuscripts (manuscript_id, project_id, body, created_at)
  VALUES (?, ?, ?, ?)`).run(
  'ms_legacy1', 'p_legacy1',
  '\\documentclass{article}\n\\begin{document}\nLegacy manuscript body.\n\\end{document}\n',
  now,
)
db.close()
console.log(`wrote ${OUT}`)
