import type { ArtifactRow, ClaimRow, EvidenceRow, ProjectRow, Projection } from '../types'
import { api } from '../api'
import { registerOverlayRebuild, t } from '../i18n/index'
import { chatSessionSelect, chatSessionsPersist, notifClear, notifMarkRead, notifPersist, state, tabSave } from '../state'
import { STATUS_META, copyText, el, openContextMenu, rootHost, showToast, statusLabel } from '../ui'
import { HISTORY_KEY, favProjects } from '../state'
export function openNotificationsModal(root: ShadowRoot | null | undefined): void {
  if (root == null) return
  notifMarkRead()
  state.rerender()
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:480px;max-width:92vw'
  const header = el('div', 'modal-header', t('shell', 'shell.notifications.title', { count: String(state.notifHistory.length) }))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)
  const list = el('div')
  list.setAttribute('role', 'log')
  list.setAttribute('aria-live', 'polite')
  list.style.cssText = 'max-height:46vh;overflow-y:auto'
  if (state.notifHistory.length === 0) {
    const emptyWrap = el('div')
    emptyWrap.style.cssText = 'padding:28px 10px;text-align:center;display:flex;flex-direction:column;gap:8px;align-items:center'
    emptyWrap.appendChild(el('div', '', '🎉'))
    emptyWrap.appendChild(el('div', 'muted', t('shell', 'shell.notifications.empty')))
    emptyWrap.appendChild(el('div', 'muted', t('shell', 'shell.notifications.emptyHint')))
    list.appendChild(emptyWrap)
  }
  for (let i = state.notifHistory.length - 1; i >= 0; i--) {
    const n = state.notifHistory[i]!
    const row = el('div')
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:6px 4px;border-bottom:1px dashed var(--border-2)'
    const count = n.count ?? 1
    const text = el('div', 'grow', count > 1 ? `${n.text} ×${count}` : n.text)
    if (count > 1) text.style.cssText += ';font-weight:600'
    text.style.cssText += ';font-size:11.5px;color:var(--text);word-break:break-word;cursor:pointer'
    text.title = t('common', 'common.clickToCopy')
    text.onclick = () => copyText(n.text)
    const time = el('span', 'muted', n.time)
    time.style.cssText = 'font-size:9px;flex-shrink:0'
    // dsh-web notification management: dismiss a single entry.
    const del = el('button', 'hbtn ghost', '×')
    del.title = t('shell', 'shell.notifications.dismiss')
    del.setAttribute('aria-label', t('shell', 'shell.notifications.dismissAria'))
    del.style.cssText = 'padding:0 4px;font-size:10px;flex-shrink:0'
    del.onclick = () => {
      state.notifHistory.splice(i, 1)
      notifPersist()
      notifMarkRead()
      overlay.remove()
      openNotificationsModal(root)
    }
    row.append(text, time, del)
    row.onmouseenter = () => { row.style.background = 'var(--bg-hover)' }
    row.onmouseleave = () => { row.style.background = 'none' }
    // dsh-web context menu: copy or dismiss a single notification.
    row.oncontextmenu = (event) => {
      event.preventDefault()
      event.stopPropagation()
      const ctxRoot = rootHost()
      if (ctxRoot === null) return
      openContextMenu(ctxRoot, event.clientX, event.clientY, [
        { label: t('common', 'common.action.copyText'), onPick: () => copyText(n.text) },
        {
          label: t('common', 'common.action.dismiss'),
          danger: true,
          onPick: () => {
            state.notifHistory.splice(i, 1)
            notifPersist()
            notifMarkRead()
            overlay.remove()
            openNotificationsModal(root)
          },
        },
      ])
    }
    list.appendChild(row)
  }
  modal.appendChild(list)
  const clearBtn = el('button', 'hbtn', t('common', 'common.action.clearAll'))
  clearBtn.style.cssText = 'margin-top:10px'
  clearBtn.onclick = () => {
    notifClear()
    overlay.remove()
  }
  modal.appendChild(clearBtn)
  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the modal in the new locale.
  registerOverlayRebuild(overlay, () => { overlay.remove(); openNotificationsModal(root) })
}


/* ─────────────────────────── command history modal ─────────────────────────── */

/**
 * dsh-web command history: every executed command (from the persisted
 * history) in a compact list; clicking one re-fills the composer.
 */
