/**
 * RUN-REMOTE-01 — RunManifest 签名共享工具（design §12.7）。
 *
 * canonicalJson / signManifest 原为 runner-gateway index.ts 内部实现；远端
 * Agent 的 complete 路径需要以同一 canonical 规则签署 run_manifest（kernel
 * 验签时使用同一 canonicalization），因此迁入本模块，index.ts 与 remote-agent.ts
 * 共用（index.ts 保持 re-export，既有导入路径不变）。
 * @module @dsh-scholar/runner-gateway/manifest-signing
 */

import { createHash, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/** Ed25519 签名密钥（§12.7）：keyId 进 manifest 的 runner_key_id。 */
export interface RunnerSigningKey {
  /** Stable public identity, e.g. `runner-<hex>`; goes into the manifest as runner_key_id. */
  keyId: string
  /** Ed25519 private key used to sign the canonical RunManifest (design §12.7). */
  privateKey: KeyObject
}

/**
 * Canonical JSON for manifest signing (design §12.7): top-level keys sorted,
 * no whitespace. `JSON.stringify(obj, keys)` serializes exactly the listed
 * keys in the given order — the verifier must use the same canonicalization.
 */
export function canonicalJson(manifest: Record<string, unknown>): string {
  return JSON.stringify(manifest, Object.keys(manifest).sort())
}

/** Sign the canonical RunManifest; returns signature/runner_key_id/payload_sha256. */
export function signManifest(manifest: Record<string, unknown>, key: RunnerSigningKey): Record<string, unknown> {
  const payloadSha256 = createHash('sha256').update(canonicalJson(manifest)).digest('hex')
  const signed = { ...manifest, runner_key_id: key.keyId, payload_sha256: payloadSha256 }
  // Ed25519 signs the raw payload directly: the one-shot `sign(null, ...)`
  // API (a digest name like 'ed25519' throws "Invalid digest"; the kernel
  // verifies with the matching `verify(null, ...)`).
  const signature = sign(null, Buffer.from(canonicalJson(signed), 'utf8'), key.privateKey).toString('base64')
  return { ...signed, signature }
}
