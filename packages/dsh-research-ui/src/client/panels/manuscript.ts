import type { ManuscriptBuild, ManuscriptFile, Projection } from '../types'
import { api, authHeaders, base } from '../api'
import { t } from '../i18n/index'
import { el } from '../ui'
import { state, tabSave } from '../state'
import { terminalLoadSeq } from '../terminal'
import { isEditorDirty } from '../manuscript-dirty'
import { resolveOpenDocument, previewPanelModel, triggerPreviewAfterSave } from '../manuscript-flow'
/* ─────────────────────────── Manuscript Workbench ─────────────────────────── */

/**
 * dsh-web TeX Workbench (gui-plugin-plan §11): file tree + editor + build
 * diagnostics/PDF. Files carry version CAS (expected_version); 409 conflicts
 * surface a base/current/local banner instead of silent overwrites.
 */


export let msDocId: string | null = null
export let msFiles: ManuscriptFile[] = []
export let msRevision = 1
export let msOpenPath: string | null = null
export let msContent = ''
export let msSavedVersion = 0
export let msSavedContent = ''
export let msDirty = false
export let msConflict: string | null = null
export let msBuilds: ManuscriptBuild[] = []
export let msBuildPoll: number | undefined
export let msPdfUrl: string | null = null
/** Document the main-build PDF blob was loaded for (blob lifetime guard). */
let msPdfDocId: string | null = null
// TEX-03 (P0-3): live-preview projection (GET /v1/documents/{id}/preview-builds).
export let msPreviews: ManuscriptBuild[] = []
export let msPreviewPending: { document_id: string; revision: number; debounce_ms: number } | null = null
export let msPreviewPoll: number | undefined
export let msPreviewPdfUrl: string | null = null
export let msPreviewPdfBuildId: string | null = null
/** Document the preview PDF blob was loaded for (blob lifetime guard). */
let msPreviewPdfDocId: string | null = null

export function msCleanup(): void {
  if (msBuildPoll !== undefined) { window.clearInterval(msBuildPoll); msBuildPoll = undefined }
  if (msPreviewPoll !== undefined) { window.clearInterval(msPreviewPoll); msPreviewPoll = undefined }
  // P0 (hot-loop guard): the PDF blob URLs are owned by the DOCUMENT they
  // were loaded for. A same-document re-render must NOT revoke them —
  // render → poll → "PDF not loaded yet" → fetch → set URL → rerender →
  // revoke → poll again … is an infinite loop once any build has a PDF,
  // and it floods the loopback rate limit within seconds (page keeps
  // "refreshing" and then freezes on 429s). Blobs are freed only when the
  // document actually changes (or the panel is left: msDocId !== owner).
  if (msPdfDocId !== null && msPdfDocId !== msDocId) {
    if (msPdfUrl !== null) URL.revokeObjectURL(msPdfUrl)
    msPdfUrl = null
    msPdfDocId = null
  }
  if (msPreviewPdfDocId !== null && msPreviewPdfDocId !== msDocId) {
    if (msPreviewPdfUrl !== null) URL.revokeObjectURL(msPreviewPdfUrl)
    msPreviewPdfUrl = null
    msPreviewPdfBuildId = null
    msPreviewPdfDocId = null
  }
}

