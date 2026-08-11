/** Shared UI state + localStorage persistence (preferences, favourites,
 * notifications, chat sessions, terminal seq). Panels/modals read & write
 * the mutable `state` object; persistence helpers own their storage keys. */
import type { ChatAttachmentRef, ChatMessage, ChatSession, NotifEntry, TerminalLine } from './types'
import { ACCENTS, el, rootHost, trapFocus } from './ui'
import { getLocale, registerOverlayRebuild, t } from './i18n/index'
// UI-SIMPLE-01: the canonical tab key set lives in the pure nav model
// (nav.ts ALL_TAB_KEYS) so tab restore covers every panel incl. the More
// tabs (manuscript/terminal).
import { ALL_TAB_KEYS } from './nav'

export let favProjects = new Set<string>()

export const state = {
  activeTab: 'phase',
  projectId: undefined as string | undefined,
  lastError: undefined as string | undefined,
  rerender: (() => {}) as () => void,
  refreshTimer: null as number | null,
  startRefreshTimer: (() => null) as () => number | null,
  notifHistory: [] as NotifEntry[],
  notifUnread: 0,
  chatMessages: [] as ChatMessage[],
  chatDraft: '',
  chatSessions: [] as ChatSession[],
  chatActiveId: null as string | null,
  chatHistory: [] as string[],
  historyIndex: -1,
  chatDetailIndex: -1,
  chatQuoteTarget: null as { index: number; text: string } | null,
  terminalRunId: null as string | null,
  terminalChannel: 'all' as 'all' | 'stdout' | 'stderr',
  terminalLines: [] as TerminalLine[],
  terminalLastSeq: 0,
  terminalRetainedSeq: 1,
  terminalTotalBytes: 0,
  terminalDroppedBytes: 0,
  terminalTruncated: false,
  terminalStatus: 'idle' as 'idle' | 'connecting' | 'live' | 'reconnecting' | 'exited',
  terminalExitCode: null as number | null,
  terminalExitSignal: null as string | null,
  terminalAbort: null as AbortController | null,
  terminalAutoScroll: true,
  terminalSearch: '',
  terminalAttempt: 0,
  terminalStreamEl: null as HTMLElement | null,
  terminalStatusEl: null as HTMLElement | null,
  terminalMetaEl: null as HTMLElement | null,
  terminalSaveTimer: undefined as number | undefined,
}

/* ─────────────────────────── theme (light default) ─────────────────────────── */

export const THEME_KEY = 'dsh-scholar-ui-theme'

export function readTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    return saved === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function writeTheme(theme: 'light' | 'dark' | string | undefined): void {
  try {
    localStorage.setItem(THEME_KEY, theme === 'dark' ? 'dark' : 'light')
  } catch { /* private mode */ }
}


/* ─────────────────────────── panel state ─────────────────────────── */

export const TAB_KEY = 'dsh-scholar-ui-tab'
export const TAB_IDS = [...ALL_TAB_KEYS]

/** Restore the last active tab (dsh-web session restore feel). */
export function tabLoad(): void {
  try {
    const saved = localStorage.getItem(TAB_KEY)
    if (saved !== null && TAB_IDS.some(id => id === saved)) state.activeTab = saved
  } catch { /* private mode */ }
}

export function tabSave(): void {
  try { localStorage.setItem(TAB_KEY, state.activeTab) } catch { /* private mode */ }
}

export const REFRESH_KEY = 'dsh-scholar-ui-refresh'

/** Auto-refresh toggle (8s polling), persisted. */
export function autoRefreshEnabled(): boolean {
  try { return localStorage.getItem(REFRESH_KEY) !== 'off' } catch { return true }
}
export function autoRefreshSet(on: boolean): void {
  try { localStorage.setItem(REFRESH_KEY, on ? 'on' : 'off') } catch { /* private mode */ }
}

export const ACCENT_KEY = 'dsh-scholar-ui-accent'
export function accentColor(): string {
  try { return ACCENTS[localStorage.getItem(ACCENT_KEY) ?? 'blue'] ?? ACCENTS.blue! } catch { return ACCENTS.blue! }
}
export function accentSet(name: string): void {
  try { localStorage.setItem(ACCENT_KEY, name in ACCENTS ? name : 'blue') } catch { /* private mode */ }
}

export const RADIUS_KEY = 'dsh-scholar-ui-radius'
export const RADII: Record<string, string> = { small: '8px', normal: '12px', large: '16px' }