export function openCommandHistoryModal(root: ShadowRoot | null | undefined): void {
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'
  const header = el('div', 'modal-header', t('shell', 'shell.commandHistory.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const hintRow = el('div', 'row')
  hintRow.style.cssText = 'justify-content:space-between;align-items:center;margin-bottom:10px'
  const hint = el('div', 'muted', t('shell', 'shell.commandHistory.hint', { count: String(state.chatHistory.length) }))
  hint.style.cssText = 'font-size:11.5px'
  hintRow.appendChild(hint)
  // dsh-web history management: clear the persisted command list.
  const clearBtn = el('button', 'hbtn', t('common', 'common.action.clear'))
  clearBtn.title = t('shell', 'shell.commandHistory.clearTitle')
  clearBtn.style.cssText = 'padding:1px 10px;flex-shrink:0'
  clearBtn.onclick = () => {
    state.chatHistory = []
    state.historyIndex = -1
    try { localStorage.setItem(HISTORY_KEY, '[]') } catch { /* private mode */ }
    overlay.remove()
    openCommandHistoryModal(root)
  }
  hintRow.appendChild(clearBtn)
  modal.appendChild(hintRow)

  const list = el('div')
  list.style.cssText = 'max-height:46vh;overflow-y:auto'
  if (state.chatHistory.length === 0) {
    list.appendChild(el('div', 'empty', t('shell', 'shell.commandHistory.empty')))
  }
  for (let i = state.chatHistory.length - 1; i >= 0; i--) {
    const line = state.chatHistory[i]!
    const row = el('button')
    row.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;border:0;background:none;color:var(--text);text-align:left;padding:7px 10px;border-radius:8px;cursor:pointer'
    row.onmouseenter = () => { row.style.background = 'var(--bg-hover)' }
    row.onmouseleave = () => { row.style.background = 'none' }
    const idx = el('span', 'artifact-kind', `#${i + 1}`)
    const text = el('span', 'grow mono', line)
    text.style.cssText = 'font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    row.append(idx, text)
    // dsh-web history: copy the command line from the list.
    const copyHist = el('button', 'hbtn', '⧉')
    copyHist.title = t('shell', 'shell.commandHistory.copyTitle')
    copyHist.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
    copyHist.onclick = (event) => {
      event.stopPropagation()
      void navigator.clipboard.writeText(line).then(
        () => { copyHist.textContent = '✓' },
        () => { copyHist.textContent = '✗' },
      )
      setTimeout(() => { copyHist.textContent = '⧉' }, 1600)
    }
    row.append(copyHist)
    // dsh-web context menu: copy or re-run the command.
    row.oncontextmenu = (event) => {
      event.preventDefault()
      event.stopPropagation()
      const ctxRoot = rootHost()
      if (ctxRoot === null) return
      openContextMenu(ctxRoot, event.clientX, event.clientY, [
        { label: t('common', 'common.action.copyCommand'), onPick: () => copyText(line) },
        {
          label: t('shell', 'shell.commandHistory.rerun'),
          onPick: () => {
            overlay.remove()
            state.chatDraft = line
            state.activeTab = 'chat'
            tabSave()
            state.rerender()
          },
        },
      ])
    }
    row.onclick = () => {
      overlay.remove()
      state.chatDraft = line
      state.activeTab = 'chat'
      tabSave()
      state.rerender()
    }
    list.appendChild(row)
  }
  modal.appendChild(list)
  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the history modal.
  registerOverlayRebuild(overlay, () => { overlay.remove(); openCommandHistoryModal(root) })
}


/* ─────────────────────────── global search modal ─────────────────────────── */

/**
 * dsh-web cross-session search: queries every project's claims and
 * evidence for a keyword and lists the hits.
 */
export function openGlobalSearchModal(root: ShadowRoot | null | undefined): void {
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:560px;max-width:92vw'
  const header = el('div', 'modal-header', t('shell', 'shell.globalSearch.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = t('shell', 'shell.globalSearch.placeholder')
  input.value = globalSearchQuery
  input.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 11px;font:12px/1.4 system-ui,sans-serif;outline:none;margin-bottom:10px'
  input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
  input.onblur = () => { input.style.borderColor = 'var(--border)' }
  modal.appendChild(input)

  // dsh-web filter chips: restrict hits by kind (All / Claims / Evidence /
  // Artifacts).
  const chipsRow = el('div')
  chipsRow.style.cssText = 'display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap'
  const GS_KINDS: Array<['all' | 'claim' | 'evidence' | 'artifact', string]> = [
    ['all', t('shell', 'shell.globalSearch.kindAll')], ['claim', t('shell', 'shell.globalSearch.kindClaim')],
    ['evidence', t('shell', 'shell.globalSearch.kindEvidence')], ['artifact', t('shell', 'shell.globalSearch.kindArtifact')],
  ]
  for (const [key, label] of GS_KINDS) {
    const chip = el('button', 'hbtn', label)
    chip.style.cssText = 'padding:2px 10px;font-size:10px'
    const paintChip = (): void => {
      const active = gsKind === key
      chip.setAttribute('aria-pressed', active ? 'true' : 'false')
      chip.style.cssText = `padding:2px 10px;font-size:10px${active ? ';border-color:var(--accent);color:var(--accent-text);background:var(--accent-soft)' : ''}`
    }
    paintChip()
    chip.onclick = () => {
      gsKind = key
      // Re-paint every chip so only the active one is highlighted.
      chipsRow.querySelectorAll('button').forEach((b, i) => {
        const gsKey = GS_KINDS[i]![0]
        const active = gsKey === key
        b.setAttribute('aria-pressed', active ? 'true' : 'false')
        b.style.cssText = `padding:2px 10px;font-size:10px${active ? ';border-color:var(--accent);color:var(--accent-text);background:var(--accent-soft)' : ''}`
      })
      if (input.value.trim() !== '') void runSearch()
    }
    chipsRow.appendChild(chip)
  }
  modal.appendChild(chipsRow)

  const results = el('div')
  results.style.cssText = 'max-height:46vh;overflow-y:auto'
  results.setAttribute('role', 'listbox')
  results.setAttribute('aria-label', t('shell', 'shell.globalSearch.resultsAria'))
  results.appendChild(el('div', 'muted', t('shell', 'shell.globalSearch.hint')))
  modal.appendChild(results)

  // dsh-web keyboard nav: ↑/↓ walk the hits, Enter opens the selected one.
  let selIdx = -1
  const rowEls: HTMLElement[] = []
  const paintSelection = (): void => {
    for (let i = 0; i < rowEls.length; i++) {
      rowEls[i]!.style.background = i === selIdx ? 'var(--bg-hover)' : 'none'
      rowEls[i]!.setAttribute('aria-selected', i === selIdx ? 'true' : 'false')
    }
    rowEls[selIdx]?.scrollIntoView({ block: 'nearest' })
  }

  const runSearch = async (): Promise<void> => {
    const q = input.value.trim().toLowerCase()
    if (q === '') return
    globalSearchQuery = q
    results.replaceChildren(el('div', 'muted', t('shell', 'shell.globalSearch.searching')))
    const projects = (await api<ProjectRow[]>('/v1/projects')) ?? []
    const hits: Array<{ projectId: string; project: string; status?: string; kind: string; text: string }> = []
    for (const p of projects) {
      if (p.project_id === undefined) continue
      const claims = (await api<ClaimRow[]>(`/v1/projects/${encodeURIComponent(p.project_id)}/claims`)) ?? []
      for (const c of claims) {
        if ((c.statement ?? '').toLowerCase().includes(q)) {
          hits.push({ projectId: p.project_id, project: p.name ?? p.project_id, status: p.status, kind: 'claim', text: c.statement ?? '' })
        }
      }
      const evidence = (await api<EvidenceRow[]>(`/v1/projects/${encodeURIComponent(p.project_id)}/evidence`)) ?? []
      for (const e of evidence) {
        const label = `${e.result?.primary_metric ?? 'metric'} = ${e.result?.value ?? '?'} (Δ${e.result?.effect_size ?? '?'})`
        if (label.toLowerCase().includes(q)) {
          hits.push({ projectId: p.project_id, project: p.name ?? p.project_id, status: p.status, kind: 'evidence', text: label })
        }
      }
      const artifacts = (await api<ArtifactRow[]>(`/v1/projects/${encodeURIComponent(p.project_id)}/artifacts`)) ?? []
      for (const a of artifacts) {
        const label = `${a.kind ?? 'artifact'} ${a.artifact_id ?? ''}${typeof a.metadata?.name === 'string' && a.metadata.name !== '' ? ` · ${a.metadata.name}` : ''}`
        if (label.toLowerCase().includes(q)) {
          hits.push({ projectId: p.project_id, project: p.name ?? p.project_id, status: p.status, kind: 'artifact', text: label })
        }
      }
    }
    const kindHits = gsKind === 'all' ? hits : hits.filter(h => h.kind === gsKind)
    globalSearchResults = kindHits
    results.replaceChildren()
    rowEls.length = 0
    selIdx = -1
    if (kindHits.length === 0) {
      results.appendChild(el('div', 'empty', gsKind === 'all'
        ? t('shell', 'shell.globalSearch.noMatch', { query: input.value.trim() })
        : t('shell', 'shell.globalSearch.noMatchKind', { kind: gsKind, query: input.value.trim() })))
      return
    }
    const count = el('div', 'muted', t('shell', 'shell.globalSearch.stats', { hits: String(kindHits.length), projects: String(projects.length) }))
    count.style.cssText = 'margin-bottom:8px;font-size:11px'
    results.appendChild(count)
    // dsh-web live counts: refresh the kind chips with the hit totals.
    const kindTotals: Record<string, number> = { claim: 0, evidence: 0, artifact: 0 }
    for (const h of hits) kindTotals[h.kind] = (kindTotals[h.kind] ?? 0) + 1
    chipsRow.querySelectorAll('button').forEach((b, i) => {
      const [key, label] = GS_KINDS[i]!
      b.textContent = key === 'all' ? t('shell', 'shell.globalSearch.kindAll', { count: String(hits.length) }) : `${label} (${kindTotals[key] ?? 0})`
    })
    for (let i = 0; i < kindHits.length; i++) {
      const h = kindHits[i]!
      const row = el('div')
      row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:6px 4px;border-bottom:1px dashed var(--border-2);border-radius:6px;cursor:pointer'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', 'false')
      // dsh-web icons: visual kind hint per hit.
      const KIND_ICON: Record<string, string> = { claim: '🧾', evidence: '📊', artifact: '📦' }
      row.appendChild(el('span', 'artifact-kind', `${KIND_ICON[h.kind] ?? ''} ${h.kind.toUpperCase()}`))
      const bodyEl = el('div', 'grow')
      bodyEl.style.cssText = 'min-width:0'
      const projEl = el('div', 'muted', h.status !== undefined ? `${h.project} · ${statusLabel(h.status)}` : h.project)
      projEl.style.cssText = 'font-size:10px'
      if (h.status !== undefined) {
        // dsh-web status colour: dot mirroring the sidebar tones.
        const statusDot = el('span')
        statusDot.style.cssText = `width:6px;height:6px;border-radius:50%;background:var(--tone-${STATUS_META[h.status]?.tone ?? 'slate'});display:inline-block;margin-right:4px`
        projEl.prepend(statusDot)
      }
      const textEl = el('div', '', h.text)
      textEl.style.cssText = 'font-size:11.5px;color:var(--text);word-break:break-word'
      bodyEl.append(projEl, textEl)
      row.appendChild(bodyEl)
      // dsh-web depth: copy the hit text straight from the result row.
      const copyHit = el('button', 'hbtn', '⧉')
      copyHit.title = t('shell', 'shell.globalSearch.copyHitTitle')
      copyHit.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      copyHit.onclick = (event) => {
        event.stopPropagation()
        void navigator.clipboard.writeText(h.text).then(
          () => { copyHit.textContent = '✓' },
          () => { copyHit.textContent = '✗' },
        )
        setTimeout(() => { copyHit.textContent = '⧉' }, 1600)
      }
      row.appendChild(copyHit)
      row.onmouseenter = () => { selIdx = i; paintSelection() }
      row.onclick = () => {
        overlay.remove()
        state.projectId = h.projectId
        // dsh-web jump: artifacts open the Artifacts tab, everything else
        // the Evidence tab.
        state.activeTab = h.kind === 'artifact' ? 'artifacts' : 'evidence'
        tabSave()
        state.rerender()
      }
      // dsh-web context menu: copy the hit or open its project.
      row.oncontextmenu = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const ctxRoot = rootHost()
        if (ctxRoot === null) return
        openContextMenu(ctxRoot, event.clientX, event.clientY, [
          { label: t('common', 'common.action.copyText'), onPick: () => copyText(h.text) },
          {
            label: t('common', 'common.action.openProject'),
            onPick: () => {
              overlay.remove()
              state.projectId = h.projectId
              state.activeTab = h.kind === 'artifact' ? 'artifacts' : 'evidence'
              tabSave()
              state.rerender()
            },
          },
        ])
      }
      rowEls.push(row)
      results.appendChild(row)
    }
  }
  input.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (selIdx >= 0 && rowEls[selIdx] !== undefined) {
        // dsh-web jump: open the selected hit's project on the right tab.
        rowEls[selIdx]!.click()
      } else if (rowEls.length > 0 && input.value.trim() === lastQuery) {
        // dsh-web default: Enter with no selection opens the first hit
        // (only when the results match the current query — never stale).
        rowEls[0]!.click()
      } else {
        runSearchSafe()
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rowEls.length === 0) return
      event.preventDefault()
      selIdx = (selIdx + (event.key === 'ArrowDown' ? 1 : -1) + rowEls.length) % rowEls.length
      paintSelection()
    }
  }
  // dsh-web search-as-you-type: live search with a 350ms debounce (Enter
  // still triggers an immediate search).
  let debounceTimer: number | undefined
  let lastQuery = ''
  const runSearchSafe = (): void => {
    lastQuery = input.value.trim()
    void runSearch()
  }
  input.oninput = () => {
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => { runSearchSafe() }, 350)
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the search modal.
  registerOverlayRebuild(overlay, () => { overlay.remove(); openGlobalSearchModal(root) })
  input.focus()
}


