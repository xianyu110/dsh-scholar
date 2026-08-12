/**
 * DSH plugin compatibility seam: the package entrypoint must expose a
 * Standard Schema config that the real Cordis host can validate before
 * calling apply().
 */
import { describe, expect, it } from 'vitest'
import { Config } from '../../src/plugin/index.js'

function validate(input: unknown): { value?: unknown; issues?: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey> }> } {
  const result = Config['~standard'].validate(input)
  if (result instanceof Promise) throw new Error('DSH plugin config validation must be synchronous')
  return result
}

describe('DSH research plugin Config', () => {
  it('publishes host-visible defaults for an empty plugin row', () => {
    expect(validate({})).toEqual({
      value: {
        kernel: { host: '127.0.0.1', port: 7412 },
        defaultMode: 'gate-only',
        unattended: false,
        models: {},
        standalone: {
          url: 'http://127.0.0.1:18610/',
          shortcut: 'Alt+Shift+S',
        },
      },
    })
  })

  it('rejects invalid ports and unknown plugin keys before apply', () => {
    const badPort = validate({ kernel: { port: 65_536 } })
    expect(badPort.issues?.[0]?.path).toEqual(['kernel', 'port'])

    const unknownRoot = validate({ legacyMode: true })
    expect(unknownRoot.issues?.[0]).toMatchObject({
      message: 'unknown config key "legacyMode"',
      path: ['legacyMode'],
    })

    const unknownNested = validate({ kernel: { socket: '/tmp/kernel.sock' } })
    expect(unknownNested.issues?.[0]).toMatchObject({
      message: 'unknown config key "kernel.socket"',
      path: ['kernel', 'socket'],
    })

    const unknownStandalone = validate({ standalone: { tokenFile: '/tmp/token' } })
    expect(unknownStandalone.issues?.[0]).toMatchObject({
      message: 'unknown config key "standalone.tokenFile"',
      path: ['standalone', 'tokenFile'],
    })
  })

  it('rejects unsafe standalone URLs and unsupported shortcuts', () => {
    for (const url of [
      'javascript:alert(1)',
      'http://example.com/',
      'http://user:secret@127.0.0.1:18610/',
      'http://127.0.0.1:18610/?token=secret',
      'http://127.0.0.1:18610/#secret',
    ]) {
      expect(validate({ standalone: { url } }).issues?.[0]?.path).toEqual(['standalone', 'url'])
    }
    expect(validate({ standalone: { shortcut: 'Ctrl+S' } }).issues?.[0]?.path).toEqual(['standalone', 'shortcut'])
    expect(validate({ standalone: { url: 'https://scholar.example.test/workbench', shortcut: 'disabled' } })).toEqual({
      value: expect.objectContaining({
        standalone: { url: 'https://scholar.example.test/workbench', shortcut: 'disabled' },
      }),
    })
  })
})
