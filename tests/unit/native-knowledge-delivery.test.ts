import { describe, expect, it } from 'vitest'
import {
  NATIVE_KNOWLEDGE_PACKS,
  verifyNativeKnowledgePack,
} from '../../packages/research-kernel/src/native-knowledge-packs.js'
import {
  resolveKnowledgeDelivery,
  type KnowledgeDeliveryActivation,
} from '../../packages/research-kernel/src/knowledge-delivery.js'
import { KnowledgePackageRecord } from '../../packages/research-schemas/src/knowledge-methodology.js'

function activation(index = 0): KnowledgeDeliveryActivation {
  const pack = NATIVE_KNOWLEDGE_PACKS[index]!
  return {
    activation_id: `activation_${index + 1}`,
    request: {
      project_id: 'project_a',
      session_id: 'session_a',
      package_name: pack.record.manifest.name,
      package_version: pack.record.manifest.version,
      manifest_sha256: pack.record.manifest_sha256,
      payload_sha256: pack.record.manifest.payload_sha256,
      phase: 'WRITING',
      next_action_revision: 7,
      explicit_human_activation: true,
      principal_capabilities: pack.record.manifest.requested_capabilities,
      next_action_capabilities: pack.record.manifest.requested_capabilities,
      project_policy_capabilities: pack.record.manifest.requested_capabilities,
    },
  }
}

describe('Scholar-owned native Knowledge packs', () => {
  it('ships exactly three immutable, independently hashed native packs', () => {
    expect(NATIVE_KNOWLEDGE_PACKS.map(pack => pack.record.manifest.name)).toEqual([
      'scholar.assurance.review',
      'scholar.synthesis.two-loop',
      'scholar.writing.reverse-outline',
    ])
    for (const pack of NATIVE_KNOWLEDGE_PACKS) {
      expect(verifyNativeKnowledgePack(pack)).toEqual({ ok: true, reason_codes: [] })
      expect(pack.record.manifest.channel).toBe('instruction')
      expect(pack.record.manifest.source.origin).toBe('scholar-native')
      expect(pack.record.manifest.license.status).toBe('SCHOLAR_OWNED')
      expect(Object.values(pack.hashes)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      ]))
    }
  })

  it('fails closed when any payload, schema, capability or receipt is changed', () => {
    const pack = NATIVE_KNOWLEDGE_PACKS[0]!
    expect(verifyNativeKnowledgePack({
      ...pack,
      payload: { ...pack.payload, instructions: [...pack.payload.instructions, 'changed'] },
    })).toMatchObject({ ok: false, reason_codes: ['payload_hash_mismatch'] })
    expect(verifyNativeKnowledgePack({
      ...pack,
      input_schema: { ...pack.input_schema, required: ['arbitrary'] },
    })).toMatchObject({ ok: false, reason_codes: ['input_schema_hash_mismatch'] })
    expect(verifyNativeKnowledgePack({
      ...pack,
      hashes: { ...pack.hashes, capability_sha256: `sha256:${'0'.repeat(64)}` },
    })).toMatchObject({ ok: false, reason_codes: ['capability_hash_mismatch'] })
    expect(verifyNativeKnowledgePack({
      ...pack,
      record: { ...pack.record, manifest_sha256: `sha256:${'0'.repeat(64)}` },
    })).toMatchObject({ ok: false, reason_codes: ['manifest_hash_mismatch'] })
  })
})

