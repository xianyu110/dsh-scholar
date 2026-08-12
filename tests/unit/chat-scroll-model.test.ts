import { describe, expect, it } from 'vitest'
import { captureChatScroll, restoreChatScrollTop } from '../../packages/dsh-research-ui/src/client/chat-scroll-model'

describe('Chat transcript bottom-follow and history anchors', () => {
  it('follows the bottom only when already near it', () => {
    expect(captureChatScroll({ scrollTop: 780, scrollHeight: 1000, clientHeight: 200 }).followBottom).toBe(true)
    expect(captureChatScroll({ scrollTop: 400, scrollHeight: 1000, clientHeight: 200 }).followBottom).toBe(false)
  })

  it('restores the old offset while reading history and the new bottom while following', () => {
    expect(restoreChatScrollTop({ scrollTop: 400, followBottom: false }, 1400, 200)).toBe(400)
    expect(restoreChatScrollTop({ scrollTop: 780, followBottom: true }, 1400, 200)).toBe(1200)
  })

  it('clamps a stale history offset after transcript truncation', () => {
    expect(restoreChatScrollTop({ scrollTop: 900, followBottom: false }, 600, 200)).toBe(400)
  })
})
