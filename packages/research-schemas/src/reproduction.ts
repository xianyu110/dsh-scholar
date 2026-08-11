/**
 * Paper reproduction contract schemas (docs/reproduction-contracts.md —
 * normative). This module is generated FROM the contract: the spec, attempt,
 * report and comparator wire shapes below are the single authority for the
 * reproduction API, storage and verification logic.
 *
 * Contract anchors:
 * - §2.1 PaperReproductionSpec — spec_id/schema_version/project_id/owner
 *   Principal/source paper ref/source artifact/locator/reproduction_level/
 *   claims_to_reproduce/code source/data inputs/execution binding/environment
 *   lock/expected outputs/metric comparators/revision/status/created/updated.
 *   Source paper ref accepts DOI, arXiv ID or a scanned PDF Artifact; external
 *   metadata/full text is UNTRUSTED. Code must finalize as an immutable
 *   CodeSnapshot (git pins exact commit + submodule commits + license +
 *   snapshot hash; a bare repo URL/branch/tag is not executable). Data pins
 *   Artifact/hash; a recipe source (network acquisition) requires an expected
 *   hash — a clean-room that cannot satisfy it is blocked, never silently
 *   skipped.
 * - §2.3 ReproductionAttempt / ReproducibilityReport — the report is an
 *   immutable JSON+Markdown Artifact; it compares paper-declared targets
 *   FIRST and then clean-room vs original formal run SEPARATELY (two
 *   comparison groups, never merged into one tolerance).
 * - §3 metric rule: allowed = max(absolute_tolerance, abs(expected) *
 *   relative_tolerance); pass = finite(actual) && unit_match &&
 *   abs(actual - expected) <= allowed. expected=0 → relative part is 0 and
 *   only the absolute tolerance decides; NaN/Infinity, missing/duplicate
 *   metrics, unit/aggregation/direction mismatch never pass; direction is
 *   NOT a substitute for the error comparison. Tables compare on stable
 *   row/column keys; figures compare generated data hashes (visual
 *   similarity is an additional diagnostic only); manuscript level must
 *   rebuild TeX/PDF with structure/text/font/page checks and missing inputs
 *   can never be a skipped-pass.
 * @module @dsh-scholar/research-schemas
 */

import { z } from 'zod'

// ── source paper reference (contract §2.1) ────────────────────────────────

