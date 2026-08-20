import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchClient } from '../../packages/research-client/src/index.js'
import { ResearchKernel } from '../../packages/research-kernel/src/kernel.js'
import { dshOperatorPrincipal } from '../../packages/research-kernel/src/dsh-principal.js'
import { NATIVE_KNOWLEDGE_PACKS } from '../../packages/research-kernel/src/native-knowledge-packs.js'
import { startKernelServer } from '../../packages/research-kernel/src/server.js'

const roots: string[] = []
const SERVICE_TOKEN = 'service-secret'
const DSH_TOKEN = 'dsh-secret'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function identity(index = 1) {
  const pack = NATIVE_KNOWLEDGE_PACKS[index]!
  return {
    package_name: pack.record.manifest.name,
    package_version: pack.record.manifest.version,
    manifest_sha256: pack.record.manifest_sha256,
    payload_sha256: pack.record.manifest.payload_sha256,
    explicit_human_activation: true as const,
  }
}

describe('Kernel-authoritative Knowledge activation', () => {
  it('rejects caller authority facts and derives session, phase, NextAction and capabilities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-knowledge-authority-'))
    roots.push(root)
    const dbPath = join(root, 'kernel.db')
    const casRoot = join(root, 'cas')
    const kernel = new ResearchKernel({ dbPath, casRoot, serviceToken: SERVICE_TOKEN, dshPluginToken: DSH_TOKEN })
    const sessionId = 'session_authority'
    const principal = dshOperatorPrincipal(DSH_TOKEN)
    const created = kernel.createProjectForDshSession({
      session_id: sessionId, name: 'knowledge authority', idempotency_key: 'knowledge-authority',
      request_hash: 'request-hash',
    })
    kernel.methodology.reconcileNativeKnowledgePacks()
    const projectId = created.project.project_id
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const client = new ResearchClient({ endpoint: url, serviceToken: SERVICE_TOKEN, dshPluginToken: DSH_TOKEN }) as ResearchClient & {
        activateKnowledgePackageForDshSession(
          sessionId: string,
          input: ReturnType<typeof identity> & {
            expected_revision: number
            expected_registry_revision: number
            expected_project_revision: number
            expected_next_action_revision: number
          },
        ): Promise<{ record: { request: Record<string, unknown>; resolution: { effective_capabilities: string[] } } }>
      }
      const action = kernel.projectProjection(projectId).next_actions_v2.find(item => item.state !== 'done')!
      const receipt = await client.activateKnowledgePackageForDshSession(sessionId, {
        ...identity(), expected_revision: 0, expected_registry_revision: 6,
        expected_project_revision: created.project.revision,
        expected_next_action_revision: action.revision ?? created.project.revision,
      })
      expect(receipt.record.request).toMatchObject({
        project_id: projectId,
        session_id: sessionId,
        phase: created.project.status,
        next_action_revision: action.revision ?? created.project.revision,
        explicit_human_activation: true,
      })
      expect(receipt.record.resolution.effective_capabilities).toContain('project:read-brief')

      const forged = await fetch(`${url}/v2/projects/${projectId}/knowledge-activations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-principal-id': principal,
          'x-principal-session': sessionId,
        },
        body: JSON.stringify({
          request: {
            project_id: projectId, session_id: 'forged', ...identity(), phase: 'WRITING', next_action_revision: 999,
            principal_capabilities: ['proposal:manuscript-patch'],
            next_action_capabilities: ['proposal:manuscript-patch'],
            project_policy_capabilities: ['proposal:manuscript-patch'],
          },
          expected_revision: 1, expected_registry_revision: 6,
          expected_project_revision: created.project.revision,
          expected_next_action_revision: action.revision ?? created.project.revision,
        }),
      })
      expect(forged.status).toBe(422)
      expect(kernel.methodology.listKnowledgeActivations(projectId).records).toHaveLength(1)

      const unlinkedSession = await fetch(`${url}/v2/projects/${projectId}/knowledge-activations`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-principal-id': principal,
          'x-principal-session': 'session_unlinked',
        },
        body: JSON.stringify({
          ...identity(), expected_revision: 1, expected_registry_revision: 6,
          expected_project_revision: created.project.revision,
          expected_next_action_revision: action.revision ?? created.project.revision,
        }),
      })
      expect(unlinkedSession.status).toBe(409)
      expect(kernel.methodology.listKnowledgeActivations(projectId).records).toHaveLength(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })

  it('fails closed on an unlinked/foreign session and project phase drift with zero writes, then reopens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-knowledge-authority-reopen-'))
    roots.push(root)
    const dbPath = join(root, 'kernel.db')
    const casRoot = join(root, 'cas')
    const kernel = new ResearchKernel({ dbPath, casRoot, serviceToken: SERVICE_TOKEN, dshPluginToken: DSH_TOKEN })
    const principal = dshOperatorPrincipal(DSH_TOKEN)
    const created = kernel.createProjectForDshSession({
      session_id: 'session_exact', name: 'authority reopen', idempotency_key: 'authority-reopen', request_hash: 'request-hash',
    })
    kernel.createProjectForDshSession({
      session_id: 'session_foreign', name: 'foreign', idempotency_key: 'authority-foreign', request_hash: 'foreign-hash',
    })
    kernel.methodology.reconcileNativeKnowledgePacks()
    const projectId = created.project.project_id
    const action = kernel.projectProjection(projectId).next_actions_v2.find(item => item.state !== 'done')!
    const input = {
      ...identity(), expected_revision: 0, expected_registry_revision: 6,
      expected_project_revision: created.project.revision,
      expected_next_action_revision: action.revision ?? created.project.revision,
    }
    expect(() => (kernel as unknown as {
      activateKnowledgePackageFromAuthority(input: typeof input & { project_id: string; session_id: string; principal_id: string }): unknown
    }).activateKnowledgePackageFromAuthority({
      ...input, project_id: projectId, session_id: 'session_foreign', principal_id: principal,
    })).toThrow(/session/i)
    expect(kernel.methodology.listKnowledgeActivations(projectId).records).toEqual([])

    kernel.db.prepare("UPDATE projects SET status = 'SCOPED', revision = revision + 1 WHERE project_id = ?").run(projectId)
    expect(() => (kernel as unknown as {
      activateKnowledgePackageFromAuthority(input: typeof input & { project_id: string; session_id: string; principal_id: string }): unknown
    }).activateKnowledgePackageFromAuthority({
      ...input, project_id: projectId, session_id: 'session_exact', principal_id: principal,
    })).toThrow(/revision|stale/i)
    expect(kernel.methodology.listKnowledgeActivations(projectId).records).toEqual([])
    kernel.close()

    const reopened = new ResearchKernel({ dbPath, casRoot, serviceToken: SERVICE_TOKEN, dshPluginToken: DSH_TOKEN })
    try {
      expect(reopened.getProjectBySession('session_exact')?.project_id).toBe(projectId)
      expect(reopened.methodology.listKnowledgeActivations(projectId).records).toEqual([])
    } finally {
      reopened.close()
    }
  })
})
