/** DSH/Cordis lifecycle seam for the research plugin. */
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, KernelSidecar } from '../../src/plugin/index.js'
import { createScholarRpcHandler, createScholarViewRpcHandler } from '../../src/plugin/settings-rpc.js'
import { Engine as ResearchOrchestrator } from '../../workers/research-orchestrator/lib/index.js'
import { ResearchClient } from '../../packages/research-client/lib/index.js'

describe('DSH research plugin lifecycle', () => {
  it('waits for the settings provider before applying the host plugin', () => {
    expect(inject).toContain('settings')
    expect(inject).toContain('userQuestions')
  })

  it('keeps privileged RPC loopback-only and exposes only the view channel to trusted hosts', () => {
    const source = readFileSync(new URL('../../src/plugin/index.ts', import.meta.url), 'utf8')
    expect(source).toContain("'/dsh-scholar',\n        createScholarRpcHandler")
    expect(source).toContain("{ authority: 'loopback' }")
    expect(source).toContain("'/dsh-scholar-view',\n        createScholarViewRpcHandler")
    expect(source).toContain("{ authority: 'trusted-host' }")
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
    const order: string[] = []
    const disposers: Array<() => unknown> = []
    const start = vi.spyOn(KernelSidecar.prototype, 'start').mockImplementation(function () {
      startedPort = this.port
      startedDataDir = this.dataDir
      order.push('kernel:start')
      return Promise.resolve()
    })
    const stop = vi.spyOn(KernelSidecar.prototype, 'stop').mockImplementation(async () => { order.push('kernel:stop') })
    const orchestratorStart = vi.spyOn(ResearchOrchestrator.prototype, 'start').mockImplementation(async () => { order.push('orchestrator:start') })
    const orchestratorStop = vi.spyOn(ResearchOrchestrator.prototype, 'stop').mockImplementation(() => { order.push('orchestrator:stop') })
    const reconcile = vi.spyOn(ResearchClient.prototype, 'reconcileNativeKnowledgePacks').mockResolvedValue({} as never)
    const ctx = {
      get: (service: string) => service === 'settings' ? { register } : undefined,
      logger: () => ({ info() {}, warn() {}, error() {} }),
      effect: (body: () => unknown) => {
        const disposer = body()
        if (typeof disposer === 'function') disposers.push(disposer as () => unknown)
      },
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
      expect(order.slice(0, 2)).toEqual(['kernel:start', 'orchestrator:start'])
      await disposers[0]?.()
      expect(order.indexOf('orchestrator:stop')).toBeLessThan(order.indexOf('kernel:stop'))
    } finally {
      start.mockRestore()
      stop.mockRestore()
      orchestratorStart.mockRestore()
      orchestratorStop.mockRestore()
      reconcile.mockRestore()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('separates privileged settings from the redacted Scholar view RPC', async () => {
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
    const sessionWorkspace = vi.fn().mockResolvedValue({ session_id: 'session_1', projection: { linked: false }, available_projects: [] })
    const bindSessionProject = vi.fn().mockResolvedValue({ session_id: 'session_1', projection: { linked: true }, available_projects: [] })
    const createSessionProject = vi.fn().mockResolvedValue({ session_id: 'session_1', projection: { linked: true }, available_projects: [] })
    const handler = createScholarRpcHandler(settings as never, () => 'clipboard-token', () => ({
      worker: 'running', runtime_default_mode: 'gate-only', fixture_only: true,
      release_requires_human: true,
      last_park: { code: 'unsupported_executor', reason: 'executor is not registered' },
    }))
    const viewHandler = createScholarViewRpcHandler({
      readSessionWorkspace: sessionWorkspace,
      bindSessionProject,
      createSessionProject,
    })

    const snapshot = await handler('settings-snapshot', {}, new AbortController().signal)
    expect(snapshot).toMatchObject({ ok: true, value: { available: true, snapshot: {
      value: {
        defaultMode: 'gate-only', unattended: false,
        automation: {
          worker: 'running', runtime_default_mode: 'gate-only', restart_required: false,
          fixture_only: true, release_requires_human: true,
          last_park: { code: 'unsupported_executor', reason: 'executor is not registered' },
        },
      },
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
    const workspace = await viewHandler('session-workspace', { session_id: 'session_1' }, controller.signal)
    expect(workspace).toMatchObject({ ok: true, value: { session_id: 'session_1', projection: { linked: false } } })
    expect(sessionWorkspace).toHaveBeenCalledWith('session_1', controller.signal)
    const bound = await viewHandler('session-bind', { session_id: 'session_1', project_id: 'rsp_1' }, controller.signal)
    expect(bound).toMatchObject({ ok: true, value: { projection: { linked: true } } })
    expect(bindSessionProject).toHaveBeenCalledWith('session_1', 'rsp_1', controller.signal)
    const created = await viewHandler('session-create', { session_id: 'session_1', name: '  New research  ' }, controller.signal)
    expect(created).toMatchObject({ ok: true, value: { projection: { linked: true } } })
    expect(createSessionProject).toHaveBeenCalledWith('session_1', 'New research', controller.signal)

    const invalidWorkspace = await viewHandler('session-workspace', { session_id: '' }, controller.signal)
    expect(invalidWorkspace).toMatchObject({ ok: false, error: { code: 'internal', message: 'invalid Scholar session workspace request' } })
    const unsafeWorkspace = await viewHandler('session-workspace', { session_id: 'x/../../projects/rsp_other' }, controller.signal)
    expect(unsafeWorkspace).toMatchObject({ ok: false, error: { code: 'internal', message: 'invalid Scholar session workspace request' } })
    const extraField = await viewHandler('session-bind', { session_id: 'session_1', project_id: 'rsp_1', token: 'forged' }, controller.signal)
    expect(extraField).toMatchObject({ ok: false, error: { code: 'internal', message: 'invalid Scholar session binding request' } })
    expect(sessionWorkspace).toHaveBeenCalledTimes(1)

    await expect(viewHandler('standalone-token', {}, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'unsupported Scholar view endpoint' },
    })
    await expect(handler('session-bind', {}, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'unsupported Scholar endpoint' },
    })

    const unavailable = createScholarViewRpcHandler()
    await expect(unavailable('session-workspace', { session_id: 'session_1' }, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal', message: 'Scholar session workspace is unavailable' },
    })
  })

  it('does not settle apply until the SkillFilesystem child plugin is active', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-plugin-lifecycle-'))
    const start = vi.spyOn(KernelSidecar.prototype, 'start').mockResolvedValue()
    const stop = vi.spyOn(KernelSidecar.prototype, 'stop').mockResolvedValue()
    const orchestratorStart = vi.spyOn(ResearchOrchestrator.prototype, 'start').mockResolvedValue()
    const orchestratorStop = vi.spyOn(ResearchOrchestrator.prototype, 'stop').mockImplementation(() => {})
    const reconcile = vi.spyOn(ResearchClient.prototype, 'reconcileNativeKnowledgePacks').mockResolvedValue({} as never)
    const disposers: Array<() => unknown> = []
    let releaseSkill!: () => void
    const skillMounted = new Promise<void>(resolve => { releaseSkill = resolve })
    const ctx = {
      logger: () => ({ info() {}, warn() {}, error() {} }),
      effect: (body: () => unknown) => {
        const disposer = body()
        if (typeof disposer === 'function') disposers.push(disposer as () => unknown)
      },
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
      await disposers[0]?.()
    } finally {
      start.mockRestore()
      stop.mockRestore()
      orchestratorStart.mockRestore()
      orchestratorStop.mockRestore()
      reconcile.mockRestore()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
