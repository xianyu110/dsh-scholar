/**
 * API-01 foundation tests: project membership — creator seeds the first PI,
 * member_manage capability is PI-scoped, the last PI cannot be removed.
 * BFF route-level AuthZ on top of this model lands with the v2 migration.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, KernelError } from '@dsh-scholar/research-kernel'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-member-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

function expectKernelError(fn: () => unknown, status: number, code: string): void {
  try {
    fn()
    throw new Error('expected KernelError to be thrown')
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError)
    expect((error as KernelError).status).toBe(status)
    expect((error as KernelError).code).toBe(code)
  }
}

describe('project membership (API-01 foundation)', () => {
  it('seeds the creator as the first PI and manages roles', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({
      name: 't', workspace: '/w', brief: makeBrief(),
      creator_principal_id: 'ops-1', creator_tenant_id: 'acme',
    } as Parameters<ResearchKernel['createProject']>[0])
    let members = kernel.listProjectMembers(project.project_id)
    expect(members).toHaveLength(1)
    expect(members[0]!.principal_id).toBe('ops-1')
    expect(members[0]!.role).toBe('pi')
    expect(members[0]!.tenant_id).toBe('acme')

    // The PI adds a researcher; a non-PI cannot manage members.
    const added = kernel.addProjectMember({ project_id: project.project_id, principal_id: 'res-1', role: 'researcher', actor: 'ops-1' })
    expect(added.role).toBe('researcher')
    expect(kernel.listProjectMembers(project.project_id)).toHaveLength(2)
    expectKernelError(
      () => kernel.addProjectMember({ project_id: project.project_id, principal_id: 'res-2', role: 'viewer', actor: 'res-1' }),
      403, 'member_manage_denied',
    )
    // Promote res-1 to PI, then remove ops-1; the last PI cannot be removed.
    kernel.addProjectMember({ project_id: project.project_id, principal_id: 'res-1', role: 'pi', actor: 'ops-1' })
    kernel.removeProjectMember({ project_id: project.project_id, principal_id: 'ops-1', actor: 'res-1' })
    members = kernel.listProjectMembers(project.project_id)
    expect(members.map(m => m.principal_id)).toEqual(['res-1'])
    expectKernelError(
      () => kernel.removeProjectMember({ project_id: project.project_id, principal_id: 'res-1', actor: 'res-1' }),
      422, 'last_pi_removal',
    )
    // Unknown target member -> 404.
    expectKernelError(
      () => kernel.removeProjectMember({ project_id: project.project_id, principal_id: 'ghost', actor: 'res-1' }),
      404, 'member_not_found',
    )
    kernel.close()
  })

  it('projects without a creator principal have no members until managed', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    expect(kernel.listProjectMembers(project.project_id)).toEqual([])
    kernel.close()
  })
})
