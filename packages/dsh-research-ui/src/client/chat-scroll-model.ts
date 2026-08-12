export interface ChatScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export interface ChatScrollPosition {
  scrollTop: number
  followBottom: boolean
}

export const CHAT_BOTTOM_THRESHOLD_PX = 120

export function captureChatScroll(metrics: ChatScrollMetrics): ChatScrollPosition {
  const scrollTop = Number.isFinite(metrics.scrollTop) ? Math.max(0, metrics.scrollTop) : 0
  const remaining = metrics.scrollHeight - scrollTop - metrics.clientHeight
  return { scrollTop, followBottom: remaining < CHAT_BOTTOM_THRESHOLD_PX }
}

export function restoreChatScrollTop(position: ChatScrollPosition, scrollHeight: number, clientHeight: number): number {
  const max = Math.max(0, scrollHeight - clientHeight)
  if (position.followBottom) return max
  return Math.min(Math.max(0, position.scrollTop), max)
}
