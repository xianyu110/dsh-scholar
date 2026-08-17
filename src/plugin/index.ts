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
 *    research tool surface, direct slash commands and the skill packs
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

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Module augmentations: ctx.tools (ToolRuntime), ctx.commands (CommandRuntime).
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-user-questions'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { KernelUnavailableError, ResearchClient } from '@dsh-scholar/research-client'
import { DiskCache } from '@dsh-scholar/scholar-connectors'
import { KernelSidecar, resolveDshHome } from './sidecar.js'
import { registerResearchTools } from './tools.js'
import { registerResearchCommands } from './commands.js'
import { RoleRegistry, RESEARCH_TOOLS, stageProjectScopeDenial, type ResearchRole } from './acl.js'
import { resolveExistingSkillDirs, selectSkillPacks, selectedSkillNames, type SkillSelection } from './skills.js'
import { readStandaloneAccessToken } from './standalone-token.js'
import { createScholarRpcHandler, createScholarViewRpcHandler } from './settings-rpc.js'
import { projectCreateIdempotencyKey } from './native-chat.js'
import {
  buildScholarSessionProjection,
  type ScholarProjectSummary,
  type ScholarSessionWorkspace,
} from '../shared/research-stage.js'
import {
  DEFAULT_STAGE_SUBAGENT_CONFIG,
  StageSubagentCoordinator,
  type StageSubagentConfig,
} from './stage-subagents.js'
import {
  DEFAULT_STANDALONE_SHORTCUT,
  DEFAULT_STANDALONE_URL,
  normalizeStandaloneShortcut,
  normalizeStandaloneUrl,
  type StandaloneShortcut,
} from '../shared/standalone.js'

export const name = 'research-plugin'

/** DSH Settings namespace owned by the research plugin. */
export const RESEARCH_SETTINGS_NAMESPACE = settingsNamespace(name)

// Settings is a boot dependency, not an opportunistic lookup: the persisted
// restart-scoped section must be registered and resolved before the kernel is
// constructed. DSH's loader activates this fiber once all four services exist.
export const inject = ['tools', 'commands', 'subagents', 'settings', 'userQuestions']

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
  /** Stage-aware, bounded DSH subagent execution. Disabled until explicitly enabled. */
  subagents?: Partial<StageSubagentConfig>
  /** Directory for connector response caches (defaults under dataDir). */
  cacheDir?: string
  /** Standalone workbench launcher shown by the DSH browser half. */
  standalone?: {
    url?: string
    shortcut?: StandaloneShortcut
  }
}

type ConfigIssue = { message: string; path: PropertyKey[] }

