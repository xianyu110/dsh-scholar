import type { Projection } from '../types'
import { api, base } from '../api'
import { getLocale, setLocale, t } from '../i18n/index'
import { openShortcutsModal } from '../modals/commands'
import { accentColor, accentSet, autoRefreshEnabled, autoRefreshSet, chatClear, densityApply, radiusSet, radiusValue, readTheme, state, textureSet, textureValue, writeTheme } from '../state'
import { ACCENTS, ACCENT_DARK, copyText, el, rootHost, showToast, trapFocus } from '../ui'
import { tokenProvider } from '../api'
import { RADII, TEXTURES } from '../state'
/* ─────────────────────────── settings modal ─────────────────────────── */

/**
 * dsh-web "Settings" counterpart: connection status (kernel health +
 * endpoint), access token state, theme and conversation controls. Reads
 * live kernel health through the bridge.
 */
export async function openSettingsModal(root: ShadowRoot | null | undefined): Promise<void> {
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'
  const header = el('div', 'modal-header', t('shell', 'shell.settings.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const section = (title: string): HTMLElement => {
    const label = el('div', 'section-label', title)
    label.style.cssText = 'margin-top:14px'
    return label
  }
  const row = (label: string, value: string, valueClass = 'mono'): void => {
    const r = el('div', 'row')
    r.style.cssText = 'padding:4px 0'
    const l = el('span', '', label)
    l.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
    const v = el('span', valueClass, value)
    v.style.cssText = 'font-size:11px;color:var(--text);word-break:break-all'
    r.append(l, v)
    modal.appendChild(r)
  }

  // Connection: live kernel health through the bridge.
  modal.appendChild(section(t('shell', 'shell.settings.connection')))
  const healthRow = el('div', 'row')
  healthRow.style.cssText = 'padding:4px 0'
  const healthLabel = el('span', '', t('shell', 'shell.settings.kernel'))
  healthLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const healthValue = el('span', 'mono', t('common', 'common.status.checking'))
  healthValue.style.cssText = 'font-size:11px'
  healthRow.append(healthLabel, healthValue)
  modal.appendChild(healthRow)
  const health = await api<{ ok?: boolean; instance?: string }>('/v1/health')
  if (health === null || health.ok !== true) {
    healthValue.textContent = t('common', 'common.status.unreachable')
    healthValue.style.color = 'var(--tone-red)'
  } else {
    healthValue.textContent = t('common', 'common.status.connectedTo', { instance: health.instance ?? '' })
    healthValue.style.color = 'var(--tone-green)'
  }
  row(t('shell', 'shell.settings.bridge'), t('shell', 'shell.settings.bridgeValue'))
  row(t('shell', 'shell.settings.auth'), tokenProvider !== undefined ? t('shell', 'shell.settings.authToken') : t('shell', 'shell.settings.authNone'))
  // dsh-web connection details: the exact bridge endpoint, copyable.
  const bridgeEnd = `${location.origin}${base()}/v1`
  const bridgeRow = el('div', 'row')
  bridgeRow.style.cssText = 'padding:4px 0'
  const bridgeLabel = el('span', '', t('shell', 'shell.settings.endpoint'))
  bridgeLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const bridgeValue = el('span', 'mono', bridgeEnd)
  bridgeValue.style.cssText = 'font-size:11px;color:var(--text);word-break:break-all;flex:1'
  const bridgeCopy = el('button', 'hbtn', '⧉')
  bridgeCopy.title = t('shell', 'shell.settings.copyEndpoint')
  bridgeCopy.style.cssText = 'padding:1px 8px'
  bridgeCopy.onclick = () => copyText(bridgeEnd)
  bridgeRow.append(bridgeLabel, bridgeValue, bridgeCopy)
  modal.appendChild(bridgeRow)

  // Access token (standalone only).
  if (tokenProvider !== undefined) {
    modal.appendChild(section(t('shell', 'shell.settings.access')))
    const tokRow = el('div', 'row')
    tokRow.style.cssText = 'padding:4px 0'
    const tokLabel = el('span', '', t('shell', 'shell.settings.token'))
    tokLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
    const tokValue = el('span', 'mono', '••••••••')
    tokValue.style.cssText = 'font-size:11px'
    const reveal = el('button', 'hbtn', t('common', 'common.action.show'))
    reveal.style.cssText = 'padding:1px 8px'
    reveal.onclick = async () => {
      const tok = await tokenProvider?.()
      tokValue.textContent = tok ?? t('shell', 'shell.settings.tokenNone')
      reveal.remove()
    }
    const copyTok = el('button', 'hbtn', '⧉')
    copyTok.title = t('shell', 'shell.settings.copyToken')
    copyTok.style.cssText = 'padding:1px 8px'
    copyTok.onclick = async () => {
      const tok = await tokenProvider?.()
      if (tok != null) copyText(tok)
    }
    tokRow.append(tokLabel, tokValue, reveal, copyTok)
    modal.appendChild(tokRow)
  }

  // Appearance.
  modal.appendChild(section(t('shell', 'shell.settings.appearance')))
  const themeRow = el('div', 'row')
  themeRow.style.cssText = 'padding:4px 0'
  const themeLabel = el('span', '', t('shell', 'shell.settings.theme'))
  themeLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const themeValue = el('span', 'mono', readTheme() === 'dark' ? 'dark' : 'light')
  themeValue.style.cssText = 'font-size:11px'
  const themeToggle = el('button', 'hbtn', t('common', 'common.action.toggle'))
  themeToggle.style.cssText = 'padding:1px 8px'
  themeToggle.onclick = () => {
    const next = readTheme() === 'dark' ? 'light' : 'dark'
    writeTheme(next)
    const hostEl = root.host as HTMLElement
    hostEl.dataset.theme = next
    themeValue.textContent = next
    // Refresh the header button label too.
    document.dispatchEvent(new Event('dsh-scholar-theme-changed'))
  }
  themeRow.append(themeLabel, themeValue, themeToggle)
  modal.appendChild(themeRow)

  // Preferences: state.density, auto-refresh (dsh-web settings feel).
  modal.appendChild(section(t('shell', 'shell.settings.preferences')))
  const densRow = el('div', 'row')
  densRow.style.cssText = 'padding:4px 0'
  const densLabel = el('span', '', t('shell', 'shell.settings.density'))
  densLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const densValue = el('span', 'mono', state.density === 'compact' ? 'compact' : 'normal')
  densValue.style.cssText = 'font-size:11px'
  const densToggle = el('button', 'hbtn', t('common', 'common.action.toggle'))
  densToggle.style.cssText = 'padding:1px 8px'
  densToggle.onclick = () => {
    state.density = state.density === 'compact' ? 'normal' : 'compact'
    const hostEl = document.querySelector('#dsh-scholar-ui')
    const panelEl = hostEl !== null ? hostEl.shadowRoot?.querySelector('.panel') as HTMLElement | null : null
    if (panelEl !== null) densityApply(panelEl)
    densValue.textContent = state.density
    state.rerender()
  }
  densRow.append(densLabel, densValue, densToggle)
  modal.appendChild(densRow)

  // dsh-web i18n: locale switch (§13.2) — persisted, immediate re-render.
  const localeRow = el('div', 'row')
  localeRow.style.cssText = 'padding:4px 0'
  const localeLabel = el('span', '', t('shell', 'shell.settings.language'))
  localeLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const localeSelect = el('select', 'picker')
  localeSelect.style.cssText = 'flex:1;padding:3px 6px;font-size:11px;border-radius:7px'
  const localeCurrent = getLocale()
  for (const [code, label] of [['zh', t('shell', 'shell.locale.zh')], ['en', t('shell', 'shell.locale.en')]] as Array<[string, string]>) {
    const opt = el('option', '', label)
    opt.value = code
    localeSelect.appendChild(opt)
  }
  localeSelect.value = localeCurrent
  localeSelect.onchange = () => {
    const next = localeSelect.value === 'zh' ? 'zh' : 'en'
    setLocale(next)
    localeSelect.value = next
    document.dispatchEvent(new Event('dsh-scholar-locale-changed'))
    // dsh-web i18n §13.4: the open settings modal re-renders in the new
    // locale immediately (other overlays refresh on their next open).
    overlay.remove()
    void openSettingsModal(root)
  }
  localeRow.append(localeLabel, localeSelect)
  modal.appendChild(localeRow)

  const refreshRow = el('div', 'row')
  refreshRow.style.cssText = 'padding:4px 0'
  const refreshLabel = el('span', '', t('shell', 'shell.settings.autoRefresh'))
  refreshLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const refreshValue = el('span', 'mono', autoRefreshEnabled() ? t('shell', 'shell.settings.polling') : t('shell', 'shell.settings.off'))
  refreshValue.style.cssText = 'font-size:11px'
  const refreshToggle = el('button', 'hbtn', t('common', 'common.action.toggle'))
  refreshToggle.style.cssText = 'padding:1px 8px'
  refreshToggle.onclick = () => {
    const next = !autoRefreshEnabled()
    autoRefreshSet(next)
    if (next && state.refreshTimer === null) state.refreshTimer = state.startRefreshTimer()
    if (!next && state.refreshTimer !== null) {
      window.clearInterval(state.refreshTimer)
      state.refreshTimer = null
    }
    refreshValue.textContent = next ? t('shell', 'shell.settings.polling') : t('shell', 'shell.settings.off')
  }
  refreshRow.append(refreshLabel, refreshValue, refreshToggle)
  modal.appendChild(refreshRow)

  // Accent colour (dsh-web theming).
  const accentRow = el('div', 'row')
  accentRow.style.cssText = 'padding:4px 0'
  const accentLabel = el('span', '', 'Accent')
  accentLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const accentSelect = el('select', 'picker')
  accentSelect.style.cssText = 'flex:1;padding:3px 6px;font-size:11px;border-radius:7px'
  const currentAccent = (Object.entries(ACCENTS).find(([, v]) => v === accentColor())?.[0] ?? 'blue')
  for (const [name, color] of Object.entries(ACCENTS)) {
    const opt = el('option', '', `${name} (${color})`)
    opt.value = name
    accentSelect.appendChild(opt)
  }
  accentSelect.value = currentAccent
  accentSelect.onchange = () => {
    accentSet(accentSelect.value)
    const hostEl = document.querySelector('#dsh-scholar-ui') as HTMLElement | null
    const dark = hostEl?.dataset.theme === 'dark'
    const name = accentSelect.value
    const c = dark ? (ACCENT_DARK[name] ?? accentColor()) : accentColor()
    hostEl?.style.setProperty('--accent', c)
    hostEl?.style.setProperty('--accent-soft', `${c}1f`)
    hostEl?.style.setProperty('--accent-text', c)
    state.rerender()
  }
  accentRow.append(accentLabel, accentSelect)
  modal.appendChild(accentRow)

  // Corner radius (dsh-web appearance).
  const radiusRow = el('div', 'row')
  radiusRow.style.cssText = 'padding:4px 0'
  const radiusLabel = el('span', '', 'Corners')
  radiusLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const radiusSelect = el('select', 'picker')
  radiusSelect.style.cssText = 'flex:1;padding:3px 6px;font-size:11px;border-radius:7px'
  const currentRadius = Object.entries(RADII).find(([, v]) => v === radiusValue())?.[0] ?? 'normal'
  for (const [name, val] of Object.entries(RADII)) {
    const opt = el('option', '', `${name} (${val})`)
    opt.value = name
    radiusSelect.appendChild(opt)
  }
  radiusSelect.value = currentRadius
  radiusSelect.onchange = () => {
    radiusSet(radiusSelect.value)
    const hostEl = document.querySelector('#dsh-scholar-ui') as HTMLElement | null
    hostEl?.style.setProperty('--panel-radius', radiusValue())
    state.rerender()
  }
  radiusRow.append(radiusLabel, radiusSelect)
  modal.appendChild(radiusRow)

  // Background texture (dsh-web appearance).
  const textureRow = el('div', 'row')
  textureRow.style.cssText = 'padding:4px 0'
  const textureLabel = el('span', '', 'Texture')
  textureLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const textureSelect = el('select', 'picker')
  textureSelect.style.cssText = 'flex:1;padding:3px 6px;font-size:11px;border-radius:7px'
  const currentTexture = textureValue()
  for (const name of Object.keys(TEXTURES)) {
    const opt = el('option', '', name)
    opt.value = name
    textureSelect.appendChild(opt)
  }
  textureSelect.value = currentTexture
  textureSelect.onchange = () => {
    textureSet(textureSelect.value)
    const hostEl = document.querySelector('#dsh-scholar-ui') as HTMLElement | null
    if (hostEl !== null) hostEl.dataset.texture = textureValue()
    state.rerender()
  }
  textureRow.append(textureLabel, textureSelect)
  modal.appendChild(textureRow)

  // Conversation.
  modal.appendChild(section(t('shell', 'shell.settings.conversation')))
  const convRow = el('div', 'row')
  convRow.style.cssText = 'padding:4px 0'
  const convLabel = el('span', '', 'Transcript')
  convLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const convValue = el('span', 'mono', `${state.chatSessions.length} session(s) · ${state.chatMessages.length} messages`)
  convValue.style.cssText = 'font-size:11px'
  const clearBtn = el('button', 'hbtn', 'Clear')
  clearBtn.style.cssText = 'padding:1px 8px'
  clearBtn.onclick = () => {
    chatClear()
    convValue.textContent = '0 messages'
    state.rerender()
  }
  convRow.append(convLabel, convValue, clearBtn)
  modal.appendChild(convRow)

  // dsh-web share/summary: copy a markdown summary of the active project.
  modal.appendChild(section(t('shell', 'shell.settings.project')))
  const projRow = el('div', 'row')
  projRow.style.cssText = 'padding:4px 0'
  const projLabel = el('span', '', 'Summary')
  projLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const summaryBtn = el('button', 'hbtn', 'Copy markdown')
  summaryBtn.style.cssText = 'padding:2px 10px'
  summaryBtn.onclick = async () => {
    const id = state.projectId
    if (id === undefined) return
    const p = await api<Projection>(`/v1/projects/${encodeURIComponent(id)}/projection`)
    if (p === null || p.project === undefined) {
      summaryBtn.textContent = 'unavailable'
      return
    }
    const counts = p.counts ?? {}
    const lines = [
      `# ${p.project.name}`,
      '',
      `- Project: \`${id}\``,
      `- Phase: \`${p.project.status}\` (rev ${p.project.revision ?? 0})`,
      `- Problem: ${p.project.brief?.problem ?? '—'}`,
      `- Primary metrics: ${(p.project.brief?.primary_metrics ?? []).join(', ') || '—'}`,
      `- Corpus snapshots: ${counts.corpus_snapshots ?? 0} · Ideas: ${counts.ideas ?? 0} · Contracts: ${counts.contracts ?? 0}`,
      `- Claims: ${counts.claims ?? 0} · Evidence: ${counts.evidence ?? 0} · Artifacts: ${counts.artifacts ?? 0}`,
      `- Pending gates: ${(p.pending_gates ?? []).map(g => `${g.type} (${g.status})`).join(', ') || 'none'}`,
      `- Next: ${(p.next_actions ?? []).join('; ') || '—'}`,
    ]
    await navigator.clipboard.writeText(lines.join('\n'))
    summaryBtn.textContent = '✓ copied'
    setTimeout(() => { summaryBtn.textContent = 'Copy markdown' }, 1800)
  }
  projRow.append(projLabel, summaryBtn)
  modal.appendChild(projRow)

  const about = el('button', 'hbtn', 'ℹ About this plugin')
  about.style.cssText = 'margin-top:16px;padding:3px 12px;align-self:flex-start'
  about.onclick = () => { openAboutModal(root) }
  modal.appendChild(about)

  // dsh-web data management: clear every local preference/transcript.
  modal.appendChild(section(t('shell', 'shell.settings.help')))
  const helpRow = el('div', 'row')
  helpRow.style.cssText = 'padding:4px 0'
  const helpBtn = el('button', 'hbtn', '⌨ Keyboard shortcuts')
  helpBtn.style.cssText = 'padding:2px 10px'
  helpBtn.onclick = () => { overlay.remove(); openShortcutsModal(root) }
  helpRow.appendChild(helpBtn)
  modal.appendChild(helpRow)

  modal.appendChild(section(t('shell', 'shell.settings.data')))
  const resetRow = el('div', 'row')
  resetRow.style.cssText = 'padding:4px 0'
  const resetLabel = el('span', '', 'Local data')
  resetLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const resetBtn = el('button', 'btn cancel', '🗑 Reset preferences')
  resetBtn.style.cssText = 'padding:3px 10px;font-size:11px'
  resetBtn.title = 'clear theme, tabs, sessions, history and notifications (reload to apply)'
  resetBtn.onclick = () => {
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      // The access token survives a preference reset (no forced re-login).
      if (k !== null && k.startsWith('dsh-scholar-ui-') && k !== 'dsh-scholar-ui-token') toRemove.push(k)
    }
    for (const k of toRemove) localStorage.removeItem(k)
    overlay.remove()
    showToast(rootHost(), '🗑 Local preferences cleared — reload the page to apply')
  }
  resetRow.append(resetLabel, resetBtn)
  modal.appendChild(resetRow)

  overlay.appendChild(modal)
  root.appendChild(overlay)
  trapFocus(overlay, null)
}


