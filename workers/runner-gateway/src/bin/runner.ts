/**
 * Runner gateway scheduler entry: claims jobs from the Kernel, executes them
 * in isolation, heartbeats leases, uploads artifacts and finalizes manifests.
 *
 * Durable Jobs (design §12.6): while a job executes, a heartbeat loop renews
 * the lease every `--heartbeat-ms`; a cancel watcher polls the job status and
 * calls cancelRun() so a cancel request terminates the REAL subprocess /
 * container, not just the lease. RunManifests are Ed25519-signed (§12.7);
 * the public key is registered with the kernel when it exposes
 * POST /v1/runner-keys (skipped with a warning otherwise).
 *
 * Usage: node lib/bin/runner.js --kernel http://127.0.0.1:7412
 *   [--mode subprocess|docker] [--poll-ms 2000] [--owner <id>]
 *   [--timeout-ms 60000] [--heartbeat-ms 15000] [--cancel-poll-ms 5000]
 *   [--key-file <path>]
 * @module @dsh-scholar/runner-gateway/bin
 */

import { parseArgs } from 'node:util'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { ResearchClient, KernelApiError } from '@dsh-scholar/research-client'
import { cancelRun, executeJob, heartbeatLoop, type RunnerMode, type RunnerSigningKey } from '../index.js'

const { values } = parseArgs({
  options: {
    kernel: { type: 'string', default: 'http://127.0.0.1:7412' },
    token: { type: 'string' },
    mode: { type: 'string', default: 'subprocess' },
    'poll-ms': { type: 'string', default: '2000' },
    'timeout-ms': { type: 'string', default: '60000' },
    'heartbeat-ms': { type: 'string', default: '15000' },
    'cancel-poll-ms': { type: 'string', default: '5000' },
    'key-file': { type: 'string' },
    owner: { type: 'string' },
  },
})

const endpoint = values.kernel ?? 'http://127.0.0.1:7412'
const mode = (values.mode ?? 'subprocess') as RunnerMode
const pollMs = Number(values['poll-ms'] ?? 2000)
const timeoutMs = Number(values['timeout-ms'] ?? 60000)
const heartbeatMs = Number(values['heartbeat-ms'] ?? 15000)
const cancelPollMs = Number(values['cancel-poll-ms'] ?? 5000)
const keyFile = values['key-file']
const owner = values.owner ?? `runner-${randomUUID().slice(0, 8)}`

const client = new ResearchClient({ endpoint, token: values.token })

/**
 * Load the Ed25519 signing key from --key-file, or generate an ephemeral one
 * (public key printed to stderr for tests, §12.7). A generated key is
 * persisted to --key-file when provided so restarts keep the same identity.
 */
function loadOrCreateSigningKey(file: string | undefined): { key: RunnerSigningKey; publicKeyPem: string } {
  if (file !== undefined && existsSync(file)) {
    const privateKey = createPrivateKey(readFileSync(file, 'utf8'))
    const publicKeyPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
    const keyId = `runner-${createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16)}`
    console.error(`[runner-gateway] loaded signing key ${keyId} from ${file}`)
    return { key: { keyId, privateKey }, publicKeyPem }
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const keyId = `runner-${createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16)}`
  console.error(`[runner-gateway] generated ephemeral signing key ${keyId}`)
  console.error(`[runner-gateway] public key PEM (SPKI):\n${publicKeyPem}`)
  if (file !== undefined) {
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    console.error(`[runner-gateway] saved private key to ${file}`)
  }
  return { key: { keyId, privateKey }, publicKeyPem }
}

/** Best-effort public-key registration (§12.7); absent endpoint → warn and continue (compat). */
async function registerRunnerKey(keyId: string, publicKeyPem: string): Promise<void> {
  try {
    await client.registerRunnerKey({ key_id: keyId, public_key_pem: publicKeyPem })
    console.error(`[runner-gateway] runner key ${keyId} registered with kernel`)
  } catch (error) {
    if (error instanceof KernelApiError && error.status === 404) {
      console.error(`[runner-gateway] warning: kernel has no /v1/runner-keys endpoint — key registration skipped (compat mode)`)
    } else if (error instanceof KernelApiError) {
      console.error(`[runner-gateway] warning: runner-key registration failed (${error.status}): ${error.message}`)
    } else {
      console.error(`[runner-gateway] warning: runner-key registration unreachable: ${(error as Error).message}`)
    }
  }
}

const { key: signingKey, publicKeyPem } = loadOrCreateSigningKey(keyFile)

console.error(`[runner-gateway] ${owner} polling ${endpoint} (mode=${mode}, poll=${pollMs}ms, heartbeat=${heartbeatMs}ms, cancel-poll=${cancelPollMs}ms, key=${signingKey.keyId})`)

// Register the public key once at startup (design §12.7; skipped when the
// kernel does not expose the endpoint yet).
await registerRunnerKey(signingKey.keyId, publicKeyPem)

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
      // §12.6: heartbeat the lease while the job runs; a cancel watcher polls
      // the kernel and terminates the REAL execution when the job is cancelled.
      const heartbeatAc = new AbortController()
      const executeAc = new AbortController()
      heartbeatLoop(job.job_id, owner, client, heartbeatMs, heartbeatAc.signal, job.lease_generation, job.lease_token)
      const cancelWatcher = setInterval(() => {
        void client.getJob(job.job_id).then(current => {
          if (current.status === 'cancelled' && !executeAc.signal.aborted) {
            console.error(`[runner-gateway] job ${job.job_id} cancelled — terminating execution`)
            cancelRun(job.job_id)
            heartbeatAc.abort()
            executeAc.abort()
          }
        }).catch(() => undefined)
      }, cancelPollMs)
      try {
        const { job: completed } = await executeJob(job, { client, owner, mode, timeoutMs, signal: executeAc.signal, signingKey })
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
      } finally {
        clearInterval(cancelWatcher)
        heartbeatAc.abort()
        executeAc.abort()
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
