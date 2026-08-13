/** Browser-half composition seam for the DSH plugin configuration page. */
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  callScholarChatTurn,
  copyStandaloneAccessToken,
  inject,
  parseScholarChatBridgeRequest,
  shouldOpenScholarShortcut,
} from '../../src/client/index.js'
import { ScholarSettingsScope } from '../../src/client/scholar-settings.js'
import { standaloneChatBridgeOrigin } from '../../src/shared/standalone.js'

describe('DSH research plugin browser configuration', () => {
  it('uses the Scholar-owned RPC scope and contributes its own plugin card', () => {
    const call = vi.fn().mockResolvedValue({ ok: false, error: { code: 'internal', message: 'not ready', details: {} } })
    const register = vi.fn(() => () => {})
    const slotInject = vi.fn((_name: string, install: () => unknown) => install())
    const registerLocale = vi.fn(() => () => {})
    const ctx = {
      get: (name: string) => name === 'connection'
        ? { isLoopback: true, rpc: { call } }
        : undefined,
      locale: { register: registerLocale },
      slots: { inject: slotInject, register },
      effect: (body: () => unknown) => body(),
      on: vi.fn(() => () => {}),
    }

    apply(ctx as never)

    expect(inject).toEqual(['slots', 'locale', 'connection'])
    expect(call).toHaveBeenCalledWith('/dsh-scholar', 'settings-snapshot', {})
    expect(slotInject).toHaveBeenCalledWith('settings.plugin.item', expect.any(Function))
    expect(register.mock.calls[0]?.[0]).toMatchObject({
      name: 'settings.plugin.item',
      id: 'dsh-scholar',
      order: 30,
    })
    expect(slotInject).toHaveBeenCalledWith('conversation.view', expect.any(Function))
    expect(register.mock.calls[1]?.[0]).toMatchObject({
      name: 'conversation.view',
      id: 'dsh-scholar',
      order: 20,
    })
    expect(registerLocale).toHaveBeenCalledOnce()
    expect(registerLocale.mock.calls[0]?.[0]).toBe('settings.dshScholar')
    expect(registerLocale.mock.calls[0]?.[1]).toMatchObject({
      zh: { title: 'dsh Scholar' },
      en: { title: 'dsh Scholar' },
    })
  })

  it('loads and mutates restart-scoped settings through the Scholar RPC channel', async () => {
    const first = {
      value: { defaultMode: 'gate-only', unattended: false, standalone: { url: 'http://127.0.0.1:18610/', shortcut: 'Alt+Shift+S' } },
      base: { defaultMode: 'gate-only' }, user: {}, revision: 4, writable: true, applies: 'restart',
    }
    const second = { ...first, value: { ...first.value, defaultMode: 'full-auto' }, user: { defaultMode: 'full-auto' }, revision: 5 }
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { available: true, snapshot: first } })
      .mockResolvedValueOnce({ ok: true, value: { available: true, snapshot: second } })
    const scope = new ScholarSettingsScope({ call }, true)

    await scope.refresh()
    expect(scope.getSnapshot()).toMatchObject({ status: 'ready', value: { defaultMode: 'gate-only' }, revision: 4, writable: true })
    await scope.set('defaultMode', 'full-auto')
    expect(call).toHaveBeenLastCalledWith('/dsh-scholar', 'settings-mutate', {
      op: 'set', field: 'defaultMode', value: 'full-auto', expectedRevision: 4,
    })
    expect(scope.getSnapshot()).toMatchObject({ status: 'ready', value: { defaultMode: 'full-auto' }, revision: 5 })
  })

  it('keeps remote browsers unavailable without calling the privileged Scholar settings RPC', async () => {
    const call = vi.fn()
    const scope = new ScholarSettingsScope({ call }, false)
    await scope.refresh()
    expect(scope.getSnapshot()).toMatchObject({ status: 'unavailable', writable: false, mode: 'memory' })
    expect(call).not.toHaveBeenCalled()
  })

  it('guards the global shortcut from editable, IME and repeated key events', () => {
    const event = {
      key: 's', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false,
      repeat: false, isComposing: false, target: { tagName: 'DIV' },
    }
    expect(shouldOpenScholarShortcut(event, 'Alt+Shift+S')).toBe(true)
    expect(shouldOpenScholarShortcut({ ...event, target: { tagName: 'TEXTAREA' } }, 'Alt+Shift+S')).toBe(false)
    expect(shouldOpenScholarShortcut({ ...event, isComposing: true }, 'Alt+Shift+S')).toBe(false)
    expect(shouldOpenScholarShortcut({ ...event, repeat: true }, 'Alt+Shift+S')).toBe(false)
    expect(shouldOpenScholarShortcut(event, 'disabled')).toBe(false)
  })

  it('copies only an explicit loopback RPC token through Clipboard API', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, value: { token: 'standalone-secret' } })
    const writeText = vi.fn().mockResolvedValue(undefined)
    await expect(copyStandaloneAccessToken({ call }, { writeText }, true)).resolves.toBe(true)
    expect(call).toHaveBeenCalledWith('/dsh-scholar', 'standalone-token', {})
    expect(writeText).toHaveBeenCalledWith('standalone-secret')

    call.mockClear()
    writeText.mockClear()
    await expect(copyStandaloneAccessToken({ call }, { writeText }, false)).resolves.toBe(false)
    expect(call).not.toHaveBeenCalled()
    expect(writeText).not.toHaveBeenCalled()

    call.mockResolvedValueOnce({ ok: false, error: { code: 'internal' } })
    await expect(copyStandaloneAccessToken({ call }, { writeText }, true)).resolves.toBe(false)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('accepts chat bridge requests only from the configured Scholar iframe origin', () => {
    const source = {}
    const data = {
      type: 'dsh-scholar/chat-turn-request',
      request_id: 'chat_1',
      payload: { text: '解释当前阶段' },
    }
    expect(parseScholarChatBridgeRequest(
      { source, origin: 'http://127.0.0.1:18610', data },
      source,
      'http://127.0.0.1:18610',
    )).toEqual({ requestId: 'chat_1', payload: { text: '解释当前阶段' } })
    expect(parseScholarChatBridgeRequest(
      { source: {}, origin: 'http://127.0.0.1:18610', data },
      source,
      'http://127.0.0.1:18610',
    )).toBeNull()
    expect(parseScholarChatBridgeRequest(
      { source, origin: 'https://attacker.invalid', data },
      source,
      'http://127.0.0.1:18610',
    )).toBeNull()
    expect(standaloneChatBridgeOrigin('http://127.0.0.1:18610/', 'http://127.0.0.1:3080')).toBe('http://127.0.0.1:18610')
    expect(standaloneChatBridgeOrigin('https://scholar.example/', 'http://127.0.0.1:3080')).toBeNull()
    expect(standaloneChatBridgeOrigin('http://127.0.0.1:3080/', 'http://127.0.0.1:3080')).toBeNull()
  })

  it('uses the loopback Scholar RPC for host chat and rejects remote browsers', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, value: { assistant_text: '回答' } })
    await expect(callScholarChatTurn({ call }, true, { text: '问题' })).resolves.toEqual({ assistant_text: '回答' })
    expect(call).toHaveBeenCalledWith('/dsh-scholar', 'chat-turn', { text: '问题' })
    call.mockClear()
    await expect(callScholarChatTurn({ call }, false, {})).rejects.toThrow('Scholar Chat model is unavailable')
    expect(call).not.toHaveBeenCalled()
  })
})
