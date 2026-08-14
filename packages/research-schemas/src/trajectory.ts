/**
 * Trajectory & Subagent Topology schemas (docs/trajectory-subagents.md,
 * authoritative contract).
 *
 * This module is the wire contract of the STANDALONE SAFE projection layer:
 *
 * - `TrajectoryEntry` / `TrajectoryPage` / `TrajectoryLanes` — a read-only
 *   projection of the Kernel Outbox (`events` table). Every entry is a
 *   REDACTED, allowlisted summary (raw payloads, tokens, secrets and
 *   absolute host paths never leave the kernel); `event_seq` is the outbox's
 *   per-aggregate monotonic sequence and `(event_seq, event_id)` is the
 *   stable keyset cursor (project-bucket and aggregate-less bucket seqs may
 *   collide numerically, so the event_id tiebreaker is part of the contract).
 *   `lane` splits Research (authoritative business events) from Session
 *   (observational session/subagent events) per trajectory-subagents.md §1.
 * - `ChildLink` / `TopologyNode` / `TopologyChildren` / `ChildDetail` —
 *   the subagent topology surface (trajectory-subagents.md §3): exact
 *   direct children only, opaque deep-linkable ids, breadcrumb to the root,
 *   cycle-safe and orphan fail-soft.
 * - `ChildHistoryEntry` / `ChildHistoryPage` — append-only per-child history
 *   (started/state/followup), never activates the child.
 * - `FollowupReceipt` — one-shot READ-ONLY followup acceptance: the
 *   standalone kernel records the message and returns `message_id` WITHOUT
 *   executing it or changing child state (trajectory-subagents.md §3:
 *   "接收只返回 message_id，不冒充已执行").
 *
 * Contract fields this round's kernel layer does NOT produce yet (token
 * four-bucket usage, cost, permissions/retention detail, raw detail
 * preview/spill) are marked 服务端已覆盖(投影基础)/DSH session 集成与 UI 后续
 * in hardening-v0.2-status.md — they require the DSH session adapter and the
 * browser layer.
 * @module @dsh-scholar/research-schemas/trajectory
 */

import { z } from 'zod'

/** trajectory-subagents.md §1: authoritative business vs observational session. */
export const TrajectoryLane = z.enum(['research', 'session'])
export type TrajectoryLane = z.infer<typeof TrajectoryLane>

/** trajectory-subagents.md §2 TrajectoryNodeStatus (subset derivable from
 * the outbox payload without guessing; unknown values stay 'unknown'). */
export const TrajectoryNodeStatus = z.enum([
  'queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled',
  'expired', 'redacted', 'unknown',
])
export type TrajectoryNodeStatus = z.infer<typeof TrajectoryNodeStatus>

/** One projected, redacted trajectory entry (trajectory-subagents.md §4
 * envelope, projected to the safe summary view). `entry_id` = outbox
 * `event_id` (idempotent); `project_id` doubles as the standalone
 * `trajectory_id`. The RAW payload is never exposed — `summary` is the
 * allowlisted, truncated, redacted projection. */
export const TrajectoryEntry = z.object({
  entry_id: z.string().min(1),
  event_seq: z.number().int().nonnegative(),
  event_version: z.number().int().nonnegative().default(1),
  /** standalone trajectory_id (trajectory-subagents.md §4). */
  project_id: z.string().min(1),
  aggregate_type: z.string().nullable().default(null),
  aggregate_id: z.string().nullable().default(null),
  /** envelope type (KernelEventKind or future session types). */
  kind: z.string().min(1),
  lane: TrajectoryLane,
  source: z.string().default('kernel-outbox'),
  occurred_at: z.string(),
  session_id: z.string().nullable().default(null),
  /** redacted allowlist summary — never the raw payload. */
  summary: z.string(),
  /** derivable node status without guessing; null when unknown. */
  status: TrajectoryNodeStatus.nullable().default(null),
})
export type TrajectoryEntry = z.infer<typeof TrajectoryEntry>

/** Keyset-paginated trajectory page (after_seq + after_event_id cursor;
 * limit capped by the server, default 200 / max 500). */
export const TrajectoryPage = z.object({
  project_id: z.string().min(1),
  entries: z.array(TrajectoryEntry),
  /** pass as `after_seq` on the next call; null = no more pages. */
  next_after_seq: z.number().int().nonnegative().nullable(),
  /** tiebreaker cursor — required when next_after_seq is non-null. */
  next_after_event_id: z.string().nullable(),
  has_more: z.boolean(),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  lane: TrajectoryLane.nullable().default(null),
})
export type TrajectoryPage = z.infer<typeof TrajectoryPage>

/** Research vs Session lanes for one project (trajectory-subagents.md §1/§6:
 * both lanes always returned with their OWN cursors — the UI marks Research
 * authoritative and Session observational; continuation is per-lane via
 * GET trajectories with `lane=` + that lane's cursor). */
export const TrajectoryLanes = z.object({
  project_id: z.string().min(1),
  research: TrajectoryPage,
  session: TrajectoryPage,
})
export type TrajectoryLanes = z.infer<typeof TrajectoryLanes>

// ── subagent topology (trajectory-subagents.md §3) ─────────────────────────

