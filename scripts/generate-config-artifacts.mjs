#!/usr/bin/env node
/**
 * CONFIG-01 — regenerate the derived config artifacts from the canonical
 * Config Registry (packages/research-schemas/src/config-registry.ts):
 *
 *   configs/generated/config.schema.json  — JSON Schema (draft-07), all scopes
 *   configs/generated/template.yml        — defaults template (YAML)
 *   configs/generated/cli-help.txt        — CLI help text per scope
 *
 * The registry (Zod schemas) is the single source of truth; these files are
 * generated outputs and must never be edited by hand. Run after changing the
 * registry and commit the refreshed artifacts:
 *
 *   node scripts/generate-config-artifacts.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONFIG_SCOPES, generateCliHelp, generateJsonSchema, generateTemplateYaml } from '@dsh-scholar/research-schemas'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'configs', 'generated')
mkdirSync(outDir, { recursive: true })

const schema = generateJsonSchema()
writeFileSync(join(outDir, 'config.schema.json'), JSON.stringify(schema, null, 2) + '\n')

const template = generateTemplateYaml()
writeFileSync(join(outDir, 'template.yml'), template)

const help = CONFIG_SCOPES.map(scope => generateCliHelp(scope)).join('\n\n')
writeFileSync(join(outDir, 'cli-help.txt'), help + '\n')

console.error(`[config-artifacts] wrote ${outDir}/config.schema.json, template.yml, cli-help.txt`)
