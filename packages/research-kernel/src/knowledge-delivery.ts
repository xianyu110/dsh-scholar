/** Exact-context delivery for immutable Knowledge activations. */
import type {
  KnowledgeActivationRequest,
  KnowledgeCapability,
  KnowledgePackageEvaluation,
  KnowledgePackageRecord,
} from '@dsh-scholar/research-schemas'
import { resolveKnowledgeActivation, type KnowledgeActivationReason } from './knowledge-registry.js'
import { findNativeKnowledgePack, verifyNativeKnowledgePack, type NativeInstructionPayload } from './native-knowledge-packs.js'

export interface KnowledgeDeliveryActivation {
  activation_id: string
  request: KnowledgeActivationRequest
}

export interface KnowledgeDeliveryDeactivation {
  deactivation_id: string
  project_id: string
  activation_id: string
}

export interface KnowledgeDeliveryContext {
  project_id: string
  session_id: string
  phase: string
  next_action_revision: number
  surface: 'scholar-chat' | 'assurance-reviewer'
}

export type KnowledgeDeliverySuppressionReason = KnowledgeActivationReason
  | 'wrong_project'
  | 'wrong_session'
  | 'stale_phase'
  | 'stale_next_action'
  | 'deactivated'
  | 'native_pack_missing'
  | 'native_integrity_failed'
  | 'surface_not_allowed'

export interface KnowledgeDeliveryItem {
  activation_id: string
  package_name: string
  package_version: string
  manifest_sha256: string
  payload_sha256: string
  trust: 'trusted-native-instruction' | 'untrusted-external-reference'
  effective_capabilities: KnowledgeCapability[]
  content: NativeInstructionPayload | null
}

export interface KnowledgeDeliverySnapshot {
  context: KnowledgeDeliveryContext
  deliveries: KnowledgeDeliveryItem[]
  suppressed: Array<{ activation_id: string; reason_codes: KnowledgeDeliverySuppressionReason[] }>
}

export function resolveKnowledgeDelivery(input: {
  packages: KnowledgePackageRecord[]
  evaluations: KnowledgePackageEvaluation[]
  activations: KnowledgeDeliveryActivation[]
  deactivations: KnowledgeDeliveryDeactivation[]
  context: KnowledgeDeliveryContext
}): KnowledgeDeliverySnapshot {
  const deliveries: KnowledgeDeliveryItem[] = []
  const suppressed: KnowledgeDeliverySnapshot['suppressed'] = []
  const deactivated = new Set(input.deactivations
    .filter(item => item.project_id === input.context.project_id)
    .map(item => item.activation_id))

  for (const activation of input.activations) {
    const request = activation.request
    const reason = request.project_id !== input.context.project_id ? 'wrong_project' as const
      : request.session_id !== input.context.session_id ? 'wrong_session' as const
        : deactivated.has(activation.activation_id) ? 'deactivated' as const
          : request.phase !== input.context.phase ? 'stale_phase' as const
            : request.next_action_revision !== input.context.next_action_revision ? 'stale_next_action' as const
              : null
    if (reason !== null) {
      suppressed.push({ activation_id: activation.activation_id, reason_codes: [reason] })
      continue
    }
    const resolution = resolveKnowledgeActivation({ packages: input.packages, evaluations: input.evaluations, request })
    if (!resolution.allowed) {
      suppressed.push({ activation_id: activation.activation_id, reason_codes: resolution.reason_codes })
      continue
    }
    if (resolution.channel === 'external-knowledge') {
      deliveries.push({
        activation_id: activation.activation_id,
        package_name: request.package_name,
        package_version: request.package_version,
        manifest_sha256: request.manifest_sha256,
        payload_sha256: request.payload_sha256,
        trust: 'untrusted-external-reference',
        effective_capabilities: resolution.effective_capabilities,
        content: null,
      })
      continue
    }
    const pack = findNativeKnowledgePack(request.package_name, request.package_version, request.manifest_sha256, request.payload_sha256)
    if (pack === null) {
      suppressed.push({ activation_id: activation.activation_id, reason_codes: ['native_pack_missing'] })
      continue
    }
    if (!verifyNativeKnowledgePack(pack).ok) {
      suppressed.push({ activation_id: activation.activation_id, reason_codes: ['native_integrity_failed'] })
      continue
    }
    if (!pack.payload.surfaces.includes(input.context.surface)) {
      suppressed.push({ activation_id: activation.activation_id, reason_codes: ['surface_not_allowed'] })
      continue
    }
    deliveries.push({
      activation_id: activation.activation_id,
      package_name: request.package_name,
      package_version: request.package_version,
      manifest_sha256: request.manifest_sha256,
      payload_sha256: request.payload_sha256,
      trust: 'trusted-native-instruction',
      effective_capabilities: resolution.effective_capabilities,
      content: pack.payload,
    })
  }
  return { context: input.context, deliveries, suppressed }
}