export async function msLoadDocument(projectId: string): Promise<{ document_id: string }> {
  // P0-3 (TEX-01): opening a manuscript is READ-ONLY — GET the existing
  // workspace first; only when nothing exists yet do we POST to create it.
  // A render/rerender therefore never writes: no regeneration, no revision
  // bump, no overwrite of saved content.
  return resolveOpenDocument(
    () => api<{ document_id: string }>(`/v1/projects/${encodeURIComponent(projectId)}/manuscript-drafts`),
    () => api<{ document_id: string }>(`/v1/projects/${encodeURIComponent(projectId)}/manuscript-drafts`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  )
}

export async function msLoadTree(): Promise<void> {
  if (msDocId === null) return
  const tree = await api<{ document: { revision: number }; files: ManuscriptFile[] }>(`/v1/documents/${encodeURIComponent(msDocId)}/tree`)
  if (tree !== null) {
    msRevision = tree.document.revision
    msFiles = tree.files
  }
}

export async function msOpenFile(path: string): Promise<void> {
  if (msDocId === null) return
  if (msDirty && msOpenPath !== null && msOpenPath !== path) {
    const keep = window.confirm(t('manuscript', 'manuscript.editor.discard', { path: msOpenPath }))
    if (!keep) return
  }
  const file = await api<{ path: string; version: number; content: string }>(`/v1/documents/${encodeURIComponent(msDocId)}/file?path=${encodeURIComponent(path)}`)
  if (file === null) return
  msOpenPath = path
  msContent = file.content
  msSavedVersion = file.version
  // §7 dirty baseline: the SAVED content from the file GET — the tree entry
  // carries no content, so it can never serve as the dirty baseline.
  msSavedContent = file.content
  msDirty = false
}

export async function msSaveFile(): Promise<void> {
  if (msDocId === null || msOpenPath === null) return
  const result = await api<{ version: number; content_hash: string }>(`/v1/documents/${encodeURIComponent(msDocId)}/file`, {
    method: 'PUT',
    body: JSON.stringify({ path: msOpenPath, content: msContent, expected_version: msSavedVersion }),
  })
  if (result === null) {
    // 409 conflict (or transport error): surface the conflict banner.
    msConflict = t('manuscript', 'manuscript.conflict.text', { path: msOpenPath })
    state.rerender()
    return
  }
  msSavedVersion = result.version
  // The server stored exactly the content we sent: that is the new baseline
  // (revert-to-saved must read clean, including a revert to '').
  msSavedContent = msContent
  msDirty = false
  msConflict = null
  await msLoadTree()
  // P0-3 (TEX-03): save success triggers the live-preview hook ONCE. The
  // kernel owns the debounce (default 800ms) and coalesces rapid saves —
  // the client never schedules its own timer. Best-effort: a failed hook
  // call never fails the already-committed save.
  await triggerPreviewAfterSave(msDocId, id => api(`/v1/documents/${encodeURIComponent(id)}/preview-builds`, {
    method: 'POST',
    body: JSON.stringify({}),
  }))
  await msPollPreviews()
  state.rerender()
}

export async function msReloadFile(): Promise<void> {
  if (msDocId === null || msOpenPath === null) return
  const file = await api<{ path: string; version: number; content: string }>(`/v1/documents/${encodeURIComponent(msDocId)}/file?path=${encodeURIComponent(msOpenPath)}`)
  if (file !== null) {
    msContent = file.content
    msSavedVersion = file.version
    msSavedContent = file.content
    msDirty = false
    msConflict = null
    state.rerender()
  }
}

export async function msCompile(): Promise<void> {
  if (msDocId === null) return
  // §4 row 95 (TEX-01): a failed save (409 conflict) must TERMINATE the
  // compile — the workspace revision moved under us and the frozen manifest
  // would not match what the editor holds. Save first, abort on conflict.
  if (msDirty) {
    await msSaveFile()
    if (msConflict !== null) return
  }
  const result = await api<{ build: ManuscriptBuild }>(`/v1/documents/${encodeURIComponent(msDocId)}/builds`, {
    method: 'POST',
    body: JSON.stringify({ expected_document_revision: msRevision, root_file: 'paper.tex' }),
  })
  if (result === null) {
    // The kernel rejects a stale-revision compile with 409
    // document_version_conflict (no job, no build row) — surface it instead
    // of silently continuing.
    msConflict = t('manuscript', 'manuscript.compile.rejected')
    state.rerender()
    return
  }
  msBuilds = [result.build, ...msBuilds]
  void msPollBuilds()
  state.rerender()
}

export async function msPollBuilds(): Promise<void> {
  if (msDocId === null) return
  const before = JSON.stringify(msBuilds)
  const builds = await api<ManuscriptBuild[]>(`/v1/documents/${encodeURIComponent(msDocId)}/builds`)
  if (builds !== null) msBuilds = builds
  const running = msBuilds.some(b => b.status === 'queued' || b.status === 'running')
  if (running) {
    if (msBuildPoll === undefined) {
      msBuildPoll = window.setInterval(() => { void msPollBuilds() }, 2000)
    }
  } else {
    if (msBuildPoll !== undefined) { window.clearInterval(msBuildPoll); msBuildPoll = undefined }
  }
  // PDF preview for the newest successful build.
  let pdfNow = false
  const ok = msBuilds.find(b => b.status === 'succeeded' && b.pdf_artifact !== null)
  if (ok !== null && ok !== undefined && msPdfUrl === null && ok.pdf_artifact !== null) {
    const projectId = document.querySelector('#dsh-scholar-ui')?.getAttribute('data-project') ?? ''
    const response = await fetch(`${base()}/v1/artifacts/${encodeURIComponent(ok.pdf_artifact)}?project_id=${encodeURIComponent(projectId)}`, {
      headers: { accept: 'application/octet-stream', ...(await authHeaders()) },
    })
    if (response.ok) {
      const blob = await response.blob()
      msPdfUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
      msPdfDocId = msDocId
      pdfNow = true
    }
  }
  // Rerender ONLY when something visibly changed. An unconditional
  // state.rerender here plus renderManuscript()'s trailing msPollBuilds() call
  // would form a hot loop: render → poll → state.rerender → render → … at
  // ~5 requests/cycle, exhausting the loopback rate limit in seconds.
  if (before !== JSON.stringify(msBuilds) || pdfNow) state.rerender()
}

/** TEX-03 (P0-3): poll the live-preview projection (pending debounce +
 * preview builds). The PDF of the newest SUCCEEDED preview is loaded once
 * per build id; a newer succeeded build replaces it. Same hot-loop guard
 * as msPollBuilds: rerender only on visible change. */
export async function msPollPreviews(): Promise<void> {
  if (msDocId === null) return
  const before = JSON.stringify({ p: msPreviewPending, b: msPreviews })
  const status = await api<{ pending: { document_id: string; revision: number; debounce_ms: number } | null; builds: ManuscriptBuild[] }>(`/v1/documents/${encodeURIComponent(msDocId)}/preview-builds`)
  if (status !== null) {
    msPreviewPending = status.pending
    msPreviews = status.builds
  }
  const busy = msPreviewPending !== null || msPreviews.some(b => b.status === 'queued' || b.status === 'running')
  if (busy) {
    if (msPreviewPoll === undefined) {
      msPreviewPoll = window.setInterval(() => { void msPollPreviews() }, 2000)
    }
  } else {
    if (msPreviewPoll !== undefined) { window.clearInterval(msPreviewPoll); msPreviewPoll = undefined }
  }
  let pdfNow = false
  const ok = msPreviews.find(b => b.status === 'succeeded' && b.pdf_artifact !== null)
  if (ok !== undefined && ok.pdf_artifact !== null && msPreviewPdfBuildId !== ok.build_id) {
    const projectId = document.querySelector('#dsh-scholar-ui')?.getAttribute('data-project') ?? ''
    const response = await fetch(`${base()}/v1/artifacts/${encodeURIComponent(ok.pdf_artifact)}?project_id=${encodeURIComponent(projectId)}`, {
      headers: { accept: 'application/octet-stream', ...(await authHeaders()) },
    })
    if (response.ok) {
      const blob = await response.blob()
      if (msPreviewPdfUrl !== null) URL.revokeObjectURL(msPreviewPdfUrl)
      msPreviewPdfUrl = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
      msPreviewPdfBuildId = ok.build_id
      msPreviewPdfDocId = msDocId
      pdfNow = true
    }
  }
  if (before !== JSON.stringify({ p: msPreviewPending, b: msPreviews }) || pdfNow) state.rerender()
}

/** P0-3 (TEX-01): explicit regeneration — confirmed by the user, never
 * triggered by a render. The server freezes the CURRENT content as a
 * revision-scoped snapshot BEFORE rewriting, so the old bytes stay
 * revertable (GET /v1/documents/{id}/snapshot-files?revision=&path=). */
export async function msRegenerate(projectId: string): Promise<void> {
  if (!window.confirm(t('manuscript', 'manuscript.regenerate.confirm'))) return
  const result = await api<{ document_id: string; revision: number }>(`/v1/projects/${encodeURIComponent(projectId)}/manuscript-drafts`, {
    method: 'POST',
    body: JSON.stringify({ regenerate: true }),
  })
  if (result === null) {
    window.alert(t('manuscript', 'manuscript.regenerate.failed'))
    return
  }
  // The workspace changed under the editor: adopt the new document, reload
  // the tree and reopen the current file at the new bytes. The old preview
  // PDF belongs to the pre-regeneration revision — drop it (the next
  // preview poll shows the fresh projection).
  if (msPreviewPdfUrl !== null) { URL.revokeObjectURL(msPreviewPdfUrl); msPreviewPdfUrl = null }
  msPreviewPdfBuildId = null
  msPreviewPdfDocId = null
  msDocId = result.document_id
  await msLoadTree()
  if (msOpenPath !== null) {
    await msOpenFile(msOpenPath)
  } else {
    const root = msFiles.find(f => f.path === 'paper.tex') ?? msFiles[0]
    if (root !== undefined) await msOpenFile(root.path)
  }
  await msPollPreviews()
  state.rerender()
}

/** dsh-web Manuscript page: tree | editor | diagnostics+PDF. */
export async function renderManuscript(body: HTMLElement, _p: Projection, projectId: string): Promise<void> {
  msCleanup()
  const host = document.querySelector('#dsh-scholar-ui') as HTMLElement | null
  host?.setAttribute('data-project', projectId)
  const doc = await msLoadDocument(projectId)
  if (doc.document_id === '') {
    body.appendChild(el('div', 'error-banner', t('manuscript', 'manuscript.workspaceUnavailable')))
    return
  }
  const firstLoad = msDocId !== doc.document_id
  msDocId = doc.document_id
  await msLoadTree()
  if (firstLoad && msOpenPath === null) {
    const root = msFiles.find(f => f.path === 'paper.tex') ?? msFiles[0]
    if (root !== undefined) await msOpenFile(root.path)
  }
  const docId = msDocId

  // Header: document, revision, save state, actions.
  const header = el('div', 'row')
  header.style.cssText = 'justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px'
  const title = el('span', 'pname', t('manuscript', 'manuscript.header.doc', { id: docId.slice(0, 16), rev: String(msRevision) }) + (msDirty ? t('manuscript', 'manuscript.header.unsaved') : ''))
  title.style.cssText = 'font-size:12px'
  header.appendChild(title)
  const actions = el('div', 'row')
  actions.style.cssText = 'gap:6px'
  const saveBtn = el('button', 'hbtn', t('manuscript', 'manuscript.action.save'))
  saveBtn.disabled = !msDirty
  saveBtn.onclick = () => { void msSaveFile() }
  const compileBtn = el('button', 'btn approve', t('manuscript', 'manuscript.action.compile'))
  compileBtn.style.cssText = 'padding:4px 14px'
  // §4 row 95: prevent duplicate submits while a build is queued/running.
  compileBtn.disabled = msBuilds.some(b => b.status === 'queued' || b.status === 'running')
  compileBtn.onclick = () => { void msCompile() }
  const refreshBtn = el('button', 'hbtn', '⟳')
  refreshBtn.title = t('manuscript', 'manuscript.action.refresh')
  refreshBtn.onclick = () => { void msLoadTree().then(() => state.rerender()) }
  // P0-3 (TEX-01): regeneration is EXPLICIT and confirmed — rendering,
  // saving and polling never rewrite the workspace.
  const regenBtn = el('button', 'hbtn', t('manuscript', 'manuscript.action.regenerate'))
  regenBtn.title = t('manuscript', 'manuscript.action.regenerate')
  regenBtn.onclick = () => { void msRegenerate(projectId) }
  actions.append(saveBtn, compileBtn, refreshBtn, regenBtn)
  header.appendChild(actions)
  body.appendChild(header)

  if (msConflict !== null) {
    const banner = el('div', 'card border-red')
    banner.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:8px'
    banner.appendChild(el('span', 'grow', `⚠ ${msConflict}`))
    const reloadBtn = el('button', 'hbtn', t('manuscript', 'manuscript.action.reload'))
    reloadBtn.onclick = () => { void msReloadFile() }
    banner.appendChild(reloadBtn)
    body.appendChild(banner)
  }

  const shell = el('div')
  shell.style.cssText = 'display:flex;gap:10px;align-items:stretch;min-height:480px'

  // File tree (220px).
  const treeCol = el('div')
  treeCol.style.cssText = 'width:220px;flex-shrink:0;border:1px solid var(--border);border-radius:10px;padding:8px;overflow-y:auto;max-height:640px'
  treeCol.appendChild(el('div', 'section-label', t('manuscript', 'manuscript.files')))
  for (const f of msFiles) {
    const row = el('button')
    row.style.cssText = 'display:flex;align-items:center;gap:6px;width:100%;border:0;background:none;color:var(--text);text-align:left;padding:4px 6px;border-radius:6px;cursor:pointer;font:11px/1.4 ui-monospace,Menlo,monospace'
    if (f.path === msOpenPath) row.style.cssText += ';background:var(--accent-soft)'
    row.onmouseenter = () => { if (f.path !== msOpenPath) row.style.background = 'var(--bg-hover)' }
    row.onmouseleave = () => { row.style.background = f.path === msOpenPath ? 'var(--accent-soft)' : 'none' }
    row.appendChild(el('span', '', f.path))
    row.appendChild(el('span', 'muted', `v${f.version}`))
    row.style.cssText += ';justify-content:space-between'
    row.onclick = () => { void msOpenFile(f.path).then(() => state.rerender()) }
    treeCol.appendChild(row)
  }
  const newFileBtn = el('button', 'hbtn', t('manuscript', 'manuscript.action.newFile'))
  newFileBtn.style.cssText = 'margin-top:8px;width:100%'
  newFileBtn.onclick = () => {
    const name = window.prompt(t('manuscript', 'manuscript.newFilePrompt'), 'section.tex')
    if (name === null || name.trim() === '') return
    void api(`/v1/documents/${encodeURIComponent(docId)}/file`, {
      method: 'PUT',
      body: JSON.stringify({ path: name.trim(), content: '', expected_version: 0 }),
    }).then(() => msLoadTree()).then(() => state.rerender())
  }
  treeCol.appendChild(newFileBtn)
  body.appendChild(treeCol)

  // Editor.
  const editorCol = el('div')
  editorCol.style.cssText = 'flex:1;display:flex;flex-direction:column;min-width:0'
  const editorHead = el('div', 'row')
  editorHead.style.cssText = 'justify-content:space-between;align-items:center;margin-bottom:4px'
  editorHead.appendChild(el('span', 'muted', msOpenPath !== null ? `${msOpenPath} · v${msSavedVersion}` : t('manuscript', 'manuscript.editor.noFile')))
  const closeEdit = el('button', 'hbtn ghost', '×')
  closeEdit.title = t('manuscript', 'manuscript.editor.close')
  closeEdit.onclick = () => { msOpenPath = null; msContent = ''; state.rerender() }
  editorHead.appendChild(closeEdit)
  editorCol.appendChild(editorHead)
  if (msOpenPath !== null) {
    const ta = el('textarea')
    ta.value = msContent
    ta.spellcheck = false
    ta.style.cssText = 'flex:1;resize:none;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font:11.5px/1.6 ui-monospace,Menlo,monospace;outline:none;min-height:420px;white-space:pre'
    ta.oninput = () => {
      msContent = ta.value
      // §7 dirty-before-compile: compare against the SAVED content — clearing
      // a non-empty file ('' !== saved) must read dirty; reverting to the
      // saved bytes (including '') must read clean.
      msDirty = isEditorDirty(ta.value, msSavedContent)
      const save = [...(editorCol.querySelectorAll('button') ?? [])].find(b => b.textContent === t('manuscript', 'manuscript.action.save'))
      if (save !== undefined) save.disabled = !msDirty
    }
    ta.onkeydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void msSaveFile()
      }
    }
    editorCol.appendChild(ta)
  } else {
    editorCol.appendChild(el('div', 'empty', t('manuscript', 'manuscript.editor.empty')))
  }
  body.appendChild(editorCol)

  // Diagnostics + PDF preview.
  const rightCol = el('div')
  rightCol.style.cssText = 'width:360px;flex-shrink:0;border:1px solid var(--border);border-radius:10px;padding:8px;overflow-y:auto;max-height:640px'
  // TEX-03 (P0-3): live preview — save success triggers the debounced
  // preview-builds hook; this section shows the projected status
  // (pending/queued/running/succeeded/failed/cancelled/superseded + stale)
  // and the newest succeeded preview's PDF. Browser-visual acceptance of
  // the auto-refresh chain stays NOT_RUN_MANUAL_PENDING (no Playwright).
  rightCol.appendChild(el('div', 'section-label', t('manuscript', 'manuscript.preview.title')))
  const previewModel = previewPanelModel(msPreviewPending, msPreviews, msRevision)
  const previewLine = el('div', 'muted')
  previewLine.style.cssText = 'font-size:10.5px;margin:2px 0 6px'
  previewLine.textContent = t('manuscript', previewModel.headline)
  rightCol.appendChild(previewLine)
  // The embed shows the last SUCCEEDED preview PDF; it is stale whenever the
  // newest preview moved past it (newer queued/running/succeeded revision or
  // the document revision itself advanced past the PDF's build).
  const pdfStale = previewModel.stale || (msPreviewPdfUrl !== null && previewModel.status !== 'succeeded')
  if (pdfStale) {
    const stale = el('span', 'muted')
    stale.style.cssText = 'color:var(--tone-amber);font-size:10px;font-weight:700'
    stale.textContent = t('manuscript', 'manuscript.preview.stale')
    rightCol.appendChild(stale)
  }
  if (msPreviewPdfUrl !== null) {
    const embed = document.createElement('embed')
    embed.src = msPreviewPdfUrl
    embed.type = 'application/pdf'
    embed.style.cssText = 'width:100%;height:280px;border:1px solid var(--border);border-radius:8px'
    rightCol.appendChild(embed)
    const dl = el('button', 'hbtn', t('manuscript', 'manuscript.preview.download'))
    dl.style.cssText = 'margin:6px 0 10px'
    dl.onclick = () => {
      const a = el('a', 'dl', t('common', 'common.action.download'))
      a.href = msPreviewPdfUrl ?? ''
      a.download = 'paper.preview.pdf'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
    rightCol.appendChild(dl)
  }
  rightCol.appendChild(el('div', 'section-label', t('manuscript', 'manuscript.builds')))
  if (msBuilds.length === 0) {
    rightCol.appendChild(el('div', 'muted', t('manuscript', 'manuscript.builds.none')))
  }
  for (const b of msBuilds.slice(0, 6)) {
    const card = el('div', 'card')
    card.style.cssText = 'padding:6px 8px;margin:4px 0'
    const head = el('div', 'row')
    head.style.cssText = 'justify-content:space-between'
    head.appendChild(el('span', 'artifact-kind', b.status.toUpperCase()))
    // Input revision of THIS build (freshness baseline): the kernel freezes
    // the manifest at b.revision; document moves past it make the PDF stale.
    head.appendChild(el('span', 'muted', t('manuscript', 'manuscript.buildMeta', { rev: String(b.revision), build: b.build_id.slice(0, 12) })))
    card.appendChild(head)
    if (b.revision < msRevision) {
      const stale = el('span', 'muted')
      stale.style.cssText = 'color:var(--tone-amber);font-size:10px;font-weight:700'
      stale.textContent = t('manuscript', 'manuscript.builds.stale')
      card.appendChild(stale)
    }
    if (b.job_id !== null && b.job_id !== '') {
      // §4 row 95: cross-link the build to its latex-compile Job's live
      // Terminal (SSE GET /v1/jobs/{job_id}/terminal; same job_id as the
      // Runs/Terminal tab).
      const termBtn = el('button', 'hbtn', '🖥')
      termBtn.title = t('manuscript', 'manuscript.builds.openTerminal')
      termBtn.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      termBtn.onclick = () => {
        state.terminalRunId = b.job_id!
        state.terminalLines = []
        state.terminalLastSeq = 0
        state.terminalTotalBytes = 0
        state.terminalDroppedBytes = 0
        state.terminalTruncated = false
        state.terminalExitCode = null
        state.terminalExitSignal = null
        state.terminalStatus = 'idle'
        terminalLoadSeq()
        state.activeTab = 'terminal'
        tabSave()
        state.rerender()
      }
      card.appendChild(termBtn)
    }
    let diagnostics: Array<{ level: string; message: string }> = []
    try { diagnostics = JSON.parse(b.diagnostics) as Array<{ level: string; message: string }> } catch { /* empty */ }
    if (diagnostics.length > 0) {
      const levels: Record<string, string> = { error: 'var(--tone-red)', warning: 'var(--tone-amber)', info: 'var(--text-3)' }
      for (const d of diagnostics.slice(0, 8)) {
        const row = el('div', 'muted')
        row.style.cssText = `font-size:10.5px;color:${levels[d.level] ?? 'var(--text-3)'};margin-top:2px;white-space:pre-wrap;word-break:break-word`
        row.textContent = `${d.level}: ${d.message}`
        card.appendChild(row)
      }
      if (diagnostics.length > 8) card.appendChild(el('div', 'muted', t('manuscript', 'manuscript.builds.more', { count: String(diagnostics.length - 8) })))
    }
    rightCol.appendChild(card)
  }
  if (msPdfUrl !== null) {
    rightCol.appendChild(el('div', 'section-label', t('manuscript', 'manuscript.pdf.title')))
    const embed = document.createElement('embed')
    embed.src = msPdfUrl
    embed.type = 'application/pdf'
    embed.style.cssText = 'width:100%;height:420px;border:1px solid var(--border);border-radius:8px'
    rightCol.appendChild(embed)
    const dl = el('button', 'hbtn', t('manuscript', 'manuscript.pdf.download'))
    dl.style.cssText = 'margin-top:6px'
    dl.onclick = () => {
      const a = el('a', 'dl', t('common', 'common.action.download'))
      a.href = msPdfUrl ?? ''
      a.download = 'paper.pdf'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
    rightCol.appendChild(dl)
  }
  body.appendChild(rightCol)

  void msPollBuilds()
  void msPollPreviews()
}

