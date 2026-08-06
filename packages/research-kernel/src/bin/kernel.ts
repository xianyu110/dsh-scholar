/**
 * Research Kernel entry — sidecar process (design §9.1 Local Desktop Profile).
 * Usage: node lib/bin/kernel.js --db <path> --cas <dir> [--port 7412] [--token <t>]
 * @module @dsh-scholar/research-kernel/bin
 */

import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
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
  },
})

const dbPath = values.db ?? join(mkdtempSync(join(tmpdir(), 'research-kernel-')), 'kernel.db')
const casRoot = values.cas ?? join(process.cwd(), '.research-cas')
const port = Number(values.port ?? 7412)
const host = values.host ?? '127.0.0.1'
const token = values.token

const kernel = new ResearchKernel({ dbPath, casRoot })

try {
  const { server, url } = await startKernelServer({ kernel, host, port, token })
  console.error(`[research-kernel] listening on ${url} (db=${dbPath}, cas=${casRoot}, instance=${kernel.instanceId})`)
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
