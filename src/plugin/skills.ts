/**
 * Skill pack resolution and deterministic domain/venue selection (design
 * §4.2, acceptance-tests.md §9).
 *
 * The skill provider always mounts the four groups from the PUBLISHED
 * PACKAGE ROOT (`<package-root>/skills/`), never a non-existent
 * `lib/skills`: after `tsc` the plugin lives at `<root>/lib/plugin/`, so the
 * package-root skills dir is exactly two parent traversals up.
 *
 * `selectSkillPacks(brief)` is the deterministic Brief → skill mapping:
 *   - brief.domain contains `machine-learning` (or is `ml`)  → domain-machine-learning
 *   - brief.domain contains `data-science` (or is `ds`)      → domain-data-science
 *   - brief.target_venue is a stated venue (non-empty)       → venue-templates
 *     (the pack ships conference-paper/journal/arXiv templates, so any
 *     stated venue maps to it)
 *   - no match → research-core only (always selected)
 * @module @dsh-scholar/research-plugin/skills
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

/** The four skill groups shipped from the package root (acceptance §9). */
export const SKILL_GROUPS = [
  'research-core',
  'domain-machine-learning',
  'domain-data-science',
  'venue-templates',
] as const

export type SkillGroup = typeof SKILL_GROUPS[number]

/** Resolve the package-root skills directory (lib/plugin → ../../skills). */
export function resolveSkillRoot(): string {
  const ownDir = dirname(fileURLToPath(import.meta.url))
  return join(ownDir, '..', '..', 'skills')
}

/** Absolute dirs of every skill group under the package root. */
export function resolveSkillDirs(): Array<{ name: SkillGroup; dir: string }> {
  const root = resolveSkillRoot()
  return SKILL_GROUPS.map(name => ({ name, dir: join(root, name) }))
}

export interface SkillSelection {
  core: 'research-core'
  domain: 'domain-machine-learning' | 'domain-data-science' | null
  venue: 'venue-templates' | null
}

/**
 * Deterministic Brief → skill pack selection (§9). Pure function: identical
 * Briefs always select identical packs. Any stated target_venue selects the
 * venue-templates pack (it ships conference-paper/journal/arXiv templates).
 */
export function selectSkillPacks(brief: { domain?: string | null; target_venue?: string | null } | null | undefined): SkillSelection {
  // Normalize: lowercase, trim, collapse internal whitespace to '-' so
  // "data science" and "data-science" (or "machine learning" / "ML") match.
  const domain = (brief?.domain ?? '').toLowerCase().trim().replace(/\s+/g, '-')
  const venue = (brief?.target_venue ?? '').trim()
  let domainPack: SkillSelection['domain'] = null
  if (domain === 'ml' || domain.includes('machine-learning')) {
    domainPack = 'domain-machine-learning'
  } else if (domain === 'ds' || domain.includes('data-science')) {
    domainPack = 'domain-data-science'
  }
  const venuePack: SkillSelection['venue'] = venue !== '' ? 'venue-templates' : null
  return { core: 'research-core', domain: domainPack, venue: venuePack }
}

/** The concrete pack names selected for a Brief, in mount order. */
export function selectedSkillNames(brief: { domain?: string | null; target_venue?: string | null } | null | undefined): SkillGroup[] {
  const selection = selectSkillPacks(brief)
  return [selection.core, selection.domain, selection.venue].filter((name): name is SkillGroup => name !== null)
}

/** Skill dirs that actually exist under the package root (missing -> warn). */
export function resolveExistingSkillDirs(): { dirs: string[]; missing: string[] } {
  const dirs: string[] = []
  const missing: string[] = []
  for (const { name, dir } of resolveSkillDirs()) {
    if (existsSync(dir)) dirs.push(dir)
    else missing.push(name)
  }
  return { dirs, missing }
}
