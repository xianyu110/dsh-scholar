/**
 * TeX workspace unit tests (execution-runtime.md §12, api-contracts.md §11):
 * versioned files with CAS writes, snapshots, latex-compile builds and the
 * ledger-to-workspace generator.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, KernelError } from '@dsh-scholar/research-kernel'
import { TexError } from '../../packages/research-kernel/lib/tex-workspace.js'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tex-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas') })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

describe('tex workspace', () => {
  it('writes files with version CAS and rejects conflicts (409)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    const w1 = kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n')
    expect(w1.version).toBe(1)
    // Same content again without expected version: new revision.
    const w2 = kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n\\begin{document}\n')
    expect(w2.version).toBe(2)
    // Stale expected version → 409 conflict.
    expect(() => kernel.texWriteFile(doc.document_id, 'paper.tex', 'x', 1)).toThrowError(TexError)
    try {
      kernel.texWriteFile(doc.document_id, 'paper.tex', 'x', 1)
    } catch (error) {
      expect((error as TexError).code).toBe('document_version_conflict')
    }
    // Correct expected version succeeds.
    const w3 = kernel.texWriteFile(doc.document_id, 'paper.tex', '\\end{document}\n', 2)
    expect(w3.version).toBe(3)
    // Absolute paths and traversal are rejected.
    expect(() => kernel.texWriteFile(doc.document_id, '/etc/passwd', 'x')).toThrowError(/root-relative/)
    expect(() => kernel.texWriteFile(doc.document_id, 'a/../../b.tex', 'x')).toThrowError(/root-relative/)
    const tree = kernel.texTree(doc.document_id)
    expect(tree.files).toHaveLength(1)
    expect(tree.files[0]!.version).toBe(3)
    // tree/GET contract (acceptance-tests.md §7): path/kind/media/version.
    expect(tree.files[0]).toMatchObject({ path: 'paper.tex', kind: 'tex', media: 'text/x-tex', version: 3 })
    const read = kernel.texReadFile(doc.document_id, 'paper.tex')
    expect(read?.content).toBe('\\end{document}\n')
    expect(read).toMatchObject({ path: 'paper.tex', kind: 'tex', media: 'text/x-tex', version: 3 })
    kernel.close()
  })

  it('expected_version=0 is create-if-absent: creates at version 1, conflicts when the file exists', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    // Fresh path with expected_version=0 → created (version 1, no 422).
    const created = kernel.texWriteFile(doc.document_id, 'sections/intro.tex', '\\section{Intro}\n', 0)
    expect(created.version).toBe(1)
    const createdBib = kernel.texWriteFile(doc.document_id, 'main.bib', '@misc{x}\n', 0)
    expect(createdBib.version).toBe(1)
    const tree = kernel.texTree(doc.document_id)
    expect(tree.files.find(f => f.path === 'sections/intro.tex')).toMatchObject({
      path: 'sections/intro.tex', kind: 'tex', media: 'text/x-tex', version: 1,
    })
    expect(tree.files.find(f => f.path === 'main.bib')).toMatchObject({
      path: 'main.bib', kind: 'bib', media: 'text/x-bibtex', version: 1,
    })
    for (const f of tree.files) {
      expect(f.path.startsWith('/')).toBe(false) // tree only holds root-relative paths
      expect(f.path).not.toContain('..')
      expect(f.version).toBeGreaterThanOrEqual(1)
      expect(f.content_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(typeof f.kind).toBe('string')
      expect(typeof f.media).toBe('string')
    }
    // Same path again with 0 → create-if-absent conflict (0 never matches a
    // stored version >= 1).
    try {
      kernel.texWriteFile(doc.document_id, 'sections/intro.tex', 'x', 0)
      throw new Error('expected TexError')
    } catch (error) {
      expect(error).toBeInstanceOf(TexError)
      expect((error as TexError).code).toBe('document_version_conflict')
    }
    // Existing paper.tex with expected_version=0 → conflict as well.
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n')
    try {
      kernel.texWriteFile(doc.document_id, 'paper.tex', 'x', 0)
      throw new Error('expected TexError')
    } catch (error) {
      expect(error).toBeInstanceOf(TexError)
      expect((error as TexError).code).toBe('document_version_conflict')
    }
    kernel.close()
  })

  it('expected_version=0 on delete/move never matches a stored version (409)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    const w = kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n')
    expect(w.version).toBe(1)
    // Delete with 0 → conflict (must reload first).
    try {
      kernel.texDeleteFile(doc.document_id, 'paper.tex', 0)
      throw new Error('expected TexError')
    } catch (error) {
      expect(error).toBeInstanceOf(TexError)
      expect((error as TexError).code).toBe('document_version_conflict')
    }
    // Move with 0 → conflict on the source version.
    try {
      kernel.texMoveFile(doc.document_id, 'paper.tex', 'renamed.tex', 0)
      throw new Error('expected TexError')
    } catch (error) {
      expect(error).toBeInstanceOf(TexError)
      expect((error as TexError).code).toBe('document_version_conflict')
    }
    // The file is untouched by the conflicts.
    expect(kernel.texReadFile(doc.document_id, 'paper.tex')?.version).toBe(1)
    // Correct source version moves; unchecked delete removes.
    kernel.texMoveFile(doc.document_id, 'paper.tex', 'renamed.tex', 1)
    expect(kernel.texReadFile(doc.document_id, 'renamed.tex')?.version).toBe(1)
    kernel.texDeleteFile(doc.document_id, 'renamed.tex')
    expect(kernel.texTree(doc.document_id).files).toHaveLength(0)
    kernel.close()
  })

  it('snapshots freeze a manifest and builds record job ids', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\begin{document}hi\\end{document}\n')
    kernel.texWriteFile(doc.document_id, 'main.bib', '@misc{x}\n')
    const snap = kernel.texSnapshot(doc.document_id)
    expect(snap.manifest.files.length).toBe(2)
    expect(snap.manifest.root_file).toBe('paper.tex')
    // Snapshot against a stale revision conflicts.
    expect(() => kernel.texSnapshot(doc.document_id, snap.revision - 1)).toThrowError(/expected revision/)
    const job = kernel.submitJob({
      project_id: project.project_id,
      idempotency_key: `latex:${doc.document_id}:${snap.revision}`,
      kind: 'latex-compile',
      payload: { tex_document_id: doc.document_id, tex_revision: snap.revision },
    })
    expect(job.kind).toBe('latex-compile')
    const build = kernel.texCreateBuild(doc.document_id, snap.revision, 'paper.tex', job.job_id)
    expect(build.status).toBe('queued')
    const updated = kernel.texUpdateBuild(build.build_id, { status: 'succeeded', diagnostics: '[]', pdf_artifact: 'sha256:pdf' })
    expect(updated.status).toBe('succeeded')
    expect(updated.finished_at).not.toBeNull()
    expect(kernel.texGetBuild(build.build_id).pdf_artifact).toBe('sha256:pdf')
    expect(kernel.texListBuilds(doc.document_id)).toHaveLength(1)
    kernel.close()
  })

  it('submitJob rejects latex-compile without a tex snapshot binding', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    try {
      kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k', kind: 'latex-compile', payload: {} })
      throw new Error('expected KernelError')
    } catch (error) {
      expect(error).toBeInstanceOf(KernelError)
      expect((error as KernelError).code).toBe('tex_snapshot_required')
    }
    kernel.close()
  })

  it('generateTexWorkspace creates paper.tex + main.bib from the ledger', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'TeX Demo', workspace: '/w', brief: makeBrief() })
    const generated = kernel.generateTexWorkspace(project.project_id)
    expect(generated.files).toContain('paper.tex')
    expect(generated.files).toContain('main.bib')
    const paper = kernel.texReadFile(generated.document_id, 'paper.tex')
    expect(paper?.content ?? '').toContain('\\documentclass')
    const bib = kernel.texReadFile(generated.document_id, 'main.bib')
    expect(bib?.content ?? '').toContain('@')
    // Regenerating writes a new revision (CAS bump).
    const again = kernel.generateTexWorkspace(project.project_id)
    expect(again.document_id).toBe(generated.document_id)
    expect(again.revision).toBeGreaterThan(generated.revision)
    kernel.close()
  })
})
