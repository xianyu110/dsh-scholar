#!/usr/bin/env node
/**
 * Durable Research Orchestrator — CLI entry (design §8).
 *
 * Usage:
 *   orchestrator --kernel http://127.0.0.1:7412 [--db <path>] [--poll-ms 5000]
 *                [--once] [--dry-run]
 *
 * - default: poll the Kernel forever, advancing projects per §8.3.
 * - `--once`: run a single poll round and exit (used by tests / cron).
 * - `--dry-run`: compute planned actions only; no Kernel writes, no persistence.
 * - SIGINT/SIGTERM stop the loop and close the store gracefully.
 * @module @dsh-scholar/research-orchestrator/bin
 */

import { parseArgs } from 'node:util'
import { Engine } from '../engine.js'

const { values } = parseArgs({
  options: {
    kernel: { type: 'string' },
    db: { type: 'string' },
    'poll-ms': { type: 'string' },
    once: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
})

const kernelUrl = values.kernel ?? 'http://127.0.0.1:7412'
const dbPath = values.db
const pollMs = values['poll-ms'] === undefined ? undefined : Number(values['poll-ms'])
const once = values.once ?? false
const dryRun = values['dry-run'] ?? false

if (pollMs !== undefined && (!Number.isFinite(pollMs) || pollMs <= 0)) {
  console.error('[research-orchestrator] --poll-ms must be a positive number')
  process.exit(2)
}

const engine = new Engine({ kernelUrl, dbPath, pollMs, dryRun })

const shutdown = (signal: string): void => {
  console.error(`[research-orchestrator] ${signal} — stopping`)
  engine.stop()
  engine.close()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

try {
  if (once) {
    const result = await engine.pollOnce()
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    engine.close()
    process.exit(0)
  } else {
    await engine.start()
  }
} catch (error) {
  console.error('[research-orchestrator] fatal:', (error as Error).message)
  engine.close()
  process.exit(1)
}
