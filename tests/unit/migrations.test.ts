/**
 * Explicit migration framework tests (storage-migrations.md §8):
 * ordered/checksummed/idempotent steps, transactional rollback, legacy v1
 * import against the committed fixture tests/fixtures/databases/v1-kernel.db.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, SCHEMA_VERSION, runMigrations, MIGRATIONS } from '@dsh-scholar/research-kernel'

const FIXTURE = fileURLToPath(new URL('../fixtures/databases/v1-kernel.db', import.meta.url))

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-migrations-'))
  return join(dir, 'kernel.db')
}

function tableInfo(db: DatabaseSync, table: string): Array<{ name: string; pk: number }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>
}

describe('explicit migrations', () => {
  afterEach(() => {
    // The rollback test appends a failing migration; always restore.
    while (MIGRATIONS.length > 13) MIGRATIONS.pop()
  })

  it('opens with WAL + foreign_keys + bounded busy_timeout (storage-migrations.md §2)', () => {
    // File-backed DB: WAL is reported as 'wal' (in-memory DBs report 'memory').
    const db = openDatabase(tmpDbPath())
    const journal = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode
    const foreignKeys = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys
    const busyTimeout = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout
    expect(journal.toLowerCase()).toBe('wal')
    expect(foreignKeys).toBe(1)
    expect(busyTimeout).toBe(5000)
    db.close()
  })

  it('bumps a fresh database to SCHEMA_VERSION with all steps recorded', () => {
    const db = openDatabase(':memory:')
    expect(SCHEMA_VERSION).toBe(12)
    const meta = Object.fromEntries((db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>).map(r => [r.key, r.value]))
    expect(meta.schema_version).toBe('12')
    expect(meta.database_id).toBeTruthy()
    expect(meta.created_at).toBeTruthy()
    const applied = db.prepare('SELECT id, checksum, report_json FROM schema_migrations ORDER BY id').all() as Array<{ id: string; checksum: string; report_json: string }>
    expect(applied.map(r => r.id)).toEqual(['0001_schema_v2_initial', '0002_import_legacy_v1', '0003_terminal_tex_i18n_capabilities', '0004_artifact_media_type', '0005_code_snapshots', '0006_project_members', '0007_project_idempotency_keys', '0008_outbox_envelope', '0009_runs_snapshot_nullable', '0010_preview_builds', '0011_pty_workspace', '0012_intake', '0013_trajectory_topology'])
    for (const row of applied) expect(row.checksum).toMatch(/^[0-9a-f]{64}$/)
    // 0002 on a fresh DB: nothing to import (row counters still reported).
    expect(JSON.parse(applied[1]!.report_json)).toEqual({ rows: { manuscripts_converted: 0 } })
    // All product tables exist.
    for (const t of ['projects', 'gates', 'decisions', 'ideas', 'contracts', 'corpus_snapshots', 'artifacts', 'jobs', 'runner_keys', 'evidence', 'claims', 'events', 'session_links', 'budget', 'manuscripts', 'terminal_frames', 'terminal_retention', 'tex_documents', 'tex_files', 'tex_snapshots', 'tex_builds', 'project_members', 'code_snapshots', 'runs', 'pty_sessions', 'pty_frames', 'workspaces', 'workspace_nodes', 'workspace_ops', 'intake_sessions', 'intake_artifacts', 'intake_observations', 'intake_questions', 'child_links', 'child_history', 'child_followups']) {
      expect(tableInfo(db, t).length, `table ${t}`).toBeGreaterThan(0)
    }
    // 0011 (PTY-01/WORK-01): the pty + workspace tables carry the interface
    // layer columns (state machine, client_seq idempotency, retention).
    const ptySessionCols = tableInfo(db, 'pty_sessions').map(c => c.name)
    for (const c of ['pty_session_id', 'principal_id', 'workspace_id', 'profile', 'target', 'preset', 'cwd', 'config_hash', 'state', 'generation', 'lease_token', 'idle_ttl_s', 'retention_bytes', 'retained_from_seq', 'last_client_seq', 'last_event_seq', 'closed_at']) {
      expect(ptySessionCols, `pty_sessions.${c}`).toContain(c)
    }
    const workspaceNodeCols = tableInfo(db, 'workspace_nodes').map(c => c.name)
    for (const c of ['workspace_id', 'path', 'version', 'binary', 'media', 'size_bytes', 'content', 'blob_sha256', 'content_hash']) {
      expect(workspaceNodeCols, `workspace_nodes.${c}`).toContain(c)
    }
    // EVENT-01/§16: the events outbox carries the canonical envelope columns.
    const eventCols = tableInfo(db, 'events').map(c => c.name)
    for (const c of ['event_seq', 'event_version', 'aggregate_type', 'aggregate_id', 'aggregate_revision', 'request_id', 'session_id', 'attempts', 'last_error', 'next_attempt_at', 'dead_lettered_at']) {
      expect(eventCols, `events.${c}`).toContain(c)
    }
    const seqIndex = db.prepare(`PRAGMA index_list('events')`).all() as Array<{ name: string; unique: number }>
    expect(seqIndex.some(i => i.name === 'idx_events_aggregate_seq' && i.unique === 1)).toBe(true)
    // STORE-01 parity: session_links gained the durable principal columns.
    const sessionCols = tableInfo(db, 'session_links').map(c => c.name)
    for (const c of ['principal_id', 'tenant_id', 'issuer']) expect(sessionCols).toContain(c)
    // 0010 (TEX-03): tex_builds carries the preview/supersede linkage and
    // the debounced preview scheduler's durable pending table exists.
    const buildCols = tableInfo(db, 'tex_builds').map(c => c.name)
    for (const c of ['preview', 'superseded_by', 'superseded_at']) expect(buildCols).toContain(c)
    expect(tableInfo(db, 'tex_preview_pending').length).toBeGreaterThan(0)
    db.close()
  })

  it('is idempotent across re-opens of the same database file', () => {
    const path = tmpDbPath()
    const db1 = openDatabase(path)
    const before = (db1.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map(r => r.id)
    db1.close()
    const db2 = openDatabase(path)
    const after = (db2.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map(r => r.id)
    expect(after).toEqual(before)
    const version = (db2.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string }).value
    expect(version).toBe('12')
    db2.close()
    rmSync(path, { recursive: false, force: true })
  })

  it('fails loudly when a released migration checksum changes', () => {
    const path = tmpDbPath()
    const db1 = openDatabase(path)
    db1.prepare("UPDATE schema_migrations SET checksum = 'deadbeef' WHERE id = ?").run('0001_schema_v2_initial')
    db1.close()
    expect(() => openDatabase(path)).toThrow(/checksum mismatch/)
    rmSync(path, { recursive: false, force: true })
  })

  it('fails loudly when the database is newer than the code', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL, report_json TEXT NOT NULL)`)
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '99')").run()
    expect(() => runMigrations(db)).toThrow(/downgrade/)
    db.close()
  })

  it('rolls a failed migration back and leaves schema_version untouched', () => {
    const db = new DatabaseSync(':memory:')
    MIGRATIONS.push({
      id: '9999_test_failure',
      description: 'test-only failing migration',
      body: 'boom',
      up: (d) => { d.exec('CREATE TABLE boom_t (x TEXT)'); throw new Error('boom') },
    })
    expect(() => runMigrations(db)).toThrow(/9999_test_failure failed: boom/)
    expect(tableInfo(db, 'boom_t').length).toBe(0)
    const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined
    expect(version).toBeUndefined()
    const applied = db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>
    expect(applied.some(r => r.id === '9999_test_failure')).toBe(false)
    db.close()
  })

  it('imports a legacy v1 fixture: data preserved and upgraded in place', () => {
    const path = tmpDbPath()
    copyFileSync(FIXTURE, path)
    const db = openDatabase(path)
    expect((db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string }).value).toBe('12')
    // Projects preserved.
    const projects = db.prepare('SELECT project_id, name FROM projects ORDER BY project_id').all() as Array<{ project_id: string; name: string }>
    expect(projects).toEqual([{ project_id: 'p_legacy1', name: 'Legacy Study' }, { project_id: 'p_legacy2', name: 'Legacy Study B' }])
    // Decisions keep rows; durable principal columns exist and stay NULL for legacy actors.
    const decCols = tableInfo(db, 'decisions').map(c => c.name)
    for (const c of ['principal_id', 'principal_tenant_id', 'principal_auth_method', 'principal_session_id']) {
      expect(decCols).toContain(c)
    }
    const decision = db.prepare('SELECT decision_id, actor, decision, principal_id FROM decisions WHERE decision_id = ?').get('dec_legacy1') as { decision_id: string; actor: string; decision: string; principal_id: string | null }
    expect(decision.actor).toBe('legacy-operator')
    expect(decision.decision).toBe('approved')
    expect(decision.principal_id).toBeNull()
    // Artifacts become project-scoped (composite PK), rows intact.
    const artPk = tableInfo(db, 'artifacts').filter(c => c.pk > 0).length
    expect(artPk).toBe(2)
    // ART-02: media_type/file_name columns exist with sensible defaults.
    const artCols = tableInfo(db, 'artifacts').map(c => c.name)
    expect(artCols).toContain('media_type')
    expect(artCols).toContain('file_name')
    const artifacts = db.prepare('SELECT artifact_id, project_id FROM artifacts ORDER BY project_id').all() as Array<{ artifact_id: string; project_id: string }>
    expect(artifacts).toEqual([{ artifact_id: 'art_x', project_id: 'p_legacy1' }, { artifact_id: 'art_y', project_id: 'p_legacy2' }])
    // Jobs gained lease fencing + snapshot binding columns; row intact.
    const jobCols = tableInfo(db, 'jobs').map(c => c.name)
    expect(jobCols).toContain('lease_generation')
    expect(jobCols).toContain('code_snapshot_id')
    const job = db.prepare('SELECT job_id, idempotency_key, status FROM jobs WHERE job_id = ?').get('job_legacy1') as { job_id: string; idempotency_key: string; status: string }
    expect(job.idempotency_key).toBe('legacy-key-1')
    expect(job.status).toBe('succeeded')
    const jobIdx = db.prepare(`PRAGMA index_list('jobs')`).all() as Array<{ name: string; unique: number }>
    expect(jobIdx.some(i => i.name === 'idx_jobs_project_idempotency' && i.unique === 1)).toBe(true)
    // Evidence is legacy_unverified.
    const evidence = db.prepare('SELECT provenance_status FROM evidence WHERE evidence_id = ?').get('ev_legacy1') as { provenance_status: string }
    expect(evidence.provenance_status).toBe('legacy_unverified')
    // Manuscripts preserved AND converted into the initial TeX workspace.
    const manuscript = db.prepare('SELECT body FROM manuscripts WHERE manuscript_id = ?').get('ms_legacy1') as { body: string }
    expect(manuscript.body).toContain('Legacy manuscript body')
    const docId = `doc_${sha256('ms_legacy1').slice(0, 12)}`
    const doc = db.prepare('SELECT document_id, project_id, root_file, revision FROM tex_documents WHERE document_id = ?').get(docId) as { document_id: string; project_id: string; root_file: string; revision: number }
    expect(doc.project_id).toBe('p_legacy1')
    expect(doc.root_file).toBe('paper.tex')
    expect(doc.revision).toBe(1)
    const file = db.prepare('SELECT path, version, content FROM tex_files WHERE document_id = ?').get(docId) as { path: string; version: number; content: string }
    expect(file.path).toBe('paper.tex')
    expect(file.version).toBe(1)
    expect(file.content).toBe(manuscript.body)
    // Re-open: still idempotent and consistent.
    db.close()
    const db2 = openDatabase(path)
    expect((db2.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(13)
    expect((db2.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string }).value).toBe('12')
    db2.close()
    rmSync(path, { recursive: false, force: true })
  })

  it('upgrades a pre-outbox events table: new columns, defaults and seq backfill', () => {
    // Simulate a database produced by the PREVIOUS release (schema v6, no
    // outbox columns): open with the current code, then rewind the events
    // table + migration record + schema_version to the old shape.
    const db = openDatabase(':memory:')
    db.prepare('INSERT INTO events (event_id, project_id, kind, payload, source, delivered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run('evt_preoutbox_1', 'p1', 'project.created', '{}', 'kernel', '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO events (event_id, project_id, kind, payload, source, delivered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run('evt_preoutbox_2', 'p1', 'gate.created', '{}', 'kernel', '2026-01-01T00:00:01.000Z')
    const outboxCols = ['event_seq', 'event_version', 'aggregate_type', 'aggregate_id', 'aggregate_revision',
      'request_id', 'session_id', 'attempts', 'last_error', 'next_attempt_at', 'dead_lettered_at']
    db.exec('DROP INDEX IF EXISTS idx_events_aggregate_seq')
    // 0013 (TRAJ-01) added a keyset index over the outbox columns — it is
    // part of the simulated "old shape" removal too.
    db.exec('DROP INDEX IF EXISTS idx_events_project_seq')
    for (const c of outboxCols) db.exec(`ALTER TABLE events DROP COLUMN ${c}`)
    db.exec("DELETE FROM schema_migrations WHERE id = '0008_outbox_envelope'")
    db.prepare("UPDATE meta SET value = '6' WHERE key = 'schema_version'").run()
    runMigrations(db)
    // Version bumped; outbox columns re-added by the new migration.
    expect((db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value: string }).value).toBe('12')
    const cols = tableInfo(db, 'events').map(c => c.name)
    for (const c of outboxCols) expect(cols).toContain(c)
    // Existing rows get default envelope values + a stable backfilled seq.
    const rows = db.prepare('SELECT event_id, event_seq, event_version, aggregate_type, aggregate_id, aggregate_revision, attempts, last_error, next_attempt_at, dead_lettered_at FROM events ORDER BY event_id').all() as Array<Record<string, unknown>>
    expect(rows).toEqual([
      { event_id: 'evt_preoutbox_1', event_seq: 1, event_version: 1, aggregate_type: null, aggregate_id: null, aggregate_revision: null, attempts: 0, last_error: null, next_attempt_at: null, dead_lettered_at: null },
      { event_id: 'evt_preoutbox_2', event_seq: 2, event_version: 1, aggregate_type: null, aggregate_id: null, aggregate_revision: null, attempts: 0, last_error: null, next_attempt_at: null, dead_lettered_at: null },
    ])
    // New envelope writes keep allocating past the backfilled seq.
    db.prepare(`INSERT INTO events (event_id, project_id, kind, payload, source, delivered, created_at, event_seq, event_version, aggregate_type, aggregate_id, aggregate_revision, request_id, session_id, attempts, last_error, next_attempt_at, dead_lettered_at)
      VALUES (?, ?, ?, '{}', 'kernel', 0, ?, ?, 1, 'project', 'p1', NULL, NULL, NULL, 0, NULL, NULL, NULL)`)
      .run('evt_post_1', 'p1', 'project.renamed', '2026-01-01T00:00:02.000Z', 3)
    const post = db.prepare('SELECT event_seq, aggregate_type, aggregate_id FROM events WHERE event_id = ?').get('evt_post_1') as { event_seq: number; aggregate_type: string; aggregate_id: string }
    expect(post.event_seq).toBe(3)
    expect(post.aggregate_type).toBe('project')
    expect(post.aggregate_id).toBe('p1')
    db.close()
  })

  it('keeps the committed v1 fixture asset present and buildable', () => {
    expect(existsSync(FIXTURE)).toBe(true)
    // The regeneration script must exist so the binary asset is reproducible.
    const script = fileURLToPath(new URL('../fixtures/databases/build-v1-fixture.mjs', import.meta.url))
    expect(existsSync(script)).toBe(true)
  })
})
