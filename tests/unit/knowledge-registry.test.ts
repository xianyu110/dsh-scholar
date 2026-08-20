import { describe, expect, it } from 'vitest'
import {
  KnowledgePackageManifest,
  type KnowledgePackageManifest as KnowledgePackageManifestValue,
} from '../../packages/research-schemas/src/knowledge-methodology.js'
import { resolveKnowledgeActivation } from '../../packages/research-kernel/src/knowledge-registry.js'

const hash = (character: string) => `sha256:${character.repeat(64)}`

function instructionManifest(
  overrides: Partial<KnowledgePackageManifestValue> = {},
): KnowledgePackageManifestValue {
  return KnowledgePackageManifest.parse({
    schema_version: 1,
    name: 'scholar.paper.reverse-outline',
    version: '1.0.0',
    channel: 'instruction',
    source: {
      transport: 'local',
      origin: 'scholar-native',
      path: 'packs/reverse-outline',
      revision: 'a'.repeat(40),
    },
    payload_sha256: hash('1'),
    license: {
      status: 'SCHOLAR_OWNED',
      spdx: 'BSD-3-Clause',
      evidence_sha256: hash('2'),
      attribution_refs: [],
    },
    requested_capabilities: [
      'project:read-manuscript-snapshot',
      'proposal:review-finding',
    ],
    input_schema_id: 'scholar.reverse-outline.input.v1',
    output_schema_id: 'scholar.reverse-outline.output.v1',
    side_effect: 'proposal-only',
    ...overrides,
  })
}