/** Panel corner radius (dsh-web appearance preference), persisted. */
export function radiusValue(): string {
  try { return RADII[localStorage.getItem(RADIUS_KEY) ?? 'normal'] ?? RADII.normal! } catch { return RADII.normal! }
}
export function radiusSet(name: string): void {
  try { localStorage.setItem(RADIUS_KEY, name in RADII ? name : 'normal') } catch { /* private mode */ }
}

export const TEXTURE_KEY = 'dsh-scholar-ui-texture'
export const TEXTURES: Record<string, string> = { plain: 'plain', grid: 'grid', dots: 'dots' }

/** Panel background texture (dsh-web appearance), persisted. */
export function textureValue(): string {
  try { return TEXTURES[localStorage.getItem(TEXTURE_KEY) ?? 'plain'] ?? 'plain' } catch { return 'plain' }
}
export function textureSet(name: string): void {
  try { localStorage.setItem(TEXTURE_KEY, name in TEXTURES ? name : 'plain') } catch { /* private mode */ }
}

export const FAV_KEY = 'dsh-scholar-ui-favs'

export function tabFavs(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_KEY)
    if (raw === null) return new Set()
    const parsed = JSON.parse(raw) as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function tabPinned(key: string): boolean {
  return tabFavs().has(key)
}

export function tabTogglePin(key: string): void {
  const favs = tabFavs()
  if (favs.has(key)) favs.delete(key)
  else favs.add(key)
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...favs])) } catch { /* private mode */ }
  state.rerender()
}

/** Project favourites (dsh-web starred projects), persisted. */
export const FAV_PROJECTS_KEY = 'dsh-scholar-ui-fav-projects'
export function favProjectsLoad(): void {
  try {
    const raw = localStorage.getItem(FAV_PROJECTS_KEY)
    if (raw !== null) favProjects = new Set(JSON.parse(raw) as string[])
  } catch { /* private mode */ }
}
export function favProjectsPersist(): void {
  try { localStorage.setItem(FAV_PROJECTS_KEY, JSON.stringify([...favProjects])) } catch { /* private mode */ }
}
export function favProjectToggle(id: string): void {
  if (favProjects.has(id)) favProjects.delete(id)
  else favProjects.add(id)
  favProjectsPersist()
}


/* ─────────────────────────── commands modal ─────────────────────────── */

export const FAV_CMDS_KEY = 'dsh-scholar-ui-favcmds'

/** Favourite command names (dsh-web quick commands), persisted. */
export function favCommands(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_CMDS_KEY)
    if (raw === null) return new Set()
    const parsed = JSON.parse(raw) as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function favCommandToggle(name: string): void {
  const favs = favCommands()
  if (favs.has(name)) favs.delete(name)
  else favs.add(name)
  try { localStorage.setItem(FAV_CMDS_KEY, JSON.stringify([...favs])) } catch { /* private mode */ }
}

/** Execute a command line in the Chat tab (fill + run). */

/** dsh-web notification centre: toast history (persisted, 30 max). */
export const NOTIF_KEY = 'dsh-scholar-ui-notifs'
export const NOTIF_READ_KEY = 'dsh-scholar-ui-notifs-read'
/** Unread badge count (dsh-web notification dot). */
export function notifLoad(): void {
  try {
    const raw = localStorage.getItem(NOTIF_KEY)
    if (raw === null) return
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      state.notifHistory = parsed.filter((n): n is NotifEntry => typeof n === 'object' && n !== null && typeof (n as { text?: unknown }).text === 'string').slice(-30)
    }
    const readRaw = localStorage.getItem(NOTIF_READ_KEY)
    state.notifUnread = readRaw === null ? 0 : Math.max(0, state.notifHistory.length - Number(readRaw))
  } catch { /* private mode */ }
}
export function notifPersist(): void {
  try { localStorage.setItem(NOTIF_KEY, JSON.stringify(state.notifHistory.slice(-30))) } catch { /* private mode */ }
}
export function notifClear(): void {
  state.notifHistory = []
  state.notifUnread = 0
  notifPersist()
  try { localStorage.setItem(NOTIF_READ_KEY, '0') } catch { /* private mode */ }
}
export function notifMarkRead(): void {
  state.notifUnread = 0
  try { localStorage.setItem(NOTIF_READ_KEY, String(state.notifHistory.length)) } catch { /* private mode */ }
}

/** dsh-web a11y: trap Tab focus inside a modal; Escape already handled
 * globally. Returns a cleanup that restores focus to the trigger. */



