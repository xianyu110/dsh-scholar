/**
 * WORK-01 (hardening-v0.2-status.md §3/§4) — TeX facade over the generic
 * workspace interface.
 *
 * The TeX workspace (TexWorkspaceStore) is the DOMAIN facade for the
 * `manuscript` workspace surface: it must never maintain a second
 * byte/revision authority (storage-migrations.md §5.1). This module maps
 * the existing TeX store ONTO the generic WorkspaceStoreLike contract
 * (workspace-store.ts) so unified consumers (routes, future filesystem
 * adapters, UI) can address a TeX document as a workspace without touching
 * the TeX implementation.
 *
 * Mapping rules:
 *
 *   workspace_id  = 'ws_' + document_id (deterministic, invertible);
 *   kind          = 'manuscript';
 *   node          = tex file → text node (binary=false, media from the tex
 *                   extension map, version = tex version, hash = content
 *                   sha256, etag = workspaceEtag(version, hash));
 *   write/delete  = tex writeFile/deleteFile with the tex expected_version
 *                   (etag expectations are translated to version checks);
 *   move          = tex moveFile with the generic no-silent-overwrite rule;
 *   binary        = the TeX store is text-only — writeBinary is rejected
 *                   (422 workspace_binary_read_only); binary TeX assets stay
 *                   a CAS-planned follow-up, existing behavior untouched.
 *
 * The existing TeX routes keep calling the TeX store directly — this facade
 * is the mapping layer for the unified interface, NOT a migration of the
 * current implementation.
 * @module @dsh-scholar/research-kernel/tex-facade
 */

import { workspaceEtag, type WorkspaceInfo, type WorkspaceKind, type WorkspaceNode, type WorkspaceRevision } from '@dsh-scholar/research-schemas'
import { TexWorkspaceStore, TexError, fileMediaType, type TexDocumentInfo, type TexFileEntry } from './tex-workspace.js'
import { WorkspaceError, matchWorkspaceGlob, withImpliedDirs, isSearchableTextMedia, hasBinaryMagic, scanTextForQuery,
  WORKSPACE_SEARCH_MAX_FILES, type WorkspaceContentHit, type WorkspaceContentSearchQuery, type WorkspaceContentSearchResult,
  type WorkspaceExpected, type WorkspaceStoreLike } from './workspace-store.js'

/**
 * Translate a TexError into the generic workspace error contract (409/404/
 * 422 codes) so unified consumers never see tex-specific codes. Other
 * errors rethrow untouched.
 */
function translateTexError(error: unknown): never {
  if (error instanceof TexError) {
    const code = error.code === 'document_version_conflict' ? 'workspace_version_conflict'
      : error.code === 'file_not_found' ? 'workspace_file_not_found'
        : error.code === 'document_not_found' ? 'workspace_not_found'
          : error.code === 'invalid_path' ? 'invalid_path'
            : 'workspace_error'
    throw new WorkspaceError(code, error.message)
  }
  throw error
}

/** Deterministic tex document → workspace id mapping ('ws_' + document_id). */
export function texWorkspaceId(documentId: string): string {
  return `ws_${documentId}`
}

/** Inverse mapping; throws when the id is not a tex workspace id. */
export function texDocumentId(workspaceId: string): string {
  if (!workspaceId.startsWith('ws_doc_')) {
    throw new WorkspaceError('workspace_not_found', `workspace ${workspaceId} is not a manuscript (TeX) workspace`)
  }
  return workspaceId.slice(3)
}

/** Map a tex document header onto the generic workspace info shape. */
export function texInfoToWorkspaceInfo(doc: TexDocumentInfo, name?: string): WorkspaceInfo {
  return {
    workspace_id: texWorkspaceId(doc.document_id),
    project_id: doc.project_id,
    kind: 'manuscript',
    name: name ?? doc.root_file,
    revision: doc.revision,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  }
}

/** Map one tex file entry onto the generic node shape (tree view: no
 * content, like the tex tree contract). `created_at` is optional — the tex
 * read path does not expose it, the tree path does. */
export function texEntryToWorkspaceNode(entry: Omit<TexFileEntry, 'created_at'> & { created_at?: string }): WorkspaceNode {
  const at = entry.created_at ?? new Date().toISOString()
  return {
    path: entry.path,
    kind: 'file',
    binary: false,
    media: entry.media,
    size: Buffer.byteLength(entry.content ?? '', 'utf8'),
    version: entry.version,
    etag: workspaceEtag(entry.version, entry.content_hash),
    hash: entry.content_hash,
    content: entry.content ?? null,
    blob_sha256: null,
    created_at: at,
    updated_at: at,
  }
}

/** Translate a generic CAS expectation to a tex expected_version (etag →
 * version check via the current file). */
