/**
 * DSH Research OS — core research object schemas (design document §6).
 * Zod schemas are the single source of truth for the Kernel, the plugin tools
 * and the DSH-facing validation boundary.
 * @module @dsh-scholar/research-schemas
 */

import { z } from 'zod'

/** Research project lifecycle states (design §5 state machine). */
export const ProjectStatus = z.enum([
  'DRAFT',
  'SCOPED',
  'SURVEYING',
  'IDEATING',
  'IDEA_APPROVED',
  'BASELINE_REPRO',
  'CONTRACT_APPROVED',
  'EXPERIMENTING',
  'EVIDENCE_READY',
  'WRITING',
  'REVIEWING',
  'RELEASE_READY',
  'ARCHIVED',
  'RELEASED',
  'FAILED',
  'STOPPED',
  'BLOCKED_GATE',
])
export type ProjectStatus = z.infer<typeof ProjectStatus>

/** Automation mode: gate-only keeps human gates; full-auto is for low-risk sandboxes only. */
export const ProjectMode = z.enum(['gate-only', 'full-auto'])
export type ProjectMode = z.infer<typeof ProjectMode>

/** Kernel event kinds persisted in the append-only outbox (design §4.2). */
export const KernelEventKind = z.enum([
  'project.created',
  'project.transitioned',
  'gate.created',
  'gate.decided',
  'artifact.registered',
  'idea.created',
  'idea.updated',
  'contract.registered',
  'contract.approved',
  'job.submitted',
  'job.updated',
  'claim.updated',
  'corpus.snapshotted',
  'manuscript.built',
  'session.linked',
  'budget.updated',
  'policy.violation',
])
export type KernelEventKind = z.infer<typeof KernelEventKind>

/** Budget & policy constraints from the project manifest (design §6.2). */
export const BudgetConstraints = z.object({
  datasets: z.enum(['public-only', 'private-allowed']).default('public-only'),
  external_model_upload: z.enum(['prohibited-for-private-data', 'allowed']).default('prohibited-for-private-data'),
  max_model_cost_usd: z.number().nonnegative().default(250),
  max_gpu_hours: z.number().nonnegative().default(120),
  max_parallel_jobs: z.number().int().nonnegative().default(4),
  deadline: z.string().optional(),
})
export type BudgetConstraints = z.infer<typeof BudgetConstraints>

/** Execution profile of a project (design §6.2). */
export const ExecutionConfig = z.object({
  runner_profile: z.enum(['local-docker-gpu', 'local-docker-cpu', 'isolated-subprocess']).default('local-docker-cpu'),
  network_policy: z.enum(['allowlist', 'none']).default('allowlist'),
  artifact_store: z.enum(['local-cas']).default('local-cas'),
})
export type ExecutionConfig = z.infer<typeof ExecutionConfig>

/** Integrity gates a project must honour (design §6.2). */
export const IntegrityConfig = z.object({
  require_baseline_reproduction: z.boolean().default(true),
  require_experiment_contract: z.boolean().default(true),
  require_claim_evidence_links: z.boolean().default(true),
  require_clean_room_rerun: z.boolean().default(false),
  allow_automatic_public_release: z.boolean().default(false),
})
export type IntegrityConfig = z.infer<typeof IntegrityConfig>

/** The research brief: problem, scope, metrics, resources, risks, outputs. */
export const ResearchBrief = z.object({
  problem: z.string().min(1),
  scope: z.string().min(1),
  questions: z.array(z.string()).default([]),
  primary_metrics: z.array(z.string()).default([]),
  resources: z.string().default(''),
  risks: z.array(z.string()).default([]),
  target_outputs: z.array(z.string()).default(['conference-paper']),
  target_venue: z.string().nullable().default(null),
  baseline_repo: z.string().nullable().default(null),
  domain: z.string().default('machine-learning'),
})
export type ResearchBrief = z.infer<typeof ResearchBrief>

/** Research project manifest — the authoritative per-project state (design §6.2). */
export const ResearchProject = z.object({
  project_id: z.string().regex(/^rsp_[a-z0-9_]+$/),
  name: z.string().min(1),
  workspace: z.string().min(1),
  mode: ProjectMode.default('gate-only'),
  status: ProjectStatus.default('DRAFT'),
  revision: z.number().int().nonnegative().default(0),
  brief: ResearchBrief,
  constraints: BudgetConstraints.default({}),
  execution: ExecutionConfig.default({}),
  integrity: IntegrityConfig.default({}),
  session_id: z.string().nullable().default(null),
  dsh_workspace_id: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
  history: z.array(z.string()).default([]),
})
export type ResearchProject = z.infer<typeof ResearchProject>

/**
 * Allowed transitions of the project state machine (v2 §6.2).
 * Gate-controlled states (SCOPED, IDEA_APPROVED, CONTRACT_APPROVED, RELEASED)
 * are NOT reachable via generic transition() — they can only be entered by
 * the corresponding gate transaction (approveGateTransaction).
 */
export const TRANSITION_TABLE: Record<ProjectStatus, readonly ProjectStatus[]> = {
  DRAFT: ['FAILED', 'STOPPED'],
  SCOPED: ['SURVEYING', 'FAILED', 'STOPPED', 'BLOCKED_GATE'],
  SURVEYING: ['IDEATING', 'FAILED', 'STOPPED', 'BLOCKED_GATE'],
  IDEATING: ['SURVEYING', 'FAILED', 'STOPPED', 'BLOCKED_GATE'],
  IDEA_APPROVED: ['BASELINE_REPRO', 'SURVEYING', 'FAILED', 'STOPPED', 'BLOCKED_GATE'],
  BASELINE_REPRO: ['EXPERIMENTING', 'FAILED', 'STOPPED', 'BLOCKED_GATE'],
  CONTRACT_APPROVED: ['EXPERIMENTING', 'FAILED', 'STOPPED', 'BLOCKED_GATE'],
  EXPERIMENTING: ['EVIDENCE_READY', 'FAILED', 'STOPPED', 'BLOCKED_GATE'],
  EVIDENCE_READY: ['WRITING', 'EXPERIMENTING', 'FAILED', 'STOPPED', 'BLOCKED_GATE'],
  WRITING: ['REVIEWING', 'EVIDENCE_READY', 'FAILED', 'STOPPED', 'BLOCKED_GATE'],
  REVIEWING: ['WRITING', 'RELEASE_READY', 'FAILED', 'STOPPED', 'BLOCKED_GATE'],
  RELEASE_READY: ['ARCHIVED', 'FAILED', 'STOPPED', 'BLOCKED_GATE'],
  ARCHIVED: ['STOPPED'],
  RELEASED: ['STOPPED'],
  FAILED: ['STOPPED'],
  STOPPED: [],
  BLOCKED_GATE: ['SURVEYING', 'IDEATING', 'BASELINE_REPRO', 'EXPERIMENTING', 'EVIDENCE_READY', 'WRITING', 'REVIEWING', 'RELEASE_READY', 'FAILED', 'STOPPED'],
}

/** v2 §6.2: gate-controlled states that generic transition() must never reach. */
export const GATE_CONTROLLED_STATES: readonly ProjectStatus[] = ['SCOPED', 'IDEA_APPROVED', 'CONTRACT_APPROVED', 'RELEASED']
