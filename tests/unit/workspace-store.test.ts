/**
 * WORK-01 interface-layer tests (api-contracts.md §17, acceptance-tests.md
 * §7): generic VS Code-style workspace — revision/etag/hash semantics,
 * CAS conflicts (409), create-if-absent, binary artifact CAS (bytes
 * round-trip, hash binding, read-only text writes), path safety
 * (execution-runtime.md §4 snapshot-walk contract), move/delete CAS,
 * history ops, implied dirs and the TeX facade mapping (tex-workspace is
 * the facade reference — the facade maps it onto this interface without a
 * second byte authority).
 *
 * The real filesystem adapter and the browser UI are NOT part of this
 * round: this store is the durable interface layer.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel } from '@dsh-scholar/research-kernel'
import { workspaceEtag, WorkspaceNode, WorkspaceWriteRequest, WorkspaceMoveRequest } from '@dsh-scholar/research-schemas'
import { WorkspaceError, normalizeWorkspacePath } from '../../packages/research-kernel/lib/workspace-store.js'

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ws-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief() {
  return { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' }
}

describe('generic workspace store (WORK-01 interface layer)', () => {
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

  it('binary CAS: server-computed sha256, CAS blob round-trip, idempotent puts, read-only text writes', () => {
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
    // The blob lives in the artifact CAS and reads back byte-identical.
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
    kernel.close()
  })

  it('path safety: absolute, .., ., NUL, backslash, drive prefixes and empty segments rejected', () => {
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
    kernel.close()
  })

  it('delete/move run the version CAS; destination collisions are 409; history records ops', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
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
    // Correct CAS move; bytes (and hash) preserved at the destination.
    const moved = kernel.workspaceMove(ws.workspace_id, 'notes.md', 'renamed.md', { etag: v1.etag })
    expect(moved.path).toBe('renamed.md')
    expect(moved.hash).toBe(v1.hash)
    expect(moved.version).toBe(1)
    expect(kernel.workspaceRead(ws.workspace_id, 'notes.md')).toBeNull()
    // Delete with correct CAS.
    kernel.workspaceDelete(ws.workspace_id, 'renamed.md', { version: 1 })
    expect(kernel.workspaceRead(ws.workspace_id, 'renamed.md')).toBeNull()
    // History: every mutation recorded with its workspace revision.
    const history = kernel.workspaceHistory(ws.workspace_id)
    expect(history.length).toBeGreaterThanOrEqual(4) // create x2 + move + delete
    expect(history.map(h => h.ops[0]?.op)).toContain('move')
    expect(history.map(h => h.ops[0]?.op)).toContain('delete')
    for (const h of history) expect(h.revision).toBeGreaterThan(0)
    kernel.close()
  })

  it('binary nodes move by blob reference (no byte copy)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef])
    const node = kernel.workspaceWriteBinary(ws.workspace_id, 'a.bin', bytes, 'application/octet-stream')
    const moved = kernel.workspaceMove(ws.workspace_id, 'a.bin', 'b.bin', { version: node.version })
    expect(moved.binary).toBe(true)
    expect(moved.blob_sha256).toBe(node.blob_sha256)
    expect(Buffer.from(kernel.workspaceBlob(ws.workspace_id, 'b.bin') as Buffer).equals(bytes)).toBe(true)
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
})
