/**
 * Stable ID builders for research objects (reconstruction-contracts.md §2,
 * domain-model.md §1).
 *
 * Business IDs are `prefix + base32(lowercase, no padding)` over 128-bit
 * crypto random — NEVER a timestamp (timestamps are not a uniqueness source;
 * §2: "不得使用时间戳作为唯一性来源"). The same rule applies to event_id
 * and request_id. Tests inject a deterministic ID source via
 * `setIdRandomSource` so IDs are reproducible without weakening production.
 * @module @dsh-scholar/research-schemas
 */

import { randomBytes } from 'node:crypto'

/** RFC 4648 base32 alphabet, lowercase (crockford-style digits omitted). */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** Production RNG; tests replace it via setIdRandomSource. */
let idRandomSource: (bytes: number) => Uint8Array = (bytes: number) => randomBytes(bytes)

/** Replace the ID randomness source (deterministic in tests). Restore with
 * the returned previous source. */
export function setIdRandomSource(source: (bytes: number) => Uint8Array): (bytes: number) => Uint8Array {
  const previous = idRandomSource
  idRandomSource = source
  return previous
}

/** base32(lowercase, no padding) of raw bytes. */
export function toBase32Lower(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** `<prefix>_<base32(128-bit random)>` — reconstruction-contracts.md §2. */
export function randomId(prefix: string): string {
  const bytes = idRandomSource(16)
  return `${prefix}_${toBase32Lower(bytes)}`
}

/** rsp_<base32> — project ids. */
export function buildProjectId(): string {
  return randomId('rsp')
}

/** idea_<base32> — idea card ids. */
export function buildIdeaId(): string {
  return randomId('idea')
}

/** expc_<base32> — experiment contract ids. */
export function buildContractId(): string {
  return randomId('expc')
}

/** gate_<base32> — gate ids. */
export function buildGateId(): string {
  return randomId('gate')
}

/** claim_<base32> — claim ids. */
export function buildClaimId(): string {
  return randomId('claim')
}
