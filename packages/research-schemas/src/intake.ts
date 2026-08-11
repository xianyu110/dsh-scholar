/**
 * Research Onboarding (ONBOARD-01) — Intake session schemas
 * (research-onboarding.md, authoritative contract; api-contracts.md §16).
 *
 * The Intake pipeline lets a user safely bring EXISTING research material
 * (papers, code, data, logs, results) into the platform from ANY stage,
 * instead of fabricating a DRAFT-to-now history:
 *
 *   begin → stage → scan → needs_input ↔ grilling → proposal_ready
 *         → awaiting_human → accepting → accepted
 *   any non-accepted state may also go to rejected | expired | failed
 *
 * Pre-accept zero authority (research-onboarding.md §2.1): before `accept`
 * only Intake tables and the isolated staging CAS may be written — never
 * Project/Gate/ProjectArtifact/Workspace/Job/Run/TerminalLog/Evidence/Claim.
 * Only a Human PI Principal may accept; the Agent surface stops at propose.
 *
 * Security invariants encoded in the schemas:
 * - `IntakeObservation.trust` is pinned to `observed_unverified` — imported
 *   observations never become verified Evidence or supported Claims;
 * - `GrillAnswer` provenance is `human_assertion` (never upgraded);
 * - `PhaseProposal.observed_phase` is metadata only; the kernel's
 *   `safe_project_status` is derived from the REAL state machine (a fresh
 *   project is DRAFT and stays DRAFT — no phase claims auto-approve gates);
 * - `AdoptionReceipt` pins proposal + target project revisions so stale
 *   accepts fail with 409, and replays with the same Idempotency-Key +
 *   request hash return the SAME receipt.
 * @module @dsh-scholar/research-schemas
 */

import { z } from 'zod'
import { NextAction } from './next-action.js'

/**
 * Intake session status machine (research-onboarding.md §3).
 * `accepting`/`failed` are reserved for the adoption transaction surface;
 * durable states are the rest.
 */
export const IntakeStatus = z.enum([
  'draft',
  'uploading',
  'scanning',
  'needs_input',
  'grilling',
  'proposal_ready',
  'awaiting_human',
  'accepting',
  'accepted',
  'rejected',
  'expired',
  'failed',
])
export type IntakeStatus = z.infer<typeof IntakeStatus>

/** Statuses in which an intake is still recoverable/continuable. */
export const INTAKE_ACTIVE_STATUSES: readonly IntakeStatus[] = [
  'draft', 'uploading', 'scanning', 'needs_input', 'grilling',
  'proposal_ready', 'awaiting_human',
]

/**
 * Claimed completion stage of the imported material (research-onboarding.md
 * §6). `observed_phase` is PROPOSAL METADATA — it never directly advances a
 * project; the kernel maps it to a safe status + required gates.
 */
export const ObservedPhase = z.enum([
  'brief', 'survey', 'idea', 'baseline', 'contract',
  'experiment', 'evidence', 'writing', 'review', 'release',
])
export type ObservedPhase = z.infer<typeof ObservedPhase>

/** GOV-01 pattern: durable authenticated human identity for intake decisions. */
export const HumanPrincipal = z.object({
  principal_id: z.string().min(1),
  tenant_id: z.string().optional(),
  auth_method: z.string().optional(),
  session_id: z.string().nullable().optional(),
})
export type HumanPrincipal = z.infer<typeof HumanPrincipal>

/** One file registered into an intake session (quarantined until accepted). */
export const IntakeArtifact = z.object({
  /** Intake-scoped artifact id (stable: `sha256:<hex>` of the staged bytes). */
  artifact_id: z.string().min(1),
  intake_id: z.string().min(1),
  /** Plain basename (validateUploadFileName contract — no path segments). */
  file_name: z.string().min(1),
  /** RFC 2046 media type (client hint; the scan records magic independently). */
  media_type: z.string().default('application/octet-stream'),
  size_bytes: z.number().int().nonnegative(),
  /** Server-computed sha256 of the staged bytes (never a client claim). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * Quarantine state (research-onboarding.md §4): `staged` (bytes written,
   * not yet scanned) → `scanning` → `clean` | `quarantined` | `rejected`.
   * Only `clean` artifacts may be adopted; `quarantined` needs human
   * resolution (delete/replace), `rejected` is static-deny (executable
   * content) and never adoptable.
   */
  quarantine: z.enum(['staged', 'scanning', 'clean', 'quarantined', 'rejected']),
  /** Static-scan verdict details: {scanner, av_available, extension, magic, verdict, reason, warnings[]}. */
  scan_result: z.record(z.unknown()).default({}),
  created_at: z.string(),
})
export type IntakeArtifact = z.infer<typeof IntakeArtifact>

/**
 * A deterministic scan/parse observation (research-onboarding.md §3).
 * `trust` is FIXED to `observed_unverified`: an intake observation can never
 * become verified Evidence, a supported Claim, or a Gate Decision input.
 * Imported run logs yield detector `imported_run` observations — never
 * TerminalLog rows.
 */
