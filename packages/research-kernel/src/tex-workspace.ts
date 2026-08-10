/**
 * TeX Workspace store (execution-runtime.md §12, gui-plugin-plan §11):
 * versioned document files with CAS writes (expected_version), frozen
 * snapshots, and build records for latex-compile jobs. Text content lives
 * inline (v1); binary assets are planned via the CAS. The store owns a
 * second WAL connection to the kernel database.
 * @module @dsh-scholar/research-kernel/tex-workspace
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export class TexError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * File kind classification (reconstruction-contracts.md §11 TexFileKind).
 * Text content lives inline (v1); binary assets are planned via the CAS.
 */
export type TexFileKind = 'tex' | 'bib' | 'sty' | 'cls' | 'image' | 'generated' | 'other'

/** RFC 2046 media type derived from the file extension (tree/GET 'media'). */
export function fileMediaType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'tex': return 'text/x-tex'
    case 'bib': return 'text/x-bibtex'
    case 'sty': return 'text/x-tex'
    case 'cls': return 'text/x-tex'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'pdf': case 'eps': case 'svg': return 'application/octet-stream'
    default: return 'text/plain'
  }
}

/** File kind derived from the extension (reconstruction-contracts.md §11). */
export function fileKindOf(path: string): TexFileKind {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'tex': return 'tex'
    case 'bib': return 'bib'
    case 'sty': return 'sty'
    case 'cls': return 'cls'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'pdf': case 'eps': case 'svg': return 'image'
    default: return 'other'
  }
}

export interface TexFileEntry {
  path: string
  kind: TexFileKind
  media: string
  version: number
  content_hash: string
  content?: string
  created_at: string
}

export interface TexDocumentInfo {
  document_id: string
  project_id: string
  root_file: string
  revision: number
  created_at: string
  updated_at: string
}

export interface TexSnapshotManifest {
  schema_version: number
  document_id: string
  revision: number
  root_file: string
  files: Array<{ path: string; version: number; content_hash: string }>
  frozen_at: string
}

