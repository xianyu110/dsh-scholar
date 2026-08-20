import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AssuranceAudit, type AssuranceAudit as AssuranceAuditValue } from '@dsh-scholar/research-schemas'
import {
  ASSURANCE_DDL,
  AssuranceStore,
  AssuranceStoreError,
} from '../../packages/research-kernel/src/assurance-store.js'

const HASH = `sha256:${'a'.repeat(64)}`
const OTHER_HASH = `sha256:${'b'.repeat(64)}`

function audit(overrides: Partial<AssuranceAuditValue> = {}): AssuranceAuditValue {
  return AssuranceAudit.parse({
    audit_id: 'audit_claim_evidence_1',
    project_id: 'project_a',
    audit_kind: 'claim-evidence',
    target_refs: [{ kind: 'manuscript', id: 'paper', revision: 3 }],
    assurance_level: 'submission',
    execution: { status: 'succeeded', run_ref: 'run_1' },
    verdict: 'PASS',
    reason_code: 'checks_passed',
    findings_artifact_id: HASH,
    input_pins: [{ ref: 'tex:paper', sha256: HASH }],
    review: { method: 'deterministic', independence: 'deterministic' },
    acceptance_status: 'pending',
    created_at: '2026-08-20T01:00:00.000Z',
    ...overrides,
  })
}