export const IntakeObservation = z.object({
  observation_id: z.string().min(1),
  intake_id: z.string().min(1),
  /** Source artifact id (sha256:<hex>); '' for session-level observations. */
  artifact_id: z.string().default(''),
  /** Locator inside the source (file name / entry / line — original text). */
  locator: z.string().default(''),
  /** Detector id: e.g. `extension`, `magic`, `secret_static`, `imported_run`. */
  detector: z.string().min(1),
  detector_version: z.string().default('1'),
  value: z.string().min(1),
  warnings: z.array(z.string()).default([]),
  /** Pinned: intake output is never verified provenance. */
  trust: z.literal('observed_unverified').default('observed_unverified'),
  created_at: z.string(),
})
export type IntakeObservation = z.infer<typeof IntakeObservation>

/**
 * One deterministic Grill Me question (research-onboarding.md §5). Questions
 * come from a VERSIONED taxonomy — the LLM may only translate/rephrase the
 * tone, never invent questions or judge completion. `label_key` is the i18n
 * key (zh/en parity lives in the UI dictionaries); `prompt` is the stable
 * English default the kernel returns (api-contracts.md §15).
 */
export const GrillQuestion = z.object({
  /** Stable machine code (e.g. `owner_scope_license`) — never changes. */
  question_code: z.string().min(1),
  /** i18n key for the UI dictionaries (zh/en parity). */
  label_key: z.string().min(1),
  /** Stable English prompt (UI translates via label_key). */
  prompt: z.string().min(1),
  /** Why this question is asked (deterministic). */
  reason: z.string().default(''),
  required: z.boolean().default(false),
  /** Codes that must be answered first (currently unused — reserved). */
  depends_on: z.array(z.string()).default([]),
  /** Taxonomy revision the question was generated at. */
  question_revision: z.number().int().positive(),
  question_type: z.enum(['text', 'choice', 'boolean']).default('text'),
})
export type GrillQuestion = z.infer<typeof GrillQuestion>

/** Wire input for ONE answer (research-onboarding.md §5: human assertion). */
export const GrillAnswerInput = z.object({
  question_code: z.string().min(1),
  /** May be 'unknown' — that keeps the gap and lowers proposal confidence. */
  answer: z.string().min(1),
  /** Must match the current question_revision (409 question_revision_conflict). */
  question_revision: z.number().int().positive(),
})
export type GrillAnswerInput = z.infer<typeof GrillAnswerInput>

/** A question plus its recorded human-assertion answer (projection). */
export const GrillAnswerView = GrillQuestion.extend({
  answer: z.string().nullable().default(null),
  answered_at: z.string().nullable().default(null),
  answered_by: z.string().nullable().default(null),
  /** 'human_assertion' when answered — user statements never upgrade. */
  provenance: z.enum(['unanswered', 'human_assertion']).default('unanswered'),
})
export type GrillAnswerView = z.infer<typeof GrillAnswerView>

/**
 * Explicit mapping of one source artifact/entry to an adopted object (§6.1).
 * The proposal's `suggested_mappings` carry the artifact-level mapping;
 * the AdoptionReceipt's `import_mappings` are the MATERIALIZATION report of
 * the same imports — every source file maps to a target (project artifact,
 * TeX document, or code workspace path) with status `materialized` | `gap`
 * and a reason. `status='gap'` NEVER rolls back the adoption: adopt is the
 * authoritative import, workspace materialization is best-effort
 * (research-onboarding.md §6.1).
 */
export const ImportMapping = z.object({
  /** Source intake artifact id (sha256:<hex>). */
  source_artifact_id: z.string().min(1),
  /** Source file name (direct artifact) or archive entry path (unpacked view). */
  source_file_name: z.string().default(''),
  /** Adopted target kind: ArtifactKind union, or 'tex_document'/'code_workspace'. */
  target_kind: z.string().min(1),
  /** Target: workspace path (`code/<path>`) or TeX document_id; '' for artifact-level mappings. */
  target: z.string().default(''),
  /** Materialization outcome: 'materialized' or 'gap' (best-effort failure). */
  status: z.enum(['materialized', 'gap']).default('materialized'),
  /** Stable reason for the status (e.g. `tex_path_conflict`, `entry_type_not_materialized`). */
  reason: z.string().default(''),
  /** Extra provenance note (never replaces immutable provenance fields). */
  note: z.string().default(''),
})
export type ImportMapping = z.infer<typeof ImportMapping>

/**
 * Deterministic phase proposal (research-onboarding.md §6). `observed_phase`
 * is metadata; `safe_project_status` is derived from the KERNEL state
 * machine + Gate transactions only (a fresh DRAFT project stays DRAFT — the
 * proposal's required gates are created PENDING at adoption, never decided).
 */
