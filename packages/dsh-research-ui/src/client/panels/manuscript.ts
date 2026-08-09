import type { ManuscriptBuild, ManuscriptFile, Projection } from '../types'
import { api, authHeaders, base } from '../api'
import { t } from '../i18n/index'
import { el } from '../ui'
import { state } from '../state'
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
export let msDirty = false
export let msConflict: string | null = null
export let msBuilds: ManuscriptBuild[] = []
export let msBuildPoll: number | undefined
export let msPdfUrl: string | null = null

export function msCleanup(): void {
  if (msBuildPoll !== undefined) { window.clearInterval(msBuildPoll); msBuildPoll = undefined }
  if (msPdfUrl !== null) { URL.revokeObjectURL(msPdfUrl); msPdfUrl = null }
}

export function msLoadDocument(projectId: string): Promise<{ document_id: string }> {
  return api<{ document_id: string }>(`/v1/projects/${encodeURIComponent(projectId)}/manuscript-drafts`, {
    method: 'POST',
    body: JSON.stringify({}),
  }).then(r => r ?? { document_id: '' })
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
  msDirty = false
  msConflict = null
  await msLoadTree()
  state.rerender()
}

export async function msReloadFile(): Promise<void> {
  if (msDocId === null || msOpenPath === null) return
  const file = await api<{ path: string; version: number; content: string }>(`/v1/documents/${encodeURIComponent(msDocId)}/file?path=${encodeURIComponent(msOpenPath)}`)
  if (file !== null) {
    msContent = file.content
    msSavedVersion = file.version
    msDirty = false
    msConflict = null
    state.rerender()
  }
}

export async function msCompile(): Promise<void> {
  if (msDocId === null) return
  if (msDirty) await msSaveFile()
  const result = await api<{ build: ManuscriptBuild }>(`/v1/documents/${encodeURIComponent(msDocId)}/builds`, {
    method: 'POST',
    body: JSON.stringify({ expected_document_revision: msRevision, root_file: 'paper.tex' }),
  })
  if (result === null) return
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
      pdfNow = true
    }
  }
  // Rerender ONLY when something visibly changed. An unconditional
  // state.rerender here plus renderManuscript()'s trailing msPollBuilds() call
  // would form a hot loop: render → poll → state.rerender → render → … at
  // ~5 requests/cycle, exhausting the loopback rate limit in seconds.
  if (before !== JSON.stringify(msBuilds) || pdfNow) state.rerender()
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
  compileBtn.onclick = () => { void msCompile() }
  const refreshBtn = el('button', 'hbtn', '⟳')
  refreshBtn.title = t('manuscript', 'manuscript.action.refresh')
  refreshBtn.onclick = () => { void msLoadTree().then(() => state.rerender()) }
  actions.append(saveBtn, compileBtn, refreshBtn)
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
      msDirty = ta.value !== (msFiles.find(f => f.path === msOpenPath)?.content ?? '')
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
    head.appendChild(el('span', 'muted', `rev ${b.revision} · ${b.build_id.slice(0, 12)}`))
    card.appendChild(head)
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
}

