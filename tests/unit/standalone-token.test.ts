import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readStandaloneAccessToken } from '../../src/plugin/standalone-token.js'

const roots: string[] = []

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-scholar-token-'))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('standalone access token reader', () => {
  it('reads only a non-empty 0600 regular file', () => {
    const dataDir = root()
    const tokenFile = join(dataDir, 'standalone-token')
    writeFileSync(tokenFile, 'dsh-test-token\n', { mode: 0o600 })
    expect(readStandaloneAccessToken(dataDir)).toBe('dsh-test-token')

    chmodSync(tokenFile, 0o640)
    expect(() => readStandaloneAccessToken(dataDir)).toThrow('permissions must be 0600')
  })

  it('rejects symlinks, directories, empty and oversized files', () => {
    const dataDir = root()
    const target = join(dataDir, 'target')
    writeFileSync(target, 'secret', { mode: 0o600 })
    symlinkSync(target, join(dataDir, 'standalone-token'))
    expect(() => readStandaloneAccessToken(dataDir)).toThrow()

    const emptyDir = root()
    writeFileSync(join(emptyDir, 'standalone-token'), '', { mode: 0o600 })
    expect(() => readStandaloneAccessToken(emptyDir)).toThrow('size is invalid')

    const largeDir = root()
    writeFileSync(join(largeDir, 'standalone-token'), 'x'.repeat(4097), { mode: 0o600 })
    expect(() => readStandaloneAccessToken(largeDir)).toThrow('size is invalid')

    const directoryDir = root()
    mkdirSync(join(directoryDir, 'standalone-token'), { mode: 0o600 })
    expect(() => readStandaloneAccessToken(directoryDir)).toThrow()
  })
})
