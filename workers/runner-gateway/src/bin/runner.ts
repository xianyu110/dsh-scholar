/**
 * Runner gateway scheduler entry: claims jobs from the Kernel, executes them
 * in isolation, heartbeats leases, uploads artifacts and finalizes manifests.
 * Usage: node lib/bin/runner.js --kernel http://127.0.0.1:7412 [--mode subprocess|docker] [--poll-ms 2000] [--owner <id>]
 * @module @dsh-scholar/runner-gateway/bin
 */

import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { ResearchClient } from '@dsh-scholar/research-client'
import { executeJob, type RunnerMode } from '../index.js'

const { values } = parseArgs({
  options: {
    kernel: { type: 'string', default: 'http://127.0.0.1:7412' },
    token: { type: 'string' },
    mode: { type: 'string', default: 'subprocess' },
    'poll-ms': { type: 'string', default: '2000' },
    'timeout-ms': { type: 'string', default: '60000' },
    owner: { type: 'string' },
  },
})

const endpoint = values.kernel ?? 'http://127.0.0.1:7412'
const mode = (values.mode ?? 'subprocess') as RunnerMode
const pollMs = Number(values['poll-ms'] ?? 2000)
const timeoutMs = Number(values['timeout-ms'] ?? 60000)
const owner = values.owner ?? `runner-${randomUUID().slice(0, 8)}`

const client = new ResearchClient({ endpoint, token: values.token })

console.error(`[runner-gateway] ${owner} polling ${endpoint} (mode=${mode}, poll=${pollMs}ms)`)

let stopping = false
const shutdown = (): void => {
  stopping = true
  console.error('[runner-gateway] stopping')
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

while (!stopping) {
  try {
    // Recover stale leases on every cycle (self-healing after crashes, §9.3).
    await client.recoverExpiredLeases().catch(() => undefined)
    const jobs = await client.claimJobs(owner, 1)
    for (const job of jobs) {
      if (stopping) break
      console.error(`[runner-gateway] executing ${job.kind} job ${job.job_id}`)
      try {
        const { job: completed } = await executeJob(job, { client, owner, mode, timeoutMs })
        console.error(`[runner-gateway] job ${job.job_id} → ${completed.status}`)
      } catch (error) {
        console.error(`[runner-gateway] job ${job.job_id} failed at gateway level:`, (error as Error).message)
        await client.completeJob({
          job_id: job.job_id,
          owner,
          status: 'failed',
          failure_class: 'unknown',
          error: `gateway error: ${(error as Error).message}`,
        }).catch(() => undefined)
      }
    }
  } catch (error) {
    const message = (error as Error).message ?? String(error)
    if (message.includes('unreachable')) {
      console.error(`[runner-gateway] kernel unreachable (${endpoint}) — retrying in ${pollMs}ms`)
    } else {
      console.error('[runner-gateway] error:', message)
    }
  }
  await new Promise(resolve => setTimeout(resolve, pollMs))
}
