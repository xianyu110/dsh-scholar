/**
 * Stable ID builders for research objects.
 * @module @dsh-scholar/research-schemas
 */

import { randomBytes } from 'node:crypto'

function suffix(prefix: string, bytes = 4): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(bytes).toString('hex').slice(0, 8)}`
}

/** rsp_<timestamp36><rand> — project ids. */
export function buildProjectId(): string {
  return suffix('rsp')
}

/** idea_<timestamp36><rand> — idea card ids. */
export function buildIdeaId(): string {
  return suffix('idea')
}

/** expc_<timestamp36><rand> — experiment contract ids. */
export function buildContractId(): string {
  return suffix('expc')
}

/** gate_<timestamp36><rand> — gate ids. */
export function buildGateId(): string {
  return suffix('gate')
}

/** claim_<timestamp36><rand> — claim ids. */
export function buildClaimId(): string {
  return suffix('claim')
}