function setup(): { db: DatabaseSync; store: AssuranceStore } {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE projects (project_id TEXT PRIMARY KEY);
    CREATE TABLE artifacts (
      project_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      PRIMARY KEY (project_id, artifact_id)
    );
  `)
  db.prepare('INSERT INTO projects (project_id) VALUES (?)').run('project_a')
  db.prepare('INSERT INTO projects (project_id) VALUES (?)').run('project_b')
  db.prepare('INSERT INTO artifacts (project_id, artifact_id) VALUES (?, ?)').run('project_a', HASH)
  db.prepare('INSERT INTO artifacts (project_id, artifact_id) VALUES (?, ?)').run('project_b', OTHER_HASH)
  db.exec(ASSURANCE_DDL)
  return {
    db,
    store: new AssuranceStore(db, () => '2026-08-20T02:00:00.000Z'),
  }
}

function expectStoreError(fn: () => unknown, status: number, code: string): void {
  try {
    fn()
    throw new Error('expected AssuranceStoreError')
  } catch (error) {
    expect(error).toBeInstanceOf(AssuranceStoreError)
    expect(error).toMatchObject({ status, code })
  }
}

describe('AssuranceStore', () => {
  it('records immutable project-scoped audits and retrieves them through the public seam', () => {
    const { db, store } = setup()
    try {
      const recorded = store.record({ audit: audit(), expected_revision: 0 })
      expect(recorded).toMatchObject({
        project_id: 'project_a',
        revision: 1,
        audit: { audit_id: 'audit_claim_evidence_1', findings_artifact_id: HASH },
      })
      expect(store.get('project_a', 'audit_claim_evidence_1')).toEqual(recorded)
      expect(store.list('project_a')).toEqual({
        project_id: 'project_a',
        revision: 1,
        audits: [recorded],
      })
    } finally {
      db.close()
    }
  })

  it('records acceptance as a separate revision and projects it onto the immutable audit', () => {
    const { db, store } = setup()
    try {
      store.record({ audit: audit(), expected_revision: 0 })
      const accepted = store.accept({
        project_id: 'project_a',
        audit_id: 'audit_claim_evidence_1',
        expected_revision: 1,
        accepted_by: 'principal_verifier',
      })
      expect(accepted).toMatchObject({
        revision: 2,
        recorded_revision: 1,
        acceptance_revision: 2,
        accepted_by: 'principal_verifier',
        accepted_at: '2026-08-20T02:00:00.000Z',
        audit: { acceptance_status: 'accepted' },
      })
      expect(store.list('project_a')).toMatchObject({ revision: 2, audits: [accepted] })
    } finally {
      db.close()
    }
  })

  it('requires accepted status to enter through the separate acceptance lifecycle', () => {
    const { db, store } = setup()
    try {
      expectStoreError(
        () => store.record({ audit: audit({ acceptance_status: 'accepted' }), expected_revision: 0 }),
        422,
        'assurance_acceptance_requires_accept',
      )
      expect(store.list('project_a')).toMatchObject({ revision: 0, audits: [] })
    } finally {
      db.close()
    }
  })

  it('rejects a supersedes reference that resolves only in another project', () => {
    const { db, store } = setup()
    try {
      store.record({ audit: audit(), expected_revision: 0 })
      expectStoreError(
        () => store.record({
          audit: audit({
            audit_id: 'audit_claim_evidence_2',
            project_id: 'project_b',
            findings_artifact_id: OTHER_HASH,
            supersedes: 'audit_claim_evidence_1',
          }),
          expected_revision: 0,
        }),
        422,
        'assurance_superseded_audit_not_found',
      )
      expect(store.list('project_b')).toMatchObject({ revision: 0, audits: [] })
    } finally {
      db.close()
    }
  })

  it('requires an explicit linear supersedes chain for a newer audit of the same kind', () => {
    const { db, store } = setup()
    try {
      store.record({ audit: audit(), expected_revision: 0 })
      const replacement = audit({
        audit_id: 'audit_claim_evidence_2',
        created_at: '2026-08-20T03:00:00.000Z',
      })
      expectStoreError(
        () => store.record({ audit: replacement, expected_revision: 1 }),
        422,
        'assurance_supersedes_required',
      )
      const recorded = store.record({
        audit: { ...replacement, supersedes: 'audit_claim_evidence_1' },
        expected_revision: 1,
      })
      expect(recorded).toMatchObject({ revision: 2, recorded_revision: 2 })
      expect(store.list('project_a').audits.map(item => item.audit.audit_id)).toEqual([
        'audit_claim_evidence_1',
        'audit_claim_evidence_2',
      ])
    } finally {
      db.close()
    }
  })

  it('accepts only the current audit at the caller-observed project revision', () => {
    const { db, store } = setup()
    try {
      store.record({ audit: audit(), expected_revision: 0 })
      store.record({
        audit: audit({
          audit_id: 'audit_claim_evidence_2',
          supersedes: 'audit_claim_evidence_1',
          created_at: '2026-08-20T03:00:00.000Z',
        }),
        expected_revision: 1,
      })
      expectStoreError(
        () => store.accept({
          project_id: 'project_a',
          audit_id: 'audit_claim_evidence_1',
          expected_revision: 2,
          accepted_by: 'principal_verifier',
        }),
        409,
        'assurance_audit_superseded',
      )
      const accepted = store.accept({
        project_id: 'project_a',
        audit_id: 'audit_claim_evidence_2',
        expected_revision: 2,
        accepted_by: 'principal_verifier',
      })
      expect(accepted).toMatchObject({ revision: 3, audit: { acceptance_status: 'accepted' } })
    } finally {
      db.close()
    }
  })

  it('rejects stale revision writes without partially appending an event', () => {
    const { db, store } = setup()
    try {
      store.record({ audit: audit(), expected_revision: 0 })
      expectStoreError(
        () => store.record({
          audit: audit({ audit_id: 'audit_citation_1', audit_kind: 'citation' }),
          expected_revision: 0,
        }),
        409,
        'assurance_revision_conflict',
      )
      expectStoreError(
        () => store.accept({
          project_id: 'project_a',
          audit_id: 'audit_claim_evidence_1',
          expected_revision: 0,
          accepted_by: 'principal_verifier',
        }),
        409,
        'assurance_revision_conflict',
      )
      expect(store.list('project_a')).toMatchObject({
        revision: 1,
        audits: [{ audit: { audit_id: 'audit_claim_evidence_1', acceptance_status: 'pending' } }],
      })
    } finally {
      db.close()
    }
  })

  it('fences findings Artifacts by project and makes persisted events immutable', () => {
    const { db, store } = setup()
    try {
      expectStoreError(
        () => store.record({
          audit: audit({ findings_artifact_id: OTHER_HASH }),
          expected_revision: 0,
        }),
        422,
        'assurance_findings_artifact_not_found',
      )
      store.record({ audit: audit(), expected_revision: 0 })
      expect(() => db.prepare(
        "UPDATE assurance_events SET findings_artifact_id = ? WHERE project_id = ? AND revision = 1",
      ).run(OTHER_HASH, 'project_a')).toThrow(/assurance_events_append_only/)
      expect(() => db.prepare(
        'DELETE FROM artifacts WHERE project_id = ? AND artifact_id = ?',
      ).run('project_a', HASH)).toThrow(/FOREIGN KEY constraint failed/)
      expectStoreError(
        () => store.get('project_b', 'audit_claim_evidence_1'),
        404,
        'assurance_audit_not_found',
      )
    } finally {
      db.close()
    }
  })

  it('makes the exported DDL bind audit JSON identity to its project-scoped Artifact columns', () => {
    const { db } = setup()
    try {
      expect(() => db.prepare(`
        INSERT INTO assurance_events
          (project_id, revision, event_type, audit_id, audit_json, findings_artifact_id, actor_ref, created_at)
        VALUES (?, 1, 'audit_recorded', ?, ?, ?, NULL, ?)
      `).run(
        'project_a',
        'audit_tampered_identity',
        JSON.stringify(audit()),
        HASH,
        '2026-08-20T01:00:00.000Z',
      )).toThrow(/CHECK constraint failed/)
      expect(() => db.prepare(`
        INSERT INTO assurance_events
          (project_id, revision, event_type, audit_id, audit_json, findings_artifact_id, actor_ref, created_at)
        VALUES (?, 1, 'audit_recorded', ?, ?, ?, NULL, ?)
      `).run(
        'project_a',
        'audit_claim_evidence_1',
        JSON.stringify(audit({ acceptance_status: 'accepted' })),
        HASH,
        '2026-08-20T01:00:00.000Z',
      )).toThrow(/CHECK constraint failed/)
      expect(() => db.prepare(`
        INSERT INTO assurance_events
          (project_id, revision, event_type, audit_id, audit_json, findings_artifact_id, actor_ref, created_at)
        VALUES (?, 1, 'audit_accepted', ?, NULL, NULL, ?, ?)
      `).run(
        'project_a',
        'audit_missing',
        'principal_verifier',
        '2026-08-20T01:00:00.000Z',
      )).toThrow(/assurance_acceptance_audit_missing/)
    } finally {
      db.close()
    }
  })

  it('projects current project audits through the pure freshness verifier', () => {
    const { db, store } = setup()
    try {
      store.record({ audit: audit(), expected_revision: 0 })
      store.accept({
        project_id: 'project_a',
        audit_id: 'audit_claim_evidence_1',
        expected_revision: 1,
        accepted_by: 'principal_verifier',
      })

      expect(store.project({
        project_id: 'project_a',
        level: 'submission',
        required_audit_kinds: ['claim-evidence'],
        current_input_hashes: { 'tex:paper': HASH },
      })).toMatchObject({
        project_id: 'project_a',
        revision: 2,
        overall_assurance: 'accepted',
        submission_ready: true,
        audits: [{ audit_id: 'audit_claim_evidence_1', effective_acceptance_status: 'accepted' }],
      })

      expect(store.project({
        project_id: 'project_a',
        level: 'submission',
        required_audit_kinds: ['claim-evidence'],
        current_input_hashes: { 'tex:paper': OTHER_HASH },
      })).toMatchObject({
        revision: 2,
        overall_assurance: 'blocked',
        submission_ready: false,
        audits: [{ effective_acceptance_status: 'stale', reasons: ['input_hash_mismatch'] }],
      })
      expect(store.get('project_a', 'audit_claim_evidence_1').audit.acceptance_status).toBe('accepted')
    } finally {
      db.close()
    }
  })
})
