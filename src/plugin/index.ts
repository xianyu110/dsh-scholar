/**
 * DSH Research OS — Cordis plugin entry (bundle: @dsh-scholar/research-plugin).
 *
 * Lifecycle (acceptance-tests.md §9, hardening §4 row 100):
 * 1. apply() is ASYNC and Cordis awaits it (cordis 4.0.0-rc.7 `_execute`
 *    collects a thenable apply result and `ctx.plugin()` resolves through
 *    `fiber.await()`, which waits for the fiber's reload task — so the plugin
 *    is only ACTIVE after apply settles). The kernel sidecar is started
 *    FIRST and awaited; only after `sidecar.start()` resolves are the client,
 *    `ctx.research` (with the RESOLVED endpoint — `port: 0` included), the
 *    research tool surface, the /research command family and the skill packs
 *    registered. Nothing is published before the kernel is healthy, so a
 *    `port: 0` endpoint is always the real bound port and no tool/command
 *    ever sees an unresolved endpoint.
 * 2. Start failure: logged explicitly and rethrown — Cordis marks the fiber
 *    FAILED and unloads everything registered so far (at that point only the
 *    sidecar disposer), so no half-initialized resource survives.
 * 3. Disposal: every resource is owned by the plugin fiber's Cordis effect
 *    model and released on dispose/reload — `ctx.tools.register` /
 *    `ctx.commands.register` / `ctx.on` / `ctx.provide` / `ctx.plugin` all
 *    register effect disposers on the calling fiber (verified in
 *    dsh-tools/dsh-commands/dsh-scope/cordis sources), and the sidecar
 *    disposer (`ctx.effect`) is registered FIRST so even a dispose during
 *    the async startup stops the kernel. Reload unloads the old fiber
 *    (kills the old sidecar, unregisters tools/commands/listeners) before
 *    re-applying, so no duplicate registration or leaked listener survives.
 * 4. Instance closure: all mutable state (client, cache, RoleRegistry,
 *    tool context) lives in per-apply closures — there is no module-level
 *    mutable ref, so two plugin instances in one process never cross-talk.
 *
 * Security stance (§1.2, §4.9): no danger-full-access, no web_fetch, no MCP,
 * no cordis self tools. Default permission surface stays workspace-write + ask.
 * @module @dsh-scholar/research-plugin
 */

import type { Context } from 'cordis'
// Module augmentations: ctx.tools (ToolRegistry), ctx.commands (CommandService).
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import * as SkillLocal from '@deepseek-ai/dsh-skill-local'
import { mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchClient } from '@dsh-scholar/research-client'
import { DiskCache } from '@dsh-scholar/scholar-connectors'
import { KernelSidecar, resolveDshHome } from './sidecar.js'
import { registerResearchTools } from './tools.js'
import { registerResearchCommands } from './commands.js'
import { RoleRegistry, RESEARCH_TOOLS, type ResearchRole } from './acl.js'
import { resolveExistingSkillDirs, selectSkillPacks, selectedSkillNames, type SkillSelection } from './skills.js'

export const name = 'research-plugin'

export const inject = ['tools', 'commands', 'subagents']

export interface ResearchPluginConfig {
  kernel?: {
    host?: string
    port?: number
    dataDir?: string
    token?: string
  }
  /** gate-only keeps every human gate; full-auto is for low-risk sandboxes only. */
  defaultMode?: 'gate-only' | 'full-auto'
  /** Unattended runs never block on questions; gates park the project. */
  unattended?: boolean
  /** Per-role model routing for spawned panel children (design §8.5). */
  models?: Record<string, string>
  /** Directory for connector response caches (defaults under dataDir). */
  cacheDir?: string
}

declare module 'cordis' {
  interface Context {
    research: {
      client: ResearchClient
      roles: RoleRegistry
      endpoint: string
      projectIdFor(sessionId: string): Promise<string | null>
      /** Deterministic Brief → skill pack selection (acceptance-tests.md §9). */
      skillsFor(brief: { domain?: string | null; target_venue?: string | null } | null | undefined): SkillSelection
    }
  }
}

/** Model preference file written by the standalone UI (/api/model).
 *  Same path contract as packages/dsh-research-ui/src/standalone/server.ts. */
const STANDALONE_MODEL_FILE = 'model.json'

function standaloneModelPreference(): string {
  try {
    const base = process.env.DSH_SCHOLAR_STANDALONE_DATA ?? join(homedir(), '.dsh-scholar-standalone', 'research-ui-standalone')
    const raw = readFileSync(join(base, STANDALONE_MODEL_FILE), 'utf8')
    const parsed = JSON.parse(raw) as { model?: unknown }
    return typeof parsed.model === 'string' ? parsed.model : ''
  } catch {
    return ''
  }
}

/**
 * §8.5 per-role model routing for spawned panel children. Resolution order:
 * explicit config.models[role] → standalone UI preference (primary role
 * only) → undefined (agent default).
 */
function modelForRole(config: ResearchPluginConfig, role: string): string | undefined {
  const explicit = config.models?.[role]
  if (explicit !== undefined && explicit !== '') return explicit
  if (role === 'pi') {
    const preferred = standaloneModelPreference()
    if (preferred !== '') return preferred
  }
  return undefined
}

/**
 * Cordis plugin apply (async — Cordis 4.0.0-rc.7 awaits a thenable apply
 * result; `ctx.plugin()` resolves via `fiber.await()` only after apply
 * settles). Ordering contract (hardening §4 row 100):
 *   1. register the sidecar disposer FIRST — a dispose/reload during the
 *      async startup below still stops the kernel (no orphaned sidecar);
 *   2. await `sidecar.start()` — the kernel is healthy (and, for `port: 0`,
 *      the real bound port is resolved) BEFORE anything is published;
 *   3. only then construct the client, provide `ctx.research` (endpoint is
 *      the resolved real port) and register tools/commands/skills.
 * A start failure is logged and rethrown: Cordis marks the fiber FAILED and
 * unloads everything registered so far, so no half-initialized resource
 * (tools/commands/services pointing at a dead kernel) survives.
 */
