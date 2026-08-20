import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MethodologyStore } from '../../packages/research-kernel/src/methodology-store.js'
import { NATIVE_KNOWLEDGE_PACKS } from '../../packages/research-kernel/src/native-knowledge-packs.js'

function open(path: string): { db: DatabaseSync; store: MethodologyStore } {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE IF NOT EXISTS projects (project_id TEXT PRIMARY KEY)')
  db.exec("INSERT OR IGNORE INTO projects (project_id) VALUES ('project_a')")
  return { db, store: new MethodologyStore(db, () => '2026-08-20T08:00:00.000Z') }
}

describe('durable native Knowledge delivery', () => {
  it('reconciles catalog idempotently and recovers active/deactivated status after reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scholar-knowledge-'))
    const path = join(dir, 'kernel.sqlite')
    try {
      let { db, store } = open(path)
      const first = store.reconcileNativeKnowledgePacks()
      expect(first.registry_revision).toBe(6)
      expect(first.package_names).toEqual(NATIVE_KNOWLEDGE_PACKS.map(pack => pack.record.manifest.name))
      expect(store.reconcileNativeKnowledgePacks()).toEqual(first)

      const pack = NATIVE_KNOWLEDGE_PACKS[0]!
      const activated = store.activateKnowledgePackage({
        request: {
          project_id: 'project_a', session_id: 'session_a',
          package_name: pack.record.manifest.name, package_version: pack.record.manifest.version,
          manifest_sha256: pack.record.manifest_sha256,
          payload_sha256: pack.record.manifest.payload_sha256,
          phase: 'WRITING', next_action_revision: 11, explicit_human_activation: true,
          principal_capabilities: pack.record.manifest.requested_capabilities,
          next_action_capabilities: pack.record.manifest.requested_capabilities,
          project_policy_capabilities: pack.record.manifest.requested_capabilities,
        },
        expected_revision: 0, expected_registry_revision: 6,
      })
      expect(store.resolveKnowledgeDelivery({
        project_id: 'project_a', session_id: 'session_a', phase: 'WRITING',
        next_action_revision: 11, surface: 'scholar-chat',
      }).deliveries).toHaveLength(1)
      db.close()

      ;({ db, store } = open(path))
      expect(store.reconcileNativeKnowledgePacks().registry_revision).toBe(6)
      expect(store.resolveKnowledgeDelivery({
        project_id: 'project_a', session_id: 'session_a', phase: 'WRITING',
        next_action_revision: 11, surface: 'scholar-chat',
      }).deliveries[0]?.activation_id).toBe(activated.record.activation_id)
      const stopped = store.deactivateKnowledgePackage({
        request: {
          project_id: 'project_a', session_id: 'session_a',
          activation_id: activated.record.activation_id,
          explicit_human_deactivation: true,
          reason: 'superseded',
        },
        expected_revision: 1,
      })
      expect(stopped.record.activation_id).toBe(activated.record.activation_id)
      expect(store.deactivateKnowledgePackage({
        request: {
          project_id: 'project_a', session_id: 'session_a', activation_id: activated.record.activation_id,
          explicit_human_deactivation: true, reason: 'superseded',
        },
        expected_revision: 1,
      })).toEqual(stopped)
      expect(store.projectRevision('project_a')).toBe(2)
      expect(store.resolveKnowledgeDelivery({
        project_id: 'project_a', session_id: 'session_a', phase: 'WRITING',
        next_action_revision: 11, surface: 'scholar-chat',
      })).toMatchObject({
        deliveries: [],
        suppressed: [{ activation_id: activated.record.activation_id, reason_codes: ['deactivated'] }],
      })
      db.close()

      ;({ db, store } = open(path))
      expect(store.listKnowledgeDeactivations('project_a').records).toHaveLength(1)
      expect(store.resolveKnowledgeDelivery({
        project_id: 'project_a', session_id: 'session_a', phase: 'WRITING',
        next_action_revision: 11, surface: 'scholar-chat',
      }).deliveries).toEqual([])
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('requires exact session and Human deactivation with zero write on denial', () => {
    const { db, store } = open(':memory:')
    try {
      store.reconcileNativeKnowledgePacks()
      const pack = NATIVE_KNOWLEDGE_PACKS[2]!
      const activation = store.activateKnowledgePackage({
        request: {
          project_id: 'project_a', session_id: 'session_a', package_name: pack.record.manifest.name,
          package_version: pack.record.manifest.version, manifest_sha256: pack.record.manifest_sha256,
          payload_sha256: pack.record.manifest.payload_sha256, phase: 'WRITING', next_action_revision: 2,
          explicit_human_activation: true,
          principal_capabilities: pack.record.manifest.requested_capabilities,
          next_action_capabilities: pack.record.manifest.requested_capabilities,
          project_policy_capabilities: pack.record.manifest.requested_capabilities,
        }, expected_revision: 0, expected_registry_revision: 6,
      })
      for (const request of [
        { project_id: 'project_a', session_id: 'other', activation_id: activation.record.activation_id, explicit_human_deactivation: true, reason: 'user-requested' },
        { project_id: 'project_a', session_id: 'session_a', activation_id: activation.record.activation_id, explicit_human_deactivation: false, reason: 'user-requested' },
      ]) {
        expect(() => store.deactivateKnowledgePackage({ request, expected_revision: 1 }))
          .toThrow()
        expect(store.projectRevision('project_a')).toBe(1)
      }
    } finally { db.close() }
  })

  it('never re-approves a revoked native pack during recovery', () => {
    const { db, store } = open(':memory:')
    try {
      store.reconcileNativeKnowledgePacks()
      const pack = NATIVE_KNOWLEDGE_PACKS[1]!
      store.activateKnowledgePackage({
        request: {
          project_id: 'project_a', session_id: 'session_a', package_name: pack.record.manifest.name,
          package_version: pack.record.manifest.version, manifest_sha256: pack.record.manifest_sha256,
          payload_sha256: pack.record.manifest.payload_sha256, phase: 'WRITING', next_action_revision: 3,
          explicit_human_activation: true,
          principal_capabilities: pack.record.manifest.requested_capabilities,
          next_action_capabilities: pack.record.manifest.requested_capabilities,
          project_policy_capabilities: pack.record.manifest.requested_capabilities,
        }, expected_revision: 0, expected_registry_revision: 6,
      })
      store.recordKnowledgeEvaluation({
        record: { ...pack.evaluation, verdict: 'revoked', granted_capabilities: [] },
        expected_revision: 6,
      })
      expect(store.reconcileNativeKnowledgePacks().registry_revision).toBe(7)
      expect(store.resolveKnowledgeDelivery({
        project_id: 'project_a', session_id: 'session_a', phase: 'WRITING',
        next_action_revision: 3, surface: 'scholar-chat',
      })).toMatchObject({ deliveries: [], suppressed: [{ reason_codes: ['package_revoked'] }] })
    } finally { db.close() }
  })
})
