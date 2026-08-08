/**
 * Content-addressed artifact store (design §4.2 Artifact Registry, §6.6).
 * Artifacts are immutable: any modification yields a new object with a new
 * sha256; the database only stores references and metadata.
 * @module @dsh-scholar/research-kernel/cas
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, statSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

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
    if (!existsSync(target)) {
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
