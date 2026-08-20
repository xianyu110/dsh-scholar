import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProtocolRevision,
  ResearchRunClassificationWriteRecord,
  type FrozenProtocolPin,
  type ResearchRunClassificationWriteRecord as ResearchRunClassificationWriteRecordValue,
} from '@dsh-scholar/research-schemas'
import { ResearchClient } from '../../packages/research-client/src/index.js'
import { ResearchKernel } from '../../packages/research-kernel/src/kernel.js'
import { protocolRevisionCanonicalHash } from '../../packages/research-kernel/src/methodology-store.js'
import { startKernelServer } from '../../packages/research-kernel/src/server.js'

const EARLIER = '2026-08-20T08:00:00.000Z'
const NOW = '2026-08-20T10:00:00.000Z'
const HASH = `sha256:${'a'.repeat(64)}`

function brief() {
  return {
    problem: 'Persist run outcomes without changing project authority.', scope: 'outcome adapter', questions: [],
    primary_metrics: ['accuracy'], resources: 'local', risks: [], target_outputs: ['paper'],
    target_venue: null, baseline_repo: null, domain: 'machine learning',
  }
}

function frozenProtocol(projectId: string) {
  const unsigned = ProtocolRevision.parse({
    protocol_id: 'protocol_outcome_1', project_id: projectId, revision: 1, supersedes: null,
    status: 'frozen', intent: 'confirmatory', research_question_ref: 'question_outcome', target_claim_ref: null,
    hypothesis: 'The approved treatment changes accuracy.', prediction: 'Accuracy differs from baseline.',
    variables: { manipulated: ['treatment'], controlled: ['data'], measured: ['accuracy'] },
    metrics: { primary: 'accuracy', secondary: [], baseline_ref: 'baseline_outcome', analysis_plan_artifact_id: 'artifact_plan' },
    pins: {
      contract: { ref: 'contract_outcome', sha256: HASH }, code: { ref: 'code_outcome', sha256: HASH },
      data: { ref: 'data_outcome', sha256: HASH }, environment: { ref: 'environment_outcome', sha256: HASH },
    },
    stopping_conditions: ['one complete run'], failure_criteria: ['integrity failure'], allowed_deviations: [],
    deviation_handling: 'Freeze another protocol revision.', author_principal_id: 'pi-outcome',
    created_at: EARLIER, frozen_at: EARLIER, canonical_hash: HASH,
  })
  return { ...unsigned, canonical_hash: protocolRevisionCanonicalHash(unsigned) }
}

function insertJob(kernel: ResearchKernel, input: {
  jobId: string
  projectId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'retryable'
  intent: 'exploratory' | 'confirmatory'
  protocolPin: FrozenProtocolPin | null
  failureClass?: 'environment' | 'resources' | 'code_error' | 'data_issue' | 'unknown' | null
  runManifest?: Record<string, unknown> | null
  error?: string
}): string {
  const terminal = input.status === 'succeeded' || input.status === 'failed' || input.status === 'cancelled'
  kernel.db.prepare(`
    INSERT INTO jobs
      (job_id, project_id, contract_id, idempotency_key, kind, command, payload, status,
       failure_class, lease_owner, lease_expires_at, heartbeat_at, attempts, max_attempts,
       run_manifest, error, created_at, updated_at, code_snapshot_id,
       created_by_principal_id, synthetic_fixture)
    VALUES (?, ?, NULL, ?, 'echo', '[]', ?, ?, ?, NULL, NULL, NULL, 1, 3, ?, ?, ?, ?, NULL, ?, 0)
  `).run(
    input.jobId,
    input.projectId,
    `idem-${input.jobId}`,
    JSON.stringify({ run_intent: input.intent, protocol_pin: input.protocolPin }),
    terminal ? 'queued' : input.status,
    input.failureClass ?? null,
    input.runManifest === undefined || input.runManifest === null ? null : JSON.stringify(input.runManifest),
    input.error ?? '',
    EARLIER,
    EARLIER,
    'pi-outcome',
  )
  if (!terminal) return `run_${input.jobId}`
  const [claimed] = kernel.claimJobs(`runner-${input.jobId}`, 300, 1)
  if (claimed === undefined || claimed.job_id !== input.jobId || claimed.run_id === null) throw new Error(`failed to claim fixture ${input.jobId}`)
  kernel.completeJob({
    job_id: input.jobId,
    owner: `runner-${input.jobId}`,
    status: input.status,
    failure_class: input.failureClass ?? undefined,
    error: input.error,
    run_manifest: input.runManifest ?? undefined,
    lease_generation: claimed.lease_generation,
    lease_token: claimed.lease_token,
  })
  return claimed.run_id
}

