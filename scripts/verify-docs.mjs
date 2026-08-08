import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requiredDocs = [
  'docs/README.md',
  'docs/product-spec.md',
  'docs/design-notes.md',
  'docs/domain-model.md',
  'docs/reconstruction-contracts.md',
  'docs/storage-migrations.md',
  'docs/api-contracts.md',
  'docs/dsh-integration.md',
  'docs/execution-runtime.md',
  'docs/gui-plugin-plan.md',
  'docs/security-baseline.md',
  'docs/repository-blueprint.md',
  'docs/acceptance-tests.md',
  'docs/test-instance-plan.md',
  'docs/USAGE_GUIDE.md',
  'docs/hardening-v0.2-status.md',
]

const errors = []

for (const relative of requiredDocs) {
  const absolute = resolve(root, relative)
  if (!existsSync(absolute)) {
    errors.push('missing required document: ' + relative)
    continue
  }
  const text = readFileSync(absolute, 'utf8')
  const fences = text.split(/\r?\n/).filter((line) => /^(?:```|~~~)/.test(line.trim()))
  if (fences.length % 2 !== 0) errors.push('unbalanced Markdown fence: ' + relative)

  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, '').split('#')[0]
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue
    const linked = resolve(dirname(absolute), target)
    if (!existsSync(linked)) errors.push('broken link in ' + relative + ': ' + target)
  }
}

const requiredFragments = new Map([
  ['docs/README.md', ['需求与修复的文档先行规则', 'subagent', '浏览器 UI 只支持独立模式']],
  ['docs/product-spec.md', ['全页面 i18n', 'Manuscript Workbench']],
  ['docs/api-contracts.md', ['Terminal SSE', '/v2/documents/{id}/moves']],
  ['docs/gui-plugin-plan.md', ['实时终端', 'i18n 硬约束']],
  ['docs/security-baseline.md', ['Cordis self-referential', 'Terminal 安全']],
  ['docs/acceptance-tests.md', ['docs-contract-sync', 'TeX Workbench', '根包无 `dshClient`']],
  ['docs/hardening-v0.2-status.md', ['TERM-01', 'TEX-01', 'UI-02']],
  ['configs/research-dev-selfmod.cordis.yml', ['@deepseek-ai/dsh-tool-cordis']],
])

for (const [relative, fragments] of requiredFragments) {
  const absolute = resolve(root, relative)
  if (!existsSync(absolute)) {
    errors.push('missing contract file: ' + relative)
    continue
  }
  const text = readFileSync(absolute, 'utf8')
  for (const fragment of fragments) {
    if (!text.includes(fragment)) errors.push('missing contract fragment in ' + relative + ': ' + fragment)
  }
}

const forbiddenEmbeddedPaths = [
  'src/client-panel.ts',
  'src/plugin/web-bridge.ts',
  'tsdown.client.config.ts',
  'scripts/start-test-dsh.sh',
  'scripts/verify-client-bundle.mjs',
  'packages/dsh-research-ui/cordis.patch.yml',
  'packages/dsh-research-ui/src/host/index.ts',
  'packages/dsh-research-ui/src/host/bridge.ts',
  'packages/dsh-research-ui/src/host/sidecar.ts',
  'packages/dsh-research-ui/src/host',
  'packages/dsh-research-ui/lib/host',
]

for (const relative of forbiddenEmbeddedPaths) {
  if (existsSync(resolve(root, relative))) errors.push('DSH embedded UI surface must not exist: ' + relative)
}

const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
if (rootPackage.dshClient !== undefined) errors.push('root package must not declare dshClient')
if (rootPackage.exports?.['./client'] !== undefined) errors.push('root package must not export ./client')

const uiPackage = JSON.parse(readFileSync(resolve(root, 'packages/dsh-research-ui/package.json'), 'utf8'))
if (uiPackage.dshClient !== undefined) errors.push('research-ui package must not declare dshClient')
if (uiPackage.dsh !== undefined) errors.push('research-ui package must not declare a DSH bundle')
if (uiPackage.peerDependencies?.cordis !== undefined) errors.push('research-ui package must not depend on Cordis')
if (String(uiPackage.main ?? '').includes('/host/')) errors.push('research-ui main export must be standalone')
if (!Array.isArray(uiPackage.files) || uiPackage.files.some(path => String(path).includes('host'))) {
  errors.push('research-ui package files must explicitly exclude the deleted Cordis host surface')
}

const uiClientSource = readFileSync(resolve(root, 'packages/dsh-research-ui/src/client/index.ts'), 'utf8')
if (/\bfullscreen\b/.test(uiClientSource) || /position:fixed;right:12px;bottom:64px/.test(uiClientSource)) {
  errors.push('research-ui client must not retain floating/embedded mode branches')
}

// SELFMOD-01: tool-cordis is a dev-only self-modification surface. It must
// never ship in the production bundle patch or any non-dev profile config.
const shippedPatch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')
if (shippedPatch.includes('tool-cordis')) {
  errors.push('production cordis.patch.yml must not mount tool-cordis (SELFMOD-01)')
}
for (const profile of ['research-web', 'research-headless']) {
  const config = resolve(root, `configs/${profile}.cordis.yml`)
  if (!existsSync(config)) continue
  const text = readFileSync(config, 'utf8')
  if (text.includes('tool-cordis')) {
    errors.push(`profile config ${profile} must not mount tool-cordis (SELFMOD-01)`)
  }
}
const startSelfmod = readFileSync(resolve(root, 'scripts/start-selfmod-dev.sh'), 'utf8')
const startAgent = readFileSync(resolve(root, 'scripts/start-dsh-agent-dev.sh'), 'utf8')
if (!startSelfmod.includes('research-dev-selfmod.cordis.yml')) {
  errors.push('start-selfmod-dev.sh must load the explicit dev-only overlay (SELFMOD-01)')
}
if (startAgent.includes('research-dev-selfmod.cordis.yml')) {
  errors.push('start-dsh-agent-dev.sh must NOT load the selfmod overlay (SELFMOD-01)')
}

// DOC-02: change-aware docs sync — when source or eval files changed in the
// reviewed range, the hardening status ledger must have moved too (DOC-01:
// every implementation change updates hardening-v0.2-status.md).
// Usage: node scripts/verify-docs.mjs --diff-check [<base-ref>]
if (process.argv.includes('--diff-check')) {
  const base = process.argv[process.argv.indexOf('--diff-check') + 1] ?? 'origin/main'
  const changed = runGit(['diff', '--name-only', `${base}...HEAD`])
  const sourceChanged = changed.some((file) =>
    /^(?:packages|workers)\/[^/]+\/src\/.+\.(?:ts|tsx)$/.test(file) && !file.endsWith('.test.ts'))
  const evalChanged = changed.some((file) => file.startsWith('evals/') && file.endsWith('.sh'))
  const statusLedgerChanged = changed.some((file) => file === 'docs/hardening-v0.2-status.md')
  if ((sourceChanged || evalChanged) && !statusLedgerChanged) {
    errors.push(`DOC-02: source/eval changes in this range (${base}...HEAD) must also update docs/hardening-v0.2-status.md`)
  }
}

function runGit(args) {
  try {
    const { execFileSync } = requireNode('node:child_process')
    const out = execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return out.split('\n').filter(Boolean)
  } catch {
    // No base ref available (e.g. first commit) — nothing to diff against.
    return []
  }
}

function requireNode(name) {
  return globalThis.process.getBuiltinModule ? globalThis.process.getBuiltinModule(name) : import(name)
}

if (errors.length > 0) {
  for (const error of errors) console.error('[verify-docs] ' + error)
  process.exit(1)
}

console.log('[verify-docs] ' + requiredDocs.length + ' documents verified')
