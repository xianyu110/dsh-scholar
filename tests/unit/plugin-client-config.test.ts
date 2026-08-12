/** Browser-half composition seam for the DSH plugin configuration page. */
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  copyStandaloneAccessToken,
  inject,
  shouldOpenScholarShortcut,
} from '../../src/client/index.js'

describe('DSH research plugin browser configuration', () => {
  it('binds the research namespace and contributes its own plugin card', () => {
    const scope = { getSnapshot: () => ({ status: 'loading' }), subscribe: () => () => {}, set: vi.fn(), unset: vi.fn() }
    const bind = vi.fn(() => scope)
    const register = vi.fn(() => () => {})
    const slotInject = vi.fn((_name: string, install: () => unknown) => install())
    const registerLocale = vi.fn(() => () => {})
    const ctx = {
      get: (name: string) => name === 'connection'
        ? { isLoopback: true, rpc: { call: vi.fn() } }
        : undefined,
      settingsScope: { bind },
      locale: { register: registerLocale },
      slots: { inject: slotInject, register },
      effect: (body: () => unknown) => body(),
    }

    apply(ctx as never)

    expect(inject).toEqual(['slots', 'locale', 'settingsScope', 'connection'])
    expect(bind).toHaveBeenCalledWith({ namespace: 'research-plugin' })
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
})
