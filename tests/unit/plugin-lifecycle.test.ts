/** DSH/Cordis lifecycle seam for the research plugin. */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, KernelSidecar } from '../../src/plugin/index.js'
import { createScholarRpcHandler } from '../../src/plugin/settings-rpc.js'

describe('DSH research plugin lifecycle', () => {
  it('waits for the settings provider before applying the host plugin', () => {
    expect(inject).toContain('settings')
  })

  it('registers a private restart settings namespace before starting the kernel', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-plugin-settings-'))
    const settingsDataDir = join(dataDir, 'from-settings')
    const register = vi.fn(() => ({
      get: () => ({
        kernel: { host: '127.0.0.1', port: 7521, dataDir: settingsDataDir },
        defaultMode: 'full-auto' as const,
        unattended: true,
        models: {},
      }),
    }))
    let startedPort: number | undefined
    let startedDataDir: string | undefined
    const start = vi.spyOn(KernelSidecar.prototype, 'start').mockImplementation(function () {
      startedPort = this.port
      startedDataDir = this.dataDir
      return Promise.resolve()
    })
    const stop = vi.spyOn(KernelSidecar.prototype, 'stop').mockResolvedValue()
    const ctx = {
      get: (service: string) => service === 'settings' ? { register } : undefined,
      logger: () => ({ info() {}, warn() {}, error() {} }),
      effect: (body: () => unknown) => { body() },
      provide() {},
      on() {},
      tools: { register() {} },
      commands: { register() {} },
      plugin: () => Promise.resolve(),
    }

    try {
      await apply(ctx as never, {
        kernel: { host: '127.0.0.1', port: 7412, dataDir },
        defaultMode: 'gate-only',
        unattended: false,
        models: {},
      })

      expect(register).toHaveBeenCalledOnce()
      expect(register.mock.calls[0]?.[0]).toBe('research-plugin')
      expect(register.mock.calls[0]?.[2]).toMatchObject({
        applies: 'restart',
      })
      expect(register.mock.calls[0]?.[2]).not.toHaveProperty('exposeToConfigurationClients')
      expect(startedPort).toBe(7521)
      expect(startedDataDir).toBe(settingsDataDir)
    } finally {
      start.mockRestore()
      stop.mockRestore()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('serves only the redacted Scholar UI projection through its loopback RPC', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined)
    const settings = {
      writable: true,
      describe: vi.fn(() => [{
        ns: 'research-plugin',
        value: {
          kernel: { host: '127.0.0.1', token: 'must-not-cross-the-wire' },
          defaultMode: 'gate-only', unattended: false,
          standalone: { url: 'http://127.0.0.1:18610/', shortcut: 'Alt+Shift+S' },
        },
        base: { defaultMode: 'gate-only', kernel: { token: 'also-secret' } },
        user: { unattended: false, kernel: { token: 'user-secret' } },
        applies: 'restart', revision: 7,
      }]),
      mutate,
    }
    const chatTurn = vi.fn().mockResolvedValue({ assistant_text: '可以继续讨论。', suggested_command: '/status' })
    const handler = createScholarRpcHandler(settings as never, () => 'clipboard-token', chatTurn)

    const snapshot = await handler('settings-snapshot', {}, new AbortController().signal)
    expect(snapshot).toMatchObject({ ok: true, value: { available: true, snapshot: {
      value: { defaultMode: 'gate-only', unattended: false },
      user: { unattended: false }, revision: 7, writable: true, applies: 'restart',
    } } })
    expect(JSON.stringify(snapshot)).not.toContain('must-not-cross-the-wire')
    expect(JSON.stringify(snapshot)).not.toContain('also-secret')
    expect(JSON.stringify(snapshot)).not.toContain('user-secret')

    await handler('settings-mutate', {
      op: 'set', field: 'defaultMode', value: 'full-auto', expectedRevision: 7,
    }, new AbortController().signal)
    expect(mutate).toHaveBeenCalledWith('research-plugin', [{ op: 'set', path: ['defaultMode'], value: 'full-auto' }], 7)

    const rejected = await handler('settings-mutate', {
      op: 'set', field: 'kernel', value: { token: 'attempted-injection' }, expectedRevision: 7,
    }, new AbortController().signal)
    expect(rejected).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(mutate).toHaveBeenCalledTimes(1)

    const controller = new AbortController()
    const chat = await handler('chat-turn', { text: '下一步是什么？' }, controller.signal)
    expect(chat).toEqual({ ok: true, value: { assistant_text: '可以继续讨论。', suggested_command: '/status' } })
    expect(chatTurn).toHaveBeenCalledWith({ text: '下一步是什么？' }, controller.signal)

    const unavailable = createScholarRpcHandler(settings as never, () => 'clipboard-token')
    await expect(unavailable('chat-turn', {}, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'Scholar Chat model is unavailable' },
    })
  })

  it('does not settle apply until the SkillFilesystem child plugin is active', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-plugin-lifecycle-'))
    const start = vi.spyOn(KernelSidecar.prototype, 'start').mockResolvedValue()
    const stop = vi.spyOn(KernelSidecar.prototype, 'stop').mockResolvedValue()
    let releaseSkill!: () => void
    const skillMounted = new Promise<void>(resolve => { releaseSkill = resolve })
    const ctx = {
      logger: () => ({ info() {}, warn() {}, error() {} }),
      effect: (body: () => unknown) => { body() },
      provide() {},
      on() {},
      tools: { register() {} },
      commands: { register() {} },
      plugin: () => skillMounted,
    }

    try {
      let settled = false
      const applying = apply(ctx as never, {
        kernel: { host: '127.0.0.1', port: 7412, dataDir },
        cacheDir: join(dataDir, 'cache'),
      }).then(() => { settled = true })

      await new Promise(resolve => setTimeout(resolve, 0))
      expect(settled).toBe(false)
      releaseSkill()
      await applying
    } finally {
      start.mockRestore()
      stop.mockRestore()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
