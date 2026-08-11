/**
 * WORK-01 Workspace panel (DOM assembly over workspace-model.ts — the pure
 * logic layer, hardening-v0.2-status.md §5): workspace picker + toolbar
 * (新建/上传/刷新/搜索), a lazy-expand file tree, multi-tab editor with CAS
 * save (409 → reload prompt, never silent overwrite), binary read-only
 * meta + download, history/rollback, and listSince watch polling. All
 * chrome copy goes through the `workspace` i18n namespace (zh/en parity);
 * node paths, media types and op enums are wire values shown verbatim.
 *
 * The DOM layer keeps per-project panel state (survives re-renders and
 * locale switches, same pattern as panels/trajectory.ts). The watch poll
 * runs only while the Workspace tab is the active tab (index.ts calls
 * stopWorkspaceWatch() when leaving, like terminalDisconnect).
 *
 * Browser visual acceptance (drag-drop upload, narrow viewports,
 * keyboard/a11y) stays NOT_RUN_MANUAL_PENDING (hardening §5).
 */
import { api, apiMultipart, apiResult, authHeaders, base } from '../api'
import { t } from '../i18n/index'
import { el } from '../ui'
import {
  WORKSPACE_WATCH_POLL_MS,
  WorkspaceWatchClient,
  activeWorkspaceTab, activateWorkspaceTab, addWorkspaceVirtualDir,
  applySavedWorkspaceTab, applyWorkspaceFeedToTabs, applyWorkspaceListSince,
  applyWorkspaceTree, binaryDownload, binaryTooLarge, binaryUploadCall,
  closeWorkspaceTab, createFileCall, deleteNodeCall, flattenWorkspaceTree,
  formatWorkspaceBytes, initialWorkspaceTreeState, markWorkspaceTabConflict,
  moveNodeCall, openWorkspaceTab, placeholderWorkspaceTab, readVersionCall,
  reloadWorkspaceTab, rollbackFileCall, saveFileCall, selectWorkspacePath,
  tabFromTextNode, toggleWorkspaceDir, updateWorkspaceTabContent,
  workspaceBasename, workspaceConflictKind, workspaceDirVirtual,
  workspaceHistoryView, workspaceKindText, workspaceNodeAt, workspaceTabDirty,
} from '../workspace-model'
import type { SseFetch } from '../sse-client'
import type {
  WorkspaceInfoLite, WorkspaceNodeLite, WorkspaceRevisionLite,
  WorkspaceTreePayload, WorkspaceListSincePayload,
} from '../types'
import type { WorkspaceTabState } from '../workspace-model'

/** Per-project panel state (module-scoped, survives panel re-renders). */
interface WorkspacePanelState {
  workspaces: WorkspaceInfoLite[]
  listStatus: 'idle' | 'loading' | 'ready' | 'error'
  activeWorkspaceId: string
  tree: ReturnType<typeof initialWorkspaceTreeState>
  expanded: Set<string>
  tabs: WorkspaceTabState[]
  history: WorkspaceRevisionLite[] | null
  historyPath: string
  searchQuery: string
  inflight: boolean
  /** One-line notice rendered above the tree ('' = none). */
  notice: string
  noticeError: boolean
}

const panelStates = new Map<string, WorkspacePanelState>()

function ensureState(projectId: string): WorkspacePanelState {
  let st = panelStates.get(projectId)
  if (st === undefined) {
    st = {
      workspaces: [], listStatus: 'idle', activeWorkspaceId: '',
      tree: initialWorkspaceTreeState(''), expanded: new Set(), tabs: [],
      history: null, historyPath: '', searchQuery: '', inflight: false,
      notice: '', noticeError: false,
    }
    panelStates.set(projectId, st)
  }
  return st
}

/* ─────────────────── watch stream (active tab only) ─────────────────── */

let watchClient: WorkspaceWatchClient | null = null
let watchProject: string | null = null
/** Live watch status key ('' = none) — repainted by the watch status hook. */
let watchStatusText = ''
/** The watch status chip in the current note row (rebuilt on paint). */
let watchStatusEl: HTMLElement | null = null

/** Stop the watch (SSE stream + poll fallback) — called by index.ts when
 *  the Workspace tab is left (same hygiene as terminalDisconnect). */
export function stopWorkspaceWatch(): void {
  watchClient?.stop()
  watchClient = null
  watchProject = null
  watchStatusText = ''
  watchStatusEl = null
}

