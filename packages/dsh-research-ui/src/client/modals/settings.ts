import type { Projection } from '../types'
import { api, base } from '../api'
import { getLocale, registerOverlayRebuild, setLocale, t } from '../i18n/index'
import { openShortcutsModal } from '../modals/commands'
import { accentColor, accentSet, autoRefreshEnabled, autoRefreshSet, chatClear, radiusSet, radiusValue, readTheme, state, textureSet, textureValue, writeTheme } from '../state'
import { ACCENTS, ACCENT_DARK, copyText, el, rootHost, showToast, trapFocus } from '../ui'
import { tokenProvider } from '../api'
import { RADII, TEXTURES } from '../state'
import {
  configPinChanged, settingsConfigModel, settingsConfigPin, settingsConfigWrite,
  settingsFieldDisplay, settingsKey, settingsSectionsForData,
} from '../settings-model'
import type { SettingsConfigField, SettingsEffectiveWire, SettingsSchemaWire } from '../settings-model'
/* ─────────────────────────── settings modal ─────────────────────────── */

/**
 * dsh-web "Settings" counterpart with UI-SIMPLE-01 progressive disclosure
 * (acceptance-tests.md §8 ui-settings) + CONFIG-01 dynamic generation
 * (hardening §5 P1 CONFIG-01/UI-02/UI-03): every section is an Accordion
 * that starts COLLAPSED (defaultCollapsed in the pure settingsSections()
 * model), each item carries its source / effective-status line, and the
 * config surface is GENERATED from GET /v1/config/schema +
 * GET /v1/config/effective — one section per ConfigScope with every field
 * showing its current (server-redacted) value, scope, declared sources,
 * hot-reload verdict, security-floor marker and validation metadata.
 * Secrets are never echoed (the server effective view is already redacted;
 * the client only renders the set-but-hidden mask, never a plaintext). The
 * effective config pin is shown with a change hint; the write surface does
 * not exist in this revision, so the submit button is disabled with the
 * honest read-only note. When the registry data is unavailable the honest
 * placeholder sections remain (settingsSectionsForData(false)). Rows
 * without a static value are dynamic slots filled below with live controls
 * (kernel health, selects, toggles). All copy goes through t()/settingsKey()
 * — no hardcoded chrome (i18n §8).
 */