/* ─────────────────────────── about modal ─────────────────────────── */

/** dsh-web "About": version, architecture and feature-surface summary. */
export function openAboutModal(root: ShadowRoot | null | undefined): void {
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'
  const header = el('div', 'modal-header', 'ℹ About Research OS')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const intro = el('div', 'muted', 'DSH Scholar — Research OS standalone web plugin. A fully self-contained research workspace: plan, run and review experiments with human-gated decisions.')
  intro.style.cssText = 'font-size:12px;line-height:1.6'
  modal.appendChild(intro)

  const row = (label: string, value: string): void => {
    const r = el('div', 'row')
    r.style.cssText = 'padding:4px 0'
    const l = el('span', '', label)
    l.style.cssText = 'width:150px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
    const v = el('span', 'mono', value)
    v.style.cssText = 'font-size:11px;color:var(--text);word-break:break-all'
    r.append(l, v)
    modal.appendChild(r)
  }
  modal.appendChild(el('div', 'section-label', 'Version'))
  row('Plugin', 'v0.2 (hardening branch)')
  row('Surface', 'Research · Execution · Review · Operations')
  row('Kernel', 'Research Kernel (SQLite + CAS)')
  row('Runner', 'docker isolation (baseline/pilot/formal/reproduce)')

  modal.appendChild(el('div', 'section-label', 'Architecture'))
  const arch = el('div', 'muted', 'The plugin serves its own origin with a bundled kernel sidecar. The browser talks to a same-origin /v1 proxy protected by a bearer token and CSRF origin checks (design §15.2/§15.3). Every gate decision is recorded in the kernel ledger with the operator identity; experiment jobs run in disposable containers with Ed25519-signed run manifests.')
  arch.style.cssText = 'font-size:11.5px;line-height:1.6'
  modal.appendChild(arch)

  modal.appendChild(el('div', 'section-label', 'Safety model'))
  const safety = el('div', 'muted', 'gate-only mode: scope / idea / contract / release gates always require a human decision (Approve/Reject in Execution → Approvals or the sidebar). Budget overruns park the project as BLOCKED_GATE until a human Budget Gate approves.')
  safety.style.cssText = 'font-size:11.5px;line-height:1.6'
  modal.appendChild(safety)

  const footer = el('div', 'muted', 'DSH Scholar · standalone Research OS · BSD-3-Clause')
  footer.style.cssText = 'margin-top:16px;font-size:10.5px'
  modal.appendChild(footer)

  overlay.appendChild(modal)
  root.appendChild(overlay)
}

