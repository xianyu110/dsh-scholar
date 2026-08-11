/**
 * WORK-01 adapter tests (api-contracts.md §17, acceptance-tests.md §7):
 * generic VS Code-style workspace on the REAL disk adapter — bytes on disk
 * under `dataDir/workspaces/{project_id}/{workspace_id}` (0750 chain, atomic
 * temp+rename writes, no tmp leftovers), metadata in `workspace_nodes`;
 * revision/etag/hash semantics, CAS conflicts (409), create-if-absent,
 * binary round-trip (disk + artifact CAS reference), path safety
 * (execution-runtime.md §4 snapshot-walk contract incl. symlink rejection),
 * move/delete CAS, history (readVersion rollback + retention), watch
 * (listSince) and path search (prefix/glob), and the TeX facade mapping
 * (tex-workspace is the facade reference — the facade maps it onto this
 * interface without a second byte authority).
 *
 * The browser editor UI is NOT part of this round (Playwright-class
 * environment unavailable — recorded as remaining).
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ResearchKernel } from '@dsh-scholar/research-kernel'
import { workspaceEtag, WorkspaceNode, WorkspaceWriteRequest, WorkspaceMoveRequest } from '@dsh-scholar/research-schemas'
import {
  WorkspaceError, normalizeWorkspacePath, HISTORY_KEEP_VERSIONS, WORKSPACE_MAX_FILE_BYTES, matchWorkspaceGlob,
} from '../../packages/research-kernel/lib/workspace-store.js'

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Recursively collect every path under `dir` (relative). */
function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      out.push(full)
      if (statSync(full).isDirectory()) walk(full)
    }
  }
  try {
    walk(dir)
  } catch {
    return out
  }
  return out
}

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief() {
  return { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' }
}

describe('generic workspace store (WORK-01 disk adapter)', () => {
  it('write creates nodes with version/etag/hash and bumps the workspace revision', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    expect(ws.revision).toBe(1)
    const node = kernel.workspaceWrite(ws.workspace_id, 'src/main.ts', 'export const x = 1\n')
    expect(node.version).toBe(1)
    expect(node.binary).toBe(false)
    expect(node.hash).toBe(sha256Hex('export const x = 1\n'))
    expect(node.etag).toBe(workspaceEtag(1, node.hash))
    expect(kernel.workspaceGet(ws.workspace_id).revision).toBe(2)
    // Write again (unchecked) → version 2, new etag, workspace revision 3.
    const node2 = kernel.workspaceWrite(ws.workspace_id, 'src/main.ts', 'export const x = 2\n')
    expect(node2.version).toBe(2)
    expect(node2.etag).toBe(workspaceEtag(2, node2.hash))
    expect(kernel.workspaceGet(ws.workspace_id).revision).toBe(3)
    // Read returns the content and matches the hash.
    const read = kernel.workspaceRead(ws.workspace_id, 'src/main.ts')
    expect(read?.content).toBe('export const x = 2\n')
    expect(WorkspaceNode.parse(read!)).toMatchObject({ path: 'src/main.ts', kind: 'file' })
    kernel.close()
  })

  it('disk adapter: per-project roots, 0750 chain, files on disk, atomic writes leave no tmp files', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    const root = kernel.workspaces.workspaceRoot(ws.workspace_id)
    // dataDir/workspaces/{project_id}/{workspace_id} with a 0750 chain.
    expect(root).toContain(`${project.project_id}${'/'.repeat(1)}${ws.workspace_id}`)
    expect(root).toContain('/workspaces/')
    expect(statSync(root).mode & 0o777).toBe(0o750)
    kernel.workspaceWrite(ws.workspace_id, 'src/main.ts', 'export const x = 1\n')
    kernel.workspaceWrite(ws.workspace_id, 'notes.md', '# hello')
    // The bytes are REAL files at the normalized path inside the root.
    expect(readFileSync(join(root, 'src/main.ts'), 'utf8')).toBe('export const x = 1\n')
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('# hello')
    expect(statSync(join(root, 'src')).mode & 0o777).toBe(0o750)
    // No temp/partial files survive any write (atomic temp+rename).
    for (const f of listFiles(root)) expect(f).not.toMatch(/\.ws-tmp-/)
    kernel.close()
  })

  it('CAS conflicts: stale version / etag / create-if-absent are 409, no silent overwrite', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    const v1 = kernel.workspaceWrite(ws.workspace_id, 'a.txt', 'one')
    expect(v1.version).toBe(1)
    // Correct CAS succeeds (v1 → v2).
    const v2 = kernel.workspaceWrite(ws.workspace_id, 'a.txt', 'two', { version: 1, etag: v1.etag })
    expect(v2.version).toBe(2)
    // Stale version → 409.
    try {
      kernel.workspaceWrite(ws.workspace_id, 'a.txt', 'three', { version: 1 })
      throw new Error('expected conflict')
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError)
      expect((error as WorkspaceError).code).toBe('workspace_version_conflict')
    }
    // Stale etag → 409.
    try {
      kernel.workspaceWrite(ws.workspace_id, 'a.txt', 'three', { etag: v1.etag })
      throw new Error('expected conflict')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_etag_conflict')
    }
    // expected_version=0 on an existing file → 409 (create-if-absent).
    try {
      kernel.workspaceWrite(ws.workspace_id, 'a.txt', 'four', { version: 0 })
      throw new Error('expected conflict')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_version_conflict')
    }
    // expected N>0 on a missing file → 409.
    try {
      kernel.workspaceWrite(ws.workspace_id, 'missing.txt', 'x', { version: 3 })
      throw new Error('expected conflict')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_version_conflict')
    }
    // expected_version=0 on a missing file → create at version 1.
    const created = kernel.workspaceWrite(ws.workspace_id, 'new.txt', 'fresh', { version: 0 })
    expect(created.version).toBe(1)
    // No expectation on a missing file also creates (UI create flow).
    expect(kernel.workspaceWrite(ws.workspace_id, 'auto.txt', 'auto').version).toBe(1)
    kernel.close()
  })

  it('binary: bytes on the tree disk + artifact CAS reference, round-trip, idempotent puts, read-only text writes', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe])
    const node = kernel.workspaceWriteBinary(ws.workspace_id, 'img/plot.png', bytes, 'image/png')
    expect(node.binary).toBe(true)
    expect(node.blob_sha256).toBe(sha256Hex(bytes))
    expect(node.hash).toBe(sha256Hex(bytes))
    expect(node.content).toBeNull()
    expect(node.media).toBe('image/png')
    expect(node.size).toBe(bytes.length)
    // The WORKING bytes are a real file on the workspace tree.
    const root = kernel.workspaces.workspaceRoot(ws.workspace_id)
    expect(Buffer.from(readFileSync(join(root, 'img/plot.png'))).equals(bytes)).toBe(true)
    // The blob reference stays a real artifact CAS link (idempotent put).
    expect(kernel.cas.has(node.blob_sha256 as string)).toBe(true)
    const blob = kernel.workspaceBlob(ws.workspace_id, 'img/plot.png')
    expect(blob).not.toBeNull()
    expect(Buffer.from(blob as Buffer).equals(bytes)).toBe(true)
    // Text read of a binary node returns metadata, never garbage content.
    const read = kernel.workspaceRead(ws.workspace_id, 'img/plot.png')
    expect(read?.content).toBeNull()
    // Text write to a binary node → 422 read-only.
    try {
      kernel.workspaceWrite(ws.workspace_id, 'img/plot.png', 'nope')
      throw new Error('expected read-only')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_binary_read_only')
    }
    // Idempotent CAS: identical bytes on a second path reuse the same blob.
    const dup = kernel.workspaceWriteBinary(ws.workspace_id, 'img/plot-copy.png', bytes, 'image/png')
    expect(dup.blob_sha256).toBe(node.blob_sha256)
    expect(kernel.cas.list().filter(h => h === node.blob_sha256)).toHaveLength(1)
    // Replace the binary node via the binary path with CAS.
    const bytes2 = Buffer.from([0x01, 0x02, 0x03])
    const replaced = kernel.workspaceWriteBinary(ws.workspace_id, 'img/plot.png', bytes2, 'image/png', { version: node.version })
    expect(replaced.version).toBe(2)
    expect(replaced.blob_sha256).toBe(sha256Hex(bytes2))
    expect(Buffer.from(readFileSync(join(root, 'img/plot.png'))).equals(bytes2)).toBe(true)
    kernel.close()
  })

  it('path safety: absolute, .., ., NUL, backslash, drive prefixes and empty segments rejected; symlinks refused', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    for (const bad of ['/etc/passwd', '../escape', 'a/../../b', '.', 'a/./b', 'a//b', 'a/', '/a', 'C:\\evil', 'a\\b', 'nul\u0000byte', '']) {
      expect(() => normalizeWorkspacePath(bad), `path ${JSON.stringify(bad)}`).toThrowError(WorkspaceError)
      expect(() => kernel.workspaceWrite(ws.workspace_id, bad, 'x'), `write ${JSON.stringify(bad)}`).toThrowError(/root-relative|path/)
    }
    // Valid nested paths survive.
    expect(normalizeWorkspacePath('src/deep/file.ts')).toBe('src/deep/file.ts')
    const node = kernel.workspaceWrite(ws.workspace_id, 'src/deep/file.ts', 'x')
    expect(node.version).toBe(1)
    // The tree only ever contains root-relative paths and projects dirs.
    const tree = kernel.workspaceTree(ws.workspace_id)
    for (const n of tree.nodes) {
      expect(n.path.startsWith('/')).toBe(false)
      expect(n.path).not.toContain('..')
    }
    expect(tree.nodes.some(n => n.path === 'src' && n.kind === 'dir')).toBe(true)
    expect(tree.nodes.some(n => n.path === 'src/deep' && n.kind === 'dir')).toBe(true)

    // Symlink policy (snapshot-walk superset): ANY symlink on the path is
    // refused — inside-root links too, the tree is regular files only.
    const root = kernel.workspaces.workspaceRoot(ws.workspace_id)
    const escape = join(kernel.workspaces.workspacesRoot, '..', 'escape-target')
    mkdirSync(escape, { recursive: true })
    writeFileSync(join(escape, 'pwned.txt'), 'pwned')
    symlinkSync(escape, join(root, 'link-out'))
    try {
      kernel.workspaceWrite(ws.workspace_id, 'link-out/pwned.txt', 'x')
      throw new Error('expected symlink rejection')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_symlink')
    }
    // A symlink as the FINAL component is refused once a row exists (host
    // tampering replaced the real file with a link — reads must not follow
    // it, and writes must not replace through it).
    kernel.workspaceWrite(ws.workspace_id, 'tampered.txt', 'orig')
    unlinkSync(join(root, 'tampered.txt'))
    symlinkSync(join(escape, 'pwned.txt'), join(root, 'tampered.txt'))
    try {
      kernel.workspaceRead(ws.workspace_id, 'tampered.txt')
      throw new Error('expected symlink rejection')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_symlink')
    }
    try {
      kernel.workspaceWrite(ws.workspace_id, 'tampered.txt', 'x')
      throw new Error('expected symlink rejection')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_symlink')
    }
    // The escape target was never written through the link.
    expect(readFileSync(join(escape, 'pwned.txt'), 'utf8')).toBe('pwned')
    kernel.close()
  })

  it('delete/move run the version CAS; destination collisions are 409; disk files move atomically', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    const root = kernel.workspaces.workspaceRoot(ws.workspace_id)
    const v1 = kernel.workspaceWrite(ws.workspace_id, 'notes.md', '# hello')
    kernel.workspaceWrite(ws.workspace_id, 'other.md', 'other')
    // Delete with stale version → 409.
    try {
      kernel.workspaceDelete(ws.workspace_id, 'notes.md', { version: 99 })
      throw new Error('expected conflict')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_version_conflict')
    }
    // Move onto an existing destination → 409 (no silent overwrite).
    try {
      kernel.workspaceMove(ws.workspace_id, 'notes.md', 'other.md', { version: v1.version })
      throw new Error('expected destination conflict')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_move_destination_exists')
    }
    // Correct CAS move; bytes (and hash) preserved at the destination; the
    // disk file moved (old path gone, new path carries the bytes).
    const moved = kernel.workspaceMove(ws.workspace_id, 'notes.md', 'renamed.md', { etag: v1.etag })
    expect(moved.path).toBe('renamed.md')
    expect(moved.hash).toBe(v1.hash)
    expect(moved.version).toBe(1)
    expect(kernel.workspaceRead(ws.workspace_id, 'notes.md')).toBeNull()
    expect(existsSync(join(root, 'notes.md'))).toBe(false)
    expect(readFileSync(join(root, 'renamed.md'), 'utf8')).toBe('# hello')
    // Delete with correct CAS removes the disk file.
    kernel.workspaceDelete(ws.workspace_id, 'renamed.md', { version: 1 })
    expect(kernel.workspaceRead(ws.workspace_id, 'renamed.md')).toBeNull()
    expect(existsSync(join(root, 'renamed.md'))).toBe(false)
    // History: every mutation recorded with its workspace revision.
    const history = kernel.workspaceHistory(ws.workspace_id)
    expect(history.length).toBeGreaterThanOrEqual(4) // create x2 + move + delete
    expect(history.map(h => h.ops[0]?.op)).toContain('move')
    expect(history.map(h => h.ops[0]?.op)).toContain('delete')
    for (const h of history) expect(h.revision).toBeGreaterThan(0)
    kernel.close()
  })

  it('binary nodes move by blob reference (no byte copy) and the disk file moves', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    const root = kernel.workspaces.workspaceRoot(ws.workspace_id)
    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef])
    const node = kernel.workspaceWriteBinary(ws.workspace_id, 'a.bin', bytes, 'application/octet-stream')
    const moved = kernel.workspaceMove(ws.workspace_id, 'a.bin', 'b.bin', { version: node.version })
    expect(moved.binary).toBe(true)
    expect(moved.blob_sha256).toBe(node.blob_sha256)
    expect(Buffer.from(kernel.workspaceBlob(ws.workspace_id, 'b.bin') as Buffer).equals(bytes)).toBe(true)
    expect(existsSync(join(root, 'a.bin'))).toBe(false)
    expect(Buffer.from(readFileSync(join(root, 'b.bin'))).equals(bytes)).toBe(true)
    kernel.close()
  })

  it('history: readVersion rolls back to stored versions; retention prunes to HISTORY_KEEP_VERSIONS', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    kernel.workspaceWrite(ws.workspace_id, 'a.txt', 'v1')
    kernel.workspaceWrite(ws.workspace_id, 'a.txt', 'v2', { version: 1 })
    const v3 = kernel.workspaceWrite(ws.workspace_id, 'a.txt', 'v3', { version: 2 })
    // Current version reads the live file; older versions read history.
    expect(kernel.workspaceReadVersion(ws.workspace_id, 'a.txt', 3)?.content).toBe('v3')
    expect(kernel.workspaceReadVersion(ws.workspace_id, 'a.txt', 3)?.etag).toBe(v3.etag)
    expect(kernel.workspaceReadVersion(ws.workspace_id, 'a.txt', 2)?.content).toBe('v2')
    expect(kernel.workspaceReadVersion(ws.workspace_id, 'a.txt', 1)?.content).toBe('v1')
    // Unknown versions → null (never 404-shaped errors).
    expect(kernel.workspaceReadVersion(ws.workspace_id, 'a.txt', 99)).toBeNull()
    expect(kernel.workspaceReadVersion(ws.workspace_id, 'missing.txt', 1)).toBeNull()
    // Deleted versions stay readable (undo): delete keeps the last version.
    kernel.workspaceDelete(ws.workspace_id, 'a.txt', { version: 3 })
    expect(kernel.workspaceRead(ws.workspace_id, 'a.txt')).toBeNull()
    expect(kernel.workspaceReadVersion(ws.workspace_id, 'a.txt', 3)?.content).toBe('v3')
    // Retention: writes beyond HISTORY_KEEP_VERSIONS prune the oldest.
    // Create v1='v0'; writes i=1..9 keep the overwritten version and produce
    // v2..v10 — history holds @2..@9 (newest 8), @1 is pruned.
    const ws2 = kernel.workspaceEnsure(project.project_id, 'scratch', 'retention')
    kernel.workspaceWrite(ws2.workspace_id, 'log.txt', 'v0')
    for (let i = 1; i <= HISTORY_KEEP_VERSIONS + 1; i += 1) {
      kernel.workspaceWrite(ws2.workspace_id, 'log.txt', `v${i}`, { version: i })
    }
    // Non-positive versions are invalid (422-shaped), not "missing".
    expect(() => kernel.workspaceReadVersion(ws2.workspace_id, 'log.txt', 0)).toThrowError(WorkspaceError)
    expect(() => kernel.workspaceReadVersion(ws2.workspace_id, 'log.txt', -1)).toThrowError(WorkspaceError)
    // @1 pruned; @2..@9 retained; current v10 reads the live file.
    expect(kernel.workspaceReadVersion(ws2.workspace_id, 'log.txt', 1)).toBeNull()
    expect(kernel.workspaceReadVersion(ws2.workspace_id, 'log.txt', 2)?.content).toBe('v1')
    expect(kernel.workspaceReadVersion(ws2.workspace_id, 'log.txt', 8)?.content).toBe('v7')
    expect(kernel.workspaceReadVersion(ws2.workspace_id, 'log.txt', 9)?.content).toBe('v8')
    expect(kernel.workspaceReadVersion(ws2.workspace_id, 'log.txt', HISTORY_KEEP_VERSIONS + 2)?.content).toBe('v9')
    kernel.close()
  })

  it('watch/search: listSince reports changed + deleted paths; search is prefix/glob path matching', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    kernel.workspaceWrite(ws.workspace_id, 'a.txt', 'a')
    kernel.workspaceWrite(ws.workspace_id, 'src/main.ts', 'm')
    kernel.workspaceWrite(ws.workspace_id, 'src/deep/x.ts', 'x')
    kernel.workspaceMove(ws.workspace_id, 'a.txt', 'b.txt')
    kernel.workspaceDelete(ws.workspace_id, 'src/deep/x.ts')
    const current = kernel.workspaceGet(ws.workspace_id).revision
    // After everything: watch from revision 1 → current nodes + tombstones.
    const since1 = kernel.workspaceListSince(ws.workspace_id, 1)
    expect(since1.nodes.map(n => n.path).sort()).toEqual(['b.txt', 'src/main.ts'])
    expect(since1.deleted.sort()).toEqual(['a.txt', 'src/deep/x.ts'])
    // At the current revision nothing changed; beyond → empty.
    expect(kernel.workspaceListSince(ws.workspace_id, current).nodes).toHaveLength(0)
    expect(kernel.workspaceListSince(ws.workspace_id, current).deleted).toHaveLength(0)
    // A cursor right after the creates sees only the move+delete effects.
    expect(kernel.workspaceListSince(ws.workspace_id, 3).nodes.some(n => n.path === 'b.txt')).toBe(true)
    expect(kernel.workspaceListSince(ws.workspace_id, 3).deleted).toContain('src/deep/x.ts')
    // Path search: prefix + glob (AND), dir nodes projected, no content search.
    const byPrefix = kernel.workspaceSearch(ws.workspace_id, { prefix: 'src' })
    expect(byPrefix.nodes.map(n => n.path).sort()).toEqual(['src', 'src/main.ts'])
    const byGlob = kernel.workspaceSearch(ws.workspace_id, { glob: 'src/*.ts' })
    expect(byGlob.nodes.map(n => n.path).sort()).toEqual(['src/main.ts'])
    const both = kernel.workspaceSearch(ws.workspace_id, { prefix: 'src', glob: 'src/*.ts' })
    expect(both.nodes.map(n => n.path)).toContain('src/main.ts')
    expect(both.nodes.map(n => n.path)).not.toContain('src/deep/x.ts')
    expect(kernel.workspaceSearch(ws.workspace_id, { glob: 'nope/**' }).nodes).toHaveLength(0)
    kernel.close()
  })

  it('size cap: nodes beyond WORKSPACE_MAX_FILE_BYTES are rejected (413-shaped workspace_file_too_large)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    try {
      kernel.workspaceWrite(ws.workspace_id, 'big.txt', 'x'.repeat(WORKSPACE_MAX_FILE_BYTES + 1))
      throw new Error('expected too-large')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_file_too_large')
    }
    // Nothing was written (no row, no disk file).
    expect(kernel.workspaceRead(ws.workspace_id, 'big.txt')).toBeNull()
    // Binary path enforces the same cap.
    try {
      kernel.workspaceWriteBinary(ws.workspace_id, 'big.bin', Buffer.alloc(WORKSPACE_MAX_FILE_BYTES + 1), 'application/octet-stream')
      throw new Error('expected too-large')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_file_too_large')
    }
    kernel.close()
  })

  it('glob matcher: * stays within one segment, ? matches one char, literals are escaped', () => {
    expect(matchWorkspaceGlob('a.txt', 'a.txt')).toBe(true)
    expect(matchWorkspaceGlob('a.txt', '*.txt')).toBe(true)
    expect(matchWorkspaceGlob('src/a.txt', '*.txt')).toBe(false) // * never crosses /
    expect(matchWorkspaceGlob('src/a.txt', 'src/*.txt')).toBe(true)
    expect(matchWorkspaceGlob('a1.txt', 'a?.txt')).toBe(true)
    expect(matchWorkspaceGlob('a12.txt', 'a?.txt')).toBe(false)
    expect(matchWorkspaceGlob('a[1].txt', 'a[1].txt')).toBe(true) // regex chars escaped
  })

  it('workspaceList: generic workspaces plus the manuscript facade workspaces of a project', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    const scratch = kernel.workspaceEnsure(project.project_id, 'scratch', 'notes')
    const doc = kernel.texEnsure(project.project_id)
    const list = kernel.workspaceList(project.project_id)
    expect(list.map(w => w.workspace_id)).toContain(ws.workspace_id)
    expect(list.map(w => w.workspace_id)).toContain(scratch.workspace_id)
    expect(list.map(w => w.workspace_id)).toContain(`ws_${doc.document_id}`)
    expect(list.find(w => w.workspace_id === `ws_${doc.document_id}`)?.kind).toBe('manuscript')
    // Ownership guard: another project cannot see it.
    const other = kernel.createProject({ name: 'q', workspace: '/w', brief: makeBrief() })
    try {
      kernel.assertWorkspaceInProject(ws.workspace_id, other.project_id)
      throw new Error('expected cross-project 404')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_not_found')
    }
    kernel.close()
  })

  it('TeX facade: the tex document is a manuscript workspace with the same contract', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    const wsId = `ws_${doc.document_id}`
    // Facade resolution: workspaceGet/workspaceTree/workspaceWrite all work.
    expect(kernel.workspaceGet(wsId).kind).toBe('manuscript')
    const node = kernel.workspaceWrite(wsId, 'sections/intro.tex', '\\section{Intro}\n')
    expect(node.version).toBe(1)
    expect(node.hash).toBe(sha256Hex('\\section{Intro}\n'))
    expect(node.media).toBe('text/x-tex')
    const tree = kernel.workspaceTree(wsId)
    expect(tree.nodes.some(n => n.path === 'sections' && n.kind === 'dir')).toBe(true)
    expect(tree.nodes.find(n => n.path === 'sections/intro.tex')?.etag).toBe(node.etag)
    // The facade routes onto the SAME tex authority: the tex store sees the
    // write and the revision moved (no second byte store).
    expect(kernel.texReadFile(doc.document_id, 'sections/intro.tex')?.content).toBe('\\section{Intro}\n')
    const before = kernel.texTree(doc.document_id).document.revision
    kernel.workspaceWrite(wsId, 'paper.tex', '\\documentclass{article}\n')
    expect(kernel.texTree(doc.document_id).document.revision).toBe(before + 1)
    // CAS conflicts flow through the facade.
    try {
      kernel.workspaceWrite(wsId, 'sections/intro.tex', 'x', { version: 99 })
      throw new Error('expected conflict')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_version_conflict')
    }
    // Delete via the facade removes the tex file.
    kernel.workspaceDelete(wsId, 'sections/intro.tex', { version: 1 })
    expect(kernel.texReadFile(doc.document_id, 'sections/intro.tex')).toBeNull()
    // Binary writes are rejected by the text-only facade.
    try {
      kernel.workspaceWriteBinary(wsId, 'fig.png', Buffer.from([1]), 'image/png')
      throw new Error('expected read-only')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_binary_read_only')
    }
    // History maps tex history onto workspace revisions.
    expect(kernel.workspaceHistory(wsId).length).toBeGreaterThan(0)
    // Facade watch/search/rollback: conservative full tree, path search,
    // current-version-only rollback.
    expect(kernel.workspaceListSince(wsId, 0).nodes.length).toBeGreaterThan(0)
    expect(kernel.workspaceListSince(wsId, kernel.workspaceGet(wsId).revision).nodes).toHaveLength(0)
    const search = kernel.workspaceSearch(wsId, { prefix: 'paper' })
    expect(search.nodes.map(n => n.path)).toContain('paper.tex')
    expect(kernel.workspaceReadVersion(wsId, 'paper.tex', 1)?.content).toBe('\\documentclass{article}\n')
    expect(kernel.workspaceReadVersion(wsId, 'paper.tex', 99)).toBeNull()
    kernel.close()
  })

  it('wire schemas: strict write/move requests and node round-trips', () => {
    expect(WorkspaceWriteRequest.parse({ path: 'a.txt', content: 'x' })).toMatchObject({ path: 'a.txt' })
    expect(() => WorkspaceWriteRequest.parse({ path: 'a.txt', content: 'x', bogus: 1 })).toThrowError(/Unrecognized key/)
    expect(() => WorkspaceWriteRequest.parse({ path: 'a.txt' })).toThrowError() // content required
    expect(() => WorkspaceMoveRequest.parse({ from_path: 'a', to_path: 'b', expected_etag: 1 })).toThrowError() // etag must be string
    const etag1 = workspaceEtag(1, 'a'.repeat(64))
    const etag2 = workspaceEtag(2, 'a'.repeat(64))
    expect(etag1).not.toBe(etag2) // version participates in the etag
    expect(workspaceEtag(1, 'a'.repeat(64))).toBe(etag1) // deterministic
  })

  it('workspace roots are per-project and history lives outside the tree', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const wsA = kernel.workspaceEnsure(project.project_id, 'code', 'a')
    const wsB = kernel.workspaceEnsure(project.project_id, 'code', 'b')
    kernel.workspaceWrite(wsA.workspace_id, 'same.txt', 'A')
    kernel.workspaceWrite(wsB.workspace_id, 'same.txt', 'B')
    // Same path in two workspaces of one project → two distinct tree files.
    const rootA = kernel.workspaces.workspaceRoot(wsA.workspace_id)
    const rootB = kernel.workspaces.workspaceRoot(wsB.workspace_id)
    expect(rootA).not.toBe(rootB)
    expect(readFileSync(join(rootA, 'same.txt'), 'utf8')).toBe('A')
    expect(readFileSync(join(rootB, 'same.txt'), 'utf8')).toBe('B')
    // History lives under .ws-meta (never inside the tree — a user path
    // `.ws-meta` inside the workspace root cannot collide with it).
    const meta = join(kernel.workspaces.workspacesRoot, '.ws-meta', wsA.workspace_id, 'history')
    kernel.workspaceWrite(wsA.workspace_id, 'same.txt', 'A2', { version: 1 })
    expect(existsSync(join(meta, 'same.txt@1'))).toBe(true)
    expect(lstatSync(join(meta, 'same.txt@1')).isFile()).toBe(true)
    kernel.close()
  })

  it('umask 0077: the full 0750 directory chain and 0640 files survive any umask; pre-existing dirs are not re-chmodded', () => {
    // WORK-01 §5 (hardening-v0.2-status.md): mkdir(mode=0750) is masked by
    // the umask (0750 → 0700 under umask 0077) and writeFileSync(mode=0640)
    // likewise (0640 → 0600). The adapter must explicitly calibrate exactly
    // the directories/files it creates. The umask is restored in `finally`
    // so the rest of the suite is unaffected.
    const previous = process.umask(0o077)
    try {
      const kernel = freshKernel()
      const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
      const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
      // Nested dirs (writeBytesAtomic chain) + an overwrite so a history
      // copy lands under .ws-meta through the same atomic writer.
      kernel.workspaceWrite(ws.workspace_id, 'src/deep/file.ts', 'x')
      kernel.workspaceWrite(ws.workspace_id, 'same.txt', 'v1')
      kernel.workspaceWrite(ws.workspace_id, 'same.txt', 'v2', { version: 1 })
      const root = kernel.workspaces.workspaceRoot(ws.workspace_id)
      // The complete 0750 chain: workspaces root, project dir, workspace
      // root, every nested adapter-created dir and the history dir.
      const chain = [
        kernel.workspaces.workspacesRoot,
        dirname(root),
        root,
        join(root, 'src'),
        join(root, 'src', 'deep'),
        join(kernel.workspaces.workspacesRoot, '.ws-meta', ws.workspace_id, 'history'),
      ]
      for (const dir of chain) {
        expect(statSync(dir).mode & 0o777, `0750 chain member ${dir}`).toBe(0o750)
      }
      // Files are 0640 (tree bytes + history copies).
      for (const file of [join(root, 'src', 'deep', 'file.ts'), join(root, 'same.txt')]) {
        expect(statSync(file).mode & 0o777, `0640 file ${file}`).toBe(0o640)
      }
      const meta = join(kernel.workspaces.workspacesRoot, '.ws-meta', ws.workspace_id, 'history')
      expect(statSync(join(meta, 'same.txt@1')).mode & 0o777).toBe(0o640)
      // Pre-existing directories are NOT re-chmodded: an operator-set 0700
      // dir stays 0700 when the adapter writes into it (chmod only applies
      // to directories this adapter created).
      const preexisting = join(root, 'preexisting')
      mkdirSync(preexisting, { recursive: true, mode: 0o700 })
      chmodSync(preexisting, 0o700)
      kernel.workspaceWrite(ws.workspace_id, 'preexisting/f.txt', 'y')
      expect(statSync(preexisting).mode & 0o777).toBe(0o700)
      // …while the file written into it still follows the 0640 contract.
      expect(statSync(join(preexisting, 'f.txt')).mode & 0o777).toBe(0o640)
      // Atomic temp+rename leaves no tmp/partial files.
      for (const f of listFiles(root)) expect(f).not.toMatch(/\.ws-tmp-/)
      kernel.close()
    } finally {
      process.umask(previous)
    }
  })
})
