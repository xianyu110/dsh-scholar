/** Browser-half composition seam for the DSH plugin configuration page. */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  callScholarSessionBind,
  callScholarSessionCreate,
  callScholarSessionWorkspace,
  copyStandaloneAccessToken,
  inject,
  shouldOpenScholarShortcut,
} from '../../src/client/index.js'
import { ScholarSettingsScope } from '../../src/client/scholar-settings.js'

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
      key: 'research-plugin',
    })
    expect(register.mock.calls[0]?.[0]).not.toHaveProperty('id')
    expect(register.mock.calls[0]?.[0]).not.toHaveProperty('order')
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

  it('renders a focused session panel and removes the standalone iframe path', () => {
    const source = readFileSync(new URL('../../src/client/index.tsx', import.meta.url), 'utf8')
    expect(source).toContain("props.t('sessionUnlinkedTitle')")
    expect(source).toContain("void runAction('bind')")
    expect(source).toContain("void runAction('create')")
    expect(source).not.toContain('<iframe')
    expect(source).not.toContain('postMessage(')
  })

  it('reads and mutates an exact trusted-host session workspace', async () => {
    const projection = {
      linked: false,
      session_id: 'session_1',
      stages: ['init', 'survey', 'idea', 'reproduce', 'contract', 'experiment', 'evidence', 'writing', 'review', 'release']
        .map(id => ({ id, state: id === 'init' ? 'current' : 'upcoming' })),
      summary: { pending_gates: 0, jobs: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0 }, counts: {} },
    }
    const value = {
      session_id: 'session_1', projection,
      available_projects: [{ project_id: 'rsp_1', name: 'Research', status: 'DRAFT', revision: 2 }],
    }
    const call = vi.fn().mockResolvedValue({ ok: true, value })
    const controller = new AbortController()
    await expect(callScholarSessionWorkspace({ call }, 'session_1', controller.signal)).resolves.toEqual(value)
    expect(call).toHaveBeenCalledWith('/dsh-scholar-view', 'session-workspace', { session_id: 'session_1' }, controller.signal)
    await expect(callScholarSessionBind({ call }, 'session_1', 'rsp_1')).resolves.toEqual(value)
    expect(call).toHaveBeenLastCalledWith('/dsh-scholar-view', 'session-bind', { session_id: 'session_1', project_id: 'rsp_1' })
    await expect(callScholarSessionCreate({ call }, 'session_1', '  New research  ')).resolves.toEqual(value)
    expect(call).toHaveBeenLastCalledWith('/dsh-scholar-view', 'session-create', { session_id: 'session_1', name: 'New research' })

    call.mockResolvedValueOnce({ ok: true, value: { ...value, session_id: 'session_2' } })
    await expect(callScholarSessionWorkspace({ call }, 'session_1')).rejects.toThrow('unavailable')
    call.mockResolvedValueOnce({ ok: true, value: { ...value, projection: { ...projection, stages: [...projection.stages].reverse() } } })
    await expect(callScholarSessionWorkspace({ call }, 'session_1')).rejects.toThrow('unavailable')
    call.mockResolvedValueOnce({ ok: true, value: { ...value, token: 'must-not-enter-state' } })
    await expect(callScholarSessionWorkspace({ call }, 'session_1')).rejects.toThrow('unavailable')
    call.mockResolvedValueOnce({ ok: true, value: { ...value, available_projects: [{ ...value.available_projects[0], secret_ref: 'ssh-key' }] } })
    await expect(callScholarSessionWorkspace({ call }, 'session_1')).rejects.toThrow('unavailable')
    call.mockClear()
    await expect(callScholarSessionWorkspace({ call }, 'session/other')).rejects.toThrow('unavailable')
    await expect(callScholarSessionBind({ call }, 'session_1', '../rsp_other')).rejects.toThrow('unavailable')
    await expect(callScholarSessionCreate({ call }, 'session_1', '   ')).rejects.toThrow('unavailable')
    expect(call).not.toHaveBeenCalled()
  })
})
