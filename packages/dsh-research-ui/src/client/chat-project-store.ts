import type { ChatMessage, ChatSession } from './types'

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ChatProjectSnapshot {
  projectId: string
  sessions: ChatSession[]
  activeId: string | null
  draft: string
  history: string[]
  detailIndex: number
  quoteTarget: { index: number; text: string } | null
  searchQuery: string
  commandsOnly: boolean
  sessionSearchQuery: string
}

const PREFIX = 'dsh-scholar-ui-chat-v1'
const CHAT_MAX = 200

export function chatProjectStorageKeys(projectId: string): { sessions: string; active: string; context: string } {
  const suffix = encodeURIComponent(projectId)
  return {
    sessions: `${PREFIX}:sessions:${suffix}`,
    active: `${PREFIX}:active:${suffix}`,
    context: `${PREFIX}:context:${suffix}`,
  }
}

function isMessage(value: unknown, projectId: string): value is ChatMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as ChatMessage
  if (!['user', 'assistant', 'error'].includes(message.role) || typeof message.text !== 'string' || typeof message.time !== 'string') return false
  return message.attachment === undefined || message.attachment.project_id === projectId
}

function cleanSession(value: unknown, projectId: string): ChatSession | null {
  if (typeof value !== 'object' || value === null) return null
  const session = value as ChatSession
  if (session.project_id !== projectId || typeof session.id !== 'string' || typeof session.name !== 'string' || !Array.isArray(session.messages)) return null
  return { ...session, project_id: projectId, messages: session.messages.filter(message => isMessage(message, projectId)).slice(-CHAT_MAX) }
}

function emptySnapshot(projectId: string): ChatProjectSnapshot {
  return {
    projectId,
    sessions: [],
    activeId: null,
    draft: '',
    history: [],
    detailIndex: -1,
    quoteTarget: null,
    searchQuery: '',
    commandsOnly: false,
    sessionSearchQuery: '',
  }
}

export function loadChatProjectSnapshot(storage: KeyValueStorage, projectId: string): ChatProjectSnapshot {
  const snapshot = emptySnapshot(projectId)
  const keys = chatProjectStorageKeys(projectId)
  try {
    const rawSessions = storage.getItem(keys.sessions)
    const parsedSessions = rawSessions === null ? [] : JSON.parse(rawSessions) as unknown
    if (Array.isArray(parsedSessions)) {
      snapshot.sessions = parsedSessions.map(value => cleanSession(value, projectId)).filter((value): value is ChatSession => value !== null)
    }
    const active = storage.getItem(keys.active)
    snapshot.activeId = active !== null && snapshot.sessions.some(session => session.id === active)
      ? active
      : (snapshot.sessions[0]?.id ?? null)
    const rawContext = storage.getItem(keys.context)
    const context = rawContext === null ? null : JSON.parse(rawContext) as Record<string, unknown>
    if (context !== null && typeof context === 'object') {
      if (typeof context.draft === 'string') snapshot.draft = context.draft
      if (Array.isArray(context.history)) snapshot.history = context.history.filter((line): line is string => typeof line === 'string').slice(-50)
      if (Number.isInteger(context.detailIndex)) snapshot.detailIndex = context.detailIndex as number
      const quote = context.quoteTarget
      if (typeof quote === 'object' && quote !== null && Number.isInteger((quote as { index?: unknown }).index) && typeof (quote as { text?: unknown }).text === 'string') {
        snapshot.quoteTarget = { index: (quote as { index: number }).index, text: (quote as { text: string }).text }
      }
      if (typeof context.searchQuery === 'string') snapshot.searchQuery = context.searchQuery
      if (typeof context.commandsOnly === 'boolean') snapshot.commandsOnly = context.commandsOnly
      if (typeof context.sessionSearchQuery === 'string') snapshot.sessionSearchQuery = context.sessionSearchQuery
    }
  } catch { /* corrupt/private storage fails closed to an empty project */ }
  return snapshot
}

export function saveChatProjectSnapshot(storage: KeyValueStorage, snapshot: ChatProjectSnapshot): void {
  const keys = chatProjectStorageKeys(snapshot.projectId)
  const sessions = snapshot.sessions
    .filter(session => session.project_id === snapshot.projectId)
    .map(session => ({
      ...session,
      messages: session.messages.filter(message => message.attachment === undefined || message.attachment.project_id === snapshot.projectId).slice(-CHAT_MAX),
    }))
  storage.setItem(keys.sessions, JSON.stringify(sessions))
  storage.setItem(keys.active, snapshot.activeId ?? '')
  storage.setItem(keys.context, JSON.stringify({
    draft: snapshot.draft,
    history: snapshot.history.slice(-50),
    detailIndex: snapshot.detailIndex,
    quoteTarget: snapshot.quoteTarget,
    searchQuery: snapshot.searchQuery,
    commandsOnly: snapshot.commandsOnly,
    sessionSearchQuery: snapshot.sessionSearchQuery,
  }))
}

export function appendStoredChatMessage(
  storage: KeyValueStorage,
  projectId: string,
  sessionId: string,
  message: ChatMessage,
  markUnread: boolean,
): boolean {
  if (message.attachment !== undefined && message.attachment.project_id !== projectId) return false
  const snapshot = loadChatProjectSnapshot(storage, projectId)
  const session = snapshot.sessions.find(candidate => candidate.id === sessionId && candidate.project_id === projectId)
  if (session === undefined) return false
  session.messages.push(message)
  session.messages = session.messages.slice(-CHAT_MAX)
  if (markUnread) session.unread = (session.unread ?? 0) + 1
  saveChatProjectSnapshot(storage, snapshot)
  return true
}
