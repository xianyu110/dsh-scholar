/**
 * PACK-01 / SKILL-01 packaging tests: every published tarball is complete
 * (lib/, skills/, cordis.patch.yml), a clean consumer install resolves via
 * overrides (file: deps stay relative in packed manifests), the installed
 * plugin declares its DSH host peers, and every skill ships with valid
 * name/description frontmatter. Full host-boot assertions belong to the
 * pending DSH fixture job (CI-01).
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const SKILLS = ['research-core', 'domain-machine-learning', 'domain-data-science', 'venue-templates']

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

interface Packed {
  dir: string
  tarballs: Record<string, string> // npm name -> tgz path
}

async function packAll(): Promise<Packed> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
  const tarballs: Record<string, string> = {}
  const targets: Array<[string, string]> = [
    [REPO, 'research-plugin'],
    [join(REPO, 'packages/research-client'), 'research-client'],
    [join(REPO, 'packages/research-kernel'), 'research-kernel'],
    [join(REPO, 'packages/research-schemas'), 'research-schemas'],
    [join(REPO, 'packages/scholar-connectors'), 'scholar-connectors'],
    [join(REPO, 'workers/runner-gateway'), 'runner-gateway'],
  ]
  for (const [cwd, name] of targets) {
    run('pnpm', ['pack', '--pack-destination', dir], cwd)
  }
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.tgz')) continue
    const m = /dsh-scholar-([a-z-]+)-\d+\.\d+\.\d+\.tgz/.exec(f)
    if (m !== null) tarballs[m[1]!] = join(dir, f)
  }
  return { dir, tarballs }
}

function tarList(tgz: string): string[] {
  return run('tar', ['-tzf', tgz], '/').split('\n').filter(Boolean)
}

describe('packaging (PACK-01/SKILL-01)', () => {
  let packed: Packed
  let rootManifest: Record<string, unknown>

  beforeAll(async () => {
    packed = await packAll()
    rootManifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as Record<string, unknown>
  }, 240_000)

  it('packs every publishable package', () => {
    for (const name of ['research-plugin', 'research-client', 'research-kernel', 'research-schemas', 'scholar-connectors', 'runner-gateway']) {
      expect(packed.tarballs[name], `tarball for ${name}`).toBeTruthy()
    }
  })

  it('plugin tarball ships lib, all four skills, patch and README', () => {
    const files = tarList(packed.tarballs['research-plugin']!)
    expect(files).toContain('package/lib/index.js')
    expect(files).toContain('package/cordis.patch.yml')
    expect(files).toContain('package/README.md')
    for (const s of SKILLS) expect(files).toContain(`package/skills/${s}/SKILL.md`)
  })

  it('every package tarball ships its compiled lib entry', () => {
    for (const name of ['research-client', 'research-kernel', 'research-schemas', 'scholar-connectors', 'runner-gateway']) {
      const files = tarList(packed.tarballs[name]!)
      expect(files.some(f => f.startsWith('package/lib/') && f.endsWith('.js')), `${name} has lib`).toBe(true)
      expect(files).toContain('package/package.json')
    }
  })

  it('plugin manifest declares its DSH host peers and a prepare build step', () => {
    const peers = rootManifest['peerDependencies'] as Record<string, string>
    for (const host of ['@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-skill-local', '@deepseek-ai/dsh-tools']) {
      expect(peers?.[host], `peer ${host}`).toBeTruthy()
    }
    const optional = rootManifest['peerDependenciesMeta'] as Record<string, unknown>
    for (const host of ['@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-skill-local', '@deepseek-ai/dsh-tools']) {
      expect(optional?.[host], `optional peer ${host}`).toMatchObject({ optional: true })
    }
    const files = rootManifest['files'] as string[]
    for (const entry of ['lib', 'skills', 'cordis.patch.yml', 'README.md']) expect(files).toContain(entry)
    expect((rootManifest['scripts'] as Record<string, string>)['prepare']).toContain('build')
  })

  it('clean consumer install resolves every @dsh-scholar tarball and lands skills on disk', () => {
    const consumer = mkdtempSync(join(tmpdir(), 'dsh-consumer-'))
    const tgz = (n: string) => packed.tarballs[n]!.replaceAll('\\', '/')
    writeFileSync(join(consumer, 'pnpm-workspace.yaml'), [
      'packages: []',
      'autoInstallPeers: false',
      'overrides:',
      `  '@dsh-scholar/research-client': file:${tgz('research-client')}`,
      `  '@dsh-scholar/research-kernel': file:${tgz('research-kernel')}`,
      `  '@dsh-scholar/research-schemas': file:${tgz('research-schemas')}`,
      `  '@dsh-scholar/scholar-connectors': file:${tgz('scholar-connectors')}`,
      `  '@dsh-scholar/runner-gateway': file:${tgz('runner-gateway')}`,
      '',
    ].join('\n'))
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({
      name: 'pack-consumer', private: true, version: '0.0.0',
      dependencies: { '@dsh-scholar/research-plugin': `file:${tgz('research-plugin')}` },
    }, null, 2))
    run('pnpm', ['install'], consumer)
    // Locate the installed plugin package dir.
    const pluginPkg = join(consumer, 'node_modules', '@dsh-scholar', 'research-plugin')
    expect(existsSync(join(pluginPkg, 'package.json'))).toBe(true)
    for (const s of SKILLS) {
      const skill = join(pluginPkg, 'skills', s, 'SKILL.md')
      expect(existsSync(skill), `installed skill ${s}`).toBe(true)
      const head = readFileSync(skill, 'utf8').slice(0, 400)
      expect(head).toContain(`name: ${s}`)
      expect(head).toContain('description:')
    }
    // The packed manifest inside node_modules declares the host peers too.
    const installed = JSON.parse(readFileSync(join(pluginPkg, 'package.json'), 'utf8')) as Record<string, unknown>
    const peers = installed['peerDependencies'] as Record<string, string>
    expect(peers?.['@deepseek-ai/dsh-skill-local']).toBeTruthy()
  }, 240_000)

  it('skills carry valid frontmatter (SKILL-01 discovery)', () => {
    for (const s of SKILLS) {
      const raw = readFileSync(join(REPO, 'skills', s, 'SKILL.md'), 'utf8')
      expect(raw.startsWith('---\n'), `${s} frontmatter opens`).toBe(true)
      const close = raw.indexOf('\n---\n', 4)
      expect(close, `${s} frontmatter closes`).toBeGreaterThan(0)
      const fm = raw.slice(4, close)
      expect(fm).toMatch(new RegExp(`^name:\\s*${s.replaceAll('-', '-')}\\s*$`, 'm'))
      expect(fm).toMatch(/^description:\s*\S.+$/m)
      expect(raw.slice(close + 5).trim().length).toBeGreaterThan(50)
    }
  })
})