export async function apply(ctx: Context, config: ResearchPluginConfig = {}): Promise<void> {
  const unattended = config.unattended ?? false
  // True once this fiber's disposer ran (dispose/reload mid-startup).
  let disposed = false
  const sidecar = new KernelSidecar({
    host: config.kernel?.host,
    port: config.kernel?.port,
    dataDir: config.kernel?.dataDir,
    token: config.kernel?.token,
    log: line => ctx.logger('research').info(line.replace(/^\[research-plugin\] /, '')),
  })
  // Disposer FIRST (effect model): sidecar.stop() runs on fiber unload; the
  // flag lets the in-flight startup below recognize a dispose instead of
  // logging a spurious failure. stop() only ever terminates OUR child and
  // only removes the endpoint.json owned by it (SIDE-01 ownership).
  ctx.effect(() => () => {
    disposed = true
    return sidecar.stop()
  }, 'research-plugin.sidecar')

  try {
    await sidecar.start()
  } catch (error) {
    if (disposed) {
      // Plugin was disposed/reloaded while the kernel was still booting;
      // the disposer already stopped the child. Not an error.
      ctx.logger('research').info('research-plugin disposed while the kernel was starting; apply aborted')
      return
    }
    ctx.logger('research').error(`kernel sidecar failed to start: ${(error as Error).message}`)
    // Cordis marks the fiber FAILED and unloads the (sidecar-only) effects.
    throw error
  }
  if (disposed) return

  // The endpoint getter is only read AFTER start: with `port: 0` it resolves
  // the real bound port from the kernel's 0600 runtime/endpoint.json; with a
  // fixed port the kernel is verified healthy on it (SIDE-01 identity gate).
  const client = new ResearchClient({
    endpoint: sidecar.endpoint,
    // §5 P0-1 (hardening API-01/SIDE-01): the plugin client authenticates to
    // the kernel's PUBLIC v1/v2 API with the same bearer token the sidecar
    // handed the kernel (0600 <dataDir>/kernel-token; seeded by
    // config.kernel.token on first creation, file stays authoritative).
    token: sidecar.kernelToken,
    // §4 P0 (API-01/EVID-01): the plugin's client authenticates to the
    // kernel's INTERNAL routes with the same service identity the sidecar
    // handed the kernel (0600 <dataDir>/service-token).
    serviceToken: sidecar.serviceToken,
  })
  const cacheDir = config.cacheDir ?? join(sidecar.dataDir, 'connector-cache')
  const cache = new DiskCache(cacheDir)
  const roles = new RoleRegistry()

  // Project resolution service for other plugins / commands.
  ctx.provide('research', {
    client,
    roles,
    endpoint: sidecar.endpoint,
    projectIdFor: async (sessionId: string) => {
      const project = await client.getProjectBySession(sessionId).catch(() => null)
      return project?.project_id ?? null
    },
    skillsFor: selectSkillPacks,
  })

  // Research tool surface (design §4.1) with per-role ACL (§1.3 least privilege).
  // Model routing: explicit config.models[role] wins; otherwise the standalone
  // UI preference (model.json in the standalone data dir) applies to the
  // primary role; '' means the agent default.
  registerResearchTools({ tools: ctx.tools }, { client, cache, ctx: ctx as never, roles, modelFor: (role) => modelForRole(config, role) })

  // Role-based ACL: deny research tools outside the caller role's surface.
  const researchToolSet = new Set<string>(RESEARCH_TOOLS)
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agentId = exec.agent?.id
    if (agentId !== undefined && researchToolSet.has(exec.name)) {
      const role = roles.get(agentId)
      if (!roles.allows(role, exec.name)) {
        return { kind: 'deny', reason: `research tool ${exec.name} is outside the ${role} role's tool surface (least privilege, design §4.1)` }
      }
    }
    return next()
  })

  // /research command family (design 附录 A).
  registerResearchCommands(ctx, { client, cache, unattended })

  // Skill pack mount: methodology plus deterministic domain/venue packs.
  // §9: the provider resolves the four groups from the PUBLISHED PACKAGE
  // ROOT (`<root>/skills/`, two parents up from lib/plugin) — never a
  // non-existent `lib/skills`. All four stay discoverable; which packs apply
  // to a project is the deterministic `selectSkillPacks(brief)` decision
  // (exposed as ctx.research.skillsFor and echoed by research_project create).
  const { dirs: skillDirs, missing: missingSkills } = resolveExistingSkillDirs()
  if (missingSkills.length > 0) {
    ctx.logger('research').warn(`skill groups missing from package root: ${missingSkills.join(', ')}`)
  }
  void ctx.plugin(SkillLocal, {
    providerName: 'dsh-scholar:research-skills',
    includeDefaultRoots: false,
    customSkillDirs: skillDirs,
    watch: false,
  }).then(undefined, error => {
    ctx.logger('research').warn(`skill mount failed: ${(error as Error).message}`)
  })
}

/** Helper for tests: build a scratch cache dir. */
export function scratchCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-scholar-cache-'))
}

export { KernelSidecar, resolveDshHome, RoleRegistry, type ResearchRole }
export { applyPatchToWorkspace, snapshotWorkspace } from './tools.js'
export { selectSkillPacks, selectedSkillNames, resolveSkillRoot, resolveSkillDirs, SKILL_GROUPS, type SkillSelection } from './skills.js'
