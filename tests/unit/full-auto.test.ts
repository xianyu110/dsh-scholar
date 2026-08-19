/**
 * Full-auto fixture binding tests (reconstruction-contracts.md §5 /
 * security-baseline.md §1 "full-auto | fixture-only").
 *
 * full-auto mode is ONLY valid for REGISTERED FixtureProfiles: project
 * create and job submit both reject unbound full-auto (422 fixture_required),
 * and fixture jobs must stay inside the profile — pinned image digest
 * (fixture_image_mismatch) and profile data content hashes
 * (fixture_artifact_outside_profile).
 */
import { describe, expect, it } from 'vitest'
import { ResearchKernel, KernelError } from '@dsh-scholar/research-kernel'
import { FixtureProfile, getFixtureProfile } from '@dsh-scholar/research-schemas'
import { ConfiguredTestKernel } from './configured-test-kernel.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Assert a KernelError with an exact error code (messages carry no code). */
function expectKernelError(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError)
    expect((error as KernelError).code).toBe(code)
    return
  }
  throw new Error(`expected KernelError with code ${code} but no error was thrown`)
}

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fullauto-'))
  return new ConfiguredTestKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas') })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m1'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'machine-learning',
  }
}

const FIXTURE_ID = 'golden-path-v2'

describe('FixtureProfile registry (reconstruction-contracts.md §5)', () => {
  it('registers the golden-path-v2 fixture with forced guard rails', () => {
    const profile = getFixtureProfile(FIXTURE_ID)
    expect(profile).not.toBeNull()
    expect(profile?.automatic_release).toBe(false)
    expect(profile?.allow_private_data).toBe(false)
    expect(profile?.allow_external_release).toBe(false)
    expect(profile?.image).toMatch(/^[^\s@]+@sha256:[0-9a-f]{64}$/)
    // The schema FORBIDS overriding the guard rails (z.literal).
    expect(FixtureProfile.safeParse({ ...profile, automatic_release: true }).success).toBe(false)
    expect(FixtureProfile.safeParse({ ...profile, allow_private_data: true }).success).toBe(false)
  })

  it('unknown fixture ids resolve to null', () => {
    expect(getFixtureProfile('not-registered')).toBeNull()
    expect(getFixtureProfile('')).toBeNull()
  })
})

describe('full-auto project create requires a registered fixture', () => {
  it('gate-only projects do not need a fixture', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'g', workspace: '/w/g', brief: makeBrief(), mode: 'gate-only' })
    expect(project.mode).toBe('gate-only')
    expect(project.execution.fixture_id).toBeNull()
  })

  it('full-auto without fixture_id is rejected (422 fixture_required) and nothing is persisted', () => {
    const kernel = freshKernel()
    expectKernelError(() => kernel.createProject({ name: 'f', workspace: '/w/f', brief: makeBrief(), mode: 'full-auto' }), 'fixture_required')
    expect(kernel.listProjects()).toHaveLength(0)
  })

  it('full-auto with an UNREGISTERED fixture_id is rejected', () => {
    const kernel = freshKernel()
    expectKernelError(() => kernel.createProject({
      name: 'f', workspace: '/w/f', brief: makeBrief(), mode: 'full-auto',
      execution: { fixture_id: 'not-registered' },
    }), 'fixture_required')
  })

  it('full-auto with a registered fixture_id is created and persisted', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({
      name: 'f', workspace: '/w/f', brief: makeBrief(), mode: 'full-auto',
      execution: { fixture_id: FIXTURE_ID },
    })
    expect(project.mode).toBe('full-auto')
    expect(project.execution.fixture_id).toBe(FIXTURE_ID)
    // Re-read from the store: the binding is durable.
    expect(kernel.getProject(project.project_id).execution.fixture_id).toBe(FIXTURE_ID)
  })
})

