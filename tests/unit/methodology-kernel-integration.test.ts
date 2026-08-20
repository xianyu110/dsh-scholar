import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ResearchKernel, KernelError } from '@dsh-scholar/research-kernel'
import { protocolRevisionCanonicalHash } from '../../packages/research-kernel/src/methodology-store.js'
import {
  ProtocolRevision,
  RUNNER_PROFILE_IDS,
  runnerTargetConfigHash,
  type ExperimentContract,
} from '@dsh-scholar/research-schemas'

const NODE_IMAGE_DIGEST = 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'

function kernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-methodology-kernel-'))
  return new ResearchKernel({
    dbPath: join(dir, 'kernel.db'),
    casRoot: join(dir, 'cas'),
    requireSignedManifest: false,
  })
}

function canonicalTopLevel(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort())
}

function contractHash(contract: ExperimentContract): string {
  return `sha256:${createHash('sha256').update(canonicalTopLevel(contract as unknown as Record<string, unknown>)).digest('hex')}`
}

function expectKernelError(fn: () => unknown, code: string): void {
  try {
    fn()
    throw new Error('expected KernelError')
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError)
    expect((error as KernelError).code).toBe(code)
  }
}

describe('Kernel methodology admission', () => {
  it('rejects formal work before any job/outbox write and admits the exact frozen boundary', () => {
    const k = kernel()
    const project = k.createProject({
      name: 'Protocol-bound run',
      workspace: '/workspace/protocol',
      brief: {
        problem: 'test a claim', scope: 'one model', questions: ['does it work?'],
        primary_metrics: ['accuracy'], resources: '', risks: [], target_outputs: ['paper'],
        target_venue: null, baseline_repo: null, domain: 'ml',
      },
      execution: { runner_profile_id: RUNNER_PROFILE_IDS.localDockerCpu },
    })
    const contract = k.registerContract({
      project_id: project.project_id,
      idea_id: 'idea_protocol',
      data: { dataset_id: 'dataset_bundle', version: 'v1' },
      methods: { baseline: 'node train.js', treatment: 'node train.js --treatment' },
      metrics: { primary: 'accuracy', secondary: [] },
    })
    k.approveContract(contract.contract_id, 'decision_protocol', 'principal_pi')
    const approved = k.getContract(contract.contract_id)
    const code = k.registerArtifact({ project_id: project.project_id, kind: 'code', content: 'code' })
    const data = k.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'data' })

    const beforeJobs = (k.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n
    const beforeEvents = (k.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
    expectKernelError(() => k.submitJob({
      project_id: project.project_id,
      idempotency_key: 'formal-without-protocol',
      kind: 'formal',
      contract_id: approved.contract_id,
      code_snapshot_id: code.artifact_id,
      data_artifact_ids: [data.artifact_id],
      image_digest: NODE_IMAGE_DIGEST,
    }), 'protocol_required')
    expect((k.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(beforeJobs)
    expect((k.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(beforeEvents)

    const initialTarget = k.listRunnerTargets().find(item => item.target_id === project.execution.runner_target_id)!
    k.runnerTargets.observe(initialTarget.target_id, { expected_revision: initialTarget.revision, health: 'online' })
    const target = k.listRunnerTargets().find(item => item.target_id === project.execution.runner_target_id)!
    const protocolInput = ProtocolRevision.parse({
      protocol_id: 'protocol_formal_v1',
      project_id: project.project_id,
      revision: 1,
      supersedes: null,
      status: 'frozen',
      intent: 'confirmatory',
      research_question_ref: 'question_primary',
      target_claim_ref: 'claim_primary',
      hypothesis: 'The treatment improves accuracy.',
      prediction: 'Accuracy increases under the treatment.',
      variables: { manipulated: ['treatment'], controlled: ['dataset'], measured: ['accuracy'] },
      metrics: {
        primary: 'accuracy', secondary: [], baseline_ref: 'baseline_primary',
        analysis_plan_artifact_id: data.artifact_id,
      },
      pins: {
        contract: { ref: approved.contract_id, sha256: contractHash(approved) },
        code: { ref: code.artifact_id, sha256: `sha256:${code.sha256}` },
        data: { ref: data.artifact_id, sha256: `sha256:${data.sha256}` },
        environment: { ref: target.target_id, sha256: runnerTargetConfigHash(target) },
      },
      stopping_conditions: ['one complete run'],
      failure_criteria: ['integrity failure'],
      allowed_deviations: [],
      deviation_handling: 'Freeze a new protocol revision.',
      author_principal_id: 'principal_pi',
      created_at: '2026-08-19T00:00:00.000Z',
      frozen_at: '2026-08-19T00:00:00.000Z',
      canonical_hash: `sha256:${'e'.repeat(64)}`,
    })
    const protocol = { ...protocolInput, canonical_hash: protocolRevisionCanonicalHash(protocolInput) }
    k.methodology.recordProtocolRevision({ record: protocol, expected_revision: 0 })

    const job = k.submitJob({
      project_id: project.project_id,
      idempotency_key: 'formal-with-protocol',
      kind: 'formal',
      contract_id: approved.contract_id,
      code_snapshot_id: code.artifact_id,
      data_artifact_ids: [data.artifact_id],
      image_digest: NODE_IMAGE_DIGEST,
      run_intent: 'confirmatory',
      protocol_pin: {
        protocol_id: protocol.protocol_id,
        revision: protocol.revision,
        canonical_hash: protocol.canonical_hash!,
      },
    })
    expect(job).toMatchObject({
      run_intent: 'confirmatory',
      protocol_pin: {
        protocol_id: protocol.protocol_id,
        revision: 1,
        canonical_hash: protocol.canonical_hash,
      },
    })
    expect(k.getJob(job.job_id)).toMatchObject({ protocol_pin: job.protocol_pin, run_intent: 'confirmatory' })
    k.close()
  })
})
