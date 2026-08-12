/**
 * WORK-01 Workspace client logic layer (hardening-v0.2-status.md §5,
 * api-contracts.md §17, research-schemas/workspace.ts wire contract):
 * PURE functions for the Workspace panel — no DOM, no fetch, no module
 * state (panels/workspace.ts only assembles nodes from this model, same
 * split as trajectory-model.ts / topology-model.ts).
 *
 * What lives here:
 *
 *  - the TREE model: the server projects a FLAT node list (dirs implied
 *    from path prefixes — an EMPTY dir carries no server node, it only
 *    exists once a file lands under it). The client groups nodes into
 *    per-directory child lists and flattens ONLY expanded dirs
 *    depth-first (lazy expand contract — children render only after their
 *    parent is expanded). Client-created empty dirs are VIRTUAL (recorded
 *    in the model; the server has no dir-create op — the panel applies
 *    them locally, and they become real projections once a file is
 *    written under them).
 *  - the OPERATION call models: create file (write expected_version=0 =
 *    create-if-absent), CAS save (expected_version/expected_etag → 409 on
 *    stale — no silent last-write-wins), delete/move with source CAS,
 *    readVersion history rollback (write with the CURRENT version/etag as
 *    guard), binary upload (multipart POST /assets, ≤ 32 MiB, server-side
 *    sha256 — the client never declares a hash) and binary download
 *    (GET /blobs?path= returns raw bytes with the node's media type).
 *  - CONFLICT handling: `workspaceConflictKind` maps the stable server
 *    error codes (workspace_version_conflict / workspace_etag_conflict /
 *    workspace_move_destination_exists / …) onto the reload/refresh
 *    decision the panel prompts — the editor never silently overwrites.
 *  - WATCH/listSince: `applyWorkspaceListSince` merges changed nodes +
 *    delete tombstones into the tree (the panel consumes the SSE watch
 *    stream via `WorkspaceWatchClient` — client/sse-client.ts; the merge
 *    model is identical on the stream and the poll path). When the stream
 *    gives up (max reconnect attempts) the client falls back to listSince
 *    POLLING (a designed degradation — same payloads, same merge).
 *  - SEARCH: path filtering only — the server implements prefix/glob
 *    PATH search (workspace_search) and NO content search; the client
 *    model mirrors that honestly (substring path filter + search call
 *    descriptor), and the panel copy states content search is not
 *    implemented.
 *  - MULTI-TAB editor: WorkspaceTabState holds path/version/etag/content/
 *    savedContent per open tab. Dirty follows manuscript-dirty.ts
 *    `isEditorDirty` ('' is a real content value — clearing a non-empty
 *    file reads dirty, reverting to saved reads clean). A 409 save
 *    conflict marks the tab conflicted so the panel prompts RELOAD
 *    (refetch + rebaseline, never overwrite the server bytes).
 *
 * Browser visual acceptance (drag-drop upload, narrow viewports,
 * keyboard/a11y) stays NOT_RUN_MANUAL_PENDING (hardening §5).
 */
import { getLocale, t, type Locale } from './i18n/index'
import { zh as workspaceZh, en as workspaceEn } from './i18n/locales/workspace'
import { isEditorDirty } from './manuscript-dirty'
import { SseClient, defaultSseScheduler, type SseEvent, type SseFetch, type SseScheduler } from './sse-client'
import type {
  WorkspaceInfoLite, WorkspaceListSincePayload, WorkspaceNodeLite,
  WorkspaceOpLite, WorkspaceRevisionLite, WorkspaceTreePayload,
} from './types'

/** Server cap mirror (WORKSPACE_MAX_FILE_BYTES, upload limits — the client
 *  pre-flags oversize uploads; the server enforces the same 32 MiB). */
export const WORKSPACE_MAX_FILE_BYTES = 32 * 1024 * 1024

/** Watch poll interval (ms) — the listSince POLL cadence (the default
 *  transport and the fallback when the SSE watch stream gives up). */
export const WORKSPACE_WATCH_POLL_MS = 5000

/* ─────────────────────── tree model ─────────────────────── */

