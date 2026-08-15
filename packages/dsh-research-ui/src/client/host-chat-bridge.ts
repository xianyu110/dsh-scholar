import { CHAT_COMMANDS } from './modals/commands'

export interface HostChatHistoryItem {
  role: 'user' | 'assistant'
  text: string
}

export interface HostChatTurnRequest {
  text: string
  locale: 'zh' | 'en'
  project: {
    project_id: string
    name?: string
    status?: string
    brief_status?: string
    next_actions_v2?: unknown[]
  }
  history: HostChatHistoryItem[]
}

export interface HostChatTurnReply {
  assistantText: string
  suggestedCommand?: string
}

const REQUEST_TYPE = 'dsh-scholar/chat-turn-request'
const RESPONSE_TYPE = 'dsh-scholar/chat-turn-response'
const COMMAND_NAMES = new Set(CHAT_COMMANDS.map(([name]) => name))
const HUMAN_ONLY_COMMANDS = new Set(['confirm-brief', 'release'])
const MAX_REPLY_CHARS = 20_000

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Model output may suggest, but never execute, one registered direct command. */
export function safeSuggestedChatCommand(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const command = value.trim()
  if (command.length === 0 || command.length > 8_192) return undefined
  const match = /^\/([a-z][a-z0-9-]*)(?:\s|$)/.exec(command)
  if (match === null || !COMMAND_NAMES.has(match[1]!) || HUMAN_ONLY_COMMANDS.has(match[1]!)) return undefined
  return command
}

/** Structural response parser kept DOM-free for regression tests. */
export function parseHostChatTurnResponse(
  event: { source?: unknown; origin?: unknown; data?: unknown },
  expectedParent: unknown,
  expectedOrigin: string,
  expectedRequestId: string,
): HostChatTurnReply | null {
  if (event.source !== expectedParent || event.origin !== expectedOrigin) return null
  const envelope = record(event.data)
  if (envelope?.type !== RESPONSE_TYPE || envelope.request_id !== expectedRequestId) return null
  const value = record(envelope.value)
  if (typeof value?.assistant_text !== 'string') return null
  const assistantText = value.assistant_text.trim()
  if (assistantText === '' || assistantText.length > MAX_REPLY_CHARS) return null
  const suggestedCommand = safeSuggestedChatCommand(value.suggested_command)
  return suggestedCommand === undefined ? { assistantText } : { assistantText, suggestedCommand }
}

function isMatchingResponse(
  event: { source?: unknown; origin?: unknown; data?: unknown },
  parent: unknown,
  origin: string,
  id: string,
): boolean {
  if (event.source !== parent || event.origin !== origin) return false
  const envelope = record(event.data)
  return envelope?.type === RESPONSE_TYPE && envelope.request_id === id
}

function requestId(): string {
  try { return `chat_${crypto.randomUUID()}` } catch { return `chat_${Date.now()}_${Math.random().toString(36).slice(2)}` }
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  return match !== null && match.slice(1).every(part => Number(part) <= 255)
}

/** Resolve the exact embedder origin from the browser-owned iframe referrer. */
export function trustedHostChatParentOrigin(referrer: string, selfOrigin: string): string | null {
  try {
    const parent = new URL(referrer)
    const self = new URL(selfOrigin)
    if (parent.origin === self.origin) return null
    if (isLoopbackHost(parent.hostname) && isLoopbackHost(self.hostname)) return parent.origin
    return parent.protocol === 'https:' && self.protocol === 'https:' && parent.hostname === self.hostname
      ? parent.origin
      : null
  } catch { return null }
}

/** The embedder must be a different-origin loopback or same-host HTTPS parent. */
export function isTrustedHostChatParent(referrer: string, selfOrigin: string): boolean {
  return trustedHostChatParentOrigin(referrer, selfOrigin) !== null
}

/**
 * Ask the DSH parent for a tool-free model answer. A standalone top-level page
 * has no parent bridge and returns null immediately so the caller can use its
 * deterministic phase-aware fallback.
 */
export function requestHostChatTurn(
  payload: HostChatTurnRequest,
  timeoutMs = 20_000,
): Promise<HostChatTurnReply | null> {
  if (typeof window === 'undefined' || window.parent === window) return Promise.resolve(null)
  const parentOrigin = trustedHostChatParentOrigin(document.referrer, window.location.origin)
  if (parentOrigin === null) return Promise.resolve(null)
  const parent = window.parent
  const id = requestId()
  return new Promise(resolve => {
    let settled = false
    const finish = (value: HostChatTurnReply | null): void => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timer)
      resolve(value)
    }
    const onMessage = (event: MessageEvent): void => {
      if (!isMatchingResponse(event, parent, parentOrigin, id)) return
      const parsed = parseHostChatTurnResponse(event, parent, parentOrigin, id)
      // A matching error or malformed reply fails closed immediately instead
      // of holding the composer disabled until the timeout expires.
      finish(parsed)
    }
    const timer = window.setTimeout(() => finish(null), Math.max(1, timeoutMs))
    window.addEventListener('message', onMessage)
    // Both directions are pinned to the origin derived from document.referrer;
    // the Host also checks the configured origin, exact iframe source and id.
    try { parent.postMessage({ type: REQUEST_TYPE, request_id: id, payload }, parentOrigin) }
    catch { finish(null) }
  })
}

export const HOST_CHAT_BRIDGE_REQUEST_TYPE = REQUEST_TYPE
export const HOST_CHAT_BRIDGE_RESPONSE_TYPE = RESPONSE_TYPE
