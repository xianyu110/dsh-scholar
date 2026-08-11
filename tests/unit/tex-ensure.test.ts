/**
 * P0-3 (TEX-01/TEX-03, hardening-v0.2-status.md §5 row): manuscript
 * open/ensure semantics — the reviewer block:
 *
 *  - "打开/ensure 文稿" is READ-ONLY or first-creation-only: GET
 *    manuscript-drafts never creates a document row and never writes a
 *    byte; POST defaults to ensure (generates ONLY on first creation — an
 *    existing workspace is returned unchanged, bytes and revision intact);
 *  - explicit regenerate (regenerate=true) is confirmed/flagged, preserves
 *    versions: the CURRENT content is frozen into the revision-scoped
 *    snapshot store BEFORE the rewrite, so the pre-regeneration bytes stay
 *    revertable via GET snapshot-files?revision=<old>&path=;
 *  - save A → rerender-style ensure → content still A, revision unchanged.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, startKernelServer } from '@dsh-scholar/research-kernel'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tex-ensure-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

function makeProject(kernel: ResearchKernel): { project_id: string } {
  return kernel.createProject({ name: 'TeX Ensure Demo', workspace: '/w', brief: makeBrief() })
}

describe('TEX-01 P0-3: manuscript ensure — first creation only', () => {
  it('read-only lookup returns null before anything exists and creates NO document row', () => {
    const kernel = freshKernel()
    const project = makeProject(kernel)
    // manuscriptWorkspace must be strictly read-only: null AND no row.
    expect(kernel.manuscriptWorkspace(project.project_id)).toBeNull()
    expect(kernel.tex.findDocument(project.project_id)).toBeNull()
    // ensure then creates on first use (generation path, created=true).
    const ws = kernel.ensureManuscriptWorkspace(project.project_id)
    expect(ws.created).toBe(true)
    expect(ws.regenerated).toBe(false)
    expect(ws.document_id).toMatch(/^doc_/)
    expect(ws.files).toContain('paper.tex')
    expect(ws.files).toContain('main.bib')
    expect(kernel.texReadFile(ws.document_id, 'paper.tex')?.content ?? '').toContain('\\documentclass')
    expect(kernel.texReadFile(ws.document_id, 'main.bib')?.content ?? '').toContain('@')
    kernel.close()
  })

  it('a second ensure does NOT rewrite: bytes and revision are unchanged (created=false)', () => {
    const kernel = freshKernel()
    const project = makeProject(kernel)
    const first = kernel.ensureManuscriptWorkspace(project.project_id)
    const revisionBefore = kernel.texTree(first.document_id).document.revision
    const paperBefore = kernel.texReadFile(first.document_id, 'paper.tex')!.content
    const bibBefore = kernel.texReadFile(first.document_id, 'main.bib')!.content
    const second = kernel.ensureManuscriptWorkspace(project.project_id)
    expect(second.created).toBe(false)
    expect(second.regenerated).toBe(false)
    expect(second.document_id).toBe(first.document_id)
    expect(second.revision).toBe(revisionBefore)
    // The rerender path (render → ensure) must not touch a single byte.
    expect(kernel.texReadFile(first.document_id, 'paper.tex')!.content).toBe(paperBefore)
    expect(kernel.texReadFile(first.document_id, 'main.bib')!.content).toBe(bibBefore)
    expect(kernel.texTree(first.document_id).document.revision).toBe(revisionBefore)
    kernel.close()
  })

  it('save A → ensure/GET after rerender: content still A, revision unchanged', () => {
    const kernel = freshKernel()
    const project = makeProject(kernel)
    const ws = kernel.ensureManuscriptWorkspace(project.project_id)
    const saved = '\\documentclass{article}\n\\begin{document}USER EDIT A\\end{document}\n'
    kernel.texWriteFile(ws.document_id, 'paper.tex', saved)
    const revAfterSave = kernel.texTree(ws.document_id).document.revision
    // The open path (ensure) and the read-only path (manuscriptWorkspace)
    // after the save must both return the saved bytes at the saved revision.
    const again = kernel.ensureManuscriptWorkspace(project.project_id)
    expect(again.created).toBe(false)
    expect(again.revision).toBe(revAfterSave)
    expect(kernel.texReadFile(ws.document_id, 'paper.tex')!.content).toBe(saved)
    const readOnly = kernel.manuscriptWorkspace(project.project_id)
    expect(readOnly?.document_id).toBe(ws.document_id)
    expect(readOnly?.revision).toBe(revAfterSave)
    expect(kernel.texReadFile(ws.document_id, 'paper.tex')!.content).toBe(saved)
    expect(kernel.texTree(ws.document_id).document.revision).toBe(revAfterSave)
    kernel.close()
  })

  it('a bare document row with zero files still counts as first creation', () => {
    const kernel = freshKernel()
    const project = makeProject(kernel)
    // texEnsure only creates the row (no files) — nothing user-visible to
    // preserve, so ensure generates content on first use.
    const doc = kernel.texEnsure(project.project_id)
    expect(kernel.texTree(doc.document_id).files).toHaveLength(0)
    expect(kernel.manuscriptWorkspace(project.project_id)).toBeNull()
    const ws = kernel.ensureManuscriptWorkspace(project.project_id)
    expect(ws.created).toBe(true)
    expect(ws.document_id).toBe(doc.document_id)
    expect(kernel.texTree(doc.document_id).files.length).toBeGreaterThan(0)
    kernel.close()
  })
})

describe('TEX-01 P0-3: explicit regenerate — new revision, old bytes revertable', () => {
  it('regenerate writes a NEW revision and freezes the pre-regeneration bytes', () => {
    const kernel = freshKernel()
    const project = makeProject(kernel)
    const ws = kernel.ensureManuscriptWorkspace(project.project_id)
    const docId = ws.document_id
    // The user edited paper.tex; that edit is what regeneration must not
    // silently destroy (it stays revertable at the old revision).
    const userEdit = '\\documentclass{article}\n\\begin{document}USER EDITED CONTENT\\end{document}\n'
    kernel.texWriteFile(docId, 'paper.tex', userEdit)
    const beforeRevision = kernel.texTree(docId).document.revision
    const bibBefore = kernel.texReadFile(docId, 'main.bib')!.content
    const regen = kernel.regenerateTexWorkspace(project.project_id)
    expect(regen.regenerated).toBe(true)
    expect(regen.created).toBe(false)
    expect(regen.document_id).toBe(docId)
    expect(regen.revision).toBeGreaterThan(beforeRevision)
    // Current bytes are the fresh ledger draft — not the user edit.
    const nowPaper = kernel.texReadFile(docId, 'paper.tex')!.content
    expect(nowPaper).not.toBe(userEdit)
    expect(nowPaper).toContain('\\documentclass')
    // The pre-regeneration state is frozen at the OLD revision: revertable.
    const frozen = kernel.texSnapshotFile(docId, beforeRevision, 'paper.tex')
    expect(frozen?.content).toBe(userEdit)
    const frozenBib = kernel.texSnapshotFile(docId, beforeRevision, 'main.bib')
    expect(frozenBib?.content).toBe(bibBefore)
    kernel.close()
  })

  it('regenerate without any prior workspace still creates one (created semantics)', () => {
    const kernel = freshKernel()
    const project = makeProject(kernel)
    const regen = kernel.regenerateTexWorkspace(project.project_id)
    expect(regen.regenerated).toBe(true)
    expect(regen.document_id).toMatch(/^doc_/)
    expect(regen.files).toContain('paper.tex')
    kernel.close()
  })

  it('a second regenerate keeps BOTH old revisions revertable', () => {
    const kernel = freshKernel()
    const project = makeProject(kernel)
    const ws = kernel.ensureManuscriptWorkspace(project.project_id)
    const docId = ws.document_id
    const firstEdit = '\\documentclass{article}\n\\begin{document}FIRST EDIT\\end{document}\n'
    kernel.texWriteFile(docId, 'paper.tex', firstEdit)
    const rev1 = kernel.texTree(docId).document.revision
    kernel.regenerateTexWorkspace(project.project_id)
    const secondEdit = '\\documentclass{article}\n\\begin{document}SECOND EDIT\\end{document}\n'
    kernel.texWriteFile(docId, 'paper.tex', secondEdit)
    const rev2 = kernel.texTree(docId).document.revision
    kernel.regenerateTexWorkspace(project.project_id)
    // Both the first edit (rev1) and the second edit (rev2) are revertable.
    expect(kernel.texSnapshotFile(docId, rev1, 'paper.tex')?.content).toBe(firstEdit)
    expect(kernel.texSnapshotFile(docId, rev2, 'paper.tex')?.content).toBe(secondEdit)
    expect(kernel.texTree(docId).document.revision).toBeGreaterThan(rev2)
    kernel.close()
  })
})

describe('TEX-01 P0-3: manuscript-drafts HTTP surface', () => {
  it('GET read-only (404 until created), POST ensure once, POST regenerate=true preserves versions', async () => {
    const kernel = freshKernel()
    const { server, url } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
    try {
      const projResp = await fetch(`${url}/v1/projects`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 't', workspace: '/w', brief: makeBrief() }),
      })
      const project = (await projResp.json()) as { project_id: string }
      // GET before creation → 404 manuscript_not_found and NO document row.
      const missing = await fetch(`${url}/v1/projects/${project.project_id}/manuscript-drafts`)
      expect(missing.status).toBe(404)
      expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('manuscript_not_found')
      // First POST creates (created=true).
      const createdResp = await fetch(`${url}/v1/projects/${project.project_id}/manuscript-drafts`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(createdResp.status).toBe(200)
      const ws = (await createdResp.json()) as { document_id: string; revision: number; created: boolean; regenerated: boolean }
      expect(ws.created).toBe(true)
      expect(ws.regenerated).toBe(false)
      // GET now returns the existing workspace read-only.
      const got = (await (await fetch(`${url}/v1/projects/${project.project_id}/manuscript-drafts`)).json()) as {
        document_id: string; revision: number; created: boolean
      }
      expect(got.document_id).toBe(ws.document_id)
      expect(got.created).toBe(false)
      // Save user content A over the generated draft.
      const saved = '\\documentclass{article}\n\\begin{document}A\\end{document}\n'
      await fetch(`${url}/v1/documents/${ws.document_id}/file`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'paper.tex', content: saved }),
      })
      const tree = (await (await fetch(`${url}/v1/documents/${ws.document_id}/tree`)).json()) as { document: { revision: number } }
      // A rerender-style POST (no regenerate flag) must NOT rewrite: bytes
      // and revision unchanged.
      const again = (await (await fetch(`${url}/v1/projects/${project.project_id}/manuscript-drafts`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })).json()) as { revision: number; created: boolean }
      expect(again.created).toBe(false)
      expect(again.revision).toBe(tree.document.revision)
      const file = (await (await fetch(`${url}/v1/documents/${ws.document_id}/file?path=paper.tex`)).json()) as { content: string }
      expect(file.content).toBe(saved)
      // Explicit regenerate=true: revision bumps and the old bytes stay
      // readable at the frozen revision.
      const oldRevision = tree.document.revision
      const regen = (await (await fetch(`${url}/v1/projects/${project.project_id}/manuscript-drafts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ regenerate: true }),
      })).json()) as { revision: number; regenerated: boolean }
      expect(regen.regenerated).toBe(true)
      expect(regen.revision).toBeGreaterThan(oldRevision)
      const frozen = (await (await fetch(`${url}/v1/documents/${ws.document_id}/snapshot-files?revision=${oldRevision}&path=paper.tex`)).json()) as { content: string }
      expect(frozen.content).toBe(saved)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })
})
