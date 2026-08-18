/**
 * Pure Runner environment assessment shared by projection and submission.
 * It separates hard configuration failures from the stronger observed-ready
 * state used by next-step guidance.
 */
import type { RunnerProfile, RunnerTargetDescriptor, SecretRef } from '@dsh-scholar/research-schemas'

export type RunnerEnvironmentFailure =
  | 'profile_disabled'
  | 'target_disabled'
  | 'target_draining'
  | 'target_offline'
  | 'target_unprobed'
  | 'profile_target_mismatch'
  | 'target_secret_unavailable'
  | 'target_capability_mismatch'

export interface RunnerEnvironmentAssessment {
  observedReady: boolean
  failures: RunnerEnvironmentFailure[]
  hardFailures: RunnerEnvironmentFailure[]
}

/** Remote observations older than this no longer establish readiness. */
export const RUNNER_TARGET_HEARTBEAT_TTL_MS = 60_000

export function assessRunnerEnvironment(
  profile: RunnerProfile,
  target: RunnerTargetDescriptor,
  secretAvailable: (ref: SecretRef) => boolean,
  nowMs = Date.now(),
): RunnerEnvironmentAssessment {
  const failures: RunnerEnvironmentFailure[] = []
  const hardFailures: RunnerEnvironmentFailure[] = []
  const hard = (failure: RunnerEnvironmentFailure): void => {
    if (!failures.includes(failure)) failures.push(failure)
    if (!hardFailures.includes(failure)) hardFailures.push(failure)
  }

  if (!profile.enabled) hard('profile_disabled')
  if (!target.enabled) hard('target_disabled')
  if (target.draining) hard('target_draining')
  if (target.health === 'offline') hard('target_offline')
  else if (target.health !== 'online') failures.push('target_unprobed')

  if (profile.runner_mode === 'isolated-subprocess' && target.kind !== 'local-process') hard('profile_target_mismatch')
  if (profile.runner_mode === 'local-docker' && target.kind === 'local-process') hard('profile_target_mismatch')

  if (target.kind === 'remote-ssh') {
    if (target.connection === undefined) {
      hard('target_secret_unavailable')
    } else if ([target.connection.endpoint, target.connection.credential, target.connection.known_hosts].some(ref => !secretAvailable(ref))) {
      hard('target_secret_unavailable')
    }
    const seenMs = target.last_seen_at === null ? Number.NaN : Date.parse(target.last_seen_at)
    if (target.health !== 'online' || !Number.isFinite(seenMs) || nowMs - seenMs > RUNNER_TARGET_HEARTBEAT_TTL_MS) {
      hard('target_unprobed')
    }
  }

  if (target.runtime?.compute.mode === 'nvidia'
    && !target.capabilities.some(capability => capability === 'nvidia' || capability === 'gpu')) {
    hard('target_capability_mismatch')
  }

  return { observedReady: failures.length === 0, failures, hardFailures }
}
