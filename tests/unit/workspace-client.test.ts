/**
 * workspace-client (hardening-v0.2-status.md §5 WORK-01 — Workspace tree
 * client 逻辑层): pure logic-layer suite for the Workspace panel (NO DOM),
 * mirroring trajectory-ui / ui-simple. Covers:
 *
 *   workspace-model tree:    flat-list → per-dir levels, lazy expand
 *                            (children render only after expand), virtual
 *                            empty dirs (server projects dirs from path
 *                            prefixes), selection, listSince watch merge
 *                            (upsert / delete + descendants / idempotent);
 *   CAS operations:          create (expected_version=0), save
 *                            (expected_version/etag passthrough), 409
 *                            conflict mapping → reload decision, save
 *                            rebaseline, reload, conflict marking;
 *   move/delete:             source-CAS query/body shapes + destination
 *                            409 handling;
 *   history rollback:        readVersion route, rollback write with CURRENT
 *                            CAS guard, revision/op view model;
 *   multi-tab editor:        open/activate/close, dirty semantics identical
 *                            to manuscript-dirty ('' is a real value),
 *                            server-change detection on watch feeds;
 *   binary:                  multipart /assets upload descriptor (≤ 32 MiB,
 *                            server-side sha256, optional CAS guard) and
 *                            /blobs download (bytes + media type);
 *   search:                  client path substring filter + server
 *                            prefix/glob path and content search calls;
 *   nav/i18n:                workspace is a reachable More tab with a stable
 *                            deep link; every workspace key exists in BOTH
 *                            zh and en — no missing-key reports.
 *
 * Browser visual acceptance (drag-drop upload, narrow viewports,
 * keyboard/a11y) stays NOT_RUN_MANUAL_PENDING (hardening §5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zh as workspaceZh, en as workspaceEn } from '../../packages/dsh-research-ui/src/client/i18n/locales/workspace'
import {
  getLocale, localeParityReport, resetMissingKeyWarnings, setLocale, setMissingKeyReporter, t,
} from '../../packages/dsh-research-ui/src/client/i18n/index'
import { MORE_TAB_KEYS, parseDeepLink } from '../../packages/dsh-research-ui/src/client/nav'
import {
  WORKSPACE_MAX_FILE_BYTES, WORKSPACE_WATCH_POLL_MS,
  WorkspaceWatchClient,
  activateWorkspaceTab, activeWorkspaceTab, addWorkspaceVirtualDir,
  applySavedWorkspaceTab, applyWorkspaceFeedToTabs, applyWorkspaceListSince,
  applyWorkspaceTree, binaryDownload, binaryTooLarge, binaryUploadCall,
  closeWorkspaceTab, createFileCall, deleteNodeCall, filterWorkspacePaths,
  flattenWorkspaceTree, formatWorkspaceBytes, initialWorkspaceTreeState, isWorkspaceConflict,
  markWorkspaceTabConflict, moveNodeCall, openWorkspaceTab,
  placeholderWorkspaceTab, readVersionCall, reloadWorkspaceTab,
  rollbackFileCall, saveFileCall,
  selectWorkspacePath, tabFromTextNode, toggleWorkspaceDir,
  updateWorkspaceTabContent, workspaceBasename, workspaceConflictKind,
  workspaceDirChildren, workspaceDirExists, workspaceDirVirtual,
  workspaceDirtyCount, workspaceHistoryView, workspaceKindText,
  workspaceNodeAt, workspaceOpText, workspaceParentDir, workspaceContentSearchCall, workspaceSearchCall,
  workspaceTabDirty,
} from '../../packages/dsh-research-ui/src/client/workspace-model'
import { MockSseFetch, type SseScheduler } from '../../packages/dsh-research-ui/src/client/sse-client'
import type {
  WorkspaceInfoLite, WorkspaceListSincePayload, WorkspaceNodeLite,
  WorkspaceRevisionLite, WorkspaceTreePayload,
} from '../../packages/dsh-research-ui/src/client/types'

interface Missing { namespace: string; key: string; locale: string }

let missing: Missing[] = []

beforeEach(() => {
  missing = []
  setMissingKeyReporter(r => { missing.push(r) })
})

afterEach(() => {
  setMissingKeyReporter(null)
  resetMissingKeyWarnings()
})

function info(over: Partial<WorkspaceInfoLite> = {}): WorkspaceInfoLite {
  return {
    workspace_id: 'ws_main',
    project_id: 'rsp_demo',
    kind: 'code',
    name: 'main',
    revision: 1,
    created_at: '2026-08-11T00:00:00.000Z',
    updated_at: '2026-08-11T00:00:00.000Z',
    ...over,
  }
}

function node(over: Partial<WorkspaceNodeLite> = {}): WorkspaceNodeLite {
  return {
    path: 'a.txt',
    kind: 'file',
    binary: false,
    media: 'text/plain',
    size: 3,
    version: 1,
    etag: '"1-0123456789ab"',
    hash: 'a'.repeat(64),
    content: null,
    blob_sha256: null,
    created_at: '2026-08-11T00:00:00.000Z',
    updated_at: '2026-08-11T00:00:00.000Z',
    ...over,
  }
}

function tree(nodes: WorkspaceNodeLite[], over: Partial<WorkspaceTreePayload> = {}): WorkspaceTreePayload {
  return { info: info(), nodes, ...over }
}

function revision(over: Partial<WorkspaceRevisionLite> = {}): WorkspaceRevisionLite {
  return {
    workspace_id: 'ws_main',
    revision: 2,
    at: '2026-08-11T00:00:00.000Z',
    ops: [{ seq: 1, op: 'write', path: 'a.txt', from_path: null, version: 2, sha256: 'b'.repeat(64), at: '2026-08-11T00:00:00.000Z' }],
    ...over,
  }
}

/* ─────────────────────── tree model ─────────────────────── */