describe('exact-session Knowledge delivery', () => {
  const packages = NATIVE_KNOWLEDGE_PACKS.map(pack => pack.record)
  const evaluations = NATIVE_KNOWLEDGE_PACKS.map(pack => pack.evaluation)

  it('delivers native instructions only for an exact current activation', () => {
    const resolved = resolveKnowledgeDelivery({
      packages,
      evaluations,
      activations: [activation()],
      deactivations: [],
      context: {
        project_id: 'project_a',
        session_id: 'session_a',
        phase: 'WRITING',
        next_action_revision: 7,
        surface: 'scholar-chat',
      },
    })
    expect(resolved.deliveries).toHaveLength(1)
    expect(resolved.deliveries[0]).toMatchObject({
      activation_id: 'activation_1',
      trust: 'trusted-native-instruction',
      content: { schema_version: 1 },
    })
    expect(resolved.suppressed).toEqual([])
  })

  it('suppresses stale, deactivated and newly revoked activations', () => {
    const current = activation()
    const base = {
      packages,
      evaluations,
      activations: [current],
      context: {
        project_id: 'project_a',
        session_id: 'session_a',
        phase: 'WRITING',
        next_action_revision: 7,
        surface: 'assurance-reviewer' as const,
      },
    }
    expect(resolveKnowledgeDelivery({
      ...base,
      deactivations: [],
      context: { ...base.context, next_action_revision: 8 },
    }).suppressed[0]?.reason_codes).toEqual(['stale_next_action'])
    expect(resolveKnowledgeDelivery({
      ...base,
      deactivations: [{
        deactivation_id: 'deactivation_1',
        project_id: 'project_a',
        activation_id: 'activation_1',
      }],
    }).suppressed[0]?.reason_codes).toEqual(['deactivated'])
    expect(resolveKnowledgeDelivery({
      ...base,
      deactivations: [],
      evaluations: [{ ...evaluations[0]!, verdict: 'revoked' }, ...evaluations.slice(1)],
    }).suppressed[0]?.reason_codes).toEqual(['package_revoked'])
  })

  it('keeps versions side-by-side, blocks equivocation, and never loads external content', () => {
    const first = activation(0)
    const second = activation(1)
    const resolved = resolveKnowledgeDelivery({
      packages,
      evaluations,
      activations: [first, second],
      deactivations: [],
      context: {
        project_id: 'project_a', session_id: 'session_a', phase: 'WRITING',
        next_action_revision: 7, surface: 'scholar-chat',
      },
    })
    expect(resolved.deliveries.map(item => item.package_name)).toEqual([
      first.request.package_name,
      second.request.package_name,
    ])

    const equivocated = {
      ...packages[0]!,
      manifest_sha256: `sha256:${'f'.repeat(64)}` as const,
      manifest: {
        ...packages[0]!.manifest,
        payload_sha256: `sha256:${'e'.repeat(64)}` as const,
      },
    }
    const denied = resolveKnowledgeDelivery({
      packages: [...packages, equivocated], evaluations,
      activations: [first], deactivations: [],
      context: {
        project_id: 'project_a', session_id: 'session_a', phase: 'WRITING',
        next_action_revision: 7, surface: 'scholar-chat',
      },
    })
    expect(denied.deliveries).toEqual([])
    expect(denied.suppressed[0]?.reason_codes).toEqual(['supply_chain_equivocation'])
  })

  it('delivers two explicitly activated versions side-by-side as untrusted references only', () => {
    const external = (version: string, character: string) => KnowledgePackageRecord.parse({
      manifest: {
        ...NATIVE_KNOWLEDGE_PACKS[0]!.record.manifest,
        name: 'external.method.reference', version, channel: 'external-knowledge',
        source: {
          transport: 'local', origin: 'third-party', path: `quarantine/reference/${version}`,
          revision: character.repeat(40), provenance_url: 'https://example.invalid/reference',
        },
        payload_sha256: `sha256:${character.repeat(64)}`,
        license: {
          status: 'VENDOR_CLEAR', spdx: 'MIT', evidence_sha256: `sha256:${character.repeat(64)}`,
          attribution_refs: ['external reference metadata'],
        },
        requested_capabilities: ['knowledge:retrieve'], side_effect: 'none',
      },
      manifest_sha256: `sha256:${character.toUpperCase().toLowerCase().repeat(64)}`,
    })
    const v1 = external('1.0.0', 'a')
    const v2 = external('2.0.0', 'b')
    const versions = [v1, v2]
    const requests = versions.map((record, index) => ({
      activation_id: `activation_external_${index + 1}`,
      request: {
        project_id: 'project_a', session_id: 'session_a', package_name: record.manifest.name,
        package_version: record.manifest.version, manifest_sha256: record.manifest_sha256,
        payload_sha256: record.manifest.payload_sha256, phase: 'WRITING', next_action_revision: 7,
        explicit_human_activation: true,
        principal_capabilities: ['knowledge:retrieve'] as const,
        next_action_capabilities: ['knowledge:retrieve'] as const,
        project_policy_capabilities: ['knowledge:retrieve'] as const,
      },
    }))
    const result = resolveKnowledgeDelivery({
      packages: versions,
      evaluations: versions.map(record => ({
        package_name: record.manifest.name, package_version: record.manifest.version,
        manifest_sha256: record.manifest_sha256, payload_sha256: record.manifest.payload_sha256,
        verdict: 'restricted' as const, granted_capabilities: ['knowledge:retrieve'] as const,
      })),
      activations: requests,
      deactivations: [],
      context: { project_id: 'project_a', session_id: 'session_a', phase: 'WRITING', next_action_revision: 7, surface: 'scholar-chat' },
    })
    expect(result.deliveries.map(item => [item.package_version, item.trust, item.content])).toEqual([
      ['1.0.0', 'untrusted-external-reference', null],
      ['2.0.0', 'untrusted-external-reference', null],
    ])
  })
})
