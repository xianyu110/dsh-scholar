/**
 * WORK-01 (hardening-v0.2-status.md §3/§4, api-contracts.md §17) — generic
 * VS Code-style Workspace store with a REAL filesystem adapter.
 *
 * One unified store for code/scratch/manuscript trees with the same
 * revision/etag/CAS semantics the TeX workspace already implements
 * (tex-workspace.ts is the facade reference; tex-facade.ts maps it onto this
 * contract). Every mutation:
 *
 *   - bumps the workspace `revision` and the per-path `version`;
 *   - records a durable op (create/write/delete/move) with the target
 *     version — the CAS key the next write must carry;
 *   - computes the node `hash` (sha256 of the bytes) and the strong `etag`
 *     (`"<version>-<sha256[0..12]>"` — workspaceEtag in research-schemas);
 *   - rejects stale CAS with 409 (`workspace_version_conflict` /
 *     `workspace_etag_conflict`) — no silent last-write-wins.
 *
 * ── disk adapter (this round) ─────────────────────────────────────────────
 *
 *   - Every node's BYTES live on disk under
 *     `{workspacesRoot}/{project_id}/{workspace_id}/{normalized-path}`
 *     (directory chain chmod 0750, files 0640; the root is created on
 *     `ensure`). `workspace_nodes` holds the METADATA only
 *     (path/kind/media/size/version/hash/etag/updated_at; the legacy
 *     `content` column is unused by the adapter and stays NULL).
 *   - Writes are atomic: bytes go to a temp file in the TARGET directory
 *     (`<name>.ws-tmp-<rand>`) and are `rename()`d over the target — a
 *     reader never observes a partial file.
 *   - Binary nodes keep their artifact-CAS reference: `writeBinary` also
 *     puts the bytes into the CAS (idempotent by content, server-computed
 *     sha256) so `blob_sha256` stays a real CAS link; the WORKING bytes are
 *     the tree file (read back from disk by `blob`/`read`).
 *   - Size cap: one node ≤ `WORKSPACE_MAX_FILE_BYTES` (32 MiB — reuses the
 *     upload limit; see upload-limits.ts). Oversized writes → 413-shaped
 *     `workspace_file_too_large` (server maps it to HTTP 413).
 *   - History: the last `HISTORY_KEEP_VERSIONS` (8) per-path versions are
 *     kept under `{workspacesRoot}/.ws-meta/{workspace_id}/history/` as
 *     `{path}@{version}` (bytes, not DB rows) — `readVersion(path, N)`
 *     rolls a node back to a stored version (delete keeps the deleted
 *     version too, so undo works). Older versions are pruned on write.
 *   - watch/search: `listSince(revision)` returns the current nodes of every
 *     path mutated after a workspace revision (plus `deleted` tombstones —
 *     the watch/change feed); `search` is PATH matching only (prefix and/or
 *     `*`/`?` glob, `*` does not cross `/`) — content search is NOT
 *     implemented (documented limitation, no full-text index).
 *
 * ── path safety (execution-runtime.md §4 snapshot-walk contract) ──────────
 *
 * Root-relative POSIX paths only; absolute paths, Windows drive prefixes,
 * `..`/`.` segments, NUL bytes, backslashes and empty segments are rejected
 * (`normalizeWorkspacePath`, shared with the interface layer). On disk the
 * adapter additionally refuses to cross ANY symbolic link (each existing
 * path component is `lstat`ed; a symlink anywhere → 422 `workspace_symlink`)
 * — the generic workspace tree is regular files only, which implies the
 * snapshot-walk rule "no symlink escapes the root" (a strict superset).
 *
 * The browser editor UI (tabs/search/watch/upload/move/history panels) is
 * NOT part of this round — this store is the real durable adapter the UI
 * will call through the server routes (server.ts `/v1/projects/{id}/
 * workspaces*`).
 * @module @dsh-scholar/research-kernel/workspace-store
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { workspaceEtag, type WorkspaceInfo, type WorkspaceKind, type WorkspaceNode, type WorkspaceOp, type WorkspaceRevision } from '@dsh-scholar/research-schemas'
import { ArtifactCas } from './cas.js'
import { UPLOAD_MAX_FILE_BYTES } from './upload-limits.js'

/** sha256 of the empty string — carried by synthesized `dir` nodes where a
 * hash is structurally required but semantically meaningless. */
export const EMPTY_CONTENT_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** Per-path history retention: the last N versions of every path (bytes
 * under `{workspacesRoot}/.ws-meta/{workspace_id}/history/`). Documented in
 * execution-runtime.md §12.2 — older versions are pruned on every write. */
export const HISTORY_KEEP_VERSIONS = 8

