/**
 * P0-3 (TEX-01/TEX-03, hardening-v0.2-status.md §5 row) client logic layer:
 * the pure, DOM-free helpers behind the Manuscript panel —
 *
 *  - resolveOpenDocument: "先 GET(只读),不存在才 POST 创建" — opening a
 *    manuscript never writes when a workspace already exists;
 *  - previewPanelModel: minimal live-preview UI model from the server
 *    projection (pending debounce / newest build status / stale / PDF).
 */
import { describe, expect, it } from 'vitest'
import { displayedManuscriptPdfIsStale, latestSucceededManuscriptBuild, resolveOpenDocument, previewPanelModel, triggerPreviewAfterSave } from '../../packages/dsh-research-ui/src/client/manuscript-flow'
import type { ManuscriptBuild } from '../../packages/dsh-research-ui/src/client/types'

function build(status: string, revision = 1, pdf: string | null = null): ManuscriptBuild {
  return {
    build_id: `build_${status}_${revision}`,
    revision,
    root_file: 'paper.tex',
    job_id: null,
    status,
    diagnostics: '[]',
    pdf_artifact: pdf,
    log_artifact: null,
    preview: true,
  }
}

describe('P0-3 manuscript open flow (TEX-01: read-only open)', () => {
  it('GETs first and returns the existing document WITHOUT POSTing (rerender writes nothing)', async () => {
    let posts = 0
    const id = await resolveOpenDocument(
      async () => ({ document_id: 'doc_existing' }),
      async () => { posts += 1; return { document_id: 'doc_created' } },
    )
    expect(id.document_id).toBe('doc_existing')
    expect(posts).toBe(0)
  })

  it('POSTs ONLY when the read-only GET found nothing (first creation)', async () => {
    let gets = 0
    const id = await resolveOpenDocument(
      async () => { gets += 1; return null },
      async () => ({ document_id: 'doc_created' }),
    )
    expect(id.document_id).toBe('doc_created')
    expect(gets).toBe(1)
  })

  it('creation failure degrades to the workspace-unavailable marker (empty id)', async () => {
    const id = await resolveOpenDocument(async () => null, async () => null)
    expect(id.document_id).toBe('')
  })
})

describe('P0-3 preview panel model (TEX-03)', () => {
  it('a durable pending debounce headlines pending (server owns the timer)', () => {
    const m = previewPanelModel({ revision: 3 }, [], 3)
    expect(m.headline).toBe('manuscript.preview.pending')
    expect(m.status).toBe('pending')
    expect(m.stale).toBe(false)
    expect(m.hasPdf).toBe(false)
  })

  it('no pending and no builds → none', () => {
    const m = previewPanelModel(null, [], 3)
    expect(m.headline).toBe('manuscript.preview.none')
  })

  it('queued/running map to their status headlines', () => {
    expect(previewPanelModel(null, [build('queued')], 1).headline).toBe('manuscript.preview.queued')
    expect(previewPanelModel(null, [build('running')], 1).headline).toBe('manuscript.preview.running')
  })

  it('succeeded with a pdf_artifact → hasPdf (PDF link/download shown), not stale', () => {
    const m = previewPanelModel(null, [build('succeeded', 3, 'art_pdf')], 3)
    expect(m.headline).toBe('manuscript.preview.succeeded')
    expect(m.hasPdf).toBe(true)
    expect(m.stale).toBe(false)
  })

  it('stale when the newest preview build is older than the document revision', () => {
    const m = previewPanelModel(null, [build('succeeded', 2, 'art_pdf')], 4)
    expect(m.stale).toBe(true)
    expect(m.hasPdf).toBe(true) // stale PDF is still downloadable
  })

  it('failed/cancelled/superseded map to their terminal status headlines', () => {
    expect(previewPanelModel(null, [build('failed')], 1).headline).toBe('manuscript.preview.failed')
    expect(previewPanelModel(null, [build('cancelled')], 1).headline).toBe('manuscript.preview.cancelled')
    expect(previewPanelModel(null, [build('superseded')], 1).headline).toBe('manuscript.preview.superseded')
  })

  it('a succeeded build without a pdf_artifact has no PDF', () => {
    const m = previewPanelModel(null, [build('succeeded', 3)], 3)
    expect(m.hasPdf).toBe(false)
  })

  it('unknown status falls back to a safe headline (never a missing i18n key)', () => {
    const m = previewPanelModel(null, [build('weird')], 1)
    expect(m.headline).toBe('manuscript.preview.unknown')
    expect(m.status).toBe('weird')
  })

  it('uses the NEWEST preview build (server returns newest first)', () => {
    const m = previewPanelModel(null, [build('succeeded', 5, 'art_new'), build('failed', 3)], 5)
    expect(m.headline).toBe('manuscript.preview.succeeded')
    expect(m.hasPdf).toBe(true)
    expect(m.stale).toBe(false)
  })
})

