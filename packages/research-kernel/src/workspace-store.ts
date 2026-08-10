/**
 * WORK-01 (hardening-v0.2-status.md §3/§4, api-contracts.md §17) — generic
 * VS Code-style Workspace store (interface layer).
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
 * Text content is stored inline; binary content lives in the artifact CAS
 * (ArtifactCas, blob_sha256) — the server computes sha256 over the bytes and
 * CAS put is idempotent by content. Binary nodes are read-only for text
 * writes (replaced only via the binary upload path).
 *
 * Path safety follows the snapshot-walk contract (execution-runtime.md §4):
 * root-relative only, no `..`, no NUL, no backslash ambiguity, no empty
 * segments. `dir` nodes are projected from path prefixes (implied); only
 * file nodes are stored.
 *
 * The real filesystem adapter (a host/container tree behind this interface)
 * and the browser UI are NOT part of this round — this store is the durable
 * interface layer the adapter will back.
 * @module @dsh-scholar/research-kernel/workspace-store
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { workspaceEtag, type WorkspaceInfo, type WorkspaceKind, type WorkspaceNode, type WorkspaceOp, type WorkspaceRevision } from '@dsh-scholar/research-schemas'
import { ArtifactCas } from './cas.js'

/** sha256 of the empty string — carried by synthesized `dir` nodes where a
 * hash is structurally required but semantically meaningless. */
export const EMPTY_CONTENT_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

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