/** The watch stream fetch wrapper (authenticated, accept text/event-stream). */
function watchStreamFetch(): SseFetch {
  return async (url, init) => {
    const response = await fetch(`${base()}${url}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        accept: 'text/event-stream',
        ...(await authHeaders()),
      },
    })
    return { ok: response.ok, status: response.status, body: response.body }
  }
}

/** Watch status copy (workspace.watch.* — the panel paints it in the
 *  watch note row). */
function watchStatusKey(status: string): string {
  switch (status) {
    case 'connecting': return 'workspace.watch.connecting'
    case 'live': return 'workspace.watch.live'
    case 'reconnecting': return 'workspace.watch.reconnecting'
    case 'polling': return 'workspace.watch.polling'
    case 'disconnected': return 'workspace.watch.disconnected'
    default: return ''
  }
}

/** Start the SSE watch stream for the active workspace (falls back to
 *  listSince polling when the stream gives up). One client per project;
 *  the tree/tabs merge is identical on both transports. */
function startWorkspaceWatch(body: HTMLElement, projectId: string, st: WorkspacePanelState): void {
  if (watchClient !== null && watchProject === projectId) return
  stopWorkspaceWatch()
  watchProject = projectId
  watchClient = new WorkspaceWatchClient({
    projectId,
    target: () => {
      const wsId = st.activeWorkspaceId
      if (wsId === '' || st.tree.info === null || st.tree.status !== 'ready') return null
      return { workspaceId: wsId, revision: st.tree.info.revision }
    },
    fetchImpl: watchStreamFetch(),
    pollListSince: async (afterRevision) => {
      const wsId = st.activeWorkspaceId
      if (wsId === '') return null
      return api<WorkspaceListSincePayload>(
        `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wsId)}/nodes?after_revision=${afterRevision}`,
      )
    },
    onFeed: (payload) => {
      const hadChanges = (Array.isArray(payload.nodes) && payload.nodes.length > 0)
        || (Array.isArray(payload.deleted) && payload.deleted.length > 0)
      st.tree = applyWorkspaceListSince(st.tree, payload)
      st.tabs = applyWorkspaceFeedToTabs(st.tabs, payload.nodes)
      // Repaint only when the feed actually changed something (typing in the
      // editor must never be disrupted by an empty tick).
      if (hadChanges) paintWorkspace(body, st, projectId)
    },
    onStatus: (status) => {
      watchStatusText = watchStatusKey(status)
      if (watchStatusEl !== null) {
        const text = watchStatusText === '' ? '' : t('workspace', watchStatusText)
        watchStatusEl.textContent = text
      }
    },
  })
  watchClient.start()
}

/* ─────────────────────── data loading ─────────────────────── */

async function loadWorkspaces(body: HTMLElement, projectId: string, st: WorkspacePanelState): Promise<void> {
  if (st.listStatus !== 'idle' && st.listStatus !== 'error') return
  st.listStatus = 'loading'
  paintWorkspace(body, st, projectId)
  const list = await api<WorkspaceInfoLite[]>(`/v1/projects/${encodeURIComponent(projectId)}/workspaces`)
  if (list === null) {
    st.listStatus = 'error'
    paintWorkspace(body, st, projectId)
    return
  }
  st.workspaces = Array.isArray(list) ? list : []
  st.listStatus = 'ready'
  if (st.activeWorkspaceId === '' && st.workspaces.length > 0) st.activeWorkspaceId = st.workspaces[0]!.workspace_id
  if (st.activeWorkspaceId !== '') await loadTree(body, projectId, st)
  else paintWorkspace(body, st, projectId)
}

async function loadTree(body: HTMLElement, projectId: string, st: WorkspacePanelState): Promise<void> {
  const wsId = st.activeWorkspaceId
  if (wsId === '') return
  st.tree = { ...st.tree, workspaceId: wsId, status: 'loading' }
  paintWorkspace(body, st, projectId)
  const payload = await api<WorkspaceTreePayload>(
    `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wsId)}/tree`,
  )
  if (payload === null) {
    st.tree = { ...st.tree, status: 'error' }
    paintWorkspace(body, st, projectId)
    return
  }
  st.tree = applyWorkspaceTree(st.tree, payload)
  if (st.historyPath !== '') await loadHistory(body, projectId, st, st.historyPath)
  paintWorkspace(body, st, projectId)
}

async function loadHistory(body: HTMLElement, projectId: string, st: WorkspacePanelState, path: string): Promise<void> {
  const wsId = st.activeWorkspaceId
  if (wsId === '') return
  const revisions = await api<WorkspaceRevisionLite[]>(
    `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wsId)}/history`,
  )
  if (revisions === null) return
  st.history = Array.isArray(revisions) ? revisions : []
  st.historyPath = path
}

/** Open a node as a tab: text → editor tab (content baseline from the
 *  read), binary → read-only tab (meta + download). */
async function openNodeTab(body: HTMLElement, projectId: string, st: WorkspacePanelState, path: string): Promise<void> {
  const wsId = st.activeWorkspaceId
  if (wsId === '') return
  const node = workspaceNodeAt(st.tree, path)
  if (node === null || node.kind === 'dir') return
  st.tabs = openWorkspaceTab(st.tabs, placeholderWorkspaceTab(node))
  if (node.binary) {
    st.tabs = st.tabs.map(x => x.path === path
      ? {
          ...x, binary: true, media: node.media, size: node.size,
          version: node.version, etag: node.etag, hash: node.hash,
          content: '', savedContent: '', conflicted: false, status: 'ready' as const,
        }
      : x)
    paintWorkspace(body, st, projectId)
    void loadHistory(body, projectId, st, path)
    return
  }
  st.tabs = tabsWithStatus(st.tabs, path, 'loading')
  paintWorkspace(body, st, projectId)
  const read = await api<WorkspaceNodeLite>(
    `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wsId)}/nodes?path=${encodeURIComponent(path)}`,
  )
  if (read === null) {
    st.tabs = tabsWithStatus(st.tabs, path, 'error')
    paintWorkspace(body, st, projectId)
    return
  }
  st.tabs = st.tabs.map(x => x.path === path ? tabFromTextNode(read, read.content ?? '') : x)
  paintWorkspace(body, st, projectId)
  void loadHistory(body, projectId, st, path)
}

function tabsWithStatus(tabs: readonly WorkspaceTabState[], path: string, status: WorkspaceTabState['status']): WorkspaceTabState[] {
  return tabs.map(tab => tab.path === path ? { ...tab, status } : tab)
}

/* ─────────────────────── operations ─────────────────────── */

async function saveActiveTab(body: HTMLElement, projectId: string, st: WorkspacePanelState): Promise<void> {
  const tab = activeWorkspaceTab(st.tabs)
  const wsId = st.activeWorkspaceId
  if (tab === undefined || tab.binary || wsId === '') return
  const content = tab.content
  if (!workspaceTabDirty(tab)) return
  st.tabs = tabsWithStatus(st.tabs, tab.path, 'loading')
  paintWorkspace(body, st, projectId)
  const call = saveFileCall(projectId, wsId, tab, content)
  const result = await apiResult<WorkspaceNodeLite>(call.path, { method: call.method, body: JSON.stringify(call.body) })
  if (result.ok) {
    st.tabs = applySavedWorkspaceTab(st.tabs, tab.path, result.data, content)
    await loadTree(body, projectId, st)
    return
  }
  const kind = workspaceConflictKind(result.error.code)
  if (kind === 'version' || kind === 'etag') {
    // 409 CAS conflict → prompt reload (never overwrite the server bytes).
    st.tabs = markWorkspaceTabConflict(st.tabs, tab.path)
    st.tabs = tabsWithStatus(st.tabs, tab.path, 'ready')
    st.notice = t('workspace', 'workspace.editor.conflictBanner')
    st.noticeError = true
  } else {
    st.tabs = tabsWithStatus(st.tabs, tab.path, 'error')
    st.notice = `${result.error.code ?? 'http_error'}: ${result.error.message ?? ''}`
    st.noticeError = true
  }
  paintWorkspace(body, st, projectId)
}

async function reloadActiveTab(body: HTMLElement, projectId: string, st: WorkspacePanelState): Promise<void> {
  const tab = activeWorkspaceTab(st.tabs)
  const wsId = st.activeWorkspaceId
  if (tab === undefined || wsId === '') return
  st.tabs = tabsWithStatus(st.tabs, tab.path, 'loading')
  st.notice = ''
  st.noticeError = false
  paintWorkspace(body, st, projectId)
  const read = await api<WorkspaceNodeLite>(
    `/v1/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wsId)}/nodes?path=${encodeURIComponent(tab.path)}`,
  )
  if (read === null) {
    st.tabs = tabsWithStatus(st.tabs, tab.path, 'error')
    paintWorkspace(body, st, projectId)
    return
  }
  st.tabs = reloadWorkspaceTab(st.tabs, tab.path, read, read.content ?? '')
  paintWorkspace(body, st, projectId)
  void loadHistory(body, projectId, st, tab.path)
}

async function createFile(body: HTMLElement, projectId: string, st: WorkspacePanelState): Promise<void> {
  const wsId = st.activeWorkspaceId
  if (wsId === '') return
  const raw = prompt(t('workspace', 'workspace.create.filePrompt'))
  if (raw === null) return
  const path = raw.trim()
  if (path === '') return
  const call = createFileCall(projectId, wsId, path, '')
  const result = await apiResult<WorkspaceNodeLite>(call.path, { method: call.method, body: JSON.stringify(call.body) })
  if (result.ok) {
    st.notice = t('workspace', 'workspace.create.fileCreated', { path })
    st.noticeError = false
    await loadTree(body, projectId, st)
    void openNodeTab(body, projectId, st, path)
  } else if (workspaceConflictKind(result.error.code) === 'version' || workspaceConflictKind(result.error.code) === 'etag') {
    st.notice = t('workspace', 'workspace.create.conflict')
    st.noticeError = true
    paintWorkspace(body, st, projectId)
  } else {
    st.notice = `${result.error.code ?? 'http_error'}: ${result.error.message ?? ''}`
    st.noticeError = true
    paintWorkspace(body, st, projectId)
  }
}

function createDir(body: HTMLElement, projectId: string, st: WorkspacePanelState): void {
  const wsId = st.activeWorkspaceId
  if (wsId === '') return
  const raw = prompt(t('workspace', 'workspace.create.dirPrompt'))
  if (raw === null) return
  const path = raw.trim()
  if (path === '') return
  st.tree = addWorkspaceVirtualDir(st.tree, path)
  st.notice = t('workspace', 'workspace.create.dirCreated', { path })
  st.noticeError = false
  paintWorkspace(body, st, projectId)
}

async function deleteNode(body: HTMLElement, projectId: string, st: WorkspacePanelState, path: string): Promise<void> {
  const wsId = st.activeWorkspaceId
  if (wsId === '') return
  const node = workspaceNodeAt(st.tree, path)
  if (node === null) {
    // Virtual dir: client-side removal only (the server has no dir node).
    if (workspaceDirVirtual(st.tree, path)) {
      st.tree = { ...st.tree, virtualDirs: st.tree.virtualDirs.filter(d => d !== path) }
      paintWorkspace(body, st, projectId)
    }
    return
  }
  if (node.kind === 'dir') return // real dirs are projections — no dir node to delete
  if (!confirm(t('workspace', 'workspace.delete.confirm', { path }))) return
  const call = deleteNodeCall(projectId, wsId, node)
  const result = await apiResult<{ ok?: boolean }>(call.path, { method: call.method })
  if (result.ok) {
    st.notice = t('workspace', 'workspace.deleted', { path })
    st.noticeError = false
    st.tabs = st.tabs.filter(tab => tab.path !== path)
    await loadTree(body, projectId, st)
  } else {
    st.notice = `${result.error.code ?? 'http_error'}: ${result.error.message ?? ''}`
    st.noticeError = true
    paintWorkspace(body, st, projectId)
  }
}

async function moveNode(body: HTMLElement, projectId: string, st: WorkspacePanelState, path: string): Promise<void> {
  const wsId = st.activeWorkspaceId
  if (wsId === '') return
  const raw = prompt(t('workspace', 'workspace.move.prompt', { path }))
  if (raw === null) return
  const toPath = raw.trim()
  if (toPath === '' || toPath === path) return
  const node = workspaceNodeAt(st.tree, path)
  if (node === null || node.kind === 'dir') return
  const call = moveNodeCall(projectId, wsId, path, toPath, node)
  const result = await apiResult<WorkspaceNodeLite>(call.path, { method: call.method, body: JSON.stringify(call.body) })
  if (result.ok) {
    st.notice = t('workspace', 'workspace.move.moved', { path: toPath })
    st.noticeError = false
    st.tabs = st.tabs.map(tab => tab.path === path ? { ...tab, path: toPath } : tab)
    await loadTree(body, projectId, st)
  } else if (workspaceConflictKind(result.error.code) === 'destination') {
    st.notice = t('workspace', 'workspace.move.destExists')
    st.noticeError = true
    paintWorkspace(body, st, projectId)
  } else {
    st.notice = `${result.error.code ?? 'http_error'}: ${result.error.message ?? ''}`
    st.noticeError = true
    paintWorkspace(body, st, projectId)
  }
}

async function uploadFile(body: HTMLElement, projectId: string, st: WorkspacePanelState, file: File): Promise<void> {
  const wsId = st.activeWorkspaceId
  if (wsId === '' || file === undefined) return
  if (binaryTooLarge(file.size)) {
    st.notice = t('workspace', 'workspace.upload.overSize')
    st.noticeError = true
    paintWorkspace(body, st, projectId)
    return
  }
  // Upload target: the selected dir, else the selected file's parent, else root.
  const selected = st.tree.selectedPath
  let dir = ''
  const selectedNode = selected !== '' ? workspaceNodeAt(st.tree, selected) : null
  if (selectedNode !== null && selectedNode.kind === 'dir') dir = selected
  else if (selectedNode !== null) dir = selectedNode.path.includes('/') ? selectedNode.path.slice(0, selectedNode.path.lastIndexOf('/')) : ''
  const path = dir === '' ? file.name : `${dir}/${file.name}`
  const existing = workspaceNodeAt(st.tree, path)
  const call = binaryUploadCall(projectId, wsId, path, file.type, existing !== null
    ? { expected_version: existing.version, expected_etag: existing.etag }
    : {})
  const form = new FormData()
  form.append('path', call.fields.path)
  form.append('media', call.fields.media)
  if (call.fields.expected_version !== undefined) form.append('expected_version', String(call.fields.expected_version))
  if (call.fields.expected_etag !== undefined) form.append('expected_etag', call.fields.expected_etag)
  form.append(call.fileField, file, file.name)
  const result = await apiMultipart<WorkspaceNodeLite>(call.path, form)
  if (result.ok) {
    st.notice = t('workspace', 'workspace.upload.done', { path })
    st.noticeError = false
    await loadTree(body, projectId, st)
    void openNodeTab(body, projectId, st, path)
  } else {
    const kind = workspaceConflictKind(result.error.code)
    if (kind === 'version' || kind === 'etag') {
      st.notice = t('workspace', 'workspace.editor.conflictBanner')
    } else {
      st.notice = `${result.error.code ?? 'http_error'}: ${result.error.message ?? ''}`
    }
    st.noticeError = true
    paintWorkspace(body, st, projectId)
  }
}

async function rollbackTo(body: HTMLElement, projectId: string, st: WorkspacePanelState, version: number): Promise<void> {
  const tab = activeWorkspaceTab(st.tabs)
  const wsId = st.activeWorkspaceId
  if (tab === undefined || tab.binary || wsId === '') return
  if (!confirm(t('workspace', 'workspace.history.rollbackConfirm', { version: String(version) }))) return
  const readCall = readVersionCall(projectId, wsId, tab.path, version)
  const old = await api<WorkspaceNodeLite>(readCall.path)
  if (old === null) {
    st.notice = t('workspace', 'workspace.history.empty')
    st.noticeError = true
    paintWorkspace(body, st, projectId)
    return
  }
  const current = workspaceNodeAt(st.tree, tab.path)
  const call = rollbackFileCall(projectId, wsId, current ?? { path: tab.path, version: tab.version, etag: tab.etag }, old.content ?? '')
  const result = await apiResult<WorkspaceNodeLite>(call.path, { method: call.method, body: JSON.stringify(call.body) })
  if (result.ok) {
    st.tabs = applySavedWorkspaceTab(st.tabs, tab.path, result.data, old.content ?? '')
    st.notice = t('workspace', 'workspace.history.rolledBack', { version: String(version) })
    st.noticeError = false
    await loadTree(body, projectId, st)
    void loadHistory(body, projectId, st, tab.path)
  } else {
    const kind = workspaceConflictKind(result.error.code)
    st.notice = kind === 'version' || kind === 'etag'
      ? t('workspace', 'workspace.editor.conflictBanner')
      : `${result.error.code ?? 'http_error'}: ${result.error.message ?? ''}`
    st.noticeError = true
    paintWorkspace(body, st, projectId)
  }
}

/** Binary download via the authenticated blobs route (raw bytes + the
 *  node's media type). */
async function downloadBinary(projectId: string, st: WorkspacePanelState, path: string): Promise<void> {
  const node = workspaceNodeAt(st.tree, path)
  if (node === null) return
  const dl = binaryDownload(projectId, st.activeWorkspaceId, node)
  try {
    const response = await fetch(`${base()}${dl.url}`, {
      headers: { ...(await authHeaders()), accept: 'application/octet-stream' },
    })
    if (!response.ok) return
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = workspaceBasename(node.path)
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch {
    /* download failed — keep the panel quiet */
  }
}

async function ensureWorkspace(body: HTMLElement, projectId: string, st: WorkspacePanelState): Promise<void> {
  const result = await apiResult<WorkspaceInfoLite>(`/v1/projects/${encodeURIComponent(projectId)}/workspaces`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'scratch', name: 'scratch' }),
  })
  if (result.ok) {
    st.notice = t('workspace', 'workspace.tree.newWorkspace.done', { name: result.data.name ?? 'scratch' })
    st.noticeError = false
    st.listStatus = 'idle'
    st.workspaces = []
    await loadWorkspaces(body, projectId, st)
  } else {
    st.notice = `${result.error.code ?? 'http_error'}: ${result.error.message ?? ''}`
    st.noticeError = true
    paintWorkspace(body, st, projectId)
  }
}

/* ─────────────────────── painting ─────────────────────── */

/** Preserve editor/search focus across repaints (typing must survive tree
 *  refreshes). */
function withFocusPreserved(body: HTMLElement, paint: () => void): void {
  const active = document.activeElement
  const editor = active instanceof HTMLTextAreaElement && active.dataset.wsEditor === 'true' ? active : null
  const search = active instanceof HTMLInputElement && active.dataset.wsSearch === 'true' ? active : null
  const editorSel = editor !== null ? [editor.selectionStart, editor.selectionEnd] as const : null
  paint()
  if (editor !== null) {
    const ta = body.querySelector('textarea[data-ws-editor="true"]')
    if (ta instanceof HTMLTextAreaElement) {
      ta.focus()
      if (editorSel !== null) ta.setSelectionRange(editorSel[0], editorSel[1])
    }
  } else if (search !== null) {
    const input = body.querySelector('input[data-ws-search="true"]')
    if (input instanceof HTMLInputElement) input.focus()
  }
}

function paintWorkspace(body: HTMLElement, st: WorkspacePanelState, projectId: string): void {
  withFocusPreserved(body, () => {
    body.replaceChildren()
    const panel = el('div')
    if (st.listStatus === 'idle') {
      panel.appendChild(el('div', 'empty', t('workspace', 'workspace.tree.loading')))
      body.appendChild(panel)
      return
    }
    if (st.listStatus === 'error') {
      panel.appendChild(el('div', 'error-banner', t('workspace', 'workspace.tree.error')))
      body.appendChild(panel)
      return
    }
    if (st.workspaces.length === 0) {
      const empty = el('div', 'empty', t('workspace', 'workspace.tree.noWorkspaces'))
      panel.appendChild(empty)
      const create = el('button', 'hbtn', t('workspace', 'workspace.tree.newWorkspace'))
      create.onclick = () => { void ensureWorkspace(body, projectId, st) }
      panel.appendChild(create)
      body.appendChild(panel)
      return
    }
    // ── toolbar ──
    const toolbar = el('div', 'row')
    toolbar.style.cssText = 'gap:6px;flex-wrap:wrap;margin-bottom:8px'
    const picker = el('select', 'picker')
    picker.style.cssText = 'width:auto;margin:0'
    for (const ws of st.workspaces) {
      const opt = el('option', '', t('workspace', 'workspace.tree.workspaceLabel', { kind: workspaceKindText(ws.kind), name: ws.name }))
      opt.value = ws.workspace_id
      picker.append(opt)
    }
    picker.value = st.activeWorkspaceId
    picker.onchange = () => {
      st.activeWorkspaceId = picker.value
      st.tree = initialWorkspaceTreeState(st.activeWorkspaceId)
      st.expanded = new Set()
      st.tabs = []
      st.history = null
      st.historyPath = ''
      void loadTree(body, projectId, st)
    }
    toolbar.appendChild(picker)
    const newFile = el('button', 'hbtn', t('workspace', 'workspace.toolbar.newFile'))
    newFile.onclick = () => { void createFile(body, projectId, st) }
    toolbar.appendChild(newFile)
    const newDir = el('button', 'hbtn', t('workspace', 'workspace.toolbar.newDir'))
    newDir.onclick = () => { createDir(body, projectId, st) }
    toolbar.appendChild(newDir)
    const uploadBtn = el('button', 'hbtn', t('workspace', 'workspace.toolbar.upload'))
    uploadBtn.title = t('workspace', 'workspace.toolbar.upload.title')
    const fileInput = el('input')
    fileInput.type = 'file'
    fileInput.style.display = 'none'
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      fileInput.value = ''
      if (file !== undefined) void uploadFile(body, projectId, st, file)
    })
    uploadBtn.onclick = () => { fileInput.click() }
    toolbar.append(uploadBtn, fileInput)
    const refresh = el('button', 'hbtn', t('workspace', 'workspace.toolbar.refresh'))
    refresh.title = t('workspace', 'workspace.toolbar.refresh.title')
    refresh.onclick = () => { void loadTree(body, projectId, st) }
    toolbar.appendChild(refresh)
    const search = el('input')
    search.type = 'text'
    search.dataset.wsSearch = 'true'
    search.placeholder = t('workspace', 'workspace.search.placeholder')
    search.style.cssText = 'flex:1;min-width:140px'
    search.value = st.searchQuery
    search.oninput = () => {
      st.searchQuery = search.value
      paintWorkspace(body, st, projectId)
    }
    toolbar.appendChild(search)
    panel.appendChild(toolbar)

    if (st.notice !== '') {
      const notice = el('div', st.noticeError ? 'error-banner' : 'muted', st.notice)
      notice.style.cssText = st.noticeError ? '' : 'background:var(--bg-3);border:1px solid var(--border);border-radius:8px;padding:6px 10px;margin-bottom:8px'
      panel.appendChild(notice)
    }

    const searchNote = el('div', 'muted', t('workspace', 'workspace.search.note'))
    searchNote.style.cssText = 'font-size:10px;margin-bottom:6px'
    panel.appendChild(searchNote)

    // ── tree + editor split ──
    const split = el('div', 'row')
    split.style.cssText = 'align-items:stretch;gap:12px;min-height:420px'
    const treeBox = el('div')
    treeBox.style.cssText = 'flex:0 0 300px;min-width:220px;border:1px solid var(--border-2);border-radius:10px;background:var(--bg-3);padding:6px;overflow:auto;max-height:640px'
    paintTree(treeBox, st, projectId, body)
    split.appendChild(treeBox)
    const editorBox = el('div')
    editorBox.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:8px'
    paintEditor(editorBox, st, projectId, body)
    split.appendChild(editorBox)
    panel.appendChild(split)

    const watchRow = el('div', 'row')
    watchRow.style.cssText = 'font-size:10px;padding-top:6px;border-top:1px solid var(--border-2);margin-top:8px;gap:8px'
    const watchNote = el('div', 'muted', t('workspace', 'workspace.watch.note', { seconds: String(Math.round(WORKSPACE_WATCH_POLL_MS / 1000)) }))
    watchNote.style.cssText = 'flex:1'
    watchRow.appendChild(watchNote)
    const statusEl = el('span', 'artifact-kind', watchStatusText === '' ? '' : t('workspace', watchStatusText))
    statusEl.setAttribute('aria-label', t('workspace', 'workspace.watch.aria'))
    watchRow.appendChild(statusEl)
    watchStatusEl = statusEl
    panel.appendChild(watchRow)
    body.appendChild(panel)
  })
}

function paintTree(box: HTMLElement, st: WorkspacePanelState, projectId: string, body: HTMLElement): void {
  box.replaceChildren()
  if (st.tree.status === 'loading') {
    box.appendChild(el('div', 'empty', t('workspace', 'workspace.tree.loading')))
    return
  }
  if (st.tree.status === 'error') {
    box.appendChild(el('div', 'error-banner', t('workspace', 'workspace.tree.error')))
    return
  }
  let rows = flattenWorkspaceTree(st.tree, st.expanded)
  if (st.searchQuery.trim() !== '') {
    const q = st.searchQuery.trim().toLowerCase()
    rows = rows.filter(row => row.path.toLowerCase().includes(q))
    if (rows.length === 0) {
      box.appendChild(el('div', 'empty', t('workspace', 'workspace.search.empty')))
      return
    }
  }
  if (rows.length === 0) {
    box.appendChild(el('div', 'empty', t('workspace', 'workspace.tree.empty')))
    return
  }
  for (const row of rows) {
    const line = el('div', 'row')
    line.style.cssText = `padding:3px 6px;border-radius:6px;cursor:${row.kind === 'dir' ? 'pointer' : 'default'};gap:5px;background:${row.selected ? 'var(--accent-soft)' : 'transparent'}`
    line.style.paddingLeft = `${8 + row.depth * 14}px`
    const kindGlyph = row.kind === 'dir' ? (row.expanded ? '▾' : '▸') : (row.binary ? '▣' : '▤')
    const glyph = el('span', 'mono', kindGlyph)
    glyph.style.cssText = 'width:12px;text-align:center;flex-shrink:0;color:var(--text-3)'
    line.appendChild(glyph)
    const name = el('span', 'grow', row.name)
    name.style.cssText = 'font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
    name.title = row.path
    line.appendChild(name)
    if (row.kind === 'file') {
      const meta = el('span', 'muted', formatWorkspaceBytes(row.size))
      meta.style.cssText = 'font-size:9px;flex-shrink:0'
      line.appendChild(meta)
      const renameBtn = el('button', 'hbtn', '✎')
      renameBtn.title = t('workspace', 'workspace.row.rename.title', { path: row.path })
      renameBtn.setAttribute('aria-label', t('workspace', 'workspace.row.rename.title', { path: row.path }))
      renameBtn.style.cssText = 'padding:0 5px;font-size:10px;flex-shrink:0;visibility:hidden'
      renameBtn.onclick = (event) => {
        event.stopPropagation()
        void moveNode(body, projectId, st, row.path)
      }
      line.appendChild(renameBtn)
      const deleteBtn = el('button', 'hbtn', '🗑')
      deleteBtn.title = t('workspace', 'workspace.row.delete.title', { path: row.path })
      deleteBtn.setAttribute('aria-label', t('workspace', 'workspace.row.delete.title', { path: row.path }))
      deleteBtn.style.cssText = 'padding:0 5px;font-size:10px;flex-shrink:0;visibility:hidden'
      deleteBtn.onclick = (event) => {
        event.stopPropagation()
        void deleteNode(body, projectId, st, row.path)
      }
      line.appendChild(deleteBtn)
      line.onmouseenter = () => { renameBtn.style.visibility = 'visible'; deleteBtn.style.visibility = 'visible' }
      line.onmouseleave = () => { renameBtn.style.visibility = 'hidden'; deleteBtn.style.visibility = 'hidden' }
    }
    if (row.virtual) {
      const tag = el('span', 'muted', '∅')
      tag.title = t('workspace', 'workspace.node.virtual')
      tag.style.cssText = 'font-size:10px;flex-shrink:0'
      line.appendChild(tag)
      const deleteBtn = el('button', 'hbtn', '🗑')
      deleteBtn.title = t('workspace', 'workspace.row.delete.title', { path: row.path })
      deleteBtn.setAttribute('aria-label', t('workspace', 'workspace.row.delete.title', { path: row.path }))
      deleteBtn.style.cssText = 'padding:0 5px;font-size:10px;flex-shrink:0;visibility:hidden'
      deleteBtn.onclick = (event) => {
        event.stopPropagation()
        void deleteNode(body, projectId, st, row.path)
      }
      line.appendChild(deleteBtn)
      line.onmouseenter = () => { deleteBtn.style.visibility = 'visible' }
      line.onmouseleave = () => { deleteBtn.style.visibility = 'hidden' }
    }
    line.onclick = () => {
      if (row.kind === 'dir') {
        st.expanded = toggleWorkspaceDir(st.expanded, row.path)
        st.tree = selectWorkspacePath(st.tree, row.path)
      } else {
        st.tree = selectWorkspacePath(st.tree, row.path)
        void openNodeTab(body, projectId, st, row.path)
      }
      paintWorkspace(body, st, projectId)
    }
    line.setAttribute('aria-label', t('workspace', 'workspace.node.aria', { kind: row.kind, path: row.path, version: String(row.version) }))
    box.appendChild(line)
  }
}

function paintEditor(box: HTMLElement, st: WorkspacePanelState, projectId: string, body: HTMLElement): void {
  box.replaceChildren()
  const tab = activeWorkspaceTab(st.tabs)
  if (tab === undefined) {
    box.appendChild(el('div', 'empty', t('workspace', 'workspace.editor.empty')))
    return
  }
  // ── tab bar ──
  const tabBar = el('div')
  tabBar.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--border-2);padding-bottom:6px'
  for (const openTab of st.tabs) {
    const dirty = workspaceTabDirty(openTab)
    const pill = el('button', 'hbtn')
    pill.style.cssText = `display:inline-flex;align-items:center;gap:5px;padding:3px 8px;${openTab.path === tab.path ? 'border-color:var(--accent);color:var(--accent-text)' : ''}`
    pill.onclick = () => {
      st.tabs = activateWorkspaceTab(st.tabs, openTab.path)
      paintWorkspace(body, st, projectId)
      void loadHistory(body, projectId, st, openTab.path)
    }
    const label = el('span', '', workspaceBasename(openTab.path))
    label.title = openTab.path
    pill.appendChild(label)
    if (dirty || openTab.conflicted) {
      const dot = el('span', '', dirty ? '●' : '⚠')
      dot.title = t('workspace', 'workspace.tab.dirty')
      dot.style.cssText = 'color:var(--tone-amber);font-size:9px'
      pill.appendChild(dot)
    }
    const close = el('span', '', '×')
    close.title = t('workspace', 'workspace.tab.close', { name: workspaceBasename(openTab.path) })
    close.style.cssText = 'color:var(--text-3);cursor:pointer;padding:0 2px'
    close.onclick = (event) => {
      event.stopPropagation()
      st.tabs = closeWorkspaceTab(st.tabs, openTab.path)
      paintWorkspace(body, st, projectId)
    }
    pill.appendChild(close)
    pill.setAttribute('aria-label', t('workspace', 'workspace.tab.aria', {
      name: workspaceBasename(openTab.path),
      state: dirty ? t('workspace', 'workspace.editor.unsaved') : String(openTab.version),
    }))
    tabBar.appendChild(pill)
  }
  box.appendChild(tabBar)

  if (tab.conflicted) {
    const banner = el('div', 'error-banner')
    banner.style.cssText = 'display:flex;align-items:center;gap:10px;justify-content:space-between'
    banner.appendChild(el('span', '', t('workspace', 'workspace.editor.conflictBanner')))
    const reload = el('button', 'hbtn', t('workspace', 'workspace.editor.reload'))
    reload.onclick = () => { void reloadActiveTab(body, projectId, st) }
    banner.appendChild(reload)
    box.appendChild(banner)
  }

  if (tab.binary) {
    // Binary: read-only meta + download (bytes via the blobs route).
    const card = el('div', 'card')
    card.style.cssText = 'display:flex;flex-direction:column;gap:6px'
    card.appendChild(el('div', 'muted', t('workspace', 'workspace.editor.readonly')))
    const rows: Array<[string, string]> = [
      ['path', tab.path],
      ['media', tab.media],
      ['size', formatWorkspaceBytes(tab.size)],
      ['version', t('workspace', 'workspace.binary.version', { version: String(tab.version) })],
      ['blob', t('workspace', 'workspace.binary.blob', { hash: tab.hash })],
    ]
    for (const [key, value] of rows) {
      const line = el('div', 'row')
      line.style.cssText = 'gap:8px'
      const label = el('span', 'mono', key)
      label.style.cssText = 'width:70px;color:var(--text-3);flex-shrink:0'
      const val = el('span', 'mono', value)
      val.style.cssText = 'word-break:break-all'
      line.append(label, val)
      card.appendChild(line)
    }
    const download = el('button', 'btn approve', t('workspace', 'workspace.binary.download'))
    download.style.cssText = 'align-self:flex-start;margin-top:4px'
    download.onclick = () => { void downloadBinary(projectId, st, tab.path) }
    card.appendChild(download)
    box.appendChild(card)
  } else {
    // ── text editor ──
    if (tab.status === 'loading') {
      box.appendChild(el('div', 'empty', t('workspace', 'workspace.editor.loading')))
      return
    }
    if (tab.status === 'error') {
      box.appendChild(el('div', 'error-banner', t('workspace', 'workspace.editor.error')))
      return
    }
    const head = el('div', 'row')
    head.style.cssText = 'justify-content:space-between;gap:10px'
    const title = el('span', 'mono', tab.path)
    title.style.cssText = 'font-size:11px;color:var(--text-2);word-break:break-all'
    head.appendChild(title)
    const dirty = workspaceTabDirty(tab)
    const save = el('button', 'btn primary', t('workspace', 'workspace.editor.save'))
    save.disabled = !dirty
    save.onclick = () => { void saveActiveTab(body, projectId, st) }
    head.appendChild(save)
    box.appendChild(head)
    const statusLine = el('div', 'muted', dirty
      ? t('workspace', 'workspace.editor.unsaved')
      : t('workspace', 'workspace.editor.saved', { version: String(tab.version) }))
    statusLine.style.cssText = 'font-size:10px'
    box.appendChild(statusLine)
    const textarea = el('textarea')
    textarea.dataset.wsEditor = 'true'
    textarea.value = tab.content
    textarea.spellcheck = false
    textarea.style.cssText = 'flex:1;min-height:360px;resize:vertical;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font:12.5px/1.6 ui-monospace,Menlo,monospace;outline:none'
    textarea.oninput = () => {
      st.tabs = updateWorkspaceTabContent(st.tabs, tab.path, textarea.value)
      paintWorkspace(body, st, projectId)
    }
    box.appendChild(textarea)
  }

  // ── history ──
  const historyBox = el('div')
  historyBox.style.cssText = 'border:1px solid var(--border-2);border-radius:10px;padding:8px 10px;margin-top:6px'
  const historyTitle = el('div', 'section-label', t('workspace', 'workspace.history.title'))
  historyBox.appendChild(historyTitle)
  if (st.historyPath !== tab.path || st.history === null) {
    historyBox.appendChild(el('div', 'muted', t('workspace', 'workspace.history.empty')))
  } else if (st.history.length === 0) {
    historyBox.appendChild(el('div', 'muted', t('workspace', 'workspace.history.empty')))
  } else {
    for (const rev of workspaceHistoryView(st.history)) {
      const row = el('div', 'row')
      row.style.cssText = 'gap:8px;padding:3px 0;align-items:flex-start'
      const revLabel = el('span', 'mono', t('workspace', 'workspace.history.revision', { version: String(rev.revision), time: rev.timeText }))
      revLabel.style.cssText = 'width:170px;flex-shrink:0;color:var(--text-2)'
      row.appendChild(revLabel)
      const ops = el('span', 'muted')
      ops.style.cssText = 'flex:1;min-width:0;font-size:10px'
      ops.textContent = rev.ops.map(op => op.fromPath !== null
        ? `${op.opText} ${op.path} ← ${op.fromPath}`
        : `${op.opText} ${op.path}`).join('; ')
      row.appendChild(ops)
      const rollback = el('button', 'hbtn', t('workspace', 'workspace.history.rollback'))
      rollback.style.cssText = 'font-size:10px;flex-shrink:0'
      rollback.onclick = () => { void rollbackTo(body, projectId, st, rev.revision) }
      row.appendChild(rollback)
      historyBox.appendChild(row)
    }
  }
  box.appendChild(historyBox)
}

/** Panel entry (index.ts dispatch): paints the accumulated state, loads the
 *  workspace list once, then the active workspace tree. */
export async function renderWorkspace(body: HTMLElement, projectId: string): Promise<void> {
  const st = ensureState(projectId)
  paintWorkspace(body, st, projectId)
  startWorkspaceWatch(body, projectId, st)
  await loadWorkspaces(body, projectId, st)
}