describe('WORK-01 tree model (lazy expand / virtual dirs / selection)', () => {
  it('never exposes NaN or an unknown unit for malformed wire sizes', () => {
    expect(formatWorkspaceBytes(Number.NaN)).toBe('0 B')
    expect(formatWorkspaceBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
    expect(formatWorkspaceBytes(-1)).toBe('0 B')
    expect(formatWorkspaceBytes(0)).toBe('0 B')
  })
  it('flatten renders only EXPANDED subtrees (lazy expand contract)', () => {
    const st = applyWorkspaceTree(initialWorkspaceTreeState('ws_main'), tree([
      node({ path: 'README.md', size: 7 }),
      node({ path: 'src/main.ts', version: 2, etag: '"2-0123456789ab"', size: 20 }),
      node({ path: 'src/lib/util.ts' }),
      node({ path: 'data.bin', binary: true, media: 'application/octet-stream', size: 100 }),
    ]))
    const root = flattenWorkspaceTree(st, new Set())
    // Only root-level rows: README.md, data.bin, src (dir).
    expect(root.map(r => r.path)).toEqual(['README.md', 'data.bin', 'src'])
    expect(root[2]).toMatchObject({ kind: 'dir', depth: 0, expanded: false, hasChildren: true })
    // Expanding src reveals its children (sorted: lib before main.ts);
    // src/lib is still collapsed.
    const expanded = toggleWorkspaceDir(new Set(), 'src')
    const one = flattenWorkspaceTree(st, expanded)
    expect(one.map(r => r.path)).toEqual(['README.md', 'data.bin', 'src', 'src/lib', 'src/main.ts'])
    expect(one[3]).toMatchObject({ kind: 'dir', depth: 1, expanded: false, hasChildren: true })
    expect(one[4]).toMatchObject({ depth: 1, kind: 'file', version: 2 })
    // Expanding src/lib too renders util.ts at depth 2 (depth-first: the
    // lib subtree renders fully before main.ts).
    const two = flattenWorkspaceTree(st, toggleWorkspaceDir(expanded, 'src/lib'))
    expect(two.map(r => r.path)).toEqual(['README.md', 'data.bin', 'src', 'src/lib', 'src/lib/util.ts', 'src/main.ts'])
    expect(two[4]).toMatchObject({ depth: 2 })
  })

  it('toggleWorkspaceDir is a pure set toggle (collapse removes rows again)', () => {
    const st = applyWorkspaceTree(initialWorkspaceTreeState('ws_main'), tree([node({ path: 'x/y.txt' })]))
    let expanded = toggleWorkspaceDir(new Set(), 'x')
    expect([...expanded]).toEqual(['x'])
    expect(flattenWorkspaceTree(st, expanded).map(r => r.path)).toEqual(['x', 'x/y.txt'])
    expanded = toggleWorkspaceDir(expanded, 'x')
    expect([...expanded]).toEqual([])
    expect(flattenWorkspaceTree(st, expanded).map(r => r.path)).toEqual(['x'])
  })

  it('virtual dirs: client-created empty dirs have no server node until a file lands', () => {
    let st = applyWorkspaceTree(initialWorkspaceTreeState('ws_main'), tree([node({ path: 'a.txt' })]))
    expect(workspaceDirExists(st, 'notes')).toBe(false)
    st = addWorkspaceVirtualDir(st, 'notes')
    expect(workspaceDirExists(st, 'notes')).toBe(true)
    expect(workspaceDirVirtual(st, 'notes')).toBe(true)
    const rows = flattenWorkspaceTree(st, new Set(['notes']))
    expect(rows.map(r => r.path)).toEqual(['a.txt', 'notes'])
    const notes = rows.find(r => r.path === 'notes')
    expect(notes).toMatchObject({ kind: 'dir', virtual: true, hasChildren: false, version: 0 })
    // Idempotent + never duplicates a server-projected dir.
    expect(addWorkspaceVirtualDir(st, 'notes').virtualDirs).toEqual(['notes'])
    // A file lands under it → the next tree projection replaces the virtual
    // dir (server projects 'notes' from the path prefix).
    const projected = applyWorkspaceTree(st, tree([node({ path: 'a.txt' }), node({ path: 'notes/todo.md', kind: 'file' })]))
    expect(projected.virtualDirs).toEqual([])
    expect(workspaceDirVirtual(projected, 'notes')).toBe(false)
    expect(workspaceDirExists(projected, 'notes')).toBe(true)
  })

  it('virtual dirs render under their parent and can be removed', () => {
    let st = applyWorkspaceTree(initialWorkspaceTreeState('ws_main'), tree([node({ path: 'src/a.ts' })]))
    st = addWorkspaceVirtualDir(st, 'src/empty')
    const rows = flattenWorkspaceTree(st, new Set(['src']))
    expect(rows.map(r => r.path)).toEqual(['src', 'src/a.ts', 'src/empty'])
    expect(rows[2]).toMatchObject({ kind: 'dir', virtual: true, depth: 1 })
    // Removing the virtual dir (client-side only — no server node exists).
    st = { ...st, virtualDirs: st.virtualDirs.filter(d => d !== 'src/empty') }
    expect(flattenWorkspaceTree(st, new Set(['src'])).map(r => r.path)).toEqual(['src', 'src/a.ts'])
  })

  it('selection: selectWorkspacePath sets exactly one selected row', () => {
    const st = applyWorkspaceTree(initialWorkspaceTreeState('ws_main'), tree([node({ path: 'a.txt' })]))
    const withSel = selectWorkspacePath(st, 'a.txt')
    expect(flattenWorkspaceTree(withSel, new Set()).find(r => r.path === 'a.txt')?.selected).toBe(true)
    expect(selectWorkspacePath(withSel, '').selectedPath).toBe('')
  })

  it('workspaceNodeAt / workspaceParentDir / workspaceBasename / dir children', () => {
    const st = applyWorkspaceTree(initialWorkspaceTreeState('ws_main'), tree([
      node({ path: 'src/main.ts' }), node({ path: 'src/lib/util.ts' }), node({ path: 'a.txt' }),
    ]))
    expect(workspaceNodeAt(st, 'src/main.ts')?.version).toBe(1)
    expect(workspaceNodeAt(st, 'missing.ts')).toBeNull()
    expect(workspaceNodeAt(st, '')).toBeNull()
    expect(workspaceParentDir('src/lib/util.ts')).toBe('src/lib')
    expect(workspaceParentDir('a.txt')).toBe('')
    expect(workspaceBasename('src/lib/util.ts')).toBe('util.ts')
    expect(workspaceDirChildren(st, 'src').map(n => n.path)).toEqual(['src/lib', 'src/main.ts'])
    expect(workspaceDirChildren(st, '').map(n => n.path)).toEqual(['a.txt', 'src'])
  })

  it('listSince watch merge: upsert, delete + descendants, idempotent, virtual prune', () => {
    const st = applyWorkspaceTree(initialWorkspaceTreeState('ws_main'), tree([
      node({ path: 'a.txt', version: 1 }),
      node({ path: 'src/x.ts', version: 1 }),
      node({ path: 'src/deep/y.ts', version: 1 }),
    ]))
    st.virtualDirs = ['src/empty']
    const feed: WorkspaceListSincePayload = {
      info: info({ revision: 5 }),
      nodes: [
        node({ path: 'a.txt', version: 2, etag: '"2-0123456789ab"', size: 9 }),
        node({ path: 'new.md' }),
        node({ path: 'src/empty/first.txt' }), // file lands under the virtual dir
      ],
      deleted: ['src/deep'],
    }
    const merged = applyWorkspaceListSince(st, feed)
    expect(merged.info?.revision).toBe(5)
    expect(workspaceNodeAt(merged, 'a.txt')?.version).toBe(2)
    expect(workspaceNodeAt(merged, 'new.md')).not.toBeNull()
    // Deleted path + its descendants are gone.
    expect(workspaceNodeAt(merged, 'src/deep/y.ts')).toBeNull()
    expect(workspaceNodeAt(merged, 'src/x.ts')).not.toBeNull()
    // The server now projects src/empty → virtual dir pruned.
    expect(merged.virtualDirs).toEqual([])
    // Idempotent: applying the same feed converges (no dupes).
    const again = applyWorkspaceListSince(merged, feed)
    expect(again.nodes.length).toBe(merged.nodes.length)
    expect(again.nodes.map(n => n.path)).toEqual(merged.nodes.map(n => n.path))
  })
})

/* ─────────────────────── CAS operations ─────────────────────── */

describe('WORK-01 CAS save (409 conflict reload, etag passthrough)', () => {
  it('createFileCall uses expected_version=0 (create-if-absent)', () => {
    const call = createFileCall('rsp_demo', 'ws_main', 'src/new.ts', '')
    expect(call).toEqual({
      method: 'POST',
      path: '/v1/projects/rsp_demo/workspaces/ws_main/nodes',
      body: { path: 'src/new.ts', content: '', expected_version: 0 },
    })
  })

  it('saveFileCall passes the tab version+etag as the CAS guard (no guard on version 0)', () => {
    const tab = tabFromTextNode(node({ path: 'a.txt', version: 3, etag: '"3-abc"', content: null }), 'hello')
    const call = saveFileCall('rsp_demo', 'ws_main', tab, 'hello2')
    expect(call.body).toEqual({ path: 'a.txt', content: 'hello2', expected_version: 3, expected_etag: '"3-abc"' })
    // Version 0 (fresh virtual node) carries NO guard.
    const fresh = { ...tab, version: 0, etag: '' }
    expect(saveFileCall('rsp_demo', 'ws_main', fresh, 'x').body).toEqual({ path: 'a.txt', content: 'x' })
  })

  it('409 conflict mapping: version/etag → reload prompt; destination/missing/binary/quarantine', () => {
    expect(workspaceConflictKind('workspace_version_conflict')).toBe('version')
    expect(workspaceConflictKind('workspace_etag_conflict')).toBe('etag')
    expect(workspaceConflictKind('workspace_move_destination_exists')).toBe('destination')
    expect(workspaceConflictKind('workspace_file_not_found')).toBe('missing')
    expect(workspaceConflictKind('workspace_binary_read_only')).toBe('binary')
    expect(workspaceConflictKind('workspace_inconsistent')).toBe('quarantined')
    expect(workspaceConflictKind('unknown_code')).toBeNull()
    expect(workspaceConflictKind(undefined)).toBeNull()
    expect(isWorkspaceConflict('workspace_version_conflict')).toBe(true)
    expect(isWorkspaceConflict('network_error')).toBe(false)
  })

  it("successful save rebaselines: dirty cleared, revert-to-saved reads clean ('' is real)", () => {
    const tab = tabFromTextNode(node({ path: 'a.txt', version: 1, etag: '"1-a"', content: null }), 'one')
    expect(workspaceTabDirty(tab)).toBe(false)
    const edited = updateWorkspaceTabContent([tab], 'a.txt', '')
    expect(workspaceTabDirty(edited[0]!)).toBe(true) // cleared to '' IS a change
    const saved = applySavedWorkspaceTab(edited, 'a.txt', node({ path: 'a.txt', version: 2, etag: '"2-b"', size: 0 }), '')
    expect(workspaceTabDirty(saved[0]!)).toBe(false)
    expect(saved[0]).toMatchObject({ version: 2, etag: '"2-b"', size: 0, savedContent: '' })
    // Revert the editor back to the saved content → clean again.
    const reverted = updateWorkspaceTabContent(saved, 'a.txt', '')
    expect(workspaceTabDirty(reverted[0]!)).toBe(false)
  })

  it('409 on save: markWorkspaceTabConflict keeps the editor content, reload rebaselines', () => {
    const tab = tabFromTextNode(node({ path: 'a.txt', version: 1, etag: '"1-a"', content: null }), 'mine')
    const edited = updateWorkspaceTabContent([tab], 'a.txt', 'mine edited')
    const conflicted = markWorkspaceTabConflict(edited, 'a.txt')
    expect(conflicted[0]).toMatchObject({ conflicted: true, content: 'mine edited' })
    expect(workspaceTabDirty(conflicted[0]!)).toBe(true)
    // Reload: server bytes win, baseline + content reset, conflict cleared.
    const server = node({ path: 'a.txt', version: 4, etag: '"4-z"', content: null })
    const reloaded = reloadWorkspaceTab(conflicted, 'a.txt', server, 'server latest')
    expect(reloaded[0]).toMatchObject({ conflicted: false, content: 'server latest', savedContent: 'server latest', version: 4, etag: '"4-z"', status: 'ready' })
    expect(workspaceTabDirty(reloaded[0]!)).toBe(false)
  })
})

/* ─────────────────────── move / delete ─────────────────────── */

describe('WORK-01 move/delete model (source CAS, 409 handling)', () => {
  it('deleteNodeCall carries path + source CAS as query params', () => {
    const call = deleteNodeCall('rsp_demo', 'ws_main', node({ path: 'src/a.ts', version: 2, etag: '"2-x"' }))
    expect(call.method).toBe('DELETE')
    expect(call.path).toContain('/v1/projects/rsp_demo/workspaces/ws_main/nodes?')
    const params = new URLSearchParams(call.path.split('?')[1] ?? '')
    expect(params.get('path')).toBe('src/a.ts')
    expect(params.get('expected_version')).toBe('2')
    expect(params.get('expected_etag')).toBe('"2-x"')
    // No CAS on a fresh node (version 0).
    const fresh = deleteNodeCall('rsp_demo', 'ws_main', node({ path: 'b.ts', version: 0, etag: '' }))
    expect(fresh.path).not.toContain('expected_version')
  })

  it('moveNodeCall: from/to + source CAS; destination conflict surfaces via kind', () => {
    const call = moveNodeCall('rsp_demo', 'ws_main', 'src/a.ts', 'src/b.ts', node({ path: 'src/a.ts', version: 2, etag: '"2-x"' }))
    expect(call).toMatchObject({
      method: 'POST',
      path: '/v1/projects/rsp_demo/workspaces/ws_main/moves',
      body: { from_path: 'src/a.ts', to_path: 'src/b.ts', expected_version: 2, expected_etag: '"2-x"' },
    })
    // No source node (virtual) → rename without a guard.
    const unguarded = moveNodeCall('rsp_demo', 'ws_main', 'x', 'y', null)
    expect(unguarded.body).toEqual({ from_path: 'x', to_path: 'y' })
    expect(workspaceConflictKind('workspace_move_destination_exists')).toBe('destination')
  })
})

/* ─────────────────────── history rollback ─────────────────────── */

describe('WORK-01 history rollback (readVersion + CAS write-back)', () => {
  it('readVersionCall targets the nodes route with path+version', () => {
    const call = readVersionCall('rsp_demo', 'ws_main', 'a.txt', 3)
    expect(call.method).toBe('GET')
    expect(call.path).toBe('/v1/projects/rsp_demo/workspaces/ws_main/nodes?path=a.txt&version=3')
  })

  it('rollbackFileCall writes the old bytes guarded by the CURRENT version/etag', () => {
    const current = node({ path: 'a.txt', version: 4, etag: '"4-cur"' })
    const call = rollbackFileCall('rsp_demo', 'ws_main', current, 'old bytes')
    expect(call.body).toEqual({ path: 'a.txt', content: 'old bytes', expected_version: 4, expected_etag: '"4-cur"' })
  })

  it('history view: op labels in zh/en, unknown ops stay verbatim, newest first', () => {
    const revs = [
      revision({ revision: 3, ops: [
        { seq: 1, op: 'move', path: 'b.txt', from_path: 'a.txt', version: 3, sha256: null, at: '2026-08-11T00:00:00.000Z' },
      ] }),
      revision({ revision: 2, ops: [
        { seq: 1, op: 'write', path: 'a.txt', from_path: null, version: 2, sha256: null, at: '2026-08-11T00:00:00.000Z' },
        { seq: 2, op: 'future_op', path: 'a.txt', from_path: null, version: 2, sha256: null, at: '2026-08-11T00:00:00.000Z' },
      ] }),
    ]
    setLocale('zh')
    const zh = workspaceHistoryView(revs, getLocale())
    expect(zh.map(v => v.revision)).toEqual([3, 2])
    expect(zh[0]!.ops[0]!.opText).toBe('移动')
    expect(zh[1]!.ops[0]!.opText).toBe('写入')
    expect(zh[1]!.ops[1]!.opText).toBe('future_op') // raw wire verbatim
    expect(zh[1]!.ops[1]!.fromPath).toBeNull()
    expect(workspaceOpText('delete', getLocale())).toBe('删除')
    expect(workspaceOpText('create', getLocale())).toBe('创建')
    setLocale('en')
    const en = workspaceHistoryView(revs, getLocale())
    expect(en[0]!.ops[0]!.opText).toBe('move')
    expect(en[1]!.ops[0]!.opText).toBe('write')
    expect(workspaceOpText('create', getLocale())).toBe('create')
    expect(workspaceOpText('', getLocale())).toBe('')
  })
})

/* ─────────────────────── multi-tab editor ─────────────────────── */

describe('WORK-01 multi-tab editor (dirty/conflict/close)', () => {
  it('open/activate/close: tabs[0] is active; reopen moves to front', () => {
    const a = tabFromTextNode(node({ path: 'a.txt', content: null }), '')
    const b = tabFromTextNode(node({ path: 'b.txt', content: null }), '')
    let tabs = openWorkspaceTab([], a)
    tabs = openWorkspaceTab(tabs, b)
    expect(tabs.map(x => x.path)).toEqual(['b.txt', 'a.txt'])
    expect(activeWorkspaceTab(tabs)?.path).toBe('b.txt')
    // Reopen a.txt → activated (moved to front), no duplicate, content kept.
    tabs = openWorkspaceTab(tabs, a)
    expect(tabs.map(x => x.path)).toEqual(['a.txt', 'b.txt'])
    expect(tabs).toHaveLength(2)
    tabs = activateWorkspaceTab(tabs, 'b.txt')
    expect(activeWorkspaceTab(tabs)?.path).toBe('b.txt')
    tabs = closeWorkspaceTab(tabs, 'b.txt')
    expect(tabs.map(x => x.path)).toEqual(['a.txt'])
    expect(closeWorkspaceTab(tabs, 'nope.txt').map(x => x.path)).toEqual(['a.txt'])
  })

  it('placeholderWorkspaceTab: tree-meta tab in loading state (fetched content comes next)', () => {
    const tab = placeholderWorkspaceTab(node({ path: 'src/a.ts', version: 3, etag: '"3-e"', media: 'text/typescript' }))
    expect(tab).toMatchObject({ path: 'src/a.ts', version: 3, etag: '"3-e"', media: 'text/typescript', status: 'loading', savedContent: '' })
    expect(workspaceTabDirty(tab)).toBe(false)
  })

  it('dirty count and edit-clear-conflict semantics', () => {
    const a = tabFromTextNode(node({ path: 'a.txt', content: null }), 'one')
    const b = tabFromTextNode(node({ path: 'b.txt', content: null }), 'two')
    let tabs = [a, b]
    expect(workspaceDirtyCount(tabs)).toBe(0)
    tabs = updateWorkspaceTabContent(tabs, 'a.txt', 'one changed')
    expect(workspaceDirtyCount(tabs)).toBe(1)
    // Editing clears the conflicted flag (user keeps typing).
    tabs = markWorkspaceTabConflict(tabs, 'a.txt')
    expect(tabs[0]!.conflicted).toBe(true)
    tabs = updateWorkspaceTabContent(tabs, 'a.txt', 'one changed again')
    expect(tabs[0]!.conflicted).toBe(false)
  })

  it('watch feed server-change: same version/etag → untouched; newer → conflicted', () => {
    const a = tabFromTextNode(node({ path: 'a.txt', version: 2, etag: '"2-a"', content: null }), 'x')
    const b = tabFromTextNode(node({ path: 'b.txt', version: 1, etag: '"1-b"', content: null }), 'y')
    let tabs = [a, b]
    // Same version/etag in the feed → no conflict.
    tabs = applyWorkspaceFeedToTabs(tabs, [node({ path: 'a.txt', version: 2, etag: '"2-a"' })])
    expect(tabs[0]!.conflicted).toBe(false)
    // Server moved forward → the tab is stale (content preserved).
    tabs = applyWorkspaceFeedToTabs(tabs, [node({ path: 'a.txt', version: 3, etag: '"3-a"' })])
    expect(tabs[0]!.conflicted).toBe(true)
    expect(tabs[0]!.content).toBe('x')
    // Directory nodes and unrelated paths never touch tabs.
    tabs = applyWorkspaceFeedToTabs(tabs, [node({ path: 'src', kind: 'dir', version: 0, etag: '' }), node({ path: 'other.txt', version: 9 })])
    expect(tabs[0]!.conflicted).toBe(true)
    expect(tabs[1]!.conflicted).toBe(false)
  })
})

/* ─────────────────────── binary upload/download ─────────────────────── */

describe('WORK-01 binary upload/download model (multipart ≤ 32 MiB)', () => {
  it('binaryUploadCall: multipart /assets route, file part name, server-side sha256 (client never declares a hash)', () => {
    const call = binaryUploadCall('rsp_demo', 'ws_main', 'img/plot.png', 'image/png')
    expect(call).toMatchObject({
      method: 'POST',
      path: '/v1/projects/rsp_demo/workspaces/ws_main/assets',
      fileField: 'file',
      maxBytes: WORKSPACE_MAX_FILE_BYTES,
      fields: { path: 'img/plot.png', media: 'image/png' },
    })
    expect(call.fields).not.toHaveProperty('expected_version')
    // CAS guard when replacing an existing node.
    const guarded = binaryUploadCall('rsp_demo', 'ws_main', 'img/plot.png', 'image/png', { expected_version: 2, expected_etag: '"2-x"' })
    expect(guarded.fields).toEqual({ path: 'img/plot.png', media: 'image/png', expected_version: 2, expected_etag: '"2-x"' })
    // Empty media defaults to octet-stream.
    expect(binaryUploadCall('rsp_demo', 'ws_main', 'x.bin', '').fields.media).toBe('application/octet-stream')
  })

  it('binaryTooLarge: 32 MiB cap boundary (server-enforced, client pre-flags)', () => {
    expect(binaryTooLarge(WORKSPACE_MAX_FILE_BYTES)).toBe(false)
    expect(binaryTooLarge(WORKSPACE_MAX_FILE_BYTES + 1)).toBe(true)
    expect(binaryTooLarge(0)).toBe(false)
  })

  it('binaryDownload: raw bytes via /blobs with the node media type + strong etag', () => {
    const dl = binaryDownload('rsp_demo', 'ws_main', node({ path: 'img/plot.png', media: 'image/png', etag: '"3-e"' }))
    expect(dl.method).toBe('GET')
    expect(dl.url).toBe('/v1/projects/rsp_demo/workspaces/ws_main/blobs?path=img%2Fplot.png')
    expect(dl.media).toBe('image/png')
    expect(dl.etag).toBe('"3-e"')
    expect(binaryDownload('rsp_demo', 'ws_main', node({ path: 'x', media: '', etag: '' })).media).toBe('application/octet-stream')
  })

  it('binary node read model: tabFromTextNode marks binary=false for text; binary tabs stay read-only', () => {
    const text = tabFromTextNode(node({ path: 'a.txt', media: 'text/plain', content: null }), 'hello')
    expect(text).toMatchObject({ binary: false, savedContent: 'hello', status: 'ready', media: 'text/plain' })
    const bin = node({ path: 'img.bin', binary: true, media: 'application/octet-stream', size: 99, version: 2, etag: '"2-b"', content: null, blob_sha256: 'c'.repeat(64) })
    // Binary nodes never carry content on the wire.
    expect(bin.content).toBeNull()
    expect(workspaceConflictKind('workspace_binary_read_only')).toBe('binary')
  })
})

/* ─────────────────────── search ─────────────────────── */

describe('WORK-01 search: path and content search', () => {
  it('filterWorkspacePaths: case-insensitive substring on the full path', () => {
    const nodes = [node({ path: 'src/Main.ts' }), node({ path: 'src/lib/util.ts' }), node({ path: 'README.md' })]
    expect(filterWorkspacePaths(nodes, '').map(n => n.path)).toEqual(nodes.map(n => n.path))
    expect(filterWorkspacePaths(nodes, 'main').map(n => n.path)).toEqual(['src/Main.ts'])
    expect(filterWorkspacePaths(nodes, 'lib').map(n => n.path)).toEqual(['src/lib/util.ts'])
    expect(filterWorkspacePaths(nodes, '  ').map(n => n.path)).toEqual(nodes.map(n => n.path))
    expect(filterWorkspacePaths(nodes, 'zzz')).toEqual([])
  })

  it('workspaceSearchCall: prefix/glob server PATH search (project-scoped route), null on blank', () => {
    expect(workspaceSearchCall('rsp_demo', 'ws_main', '  ')).toBeNull()
    const prefix = workspaceSearchCall('rsp_demo', 'ws_main', 'src')
    expect(prefix).toEqual({ method: 'POST', path: '/v1/projects/rsp_demo/workspaces/ws_main/search', body: { prefix: 'src' } })
    const glob = workspaceSearchCall('rsp_demo', 'ws_main', 'src/*.ts')
    expect(glob?.body).toEqual({ prefix: 'src', glob: 'src/*.ts' })
    const pureGlob = workspaceSearchCall('rsp_demo', 'ws_main', '*.md')
    expect(pureGlob?.body).toEqual({ glob: '*.md' })
  })

  it('workspaceContentSearchCall: project-scoped content search, trimmed query and optional case sensitivity', () => {
    expect(workspaceContentSearchCall('rsp_demo', 'ws_main', '  ')).toBeNull()
    expect(workspaceContentSearchCall('rsp_demo', 'ws_main', '  training loop  ')).toEqual({
      method: 'POST',
      path: '/v1/projects/rsp_demo/workspaces/ws_main/search',
      body: { mode: 'content', q: 'training loop' },
    })
    expect(workspaceContentSearchCall('rsp/a', 'ws main', 'Loss', true)).toEqual({
      method: 'POST',
      path: '/v1/projects/rsp%2Fa/workspaces/ws%20main/search',
      body: { mode: 'content', q: 'Loss', case_sensitive: true },
    })
  })

  it('watch polling cadence is a documented constant (SSE is a later round)', () => {
    expect(WORKSPACE_WATCH_POLL_MS).toBeGreaterThan(0)
    expect(WORKSPACE_WATCH_POLL_MS).toBe(5000)
  })
})

/* ─────────────────────── nav / i18n ─────────────────────── */

describe('WORK-01 nav + i18n (More tab, deep link, zh/en parity, zero missing keys)', () => {
  it('workspace is a reachable More tab with a stable deep link', () => {
    expect(MORE_TAB_KEYS).toContain('workspace')
    expect(parseDeepLink('#tab=workspace')).toEqual({ kind: 'tab', target: 'workspace' })
  })

  it('every workspace key exists in BOTH zh and en — no missing-key reports', () => {
    expect(localeParityReport()).toEqual([])
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      for (const key of Object.keys(workspaceZh)) {
        const text = t('workspace', key)
        expect(text).not.toBe(key) // resolved, never the raw key
        expect(text).not.toBe('')
      }
      expect(missing).toEqual([])
    }
  })

  it('kind/op copy resolves in both locales; unknown enums stay verbatim', () => {
    setLocale('zh')
    expect(workspaceKindText('code', getLocale())).toBe('代码')
    expect(workspaceKindText('manuscript', getLocale())).toBe('手稿')
    expect(workspaceKindText('scratch', getLocale())).toBe('草稿')
    expect(workspaceKindText('fleet', getLocale())).toBe('fleet')
    setLocale('en')
    expect(workspaceKindText('code', getLocale())).toBe('Code')
    expect(workspaceOpText('move', getLocale())).toBe('move')
    expect(workspaceOpText('delete', getLocale())).toBe('delete')
    expect(missing).toEqual([])
  })

  it('zh/en dictionaries cover the same key set exactly (no zh-only / en-only)', () => {
    const zhKeys = Object.keys(workspaceZh).sort()
    const enKeys = Object.keys(workspaceEn).sort()
    expect(enKeys).toEqual(zhKeys)
  })
})