export const PhaseProposal = z.object({
  proposal_id: z.string().min(1),
  intake_id: z.string().min(1),
  /** Bumped on every propose; accepts pin this (409 proposal_stale). */
  revision: z.number().int().positive(),
  observed_phase: ObservedPhase,
  /** Kernel-state-machine-derived safe status (DRAFT for fresh projects). */
  safe_project_status: z.string().min(1),
  /** Deterministic 0..1 confidence (answers + scan verdicts, rounded). */
  confidence: z.number().min(0).max(1),
  /** Plan summary (deterministic per phase). */
  plan: z.string().default(''),
  /** Deterministic risk list. */
  risks: z.array(z.string()).default([]),
  /** Pre-accept checklist the human sees before adopting. */
  pre_accept_checklist: z.array(z.string()).default([]),
  /** Unresolved gaps: unanswered optional questions + scan warnings. */
  unresolved_gaps: z.array(z.string()).default([]),
  /** Explicit source→adopted mappings (research-onboarding.md §6.1). */
  suggested_mappings: z.array(ImportMapping).default([]),
  /** Gate types to create PENDING at adoption (never decided). */
  required_gates: z.array(z.string()).default([]),
  /** Structured post-adoption actions (GUIDE-01 NextAction reuse). */
  next_actions: z.array(NextAction).default([]),
  created_at: z.string(),
})
export type PhaseProposal = z.infer<typeof PhaseProposal>

/**
 * Adoption receipt (research-onboarding.md §3/§7): written ATOMICALLY with
 * the import in one Kernel transaction. Pins the proposal + target project
 * revisions; the same Idempotency-Key + request hash replays the same
 * receipt, a different hash is 409 idempotency_conflict.
 */
export const AdoptionReceipt = z.object({
  adoption_id: z.string().min(1),
  intake_id: z.string().min(1),
  project_id: z.string().min(1),
  proposal_revision: z.number().int().positive(),
  target_project_revision: z.number().int().nonnegative(),
  /** Artifact ids (sha256:...) adopted into the project. */
  created_object_refs: z.array(z.string()).default([]),
  /** Pending gate ids created at adoption (never decided by the intake). */
  pending_gate_refs: z.array(z.string()).default([]),
  /** Draft evidence ids created from importable metrics/results. */
  draft_evidence_refs: z.array(z.string()).default([]),
  /**
   * Materialization report (research-onboarding.md §6.1): one mapping per
   * adopted artifact + per unpacked archive entry (TeX/code). Written AFTER
   * the adoption transaction commits — materialization is best-effort and
   * `status='gap'` entries never fail the adoption.
   */
  import_mappings: z.array(ImportMapping).default([]),
  /** CodeSnapshot ids generated from the materialized code workspace (optional). */
  code_snapshot_refs: z.array(z.string()).default([]),
  idempotency_key: z.string().nullable().default(null),
  request_hash: z.string().default(''),
  adopted_by: HumanPrincipal,
  adopted_at: z.string(),
})
export type AdoptionReceipt = z.infer<typeof AdoptionReceipt>

/** Intake session head (research-onboarding.md §3). */
export const IntakeSession = z.object({
  intake_id: z.string().min(1),
  /** Target project (optional at begin; the HTTP surface scopes by project). */
  project_id: z.string().nullable().default(null),
  /** Owner Principal (agent-initiated intakes record 'agent'). */
  owner: HumanPrincipal,
  status: IntakeStatus,
  revision: z.number().int().nonnegative().default(1),
  /** User-facing source label (e.g. "uploaded-paper", "repro-package"). */
  source_label: z.string().min(1),
  /** Claimed target phase driving the question taxonomy. */
  target_phase: ObservedPhase.nullable().default(null),
  expires_at: z.string(),
  scan_summary: z.record(z.unknown()).default({}),
  created_at: z.string(),
  updated_at: z.string(),
  /** Audit trail: quarantine/expiry/purge/adopt/reject entries. */
  audit: z.array(z.object({
    at: z.string(),
    action: z.string(),
    detail: z.string().default(''),
  })).default([]),
})
export type IntakeSession = z.infer<typeof IntakeSession>

/** Full resumable intake state (GET / resume — survives kernel restarts). */
export const IntakeProjection = z.object({
  session: IntakeSession,
  artifacts: z.array(IntakeArtifact).default([]),
  observations: z.array(IntakeObservation).default([]),
  questions: z.array(GrillAnswerView).default([]),
  proposal: PhaseProposal.nullable().default(null),
  receipt: AdoptionReceipt.nullable().default(null),
})
export type IntakeProjection = z.infer<typeof IntakeProjection>

/** Stable intake error codes (research-onboarding.md §9 "至少包含"). */
export const INTAKE_ERROR_CODES = [
  'intake_not_found',
  'intake_state_conflict',
  'intake_expired',
  'artifact_quarantined',
  'question_required',
  'proposal_stale',
  'acceptance_required',
  'phase_unadoptable',
  'project_revision_conflict',
  'cross_project_reference',
  'question_revision_conflict',
  'unknown_question',
  'intake_artifact_not_found',
] as const
export type IntakeErrorCode = typeof INTAKE_ERROR_CODES[number]
