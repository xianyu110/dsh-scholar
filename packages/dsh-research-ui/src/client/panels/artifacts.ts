import type { ArtifactRow } from '../types'
import { api, authHeaders, base, overlayRoot } from '../api'
import { t } from '../i18n/index'
import { copyText, el, fmtBytes, fmtId, openContextMenu, rootHost, showToast, trapFocus } from '../ui'
import { state } from '../state'
/** Artifact list filter (dsh-web search-as-you-type), persisted per render. */
export let artifactsQuery = ''
/** Artifact kind filter (dsh-web filter chips). */
export let artifactsKind = 'all'


/** Artifacts multi-select (dsh-web bulk download). */
export let artifactsSelecting = false
export let artifactsSelected = new Set<string>()


export async function renderArtifacts(body: HTMLElement, projectId: string): Promise<void> {
  const artifacts = (await api<ArtifactRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`)) ?? []
  const labelRow = el('div', 'row')
  labelRow.style.cssText = 'justify-content:space-between;align-items:center'
  labelRow.appendChild(el('div', 'section-label', t('artifacts', 'artifacts.section', { count: String(artifacts.length) })))
  if (artifacts.length > 0) {
    const selBtn = el('button', 'hbtn', artifactsSelecting ? t('artifacts', 'artifacts.selecting') : t('artifacts', 'artifacts.select'))
    selBtn.title = artifactsSelecting ? t('artifacts', 'artifacts.selecting.title') : t('artifacts', 'artifacts.select.title')
    selBtn.setAttribute('aria-pressed', artifactsSelecting ? 'true' : 'false')
    selBtn.style.cssText = 'padding:1px 10px;margin-bottom:2px'
    selBtn.onclick = () => {
      artifactsSelecting = !artifactsSelecting
      artifactsSelected.clear()
      state.rerender()
    }
    labelRow.appendChild(selBtn)
  }
  body.appendChild(labelRow)
  if (artifacts.length === 0) {
    body.appendChild(el('div', 'empty', t('artifacts', 'artifacts.empty')))
    return
  }
  // dsh-web search-as-you-type: filter the artifact list in place. Only
  // the list below is rebuilt, so the input keeps focus while typing.
  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = t('artifacts', 'artifacts.filterPlaceholder')
  searchInput.value = artifactsQuery
  searchInput.style.cssText = 'flex:1;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font:11px/1.4 system-ui,sans-serif;outline:none;margin:2px 0 4px'
  searchInput.onfocus = () => { searchInput.style.borderColor = 'var(--accent)' }
  searchInput.onblur = () => { searchInput.style.borderColor = 'var(--border)' }
  body.appendChild(searchInput)

  // dsh-web filter chips: restrict by artifact kind (kinds present here).
  const kindCounts = new Map<string, number>()
  for (const a of artifacts) {
    const k = a.kind ?? '?'
    kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1)
  }
  const kindChips = el('div')
  kindChips.style.cssText = 'display:flex;gap:4px;margin:2px 0 6px;flex-wrap:wrap'
  const kindDefs: Array<[string, string]> = [['all', t('artifacts', 'artifacts.kindAll', { count: String(artifacts.length) })], ...[...kindCounts.entries()].slice(0, 8).map(([k, n]) => [k, `${k} (${n})`] as [string, string])]
  const paintKindChips = (): void => {
    for (let i = 0; i < kindDefs.length; i++) {
      const b = kindChips.children[i] as HTMLElement | undefined
      if (b === undefined) continue
      const active = artifactsKind === kindDefs[i]![0]
      b.setAttribute('aria-pressed', active ? 'true' : 'false')
      b.style.cssText = `padding:2px 8px;font-size:10px${active ? ';border-color:var(--accent);color:var(--accent-text);background:var(--accent-soft)' : ''}`
    }
  }
  for (const [key, label] of kindDefs) {
    const chip = el('button', 'hbtn', label)
    chip.onclick = () => {
      artifactsKind = key
      paintKindChips()
      renderList()
    }
    kindChips.appendChild(chip)
  }
  paintKindChips()
  body.appendChild(kindChips)

  const listEl = el('div')
  body.appendChild(listEl)

  const renderList = (): void => {
    listEl.replaceChildren()
    // Bulk download bar.
    if (artifactsSelecting) {
      const bar = el('div', 'card')
      bar.style.cssText = 'padding:8px 10px;margin:4px 0;display:flex;align-items:center;gap:10px;border-color:var(--accent)'
      const count = el('span', 'mono', t('common', 'common.selected', { count: String(artifactsSelected.size) }))
      count.style.cssText = 'font-size:11px;color:var(--text)'
      const downloadSel = el('button', 'btn approve', t('artifacts', 'artifacts.downloadSelected'))
      downloadSel.disabled = artifactsSelected.size === 0
      downloadSel.onclick = async () => {
        let downloaded = 0
        // dsh-web names: prefer the artifact kind/name in the file name.
        const metaById = new Map<string, ArtifactRow>()
        for (const a of artifacts) if (a.artifact_id !== undefined) metaById.set(a.artifact_id, a)
        for (const id of artifactsSelected) {
          const response = await fetch(`${base()}/v1/artifacts/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`, {
            headers: { accept: 'application/octet-stream', ...(await authHeaders()) },
          })
          if (!response.ok) continue
          downloaded += 1
          const blob = await response.blob()
          const url = URL.createObjectURL(blob)
          const a = el('a', 'dl', t('common', 'common.action.download'))
          a.href = url
          const meta = metaById.get(id)
          const metaName = typeof meta?.metadata?.name === 'string' && meta.metadata.name !== ''
            ? String(meta.metadata.name).replaceAll(' ', '-').slice(0, 20)
            : (meta?.kind ?? 'artifact')
          a.download = `${metaName}-${id.slice(0, 12)}.bin`
          document.body.appendChild(a)
          a.click()
          a.remove()
          setTimeout(() => URL.revokeObjectURL(url), 4000)
        }
        showToast(rootHost(), t('artifacts', 'artifacts.downloadedToast', { count: String(downloaded) }))
        artifactsSelecting = false
        artifactsSelected.clear()
        state.rerender()
      }
      const doneSel = el('button', 'hbtn', t('artifacts', 'artifacts.done'))
      doneSel.onclick = () => {
        artifactsSelecting = false
        artifactsSelected.clear()
        state.rerender()
      }
      const allBtn = el('button', 'hbtn', t('artifacts', 'artifacts.all'))
      allBtn.title = t('artifacts', 'artifacts.all.title')
      allBtn.onclick = () => {
        for (const a of artifacts) if (a.artifact_id !== undefined) artifactsSelected.add(a.artifact_id)
        renderList()
      }
      bar.append(count, allBtn, downloadSel, doneSel)
      listEl.appendChild(bar)
    }
    // dsh-web virtualized feel: window artifacts to the newest 15.
    const shownArtifacts = artifacts.slice(-15).reverse()
    if (artifacts.length > 15) {
      const notice = el('div', 'muted', t('artifacts', 'artifacts.showingNewest', { count: String(artifacts.length) }))
      notice.style.cssText = 'font-size:10px;padding:2px;text-align:center'
      listEl.appendChild(notice)
    }
    const kindFiltered = artifactsKind === 'all' ? shownArtifacts : shownArtifacts.filter(a => (a.kind ?? '?') === artifactsKind)
    const q = artifactsQuery.trim().toLowerCase()
    const filtered = q === '' ? kindFiltered : kindFiltered.filter(a =>
      (a.kind ?? '').toLowerCase().includes(q) ||
      (a.artifact_id ?? '').toLowerCase().includes(q) ||
      String(a.metadata?.kind ?? '').toLowerCase().includes(q) ||
      String(a.metadata?.name ?? '').toLowerCase().includes(q),
    )
    if (filtered.length === 0) {
      listEl.appendChild(el('div', 'empty', t('artifacts', 'artifacts.noMatch', { query: artifactsQuery.trim(), kind: artifactsKind !== 'all' ? ` (kind: ${artifactsKind})` : '' })))
      return
    }
    for (const artifact of filtered) {
      const row = el('div', 'artifact-row')
      if (artifactsSelecting && artifact.artifact_id !== undefined) {
        const box = el('span', 'ws-check', artifactsSelected.has(artifact.artifact_id) ? '☑' : '☐')
        box.style.cssText += ';cursor:pointer'
        box.onclick = (event) => {
          event.stopPropagation()
          if (artifact.artifact_id === undefined) return
          if (artifactsSelected.has(artifact.artifact_id)) artifactsSelected.delete(artifact.artifact_id)
          else artifactsSelected.add(artifact.artifact_id)
          renderList()
        }
        row.prepend(box)
        if (artifactsSelected.has(artifact.artifact_id)) row.style.outline = '1px solid var(--accent)'
      }
      row.appendChild(el('span', 'artifact-kind', (artifact.kind ?? '?').toUpperCase()))
      // dsh-web metadata: a human-readable name when the artifact has one.
      if (typeof artifact.metadata?.name === 'string' && artifact.metadata.name !== '') {
        const nameChip = el('span', 'artifact-kind', String(artifact.metadata.name).slice(0, 24))
        nameChip.style.cssText += ';color:var(--text-3)'
        row.appendChild(nameChip)
      }
      const name = el('span', 'grow mono', fmtId(artifact.artifact_id, 22))
      row.appendChild(name)
      // dsh-web metadata: show the artifact kind detail (e.g. code-snapshot-archive).
      const metaKind = typeof artifact.metadata?.kind === 'string' && artifact.metadata.kind !== artifact.kind ? artifact.metadata.kind : ''
      if (metaKind !== '') {
        const chip = el('span', 'artifact-kind', metaKind.slice(0, 22))
        chip.style.cssText += ';color:var(--text-3)'
        row.appendChild(chip)
      }
      row.appendChild(el('span', 'muted', fmtBytes(artifact.size_bytes)))
      row.title = t('artifacts', 'artifacts.rowTitle')
      row.onclick = () => { void previewArtifact(artifact.artifact_id ?? '') }
      // dsh-web context menu: preview / details / copy id.
      row.oncontextmenu = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root == null || artifact.artifact_id === undefined) return
        const aid = artifact.artifact_id
        openContextMenu(root, event.clientX, event.clientY, [
          { label: t('artifacts', 'artifacts.detail.preview'), onPick: () => { void previewArtifact(aid) } },
          { label: `⧉ ${t('common', 'common.action.details')}`, onPick: () => openArtifactDetailModal(root, artifact) },
          { label: t('common', 'common.action.copyId'), hint: aid, onPick: () => copyText(aid) },
        ])
      }
      row.ondblclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root != null) openArtifactDetailModal(root, artifact)
      }
      listEl.appendChild(row)
    }
  }
  searchInput.oninput = () => { artifactsQuery = searchInput.value; renderList() }
  renderList()
}

/** dsh-web artifact drawer: metadata of one CAS artifact. */
export function openArtifactDetailModal(root: ShadowRoot, artifact: ArtifactRow): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:540px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', t('artifacts', 'artifacts.detailModal'))
  const header = el('div', 'modal-header', t('artifacts', 'artifacts.detailModal'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const row = (label: string, value: string): void => {
    const r = el('div', 'row')
    r.style.cssText = 'padding:4px 0;align-items:flex-start'
    const l = el('span', '', label)
    l.style.cssText = 'width:110px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
    const v = el('span', 'mono', value)
    v.style.cssText = 'font-size:11px;color:var(--text);word-break:break-all'
    r.append(l, v)
    modal.appendChild(r)
  }
  const titleRow = el('div', 'row')
  titleRow.style.cssText = 'align-items:center;gap:8px;margin-bottom:8px'
  titleRow.appendChild(el('span', 'artifact-kind', (artifact.kind ?? '?').toUpperCase()))
  titleRow.appendChild(el('span', 'pname', fmtId(artifact.artifact_id ?? '', 30)))
  modal.appendChild(titleRow)

  modal.appendChild(el('div', 'section-label', t('artifacts', 'artifacts.detail.title')))
  row(t('artifacts', 'artifacts.detailArtifact'), String(artifact.artifact_id ?? '—'))
  row(t('artifacts', 'artifacts.detailKind'), String(artifact.kind ?? '—'))
  row(t('artifacts', 'artifacts.detailSize'), fmtBytes(artifact.size_bytes))
  const meta = artifact.metadata
  if (meta !== undefined && Object.keys(meta).length > 0) {
    modal.appendChild(el('div', 'section-label', t('artifacts', 'artifacts.detail.metadata')))
    for (const [k, v] of Object.entries(meta)) {
      row(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
  }
  const previewBtn = el('button', 'hbtn', t('artifacts', 'artifacts.detail.preview'))
  previewBtn.style.cssText = 'margin-top:12px'
  previewBtn.onclick = () => {
    overlay.remove()
    void previewArtifact(artifact.artifact_id ?? '')
  }
  modal.appendChild(previewBtn)
  overlay.appendChild(modal)
  root.appendChild(overlay)
  trapFocus(overlay, null)
}

/** Download link backed by a blob URL (used for non-previewable types). */
export function downloadLink(blob: Blob, name: string): HTMLElement {
  const link = el('a', 'dl', t('common', 'common.action.downloadFile'))
  link.href = URL.createObjectURL(blob)
  link.download = name
  return link
}

/**
 * Fetch an artifact blob through the bridge and show it in a modal.
 * Security (design §15.4): untrusted artifacts are never rendered through
 * HTML-string sinks. SVG/PDF/images are shown via blob URLs (script
 * execution is isolated/disabled in these contexts); HTML is download-only;
 * text is rendered with textContent.
 */
export async function previewArtifact(artifactId: string): Promise<void> {
  try {
    const response = await fetch(`${base()}/v1/artifacts/${encodeURIComponent(artifactId)}`, {
      headers: { accept: 'application/octet-stream', ...(await authHeaders()) },
    })
    if (!response.ok) return
    const blob = await response.blob()
    const root = overlayRoot ?? (document.querySelector('#dsh-scholar-ui')?.shadowRoot ?? null)
    if (root == null) return
    const overlay = el('div', 'overlay')
    const blobUrls: string[] = []
    const revoke = (): void => { for (const url of blobUrls) URL.revokeObjectURL(url) }
    overlay.onclick = (event) => { if (event.target === overlay) { revoke(); overlay.remove() } }
    const modal = el('div', 'modal')
    const contentType = (blob.type ?? '').toLowerCase()
    const header = el('div', 'modal-header', `📦 ${artifactId.slice(0, 28)}${artifactId.length > 28 ? '…' : ''}`)
    if (contentType !== '') {
      // dsh-web metadata: show the served content type in the header.
      const chip = el('span', 'artifact-kind', contentType.slice(0, 24))
      chip.style.cssText += ';color:var(--text-3);font-size:9px'
      header.appendChild(chip)
    }
    const closeBtn = el('button', 'hbtn ghost', '×')
    closeBtn.onclick = () => { revoke(); overlay.remove() }
    header.appendChild(closeBtn)
    modal.appendChild(header)
    const text = contentType.startsWith('text/') ? await blob.text() : undefined
    const trimmed = text?.trim() ?? ''
    const isSvg = contentType === 'image/svg+xml' || trimmed.startsWith('<svg')
    const isHtml = contentType === 'text/html' || /^<!doctype html/i.test(trimmed) || trimmed.startsWith('<html')
    if (isSvg) {
      // SVG as <img src=blobUrl>: no script execution, no HTML-string sink (§15.4).
      const url = URL.createObjectURL(blob)
      blobUrls.push(url)
      const img = document.createElement('img')
      img.src = url
      img.alt = artifactId
      modal.appendChild(img)
      modal.appendChild(downloadLink(blob, artifactId))
    } else if (isHtml) {
      // HTML is untrusted markup: never rendered via HTML strings, download only (§15.4).
      modal.appendChild(el('div', 'warn', t('artifacts', 'artifacts.previewDisabled')))
      modal.appendChild(downloadLink(blob, artifactId))
    } else if (contentType.startsWith('image/')) {
      const url = URL.createObjectURL(blob)
      blobUrls.push(url)
      const img = document.createElement('img')
      img.src = url
      img.alt = artifactId
      modal.appendChild(img)
      modal.appendChild(downloadLink(blob, artifactId))
    } else if (contentType === 'application/pdf') {
      const url = URL.createObjectURL(blob)
      blobUrls.push(url)
      const embed = document.createElement('embed')
      embed.src = url
      embed.type = 'application/pdf'
      embed.style.cssText = 'width:100%;height:60vh'
      modal.appendChild(embed)
      modal.appendChild(downloadLink(blob, artifactId))
    } else {
      const content = text ?? (await blob.text())
      const pre = el('pre', '', content.length > 6000 ? content.slice(0, 6000) + String.fromCharCode(10) + t('artifacts', 'artifacts.truncated') : content)
      pre.className = 'pre'
      modal.appendChild(pre)
      modal.appendChild(downloadLink(blob, artifactId))
    }
    // dsh-web depth: open blob-backed previews in their own browser tab.
    if (blobUrls.length > 0) {
      const openTab = el('button', 'hbtn', t('artifacts', 'artifacts.detail.openTab'))
      openTab.title = t('artifacts', 'artifacts.detail.openTab.title')
      openTab.style.cssText = 'margin-top:10px'
      openTab.onclick = () => {
        const url = blobUrls[blobUrls.length - 1]!
        window.open(url, '_blank', 'noopener')
      }
      modal.appendChild(openTab)
    }
    overlay.appendChild(modal)
    root.appendChild(overlay)
  } catch { /* bridge unreachable */ }
}

