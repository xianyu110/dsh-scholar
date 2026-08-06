/**
 * Web bridge: exposes the Research Kernel over the DSH web origin under
 * `/research-api/*` (E7 UI data plane). Registered only when the httpServer
 * service is composed (web mode); headless profiles skip it. The kernel
 * stays on 127.0.0.1:7412; the bridge is a same-origin proxy with no
 * credentials and no extra privileges.
 * @module @dsh-scholar/research-plugin/web-bridge
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from 'cordis'
// Module augmentation: ctx.httpServer (web composition, @deepseek-ai/dsh-host-webserver).
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { KernelSidecar } from './sidecar.ts'

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined))
  })
}

/** Register the /research-api prefix route proxying to the kernel sidecar. */
export function registerResearchApiBridge(ctx: Context, sidecar: KernelSidecar): void {
  ctx.inject(['httpServer'], httpCtx => {
    httpCtx.effect(() => httpCtx.httpServer.register({
      kind: 'prefix',
      path: '/research-api',
      handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          // Strip the bridge prefix; the rest is the kernel path (/v1/...).
          const target = `${sidecar.endpoint}${url.pathname.replace(/^\/research-api/, '')}${url.search}`
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
    }), 'research-plugin: /research-api bridge')
  })
}
