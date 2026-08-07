/**
 * DSH Research OS — Cordis plugin entry (bundle: @dsh-scholar/research-plugin).
 *
 * On apply:
 * 1. Spawns (or reuses) the Research Kernel sidecar (design §9.1).
 * 2. Registers the research tool surface with per-role ACL (§4.1).
 * 3. Registers the /research command family (附录 A).
 * 4. Mounts the research-core skill pack (§4.2 Skills / Domain Packs).
 * 5. Exposes `ctx.research` (client + role registry) for other plugins.
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
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ResearchClient } from '@dsh-scholar/research-client'
import { DiskCache } from '@dsh-scholar/scholar-connectors'
import { KernelSidecar, resolveDshHome } from './sidecar.js'
import { registerResearchTools } from './tools.js'
import { registerResearchCommands } from './commands.js'
import { registerResearchApiBridge } from './web-bridge.js'
import { RoleRegistry, RESEARCH_TOOLS, type ResearchRole } from './acl.js'

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
    }
  }
}

export function apply(ctx: Context, config: ResearchPluginConfig = {}): void {
  const unattended = config.unattended ?? false
  const sidecar = new KernelSidecar({
    host: config.kernel?.host,
    port: config.kernel?.port,
    dataDir: config.kernel?.dataDir,
    token: config.kernel?.token,
    log: line => ctx.logger('research').info(line.replace(/^\[research-plugin\] /, '')),
  })
  const client = new ResearchClient({
    endpoint: sidecar.endpoint,
    token: config.kernel?.token,
  })
  const cacheDir = config.cacheDir ?? join(sidecar.dataDir, 'connector-cache')
  const cache = new DiskCache(cacheDir)
  const roles = new RoleRegistry()

  void sidecar.start().catch(error => {
    ctx.logger('research').error(`kernel sidecar failed to start: ${(error as Error).message}`)
  })

  // Project resolution service for other plugins / commands.
  ctx.provide('research', {
    client,
    roles,
    endpoint: sidecar.endpoint,
    projectIdFor: async (sessionId: string) => {
      const project = await client.getProjectBySession(sessionId).catch(() => null)
      return project?.project_id ?? null
    },
  })

  // Research tool surface (design §4.1) with per-role ACL (§1.3 least privilege).
  registerResearchTools({ tools: ctx.tools }, { client, cache, ctx: ctx as never, roles, modelFor: (role) => config.models?.[role] })

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

  // Web-only data plane: /research-api/* -> kernel (E7 panels).
  registerResearchApiBridge(ctx, sidecar)

  // Skill pack mount: research-core methodology (design §4.2).
  const ownDir = dirname(fileURLToPath(import.meta.url))
  const skillDir = join(ownDir, '..', 'skills', 'research-core')
  void ctx.plugin(SkillLocal, {
    providerName: 'dsh-scholar:research-core',
    includeDefaultRoots: false,
    customSkillDirs: [skillDir],
    watch: false,
  }).then(undefined, error => {
    ctx.logger('research').warn(`skill mount failed: ${(error as Error).message}`)
  })

  // Tear down the sidecar when the plugin disposes (Cordis effect model).
  ctx.effect(() => () => {
    void sidecar.stop()
  }, 'research-plugin.sidecar')
}

/** Helper for tests: build a scratch cache dir. */
export function scratchCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-scholar-cache-'))
}

export { KernelSidecar, resolveDshHome, RoleRegistry, type ResearchRole }
export { applyPatchToWorkspace, snapshotWorkspace } from './tools.js'