export const CHAT_STORAGE_KEY = 'dsh-scholar-ui-chat'
export const CHAT_MAX = 200
/** Multi-session chats (dsh-web session tabs), persisted. */
export const SESSIONS_KEY = 'dsh-scholar-ui-sessions'

/** Current session's messages (state.chatMessages mirrors the active session). */


export function chatSyncActive(): void {
  const active = state.chatSessions.find(s => s.id === state.chatActiveId)
  state.chatMessages = active !== undefined ? active.messages : []
  if (active !== undefined) {
    active.lastActive = Date.now()
    // dsh-web pinned sessions stay at the top; the rest by recent activity.
    state.chatSessions.sort((a, b) =>
      ((b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0)) || ((b.lastActive ?? 0) - (a.lastActive ?? 0)),
    )
  }
}
export function chatSessionsPersist(): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(state.chatSessions.map(s => ({ ...s, messages: s.messages.slice(-CHAT_MAX) }))))
    // dsh-web session memory: remember the active session across reloads.
    if (state.chatActiveId !== null) localStorage.setItem('dsh-scholar-ui-active-session', state.chatActiveId)
  } catch { /* private mode */ }
}
export function chatSessionEnsure(): void {
  if (state.chatSessions.length === 0) {
    state.chatSessions = [{ id: 'default', name: 'Chat 1', messages: [] }]
    state.chatActiveId = 'default'
  }
  if (state.chatActiveId === null || !state.chatSessions.some(s => s.id === state.chatActiveId)) {
    state.chatActiveId = state.chatSessions[0]!.id
  }
  chatSyncActive()
}
export function chatSessionNew(): void {
  const id = `s${Date.now()}`
  state.chatSessions.push({ id, name: `Chat ${state.chatSessions.length + 1}`, messages: [] })
  state.chatActiveId = id
  state.chatDraft = ''
  chatSyncActive()
  chatSessionsPersist()
  state.rerender()
}
export function chatSessionClose(id: string): void {
  const idx = state.chatSessions.findIndex(s => s.id === id)
  if (idx < 0) return
  state.chatSessions.splice(idx, 1)
  if (state.chatSessions.length === 0) chatSessionEnsure()
  if (state.chatActiveId === id) {
    state.chatActiveId = state.chatSessions[Math.min(idx, state.chatSessions.length - 1)]!.id
    state.chatDraft = ''
  }
  chatSyncActive()
  chatSessionsPersist()
  state.rerender()
}
export function chatSessionSelect(id: string): void {
  if (state.chatSessions.some(s => s.id === id)) {
    state.chatActiveId = id
    state.chatDraft = ''
    const session = state.chatSessions.find(s => s.id === id)
    if (session !== undefined) session.unread = 0
    chatSyncActive()
    state.rerender()
  }
}

/** Rename a chat session via an in-app dialog (dsh-web dialogs — no
 * browser prompts), persisted. */
export function chatSessionRename(id: string): void {
  const session = state.chatSessions.find(s => s.id === id)
  if (session === undefined) return
  const root = rootHost()
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:440px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', t('shell', 'shell.renameSession.title'))
  const header = el('div', 'modal-header', t('shell', 'shell.renameSession.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)
  const hint = el('div', 'muted', t('shell', 'shell.renameSession.hint', { name: session.name }))
  hint.style.cssText = 'margin-bottom:10px;font-size:11.5px'
  modal.appendChild(hint)
  const input = document.createElement('input')
  input.type = 'text'
  input.value = session.name
  input.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 11px;font:12px/1.4 system-ui,sans-serif;outline:none'
  input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
  input.onblur = () => { input.style.borderColor = 'var(--border)' }
  modal.appendChild(input)
  const err = el('div', 'error-banner')
  err.style.cssText = 'display:none;margin-top:10px'
  modal.appendChild(err)
  const actions = el('div', 'row')
  actions.style.cssText = 'justify-content:flex-end;gap:8px;margin-top:14px'
  const cancel = el('button', 'hbtn', t('budget', 'budget.modal.cancel'))
  cancel.onclick = () => overlay.remove()
  const save = el('button', 'btn approve', t('common', 'common.action.save'))
  save.style.cssText = 'padding:7px 18px'
  const saveName = (): void => {
    const clean = input.value.trim()
    if (clean === '') {
      err.textContent = t('common', 'common.nameRequired')
      err.style.display = 'block'
      return
    }
    session.name = clean.slice(0, 40)
    chatSessionsPersist()
    overlay.remove()
    state.rerender()
  }
  save.onclick = saveName
  input.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); saveName() } }
  actions.append(cancel, save)
  modal.appendChild(actions)
  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the rename dialog (the typed
  // name is preserved via session.name captured below).
  registerOverlayRebuild(overlay, () => { overlay.remove(); chatSessionRename(id) })
  input.focus()
  input.select()
  trapFocus(overlay, null)
}

