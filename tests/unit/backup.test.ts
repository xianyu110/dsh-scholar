/**
 * STORAGE-07 (storage-migrations.md §8.2/§10): startup backup + CAS
 * inventory tests — the pre-migration snapshot file is produced, is a
 * valid openable SQLite database carrying the pre-backup schema, the
 * inventory JSON matches the CAS on-disk state (sha256 + size + mtime),
 * and the files are 0600.
 */
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { ResearchKernel, createStartupBackup } from '@dsh-scholar/research-kernel'

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

function freshKernelPaths(): { kernel: ResearchKernel; dir: string; dbPath: string; casRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-backup-'))
  const dbPath = join(dir, 'kernel.db')
  const casRoot = join(dir, 'cas')
  const kernel = new ResearchKernel({ dbPath, casRoot, requireSignedManifest: false })
  return { kernel, dir, dbPath, casRoot }
}

describe('startup backup + CAS inventory (STORAGE-07)', () => {
  it('produces an openable pre-migration DB snapshot + a CAS-consistent inventory (0600)', () => {
    const { kernel, dbPath, casRoot } = freshKernelPaths()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const art = kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'backup me' })
    kernel.submitJob({ project_id: project.project_id, idempotency_key: 'b1', kind: 'smoke' })
    const schemaBefore = kernel.schemaVersion()
    const dbId = kernel.databaseId()
    kernel.close()

    const result = createStartupBackup({ dbPath, casRoot, instanceId: 'test-instance' })

    // Backup file exists, is 0600, and opens as a valid SQLite database with
    // the same schema + data as the pre-backup state.
    expect(result.backup_path).toMatch(/backups\/kernel-.+\.db$/)
    expect(existsSync(result.backup_path)).toBe(true)
    expect(statSync(result.backup_path).mode & 0o777).toBe(0o600)
    const backupDb = new DatabaseSync(result.backup_path, { readOnly: true })
    try {
      const jobs = backupDb.prepare('SELECT job_id, status FROM jobs').all() as Array<{ job_id: string; status: string }>
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.status).toBe('queued')
      const meta = backupDb.prepare('SELECT key, value FROM meta WHERE key = ?').get('schema_version') as { value: string } | undefined
      expect(meta?.value).toBe(String(schemaBefore))
    } finally {
      backupDb.close()
    }
    expect(result.schema_version_at_backup).toBe(schemaBefore)
    expect(result.database_id).toBe(dbId)
    expect(result.data_dir).toBe(dirname(dbPath))

    // Inventory: every blob with size + mod_time, byte-identical to the CAS.
    expect(existsSync(result.inventory_path)).toBe(true)
    expect(statSync(result.inventory_path).mode & 0o777).toBe(0o600)
    const inventory = JSON.parse(readFileSync(result.inventory_path, 'utf8')) as {
      kind: string; cas_root: string; blob_count: number; blob_bytes: number
      blobs: Array<{ sha256: string; size_bytes: number; mod_time: string }>
    }
    expect(inventory.kind).toBe('cas-inventory')
    expect(inventory.cas_root).toBe(casRoot)
    expect(inventory.blob_count).toBe(1)
    expect(inventory.blobs[0]!.sha256).toBe(art.sha256)
    expect(inventory.blobs[0]!.size_bytes).toBe(Buffer.byteLength('backup me'))
    expect(new Date(inventory.blobs[0]!.mod_time).getTime()).toBeGreaterThan(0)
    // The listed blob hash is the content hash (inventory is self-consistent).
    expect(inventory.blobs[0]!.sha256).toBe(createHash('sha256').update('backup me').digest('hex'))
    expect(result.blob_count).toBe(1)
    expect(result.blob_bytes).toBe(Buffer.byteLength('backup me'))
    // (kernel.close() already ran before the backup — nothing left to close.)
  })

  it('fails loudly when the database does not exist (nothing to back up)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-backup-'))
    expect(() => createStartupBackup({ dbPath: join(dir, 'missing.db'), casRoot: join(dir, 'cas') }))
      .toThrowError(/does not exist/)
    rmSync(dir, { recursive: true, force: true })
  })
})