function texExpectedVersion(store: TexWorkspaceStore, documentId: string, path: string, expected?: WorkspaceExpected): number | undefined {
  if (expected === undefined) return undefined
  if (expected.version !== undefined) return expected.version
  if (expected.etag !== undefined) {
    const file = store.readFile(documentId, path)
    if (file === null) return undefined // create-if-absent path
    const current = workspaceEtag(file.version, file.content_hash)
    if (current !== expected.etag) {
      throw new WorkspaceError('workspace_etag_conflict', `write: ${path} etag ${current} does not match expected etag ${expected.etag} — reload and merge`)
    }
    return file.version
  }
  return undefined
}

/**
 * The TeX store viewed through the generic workspace contract. Wraps a
 * TexWorkspaceStore instance; every call maps to the tex API so revision/
 * version semantics stay in ONE authority (the tex store).
 */
export class TexWorkspaceFacade implements WorkspaceStoreLike {
  private readonly tex: TexWorkspaceStore

  constructor(tex: TexWorkspaceStore) {
    this.tex = tex
  }

  /** The wrapped TeX store (facade never hides the domain surface). */
  get texStore(): TexWorkspaceStore {
    return this.tex
  }

  ensure(projectId: string, kind: WorkspaceKind, name: string): WorkspaceInfo {
    if (kind !== 'manuscript') {
      throw new WorkspaceError('workspace_kind_invalid', `tex facade serves only 'manuscript' workspaces, got '${kind}'`)
    }
    try {
      const doc = this.tex.ensureDocument(projectId, name === '' ? 'paper.tex' : name)
      return texInfoToWorkspaceInfo(doc, name)
    } catch (error) {
      return translateTexError(error)
    }
  }

  get(workspaceId: string): WorkspaceInfo {
    try {
      return texInfoToWorkspaceInfo(this.tex.getDocument(texDocumentId(workspaceId)))
    } catch (error) {
      return translateTexError(error)
    }
  }

  tree(workspaceId: string): { info: WorkspaceInfo; nodes: WorkspaceNode[] } {
    try {
      const documentId = texDocumentId(workspaceId)
      const tree = this.tex.tree(documentId)
      const info = texInfoToWorkspaceInfo(tree.document)
      return { info, nodes: withImpliedDirs(info, tree.files.map(texEntryToWorkspaceNode)) }
    } catch (error) {
      return translateTexError(error)
    }
  }

  read(workspaceId: string, path: string): WorkspaceNode | null {
    try {
      const file = this.tex.readFile(texDocumentId(workspaceId), path)
      return file === null ? null : texEntryToWorkspaceNode(file)
    } catch (error) {
      return translateTexError(error)
    }
  }

  write(workspaceId: string, path: string, content: string, expected?: WorkspaceExpected): WorkspaceNode {
    try {
      const documentId = texDocumentId(workspaceId)
      const version = texExpectedVersion(this.tex, documentId, path, expected)
      this.tex.writeFile(documentId, path, content, version)
      // Re-read for the full entry (kind/media/version/hash).
      const file = this.tex.readFile(documentId, path)
      if (file === null) throw new WorkspaceError('workspace_file_not_found', `file ${path} not found after write`)
      return texEntryToWorkspaceNode(file)
    } catch (error) {
      return translateTexError(error)
    }
  }

  /** The TeX store is text-only — binary writes are rejected (CAS binary
   * assets for TeX remain a planned follow-up; no behavior change). The
   * full generic signature is kept for interface compliance; unknown
   * workspace ids still 404 before the read-only error. */
  writeBinary(workspaceId: string, _path: string, _bytes: Uint8Array, _media: string, _expected?: WorkspaceExpected): WorkspaceNode {
    texDocumentId(workspaceId)
    throw new WorkspaceError('workspace_binary_read_only', 'tex workspace is text-only — binary writes are not supported by the tex facade')
  }

  deleteNode(workspaceId: string, path: string, expected?: WorkspaceExpected): void {
    try {
      const documentId = texDocumentId(workspaceId)
      this.tex.deleteFile(documentId, path, texExpectedVersion(this.tex, documentId, path, expected))
    } catch (error) {
      translateTexError(error)
    }
  }

  moveNode(workspaceId: string, fromPath: string, toPath: string, expected?: WorkspaceExpected): WorkspaceNode {
    try {
      const documentId = texDocumentId(workspaceId)
      // Generic no-silent-overwrite rule: the destination must not exist.
      if (this.tex.readFile(documentId, toPath) !== null) {
        throw new WorkspaceError('workspace_move_destination_exists', `move destination ${toPath} already exists — reload`)
      }
      const from = this.tex.readFile(documentId, fromPath)
      if (from === null) throw new WorkspaceError('workspace_file_not_found', `file ${fromPath} not found`)
      if (expected?.etag !== undefined && workspaceEtag(from.version, from.content_hash) !== expected.etag) {
        throw new WorkspaceError('workspace_etag_conflict', `move: ${fromPath} etag changed — reload before moving`)
      }
      const version = expected?.version !== undefined ? expected.version : from.version
      this.tex.moveFile(documentId, fromPath, toPath, version)
      return texEntryToWorkspaceNode(this.tex.readFile(documentId, toPath) as TexFileEntry)
    } catch (error) {
      return translateTexError(error)
    }
  }

