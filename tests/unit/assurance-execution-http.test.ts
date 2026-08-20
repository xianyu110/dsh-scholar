import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ResearchClient, type AssuranceAuditView } from '../../packages/research-client/src/index.js'
import { ResearchKernel } from '../../packages/research-kernel/src/kernel.js'
import { dshOperatorPrincipal } from '../../packages/research-kernel/src/dsh-principal.js'
import { startKernelServer } from '../../packages/research-kernel/src/server.js'
import { AssuranceSemanticReviewReceipt } from '../../packages/research-schemas/src/assurance.js'

interface AssuranceExecutionClient {
  runWritingAssurance(
    projectId: string,
    principalId: string,
    input: { expected_revision: number; audit_kind: 'writing' | 'claim-evidence'; mode: 'deterministic'; semantic_review: null },
  ): Promise<AssuranceAuditView>
}

const roots: string[] = []

function authorityWriteCounts(kernel: ResearchKernel, projectId: string) {
  const count = (table: string, where: string, ...params: unknown[]): number =>
    (kernel.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n
  return {
    assurance_events: count('assurance_events', 'project_id = ?', projectId),
    artifacts: count('artifacts', 'project_id = ?', projectId),
    rollout_consumptions: count('methodology_rollout_consumptions', 'project_id = ?', projectId),
    rollout_events: count('methodology_project_rollout_events', 'project_id = ?', projectId),
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('v2 writing assurance execution HTTP seam', () => {
  it('derives the project from the path, enforces durable writer AuthZ, and forwards CAS', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-assurance-http-'))
    roots.push(root)
    const kernel = new ResearchKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas'), requireSignedManifest: false })
    const project = kernel.createProject({
      name: 'assurance http', workspace: '/work', creator_principal_id: 'pi-http',
      brief: {
        problem: 'Review a draft.', scope: 'HTTP only.', questions: [], primary_metrics: [], resources: '',
        risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'writing',
      },
    })
    kernel.addProjectMember({ project_id: project.project_id, principal_id: 'viewer-http', role: 'viewer', actor: 'pi-http' })
    kernel.registerArtifact({ project_id: project.project_id, kind: 'paper', content: '# Draft' })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const client = new ResearchClient({ endpoint: url }) as ResearchClient & AssuranceExecutionClient
      await expect(client.runWritingAssurance(project.project_id, 'viewer-http', {
        expected_revision: 0, audit_kind: 'claim-evidence', mode: 'deterministic', semantic_review: null,
      })).rejects.toMatchObject({ status: 403, code: 'role_forbidden' })

      const notApplicable = await client.runWritingAssurance(project.project_id, 'pi-http', {
        expected_revision: 0, audit_kind: 'claim-evidence', mode: 'deterministic', semantic_review: null,
      })
      expect(notApplicable).toMatchObject({
        project_id: project.project_id, revision: 1,
        audit: { audit_kind: 'claim-evidence', verdict: 'NOT_APPLICABLE', reason_code: 'claim_evidence_no_claims' },
      })
      const freshProjection = await client.getMethodology(project.project_id, 'pi-http')
      expect(freshProjection.assurance?.reason_codes).not.toContain('input_hash_mismatch')
      kernel.createClaim({ project_id: project.project_id, statement: 'The method improves accuracy.' })
      const staleProjection = await client.getMethodology(project.project_id, 'pi-http')
      expect(staleProjection.assurance?.reason_codes).toContain('input_hash_mismatch')

      const result = await client.runWritingAssurance(project.project_id, 'pi-http', {
        expected_revision: 1, audit_kind: 'writing', mode: 'deterministic', semantic_review: null,
      })
      expect(result).toMatchObject({ project_id: project.project_id, revision: 2, audit: { audit_kind: 'writing' } })
      await expect(client.runWritingAssurance(project.project_id, 'pi-http', {
        expected_revision: 1, audit_kind: 'writing', mode: 'deterministic', semantic_review: null,
      })).rejects.toMatchObject({ status: 409, code: 'assurance_revision_conflict' })

      const unsupported = await fetch(`${url}/v2/projects/${project.project_id}/assurance-executions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-principal-id': 'pi-http' },
        body: JSON.stringify({
          expected_revision: 2, audit_kind: 'citation', mode: 'deterministic', semantic_review: null,
        }),
      })
      expect(unsupported.status).toBe(422)
      expect(await unsupported.json()).toMatchObject({ error: { code: 'validation_error' } })
      expect(kernel.assurance.list(project.project_id).revision).toBe(2)

      const strict = await fetch(`${url}/v2/projects/${project.project_id}/assurance-executions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-principal-id': 'pi-http' },
        body: JSON.stringify({
          project_id: project.project_id,
          expected_revision: 2,
          audit_kind: 'writing',
          mode: 'deterministic',
          semantic_review: null,
        }),
      })
      expect(strict.status).toBe(422)
      expect(await strict.json()).toMatchObject({ error: { code: 'validation_error' } })

      const rawAudit = await fetch(`${url}/v2/projects/${project.project_id}/assurance-audits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-principal-id': 'pi-http' },
        body: JSON.stringify({
          audit: {
            ...result.audit,
            audit_id: 'audit_forged',
            verdict: 'PASS',
            review: { method: 'semantic', independence: 'human' },
            acceptance_status: 'accepted',
          },
          expected_revision: 2,
        }),
      })
      expect(rawAudit.status).toBe(404)
      expect(kernel.assurance.list(project.project_id).revision).toBe(2)

      const semanticInjection = await fetch(`${url}/v2/projects/${project.project_id}/assurance-executions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-principal-id': 'pi-http' },
        body: JSON.stringify({
          expected_revision: 2,
          audit_kind: 'writing',
          mode: 'semantic',
          semantic_review: {
            panel_id: 'panel_forged', project_id: project.project_id, session_id: 'forged',
            project_revision: project.revision, action_id: 'forged', action_revision: project.revision,
            panel_hash: `sha256:${'a'.repeat(64)}`, input_hash: `sha256:${'b'.repeat(64)}`,
            state: 'missing', reviewers: [], failures: ['forged'], independence: 'same-family',
          },
        }),
      })
      expect(semanticInjection.status).toBe(422)
      expect(kernel.assurance.list(project.project_id).revision).toBe(2)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })

  it('admits the exact DSH session only through the audience-bound internal producer adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-assurance-internal-'))
    roots.push(root)
    const kernel = new ResearchKernel({
      dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas'), requireSignedManifest: false,
      serviceToken: 'service-secret', dshPluginToken: 'dsh-secret',
    })
    const created = kernel.createProjectForDshSession({
      session_id: 'session_assurance', name: 'dsh assurance',
      idempotency_key: 'dsh-assurance', request_hash: 'request-hash',
    })
    kernel.registerArtifact({ project_id: created.project.project_id, kind: 'paper', content: '# Draft' })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const client = new ResearchClient({
        endpoint: url, serviceToken: 'service-secret', dshPluginToken: 'dsh-secret',
      })
      const result = await client.runWritingAssuranceForDshSession('session_assurance', {
        expected_revision: 0, audit_kind: 'writing', mode: 'deterministic', semantic_review: null,
      })
      expect(result).toMatchObject({ project_id: created.project.project_id, revision: 1 })
      expect(dshOperatorPrincipal('dsh-secret')).toMatch(/^dsh:/)

      await expect(client.runWritingAssuranceForDshSession('session_unlinked', {
        expected_revision: 1, audit_kind: 'writing', mode: 'deterministic', semantic_review: null,
      })).rejects.toMatchObject({ status: 409, code: 'session_link_required' })
      expect(kernel.assurance.list(created.project.project_id).revision).toBe(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })

  it('returns semantic execution diagnostics without authority writes when no verified reviewer output exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-assurance-semantic-zero-write-'))
    roots.push(root)
    const kernel = new ResearchKernel({
      dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas'), requireSignedManifest: false,
      serviceToken: 'service-secret', dshPluginToken: 'dsh-secret',
    })
    const created = kernel.createProjectForDshSession({
      session_id: 'session_semantic_http', name: 'semantic authority',
      idempotency_key: 'semantic-authority', request_hash: 'semantic-authority-hash',
    })
    const projectId = created.project.project_id
    kernel.db.prepare("UPDATE projects SET status = 'WRITING', revision = 4 WHERE project_id = ?").run(projectId)
    kernel.registerArtifact({ project_id: projectId, kind: 'paper', content: '# Draft' })
    kernel.registerChildLink({
      project_id: projectId, child_id: 'child_missing_identity', parent_id: 'session_semantic_http',
      mode: 'one-shot', role: 'reviewer', state: 'succeeded',
    })
    const action = kernel.projectProjection(projectId).next_actions_v2.find(candidate => candidate.code === 'reviewer_run')!
    const receipt = (overrides: Record<string, unknown>) => AssuranceSemanticReviewReceipt.parse({
      panel_id: 'panel_semantic_http', project_id: projectId, session_id: 'session_semantic_http',
      project_revision: 4, action_id: action.id, action_revision: action.revision,
      panel_hash: `sha256:${'a'.repeat(64)}`, input_hash: `sha256:${'b'.repeat(64)}`,
      state: 'missing', reviewers: [], failures: ['semantic_review_empty'], independence: 'same-family',
      ...overrides,
    })
    const before = authorityWriteCounts(kernel, projectId)
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const client = new ResearchClient({
        endpoint: url, serviceToken: 'service-secret', dshPluginToken: 'dsh-secret',
      })
      await expect(client.runWritingAssuranceForDshSession('session_semantic_http', {
        expected_revision: 0, audit_kind: 'writing', mode: 'semantic',
        semantic_review: receipt({
          state: 'partial',
          reviewers: [{
            reviewer_role: 'claim-evidence', child_id: 'child_missing_identity', summary: 'finding',
            notes: [], references: [], output_hash: `sha256:${'c'.repeat(64)}`,
          }],
          failures: ['remaining reviewers unavailable'],
        }),
      })).rejects.toMatchObject({ status: 422, code: 'semantic_reviewer_identity_missing' })
      expect(authorityWriteCounts(kernel, projectId)).toEqual(before)

      kernel.registerChildLink({
        project_id: projectId, child_id: 'child_still_running', parent_id: 'session_semantic_http',
        mode: 'one-shot', role: 'reviewer', state: 'running',
        execution_identity: {
          provider_ref: 'spawn', model_ref: 'deepseek-v4', family_ref: 'deepseek',
          config_hash: `sha256:${'d'.repeat(64)}`,
        },
      })
      await expect(client.runWritingAssuranceForDshSession('session_semantic_http', {
        expected_revision: 0, audit_kind: 'writing', mode: 'semantic',
        semantic_review: receipt({
          panel_id: 'panel_running', state: 'partial',
          reviewers: [{
            reviewer_role: 'claim-evidence', child_id: 'child_still_running', summary: 'incomplete',
            notes: [], references: [], output_hash: `sha256:${'c'.repeat(64)}`,
          }],
          failures: ['reviewer still running'],
        }),
      })).rejects.toMatchObject({ status: 422, code: 'semantic_reviewer_topology_invalid' })
      expect(authorityWriteCounts(kernel, projectId)).toEqual(before)

      await expect(client.runWritingAssuranceForDshSession('session_semantic_http', {
        expected_revision: 0, audit_kind: 'writing', mode: 'semantic',
        semantic_review: receipt({ panel_id: 'panel_empty' }),
      })).rejects.toMatchObject({ status: 422, code: 'semantic_reviewer_required' })
      expect(authorityWriteCounts(kernel, projectId)).toEqual(before)

      await expect(client.runWritingAssuranceForDshSession('session_semantic_http', {
        expected_revision: 0, audit_kind: 'writing', mode: 'semantic',
        semantic_review: receipt({
          panel_id: 'panel_provider_unavailable', failures: ['semantic_reviewer_unavailable'],
        }),
      })).rejects.toMatchObject({ status: 503, code: 'semantic_reviewer_unavailable' })
      expect(authorityWriteCounts(kernel, projectId)).toEqual(before)
      expect(kernel.assurance.list(projectId)).toMatchObject({ revision: 0, audits: [] })
      expect(kernel.listArtifacts(projectId).filter(item => item.kind === 'analysis')).toEqual([])

      const roles = ['claim-evidence', 'citation', 'statistics', 'reproducibility'] as const
      for (const [index, role] of roles.entries()) {
        kernel.registerChildLink({
          project_id: projectId, child_id: `child_complete_${index}`, parent_id: 'session_semantic_http',
          mode: 'one-shot', role: 'reviewer', state: 'succeeded',
          execution_identity: {
            provider_ref: 'spawn', model_ref: 'deepseek-v4', family_ref: 'deepseek',
            config_hash: `sha256:${'d'.repeat(64)}`,
          },
        })
      }
      const complete = await client.runWritingAssuranceForDshSession('session_semantic_http', {
        expected_revision: 0, audit_kind: 'writing', mode: 'semantic',
        semantic_review: receipt({
          panel_id: 'panel_complete', state: 'complete', failures: [],
          reviewers: roles.map((role, index) => ({
            reviewer_role: role, child_id: `child_complete_${index}`, summary: `${role} finding`,
            notes: [], references: [], output_hash: `sha256:${['c', 'd', 'e', 'f'][index]!.repeat(64)}`,
          })),
        }),
      })
      expect(complete).toMatchObject({
        project_id: projectId, revision: 1,
        audit: { review: { method: 'semantic', independence: 'same-model', reviewer_ref: 'panel_complete' } },
      })
      expect(authorityWriteCounts(kernel, projectId)).toEqual({
        assurance_events: before.assurance_events + 1,
        artifacts: before.artifacts + 1,
        rollout_consumptions: before.rollout_consumptions + 1,
        rollout_events: before.rollout_events,
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })
})