/** Per-project tree state (the panel keeps one per project id). */
export interface WorkspaceTreeState {
  workspaceId: string
  info: WorkspaceInfoLite | null
  /** Flat server node list (files + implied dirs), kept sorted by path. */
  nodes: WorkspaceNodeLite[]
  /** Client-created EMPTY dirs (no server node until a file lands under
   *  them — dirs are projected from path prefixes). */
  virtualDirs: string[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Selected node path ('' = none). */
  selectedPath: string
}

export function initialWorkspaceTreeState(workspaceId: string): WorkspaceTreeState {
  return { workspaceId, info: null, nodes: [], virtualDirs: [], status: 'idle', selectedPath: '' }
}

function sortNodes(nodes: WorkspaceNodeLite[]): WorkspaceNodeLite[] {
  return [...nodes].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Parent directory path of a node path ('' = root). */
export function workspaceParentDir(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx < 0 ? '' : path.slice(0, idx)
}

/** Basename (last path segment) of a node path. */
export function workspaceBasename(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx < 0 ? path : path.slice(idx + 1)
}

/**
 * Mirror of the server's `withImpliedDirs` (workspace-store.ts): dir nodes
 * are projected from path prefixes and never stored. The server sends them
 * in the tree projection but NOT in listSince watch feeds — the client
 * derives them from the file set so the tree stays complete across watch
 * merges. A synthesized dir node carries version 0 and no content semantics
 * (same contract as the server's dir projection).
 */
function withImpliedWorkspaceDirs(nodes: readonly WorkspaceNodeLite[]): WorkspaceNodeLite[] {
  const byPath = new Map(nodes.map(n => [n.path, n]))
  for (const file of nodes) {
    if (file.kind !== 'file') continue
    const segments = file.path.split('/')
    for (let i = 1; i < segments.length; i += 1) {
      const prefix = segments.slice(0, i).join('/')
      if (!byPath.has(prefix)) {
        byPath.set(prefix, {
          path: prefix,
          kind: 'dir',
          binary: false,
          media: '',
          size: 0,
          version: 0,
          etag: '',
          hash: '0'.repeat(64),
          content: null,
          blob_sha256: null,
          created_at: file.created_at,
          updated_at: file.updated_at,
        })
      }
    }
  }
  return sortNodes([...byPath.values()])
}

/** Merge the full tree projection (GET /tree) into the state. Never
 *  throws; malformed payloads degrade to their usable fields. Implied dirs
 *  are derived client-side (the tree contract projects them, but the model
 *  must not depend on the server's projection). */
export function applyWorkspaceTree(prev: WorkspaceTreeState, payload: WorkspaceTreePayload): WorkspaceTreeState {
  const nodes = withImpliedWorkspaceDirs(
    Array.isArray(payload.nodes) ? payload.nodes.filter(n => n !== null && typeof n === 'object') : [],
  )
  const serverDirs = new Set(nodes.filter(n => n.kind === 'dir').map(n => n.path))
  return {
    ...prev,
    info: typeof payload.info === 'object' && payload.info !== null ? payload.info : prev.info,
    nodes,
    // Prune virtual dirs that the server now projects (a file landed).
    virtualDirs: prev.virtualDirs.filter(dir => !serverDirs.has(dir)),
    status: 'ready',
  }
}

/** Direct children (files + dirs) of a dir path under the CURRENT model
 *  ('' = root). Virtual dirs never produce children here. */
export function workspaceDirChildren(state: WorkspaceTreeState, dirPath: string): WorkspaceNodeLite[] {
  return state.nodes.filter(n => workspaceParentDir(n.path) === dirPath)
}

/** Whether a dir exists in the model (server node OR virtual). */
export function workspaceDirExists(state: WorkspaceTreeState, dirPath: string): boolean {
  if (dirPath === '') return true
  return state.nodes.some(n => n.kind === 'dir' && n.path === dirPath)
    || state.virtualDirs.includes(dirPath)
}

/** Whether a dir is VIRTUAL (client-created, no server node yet). */
export function workspaceDirVirtual(state: WorkspaceTreeState, dirPath: string): boolean {
  return state.virtualDirs.includes(dirPath)
}

/** Node lookup by exact path ('' → null). */
export function workspaceNodeAt(state: WorkspaceTreeState, path: string): WorkspaceNodeLite | null {
  if (path === '') return null
  return state.nodes.find(n => n.path === path) ?? null
}

/** Add a client-created empty dir (idempotent; ignored when the server
 *  already projects the dir). */
export function addWorkspaceVirtualDir(prev: WorkspaceTreeState, dirPath: string): WorkspaceTreeState {
  if (dirPath === '' || workspaceDirExists(prev, dirPath) || prev.virtualDirs.includes(dirPath)) return prev
  return { ...prev, virtualDirs: [...prev.virtualDirs, dirPath].sort() }
}

/** Selection: '' clears the selection. */
export function selectWorkspacePath(prev: WorkspaceTreeState, path: string): WorkspaceTreeState {
  return { ...prev, selectedPath: path }
}

/** Toggle one dir's expanded flag (pure set copy — same contract as
 *  topology-model's toggleTopologyNode). */
export function toggleWorkspaceDir(expanded: ReadonlySet<string>, dirPath: string): Set<string> {
  const next = new Set(expanded)
  if (next.has(dirPath)) next.delete(dirPath)
  else next.add(dirPath)
  return next
}

/** One visible tree row (flatten projection). */
export interface WorkspaceTreeRow {
  path: string
  name: string
  kind: 'file' | 'dir'
  binary: boolean
  depth: number
  expanded: boolean
  /** True when the node has children under the current model (a dir with
   *  at least one known child OR any virtual dir). */
  hasChildren: boolean
  /** True when the node is a client-created empty dir (no server node). */
  virtual: boolean
  selected: boolean
  size: number
  version: number
  etag: string
  media: string
}

/** Synthetic node view for a virtual dir (kind dir, version 0 — server
 *  dir nodes carry version 0 too). */
function virtualDirView(state: WorkspaceTreeState, dirPath: string): WorkspaceTreeRow {
  const base = { path: dirPath, name: workspaceBasename(dirPath), kind: 'dir' as const, binary: false, media: '' }
  return {
    ...base,
    depth: 0,
    expanded: false,
    hasChildren: false,
    virtual: true,
    selected: state.selectedPath === dirPath,
    size: 0,
    version: 0,
    etag: '',
  }
}

/**
 * Flatten the model into visible rows (depth-first, root ''). Children of
 * a dir render ONLY when the dir is expanded (lazy expand contract — the
 * server tree call is one flat projection, but the panel never renders
 * unexpanded subtrees). Virtual dirs appear as leaf rows until a file
 * lands under them.
 */
export function flattenWorkspaceTree(state: WorkspaceTreeState, expanded: ReadonlySet<string>): WorkspaceTreeRow[] {
  const out: WorkspaceTreeRow[] = []
  const walk = (dirPath: string, depth: number): void => {
    const children = workspaceDirChildren(state, dirPath)
    for (const node of children) {
      const isDir = node.kind === 'dir'
      const childrenOf = isDir ? workspaceDirChildren(state, node.path) : []
      const virtual = isDir && workspaceDirVirtual(state, node.path)
      const hasChildren = isDir && (childrenOf.length > 0 || state.virtualDirs.some(d => workspaceParentDir(d) === node.path))
      out.push({
        path: node.path,
        name: workspaceBasename(node.path),
        kind: node.kind,
        binary: node.binary === true,
        depth,
        expanded: isDir && expanded.has(node.path),
        hasChildren,
        virtual,
        selected: state.selectedPath === node.path,
        size: typeof node.size === 'number' ? node.size : 0,
        version: typeof node.version === 'number' ? node.version : 0,
        etag: typeof node.etag === 'string' ? node.etag : '',
        media: typeof node.media === 'string' ? node.media : '',
      })
      if (isDir && expanded.has(node.path)) walk(node.path, depth + 1)
    }
    // Virtual dirs whose parent is this dir (they have no server node).
    const parentVirtual = state.virtualDirs.filter(d => workspaceParentDir(d) === dirPath)
    for (const dir of parentVirtual) {
      if (children.some(n => n.path === dir)) continue
      const view = virtualDirView(state, dir)
      view.depth = depth
      out.push(view)
      if (expanded.has(dir)) walk(dir, depth + 1)
    }
  }
  walk('', 0)
  return out
}

/* ─────────────────────── multi-tab editor ─────────────────────── */

/** One open editor tab. `savedContent` is the last content KNOWN TO BE
 *  SAVED on the server (the dirty baseline — never the tree entry, which
 *  carries no content). */
export interface WorkspaceTabState {
  path: string
  version: number
  etag: string
  hash: string
  media: string
  binary: boolean
  size: number
  /** Editor content (text nodes only; '' is a real value). */
  content: string
  /** Last content known to be saved on the server. */
  savedContent: string
  /** True when the last save attempt hit a 409 CAS conflict (prompt
   *  reload — never overwrite silently). */
  conflicted: boolean
  status: 'idle' | 'loading' | 'ready' | 'error'
}

/** New tab from a text node read (GET /nodes?path= — the ONLY source of
 *  the dirty baseline, same contract as manuscript-dirty). */
export function tabFromTextNode(node: WorkspaceNodeLite, content: string): WorkspaceTabState {
  return {
    path: node.path,
    version: typeof node.version === 'number' ? node.version : 0,
    etag: typeof node.etag === 'string' ? node.etag : '',
    hash: typeof node.hash === 'string' ? node.hash : '',
    media: typeof node.media === 'string' ? node.media : 'text/plain',
    binary: node.binary === true,
    size: typeof node.size === 'number' ? node.size : 0,
    content,
    savedContent: content,
    conflicted: false,
    status: 'ready',
  }
}

/** Placeholder tab from the TREE meta (no content yet — the panel fetches
 *  the node read right after opening; status 'loading'). */
export function placeholderWorkspaceTab(node: WorkspaceNodeLite): WorkspaceTabState {
  return { ...tabFromTextNode(node, ''), status: 'loading' }
}

/** Open (or activate) a tab — tabs[0] is the ACTIVE tab. Opening a path
 *  that is already open activates the EXISTING tab (keeps its content and
 *  dirty state — never a duplicate). */
export function openWorkspaceTab(tabs: readonly WorkspaceTabState[], tab: WorkspaceTabState): WorkspaceTabState[] {
  const existing = tabs.find(x => x.path === tab.path)
  if (existing !== undefined) return [existing, ...tabs.filter(x => x.path !== tab.path)]
  return [tab, ...tabs]
}

/** Activate an already-open tab (move to front; no-op when absent). */
export function activateWorkspaceTab(tabs: readonly WorkspaceTabState[], path: string): WorkspaceTabState[] {
  const existing = tabs.find(tab => tab.path === path)
  if (existing === undefined) return [...tabs]
  return [existing, ...tabs.filter(tab => tab.path !== path)]
}

/** Close a tab by path (active falls back to the next front tab). */
export function closeWorkspaceTab(tabs: readonly WorkspaceTabState[], path: string): WorkspaceTabState[] {
  return tabs.filter(tab => tab.path !== path)
}

/** The active tab (front of the list), or undefined when none is open. */
export function activeWorkspaceTab(tabs: readonly WorkspaceTabState[]): WorkspaceTabState | undefined {
  return tabs[0]
}

/** Dirty: current content differs from the last content KNOWN TO BE SAVED
 *  ('' is a real value — same semantics as manuscript-dirty). */
export function workspaceTabDirty(tab: WorkspaceTabState): boolean {
  return isEditorDirty(tab.content, tab.savedContent)
}

/** Number of open tabs with unsaved changes. */
export function workspaceDirtyCount(tabs: readonly WorkspaceTabState[]): number {
  return tabs.filter(tab => workspaceTabDirty(tab)).length
}

/** Editor change: set content; editing clears the conflict flag (the
 *  user acknowledged by continuing to type — the panel still shows the
 *  conflict banner until they reload). */
export function updateWorkspaceTabContent(tabs: readonly WorkspaceTabState[], path: string, content: string): WorkspaceTabState[] {
  return tabs.map(tab => tab.path === path
    ? { ...tab, content, conflicted: false }
    : tab)
}

/** Apply a SUCCESSFUL save response: new version/etag/hash/size and the
 *  saved-content baseline (a revert-to-saved must read clean, incl. ''). */
export function applySavedWorkspaceTab(tabs: readonly WorkspaceTabState[], path: string, node: WorkspaceNodeLite, content: string): WorkspaceTabState[] {
  return tabs.map(tab => tab.path === path
    ? {
        ...tab,
        version: typeof node.version === 'number' ? node.version : tab.version,
        etag: typeof node.etag === 'string' ? node.etag : tab.etag,
        hash: typeof node.hash === 'string' ? node.hash : tab.hash,
        size: typeof node.size === 'number' ? node.size : tab.size,
        media: typeof node.media === 'string' ? node.media : tab.media,
        content,
        savedContent: content,
        conflicted: false,
        status: 'ready' as const,
      }
    : tab)
}

/** Apply a RELOAD (refetch after a 409 conflict): full rebaseline from the
 *  freshly read node — server bytes win, dirty is cleared. */
export function reloadWorkspaceTab(tabs: readonly WorkspaceTabState[], path: string, node: WorkspaceNodeLite, content: string): WorkspaceTabState[] {
  return tabs.map(tab => tab.path === path
    ? {
        ...tabFromTextNode(node, content),
        status: 'ready' as const,
      }
    : tab)
}

/** Mark one tab conflicted (a save just got 409) — the editor keeps the
 *  user's content but the panel prompts reload (never overwrite). */
export function markWorkspaceTabConflict(tabs: readonly WorkspaceTabState[], path: string): WorkspaceTabState[] {
  return tabs.map(tab => tab.path === path ? { ...tab, conflicted: true } : tab)
}

/** Server-change detection for watch feeds: paths in the feed whose node
 *  moved forward while a tab is open → the tab is now stale. Mark those
 *  tabs conflicted (the panel prompts reload); the editor content is
 *  preserved. Clean tabs reload; dirty tabs keep their edits until the
 *  user decides. */
export function applyWorkspaceFeedToTabs(tabs: readonly WorkspaceTabState[], feedNodes: readonly WorkspaceNodeLite[]): WorkspaceTabState[] {
  const changed = new Map<string, WorkspaceNodeLite>()
  for (const node of Array.isArray(feedNodes) ? feedNodes : []) {
    if (node === null || typeof node !== 'object' || node.kind !== 'file') continue
    const existing = changed.get(node.path)
    if (existing === undefined) changed.set(node.path, node as WorkspaceNodeLite)
  }
  return tabs.map(tab => {
    const node = changed.get(tab.path)
    if (node === undefined) return tab
    const version = typeof node.version === 'number' ? node.version : tab.version
    const etag = typeof node.etag === 'string' ? node.etag : tab.etag
    // Same version/etag → no server-side change for this tab.
    if (version === tab.version && etag === tab.etag) return tab
    return { ...tab, conflicted: true }
  })
}

/* ─────────────────────── operation call models ─────────────────────── */

function nodesRoute(projectId: string, workspaceId: string): string {
  return `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/nodes`
}

export interface WorkspaceWriteCall {
  method: 'POST'
  path: string
  body: { path: string; content: string; expected_version?: number; expected_etag?: string }
}

/** Create a NEW text file: expected_version=0 = create-if-absent (the
 *  server 409s when the path already exists — no silent overwrite). */
export function createFileCall(projectId: string, workspaceId: string, path: string, content: string): WorkspaceWriteCall {
  return { method: 'POST', path: nodesRoute(projectId, workspaceId), body: { path, content, expected_version: 0 } }
}

/** CAS save of an open tab: the tab's version+etag guard the write
 *  (409 workspace_version_conflict / workspace_etag_conflict on stale). */
export function saveFileCall(projectId: string, workspaceId: string, tab: WorkspaceTabState, content: string): WorkspaceWriteCall {
  const body: WorkspaceWriteCall['body'] = { path: tab.path, content }
  if (tab.version > 0) body.expected_version = tab.version
  if (tab.etag !== '') body.expected_etag = tab.etag
  return { method: 'POST', path: nodesRoute(projectId, workspaceId), body }
}

/** History ROLLBACK: write an old version's bytes back with the CURRENT
 *  version/etag as CAS guard (a concurrent change 409s instead of being
 *  overwritten). */
export function rollbackFileCall(projectId: string, workspaceId: string, current: Pick<WorkspaceNodeLite, 'path' | 'version' | 'etag'>, oldContent: string): WorkspaceWriteCall {
  const body: WorkspaceWriteCall['body'] = { path: current.path, content: oldContent }
  if (typeof current.version === 'number' && current.version > 0) body.expected_version = current.version
  if (typeof current.etag === 'string' && current.etag !== '') body.expected_etag = current.etag
  return { method: 'POST', path: nodesRoute(projectId, workspaceId), body }
}

export interface WorkspaceDeleteCall {
  method: 'DELETE'
  path: string
}

/** Delete with source CAS (expected_version/expected_etag query params —
  *  stale → 409, no silent delete). */
export function deleteNodeCall(projectId: string, workspaceId: string, node: Pick<WorkspaceNodeLite, 'path' | 'version' | 'etag'>): WorkspaceDeleteCall {
  const params = new URLSearchParams({ path: node.path })
  if (typeof node.version === 'number' && node.version > 0) params.set('expected_version', String(node.version))
  if (typeof node.etag === 'string' && node.etag !== '') params.set('expected_etag', node.etag)
  return { method: 'DELETE', path: `${nodesRoute(projectId, workspaceId)}?${params.toString()}` }
}

export interface WorkspaceMoveCall {
  method: 'POST'
  path: string
  body: { from_path: string; to_path: string; expected_version?: number; expected_etag?: string }
}

/** Move/rename with source CAS (the guard protects the SOURCE node; the
  *  server 409s when the destination exists). */
export function moveNodeCall(projectId: string, workspaceId: string, fromPath: string, toPath: string, node: Pick<WorkspaceNodeLite, 'version' | 'etag'> | null): WorkspaceMoveCall {
  const body: WorkspaceMoveCall['body'] = { from_path: fromPath, to_path: toPath }
  if (node !== null && typeof node.version === 'number' && node.version > 0) body.expected_version = node.version
  if (node !== null && typeof node.etag === 'string' && node.etag !== '') body.expected_etag = node.etag
  return { method: 'POST', path: `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/moves`, body }
}

export interface WorkspaceReadVersionCall {
  method: 'GET'
  path: string
}

/** History read of one path at a specific version (rollback PREVIEW —
  *  read-only; the write that restores the bytes is rollbackFileCall). */
export function readVersionCall(projectId: string, workspaceId: string, path: string, version: number): WorkspaceReadVersionCall {
  const params = new URLSearchParams({ path, version: String(version) })
  return { method: 'GET', path: `${nodesRoute(projectId, workspaceId)}?${params.toString()}` }
}

export interface WorkspaceBinaryUploadCall {
  method: 'POST'
  /** Multipart route: /v1/projects/{id}/workspaces/{wsid}/assets. */
  path: string
  /** Form fields (the DOM layer builds the FormData; the file part name
   *  is always 'file'). expected_version/etag guard the replace. */
  fields: { path: string; media: string; expected_version?: number; expected_etag?: string }
  fileField: 'file'
  maxBytes: number
}

/** Binary upload descriptor (multipart, ≤ 32 MiB, server-side sha256 —
  *  the client never declares a hash). CAS fields optional: absent =
  *  create-if-absent, present = guarded replace. */
export function binaryUploadCall(
  projectId: string, workspaceId: string, path: string, media: string,
  opts: { expected_version?: number; expected_etag?: string } = {},
): WorkspaceBinaryUploadCall {
  const fields: WorkspaceBinaryUploadCall['fields'] = { path, media: media === '' ? 'application/octet-stream' : media }
  if (opts.expected_version !== undefined && opts.expected_version > 0) fields.expected_version = opts.expected_version
  if (opts.expected_etag !== undefined && opts.expected_etag !== '') fields.expected_etag = opts.expected_etag
  return {
    method: 'POST',
    path: `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/assets`,
    fields,
    fileField: 'file',
    maxBytes: WORKSPACE_MAX_FILE_BYTES,
  }
}

/** Pre-flight size check against the server cap (32 MiB). */
export function binaryTooLarge(sizeBytes: number): boolean {
  return sizeBytes > WORKSPACE_MAX_FILE_BYTES
}

export interface WorkspaceBinaryDownload {
  method: 'GET'
  /** Raw-bytes route: GET /blobs?path= (content-type = node media, strong
   *  etag header — read returns bytes + media type). */
  url: string
  media: string
  etag: string
}

/** Binary download descriptor from the node meta (blobs route serves the
  *  node's media type verbatim). */
export function binaryDownload(projectId: string, workspaceId: string, node: Pick<WorkspaceNodeLite, 'path' | 'media' | 'etag'>): WorkspaceBinaryDownload {
  const params = new URLSearchParams({ path: node.path })
  return {
    method: 'GET',
    url: `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/blobs?${params.toString()}`,
    media: typeof node.media === 'string' && node.media !== '' ? node.media : 'application/octet-stream',
    etag: typeof node.etag === 'string' ? node.etag : '',
  }
}

export interface WorkspaceSearchCall {
  method: 'POST'
  path: string
  /** PATH search only — the server implements prefix/glob path matching
   *  and NO content search (recorded honestly; the UI never claims
   *  content search). */
  body: { prefix?: string; glob?: string }
}

/** Server path-search descriptor (null while the query is blank). */
export function workspaceSearchCall(projectId: string, workspaceId: string, query: string): WorkspaceSearchCall | null {
  const q = query.trim()
  if (q === '') return null
  const body: WorkspaceSearchCall['body'] = {}
  // 'src/*.ts' style queries: prefix is the longest non-glob head (trailing
  // '/' trimmed — the server normalizes prefixes itself).
  const globIdx = q.search(/[*?]/)
  if (globIdx === -1) body.prefix = q
  else {
    const head = q.slice(0, globIdx).replace(/\/+$/, '')
    if (head !== '') body.prefix = head
    body.glob = q
  }
  return { method: 'POST', path: `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}/search`, body }
}

/** CLIENT-side path filter: case-insensitive substring on the full path
 *  (the search box applies this to the loaded tree; the server search is
 *  prefix/glob PATH matching — content search is not implemented). */
export function filterWorkspacePaths(nodes: readonly WorkspaceNodeLite[], query: string): WorkspaceNodeLite[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...nodes]
  return nodes.filter(n => n.path.toLowerCase().includes(q))
}

/* ─────────────────────── watch / listSince ─────────────────────── */

/**
 * Merge one listSince watch feed into the tree: changed nodes upsert,
 * deleted paths (+ their descendants) are removed, implied dirs are
 * re-derived from the file set (listSince feeds carry NO dir nodes — the
 * client projects them), and the workspace revision follows the feed.
 * Virtual dirs pruned once the server projects them. Idempotent — applying
 * the same feed twice converges (no duplicates).
 */
export function applyWorkspaceListSince(prev: WorkspaceTreeState, payload: WorkspaceListSincePayload): WorkspaceTreeState {
  const byPath = new Map(prev.nodes.map(n => [n.path, n]))
  for (const node of Array.isArray(payload.nodes) ? payload.nodes : []) {
    if (node === null || typeof node !== 'object') continue
    byPath.set(node.path, node as WorkspaceNodeLite)
  }
  const deleted = Array.isArray(payload.deleted) ? payload.deleted : []
  for (const path of deleted) {
    byPath.delete(path)
    for (const key of [...byPath.keys()]) {
      if (key.startsWith(`${path}/`)) byPath.delete(key)
    }
  }
  const nodes = withImpliedWorkspaceDirs([...byPath.values()])
  const serverDirs = new Set(nodes.filter(n => n.kind === 'dir').map(n => n.path))
  return {
    ...prev,
    // info MERGES (never replaces): stream feeds carry only {revision} —
    // the workspace identity fields come from the tree load / poll feeds.
    info: typeof payload.info === 'object' && payload.info !== null
      ? { ...(prev.info ?? {}), ...(payload.info as Partial<WorkspaceInfoLite>) } as WorkspaceInfoLite
      : prev.info,
    nodes,
    virtualDirs: prev.virtualDirs.filter(dir => !serverDirs.has(dir)),
    status: 'ready',
  }
}

/* ─────────────────────── SSE watch stream client ─────────────────────── */

/** Watch transport lifecycle: 'idle' → 'connecting' → 'live' ⇄
 *  'reconnecting' → ('disconnected' | 'polling'). 'polling' = the SSE
 *  stream gave up and the client polls listSince (designed fallback). */
export type WorkspaceWatchStatus =
  | 'idle' | 'connecting' | 'live' | 'reconnecting' | 'disconnected' | 'polling' | 'stopped'

export interface WorkspaceWatchOptions {
  projectId: string
  /** Resolve the CURRENT watch target at (re)connect/poll time (the panel
   *  switches workspaces; null = nothing to watch right now). */
  target: () => { workspaceId: string; revision: number } | null
  /** Inject the stream transport (client/sse-client.ts). */
  fetchImpl?: SseFetch
  /** Extra per-connect headers (auth). */
  headers?: () => Promise<Record<string, string>> | Record<string, string>
  /** Timer scheduler (fake in tests; global setTimeout in the browser). */
  scheduler?: SseScheduler
  /** listSince POLL fallback (the panel wires its authenticated api() call;
   *  absent → the client only reports the 'polling' status). */
  pollListSince?: (afterRevision: number) => Promise<WorkspaceListSincePayload | null>
  /** Poll cadence — WORKSPACE_WATCH_POLL_MS by default. */
  pollIntervalMs?: number
  /** One watch feed (nodes + deleted tombstones — the consumer merges it
   *  with applyWorkspaceListSince). */
  onFeed: (payload: WorkspaceListSincePayload) => void
  onStatus?: (status: WorkspaceWatchStatus) => void
  /** No stream bytes for this long → reconnect (server heartbeats must
   *  arrive more often). Default 30s. */
  heartbeatTimeoutMs?: number
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  /** Consecutive failed connect attempts before the POLL fallback. */
  maxReconnectAttempts?: number
}

/** The Workspace watch consumer: SSE stream
 *  (GET /v1/projects/{id}/workspaces/{wid}/watch/stream?after_revision=N)
 *  with listSince poll fallback. Change nodes + delete tombstones are
 *  normalized into WorkspaceListSincePayload feeds — the SAME payload the
 *  poll endpoint returns, so applyWorkspaceListSince (and the tabs
 *  conflict detection) behave identically on both transports. PURE LOGIC —
 *  NO DOM: fetch + scheduler injected. */
export class WorkspaceWatchClient {
  readonly options: WorkspaceWatchOptions
  status: WorkspaceWatchStatus = 'idle'
  private readonly scheduler: SseScheduler
  private sse: SseClient | null = null
  private pollTimer: unknown = null
  private retryTimer: unknown = null
  private stopped = false

