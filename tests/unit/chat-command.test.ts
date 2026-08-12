/**
 * chat command arg parsing (client/chat.ts, USAGE_GUIDE §5/§6): the PURE
 * helpers behind the standalone Chat's direct slash executor — `chatJsonArg`
 * (extract the trailing JSON object) and `chatRunKind` (positional kind
 * before the JSON wins, else the JSON `kind` field, else the fallback).
 * Import-safe under vitest (no DOM at module scope).
 */
import { describe, expect, it } from 'vitest'
import { chatInputKind, chatJsonArg, chatRunKind, chatRunnerTargetId, executeChatCommand, projectCreatePayload } from '../../packages/dsh-research-ui/src/client/chat'
import { CHAT_COMMANDS } from '../../packages/dsh-research-ui/src/client/modals/commands'

describe('name-only Init and Grill prose routing', () => {
  it('builds a name-only v2 project payload', () => {
    expect(projectCreatePayload('  My study  ')).toEqual({ name: 'My study' })
  })

  it('routes slash input to commands and ordinary prose to the active Grill', () => {
    expect(chatInputKind('/status')).toEqual({ kind: 'command', line: '/status' })
    expect(chatInputKind('Public datasets only')).toEqual({ kind: 'prose', text: 'Public datasets only' })
  })

  it('advertises only direct command descriptors', async () => {
    expect(CHAT_COMMANDS.map(([, line]) => line)).not.toContainEqual(expect.stringMatching(/^\/research(?:\s|$)/))
    expect(CHAT_COMMANDS.some(([name, line]) => name === 'confirm-brief' && line === '/confirm-brief')).toBe(true)
    const help = await executeChatCommand('/help', undefined)
    expect(help).toContain('/reproduce')
    expect(help).toContain('/confirm-brief')
    expect(help).not.toContain('/research')
  })

  it('rejects the removed aggregate prefix instead of silently aliasing it', async () => {
    expect(await executeChatCommand('/research help', undefined)).toBe('Unknown command: /research. Try /help')
  })
})

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

describe('chatRunKind (USAGE_GUIDE §6: /run <kind> <json>)', () => {
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

describe('chat runner target override', () => {
  it('accepts only a non-empty opaque runner_target_id for top-level Job submission', () => {
    expect(chatRunnerTargetId({ runner_target_id: 'target_remote_lab_a' })).toBe('target_remote_lab_a')
    expect(chatRunnerTargetId({ runner_target_id: '' })).toBeUndefined()
    expect(chatRunnerTargetId({ runner_target_id: 22 })).toBeUndefined()
    expect(chatRunnerTargetId(null)).toBeUndefined()
  })
})