export interface TexBuild {
  build_id: string
  document_id: string
  revision: number
  root_file: string
  job_id: string | null
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  diagnostics: string
  pdf_artifact: string | null
  log_artifact: string | null
  created_at: string
  finished_at: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tex_documents (
  document_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_file TEXT NOT NULL DEFAULT 'paper.tex',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tex_files (
  document_id TEXT NOT NULL,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, path)
);
CREATE INDEX IF NOT EXISTS idx_tex_files_doc ON tex_files(document_id);
CREATE TABLE IF NOT EXISTS tex_snapshots (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, revision)
);
-- TEX-01 (§4 row 95): the snapshot is the MATERIALIZABLE byte source of a
-- build — every file's frozen content is stored alongside the manifest at
-- freeze time. The Runner fetches THESE bytes (revision-scoped), never the
-- current file, so a concurrent edit cannot leak into a compile.
CREATE TABLE IF NOT EXISTS tex_snapshot_files (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (document_id, revision, path)
);
CREATE INDEX IF NOT EXISTS idx_tex_snapshot_files_doc ON tex_snapshot_files(document_id, revision);
CREATE TABLE IF NOT EXISTS tex_builds (
  build_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  root_file TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL,
  diagnostics TEXT NOT NULL DEFAULT '[]',
  pdf_artifact TEXT,
  log_artifact TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tex_builds_doc ON tex_builds(document_id);
`

function nowIso(): string {
  return new Date().toISOString()
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function normalizePath(path: string): string {
  const clean = path.replaceAll('\\', '/')
  if (clean.startsWith('/') || clean.includes('..')) {
    throw new TexError('invalid_path', `path must be root-relative without '..': ${path}`)
  }
  return clean
}

/** Create (or open) the TeX workspace store on the kernel database path. */
export function openTexWorkspace(dbPath: string): TexWorkspaceStore {
  return new TexWorkspaceStore(dbPath)
}

export class TexWorkspaceStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  ensureDocument(projectId: string, rootFile = 'paper.tex'): TexDocumentInfo {
    const row = this.db.prepare('SELECT * FROM tex_documents WHERE project_id = ?').get(projectId) as TexDocumentInfo | undefined
    if (row !== undefined) return row
    const document: TexDocumentInfo = {
      document_id: `doc_${randomUUID().slice(0, 12)}`,
      project_id: projectId,
      root_file: normalizePath(rootFile),
      revision: 1,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    this.db.prepare('INSERT INTO tex_documents (document_id, project_id, root_file, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(document.document_id, document.project_id, document.root_file, document.revision, document.created_at, document.updated_at)
    return document
  }

  getDocument(documentId: string): TexDocumentInfo {
    const row = this.db.prepare('SELECT * FROM tex_documents WHERE document_id = ?').get(documentId) as TexDocumentInfo | undefined
    if (row === undefined) throw new TexError('document_not_found', `tex document ${documentId} not found`)
    return row
  }

  /** Bump the document revision (every mutation), returns the new revision. */
  private bumpRevision(documentId: string): number {
    const doc = this.getDocument(documentId)
    const next = doc.revision + 1
    this.db.prepare('UPDATE tex_documents SET revision = ?, updated_at = ? WHERE document_id = ?')
      .run(next, nowIso(), documentId)
    return next
  }

  tree(documentId: string): { document: TexDocumentInfo; files: TexFileEntry[] } {
    const document = this.getDocument(documentId)
    const rows = this.db.prepare('SELECT path, version, content, content_hash, created_at FROM tex_files WHERE document_id = ? ORDER BY path')
      .all(documentId) as unknown as Array<{ path: string; version: number; content: string; content_hash: string; created_at: string }>
    return {
      document,
      // tree/GET contract (acceptance-tests.md §7): each entry carries
      // path/kind/media/version so the UI can classify and version files.
      files: rows.map(r => ({
        path: r.path,
        kind: fileKindOf(r.path),
        media: fileMediaType(r.path),
        version: r.version,
        content_hash: r.content_hash,
        created_at: r.created_at,
      })),
    }
  }

  readFile(documentId: string, path: string): { path: string; kind: TexFileKind; media: string; version: number; content: string; content_hash: string } | null {
    const row = this.db.prepare('SELECT path, version, content, content_hash FROM tex_files WHERE document_id = ? AND path = ?')
      .get(documentId, normalizePath(path)) as { path: string; version: number; content: string; content_hash: string } | undefined
    if (row === null || row === undefined) return null
    return { ...row, kind: fileKindOf(row.path), media: fileMediaType(row.path) }
  }

  /**
   * CAS write. expected_version semantics (acceptance-tests.md §7):
   *   - undefined  → unchecked write (create or overwrite);
   *   - 0          → create-if-absent: the file must NOT exist yet (the UI
   *     "new file" flow sends 0); missing → create at version 1, existing →
   *     409 document_version_conflict (0 never equals a stored version >= 1);
   *   - N > 0      → must match the stored version, else 409; missing file
   *     with N > 0 is also a 409 (cannot write a nonexistent version).
   * Conflict → TexError 409.
   */
  writeFile(documentId: string, path: string, content: string, expectedVersion?: number): { version: number; content_hash: string } {
    const clean = normalizePath(path)
    this.getDocument(documentId)
    const existing = this.db.prepare('SELECT version, content FROM tex_files WHERE document_id = ? AND path = ?')
      .get(documentId, clean) as { version: number; content: string } | undefined
    if (existing === undefined) {
      if (expectedVersion !== undefined && expectedVersion !== 0) {
        throw new TexError('document_version_conflict', `file ${clean} does not exist (expected version ${expectedVersion})`)
      }
      const hash = sha256(content)
      this.db.prepare('INSERT INTO tex_files (document_id, path, version, content, content_hash, created_at) VALUES (?, ?, 1, ?, ?, ?)')
        .run(documentId, clean, content, hash, nowIso())
      this.bumpRevision(documentId)
      return { version: 1, content_hash: hash }
    }
    if (expectedVersion !== undefined && expectedVersion !== existing.version) {
      throw new TexError('document_version_conflict',
        `file ${clean} version ${existing.version} does not match expected version ${expectedVersion} — reload and merge`)
    }
    const hash = sha256(content)
    this.db.prepare('UPDATE tex_files SET version = version + 1, content = ?, content_hash = ?, created_at = ? WHERE document_id = ? AND path = ?')
      .run(content, hash, nowIso(), documentId, clean)
    this.bumpRevision(documentId)
    return { version: existing.version + 1, content_hash: hash }
  }

  /**
   * Delete requires the file to exist. expected_version semantics: undefined
   * = unchecked delete; 0 = never matches a stored version (>= 1) → 409
   * document_version_conflict ("reload before deleting"); N > 0 must match.
   */
  deleteFile(documentId: string, path: string, expectedVersion?: number): void {
    const clean = normalizePath(path)
    const existing = this.db.prepare('SELECT version FROM tex_files WHERE document_id = ? AND path = ?')
      .get(documentId, clean) as { version: number } | undefined
    if (existing === undefined) throw new TexError('file_not_found', `file ${clean} not found`)
    if (expectedVersion !== undefined && expectedVersion !== existing.version) {
      throw new TexError('document_version_conflict', `file ${clean} version changed; reload before deleting`)
    }
    this.db.prepare('DELETE FROM tex_files WHERE document_id = ? AND path = ?').run(documentId, clean)
    this.bumpRevision(documentId)
  }

  /**
   * Move = write the destination (create-if-absent, no expected version) plus
   * delete the source. expected_version guards the SOURCE: undefined =
   * unchecked; 0 = never matches a stored version (>= 1) → 409; N > 0 must
   * match the source version.
   */
  moveFile(documentId: string, fromPath: string, toPath: string, expectedVersion?: number): void {
    const from = normalizePath(fromPath)
    const to = normalizePath(toPath)
    const file = this.readFile(documentId, from)
    if (file === null) throw new TexError('file_not_found', `file ${from} not found`)
    if (expectedVersion !== undefined && expectedVersion !== file.version) {
      throw new TexError('document_version_conflict', `file ${from} version changed; reload before moving`)
    }
    this.writeFile(documentId, to, file.content)
    this.db.prepare('DELETE FROM tex_files WHERE document_id = ? AND path = ?').run(documentId, from)
    this.bumpRevision(documentId)
  }

  history(documentId: string): Array<{ revision: number; at: string }> {
    this.getDocument(documentId)
    const rows = this.db.prepare('SELECT DISTINCT revision, created_at FROM tex_files WHERE document_id = ? ORDER BY version DESC LIMIT 20')
      .all(documentId) as unknown as Array<{ revision: number; created_at: string }>
    const doc = this.getDocument(documentId)
    return rows.length > 0 ? rows.map(r => ({ revision: r.revision, at: r.created_at })) : [{ revision: doc.revision, at: doc.updated_at }]
  }

  /**
   * Freeze the current file set into a snapshot manifest (build input).
   * TEX-01 (§4 row 95): the freeze ALSO stores every file's content bytes in
   * tex_snapshot_files at this revision — the snapshot is the materializable
   * source for latex-compile. The manifest stays hash-only (tree/GET and
   * build payload contracts); bytes are read back via snapshotFile().
   * The document-revision CAS still applies: a stale expectedRevision → 409.
   */
  snapshot(documentId: string, expectedRevision?: number): { revision: number; manifest: TexSnapshotManifest } {
    const document = this.getDocument(documentId)
    if (expectedRevision !== undefined && expectedRevision !== document.revision) {
      throw new TexError('document_version_conflict',
        `document revision ${document.revision} does not match expected revision ${expectedRevision} — save before building`)
    }
    const rows = this.db.prepare('SELECT path, version, content, content_hash FROM tex_files WHERE document_id = ? ORDER BY path')
      .all(documentId) as unknown as Array<{ path: string; version: number; content: string; content_hash: string }>
    const manifest: TexSnapshotManifest = {
      schema_version: 1,
      document_id: documentId,
      revision: document.revision,
      root_file: document.root_file,
      files: rows.map(r => ({ path: r.path, version: r.version, content_hash: r.content_hash })),
      frozen_at: nowIso(),
    }
    // Manifest + frozen bytes are one atomic freeze: either both land or
    // neither (a partial snapshot must never be materializable).
    this.db.exec('BEGIN')
    try {
      this.db.prepare('INSERT OR REPLACE INTO tex_snapshots (document_id, revision, manifest, created_at) VALUES (?, ?, ?, ?)')
        .run(documentId, document.revision, JSON.stringify(manifest), manifest.frozen_at)
      this.db.prepare('DELETE FROM tex_snapshot_files WHERE document_id = ? AND revision = ?').run(documentId, document.revision)
      const insert = this.db.prepare('INSERT INTO tex_snapshot_files (document_id, revision, path, content, content_hash) VALUES (?, ?, ?, ?, ?)')
      for (const r of rows) insert.run(documentId, document.revision, r.path, r.content, r.content_hash)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { revision: document.revision, manifest }
  }

  /**
   * TEX-01: read the FROZEN bytes of one snapshot file at a given revision.
   * Returns null when the revision/path is not in the snapshot store (the
   * runner treats null as a hard materialization failure — never a fallback
   * to the current file). Path is root-relative with the usual traversal
   * rejection.
   */
  snapshotFile(documentId: string, revision: number, path: string): { path: string; content: string; content_hash: string } | null {
    this.getDocument(documentId)
    const row = this.db.prepare('SELECT path, content, content_hash FROM tex_snapshot_files WHERE document_id = ? AND revision = ? AND path = ?')
      .get(documentId, revision, normalizePath(path)) as { path: string; content: string; content_hash: string } | undefined
    return row ?? null
  }

  createBuild(documentId: string, revision: number, rootFile: string, jobId: string | null): TexBuild {
    const build: TexBuild = {
      build_id: `build_${randomUUID().slice(0, 12)}`,
      document_id: documentId,
      revision,
      root_file: rootFile,
      job_id: jobId,
      status: 'queued',
      diagnostics: '[]',
      pdf_artifact: null,
      log_artifact: null,
      created_at: nowIso(),
      finished_at: null,
    }
    this.db.prepare('INSERT INTO tex_builds (build_id, document_id, revision, root_file, job_id, status, diagnostics, pdf_artifact, log_artifact, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(build.build_id, build.document_id, build.revision, build.root_file, build.job_id, build.status, build.diagnostics, build.pdf_artifact, build.log_artifact, build.created_at, build.finished_at)
    return build
  }

  updateBuild(buildId: string, patch: {
    status?: TexBuild['status']
    diagnostics?: string
    pdf_artifact?: string | null
    log_artifact?: string | null
    job_id?: string | null
  }): TexBuild {
    const current = this.getBuild(buildId)
    const next: TexBuild = {
      ...current,
      ...patch,
      status: patch.status ?? current.status,
      diagnostics: patch.diagnostics ?? current.diagnostics,
      pdf_artifact: patch.pdf_artifact !== undefined ? patch.pdf_artifact : current.pdf_artifact,
      log_artifact: patch.log_artifact !== undefined ? patch.log_artifact : current.log_artifact,
      job_id: patch.job_id !== undefined ? patch.job_id : current.job_id,
      finished_at: (patch.status === 'succeeded' || patch.status === 'failed' || patch.status === 'cancelled') ? (current.finished_at ?? nowIso()) : current.finished_at,
    }
    this.db.prepare('UPDATE tex_builds SET status = ?, diagnostics = ?, pdf_artifact = ?, log_artifact = ?, job_id = ?, finished_at = ? WHERE build_id = ?')
      .run(next.status, next.diagnostics, next.pdf_artifact, next.log_artifact, next.job_id, next.finished_at, buildId)
    return next
  }

  getBuild(buildId: string): TexBuild {
    const row = this.db.prepare('SELECT * FROM tex_builds WHERE build_id = ?').get(buildId) as TexBuild | undefined
    if (row === undefined) throw new TexError('build_not_found', `tex build ${buildId} not found`)
    return row
  }

  listBuilds(documentId: string): TexBuild[] {
    this.getDocument(documentId)
    const rows = this.db.prepare('SELECT * FROM tex_builds WHERE document_id = ? ORDER BY created_at DESC').all(documentId) as unknown as TexBuild[]
    return rows
  }
}
