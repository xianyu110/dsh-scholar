import { describe, expect, it } from 'vitest'
import {
  parseHostChatTurnResponse,
  isTrustedHostChatParent,
  safeSuggestedChatCommand,
} from '../../packages/dsh-research-ui/src/client/host-chat-bridge'

describe('DSH Host freeform Chat bridge', () => {
  it('accepts only the matching parent/source request and a bounded reply', () => {
    const parent = {}
    const response = parseHostChatTurnResponse({
      source: parent,
      data: {
        type: 'dsh-scholar/chat-turn-response',
        request_id: 'turn_1',
        value: { assistant_text: '可以，我们先明确主指标。', suggested_command: '/status' },
      },
    }, parent, 'turn_1')
    expect(response).toEqual({ assistantText: '可以，我们先明确主指标。', suggestedCommand: '/status' })
    expect(parseHostChatTurnResponse({ source: {}, data: response }, parent, 'turn_1')).toBeNull()
  })

  it('allows only registered top-level slash commands and never an aggregate or human decision alias', () => {
    expect(safeSuggestedChatCommand('/run formal {"contract_id":"ctr_1"}')).toBe('/run formal {"contract_id":"ctr_1"}')
    expect(safeSuggestedChatCommand('/research run formal')).toBeUndefined()
    expect(safeSuggestedChatCommand('/approve gate_1')).toBeUndefined()
    expect(safeSuggestedChatCommand('/confirm-brief')).toBeUndefined()
    expect(safeSuggestedChatCommand('/release')).toBeUndefined()
    expect(safeSuggestedChatCommand('run formal')).toBeUndefined()
  })

  it('allows bridge payloads only to a different-origin loopback parent', () => {
    expect(isTrustedHostChatParent('http://127.0.0.1:3080/session', 'http://127.0.0.1:18610')).toBe(true)
    expect(isTrustedHostChatParent('http://localhost:3080/', 'http://127.0.0.1:18610')).toBe(true)
    expect(isTrustedHostChatParent('https://attacker.invalid/', 'http://127.0.0.1:18610')).toBe(false)
    expect(isTrustedHostChatParent('', 'http://127.0.0.1:18610')).toBe(false)
  })
})
