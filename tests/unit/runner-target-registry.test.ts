import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KernelError, ResearchKernel, startKernelServer } from '@dsh-scholar/research-kernel'
import {
  RunnerTargetCreateInput,
  RunnerTargetDescriptor,
  RunnerTargetUpdateInput,
  runnerTargetConfigHash,
  runnerTargetSafeView,
} from '../../packages/research-schemas/src/runner-target'

const remoteInput = {
  target_id: 'target_remote_lab_a',
  display_name: 'Lab A',
  kind: 'remote-ssh' as const,
  enabled: true,
  draining: false,
  capabilities: ['linux', 'amd64', 'docker'],
  connection: {
    endpoint: { scheme: 'file' as const, name: 'runner/lab-a-endpoint.json', scope: 'instance' as const },
    credential: { scheme: 'vault' as const, name: 'runner/lab-a-key', version: '3', scope: 'instance' as const },
    known_hosts: { scheme: 'file' as const, name: 'runner/lab-a-known-hosts', scope: 'instance' as const },
  },
}

describe('EXEC-ENV-02 configurable runner targets', () => {
  it('models local process, local Docker and remote SSH explicitly', () => {
    expect(RunnerTargetCreateInput.parse({
      target_id: 'target_local_process_v1', display_name: 'Local process', kind: 'local-process',
      enabled: true, draining: false, capabilities: ['trusted-smoke-fixture'],
    }).kind).toBe('local-process')
    expect(RunnerTargetCreateInput.parse({
      target_id: 'target_local_docker_v1', display_name: 'Local Docker', kind: 'local-docker',
      enabled: true, draining: false, capabilities: ['docker'],
    }).kind).toBe('local-docker')
    expect(RunnerTargetCreateInput.parse(remoteInput).kind).toBe('remote-ssh')
  })

  it('rejects inline SSH endpoints, credentials and arbitrary bootstrap commands', () => {
    for (const forbidden of [
      { ...remoteInput, hostname: '10.0.0.5' },
      { ...remoteInput, private_key: 'SECRET' },
      { ...remoteInput, proxy_command: 'nc %h %p' },
      { ...remoteInput, connection: { ...remoteInput.connection, credential: { ...remoteInput.connection.credential, value: 'SECRET' } } },
    ]) expect(() => RunnerTargetCreateInput.parse(forbidden)).toThrow()
  })

  it('requires revision CAS for updates', () => {
    expect(RunnerTargetUpdateInput.parse({ expected_revision: 2, draining: true })).toEqual({ expected_revision: 2, draining: true })
    expect(() => RunnerTargetUpdateInput.parse({ draining: true })).toThrow()
  })

  it('returns only SecretRef metadata/availability and a stable config hash', () => {
    const now = '2026-08-12T00:00:00.000Z'
    const descriptor = RunnerTargetDescriptor.parse({ ...remoteInput, revision: 1, created_by: 'pi', created_at: now, updated_at: now })
    expect(runnerTargetConfigHash(descriptor)).toMatch(/^sha256:[0-9a-f]{64}$/)
    const view = runnerTargetSafeView(descriptor, () => false)
    expect(view.connection?.credential).toEqual({ ...remoteInput.connection.credential, available: false })
    expect(JSON.stringify(view)).not.toContain('SECRET')
  })

  it('persists targets, applies revision CAS and pins the selected target into jobs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-targets-'))
    const secretRoot = join(root, 'secrets')
    mkdirSync(join(secretRoot, 'runner'), { recursive: true })
    writeFileSync(join(secretRoot, 'runner/endpoint.json'), '{"host":"lab.example","port":22,"user":"runner"}')
    writeFileSync(join(secretRoot, 'runner/key'), 'test-key')
    writeFileSync(join(secretRoot, 'runner/known_hosts'), 'lab.example ssh-ed25519 test')
    const kernel = new ResearchKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas'), secretRoot })
    try {
      expect(kernel.listRunnerTargets().map(target => target.target_id)).toEqual([
        'target_local_docker_v1',
        'target_local_process_v1',
      ])
      const created = kernel.registerRunnerTarget(RunnerTargetCreateInput.parse({
        ...remoteInput,
        target_id: 'lab-a',
        connection: {
          endpoint: { scheme: 'file', name: 'runner/endpoint.json' },
          credential: { scheme: 'file', name: 'runner/key' },
          known_hosts: { scheme: 'file', name: 'runner/known_hosts' },
        },
      }), 'operator-1')
      expect(kernel.runnerTargetView(created).connection?.known_hosts.available).toBe(true)
      expect(() => kernel.updateRunnerTarget('lab-a', { expected_revision: 2, draining: true })).toThrowError(KernelError)
      const project = kernel.createProject({
        name: 'remote', workspace: '/w',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        execution: { runner_target_id: 'lab-a' },
      })
      const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'remote-1', kind: 'echo' })
      expect(job.payload).toMatchObject({
        runner_target_id: 'lab-a',
        runner_target_kind: 'remote-ssh',
        runner_target_revision: 1,
      })
      expect(job.payload.runner_target_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    } finally {
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('CAS-configures the current project default target and preserves Job override precedence', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-project-target-'))
    const kernel = new ResearchKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas') })
    try {
      const project = kernel.createProject({
        name: 'target selection', workspace: '/w',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
      })
      const configured = kernel.configureProjectRunnerTarget({
        project_id: project.project_id,
        runner_target_id: 'target_local_process_v1',
        expected_revision: project.revision,
      })
      expect(configured.execution.runner_target_id).toBe('target_local_process_v1')
      expect(configured.execution.runner_profile_id).toBe('profile_isolated_subprocess_v1')
      expect(configured.revision).toBe(project.revision + 1)
      expect(() => kernel.configureProjectRunnerTarget({
        project_id: project.project_id,
        runner_target_id: 'target_local_docker_v1',
        expected_revision: project.revision,
      })).toThrowError(KernelError)
      expect(() => kernel.configureProjectRunnerTarget({
        project_id: project.project_id,
        runner_target_id: 'target_missing',
        expected_revision: configured.revision,
      })).toThrowError(KernelError)
      kernel.updateRunnerTarget('target_local_docker_v1', { expected_revision: 1, enabled: false })
      expect(() => kernel.configureProjectRunnerTarget({
        project_id: project.project_id,
        runner_target_id: 'target_local_docker_v1',
        expected_revision: configured.revision,
      })).toThrowError(KernelError)
      kernel.updateRunnerTarget('target_local_docker_v1', { expected_revision: 2, enabled: true })

      const projectDefault = kernel.submitJob({
        project_id: project.project_id, idempotency_key: 'project-default', kind: 'echo',
      })
      expect(projectDefault.payload.runner_target_id).toBe('target_local_process_v1')
      const overridden = kernel.submitJob({
        project_id: project.project_id, idempotency_key: 'job-override', kind: 'echo',
        runner_target_id: 'target_local_docker_v1', runner_profile_id: 'profile_local_docker_cpu_v1',
      })
      expect(overridden.payload.runner_target_id).toBe('target_local_docker_v1')
    } finally {
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('claims only jobs compatible with the runner target kind', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-target-claim-'))
    const kernel = new ResearchKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas') })
    try {
      const localProcess = kernel.createProject({
        name: 'process', workspace: '/process',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        execution: { runner_profile: 'isolated-subprocess', runner_target_id: 'target_local_process_v1' },
      })
      const localDocker = kernel.createProject({
        name: 'docker', workspace: '/docker',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
      })
      const processJob = kernel.submitJob({ project_id: localProcess.project_id, idempotency_key: 'p', kind: 'echo' })
      const dockerJob = kernel.submitJob({ project_id: localDocker.project_id, idempotency_key: 'd', kind: 'echo' })
      expect(kernel.claimJobs('process-runner', 60, 8, { runner_target_kinds: ['local-process'] }).map(job => job.job_id)).toEqual([processJob.job_id])
      expect(kernel.claimJobs('docker-runner', 60, 8, { runner_target_kinds: ['local-docker'] }).map(job => job.job_id)).toEqual([dockerJob.job_id])
    } finally {
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('claims an exact target id and does not let stale candidates consume the claim limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-target-exact-'))
    const kernel = new ResearchKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas') })
    try {
      for (const targetId of ['docker-a', 'docker-b']) {
        kernel.registerRunnerTarget(RunnerTargetCreateInput.parse({
          target_id: targetId,
          display_name: targetId,
          kind: 'local-docker',
          capabilities: ['docker'],
        }), 'operator-1')
      }
      const projectA = kernel.createProject({
        name: 'docker a', workspace: '/docker-a',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        execution: { runner_target_id: 'docker-a' },
      })
      const projectB = kernel.createProject({
        name: 'docker b', workspace: '/docker-b',
        brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
        execution: { runner_target_id: 'docker-b' },
      })
      const staleA = kernel.submitJob({ project_id: projectA.project_id, idempotency_key: 'a-stale', kind: 'echo' })
      const jobB = kernel.submitJob({ project_id: projectB.project_id, idempotency_key: 'b', kind: 'echo' })
      kernel.updateRunnerTarget('docker-a', { expected_revision: 1, display_name: 'docker a revision 2' })
      const freshA = kernel.submitJob({ project_id: projectA.project_id, idempotency_key: 'a-fresh', kind: 'echo' })

      expect(kernel.claimJobs('runner-a', 60, 1, {
        runner_target_kinds: ['local-docker'], runner_target_ids: ['docker-a'],
      }).map(job => job.job_id)).toEqual([freshA.job_id])
      expect(kernel.getJob(staleA.job_id).status).toBe('queued')
      expect(kernel.getJob(jobB.job_id).status).toBe('queued')
      expect(kernel.claimJobs('runner-b', 60, 1, {
        runner_target_kinds: ['local-docker'], runner_target_ids: ['docker-b'],
      }).map(job => job.job_id)).toEqual([jobB.job_id])
    } finally {
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed when project target state or target/profile kind is invalid', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-target-project-validation-'))
    const kernel = new ResearchKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas') })
    const create = (execution: Record<string, unknown>) => kernel.createProject({
      name: 'invalid target', workspace: '/invalid',
      brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
      execution,
    } as never)
    try {
      expect(() => create({ runner_target_id: 'target_missing' })).toThrowError(KernelError)
      expect(() => create({ runner_target_id: 'target_local_process_v1' })).toThrowError(KernelError)
      kernel.updateRunnerTarget('target_local_docker_v1', { expected_revision: 1, enabled: false })
      expect(() => create({ runner_target_id: 'target_local_docker_v1' })).toThrowError(KernelError)
      expect(kernel.listProjects()).toHaveLength(0)
    } finally {
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes redacted CRUD over HTTP and restricts writes to PI/operator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-target-http-'))
    const kernel = new ResearchKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas') })
    const project = kernel.createProject({
      name: 'target administrators', workspace: '/w', creator_principal_id: 'pi',
      brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
    } as never)
    kernel.addProjectMember({ project_id: project.project_id, principal_id: 'op', role: 'operator', actor: 'pi' })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    try {
      expect((await fetch(`${url}/v1/runner-targets`)).status).toBe(200)
      const body = { target_id: 'http-local', display_name: 'HTTP local', kind: 'local-process' }
      const denied = await fetch(`${url}/v1/runner-targets`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'outsider', 'x-principal-role': 'operator' }, body: JSON.stringify(body),
      })
      expect(denied.status).toBe(403)
      const created = await fetch(`${url}/v1/runner-targets`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'op', 'x-principal-role': 'operator' }, body: JSON.stringify(body),
      })
      expect(created.status).toBe(201)
      expect(await created.json()).toMatchObject({ target_id: 'http-local', revision: 1, kind: 'local-process' })
      const updated = await fetch(`${url}/v1/runner-targets/http-local`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', 'x-principal-id': 'pi', 'x-principal-role': 'pi' },
        body: JSON.stringify({ expected_revision: 1, draining: true }),
      })
      expect(updated.status).toBe(200)
      expect(await updated.json()).toMatchObject({ target_id: 'http-local', revision: 2, draining: true })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exposes a PI/operator-only project target configuration route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-project-target-http-'))
    const kernel = new ResearchKernel({ dbPath: join(root, 'kernel.db'), casRoot: join(root, 'cas') })
    const project = kernel.createProject({
      name: 'HTTP selection', workspace: '/w',
      brief: { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' },
      creator_principal_id: 'pi-1',
    } as never)
    kernel.addProjectMember({ project_id: project.project_id, principal_id: 'researcher-1', role: 'researcher', actor: 'pi-1' })
    const { server, url } = await startKernelServer({ kernel, port: 0 })
    const patchTarget = (principal: string, role: string, expectedRevision: number): Promise<Response> => fetch(
      `${url}/v2/projects/${project.project_id}/execution`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-principal-id': principal, 'x-principal-role': role },
        body: JSON.stringify({ expected_revision: expectedRevision, runner_target_id: 'target_local_process_v1' }),
      },
    )
    try {
      expect((await patchTarget('researcher-1', 'researcher', project.revision)).status).toBe(403)
      const updated = await patchTarget('pi-1', 'pi', project.revision)
      expect(updated.status).toBe(200)
      expect(await updated.json()).toMatchObject({
        revision: project.revision + 1,
        execution: { runner_target_id: 'target_local_process_v1', runner_profile_id: 'profile_isolated_subprocess_v1' },
      })
      expect((await patchTarget('pi-1', 'pi', project.revision)).status).toBe(409)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