/* ─────────────────────────── session search modal ─────────────────────────── */

/** Search every session inside the active project Chat context. */

export function openSessionSearchModal(root: ShadowRoot | null | undefined): void {
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:560px;max-width:92vw'
  const header = el('div', 'modal-header', t('shell', 'shell.sessionSearch.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = t('shell', 'shell.sessionSearch.placeholder')
  input.value = state.chatSessionSearchQuery
  input.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 11px;font:12px/1.4 system-ui,sans-serif;outline:none;margin-bottom:10px'
  input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
  input.onblur = () => { input.style.borderColor = 'var(--border)' }
  modal.appendChild(input)

  const results = el('div')
  results.style.cssText = 'max-height:46vh;overflow-y:auto'
  results.setAttribute('role', 'listbox')
  results.setAttribute('aria-label', t('shell', 'shell.sessionSearch.resultsAria'))
  modal.appendChild(results)

  let selIdx = -1
  const rowEls: HTMLElement[] = []
  const paint = (): void => {
    for (let i = 0; i < rowEls.length; i++) {
      rowEls[i]!.style.background = i === selIdx ? 'var(--bg-hover)' : 'none'
      rowEls[i]!.setAttribute('aria-selected', i === selIdx ? 'true' : 'false')
    }
    rowEls[selIdx]?.scrollIntoView({ block: 'nearest' })
  }

  const runSearch = (): void => {
    const q = state.chatSessionSearchQuery.trim().toLowerCase()
    results.replaceChildren()
    rowEls.length = 0
    selIdx = -1
    if (q === '') {
      results.appendChild(el('div', 'muted', t('shell', 'shell.sessionSearch.hint')))
      return
    }
    const hits: Array<{ sessionId: string; sessionName: string; index: number; role: string; text: string }> = []
    for (const s of state.chatSessions) {
      for (let i = 0; i < s.messages.length; i++) {
        const m = s.messages[i]!
        if (m.text.toLowerCase().includes(q)) {
          hits.push({ sessionId: s.id, sessionName: s.name, index: i, role: m.role, text: m.text })
        }
      }
    }
    if (hits.length === 0) {
      results.appendChild(el('div', 'empty', t('shell', 'shell.sessionSearch.noMatch', { query: state.chatSessionSearchQuery.trim(), count: String(state.chatSessions.length) })))
      return
    }
    const count = el('div', 'muted', t('shell', 'shell.sessionSearch.stats', { hits: String(hits.length), count: String(state.chatSessions.length) }))
    count.style.cssText = 'margin-bottom:8px;font-size:11px'
    results.appendChild(count)
    for (const h of hits.slice(0, 100)) {
      const row = el('div')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', 'false')
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;border-bottom:1px dashed var(--border-2)'
      row.appendChild(el('span', 'artifact-kind', h.sessionName.slice(0, 14)))
      const roleTag = el('span', 'artifact-kind', h.role === 'user' ? 'YOU' : h.role === 'error' ? 'ERR' : 'OS')
      roleTag.style.cssText += ';color:var(--text-3)'
      row.appendChild(roleTag)
      const snippet = el('span', 'grow')
      snippet.style.cssText = 'font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      // dsh-web highlight: mark the matched term inside the snippet.
      const snippetText = h.text.length > 90 ? `${h.text.slice(0, 90)}…` : h.text
      const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const parts = snippetText.split(new RegExp(`(${esc})`, 'gi'))
      for (const part of parts) {
        if (part !== '' && part.toLowerCase() === q) {
          const mark = el('span')
          mark.style.cssText = 'background:var(--tone-amber-bg);color:var(--tone-amber);border-radius:3px'
          mark.textContent = part
          snippet.appendChild(mark)
        } else if (part !== '') {
          snippet.appendChild(document.createTextNode(part))
        }
      }
      row.appendChild(snippet)
      row.onmouseenter = () => { selIdx = rowEls.indexOf(row); paint() }
      row.onclick = () => {
        overlay.remove()
        chatSessionSelect(h.sessionId)
        state.chatDetailIndex = h.index
        state.rerender()
      }
      rowEls.push(row)
      results.appendChild(row)
    }
    if (hits.length > 100) results.appendChild(el('div', 'muted', t('shell', 'shell.sessionSearch.more', { count: String(hits.length - 100) })))
  }
  input.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (selIdx >= 0 && rowEls[selIdx] !== undefined) rowEls[selIdx]!.click()
      else runSearch()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rowEls.length === 0) return
      event.preventDefault()
      selIdx = (selIdx + (event.key === 'ArrowDown' ? 1 : -1) + rowEls.length) % rowEls.length
      paint()
    }
  }
  let debounceTimer: number | undefined
  input.oninput = () => {
    state.chatSessionSearchQuery = input.value
    chatSessionsPersist()
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => { runSearch() }, 300)
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the session search modal
  // (the query is part of the active project Chat context).
  registerOverlayRebuild(overlay, () => { overlay.remove(); openSessionSearchModal(root) })
  input.focus()
}

