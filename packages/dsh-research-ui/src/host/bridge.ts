/**
 * Standalone data plane: `/research-ui-api/*` same-origin bridge to the
 * Research Kernel (design E7). Separate path from the main plugin's
 * `/research-api` so both can be installed side by side.
 * @module @dsh-scholar/research-ui/host/bridge
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { UiKernelSidecar } from './sidecar.ts'

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined))
  })
}

export function registerResearchUiBridge(ctx: Context, sidecar: UiKernelSidecar): void {
  ctx.inject(['httpServer'], httpCtx => {
    httpCtx.effect(() => httpCtx.httpServer.register({
      kind: 'prefix',
      path: '/research-ui-api',
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const target = `${sidecar.endpoint}${url.pathname.replace(/^\/research-ui-api/, '')}${url.search}`
          const upstream = await fetch(target, {
            method: req.method ?? 'GET',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req),
          })
          const text = await upstream.text()
          res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(text)
        } catch (error) {
          res.writeHead(502, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'kernel_unreachable', message: (error as Error).message } }))
        }
      },
    }), 'research-ui: /research-ui-api bridge')
  })
}