describe('full-auto job submit stays inside the fixture profile', () => {
  function fullAutoProject(kernel: ResearchKernel): string {
    return kernel.createProject({
      name: 'f', workspace: '/w/f', brief: makeBrief(), mode: 'full-auto',
      execution: { fixture_id: FIXTURE_ID },
    }).project_id
  }

  function codeSnapshot(kernel: ResearchKernel, projectId: string): string {
    return kernel.registerArtifact({
      project_id: projectId, kind: 'code', content: 'fixture code archive bytes',
      file_name: 'fixture.tar', media_type: 'application/x-tar',
    }).artifact_id
  }

  function approvedContractId(kernel: ResearchKernel, projectId: string): string {
    const contract = kernel.registerContract({
      project_id: projectId, idea_id: 'idea_x', data: { dataset_id: 'd', version: 'v1' },
      methods: { baseline: 'b', treatment: 'a' }, metrics: { primary: 'm1', secondary: [] },
      seeds: [1], analysis: {}, ablations: [],
      stop_conditions: { max_gpu_hours: 1, min_completed_seeds: 1, stop_on_data_leakage: true },
    })
    kernel.approveContract(contract.contract_id, 'dec_gate', 'pi')
    return contract.contract_id
  }

  it('submission on a project whose fixture binding was lost is rejected (defense in depth)', () => {
    const kernel = freshKernel()
    const projectId = fullAutoProject(kernel)
    kernel.db.prepare('UPDATE projects SET execution = ? WHERE project_id = ?')
      .run(JSON.stringify({ runner_profile_id: 'profile_local_docker_cpu_v1', network_policy: 'allowlist', artifact_store: 'local-cas', fixture_id: null }), projectId)
    expectKernelError(() => kernel.submitJob({
      project_id: projectId, idempotency_key: 'k1', kind: 'echo', command: [],
      payload: { message: 'x' },
    }), 'fixture_required')
  })

  it('a caller-supplied digest that differs from the profile image is rejected (fixture_image_mismatch)', () => {
    const kernel = freshKernel()
    const projectId = fullAutoProject(kernel)
    const contractId = approvedContractId(kernel, projectId)
    const snap = codeSnapshot(kernel, projectId)
    expectKernelError(() => kernel.submitJob({
      project_id: projectId, idempotency_key: 'k1', kind: 'baseline', contract_id: contractId,
      code_snapshot_id: snap, image_digest: 'node@sha256:' + 'b'.repeat(64),
      payload: { repo: 'evals/golden-path-v2/fixture-repo', commit: 'in-repo' },
    }), 'fixture_image_mismatch')
  })

  it('an absent digest is bound to the fixture profile image', () => {
    const kernel = freshKernel()
    const projectId = fullAutoProject(kernel)
    const contractId = approvedContractId(kernel, projectId)
    const snap = codeSnapshot(kernel, projectId)
    const job = kernel.submitJob({
      project_id: projectId, idempotency_key: 'k2', kind: 'baseline', contract_id: contractId,
      code_snapshot_id: snap, payload: { repo: 'evals/golden-path-v2/fixture-repo', commit: 'in-repo' },
    })
    expect(job.image_digest).toBe(getFixtureProfile(FIXTURE_ID)!.image)
    expect(job.payload.image_digest).toBe(getFixtureProfile(FIXTURE_ID)!.image)
  })

  it('data artifacts outside the profile are rejected (fixture_artifact_outside_profile)', () => {
    const kernel = freshKernel()
    const projectId = fullAutoProject(kernel)
    const contractId = approvedContractId(kernel, projectId)
    const snap = codeSnapshot(kernel, projectId)
    // Private data blob: content is NOT among the profile's fixed data inputs.
    const artifact = kernel.registerArtifact({
      project_id: projectId, kind: 'data', content: 'private dataset bytes that must never enter a fixture job',
      file_name: 'private.csv',
    })
    expectKernelError(() => kernel.submitJob({
      project_id: projectId, idempotency_key: 'k3', kind: 'baseline', contract_id: contractId,
      code_snapshot_id: snap, data_artifact_ids: [artifact.artifact_id],
      payload: { repo: 'evals/golden-path-v2/fixture-repo', commit: 'in-repo' },
    }), 'fixture_artifact_outside_profile')
  })

  it('echo jobs in a full-auto project remain allowed', () => {
    const kernel = freshKernel()
    const projectId = fullAutoProject(kernel)
    const job = kernel.submitJob({
      project_id: projectId, idempotency_key: 'k4', kind: 'echo', command: [],
      payload: { message: 'fixture ok' },
    })
    expect(job.status).toBe('queued')
  })
})