describe('P0-3 preview trigger (TEX-03: save success → hook once)', () => {
  it('fires the preview hook EXACTLY once per successful save', async () => {
    let fired = 0
    const ok = await triggerPreviewAfterSave('doc_1', async () => { fired += 1; return { pending: {} } })
    expect(ok).toBe(true)
    expect(fired).toBe(1)
  })

  it('a failed hook call returns false but never fails the already-committed save', async () => {
    const ok = await triggerPreviewAfterSave('doc_1', async () => null)
    expect(ok).toBe(false)
  })

  it('never fires when there is no document (save could not have happened)', async () => {
    let fired = 0
    const ok = await triggerPreviewAfterSave('', async () => { fired += 1; return { pending: {} } })
    expect(ok).toBe(false)
    expect(fired).toBe(0)
  })
})

describe('Manuscript PDF authority selection', () => {
  it('selects the newest succeeded build before inspecting PDF availability', () => {
    const noPdf = build('succeeded', 4, null)
    const oldPdf = build('succeeded', 3, 'art_old')
    noPdf.build_id = 'build_new_without_pdf'
    oldPdf.build_id = 'build_old_with_pdf'
    expect(latestSucceededManuscriptBuild([noPdf, oldPdf], 'preview')).toBe(noPdf)
    expect(latestSucceededManuscriptBuild([noPdf, oldPdf], 'preview')?.pdf_artifact).toBeNull()
  })

  it('keeps preview builds out of authoritative PDF selection', () => {
    const preview = build('succeeded', 5, 'art_preview')
    const authoritative = { ...build('succeeded', 4, 'art_authoritative'), preview: false }
    expect(latestSucceededManuscriptBuild([preview, authoritative], 'authoritative')).toBe(authoritative)
  })

  it('marks an older displayed PDF stale when a newer build exists or the editor is dirty', () => {
    const displayed = { ...build('succeeded', 4, 'art_old'), build_id: 'build_old', preview: false }
    const newer = { ...build('running', 5), build_id: 'build_new', preview: false }
    expect(displayedManuscriptPdfIsStale([newer, displayed], displayed.build_id, 5, 'authoritative')).toBe(true)
    expect(displayedManuscriptPdfIsStale([displayed], displayed.build_id, 4, 'authoritative', true)).toBe(true)
    expect(displayedManuscriptPdfIsStale([displayed], displayed.build_id, 4, 'authoritative')).toBe(false)
  })

  it('marks an old preview stale when the newer succeeded PDF could not be loaded', () => {
    const displayed = { ...build('succeeded', 5, 'art_old'), build_id: 'preview_old' }
    const newer = { ...build('succeeded', 5, 'art_new'), build_id: 'preview_new' }
    expect(displayedManuscriptPdfIsStale([newer, displayed], displayed.build_id, 5, 'preview')).toBe(true)
  })
})