describe('local immutable knowledge registry', () => {
  it('activates a locally pinned Instruction Pack with only the capability intersection', () => {
    const manifest = instructionManifest()
    const manifestHash = hash('3')
    const report = resolveKnowledgeActivation({
      packages: [{ manifest, manifest_sha256: manifestHash }],
      evaluations: [{
        package_name: manifest.name,
        package_version: manifest.version,
        manifest_sha256: manifestHash,
        payload_sha256: manifest.payload_sha256,
        verdict: 'approved',
        granted_capabilities: manifest.requested_capabilities,
      }],
      request: {
        project_id: 'rsp_registry',
        session_id: 'session_registry',
        package_name: manifest.name,
        package_version: manifest.version,
        manifest_sha256: manifestHash,
        payload_sha256: manifest.payload_sha256,
        phase: 'writing',
        next_action_revision: 7,
        explicit_human_activation: true,
        principal_capabilities: manifest.requested_capabilities,
        next_action_capabilities: ['project:read-manuscript-snapshot'],
        project_policy_capabilities: manifest.requested_capabilities,
      },
    })

    expect(report).toEqual({
      allowed: true,
      channel: 'instruction',
      injection_mode: 'trusted-instruction-reference',
      effective_capabilities: ['project:read-manuscript-snapshot'],
      reason_codes: [],
      pin: {
        project_id: 'rsp_registry',
        session_id: 'session_registry',
        package_name: manifest.name,
        package_version: manifest.version,
        manifest_sha256: manifestHash,
        payload_sha256: manifest.payload_sha256,
        phase: 'writing',
        next_action_revision: 7,
      },
    })
  })

  it('keeps third-party knowledge untrusted and prevents channel capability confusion', () => {
    const external = KnowledgePackageManifest.parse({
      ...instructionManifest(),
      name: 'external.paper.reference',
      channel: 'external-knowledge',
      source: {
        transport: 'local',
        origin: 'third-party',
        path: 'quarantine/reference',
        revision: 'b'.repeat(40),
        provenance_url: 'https://example.invalid/upstream',
      },
      license: {
        status: 'VENDOR_CLEAR',
        spdx: 'MIT',
        evidence_sha256: hash('4'),
        attribution_refs: ['notice:external-reference'],
      },
      requested_capabilities: ['knowledge:retrieve'],
      side_effect: 'none',
    })
    const manifestHash = hash('5')
    const report = resolveKnowledgeActivation({
      packages: [{ manifest: external, manifest_sha256: manifestHash }],
      evaluations: [{
        package_name: external.name,
        package_version: external.version,
        manifest_sha256: manifestHash,
        payload_sha256: external.payload_sha256,
        verdict: 'restricted',
        granted_capabilities: ['knowledge:retrieve'],
      }],
      request: {
        project_id: 'rsp_registry',
        session_id: 'session_registry',
        package_name: external.name,
        package_version: external.version,
        manifest_sha256: manifestHash,
        payload_sha256: external.payload_sha256,
        phase: 'writing',
        next_action_revision: 8,
        explicit_human_activation: true,
        principal_capabilities: ['knowledge:retrieve'],
        next_action_capabilities: ['knowledge:retrieve'],
        project_policy_capabilities: ['knowledge:retrieve'],
      },
    })

    expect(report).toMatchObject({
      allowed: true,
      channel: 'external-knowledge',
      injection_mode: 'untrusted-read-only-reference',
      effective_capabilities: ['knowledge:retrieve'],
    })
    expect(() => KnowledgePackageManifest.parse({
      ...external,
      requested_capabilities: ['proposal:manuscript-patch'],
    })).toThrow()
    expect(() => KnowledgePackageManifest.parse({
      ...instructionManifest(),
      source: { ...instructionManifest().source, origin: 'third-party' },
    })).toThrow()
  })

  it('rejects remote, mutable and ambiguous sources at the strict manifest seam', () => {
    expect(() => KnowledgePackageManifest.parse({
      ...instructionManifest(),
      source: {
        transport: 'remote',
        origin: 'third-party',
        path: 'https://example.invalid/pack',
        revision: 'main',
      },
    })).toThrow()
    expect(() => KnowledgePackageManifest.parse({
      ...instructionManifest(),
      source: { ...instructionManifest().source, path: '../escape' },
    })).toThrow()
    expect(() => KnowledgePackageManifest.parse({
      ...instructionManifest(),
      version: 'next',
    })).toThrow()
    expect(() => KnowledgePackageManifest.parse({
      ...instructionManifest(),
      undeclared: true,
    })).toThrow()
  })

  it('fails closed on missing consent, revocation, license ambiguity and equivocation', () => {
    const manifest = instructionManifest()
    const manifestHash = hash('6')
    const base = {
      packages: [{ manifest, manifest_sha256: manifestHash }],
      evaluations: [{
        package_name: manifest.name,
        package_version: manifest.version,
        manifest_sha256: manifestHash,
        payload_sha256: manifest.payload_sha256,
        verdict: 'approved' as const,
        granted_capabilities: manifest.requested_capabilities,
      }],
      request: {
        project_id: 'rsp_registry',
        session_id: 'session_registry',
        package_name: manifest.name,
        package_version: manifest.version,
        manifest_sha256: manifestHash,
        payload_sha256: manifest.payload_sha256,
        phase: 'writing',
        next_action_revision: 9,
        explicit_human_activation: true,
        principal_capabilities: manifest.requested_capabilities,
        next_action_capabilities: manifest.requested_capabilities,
        project_policy_capabilities: manifest.requested_capabilities,
      },
    }

    expect(resolveKnowledgeActivation({
      ...base,
      request: { ...base.request, explicit_human_activation: false },
    }).reason_codes).toEqual(['activation_not_explicit'])
    expect(resolveKnowledgeActivation({
      ...base,
      evaluations: [{ ...base.evaluations[0], verdict: 'revoked' }],
    }).reason_codes).toEqual(['package_revoked'])
    expect(resolveKnowledgeActivation({
      ...base,
      evaluations: [
        ...base.evaluations,
        { ...base.evaluations[0], verdict: 'revoked' },
      ],
    }).reason_codes).toEqual(['package_revoked'])
    expect(resolveKnowledgeActivation({
      ...base,
      packages: [{
        manifest: instructionManifest({
          license: {
            status: 'UPSTREAM_AMBIGUOUS',
            spdx: 'MIT',
            evidence_sha256: hash('7'),
            attribution_refs: [],
          },
        }),
        manifest_sha256: manifestHash,
      }],
    }).reason_codes).toEqual(['license_not_activatable'])

    const conflicting = instructionManifest({ payload_sha256: hash('8') })
    expect(resolveKnowledgeActivation({
      ...base,
      packages: [
        ...base.packages,
        { manifest: conflicting, manifest_sha256: hash('9') },
      ],
    }).reason_codes).toEqual(['supply_chain_equivocation'])
  })

  it('never expands capabilities beyond the five-way intersection', () => {
    const manifest = instructionManifest()
    const manifestHash = hash('a')
    const report = resolveKnowledgeActivation({
      packages: [{ manifest, manifest_sha256: manifestHash }],
      evaluations: [{
        package_name: manifest.name,
        package_version: manifest.version,
        manifest_sha256: manifestHash,
        payload_sha256: manifest.payload_sha256,
        verdict: 'approved',
        granted_capabilities: ['proposal:review-finding'],
      }],
      request: {
        project_id: 'rsp_registry',
        session_id: 'session_registry',
        package_name: manifest.name,
        package_version: manifest.version,
        manifest_sha256: manifestHash,
        payload_sha256: manifest.payload_sha256,
        phase: 'writing',
        next_action_revision: 10,
        explicit_human_activation: true,
        principal_capabilities: ['proposal:review-finding'],
        next_action_capabilities: ['proposal:review-finding'],
        project_policy_capabilities: [],
      },
    })
    expect(report).toMatchObject({
      allowed: false,
      effective_capabilities: [],
      reason_codes: ['no_effective_capabilities'],
    })
  })
})