  constructor(options: WorkspaceWatchOptions) {
    this.options = options
    this.scheduler = options.scheduler ?? defaultSseScheduler
  }

  /** Start watching (idempotent while live/connecting/reconnecting; a
   *  stopped watcher can be started again). When no watch target exists
   *  yet (workspace not loaded), retries on the poll cadence until one
   *  does. */
  start(): void {
    if (this.status === 'live' || this.status === 'connecting' || this.status === 'reconnecting') return
    this.stopped = false
    if (this.options.target() === null) {
      this.setStatus('idle')
      if (this.retryTimer === null) {
        this.retryTimer = this.scheduler.setTimeout(() => {
          this.retryTimer = null
          if (!this.stopped) this.start()
        }, this.options.pollIntervalMs ?? WORKSPACE_WATCH_POLL_MS)
      }
      return
    }
    this.connectStream()
  }

  /** Stop watching (tab leave): aborts the stream and clears the poll
   *  fallback timer. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.sse?.close()
    this.sse = null
    if (this.pollTimer !== null) {
      this.scheduler.clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.retryTimer !== null) {
      this.scheduler.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.setStatus('stopped')
  }

  private setStatus(status: WorkspaceWatchStatus): void {
    if (this.status === status) return
    this.status = status
    this.options.onStatus?.(status)
  }

  /** Open the watch stream for the CURRENT target (the url builder folds
   *  the live revision in — reconnect resumes from where the stream
   *  stopped, never replays the whole feed). */
  private connectStream(): void {
    const target = this.options.target()
    if (target === null) {
      this.setStatus('idle')
      return
    }
    const { workspaceId } = target
    const projectId = this.options.projectId
    this.sse?.close()
    const client = new SseClient({
      url: () => {
        const t = this.options.target()
        if (t === null || t.workspaceId !== workspaceId) return ''
        return `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(t.workspaceId)}/watch/stream?after_revision=${t.revision}`
      },
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      scheduler: this.options.scheduler,
      heartbeatTimeoutMs: this.options.heartbeatTimeoutMs,
      reconnectBaseMs: this.options.reconnectBaseMs,
      reconnectMaxMs: this.options.reconnectMaxMs,
      maxReconnectAttempts: this.options.maxReconnectAttempts,
      onEvent: (event) => { this.onStreamEvent(event) },
      onStatus: (status) => {
        this.setStatus(status === 'closed' ? 'disconnected' : status)
      },
      onEnd: (reason) => {
        if (reason !== 'max-retries') return
        // The stream gave up → listSince POLL fallback (designed
        // degradation; the revision cursor was never lost, so the poll
        // resumes exactly where the stream stopped).
        this.sse?.close()
        this.sse = null
        this.startPollFallback()
      },
    })
    this.sse = client
    client.open()
  }

