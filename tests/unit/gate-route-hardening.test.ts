import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ResearchKernel, startKernelServer } from '@dsh-scholar/research-kernel'

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

describe('Gate decision HTTP authority boundary', () => {
  it('removes the public v1 writer and accepts Human decisions only from the authenticated standalone BFF bridge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-gate-route-hardening-'))
    const kernel = new ResearchKernel({
      dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas'),
      requireSignedManifest: false, serviceToken: 'service-secret',
    })
    const project = kernel.createProject({
      name: 'gated', workspace: '/w', creator_principal_id: 'pi-1', brief: makeBrief(),
    })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    const body = JSON.stringify({
      decision: 'approved',
      principal: { principal_id: 'pi-1', auth_method: 'dsh-session', session_id: 'sess-1' },
    })
    try {
      const direct = await fetch(`${url}/v1/gates/${gate.gate_id}/decisions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      })
      expect(direct.status).toBe(404)
      expect(kernel.listDecisions(project.project_id)).toEqual([])

      const internalPath = `${url}/internal/human-gates/${gate.gate_id}/decisions`
      const missingIdentity = await fetch(internalPath, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': 'service-secret' }, body,
      })
      expect(missingIdentity.status).toBe(403)
      expect(kernel.listDecisions(project.project_id)).toEqual([])

      const accepted = await fetch(internalPath, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': 'service-secret',
          'x-service-principal': 'standalone-human-bff',
          'x-principal-session': 'sess-1',
        },
        body,
      })
      expect(accepted.status).toBe(200)
      expect(kernel.getProject(project.project_id).status).toBe('SCOPED')
      expect(kernel.listDecisions(project.project_id)).toHaveLength(1)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })
})