/** DOI pattern (10.<registrant>/<suffix>). */
const DOI_PATTERN = /^10\.\d{4,9}\/[^\s]+$/
/** New-style arXiv id (2401.12345[v2]) or old-style (cs.AI/9901001[v1]). */
const ARXIV_PATTERN = /^(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i
/** CAS artifact id of a scanned PDF paper artifact. */
const ARTIFACT_PATTERN = /^sha256:[0-9a-f]{64}$/i

/**
 * The paper being reproduced: exactly one of doi | arxiv_id | artifact_id
 * (a scanned PDF Artifact already registered in the project). External
 * metadata/full text fetched from these refs is UNTRUSTED by design — it is
 * never authoritative evidence, only wizard input.
 */
export const PaperRef = z.object({
  doi: z.string().regex(DOI_PATTERN, 'invalid DOI — expected 10.<registrant>/<suffix>').optional(),
  arxiv_id: z.string().regex(ARXIV_PATTERN, 'invalid arXiv id — expected 2401.12345[vN] or cs.AI/9901001[vN]').optional(),
  artifact_id: z.string().regex(ARTIFACT_PATTERN, 'paper artifact id must be a sha256:<hex> project artifact').optional(),
}).refine(
  ref => ref.doi !== undefined || ref.arxiv_id !== undefined || ref.artifact_id !== undefined,
  { message: 'paper ref requires exactly one of doi | arxiv_id | artifact_id' },
)
export type PaperRef = z.infer<typeof PaperRef>

/**
 * Parse a single user/CLI token into a PaperRef: DOI, arXiv id (with or
 * without the `arXiv:` prefix, new and old style) or a `sha256:<hex>` paper
 * artifact id. Throws on tokens that match none of the three formats — the
 * caller maps this to a stable 422 (never a silent guess).
 */
export function paperRefFromToken(token: string): PaperRef {
  const t = String(token ?? '').trim()
  if (t === '') throw new Error('paper reference is empty')
  if (DOI_PATTERN.test(t)) return { doi: t }
  if (ARXIV_PATTERN.test(t)) return { arxiv_id: t }
  if (/^arXiv:/i.test(t)) {
    const id = t.replace(/^arXiv:/i, '').trim()
    if (ARXIV_PATTERN.test(id)) return { arxiv_id: id }
    throw new Error(`invalid arXiv id '${t}'`)
  }
  if (ARTIFACT_PATTERN.test(t)) return { artifact_id: t }
  throw new Error(`invalid paper reference '${t}' — expected a DOI (10.xxxx/...), an arXiv id (2401.12345 or arXiv:2401.12345) or a scanned-PDF artifact id (sha256:<hex>)`)
}

/** Contract §2.1 — how far the reproduction goes. */
export const ReproductionLevel = z.enum([
  'baseline_official', // reproduce the paper's official primary results
  'contract_rerun',    // rerun per an approved ExperimentContract
  'clean_room',        // independent rebuild: fresh dataDir/runner, no checkout/CAS implicit deps
  'manuscript',        // also rebuild tables, figures and the PDF
  'bundle_only',       // Bundle structure/hash verification only — NOT scientific reproduction
])
export type ReproductionLevel = z.infer<typeof ReproductionLevel>

/** One claim of the paper selected for reproduction (contract §2.1). */
export const ClaimToReproduce = z.object({
  claim_ref: z.string().min(1),
  statement: z.string().default(''),
  metric_refs: z.array(z.string()).default([]),
  /** Paper locator, e.g. "Table 2 row 3" / "§5.2". */
  locator: z.string().default(''),
})
export type ClaimToReproduce = z.infer<typeof ClaimToReproduce>

// ── code source (contract §2.1: must finalize as an immutable CodeSnapshot) ─

/**
 * Git-pinned code source. A bare repo URL/branch/tag is NOT executable: the
 * spec pins the exact commit, submodule commits, license and — once
 * materialized — the snapshot hash/id of the immutable CodeSnapshot.
 */
export const GitCodeSource = z.object({
  kind: z.literal('git'),
  repo_url: z.string().min(1),
  /** Exact commit (hex, at least 7 chars; materialization requires the full
   *  object). No branch/tag here — branch/tag references are not executable. */
  commit: z.string().regex(/^[0-9a-f]{7,64}$/, 'git code source requires an exact commit (hex) — branch/tag is not executable'),
  /** submodule path → pinned commit. */
  submodule_commits: z.record(z.string().regex(/^[0-9a-f]{7,64}$/)).default({}),
  license: z.string().default(''),
  /** Filled once the source is materialized as an immutable CodeSnapshot. */
  snapshot_hash: z.string().optional(),
  code_snapshot_id: z.string().nullable().default(null),
})
export type GitCodeSource = z.infer<typeof GitCodeSource>

/** Already-materialized immutable CodeSnapshot (registry id, kernel-verified). */
export const SnapshotCodeSource = z.object({
  kind: z.literal('snapshot'),
  code_snapshot_id: z.string().min(1),
  license: z.string().default(''),
})
export type SnapshotCodeSource = z.infer<typeof SnapshotCodeSource>

export const CodeSource = z.discriminatedUnion('kind', [GitCodeSource, SnapshotCodeSource])
export type CodeSource = z.infer<typeof CodeSource>

// ── data inputs (contract §2.1) ────────────────────────────────────────────

/** Data pinned to a project Artifact + its content hash. */
export const ArtifactDataSource = z.object({
  kind: z.literal('artifact'),
  artifact_id: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  version: z.string().default(''),
  split: z.string().default(''),
  license: z.string().default(''),
  preprocess_hash: z.string().default(''),
})
export type ArtifactDataSource = z.infer<typeof ArtifactDataSource>

/**
 * No bytes yet: a network acquisition recipe with the EXPECTED hash. The
 * verifier may fetch per the recipe (network policy permitting), but the
 * result must hash-match; a clean-room that cannot satisfy the recipe is
 * BLOCKED — never silently skipped.
 */
export const RecipeDataSource = z.object({
  kind: z.literal('recipe'),
  acquisition_recipe: z.string().min(1),
  expected_sha256: z.string().regex(/^[0-9a-f]{64}$/, 'recipe data source requires an expected sha256'),
  license: z.string().default(''),
})
export type RecipeDataSource = z.infer<typeof RecipeDataSource>

export const DataSource = z.discriminatedUnion('kind', [ArtifactDataSource, RecipeDataSource])
export type DataSource = z.infer<typeof DataSource>

// ── execution binding + environment lock (contract §2.2) ───────────────────

/**
 * Execution binding: ONLY opaque ids. SSH host/port/user/private key/jump
 * host/known-hosts/mTLS material live in server-side Settings/SecretRef and
 * never enter the Project/Spec/Contract/Job/argv/Browser/Bundle.
 */
export const ExecutionBinding = z.object({
  runner_profile_id: z.string().min(1),
  target_id: z.string().min(1),
})
export type ExecutionBinding = z.infer<typeof ExecutionBinding>

/** Contract §2.2 — the frozen environment. Digest-pinned only, never mutable
 *  `latest`; Node/TeX runtime uses the repository canonical baseline. */
export const EnvironmentLock = z.object({
  /** `<image>@sha256:<64hex>` or `sha256:<64hex>` (never a mutable tag). */
  image_digest: z.string().regex(/^(?:[a-z0-9./-]+@)?sha256:[0-9a-f]{64}$/i).optional(),
  os_arch: z.string().default(''),
  runtime_lock_hash: z.string().default(''),
  cuda_gpu: z.string().default(''),
  dataset_hashes: z.array(z.string()).default([]),
  code_hashes: z.array(z.string()).default([]),
  runner_profile_id: z.string().default(''),
  runner_profile_hash: z.string().default(''),
  target_id: z.string().default(''),
  target_revision: z.string().default(''),
  target_hash: z.string().default(''),
  effective_config_hash: z.string().default(''),
  network_policy: z.enum(['none', 'allowlist']).optional(),
  resource_policy: z.string().default(''),
  tool_versions: z.record(z.string()).default({}),
  sbom_ref: z.string().default(''),
})
export type EnvironmentLock = z.infer<typeof EnvironmentLock>

// ── metric comparators (contract §3) ───────────────────────────────────────

/** Absolute + relative tolerance; the comparison uses
 *  allowed = max(absolute, abs(expected) * relative). */
export const MetricTolerance = z.object({
  absolute: z.number().nonnegative().default(0),
  relative: z.number().nonnegative().default(0),
})
export type MetricTolerance = z.infer<typeof MetricTolerance>

/**
 * One paper-declared metric target. `expected` is the paper's declared
 * value; the verifier compares the actual run value with the §3 rule.
 * `required=false` comparators never fail the report alone (missing → 
 * inconclusive), but they also never count as pass.
 */
export const MetricComparator = z.object({
  metric_id: z.string().min(1),
  name: z.string().min(1),
  unit: z.string().default(''),
  direction: z.enum(['higher_is_better', 'lower_is_better']).optional(),
  aggregation: z.string().default(''),
  expected: z.number(),
  tolerance: MetricTolerance.default({}),
  seed_policy: z.string().default(''),
  n: z.number().int().nonnegative().optional(),
  source_locator: z.string().default(''),
  required: z.boolean().default(true),
})
export type MetricComparator = z.infer<typeof MetricComparator>

// ── PaperReproductionSpec (contract §2.1) ──────────────────────────────────

export const ReproductionSpecStatus = z.enum([
  'draft',      // created by /reproduce — wizard in progress
  'confirmed',  // Human confirmed the reproduction plan/contract
  'running',    // an attempt is in flight
  'completed',  // a persisted report exists (pass/fail/inconclusive)
  'failed',     // reproduction failed (not an attempt report — spec-level)
  'blocked',    // blocked (e.g. clean-room cannot satisfy a recipe)
  'archived',
])
export type ReproductionSpecStatus = z.infer<typeof ReproductionSpecStatus>

/** Allowed spec status transitions (updateSpec only; `completed`/`blocked`
 *  are also reachable from `running` via reportAttempt). */
export const REPRODUCTION_SPEC_TRANSITIONS: Record<ReproductionSpecStatus, readonly ReproductionSpecStatus[]> = {
  draft: ['confirmed', 'failed', 'blocked', 'archived'],
  confirmed: ['failed', 'blocked', 'archived'],
  running: ['failed', 'blocked', 'archived'],
  completed: ['archived'],
  failed: ['archived'],
  blocked: ['archived'],
  archived: [],
}

export const PaperReproductionSpec = z.object({
  spec_id: z.string().regex(/^repro_[a-z0-9_]+$/),
  schema_version: z.number().int().positive().default(1),
  project_id: z.string().min(1),
  /** owner Principal (human or the DSH agent session that created it). */
  owner: z.object({
    principal_id: z.string().min(1),
    tenant_id: z.string().default(''),
    auth_method: z.string().default(''),
  }),
  paper_ref: PaperRef,
  /** e.g. "Table 2 / §5.2" or the PDF page; free locator, not authoritative. */
  source_locator: z.string().default(''),
  /** The scanned-PDF paper Artifact when paper_ref.artifact_id is set. */
  source_artifact_id: z.string().nullable().default(null),
  reproduction_level: ReproductionLevel.default('baseline_official'),
  claims_to_reproduce: z.array(ClaimToReproduce).min(1, 'claims_to_reproduce must not be empty'),
  code_source: CodeSource.nullable().default(null),
  data_inputs: z.array(DataSource).default([]),
  execution_binding: ExecutionBinding.nullable().default(null),
  environment_lock: EnvironmentLock.default({}),
  expected_outputs: z.array(z.string()).default([]),
  metric_comparators: z.array(MetricComparator).default([]),
  revision: z.number().int().nonnegative().default(1),
  status: ReproductionSpecStatus.default('draft'),
  created_at: z.string(),
  updated_at: z.string(),
})
export type PaperReproductionSpec = z.infer<typeof PaperReproductionSpec>

// ── ReproductionAttempt (contract §2.3) ────────────────────────────────────

export const ReproductionAttemptStatus = z.enum([
  'queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled', 'reported',
])
export type ReproductionAttemptStatus = z.infer<typeof ReproductionAttemptStatus>

/** One execution attempt. Pins the spec revision, generation (fencing),
 *  lease token hash (never plaintext at rest), code snapshot, data/image/
 *  environment pins and the submitter Principal. A new attempt keeps the
 *  original binding and records `reason` (contract §2.2). */
export const ReproductionAttempt = z.object({
  attempt_id: z.string().regex(/^repa_[a-z0-9_]+$/),
  spec_id: z.string().min(1),
  project_id: z.string().min(1),
  generation: z.number().int().positive().default(1),
  status: ReproductionAttemptStatus.default('queued'),
  /** Spec revision pinned at start — later spec edits never change this. */
  spec_revision: z.number().int().nonnegative(),
  approved_contract_version: z.number().int().nonnegative().nullable().default(null),
  job_id: z.string().nullable().default(null),
  run_id: z.string().nullable().default(null),
  code_snapshot_id: z.string().nullable().default(null),
  data_pins: z.array(z.string()).default([]),
  environment_pins: z.record(z.string()).default({}),
  run_manifest_refs: z.array(z.string()).default([]),
  submitter_principal: z.string().default(''),
  /** Why this attempt exists (e.g. "explicit new attempt on target B"). */
  reason: z.string().default(''),
  created_at: z.string(),
  updated_at: z.string(),
})
export type ReproductionAttempt = z.infer<typeof ReproductionAttempt>

// ── ReproducibilityReport (contract §2.3 / §3) ─────────────────────────────

export const ReportStatus = z.enum(['pass', 'fail', 'blocked', 'inconclusive'])
export type ReportStatus = z.infer<typeof ReportStatus>

export const ReportCheckStatus = z.enum(['pass', 'fail', 'inconclusive'])
export type ReportCheckStatus = z.infer<typeof ReportCheckStatus>

/** One named check of the report. `required` checks decide the status:
 *  any required fail → fail; no fail but some required inconclusive →
 *  inconclusive; all required pass → pass. */
export const ReportCheck = z.object({
  check_id: z.string().min(1),
  kind: z.enum(['metric', 'table', 'figure', 'pdf', 'tex', 'preflight', 'runtime', 'environment', 'outputs', 'manifest', 'paper']),
  name: z.string().min(1),
  status: ReportCheckStatus,
  required: z.boolean().default(true),
  detail: z.string().default(''),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  allowed: z.unknown().optional(),
})
export type ReportCheck = z.infer<typeof ReportCheck>

/** §3 per-metric comparison result (paper vs actual, or clean-room vs
 *  formal run). */
export const MetricComparison = z.object({
  metric_id: z.string().min(1),
  name: z.string().min(1),
  expected: z.number(),
  actual: z.number().nullable(),
  unit_match: z.boolean(),
  direction_match: z.boolean().nullable().default(null),
  aggregation_match: z.boolean().nullable().default(null),
  /** allowed = max(absolute, abs(expected)*relative) — the §3 rule. */
  allowed: z.number().nullable().default(null),
  deviation: z.number().nullable().default(null),
  status: ReportCheckStatus,
  detail: z.string().default(''),
})
export type MetricComparison = z.infer<typeof MetricComparison>

/** Table comparison on stable row/column keys (contract §3). */
export const TableComparison = z.object({
  table_id: z.string().min(1),
  status: ReportCheckStatus,
  missing_rows: z.array(z.string()).default([]),
  extra_rows: z.array(z.string()).default([]),
  missing_columns: z.array(z.string()).default([]),
  cell_mismatches: z.array(z.object({ row: z.string(), column: z.string(), expected: z.unknown(), actual: z.unknown() })).default([]),
  detail: z.string().default(''),
})
export type TableComparison = z.infer<typeof TableComparison>

/** Figure comparison: generated-data hash is authoritative; visual
 *  similarity is an additional DIAGNOSTIC only (never a pass/fail alone). */
export const FigureComparison = z.object({
  figure_id: z.string().min(1),
  status: ReportCheckStatus,
  data_hash_expected: z.string().nullable().default(null),
  data_hash_actual: z.string().nullable().default(null),
  visual_similarity: z.number().min(0).max(1).nullable().default(null),
  detail: z.string().default(''),
})
export type FigureComparison = z.infer<typeof FigureComparison>

/** Manuscript level: TeX/PDF rebuilt with structure/text/font/page-count
 *  checks. Missing inputs can NEVER be a skipped-pass (contract §3). */
export const ManuscriptComparison = z.object({
  status: ReportCheckStatus,
  tex_rebuilt: z.boolean().default(false),
  pdf_rebuilt: z.boolean().default(false),
  structure_ok: z.boolean().nullable().default(null),
  text_ok: z.boolean().nullable().default(null),
  fonts_ok: z.boolean().nullable().default(null),
  page_count_ok: z.boolean().nullable().default(null),
  inputs_missing: z.array(z.string()).default([]),
  detail: z.string().default(''),
})
export type ManuscriptComparison = z.infer<typeof ManuscriptComparison>

export const Preflight = z.object({
  ok: z.boolean().default(false),
  checks: z.array(z.string()).default([]),
  blocked: z.boolean().default(false),
  reason: z.string().default(''),
})
export type Preflight = z.infer<typeof Preflight>

export const RuntimeVerified = z.object({
  exit_code: z.number().int().nullable().default(null),
  signal: z.string().nullable().default(null),
  /** exit 0 only means execution succeeded — never report pass by itself. */
  execution_succeeded: z.boolean().default(true),
  timed_out: z.boolean().default(false),
  cancelled: z.boolean().default(false),
  run_manifest_signed: z.boolean().default(false),
  lease_fenced: z.boolean().default(false),
})
export type RuntimeVerified = z.infer<typeof RuntimeVerified>

/** One comparison GROUP. The report carries TWO groups (contract §2.3):
 *  `paper_comparisons` = paper-declared targets vs this reproduction, and
 *  `run_comparisons` = clean-room run vs the original formal run. The two
 *  groups use their own tolerances and are never merged. */
export const ComparisonGroup = z.object({
  metrics: z.array(MetricComparison).default([]),
  tables: z.array(TableComparison).default([]),
  figures: z.array(FigureComparison).default([]),
  manuscript: ManuscriptComparison.optional(),
  checks: z.array(ReportCheck).default([]),
})
export type ComparisonGroup = z.infer<typeof ComparisonGroup>

/**
 * The immutable ReproducibilityReport (contract §2.3). Stored as JSON in the
 * CAS; the database row keeps only the content hash + cas ref. `status`:
 * pass | fail | blocked | inconclusive — an out-of-tolerance scientific
 * result is fail/inconclusive and is NEVER disguised as code_error.
 */
export const ReproducibilityReport = z.object({
  report_id: z.string().regex(/^repr_[a-z0-9_]+$/),
  spec_id: z.string().min(1),
  attempt_id: z.string().min(1),
  project_id: z.string().min(1),
  paper_refs: z.array(z.string()).default([]),
  claim_refs: z.array(z.string()).default([]),
  status: ReportStatus,
  preflight: Preflight.default({}),
  runtime_verified: RuntimeVerified.default({}),
  environment: z.object({
    declared: EnvironmentLock.default({}),
    used: EnvironmentLock.default({}),
  }).default({}),
  run_manifest_refs: z.array(z.string()).default([]),
  paper_comparisons: ComparisonGroup.default({}),
  run_comparisons: ComparisonGroup.default({}),
  checks: z.array(ReportCheck).default([]),
  missing_outputs: z.array(z.string()).default([]),
  extra_outputs: z.array(z.string()).default([]),
  /** Scientific failure class (metric_mismatch/table_mismatch/...), never
   *  code_error for an out-of-tolerance result. */
  failure_class: z.string().nullable().default(null),
  stable_error_code: z.string().default(''),
  retryable: z.boolean().default(false),
  generated_by: z.string().default('reproduction-verifier'),
  tool_versions: z.record(z.string()).default({}),
  /** sha256 of the canonical report JSON + CAS content ref, filled by the
   *  kernel at storage time. */
  report_hash: z.string().optional(),
  cas_ref: z.string().optional(),
  created_at: z.string(),
})
export type ReproducibilityReport = z.infer<typeof ReproducibilityReport>

/**
 * Wire input for POST /internal/reproduction-attempts/{attempt}/reports
 * (verifier service identity). Everything except the identity fields
 * (report_id/spec_id/attempt_id/project_id/created_at/hash/ref) plus the
 * attempt fencing fields (generation + lease token).
 */
export const ReproductionReportInput = z.object({
  attempt_generation: z.number().int().positive(),
  lease_token: z.string().min(1),
  paper_refs: z.array(z.string()).default([]),
  claim_refs: z.array(z.string()).default([]),
  status: ReportStatus,
  preflight: Preflight.default({}),
  runtime_verified: RuntimeVerified.default({}),
  environment: z.object({
    declared: EnvironmentLock.default({}),
    used: EnvironmentLock.default({}),
  }).default({}),
  run_manifest_refs: z.array(z.string()).default([]),
  paper_comparisons: ComparisonGroup.default({}),
  run_comparisons: ComparisonGroup.default({}),
  checks: z.array(ReportCheck).default([]),
  missing_outputs: z.array(z.string()).default([]),
  extra_outputs: z.array(z.string()).default([]),
  failure_class: z.string().nullable().default(null),
  stable_error_code: z.string().default(''),
  retryable: z.boolean().default(false),
  generated_by: z.string().default('reproduction-verifier'),
  tool_versions: z.record(z.string()).default({}),
}).refine(
  // The verifier cannot report a pass while a required check is not pass —
  // the pure evaluator (research-kernel reproduction-compare) derives status
  // from checks; a mismatched status/checks pair is a protocol error.
  input => {
    const required = input.checks.filter(c => c.required)
    if (input.status === 'pass') return required.every(c => c.status === 'pass')
    if (input.status === 'fail') return required.some(c => c.status === 'fail')
    if (input.status === 'inconclusive') return required.some(c => c.status === 'inconclusive') && !required.some(c => c.status === 'fail')
    return true // blocked — preflight level, checks need not carry it
  },
  { message: 'report status is inconsistent with its required checks (pass requires all required checks pass; fail requires a required check fail)' },
)
export type ReproductionReportInput = z.infer<typeof ReproductionReportInput>