const ROOT_CONFIG_KEYS = new Set(['kernel', 'defaultMode', 'unattended', 'models', 'subagents', 'cacheDir', 'standalone'])
const KERNEL_CONFIG_KEYS = new Set(['host', 'port', 'dataDir', 'token'])
const STANDALONE_CONFIG_KEYS = new Set(['url', 'shortcut'])
const SUBAGENT_CONFIG_KEYS = new Set(['enabled', 'provider', 'maxConcurrency', 'maxFanoutPerAction', 'maxDepth', 'timeoutMs', 'maxOutputBytes'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reject config drift instead of silently accepting misspelled or v2-only fields. */
function unknownConfigIssues(value: unknown): ConfigIssue[] {
  if (!isRecord(value)) return []
  const issues: ConfigIssue[] = []
  for (const key of Object.keys(value)) {
    if (!ROOT_CONFIG_KEYS.has(key)) {
      issues.push({ message: `unknown config key "${key}"`, path: [key] })
    }
  }
  if (isRecord(value.kernel)) {
    for (const key of Object.keys(value.kernel)) {
      if (!KERNEL_CONFIG_KEYS.has(key)) {
        issues.push({ message: `unknown config key "kernel.${key}"`, path: ['kernel', key] })
      }
    }
  }
  if (isRecord(value.standalone)) {
    for (const key of Object.keys(value.standalone)) {
      if (!STANDALONE_CONFIG_KEYS.has(key)) {
        issues.push({ message: `unknown config key "standalone.${key}"`, path: ['standalone', key] })
      }
    }
  }
  if (isRecord(value.subagents)) {
    for (const key of Object.keys(value.subagents)) {
      if (!SUBAGENT_CONFIG_KEYS.has(key)) {
        issues.push({ message: `unknown config key "subagents.${key}"`, path: ['subagents', key] })
      }
    }
  }
  return issues
}

function standaloneConfigIssues(value: unknown): ConfigIssue[] {
  if (!isRecord(value) || !isRecord(value.standalone)) return []
  const issues: ConfigIssue[] = []
  if (typeof value.standalone.url === 'string') {
    try {
      normalizeStandaloneUrl(value.standalone.url)
    } catch (error) {
      issues.push({ message: (error as Error).message, path: ['standalone', 'url'] })
    }
  }
  if (typeof value.standalone.shortcut === 'string') {
    try {
      normalizeStandaloneShortcut(value.standalone.shortcut)
    } catch (error) {
      issues.push({ message: (error as Error).message, path: ['standalone', 'shortcut'] })
    }
  }
  return issues
}

/**
 * Schemastery supplies the DSH config editor metadata and defaults. Its object
 * validator intentionally preserves unknown properties, while Scholar's
 * canonical config contract is fail-closed, so the Standard Schema seam adds
 * strict-key issues without changing the host-visible Schemastery shape.
 */
function strictPluginConfig(schema: z<ResearchPluginConfig>): z<ResearchPluginConfig> {
  const standard = schema['~standard']
  Object.defineProperty(schema, '~standard', {
    value: {
      version: standard.version,
      vendor: standard.vendor,
      validate(value: unknown) {
        const result = standard.validate(value)
        if (result instanceof Promise) {
          return result.then((resolved) => {
            if (resolved.issues !== undefined) return resolved
            const issues = [...unknownConfigIssues(value), ...standaloneConfigIssues(resolved.value)]
            return issues.length > 0 ? { issues } : resolved
          })
        }
        if (result.issues !== undefined) return result
        const issues = [...unknownConfigIssues(value), ...standaloneConfigIssues(result.value)]
        return issues.length > 0 ? { issues } : result
      },
    },
  })
  return schema
}

/** Runtime config schema discovered by the real DSH/Cordis plugin loader. */
export const Config: z<ResearchPluginConfig> = strictPluginConfig(z.object({
  kernel: z.object({
    host: z.string().min(1).default('127.0.0.1').description('Research Kernel bind host.'),
    port: z.natural().max(65_535).default(7412).description('Research Kernel port; 0 requests an ephemeral loopback port.'),
    dataDir: z.string().min(1).description('Directory containing kernel.db, CAS, runtime identity and token files.'),
    token: z.string().min(1).role('secret').description('Optional initial Kernel bearer token; persisted in a 0600 token file.'),
  }).default({} as never).description('Managed Research Kernel sidecar.'),
  defaultMode: z.union(['gate-only', 'full-auto'] as const).default('gate-only')
    .description('Default project governance mode; full-auto remains fixture-only.'),
  unattended: z.boolean().default(false)
    .description('Park at human gates instead of waiting for interactive answers.'),
  models: z.dict(z.string().min(1)).default({})
    .description('Per-role model routing for research subagents.'),
  subagents: z.object({
    enabled: z.boolean().default(false)
      .description('Enable stage-aware DSH subagent panels; disabled is the fail-closed default.'),
    provider: z.union(['spawn'] as const).default('spawn')
      .description('One-shot DSH subagent provider.'),
    maxConcurrency: z.natural().min(1).max(16).default(4)
      .description('Maximum concurrent panel children across this plugin instance.'),
    maxFanoutPerAction: z.natural().min(1).max(16).default(6)
      .description('Maximum perspectives accepted by one stage action.'),
    maxDepth: z.union([1] as const).default(1)
      .description('Absolute subagent delegation depth cap; stage panels do not recurse.'),
    timeoutMs: z.natural().min(1_000).max(3_600_000).default(300_000)
      .description('Per-child timeout in milliseconds.'),
    maxOutputBytes: z.natural().min(1_024).max(1_048_576).default(131_072)
      .description('Maximum validated structured output bytes per child.'),
  }).default({} as never).description('Stage-aware DSH subagent execution policy.'),
  cacheDir: z.string().min(1).description('Connector response cache directory.'),
  standalone: z.object({
    url: z.string().min(1).default(DEFAULT_STANDALONE_URL)
      .description('Standalone workbench URL; HTTPS or loopback HTTP without credentials/query/fragment.'),
    shortcut: z.union([DEFAULT_STANDALONE_SHORTCUT, 'disabled'] as const).default(DEFAULT_STANDALONE_SHORTCUT)
      .description('Global shortcut for opening Scholar in a new browser page.'),
  }).default({} as never).description('DSH browser launcher for the standalone workbench.'),
}).default({} as never))

declare module '@deepseek-ai/cordis' {
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
  // Cordis entry Config and the durable user section are distinct layers.
  // Register before sidecar construction so a restart applies the persisted
  // section to every closure and process option created by this fiber.
  const settings = typeof ctx.get === 'function' ? ctx.get('settings') as SettingsProvider | undefined : undefined
  const settingsScope = settings?.register(RESEARCH_SETTINGS_NAMESPACE, Config, {
    base: config,
    applies: 'restart',
  })
  const effectiveConfig = settingsScope?.get() ?? config
  const unattended = effectiveConfig.unattended ?? false

  let readSessionWorkspace: ((sessionId: string, signal: AbortSignal) => Promise<ScholarSessionWorkspace>) | undefined
  let bindSessionProject: ((sessionId: string, projectId: string, signal: AbortSignal) => Promise<ScholarSessionWorkspace>) | undefined
  let createSessionProject: ((sessionId: string, name: string, signal: AbortSignal) => Promise<ScholarSessionWorkspace>) | undefined

  // Optional browser Host seam. Privileged settings/token operations remain
  // loopback-only; the trusted-host view channel owns only the redacted,
  // session-bound panel and its exclusive select/create link operations.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], connectionCtx => {
      const disposePrivate = connectionCtx.connection.rpc.handle(
        '/dsh-scholar',
        createScholarRpcHandler(settings as SettingsProvider, readStandaloneAccessToken),
        { authority: 'loopback' },
      )
      const disposeView = connectionCtx.connection.rpc.handle(
        '/dsh-scholar-view',
        createScholarViewRpcHandler({
          readSessionWorkspace: (sessionId, signal) => {
            if (readSessionWorkspace === undefined) throw new Error('Scholar session workspace is unavailable')
            return readSessionWorkspace(sessionId, signal)
          },
          bindSessionProject: (sessionId, projectId, signal) => {
            if (bindSessionProject === undefined) throw new Error('Scholar session binding is unavailable')
            return bindSessionProject(sessionId, projectId, signal)
          },
          createSessionProject: (sessionId, projectName, signal) => {
            if (createSessionProject === undefined) throw new Error('Scholar session project creation is unavailable')
            return createSessionProject(sessionId, projectName, signal)
          },
        }),
        { authority: 'trusted-host' },
      )
      return async () => {
        await disposeView()
        await disposePrivate()
      }
    })
  }
  // True once this fiber's disposer ran (dispose/reload mid-startup).
  let disposed = false
  const sidecar = new KernelSidecar({
    host: effectiveConfig.kernel?.host,
    port: effectiveConfig.kernel?.port,
    dataDir: effectiveConfig.kernel?.dataDir,
    token: effectiveConfig.kernel?.token,
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
    dshPluginToken: sidecar.dshPluginToken,
  })
  const cacheDir = effectiveConfig.cacheDir ?? join(sidecar.dataDir, 'connector-cache')
  const cache = new DiskCache(cacheDir)
  const roles = new RoleRegistry()
  const projectScopes = new Map<string, string>()
  const stageSubagents = new StageSubagentCoordinator({
    ...DEFAULT_STAGE_SUBAGENT_CONFIG,
    ...effectiveConfig.subagents,
  })

  const projectSummary = (project: {
    project_id: string; name: string; status: string; revision: number; brief_status?: string
  }): ScholarProjectSummary => ({
    project_id: project.project_id,
    name: project.name,
    status: project.status,
    revision: project.revision,
    ...(project.brief_status === undefined ? {} : { brief_status: project.brief_status }),
  })
  const workspaceReader = async (sessionId: string, signal: AbortSignal): Promise<ScholarSessionWorkspace> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal.aborted) throw new Error('aborted')
      const project = await client.getProjectBySession(sessionId, signal)
      if (signal.aborted) throw new Error('aborted')
      if (project !== null) {
        const projection = await client.projectProjection(project.project_id, signal)
        if (signal.aborted) throw new Error('aborted')
        const confirmed = await client.getProjectBySession(sessionId, signal)
        if (signal.aborted) throw new Error('aborted')
        if (confirmed?.project_id === project.project_id) {
          return {
            session_id: sessionId,
            projection: buildScholarSessionProjection(sessionId, projection),
            available_projects: [],
          }
        }
        continue
      }
      const projects = await client.listProjectsForDshSession(sessionId, signal)
      if (signal.aborted) throw new Error('aborted')
      const confirmed = await client.getProjectBySession(sessionId, signal)
      if (signal.aborted) throw new Error('aborted')
      if (confirmed === null) {
        return {
          session_id: sessionId,
          projection: buildScholarSessionProjection(sessionId),
          available_projects: [...projects]
            .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
            .map(projectSummary),
        }
      }
    }
    throw new Error('Scholar session link changed during workspace read')
  }
  const bindingWriter = async (sessionId: string, projectId: string, signal: AbortSignal): Promise<ScholarSessionWorkspace> => {
    try {
      await client.linkProjectForDshSession(sessionId, projectId, signal)
    } catch (error) {
      if (!(error instanceof KernelUnavailableError)) throw error
      const linked = await client.getProjectBySession(sessionId)
      if (linked?.project_id !== projectId) throw error
    }
    return workspaceReader(sessionId, new AbortController().signal)
  }
  const creationWriter = async (sessionId: string, projectName: string, signal: AbortSignal): Promise<ScholarSessionWorkspace> => {
    const idempotencyKey = projectCreateIdempotencyKey(sessionId, projectName)
    try {
      await client.createProjectForDshSession({ session_id: sessionId, name: projectName, idempotency_key: idempotencyKey }, signal)
    } catch (error) {
      if (!(error instanceof KernelUnavailableError)) throw error
      try {
        await client.createProjectForDshSession({
          session_id: sessionId, name: projectName, idempotency_key: idempotencyKey, replay_only: true,
        })
      } catch { throw error }
    }
    return workspaceReader(sessionId, new AbortController().signal)
  }
  readSessionWorkspace = workspaceReader
  bindSessionProject = bindingWriter
  createSessionProject = creationWriter
  ctx.effect(() => () => {
    if (readSessionWorkspace === workspaceReader) readSessionWorkspace = undefined
    if (bindSessionProject === bindingWriter) bindSessionProject = undefined
    if (createSessionProject === creationWriter) createSessionProject = undefined
  }, 'research-plugin.session-workspace')

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
  registerResearchTools({ tools: ctx.tools }, {
    client,
    cache,
    ctx: ctx as never,
    roles,
    projectScopes,
    modelFor: role => modelForRole(effectiveConfig, role),
    stageSubagents,
    defaultMode: effectiveConfig.defaultMode ?? 'gate-only',
    operatorPrincipal: sidecar.operatorPrincipal,
  })

  // Role-based ACL: deny research tools outside the caller role's surface.
  const researchToolSet = new Set<string>(RESEARCH_TOOLS)
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agentId = exec.agent?.id
    if (agentId !== undefined && researchToolSet.has(exec.name)) {
      const role = roles.get(agentId)
      if (!roles.allows(role, exec.name)) {
        return { kind: 'deny', reason: `research tool ${exec.name} is outside the ${role} role's tool surface (least privilege, design §4.1)` }
      }
      if (exec.name === 'research_panel') {
        return { kind: 'ask', reason: 'Start the stage-aware subagent panel for the current ready research action?' }
      }
      const projectScope = projectScopes.get(agentId)
      if (projectScope !== undefined) {
        const denial = await stageProjectScopeDenial(projectScope, exec.arguments, async jobId => (await client.getJob(jobId)).project_id)
        if (denial !== undefined) return { kind: 'deny', reason: denial }
      }
    }
    return next()
  })

  // Direct slash commands (design 附录 A).
  registerResearchCommands(ctx, {
    client,
    cache,
    unattended,
    defaultMode: effectiveConfig.defaultMode ?? 'gate-only',
    operatorPrincipal: sidecar.operatorPrincipal,
  })

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
  try {
    await ctx.plugin(SkillFilesystem, {
      providerName: 'dsh-scholar:research-skills',
      includeDefaultRoots: false,
      customSkillDirs: skillDirs,
      watch: false,
    })
  } catch (error) {
    ctx.logger('research').error(`skill mount failed: ${(error as Error).message}`)
    // A plugin advertised as ACTIVE must have its documented Skill surface.
    // Rethrowing makes Cordis unload the already registered child effects,
    // tools, commands, research service and sidecar in one lifecycle rollback.
    throw error
  }
}

/** Helper for tests: build a scratch cache dir. */
export function scratchCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-scholar-cache-'))
}

export { KernelSidecar, resolveDshHome, RoleRegistry, type ResearchRole }
export { applyPatchToWorkspace, snapshotWorkspace } from './tools.js'
export { selectSkillPacks, selectedSkillNames, resolveSkillRoot, resolveSkillDirs, SKILL_GROUPS, type SkillSelection } from './skills.js'
