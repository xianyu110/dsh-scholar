/** Browser-half composition seam for the DSH plugin configuration page. */
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../../src/client/index.js'

describe('DSH research plugin browser configuration', () => {
  it('binds the research namespace and contributes its own plugin card', () => {
    const scope = { getSnapshot: () => ({ status: 'loading' }), subscribe: () => () => {}, set: vi.fn(), unset: vi.fn() }
    const bind = vi.fn(() => scope)
    const register = vi.fn(() => () => {})
    const slotInject = vi.fn((_name: string, install: () => unknown) => install())
    const registerLocale = vi.fn(() => () => {})
    const ctx = {
      settingsScope: { bind },
      locale: { register: registerLocale },
      slots: { inject: slotInject, register },
      effect: (body: () => unknown) => body(),
    }

    apply(ctx as never)

    expect(inject).toEqual(['slots', 'locale', 'settingsScope'])
    expect(bind).toHaveBeenCalledWith({ namespace: 'research-plugin' })
    expect(slotInject).toHaveBeenCalledWith('settings.plugin.item', expect.any(Function))
    expect(register.mock.calls[0]?.[0]).toMatchObject({
      name: 'settings.plugin.item',
      id: 'dsh-scholar',
      order: 30,
    })
    expect(registerLocale).toHaveBeenCalledOnce()
    expect(registerLocale.mock.calls[0]?.[0]).toBe('settings.dshScholar')
    expect(registerLocale.mock.calls[0]?.[1]).toMatchObject({
      zh: { title: 'dsh Scholar' },
      en: { title: 'dsh Scholar' },
    })
  })
})
