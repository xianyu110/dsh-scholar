/**
 * Pure local Knowledge Registry resolver.
 *
 * It performs no fetch, install, model call or Kernel mutation. The caller
 * supplies immutable registry facts and receives one fail-closed activation
 * decision with an exact project pin.
 */

import {
  KnowledgeRegistryResolutionInput,
  type KnowledgeCapability,
  type KnowledgeRegistryResolutionInput as KnowledgeRegistryResolutionInputValue,
} from '@dsh-scholar/research-schemas'

export type KnowledgeActivationReason =
  | 'activation_not_explicit'
  | 'package_not_found'
  | 'package_identity_mismatch'
  | 'evaluation_not_found'
  | 'evaluation_conflict'
  | 'package_rejected'
  | 'package_revoked'
  | 'license_not_activatable'
  | 'instruction_source_not_trusted'
  | 'channel_verdict_mismatch'
  | 'supply_chain_equivocation'
  | 'no_effective_capabilities'

export interface KnowledgeActivationResolution {
  allowed: boolean
  channel: KnowledgeRegistryResolutionInputValue['packages'][number]['manifest']['channel'] | null
  injection_mode: 'trusted-instruction-reference' | 'untrusted-read-only-reference' | 'none'
  effective_capabilities: KnowledgeCapability[]
  reason_codes: KnowledgeActivationReason[]
  pin: {
    project_id: string
    session_id: string
    package_name: string
    package_version: string
    manifest_sha256: string
    payload_sha256: string
    phase: string
    next_action_revision: number
  } | null
}

function intersectCapabilities(
  requested: readonly KnowledgeCapability[],
  ...constraints: ReadonlyArray<readonly KnowledgeCapability[]>
): KnowledgeCapability[] {
  return requested.filter(capability => constraints.every(set => set.includes(capability)))
}

/** Resolve an exact activation without mutating or silently upgrading a pin. */
export function resolveKnowledgeActivation(
  rawInput: KnowledgeRegistryResolutionInputValue,
): KnowledgeActivationResolution {
  const input = KnowledgeRegistryResolutionInput.parse(rawInput)
  const requestedIdentity = `${input.request.package_name}@${input.request.package_version}`
  const versions = input.packages.filter(record => (
    `${record.manifest.name}@${record.manifest.version}` === requestedIdentity
  ))
  const identities = new Set(versions.map(record => (
    `${record.manifest_sha256}:${record.manifest.payload_sha256}`
  )))

  if (identities.size > 1) {
    return denied('supply_chain_equivocation')
  }

  const record = versions.find(candidate => (
    candidate.manifest_sha256 === input.request.manifest_sha256
    && candidate.manifest.payload_sha256 === input.request.payload_sha256
  ))
  if (!record) return denied(versions.length === 0 ? 'package_not_found' : 'package_identity_mismatch')

  const evaluations = input.evaluations.filter(candidate => (
    candidate.package_name === input.request.package_name
    && candidate.package_version === input.request.package_version
    && candidate.manifest_sha256 === input.request.manifest_sha256
    && candidate.payload_sha256 === input.request.payload_sha256
  ))
  if (evaluations.length === 0) return denied('evaluation_not_found', record.manifest.channel)

  if (!input.request.explicit_human_activation) {
    return denied('activation_not_explicit', record.manifest.channel)
  }
  if (evaluations.some(candidate => candidate.verdict === 'revoked')) {
    return denied('package_revoked', record.manifest.channel)
  }
  if (evaluations.some(candidate => candidate.verdict === 'rejected')) {
    return denied('package_rejected', record.manifest.channel)
  }
  const evaluationFingerprints = new Set(evaluations.map(candidate => (
    `${candidate.verdict}:${[...candidate.granted_capabilities].sort().join(',')}`
  )))
  if (evaluationFingerprints.size !== 1) return denied('evaluation_conflict', record.manifest.channel)
  const evaluation = evaluations[0]
  if (!evaluation) return denied('evaluation_not_found', record.manifest.channel)
  const licenseActivatable = record.manifest.channel === 'instruction'
    ? record.manifest.license.status === 'SCHOLAR_OWNED'
    : record.manifest.license.status === 'VENDOR_CLEAR'
  if (!licenseActivatable) {
    return denied('license_not_activatable', record.manifest.channel)
  }
  if (record.manifest.channel === 'instruction'
    && record.manifest.source.origin === 'third-party') {
    return denied('instruction_source_not_trusted', record.manifest.channel)
  }
  if ((record.manifest.channel === 'instruction' && evaluation.verdict !== 'approved')
    || (record.manifest.channel === 'external-knowledge'
      && evaluation.verdict !== 'approved'
      && evaluation.verdict !== 'restricted')) {
    return denied('channel_verdict_mismatch', record.manifest.channel)
  }

  const effective = intersectCapabilities(
    record.manifest.requested_capabilities,
    evaluation.granted_capabilities,
    input.request.principal_capabilities,
    input.request.next_action_capabilities,
    input.request.project_policy_capabilities,
  )
  if (effective.length === 0) return denied('no_effective_capabilities', record.manifest.channel)

  return {
    allowed: true,
    channel: record.manifest.channel,
    injection_mode: record.manifest.channel === 'instruction'
      ? 'trusted-instruction-reference'
      : 'untrusted-read-only-reference',
    effective_capabilities: effective,
    reason_codes: [],
    pin: {
      project_id: input.request.project_id,
      session_id: input.request.session_id,
      package_name: input.request.package_name,
      package_version: input.request.package_version,
      manifest_sha256: input.request.manifest_sha256,
      payload_sha256: input.request.payload_sha256,
      phase: input.request.phase,
      next_action_revision: input.request.next_action_revision,
    },
  }
}

function denied(
  reason: KnowledgeActivationReason,
  channel: KnowledgeActivationResolution['channel'] = null,
): KnowledgeActivationResolution {
  return {
    allowed: false,
    channel,
    injection_mode: 'none',
    effective_capabilities: [],
    reason_codes: [reason],
    pin: null,
  }
}
