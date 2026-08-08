/**
 * DSH Research OS — standalone GUI plugin, host half (design E7,
 * docs/gui-plugin-plan.md): spawns/reuses the Research Kernel sidecar and
 * registers the `/research-ui-api` bridge. The browser half ships via
 * exports["./client"] and renders the tabbed panels.
 * @module @dsh-scholar/research-ui/host
 */

import type { Context } from 'cordis'
import { UiKernelSidecar } from './sidecar.js'
import { registerResearchUiBridge } from './bridge.js'

export const name = 'research-ui'

export interface ResearchUiConfig {
  kernel?: {
    host?: string
    port?: number
    dataDir?: string
  }
  /** Web bridge hardening (design §15.2/§15.3). Defaults keep token mode off. */
  bridge?: {
    /** Bridge auth token; falls back to env DSH_SCHOLAR_BRIDGE_TOKEN. undefined = disabled. */
    token?: string
    /** Per-IP sliding window limits; defaults to 60 req/min. */
    rateLimit?: { windowMs?: number; max?: number }
  }
}

export function apply(ctx: Context, config: ResearchUiConfig = {}): void {
  const sidecar = new UiKernelSidecar({
    host: config.kernel?.host,
    port: config.kernel?.port,
    dataDir: config.kernel?.dataDir,
    log: line => ctx.logger('research-ui').info(line.replace(/^\[research-ui\] /, '')),
  })

  void sidecar.start().catch(error => {
    ctx.logger('research-ui').error(`kernel sidecar failed to start: ${(error as Error).message}`)
  })

  registerResearchUiBridge(ctx, sidecar, { token: config.bridge?.token, rateLimit: config.bridge?.rateLimit })

  ctx.effect(() => () => { void sidecar.stop() }, 'research-ui: kernel sidecar')
}
