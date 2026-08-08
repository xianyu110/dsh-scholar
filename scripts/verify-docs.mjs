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
  ['docs/README.md', ['需求与修复的文档先行规则', 'subagent']],
  ['docs/product-spec.md', ['全页面 i18n', 'Manuscript Workbench']],
  ['docs/api-contracts.md', ['Terminal SSE', '/v2/documents/{id}/moves']],
  ['docs/gui-plugin-plan.md', ['实时终端', 'i18n 硬约束']],
  ['docs/security-baseline.md', ['Cordis self-referential', 'Terminal 安全']],
  ['docs/acceptance-tests.md', ['docs-contract-sync', 'TeX Workbench']],
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

if (errors.length > 0) {
  for (const error of errors) console.error('[verify-docs] ' + error)
  process.exit(1)
}

console.log('[verify-docs] ' + requiredDocs.length + ' documents verified')
