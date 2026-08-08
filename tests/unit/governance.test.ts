/**
 * Governance unit tests (hardening GOV-01, EVID-01): durable decision
 * principal, worker-only verified evidence, claim verification provenance.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel } from '@dsh-scholar/research-kernel'
import { startKernelServer } from '../../packages/research-kernel/lib/server.js'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gov-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas') })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

describe('governance: durable human principal (GOV-01)', () => {
  it('persists and re-reads the decision principal', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({
      gate_id: gate.gate_id,
      actor: 'web-user',
      principal: { principal_id: 'ops-42', tenant_id: 'acme', auth_method: 'dsh-session', session_id: 'sess-7' },
      decision: 'approved',
      reason: 'scope acceptable',
    })
    const decisions = kernel.listDecisions(project.project_id)
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.principal?.principal_id).toBe('ops-42')
    expect(decisions[0]!.principal?.tenant_id).toBe('acme')
    expect(decisions[0]!.principal?.auth_method).toBe('dsh-session')
    expect(decisions[0]!.principal?.session_id).toBe('sess-7')
    // A fresh kernel over the same DB still sees the principal.
    kernel.close()
  })

  it('marks legacy decisions without a principal', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: gate.gate_id, actor: 'legacy_unverified', decision: 'approved' })
    const decisions = kernel.listDecisions(project.project_id)
    expect(decisions[0]!.principal).toBeUndefined()
    kernel.close()
  })
})

describe('governance: gate target freeze (GOV-02)', () => {
  it('contract gate approval freezes the target contract atomically', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const gate = kernel.createGate({ project_id: project.project_id, type: 'scope', title: 'Scope' })
    kernel.decideGate({ gate_id: gate.gate_id, actor: 'web-user', principal: { principal_id: 'u1' }, decision: 'approved' })
    expect(kernel.getProject(project.project_id).status).toBe('SCOPED')
    // Walk to IDEA_APPROVED (contract gate's from-state) via the public
    // transition table + an idea gate.
    kernel.transition(project.project_id, 'SURVEYING', kernel.getProject(project.project_id).revision)
    kernel.transition(project.project_id, 'IDEATING', kernel.getProject(project.project_id).revision)
    const ideaGate = kernel.createGate({ project_id: project.project_id, type: 'idea', title: 'Idea Gate', payload: { idea_id: 'idea_x' } })
    kernel.decideGate({ gate_id: ideaGate.gate_id, actor: 'web-user', principal: { principal_id: 'u1' }, decision: 'approved' })
    expect(kernel.getProject(project.project_id).status).toBe('IDEA_APPROVED')
    // IDEA_APPROVED -> BASELINE_REPRO (the contract gate's from-state).
    kernel.transition(project.project_id, 'BASELINE_REPRO', kernel.getProject(project.project_id).revision)
    // A contract + its gate; approval must freeze the contract in the SAME
    // transaction as the decision.
    const contract = kernel.registerContract({
      project_id: project.project_id,
      idea_id: 'idea_x', data: { dataset_id: 'd', version: 'v1' }, methods: { baseline: 'b', treatment: 'a' },
      metrics: { primary: 'macro_f1', secondary: [] }, seeds: [1, 2], analysis: {},
      ablations: [], stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 1, stop_on_data_leakage: true },
    })
    const cGate = kernel.createGate({ project_id: project.project_id, type: 'contract', title: 'Contract Gate', payload: { contract_id: contract.contract_id } })
    const decided = kernel.decideGate({ gate_id: cGate.gate_id, actor: 'web-user', principal: { principal_id: 'u1' }, decision: 'approved', diff: 'v1' })
    const frozen = kernel.getContract(contract.contract_id)
    expect(frozen.status).toBe('approved')
    expect(frozen.approval?.gate_decision_id).toBe(decided.decision.decision_id)
    expect(frozen.approval?.approved_by).toBe('web-user')
    // The project moved to the contract-approved state in the same txn.
    expect(kernel.getProject(project.project_id).status).toBe('CONTRACT_APPROVED')
    kernel.close()
  })
})

describe('governance: evidence provenance (EVID-01)', () => {
  it('claim verification ignores draft/legacy evidence and needs worker-verified rows', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    // Draft (public) evidence: must NOT support a claim.
    const draft = kernel.ingestEvidence({
      project_id: project.project_id, source_type: 'analysis', run_ids: ['r1'],
      artifact_refs: [], analysis_method: 'bootstrap_95',
      result: { primary_metric: 'f1', value: 0.9, effect_size: 0.3, ci_low: 0.1, ci_high: 0.5, n_seeds: 3 },
      provenance_status: 'draft_unverified',
    })
    const claim = kernel.createClaim({
      project_id: project.project_id,
      statement: 'A improves f1',
      scope: { dataset: 'd', split: 'official' },
    })
    const verdictDraft = kernel.verifyClaim({ claim_id: claim.claim_id, evidence_ids: [draft.evidence_id] })
    expect(verdictDraft.status).not.toBe('supported')
    // Worker-verified evidence: supports the claim.
    const verified = kernel.ingestVerifiedEvidence({
      project_id: project.project_id, source_type: 'analysis', run_ids: ['r1'],
      artifact_refs: [], analysis_method: 'bootstrap_95',
      result: { primary_metric: 'f1', value: 0.9, effect_size: 0.3, ci_low: 0.1, ci_high: 0.5, n_seeds: 3 },
    })
    const verdictVerified = kernel.verifyClaim({ claim_id: claim.claim_id, evidence_ids: [verified.evidence_id] })
    expect(verdictVerified.status).toBe('supported')
    kernel.close()
  })

  it('public HTTP route rejects verified; the worker route accepts it', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const body = {
        source_type: 'analysis', run_ids: ['r1'], artifact_refs: [],
        analysis_method: 'bootstrap_95',
        result: { primary_metric: 'f1', value: 0.9, effect_size: 0.3, ci_low: 0.1, ci_high: 0.5, n_seeds: 3 },
        provenance_status: 'verified',
      }
      const publicRes = await fetch(`http://127.0.0.1:${port}/v1/projects/${project.project_id}/evidence`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(publicRes.status).toBe(422)
      const workerRes = await fetch(`http://127.0.0.1:${port}/v1/projects/${project.project_id}/evidence/verified`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, provenance_status: undefined }),
      })
      expect(workerRes.status).toBe(201)
      const item = await workerRes.json() as { provenance_status?: string; evidence_id?: string }
      expect(item.provenance_status).toBe('verified')
    } finally {
      server.close()
      kernel.close()
    }
  })
})
