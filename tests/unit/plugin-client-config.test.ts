/** Browser-half composition seam for the DSH plugin configuration page. */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  callScholarChatTurn,
  callScholarSessionProjection,
  copyStandaloneAccessToken,
  inject,
  nextScholarFrameState,
  parseScholarChatBridgeRequest,
  parseScholarFrameReadyMessage,
  scholarFrameAttemptKey,
  scholarFrameStateForUrl,
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
    expect(standaloneChatBridgeOrigin('https://210.34.241.17:8443/', 'https://210.34.241.17')).toBe('https://210.34.241.17:8443')
    expect(standaloneChatBridgeOrigin('https://scholar.attacker.invalid/', 'https://210.34.241.17')).toBeNull()
    expect(standaloneChatBridgeOrigin('https://scholar.example/', 'http://127.0.0.1:3080')).toBeNull()
    expect(standaloneChatBridgeOrigin('http://127.0.0.1:3080/', 'http://127.0.0.1:3080')).toBeNull()
  })

  it('accepts an exact iframe ready handshake and fails closed after timeout', () => {
    const source = {}
    const data = { type: 'dsh-scholar/frame-ready', protocol: 1 }
    expect(parseScholarFrameReadyMessage(
      { source, origin: 'https://210.34.241.17:8443', data },
      source,
      'https://210.34.241.17:8443',
    )).toBe(true)
    expect(parseScholarFrameReadyMessage(
      { source: {}, origin: 'https://210.34.241.17:8443', data },
      source,
      'https://210.34.241.17:8443',
    )).toBe(false)
    expect(parseScholarFrameReadyMessage(
      { source, origin: 'https://attacker.invalid', data },
      source,
      'https://210.34.241.17:8443',
    )).toBe(false)
    expect(nextScholarFrameState('loading', 'ready')).toBe('ready')
    expect(nextScholarFrameState('loading', 'timeout')).toBe('failed')
    expect(nextScholarFrameState('ready', 'timeout')).toBe('ready')
    expect(nextScholarFrameState('failed', 'retry')).toBe('loading')
    expect(scholarFrameStateForUrl('https://old.example/', 'https://new.example/', 'failed')).toBe('loading')
    expect(scholarFrameStateForUrl('https://new.example/', 'https://new.example/', 'ready')).toBe('ready')
    expect(scholarFrameAttemptKey('https://scholar.example/', 0)).not.toBe(scholarFrameAttemptKey('https://scholar.example/', 1))
  })

  it('rebinds both iframe listeners for URL changes and same-URL retries', () => {
    const source = readFileSync(new URL('../../src/client/index.tsx', import.meta.url), 'utf8')
    expect(source).toContain('scholarFrameStateForUrl(frameStateUrl, url, frameState)')
    expect(source).toContain('cleanupReady()')
    expect(source).toContain('}, [frameAttemptKey, url])')
    expect(source).toContain("if (url === null || frameFailed) return")
    expect(source).toContain('}, [frameAttemptKey, frameFailed, props.callHostChatTurn, url])')
    expect(source).toContain('key={frameAttemptKey ?? url}')
  })

  it('uses the trusted-host Scholar view RPC for host chat', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, value: { assistant_text: '回答' } })
    await expect(callScholarChatTurn({ call }, { text: '问题' })).resolves.toEqual({ assistant_text: '回答' })
    expect(call).toHaveBeenCalledWith('/dsh-scholar-view', 'chat-turn', { text: '问题' })
    call.mockClear()
    call.mockResolvedValueOnce({ ok: false, error: { code: 'internal' } })
    await expect(callScholarChatTurn({ call }, {})).rejects.toThrow('Scholar Chat model is unavailable')
  })

  it('reads an exact trusted-host DSH session projection and rejects malformed responses', async () => {
    const value = {
      linked: true,
      session_id: 'session_1',
      project: { project_id: 'rsp_1', name: 'Research', status: 'SCOPED', revision: 2 },
      stages: ['init', 'survey', 'idea', 'reproduce', 'contract', 'experiment', 'evidence', 'writing', 'review', 'release']
        .map(id => ({ id, state: id === 'survey' ? 'current' : id === 'init' ? 'done' : 'upcoming' })),
      next_action: {
        code: 'survey_run', label: 'Run survey', reason: 'corpus required', route: 'chat', state: 'ready',
        blocking: false, required_by: 'agent', required: true, revision: 2,
      },
      summary: { pending_gates: 0, jobs: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0 }, counts: {} },
    }
    const call = vi.fn().mockResolvedValue({ ok: true, value })
    const controller = new AbortController()
    await expect(callScholarSessionProjection({ call }, 'session_1', controller.signal)).resolves.toEqual(value)
    expect(call).toHaveBeenCalledWith('/dsh-scholar-view', 'session-projection', { session_id: 'session_1' }, controller.signal)

    call.mockResolvedValueOnce({ ok: true, value: { ...value, session_id: 'session_2' } })
    await expect(callScholarSessionProjection({ call }, 'session_1')).rejects.toThrow('unavailable')
    call.mockResolvedValueOnce({ ok: true, value: { ...value, stages: [...value.stages].reverse() } })
    await expect(callScholarSessionProjection({ call }, 'session_1')).rejects.toThrow('unavailable')
    call.mockResolvedValueOnce({ ok: true, value: { ...value, next_action: { code: 'survey_run' } } })
    await expect(callScholarSessionProjection({ call }, 'session_1')).rejects.toThrow('unavailable')
    call.mockResolvedValueOnce({ ok: true, value: { ...value, summary: { ...value.summary, pending_gates: -1 } } })
    await expect(callScholarSessionProjection({ call }, 'session_1')).rejects.toThrow('unavailable')
    call.mockResolvedValueOnce({ ok: true, value: { ...value, token: 'must-not-enter-state' } })
    await expect(callScholarSessionProjection({ call }, 'session_1')).rejects.toThrow('unavailable')
    call.mockResolvedValueOnce({ ok: true, value: { ...value, project: { ...value.project, secret_ref: 'ssh-key' } } })
    await expect(callScholarSessionProjection({ call }, 'session_1')).rejects.toThrow('unavailable')
    call.mockClear()
    await expect(callScholarSessionProjection({ call }, 'session/other')).rejects.toThrow('unavailable')
    await expect(callScholarSessionProjection({ call }, ' session_1')).rejects.toThrow('unavailable')
    expect(call).not.toHaveBeenCalled()
  })
})
