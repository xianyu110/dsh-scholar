/**
 * Durable Research Orchestrator (design §8) — public surface.
 *
 * This package does not export an `apply()` hook. Its Engine can be owned by
 * the DSH Scholar plugin lifecycle or launched by the CLI; either way it
 * polls only the strict Research Kernel projection and persists its own
 * SQLite Action/lease journal for crash-safe receipt reconciliation.
 *
 * @module @dsh-scholar/research-orchestrator
 */

export {
  ActionStore,
  buildActionId,
  type Action,
  type ActionLike,
  type ActionStatus,
  type ActionStoreOptions,
} from './actions.js'
export {
  Engine,
  KernelApiError,
  decideFullAutoPlans,
  planFullAutoProjection,
  FULL_AUTO_GATE_ALLOWLIST,
  FULL_AUTO_ACTION_EXECUTOR_ALLOWLIST,
  type EngineOptions,
  type EngineRuntimeStatus,
  type FullAutoPlan,
  type KernelProjection,
  type ParkCode,
  type ParkReason,
  type PollResult,
  type ProjectPollDetail,
} from './engine.js'
