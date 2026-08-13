import { registerOverlayRebuild, t } from '../i18n/index'
import { chatPersist, favCommandToggle, favCommands, state, tabSave } from '../state'
import { el, focusChatComposerAtEnd, trapFocus } from '../ui'
export function runChatLine(line: string): void {
  state.chatDraft = line
  state.activeTab = 'chat'
  tabSave()
  chatPersist()
  state.rerender()
  focusChatComposerAtEnd()
}


/* ─────────────────────────── shortcuts modal ─────────────────────────── */

export const SHORTCUTS: Array<[string, string]> = [
  ['Alt+1..9', 'switch view (Chat, Overview, Approvals, Runs, Terminal, Artifacts, Evidence, Budget, Manuscript)'],
  ['Ctrl/Cmd+K', 'open the command palette'],
  ['Ctrl/Cmd+P', 'quick project switcher'],
  ['Ctrl/Cmd+Shift+F (chat)', 'search across all sessions'],
  ['Ctrl/Cmd+Shift+T', 'toggle light/dark theme'],
  ['Ctrl+1..9', 'select the Nth chat session'],
  ['Ctrl+Tab', 'cycle chat sessions'],
  ['Ctrl+↑ / Ctrl+↓', 'walk chat messages (details panel)'],
  ['Home / End', 'jump to the first / last message'],
  ['/ (not typing)', 'focus the chat composer with a leading slash'],
  ['↑ / ↓ (composer)', 'walk command history'],
  ['Tab (composer)', 'complete the command name'],
  ['Shift+Enter (composer)', 'newline without sending'],
  ['Enter (composer)', 'send / fill completion'],
  ['Ctrl/Cmd+Enter (composer)', 'send (alias for Enter)'],
  ['Esc', 'close modal / context menu / details / quote'],
  ['?', 'open this shortcut reference'],
  ['Double-click project', 'open the project detail drawer'],
  ['Double-click run / artifact', 'open the job / artifact detail drawer'],
  ['Right-click project / session', 'context menu (open, rename, archive, copy)'],
  ['Right-click tab', 'pin / unpin a favourite tab'],
  ['↑ / ↓ + Enter (global search)', 'walk hits and jump to the selected one'],
]