/**
 * Hard cap for ONE workspace node (any kind). Reuses the upload limit
 * (upload-limits.ts `UPLOAD_MAX_FILE_BYTES`) so every byte that can enter
 * the research system through a browser path shares one bound. Writes
 * beyond it → `workspace_file_too_large` (HTTP 413).
 */
export const WORKSPACE_MAX_FILE_BYTES = UPLOAD_MAX_FILE_BYTES

/** Error raised by the workspace store. `code` is the stable wire code. */
export class WorkspaceError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = code
  }
}

/**
 * The generic workspace contract every workspace backend satisfies — the
 * durable store (WorkspaceStore) and the TeX facade (TexWorkspaceFacade in
 * tex-facade.ts) both implement it, so consumers (kernel routes, future
 * filesystem adapters, UI) never know which backend backs a workspace.
 */
export interface WorkspaceStoreLike {
  ensure(projectId: string, kind: WorkspaceKind, name: string): WorkspaceInfo
  get(workspaceId: string): WorkspaceInfo
  tree(workspaceId: string): { info: WorkspaceInfo; nodes: WorkspaceNode[] }
  read(workspaceId: string, path: string): WorkspaceNode | null
  write(workspaceId: string, path: string, content: string, expected?: WorkspaceExpected): WorkspaceNode
  writeBinary(workspaceId: string, path: string, bytes: Uint8Array, media: string, expected?: WorkspaceExpected): WorkspaceNode
  deleteNode(workspaceId: string, path: string, expected?: WorkspaceExpected): void
  moveNode(workspaceId: string, fromPath: string, toPath: string, expected?: WorkspaceExpected): WorkspaceNode
  history(workspaceId: string): WorkspaceRevision[]
  /** Binary node bytes (null for text/missing nodes). */
  blob(workspaceId: string, path: string): Buffer | null
  /** Watch feed: current nodes of every path mutated after `sinceRevision`,
   * plus paths deleted after it. `sinceRevision >= info.revision` → empty. */
  listSince(workspaceId: string, sinceRevision: number): { info: WorkspaceInfo; nodes: WorkspaceNode[]; deleted: string[] }
  /** PATH search (prefix and/or `*`/`?` glob — `*` never crosses `/`).
   * Content search is NOT implemented (documented limitation). */
  search(workspaceId: string, query: { prefix?: string; glob?: string }): { info: WorkspaceInfo; nodes: WorkspaceNode[] }
  /** Rollback read: node bytes at a stored per-path version (history), or
   * null when that version is not retained. */
  readVersion(workspaceId: string, path: string, version: number): WorkspaceNode | null
}

/** CAS expectation of a mutation: either the version or the etag (or both —
 * both must match when both are given). */
export interface WorkspaceExpected {
  version?: number
  etag?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Path safety (execution-runtime.md §4 snapshot-walk contract): root-relative
 * POSIX paths only. Rejects absolute paths (and Windows drive prefixes),
 * `..` and `.` segments, NUL bytes, empty segments (leading/trailing/
 * doubled `/`) and backslash ambiguity. Returns the normalized path.
 */
export function normalizeWorkspacePath(path: string): string {
  if (path === '') throw new WorkspaceError('invalid_path', 'workspace path must not be empty')
  if (path.includes('\u0000')) throw new WorkspaceError('invalid_path', 'workspace path must not contain NUL')
  if (path.includes('\\')) throw new WorkspaceError('invalid_path', `workspace path must use '/' separators: ${path}`)
  if (path.startsWith('/')) throw new WorkspaceError('invalid_path', `workspace path must be root-relative: ${path}`)
  if (/^[A-Za-z]:/.test(path)) throw new WorkspaceError('invalid_path', `workspace path must not carry a Windows drive prefix: ${path}`)
  const segments = path.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new WorkspaceError('invalid_path', `workspace path must not contain empty, '.' or '..' segments: ${path}`)
    }
  }
  return path
}

/** Simple `*`/`?` glob matcher over workspace paths. `*` matches within ONE
 * segment (`[^/]*` — it never crosses `/`); `?` matches one non-`/` char.
 * The pattern itself must be a valid normalized path (globs may contain
 * `*`/`?` characters which the normalizer otherwise allows). */