/** Child continuation mode; one-shot/diagnostic/parent-offline = read-only. */
export const ChildMode = z.enum(['one-shot', 'continuable', 'read-only'])
export type ChildMode = z.infer<typeof ChildMode>

/** Subagent activity state (trajectory-subagents.md §3 running/inactive/
 * diagnostic; succeeded/failed/redacted/unknown keep the projection honest). */
export const ChildState = z.enum([
  'running', 'inactive', 'diagnostic', 'succeeded', 'failed', 'cancelled', 'redacted', 'unknown',
])
export type ChildState = z.infer<typeof ChildState>

/** Durable child link row — the standalone topology storage (child_links
 * table, migration 0013). `child_id` is the opaque subagent session id
 * (deep-linkable, never a token/prompt/host path). */
export const ChildLink = z.object({
  child_id: z.string().min(1),
  project_id: z.string().min(1),
  /** exact parent agent session id; null = root (top-level child). */
  parent_id: z.string().nullable().default(null),
  label: z.string().nullable().default(null),
  /** redacted/truncated summary (allowlist — never raw tool output). */
  summary: z.string().default(''),
  kind: z.enum(['subagent', 'task']).default('subagent'),
  mode: ChildMode.default('one-shot'),
  state: ChildState.default('running'),
  /** role ACL the child runs under (research_panel role registry). */
  role: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
  ended_at: z.string().nullable().default(null),
})
export type ChildLink = z.infer<typeof ChildLink>

/** One topology node as served to the browser (direct children only). */
export const TopologyNode = z.object({
  child_id: z.string().min(1),
  project_id: z.string().min(1),
  parent_id: z.string().nullable().default(null),
  label: z.string().nullable().default(null),
  summary: z.string().default(''),
  kind: z.enum(['subagent', 'task']).default('subagent'),
  mode: ChildMode.default('one-shot'),
  state: ChildState.default('running'),
  role: z.string().nullable().default(null),
  started_at: z.string(),
  ended_at: z.string().nullable().default(null),
  has_children: z.boolean(),
  children_count: z.number().int().nonnegative(),
  /** stable projection-local ordinal (rowid) used as the page cursor. */
  seq: z.number().int().nonnegative(),
  refs: z.array(z.object({ kind: z.string(), id: z.string() })).default([]),
})
export type TopologyNode = z.infer<typeof TopologyNode>

/** Direct children of one parent (or roots when parent_id is null). */
export const TopologyChildren = z.object({
  project_id: z.string().min(1),
  parent_id: z.string().nullable(),
  items: z.array(TopologyNode),
  total: z.number().int().nonnegative(),
  next_after_seq: z.number().int().nonnegative().nullable(),
  has_more: z.boolean(),
})
export type TopologyChildren = z.infer<typeof TopologyChildren>

/** Exact-parent + breadcrumb for one child (trajectory-subagents.md §3
 * "点击或 Enter 进入 child 详情，顶部 breadcrumb 可逐级返回 parent"). */
export const ChildDetail = z.object({
  child_id: z.string().min(1),
  project_id: z.string().min(1),
  node: TopologyNode,
  /** exact parent node; null for roots and orphan fail-soft. */
  parent: TopologyNode.nullable().default(null),
  /** root → parent path (self excluded); cycle-safe, capped depth. */
  breadcrumb: z.array(TopologyNode).default([]),
})
export type ChildDetail = z.infer<typeof ChildDetail>

/** Append-only per-child history row (started / state / followup). */
export const ChildHistoryEntry = z.object({
  seq: z.number().int().nonnegative(),
  event_id: z.string().min(1),
  child_id: z.string().min(1),
  type: z.string().min(1),
  occurred_at: z.string(),
  /** redacted allowlist summary of the event payload. */
  summary: z.string().default(''),
})
export type ChildHistoryEntry = z.infer<typeof ChildHistoryEntry>

export const ChildHistoryPage = z.object({
  child_id: z.string().min(1),
  project_id: z.string().min(1),
  items: z.array(ChildHistoryEntry),
  next_after_seq: z.number().int().nonnegative().nullable(),
  has_more: z.boolean(),
  total: z.number().int().nonnegative(),
})
export type ChildHistoryPage = z.infer<typeof ChildHistoryPage>

/** One-shot READ-ONLY followup acceptance (trajectory-subagents.md §3/§7
 * POST followups): the standalone kernel records the message and returns
 * `message_id` WITHOUT executing it; child state is never touched. */
export const FollowupReceipt = z.object({
  message_id: z.string().min(1),
  child_id: z.string().min(1),
  project_id: z.string().min(1),
  accepted: z.boolean(),
  read_only: z.boolean(),
  state_unchanged: z.boolean(),
  note: z.string().default(''),
})
export type FollowupReceipt = z.infer<typeof FollowupReceipt>

/** Registration payload for a spawned subagent (plugin research_panel →
 * kernel child_links, migration 0013). */
export const ChildLinkInput = z.object({
  project_id: z.string().min(1),
  child_id: z.string().min(1),
  parent_id: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  summary: z.string().max(2000).optional(),
  kind: z.enum(['subagent', 'task']).optional(),
  mode: ChildMode.optional(),
  role: z.string().nullable().optional(),
  state: ChildState.optional(),
})
export type ChildLinkInput = z.infer<typeof ChildLinkInput>
