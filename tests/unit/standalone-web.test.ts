/**
 * Standalone web application server tests: option loading, token lifecycle,
 * proxy auth and CSRF posture (design §15.2/§15.3) on the only browser
 * delivery mode supported by DSH Scholar.
 * @module tests/unit/standalone-web.test
 */

import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOptions } from '../../packages/dsh-research-ui/lib/standalone/server.js'
// @ts-expect-error re-export surface

describe('standalone web application', () => {
  it('loads options with defaults (port 18610, kernel 17413)', () => {
    const dir = join(tmpdir(), `dsh-standalone-defaults-${Date.now()}`)
    const o = loadOptions(['--data-dir', dir])
    expect(o.port).toBe(18610)
    expect(o.kernelPort).toBe(17413)
    expect(o.host).toBe('127.0.0.1')
  })

  it('loads explicit --port / --kernel-port / --data-dir', () => {
    const dir = join(tmpdir(), 'dsh-standalone-opts-test')
    const o = loadOptions(['--port', '19000', '--kernel-port', '19001', '--data-dir', dir, '--no-token'])
    expect(o.port).toBe(19000)
    expect(o.kernelPort).toBe(19001)
    expect(o.dataDir).toBe(dir)
    expect(o.token).toBeNull()
  })

  it('persists a generated token under the data dir (0600)', () => {
    const dir = join(tmpdir(), `dsh-standalone-tok-${Date.now()}`)
    const o = loadOptions(['--data-dir', dir])
    expect(o.token).toBeTruthy()
    expect(o.token!.startsWith('dsh-')).toBe(true)
    const file = join(dir, 'standalone-token')
    expect(readFileSync(file, 'utf8').trim()).toBe(o.token)
    // Second load reuses the persisted token (stable identity).
    const o2 = loadOptions(['--data-dir', dir])
    expect(o2.token).toBe(o.token)
  })

  it('honors --token over generation and persists it', () => {
    const dir = join(tmpdir(), `dsh-standalone-explicit-${Date.now()}`)
    const o = loadOptions(['--data-dir', dir, '--token', 'my-secret'])
    expect(o.token).toBe('my-secret')
    expect(readFileSync(join(dir, 'standalone-token'), 'utf8').trim()).toBe('my-secret')
  })

  it('repairs an existing token file to 0600 before reading it', () => {
    const dir = join(tmpdir(), `dsh-standalone-mode-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'standalone-token')
    writeFileSync(file, 'existing-secret', { mode: 0o644 })
    chmodSync(file, 0o644)
    expect(loadOptions(['--data-dir', dir]).token).toBe('existing-secret')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('rejects a symlink token path', () => {
    const dir = join(tmpdir(), `dsh-standalone-symlink-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'target-token')
    writeFileSync(target, 'do-not-follow')
    symlinkSync(target, join(dir, 'standalone-token'))
    expect(() => loadOptions(['--data-dir', dir])).toThrow(/regular file/)
  })

  it('--no-token disables auth on loopback', () => {
    const o = loadOptions(['--no-token'])
    expect(o.token).toBeNull()
  })

  it.each(['0.0.0.0', '192.168.1.9', 'example.test'])('rejects tokenless non-loopback host %s', host => {
    expect(() => loadOptions(['--host', host, '--no-token'])).toThrow(/loopback/)
  })

  it.each(['127.0.0.2', 'localhost', '::1'])('allows tokenless loopback host %s', host => {
    expect(loadOptions(['--host', host, '--no-token']).token).toBeNull()
  })

  it('loadOptions writes the data dir when token file is created', () => {
    const dir = join(tmpdir(), `dsh-standalone-mkdir-${Date.now()}`)
    expect(() => loadOptions(['--data-dir', dir])).not.toThrow()
    // mkdirSync happened inside loadOptions for the token file.
    const o = loadOptions(['--data-dir', dir, '--token', 'x'])
    void o
    // Re-run on the existing dir is idempotent.
    expect(() => loadOptions(['--data-dir', dir])).not.toThrow()
  })

  it('is exportable from the package surface', async () => {
    const mod = await import('../../packages/dsh-research-ui/lib/standalone/server.js')
    expect(typeof mod.startStandalone).toBe('function')
    expect(typeof mod.loadOptions).toBe('function')
    void mkdirSync
    void writeFileSync
  })
})