export function matchWorkspaceGlob(path: string, glob: string): boolean {
  let re = ''
  for (const ch of glob) {
    if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`).test(path)
}

/**
 * Table DDL — parity copy of migration 0011 (the store opens its own WAL
 * connection, exactly like tex-workspace.ts; CREATE IF NOT EXISTS keeps both
 * connections in sync). The disk adapter writes the `content` column as NULL
 * (bytes live on disk); the column is kept for migration parity.
 */
export const WORKSPACE_DDL = `
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('code','manuscript','scratch')),
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id);
CREATE TABLE IF NOT EXISTS workspace_nodes (
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  binary INTEGER NOT NULL DEFAULT 0,
  media TEXT NOT NULL DEFAULT 'text/plain',
  size_bytes INTEGER NOT NULL,
  content TEXT,
  blob_sha256 TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, path)
);
CREATE INDEX IF NOT EXISTS idx_workspace_nodes_ws ON workspace_nodes(workspace_id);
-- Durable op ledger (history / revision projection).
CREATE TABLE IF NOT EXISTS workspace_ops (
  workspace_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('create','write','delete','move')),
  path TEXT NOT NULL,
  from_path TEXT,
  version INTEGER,
  sha256 TEXT,
  workspace_revision INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_workspace_ops_ws ON workspace_ops(workspace_id, seq);
