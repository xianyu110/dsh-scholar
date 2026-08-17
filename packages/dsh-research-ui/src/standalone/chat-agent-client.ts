import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ScholarAgentReply,
  ScholarAgentRequest,
  type ScholarAgentReply as ScholarAgentReplyValue,
  type ScholarAgentRequest as ScholarAgentRequestValue,
} from '@dsh-scholar/research-schemas'

const MAX_PRIVATE_FILE_BYTES = 8_192

function privateFile(path: string): string {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Scholar agent bridge metadata is unavailable')
  if ((stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > MAX_PRIVATE_FILE_BYTES) {
    throw new Error('Scholar agent bridge metadata is unavailable')
  }
  return readFileSync(path, 'utf8')
}

function loopbackOrigin(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Scholar agent bridge endpoint is unavailable')
  const parsed = new URL(value)
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'
  if (parsed.protocol !== 'http:' || !loopback || parsed.username !== '' || parsed.password !== ''
    || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('Scholar agent bridge endpoint is unavailable')
  }
  return parsed.origin
}

/** Ask the active DSH plugin's local model runtime; no bridge secret crosses the BFF. */
export async function requestScholarAgent(
  dataDir: string,
  requestValue: ScholarAgentRequestValue,
  timeoutMs = 45_000,
): Promise<ScholarAgentReplyValue> {
  const request = ScholarAgentRequest.parse(requestValue)
  const endpoint = JSON.parse(privateFile(join(dataDir, 'agent-bridge-endpoint.json'))) as { origin?: unknown }
  const origin = loopbackOrigin(endpoint.origin)
  const token = privateFile(join(dataDir, 'agent-bridge-token')).trim()
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Scholar agent bridge credential is unavailable')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  try {
    const response = await fetch(`${origin}/v1/turn`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('Scholar agent bridge rejected the request')
    return ScholarAgentReply.parse(await response.json())
  } finally {
    clearTimeout(timer)
  }
}
