/**
 * budget-gate-resume tests (acceptance-tests.md §2): crossing a budget limit
 * blocks the project AND durably journals the only allowed resume target
 * (the pre-block status); a client-supplied resume_to is ignored.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel } from '@dsh-scholar/research-kernel'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-budget-gate-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

describe('budget gate resume (Kernel-recorded provenance only)', () => {
  it('blocks with a gate declaring the pre-block status; client resume_to is ignored', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({
      name: 't', workspace: '/w', brief: makeBrief(),
      constraints: { max_model_cost_usd: 10, max_gpu_hours: 10, max_api_requests: 100, max_parallel_jobs: 2 },
    })
    // Walk to EXPERIMENTING (a state a budget block could occur in).
    const scope = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: scope.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    kernel.transition(project.project_id, 'SURVEYING', kernel.getProject(project.project_id).revision)
    kernel.transition(project.project_id, 'IDEATING', kernel.getProject(project.project_id).revision)
    const ideaGate = kernel.createGate({ project_id: project.project_id, type: 'idea', title: 'Idea' })
    kernel.decideGate({ gate_id: ideaGate.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    kernel.transition(project.project_id, 'CONTRACT_PENDING', kernel.getProject(project.project_id).revision)
    const contractGate = kernel.createGate({ project_id: project.project_id, type: 'contract', title: 'Contract' })
    kernel.decideGate({ gate_id: contractGate.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    kernel.transition(project.project_id, 'BASELINE_REPRO', kernel.getProject(project.project_id).revision)
    kernel.transition(project.project_id, 'EXPERIMENTING', kernel.getProject(project.project_id).revision)
    expect(kernel.getProject(project.project_id).status).toBe('EXPERIMENTING')

    // Cross the model-cost limit -> BLOCKED_GATE + Gate/provenance in one transaction.
    kernel.recordUsage(project.project_id, { model_cost_usd: 11 })
    expect(kernel.getProject(project.project_id).status).toBe('BLOCKED_GATE')
    const gates = kernel.listGates(project.project_id).filter(g => g.type === 'budget')
    expect(gates).toHaveLength(1)
    expect(gates[0]!.payload.resume_to).toBe('EXPERIMENTING')

    // Approving with a CLIENT-supplied resume_to of RELEASED must be ignored:
    // the Kernel-recorded EXPERIMENTING provenance is used.
    kernel.decideGate({
      gate_id: gates[0]!.gate_id,
      actor: 'u1',
      principal: { principal_id: 'u1' },
      decision: 'approved',
      resume_to: 'RELEASED' as never, // legacy field must be ignored
    })
    expect(kernel.getProject(project.project_id).status).toBe('EXPERIMENTING')
    kernel.close()
  })

  it('blocking from SURVEYING declares SURVEYING and approval resumes to it', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({
      name: 't', workspace: '/w', brief: makeBrief(),
      constraints: { max_model_cost_usd: 0, max_gpu_hours: 0, max_api_requests: 0, max_parallel_jobs: 1 },
    })
    const scope = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: scope.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    kernel.transition(project.project_id, 'SURVEYING', kernel.getProject(project.project_id).revision)
    kernel.recordUsage(project.project_id, { model_cost_usd: 1 })
    expect(kernel.getProject(project.project_id).status).toBe('BLOCKED_GATE')
    const gates = kernel.listGates(project.project_id).filter(g => g.type === 'budget')
    expect(gates).toHaveLength(1)
    expect(gates[0]!.payload.resume_to).toBe('SURVEYING')
    kernel.decideGate({ gate_id: gates[0]!.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved' })
    expect(kernel.getProject(project.project_id).status).toBe('SURVEYING')
    kernel.close()
  })

  it('rejects a Budget Gate whose payload no longer matches the durable block provenance', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({
      name: 'tampered budget gate', workspace: '/w', brief: makeBrief(),
      constraints: { max_model_cost_usd: 0, max_gpu_hours: 10, max_api_requests: 100, max_parallel_jobs: 1 },
    })
    kernel.db.prepare("UPDATE projects SET status = 'SURVEYING' WHERE project_id = ?").run(project.project_id)
    kernel.recordUsage(project.project_id, { model_cost_usd: 1 })
    const gate = kernel.listGates(project.project_id).find(candidate => candidate.type === 'budget')!
    kernel.db.prepare('UPDATE gates SET payload = ? WHERE gate_id = ?')
      .run(JSON.stringify({ resume_to: 'RELEASED' }), gate.gate_id)

    expect(() => kernel.decideGate({
      gate_id: gate.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved',
    })).toThrow(/provenance/i)
    expect(kernel.getProject(project.project_id).status).toBe('BLOCKED_GATE')
    expect(kernel.listDecisions(project.project_id)).toEqual([])
    kernel.close()
  })

  it('rejects a Budget Gate after the blocked Project revision diverges from its durable provenance', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({
      name: 'stale budget block', workspace: '/w', brief: makeBrief(),
      constraints: { max_model_cost_usd: 0, max_gpu_hours: 10, max_api_requests: 100, max_parallel_jobs: 1 },
    })
    kernel.db.prepare("UPDATE projects SET status = 'SURVEYING' WHERE project_id = ?").run(project.project_id)
    kernel.recordUsage(project.project_id, { model_cost_usd: 1 })
    const gate = kernel.listGates(project.project_id).find(candidate => candidate.type === 'budget')!
    kernel.db.prepare('UPDATE projects SET revision = revision + 1 WHERE project_id = ?').run(project.project_id)

    expect(() => kernel.decideGate({
      gate_id: gate.gate_id, actor: 'u1', principal: { principal_id: 'u1' }, decision: 'approved',
    })).toThrow(/provenance/i)
    expect(kernel.getProject(project.project_id).status).toBe('BLOCKED_GATE')
    expect(kernel.listDecisions(project.project_id)).toEqual([])
    kernel.close()
  })
})
