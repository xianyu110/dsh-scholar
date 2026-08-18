import { describe, expect, it } from 'vitest'
import {
  BUILTIN_RUNNER_PROFILES,
  RunnerTargetDescriptor,
  type RunnerProfile,
  type RunnerTargetDescriptor as RunnerTarget,
} from '@dsh-scholar/research-schemas'
import { assessRunnerEnvironment } from '@dsh-scholar/research-kernel'

const now = '2026-08-19T00:00:00.000Z'
const dockerProfile = BUILTIN_RUNNER_PROFILES.find(profile => profile.profile_id === 'profile_local_docker_cpu_v1')!

function target(overrides: Partial<RunnerTarget> = {}): RunnerTarget {
  return RunnerTargetDescriptor.parse({
    target_id: 'target_test', display_name: 'Test Docker', kind: 'local-docker', enabled: true,
    draining: false, capabilities: ['docker', 'cpu'], health: 'online', last_seen_at: now,
    revision: 1, created_by: 'test', created_at: now, updated_at: now,
    ...overrides,
  })
}

describe('runner environment readiness', () => {
  it('requires an observed online target; unknown and offline never project ready', () => {
    expect(assessRunnerEnvironment(dockerProfile, target({ health: 'unknown' }), () => true)).toMatchObject({
      observedReady: false, failures: ['target_unprobed'], hardFailures: [],
    })
    expect(assessRunnerEnvironment(dockerProfile, target({ health: 'offline' }), () => true)).toMatchObject({
      observedReady: false, failures: ['target_offline'], hardFailures: ['target_offline'],
    })
  })

  it('reports online compatible local targets ready', () => {
    expect(assessRunnerEnvironment(dockerProfile, target(), () => true)).toEqual({
      observedReady: true, failures: [], hardFailures: [],
    })
  })

  it('fails closed on disabled, draining and profile-target mismatch states', () => {
    const subprocess = BUILTIN_RUNNER_PROFILES.find(profile => profile.profile_id === 'profile_isolated_subprocess_v1')!
    const assessment = assessRunnerEnvironment(subprocess, target({ enabled: false, draining: true }), () => true)
    expect(assessment.observedReady).toBe(false)
    expect(assessment.hardFailures).toEqual(expect.arrayContaining([
      'target_disabled', 'target_draining', 'profile_target_mismatch',
    ]))
  })

  it('requires every remote SecretRef and a successful remote probe', () => {
    const observedAt = Date.parse('2026-08-19T00:00:00.000Z')
    const remote = target({
      kind: 'remote-ssh', health: 'online', last_seen_at: new Date(observedAt).toISOString(),
      connection: {
        endpoint: { scheme: 'keyring', name: 'ssh-endpoint' },
        credential: { scheme: 'keyring', name: 'ssh-key' },
        known_hosts: { scheme: 'keyring', name: 'ssh-known-hosts' },
      },
    })
    const unavailable = assessRunnerEnvironment(dockerProfile, remote, ref => ref.name !== 'ssh-key', observedAt + 1_000)
    expect(unavailable.hardFailures).toContain('target_secret_unavailable')
    expect(unavailable.hardFailures).not.toContain('target_unprobed')
    const stale = assessRunnerEnvironment(dockerProfile, remote, () => true, observedAt + 61_000)
    expect(stale.hardFailures).toContain('target_unprobed')
  })

  it('requires an advertised NVIDIA/GPU capability for an NVIDIA target runtime', () => {
    const gpuTarget = target({
      capabilities: ['docker'],
      runtime: { image_digest: `runner@sha256:${'a'.repeat(64)}`, compute: { mode: 'nvidia', devices: 'all' } },
    })
    expect(assessRunnerEnvironment(dockerProfile as RunnerProfile, gpuTarget, () => true).hardFailures)
      .toContain('target_capability_mismatch')
  })
})