/* ─────────────────────────── project switcher modal ─────────────────────────── */

/** Quick project switcher (dsh-web Ctrl/Cmd+P): filter + ↑/↓ + Enter. */
export let projectSwitchQuery = ''

export function openProjectSwitcherModal(root: ShadowRoot | null | undefined): void {
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'
  const header = el('div', 'modal-header', t('shell', 'shell.switchProject.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = t('shell', 'shell.switchProject.placeholder')
  input.value = projectSwitchQuery
  input.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 11px;font:12px/1.4 system-ui,sans-serif;outline:none;margin-bottom:10px'
  input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
  input.onblur = () => { input.style.borderColor = 'var(--border)' }
  modal.appendChild(input)

  const list = el('div')
  list.style.cssText = 'max-height:46vh;overflow-y:auto'
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', t('shell', 'shell.switchProject.resultsAria'))
  modal.appendChild(list)

  let selIdx = -1
  const rows: HTMLElement[] = []
  const paint = (): void => {
    for (let i = 0; i < rows.length; i++) {
      rows[i]!.style.background = i === selIdx ? 'var(--bg-hover)' : 'none'
      rows[i]!.setAttribute('aria-selected', i === selIdx ? 'true' : 'false')
    }
    rows[selIdx]?.scrollIntoView({ block: 'nearest' })
  }

  const renderList = (projects: ProjectRow[]): void => {
    list.replaceChildren()
    rows.length = 0
    selIdx = -1
    const q = projectSwitchQuery.trim().toLowerCase()
    let filtered = q === '' ? projects : projects.filter(p =>
      (p.name ?? '').toLowerCase().includes(q) || (p.project_id ?? '').toLowerCase().includes(q),
    )
    // dsh-web starred projects sort first, mirroring the sidebar.
    if (favProjects.size > 0) {
      filtered = [...filtered].sort((a, b) => (favProjects.has(b.project_id ?? '') ? 1 : 0) - (favProjects.has(a.project_id ?? '') ? 1 : 0))
    }
    if (filtered.length === 0) {
      list.appendChild(el('div', 'empty', t('shell', 'shell.switchProject.noMatch', { query: projectSwitchQuery.trim() })))
      return
    }
    for (const p of filtered) {
      if (p.project_id === undefined) continue
      const row = el('div')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', 'false')
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;cursor:pointer'
      const tone = STATUS_META[p.status ?? '']?.tone ?? 'slate'
      const dot = el('span')
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:var(--tone-${tone});flex-shrink:0`
      const name = el('span', 'grow', p.name ?? p.project_id)
      name.style.cssText = 'font-size:11.5px;color:var(--text)'
      const meta = el('span', 'muted mono', `${statusLabel(p.status)} · ${p.project_id.slice(0, 14)}`)
      meta.style.cssText = 'font-size:9.5px'
      row.append(dot, name, meta)
      row.onmouseenter = () => { selIdx = rows.indexOf(row); paint() }
      row.onclick = () => {
        overlay.remove()
        state.projectId = p.project_id
        state.rerender()
        showToast(rootHost(), t('shell', 'shell.switchProject.switched', { name: p.name ?? p.project_id ?? '' }))
      }
      rows.push(row)
      list.appendChild(row)
    }
  }
  input.oninput = () => {
    projectSwitchQuery = input.value
    void api<ProjectRow[]>('/v1/projects').then((projects) => { renderList(projects ?? []) })
  }
  input.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (selIdx >= 0 && rows[selIdx] !== undefined) {
        rows[selIdx]!.click()
      } else if (rows.length > 0) {
        // dsh-web default: Enter with no selection picks the first row.
        rows[0]!.click()
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rows.length === 0) return
      event.preventDefault()
      selIdx = (selIdx + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
      paint()
    }
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the switcher (projectSwitchQuery
  // is module state, so the filter survives the rebuild).
  registerOverlayRebuild(overlay, () => { overlay.remove(); openProjectSwitcherModal(root) })
  input.focus()
  void api<ProjectRow[]>('/v1/projects').then((projects) => { renderList(projects ?? []) })
}

/* ─────────────────────────── compare modal ─────────────────────────── */

/**
 * dsh-web compare: side-by-side status/budget/counts table for selected
 * projects.
 */

export async function openCompareModal(root: ShadowRoot, projectIds: string[]): Promise<void> {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:720px;max-width:96vw'
  const header = el('div', 'modal-header', t('shell', 'shell.compare.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const loading = el('div', 'muted', t('common', 'common.status.loading'))
  modal.appendChild(loading)
  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the compare modal.
  registerOverlayRebuild(overlay, () => { overlay.remove(); void openCompareModal(root, projectIds) })

  const rows: Array<{ label: string; values: string[] }> = []
  const projections = await Promise.all(projectIds.map(id => api<Projection>(`/v1/projects/${encodeURIComponent(id)}/projection`)))
  const valid = projections.filter((p): p is Projection => p !== null && p.project !== undefined)
  if (valid.length < 2) {
    loading.textContent = t('shell', 'shell.compare.needTwo')
    return
  }
  modal.removeChild(loading)

  const labels = valid.map(p => p.project!.name ?? p.project!.project_id!)
  const cell = (text: string, head = false): HTMLElement => {
    const c = el('div', head ? 'pname' : '')
    c.style.cssText = `padding:5px 10px;font-size:11px;color:var(--text);border-bottom:1px solid var(--border-2);${head ? 'font-weight:700' : ''}`
    c.textContent = text
    return c
  }
  const addRow = (label: string, get: (p: Projection) => string): void => {
    rows.push({ label, values: valid.map(get) })
  }
  addRow(t('shell', 'shell.compare.rowPhase'), p => `${p.project!.status ?? '?'} (rev ${p.project!.revision ?? 0})`)
  addRow(t('budget', 'budget.section'), p => `$${p.budget?.model_cost_usd ?? 0} / ${p.project!.constraints?.max_model_cost_usd ?? '∞'}`)
  addRow(t('budget', 'budget.gpuHours'), p => `${p.budget?.gpu_hours ?? 0} / ${p.project!.constraints?.max_gpu_hours ?? '∞'}`)
  addRow(t('shell', 'shell.compare.rowIdeas'), p => String(p.counts?.ideas ?? 0))
  addRow(t('shell', 'shell.compare.rowContracts'), p => String(p.counts?.contracts ?? 0))
  addRow(t('shell', 'shell.compare.rowClaims'), p => String(p.counts?.claims ?? 0))
  addRow(t('shell', 'shell.compare.rowEvidence'), p => String(p.counts?.evidence ?? 0))
  addRow(t('shell', 'shell.compare.rowArtifacts'), p => String(p.counts?.artifacts ?? 0))
  addRow(t('shell', 'shell.compare.rowRuns'), p => String((p.jobs ?? []).length))
  addRow(t('shell', 'shell.compare.rowPendingGates'), p => String((p.pending_gates ?? []).length))

  const table = el('div')
  table.style.cssText = `display:grid;grid-template-columns:140px repeat(${valid.length}, 1fr);gap:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;max-height:60vh;overflow-y:auto`
  // header row
  table.appendChild(cell('', true))
  for (let i = 0; i < labels.length; i++) {
    const headCell = cell(labels[i]!, true)
    // dsh-web depth: click a column header to open that project.
    const pid = valid[i]!.project!.project_id
    if (pid !== undefined) {
      headCell.style.cursor = 'pointer'
      headCell.title = t('shell', 'shell.compare.openLabel', { label: labels[i]! })
      headCell.onclick = () => {
        overlay.remove()
        state.projectId = pid
        state.rerender()
      }
    }
    table.appendChild(headCell)
  }
  for (const r of rows) {
    table.appendChild(cell(r.label))
    for (const v of r.values) table.appendChild(cell(v))
  }
  modal.appendChild(table)
  // dsh-web data viz: highlight the best (max) and worst (min) numeric
  // cell per row (only pure-number cells count, e.g. Ideas/Claims counts).
  const numeric = (s: string): number | null => /^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s.trim()) : null
  const gridCells = [...table.querySelectorAll('div')] as HTMLElement[]
  const perRow = valid.length + 1
  for (let r = 0; r < rows.length; r++) {
    const values: Array<number | null> = []
    for (let c = 1; c < perRow; c++) values.push(numeric(gridCells[(r + 1) * perRow + c]?.textContent ?? ''))
    const nums = values.filter((v): v is number => v !== null)
    if (nums.length < 2) continue
    const max = Math.max(...nums)
    const min = Math.min(...nums)
    for (let c = 1; c < perRow; c++) {
      const v = values[c - 1]
      if (v === null) continue
      const cellEl = gridCells[(r + 1) * perRow + c]!
      if (v === max) cellEl.style.color = 'var(--tone-green)'
      else if (v === min) cellEl.style.color = 'var(--tone-red)'
    }
  }
  // dsh-web export: download the comparison as CSV, or copy as markdown.
  const exportRow = el('div', 'row')
  exportRow.style.cssText = 'margin-top:10px;gap:8px'
  const exportCsv = el('button', 'hbtn', t('common', 'common.action.exportCsv'))
  exportCsv.title = t('shell', 'shell.compare.exportCsvTitle')
  exportCsv.onclick = () => {
    const lines = [
      [t('shell', 'shell.compare.labelHeader'), ...labels],
      ...rows.map(r => [r.label, ...r.values]),
    ]
    const csv = lines.map(line => line.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = el('a', 'dl', t('common', 'common.action.download'))
    a.href = url
    a.download = `compare-${labels.join('-').replaceAll(' ', '-').slice(0, 60)}-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }
  const copyMd = el('button', 'hbtn', t('common', 'common.action.copyMd'))
  copyMd.title = t('shell', 'shell.compare.copyMdTitle')
  copyMd.onclick = () => {
    const lines = [
      [t('shell', 'shell.compare.labelHeader'), ...labels],
      ...rows.map(r => [r.label, ...r.values]),
    ]
    const md = lines.map(line => `| ${line.join(' | ')} |`).join('\n')
    void navigator.clipboard.writeText(md).then(
      () => { copyMd.textContent = t('common', 'common.action.copied') },
      () => { copyMd.textContent = t('common', 'common.action.copyFailed') },
    )
    setTimeout(() => { copyMd.textContent = t('common', 'common.action.copyMd') }, 1600)
  }
  exportRow.append(exportCsv, copyMd)
  modal.appendChild(exportRow)
}


/** Global search state (dsh-web cross-session search). */
let globalSearchOpen = false
let globalSearchQuery = ''
let globalSearchResults: Array<{ project: string; kind: string; text: string }> = []
/** Global search kind filter (dsh-web filter chips). */
let gsKind: 'all' | 'claim' | 'evidence' | 'artifact' = 'all'