/** dsh-web shortcut reference modal. */
export function openShortcutsModal(root: ShadowRoot | null | undefined): void {
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'
  const header = el('div', 'modal-header', t('shell', 'shell.shortcuts.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)
  for (const [keys, desc] of SHORTCUTS) {
    const row = el('div', 'row')
    row.style.cssText = 'padding:5px 0;align-items:flex-start'
    const k = el('span', 'artifact-kind', keys)
    k.style.cssText += ';min-width:150px;text-align:center'
    const d = el('span', 'grow', desc)
    d.style.cssText = 'font-size:11.5px;color:var(--text)'
    row.append(k, d)
    modal.appendChild(row)
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: a locale switch re-opens this modal in the new
  // locale (the old overlay is removed; the new one re-registers itself).
  registerOverlayRebuild(overlay, () => { overlay.remove(); openShortcutsModal(root) })
}

export const CHAT_COMMANDS: Array<[string, string, string]> = [
  ['help', '/help', 'shell.commands.desc.help'],
  ['new', '/new demo1', 'shell.commands.desc.new'],
  ['confirm-brief', '/confirm-brief', 'shell.commands.desc.confirmBrief'],
  ['list', '/list', 'shell.commands.desc.list'],
  ['status', '/status', 'shell.commands.desc.status'],
  ['survey', '/survey temporal action localization', 'shell.commands.desc.survey'],
  ['ideas', '/ideas', 'shell.commands.desc.ideas'],
  ['reproduce', '/reproduce {"command":["node","baseline.js"]}', 'shell.commands.desc.reproduce'],
  ['gates', '/gates', 'shell.commands.desc.gates'],
  ['jobs', '/jobs', 'shell.commands.desc.jobs'],
  ['contract', '/contract {"idea_id":"...","dataset_id":"fixture","baseline":"b","treatment":"a","primary_metric":"macro_f1","seeds":[11,23,47]}', 'shell.commands.desc.contract'],
  ['run', '/run {"kind":"echo","command":["echo","hi"]}', 'shell.commands.desc.run'],
  ['evidence', '/evidence {"analysis_method":"bootstrap_95_mean_difference","result":{"primary_metric":"acc","value":0.9,"baseline_value":0.8,"effect_size":0.1,"ci_low":0.05,"ci_high":0.15,"n_seeds":3}}', 'shell.commands.desc.evidence'],
  ['claims', '/claims', 'shell.commands.desc.claims'],
  ['write', '/write', 'shell.commands.desc.write'],
  ['review', '/review', 'shell.commands.desc.review'],
  ['release-bundle', '/release-bundle', 'shell.commands.desc.releaseBundle'],
  ['release', '/release', 'shell.commands.desc.release'],
]

/**
 * dsh-web "Commands" palette: every direct slash command with a one-line
 * description. Clicking one switches to the Chat tab, fills the composer
 * and runs it.
 */
/** Command palette filter (dsh-web search-as-you-type), persisted across
 * reopenings of the palette. */
export let paletteQuery = ''

export function openCommandsModal(root: ShadowRoot | null | undefined): void {
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:560px;max-width:92vw'
  modal.setAttribute('aria-describedby', 'cmd-desc')
  const header = el('div', 'modal-header', t('shell', 'shell.commands.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const hint = el('div', 'muted', t('shell', 'shell.commands.hint', { count: String(CHAT_COMMANDS.length) }))
  hint.id = 'cmd-desc'
  hint.style.cssText = 'margin-bottom:10px;font-size:11.5px'
  modal.appendChild(hint)

  // dsh-web command palette: filter-as-you-type over name/line/description.
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = t('shell', 'shell.commands.filterPlaceholder')
  input.value = paletteQuery
  input.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 11px;font:12px/1.4 system-ui,sans-serif;outline:none;margin-bottom:10px'
  input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
  input.onblur = () => { input.style.borderColor = 'var(--border)' }
  modal.appendChild(input)

  const list = el('div')
  list.style.cssText = 'max-height:46vh;overflow-y:auto'
  modal.appendChild(list)

  const renderList = (): void => {
    list.replaceChildren()
    const q = paletteQuery.trim().toLowerCase()
    const matches = q === '' ? CHAT_COMMANDS : CHAT_COMMANDS.filter(([name, line, descKey]) =>
      name.toLowerCase().includes(q) || line.toLowerCase().includes(q) || t('shell', descKey).toLowerCase().includes(q),
    )
    // dsh-web favourites: ★ commands sort to the top of the palette.
    const favsSet = favCommands()
    const ordered = q === ''
      ? [...matches].sort((a, b) => (favsSet.has(b[0]) ? 1 : 0) - (favsSet.has(a[0]) ? 1 : 0))
      : matches
    if (ordered.length === 0) {
      list.appendChild(el('div', 'empty', t('shell', 'shell.commands.noMatch', { query: paletteQuery.trim() })))
      return
    }
    for (const [name, line, descKey] of ordered) {
      const row = el('button')
      row.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;border:0;background:none;color:var(--text);text-align:left;padding:8px 10px;border-radius:8px;cursor:pointer'
      row.onmouseenter = () => { row.style.background = 'var(--bg-hover)' }
      row.onmouseleave = () => { row.style.background = 'none' }
      const nameEl = el('span', 'artifact-kind', name.toUpperCase())
      const bodyEl = el('span', 'grow')
      bodyEl.style.cssText = 'min-width:0'
      const lineEl = el('div', 'mono', line)
      lineEl.style.cssText = 'font-size:10.5px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      const descEl = el('div', 'muted', t('shell', descKey))
      descEl.style.cssText = 'font-size:10.5px'
      bodyEl.append(lineEl, descEl)
      const favBtn = el('span', 'artifact-kind', favCommands().has(name) ? '★' : '☆')
      favBtn.title = favCommands().has(name) ? t('shell', 'shell.commands.unfavTitle') : t('shell', 'shell.commands.favTitle')
      favBtn.style.cssText += ';cursor:pointer;color:' + (favCommands().has(name) ? 'var(--tone-amber)' : 'var(--text-3)')
      favBtn.onclick = (event) => {
        event.stopPropagation()
        favCommandToggle(name)
        overlay.remove()
        openCommandsModal(root)
      }
      row.append(nameEl, bodyEl, favBtn)
      row.onclick = () => {
        overlay.remove()
        runChatLine(line)
      }
      list.appendChild(row)
    }
  }
  input.oninput = () => { paletteQuery = input.value; renderList() }
  renderList()
  // dsh-web palette navigation: ↑/↓ move through the command rows (the
  // rows are buttons, so Enter on a focused row runs it natively).
  modal.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = [...list.querySelectorAll('button')] as HTMLElement[]
    if (rows.length === 0) return
    event.preventDefault()
    const cur = rows.indexOf(root.activeElement as HTMLElement)
    const next = cur < 0
      ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
      : (cur + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
    rows[next]?.focus()
  })
  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the palette (paletteQuery is
  // module state, so the filter survives the rebuild).
  registerOverlayRebuild(overlay, () => { overlay.remove(); openCommandsModal(root) })
  input.focus()
  trapFocus(overlay, null)
}