/**
 * Table DDL — parity copy of migration 0011 (the store opens its own WAL
 * connection, exactly like tex-workspace.ts; CREATE IF NOT EXISTS keeps both
 * connections in sync).
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
export function openWorkspaceStore(dbPath: string, casRoot: string): WorkspaceStore {
  return new WorkspaceStore(dbPath, casRoot)
}

export class WorkspaceStore implements WorkspaceStoreLike {
  private readonly db: DatabaseSync
  private readonly cas: ArtifactCas

  constructor(dbPath: string, casRoot: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(WORKSPACE_DDL)
    this.cas = new ArtifactCas(casRoot)
  }

  close(): void {
    this.db.close()
  }

  /** The artifact CAS backing binary nodes (kernel passes the same root). */
  get casRef(): ArtifactCas {
    return this.cas
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

  private nodeFromRow(row: WorkspaceNodeRow): WorkspaceNode {
    return {
      path: row.path,
      kind: 'file',
      binary: row.binary === 1,
      media: row.media,
      size: row.size_bytes,
      version: row.version,
      etag: workspaceEtag(row.version, row.content_hash),
      hash: row.content_hash,
      content: row.binary === 1 ? null : row.content,
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

  /** Create (or open) a workspace for a project. */
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

  /**
   * The file tree at the current workspace revision. `dir` nodes are
   * projected from path prefixes (never stored) with version 0 and the
   * empty-content hash — they carry no content semantics.
   */
  tree(workspaceId: string): { info: WorkspaceInfo; nodes: WorkspaceNode[] } {
    const info = this.get(workspaceId)
    const rows = this.db.prepare('SELECT * FROM workspace_nodes WHERE workspace_id = ? ORDER BY path').all(workspaceId) as unknown as WorkspaceNodeRow[]
    return { info, nodes: withImpliedDirs(info, rows.map(r => this.nodeFromRow(r))) }
  }

  read(workspaceId: string, path: string): WorkspaceNode | null {
    const clean = normalizeWorkspacePath(path)
    const row = this.getNodeRow(workspaceId, clean)
    return row === undefined ? null : this.nodeFromRow(row)
  }

  /** Text write with CAS (expected version/etag → 409 on conflict).
   * expected_version=0 creates at version 1; missing path + no expectation
   * also creates. Binary nodes reject text writes (422 binary_read_only). */
  write(workspaceId: string, path: string, content: string, expected?: WorkspaceExpected): WorkspaceNode {
    const clean = normalizeWorkspacePath(path)
    this.get(workspaceId)
    const existing = this.getNodeRow(workspaceId, clean)
    if (existing !== undefined && existing.binary === 1) {
      throw new WorkspaceError('workspace_binary_read_only', `${clean} is a binary node — text writes are read-only; replace via the binary upload path`)
    }
    this.assertCas(workspaceId, clean, existing, expected, 'write')
    const hash = sha256Hex(content)
    const at = nowIso()
    if (existing === undefined) {
      this.db.prepare('INSERT INTO workspace_nodes (workspace_id, path, version, binary, media, size_bytes, content, blob_sha256, content_hash, created_at, updated_at) VALUES (?, ?, 1, 0, ?, ?, ?, NULL, ?, ?, ?)')
        .run(workspaceId, clean, mediaTypeOf(clean), Buffer.byteLength(content, 'utf8'), content, hash, at, at)
      this.recordOp(workspaceId, 'create', clean, this.bumpRevision(workspaceId), { version: 1, sha256: hash })
    } else {
      this.db.prepare('UPDATE workspace_nodes SET version = version + 1, media = ?, size_bytes = ?, content = ?, blob_sha256 = NULL, content_hash = ?, updated_at = ? WHERE workspace_id = ? AND path = ?')
        .run(mediaTypeOf(clean), Buffer.byteLength(content, 'utf8'), content, hash, at, workspaceId, clean)
      this.recordOp(workspaceId, 'write', clean, this.bumpRevision(workspaceId), { version: existing.version + 1, sha256: hash })
    }
    const row = this.getNodeRow(workspaceId, clean)
    return this.nodeFromRow(row as WorkspaceNodeRow)
  }

  /**
   * Binary write: bytes go into the artifact CAS (idempotent by content,
   * server-computed sha256 — the client never declares the hash), the node
   * records blob_sha256 + media + size. Replaces a text node when CAS
   * matches; binary nodes are replaced via this path only.
   */
  writeBinary(workspaceId: string, path: string, bytes: Uint8Array, media: string, expected?: WorkspaceExpected): WorkspaceNode {
    const clean = normalizeWorkspacePath(path)
    this.get(workspaceId)
    const existing = this.getNodeRow(workspaceId, clean)
    this.assertCas(workspaceId, clean, existing, expected, 'writeBinary')
    const { sha256, size_bytes } = this.cas.put(bytes)
    const at = nowIso()
    if (existing === undefined) {
      this.db.prepare('INSERT INTO workspace_nodes (workspace_id, path, version, binary, media, size_bytes, content, blob_sha256, content_hash, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?, NULL, ?, ?, ?, ?)')
        .run(workspaceId, clean, media, size_bytes, sha256, sha256, at, at)
      this.recordOp(workspaceId, 'create', clean, this.bumpRevision(workspaceId), { version: 1, sha256 })
    } else {
      this.db.prepare('UPDATE workspace_nodes SET version = version + 1, binary = 1, media = ?, size_bytes = ?, content = NULL, blob_sha256 = ?, content_hash = ?, updated_at = ? WHERE workspace_id = ? AND path = ?')
        .run(media, size_bytes, sha256, sha256, at, workspaceId, clean)
      this.recordOp(workspaceId, 'write', clean, this.bumpRevision(workspaceId), { version: existing.version + 1, sha256 })
    }
    const row = this.getNodeRow(workspaceId, clean)
    return this.nodeFromRow(row as WorkspaceNodeRow)
  }

  deleteNode(workspaceId: string, path: string, expected?: WorkspaceExpected): void {
    const clean = normalizeWorkspacePath(path)
    this.get(workspaceId)
    const existing = this.getNodeRow(workspaceId, clean)
    if (existing === undefined) throw new WorkspaceError('workspace_file_not_found', `file ${clean} not found`)
    this.assertCas(workspaceId, clean, existing, expected, 'delete')
    this.db.prepare('DELETE FROM workspace_nodes WHERE workspace_id = ? AND path = ?').run(workspaceId, clean)
    this.recordOp(workspaceId, 'delete', clean, this.bumpRevision(workspaceId), { version: existing.version, sha256: existing.content_hash })
  }

  /**
   * Move = copy the bytes to the destination (create-if-absent) + delete the
   * source. The CAS expectation guards the SOURCE; the destination must not
   * exist (409 workspace_move_destination_exists — no silent overwrite).
   * Binary nodes move by blob reference (no byte copy).
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
    const at = nowIso()
    this.db.prepare(`INSERT INTO workspace_nodes (workspace_id, path, version, binary, media, size_bytes, content, blob_sha256, content_hash, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(workspaceId, to, source.binary, source.media, source.size_bytes, source.content, source.blob_sha256, source.content_hash, at, at)
    this.db.prepare('DELETE FROM workspace_nodes WHERE workspace_id = ? AND path = ?').run(workspaceId, from)
    const revision = this.bumpRevision(workspaceId)
    this.recordOp(workspaceId, 'move', to, revision, { from_path: from, version: 1, sha256: source.content_hash })
    const row = this.getNodeRow(workspaceId, to)
    return this.nodeFromRow(row as WorkspaceNodeRow)
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

  /** Binary node bytes from the artifact CAS (null for text/missing). */
  blob(workspaceId: string, path: string): Buffer | null {
    const clean = normalizeWorkspacePath(path)
    const row = this.getNodeRow(workspaceId, clean)
    if (row === undefined || row.binary !== 1 || row.blob_sha256 === null) return null
    return this.cas.read(row.blob_sha256)
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
