#!/usr/bin/env node
/**
 * Durable Research Orchestrator — CLI entry (design §8).
 *
 * Usage:
 *   orchestrator --kernel http://127.0.0.1:7412 [--db <path>] [--poll-ms 5000]
 *                [--owner <id>] [--lease-seconds 60] [--token-file <0600 file>]
 *                [--once] [--dry-run]
 *
 * - default: poll the Kernel forever, advancing projects per §8.3.
 * - `--once`: run a single poll round and exit (used by tests / cron).
 * - `--dry-run`: compute planned actions only; no Kernel writes, no persistence.
 * - leader election (§15): `--owner` names this instance in
 *   orchestrator_leases (default orch-<hostname>-<pid>); `--lease-seconds`
 *   sets the lease expiry; a project whose live lease is held by another
 *   owner is skipped. `--token-file` supplies the kernel bearer token
 *   (Authorization: Bearer) for token-protected kernels.
 * - SIGINT/SIGTERM stop the loop, release all held leases and close the store.
 *
 * CONFIG-01: the CLI surface is parsed by the canonical Config Registry
 * (parseCli) — flags, defaults and validation are the registry's single
 * source of truth; `--help` prints the registry-generated help text.
 * @module @dsh-scholar/research-orchestrator/bin
 */

import { Engine } from '../engine.js'
import { parseCli, generateCliHelp, ConfigRegistryError } from '@dsh-scholar/research-schemas'

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Durable Research Orchestrator (design §8)\nUsage: orchestrator [options]\n\n${generateCliHelp('orchestrator')}`)
  process.exit(0)
}

let cli: Record<string, unknown>
try {
  cli = parseCli(argv, 'orchestrator')
} catch (error) {
  console.error(`[research-orchestrator] invalid config: ${error instanceof ConfigRegistryError ? error.message : (error as Error).message}`)
  process.exit(2)
}

const kernelUrl = (cli['orchestrator.kernel'] as string | undefined) ?? 'http://127.0.0.1:7412'
const dbPath = cli['orchestrator.db'] as string | undefined
const pollMs = cli['orchestrator.poll_ms'] as number | undefined
const once = cli['orchestrator.once'] === true
const dryRun = cli['orchestrator.dry_run'] === true
const owner = (cli['orchestrator.owner'] as string | undefined) ?? ''
const leaseSeconds = (cli['orchestrator.lease_seconds'] as number | undefined) ?? 60
const tokenFile = (cli['orchestrator.token_file'] as string | undefined) ?? ''

if (pollMs !== undefined && pollMs <= 0) {
  console.error('[research-orchestrator] --poll-ms must be a positive number')
  process.exit(2)
}

const engine = new Engine({ kernelUrl, dbPath, pollMs, dryRun, owner: owner === '' ? undefined : owner, leaseSeconds, tokenFile: tokenFile === '' ? undefined : tokenFile })

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