export async function openSettingsModal(root: ShadowRoot | null | undefined): Promise<void> {
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:560px;max-width:92vw'
  const header = el('div', 'modal-header', t('shell', 'shell.settings.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  // Accordion expand memory (optional): sections start collapsed; only a
  // user-expanded section stays open across re-opens.
  const SETTINGS_OPEN_KEY = 'dsh-scholar-ui-settings-open'
  const settingsOpenLoad = (): Set<string> => {
    try {
      const raw = localStorage.getItem(SETTINGS_OPEN_KEY)
      const parsed = raw !== null ? JSON.parse(raw) as unknown : null
      return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
    } catch { /* private mode */ }
    return new Set()
  }
  const settingsOpenPersist = (open: Set<string>): void => {
    try { localStorage.setItem(SETTINGS_OPEN_KEY, JSON.stringify([...open])) } catch { /* private mode */ }
  }
  const openSections = settingsOpenLoad()

  // One kernel health probe serves the connection section; the CONFIG-01
  // surface (schema + effective) drives the dynamic config sections.
  const [health, schema, effective] = await Promise.all([
    api<{ ok?: boolean; instance?: string; config_pin?: string }>('/v1/health'),
    api<SettingsSchemaWire>('/v1/config/schema'),
    api<SettingsEffectiveWire>('/v1/config/effective'),
  ])
  const hasConfig = schema !== null && effective !== null &&
    typeof effective.config === 'object' && effective.config !== null
  const dynamicSections = hasConfig && schema !== null && effective !== null
    ? settingsConfigModel(schema, effective)
    : []

  /** One Accordion section (head + collapsible body, expand memory). */
  const makeAccordion = (id: string, title: string, summary: string, defaultCollapsed: boolean):
    { acc: HTMLElement; head: HTMLButtonElement; body: HTMLElement } => {
    const acc = el('div', 'settings-section')
    acc.dataset.section = id
    const open = openSections.has(id) || !defaultCollapsed
    acc.dataset.open = open ? 'true' : 'false'
    const head = el('button', 'settings-section-head')
    head.id = `settings-head-${id}`
    head.setAttribute('aria-expanded', open ? 'true' : 'false')
    head.setAttribute('aria-controls', `settings-body-${id}`)
    head.setAttribute('aria-label', t('shell', 'shell.settings.accordion.toggle', { title }))
    const caret = el('span', 'settings-section-caret', '▸')
    const titleEl = el('span', '', title)
    const summaryEl = el('span', 'settings-section-summary', summary)
    head.append(caret, titleEl, summaryEl)
    head.onclick = () => {
      const next = acc.dataset.open !== 'true'
      acc.dataset.open = next ? 'true' : 'false'
      head.setAttribute('aria-expanded', next ? 'true' : 'false')
      if (next) openSections.add(id)
      else openSections.delete(id)
      settingsOpenPersist(openSections)
    }
    acc.appendChild(head)
    const body = el('div', 'settings-section-body')
    body.id = `settings-body-${id}`
    acc.appendChild(body)
    return { acc, head, body }
  }

  // ── static sections (connection/appearance/preferences + config
  // provenance; placeholders only when the registry data is unavailable) ──
  for (const section of settingsSectionsForData(hasConfig)) {
    const { acc, body } = makeAccordion(section.id, settingsKey(section.titleKey), settingsKey(section.summaryKey), section.defaultCollapsed)
    for (const row of section.rows) {
      const rowEl = el('div', 'settings-row')
      rowEl.dataset.row = row.id
      rowEl.appendChild(el('span', 'settings-row-label', settingsKey(row.labelKey)))
      const slot = el('div', 'settings-row-slot')
      slot.dataset.slot = row.id
      if (row.valueKey !== undefined) {
        slot.appendChild(el('span', 'mono', settingsKey(row.valueKey, row.valueParams)))
      }
      if (row.actionKey !== undefined) {
        const btn = el('button', 'hbtn', settingsKey(row.actionKey))
        btn.dataset.action = row.id
        btn.style.cssText = 'padding:2px 10px'
        slot.appendChild(btn)
      }
      rowEl.appendChild(slot)
      body.appendChild(rowEl)
    }
    modal.appendChild(acc)
  }

  // ── CONFIG-01 dynamic sections: one Accordion per ConfigScope generated
  // from /v1/config/schema + /v1/config/effective (replaces the runner /
  // workspace / terminal / tex / agent placeholders) ──
  if (dynamicSections.length > 0) {
    /** One schema field row: label + value (secret-masked) + meta + desc. */
    const renderConfigField = (field: SettingsConfigField): HTMLElement => {
      const row = el('div', 'settings-row settings-row-stack')
      row.dataset.row = `config.${field.key}`
      row.appendChild(el('span', 'settings-row-label', settingsKey(field.labelKey)))
      const slot = el('div', 'settings-row-slot')
      const display = settingsFieldDisplay(field)
      const valueEl = el('span', 'mono settings-field-value')
      if (display.kind === 'secret') {
        // SecretRef future note: the server effective view is already
        // redacted; the client only renders the mask, never a plaintext.
        valueEl.textContent = t('shell', 'shell.settings.secretSet')
        valueEl.style.color = 'var(--text-2)'
        slot.appendChild(valueEl)
      } else if (display.kind === 'none') {
        valueEl.textContent = t('shell', 'shell.settings.valueNone')
        slot.appendChild(valueEl)
      } else {
        valueEl.textContent = String(display.value ?? '') || '—'
        if (display.kind === 'absent') {
          const note = el('span', 'muted', settingsKey('shell.settings.notInEffective'))
          note.style.cssText = 'font-size:10px'
          slot.append(valueEl, note)
        } else {
          slot.appendChild(valueEl)
        }
      }
      // meta chips: scope · sources · reload verdict · floor · env
      const meta = el('div', 'settings-field-meta')
      const chips: Array<{ text: string; color: string }> = [
        { text: t('shell', 'shell.settings.scopeLabel', { scope: settingsKey(`shell.settings.scope.${field.scope}`) }), color: '' },
        { text: t('shell', 'shell.settings.sourcesLabel', { sources: field.sources.join('/') }), color: '' },
        {
          text: field.reload === 'hot' ? t('shell', 'shell.settings.reloadHot') : t('shell', 'shell.settings.reloadRestart'),
          color: field.reload === 'hot' ? 'var(--tone-green)' : 'var(--tone-amber)',
        },
      ]
      if (field.securityFloor) chips.push({ text: t('shell', 'shell.settings.securityFloor'), color: 'var(--tone-red)' })
      if (field.env !== undefined) chips.push({ text: t('shell', 'shell.settings.envAlias', { env: field.env }), color: '' })
      for (const chip of chips) {
        const chipEl = el('span', 'settings-chip', chip.text)
        if (chip.color !== '') chipEl.style.color = chip.color
        meta.appendChild(chipEl)
      }
      slot.appendChild(meta)
      if (field.description !== '') {
        // raw registry description — wire/model text displayed verbatim (§8 line 115)
        slot.appendChild(el('div', 'settings-field-desc', field.description))
      }
      row.appendChild(slot)
      return row
    }

    const configSectionEl = modal.querySelector('[data-section="config"]')
    const holder = el('div')
    for (const section of dynamicSections) {
      if (section.fields.length === 0) continue
      const { acc, body } = makeAccordion(section.id, settingsKey(section.titleKey), settingsKey(section.summaryKey), true)
      for (const field of section.fields) body.appendChild(renderConfigField(field))
      holder.appendChild(acc)
    }
    // Read-only footer: no PUT /v1/config (or project PATCH) in this
    // revision — submit is disabled with the honest note.
    const write = settingsConfigWrite()
    const footer = el('div', 'settings-readonly-note')
    footer.appendChild(el('span', '', settingsKey(write.noteKey)))
    const saveBtn = el('button', 'hbtn', t('common', 'common.action.save'))
    saveBtn.disabled = true
    saveBtn.style.cssText = 'padding:2px 10px;opacity:.5;cursor:not-allowed'
    footer.appendChild(saveBtn)
    holder.appendChild(footer)
    if (configSectionEl !== null) modal.insertBefore(holder, configSectionEl)
    else modal.appendChild(holder)
  }

  /** Dynamic-slot lookup: rows without a static value get live controls. */
  const slot = (sectionId: string, rowId: string): HTMLElement | null =>
    modal.querySelector(`[data-section="${sectionId}"] [data-slot="${rowId}"]`)
  const actionBtn = (rowId: string): HTMLElement | null =>
    modal.querySelector(`[data-action="${rowId}"]`)

  // ── connection: live kernel health, auth state, endpoint + token ──
  const kernelSlot = slot('connection', 'connection.kernel')
  if (kernelSlot !== null) {
    const up = health !== null && health.ok === true
    const value = el('span', 'mono', up
      ? t('common', 'common.status.connectedTo', { instance: health?.instance ?? '' })
      : t('common', 'common.status.unreachable'))
    value.style.cssText = 'font-size:11px'
    value.style.color = up ? 'var(--tone-green)' : 'var(--tone-red)'
    kernelSlot.appendChild(value)
  }
  const authSlot = slot('connection', 'connection.auth')
  if (authSlot !== null) {
    authSlot.appendChild(el('span', 'mono', tokenProvider !== undefined
      ? t('shell', 'shell.settings.authToken')
      : t('shell', 'shell.settings.authNone')))
  }
  const endpointSlot = slot('connection', 'connection.endpoint')
  if (endpointSlot !== null) {
    const bridgeEnd = `${location.origin}${base()}/v1`
    const value = el('span', 'mono', bridgeEnd)
    value.style.cssText = 'flex:1'
    const copy = el('button', 'hbtn', '⧉')
    copy.title = t('shell', 'shell.settings.copyEndpoint')
    copy.style.cssText = 'padding:1px 8px'
    copy.onclick = () => copyText(bridgeEnd)
    endpointSlot.append(value, copy)
  }
  // Access token row (standalone only); hidden without a token provider.
  const tokenRow = modal.querySelector('[data-section="connection"] [data-row="connection.token"]')
  if (tokenProvider !== undefined && tokenRow !== null) {
    const tokenSlot = slot('connection', 'connection.token')
    if (tokenSlot !== null) {
      const value = el('span', 'mono', '••••••••')
      const reveal = el('button', 'hbtn', t('common', 'common.action.show'))
      reveal.style.cssText = 'padding:1px 8px'
      reveal.onclick = async () => {
        const tok = await tokenProvider?.()
        value.textContent = tok ?? t('shell', 'shell.settings.tokenNone')
        reveal.remove()
      }
      const copyTok = el('button', 'hbtn', '⧉')
      copyTok.title = t('shell', 'shell.settings.copyToken')
      copyTok.style.cssText = 'padding:1px 8px'
      copyTok.onclick = async () => {
        const tok = await tokenProvider?.()
        if (tok != null) copyText(tok)
      }
      tokenSlot.append(value, reveal, copyTok)
    }
  } else {
    tokenRow?.remove()
  }

  // ── appearance: theme / accent / corners / texture ──
  const themeSlot = slot('appearance', 'appearance.theme')
  if (themeSlot !== null) {
    const value = el('span', 'mono', readTheme() === 'dark' ? 'dark' : 'light')
    const toggle = el('button', 'hbtn', t('common', 'common.action.toggle'))
    toggle.style.cssText = 'padding:1px 8px'
    toggle.onclick = () => {
      const next = readTheme() === 'dark' ? 'light' : 'dark'
      writeTheme(next)
      const hostEl = root.host as HTMLElement
      hostEl.dataset.theme = next
      value.textContent = next
      // Refresh the header button label too.
      document.dispatchEvent(new Event('dsh-scholar-theme-changed'))
    }
    themeSlot.append(value, toggle)
  }
  const accentSlot = slot('appearance', 'appearance.accent')
  if (accentSlot !== null) {
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
    accentSlot.appendChild(accentSelect)
  }
  const radiusSlot = slot('appearance', 'appearance.corners')
  if (radiusSlot !== null) {
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
    radiusSlot.appendChild(radiusSelect)
  }
  const textureSlot = slot('appearance', 'appearance.texture')
  if (textureSlot !== null) {
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
    textureSlot.appendChild(textureSelect)
  }
  // ── preferences: language / auto-refresh / transcript / summary / actions ──
  const localeSlot = slot('preferences', 'preferences.language')
  if (localeSlot !== null) {
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
      // dsh-web i18n §13.4: setLocale re-paints the shell chrome, re-renders
      // the active panel and rebuilds every open overlay (this modal
      // included) via the overlay registry — no manual reopen needed.
      setLocale(next)
      document.dispatchEvent(new Event('dsh-scholar-locale-changed'))
    }
    localeSlot.appendChild(localeSelect)
  }
  const refreshSlot = slot('preferences', 'preferences.autoRefresh')
  if (refreshSlot !== null) {
    const value = el('span', 'mono', autoRefreshEnabled() ? t('shell', 'shell.settings.polling') : t('shell', 'shell.settings.off'))
    const toggle = el('button', 'hbtn', t('common', 'common.action.toggle'))
    toggle.style.cssText = 'padding:1px 8px'
    toggle.onclick = () => {
      const next = !autoRefreshEnabled()
      autoRefreshSet(next)
      if (next && state.refreshTimer === null) state.refreshTimer = state.startRefreshTimer()
      if (!next && state.refreshTimer !== null) {
        window.clearInterval(state.refreshTimer)
        state.refreshTimer = null
      }
      value.textContent = next ? t('shell', 'shell.settings.polling') : t('shell', 'shell.settings.off')
    }
    refreshSlot.append(value, toggle)
  }
  const transcriptSlot = slot('preferences', 'preferences.transcript')
  if (transcriptSlot !== null) {
    const value = el('span', 'mono', t('shell', 'shell.settings.transcriptValue', { sessions: String(state.chatSessions.length), messages: String(state.chatMessages.length) }))
    const clearBtn = el('button', 'hbtn', t('common', 'common.action.clear'))
    clearBtn.style.cssText = 'padding:1px 8px'
    clearBtn.onclick = () => {
      chatClear()
      value.textContent = t('shell', 'shell.settings.zeroMessages')
      state.rerender()
    }
    transcriptSlot.append(value, clearBtn)
  }
  const summarySlot = slot('preferences', 'preferences.summary')
  if (summarySlot !== null) {
    const summaryBtn = el('button', 'hbtn', t('common', 'common.action.copyMarkdown'))
    summaryBtn.style.cssText = 'padding:2px 10px'
    summaryBtn.onclick = async () => {
      const id = state.projectId
      if (id === undefined) return
      const p = await api<Projection>(`/v1/projects/${encodeURIComponent(id)}/projection`)
      if (p === null || p.project === undefined) {
        summaryBtn.textContent = t('common', 'common.status.unavailable')
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
      summaryBtn.textContent = t('common', 'common.action.copied')
      setTimeout(() => { summaryBtn.textContent = t('common', 'common.action.copyMarkdown') }, 1800)
    }
    summarySlot.appendChild(summaryBtn)
  }
  const shortcutsBtn = actionBtn('preferences.shortcuts')
  shortcutsBtn?.addEventListener('click', () => { overlay.remove(); openShortcutsModal(root) })
  const aboutBtn = actionBtn('preferences.about')
  aboutBtn?.addEventListener('click', () => openAboutModal(root))
  const resetBtn = actionBtn('preferences.localData')
  if (resetBtn !== null) {
    resetBtn.classList.add('cancel')
    resetBtn.title = t('shell', 'shell.settings.resetTitle')
    resetBtn.onclick = () => {
      const toRemove: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        // The access token survives a preference reset (no forced re-login).
        if (k !== null && k.startsWith('dsh-scholar-ui-') && k !== 'dsh-scholar-ui-token') toRemove.push(k)
      }
      for (const k of toRemove) localStorage.removeItem(k)
      overlay.remove()
      showToast(rootHost(), t('shell', 'shell.settings.resetDone'))
    }
  }

  // ── config provenance: effective config pin from the CONFIG-01 surface
  // (fallback: kernel health config_pin) with a change hint vs the last
  // seen pin (persisted locally — the pin changes with ANY config change,
  // including secrets, so a change means the running config moved) ──
  const pinSlot = slot('config', 'config.pin')
  if (pinSlot !== null) {
    const pin = effective !== null ? settingsConfigPin(effective) : health?.config_pin
    if (pin !== undefined) {
      pinSlot.appendChild(el('span', 'mono', t('shell', 'shell.settings.configPinValue', { pin })))
      const PIN_KEY = 'dsh-scholar-ui-config-pin'
      let previous: string | null = null
      try { previous = localStorage.getItem(PIN_KEY) } catch { /* private mode */ }
      if (configPinChanged(previous ?? undefined, pin)) {
        const hint = el('span', '', t('shell', 'shell.settings.configPinChanged'))
        hint.style.cssText = 'font-size:10.5px;color:var(--tone-amber)'
        pinSlot.appendChild(hint)
      }
      try { localStorage.setItem(PIN_KEY, pin) } catch { /* private mode */ }
    } else {
      pinSlot.appendChild(el('span', 'mono', t('shell', 'shell.settings.configPinNone')))
    }
  }

  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the settings modal in the
  // new locale (setLocale → relocalizeOpenOverlays).
  registerOverlayRebuild(overlay, () => { overlay.remove(); void openSettingsModal(root) })
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
  const header = el('div', 'modal-header', t('shell', 'shell.about.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const intro = el('div', 'muted', t('shell', 'shell.about.intro'))
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
  modal.appendChild(el('div', 'section-label', t('shell', 'shell.about.version')))
  row(t('shell', 'shell.about.rowPlugin'), 'v0.2 (hardening branch)')
  row(t('shell', 'shell.about.rowSurface'), 'Research · Execution · Review · Operations')
  row(t('shell', 'shell.about.rowKernel'), 'Research Kernel (SQLite + CAS)')
  row(t('shell', 'shell.about.rowRunner'), 'docker isolation (baseline/pilot/formal/reproduce)')

  modal.appendChild(el('div', 'section-label', t('shell', 'shell.about.architecture')))
  const arch = el('div', 'muted', t('shell', 'shell.about.architectureText'))
  arch.style.cssText = 'font-size:11.5px;line-height:1.6'
  modal.appendChild(arch)

  modal.appendChild(el('div', 'section-label', t('shell', 'shell.about.safety')))
  const safety = el('div', 'muted', t('shell', 'shell.about.safetyText'))
  safety.style.cssText = 'font-size:11.5px;line-height:1.6'
  modal.appendChild(safety)

  const footer = el('div', 'muted', t('shell', 'shell.about.footer'))
  footer.style.cssText = 'margin-top:16px;font-size:10.5px'
  modal.appendChild(footer)

  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the about modal.
  registerOverlayRebuild(overlay, () => { overlay.remove(); openAboutModal(root) })
}