`

interface WorkspaceInfoRow {
  workspace_id: string
  project_id: string
  kind: string
  name: string
  revision: number
  created_at: string
  updated_at: string
}

interface WorkspaceNodeRow {
  workspace_id: string
  path: string
  version: number
  binary: number
  media: string
  size_bytes: number
  content: string | null
  blob_sha256: string | null
  content_hash: string
  created_at: string
  updated_at: string
}

interface WorkspaceOpRow {
  workspace_id: string
  seq: number
  op: string
  path: string
  from_path: string | null
  version: number | null
  sha256: string | null
  workspace_revision: number
  at: string
}

/** Open the generic workspace store on the kernel database path. */
export function openWorkspaceStore(dbPath: string, casRoot: string, workspacesRoot: string): WorkspaceStore {
  return new WorkspaceStore(dbPath, casRoot, workspacesRoot)
}

export class WorkspaceStore implements WorkspaceStoreLike {
  private readonly db: DatabaseSync
  private readonly cas: ArtifactCas
  /** Host root holding every workspace tree + history (`{workspacesRoot}`). */
  readonly workspacesRoot: string

  constructor(dbPath: string, casRoot: string, workspacesRoot: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(WORKSPACE_DDL)
    this.cas = new ArtifactCas(casRoot)
    this.workspacesRoot = workspacesRoot
    mkdirSync(workspacesRoot, { recursive: true, mode: 0o750 })
  }

  close(): void {
    this.db.close()
  }

  /** The artifact CAS backing binary node references (kernel passes the
   * same root). */
  get casRef(): ArtifactCas {
    return this.cas
  }

  /** Host directory holding the tree of one workspace (0750). */
  workspaceRoot(workspaceId: string): string {
    const info = this.getInfoRow(workspaceId)
    return join(this.workspacesRoot, info.project_id, workspaceId)
  }

  /** Host directory holding per-path version history of one workspace. */
  historyRoot(workspaceId: string): string {
    const info = this.getInfoRow(workspaceId)
    return join(this.workspacesRoot, '.ws-meta', workspaceId, 'history')
  }

  /** Absolute host path of a normalized workspace path inside the tree root
   * (never exposed to callers — internal helper). */
  private absPath(workspaceId: string, cleanPath: string): string {
    return join(this.workspaceRoot(workspaceId), ...cleanPath.split('/'))
  }

  /** History file of `{path}@{version}` (internal): the last segment carries
   * `@<version>` so one path = one file (nested paths keep their dirs). */
  private historyPath(workspaceId: string, cleanPath: string, version: number): string {
    const segments = cleanPath.split('/')
    const last = segments.at(-1) ?? 'file'
    return join(this.historyRoot(workspaceId), ...segments.slice(0, -1), `${last}@${version}`)
  }

  /**
   * Symlink policy (execution-runtime.md §4 / snapshot-walk contract): the
   * workspace tree is regular files only — any symbolic link on the path
   * (existing component or final target) is rejected with 422
   * `workspace_symlink`. This is a strict superset of "no symlink escapes
   * the root" (a link that stays inside the root is still rejected, because
   * a generic workspace tree must be a plain directory of files).
   */
  private assertNoSymlink(workspaceId: string, cleanPath: string): void {
    const root = this.workspaceRoot(workspaceId)
    const segments = cleanPath.split('/')
    let current = root
    for (const segment of segments) {
      current = join(current, segment)
      let st
      try {
        st = lstatSync(current)
      } catch {
        return // first missing component — the rest will be created fresh
      }
      if (st.isSymbolicLink()) {
        throw new WorkspaceError('workspace_symlink',
          `workspace path crosses a symbolic link (rejected): ${cleanPath}`)
      }
    }
  }

  /** Size guard shared by every byte write (text + binary). */
  private assertSize(workspaceId: string, cleanPath: string, bytes: number): void {
    if (bytes > WORKSPACE_MAX_FILE_BYTES) {
      throw new WorkspaceError('workspace_file_too_large',
        `workspace file ${cleanPath} is ${bytes} bytes (max_file_bytes=${WORKSPACE_MAX_FILE_BYTES})`)
    }
  }

  /** Atomic byte write: temp file in the target directory + rename. */
  private writeBytesAtomic(target: string, bytes: Uint8Array): void {
    const dir = dirname(target)
    mkdirSync(dir, { recursive: true, mode: 0o750 })
    const tmp = join(dir, `${target.split('/').at(-1) ?? 'file'}.ws-tmp-${randomBytes(4).toString('hex')}`)
    writeFileSync(tmp, bytes, { mode: 0o640 })
    try {
      renameSync(tmp, target)
    } catch (error) {
      try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
      throw error
    }
  }

  /** Copy `{path}@{version}` into the workspace history (retention-pruned).
   * The bytes are COPYIED (not moved) so a crash between history write and
   * the node write never loses the current file. */
  private keepHistory(workspaceId: string, cleanPath: string, version: number): void {
    const source = this.absPath(workspaceId, cleanPath)
    if (!existsSync(source)) return
    const target = this.historyPath(workspaceId, cleanPath, version)
    this.writeBytesAtomic(target, readFileSync(source))
    // Prune to HISTORY_KEEP_VERSIONS newest per path.
    const dir = dirname(target)
    const base = target.split('/').at(-1) as string
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    const versions = entries
      .filter(e => e.startsWith(`${base.slice(0, base.lastIndexOf('@'))}@`) && /^@\d+$/.test(e.slice(base.lastIndexOf('@'))))
      .map(e => ({ e, v: Number(e.slice(base.lastIndexOf('@') + 1)) }))
      .sort((a, b) => b.v - a.v)
    for (const entry of versions.slice(HISTORY_KEEP_VERSIONS)) {
      try { unlinkSync(join(dir, entry.e)) } catch { /* raced */ }
    }
  }

  private infoFromRow(row: WorkspaceInfoRow): WorkspaceInfo {
    return {
      workspace_id: row.workspace_id,
      project_id: row.project_id,
      kind: row.kind as WorkspaceKind,
      name: row.name,
      revision: row.revision,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  /** Metadata → wire node. `content` is passed explicitly: tree/search/
   * listSince never read bytes (null), read() supplies them. */
  private nodeFromRow(row: WorkspaceNodeRow, content: string | null): WorkspaceNode {
    return {
      path: row.path,
      kind: 'file',
      binary: row.binary === 1,
      media: row.media,
      size: row.size_bytes,
      version: row.version,
      etag: workspaceEtag(row.version, row.content_hash),
      hash: row.content_hash,
      content: row.binary === 1 ? null : content,
      blob_sha256: row.binary === 1 ? row.blob_sha256 : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  private getInfoRow(workspaceId: string): WorkspaceInfoRow {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE workspace_id = ?').get(workspaceId) as WorkspaceInfoRow | undefined
    if (row === undefined) throw new WorkspaceError('workspace_not_found', `workspace ${workspaceId} not found`)
    return row
  }

  get(workspaceId: string): WorkspaceInfo {
    return this.infoFromRow(this.getInfoRow(workspaceId))
  }

  /** Every workspace of a project (generic kinds; manuscript workspaces are
   * served by the TeX facade and listed by the kernel). */
  listByProject(projectId: string): WorkspaceInfo[] {
    const rows = this.db.prepare('SELECT * FROM workspaces WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as WorkspaceInfoRow[]
    return rows.map(r => this.infoFromRow(r))
  }

  /** Create (or open) a workspace for a project. The tree root is created
   * on disk with a 0750 chain. */
  ensure(projectId: string, kind: WorkspaceKind, name: string): WorkspaceInfo {
    const existing = this.db.prepare('SELECT * FROM workspaces WHERE project_id = ? AND kind = ? AND name = ?').get(projectId, kind, name) as WorkspaceInfoRow | undefined
    if (existing !== undefined) return this.infoFromRow(existing)
    const at = nowIso()
    const info: WorkspaceInfo = {
      workspace_id: `ws_${randomUUID().slice(0, 12)}`,
      project_id: projectId,
      kind,
      name,
      revision: 1,
      created_at: at,
      updated_at: at,
    }
    this.db.prepare('INSERT INTO workspaces (workspace_id, project_id, kind, name, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(info.workspace_id, info.project_id, info.kind, info.name, info.revision, info.created_at, info.updated_at)
    const root = this.workspaceRoot(info.workspace_id)
    mkdirSync(root, { recursive: true, mode: 0o750 })
    try {
      chmodSync(root, 0o750)
    } catch { /* best-effort (some filesystems ignore modes) */ }
    return info
  }

  private bumpRevision(workspaceId: string): number {
    const info = this.getInfoRow(workspaceId)
    const next = info.revision + 1
    this.db.prepare('UPDATE workspaces SET revision = ?, updated_at = ? WHERE workspace_id = ?').run(next, nowIso(), workspaceId)
    return next
  }

  private recordOp(workspaceId: string, op: WorkspaceOpRow['op'], path: string, revision: number, opts: { from_path?: string | null; version?: number | null; sha256?: string | null } = {}): void {
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM workspace_ops WHERE workspace_id = ?').get(workspaceId) as { m: number }).m + 1
    this.db.prepare('INSERT INTO workspace_ops (workspace_id, seq, op, path, from_path, version, sha256, workspace_revision, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(workspaceId, seq, op, path, opts.from_path ?? null, opts.version ?? null, opts.sha256 ?? null, revision, nowIso())
  }

  private getNodeRow(workspaceId: string, path: string): WorkspaceNodeRow | undefined {
    return this.db.prepare('SELECT * FROM workspace_nodes WHERE workspace_id = ? AND path = ?').get(workspaceId, path) as WorkspaceNodeRow | undefined
  }

  /** Check the CAS expectation against the stored node (missing = version 0
   * semantics like tex-workspace: expected 0 = create-if-absent). */
  private assertCas(workspaceId: string, path: string, node: WorkspaceNodeRow | undefined, expected: WorkspaceExpected | undefined, op: string): void {
    if (node === undefined) {
      if (expected?.version !== undefined && expected.version !== 0) {
        throw new WorkspaceError('workspace_version_conflict', `${op}: ${path} does not exist (expected version ${expected.version}) — reload`)
      }
      if (expected?.etag !== undefined) {
        throw new WorkspaceError('workspace_etag_conflict', `${op}: ${path} does not exist (expected etag ${expected.etag}) — reload`)
      }
      return
    }
    if (expected?.version !== undefined && expected.version !== node.version) {
      throw new WorkspaceError('workspace_version_conflict',
        `${op}: ${path} version ${node.version} does not match expected version ${expected.version} — reload and merge`)
    }
    if (expected?.etag !== undefined && expected.etag !== workspaceEtag(node.version, node.content_hash)) {
      throw new WorkspaceError('workspace_etag_conflict',
        `${op}: ${path} etag ${workspaceEtag(node.version, node.content_hash)} does not match expected etag ${expected.etag} — reload and merge`)
    }
  }

  /** Disk bytes of a node, with a tamper guard (a file larger than the cap
   * could only have appeared through external tampering — reject). */
  private readBytes(workspaceId: string, cleanPath: string, row: WorkspaceNodeRow): Buffer {
    this.assertNoSymlink(workspaceId, cleanPath)
    const target = this.absPath(workspaceId, cleanPath)
    let st
    try {
      st = statSync(target)
    } catch {
      throw new WorkspaceError('workspace_file_missing',
        `workspace file ${cleanPath} is missing from disk (row exists) — host tampering`)
    }
    if (st.size > WORKSPACE_MAX_FILE_BYTES) {
      throw new WorkspaceError('workspace_file_missing',
        `workspace file ${cleanPath} is ${st.size} bytes on disk (max_file_bytes=${WORKSPACE_MAX_FILE_BYTES}) — host tampering`)
    }
    return readFileSync(target)
  }

  /**
   * The file tree at the current workspace revision. `dir` nodes are
   * projected from path prefixes (never stored) with version 0 and the
   * empty-content hash — they carry no content semantics. Tree nodes never
   * carry content (metadata only — bytes are read via `read`).
   */
  tree(workspaceId: string): { info: WorkspaceInfo; nodes: WorkspaceNode[] } {
    const info = this.get(workspaceId)
    const rows = this.db.prepare('SELECT * FROM workspace_nodes WHERE workspace_id = ? ORDER BY path').all(workspaceId) as unknown as WorkspaceNodeRow[]
    return { info, nodes: withImpliedDirs(info, rows.map(r => this.nodeFromRow(r, null))) }
  }

  /** Read one node WITH its text content (metadata + bytes from disk).
   * Binary nodes return content null (bytes via `blob`). */
  read(workspaceId: string, path: string): WorkspaceNode | null {
    const clean = normalizeWorkspacePath(path)
    const row = this.getNodeRow(workspaceId, clean)
    if (row === undefined) return null
    if (row.binary === 1) return this.nodeFromRow(row, null)
    const content = this.readBytes(workspaceId, clean, row).toString('utf8')
    return this.nodeFromRow(row, content)
  }

  /** Text write with CAS (expected version/etag → 409 on conflict).
   * expected_version=0 creates at version 1; missing path + no expectation
   * also creates. Binary nodes reject text writes (422 binary_read_only).
   * Bytes land on disk atomically (temp + rename); the previous version is
   * kept in history (retention-pruned). */
  write(workspaceId: string, path: string, content: string, expected?: WorkspaceExpected): WorkspaceNode {
    const clean = normalizeWorkspacePath(path)
    this.get(workspaceId)
    const existing = this.getNodeRow(workspaceId, clean)
    if (existing !== undefined && existing.binary === 1) {
      throw new WorkspaceError('workspace_binary_read_only', `${clean} is a binary node — text writes are read-only; replace via the binary upload path`)
    }
    this.assertCas(workspaceId, clean, existing, expected, 'write')
    const bytes = Buffer.from(content, 'utf8')
    this.assertSize(workspaceId, clean, bytes.byteLength)
    this.assertNoSymlink(workspaceId, clean)
    const hash = sha256Hex(bytes)
    const at = nowIso()
    if (existing !== undefined) this.keepHistory(workspaceId, clean, existing.version)
    this.writeBytesAtomic(this.absPath(workspaceId, clean), bytes)
    if (existing === undefined) {
      this.db.prepare('INSERT INTO workspace_nodes (workspace_id, path, version, binary, media, size_bytes, content, blob_sha256, content_hash, created_at, updated_at) VALUES (?, ?, 1, 0, ?, ?, NULL, NULL, ?, ?, ?)')
        .run(workspaceId, clean, mediaTypeOf(clean), bytes.byteLength, hash, at, at)
      this.recordOp(workspaceId, 'create', clean, this.bumpRevision(workspaceId), { version: 1, sha256: hash })
    } else {
      this.db.prepare('UPDATE workspace_nodes SET version = version + 1, media = ?, size_bytes = ?, content = NULL, blob_sha256 = NULL, content_hash = ?, updated_at = ? WHERE workspace_id = ? AND path = ?')
        .run(mediaTypeOf(clean), bytes.byteLength, hash, at, workspaceId, clean)
      this.recordOp(workspaceId, 'write', clean, this.bumpRevision(workspaceId), { version: existing.version + 1, sha256: hash })
    }
    const row = this.getNodeRow(workspaceId, clean)
    return this.nodeFromRow(row as WorkspaceNodeRow, content)
  }

  /**
   * Binary write: bytes land on the workspace tree atomically (temp +
   * rename) AND are registered in the artifact CAS (idempotent by content,
   * server-computed sha256 — the client never declares the hash); the node
   * records blob_sha256 + media + size. Replaces a text node when CAS
   * matches; binary nodes are replaced via this path only.
   */
  writeBinary(workspaceId: string, path: string, bytes: Uint8Array, media: string, expected?: WorkspaceExpected): WorkspaceNode {
    const clean = normalizeWorkspacePath(path)
    this.get(workspaceId)
    const existing = this.getNodeRow(workspaceId, clean)
    this.assertCas(workspaceId, clean, existing, expected, 'writeBinary')
    this.assertSize(workspaceId, clean, bytes.byteLength)
    this.assertNoSymlink(workspaceId, clean)
    const { sha256 } = this.cas.put(bytes)
    const at = nowIso()
    if (existing !== undefined) this.keepHistory(workspaceId, clean, existing.version)
    this.writeBytesAtomic(this.absPath(workspaceId, clean), bytes)
    if (existing === undefined) {
      this.db.prepare('INSERT INTO workspace_nodes (workspace_id, path, version, binary, media, size_bytes, content, blob_sha256, content_hash, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?, NULL, ?, ?, ?, ?)')
        .run(workspaceId, clean, media, bytes.byteLength, sha256, sha256, at, at)
      this.recordOp(workspaceId, 'create', clean, this.bumpRevision(workspaceId), { version: 1, sha256 })
    } else {
      this.db.prepare('UPDATE workspace_nodes SET version = version + 1, binary = 1, media = ?, size_bytes = ?, content = NULL, blob_sha256 = ?, content_hash = ?, updated_at = ? WHERE workspace_id = ? AND path = ?')
        .run(media, bytes.byteLength, sha256, sha256, at, workspaceId, clean)
      this.recordOp(workspaceId, 'write', clean, this.bumpRevision(workspaceId), { version: existing.version + 1, sha256 })
    }
    const row = this.getNodeRow(workspaceId, clean)
    return this.nodeFromRow(row as WorkspaceNodeRow, null)
  }

  /** Delete with version CAS. The deleted bytes stay in history (undo), the
   * disk file is removed and the row dropped. */
  deleteNode(workspaceId: string, path: string, expected?: WorkspaceExpected): void {
    const clean = normalizeWorkspacePath(path)
    this.get(workspaceId)
    const existing = this.getNodeRow(workspaceId, clean)
    if (existing === undefined) throw new WorkspaceError('workspace_file_not_found', `file ${clean} not found`)
    this.assertCas(workspaceId, clean, existing, expected, 'delete')
    this.assertNoSymlink(workspaceId, clean)
    this.keepHistory(workspaceId, clean, existing.version)
    try {
      unlinkSync(this.absPath(workspaceId, clean))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error // ENOENT: already gone — row is the authority
    }
    this.db.prepare('DELETE FROM workspace_nodes WHERE workspace_id = ? AND path = ?').run(workspaceId, clean)
    this.recordOp(workspaceId, 'delete', clean, this.bumpRevision(workspaceId), { version: existing.version, sha256: existing.content_hash })
  }

  /**
   * Move = atomically rename the disk file to the destination (create-if-
   * absent) + delete the source row. The CAS expectation guards the SOURCE;
   * the destination must not exist (409 workspace_move_destination_exists —
   * no silent overwrite). The source's last version stays in history under
   * its OLD path. Binary nodes move the same way (their blob reference is
   * content-addressed, so the destination row keeps the same hash).
   */
  moveNode(workspaceId: string, fromPath: string, toPath: string, expected?: WorkspaceExpected): WorkspaceNode {
    const from = normalizeWorkspacePath(fromPath)
    const to = normalizeWorkspacePath(toPath)
    this.get(workspaceId)
    const source = this.getNodeRow(workspaceId, from)
    if (source === undefined) throw new WorkspaceError('workspace_file_not_found', `file ${from} not found`)
    this.assertCas(workspaceId, from, source, expected, 'move')
    const dest = this.getNodeRow(workspaceId, to)
    if (dest !== undefined) throw new WorkspaceError('workspace_move_destination_exists', `move destination ${to} already exists — reload`)
    this.assertNoSymlink(workspaceId, from)
    this.assertNoSymlink(workspaceId, to)
    this.keepHistory(workspaceId, from, source.version)
    const fromAbs = this.absPath(workspaceId, from)
    const toAbs = this.absPath(workspaceId, to)
    mkdirSync(dirname(toAbs), { recursive: true, mode: 0o750 })
    renameSync(fromAbs, toAbs)
    const at = nowIso()
    this.db.prepare(`INSERT INTO workspace_nodes (workspace_id, path, version, binary, media, size_bytes, content, blob_sha256, content_hash, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, NULL, ?, ?, ?, ?)`)
      .run(workspaceId, to, source.binary, source.media, source.size_bytes, source.blob_sha256, source.content_hash, at, at)
    this.db.prepare('DELETE FROM workspace_nodes WHERE workspace_id = ? AND path = ?').run(workspaceId, from)
    const revision = this.bumpRevision(workspaceId)
    this.recordOp(workspaceId, 'move', to, revision, { from_path: from, version: 1, sha256: source.content_hash })
    const row = this.getNodeRow(workspaceId, to)
    return this.nodeFromRow(row as WorkspaceNodeRow, null)
  }

  /** History projection (newest first): every op with the workspace revision
   * it produced — the move/history UI feed (WORK-01). */
  history(workspaceId: string): WorkspaceRevision[] {
    this.get(workspaceId)
    const rows = this.db.prepare('SELECT * FROM workspace_ops WHERE workspace_id = ? ORDER BY seq DESC LIMIT 50').all(workspaceId) as unknown as WorkspaceOpRow[]
    return rows.map(r => ({
      workspace_id: r.workspace_id,
      revision: r.workspace_revision,
      at: r.at,
      ops: [{
        seq: r.seq,
        op: r.op as WorkspaceOp['op'],
        path: r.path,
        from_path: r.from_path,
        version: r.version,
        sha256: r.sha256,
        at: r.at,
      }],
    }))
  }

  /** Binary node bytes (null for text/missing nodes). The WORKING bytes are
   * the tree file (the CAS copy is the immutable reference). */
  blob(workspaceId: string, path: string): Buffer | null {
    const clean = normalizeWorkspacePath(path)
    const row = this.getNodeRow(workspaceId, clean)
    if (row === undefined || row.binary !== 1) return null
    return this.readBytes(workspaceId, clean, row)
  }

  /** Watch feed: current nodes of every path touched after `sinceRevision`
   * plus `deleted` tombstones (paths removed after it). `sinceRevision >=
   * current` → empty result. */
  listSince(workspaceId: string, sinceRevision: number): { info: WorkspaceInfo; nodes: WorkspaceNode[]; deleted: string[] } {
    const info = this.get(workspaceId)
    if (sinceRevision >= info.revision) return { info, nodes: [], deleted: [] }
    const rows = this.db.prepare(
      'SELECT DISTINCT path FROM workspace_ops WHERE workspace_id = ? AND workspace_revision > ? ORDER BY path',
    ).all(workspaceId, sinceRevision) as unknown as Array<{ path: string }>
    const nodes: WorkspaceNode[] = []
    const deleted: string[] = []
    for (const { path } of rows) {
      const row = this.getNodeRow(workspaceId, path)
      if (row === undefined) deleted.push(path)
      else nodes.push(this.nodeFromRow(row, null))
    }
    return { info, nodes, deleted }
  }

  /** PATH search: prefix and/or `*`/`?` glob over the current tree (AND when
   * both are given). Content search is NOT implemented (documented
   * limitation). */
  search(workspaceId: string, query: { prefix?: string; glob?: string }): { info: WorkspaceInfo; nodes: WorkspaceNode[] } {
    const tree = this.tree(workspaceId)
    let nodes = tree.nodes
    if (query.prefix !== undefined && query.prefix !== '') {
      const prefix = normalizeWorkspacePath(query.prefix.replace(/\/+$/, ''))
      nodes = nodes.filter(n => n.path.startsWith(prefix))
    }
    if (query.glob !== undefined && query.glob !== '') {
      const glob = query.glob
      nodes = nodes.filter(n => matchWorkspaceGlob(n.path, glob))
    }
    return { info: tree.info, nodes }
  }

  /** Rollback read: the node bytes at a stored per-path version (history),
   * or null when that version is not retained (beyond
   * HISTORY_KEEP_VERSIONS / never written). The current version reads the
   * live tree file; older versions read the history copy. */
  readVersion(workspaceId: string, path: string, version: number): WorkspaceNode | null {
    const clean = normalizeWorkspacePath(path)
    if (!Number.isInteger(version) || version <= 0) {
      throw new WorkspaceError('invalid_path', `readVersion: version must be a positive integer, got ${version}`)
    }
    const row = this.getNodeRow(workspaceId, clean)
    if (row !== undefined && version === row.version) {
      return row.binary === 1 ? this.nodeFromRow(row, null) : this.nodeFromRow(row, this.readBytes(workspaceId, clean, row).toString('utf8'))
    }
    const historyFile = this.historyPath(workspaceId, clean, version)
    let bytes: Buffer
    try {
      bytes = readFileSync(historyFile)
    } catch {
      return null
    }
    const hash = sha256Hex(bytes)
    return {
      path: clean,
      kind: 'file',
      binary: row !== undefined ? row.binary === 1 : false,
      media: row !== undefined ? row.media : mediaTypeOf(clean),
      size: bytes.byteLength,
      version,
      etag: workspaceEtag(version, hash),
      hash,
      content: row !== undefined && row.binary === 1 ? null : bytes.toString('utf8'),
      blob_sha256: row !== undefined && row.binary === 1 ? row.blob_sha256 : null,
      created_at: row?.created_at ?? '',
      updated_at: row?.updated_at ?? '',
    }
  }
}

/** RFC 2046 media type derived from the extension (mirrors
 * tex-workspace.fileMediaType for the generic store). */
export function mediaTypeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'pdf': case 'eps': case 'svg': case 'bin': case 'zip': case 'gz':
      return 'application/octet-stream'
    case 'json': return 'application/json'
    case 'md': return 'text/markdown'
    case 'py': return 'text/x-python'
    case 'ts': case 'tsx': return 'text/typescript'
    case 'js': return 'text/javascript'
    case 'sh': return 'text/x-shellscript'
    default: return 'text/plain'
  }
}

/**
 * Project the implied `dir` nodes of a file list (shared by WorkspaceStore
 * and the TeX facade so every backend renders the same tree shape). Dir
 * nodes carry version 0 and the empty-content hash — no content semantics.
 */
export function withImpliedDirs(info: WorkspaceInfo, files: WorkspaceNode[]): WorkspaceNode[] {
  const dirs = new Map<string, WorkspaceNode>()
  for (const f of files) {
    const segments = f.path.split('/')
    for (let i = 1; i < segments.length; i += 1) {
      const prefix = segments.slice(0, i).join('/')
      if (!dirs.has(prefix)) {
        dirs.set(prefix, {
          path: prefix,
          kind: 'dir',
          binary: false,
          media: '',
          size: 0,
          version: 0,
          etag: workspaceEtag(0, EMPTY_CONTENT_HASH),
          hash: EMPTY_CONTENT_HASH,
          content: null,
          blob_sha256: null,
          created_at: info.created_at,
          updated_at: info.updated_at,
        })
      }
    }
  }
  return [...files, ...dirs.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
