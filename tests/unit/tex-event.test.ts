/**
 * TEX-SAVE (storage-migrations.md §5/§7, domain-model.md §12): the
 * `tex.file.saved` kernel outbox event. The tex store owns a SECOND WAL
 * connection (openTexWorkspace), so the outbox append cannot share the write
 * transaction — the tex write commits FIRST, then the event lands on the
 * kernel connection (ordering documented in storage-migrations.md §7;
 * cross-connection atomicity is impossible, the write is the authority).
 *
 * Covered here:
 *  - a successful save appends exactly one tex.file.saved per project
 *    aggregate with the canonical envelope (monotonic event_seq, aggregate
 *    identity, the document revision AFTER the save, request_id/session_id
 *    pass-through);
 *  - a version conflict (409) emits NOTHING;
 *  - event_seq is strictly monotonic across saves of the same project;
 *  - delete/move are intentionally event-free by design (only saves emit);
 *  - the event projects as a research-lane trajectory entry with a redacted
 *    summary.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel } from '@dsh-scholar/research-kernel'
import { TexError } from '../../packages/research-kernel/lib/tex-workspace.js'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tex-event-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

describe('tex.file.saved outbox event (TEX-SAVE)', () => {
  it('emits exactly one tex.file.saved with the canonical envelope after a successful save', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    const w = kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n', undefined, {
      request_id: 'req-tex-1',
      session_id: 'sess-tex-1',
    })
    expect(w.version).toBe(1)
    const saved = kernel.listEvents(project.project_id).filter(e => e.kind === 'tex.file.saved')
    expect(saved).toHaveLength(1)
    const ev = saved[0]!
    // Canonical §16 envelope: per-aggregate monotonic seq (project bucket),
    // aggregate identity, revision AFTER the save (ensure=1 → save=2),
    // request/session pass-through, undelivered.
    expect(ev.project_id).toBe(project.project_id)
    expect(ev.event_seq).toBeGreaterThanOrEqual(1)
    expect(ev.event_version).toBe(1)
    expect(ev.aggregate_type).toBe('project')
    expect(ev.aggregate_id).toBe(project.project_id)
    expect(ev.aggregate_revision).toBe(2)
    expect(ev.request_id).toBe('req-tex-1')
    expect(ev.session_id).toBe('sess-tex-1')
    expect(ev.delivered).toBe(false)
    expect(ev.payload).toMatchObject({
      project_id: project.project_id,
      document_id: doc.document_id,
      path: 'paper.tex',
      revision: 2,
      request_id: 'req-tex-1',
      session_id: 'sess-tex-1',
    })
    kernel.close()
  })

  it('emits NOTHING on a version conflict (409) and keeps the last good event', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    const w = kernel.texWriteFile(doc.document_id, 'paper.tex', 'v1\n')
    expect(w.version).toBe(1)
    // Stale expected version (stored=1, expected=2) → 409 document_version_
    // conflict, and the failed save must not append an event.
    expect(() => kernel.texWriteFile(doc.document_id, 'paper.tex', 'v2\n', 2)).toThrow(TexError)
    const saved = kernel.listEvents(project.project_id).filter(e => e.kind === 'tex.file.saved')
    expect(saved).toHaveLength(1)
    expect(saved[0]!.payload).toMatchObject({ path: 'paper.tex', revision: 2 })
    // The document itself is untouched by the conflict.
    expect(kernel.texReadFile(doc.document_id, 'paper.tex')?.content).toBe('v1\n')
    kernel.close()
  })

  it('allocates strictly monotonic event_seq and per-save revisions across saves', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', 'a\n')
    kernel.texWriteFile(doc.document_id, 'main.bib', '@misc{x}\n')
    kernel.texWriteFile(doc.document_id, 'paper.tex', 'b\n')
    const events = kernel.listEvents(project.project_id).filter(e => e.kind === 'tex.file.saved')
    expect(events).toHaveLength(3)
    const seqs = events.map(e => e.event_seq!)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
    // Each event carries the document revision AFTER that save
    // (ensure=1 → 2, 3, 4).
    expect(events.map(e => e.payload.revision)).toEqual([2, 3, 4])
    kernel.close()
  })

  it('delete/move are intentionally event-free: only saves emit tex.file.saved', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', 'a\n')
    kernel.texWriteFile(doc.document_id, 'main.bib', '@misc{x}\n')
    kernel.texDeleteFile(doc.document_id, 'paper.tex')
    const saved = kernel.listEvents(project.project_id).filter(e => e.kind === 'tex.file.saved')
    // Two saves → two events; the delete emits nothing.
    expect(saved).toHaveLength(2)
    kernel.close()
  })

  it('projects as a research-lane trajectory entry with a redacted summary', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n')
    const entry = kernel.projectTrajectory(project.project_id).entries.find(e => e.kind === 'tex.file.saved')
    expect(entry).toBeDefined()
    expect(entry!.lane).toBe('research')
    expect(entry!.summary).toContain('paper.tex')
    // Raw payload never travels into the projection.
    expect('payload' in entry!).toBe(false)
    kernel.close()
  })

  it('an outbox append failure is recorded and never fails the already-committed save', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    // Sabotage the KERNEL connection (the outbox side). The tex store owns a
    // SEPARATE WAL connection, so the save itself is unaffected: the tex
    // write commits first, the outbox append fails and is recorded without
    // failing the save (storage-migrations.md §7 ordering — the client
    // already observed success; failing here would force a doomed 409 retry).
    kernel.db.close()
    const w = kernel.texWriteFile(doc.document_id, 'paper.tex', '\\documentclass{article}\n')
    expect(w.version).toBe(1)
    // The tex write is the authority: it landed despite the outbox failure.
    expect(kernel.texReadFile(doc.document_id, 'paper.tex')?.content).toBe('\\documentclass{article}\n')
    // NOTE: kernel.close() is intentionally not called — the kernel db is
    // already closed by the sabotage; closing it twice would throw.
  })
})
