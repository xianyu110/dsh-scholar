/**
 * Durable Research Orchestrator (design §8) — public surface.
 *
 * This is NOT a DSH plugin and does not export an `apply()` hook: it is a
 * standalone service that polls the Research Kernel projection API and
 * advances projects toward the next Human Gate (§8.3), with its own durable
 * SQLite action store (§8.2) and crash recovery (§8.5).
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
  decideActions,
  planForStatus,
  type ActionPlan,
  type ActionPlanKind,
  type EngineOptions,
  type KernelProjection,
  type PollResult,
  type ProjectPollDetail,
  type ProjectionGate,
  type ProjectStatus,
} from './engine.js'