  /** listSince poll fallback loop (same cadence as the legacy watcher). */
  private startPollFallback(): void {
    if (this.stopped) return
    this.setStatus('polling')
    if (this.options.pollListSince === undefined) return
    const tick = (): void => {
      if (this.stopped) return
      const target = this.options.target()
      if (target !== null && this.options.pollListSince !== undefined) {
        void this.options.pollListSince(target.revision).then(payload => {
          if (this.stopped) return
          if (payload !== null) this.options.onFeed(payload)
        })
      }
      this.pollTimer = this.scheduler.setTimeout(tick, this.options.pollIntervalMs ?? WORKSPACE_WATCH_POLL_MS)
    }
    this.pollTimer = this.scheduler.setTimeout(tick, this.options.pollIntervalMs ?? WORKSPACE_WATCH_POLL_MS)
  }

  /** One SSE dispatch → a listSince-shaped feed. The server emits ONE
   *  change/delete event per node ({node, revision} / {path, revision});
   *  batch shapes ({nodes, deleted}) and bare arrays are accepted too
   *  (defensive). */
  private onStreamEvent(event: SseEvent): void {
    let data: unknown
    try {
      data = JSON.parse(event.data)
    } catch {
      return // malformed frame: skip
    }
    if (event.event === 'heartbeat' || event.event === 'subscribed' || event.event === 'revision') return
    if (Array.isArray(data)) {
      // bare node batch
      this.feed(data as WorkspaceNodeLite[], [])
      return
    }
    if (typeof data !== 'object' || data === null) return
    const obj = data as Record<string, unknown>
    if (event.event === 'change') {
      // one changed node: {node, revision}
      if (typeof obj.node === 'object' && obj.node !== null) {
        this.feed([obj.node as WorkspaceNodeLite], [], typeof obj.revision === 'number' ? { revision: obj.revision } : undefined)
      }
      return
    }
    if (event.event === 'delete') {
      // one delete tombstone: {path, revision}
      if (typeof obj.path === 'string') {
        this.feed([], [obj.path], typeof obj.revision === 'number' ? { revision: obj.revision } : undefined)
      }
      return
    }
    if (Array.isArray(obj.nodes) || Array.isArray(obj.deleted)) {
      this.feed(
        Array.isArray(obj.nodes) ? obj.nodes as WorkspaceNodeLite[] : [],
        Array.isArray(obj.deleted) ? obj.deleted as string[] : [],
        // a bare {revision} advance merges into the tree info (the cursor
        // and the UI revision both follow the stream)
        obj.info ?? (typeof obj.revision === 'number' ? { revision: obj.revision } : undefined),
      )
      return
    }
    if (typeof obj.path === 'string' && (obj.deleted === true || obj.tombstone === true)) {
      this.feed([], [obj.path], typeof obj.revision === 'number' ? { revision: obj.revision } : undefined)
      return
    }
    // unknown event shapes are ignored (future-proof)
  }

