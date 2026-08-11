/**
 * chat command arg parsing (client/chat.ts, USAGE_GUIDE §5/§6): the PURE
 * helpers behind the standalone Chat's /research executor — `chatJsonArg`
 * (extract the trailing JSON object) and `chatRunKind` (positional kind
 * before the JSON wins, else the JSON `kind` field, else the fallback).
 * Import-safe under vitest (no DOM at module scope).
 */
import { describe, expect, it } from 'vitest'
import { chatJsonArg, chatRunKind } from '../../packages/dsh-research-ui/src/client/chat'

describe('chatJsonArg', () => {
  it('extracts a trailing JSON object', () => {
    expect(chatJsonArg('formal {"contract_id":"c1","code_snapshot_id":"s1"}')).toEqual({ contract_id: 'c1', code_snapshot_id: 's1' })
  })

  it('returns null without a JSON object', () => {
    expect(chatJsonArg('formal')).toBeNull()
    expect(chatJsonArg('')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(chatJsonArg('formal {bad json')).toBeNull()
  })
})

describe('chatRunKind (USAGE_GUIDE §6: /research run <kind> <json>)', () => {
  it('positional kind before the JSON wins', () => {
    expect(chatRunKind('formal {"contract_id":"c1"}', { contract_id: 'c1' }, 'echo')).toBe('formal')
    expect(chatRunKind('baseline', null, 'echo')).toBe('baseline')
  })

  it('JSON kind field is used when no positional word', () => {
    expect(chatRunKind('{"kind":"echo","command":["echo","hi"]}', { kind: 'echo' }, 'echo')).toBe('echo')
  })

  it('falls back when neither positional nor JSON kind is present', () => {
    expect(chatRunKind('', null, 'echo')).toBe('echo')
    expect(chatRunKind('{"command":["echo","hi"]}', { command: ['echo', 'hi'] }, 'echo')).toBe('echo')
  })
})