  history(workspaceId: string): WorkspaceRevision[] {
    try {
      const documentId = texDocumentId(workspaceId)
      return this.tex.history(documentId).map(h => ({
        workspace_id: texWorkspaceId(documentId),
        revision: h.revision,
        at: h.at,
        ops: [],
      }))
    } catch (error) {
      return translateTexError(error)
    }
  }

  blob(workspaceId: string, _path: string): Buffer | null {
    texDocumentId(workspaceId) // unknown ids still 404
    return null // tex is text-only
  }

  /**
   * Watch feed over the tex store. The tex store keeps no per-op ledger, so
   * the facade reports CONSERVATIVELY: `sinceRevision >= current revision`
   * → empty (nothing changed since the caller's cursor); otherwise the whole
   * current tree as "changed" (a caller can never miss a change, it only
   * re-reads more than strictly necessary). Deleted paths cannot be
   * projected — the tex store drops rows (documented limitation).
   */
  listSince(workspaceId: string, sinceRevision: number): { info: WorkspaceInfo; nodes: WorkspaceNode[]; deleted: string[] } {
    try {
      const tree = this.tree(workspaceId)
      if (sinceRevision >= tree.info.revision) return { info: tree.info, nodes: [], deleted: [] }
      return { info: tree.info, nodes: tree.nodes, deleted: [] }
    } catch (error) {
      return translateTexError(error)
    }
  }

  /** PATH search (prefix and/or `*`/`?` glob) over the tex tree — same
   * semantics as the generic store. */
  search(workspaceId: string, query: { prefix?: string; glob?: string }): { info: WorkspaceInfo; nodes: WorkspaceNode[] } {
    try {
      const tree = this.tree(workspaceId)
      let nodes = tree.nodes
      if (query.prefix !== undefined && query.prefix !== '') {
        const prefix = query.prefix.replace(/\/+$/, '')
        nodes = nodes.filter(n => n.path.startsWith(prefix))
      }
      if (query.glob !== undefined && query.glob !== '') {
        const glob = query.glob
        nodes = nodes.filter(n => matchWorkspaceGlob(n.path, glob))
      }
      return { info: tree.info, nodes }
    } catch (error) {
      return translateTexError(error)
    }
  }

  /** CONTENT search over the tex tree — same caps and semantics as the
   * generic store (text-only media allowlist, per-file/per-result limits,
   * case-insensitive by default). The tex store is text-only, so every file
   * is a candidate; content comes from the tex store itself (no second byte
   * authority). */
  searchContent(workspaceId: string, query: WorkspaceContentSearchQuery): WorkspaceContentSearchResult {
    try {
      if (query.q === undefined || query.q.trim() === '') {
        throw new WorkspaceError('invalid_query', 'content search requires a non-empty q')
      }
      const documentId = texDocumentId(workspaceId)
      const tree = this.tex.tree(documentId)
      const info = texInfoToWorkspaceInfo(tree.document)
      const hits: WorkspaceContentHit[] = []
      let truncated = false
      for (const file of tree.files) {
        if (hits.length >= WORKSPACE_SEARCH_MAX_FILES) {
          truncated = true
          break
        }
        if (!isSearchableTextMedia(file.media)) continue
        const entry = this.tex.readFile(documentId, file.path)
        if (entry === null) continue
        const content = entry.content ?? ''
        if (hasBinaryMagic(Buffer.from(content, 'utf8'))) continue
        const { matches, total } = scanTextForQuery(content, query.q, {
          case_sensitive: query.case_sensitive,
        })
        if (total > 0) hits.push({ path: file.path, match_count: total, matches })
      }
      return { info, hits, truncated }
    } catch (error) {
      return translateTexError(error)
    }
  }

  /** Rollback read: only the CURRENT per-file version is retained by the
   * tex store (no per-file version history) — any other version → null
   * (documented limitation of the manuscript facade). */
  readVersion(workspaceId: string, path: string, version: number): WorkspaceNode | null {
    try {
      const file = this.tex.readFile(texDocumentId(workspaceId), path)
      if (file === null || file.version !== version) return null
      return texEntryToWorkspaceNode(file)
    } catch (error) {
      return translateTexError(error)
    }
  }

  /** Media type helper (exposed for facade callers). */
  static mediaTypeOf(path: string): string {
    return fileMediaType(path)
  }
}
