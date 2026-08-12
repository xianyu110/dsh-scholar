/** DSH/Cordis lifecycle seam for the research plugin. */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, KernelSidecar } from '../../src/plugin/index.js'

describe('DSH research plugin lifecycle', () => {
  it('waits for the settings provider before applying the host plugin', () => {
    expect(inject).toContain('settings')
  })

  it('registers an exposed restart settings namespace before starting the kernel', async () => {
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
        exposeToConfigurationClients: true,
      })
      expect(startedPort).toBe(7521)
      expect(startedDataDir).toBe(settingsDataDir)
    } finally {
      start.mockRestore()
      stop.mockRestore()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('does not settle apply until the SkillLocal child plugin is active', async () => {
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