/* ─────────────────── SSE watch stream (client/sse-client.ts) ─────────────────── */

/** Deterministic manual timer queue (mirrors the pty suite's fake). */
class FakeScheduler implements SseScheduler {
  timers: Array<{ id: number; fn: () => void }> = []
  private nextId = 1
  setTimeout(fn: () => void, _ms?: number): unknown {
    const id = this.nextId
    this.nextId += 1
    this.timers.push({ id, fn })
    return id
  }
  clearTimeout(timer: unknown): void {
    this.timers = this.timers.filter(t => t.id !== timer)
  }
  get pending(): number {
    return this.timers.length
  }
  runOnce(): void {
    const batch = [...this.timers]
    this.timers = this.timers.filter(t => !batch.includes(t))
    for (const t of batch) t.fn()
  }
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

function watchUrl(workspaceId: string, revision: number): string {
  return `/v1/projects/rsp_demo/workspaces/${encodeURIComponent(workspaceId)}/watch/stream?after_revision=${revision}`
}

describe('WORK-01 SSE watch stream (watch/stream — client/sse-client.ts)', () => {
  it('stream change events merge IDENTICALLY to the listSince poll path (upsert + tombstone + implied dirs)', async () => {
    const scheduler = new FakeScheduler()
    const fetchMock = new MockSseFetch()
    const feeds: WorkspaceListSincePayload[] = []
    const client = new WorkspaceWatchClient({
      projectId: 'rsp_demo',
      target: () => ({ workspaceId: 'ws_main', revision: 1 }),
      fetchImpl: fetchMock.fetchImpl.bind(fetchMock),
      scheduler,
      onFeed: (p) => { feeds.push(p) },
    })
    const stream = fetchMock.enqueueStream(watchUrl('ws_main', 1))
    client.start()
    await flush()
    expect(client.status).toBe('live')
    // the REAL wire: one `change` event per node + one `delete` tombstone
    // per path (each carrying the revision advance) + heartbeats
    stream.push(sse('change', { workspace_id: 'ws_main', revision: 2, node: node({ path: 'a.txt', version: 2, etag: '"2-xyz"', size: 5 }) }))
    stream.push(sse('delete', { workspace_id: 'ws_main', revision: 2, path: 'old.txt' }))
    stream.push(sse('change', { workspace_id: 'ws_main', revision: 3, node: node({ path: 'src/main.ts', version: 1 }) }))
    stream.push(sse('delete', { workspace_id: 'ws_main', revision: 3, path: 'src/lib' }))
    stream.push(sse('heartbeat', { time: 'x' }))
    await flush()
    expect(feeds).toHaveLength(4)
    expect(feeds[0]!.nodes.map(n => n.path)).toEqual(['a.txt'])
    expect(feeds[0]!.deleted).toEqual([])
    expect(feeds[1]!.deleted).toEqual(['old.txt'])
    expect(feeds[3]!.deleted).toEqual(['src/lib'])

    // The SAME payloads through the poll endpoint converge to the SAME tree.
    const streamTree = feeds.reduce(
      (acc, feed) => applyWorkspaceListSince(acc, feed),
      applyWorkspaceTree(initialWorkspaceTreeState('ws_main'), tree([
        node({ path: 'a.txt', version: 1 }),
        node({ path: 'old.txt' }),
        node({ path: 'src/lib/util.ts' }),
        node({ path: 'src/main.ts' }),
      ])),
    )
    const pollTree = applyWorkspaceListSince(
      applyWorkspaceListSince(
        applyWorkspaceTree(initialWorkspaceTreeState('ws_main'), tree([
          node({ path: 'a.txt', version: 1 }),
          node({ path: 'old.txt' }),
          node({ path: 'src/lib/util.ts' }),
          node({ path: 'src/main.ts' }),
        ])),
        { info: info({ revision: 2 }), nodes: [node({ path: 'a.txt', version: 2, etag: '"2-xyz"', size: 5 })], deleted: ['old.txt'] },
      ),
      { info: info({ revision: 3 }), nodes: [node({ path: 'src/main.ts', version: 1 })], deleted: ['src/lib'] },
    )
    const paths = (s: ReturnType<typeof initialWorkspaceTreeState>): Array<[string, string, number]> =>
      s.nodes.map(n => [n.path, n.kind, n.version] as [string, string, number])
    expect(paths(streamTree)).toEqual(paths(pollTree))
    expect(streamTree.nodes.map(n => n.path)).toEqual(['a.txt', 'src', 'src/main.ts'])
    // the per-event revision advances merged into the tree info
    expect(streamTree.info!.revision).toBe(3)
    client.stop()
  })

  it('bare node arrays and revision-only events are handled defensively', async () => {
    const scheduler = new FakeScheduler()
    const fetchMock = new MockSseFetch()
    const feeds: WorkspaceListSincePayload[] = []
    const client = new WorkspaceWatchClient({
      projectId: 'rsp_demo',
      target: () => ({ workspaceId: 'ws_main', revision: 1 }),
      fetchImpl: fetchMock.fetchImpl.bind(fetchMock),
      scheduler,
      onFeed: (p) => { feeds.push(p) },
    })
    const stream = fetchMock.enqueueStream(watchUrl('ws_main', 1))
    client.start()
    await flush()
    // a bare node array (no event wrapper) still feeds
    stream.push(`data: ${JSON.stringify([node({ path: 'bare.txt' })])}\n\n`)
    // revision-only advances are cursor heartbeats — no feed, no error
    stream.push(sse('revision', { revision: 7 }))
    await flush()
    expect(feeds).toHaveLength(1)
    expect(feeds[0]!.nodes.map(n => n.path)).toEqual(['bare.txt'])
    client.stop()
  })

  it('stream give-up falls back to listSince POLLING with the current revision', async () => {
    const scheduler = new FakeScheduler()
    const fetchMock = new MockSseFetch()
    let revision = 1
    const polled: number[] = []
    const feeds: WorkspaceListSincePayload[] = []
    const client = new WorkspaceWatchClient({
      projectId: 'rsp_demo',
      target: () => ({ workspaceId: 'ws_main', revision }),
      fetchImpl: fetchMock.fetchImpl.bind(fetchMock),
      scheduler,
      maxReconnectAttempts: 1,
      pollListSince: async (afterRevision) => {
        polled.push(afterRevision)
        return { info: info({ revision: afterRevision }), nodes: [node({ path: 'poll.txt', version: 1 })], deleted: [] }
      },
      onFeed: (p) => { feeds.push(p) },
    })
    // the first connect fails → the budget (1) is exhausted → POLL fallback
    fetchMock.enqueueError(watchUrl('ws_main', 1), 500)
    client.start()
    await flush()
    expect(client.status).toBe('polling')
    // poll tick: fetches listSince at the CURRENT revision and feeds
    scheduler.runOnce()
    await flush()
    expect(polled).toEqual([1])
    expect(feeds).toHaveLength(1)
    expect(feeds[0]!.nodes[0]!.path).toBe('poll.txt')
    // revision advanced by the feed → next tick polls from it
    revision = 2
    scheduler.runOnce()
    await flush()
    expect(polled).toEqual([1, 2])
    client.stop()
  })

  it('watcher waits for a watch target (workspace not loaded) and retries on the poll cadence', async () => {
    const scheduler = new FakeScheduler()
    const fetchMock = new MockSseFetch()
    let target: { workspaceId: string; revision: number } | null = null
    const client = new WorkspaceWatchClient({
      projectId: 'rsp_demo',
      target: () => target,
      fetchImpl: fetchMock.fetchImpl.bind(fetchMock),
      scheduler,
      pollIntervalMs: 100,
      onFeed: () => {},
    })
    client.start()
    expect(client.status).toBe('idle')
    expect(fetchMock.calls).toHaveLength(0)
    const stream = fetchMock.enqueueStream(watchUrl('ws_main', 5))
    target = { workspaceId: 'ws_main', revision: 5 }
    scheduler.runOnce() // the retry timer fires → target exists → connect
    await flush()
    expect(client.status).toBe('live')
    expect(fetchMock.calls.at(-1)!.url).toBe(watchUrl('ws_main', 5))
    client.stop()
    void stream
  })

  it('stop() aborts the stream and the poll fallback (tab-leave hygiene)', async () => {
    const scheduler = new FakeScheduler()
    const fetchMock = new MockSseFetch()
    const client = new WorkspaceWatchClient({
      projectId: 'rsp_demo',
      target: () => ({ workspaceId: 'ws_main', revision: 1 }),
      fetchImpl: fetchMock.fetchImpl.bind(fetchMock),
      scheduler,
      maxReconnectAttempts: 0,
      onFeed: () => {},
    })
    const stream = fetchMock.enqueueStream(watchUrl('ws_main', 1))
    client.start()
    await flush()
    expect(client.status).toBe('live')
    client.stop()
    expect(client.status).toBe('stopped')
    expect(scheduler.pending).toBe(0)
    expect(fetchMock.calls[0]!.signal?.aborted).toBe(true)
    stream.push(sse('changes', { nodes: [node({ path: 'late.txt' })], deleted: [] }))
    await flush()
    expect(scheduler.pending).toBe(0) // no reconnect scheduled
    client.start() // restart allowed after stop
    await flush()
    expect(client.status).toBe('live')
    client.stop()
  })

  it('watch status keys resolve in BOTH locales (no missing-key reports)', () => {
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      missing = []
      for (const key of ['connecting', 'live', 'reconnecting', 'disconnected', 'polling'] as const) {
        const text = t('workspace', `workspace.watch.${key}`)
        expect(text).not.toBe('')
        expect(text).not.toBe(`workspace.watch.${key}`)
      }
      expect(missing).toEqual([])
    }
  })
})