function runRecord(input: Partial<ResearchRunClassificationWriteRecordValue> & Pick<ResearchRunClassificationWriteRecordValue, 'run_ref' | 'project_id'>): ResearchRunClassificationWriteRecordValue {
  return ResearchRunClassificationWriteRecord.parse({
    outcome: 'negative', validity: 'valid', analysis_artifact_id: null, evidence_refs: [], recorded_at: NOW, ...input,
  })
}

describe('Research run outcome closure', () => {
  const kernels: ResearchKernel[] = []
  afterEach(() => { for (const kernel of kernels.splice(0)) kernel.close() })

  it('persists a confirmatory negative as an append-only finding and Claim proposal without moving Project state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-run-outcome-'))
    const dbPath = join(dir, 'kernel.db')
    const casRoot = join(dir, 'cas')
    const kernel = new ResearchKernel({ dbPath, casRoot })
    kernels.push(kernel)
    const project = kernel.createProject({ name: 'outcome', workspace: '/work', brief: brief(), creator_principal_id: 'pi-outcome' })
    kernel.addProjectMember({ project_id: project.project_id, principal_id: 'viewer-outcome', role: 'viewer', actor: 'pi-outcome' })
    const protocol = frozenProtocol(project.project_id)
    kernel.methodology.recordProtocolRevision({ record: protocol, expected_revision: 0 })
    const protocolPin = {
      protocol_id: protocol.protocol_id, revision: protocol.revision, canonical_hash: protocol.canonical_hash!,
    }
    const analysis = kernel.registerArtifact({ project_id: project.project_id, kind: 'analysis', content: '{"effect":-0.1}' })
    const negativeRunId = insertJob(kernel, { jobId: 'job_negative_1', projectId: project.project_id, status: 'succeeded', intent: 'confirmatory', protocolPin })
    const evidence = kernel.ingestVerifiedEvidence({
      project_id: project.project_id, source_type: 'analysis', run_ids: ['job_negative_1'],
      artifact_refs: [analysis.artifact_id], analysis_method: 'paired test',
      result: { primary_metric: 'accuracy', value: 0.7, baseline_value: 0.8, effect_size: -0.1, n_seeds: 3 },
    })
    const statusBefore = kernel.getProject(project.project_id).status
    const claimsBefore = kernel.listClaims(project.project_id).length
    const evidenceBefore = kernel.listEvidence(project.project_id).length
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const client = new ResearchClient({ endpoint: url })
      expect((await fetch(`${url}/v2/projects/${project.project_id}/research-runs`)).status).toBe(422)
      expect((await fetch(`${url}/v2/projects/${project.project_id}/research-runs`, { headers: { 'x-principal-id': 'outsider' } })).status).toBe(404)
      await expect(client.recordResearchRun(project.project_id, 'viewer-outcome', {
        record: runRecord({ run_ref: negativeRunId, project_id: project.project_id,
          analysis_artifact_id: analysis.artifact_id, evidence_refs: [evidence.evidence_id] }),
        claim_proposal: { proposal_id: 'claim_proposal_negative_1', statement: 'The approved treatment did not improve accuracy.' },
        expected_revision: 0,
      })).rejects.toMatchObject({ status: 403, code: 'role_forbidden' })

      const receipt = await client.recordResearchRun(project.project_id, 'pi-outcome', {
        record: runRecord({ run_ref: negativeRunId, project_id: project.project_id,
          analysis_artifact_id: analysis.artifact_id, evidence_refs: [evidence.evidence_id] }),
        claim_proposal: { proposal_id: 'claim_proposal_negative_1', statement: 'The approved treatment did not improve accuracy.' },
        expected_revision: 0,
      })
      expect(receipt).toMatchObject({
        run_stream_revision: 1, recorded_revision: 1, replayed: false,
        outcome: {
          run: { run_ref: negativeRunId, intent: 'confirmatory', outcome: 'negative', validity: 'valid' },
          classification: { interpretation: 'negative_finding_candidate', negative_finding_eligible: true, claim_authority: 'proposal_only' },
          negative_finding: { run_ref: negativeRunId, claim_proposal_id: 'claim_proposal_negative_1' },
          claim_proposal: { proposal_id: 'claim_proposal_negative_1', proposal_kind: 'negative_finding', status: 'proposed' },
        },
      })
      expect(() => kernel.db.prepare('DELETE FROM methodology_run_outcomes WHERE project_id = ?').run(project.project_id))
        .toThrow('methodology_run_outcomes_append_only')
      expect(kernel.getProject(project.project_id).status).toBe(statusBefore)
      expect(kernel.listClaims(project.project_id)).toHaveLength(claimsBefore)
      expect(kernel.listEvidence(project.project_id)).toHaveLength(evidenceBefore)

      const replay = await client.recordResearchRun(project.project_id, 'pi-outcome', {
        record: runRecord({
          run_ref: receipt.outcome.run.run_ref,
          project_id: receipt.outcome.run.project_id,
          outcome: receipt.outcome.run.outcome,
          validity: receipt.outcome.run.validity,
          analysis_artifact_id: receipt.outcome.run.analysis_artifact_id,
          evidence_refs: receipt.outcome.run.evidence_refs,
          recorded_at: receipt.outcome.run.recorded_at,
        }),
        claim_proposal: { proposal_id: 'claim_proposal_negative_1', statement: 'The approved treatment did not improve accuracy.' },
        expected_revision: 0,
      })
      expect(replay).toMatchObject({ replayed: true, recorded_revision: 1, run_stream_revision: 1 })
      expect((await client.listResearchRuns(project.project_id, 'pi-outcome')).outcomes).toHaveLength(1)
      expect((await client.listNegativeFindings(project.project_id, 'pi-outcome')).findings).toHaveLength(1)
      expect((await client.listResearchClaimProposals(project.project_id, 'pi-outcome')).proposals).toHaveLength(1)

      await expect(client.recordResearchRun(project.project_id, 'pi-outcome', {
        record: runRecord({
          run_ref: receipt.outcome.run.run_ref,
          project_id: receipt.outcome.run.project_id,
          outcome: receipt.outcome.run.outcome,
          validity: receipt.outcome.run.validity,
          analysis_artifact_id: receipt.outcome.run.analysis_artifact_id,
          evidence_refs: receipt.outcome.run.evidence_refs,
          recorded_at: receipt.outcome.run.recorded_at,
        }),
        claim_proposal: { proposal_id: 'claim_proposal_negative_1', statement: 'A conflicting replay.' },
        expected_revision: 1,
      })).rejects.toMatchObject({ status: 409, code: 'methodology_run_outcome_conflict' })

      const graph = await client.getMethodologyGraph(project.project_id, 'pi-outcome')
      expect(graph.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: `run:${negativeRunId}`, kind: 'classifies_as' }),
        expect.objectContaining({ to: 'claim-proposal:claim_proposal_negative_1', kind: 'proposes' }),
      ]))
      expect(await client.getMethodology(project.project_id, 'pi-outcome')).toMatchObject({
        runs: { revision: 1, count: 1, negative_finding_count: 1, claim_proposal_count: 1, latest_run_ref: negativeRunId },
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }

    kernel.close()
    kernels.splice(kernels.indexOf(kernel), 1)
    const reopened = new ResearchKernel({ dbPath, casRoot })
    kernels.push(reopened)
    expect(reopened.methodology.listResearchRunOutcomes(project.project_id)).toMatchObject({
      project_id: project.project_id, run_stream_revision: 1,
      outcomes: [{ outcome: { run: { run_ref: negativeRunId } } }],
    })
  })

  it('fails closed on nonterminal/cross-project bindings and never turns failed execution into a scientific negative', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-run-diagnostic-'))
    const kernel = new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas') })
    kernels.push(kernel)
    const project = kernel.createProject({ name: 'diagnostics', workspace: '/work', brief: brief(), creator_principal_id: 'pi-outcome' })
    const foreign = kernel.createProject({ name: 'foreign', workspace: '/foreign', brief: brief(), creator_principal_id: 'pi-foreign' })
    const runningRunId = insertJob(kernel, { jobId: 'job_running_1', projectId: project.project_id, status: 'running', intent: 'exploratory', protocolPin: null })
    const foreignRunId = insertJob(kernel, { jobId: 'job_foreign_1', projectId: foreign.project_id, status: 'succeeded', intent: 'exploratory', protocolPin: null })
    const oomRunId = insertJob(kernel, { jobId: 'job_oom_1', projectId: project.project_id, status: 'failed', intent: 'confirmatory', protocolPin: null,
      failureClass: 'resources', error: 'container OOM' })
    const sshRunId = insertJob(kernel, { jobId: 'job_ssh_1', projectId: project.project_id, status: 'failed', intent: 'exploratory', protocolPin: null,
      failureClass: 'environment', error: 'SSH connection lost' })
    const exploreRunId = insertJob(kernel, { jobId: 'job_explore_1', projectId: project.project_id, status: 'succeeded', intent: 'exploratory', protocolPin: null })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      const client = new ResearchClient({ endpoint: url })
      await expect(client.recordResearchRun(project.project_id, 'pi-outcome', {
        record: runRecord({ run_ref: runningRunId, project_id: project.project_id,
          outcome: 'inconclusive', validity: 'invalid' }), claim_proposal: null, expected_revision: 0,
      })).rejects.toMatchObject({ status: 404, code: 'research_run_observation_not_found' })
      await expect(client.recordResearchRun(project.project_id, 'pi-outcome', {
        record: runRecord({ run_ref: foreignRunId, project_id: project.project_id,
          outcome: 'positive', validity: 'valid' }),
        claim_proposal: { proposal_id: 'claim_proposal_foreign', statement: 'Must not cross projects.' }, expected_revision: 0,
      })).rejects.toMatchObject({ status: 404, code: 'research_run_observation_not_found' })
      await expect(client.recordResearchRun(project.project_id, 'pi-outcome', {
        record: runRecord({ run_ref: oomRunId, project_id: project.project_id,
          outcome: 'negative', validity: 'valid' }), claim_proposal: null, expected_revision: 0,
      })).rejects.toMatchObject({ status: 422, code: 'research_run_execution_classification_mismatch' })

      const diagnostic = await client.recordResearchRun(project.project_id, 'pi-outcome', {
        record: runRecord({ run_ref: oomRunId, project_id: project.project_id,
          outcome: 'inconclusive', validity: 'infrastructure_failure' }), claim_proposal: null, expected_revision: 0,
      })
      expect(diagnostic.outcome).toMatchObject({
        classification: { interpretation: 'infrastructure_diagnostic', negative_finding_eligible: false },
        negative_finding: null, claim_proposal: null,
      })

      const sshDiagnostic = await client.recordResearchRun(project.project_id, 'pi-outcome', {
        record: runRecord({ run_ref: sshRunId, project_id: project.project_id,
          outcome: 'inconclusive', validity: 'infrastructure_failure' }),
        claim_proposal: null, expected_revision: 1,
      })
      expect(sshDiagnostic.outcome).toMatchObject({
        classification: { interpretation: 'infrastructure_diagnostic', negative_finding_eligible: false },
        negative_finding: null, claim_proposal: null,
      })

      const hypothesis = await client.recordResearchRun(project.project_id, 'pi-outcome', {
        record: runRecord({ run_ref: exploreRunId, project_id: project.project_id,
          outcome: 'positive', validity: 'valid' }),
        claim_proposal: { proposal_id: 'claim_proposal_explore_1', statement: 'The observed pattern is worth a confirmatory test.' },
        expected_revision: 2,
      })
      expect(hypothesis.outcome).toMatchObject({
        classification: { interpretation: 'hypothesis_proposal', claim_authority: 'proposal_only' },
        negative_finding: null,
        claim_proposal: { proposal_kind: 'hypothesis', status: 'proposed', evidence_refs: [] },
      })
      expect(kernel.listClaims(project.project_id)).toEqual([])
      expect(kernel.listAcceptedEvidence(project.project_id)).toEqual([])
      expect(kernel.getProject(project.project_id).status).toBe('DRAFT')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