/** Archive a chat session (dsh-web session actions); messages are kept. */
export function chatSessionArchive(id: string): void {
  const session = state.chatSessions.find(s => s.id === id)
  if (session === undefined) return
  session.archived = !session.archived
  if (!session.archived) {
    // dsh-web restore: a restored session is no longer unread.
    session.unread = 0
  }
  if (session.archived && state.chatActiveId === id) {
    const next = state.chatSessions.find(s => s.id !== id && !s.archived) ?? state.chatSessions.find(s => s.id !== id)
    if (next !== undefined) {
      state.chatActiveId = next.id
      state.chatDraft = ''
    }
  }
  chatSyncActive()
  chatSessionsPersist()
  state.rerender()
}
/** Command history for ↑/↓ navigation (dsh-web shell feel), persisted. */
export const HISTORY_KEY = 'dsh-scholar-ui-history'

export function historyLoad(): void {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (raw === null) return
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      state.chatHistory = parsed.filter((h): h is string => typeof h === 'string').slice(-50)
    }
  } catch { /* private mode */ }
}

export function historyPush(line: string): void {
  if (line === '') return
  if (state.chatHistory[state.chatHistory.length - 1] === line) return
  state.chatHistory.push(line)
  state.chatHistory = state.chatHistory.slice(-50)
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.chatHistory)) } catch { /* private mode */ }
  state.historyIndex = -1
}

/** Restore transcripts persisted in localStorage (dsh-web session tabs). */
export function chatLoad(): void {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    const parsed = raw !== null ? JSON.parse(raw) as unknown : null
    if (Array.isArray(parsed) && parsed.length > 0) {
      state.chatSessions = parsed
        .filter((s): s is ChatSession => typeof s === 'object' && s !== null
          && typeof (s as ChatSession).id === 'string'
          && typeof (s as ChatSession).name === 'string'
          && Array.isArray((s as ChatSession).messages))
        .map(s => ({ ...s, messages: s.messages.filter((m): m is ChatMessage => typeof m === 'object' && m !== null && typeof (m as ChatMessage).role === 'string' && (m as ChatMessage).role in { user: 1, assistant: 1, error: 1 } && typeof (m as ChatMessage).text === 'string').slice(-CHAT_MAX) }))
      // dsh-web session memory: restore the last active session if it exists.
      const lastActive = localStorage.getItem('dsh-scholar-ui-active-session')
      state.chatActiveId = lastActive !== null && state.chatSessions.some(s => s.id === lastActive)
        ? lastActive
        : (state.chatSessions[0]?.id ?? null)
      chatSyncActive()
      return
    }
  } catch { /* corrupt or private mode */ }
  // Legacy single-transcript key.
  chatSessionEnsure()
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY)
    if (raw === null) return
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      state.chatMessages = parsed
        .filter((m): m is ChatMessage => typeof m === 'object' && m !== null
          && typeof (m as ChatMessage).role === 'string'
          && (m as ChatMessage).role in { user: 1, assistant: 1, error: 1 }
          && typeof (m as ChatMessage).text === 'string')
        .slice(-CHAT_MAX)
      chatSyncActive()
    }
  } catch { /* corrupt or private mode */ }
}

export function chatPersist(): void {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(state.chatMessages.slice(-CHAT_MAX)))
  } catch { /* private mode */ }
  chatSessionsPersist()
}

export function chatClear(): void {
  state.chatMessages = []
  chatSyncActive()
  chatPersist()
}

export function chatPush(role: ChatMessage['role'], text: string, quote?: { index: number; text: string }, attachment?: ChatAttachmentRef): void {
  const msg: ChatMessage = { role, text, time: new Date().toLocaleTimeString(getLocale()) }
  if (quote !== undefined) msg.quote = quote
  if (attachment !== undefined) msg.attachment = attachment
  state.chatMessages.push(msg)
  // dsh-web session unread: bump every session other than the active one
  // (assistant replies that land while the user is elsewhere).
  chatPersist()
}


/** Chat transcript search (dsh-web session search feel). */