  /** Normalize into the listSince payload shape (info optional on stream
   *  feeds — applyWorkspaceListSince keeps the current info when absent;
   *  the poll endpoint always returns it). */
  private feed(nodes: WorkspaceNodeLite[], deleted: string[], info?: unknown): void {
    if (this.stopped) return
    const payload: WorkspaceListSincePayload = {
      info: info as WorkspaceInfoLite | undefined,
      nodes,
      deleted,
    } as WorkspaceListSincePayload
    this.options.onFeed(payload)
  }
}

/* ─────────────────────── conflict handling ─────────────────────── */

export type WorkspaceConflictKind =
  | 'version'       // workspace_version_conflict → reload the file
  | 'etag'          // workspace_etag_conflict → reload the file
  | 'destination'   // workspace_move_destination_exists → pick another name
  | 'missing'       // workspace_file_not_found → refresh the tree
  | 'binary'        // workspace_binary_read_only → binary node is not text-editable
  | 'quarantined'   // workspace_inconsistent → workspace isolated, refresh later
  | 'unknown'

/** Map a server error code onto the conflict decision (null = not a
 *  CAS/path conflict — plain request error). */
export function workspaceConflictKind(code: string | undefined): WorkspaceConflictKind | null {
  switch (code) {
    case 'workspace_version_conflict': return 'version'
    case 'workspace_etag_conflict': return 'etag'
    case 'workspace_move_destination_exists': return 'destination'
    case 'workspace_file_not_found': return 'missing'
    case 'workspace_binary_read_only': return 'binary'
    case 'workspace_inconsistent': return 'quarantined'
    default: return null
  }
}

/** Whether a server code is a CAS/path conflict the panel must surface. */
export function isWorkspaceConflict(code: string | undefined): boolean {
  return workspaceConflictKind(code) !== null
}

/* ─────────────────────── history view ─────────────────────── */

export function hasWorkspaceKey(key: string, locale: Locale): boolean {
  const dict = (locale === 'zh' ? workspaceZh : workspaceEn) as Record<string, string>
  return dict[key] !== undefined
}

/** Op-type copy: workspace.op.* when known, else the raw wire value. */
export function workspaceOpText(op: string | undefined | null, locale: Locale = getLocale()): string {
  if (op === undefined || op === null || op === '') return ''
  const key = `workspace.op.${op}`
  if (hasWorkspaceKey(key, locale)) return t('workspace', key)
  return op
}

/** Workspace-kind copy: workspace.kind.* when known, else raw wire. */
export function workspaceKindText(kind: string | undefined | null, locale: Locale = getLocale()): string {
  if (kind === undefined || kind === null || kind === '') return ''
  const key = `workspace.kind.${kind}`
  if (hasWorkspaceKey(key, locale)) return t('workspace', key)
  return kind
}

export interface WorkspaceOpView {
  op: string
  opText: string
  path: string
  fromPath: string | null
}

export interface WorkspaceHistoryEntryView {
  revision: number
  timeText: string
  ops: WorkspaceOpView[]
}

function formatWorkspaceTime(raw: string, locale: Locale): string {
  const ts = Date.parse(raw)
  if (!Number.isFinite(ts)) return raw
  try {
    return new Date(ts).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return raw
  }
}

/** History projection (newest first, as served): per-revision time + op
 *  rows (op copy from the workspace namespace; unknown ops stay verbatim). */
export function workspaceHistoryView(
  revisions: readonly WorkspaceRevisionLite[],
  locale: Locale = getLocale(),
): WorkspaceHistoryEntryView[] {
  return (Array.isArray(revisions) ? revisions : []).map(rev => ({
    revision: typeof rev.revision === 'number' ? rev.revision : 0,
    timeText: formatWorkspaceTime(typeof rev.at === 'string' ? rev.at : '', locale),
    ops: (Array.isArray(rev.ops) ? (rev.ops as WorkspaceOpLite[]) : []).map(op => ({
      op: typeof op.op === 'string' ? op.op : '',
      opText: workspaceOpText(op.op, locale),
      path: typeof op.path === 'string' ? op.path : '',
      fromPath: typeof op.from_path === 'string' ? op.from_path : null,
    })),
  }))
}

/** Human size text (B/KB/MB — wire numbers, no i18n keys; the panel shows
 *  it as data, not chrome copy). */
export function formatWorkspaceBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
