/**
 * Content-addressed artifact store (design §4.2 Artifact Registry, §6.6).
 * Artifacts are immutable: any modification yields a new object with a new
 * sha256; the database only stores references and metadata.
 * @module @dsh-scholar/research-kernel/cas
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, statSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** One CAS inventory entry (STORAGE-07): identity + on-disk metadata. */
export interface CasInventoryEntry {
  sha256: string
  size_bytes: number
  /** ISO-8601 modification time of the blob file. */
  mod_time: string
}

export class ArtifactCas {
  readonly root: string

  constructor(root: string) {
    this.root = root
    mkdirSync(root, { recursive: true })
  }

  /** Absolute path of the immutable blob for `sha256` (hex, no prefix). */
  pathFor(sha256: string): string {
    return join(this.root, sha256)
  }

  /** Store `content`; returns { sha256, size_bytes }. Idempotent by content. */
  put(content: Uint8Array | string): { sha256: string; size_bytes: number } {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const target = this.pathFor(sha256)
    if (existsSync(target)) {
      // storage-migrations.md §6: an existing blob is only reused after a
      // SIZE verification — a size mismatch means the blob at this content
      // address is corrupted (hash collision or torn write) and MUST NOT be
      // silently treated as the same content.
      const existingSize = statSync(target).size
      if (existingSize !== bytes.byteLength) {
        throw new Error(
          `CAS blob ${sha256} exists with size ${existingSize} but content-addressed put has size ${bytes.byteLength} — blob corruption at ${target}`,
        )
      }
      return { sha256, size_bytes: bytes.byteLength }
    }
    // Atomic-ish write: temp file + rename so a concurrent writer never
    // observes a partial blob.
    const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`
    writeFileSync(tmp, bytes)
    try {
      // Rename over an existing (identical) target is fine on POSIX.
      mkdirSync(this.root, { recursive: true })
      renameSync(tmp, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      // Another writer won the race with identical content — keep the blob.
    }
    return { sha256, size_bytes: bytes.byteLength }
  }

  /** Read a blob back; throws when absent. */
  read(sha256: string): Buffer {
    return readFileSync(this.pathFor(sha256))
  }

  /** Whether the blob exists and is non-empty. */
  has(sha256: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return false
    try {
      return statSync(this.pathFor(sha256)).size > 0
    } catch {
      return false
    }
  }

  /** Every stored blob sha256 (acceptance-tests.md §3 blob scan). */
  list(): string[] {
    let entries: string[]
    try {
      entries = readdirSync(this.root)
    } catch {
      return []
    }
    return entries
      .filter(entry => /^[0-9a-f]{64}$/.test(entry) && !entry.endsWith('.tmp-'))
      .sort()
  }

  /**
   * STORAGE-07 (storage-migrations.md §8.2/§10): CAS inventory — every blob
   * with its on-disk size and modification time (ISO). Written by the
   * startup backup hook into backups/inventory-<ts>.json so a restore can
   * verify blob count/size/mtime before serving. Blobs that vanish between
   * list() and stat (concurrent GC) are skipped.
   */
  inventory(): CasInventoryEntry[] {
    const out: CasInventoryEntry[] = []
    for (const sha of this.list()) {
      try {
        const st = statSync(this.pathFor(sha))
        out.push({ sha256: sha, size_bytes: st.size, mod_time: new Date(st.mtimeMs).toISOString() })
      } catch {
        // Blob removed concurrently — skip (a later scan reports it missing).
      }
    }
    return out
  }

  /** Delete one blob; missing blobs are a no-op (orphan GC, §6 CAS). */
  remove(sha256: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return false
    try {
      unlinkSync(this.pathFor(sha256))
      return true
    } catch {
      return false
    }
  }

  /** mtime of a blob (grace-period GC); null when absent. */
  mtimeMs(sha256: string): number | null {
    try {
      return statSync(this.pathFor(sha256)).mtimeMs
    } catch {
      return null
    }
  }
}
