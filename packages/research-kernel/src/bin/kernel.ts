/**
 * Research Kernel entry — sidecar process (design §9.1 Local Desktop Profile).
 * Usage: node lib/bin/kernel.js --db <path> --cas <dir> [--port 7412] [--token <t>]
 *        [--service-token <t>] [--endpoint-file <path>]
 *        (or DSH_SCHOLAR_KERNEL_TOKEN / DSH_SCHOLAR_SERVICE_TOKEN)
 * @module @dsh-scholar/research-kernel/bin
 */

import { parseArgs } from 'node:util'
import { basename, dirname, join, resolve } from 'node:path'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ResearchKernel } from '../kernel.js'
import { startKernelServer } from '../server.js'

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    cas: { type: 'string' },
    port: { type: 'string' },
    host: { type: 'string' },
    token: { type: 'string' },
    // §4 P0 (API-01/EVID-01): internal-route service identity. Sidecars pass
    // it via env (0600 file, out-of-band from argv); the flag is the explicit
    // override for direct deployments.
    'service-token': { type: 'string' },
    // SIDE-01: publish the actual bound port (works with --port 0) plus the
    // kernel's database/dataDir identity so sidecars can verify reuse.
    'endpoint-file': { type: 'string' },
  },
})

const dbPath = values.db ?? join(mkdtempSync(join(tmpdir(), 'research-kernel-')), 'kernel.db')
const casRoot = values.cas ?? join(process.cwd(), '.research-cas')
const port = Number(values.port ?? 7412)
const host = values.host ?? '127.0.0.1'
// Sidecars pass the token out-of-band from argv so it is not exposed by
// process listings. The CLI flag remains for explicit backwards compatibility.
const token = values.token ?? process.env.DSH_SCHOLAR_KERNEL_TOKEN
const serviceToken = values['service-token'] ?? process.env.DSH_SCHOLAR_SERVICE_TOKEN
const endpointFile = values['endpoint-file'] ?? process.env.DSH_SCHOLAR_KERNEL_ENDPOINT_FILE

const kernel = new ResearchKernel({ dbPath, casRoot, serviceToken })

try {
  const { server, url, port: actualPort } = await startKernelServer({ kernel, host, port, token })
  console.error(`[research-kernel] listening on ${url} (db=${dbPath}, cas=${casRoot}, instance=${kernel.instanceId})`)
  if (endpointFile !== undefined && endpointFile !== '') {
    // SIDE-01: server.address().port is the REAL port even when --port 0 was
    // requested. The 0600 file is the sidecar's only identity source: the
    // plugin/standalone sidecars refuse to reuse a kernel whose
    // protocol/schema/database/dataDir do not match their own instance.
    mkdirSync(dirname(endpointFile), { recursive: true })
    writeFileSync(endpointFile, JSON.stringify({
      host,
      port: actualPort,
      protocol: 'http',
      schema: 'v1',
      database: basename(dbPath),
      dataDir: resolve(dirname(dbPath)),
      pid: process.pid,
      started_at: new Date().toISOString(),
    }, null, 2) + '\n', { mode: 0o600 })
    chmodSync(endpointFile, 0o600)
  }
  const shutdown = (signal: string): void => {
    console.error(`[research-kernel] ${signal} — closing`)
    server.close(() => {
      kernel.close()
      process.exit(0)
    })
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
} catch (error) {
  console.error('[research-kernel] failed to start:', error)
  kernel.close()
  process.exit(1)
}
