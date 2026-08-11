/**
 * STORAGE-07 (storage-migrations.md §8.2/§10): pre-migration startup backup
 * + CAS inventory.
 *
 * `createStartupBackup` produces, under `<dataDir>/backups/` (dataDir = the
 * directory holding the kernel database):
 *
 *  - `kernel-<ts>.db` — a consistent single-file snapshot of the database
 *    (SQLite `VACUUM INTO`, WAL-safe, 0600). Called BEFORE the kernel opens
 *    the database, so the snapshot is the PRE-migration state an operator
 *    can restore if a migration fails or a restore is needed.
 *  - `inventory-<ts>.json` — the CAS inventory (every blob sha256 + size +
 *    mod_time) plus instance metadata (db path, cas root, schema version and
 *    database id AT BACKUP TIME, blob count/bytes), 0600.
 *
 * The hook is opt-in (--backup-on-start / DSH_SCHOLAR_BACKUP_ON_START=1,
 * default off) and wired in bin/kernel.ts; it fails loudly when the
 * database is missing or the backup cannot be produced (an explicit
 * operator request must not silently no-op).
 * @module @dsh-scholar/research-kernel/backup
 */

import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ArtifactCas } from './cas.js'

export interface StartupBackupResult {
  backup_path: string
  inventory_path: string
  created_at: string
  db_path: string
  data_dir: string
  cas_root: string
  /** schema_version / database_id read from the PRE-migration database. */
  schema_version_at_backup: number | null
  database_id: string | null
  instance_id: string
  blob_count: number
  blob_bytes: number
}

/**
 * Create the pre-migration backup + CAS inventory. Throws when the database
 * file does not exist (nothing to back up — the caller decides whether that
 * is fatal) or the VACUUM INTO fails.
 */
export function createStartupBackup(opts: {
  dbPath: string
  casRoot: string
  instanceId?: string
}): StartupBackupResult {
  const dbPath = resolve(opts.dbPath)
  if (!existsSync(dbPath)) {
    throw new Error(`research-kernel backup: database ${dbPath} does not exist — nothing to back up`)
  }
  const dataDir = resolve(dirname(dbPath))
  const backupsDir = join(dataDir, 'backups')
  mkdirSync(backupsDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(backupsDir, `kernel-${ts}.db`)

  // Consistent snapshot via VACUUM INTO (safe on WAL databases; the source
  // connection only reads the current committed state).
  const src = new DatabaseSync(dbPath)
  try {
    src.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`)
  } finally {
    src.close()
  }
  chmodSync(backupPath, 0o600)

  // Instance metadata from the (pre-migration) database, read-only.
  let schemaVersion: number | null = null
  let databaseId: string | null = null
  try {
    const metaDb = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const meta = metaDb.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>
      const version = Number(meta.find(r => r.key === 'schema_version')?.value ?? NaN)
      schemaVersion = Number.isFinite(version) ? version : null
      databaseId = meta.find(r => r.key === 'database_id')?.value ?? null
    } finally {
      metaDb.close()
    }
  } catch {
    // Pre-migration databases may not carry meta yet — metadata stays null.
  }

  // CAS inventory: every blob with size + mod_time.
  const cas = new ArtifactCas(opts.casRoot)
  const blobs = cas.inventory()
  const blobBytes = blobs.reduce((sum, e) => sum + e.size_bytes, 0)
  const inventoryPath = join(backupsDir, `inventory-${ts}.json`)
  writeFileSync(inventoryPath, JSON.stringify({
    kind: 'cas-inventory',
    created_at: new Date().toISOString(),
    cas_root: cas.root,
    blob_count: blobs.length,
    blob_bytes: blobBytes,
    blobs,
  }, null, 2) + '\n', { mode: 0o600 })
  chmodSync(inventoryPath, 0o600)

  return {
    backup_path: backupPath,
    inventory_path: inventoryPath,
    created_at: new Date().toISOString(),
    db_path: dbPath,
    data_dir: dataDir,
    cas_root: cas.root,
    schema_version_at_backup: schemaVersion,
    database_id: databaseId,
    instance_id: opts.instanceId ?? `backup-${process.pid}`,
    blob_count: blobs.length,
    blob_bytes: blobBytes,
  }
}
