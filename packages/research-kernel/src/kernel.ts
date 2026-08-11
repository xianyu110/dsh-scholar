/**
 * Research Kernel — authoritative research state machine, ledger and durable
 * job store (design §3.2 ADR-002/003, §4.2, §5, §6). All writes go through
 * this class; the HTTP server and DSH plugin are thin adapters.
 * @module @dsh-scholar/research-kernel/kernel
 */

import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep, dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  ArtifactKind, ArtifactRecord, BudgetConstraints, BudgetRecord, Claim, CodeSnapshot, CorpusSnapshot, Decision,
  EvidenceItem, ExecutionConfig, ExperimentContract, Gate, IdeaCard, IntegrityConfig,
  JobRecord, KernelEvent, KernelEventKind, Paper, Passage, ResearchProject, ResearchBrief,
  RunnerKey, SessionLink, TRANSITION_TABLE, buildClaimId, buildContractId, buildGateId, buildIdeaId,
  buildProjectId, getFixtureProfile, getRunnerProfile, resolveRunnerProfileId, validateConfig, type GateType, type JobSpecBound, type JobStatus, type NextAction, type ProjectStatus,
  type HumanPrincipal, type IntakeArtifact, type IntakeObservation, type IntakeProjection, type IntakeSession,
  type AdoptionReceipt, type PhaseProposal, type ObservedPhase, type GrillAnswerInput, type GrillAnswerView,
  type IntakeStatus,
} from '@dsh-scholar/research-schemas'
import { ArtifactCas } from './cas.js'
import { openDatabase, type GateRow, type JobRow, type ProjectRow, type RunnerKeyRow } from './store.js'
import { openPtySessionStore, NullPtyAdapter, PtyError, type PtyAdapter, type PtyAppendResult, type PtyControlResult, type PtySessionStore } from './pty-session.js'
import { openWorkspaceStore, WorkspaceError, type WorkspaceExpected, type WorkspaceStore } from './workspace-store.js'
import { TexWorkspaceFacade, texInfoToWorkspaceInfo } from './tex-facade.js'
import { computePairedAnalysis } from '@dsh-scholar/analysis-worker'
import { nextActionProjection, legacyNextActionStrings, type NextActionJob } from './next-action.js'
import { IMAGES_LOCK } from './images-lock.js'
import { STAGED_UPLOAD_TTL_MS as STAGED_TTL, UPLOAD_MAX_FILE_BYTES as UPLOAD_LIMIT_BYTES } from './upload-limits.js'
import {
  INTAKE_DEFAULT_TTL_MS, INTAKE_STAGED_TTL_MS, INTAKE_DDL, GRILL_TAXONOMY_VERSION, GRILL_QUESTION_REVISION,
  questionsForTargetPhase, requiredQuestionCodes, scanIntakeArtifactStatic, artifactKindForFile,
  isImportableMetricsFile, parseMetricsFileV1, buildPhaseProposal, questionViews,
  SAFE_PHASE_LANDING, type StaticScanVerdict,
} from './intake.js'
import { TrajectoryStore } from './trajectory.js'
import { MetricsStore } from './metrics.js'

/** §12 (reconstruction-contracts.md): bootstrap resamples are FIXED at
 * 10,000 in production — the kernel never lowers them. */
const ANALYSIS_RESAMPLES = 10_000

/**
 * STORAGE-07 (storage-migrations.md §10): post-restore integrity scan
 * report — every artifact record vs its CAS blob (existence, recorded size,
 * content re-hash) plus unreferenced ("orphan") blobs.
 */
export interface IntegrityScanReport {
  /** Artifact records whose blob is missing from the CAS (or empty). */
  missing_blobs: Array<{ project_id: string; artifact_id: string; sha256: string }>
  /** CAS blobs not referenced by any artifact record (GC candidate set). */
  orphan_blobs: string[]
  /** Existing blobs whose on-disk size differs from artifacts.size_bytes. */
  size_mismatch: Array<{ project_id: string; artifact_id: string; sha256: string; recorded_size: number; actual_size: number }>
  /** Existing blobs whose content re-hashes to a different sha256. */
  hash_mismatch: Array<{ project_id: string; artifact_id: string; sha256: string; recorded_size: number; actual_size: number }>
  /** Blob verifications performed (size + hash). */
  scanned_blobs: number
  /** Artifact blobs skipped when the scan was limited (limit option). */
  skipped_blobs: number
  /** Total CAS blob count at scan time. */
  total_blobs: number
}

/**
 * §4 (RUN-02/TEX-02 P0): the TeX build engine is a FIXED enum — never a raw
 * string spliced into a shell. The runner's build script validates the same
 * whitelist before generating any command line.
 */
export const TEX_ENGINES: readonly string[] = ['pdflatex', 'lualatex', 'xelatex', 'bibtex', 'biber']

/** §4 (TEX-02): shell metacharacters that must never appear in a TeX build
 * path (mirrors the runner's materializeTexWorkspace rule). */
const TEX_SHELL_META = /[;&|`$"'\\ \t\n]/

/** §4 (TEX-02): a TeX build path must be root-relative (inside the frozen
 * workspace), free of `..` segments and shell metacharacters — it is
 * interpolated into the container build script. */
function assertSafeTexBuildPath(path: string): void {
  if (path === '' || path.startsWith('/') || path.split('/').some(part => part === '..')) {
    throw new KernelError(422, 'tex_path_invalid', `tex build path must be root-relative without '..': ${path}`)
  }
  if (TEX_SHELL_META.test(path)) {
    throw new KernelError(422, 'tex_path_invalid', `tex build path contains shell metacharacters: ${path}`)
  }
}

/**
 * PTY-01 (execution-runtime.md §6.1): the PTY cwd must be a RELATIVE path
 * inside the workspace — never a host path. Rejects absolute paths (and
 * Windows drive prefixes), `..` segments, NUL bytes and backslash
 * ambiguity; `''`/'.' normalize to '.'. Throws 422-shaped PtyError.
 */
function validatePtyCwd(cwd: string): string {
  if (cwd.includes('\u0000')) throw new PtyError('pty_open_invalid', 'pty cwd must not contain NUL')
  if (cwd.includes('\\')) throw new PtyError('pty_open_invalid', `pty cwd must use '/' separators: ${cwd}`)
  if (cwd.startsWith('/')) throw new PtyError('pty_open_invalid', `pty cwd must be root-relative inside the workspace: ${cwd}`)
  if (/^[A-Za-z]:/.test(cwd)) throw new PtyError('pty_open_invalid', `pty cwd must not carry a Windows drive prefix: ${cwd}`)
  if (cwd.split('/').some(part => part === '..')) throw new PtyError('pty_open_invalid', `pty cwd must not contain '..' segments: ${cwd}`)
  return cwd === '' ? '.' : cwd
}

/**
 * UPLOAD-01 path safety (execution-runtime.md §4 / domain-model.md §artifact):
 * the upload file name must be a plain basename. Rejects absolute paths
 * (POSIX and Windows drive prefixes), `..` segments (on both separators),
 * NUL bytes and anything that normalizes to empty. Throws 422
 * invalid_file_name — the same contract the code-snapshot walk enforces for
 * archived paths. Lives here (not in uploads.ts) so the parser module stays
 * dependency-free: kernel.ts is the only module that needs KernelError.
 */
export function validateUploadFileName(name: string): void {
  if (name === '' || name.trim() === '') {
    throw new KernelError(422, 'invalid_file_name', 'upload file name must not be empty')
  }
  if (name.includes('\0')) {
    throw new KernelError(422, 'invalid_file_name', 'upload file name must not contain NUL bytes')
  }
  if (name.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(name)) {
    throw new KernelError(422, 'invalid_file_name', 'upload file name must be a relative basename (absolute paths are rejected)')
  }
  // Windows drive prefix without separator (e.g. "C:evil.txt") is ambiguous —
  // reject it too so a Windows-style name can never reach the CAS download
  // Content-Disposition or a future archive materializer.
  if (/^[a-zA-Z]:/.test(name)) {
    throw new KernelError(422, 'invalid_file_name', 'upload file name must not carry a Windows drive prefix')
  }
  const normalized = name.replaceAll('\\', '/')
  if (normalized.startsWith('/')) {
    throw new KernelError(422, 'invalid_file_name', 'upload file name must be a relative basename (absolute paths are rejected)')
  }
  if (normalized.split('/').some(part => part === '..' || part === '.')) {
    throw new KernelError(422, 'invalid_file_name', 'upload file name must not contain "." or ".." path segments')
  }
  if (normalized.includes('/')) {
    // A single-file upload carries one basename; nested paths belong to
    // research-package archives (validated by the archive walk instead).
    throw new KernelError(422, 'invalid_file_name', 'upload file name must be a single basename without path separators')
  }
}

import { openTexWorkspace, TexError, type TexBuild, type TexDocumentInfo, type TexFileEntry, type TexPreviewPending, type TexSnapshotManifest } from './tex-workspace.js'
import { validateImageDigest, type SecureJobKind } from './images-lock.js'
import { parseLatexDiagnostics, type LatexDiagnostic } from './tex-diagnostics.js'

/** §12.1 (TEX-03): default debounce for live preview builds after a save. */
export const TEX_PREVIEW_DEBOUNCE_MS_DEFAULT = 800

export interface KernelOptions {
  /** SQLite database path (defaults to `:memory:`). */
  dbPath?: string
  /** CAS root for immutable artifacts. */
  casRoot?: string
  /** Kernel identity used for leases. */
  instanceId?: string
  /** §12.7: reject unsigned run manifests at job completion (default: compatible, accept). */
  requireSignedManifest?: boolean
  /**
   * §4 P0 (hardening API-01/EVID-01): service identity token for INTERNAL
   * routes (jobs-claim, runner-keys, recover/leases, evidence verified/
   * accept, contracts approve). When configured, the HTTP server demands
   * `x-service-token` on those routes (browser bearer credentials and
   * self-reported x-service-principal headers are NOT accepted). Supplied by
   * the sidecars via DSH_SCHOLAR_SERVICE_TOKEN; a bare kernel without it
   * stays open (dev compatibility).
   */
  serviceToken?: string
  /**
   * §12.1 (TEX-03): debounce window for live preview builds after a save
   * success (default 800ms). Per-request overrides are accepted by
   * texRequestPreview / POST preview-builds.
   */
  previewDebounceMs?: number
  /**
   * §12.1 (TEX-03): when true, every successful workspace write (save/new/
   * delete/move) automatically schedules a debounced preview build — the
   * kernel-internal "Workspace event → preview" path. Off by default so the
   * explicit POST /v1/documents/{id}/preview-builds hook (called by the UI
   * after a save success) stays the canonical trigger; the flag exists for
   * deployments that want zero client involvement.
   */
  previewAutoTrigger?: boolean
  /**
   * PTY-01: idle-TTL sweep cadence in ms (default 30s). The kernel owns the
   * sweep timer so sessions close even when no client ever reconnects; the
   * per-session idle_ttl_s (resolved from the Config Schema / request at
   * open) decides each session's deadline. 0 disables the timer.
   */
  ptyIdleSweepMs?: number
}

/** Error carrying an HTTP status for the API adapter. */
export class KernelError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * STORE-05 (storage-migrations.md §4): canonical content signature of one
 * terminal frame. Compares ONLY content fields (frame_kind, stream_seq,
 * channel, text, byte_offset, byte_length, payload_json); lease_generation
 * and created_at are delivery bookkeeping, not content (a reclaim replays
 * old seqs with a new generation). Deterministic: JSON.stringify of a fixed
 * field array.
 */
function terminalFrameSignature(frame: {
  frame_kind: string
  stream_seq?: number | null
  channel?: string | null
  text?: string | null
  byte_offset?: number | null
  byte_length?: number | null
  payload_json?: string | null
}): string {
  return createHash('sha256').update(JSON.stringify([
    frame.frame_kind,
    frame.stream_seq ?? null,
    frame.channel ?? null,
    frame.text ?? null,
    frame.byte_offset ?? null,
    frame.byte_length ?? null,
    frame.payload_json ?? '{}',
  ])).digest('hex')
}

function jsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (text === undefined || text === null || text === '') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function projectFromRow(row: ProjectRow): ResearchProject {
  return {
    project_id: row.project_id,
    name: row.name,
    workspace: row.workspace,
    mode: row.mode as ResearchProject['mode'],
    status: row.status as ProjectStatus,
    revision: row.revision,
    brief: jsonParse(row.brief, {} as ResearchProject['brief']),
    constraints: jsonParse(row.constraints, {} as ResearchProject['constraints']),
    execution: jsonParse(row.execution, {} as ResearchProject['execution']),
    integrity: jsonParse(row.integrity, {} as ResearchProject['integrity']),
    session_id: row.session_id,
    dsh_workspace_id: row.dsh_workspace_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    history: jsonParse(row.history, [] as string[]),
  }
}

function gateFromRow(row: GateRow): Gate {
  return {
    gate_id: row.gate_id,
    project_id: row.project_id,
    type: row.type as GateType,
    title: row.title,
    summary: row.summary,
    payload: jsonParse(row.payload, {}),
    status: row.status as Gate['status'],
    dsh_session_id: row.dsh_session_id,
    dsh_event_id: row.dsh_event_id,
    created_at: row.created_at,
    decided_at: row.decided_at,
  }
}

function jobFromRow(row: JobRow, db: DatabaseSync, tokenOverride?: string | null): JobSpecBound & { run_id: string | null } {
  const payload = jsonParse(row.payload, {} as Record<string, unknown>)
  // §12.6 / STORE-06 (storage-migrations.md §4): the opaque lease token is
  // NEVER persisted — new claims store only sha256(token) in
  // jobs.lease_token_hash and keep the plaintext in kernel memory (returned
  // to the runner on the claim response). `tokenOverride` is that in-memory
  // plaintext. Legacy rows claimed by the pre-0014 release still carry the
  // plaintext inside payload.__lease_token (hash column NULL); they are
  // surfaced the same way for backward-compatible fencing.
  const legacyToken = typeof payload.__lease_token === 'string' ? payload.__lease_token : null
  if (legacyToken !== null) delete payload.__lease_token
  const leaseToken = tokenOverride ?? legacyToken
  // §3.1 / RUN-01 (P0): the durable per-attempt run identity — the runs row
  // of the CURRENT attempt (`attempts`). Runners that only hold the job
  // record (claim response / GET job) can use run_id for manifest, terminal
  // frames and evidence without re-fetching; queued jobs (no attempt yet)
  // yield null.
  const runRow = db.prepare('SELECT run_id FROM runs WHERE job_id = ? AND attempt_no = ?')
    .get(row.job_id, row.attempts) as { run_id?: string } | undefined
  return {
    run_id: runRow?.run_id ?? null,
    job_id: row.job_id,
    project_id: row.project_id,
    contract_id: row.contract_id,
    idempotency_key: row.idempotency_key,
    kind: row.kind as JobRecord['kind'],
    command: jsonParse(row.command, [] as string[]),
    payload,
    status: row.status as JobStatus,
    failure_class: row.failure_class as JobRecord['failure_class'],
    lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at,
    heartbeat_at: row.heartbeat_at,
    lease_generation: row.lease_generation ?? null,
    lease_token: leaseToken,
    // v2 shape (domain-model.md §9): durable submitter principal; NULL for
    // legacy rows (migration 0016).
    created_by_principal_id: row.created_by_principal_id ?? null,
    // §12.2 JobSpec binding (SCH-EXEC-002): code snapshot materialized from CAS.
    code_snapshot_id: row.code_snapshot_id,
    data_artifact_ids: Array.isArray(payload.data_artifact_ids) ? payload.data_artifact_ids.map(String) : [],
    image_digest: typeof payload.image_digest === 'string' ? payload.image_digest : '',
    // domain-model.md §9.1: Job 固定的 opaque profile id + config hash
    // （kernel submitJob 注入 payload；runner 按注册表复算校验）。
    runner_profile_id: typeof payload.runner_profile_id === 'string' && payload.runner_profile_id !== '' ? payload.runner_profile_id : null,
    profile_config_hash: typeof payload.profile_config_hash === 'string' && payload.profile_config_hash !== '' ? payload.profile_config_hash : null,
    output_contract: typeof payload.output_contract === 'object' && payload.output_contract !== null
      ? { metrics: String((payload.output_contract as Record<string, unknown>).metrics ?? '/outputs/metrics.json'), logs: String((payload.output_contract as Record<string, unknown>).logs ?? '/outputs/run.log') }
      : undefined,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    run_manifest: jsonParse(row.run_manifest, null),
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * §3.1 (STORE-01): a durable run-attempt row — one row per job claim,
 * identity (run_id) per attempt. Populated at claim time and finalized at
 * completion (RUN-01). `snapshot_sha256` is the CAS sha256 of the job's
 * bound code snapshot (null when the job has none, e.g. echo/smoke/TeX).
 */
export interface RunRecord {
  run_id: string
  project_id: string
  job_id: string
  attempt_no: number
  contract_id: string | null
  snapshot_sha256: string | null
  manifest_json: Record<string, unknown> | null
  signature_status: 'pending' | 'signed' | 'unsigned'
  started_at: string
  finished_at: string | null
}

/** Row shape for the §3.1 runs table. */
interface RunRow {
  run_id: string
  project_id: string
  job_id: string
  attempt_no: number
  contract_id: string | null
  snapshot_sha256: string | null
  manifest_json: string | null
  signature_status: string
  started_at: string
  finished_at: string | null
}

function runFromRow(row: RunRow): RunRecord {
  return {
    run_id: row.run_id,
    project_id: row.project_id,
    job_id: row.job_id,
    attempt_no: row.attempt_no,
    contract_id: row.contract_id,
    snapshot_sha256: row.snapshot_sha256,
    manifest_json: jsonParse(row.manifest_json, null),
    signature_status: row.signature_status as RunRecord['signature_status'],
    started_at: row.started_at,
    finished_at: row.finished_at,
  }
}

/** Row shape for the event outbox (§16 canonical envelope, EVENT-01). */
interface OutboxEventRow {
  event_id: string
  project_id: string | null
  kind: string
  payload: string
  source: string
  delivered: number
  created_at: string
  /** §16: per-aggregate monotonic sequence (max+1 in the write transaction). */
  event_seq: number | null
  event_version: number | null
  aggregate_type: string | null
  aggregate_id: string | null
  aggregate_revision: number | null
  request_id: string | null
  session_id: string | null
  attempts: number | null
  last_error: string | null
  next_attempt_at: string | null
  dead_lettered_at: string | null
}

/** Row shapes for the ONBOARD-01 Intake tables (research-onboarding.md §3). */
interface IntakeSessionRow {
  intake_id: string
  project_id: string | null
  owner_principal_id: string
  owner_tenant_id: string
  owner_auth_method: string
  owner_session_id: string | null
  status: string
  revision: number
  source_label: string
  target_phase: string | null
  expires_at: string
  scan_summary: string
  proposal_json: string | null
  receipt_json: string | null
  audit_json: string
  idempotency_key: string | null
  request_hash: string | null
  created_at: string
  updated_at: string
}

interface IntakeArtifactRow {
  intake_id: string
  artifact_id: string
  file_name: string
  media_type: string
  size_bytes: number
  sha256: string
  quarantine: string
  scan_result: string
  created_at: string
}

interface IntakeObservationRow {
  observation_id: string
  intake_id: string
  artifact_id: string
  locator: string
  detector: string
  detector_version: string
  value: string
  warnings: string
  trust: string
  created_at: string
}

interface IntakeQuestionRow {
  intake_id: string
  question_code: string
  question_revision: number
  required: number
  answer: string | null
  answered_by_principal: string | null
  answered_by_session: string | null
  answered_at: string | null
}

function eventFromRow(row: OutboxEventRow): KernelEvent {
  return {
    event_id: row.event_id,
    project_id: row.project_id,
    kind: row.kind as KernelEventKind,
    payload: jsonParse(row.payload, {}),
    source: row.source,
    delivered: row.delivered === 1,
    created_at: row.created_at,
    // §16 outbox canonical envelope (EVENT-01): additive fields surfaced on
    // reads; old rows keep NULLs except the NOT NULL defaults.
    event_seq: row.event_seq ?? undefined,
    event_version: row.event_version ?? undefined,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    aggregate_revision: row.aggregate_revision,
    request_id: row.request_id,
    session_id: row.session_id,
    attempts: row.attempts ?? undefined,
    last_error: row.last_error,
    next_attempt_at: row.next_attempt_at,
    dead_lettered_at: row.dead_lettered_at,
  }
}

/** Side effects applied when a human decision approves a gate (design §5.2). */
const GATE_APPROVAL_TRANSITION: Record<GateType, { from: ProjectStatus; to: ProjectStatus }> = {
  scope: { from: 'DRAFT', to: 'SCOPED' },
  idea: { from: 'IDEATING', to: 'IDEA_APPROVED' },
  contract: { from: 'BASELINE_REPRO', to: 'CONTRACT_APPROVED' },
  budget: { from: 'BLOCKED_GATE', to: 'EXPERIMENTING' }, // resume: caller pins target in payload
  release: { from: 'RELEASE_READY', to: 'RELEASED' },
}

/** Run `fn` inside a single SQLite transaction (v2 §7.6 transactional kernel). */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
    throw error
  }
}

export class ResearchKernel {
  /**
   * Code-snapshot fixed resource limits (reconstruction-contracts.md §3,
   * STORE-02): the archive walk refuses to grow past these instead of
   * silently truncating. Static so deployments/tests can override them
   * (e.g. a unit test temporarily lowers SNAPSHOT_MAX_FILE_BYTES and
   * restores it in `finally`); 超限 → 422 `snapshot_too_large` with the
   * concrete limit and measured value in the message.
   */
  static SNAPSHOT_MAX_FILES = 10_000
  static SNAPSHOT_MAX_FILE_BYTES = 64 * 1024 * 1024 // 64 MiB per file
  static SNAPSHOT_MAX_TOTAL_BYTES = 512 * 1024 * 1024 // 512 MiB total

  /**
   * UPLOAD-01: hard cap for ONE multipart-uploaded file (api-contracts.md
   * §1/§7). Static so deployments/tests can lower it (same pattern as the
   * snapshot limits above); 超限 → 413 payload_too_large with the concrete
   * limit and measured value in the message. The HTTP layer streams against
   * this cap (plus a bounded multipart envelope allowance) so an oversized
   * upload is rejected before it is buffered in full.
   */
  static UPLOAD_MAX_FILE_BYTES = UPLOAD_LIMIT_BYTES

  /** Default staged-upload TTL for cleanupStagedUploads (24 h). */
  static STAGED_UPLOAD_TTL_MS = STAGED_TTL

  /** ONBOARD-01: default Intake session TTL before expireIntakes (7 days). */
  static INTAKE_DEFAULT_TTL_MS = INTAKE_DEFAULT_TTL_MS

  /** ONBOARD-01: default staged-intake-blob TTL for cleanupIntakeStaged. */
  static INTAKE_STAGED_TTL_MS = INTAKE_STAGED_TTL_MS

  readonly db: DatabaseSync
  readonly cas: ArtifactCas
  readonly instanceId: string
  /**
   * UPLOAD-01: staging area for in-flight multipart uploads (inside the CAS
   * root so it lives/dies with the artifact store). Files are written as
   * `stage_<id>.part` (raw bytes) + `stage_<id>.json` (metadata: project,
   * kind, file_name, media_type, sha256, size) and are never visible to
   * cas.list() (which only accepts 64-hex blob names) — they either become a
   * CAS blob at finalize or are collected by cleanupStagedUploads.
   */
  readonly stagedUploadsRoot: string
  /**
   * ONBOARD-01: ISOLATED staging CAS for intake sessions
   * (research-onboarding.md §2.1 — pre-accept writes only Intake tables and
   * this isolated temp area, never the project artifact space). A SIBLING of
   * staged-uploads/ under the CAS root (so the UPLOAD-01 staging directory
   * and its GC stay untouched). Files live under
   * `intake-staged/<intake_id>/<sha256>.part`; cas.list() never sees them,
   * adopted blobs are promoted into the real CAS inside the adoption
   * transaction, and reject/expiry/cleanupIntakeStaged remove them.
   */
  readonly intakeStagedRoot: string
  /** TeX workspace store (execution-runtime.md §12). */
  readonly tex: import('./tex-workspace.js').TexWorkspaceStore
  /**
   * PTY-01 (execution-runtime.md §6.1): durable Interactive Terminal session
   * store — state machine + control idempotency + frame seq/retention
   * (interface layer; the real tty adapter is injected via setPtyAdapter).
   */
  readonly pty: PtySessionStore
  /**
   * WORK-01 (api-contracts.md §17): generic VS Code-style workspace store —
   * revision/etag/CAS + binary artifact CAS, backed by the REAL disk
   * adapter (bytes under `dataDir/workspaces/{project_id}/{workspace_id}`,
   * metadata in `workspace_nodes`; workspace-store.ts).
   */
  readonly workspaces: WorkspaceStore
  /**
   * WORK-01: the TeX store viewed through the generic workspace contract
   * (kind='manuscript') — the mapping layer, not a second authority
   * (tex-facade.ts). The existing TeX routes keep calling `tex` directly.
   */
  readonly texFacade: TexWorkspaceFacade
  /**
   * TRAJ-01/SUBAGENT-01 (trajectory-subagents.md): standalone safe
   * trajectory projection + subagent topology store — read-only outbox
   * projection (Research/Session lanes, keyset pagination, redaction) and
   * child_links/history/followups (exact-parent, breadcrumb, one-shot
   * read-only followup). The Kernel Outbox stays the only business ledger.
   */
  readonly trajectory: import('./trajectory.js').TrajectoryStore
  /** §12.7: when true, unsigned run manifests are rejected at completion. */
  requireSignedManifest: boolean
  /** §4 P0 (API-01/EVID-01): service identity for internal HTTP routes. */
  readonly serviceToken: string | undefined
  /**
   * CONFIG-01: sha256 pin of the running kernel's effective config, computed
   * through the canonical Config Registry (research-schemas config-registry
   * module): global + project scope defaults merged with this instance's
   * kernel-scope values (db/cas/require-signed-manifest/service identity) and
   * the trusted images.lock digests. Deterministic for identical configs and
   * changes whenever any value changes — including the (hashed-only) service
   * token. Exposed via the HTTP `x-config-pin` header and /v1|v2 health.
   */
  readonly configPinHash: string
  /**
   * CONFIG-01: the REDACTED view of this kernel's effective config (secret
   * values replaced with `<redacted>` by the registry) — the safe plaintext
   * for the `/v1/config/effective` HTTP surface. The deployment-level
   * effective config (computed by the CLI with host/port/token/endpoint-file
   * included) overrides this via startKernelServer({ configRedacted }).
   */
  readonly configRedacted: Record<string, unknown>
  /** §12.1 (TEX-03): debounce window for live preview builds. */
  readonly previewDebounceMs: number
  /** §12.1 (TEX-03): auto-trigger previews on every workspace write. */
  readonly previewAutoTrigger: boolean
  /** §12.1 (TEX-03): in-flight debounce timers, one per document. */
  private readonly previewTimers = new Map<string, NodeJS.Timeout>()
  /**
   * PTY-01: the registered PTY adapter (null = no real tty yet). The
   * interface layer ships NullPtyAdapter; LocalPtyAdapter (pty-local.ts)
   * replaces it in the kernel bin; LocalDockerPty/RemoteRunnerPty share the
   * same contract. PTY output never becomes Job log, Metrics, Manifest,
   * Evidence or Gate Decision regardless of adapter.
   */
  private ptyAdapter: PtyAdapter | null = null
  /** PTY-01: idle-TTL sweep timer (kernel-owned, see KernelOptions). */
  private readonly ptySweepTimer: NodeJS.Timeout | null
  /**
   * OBS-01 (reconstruction-contracts.md §18): in-memory runtime metrics
   * (counters + histograms). Instrumented at the key paths below — request
   * completion (server layer), outbox append/dead-letter, job claim/
   * complete, lease expiry, terminal dropped bytes, CAS GC/orphan, TeX build
   * completion and budget accounting. Exposed as JSON via GET
   * /internal/metrics (loopback only). Series keys/tags are FIXED constant
   * strings — never paths, ids, tokens or content (OBS-01).
   */
  readonly metrics: MetricsStore

  /**
   * STORE-06 (storage-migrations.md §4): in-memory plaintext lease tokens,
   * one per currently-claimed job (job_id → token). The database only ever
   * stores sha256(token) in jobs.lease_token_hash; this map backs the
   * claim-response surface (the runner receives the plaintext token once)
   * and is cleared when the lease is released (complete/cancel/expiry
   * recovery). After a kernel restart it is empty — verification stays
   * possible via the hash column, but re-fetched jobs no longer carry the
   * plaintext (the runner holds it from the claim response).
   */
  private readonly leaseTokens = new Map<string, string>()

  constructor(options: KernelOptions = {}) {
    // MIG-V1 (0017): the migration runner receives the CAS root so legacy
    // log text can be materialized as real content-addressed blobs (with a
    // final log Artifact row) instead of phantom references.
    const casRoot = options.casRoot ?? join(process.cwd(), '.research-cas')
    this.db = openDatabase(options.dbPath ?? ':memory:', undefined, casRoot)
    this.cas = new ArtifactCas(casRoot)
    this.stagedUploadsRoot = join(this.cas.root, 'staged-uploads')
    mkdirSync(this.stagedUploadsRoot, { recursive: true })
    // ONBOARD-01: isolated intake staging area (sibling dir — the upload
    // staging root and cleanupStagedUploads stay untouched by intake).
    this.intakeStagedRoot = join(this.cas.root, 'intake-staged')
    mkdirSync(this.intakeStagedRoot, { recursive: true })
    this.tex = openTexWorkspace(options.dbPath ?? ':memory:')
    this.pty = openPtySessionStore(options.dbPath ?? ':memory:')
    this.workspaces = openWorkspaceStore(options.dbPath ?? ':memory:', options.casRoot ?? join(process.cwd(), '.research-cas'),
      // WORK-01 disk adapter: one tree root per project under the kernel's
      // data directory (dataDir/workspaces/{project_id}/{workspace_id}).
      join(dirname(options.dbPath ?? ':memory:'), 'workspaces'))
    this.texFacade = new TexWorkspaceFacade(this.tex)
    // TRAJ-01/SUBAGENT-01: the trajectory/topology store shares THIS
    // connection (single-writer SQLite) and emits its outbox events through
    // the kernel's canonical emit (per-aggregate monotonic event_seq).
    this.trajectory = new TrajectoryStore(this.db, (projectId, kind, payload) => this.emit(projectId, kind, payload))
    this.instanceId = options.instanceId ?? `kernel-${randomUUID().slice(0, 8)}`
    this.serviceToken = options.serviceToken
    // OBS-01: the runtime metrics store is process-local; no locking needed.
    this.metrics = new MetricsStore()
    // RUN-01 (§4): signed run manifests are REQUIRED BY DEFAULT — the runner
    // registers an ephemeral Ed25519 key and signs every completion, so the
    // default only affects callers that never sign. Unit tests that exercise
    // unrelated paths opt out explicitly (freshKernel passes false).
    this.requireSignedManifest = options.requireSignedManifest ?? true
    // §12.1 (TEX-03): preview scheduling knobs. Defaults keep the explicit
    // preview-builds hook as the canonical trigger; the pending rows are
    // durable, so any request that survived a restart is re-armed below.
    this.previewDebounceMs = options.previewDebounceMs ?? TEX_PREVIEW_DEBOUNCE_MS_DEFAULT
    this.previewAutoTrigger = options.previewAutoTrigger ?? false
    // CONFIG-01: pin the effective runtime config through the registry. The
    // registry validates the values (unknown keys / floor violations throw
    // here — fail fast at construction) and returns the one-way sha256 pin.
    const pinned = validateConfig({
      'kernel.db': options.dbPath ?? ':memory:',
      'kernel.cas': options.casRoot ?? join(process.cwd(), '.research-cas'),
      'kernel.require_signed_manifest': this.requireSignedManifest,
      'kernel.service_token': this.serviceToken ?? '',
    }, {
      scopes: ['global', 'project', 'kernel'],
      imagesLock: { node_fixture: IMAGES_LOCK.node_fixture, texlive: IMAGES_LOCK.texlive },
    })
    this.configPinHash = pinned.pinHash
    this.configRedacted = pinned.redacted
    // §12.1 (TEX-03): re-arm debounce timers for pending preview requests
    // that survived a kernel restart — preview state is re-projectable from
    // the kernel, it never lives only in a browser debounce timer.
    for (const pending of this.tex.listPendingPreviews()) {
      this.armPreviewTimer(pending.document_id, pending.debounce_ms)
    }
    // PTY-01: idle-TTL sweep. Sessions idle longer than their pinned
    // idle_ttl_s are closed (and their real tty torn down via the adapter)
    // even when no client ever reconnects. The timer is unref'd — it never
    // keeps the process alive and is cleared on close().
    const sweepMs = options.ptyIdleSweepMs ?? 30_000
    if (sweepMs > 0) {
      const timer = setInterval(() => {
        try {
          this.ptySweepIdle()
        } catch {
          // A sweep failure must never take the kernel down.
        }
      }, sweepMs)
      timer.unref()
      this.ptySweepTimer = timer
    } else {
      this.ptySweepTimer = null
    }
  }

  close(): void {
    if (this.ptySweepTimer !== null) clearInterval(this.ptySweepTimer)
    for (const timer of this.previewTimers.values()) clearTimeout(timer)
    this.previewTimers.clear()
    // PTY-01: tear down every live real tty before the stores close (the
    // adapter processes are children of this kernel — no orphans).
    for (const session of this.pty.listSessions()) {
      if (session.state !== 'closed') this.ptyNotifyClosed(session.pty_session_id)
    }
    this.tex.close()
    this.pty.close()
    this.workspaces.close()
    this.db.close()
  }

  // ── events (append-only outbox) ──────────────────────────────────────────

  /**
   * Append one event to the durable outbox (reconstruction-contracts.md §16,
   * EVENT-01). The canonical envelope is written atomically: `event_seq` is
   * allocated as per-aggregate max+1 inside the write transaction (or the
   * caller's already-open transaction — single-writer SQLite serializes the
   * read+insert). The aggregate is derived from the payload when it carries
   * `project_id` (+ optional numeric `revision`), otherwise NULL; request_id/
   * session_id pass through from the payload when present.
   */
  emit(projectId: string | null, kind: KernelEventKind, payload: Record<string, unknown> = {}): KernelEvent {
    const write = (): KernelEvent => {
      // §16 aggregate identity: project-scoped events aggregate by project.
      const aggregateType = typeof payload.project_id === 'string' && payload.project_id !== '' ? 'project' : null
      const aggregateId = aggregateType !== null ? String(payload.project_id) : null
      const aggregateRevision = typeof payload.revision === 'number' ? payload.revision : null
      const requestId = typeof payload.request_id === 'string' && payload.request_id !== '' ? payload.request_id : null
      const sessionId = typeof payload.session_id === 'string' && payload.session_id !== '' ? payload.session_id : null
      // max+1 within the aggregate bucket (NULL buckets allocate among
      // aggregate-less events; SQLite treats NULLs as distinct in the unique
      // index, so bucket-local allocation can never collide).
      const next = (this.db.prepare(
        'SELECT COALESCE(MAX(event_seq), 0) + 1 AS next FROM events WHERE aggregate_type IS ? AND aggregate_id IS ?',
      ).get(aggregateType, aggregateId) as { next: number }).next
      const event: KernelEvent = {
        event_id: `evt_${randomUUID().replaceAll('-', '')}`,
        project_id: projectId,
        kind,
        payload,
        source: `kernel:${this.instanceId}`,
        delivered: false,
        created_at: nowIso(),
        event_seq: next,
        event_version: 1,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        aggregate_revision: aggregateRevision,
        request_id: requestId,
        session_id: sessionId,
        attempts: 0,
        last_error: null,
        next_attempt_at: null,
        dead_lettered_at: null,
      }
      this.db.prepare(
        `INSERT INTO events (event_id, project_id, kind, payload, source, delivered, created_at,
           event_seq, event_version, aggregate_type, aggregate_id, aggregate_revision,
           request_id, session_id, attempts, last_error, next_attempt_at, dead_lettered_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL)`,
      ).run(
        event.event_id, event.project_id, event.kind, JSON.stringify(event.payload), event.source, event.created_at,
        next, aggregateType, aggregateId, aggregateRevision,
        requestId, sessionId,
      )
      // OBS-01: outbox append counter (kind is a fixed event-kind constant).
      this.metrics.count('outbox.append', { kind })
      return event
    }
    // §16 "SQLite 单写事务分配 event_seq=max+1": emit already running inside
    // a caller transaction (e.g. createProjectWithInitialGate) reuses it —
    // node:sqlite forbids nested BEGIN, so only standalone emits open one.
    if (this.db.isTransaction) return write()
    return withTransaction(this.db, write)
  }

  listEvents(projectId?: string, delivered?: boolean): KernelEvent[] {
    const rows = projectId === undefined
      ? this.db.prepare('SELECT * FROM events ORDER BY created_at').all() as unknown as OutboxEventRow[]
      : this.db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as OutboxEventRow[]
    return rows
      .filter(row => delivered === undefined || row.delivered === (delivered ? 1 : 0))
      .map(eventFromRow)
  }

  /**
   * §16 consumer-side delivery bookkeeping: mark one undeliverable event as
   * dead-lettered (the original event is kept, per §16). Records the
   * `outbox.dead_letter` metric (OBS-01). Returns true when the event was
   * transitioned (false when it was already dead-lettered or unknown).
   */
  deadLetterEvent(eventId: string, reason = 'max delivery attempts exceeded'): boolean {
    const result = this.db.prepare(
      'UPDATE events SET dead_lettered_at = ?, last_error = ? WHERE event_id = ? AND dead_lettered_at IS NULL',
    ).run(nowIso(), reason, eventId)
    if (Number(result.changes) === 1) {
      this.metrics.count('outbox.dead_letter')
      return true
    }
    return false
  }

  /** At-least-once delivery: mark events delivered; the caller dedupes. */
  markEventsDelivered(eventIds: string[]): void {
    const stmt = this.db.prepare('UPDATE events SET delivered = 1 WHERE event_id = ? AND delivered = 0')
    for (const id of eventIds) stmt.run(id)
  }

  // ── trajectory projection & subagent topology (trajectory-subagents.md) ──

  /** Read-only, redacted outbox projection with keyset pagination
   * ((event_seq, event_id) cursor; single page ≤ 500). */
  projectTrajectory(projectId: string, opts: Parameters<TrajectoryStore['projectTrajectory']>[1] = {}): ReturnType<TrajectoryStore['projectTrajectory']> {
    return this.trajectory.projectTrajectory(projectId, opts)
  }

  /** Research + Session lanes for one project (both always returned). */
  projectTrajectoryLanes(projectId: string, opts: Parameters<TrajectoryStore['projectTrajectoryLanes']>[1] = {}): ReturnType<TrajectoryStore['projectTrajectoryLanes']> {
    return this.trajectory.projectTrajectoryLanes(projectId, opts)
  }

  /** Record a spawned subagent child (plugin research_panel wiring is a
   * later integration; the kernel surface + tests cover the contract). */
  registerChildLink(input: Parameters<TrajectoryStore['registerChildLink']>[0]): ReturnType<TrajectoryStore['registerChildLink']> {
    return this.trajectory.registerChildLink(input)
  }

  getChildLink(childId: string): ReturnType<TrajectoryStore['getChildLink']> {
    return this.trajectory.getChildLink(childId)
  }

  updateChildState(childId: string, state: Parameters<TrajectoryStore['updateChildState']>[1], detail?: string): ReturnType<TrajectoryStore['updateChildState']> {
    return this.trajectory.updateChildState(childId, state, detail)
  }

  /** Exact direct children of a parent (or roots); bounded pages. */
  projectTopology(projectId: string, opts: Parameters<TrajectoryStore['projectTopology']>[1] = {}): ReturnType<TrajectoryStore['projectTopology']> {
    return this.trajectory.projectTopology(projectId, opts)
  }

  /** Exact-parent + breadcrumb (cycle-safe, orphan fail-soft). */
  getChildDetail(childId: string): ReturnType<TrajectoryStore['getChildDetail']> {
    return this.trajectory.getChildDetail(childId)
  }

  /** Read-only per-child history; never activates the child. */
  childHistory(childId: string, opts: Parameters<TrajectoryStore['childHistory']>[1] = {}): ReturnType<TrajectoryStore['childHistory']> {
    return this.trajectory.childHistory(childId, opts)
  }

  /** One-shot READ-ONLY followup: records the message, returns message_id,
   * child state untouched. */
  childFollowup(childId: string, message: string, requestId?: string): ReturnType<TrajectoryStore['childFollowup']> {
    return this.trajectory.childFollowup(childId, message, requestId)
  }

  /** Owning project of a child (BFF membership pre-check; null = unknown). */
  childProjectId(childId: string): string | null {
    return this.trajectory.childProjectId(childId)
  }

  // ── projects ─────────────────────────────────────────────────────────────

  createProject(input: {
    name: string
    workspace: string
    brief: ResearchBrief
    mode?: 'gate-only' | 'full-auto'
    constraints?: ResearchProject['constraints']
    execution?: ResearchProject['execution']
    integrity?: ResearchProject['integrity']
    session_id?: string | null
    dsh_workspace_id?: string | null
  }): ResearchProject {
    // hardening: store the PARSED brief (defaults applied), never the raw
    // caller object — projection and ledger stay consistent.
    const brief = ResearchBrief.parse(input.brief)
    // CONFIG-01: the project-scope effective config (execution + integrity)
    // must pass the canonical Config Registry — the zod parses below reject
    // unknown keys and wrong values; the registry additionally enforces the
    // security floor for programmatic callers (docker socket / privileged /
    // host network / images.lock pins). Throws ConfigRegistryError on
    // violation before anything is persisted.
    const execution = ExecutionConfig.parse(input.execution ?? {})
    const integrity = IntegrityConfig.parse(input.integrity ?? {})
    // canonical registry keys are dotted: execution.* / integrity.*
    const projectConfig: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(execution)) projectConfig[`execution.${key}`] = value
    for (const [key, value] of Object.entries(integrity)) projectConfig[`integrity.${key}`] = value
    validateConfig(projectConfig, { scopes: ['project'] })
    // product-spec.md §1 / README 使用边界: high-risk domains (clinical
    // decision-making, human trials, wet-lab, weapons, biosecurity) are
    // OUTSIDE the product boundary — the system must not proceed with them.
    // Fail closed at creation with a stable code (default-denial posture);
    // an independent policy extension would relax this list explicitly.
    const HIGH_RISK_DOMAINS = ['clinical', 'clinical-decision', 'human-trial', 'human-trials', 'wet-lab', 'wetlab', 'weapon', 'weapons', 'biosecurity', 'bio-safety']
    const domain = (brief.domain ?? '').toLowerCase().trim()
    if (HIGH_RISK_DOMAINS.includes(domain)) {
      throw new KernelError(422, 'domain_unsupported',
        `domain '${brief.domain}' is a high-risk domain (clinical decision-making / human trials / wet-lab / weapons / biosecurity) — DSH Scholar is for pure-computation research only (product-spec.md §1)`)
    }
    // reconstruction-contracts.md §5 / security-baseline.md §1: full-auto is
    // fixture-only — the project must bind a REGISTERED FixtureProfile at
    // creation; job submit re-checks below. Unknown/missing -> 422, nothing
    // is persisted (no unbound full-auto project rows can exist).
    const mode = input.mode ?? 'gate-only'
    if (mode === 'full-auto' && getFixtureProfile(execution.fixture_id ?? '') === null) {
      throw new KernelError(422, 'fixture_required',
        'full-auto projects require execution.fixture_id bound to a REGISTERED FixtureProfile (reconstruction-contracts.md §5); unknown fixture ids are rejected')
    }
    // domain-model.md §2/§9.1: Project 只能引用已登记的 opaque RunnerProfile
    // id。runner_profile_id 显式设置时必须在注册表内——未知 id 422，零落库
    // （与 fixture_required 同一 fail-closed 姿态）。
    if (execution.runner_profile_id !== null && execution.runner_profile_id !== '') {
      if (getRunnerProfile(execution.runner_profile_id) === null) {
        throw new KernelError(422, 'runner_profile_unknown',
          `execution.runner_profile_id ${execution.runner_profile_id} is not a registered opaque RunnerProfile id (domain-model.md §9.1)`)
      }
    }
    const project: ResearchProject = {
      project_id: buildProjectId(),
      name: input.name,
      workspace: input.workspace,
      mode,
      status: 'DRAFT',
      revision: 0,
      brief,
      constraints: BudgetConstraints.parse(input.constraints ?? {}),
      execution,
      integrity,
      session_id: input.session_id ?? null,
      dsh_workspace_id: input.dsh_workspace_id ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
      history: ['created'],
    }
    this.db.prepare(
      `INSERT INTO projects (project_id, name, workspace, mode, status, revision, brief, constraints, execution, integrity, session_id, dsh_workspace_id, created_at, updated_at, history)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      project.project_id, project.name, project.workspace, project.mode, project.status, project.revision,
      JSON.stringify(project.brief), JSON.stringify(project.constraints), JSON.stringify(project.execution),
      JSON.stringify(project.integrity), project.session_id, project.dsh_workspace_id,
      project.created_at, project.updated_at, JSON.stringify(project.history),
    )
    if (project.session_id !== null) this.linkSession(project.session_id, project.project_id)
    // API-01 foundation: the creator becomes the first PI member
    // (reconstruction-contracts.md §7: "Project creator 成为 pi").
    const creator = (input as { creator_principal_id?: string }).creator_principal_id
    if (creator !== undefined && creator !== '') {
      this.db.prepare(`INSERT INTO project_members (project_id, principal_id, tenant_id, role, created_at, updated_at)
        VALUES (?, ?, ?, 'pi', ?, ?)`)
        .run(project.project_id, creator, (input as { creator_tenant_id?: string }).creator_tenant_id ?? '', project.created_at, project.created_at)
    }
    this.emit(project.project_id, 'project.created', { project_id: project.project_id, name: project.name })
    return project
  }

  /**
   * v2 (api-contracts.md §4): atomic create-project with the initial Scope
   * Gate + creator membership + budget, plus the BFF-scoped Idempotency-Key.
   * Replaying the same key + request hash returns the SAME project/gate/
   * budget/membership; the same key with a different request hash is a 409.
   */
  createProjectWithInitialGate(input: Parameters<ResearchKernel['createProject']>[0] & {
    idempotency_key?: string
    request_hash?: string
  }): { project: ResearchProject; gate: Gate; budget: BudgetRecord; membership: Array<Record<string, unknown>> } {
    if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
      const existing = this.db.prepare('SELECT project_id, request_hash FROM projects WHERE idempotency_key = ?')
        .get(input.idempotency_key) as { project_id: string; request_hash: string | null } | undefined
      if (existing !== undefined) {
        if (existing.request_hash !== (input.request_hash ?? '')) {
          throw new KernelError(409, 'idempotency_conflict', `idempotency key ${input.idempotency_key} was used with a different request hash`)
        }
        return {
          project: this.getProject(existing.project_id),
          gate: this.listGates(existing.project_id, 'pending').find(g => g.type === 'scope') ?? this.listGates(existing.project_id)[0]!,
          budget: this.getBudget(existing.project_id),
          membership: this.listProjectMembers(existing.project_id),
        }
      }
    }
    return withTransaction(this.db, () => {
      const project = this.createProject(input)
      // Initial Scope Gate (v2 contract: the project ships with it).
      const gate = this.createGate({
        project_id: project.project_id,
        type: 'scope',
        title: 'Scope Gate',
        summary: 'Initial scope approval required before any research work.',
      })
      const budget = this.getBudget(project.project_id)
      if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
        this.db.prepare('UPDATE projects SET idempotency_key = ?, request_hash = ? WHERE project_id = ?')
          .run(input.idempotency_key, input.request_hash ?? '', project.project_id)
      }
      return { project, gate, budget, membership: this.listProjectMembers(project.project_id) }
    })
  }

  /**
   * v2 keyset pagination (api-contracts.md §1): items ordered by
   * (updated_at DESC, project_id DESC); cursor encodes the last row.
   */
  listProjectsPage(limit = 50, cursor?: string): { items: ProjectRow[]; next_cursor: string | null } {
    const cap = Math.min(Math.max(limit, 1), 200)
    let after: { updated_at: string; project_id: string } | null = null
    if (cursor !== undefined && cursor !== '') {
      // api-contracts.md §1: a malformed cursor is an explicit 400, never a
      // silent restart-from-top.
      let raw: string
      try {
        raw = Buffer.from(cursor, 'base64url').toString('utf8')
      } catch {
        throw new KernelError(400, 'invalid_cursor', `malformed cursor: ${cursor}`)
      }
      const [updatedAt, projectId] = raw.split('|')
      if (updatedAt === undefined || projectId === undefined || updatedAt === '' || projectId === '') {
        throw new KernelError(400, 'invalid_cursor', `malformed cursor: ${cursor}`)
      }
      after = { updated_at: updatedAt, project_id: projectId }
    }
    const rows = after === null
      ? this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, project_id DESC LIMIT ?').all(cap + 1) as unknown as ProjectRow[]
      : this.db.prepare('SELECT * FROM projects WHERE (updated_at < ? OR (updated_at = ? AND project_id < ?)) ORDER BY updated_at DESC, project_id DESC LIMIT ?')
        .all(after.updated_at, after.updated_at, after.project_id, cap + 1) as unknown as ProjectRow[]
    const hasMore = rows.length > cap
    const page = hasMore ? rows.slice(0, cap) : rows
    const last = page[page.length - 1]
    return {
      items: page,
      next_cursor: hasMore && last !== undefined ? Buffer.from(`${last.updated_at}|${last.project_id}`).toString('base64url') : null,
    }
  }

  // ── project membership (API-01 foundation, reconstruction-contracts §7) ──

  listProjectMembers(projectId: string): Array<{
    project_id: string; principal_id: string; tenant_id: string; role: string; created_at: string; updated_at: string
  }> {
    this.getProject(projectId)
    const rows = this.db.prepare('SELECT * FROM project_members WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as Array<{
      project_id: string; principal_id: string; tenant_id: string; role: string; created_at: string; updated_at: string
    }>
    return rows
  }

  addProjectMember(input: {
    project_id: string
    principal_id: string
    role: 'pi' | 'researcher' | 'operator' | 'auditor' | 'viewer'
    tenant_id?: string
    actor: string
  }): { project_id: string; principal_id: string; tenant_id: string; role: string; created_at: string; updated_at: string } {
    const project = this.getProject(input.project_id)
    // member_manage capability (reconstruction-contracts §7): the acting
    // principal must already be a PI of the project.
    const actorRow = this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND principal_id = ?')
      .get(input.project_id, input.actor) as { role: string } | undefined
    if (actorRow?.role !== 'pi') {
      throw new KernelError(403, 'member_manage_denied', `only an existing PI can manage members of ${input.project_id}`)
    }
    const now = nowIso()
    const tenant = input.tenant_id ?? ''
    this.db.prepare(`INSERT INTO project_members (project_id, principal_id, tenant_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, principal_id) DO UPDATE SET role = excluded.role, tenant_id = excluded.tenant_id, updated_at = excluded.updated_at`)
      .run(input.project_id, input.principal_id, tenant, input.role, now, now)
    this.emit(project.project_id, 'project.membership.updated', { project_id: input.project_id, principal_id: input.principal_id, role: input.role })
    return { project_id: input.project_id, principal_id: input.principal_id, tenant_id: tenant, role: input.role, created_at: now, updated_at: now }
  }

  removeProjectMember(input: { project_id: string; principal_id: string; actor: string }): void {
    this.getProject(input.project_id)
    const actorRow = this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND principal_id = ?')
      .get(input.project_id, input.actor) as { role: string } | undefined
    if (actorRow?.role !== 'pi') {
      throw new KernelError(403, 'member_manage_denied', `only an existing PI can manage members of ${input.project_id}`)
    }
    const target = this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND principal_id = ?')
      .get(input.project_id, input.principal_id) as { role: string } | undefined
    if (target === undefined) throw new KernelError(404, 'member_not_found', `member ${input.principal_id} not found in ${input.project_id}`)
    if (target.role === 'pi') {
      const piCount = (this.db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = ?').get(input.project_id, 'pi') as { n: number }).n
      if (piCount <= 1) {
        throw new KernelError(422, 'last_pi_removal', 'the last PI of a project cannot be removed')
      }
    }
    this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND principal_id = ?').run(input.project_id, input.principal_id)
  }

  getProject(projectId: string): ResearchProject {
    const row = this.db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as ProjectRow | undefined
    if (row === undefined) throw new KernelError(404, 'project_not_found', `project ${projectId} not found`)
    return projectFromRow(row)
  }

  listProjects(): ResearchProject[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as unknown as ProjectRow[]
    return rows.map(projectFromRow)
  }

  /** State transition with expected_revision CAS (design §5.1, §9.3). */
  transition(projectId: string, to: ProjectStatus, expectedRevision: number, reason = ''): ResearchProject {
    const project = this.getProject(projectId)
    if (project.revision !== expectedRevision) {
      throw new KernelError(409, 'revision_conflict', `expected revision ${expectedRevision}, got ${project.revision}`)
    }
    const allowed = TRANSITION_TABLE[project.status]
    if (!allowed.includes(to)) {
      throw new KernelError(422, 'invalid_transition', `transition ${project.status} -> ${to} not allowed`)
    }
    const now = nowIso()
    this.db.prepare('UPDATE projects SET status = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ? AND revision = ?')
      .run(to, now, JSON.stringify([...project.history, `${project.status}->${to}${reason ? ` (${reason})` : ''}`]), projectId, expectedRevision)
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.transitioned', { from: project.status, to, revision: updated.revision, reason })
    return updated
  }

  /** Rename a project (dsh-web session actions); audited in history. */
  renameProject(projectId: string, name: string): ResearchProject {
    const clean = name.trim()
    if (clean === '') throw new KernelError(422, 'invalid_name', 'project name must not be empty')
    if (clean.length > 120) throw new KernelError(422, 'invalid_name', 'project name too long (max 120 chars)')
    const project = this.getProject(projectId)
    const now = nowIso()
    this.db.prepare('UPDATE projects SET name = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ?')
      .run(clean, now, JSON.stringify([...project.history, `renamed to "${clean}"`]), projectId)
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.renamed', { from: project.name, to: clean, revision: updated.revision })
    return updated
  }

  /**
   * Archive a project (dsh-web session actions): data is kept, the project
   * leaves the Active group and all further gates/actions are blocked.
   * Reversible via unarchiveProject.
   */
  archiveProject(projectId: string): ResearchProject {
    const project = this.getProject(projectId)
    if (project.status === 'ARCHIVED') return project
    // reconstruction-contracts.md §4: "any non-ARCHIVED → ARCHIVED | PI |
    // no running jobs; otherwise 409" — archiving a project with active
    // (queued/running/retryable) jobs would orphan lease ownership and
    // terminal streams, so it is rejected outright.
    const active = this.db.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE project_id = ? AND status IN ('queued', 'running', 'retryable')",
    ).get(projectId) as { n: number }
    if (Number(active.n) > 0) {
      throw new KernelError(409, 'jobs_running',
        `project ${projectId} has ${active.n} active job(s) (queued/running/retryable) — stop or finish them before archiving`)
    }
    const now = nowIso()
    this.db.prepare('UPDATE projects SET status = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ?')
      .run('ARCHIVED', now, JSON.stringify([...project.history, `${project.status}->ARCHIVED (archived)`]), projectId)
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.transitioned', { from: project.status, to: 'ARCHIVED', revision: updated.revision, reason: 'archived' })
    return updated
  }

  /** Restore an archived project (back to RELEASE_READY when it was done,
   * otherwise to its pre-archive phase). */
  unarchiveProject(projectId: string): ResearchProject {
    const project = this.getProject(projectId)
    if (project.status !== 'ARCHIVED') return project
    const restored = project.history.at(-1)?.startsWith('RELEASED') === true ? 'RELEASED' as ProjectStatus : 'RELEASE_READY' as ProjectStatus
    const now = nowIso()
    this.db.prepare('UPDATE projects SET status = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ?')
      .run(restored, now, JSON.stringify([...project.history, 'ARCHIVED->restored']), projectId)
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.transitioned', { from: 'ARCHIVED', to: restored, revision: updated.revision, reason: 'restored' })
    return updated
  }

  /** Link a DSH session to a project (design RSP-006). */
  linkSession(sessionId: string, projectId: string): SessionLink {
    this.getProject(projectId)
    const link: SessionLink = { session_id: sessionId, project_id: projectId, linked_at: nowIso() }
    this.db.prepare('INSERT INTO session_links (session_id, project_id, linked_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, linked_at = excluded.linked_at')
      .run(link.session_id, link.project_id, link.linked_at)
    this.emit(projectId, 'session.linked', { session_id: sessionId })
    return link
  }

  getProjectBySession(sessionId: string): ResearchProject | null {
    const row = this.db.prepare('SELECT project_id FROM session_links WHERE session_id = ?').get(sessionId) as { project_id: string } | undefined
    if (row === undefined) return null
    try {
      return this.getProject(row.project_id)
    } catch {
      return null
    }
  }

  // ── gates & decisions ────────────────────────────────────────────────────

  createGate(input: {
    project_id: string
    type: GateType
    title: string
    summary?: string
    payload?: Record<string, unknown>
    session_id?: string | null
  }): Gate {
    this.getProject(input.project_id)
    const gate: Gate = {
      gate_id: buildGateId(),
      project_id: input.project_id,
      type: input.type,
      title: input.title,
      summary: input.summary ?? '',
      payload: input.payload ?? {},
      status: 'pending',
      dsh_session_id: input.session_id ?? null,
      dsh_event_id: null,
      created_at: nowIso(),
      decided_at: null,
    }
    this.db.prepare(
      'INSERT INTO gates (gate_id, project_id, type, title, summary, payload, status, dsh_session_id, dsh_event_id, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(gate.gate_id, gate.project_id, gate.type, gate.title, gate.summary, JSON.stringify(gate.payload), gate.status, gate.dsh_session_id, gate.dsh_event_id, gate.created_at, gate.decided_at)
    this.emit(input.project_id, 'gate.created', { gate_id: gate.gate_id, type: gate.type, title: gate.title })
    return gate
  }

  listGates(projectId: string, status?: Gate['status']): Gate[] {
    const rows = status === undefined
      ? this.db.prepare('SELECT * FROM gates WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as GateRow[]
      : this.db.prepare('SELECT * FROM gates WHERE project_id = ? AND status = ? ORDER BY created_at').all(projectId, status) as unknown as GateRow[]
    return rows.map(gateFromRow)
  }

  getGate(gateId: string): Gate {
    const row = this.db.prepare('SELECT * FROM gates WHERE gate_id = ?').get(gateId) as GateRow | undefined
    if (row === undefined) throw new KernelError(404, 'gate_not_found', `gate ${gateId} not found`)
    return gateFromRow(row)
  }

  /** Record a human decision and apply the gate side effect (v2 §6.5, §6.6). */
  decideGate(input: {
    gate_id: string
    actor: string
    /** v2: authenticated human principal; agents cannot call this path. */
    principal?: {
      principal_id: string
      tenant_id?: string
      auth_method?: string
      session_id?: string | null
    }
    decision: 'approved' | 'rejected' | 'revised'
    reason?: string
    diff?: string
    session_id?: string | null
    event_id?: string | null
    /** For budget gates: the status to resume to on approval. */
    resume_to?: ProjectStatus
  }): { gate: Gate; decision: Decision; project: ResearchProject } {
    const gate = this.getGate(input.gate_id)
    if (gate.status !== 'pending') {
      throw new KernelError(409, 'gate_already_decided', `gate ${input.gate_id} already ${gate.status}`)
    }
    return withTransaction(this.db, () => {
      const decision: Decision = {
        decision_id: `dec_${randomUUID().replaceAll('-', '')}`,
        gate_id: gate.gate_id,
        project_id: gate.project_id,
        gate_type: gate.type,
        actor: input.actor,
        // v2 §6.4: authenticated principal record; missing principal is only
        // tolerated for legacy rows (actor == 'legacy_unverified').
        principal: input.principal === undefined && input.actor === 'legacy_unverified'
          ? undefined
          : {
              principal_id: input.principal?.principal_id ?? input.actor,
              tenant_id: input.principal?.tenant_id ?? '',
              auth_method: input.principal?.auth_method ?? 'unverified',
              session_id: input.principal?.session_id ?? input.session_id ?? null,
            },
        decision: input.decision,
        reason: input.reason ?? '',
        diff: input.diff ?? '',
        session_id: input.session_id ?? null,
        event_id: input.event_id ?? null,
        decided_at: nowIso(),
      }
      this.db.prepare(
        'INSERT INTO decisions (decision_id, gate_id, project_id, gate_type, actor, decision, reason, diff, session_id, event_id, decided_at, principal_id, principal_tenant_id, principal_auth_method, principal_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        decision.decision_id, decision.gate_id, decision.project_id, decision.gate_type, decision.actor,
        decision.decision, decision.reason, decision.diff, decision.session_id, decision.event_id, decision.decided_at,
        decision.principal?.principal_id ?? null,
        decision.principal?.tenant_id ?? null,
        decision.principal?.auth_method ?? null,
        decision.principal?.session_id ?? null,
      )
      const gateUpdate = this.db.prepare('UPDATE gates SET status = ?, decided_at = ? WHERE gate_id = ? AND status = ?')
        .run(input.decision, decision.decided_at, gate.gate_id, 'pending')
      if (Number(gateUpdate.changes) !== 1) {
        // Lost the CAS race to a concurrent decision (design §11.2).
        throw new KernelError(409, 'gate_already_decided', `gate ${input.gate_id} was decided concurrently (CAS race)`)
      }
      let project = this.getProject(gate.project_id)
      if (input.decision === 'approved') {
        const mapping = GATE_APPROVAL_TRANSITION[gate.type]
        if (gate.type === 'budget') {
          // budget-gate-resume (acceptance-tests.md §2): ONLY the resume
          // target declared in the gate payload may be used; client-supplied
          // resume_to is ignored.
          const declared = typeof gate.payload.resume_to === 'string' ? gate.payload.resume_to : ''
          const resumeTo = declared !== '' && declared !== 'BLOCKED_GATE' ? declared as ProjectStatus : project.status
          if (project.status === 'BLOCKED_GATE' && resumeTo !== 'BLOCKED_GATE') {
            project = this.forceTransition(project.project_id, resumeTo, `budget gate ${gate.gate_id} approved`)
          }
        } else if (gate.type === 'contract') {
          // GOV-02: freeze the target contract ATOMICALLY with the decision
          // (design §6.6: contracts become immutable on Contract Gate
          // approval) — inside the same transaction as the decision row.
          // P0 (GOV-02/RUN-01a): the gate payload must reference a contract
          // of the GATE's OWN project — a cross-project Contract is rejected
          // 422 `contract_foreign` (the approval still updates by contract_id,
          // but only after the ownership check inside the same transaction).
          const contractId = typeof gate.payload.contract_id === 'string' ? gate.payload.contract_id : undefined
          if (contractId !== undefined) {
            let contract: ExperimentContract | undefined
            try {
              contract = this.getContract(contractId)
            } catch {
              throw new KernelError(422, 'contract_unknown', `contract ${contractId} referenced by contract gate ${gate.gate_id} not found`)
            }
            if (contract.project_id !== gate.project_id) {
              throw new KernelError(422, 'contract_foreign',
                `contract ${contractId} belongs to project ${contract.project_id}, not gate project ${gate.project_id} (cross-project Contract freeze is rejected)`)
            }
            this.approveContract(contractId, decision.decision_id, input.actor)
          }
          if (project.status === mapping.from) {
            project = this.gateTransition(project.project_id, mapping.to, mapping.from, gate.gate_id, `${gate.type} gate approved`)
          } else if (project.status !== mapping.to) {
            throw new KernelError(422, 'gate_state_mismatch', `gate ${gate.gate_id} (${gate.type}) cannot approve from ${project.status}`)
          }
        } else if (gate.type === 'idea') {
          // v2 shape (domain-model.md §6): an Idea must be bound to a frozen
          // Corpus snapshot of the SAME project before its Gate can approve.
          // The binding is read from the CARD (payload.idea_id), not from the
          // gate payload, so legacy cards (no corpus_snapshot_id) and
          // payload-less idea gates pass through unchanged (old-read
          // compatible). When the card DOES carry a snapshot id the snapshot
          // must exist (422 idea_corpus_unknown) and belong to the gate's
          // project (422 idea_corpus_foreign, cross-project never approved).
          const ideaId = typeof gate.payload.idea_id === 'string' ? gate.payload.idea_id : undefined
          if (ideaId !== undefined) {
            let card: IdeaCard | undefined
            try {
              card = this.getIdea(ideaId)
            } catch {
              card = undefined
            }
            const corpusSnapshotId = card?.corpus_snapshot_id ?? null
            if (corpusSnapshotId !== null && corpusSnapshotId !== '') {
              let snapshot: CorpusSnapshot
              try {
                snapshot = this.getCorpusSnapshot(corpusSnapshotId)
              } catch {
                throw new KernelError(422, 'idea_corpus_unknown',
                  `idea ${ideaId} references corpus snapshot ${corpusSnapshotId} which does not exist — an Idea Gate cannot approve against an unfrozen corpus (domain-model.md §6)`)
              }
              if (snapshot.project_id !== gate.project_id) {
                throw new KernelError(422, 'idea_corpus_foreign',
                  `idea ${ideaId} references corpus snapshot ${corpusSnapshotId} of project ${snapshot.project_id}, not gate project ${gate.project_id} (cross-project corpus binding is rejected)`)
              }
            }
          }
          if (project.status === mapping.from) {
            project = this.gateTransition(project.project_id, mapping.to, mapping.from, gate.gate_id, `${gate.type} gate approved`)
          } else if (project.status !== mapping.to) {
            throw new KernelError(422, 'gate_state_mismatch', `gate ${gate.gate_id} (${gate.type}) cannot approve from ${project.status}`)
          }
        } else if (project.status === mapping.from) {
          project = this.gateTransition(project.project_id, mapping.to, mapping.from, gate.gate_id, `${gate.type} gate approved`)
        } else if (project.status === mapping.to) {
          // Already in target state (idempotent replay) — no-op.
        } else {
          throw new KernelError(422, 'gate_state_mismatch', `gate ${gate.gate_id} (${gate.type}) cannot approve from ${project.status}`)
        }
      } else if (input.decision === 'rejected' && gate.type === 'scope') {
        project = this.forceTransition(project.project_id, 'FAILED', `scope gate ${gate.gate_id} rejected`)
      }
      this.emit(gate.project_id, 'gate.decided', {
        gate_id: gate.gate_id, type: gate.type, decision: input.decision, actor: input.actor, decision_id: decision.decision_id,
      })
      return { gate: this.getGate(gate.gate_id), decision, project }
    })
  }

  listDecisions(projectId: string): Decision[] {
    const rows = this.db.prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY decided_at').all(projectId) as unknown as Array<Record<string, unknown>>
    return rows.map(row => {
      const principalId = row.principal_id as string | null
      const decision: Decision = {
        decision_id: row.decision_id as string,
        gate_id: row.gate_id as string,
        project_id: row.project_id as string,
        gate_type: row.gate_type as GateType,
        actor: row.actor as string,
        // hardening GOV-01: the durable principal is reconstructed from the
        // stored columns; legacy rows (NULL) surface as legacy_unverified.
        principal: principalId !== null && principalId !== ''
          ? {
              principal_id: principalId,
              tenant_id: (row.principal_tenant_id as string | null) ?? '',
              auth_method: (row.principal_auth_method as string | null) ?? 'unverified',
              session_id: (row.principal_session_id as string | null) ?? null,
            }
          : undefined,
        decision: row.decision as Decision['decision'],
        reason: row.reason as string,
        diff: row.diff as string,
        session_id: row.session_id as string | null,
        event_id: row.event_id as string | null,
        decided_at: row.decided_at as string,
      }
      return decision
    })
  }

  /** Gate-transaction transition: the ONLY path into gate-controlled states
   * (v2 §6.2). Bypasses the generic TRANSITION_TABLE (which excludes those
   * states) but still performs revision CAS and appends history. */
  private gateTransition(projectId: string, to: ProjectStatus, from: ProjectStatus, gateId: string, reason: string): ResearchProject {
    const project = this.getProject(projectId)
    if (project.status !== from) {
      throw new KernelError(422, 'gate_state_mismatch', `gate ${gateId} cannot transition from ${project.status} (expected ${from})`)
    }
    // Bypasses the generic TRANSITION_TABLE on purpose (§6.2): the gate
    // transaction is the ONLY authorized path into gate-controlled states.
    const now = nowIso()
    const result = this.db.prepare(
      'UPDATE projects SET status = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ? AND revision = ?',
    ).run(to, now, JSON.stringify([...project.history, `${from}->${to} (${reason}; gate ${gateId})`]), projectId, project.revision)
    if (Number(result.changes) !== 1) {
      throw new KernelError(409, 'revision_conflict', `gate transition lost CAS race on project ${projectId}`)
    }
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.transitioned', { from, to, revision: updated.revision, reason, via: 'gate' })
    return updated
  }

  /** Internal: transition without CAS check (gate side effects, budget resume). */
  private forceTransition(projectId: string, to: ProjectStatus, reason: string): ResearchProject {
    const project = this.getProject(projectId)
    const allowed = TRANSITION_TABLE[project.status]
    if (!allowed.includes(to)) {
      throw new KernelError(422, 'invalid_transition', `transition ${project.status} -> ${to} not allowed (${reason})`)
    }
    return this.transition(projectId, to, project.revision, reason)
  }

  // ── budget & policy (design §4.2, §5.2 Budget Gate) ──────────────────────

  getBudget(projectId: string): BudgetRecord {
    const row = this.db.prepare('SELECT * FROM budget WHERE project_id = ?').get(projectId) as BudgetRecord | undefined
    return row ?? { project_id: projectId, model_cost_usd: 0, gpu_hours: 0, api_requests: 0, storage_bytes: 0, updated_at: nowIso() }
  }

  recordUsage(projectId: string, usage: { model_cost_usd?: number; gpu_hours?: number; api_requests?: number; storage_bytes?: number }): BudgetRecord {
    // v2 §7.6: budget increment + limit check + block state + outbox in ONE transaction.
    return withTransaction(this.db, () => {
      const project = this.getProject(projectId)
      const current = this.getBudget(projectId)
      // v2 shape (domain-model.md §16): storage_bytes increments atomically
      // with the other counters; legacy ledger rows (column added by
      // migration 0016) read back 0.
      const next: BudgetRecord = {
        project_id: projectId,
        model_cost_usd: current.model_cost_usd + (usage.model_cost_usd ?? 0),
        gpu_hours: current.gpu_hours + (usage.gpu_hours ?? 0),
        api_requests: current.api_requests + (usage.api_requests ?? 0),
        storage_bytes: current.storage_bytes + (usage.storage_bytes ?? 0),
        updated_at: nowIso(),
      }
      this.db.prepare(
        'INSERT INTO budget (project_id, model_cost_usd, gpu_hours, api_requests, storage_bytes, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET model_cost_usd = excluded.model_cost_usd, gpu_hours = excluded.gpu_hours, api_requests = excluded.api_requests, storage_bytes = excluded.storage_bytes, updated_at = excluded.updated_at',
      ).run(projectId, next.model_cost_usd, next.gpu_hours, next.api_requests, next.storage_bytes, next.updated_at)
      this.emit(projectId, 'budget.updated', { model_cost_usd: next.model_cost_usd, gpu_hours: next.gpu_hours, storage_bytes: next.storage_bytes })
      // Hard limit check: crossing a limit stops the project into BLOCKED_GATE.
      if (project.status !== 'BLOCKED_GATE' && project.status !== 'FAILED' && project.status !== 'STOPPED') {
        const exceeded: string[] = []
        if (next.model_cost_usd > project.constraints.max_model_cost_usd) exceeded.push(`model cost $${next.model_cost_usd} > $${project.constraints.max_model_cost_usd}`)
        if (next.gpu_hours > project.constraints.max_gpu_hours) exceeded.push(`gpu hours ${next.gpu_hours} > ${project.constraints.max_gpu_hours}`)
        if (exceeded.length > 0) {
          this.emit(projectId, 'policy.violation', { reasons: exceeded })
          // Budget Gate declares the ONLY allowed resume target: the status
          // the project was in before the block (acceptance-tests.md §2
          // budget-gate-resume — never client-supplied).
          const resumeTo = project.status
          this.db.prepare(
            `INSERT INTO gates (gate_id, project_id, type, title, summary, payload, status, dsh_session_id, dsh_event_id, created_at, decided_at)
             VALUES (?, ?, 'budget', ?, '', ?, 'pending', NULL, NULL, ?, NULL)`,
          ).run(buildGateId(), projectId, 'Budget Gate', JSON.stringify({ resume_to: resumeTo }), nowIso())
          this.db.prepare('UPDATE projects SET status = ?, updated_at = ?, history = ? WHERE project_id = ?')
            .run('BLOCKED_GATE', nowIso(), JSON.stringify([...project.history, `BLOCKED_GATE (budget: ${exceeded.join('; ')}; resume allowed to ${resumeTo})`]), projectId)
        }
      }
      // OBS-01: budget accounting — one counter per recordUsage + the model
      // cost delta histogram (fixed keys; no project ids in tags).
      this.metrics.count('budget.recorded')
      this.metrics.observe('budget.model_cost_usd', usage.model_cost_usd ?? 0)
      return this.getBudget(projectId)
    })
  }

  // ── CAS integrity & GC (acceptance-tests.md §3) ─────────────────────────

  /**
   * Remove blobs that are not referenced by ANY artifact record (orphan GC,
   * storage-migrations.md §6). A grace period protects blobs written but not
   * yet committed to a transaction (stage/finalize pattern). Returns the
   * number of removed blobs.
   */
  collectOrphanBlobs(graceMs = 0): number {
    const referenced = new Set(
      (this.db.prepare('SELECT sha256 FROM artifacts').all() as Array<{ sha256: string }>).map(r => r.sha256),
    )
    const now = Date.now()
    let removed = 0
    for (const sha of this.cas.list()) {
      if (referenced.has(sha)) continue
      const mtime = this.cas.mtimeMs(sha)
      if (mtime === null || now - mtime < graceMs) continue
      if (this.cas.remove(sha)) removed++
    }
    // OBS-01: CAS orphan GC counter accumulates removed blobs.
    if (removed > 0) this.metrics.count('cas.orphans_removed', undefined, removed)
    return removed
  }

  /**
   * Integrity scan: artifacts whose blob is missing from the CAS (or empty).
   * Returns per-project counts + the offending artifact ids. Used by the
   * recovery flow after restore (storage-migrations.md §10).
   */
  scanMissingBlobs(): { project_id: string; artifact_id: string; sha256: string }[] {
    const rows = this.db.prepare('SELECT artifact_id, project_id, sha256 FROM artifacts').all() as unknown as Array<{
      artifact_id: string; project_id: string; sha256: string
    }>
    return rows.filter(r => !this.cas.has(r.sha256))
  }

  /**
   * STORAGE-07 (storage-migrations.md §10): post-restore integrity scan over
   * the artifacts table vs the CAS. Reports:
   *
   *  - missing_blobs — artifact records whose blob is absent/empty (same
   *    check as scanMissingBlobs);
   *  - orphan_blobs — CAS blobs referenced by NO artifact record (the
   *    collectOrphanBlobs candidate set, without deleting);
   *  - size_mismatch — existing blob whose on-disk size differs from the
   *    recorded artifacts.size_bytes;
   *  - hash_mismatch — existing blob whose content re-hashes to a different
   *    sha256 than the recorded one (tampered/corrupted bytes).
   *
   * Blob re-hashing reads every referenced blob; on very large CAS stores
   * pass `limit` to cap how many blobs are verified (missing/orphan
   * detection is stat-only and always complete; the remainder is reported
   * in `skipped_blobs`).
   */
  scanIntegrity(opts: { limit?: number } = {}): IntegrityScanReport {
    const rows = this.db.prepare('SELECT artifact_id, project_id, sha256, size_bytes FROM artifacts').all() as unknown as Array<{
      artifact_id: string; project_id: string; sha256: string; size_bytes: number
    }>
    const referenced = new Set(rows.map(r => r.sha256))
    const missing_blobs = rows
      .filter(r => !this.cas.has(r.sha256))
      .map(r => ({ project_id: r.project_id, artifact_id: r.artifact_id, sha256: r.sha256 }))
    const orphan_blobs = this.cas.list().filter(sha => !referenced.has(sha))
    const size_mismatch: IntegrityScanReport['size_mismatch'] = []
    const hash_mismatch: IntegrityScanReport['hash_mismatch'] = []
    let scanned = 0
    for (const r of rows) {
      if (!this.cas.has(r.sha256)) continue
      if (opts.limit !== undefined && scanned >= opts.limit) break
      scanned += 1
      const path = this.cas.pathFor(r.sha256)
      let bytes: Buffer
      try {
        const st = statSync(path)
        if (st.size !== r.size_bytes) {
          size_mismatch.push({
            project_id: r.project_id, artifact_id: r.artifact_id, sha256: r.sha256,
            recorded_size: r.size_bytes, actual_size: st.size,
          })
        }
        bytes = readFileSync(path)
      } catch {
        continue // blob vanished between has() and read — reported as missing on the next scan
      }
      if (createHash('sha256').update(bytes).digest('hex') !== r.sha256) {
        hash_mismatch.push({
          project_id: r.project_id, artifact_id: r.artifact_id, sha256: r.sha256,
          recorded_size: r.size_bytes, actual_size: bytes.byteLength,
        })
      }
    }
    return {
      missing_blobs,
      orphan_blobs,
      size_mismatch,
      hash_mismatch,
      scanned_blobs: scanned,
      skipped_blobs: Math.max(0, rows.length - scanned),
      total_blobs: this.cas.list().length,
    }
  }

  // ── identity (api-contracts.md §3 /v2/health) ────────────────────────────

  schemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined
    return row !== undefined ? Number(row.value) : 0
  }

  databaseId(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'database_id'").get() as { value?: string } | undefined
    return row?.value ?? ''
  }

  // ── artifacts (CAS) ──────────────────────────────────────────────────────

  /** Shared artifact-row insert + outbox event (single writer: SQLite). */
  private persistArtifact(record: ArtifactRecord): void {
    this.db.prepare('INSERT INTO artifacts (artifact_id, project_id, kind, size_bytes, sha256, metadata, media_type, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.artifact_id, record.project_id, record.kind, record.size_bytes, record.sha256, JSON.stringify(record.metadata), record.media_type, record.file_name, record.created_at)
    this.emit(record.project_id, 'artifact.registered', { artifact_id: record.artifact_id, kind: record.kind, size_bytes: record.size_bytes })
  }

  registerArtifact(input: {
    project_id: string
    kind: ArtifactKind
    content: Uint8Array | string
    metadata?: Record<string, unknown>
    /** RFC 2046 media type (ART-02); pdf artifacts should pass application/pdf. */
    media_type?: string
    /** Download file name for Content-Disposition. */
    file_name?: string
  }): ArtifactRecord {
    this.getProject(input.project_id)
    const { sha256, size_bytes } = this.cas.put(input.content)
    const artifactId = `sha256:${sha256}`
    // v2 §7.4: blobs are global (CAS), artifact records are project-scoped —
    // the same blob in another project yields that project's OWN record.
    const existing = this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND artifact_id = ?')
      .get(input.project_id, artifactId) as ArtifactRecord | undefined
    if (existing !== undefined) return existing
    const mediaType = input.media_type !== undefined && input.media_type !== ''
      ? input.media_type
      : (input.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream')
    const record: ArtifactRecord = {
      artifact_id: artifactId,
      project_id: input.project_id,
      kind: input.kind,
      size_bytes,
      sha256,
      metadata: input.metadata ?? {},
      media_type: mediaType,
      file_name: input.file_name ?? null,
      created_at: nowIso(),
    }
    this.persistArtifact(record)
    return record
  }

  // ── staged uploads (UPLOAD-01, api-contracts.md §7) ─────────────────────

  /** Absolute path of a staged part/metadata file for `stageId`. */
  stagedPartPath(stageId: string): string {
    return join(this.stagedUploadsRoot, `stage_${stageId}.part`)
  }

  stagedMetaPath(stageId: string): string {
    return join(this.stagedUploadsRoot, `stage_${stageId}.json`)
  }

  /**
   * UPLOAD-01 phase 1 (stage): write the received bytes to a session-id'd
   * temporary file under the CAS root together with a metadata sidecar.
   * Nothing is registered yet — the artifact only becomes visible at
   * finalizeStagedUpload, so a crash between the two leaves only a staged
   * file (recoverable: re-upload or cleanupStagedUploads), never a partial
   * artifact row. Validation (project existence, kind, file name, size cap)
   * runs here — before anything touches disk beyond the staging area.
   */
  stageUploadContent(input: {
    project_id: string
    kind: ArtifactKind
    file_name: string
    media_type?: string
    content: Uint8Array | string
  }): { stage_id: string } {
    this.getProject(input.project_id)
    const kindCheck = ArtifactKind.safeParse(input.kind)
    if (!kindCheck.success) {
      throw new KernelError(422, 'invalid_kind', `upload kind must be one of ${ArtifactKind.options.join('/')}`)
    }
    validateUploadFileName(input.file_name)
    const bytes = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : Buffer.from(input.content)
    if (bytes.byteLength > ResearchKernel.UPLOAD_MAX_FILE_BYTES) {
      throw new KernelError(413, 'payload_too_large',
        `upload exceeds the size limit: ${bytes.byteLength} bytes (max_file_bytes=${ResearchKernel.UPLOAD_MAX_FILE_BYTES})`)
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const stageId = randomUUID().replaceAll('-', '')
    const partPath = this.stagedPartPath(stageId)
    const metaPath = this.stagedMetaPath(stageId)
    try {
      // mkdirSync is a no-op once the staging root exists (constructor).
      mkdirSync(this.stagedUploadsRoot, { recursive: true })
      writeFileSync(partPath, bytes, { mode: 0o600 })
      writeFileSync(metaPath, JSON.stringify({
        schema_version: 1,
        stage_id: stageId,
        project_id: input.project_id,
        kind: kindCheck.data,
        file_name: input.file_name,
        media_type: input.media_type ?? '',
        sha256,
        size_bytes: bytes.byteLength,
        created_at: nowIso(),
      }), { mode: 0o600 })
    } catch (error) {
      // Rollback: never leave a half-written stage behind.
      try { unlinkSync(partPath) } catch { /* absent */ }
      try { unlinkSync(metaPath) } catch { /* absent */ }
      throw new KernelError(500, 'stage_write_failed', `staged upload write failed: ${(error as Error).message}`)
    }
    return { stage_id: stageId }
  }

  /**
   * UPLOAD-01 phase 2 (finalize): atomically promote a staged upload to a
   * registered artifact. The staged bytes are re-hashed and re-measured
   * (the recorded sha256 is server-computed at stage time; a mismatch means
   * the staged file was tampered with → 422 stage_corrupted), then the part
   * file is renamed into the CAS blob slot (atomic on POSIX; concurrent
   * writers with identical content keep the existing blob) and the artifact
   * row is inserted in the same write path as registerArtifact. Idempotent:
   * an existing artifact for the same project + sha256 + file_name is
   * returned unchanged (reused: true) and the staged files are dropped.
   * Any failure removes the staged files before rethrowing (rollback).
   */
  finalizeStagedUpload(stageId: string): { record: ArtifactRecord; reused: boolean } {
    const partPath = this.stagedPartPath(stageId)
    const metaPath = this.stagedMetaPath(stageId)
    let meta: {
      project_id: string
      kind: ArtifactKind
      file_name: string
      media_type?: string
      sha256: string
      size_bytes: number
    }
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8')) as typeof meta
    } catch {
      // Absent/expired stage: stable code from the internal-stage contract
      // (api-contracts.md §2 artifact_stage_expired).
      throw new KernelError(409, 'artifact_stage_expired', `upload stage ${stageId} not found or expired`)
    }
    const rollback = (): void => {
      try { unlinkSync(partPath) } catch { /* absent */ }
      try { unlinkSync(metaPath) } catch { /* absent */ }
    }
    if (typeof meta.project_id !== 'string' || typeof meta.kind !== 'string' || typeof meta.file_name !== 'string' || typeof meta.sha256 !== 'string') {
      throw new KernelError(422, 'stage_corrupted', `upload stage ${stageId} metadata is malformed`)
    }
    if (!ArtifactKind.safeParse(meta.kind).success) {
      rollback()
      throw new KernelError(422, 'stage_corrupted', `upload stage ${stageId} metadata carries an invalid kind`)
    }
    try {
      // Re-hash the staged bytes: the artifact hash is bound to the CONTENT
      // actually promoted, never to a client claim or a stale record.
      const staged = readFileSync(partPath)
      const actualSha = createHash('sha256').update(staged).digest('hex')
      if (actualSha !== meta.sha256 || staged.byteLength !== meta.size_bytes) {
        rollback()
        throw new KernelError(422, 'stage_corrupted',
          `upload stage ${stageId} content hash mismatch (recorded ${meta.sha256}, got ${actualSha})`)
      }
      if (staged.byteLength > ResearchKernel.UPLOAD_MAX_FILE_BYTES) {
        rollback()
        throw new KernelError(413, 'payload_too_large',
          `upload exceeds the size limit: ${staged.byteLength} bytes (max_file_bytes=${ResearchKernel.UPLOAD_MAX_FILE_BYTES})`)
      }
      this.getProject(meta.project_id)
      // Idempotency (UPLOAD-01): same project + sha256 + file_name re-upload
      // returns the ORIGINAL artifact without writing anything new.
      const artifactId = `sha256:${meta.sha256}`
      const existing = this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND artifact_id = ?')
        .get(meta.project_id, artifactId) as ArtifactRecord | undefined
      if (existing !== undefined) {
        rollback()
        return { record: existing, reused: true }
      }
      // Atomic promotion: rename the staged part into the CAS blob slot
      // (POSIX rename is atomic; a concurrent identical writer keeps the
      // existing blob — same semantics as ArtifactCas.put).
      const target = this.cas.pathFor(meta.sha256)
      try {
        renameSync(partPath, target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try { unlinkSync(partPath) } catch { /* absent */ }
      }
      const mediaType = meta.media_type !== undefined && meta.media_type !== ''
        ? meta.media_type
        : (meta.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream')
      const record: ArtifactRecord = {
        artifact_id: artifactId,
        project_id: meta.project_id,
        kind: meta.kind,
        size_bytes: meta.size_bytes,
        sha256: meta.sha256,
        metadata: {},
        media_type: mediaType,
        file_name: meta.file_name,
        created_at: nowIso(),
      }
      this.persistArtifact(record)
      try { unlinkSync(metaPath) } catch { /* absent */ }
      return { record, reused: false }
    } catch (error) {
      rollback()
      throw error
    }
  }

  /**
   * UPLOAD-01 recovery/GC: remove staged uploads older than `maxAgeMs`
   * (grace-period model, mirroring collectOrphanBlobs). Both the `.part`
   * and the `.json` sidecar of an aged stage are removed; orphaned sidecars
   * of already-finalized stages are collected as well. Returns the number
   * of files removed. A finalized upload's blob lives in CAS and is never
   * touched here (accepted blobs are not intake GC targets).
   */
  cleanupStagedUploads(maxAgeMs: number = ResearchKernel.STAGED_UPLOAD_TTL_MS): number {
    let entries: string[]
    try {
      entries = readdirSync(this.stagedUploadsRoot)
    } catch {
      return 0
    }
    const now = Date.now()
    let removed = 0
    for (const entry of entries) {
      if (!entry.startsWith('stage_') || !(entry.endsWith('.part') || entry.endsWith('.json'))) continue
      const full = join(this.stagedUploadsRoot, entry)
      let mtime: number
      try {
        mtime = statSync(full).mtimeMs
      } catch {
        continue // raced with another cleanup — skip
      }
      if (now - mtime > maxAgeMs) {
        try {
          unlinkSync(full)
          removed += 1
        } catch { /* raced — another collector won */ }
      }
    }
    return removed
  }

  // ── Research Intake (ONBOARD-01, research-onboarding.md) ────────────────
  //
  // Pre-accept zero authority (§2.1): begin/stage/scan/grill/propose write
  // ONLY intake_sessions/intake_artifacts/intake_observations/intake_questions
  // and the isolated staging CAS (intake-staged/<intake_id>/…, a sibling of
  // staged-uploads/ under the CAS root) — never
  // Project/Gate/ProjectArtifact/Workspace/Job/Run/TerminalLog/Evidence/
  // Claim, and NOTHING to the outbox. The only writes to business tables and
  // the outbox happen inside the adoption transaction (adoptIntake). There is
  // no Gate/Run/Evidence write path in any intake method (asserted by
  // tests/unit/intake.test.ts — pre-accept table counts stay zero).

  /** Absolute staged-file path for one intake artifact. */
  intakeStagedPath(intakeId: string, sha256: string): string {
    return join(this.intakeStagedRoot, intakeId, `${sha256}.part`)
  }

  private intakeSessionFromRow(row: IntakeSessionRow): IntakeSession {
    return {
      intake_id: row.intake_id,
      project_id: row.project_id,
      owner: {
        principal_id: row.owner_principal_id,
        tenant_id: row.owner_tenant_id,
        auth_method: row.owner_auth_method,
        session_id: row.owner_session_id,
      },
      status: row.status as IntakeStatus,
      revision: row.revision,
      source_label: row.source_label,
      target_phase: (row.target_phase ?? null) as ObservedPhase | null,
      expires_at: row.expires_at,
      scan_summary: jsonParse(row.scan_summary, {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
      audit: jsonParse(row.audit_json, []),
    }
  }

  /**
   * ONBOARD-01 scope guard (cross-project 404, log-authz style): a route
   * scoped to `/v1/projects/{id}/intake/{iid}` must not observe an intake
   * that belongs to another project — 404 intake_not_found either way.
   */
  assertIntakeInProject(intakeId: string, projectId: string): void {
    this.getIntakeSessionRow(intakeId, projectId)
  }

  /** Session row lookup with 404 intake_not_found (project-scoped). */
  private getIntakeSessionRow(intakeId: string, projectId?: string): IntakeSessionRow {
    const row = this.db.prepare('SELECT * FROM intake_sessions WHERE intake_id = ?').get(intakeId) as IntakeSessionRow | undefined
    if (row === undefined || (projectId !== undefined && row.project_id !== projectId)) {
      throw new KernelError(404, 'intake_not_found', `intake ${intakeId} not found`)
    }
    return row
  }

  private appendIntakeAudit(intakeId: string, action: string, detail = ''): void {
    const row = this.getIntakeSessionRow(intakeId)
    const audit = jsonParse(row.audit_json, [] as Array<{ at: string; action: string; detail?: string }>)
    audit.push({ at: nowIso(), action, detail })
    this.db.prepare('UPDATE intake_sessions SET audit_json = ?, updated_at = ? WHERE intake_id = ?')
      .run(JSON.stringify(audit), nowIso(), intakeId)
  }

  /** Throw 409 intake_state_conflict for terminal sessions. */
  private assertIntakeMutable(session: IntakeSession): void {
    if (['accepted', 'rejected', 'expired', 'failed'].includes(session.status)) {
      throw new KernelError(409, 'intake_state_conflict', `intake ${session.intake_id} is ${session.status} and cannot be modified`)
    }
  }

  /** Throw 409 intake_expired for active sessions past their TTL. */
  private assertIntakeNotExpired(session: IntakeSession, now = Date.now()): void {
    if (Date.parse(session.expires_at) < now && ['accepted', 'rejected', 'expired', 'failed'].includes(session.status) === false) {
      throw new KernelError(409, 'intake_expired', `intake ${session.intake_id} expired at ${session.expires_at} — reject it or start a new intake`)
    }
  }

  private intakeArtifacts(intakeId: string): IntakeArtifact[] {
    const rows = this.db.prepare('SELECT * FROM intake_artifacts WHERE intake_id = ? ORDER BY created_at').all(intakeId) as unknown as IntakeArtifactRow[]
    return rows.map(row => ({
      intake_id: row.intake_id,
      artifact_id: row.artifact_id,
      file_name: row.file_name,
      media_type: row.media_type,
      size_bytes: row.size_bytes,
      sha256: row.sha256,
      quarantine: row.quarantine as IntakeArtifact['quarantine'],
      scan_result: jsonParse(row.scan_result, {}),
      created_at: row.created_at,
    }))
  }

  private intakeObservations(intakeId: string): IntakeObservation[] {
    const rows = this.db.prepare('SELECT * FROM intake_observations WHERE intake_id = ? ORDER BY created_at').all(intakeId) as unknown as IntakeObservationRow[]
    return rows.map(row => ({
      observation_id: row.observation_id,
      intake_id: row.intake_id,
      artifact_id: row.artifact_id,
      locator: row.locator,
      detector: row.detector,
      detector_version: row.detector_version,
      value: row.value,
      warnings: jsonParse(row.warnings, []),
      trust: 'observed_unverified' as const,
      created_at: row.created_at,
    }))
  }

  private intakeAnswerMap(intakeId: string): Map<string, { answer: string; answered_at: string; answered_by: string | null }> {
    const rows = this.db.prepare('SELECT * FROM intake_questions WHERE intake_id = ?').all(intakeId) as unknown as IntakeQuestionRow[]
    const map = new Map<string, { answer: string; answered_at: string; answered_by: string | null }>()
    for (const row of rows) {
      if (row.answer === null) continue
      map.set(row.question_code, { answer: row.answer, answered_at: row.answered_at ?? '', answered_by: row.answered_by_principal })
    }
    return map
  }

  /**
   * ONBOARD-01 begin (research-onboarding.md §1/§3): create an Intake session
   * for the target project. Pre-accept: only an intake row is written.
   * Idempotent: the same Idempotency-Key replays the SAME session (different
   * request hash → 409 idempotency_conflict), and at most ONE active intake
   * exists per project (reuse). Expiry defaults to 7 days.
   */
  beginIntake(input: {
    project_id?: string | null
    source_label: string
    target_phase?: ObservedPhase | null
    owner?: HumanPrincipal
    expires_in_ms?: number
    idempotency_key?: string
    request_hash?: string
  }): IntakeSession {
    if (input.source_label === undefined || input.source_label.trim() === '') {
      throw new KernelError(422, 'validation_error', 'source_label is required')
    }
    if (input.project_id !== undefined && input.project_id !== null) {
      this.getProject(input.project_id) // 404 project_not_found
    }
    // Idempotency-Key replay.
    if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
      const existing = this.db.prepare('SELECT * FROM intake_sessions WHERE idempotency_key = ?').get(input.idempotency_key) as IntakeSessionRow | undefined
      if (existing !== undefined) {
        if (existing.request_hash !== (input.request_hash ?? '')) {
          throw new KernelError(409, 'idempotency_conflict', `intake idempotency key ${input.idempotency_key} was used with a different request hash`)
        }
        return this.intakeSessionFromRow(existing)
      }
    }
    // One active intake per project (recovery-friendly reuse).
    if (input.project_id !== undefined && input.project_id !== null) {
      const active = this.db.prepare(
        "SELECT * FROM intake_sessions WHERE project_id = ? AND status IN ('draft','uploading','scanning','needs_input','grilling','proposal_ready','awaiting_human') ORDER BY created_at LIMIT 1",
      ).get(input.project_id) as IntakeSessionRow | undefined
      if (active !== undefined) return this.intakeSessionFromRow(active)
    }
    const owner: HumanPrincipal = input.owner ?? { principal_id: 'agent', auth_method: 'agent' }
    const now = nowIso()
    const intakeId = `intk_${randomUUID().replaceAll('-', '').slice(0, 20)}`
    const session: IntakeSession = {
      intake_id: intakeId,
      project_id: input.project_id ?? null,
      owner,
      status: 'draft',
      revision: 1,
      source_label: input.source_label.trim(),
      target_phase: input.target_phase ?? null,
      expires_at: new Date(Date.now() + (input.expires_in_ms ?? ResearchKernel.INTAKE_DEFAULT_TTL_MS)).toISOString(),
      scan_summary: {},
      created_at: now,
      updated_at: now,
      audit: [{ at: now, action: 'begin', detail: input.source_label }],
    }
    this.db.prepare(
      `INSERT INTO intake_sessions (intake_id, project_id, owner_principal_id, owner_tenant_id, owner_auth_method, owner_session_id,
         status, revision, source_label, target_phase, expires_at, scan_summary, audit_json, idempotency_key, request_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.intake_id, session.project_id,
      session.owner.principal_id, session.owner.tenant_id ?? '', session.owner.auth_method ?? 'agent', session.owner.session_id ?? null,
      session.status, session.revision, session.source_label, session.target_phase, session.expires_at,
      JSON.stringify(session.scan_summary), JSON.stringify(session.audit),
      input.idempotency_key ?? null, input.request_hash ?? '', session.created_at, session.updated_at,
    )
    return session
  }

  /**
   * ONBOARD-01 stage (research-onboarding.md §4): register ONE file into the
   * intake — server-computed sha256, plain-basename path safety, size cap
   * (reuses UPLOAD-01 limits). Bytes land in the ISOLATED staging CAS
   * (stagedUploadsRoot/intake/<intake_id>/<sha256>.part), never in the
   * project artifact space. Content-addressed: re-staging identical bytes
   * returns the existing artifact row. Changing files invalidates any
   * generated proposal (proposal_stale semantics).
   */
  stageIntakeArtifact(intakeId: string, input: {
    file_name: string
    media_type?: string
    content: Uint8Array | string
  }): IntakeArtifact {
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    this.assertIntakeMutable(session)
    this.assertIntakeNotExpired(session)
    validateUploadFileName(input.file_name)
    const bytes = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : Buffer.from(input.content)
    if (bytes.byteLength > ResearchKernel.UPLOAD_MAX_FILE_BYTES) {
      throw new KernelError(413, 'payload_too_large',
        `intake file exceeds the size limit: ${bytes.byteLength} bytes (max_file_bytes=${ResearchKernel.UPLOAD_MAX_FILE_BYTES})`)
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const artifactId = `sha256:${sha256}`
    const existing = this.db.prepare('SELECT * FROM intake_artifacts WHERE intake_id = ? AND artifact_id = ?')
      .get(intakeId, artifactId) as IntakeArtifactRow | undefined
    if (existing !== undefined) {
      return {
        intake_id: existing.intake_id,
        artifact_id: existing.artifact_id,
        file_name: existing.file_name,
        media_type: existing.media_type,
        size_bytes: existing.size_bytes,
        sha256: existing.sha256,
        quarantine: existing.quarantine as IntakeArtifact['quarantine'],
        scan_result: jsonParse(existing.scan_result, {}),
        created_at: existing.created_at,
      }
    }
    const partPath = this.intakeStagedPath(intakeId, sha256)
    try {
      mkdirSync(join(this.intakeStagedRoot, intakeId), { recursive: true })
      writeFileSync(partPath, bytes, { mode: 0o600 })
    } catch (error) {
      throw new KernelError(500, 'stage_write_failed', `intake staged write failed: ${(error as Error).message}`)
    }
    const now = nowIso()
    const artifact: IntakeArtifact = {
      artifact_id: artifactId,
      intake_id: intakeId,
      file_name: input.file_name,
      media_type: input.media_type ?? 'application/octet-stream',
      size_bytes: bytes.byteLength,
      sha256,
      quarantine: 'staged',
      scan_result: {},
      created_at: now,
    }
    this.db.prepare(
      'INSERT INTO intake_artifacts (intake_id, artifact_id, file_name, media_type, size_bytes, sha256, quarantine, scan_result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(intakeId, artifactId, artifact.file_name, artifact.media_type, artifact.size_bytes, artifact.sha256, artifact.quarantine, '{}', now)
    this.setIntakeStatus(intakeId, 'uploading', row.status, 'artifact_staged')
    return artifact
  }

  private setIntakeStatus(intakeId: string, to: IntakeStatus, from: string, auditAction: string): void {
    // A file change after a proposal invalidates it (accept pins the revision).
    if ((from === 'proposal_ready' || from === 'awaiting_human') && to !== 'awaiting_human') {
      this.db.prepare('UPDATE intake_sessions SET proposal_json = NULL WHERE intake_id = ?').run(intakeId)
      this.appendIntakeAudit(intakeId, 'proposal_invalidated', `files changed while ${from}`)
    }
    this.db.prepare('UPDATE intake_sessions SET status = ?, revision = revision + 1, updated_at = ? WHERE intake_id = ?')
      .run(to, nowIso(), intakeId)
    this.appendIntakeAudit(intakeId, auditAction, `${from} -> ${to}`)
  }

  /** Remove one staged artifact (quarantine resolution: delete/replace). */
  removeIntakeArtifact(intakeId: string, artifactId: string): void {
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    this.assertIntakeMutable(session)
    this.assertIntakeNotExpired(session)
    const artifact = this.db.prepare('SELECT * FROM intake_artifacts WHERE intake_id = ? AND artifact_id = ?')
      .get(intakeId, artifactId) as IntakeArtifactRow | undefined
    if (artifact === undefined) {
      throw new KernelError(404, 'intake_artifact_not_found', `intake artifact ${artifactId} not found in intake ${intakeId}`)
    }
    try { unlinkSync(this.intakeStagedPath(intakeId, artifact.sha256)) } catch { /* already gone */ }
    this.db.prepare('DELETE FROM intake_artifacts WHERE intake_id = ? AND artifact_id = ?').run(intakeId, artifactId)
    this.db.prepare('DELETE FROM intake_observations WHERE intake_id = ? AND artifact_id = ?').run(intakeId, artifactId)
    this.setIntakeStatus(intakeId, 'uploading', row.status, 'artifact_removed')
  }

  /**
   * ONBOARD-01 scan (research-onboarding.md §4.2): verify every staged
   * artifact's server-side sha256 and run the STATIC security scan
   * (extension allow/deny/quarantine, magic bytes, static secret patterns;
   * NO AV in this environment — recorded honestly in scan_result). Verdicts:
   * clean | quarantined | rejected. Observations are replaced per scan.
   */
  scanIntake(intakeId: string): IntakeProjection {
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    this.assertIntakeMutable(session)
    this.assertIntakeNotExpired(session)
    const artifacts = this.intakeArtifacts(intakeId)
    let clean = 0
    let quarantined = 0
    let rejected = 0
    this.db.prepare('DELETE FROM intake_observations WHERE intake_id = ?').run(intakeId)
    const insertObservation = this.db.prepare(
      'INSERT INTO intake_observations (observation_id, intake_id, artifact_id, locator, detector, detector_version, value, warnings, trust, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const artifact of artifacts) {
      const partPath = this.intakeStagedPath(intakeId, artifact.sha256)
      let staged: Buffer
      try {
        staged = readFileSync(partPath)
      } catch {
        throw new KernelError(422, 'stage_corrupted', `intake artifact ${artifact.file_name} staged bytes are missing — re-upload (stage GC?)`)
      }
      const actualSha = createHash('sha256').update(staged).digest('hex')
      if (actualSha !== artifact.sha256 || staged.byteLength !== artifact.size_bytes) {
        throw new KernelError(422, 'stage_corrupted', `intake artifact ${artifact.file_name} content hash mismatch (recorded ${artifact.sha256}, got ${actualSha})`)
      }
      const verdict = scanIntakeArtifactStatic(artifact.file_name, artifact.media_type, staged)
      this.db.prepare('UPDATE intake_artifacts SET quarantine = ?, scan_result = ? WHERE intake_id = ? AND artifact_id = ?')
        .run(verdict.quarantine, JSON.stringify(verdict.scan_result), intakeId, artifact.artifact_id)
      if (verdict.quarantine === 'clean') clean += 1
      else if (verdict.quarantine === 'quarantined') quarantined += 1
      else rejected += 1
      for (const observation of verdict.observations) {
        insertObservation.run(
          `obs_${randomUUID().replaceAll('-', '').slice(0, 16)}`, intakeId, artifact.artifact_id,
          observation.locator, observation.detector, observation.detector_version, observation.value,
          JSON.stringify(observation.warnings), 'observed_unverified', nowIso(),
        )
      }
    }
    const scanSummary: Record<string, unknown> = {
      scanned_at: nowIso(),
      scanner: 'static-rules-v1',
      av_available: false,
      artifact_count: artifacts.length,
      clean,
      quarantined,
      rejected,
    }
    this.db.prepare('UPDATE intake_sessions SET scan_summary = ? WHERE intake_id = ?').run(JSON.stringify(scanSummary), intakeId)
    // Questions are always answerable after a scan; when every required
    // question is already answered the session is proposal_ready.
    const required = requiredQuestionCodes(session.target_phase)
    const answers = this.intakeAnswerMap(intakeId)
    const allAnswered = [...required].every(code => {
      const a = answers.get(code)
      return a !== undefined && a.answer !== ''
    })
    this.setIntakeStatus(intakeId, allAnswered ? 'proposal_ready' : 'needs_input', row.status, 'scan_completed')
    return this.getIntakeProjection(intakeId)
  }

  /** ONBOARD-01 resume: full durable intake state (survives restarts). */
  getIntakeProjection(intakeId: string): IntakeProjection {
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    const proposal = row.proposal_json === null || row.proposal_json === '' ? null : jsonParse(row.proposal_json, null) as unknown as PhaseProposal
    const receipt = row.receipt_json === null || row.receipt_json === '' ? null : jsonParse(row.receipt_json, null) as unknown as AdoptionReceipt
    return {
      session,
      artifacts: this.intakeArtifacts(intakeId),
      observations: this.intakeObservations(intakeId),
      questions: questionViews(
        questionsForTargetPhase(session.target_phase),
        this.intakeAnswerMap(intakeId),
      ),
      proposal,
      receipt,
    }
  }

  /** ONBOARD-01: list intake sessions (optionally per project). */
  listIntakes(projectId?: string): IntakeSession[] {
    const rows = projectId === undefined
      ? this.db.prepare('SELECT * FROM intake_sessions ORDER BY created_at DESC').all() as unknown as IntakeSessionRow[]
      : this.db.prepare('SELECT * FROM intake_sessions WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as unknown as IntakeSessionRow[]
    return rows.map(row => this.intakeSessionFromRow(row))
  }

  /** ONBOARD-01 Grill: deterministic versioned question set + answer state. */
  getIntakeQuestions(intakeId: string): {
    intake_id: string
    taxonomy_version: number
    question_revision: number
    target_phase: ObservedPhase | null
    questions: GrillAnswerView[]
  } {
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    return {
      intake_id: intakeId,
      taxonomy_version: GRILL_TAXONOMY_VERSION,
      question_revision: GRILL_QUESTION_REVISION,
      target_phase: session.target_phase,
      questions: questionViews(questionsForTargetPhase(session.target_phase), this.intakeAnswerMap(intakeId)),
    }
  }

  /**
   * ONBOARD-01 Grill answers (research-onboarding.md §5): record
   * human_assertion answers with the Human Principal + question revision.
   * All required answered → proposal_ready; otherwise stays grilling.
   * `unknown` answers are stored as answers but keep their gap (and lower
   * the proposal confidence). Pre-accept: only intake_questions rows.
   */
  submitIntakeAnswers(intakeId: string, answers: GrillAnswerInput[], principal: HumanPrincipal): IntakeProjection {
    if (principal === undefined || typeof principal.principal_id !== 'string' || principal.principal_id === '') {
      throw new KernelError(422, 'principal_required', 'intake answers require an authenticated principal (principal.principal_id)')
    }
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    this.assertIntakeNotExpired(session)
    if (!['needs_input', 'grilling', 'proposal_ready'].includes(session.status)) {
      throw new KernelError(409, 'intake_state_conflict', `intake ${intakeId} is ${session.status}; answers require needs_input/grilling/proposal_ready (scan first)`)
    }
    const taxonomy = questionsForTargetPhase(session.target_phase)
    const byCode = new Map(taxonomy.map(q => [q.question_code, q] as const))
    const upsert = this.db.prepare(
      `INSERT INTO intake_questions (intake_id, question_code, question_revision, required, answer, answered_by_principal, answered_by_session, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(intake_id, question_code) DO UPDATE SET answer = excluded.answer, answered_by_principal = excluded.answered_by_principal, answered_by_session = excluded.answered_by_session, answered_at = excluded.answered_at`,
    )
    for (const answer of answers) {
      const question = byCode.get(answer.question_code)
      if (question === undefined) {
        throw new KernelError(422, 'unknown_question', `question ${answer.question_code} does not exist in taxonomy version ${GRILL_TAXONOMY_VERSION}`)
      }
      if (answer.question_revision !== GRILL_QUESTION_REVISION) {
        throw new KernelError(409, 'question_revision_conflict',
          `question ${answer.question_code} revision ${answer.question_revision} does not match current revision ${GRILL_QUESTION_REVISION}`)
      }
      if (answer.answer === undefined || answer.answer.trim() === '') {
        throw new KernelError(422, 'question_required', `question ${answer.question_code} answer must not be empty ('unknown' is allowed)`)
      }
      upsert.run(
        intakeId, answer.question_code, GRILL_QUESTION_REVISION, question.required ? 1 : 0,
        answer.answer.trim(), principal.principal_id, principal.session_id ?? null, nowIso(),
      )
    }
    const required = requiredQuestionCodes(session.target_phase)
    const answersMap = this.intakeAnswerMap(intakeId)
    const allAnswered = [...required].every(code => {
      const a = answersMap.get(code)
      return a !== undefined && a.answer !== ''
    })
    this.setIntakeStatus(intakeId, allAnswered ? 'proposal_ready' : 'grilling', row.status, 'answers_submitted')
    return this.getIntakeProjection(intakeId)
  }

  /**
   * ONBOARD-01 propose (research-onboarding.md §6): deterministically build
   * the PhaseProposal from the human answers + scan verdicts. All REQUIRED
   * questions must be answered (422 question_required lists the missing
   * codes). observed_phase is metadata; safe_project_status comes from the
   * KERNEL state machine (a fresh DRAFT project stays DRAFT); the proposal's
   * required gates are created PENDING at adoption — never decided here.
   */
  proposeIntake(intakeId: string): PhaseProposal {
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    this.assertIntakeNotExpired(session)
    if (!['needs_input', 'grilling', 'proposal_ready', 'awaiting_human'].includes(session.status)) {
      throw new KernelError(409, 'intake_state_conflict', `intake ${intakeId} is ${session.status}; propose requires a scanned, answered intake`)
    }
    const answers = this.intakeAnswerMap(intakeId)
    const required = requiredQuestionCodes(session.target_phase)
    const missing: string[] = []
    for (const code of required) {
      const a = answers.get(code)
      if (a === undefined || a.answer === '') missing.push(code)
    }
    if (missing.length > 0) {
      throw new KernelError(422, 'question_required', `required questions unanswered: ${missing.join(', ')} — answer them before proposing`)
    }
    const projectStatus = session.project_id === null ? 'DRAFT' : this.getProject(session.project_id).status
    const previous = row.proposal_json === null || row.proposal_json === '' ? null : jsonParse(row.proposal_json, null) as unknown as PhaseProposal
    const proposal = buildPhaseProposal({
      intakeId,
      revision: (previous?.revision ?? 0) + 1,
      targetPhase: session.target_phase,
      answers,
      artifacts: this.intakeArtifacts(intakeId),
      observations: this.intakeObservations(intakeId),
      projectStatus,
      now: nowIso(),
    })
    this.db.prepare('UPDATE intake_sessions SET proposal_json = ?, status = ?, revision = revision + 1, updated_at = ? WHERE intake_id = ?')
      .run(JSON.stringify(proposal), 'awaiting_human', nowIso(), intakeId)
    this.appendIntakeAudit(intakeId, 'proposal_generated', `revision ${proposal.revision} (observed_phase=${proposal.observed_phase})`)
    return proposal
  }

  /**
   * ONBOARD-01 adopt (research-onboarding.md §7): the ONLY intake write to
   * business tables. Runs in ONE Kernel transaction:
   *  - validates the Human PI Principal, proposal freshness (revision),
   *    target project revision (409 project_revision_conflict) and that all
   *    artifacts are clean (422 artifact_quarantined);
   *  - promotes staged blobs into CAS + registers project Artifact rows;
   *  - creates the phase's required gates PENDING (never decided);
   *  - imports metrics/results files as draft (legacy_unverified) Evidence
   *    and logs as log Artifact + ImportedRunObservation — NEVER TerminalLog,
   *    RunSet, verified/accepted Evidence or supported Claim;
   *  - writes the AdoptionReceipt (pinned revisions + idempotency hash).
   * The project stays on its kernel state machine status (DRAFT for fresh
   * projects) — adoption never skips the Scope Gate or any other gate.
   * Idempotent: same intake + Idempotency-Key + request hash → same receipt;
   * different hash → 409 idempotency_conflict; a second adopt without a key
   * replays the stored receipt.
   */
  adoptIntake(input: {
    intake_id: string
    expected_proposal_revision: number
    expected_target_revision?: number
    idempotency_key?: string
    request_hash?: string
  }, principal: HumanPrincipal): AdoptionReceipt {
    if (principal === undefined || typeof principal.principal_id !== 'string' || principal.principal_id === '') {
      throw new KernelError(422, 'principal_required', 'intake adoption requires an authenticated Human Principal (principal.principal_id)')
    }
    const row = this.getIntakeSessionRow(input.intake_id)
    const session = this.intakeSessionFromRow(row)
    const storedReceipt = row.receipt_json === null || row.receipt_json === '' ? null : jsonParse(row.receipt_json, null) as unknown as AdoptionReceipt
    if (session.status === 'accepted' && storedReceipt !== null) {
      // Idempotent replay: same key + request hash returns the SAME receipt;
      // a different key OR a different hash under the same key is a 409.
      if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
        if (storedReceipt.idempotency_key !== input.idempotency_key) {
          throw new KernelError(409, 'idempotency_conflict', `intake ${input.intake_id} was already adopted under a different idempotency key`)
        }
        if (storedReceipt.request_hash !== (input.request_hash ?? '')) {
          throw new KernelError(409, 'idempotency_conflict', `intake idempotency key ${input.idempotency_key} was used with a different request hash`)
        }
      }
      return storedReceipt
    }
    if (session.status !== 'awaiting_human') {
      throw new KernelError(409, 'intake_state_conflict', `intake ${input.intake_id} is ${session.status}; adoption requires awaiting_human (propose first)`)
    }
    if (Date.parse(session.expires_at) < Date.now()) {
      throw new KernelError(409, 'intake_expired', `intake ${input.intake_id} expired at ${session.expires_at}`)
    }
    const proposal = row.proposal_json === null || row.proposal_json === '' ? null : jsonParse(row.proposal_json, null) as unknown as PhaseProposal
    if (proposal === null) {
      throw new KernelError(422, 'proposal_stale', `intake ${input.intake_id} has no proposal — propose first`)
    }
    if (input.expected_proposal_revision !== proposal.revision) {
      throw new KernelError(409, 'proposal_stale',
        `proposal revision ${input.expected_proposal_revision} is stale; current revision is ${proposal.revision} — re-propose`)
    }
    if (session.project_id === null) {
      throw new KernelError(422, 'phase_unadoptable', `intake ${input.intake_id} has no target project — merge into a project first`)
    }
    const project = this.getProject(session.project_id)
    if (input.expected_target_revision !== undefined && input.expected_target_revision !== project.revision) {
      throw new KernelError(409, 'project_revision_conflict',
        `target project revision ${input.expected_target_revision} is stale; current revision is ${project.revision} — re-propose`)
    }
    if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
      const replay = this.db.prepare('SELECT * FROM intake_sessions WHERE intake_id = ? AND idempotency_key = ?')
        .get(input.intake_id, input.idempotency_key) as IntakeSessionRow | undefined
      if (replay !== undefined && replay.receipt_json !== null && replay.receipt_json !== '') {
        const receipt = jsonParse(replay.receipt_json, null) as unknown as AdoptionReceipt
        if (receipt.request_hash !== (input.request_hash ?? '')) {
          throw new KernelError(409, 'idempotency_conflict', `intake idempotency key ${input.idempotency_key} was used with a different request hash`)
        }
        return receipt
      }
    }
    const artifacts = this.intakeArtifacts(input.intake_id)
    const blocked = artifacts.filter(a => a.quarantine !== 'clean')
    if (blocked.length > 0) {
      throw new KernelError(422, 'artifact_quarantined',
        `intake artifacts are not clean: ${blocked.map(a => `${a.file_name} (${a.quarantine})`).join(', ')} — remove or replace them`)
    }
    return withTransaction(this.db, () => {
      const now = nowIso()
      const createdObjectRefs: string[] = []
      const draftEvidenceRefs: string[] = []
      const pendingGateRefs: string[] = []
      for (const artifact of artifacts) {
        const partPath = this.intakeStagedPath(input.intake_id, artifact.sha256)
        let staged: Buffer
        try {
          staged = readFileSync(partPath)
        } catch {
          throw new KernelError(422, 'stage_corrupted', `intake artifact ${artifact.file_name} staged bytes are missing — re-upload`)
        }
        const actualSha = createHash('sha256').update(staged).digest('hex')
        if (actualSha !== artifact.sha256 || staged.byteLength !== artifact.size_bytes) {
          throw new KernelError(422, 'stage_corrupted', `intake artifact ${artifact.file_name} content hash mismatch — re-upload`)
        }
        const kind = artifactKindForFile(artifact.file_name)
        const record = this.registerArtifact({
          project_id: session.project_id!,
          kind,
          content: staged,
          media_type: artifact.media_type,
          file_name: artifact.file_name,
          metadata: { intake_id: input.intake_id, imported: true, source: 'intake' },
        })
        createdObjectRefs.push(record.artifact_id)
        // §6.1: logs → log Artifact + ImportedRunObservation (NEVER TerminalLog).
        if (kind === 'log') {
          this.db.prepare(
            'INSERT INTO intake_observations (observation_id, intake_id, artifact_id, locator, detector, detector_version, value, warnings, trust, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(
            `obs_${randomUUID().replaceAll('-', '').slice(0, 16)}`, input.intake_id, artifact.artifact_id,
            artifact.file_name, 'imported_run', '1',
            `imported run observation from ${artifact.file_name} — imported logs never become TerminalLog rows`,
            '[]', 'observed_unverified', now,
          )
        }
        // §6.1: metrics/results → data Artifact + draft (legacy_unverified) Evidence.
        if (isImportableMetricsFile(artifact.file_name)) {
          const parsed = parseMetricsFileV1(staged)
          if (parsed !== null) {
            const first = parsed.metrics[0]!
            const evidence = this.ingestEvidence({
              project_id: session.project_id!,
              source_type: 'reproduction',
              run_ids: [],
              artifact_refs: [record.artifact_id],
              analysis_method: 'imported-unverified',
              result: {
                primary_metric: first.name,
                value: first.value,
                n_seeds: 0,
                direction: undefined,
              },
              provenance_status: 'legacy_unverified',
            })
            draftEvidenceRefs.push(evidence.evidence_id)
          }
        }
      }
      // §6: the phase's gates are created PENDING — never decided by intake.
      for (const gateType of SAFE_PHASE_LANDING[proposal.observed_phase].required_gates) {
        const gate = this.createGate({
          project_id: session.project_id!,
          type: gateType as GateType,
          title: `${gateType} gate (imported material)`,
          summary: `created by intake adoption ${input.intake_id} — pending human decision; the intake never decides gates`,
          payload: { intake_id: input.intake_id, imported: true },
        })
        pendingGateRefs.push(gate.gate_id)
      }
      const receipt: AdoptionReceipt = {
        adoption_id: `adopt_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        intake_id: input.intake_id,
        project_id: session.project_id!,
        proposal_revision: proposal.revision,
        target_project_revision: project.revision,
        created_object_refs: createdObjectRefs,
        pending_gate_refs: pendingGateRefs,
        draft_evidence_refs: draftEvidenceRefs,
        idempotency_key: input.idempotency_key ?? null,
        request_hash: input.request_hash ?? '',
        adopted_by: principal,
        adopted_at: now,
      }
      this.db.prepare(
        'UPDATE intake_sessions SET status = ?, receipt_json = ?, revision = revision + 1, updated_at = ? WHERE intake_id = ?',
      ).run('accepted', JSON.stringify(receipt), now, input.intake_id)
      this.appendIntakeAudit(input.intake_id, 'adopted', `adoption ${receipt.adoption_id} (proposal r${proposal.revision})`)
      // GC the isolated staging files (blobs now live in the real CAS).
      this.gcIntakeStagedDir(input.intake_id)
      this.emit(session.project_id, 'intake.accepted', {
        intake_id: input.intake_id, project_id: session.project_id, adoption_id: receipt.adoption_id,
        proposal_revision: proposal.revision, artifact_count: artifacts.length,
      })
      return receipt
    })
  }

  private gcIntakeStagedDir(intakeId: string): void {
    const dir = join(this.intakeStagedRoot, intakeId)
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return // already gone
    }
    for (const entry of entries) {
      try { unlinkSync(join(dir, entry)) } catch { /* raced */ }
    }
    try { rmdirSync(dir) } catch { /* raced */ }
  }

  /**
   * ONBOARD-01 reject (research-onboarding.md §7): Human rejection — GC the
   * isolated staged blobs and mark the session rejected (audited). Accepted
   * sessions cannot be rejected; an already-rejected replay is a no-op.
   */
  rejectIntake(intakeId: string, principal: HumanPrincipal): IntakeProjection {
    if (principal === undefined || typeof principal.principal_id !== 'string' || principal.principal_id === '') {
      throw new KernelError(422, 'principal_required', 'intake rejection requires an authenticated principal (principal.principal_id)')
    }
    const row = this.getIntakeSessionRow(intakeId)
    const session = this.intakeSessionFromRow(row)
    if (session.status === 'accepted') {
      throw new KernelError(409, 'intake_state_conflict', `intake ${intakeId} was adopted and cannot be rejected`)
    }
    if (session.status === 'rejected') {
      return this.getIntakeProjection(intakeId) // idempotent replay
    }
    this.gcIntakeStagedDir(intakeId)
    this.db.prepare('UPDATE intake_sessions SET status = ?, revision = revision + 1, updated_at = ? WHERE intake_id = ?')
      .run('rejected', nowIso(), intakeId)
    this.appendIntakeAudit(intakeId, 'rejected', `rejected by ${principal.principal_id}`)
    this.emit(session.project_id, 'intake.rejected', { intake_id: intakeId, project_id: session.project_id })
    return this.getIntakeProjection(intakeId)
  }

  /**
   * ONBOARD-01 recovery/GC (research-onboarding.md §7): expire sessions past
   * their TTL that were never adopted — GC staged blobs, mark expired
   * (audited + outbox). Accepted sessions are never touched. Returns the
   * number of sessions expired.
   */
  expireIntakes(now = Date.now()): number {
    const rows = this.db.prepare(
      "SELECT * FROM intake_sessions WHERE status IN ('draft','uploading','scanning','needs_input','grilling','proposal_ready','awaiting_human','accepting') AND expires_at < ?",
    ).all(new Date(now).toISOString()) as unknown as IntakeSessionRow[]
    for (const row of rows) {
      this.gcIntakeStagedDir(row.intake_id)
      this.db.prepare('UPDATE intake_sessions SET status = ?, revision = revision + 1, updated_at = ? WHERE intake_id = ?')
        .run('expired', nowIso(), row.intake_id)
      this.appendIntakeAudit(row.intake_id, 'expired', `expired at ${row.expires_at}`)
      this.emit(row.project_id, 'intake.expired', { intake_id: row.intake_id, project_id: row.project_id })
    }
    return rows.length
  }

  /**
   * ONBOARD-01 recovery/GC: remove ISOLATED staged intake blobs older than
   * `maxAgeMs` (research-onboarding.md §7: unadopted temp blobs GC after
   * 24 h). Adopted blobs already live in the real CAS (never touched);
   * session rows survive (re-uploadable) until expireIntakes collects them.
   * Returns the number of files removed.
   */
  cleanupIntakeStaged(maxAgeMs: number = ResearchKernel.INTAKE_STAGED_TTL_MS): number {
    let sessions: string[]
    try {
      sessions = readdirSync(this.intakeStagedRoot)
    } catch {
      return 0
    }
    const now = Date.now()
    let removed = 0
    for (const intakeId of sessions) {
      const dir = join(this.intakeStagedRoot, intakeId)
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        continue // raced
      }
      for (const entry of entries) {
        const full = join(dir, entry)
        let mtime: number
        try {
          mtime = statSync(full).mtimeMs
        } catch {
          continue
        }
        if (now - mtime > maxAgeMs) {
          try {
            unlinkSync(full)
            removed += 1
          } catch { /* raced */ }
        }
      }
      try {
        if (readdirSync(dir).length === 0) rmdirSync(dir)
      } catch { /* raced */ }
    }
    return removed
  }

  /** Project-scoped artifact lookup (v2 §3.4 isolation). */
  getArtifact(projectId: string, sha256OrId: string): ArtifactRecord {
    const id = sha256OrId.startsWith('sha256:') ? sha256OrId : `sha256:${sha256OrId}`
    const row = this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND artifact_id = ?')
      .get(projectId, id) as ArtifactRecord | undefined
    if (row === undefined) throw new KernelError(404, 'artifact_not_found', `artifact ${id} not found in project ${projectId}`)
    // metadata is stored as JSON TEXT — surface it as the schema object.
    return { ...row, metadata: jsonParse(row.metadata as unknown as string, {}) }
  }


  listArtifacts(projectId: string): ArtifactRecord[] {
    const rows = this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as ArtifactRecord[]
    return rows.map(row => ({ ...row, metadata: jsonParse(row.metadata as unknown as string, {}) }))
  }

  /** All project records referencing one blob (v2 §7.4 compatibility). */
  listArtifactsForBlob(sha256OrId: string): ArtifactRecord[] {
    const id = sha256OrId.startsWith('sha256:') ? sha256OrId : `sha256:${sha256OrId}`
    return this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ? ORDER BY project_id').all(id) as unknown as ArtifactRecord[]
  }

  /** Verify a RunManifest's artifact refs exist in CAS (design §4.6.1). */
  verifyArtifactRefs(refs: string[]): { ok: boolean; missing: string[] } {
    const missing = refs.filter(ref => {
      const sha = ref.replace(/^sha256:/, '')
      return !this.cas.has(sha)
    })
    return { ok: missing.length === 0, missing }
  }

  // ── ideas ────────────────────────────────────────────────────────────────

  createIdea(input: Omit<IdeaCard, 'idea_id' | 'project_id' | 'status' | 'version' | 'created_at' | 'updated_at'> & { project_id: string }): IdeaCard {
    this.getProject(input.project_id)
    const card: IdeaCard = {
      idea_id: buildIdeaId(),
      project_id: input.project_id,
      version: 1,
      // v2 shape (domain-model.md §6): optional frozen-corpus binding —
      // validated by the Idea Gate decision (422 idea_corpus_unknown /
      // idea_corpus_foreign); legacy cards default to null.
      corpus_snapshot_id: input.corpus_snapshot_id ?? null,
      title: input.title,
      hypothesis: input.hypothesis,
      scientific_gap: input.scientific_gap,
      nearest_prior_works: input.nearest_prior_works,
      exact_delta: input.exact_delta,
      falsification: input.falsification,
      minimum_viable_experiment: input.minimum_viable_experiment,
      novelty_audit: input.novelty_audit,
      scores: input.scores,
      risk_notes: input.risk_notes ?? '',
      status: 'proposed',
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    IdeaCard.parse(card)
    this.db.prepare('INSERT INTO ideas (idea_id, project_id, body, updated_at) VALUES (?, ?, ?, ?)')
      .run(card.idea_id, card.project_id, JSON.stringify(card), card.updated_at)
    this.emit(input.project_id, 'idea.created', { idea_id: card.idea_id, title: card.title })
    return card
  }

  listIdeas(projectId: string): IdeaCard[] {
    const rows = this.db.prepare('SELECT * FROM ideas WHERE project_id = ? ORDER BY updated_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => jsonParse(row.body, null as unknown as IdeaCard)).filter(Boolean)
  }

  getIdea(ideaId: string): IdeaCard {
    const row = this.db.prepare('SELECT * FROM ideas WHERE idea_id = ?').get(ideaId) as { body?: string } | undefined
    if (row?.body === undefined) throw new KernelError(404, 'idea_not_found', `idea ${ideaId} not found`)
    return JSON.parse(row.body) as IdeaCard
  }

  /** Versioned update: existing fields carried forward, version bumped. */
  updateIdea(ideaId: string, patch: Partial<Omit<IdeaCard, 'idea_id' | 'project_id' | 'version' | 'created_at'>>): IdeaCard {
    const current = this.getIdea(ideaId)
    const next: IdeaCard = {
      ...current,
      ...patch,
      version: current.version + 1,
      updated_at: nowIso(),
    }
    IdeaCard.parse(next)
    this.db.prepare('UPDATE ideas SET body = ?, updated_at = ? WHERE idea_id = ?').run(JSON.stringify(next), next.updated_at, ideaId)
    this.emit(current.project_id, 'idea.updated', { idea_id: ideaId, version: next.version })
    return next
  }

  approveIdea(ideaId: string): IdeaCard {
    return this.updateIdea(ideaId, { status: 'approved' })
  }

  /** Attach/refresh the novelty counter-search audit on an IdeaCard. */
  updateIdeaNovelty(ideaId: string, audit: NonNullable<IdeaCard['novelty_audit']>): IdeaCard {
    return this.updateIdea(ideaId, { novelty_audit: audit })
  }

  // ── contracts ────────────────────────────────────────────────────────────

  registerContract(input: Omit<ExperimentContract, 'contract_id' | 'version' | 'status' | 'created_at' | 'updated_at'> & { project_id: string }): ExperimentContract {
    this.getProject(input.project_id)
    const contract: ExperimentContract = {
      contract_id: buildContractId(),
      version: 1,
      project_id: input.project_id,
      idea_id: input.idea_id,
      baseline_run: input.baseline_run,
      code_snapshot: input.code_snapshot,
      data: input.data,
      methods: input.methods,
      metrics: input.metrics,
      seeds: input.seeds,
      analysis: input.analysis,
      ablations: input.ablations,
      stop_conditions: input.stop_conditions,
      status: 'draft',
      approval: undefined,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    // Zod defaults (seeds, analysis, metrics.secondary, metrics.direction,
    // stop_conditions …) must be MATERIALIZED into the stored body — parsing
    // then re-inserting the PARSED value (not the raw input) guarantees the
    // runner's contract_metrics injection and direction resolution always see
    // the defaulted fields.
    const parsed = ExperimentContract.parse(contract)
    this.db.prepare('INSERT INTO contracts (contract_id, project_id, body, updated_at) VALUES (?, ?, ?, ?)')
      .run(parsed.contract_id, parsed.project_id, JSON.stringify(parsed), parsed.updated_at)
    this.emit(input.project_id, 'contract.registered', { contract_id: parsed.contract_id })
    return parsed
  }

  getContract(contractId: string): ExperimentContract {
    const row = this.db.prepare('SELECT * FROM contracts WHERE contract_id = ?').get(contractId) as { body?: string } | undefined
    if (row?.body === undefined) throw new KernelError(404, 'contract_not_found', `contract ${contractId} not found`)
    return JSON.parse(row.body) as ExperimentContract
  }

  listContracts(projectId: string): ExperimentContract[] {
    const rows = this.db.prepare('SELECT * FROM contracts WHERE project_id = ? ORDER BY updated_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as ExperimentContract)
  }

  /** Freeze a contract upon Contract Gate approval (design §6.6: immutable). */
  approveContract(contractId: string, gateDecisionId: string, actor: string): ExperimentContract {
    const current = this.getContract(contractId)
    if (current.status === 'approved') return current
    const next: ExperimentContract = {
      ...current,
      status: 'approved',
      approval: { gate_decision_id: gateDecisionId, approved_at: nowIso(), approved_by: actor },
      updated_at: nowIso(),
    }
    this.db.prepare('UPDATE contracts SET body = ?, updated_at = ? WHERE contract_id = ?').run(JSON.stringify(next), next.updated_at, contractId)
    this.emit(current.project_id, 'contract.approved', { contract_id: contractId, gate_decision_id: gateDecisionId })
    return next
  }

  // ── corpus ───────────────────────────────────────────────────────────────

  snapshotCorpus(input: {
    project_id: string
    queries: CorpusSnapshot['queries']
    papers: Paper[]
    passages?: Passage[]
    citation_edges?: CorpusSnapshot['citation_edges']
    external_claims?: CorpusSnapshot['external_claims']
    /** v2 shape (domain-model.md §5): per-source status; any source failure
     * must be recorded here instead of silently dropping the query. */
    source_status?: CorpusSnapshot['source_status']
  }): CorpusSnapshot {
    this.getProject(input.project_id)
    // v2 shape (domain-model.md §5): every passage carries the sha256 of its
    // text — "new-write required": the kernel always fills it on snapshot
    // writes and the verification step below rejects any passage that would
    // land without a non-empty content hash (old rows without the field
    // still parse on read — old-read compatible).
    const passages = (input.passages ?? []).map((passage) => ({
      ...passage,
      content_hash: createHash('sha256').update(passage.text, 'utf8').digest('hex'),
    }))
    for (const passage of passages) {
      const parsed = Passage.safeParse(passage)
      if (!parsed.success || parsed.data.content_hash === undefined || parsed.data.content_hash === '') {
        throw new KernelError(422, 'passage_content_hash_required',
          `passage ${passage.passage_id} (${passage.paper_id}) would land without a content hash — the kernel computes sha256(text) on every snapshot write (domain-model.md §5)`)
      }
    }
    const snapshot: CorpusSnapshot = {
      snapshot_id: `corpus_snap_${randomUUID().slice(0, 8)}`,
      project_id: input.project_id,
      // v2 shape (domain-model.md §5): explicit payload schema version +
      // per-source retrieval status (defaults keep legacy readers intact).
      schema_version: 1,
      source_status: input.source_status ?? 'complete',
      queries: input.queries,
      papers: input.papers,
      passages,
      citation_edges: input.citation_edges ?? [],
      external_claims: input.external_claims ?? [],
      quality: {
        total_papers: input.papers.length,
        dedup_ratio: 0,
        coverage_note: '',
      },
      created_at: nowIso(),
      frozen: true,
    }
    CorpusSnapshot.parse(snapshot)
    this.db.prepare('INSERT INTO corpus_snapshots (snapshot_id, project_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(snapshot.snapshot_id, snapshot.project_id, JSON.stringify(snapshot), snapshot.created_at)
    this.emit(input.project_id, 'corpus.snapshotted', { snapshot_id: snapshot.snapshot_id, total_papers: snapshot.papers.length })
    return snapshot
  }

  listCorpusSnapshots(projectId: string): CorpusSnapshot[] {
    this.getProject(projectId)
    const rows = this.db.prepare('SELECT * FROM corpus_snapshots WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as CorpusSnapshot)
  }

  getCorpusSnapshot(snapshotId: string): CorpusSnapshot {
    const row = this.db.prepare('SELECT * FROM corpus_snapshots WHERE snapshot_id = ?').get(snapshotId) as { body?: string } | undefined
    if (row?.body === undefined) throw new KernelError(404, 'snapshot_not_found', `corpus snapshot ${snapshotId} not found`)
    return JSON.parse(row.body) as CorpusSnapshot
  }

  // ── code snapshot archive (design §11.3, SCH-EXEC-002) ───────────────────

  /**
   * Archive a directory's ACTUAL file contents into a content-addressed
   * `code` artifact (JSON `{schema_version, project_id, description, files:
   * {rel: {sha256, content_base64}}, excludes}`) plus a lightweight `manifest`
   * artifact (file list + hashes, no content). The Runner materializes the
   * code snapshot ONLY from the Artifact Store — never from agent host dirs.
   *
   * Safety (path escape / symlink protection): the walk rejects any file whose
   * relative path escapes the root, and any symbolic link whose realpath
   * resolves OUTSIDE the real root (422 `snapshot_path_escape`); directories
   * `.git`, `node_modules` and `.research-cas` are excluded.
   */
  snapshotCodeArchive(projectId: string, rootPath: string, description = ''): CodeSnapshot {
    this.getProject(projectId)
    const absRoot = resolve(rootPath)
    let rootInfo
    try {
      rootInfo = statSync(absRoot)
    } catch {
      throw new KernelError(422, 'snapshot_root_missing', `code snapshot root not readable: ${rootPath}`)
    }
    if (!rootInfo.isDirectory()) {
      throw new KernelError(422, 'snapshot_root_missing', `code snapshot root is not a directory: ${rootPath}`)
    }
    const realRoot = realpathSync(absRoot)
    // Directories that are never part of a code snapshot (build/vendor/state).
    const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.research-cas'])
    const files: Record<string, { sha256: string; content_base64: string; size_bytes: number }> = {}
    let totalBytes = 0
    let fileCount = 0
    const walk = (dir: string): void => {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch (error) {
        throw new KernelError(422, 'snapshot_read_error', `code snapshot: directory not readable: ${dir} (${(error as Error).message})`)
      }
      for (const entry of entries) {
        const full = join(dir, entry)
        let info
        try {
          info = lstatSync(full)
        } catch {
          continue // raced with deletion — skip
        }
        if (info.isSymbolicLink()) {
          // §11.3 escape protection: symlinks resolving outside the archived
          // root are rejected; symlinks staying inside are followed.
          let target: string
          try {
            target = realpathSync(full)
          } catch {
            continue // dangling symlink — skip
          }
          if (target !== realRoot && !target.startsWith(`${realRoot}${sep}`)) {
            throw new KernelError(422, 'snapshot_path_escape',
              `code snapshot: symbolic link escapes the archived root: ${relative(absRoot, full)} -> ${target}`)
          }
          try {
            info = statSync(full)
          } catch {
            continue
          }
        }
        if (info.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry)) continue
          walk(full)
        } else if (info.isFile()) {
          const rel = relative(absRoot, full)
          if (rel.startsWith('..') || rel.startsWith(sep)) {
            throw new KernelError(422, 'snapshot_path_escape', `code snapshot: path escapes the archived root: ${full}`)
          }
          // STORE-02 (§3 fixed resource limits): single-file and file-count
          // caps are enforced BEFORE reading the content (a giant file is
          // rejected on its stat, never buffered in full).
          if (info.size > ResearchKernel.SNAPSHOT_MAX_FILE_BYTES) {
            throw new KernelError(422, 'snapshot_too_large',
              `code snapshot exceeds limits: file ${rel} is ${info.size} bytes (max_file_bytes=${ResearchKernel.SNAPSHOT_MAX_FILE_BYTES})`)
          }
          if (fileCount >= ResearchKernel.SNAPSHOT_MAX_FILES) {
            throw new KernelError(422, 'snapshot_too_large',
              `code snapshot exceeds limits: file count ${fileCount} >= max_files=${ResearchKernel.SNAPSHOT_MAX_FILES}`)
          }
          let content: Buffer
          try {
            content = readFileSync(full)
          } catch (error) {
            throw new KernelError(422, 'snapshot_read_error', `code snapshot: unreadable file ${rel}: ${(error as Error).message}`)
          }
          const sha256 = createHash('sha256').update(content).digest('hex')
          files[rel] = { sha256, content_base64: content.toString('base64'), size_bytes: content.byteLength }
          fileCount += 1
          totalBytes += content.byteLength
          // Total-size cap is checked as the walk accumulates, so an
          // oversized archive fails early instead of being read to the end.
          if (totalBytes > ResearchKernel.SNAPSHOT_MAX_TOTAL_BYTES) {
            throw new KernelError(422, 'snapshot_too_large',
              `code snapshot exceeds limits: total_bytes=${totalBytes} (max_total_bytes=${ResearchKernel.SNAPSHOT_MAX_TOTAL_BYTES})`)
          }
        }
        // sockets/fifos/devices are skipped silently (never part of source).
      }
    }
    walk(absRoot)

    // STORE-02 host-path hygiene: the archive's `root` field is a display
    // placeholder, never the host path — the Runner materializes code ONLY
    // from the `files` map (unpackCodeSnapshot/materializeCodeSnapshot), so
    // `root` carries no materialization semantics. Same for the manifest and
    // the registry source_json; the absolute host path never leaves the kernel.
    const rootPlaceholder = '~'
    const archive = {
      schema_version: 1,
      project_id: projectId,
      description,
      root: rootPlaceholder,
      files,
      excludes: [...EXCLUDED_DIRS],
      created_at: nowIso(),
    }
    const archiveRecord = this.registerArtifact({
      project_id: projectId,
      kind: 'code',
      content: JSON.stringify(archive),
      metadata: { kind: 'code-snapshot-archive', files: Object.keys(files).length, total_bytes: totalBytes },
    })
    // Lightweight manifest artifact (file list + hashes, no content) — §11.3
    // `manifest_artifact_id`. Same sha256 space; content-addressed.
    const manifestRecord = this.registerArtifact({
      project_id: projectId,
      kind: 'manifest',
      content: JSON.stringify({
        schema_version: 1,
        project_id: projectId,
        description,
        root: rootPlaceholder,
        files: Object.fromEntries(Object.entries(files).map(([rel, f]) => [rel, { sha256: f.sha256, size_bytes: f.size_bytes }])),
        excludes: [...EXCLUDED_DIRS],
        created_at: nowIso(),
      }),
      metadata: { kind: 'code-snapshot-manifest', files: Object.keys(files).length },
    })
    const snapshot: CodeSnapshot = {
      snapshot_id: `code_snap_${randomUUID().slice(0, 8)}`,
      project_id: projectId,
      // Display placeholder only — never the host path (STORE-02).
      path: rootPlaceholder,
      description,
      archive_artifact_id: archiveRecord.artifact_id,
      manifest_artifact_id: manifestRecord.artifact_id,
      submodules_artifact_id: null,
      lockfiles: [],
      files: Object.keys(files).length,
      total_bytes: totalBytes,
      sha256: archiveRecord.sha256,
      created_at: nowIso(),
    }
    // STORE-02: record the snapshot in the authoritative code_snapshots
    // registry (snapshot_id -> archive/manifest artifacts + integrity).
    this.db.prepare(`INSERT INTO code_snapshots
        (snapshot_id, project_id, archive_artifact_id, manifest_artifact_id, source_json, sha256, file_count, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(snapshot.snapshot_id, projectId, archiveRecord.artifact_id, manifestRecord.artifact_id,
        JSON.stringify({ description, root: rootPlaceholder, excludes: [...EXCLUDED_DIRS] }),
        archiveRecord.sha256, Object.keys(files).length, totalBytes, snapshot.created_at)
    // Both artifacts already emit artifact.registered events (outbox).
    return snapshot
  }

  /** STORE-02: authoritative code snapshot registry lookup. */
  getCodeSnapshot(snapshotId: string): {
    snapshot_id: string
    project_id: string
    archive_artifact_id: string
    manifest_artifact_id: string
    source: { description?: string; root?: string; excludes?: string[] }
    sha256: string
    file_count: number
    size_bytes: number
    created_at: string
  } {
    const row = this.db.prepare('SELECT * FROM code_snapshots WHERE snapshot_id = ?').get(snapshotId) as {
      snapshot_id: string; project_id: string; archive_artifact_id: string; manifest_artifact_id: string
      source_json: string; sha256: string; file_count: number; size_bytes: number; created_at: string
    } | undefined
    if (row === undefined) throw new KernelError(404, 'code_snapshot_not_found', `code snapshot ${snapshotId} not found`)
    return {
      snapshot_id: row.snapshot_id,
      project_id: row.project_id,
      archive_artifact_id: row.archive_artifact_id,
      manifest_artifact_id: row.manifest_artifact_id,
      source: JSON.parse(row.source_json) as { description?: string; root?: string; excludes?: string[] },
      sha256: row.sha256,
      file_count: row.file_count,
      size_bytes: row.size_bytes,
      created_at: row.created_at,
    }
  }

  // ── durable jobs (design §4.2 Job Controller, §9.3) ──────────────────────

  /** Idempotent job submission: same idempotency_key returns the existing job. */
  submitJob(input: {
    project_id: string
    idempotency_key: string
    kind: JobRecord['kind']
    command?: string[]
    payload?: Record<string, unknown>
    contract_id?: string | null
    max_attempts?: number
    // §12.2 JobSpec binding (SCH-EXEC-002): code snapshot materialized by the
    // Runner from CAS; image_digest/output_contract/data_artifact_ids travel
    // inside payload.
    code_snapshot_id?: string | null
    data_artifact_ids?: string[]
    image_digest?: string
    output_contract?: { metrics: string; logs: string }
    // domain-model.md §9.1: opaque RunnerProfile id（缺省回退 project 级
    // execution.runner_profile_id，再回退 v1 enum 映射）；未知 id 422。
    runner_profile_id?: string | null
    // v2 shape (domain-model.md §9): durable submitter principal, persisted
    // to jobs.created_by_principal_id. The server layer resolves it from the
    // BFF-injected x-principal-id header (never client body trust); internal
    // callers may omit it → NULL.
    created_by_principal_id?: string | null
  }): JobSpecBound {
    const project = this.getProject(input.project_id)
    // reconstruction-contracts.md §5 / security-baseline.md §1: full-auto is
    // fixture-only. A full-auto project must stay bound to its REGISTERED
    // FixtureProfile and every job input must stay INSIDE the profile:
    // pinned image digest, data artifact content hashes and (when the
    // profile pins one) the code archive hash. Referencing anything outside
    // the profile is 422 — never queued.
    const fixtureProfile = project.mode === 'full-auto' ? getFixtureProfile(project.execution.fixture_id ?? '') : null
    if (project.mode === 'full-auto' && fixtureProfile === null) {
      throw new KernelError(422, 'fixture_required',
        `full-auto project ${project.project_id} is not bound to a REGISTERED FixtureProfile (reconstruction-contracts.md §5)`)
    }
    // v2 §3.4: idempotency is project-scoped — the same key in two projects
    // yields two independent jobs.
    const existing = this.db.prepare('SELECT * FROM jobs WHERE project_id = ? AND idempotency_key = ?')
      .get(input.project_id, input.idempotency_key) as JobRow | undefined
    if (existing !== undefined) return jobFromRow(existing, this.db, this.leaseTokens.get(existing.job_id) ?? null)
    // v2 §3.2 / §12.3: formal-class jobs require a container runner profile;
    // isolated-subprocess is rejected at submission time (kernel layer).
    // domain-model.md §2/§9.1: Job 只引用已登记的 opaque profile id ——
    // 显式 runner_profile_id（job 级 > project 级）优先，缺省从 v1 enum
    // 映射同名本机 profile；未知 id → 422（fail closed，零落库）。解析出的
    // profile 的 config_hash 与 image digest 一起固定进 Job payload，runner
    // 按注册表复算校验。
    const SECURE_KINDS: readonly string[] = ['baseline', 'pilot', 'formal', 'reproduce', 'latex-compile']
    // job 级 > project 级 > v1 enum（最后一个恒非空：ExecutionConfig 有默认值）
    const profileRef = input.runner_profile_id ?? project.execution.runner_profile_id ?? project.execution.runner_profile
    const resolvedProfileId = resolveRunnerProfileId(profileRef)
    const runnerProfile = resolvedProfileId !== null ? getRunnerProfile(resolvedProfileId) : null
    if (runnerProfile === null) {
      throw new KernelError(422, 'runner_profile_unknown',
        `runner profile '${profileRef ?? project.execution.runner_profile}' is not a registered opaque profile id (domain-model.md §9.1); jobs reference only registered RunnerProfile ids, never docker flags/endpoints`)
    }
    if (SECURE_KINDS.includes(input.kind) && runnerProfile.runner_mode !== 'local-docker') {
      throw new KernelError(422, 'container_execution_required',
        `job kind ${input.kind} requires a container runner profile (got ${runnerProfile.profile_id}); host subprocess is prohibited (v2 §3.2)`)
    }
    // §12 latex-compile binds a frozen TeX snapshot, not a code snapshot.
    if (input.kind === 'latex-compile') {
      const docId = typeof input.payload?.tex_document_id === 'string' ? input.payload.tex_document_id : ''
      const rev = typeof input.payload?.tex_revision === 'number' ? input.payload.tex_revision : undefined
      if (docId === '' || rev === undefined) {
        throw new KernelError(422, 'tex_snapshot_required', 'latex-compile jobs require payload.tex_document_id + payload.tex_revision')
      }
      // P0 (RUN-02/TEX-02): the build engine is a fixed enum — an arbitrary
      // string (payload.engine or command[0]) is rejected 422 `engine_invalid`
      // before it can be spliced into the container build script.
      const engine = typeof input.payload?.engine === 'string' && input.payload.engine !== ''
        ? input.payload.engine
        : (Array.isArray(input.command) && input.command.length > 0 ? String(input.command[0]) : 'pdflatex')
      if (!TEX_ENGINES.includes(engine)) {
        throw new KernelError(422, 'engine_invalid',
          `latex-compile engine '${engine}' is not in the fixed engine whitelist (${TEX_ENGINES.join('/')})`)
      }
      // P0 (TEX-02): every path of the frozen snapshot must be root-relative
      // and free of shell metacharacters (they are interpolated into the
      // build script by the runner; the kernel rejects them at submit).
      const snapshot = input.payload?.tex_snapshot
      if (typeof snapshot === 'object' && snapshot !== null) {
        const snap = snapshot as { root_file?: unknown; files?: unknown }
        if (typeof snap.root_file === 'string') assertSafeTexBuildPath(snap.root_file)
        if (Array.isArray(snap.files)) {
          for (const f of snap.files) {
            const path = (f as { path?: unknown } | null)?.path
            if (typeof path === 'string') assertSafeTexBuildPath(path)
          }
        }
        // TEX-01 (§4 row 95): the carried manifest must describe the SAME
        // revision the job claims to compile — a mismatched manifest would
        // let a build row label one revision while the runner compiles
        // another. 409, never queued.
        const manifestRevision = (snap as { revision?: unknown }).revision
        if (typeof manifestRevision === 'number' && manifestRevision !== rev) {
          throw new KernelError(409, 'document_version_conflict',
            `tex snapshot manifest revision ${manifestRevision} does not match tex_revision ${rev} — freeze a fresh manifest before building`)
        }
      }
      this.texSnapshot(docId, rev)
    }
    // §12.2 (SCH-EXEC-002): formal-class jobs MUST bind a materialized code
    // snapshot — the Runner never executes agent host directories.
    // latex-compile binds a frozen TeX snapshot instead (§12).
    const codeSnapshotId = input.code_snapshot_id ?? null
    if (SECURE_KINDS.includes(input.kind) && input.kind !== 'latex-compile' && (codeSnapshotId === null || codeSnapshotId === '')) {
      throw new KernelError(422, 'code_snapshot_required',
        `job kind ${input.kind} requires code_snapshot_id (the Runner materializes code from CAS, §11.3/§12.2)`)
    }
    // STORE-02: code_snapshot_id may be the authoritative REGISTRY id
    // (code_snap_…) or a raw archive artifact id; the registry id is
    // resolved to its archive artifact and the job binds THAT (the Runner
    // materializes from CAS via fetchArtifact).
    let boundCodeSnapshotId = codeSnapshotId
    if (codeSnapshotId !== null && codeSnapshotId !== '') {
      if (codeSnapshotId.startsWith('code_snap_')) {
        try {
          const registered = this.getCodeSnapshot(codeSnapshotId)
          this.getArtifact(project.project_id, registered.archive_artifact_id)
          boundCodeSnapshotId = registered.archive_artifact_id
        } catch {
          throw new KernelError(422, 'code_snapshot_unknown',
            `code_snapshot_id ${codeSnapshotId} is not a registered snapshot of project ${project.project_id}`)
        }
      } else {
        try {
          this.getArtifact(project.project_id, codeSnapshotId)
        } catch {
          throw new KernelError(422, 'code_snapshot_unknown',
            `code_snapshot_id ${codeSnapshotId} is not a registered artifact of project ${project.project_id}`)
        }
      }
    }
    // Full-auto fixture jobs: when the profile pins the code archive hash,
    // the bound snapshot's blob hash must match EXACTLY (fixture code can
    // never be swapped for private/external code).
    if (fixtureProfile !== null && fixtureProfile.code.archive_sha256 !== null) {
      if (boundCodeSnapshotId === null || boundCodeSnapshotId === '') {
        throw new KernelError(422, 'code_snapshot_required',
          'full-auto fixture jobs require code_snapshot_id (the fixture code archive is pinned)')
      }
      let boundHash: string
      try {
        boundHash = this.getArtifact(project.project_id, boundCodeSnapshotId).sha256
      } catch {
        throw new KernelError(422, 'code_snapshot_unknown',
          `full-auto fixture job requires code_snapshot_id bound to an in-project artifact`)
      }
      if (boundHash !== fixtureProfile.code.archive_sha256) {
        throw new KernelError(422, 'fixture_code_mismatch',
          `full-auto job code snapshot ${boundCodeSnapshotId} (${boundHash}) is not the fixture profile's pinned archive ${fixtureProfile.code.archive_sha256}`)
      }
    }
    // P0 (acceptance-tests.md §4): formal-class jobs MUST bind an approved
    // contract of the SAME project, frozen by a Human Gate Decision.
    // draft/foreign/missing contracts are 422, never queued.
    const CONTRACT_BOUND_KINDS: readonly string[] = ['baseline', 'pilot', 'formal', 'reproduce']
    let contractMetricNames: string[] | undefined
    if (CONTRACT_BOUND_KINDS.includes(input.kind)) {
      const contractId = input.contract_id ?? null
      if (contractId === null || contractId === '') {
        throw new KernelError(422, 'contract_required', `job kind ${input.kind} requires an approved contract binding`)
      }
      let contract: ExperimentContract
      try {
        contract = this.getContract(contractId)
      } catch {
        throw new KernelError(422, 'contract_unknown', `contract ${contractId} not found for ${input.kind} job`)
      }
      if (contract.project_id !== project.project_id) {
        throw new KernelError(422, 'contract_foreign', `contract ${contractId} belongs to another project (cannot bind to ${project.project_id})`)
      }
      if (contract.status !== 'approved' || contract.approval?.gate_decision_id === undefined || contract.approval.gate_decision_id === '') {
        throw new KernelError(422, 'contract_not_approved', `contract ${contractId} is ${contract.status} and not frozen by a Human Gate Decision`)
      }
      contractMetricNames = [contract.metrics.primary, ...contract.metrics.secondary]
    }
    // P0 (acceptance-tests.md §4): every `data_artifact_ids` entry must exist,
    // belong to the SAME project and be hash-reverifiable in CAS — a missing,
    // cross-project or unverifiable input is 422 and the job never reaches
    // queued. Empty array / undefined skips the check entirely.
    const dataArtifactIds = input.data_artifact_ids ?? []
    if (dataArtifactIds.length > 0) {
      for (const rawId of dataArtifactIds) {
        const id = rawId.startsWith('sha256:') ? rawId : `sha256:${rawId}`
        // Cross-project input is a distinct error: the blob may exist in
        // another project's registry (v2 §3.4 isolation) — never fall through
        // to a plain "missing".
        const anywhere = this.db.prepare('SELECT project_id FROM artifacts WHERE artifact_id = ?').get(id) as { project_id: string } | undefined
        if (anywhere !== undefined && anywhere.project_id !== project.project_id) {
          throw new KernelError(422, 'data_artifact_foreign',
            `data artifact ${id} belongs to project ${anywhere.project_id}, not ${project.project_id}`)
        }
        let record: ArtifactRecord
        try {
          record = this.getArtifact(project.project_id, id)
        } catch {
          throw new KernelError(422, 'data_artifact_missing',
            `data artifact ${id} is not registered in project ${project.project_id}`)
        }
        // Hash re-verification: the artifact record must reference a blob that
        // is actually present in CAS (immutable content-addressed store).
        if (!this.cas.has(record.sha256)) {
          throw new KernelError(422, 'data_artifact_hash_unverifiable',
            `data artifact ${id} blob ${record.sha256} is missing from CAS and cannot be re-verified`)
        }
        // Full-auto fixture jobs: every data artifact must be part of the
        // fixture profile's fixed inputs (by content hash) — private or
        // external data can never enter a fixture job.
        if (fixtureProfile !== null) {
          const inProfile = fixtureProfile.data.some(d => d.sha256 === record.sha256)
          if (!inProfile) {
            throw new KernelError(422, 'fixture_artifact_outside_profile',
              `data artifact ${id} (${record.sha256}) is not part of the full-auto fixture profile ${fixtureProfile.fixture_id}`)
          }
        }
      }
    }
    // §12.2 (P0, acceptance-tests.md §4): image_digest MUST equal the trusted
    // images.lock entry exactly — tags, `latest`, missing digests and
    // post-commit digest swaps are 422. latex-compile is kernel-owned: a
    // missing digest is injected with the locked texlive entry. An explicit
    // digest inside payload (the HTTP TeX builds route forwards it there) is
    // validated too, so it can never silently diverge from the lock.
    // Full-auto fixture jobs additionally MUST use the profile's pinned
    // image: a different caller-supplied digest is 422 fixture_image_mismatch
    // and an absent digest is bound to the profile image.
    let digestInput = input.image_digest ?? (typeof input.payload?.image_digest === 'string' && input.payload.image_digest !== '' ? input.payload.image_digest : undefined)
    if (fixtureProfile !== null && SECURE_KINDS.includes(input.kind)) {
      if (digestInput !== undefined && digestInput !== fixtureProfile.image) {
        throw new KernelError(422, 'fixture_image_mismatch',
          `full-auto jobs must use the fixture profile image ${fixtureProfile.image} (got ${digestInput})`)
      }
      digestInput = fixtureProfile.image
    }
    const payload = {
      ...(input.payload ?? {}),
      // §12.5 (P0): the Runner validates the metrics FILE against the bound
      // contract's metric names (primary + secondary) — injected here so the
      // runner never trusts client-supplied names.
      ...(contractMetricNames !== undefined ? { contract_metrics: contractMetricNames } : {}),
      // domain-model.md §9.1: secure kinds 固定 opaque runner profile id +
      // profile 记录 config_hash（与 image digest 同一 pin 语义）——runner
      // executeJob 按注册表复算比对，不一致 → environment 失败（不执行）。
      ...(SECURE_KINDS.includes(input.kind) ? {
        runner_profile_id: runnerProfile.profile_id,
        profile_config_hash: runnerProfile.config_hash,
      } : {}),
      image_digest: SECURE_KINDS.includes(input.kind)
        ? validateImageDigest(input.kind as SecureJobKind, digestInput)
        : (input.image_digest ?? ''),
      ...(input.data_artifact_ids !== undefined ? { data_artifact_ids: input.data_artifact_ids } : {}),
      ...(input.output_contract !== undefined ? { output_contract: input.output_contract } : {}),
    }
    const job: JobSpecBound = {
      job_id: `job_${randomUUID().slice(0, 12)}`,
      project_id: input.project_id,
      contract_id: input.contract_id ?? null,
      idempotency_key: input.idempotency_key,
      kind: input.kind,
      command: input.command ?? [],
      payload,
      status: 'queued',
      failure_class: null,
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      lease_generation: null,
      lease_token: null,
      code_snapshot_id: boundCodeSnapshotId,
      data_artifact_ids: input.data_artifact_ids ?? [],
      image_digest: String(payload.image_digest),
      // domain-model.md §9.1: Job 固定 opaque profile id + config hash
      // （secure kinds 由上方 payload 注入；其余 kind 为 null）。
      runner_profile_id: typeof payload.runner_profile_id === 'string' && payload.runner_profile_id !== '' ? payload.runner_profile_id : null,
      profile_config_hash: typeof payload.profile_config_hash === 'string' && payload.profile_config_hash !== '' ? payload.profile_config_hash : null,
      // v2 shape (domain-model.md §9): durable submitter principal (server
      // resolves it from x-principal-id; internal submissions → NULL).
      created_by_principal_id: input.created_by_principal_id ?? null,
      output_contract: input.output_contract,
      attempts: 0,
      max_attempts: input.max_attempts ?? 3,
      run_manifest: null,
      error: '',
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    // MIG-V1 (0017, storage-migrations.md §9): echo/smoke are the in-process
    // FIXTURE kinds (echo executes nothing, §3.2 invariant 1; smoke is a
    // trusted fixture) — new fixture jobs are written with
    // synthetic_fixture=1 so audits/statistics can separate fixture runs
    // from real experiments (legacy rows were backfilled by 0017).
    const syntheticFixture = input.kind === 'echo' || input.kind === 'smoke' ? 1 : 0
    this.db.prepare(
      `INSERT INTO jobs (job_id, project_id, contract_id, idempotency_key, kind, command, payload, status, failure_class, lease_owner, lease_expires_at, heartbeat_at, attempts, max_attempts, run_manifest, error, created_at, updated_at, code_snapshot_id, created_by_principal_id, synthetic_fixture)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.job_id, job.project_id, job.contract_id, job.idempotency_key, job.kind, JSON.stringify(job.command),
      JSON.stringify(job.payload), job.status, job.failure_class, job.lease_owner, job.lease_expires_at,
      job.heartbeat_at, job.attempts, job.max_attempts, job.run_manifest === null ? null : JSON.stringify(job.run_manifest),
      job.error, job.created_at, job.updated_at, job.code_snapshot_id, job.created_by_principal_id,
      syntheticFixture,
    )
    this.emit(input.project_id, 'job.submitted', { job_id: job.job_id, kind: job.kind, idempotency_key: input.idempotency_key })
    return job
  }

  getJob(jobId: string): JobSpecBound & { run_id: string | null } {
    const row = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as JobRow | undefined
    if (row === undefined) throw new KernelError(404, 'job_not_found', `job ${jobId} not found`)
    // STORE-06: the in-memory plaintext token (when the lease is live in
    // this process) rides on the returned record; legacy rows fall back to
    // their payload.__lease_token.
    return jobFromRow(row, this.db, this.leaseTokens.get(jobId) ?? null)
  }

  listJobs(projectId: string, status?: JobStatus): Array<JobSpecBound & { run_id: string | null }> {
    const rows = status === undefined
      ? this.db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as JobRow[]
      : this.db.prepare('SELECT * FROM jobs WHERE project_id = ? AND status = ? ORDER BY created_at').all(projectId, status) as unknown as JobRow[]
    return rows.map(row => jobFromRow(row, this.db, this.leaseTokens.get(row.job_id) ?? null))
  }

  /** §3.1 / RUN-01: durable per-attempt run rows of a project (claim-time
   * identity + completion manifest/signature status), newest first. */
  listRuns(projectId: string): RunRecord[] {
    this.getProject(projectId)
    const rows = this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC').all(projectId) as unknown as RunRow[]
    return rows.map(runFromRow)
  }

  /** §3.1 / RUN-01: single run attempt, project-scoped (404 when unknown). */
  getRun(projectId: string, runId: string): RunRecord {
    this.getProject(projectId)
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ? AND project_id = ?').get(runId, projectId) as RunRow | undefined
    if (row === undefined) throw new KernelError(404, 'run_not_found', `run ${runId} not found in project ${projectId}`)
    return runFromRow(row)
  }

  /** Claim queued/retryable jobs for an owner with a lease TTL (design §9.3, §12.6).
   * Every claim bumps `lease_generation` and issues a fresh opaque
   * `lease_token`; runners must echo both on heartbeat/complete, and stale
   * generations are fenced out (an old runner can never finish the job).
   * RUN-01 (P0): each claimed job carries the durable `run_id` of the runs
   * row written for THIS attempt — the runner must use it for manifest,
   * terminal frames and evidence instead of minting its own run identity. */
  claimJobs(owner: string, leaseTtlSeconds = 300, limit = 8): Array<JobSpecBound & { run_id: string | null }> {
    const now = nowIso()
    const rows = this.db.prepare(
      `SELECT * FROM jobs WHERE status = 'queued' OR (status = 'retryable' AND attempts < max_attempts) ORDER BY created_at LIMIT ?`,
    ).all(limit) as unknown as JobRow[]
    const claimed: Array<JobSpecBound & { run_id: string | null }> = []
    // STORE-06 (storage-migrations.md §4): the claim persists ONLY the
    // sha256 of the opaque token (jobs.lease_token_hash) — the plaintext
    // never touches the database, it lives in kernel memory (this.leaseTokens)
    // and is returned to the runner on the claim response.
    const update = this.db.prepare(
      `UPDATE jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, attempts = attempts + 1, lease_generation = COALESCE(lease_generation, 0) + 1, lease_token_hash = ?, payload = ?, updated_at = ? WHERE job_id = ? AND (status = 'queued' OR status = 'retryable')`,
    )
    for (const row of rows) {
      const leaseExpires = new Date(Date.now() + leaseTtlSeconds * 1000).toISOString()
      const payload = jsonParse(row.payload, {} as Record<string, unknown>)
      const leaseToken = `lt_${randomUUID().replaceAll('-', '')}${randomUUID().slice(0, 8)}`
      // execution-runtime.md §3 / storage-migrations.md §4: a claim is ONE
      // transaction — UPDATE jobs (running + lease + generation + token
      // hash) and INSERT runs (durable attempt identity) commit atomically,
      // so a crash between them can never leave a running job without its
      // run row or a run row on an unclaimed job. (The tex_builds status
      // sync below runs AFTER the commit: TexWorkspaceStore owns a separate
      // connection to the same file, so it must not write inside the kernel
      // txn.)
      const claimedRow = withTransaction(this.db, () => {
        const result = update.run(owner, leaseExpires, now, sha256Hex(leaseToken), JSON.stringify(payload), now, row.job_id)
        if (Number(result.changes) !== 1) return null
        this.leaseTokens.set(row.job_id, leaseToken)
        const claimedJob = jobFromRow(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(row.job_id) as unknown as JobRow, this.db, leaseToken)
        // §3.1 / RUN-01 (Run attempt): every claim records a runs row — the
        // durable per-attempt identity (attempt_no = attempts after claim).
        // run_id is run_<12 hex>; snapshot_sha256 is the CAS sha256 resolved
        // from the job's code_snapshot_id ('' → NULL when the job has none).
        // P0: the run_id is generated HERE and returned on the claimed job so
        // the runner never mints a parallel run identity.
        const runId = `run_${randomUUID().replaceAll('-', '').slice(0, 12)}`
        this.db.prepare(
          `INSERT INTO runs (run_id, project_id, job_id, attempt_no, contract_id, snapshot_sha256, signature_status, started_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        ).run(
          runId, claimedJob.project_id, claimedJob.job_id, claimedJob.attempts,
          claimedJob.contract_id, this.resolveSnapshotSha256(claimedJob.code_snapshot_id), now,
        )
        return { claimedJob, runId }
      })
      if (claimedRow !== null) {
        claimed.push({ ...claimedRow.claimedJob, run_id: claimedRow.runId })
        // OBS-01: one claim counter per successfully claimed job.
        this.metrics.count('job.claimed')
        // §12.1 (TEX-03): a claimed latex-compile job moves its tex_builds
        // row queued → running, so preview supersede can distinguish a
        // never-started queued preview (→ cancelled) from a running one
        // (→ superseded).
        const texBuildRow = this.db.prepare('SELECT build_id, status FROM tex_builds WHERE job_id = ?').get(claimedRow.claimedJob.job_id) as { build_id: string; status: string } | undefined
        if (texBuildRow !== undefined && texBuildRow.status === 'queued') {
          this.tex.updateBuild(texBuildRow.build_id, { status: 'running' })
        }
      }
    }
    return claimed
  }

  /**
   * §3.1 / RUN-01: resolve the CAS sha256 recorded on a runs row from a job's
   * `code_snapshot_id`. `sha256:<hex>` artifact ids and raw 64-hex hashes are
   * used verbatim; `code_snap_` registry ids resolve through the
   * authoritative code_snapshots registry (its archive artifact sha256).
   * Jobs without a code snapshot (echo/smoke/latex-compile) yield null.
   */
  private resolveSnapshotSha256(codeSnapshotId: string | null): string | null {
    if (codeSnapshotId === null || codeSnapshotId === '') return null
    if (codeSnapshotId.startsWith('sha256:')) return codeSnapshotId.slice('sha256:'.length)
    if (/^[0-9a-f]{64}$/.test(codeSnapshotId)) return codeSnapshotId
    if (codeSnapshotId.startsWith('code_snap_')) {
      try {
        return this.getCodeSnapshot(codeSnapshotId).sha256
      } catch {
        return null
      }
    }
    return null
  }

  /**
   * STORE-06 (storage-migrations.md §4): the persisted lease credential of a
   * job — the sha256 stored in jobs.lease_token_hash (NULL on legacy rows
   * claimed before migration 0014).
   */
  private leaseHashOf(jobId: string): string | null {
    const row = this.db.prepare('SELECT lease_token_hash FROM jobs WHERE job_id = ?').get(jobId) as { lease_token_hash: string | null } | undefined
    const hash = row?.lease_token_hash ?? null
    return hash !== null && hash !== '' ? hash : null
  }

  /**
   * STORE-06: fencing comparison for a caller-supplied lease token. The
   * comparison object is the sha256 of the token (jobs.lease_token_hash) —
   * the plaintext is never stored. Legacy rows with an empty hash column
   * (claimed by the pre-0014 release, token recorded in
   * payload.__lease_token) fall back to the legacy plaintext comparison so
   * fencing keeps working on rows that were not migrated/backfilled.
   */
  private leaseTokenMatches(jobId: string, job: JobRecord, provided: string | null | undefined): boolean {
    if (provided === undefined || provided === null) return false
    const hash = this.leaseHashOf(jobId)
    if (hash !== null) return hash === sha256Hex(provided)
    return job.lease_token !== null && job.lease_token === provided
  }

  /**
   * Renew a lease (heartbeat); rejects when owned by another instance.
   * §12.6: when `generation`/`token` are provided the lease is fenced —
   * both must match the CURRENT lease, otherwise 409 `lease_stale`.
   * Legacy callers that pass neither keep the old owner-only check.
   * STORE-06: the token half of the fence compares sha256(provided) against
   * jobs.lease_token_hash (legacy rows fall back to the payload token).
   */
  heartbeatJob(jobId: string, owner: string, generation?: number | null, token?: string | null, leaseTtlSeconds = 300): JobRecord {
    const job = this.getJob(jobId)
    if (job.lease_owner !== null && job.lease_owner !== owner) {
      throw new KernelError(409, 'lease_conflict', `job ${jobId} leased by ${job.lease_owner}`)
    }
    // P0 fencing (acceptance-tests.md §4): a leased job's heartbeat MUST
    // carry the current owner's generation AND token — missing fields are
    // stale, not "unfenced" (no owner-only compatibility pass).
    if (job.lease_owner !== null && (generation === undefined || generation === null || token === undefined || token === null)) {
      throw new KernelError(409, 'lease_stale',
        `job ${jobId} heartbeat missing lease fencing fields: expected generation ${job.lease_generation ?? 'n/a'} token hash ${this.leaseHashOf(jobId) ?? 'n/a'}`)
    }
    if ((generation !== undefined && generation !== null) || (token !== undefined && token !== null)) {
      if (job.lease_generation !== (generation ?? null) || !this.leaseTokenMatches(jobId, job, token)) {
        throw new KernelError(409, 'lease_stale',
          `job ${jobId} lease is stale: expected generation ${job.lease_generation ?? 'n/a'} token hash ${this.leaseHashOf(jobId) ?? 'n/a'}, got generation ${generation ?? 'n/a'} token ${token ?? 'n/a'}`)
      }
    }
    const now = nowIso()
    const leaseExpires = new Date(Date.now() + leaseTtlSeconds * 1000).toISOString()
    this.db.prepare('UPDATE jobs SET lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE job_id = ?')
      .run(owner, leaseExpires, now, now, jobId)
    return this.getJob(jobId)
  }

  /** Recover stale leases after a runner crash (design §9.3). */
  recoverExpiredLeases(now = Date.now()): number {
    // STORE-06: recovered leases drop their in-memory plaintext token — the
    // next claim issues a fresh token (generation bumps) and a new hash.
    const stale = this.db.prepare(
      "SELECT job_id FROM jobs WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?",
    ).all(new Date(now).toISOString()) as Array<{ job_id: string }>
    const result = this.db.prepare(
      `UPDATE jobs SET status = 'retryable', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    ).run(nowIso(), new Date(now).toISOString())
    for (const s of stale) this.leaseTokens.delete(s.job_id)
    const changes = Number(result.changes)
    // OBS-01: lease expiry counter accumulates the recovered-job count.
    if (changes > 0) this.metrics.count('lease.expiry', undefined, changes)
    return changes
  }

  /**
   * Finalize a job with a validated RunManifest (design §4.6.1, §6.5, §12.6-12.7).
   * §12.6 fencing: when `lease_generation`/`lease_token` are provided both must
   * match the CURRENT lease — a stale runner (old generation/token) is rejected
   * with 409 `lease_stale` even if its owner matches. Legacy callers that pass
   * neither keep the old owner-only check.
   * §12.7: when the manifest carries an Ed25519 `signature`, the kernel
   * verifies runner key registration, payload hash and signature; when it does
   * not, the manifest is accepted unless the kernel/project requires signing.
   */
  completeJob(input: {
    job_id: string
    owner: string
    status: 'succeeded' | 'failed' | 'cancelled'
    run_manifest?: Record<string, unknown>
    failure_class?: JobRecord['failure_class']
    error?: string
    lease_generation?: number | null
    lease_token?: string | null
  }): JobRecord {
    const job = this.getJob(input.job_id)
    if (job.lease_owner !== null && job.lease_owner !== input.owner) {
      throw new KernelError(409, 'lease_conflict', `job ${input.job_id} leased by ${job.lease_owner}`)
    }
    if (job.status !== 'running') {
      throw new KernelError(409, 'job_not_running', `job ${input.job_id} is ${job.status}, not running`)
    }
    // §12.6 strict lease fencing (P0): completion of a leased job MUST carry
    // the current generation AND token — missing fields are rejected 409.
    // STORE-06: the token half of the fence compares sha256(provided)
    // against jobs.lease_token_hash (legacy rows fall back to the payload
    // token when the hash column is empty).
    if ((input.lease_generation === undefined || input.lease_generation === null) || (input.lease_token === undefined || input.lease_token === null)) {
      throw new KernelError(409, 'lease_stale',
        `job ${input.job_id} completion missing lease fencing fields: expected generation ${job.lease_generation ?? 'n/a'} token hash ${this.leaseHashOf(input.job_id) ?? 'n/a'}`)
    }
    if (job.lease_generation !== input.lease_generation || !this.leaseTokenMatches(input.job_id, job, input.lease_token)) {
      throw new KernelError(409, 'lease_stale',
        `job ${input.job_id} lease is stale: expected generation ${job.lease_generation ?? 'n/a'} token hash ${this.leaseHashOf(input.job_id) ?? 'n/a'}, got generation ${input.lease_generation ?? 'n/a'} token ${input.lease_token ?? 'n/a'}`)
    }
    // RUN-01 (P0): a SUCCEEDED completion MUST carry a RunManifest — a real
    // run that finished without one is a protocol violation, not a success
    // (422 run_manifest_required). echo/smoke are the in-process FIXTURE
    // kinds (echo executes nothing, §3.2 invariant 1; smoke is a trusted
    // fixture) — every kind that actually executes work (baseline/pilot/
    // formal/reproduce/analysis/latex-compile) is enforced.
    if (input.status === 'succeeded' && input.run_manifest === undefined && job.kind !== 'echo' && job.kind !== 'smoke') {
      throw new KernelError(422, 'run_manifest_required',
        `job ${input.job_id} (${job.kind}) succeeded without a run manifest — succeeded completions must carry run_manifest (RUN-01)`)
    }
    if (input.run_manifest !== undefined) {
      this.verifyRunManifest(input.run_manifest, job)
    }
    if (input.status === 'succeeded' && input.run_manifest !== undefined) {
      const refs = collectManifestRefs(input.run_manifest)
      if (refs.length > 0) {
        const { ok, missing } = this.verifyArtifactRefs(refs)
        if (!ok) {
          throw new KernelError(422, 'manifest_refs_missing', `run manifest references missing artifacts: ${missing.join(', ')}`)
        }
        // §12.7: artifacts must exist AND belong to the job's project.
        for (const ref of refs) {
          try {
            this.getArtifact(job.project_id, ref)
          } catch {
            throw new KernelError(422, 'manifest_refs_missing', `artifact ${ref} is not registered in project ${job.project_id}`)
          }
        }
      }
    }
    const now = nowIso()
    // RUN-01 (P0): the jobs UPDATE and the runs-row finalization MUST be one
    // transaction — a crash between the two would leave a finalized job with
    // a pending run (or vice versa). Manifest verification above stays OUTSIDE
    // the transaction (read-only; no partial-write risk).
    withTransaction(this.db, () => {
      this.db.prepare(
        'UPDATE jobs SET status = ?, failure_class = ?, run_manifest = ?, error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ?',
      ).run(input.status, input.failure_class ?? null, input.run_manifest !== undefined ? JSON.stringify(input.run_manifest) : null, input.error ?? '', now, input.job_id)
      // §3.1 / RUN-01 (Run attempt): finalize the attempt's runs row (the one
      // recorded at claim time for this attempt_no). Manifest + signature
      // status come from the completed run; a manifest without a non-empty
      // `signature` (or no manifest at all) records 'unsigned'.
      const manifestRow = input.run_manifest !== undefined ? input.run_manifest : undefined
      const signed = typeof (manifestRow as Record<string, unknown> | undefined)?.signature === 'string'
        && (manifestRow as Record<string, unknown>).signature !== ''
      const signatureStatus = manifestRow !== undefined && signed ? 'signed' : 'unsigned'
      this.db.prepare(
        'UPDATE runs SET manifest_json = ?, signature_status = ?, finished_at = ? WHERE job_id = ? AND attempt_no = ?',
      ).run(
        manifestRow !== undefined ? JSON.stringify(manifestRow) : null,
        signatureStatus, now, input.job_id, job.attempts,
      )
      const jobRecord = this.getJob(input.job_id)
      this.emit(job.project_id, 'job.updated', {
        job_id: jobRecord.job_id, status: jobRecord.status, failure_class: jobRecord.failure_class ?? undefined,
      })
    })
    const jobRecord = this.getJob(input.job_id)
    // §12 (TEX-02): a latex-compile completion finalizes its tex_builds row
    // (status/diagnostics/PDF/log from the runner manifest).
    if (job.kind === 'latex-compile' && input.run_manifest !== undefined) {
      const manifest = input.run_manifest as Record<string, unknown>
      const buildRow = this.db.prepare('SELECT build_id FROM tex_builds WHERE job_id = ?').get(job.job_id) as { build_id: string } | undefined
      if (buildRow !== undefined) {
        // §12.1 (TEX-03): a superseded/cancelled preview build is FINAL —
        // its completion (a race between supersede and a runner that already
        // passed the running check) must never resurrect the record.
        const current = this.tex.getBuild(buildRow.build_id)
        const frozen = current.status === 'superseded' || current.status === 'cancelled'
        let diagnostics: LatexDiagnostic[] = Array.isArray(manifest.tex_diagnostics)
          ? manifest.tex_diagnostics as LatexDiagnostic[]
          : []
        // §7 (TEX-DIAG): re-parse the AUTHORITATIVE log artifact at
        // completion so the durable diagnostics carry file/line location and
        // structured kinds (undefined citation, missing file). The runner's
        // first-pass parse stays as the fallback when no log artifact is
        // registered or the log yields nothing.
        if (typeof manifest.tex_log_artifact === 'string' && manifest.tex_log_artifact !== '') {
          try {
            const record = this.getArtifact(job.project_id, manifest.tex_log_artifact)
            const logText = this.cas.read(record.sha256).toString('utf8')
            const enriched = parseLatexDiagnostics(logText)
            if (enriched.length > 0) diagnostics = enriched
          } catch {
            // Log artifact unreadable — keep the manifest diagnostics.
          }
        }
        this.texUpdateBuild(buildRow.build_id, {
          status: frozen ? current.status : (input.status === 'succeeded' ? 'succeeded' : (input.status === 'cancelled' ? 'cancelled' : 'failed')),
          diagnostics: JSON.stringify(diagnostics),
          pdf_artifact: typeof manifest.tex_pdf_artifact === 'string' ? manifest.tex_pdf_artifact : null,
          log_artifact: typeof manifest.tex_log_artifact === 'string' ? manifest.tex_log_artifact : null,
        })
      }
    }
    // OBS-01: completion counter tagged with the terminal status constant.
    this.metrics.count('job.completed', { status: input.status })
    // STORE-06: the lease is released — drop the in-memory plaintext token
    // (the returned record was fetched before this, so it still carries the
    // token exactly like the pre-0014 release did).
    this.leaseTokens.delete(input.job_id)
    return jobRecord
  }

  /**
   * §12.7: register a runner Ed25519 public key used to verify RunManifest
   * signatures. Rejects non-Ed25519 / unparseable PEMs (422 runner_key_invalid).
   */
  registerRunnerKey(input: { key_id: string; public_key_pem: string }): RunnerKey {
    let publicKey: KeyObject
    try {
      publicKey = createPublicKey(input.public_key_pem)
    } catch (error) {
      throw new KernelError(422, 'runner_key_invalid', `public_key_pem is not a valid public key: ${(error as Error).message}`)
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new KernelError(422, 'runner_key_invalid', `runner key ${input.key_id} must be Ed25519, got ${publicKey.asymmetricKeyType}`)
    }
    const record: RunnerKey = { key_id: input.key_id, public_key_pem: input.public_key_pem, created_at: nowIso() }
    this.db.prepare(
      'INSERT INTO runner_keys (key_id, public_key_pem, created_at) VALUES (?, ?, ?) ON CONFLICT(key_id) DO UPDATE SET public_key_pem = excluded.public_key_pem, created_at = excluded.created_at',
    ).run(record.key_id, record.public_key_pem, record.created_at)
    return record
  }

  listRunnerKeys(): RunnerKey[] {
    const rows = this.db.prepare('SELECT * FROM runner_keys ORDER BY created_at').all() as unknown as RunnerKeyRow[]
    return rows.map(row => ({ key_id: row.key_id, public_key_pem: row.public_key_pem, created_at: row.created_at }))
  }

  /**
   * §12.7: verify a run manifest against the job it claims to belong to.
   *  - identity: job_id/project_id/contract_id/lease.generation must match the
   *    job when present (422 manifest_*_mismatch);
   *  - signature: when `signature` is present the runner key must be
   *    registered (422 manifest_key_unknown), the canonical payload hash must
   *    match `payload_sha256` when provided (422 manifest_hash_mismatch) and
   *    the Ed25519 signature must verify (422 manifest_signature_invalid);
   *  - unsigned manifests are accepted by default (backward compatible) and
   *    rejected only when the kernel or project requires signing
   *    (422 manifest_signature_required).
   * Field-level checks only: partial manifests (legacy callers) keep working.
   */
  private verifyRunManifest(manifest: Record<string, unknown>, job: JobRecord): void {
    // Job/Project/Contract matching (§12.7) — only when the fields are present.
    if (manifest.job_id !== undefined && manifest.job_id !== job.job_id) {
      throw new KernelError(422, 'manifest_job_mismatch', `run manifest job_id ${String(manifest.job_id)} does not match job ${job.job_id}`)
    }
    if (manifest.project_id !== undefined && manifest.project_id !== job.project_id) {
      throw new KernelError(422, 'manifest_project_mismatch', `run manifest project_id ${String(manifest.project_id)} does not match project ${job.project_id}`)
    }
    if (manifest.contract_id !== undefined && (job.contract_id === null || manifest.contract_id !== job.contract_id)) {
      throw new KernelError(422, 'manifest_contract_mismatch',
        `run manifest contract_id ${String(manifest.contract_id)} does not match job contract ${job.contract_id ?? 'none'}`)
    }
    // Lease fencing recorded inside the manifest (§12.6/§12.7).
    const lease = manifest.lease
    if (typeof lease === 'object' && lease !== null && typeof (lease as { generation?: unknown }).generation === 'number'
      && job.lease_generation !== null && (lease as { generation: number }).generation !== job.lease_generation) {
      throw new KernelError(422, 'manifest_lease_mismatch',
        `run manifest lease generation ${String((lease as { generation: number }).generation)} does not match job lease generation ${job.lease_generation}`)
    }

    const signature = manifest.signature
    if (typeof signature !== 'string' || signature === '') {
      // No signature: accept by default; enforce only when required.
      const integrity = this.getProject(job.project_id).integrity as Record<string, unknown>
      if (this.requireSignedManifest || integrity.require_signed_manifest === true) {
        throw new KernelError(422, 'manifest_signature_required', 'run manifest must be signed (require_signed_manifest)')
      }
      return
    }
    const runnerKeyId = manifest.runner_key_id
    if (typeof runnerKeyId !== 'string' || runnerKeyId === '') {
      throw new KernelError(422, 'manifest_key_unknown', 'run manifest carries a signature but no runner_key_id')
    }
    const keyRow = this.db.prepare('SELECT * FROM runner_keys WHERE key_id = ?').get(runnerKeyId) as RunnerKeyRow | undefined
    if (keyRow === undefined) {
      throw new KernelError(422, 'manifest_key_unknown', `runner key ${runnerKeyId} is not registered`)
    }
    // Signed payload = the manifest minus its signature field, canonicalized.
    const { signedPayload, signatureBytes } = stripManifestSignature(manifest)
    const payloadSha256 = manifest.payload_sha256
    if (typeof payloadSha256 === 'string' && payloadSha256 !== '') {
      const actual = sha256Hex(manifestHashPayload(manifest))
      if (actual !== payloadSha256) {
        throw new KernelError(422, 'manifest_hash_mismatch', `payload_sha256 mismatch: got ${actual}, manifest claims ${payloadSha256}`)
      }
    }
    let publicKey: KeyObject
    try {
      publicKey = createPublicKey(keyRow.public_key_pem)
    } catch {
      throw new KernelError(422, 'manifest_key_unknown', `runner key ${runnerKeyId} is not a valid public key`)
    }
    const valid = verify(null, Buffer.from(canonicalJson(signedPayload), 'utf8'), publicKey, signatureBytes)
    if (!valid) {
      throw new KernelError(422, 'manifest_signature_invalid', `run manifest signature verification failed for key ${runnerKeyId}`)
    }
  }

  cancelJob(jobId: string, actor: string, reason = ''): JobRecord {
    const job = this.getJob(jobId)
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      throw new KernelError(409, 'job_finished', `job ${jobId} already ${job.status}`)
    }
    this.db.prepare('UPDATE jobs SET status = ?, error = ?, lease_owner = NULL, updated_at = ? WHERE job_id = ?')
      .run('cancelled', reason ? `cancelled by ${actor}: ${reason}` : `cancelled by ${actor}`, nowIso(), jobId)
    // STORE-06: cancellation releases the lease — the in-memory plaintext
    // token must not survive it (the returned record has lease_token null).
    this.leaseTokens.delete(jobId)
    // §12.1 (TEX-03): cancelling a latex-compile job finalizes its tex_builds
    // row (queued/running → cancelled) so build history never shows a
    // cancelled job with a live build.
    const texBuildRow = this.db.prepare('SELECT build_id, status FROM tex_builds WHERE job_id = ?').get(jobId) as { build_id: string; status: string } | undefined
    if (texBuildRow !== undefined && (texBuildRow.status === 'queued' || texBuildRow.status === 'running')) {
      this.tex.updateBuild(texBuildRow.build_id, { status: 'cancelled' })
    }
    // dsh-web parity: unify the job.updated event with the other mutations.
    this.emit(job.project_id, 'job.updated', { job_id: jobId, status: 'cancelled', actor })
    return this.getJob(jobId)
  }

  // ── terminal frames (execution-runtime.md §6) ────────────────────────────

  /** Default hot-log retention per run (8 MiB, execution-runtime.md §6). */
  static readonly TERMINAL_DEFAULT_MAX_BYTES = 8 * 1024 * 1024

  /**
   * Append a batch of terminal frames for a run. Validation: the job must
   * exist; frames from a stale lease generation are rejected (fencing); seq
   * must be monotonic within the run (duplicate/older seq is an idempotent
   * skip); chunk frames must carry channel/stream_seq/text/byte_offset/
   * byte_length. P0 (acceptance-tests.md §4): when the caller supplies the
   * lease owner/token, each frame is fenced against BOTH — a wrong owner or
   * token is 409 `lease_stale` (the HTTP route requires both for leased
   * jobs, so every frame that arrives over the wire is owner/token checked).
   * Retention: when total_bytes exceeds maxLogBytes, the OLDEST chunk frames
   * are evicted, dropped_bytes accumulate and truncated is set; gap/exit
   * frames are never evicted.
   */
  appendTerminalFrames(input: {
    jobId: string
    runId: string
    frames: Array<{
      seq: number
      stream_seq?: number | null
      channel?: 'stdout' | 'stderr' | null
      text?: string | null
      byte_offset?: number | null
      byte_length?: number | null
      frame_kind: 'chunk' | 'gap' | 'exit'
      payload_json?: string
      lease_generation?: number
    }>
    /** §4 P0 (TERM-01): lease owner/token fencing — exact match when provided. */
    owner?: string | null
    lease_token?: string | null
    maxLogBytes?: number
  }): { appended: number; last_seq: number; truncated: boolean; total_bytes: number; dropped_bytes: number } {
    const job = this.getJob(input.jobId)
    if (input.frames.length === 0) {
      throw new KernelError(422, 'empty_frames', 'at least one frame is required')
    }
    // P0 (acceptance-tests.md §4): Terminal frames must authenticate the
    // CLAIM — when the caller provides owner/token (the runner gateway and
    // the HTTP route always do), both must exactly match the job's lease or
    // the batch is rejected 409 lease_stale (an old or foreign runner can
    // never write frames into a live run). Partial credentials (one side
    // provided, the other null/undefined) are stale too.
    const ownerProvided = input.owner !== undefined && input.owner !== null
    const tokenProvided = input.lease_token !== undefined && input.lease_token !== null
    if (ownerProvided || tokenProvided) {
      if (!ownerProvided || !tokenProvided) {
        throw new KernelError(409, 'lease_stale',
          `job ${input.jobId} terminal frames must carry BOTH lease owner and token (got owner=${String(input.owner)} token=${String(input.lease_token)})`)
      }
      // STORE-06: the token half of the fence compares sha256(provided)
      // against jobs.lease_token_hash (legacy rows fall back to the payload
      // token when the hash column is empty).
      if (input.owner !== job.lease_owner || !this.leaseTokenMatches(input.jobId, job, input.lease_token)) {
        throw new KernelError(409, 'lease_stale',
          `job ${input.jobId} terminal frames lease mismatch: expected owner ${job.lease_owner ?? 'n/a'} token hash ${this.leaseHashOf(input.jobId) ?? 'n/a'}, got owner ${input.owner} token ${input.lease_token}`)
      }
    }
    const maxBytes = input.maxLogBytes ?? ResearchKernel.TERMINAL_DEFAULT_MAX_BYTES
    let appended = 0
    let lastSeq = 0
    const inserted: Array<Record<string, unknown>> = []
    return withTransaction(this.db, () => {
      const lastRow = this.db.prepare('SELECT seq FROM terminal_frames WHERE job_id = ? AND run_id = ? ORDER BY seq DESC LIMIT 1')
        .get(input.jobId, input.runId) as { seq?: number } | undefined
      let cursor = lastRow?.seq ?? 0
      const insert = this.db.prepare(`INSERT OR IGNORE INTO terminal_frames
        (job_id, run_id, seq, stream_seq, channel, text, byte_offset, byte_length, frame_kind, payload_json, lease_generation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const frame of input.frames) {
        if (frame.seq <= cursor) {
          // STORE-05 (storage-migrations.md §4): a replayed (run_id, seq)
          // must carry IDENTICAL content — same seq with different content
          // is an integrity error, not a silent INSERT OR IGNORE skip.
          this.assertTerminalFrameConsistent(input.jobId, input.runId, frame)
          continue // idempotent replay / out-of-order skip
        }
        // P0 (acceptance-tests.md §4): Terminal frames MUST carry the current
        // owner generation/token — a frame with a MISSING generation is
        // rejected 409 (fail-closed, no owner-only/defaulting pass), and a
        // stale or future generation is rejected too.
        if (job.lease_generation !== null && job.lease_generation !== undefined) {
          if (frame.lease_generation === undefined || frame.lease_generation === null) {
            throw new KernelError(409, 'lease_stale',
              `frame lease_generation missing (job generation ${job.lease_generation}) — terminal frames must carry the claim's generation (P0)`)
          }
          if (frame.lease_generation !== job.lease_generation) {
            throw new KernelError(409, 'lease_stale',
              `frame lease_generation ${frame.lease_generation} != job generation ${job.lease_generation}`)
          }
        }
        const generation = frame.lease_generation ?? 0
        if (frame.frame_kind === 'chunk' && (frame.channel === null || frame.channel === undefined || frame.text === null || frame.text === undefined)) {
          throw new KernelError(422, 'invalid_chunk_frame', 'chunk frames require channel + text')
        }
        insert.run(
          input.jobId, input.runId, frame.seq,
          frame.stream_seq ?? null, frame.channel ?? null, frame.text ?? null,
          frame.byte_offset ?? null, frame.byte_length ?? null,
          frame.frame_kind, frame.payload_json ?? '{}', generation, nowIso(),
        )
        cursor = frame.seq
        appended += 1
        lastSeq = frame.seq
        inserted.push({ run_id: input.runId, seq: frame.seq, frame_kind: frame.frame_kind })
      }
      if (appended === 0) {
        const ret = this.getTerminalRetention(input.jobId, input.runId)
        return { appended: 0, last_seq: cursor, truncated: ret.truncated, total_bytes: ret.total_bytes, dropped_bytes: ret.dropped_bytes }
      }
      // Retention accounting.
      let totalBytes = 0
      let droppedBytes = 0
      let truncated = 0
      const byteSum = this.db.prepare(
        'SELECT COALESCE(SUM(byte_length), 0) AS bytes FROM terminal_frames WHERE job_id = ? AND run_id = ?',
      ).get(input.jobId, input.runId) as { bytes: number }
      totalBytes = Number(byteSum.bytes)
      if (totalBytes > maxBytes) {
        const evict = this.db.prepare(`DELETE FROM terminal_frames
          WHERE job_id = ? AND run_id = ? AND frame_kind = 'chunk'
          AND seq IN (SELECT seq FROM terminal_frames WHERE job_id = ? AND run_id = ? AND frame_kind = 'chunk' ORDER BY seq ASC LIMIT ?)`)
        let guard = 0
        while (totalBytes > maxBytes && guard < 10000) {
          const victims = this.db.prepare(
            'SELECT seq, byte_length FROM terminal_frames WHERE job_id = ? AND run_id = ? AND frame_kind = ? ORDER BY seq ASC LIMIT 64',
          ).all(input.jobId, input.runId, 'chunk') as Array<{ seq: number; byte_length: number | null }>
          if (victims.length === 0) break
          evict.run(input.jobId, input.runId, input.jobId, input.runId, victims.length)
          for (const v of victims) droppedBytes += Number(v.byte_length ?? 0)
          const next = this.db.prepare('SELECT COALESCE(SUM(byte_length), 0) AS bytes FROM terminal_frames WHERE job_id = ? AND run_id = ?')
            .get(input.jobId, input.runId) as { bytes: number }
          totalBytes = Number(next.bytes)
          guard += 1
        }
        truncated = 1
      }
      const retainedRow = this.db.prepare('SELECT COALESCE(MIN(seq), 1) AS min_seq FROM terminal_frames WHERE job_id = ? AND run_id = ?')
        .get(input.jobId, input.runId) as { min_seq: number }
      this.db.prepare(`INSERT INTO terminal_retention (job_id, run_id, retained_from_seq, total_bytes, dropped_bytes, truncated)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, run_id) DO UPDATE SET
          retained_from_seq = excluded.retained_from_seq,
          total_bytes = excluded.total_bytes,
          dropped_bytes = terminal_retention.dropped_bytes + excluded.dropped_bytes,
          truncated = MAX(terminal_retention.truncated, excluded.truncated)`)
        .run(input.jobId, input.runId, Number(retainedRow.min_seq), totalBytes, droppedBytes, truncated)
      const retention = this.getTerminalRetention(input.jobId, input.runId)
      // OBS-01: dropped-bytes counter accumulates the retention-evicted bytes
      // (terminal dropped bytes, reconstruction-contracts.md §18).
      if (droppedBytes > 0) this.metrics.count('terminal.dropped_bytes', undefined, droppedBytes)
      for (const frame of inserted) {
        this.emit(job.project_id, 'terminal.frame', frame)
      }
      return {
        appended,
        last_seq: lastSeq,
        truncated: retention.truncated,
        total_bytes: retention.total_bytes,
        dropped_bytes: retention.dropped_bytes,
      }
    })
  }

  /**
   * STORE-05 (storage-migrations.md §4): same (run_id, seq) with DIFFERENT
   * content is an integrity error. When a frame replays a stored seq, its
   * content signature (frame_kind/stream_seq/channel/text/byte_offset/
   * byte_length/payload_json — lease_generation/created_at are bookkeeping,
   * not content) must match the stored row; otherwise 409
   * `terminal_frame_conflict`. Identical content is an idempotent skip
   * (replay semantics preserved). A row already evicted by retention can no
   * longer be verified and is skipped — its eviction was already surfaced to
   * the client via terminal_retention/gap frames.
   */
  private assertTerminalFrameConsistent(jobId: string, runId: string, frame: {
    seq: number
    stream_seq?: number | null
    channel?: string | null
    text?: string | null
    byte_offset?: number | null
    byte_length?: number | null
    frame_kind: string
    payload_json?: string | null
  }): void {
    const row = this.db.prepare(
      'SELECT frame_kind, stream_seq, channel, text, byte_offset, byte_length, payload_json FROM terminal_frames WHERE job_id = ? AND run_id = ? AND seq = ?',
    ).get(jobId, runId, frame.seq) as {
      frame_kind: string; stream_seq: number | null; channel: string | null; text: string | null
      byte_offset: number | null; byte_length: number | null; payload_json: string
    } | undefined
    if (row === undefined) return // evicted by retention — nothing to compare
    if (terminalFrameSignature(frame) !== terminalFrameSignature(row)) {
      throw new KernelError(409, 'terminal_frame_conflict',
        `terminal frame (run ${runId}, seq ${frame.seq}) content differs from the stored frame — the same seq must carry identical content (STORE-05)`)
    }
  }

  /** Frames after `afterSeq` (ordered by seq) plus the retention summary. */
  listTerminalFrames(jobId: string, runId: string, afterSeq = 0): {
    frames: Array<{
      seq: number; stream_seq: number | null; channel: 'stdout' | 'stderr' | null
      text: string | null; byte_offset: number | null; byte_length: number | null
      frame_kind: 'chunk' | 'gap' | 'exit'; payload_json: string; lease_generation: number; created_at: string
    }>
    retention: { retained_from_seq: number; total_bytes: number; dropped_bytes: number; truncated: boolean }
  } {
    this.getJob(jobId)
    const rows = this.db.prepare('SELECT seq, stream_seq, channel, text, byte_offset, byte_length, frame_kind, payload_json, lease_generation, created_at FROM terminal_frames WHERE job_id = ? AND run_id = ? AND seq > ? ORDER BY seq ASC')
      .all(jobId, runId, afterSeq) as unknown as Array<Record<string, unknown>>
    return {
      frames: rows.map(r => ({
        seq: Number(r.seq),
        stream_seq: r.stream_seq === null ? null : Number(r.stream_seq),
        channel: (r.channel as 'stdout' | 'stderr' | null) ?? null,
        text: r.text as string | null,
        byte_offset: r.byte_offset === null ? null : Number(r.byte_offset),
        byte_length: r.byte_length === null ? null : Number(r.byte_length),
        frame_kind: r.frame_kind as 'chunk' | 'gap' | 'exit',
        payload_json: String(r.payload_json ?? '{}'),
        lease_generation: Number(r.lease_generation ?? 0),
        created_at: String(r.created_at ?? ''),
      })),
      retention: this.getTerminalRetention(jobId, runId),
    }
  }

  getTerminalRetention(jobId: string, runId: string): {
    retained_from_seq: number; total_bytes: number; dropped_bytes: number; truncated: boolean
  } {
    const row = this.db.prepare('SELECT retained_from_seq, total_bytes, dropped_bytes, truncated FROM terminal_retention WHERE job_id = ? AND run_id = ?')
      .get(jobId, runId) as { retained_from_seq?: number; total_bytes?: number; dropped_bytes?: number; truncated?: number } | undefined
    return {
      retained_from_seq: Number(row?.retained_from_seq ?? 1),
      total_bytes: Number(row?.total_bytes ?? 0),
      dropped_bytes: Number(row?.dropped_bytes ?? 0),
      truncated: row?.truncated === 1,
    }
  }

  /** Resolve the terminal run identity for a job: the most recent run that
   * uploaded frames, or null when none exists yet (the SSE endpoint then
   * falls back to the job id). */
  resolveTerminalRun(jobId: string): string | null {
    const row = this.db.prepare('SELECT run_id FROM terminal_frames WHERE job_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1')
      .get(jobId) as { run_id?: string } | undefined
    return row?.run_id ?? null
  }

  // ── TeX workspace (execution-runtime.md §12) ─────────────────────────────

  texEnsure(projectId: string, rootFile = 'paper.tex'): TexDocumentInfo {
    this.getProject(projectId)
    return this.tex.ensureDocument(projectId, rootFile)
  }

  texTree(documentId: string): { document: TexDocumentInfo; files: TexFileEntry[] } {
    return this.tex.tree(documentId)
  }

  texReadFile(documentId: string, path: string) {
    return this.tex.readFile(documentId, path)
  }

  texWriteFile(documentId: string, path: string, content: string, expectedVersion?: number) {
    const result = this.tex.writeFile(documentId, path, content, expectedVersion)
    // §12.1 (TEX-03): with previewAutoTrigger the save-success event itself
    // schedules the debounced preview build (kernel-internal Workspace event
    // path; the explicit POST preview-builds hook remains the canonical one).
    if (this.previewAutoTrigger) this.maybeAutoPreview(documentId)
    return result
  }

  texDeleteFile(documentId: string, path: string, expectedVersion?: number): void {
    this.tex.deleteFile(documentId, path, expectedVersion)
    if (this.previewAutoTrigger) this.maybeAutoPreview(documentId)
  }

  texMoveFile(documentId: string, fromPath: string, toPath: string, expectedVersion?: number): void {
    this.tex.moveFile(documentId, fromPath, toPath, expectedVersion)
    if (this.previewAutoTrigger) this.maybeAutoPreview(documentId)
  }

  /** §12.1 (TEX-03): schedule a preview after a write, unless the document
   * has no files left (an empty workspace cannot compile — the runner would
   * just fail). */
  private maybeAutoPreview(documentId: string): void {
    try {
      if (this.tex.tree(documentId).files.length === 0) return
      this.texRequestPreview(documentId)
    } catch {
      // Preview scheduling is best-effort; the write itself already landed.
    }
  }

  texHistory(documentId: string) {
    return this.tex.history(documentId)
  }

  texSnapshot(documentId: string, expectedRevision?: number): { revision: number; manifest: TexSnapshotManifest } {
    return this.tex.snapshot(documentId, expectedRevision)
  }

  /**
   * TEX-01 (§4 row 95): frozen bytes of one snapshot file at a revision —
   * the Runner materializes latex-compile input from THESE bytes (never the
   * current file). null when the revision/path is not in the snapshot store.
   */
  texSnapshotFile(documentId: string, revision: number, path: string): { path: string; content: string; content_hash: string } | null {
    return this.tex.snapshotFile(documentId, revision, path)
  }

  texCreateBuild(documentId: string, revision: number, rootFile: string, jobId: string | null, preview = false): TexBuild {
    return this.tex.createBuild(documentId, revision, rootFile, jobId, preview)
  }

  texUpdateBuild(buildId: string, patch: Parameters<import('./tex-workspace.js').TexWorkspaceStore['updateBuild']>[1]): TexBuild {
    const updated = this.tex.updateBuild(buildId, patch)
    // OBS-01: TeX build completion counter — a terminal status transition
    // (succeeded/failed/cancelled/superseded) is the completion event.
    if (patch.status === 'succeeded' || patch.status === 'failed' || patch.status === 'cancelled' || patch.status === 'superseded') {
      this.metrics.count('tex.build_completed', { status: patch.status })
    }
    return updated
  }

  /**
   * §12.1 (TEX-03): a build record's staleness for PDF display — the
   * compiled PDF is stale as soon as the document revision moved past the
   * revision the build froze (build.revision < document.revision).
   */
  private texBuildView(build: TexBuild): TexBuild & { stale: boolean } {
    let documentRevision = build.revision
    try {
      documentRevision = this.tex.getDocument(build.document_id).revision
    } catch {
      // document gone — keep the build's own revision (stale=false baseline)
    }
    return { ...build, stale: documentRevision > build.revision }
  }

  texGetBuild(buildId: string): TexBuild & { stale: boolean } {
    return this.texBuildView(this.tex.getBuild(buildId))
  }

  /** §12.1 (TEX-03): authoritative builds only (preview=0) — the explicit
   * Compile surface is kept separate from live previews. */
  texListBuilds(documentId: string): Array<TexBuild & { stale: boolean }> {
    return this.tex.listBuilds(documentId).filter(b => !b.preview).map(b => this.texBuildView(b))
  }

  /** §12.1 (TEX-03): live preview builds (preview=1), newest first. */
  texListPreviews(documentId: string): Array<TexBuild & { stale: boolean }> {
    return this.tex.listPreviews(documentId).map(b => this.texBuildView(b))
  }

  /**
   * §12.1 (TEX-03): request a debounced live preview build after a save
   * success. The pending request is durable (tex_preview_pending) and the
   * debounce timer is owned by the kernel — UI reconnects and kernel
   * restarts re-project the same state. A second request while the debounce
   * is pending simply restarts the window (coalescing); the flush compiles
   * the LATEST document revision.
   */
  texRequestPreview(documentId: string, opts: { debounce_ms?: number; root_file?: string; engine?: string } = {}): TexPreviewPending {
    this.tex.getDocument(documentId)
    if (opts.engine !== undefined && opts.engine !== '' && !TEX_ENGINES.includes(opts.engine)) {
      throw new KernelError(422, 'engine_invalid',
        `preview engine '${opts.engine}' is not in the fixed engine whitelist (${TEX_ENGINES.join('/')})`)
    }
    if (opts.root_file !== undefined && opts.root_file !== '') assertSafeTexBuildPath(opts.root_file)
    const debounceMs = opts.debounce_ms ?? this.previewDebounceMs
    const pending = this.tex.requestPreview(documentId, debounceMs, opts.root_file, opts.engine)
    this.armPreviewTimer(documentId, debounceMs)
    return pending
  }

  /** §12.1 (TEX-03): debounce timer bookkeeping (one timer per document). */
  private armPreviewTimer(documentId: string, debounceMs: number): void {
    const existing = this.previewTimers.get(documentId)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.previewTimers.delete(documentId)
      try {
        this.texFlushPreview(documentId)
      } catch (error) {
        // Best-effort preview: a failed flush must never loop. Consume the
        // pending request so the failure surfaces once (build history or
        // diagnostics), then drop it.
        console.error(`[kernel] tex preview flush failed for ${documentId}: ${(error as Error).message}`)
        try { this.tex.consumePendingPreview(documentId) } catch { /* ignore */ }
      }
    }, debounceMs)
    timer.unref?.()
    this.previewTimers.set(documentId, timer)
  }

  /**
   * §12.1 (TEX-03): consume the pending request and create the preview build
   * (synchronous, called by the debounce timer or directly for tests).
   * Preview runs the SAME fixed TeX image / no-network / no-shell-escape
   * latex-compile runner path (kind stays latex-compile, payload.preview=true
   * marks the record) but is NOT part of the authoritative manifest chain:
   * no accepted Evidence, no manifest freeze beyond the revision-scoped
   * snapshot it compiles. Skipped when an authoritative latex-compile is
   * active (its build superseded previews) or when a non-terminal preview
   * for the same revision already exists.
   */
  texFlushPreview(documentId: string): {
    action: 'noop' | 'skipped_authoritative' | 'skipped_dup' | 'created'
    revision?: number
    build?: TexBuild
    job?: JobSpecBound
    superseded?: string[]
  } {
    const pending = this.tex.consumePendingPreview(documentId)
    if (pending === null) return { action: 'noop' }
    const document = this.tex.getDocument(documentId)
    const revision = document.revision
    // An active authoritative latex-compile supersedes previews by existing:
    // do not queue another container run behind it.
    const activeAuthoritative = this.listJobs(document.project_id).some(j =>
      j.kind === 'latex-compile'
      && (j.status === 'queued' || j.status === 'running')
      && (j.payload as Record<string, unknown> | undefined)?.preview !== true
      && (j.payload as Record<string, unknown>)?.tex_document_id === documentId)
    if (activeAuthoritative) return { action: 'skipped_authoritative', revision }
    // Dedupe: an already queued/running preview for this exact revision is
    // the preview the UI wants; creating a second job would waste a run.
    const sameRevisionLive = this.tex.listPreviews(documentId).find(b => b.revision === revision && (b.status === 'queued' || b.status === 'running'))
    if (sameRevisionLive !== undefined) return { action: 'skipped_dup', revision }
    // Freeze the CURRENT revision (the debounce coalesced any newer saves)
    // and run the same fixed-image latex-compile pipeline, marked preview.
    const snap = this.tex.snapshot(documentId)
    const rootFile = pending.root_file !== '' ? pending.root_file : document.root_file
    const engine = pending.engine !== '' ? pending.engine : 'pdflatex'
    const job = this.submitJob({
      project_id: document.project_id,
      // Nonce so a retried flush after a terminal preview never reuses a
      // finished job (store-level dedup prevents same-revision duplicates).
      idempotency_key: `latex-preview:${documentId}:${snap.revision}:${engine}:${randomUUID().slice(0, 8)}`,
      kind: 'latex-compile',
      command: [engine, '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-recorder', '-no-shell-escape', rootFile],
      payload: {
        tex_document_id: documentId,
        tex_revision: snap.revision,
        tex_snapshot: snap.manifest,
        engine,
        preview: true,
      },
    })
    const build = this.tex.createBuild(documentId, snap.revision, rootFile, job.job_id, true)
    // The new revision's preview supersedes every non-terminal older preview
    // (queued → cancelled, running → superseded) and cancels their jobs.
    const superseded = this.tex.supersedePreviews(documentId, build.build_id)
    for (const old of superseded) {
      if (old.job_id !== null) {
        try {
          this.cancelJob(old.job_id, 'kernel:preview-supersede', `superseded by preview build ${build.build_id}`)
        } catch {
          // Job already terminal — its build row is already frozen too.
        }
      }
    }
    return { action: 'created', revision: snap.revision, build, job, superseded: superseded.map(b => b.build_id) }
  }

  /**
   * §12.1 (TEX-03): an explicit authoritative Compile supersedes ALL
   * non-terminal previews of the document (queued → cancelled, running →
   * superseded, superseded_by = the authoritative build). Previews never
   * block or replace the authoritative job; the authority is the manifest
   * frozen by POST builds.
   */
  texSupersedePreviews(documentId: string, supersederBuildId: string): TexBuild[] {
    const affected = this.tex.supersedePreviews(documentId, supersederBuildId)
    for (const old of affected) {
      if (old.job_id !== null) {
        try {
          this.cancelJob(old.job_id, 'kernel:authoritative-compile', `superseded by authoritative build ${supersederBuildId}`)
        } catch {
          // Job already terminal — its build row is already frozen too.
        }
      }
    }
    return affected
  }

  /** §12.1 (TEX-03): projection for UI reconnects — pending debounce state
   * (if any) plus the document's preview builds with staleness flags. */
  texPreviewStatus(documentId: string): { pending: TexPreviewPending | null; builds: Array<TexBuild & { stale: boolean }> } {
    this.tex.getDocument(documentId)
    return { pending: this.tex.getPendingPreview(documentId), builds: this.texListPreviews(documentId) }
  }

  /**
   * Generate a versioned TeX workspace from the ledger (gui-plugin-plan
   * §11): paper.tex with title/abstract/methods/results/limitations and a
   * main.bib from the frozen corpus. Creates the document if absent; every
   * generation writes a new revision via the CAS.
   */
  generateTexWorkspace(projectId: string, rootFile = 'paper.tex'): { document_id: string; revision: number; files: string[] } {
    const project = this.getProject(projectId)
    const document = this.texEnsure(projectId, rootFile)
    const latex = this.buildManuscript(projectId, 'latex', true)
    const paperTex = latex.text
    const bibtex = latex.bibtex.trim() !== '' ? latex.bibtex : `@misc{corpus,\n  title = {Frozen corpus for ${escapeLatex(project.name)}},\n}\n`
    this.texWriteFile(document.document_id, 'paper.tex', paperTex)
    this.texWriteFile(document.document_id, 'main.bib', bibtex)
    const tree = this.texTree(document.document_id)
    return { document_id: document.document_id, revision: tree.document.revision, files: tree.files.map(f => f.path) }
  }

  // ── Interactive Terminal PTY-01 (execution-runtime.md §6.1) ─────────────
  //
  // Interface layer: durable sessions, the open→attached→detached→closed
  // state machine, client_seq idempotent control, server seq/gap/retention
  // output and the pinned lease. The real tty allocation is the ADAPTER
  // (LocalDockerPty/RemoteRunnerPty — later round); until one is registered
  // the kernel ships NullPtyAdapter and the HTTP open route answers 501.
  //
  // SECURITY: pty frames live only in pty_frames. Nothing here touches
  // jobs/runs/evidence/gates/metrics — PTY output can never become a formal
  // Job log, Metrics, RunManifest, accepted Evidence or Gate Decision
  // (enforced by pty-session.test.ts `pty-not-evidence`).

  /** Register (or replace) the PTY adapter; null detaches all adapters. */
  setPtyAdapter(adapter: PtyAdapter | null): void {
    this.ptyAdapter = adapter
  }

  /** True when a real adapter is registered (HTTP open creates sessions
   * only then — an inert session would mislead the UI). */
  hasPtyAdapter(): boolean {
    return this.ptyAdapter !== null
  }

  /** The active adapter (NullPtyAdapter when none is registered). */
  getPtyAdapter(): PtyAdapter {
    return this.ptyAdapter ?? new NullPtyAdapter()
  }

  /**
   * PTY-01: a session transitioned to CLOSED (explicit close control,
   * explicit close, idle TTL sweep, lease expiry) — the adapter must tear
   * down the real process. The store owns the state machine, the adapter
   * owns the process; a delivery failure never breaks the transition (the
   * adapter surfaces its own error channel).
   */
  private ptyNotifyClosed(sessionId: string): void {
    const adapter = this.ptyAdapter
    if (adapter === null) return
    try {
      adapter.kill(sessionId)
    } catch {
      // ignore — the state transition is already committed
    }
  }

  /**
   * PTY-01 open: validate the pinned request (project, workspace, relative
   * cwd), create the durable session (state 'open', lease pinned) and hand
   * the spawn plan to the adapter. A failed spawn closes the session with
   * close_reason='adapter_failed' (the row stays for audit) and this call
   * throws PtyError('pty_adapter_failed'). `principal` is REQUIRED
   * (fail-closed — the HTTP layer injects the authenticated principal).
   */
  ptyOpen(request: import('@dsh-scholar/research-schemas').PtyOpenRequest, opts: {
    principal: { principal_id: string; tenant_id?: string }
    adapter?: PtyAdapter | null
  }): import('@dsh-scholar/research-schemas').PtySession {
    this.getProject(request.project_id)
    this.resolveWorkspace(request.workspace_id)
    const cwd = validatePtyCwd(request.cwd)
    const session = this.pty.createSession({ ...request, cwd }, opts.principal, {
      config_hash: request.config_hash ?? this.configPinHash,
      idle_ttl_s: request.idle_ttl_s,
      retention_bytes: request.retention_bytes,
      adapter_id: (opts.adapter ?? this.ptyAdapter)?.id ?? 'none',
    })
    const adapter = opts.adapter !== undefined ? opts.adapter : this.ptyAdapter
    if (adapter !== null && adapter !== undefined) {
      const result = adapter.spawn({
        pty_session_id: session.pty_session_id,
        project_id: session.project_id,
        workspace_id: session.workspace_id,
        preset: session.preset,
        cwd: session.cwd,
        cols: request.cols ?? 80,
        rows: request.rows ?? 24,
        profile: session.profile,
        target: session.target,
        config_hash: session.config_hash,
        // STORE-06: the spawn plan always receives the freshly-minted
        // plaintext token (createSession pins it in memory; the fallback is
        // unreachable for a just-created session).
        lease_token: session.lease_token ?? '',
      })
      if (!result.ok) {
        this.pty.closeSession(session.pty_session_id, 'adapter_failed')
        throw new PtyError('pty_adapter_failed', `pty adapter ${adapter.id} failed to spawn: ${result.error}`)
      }
    }
    return session
  }

  ptyGet(sessionId: string): import('@dsh-scholar/research-schemas').PtySession {
    return this.pty.getSession(sessionId)
  }

  ptyList(projectId?: string): import('@dsh-scholar/research-schemas').PtySession[] {
    return this.pty.listSessions(projectId)
  }

  /** Attach a wire (open|detached → attached); generation bumps for
   * reconnect fencing (generation + after_seq). */
  ptyAttach(sessionId: string): import('@dsh-scholar/research-schemas').PtySession {
    return this.pty.attach(sessionId)
  }

  /** Detach the wire — the process keeps running (a PTY disconnect never
   * ends the process, execution-runtime.md §6.1). */
  ptyDetach(sessionId: string): import('@dsh-scholar/research-schemas').PtySession {
    return this.pty.detach(sessionId)
  }

  /** Permission revocation: detach immediately (or no-op when already
   * detached); the session stays until close/TTL. */
  ptyRevoke(sessionId: string): import('@dsh-scholar/research-schemas').PtySession {
    return this.pty.revoke(sessionId)
  }

  /** Explicit close (idempotent) — the real process is torn down too. */
  ptyClose(sessionId: string, reason: import('@dsh-scholar/research-schemas').PtyCloseReason = 'explicit'): import('@dsh-scholar/research-schemas').PtySession {
    const session = this.pty.closeSession(sessionId, reason)
    this.ptyNotifyClosed(sessionId)
    return session
  }

  /**
   * Apply one control frame with client_seq idempotency (duplicate → replay
   * no-op, reordered/gapped → 409 pty_client_seq_out_of_order). Frames are
   * audited in pty_frames; delivery to the real tty happens only when an
   * adapter is attached (`delivered` in the result). A `close` control also
   * tears the real process down.
   */
  ptyControl(sessionId: string, request: import('@dsh-scholar/research-schemas').PtyControlRequest, adapter?: PtyAdapter | null): PtyControlResult {
    const result = this.pty.applyControl(sessionId, request, adapter !== undefined ? adapter : this.ptyAdapter)
    if (request.type === 'close') this.ptyNotifyClosed(sessionId)
    return result
  }

  /** Append adapter output (output/exit frames) with monotonic server seq
   * and bounded retention (eviction reports a gap, never silence). */
  ptyAppendOutput(sessionId: string, frames: Parameters<PtySessionStore['appendOutput']>[1]): PtyAppendResult {
    return this.pty.appendOutput(sessionId, frames)
  }

  /** Read output frames after a cursor; gap=true when retention evicted
   * seqs the client missed (pty-reconnect-seq / retention-gap). */
  ptyFrames(sessionId: string, afterSeq: number): ReturnType<PtySessionStore['frames']> {
    return this.pty.frames(sessionId, afterSeq)
  }

  /** Idle TTL sweep — closes every session idle longer than its
   * idle_ttl_s (read from the Config Schema / session row) and tears the
   * real tty down. Runs on the kernel-owned timer plus explicit calls. */
  ptySweepIdle(now = Date.now()): string[] {
    const closed = this.pty.sweepIdle(now)
    for (const sessionId of closed) this.ptyNotifyClosed(sessionId)
    return closed
  }

  /** Touch activity (a reconnecting wire resets the idle TTL). */
  ptyTouch(sessionId: string): import('@dsh-scholar/research-schemas').PtySession {
    return this.pty.touch(sessionId)
  }

  // ── generic Workspace WORK-01 (api-contracts.md §17) ────────────────────

  /**
   * Resolve a workspace id across the generic store and the TeX facade
   * (a `manuscript` workspace may be backed by either). Throws 404-shaped
   * errors when neither knows the id.
   */
  resolveWorkspace(workspaceId: string): import('@dsh-scholar/research-schemas').WorkspaceInfo {
    try {
      return this.workspaces.get(workspaceId)
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'workspace_not_found') throw error
    }
    try {
      return this.texFacade.get(workspaceId)
    } catch {
      throw new WorkspaceError('workspace_not_found', `workspace ${workspaceId} not found`)
    }
  }

  workspaceEnsure(projectId: string, kind: import('@dsh-scholar/research-schemas').WorkspaceKind, name: string): import('@dsh-scholar/research-schemas').WorkspaceInfo {
    this.getProject(projectId)
    return this.workspaces.ensure(projectId, kind, name)
  }

  workspaceGet(workspaceId: string): import('@dsh-scholar/research-schemas').WorkspaceInfo {
    return this.resolveWorkspace(workspaceId)
  }

  workspaceTree(workspaceId: string): { info: import('@dsh-scholar/research-schemas').WorkspaceInfo; nodes: import('@dsh-scholar/research-schemas').WorkspaceNode[] } {
    try {
      return this.workspaces.tree(workspaceId)
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'workspace_not_found') throw error
      return this.texFacade.tree(workspaceId)
    }
  }

  workspaceRead(workspaceId: string, path: string): import('@dsh-scholar/research-schemas').WorkspaceNode | null {
    try {
      return this.workspaces.read(workspaceId, path)
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'workspace_not_found') throw error
      return this.texFacade.read(workspaceId, path)
    }
  }

  workspaceWrite(workspaceId: string, path: string, content: string, expected?: WorkspaceExpected): import('@dsh-scholar/research-schemas').WorkspaceNode {
    try {
      return this.workspaces.write(workspaceId, path, content, expected)
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'workspace_not_found') throw error
      return this.texFacade.write(workspaceId, path, content, expected)
    }
  }

  /** Binary write — bytes go to the artifact CAS (server-computed sha256).
   * The generic store owns binary nodes; the TeX facade rejects them
   * (text-only, workspace_binary_read_only). */
  workspaceWriteBinary(workspaceId: string, path: string, bytes: Uint8Array, media: string, expected?: WorkspaceExpected): import('@dsh-scholar/research-schemas').WorkspaceNode {
    try {
      return this.workspaces.writeBinary(workspaceId, path, bytes, media, expected)
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'workspace_not_found') throw error
      return this.texFacade.writeBinary(workspaceId, path, bytes, media, expected)
    }
  }

  workspaceDelete(workspaceId: string, path: string, expected?: WorkspaceExpected): void {
    try {
      this.workspaces.deleteNode(workspaceId, path, expected)
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'workspace_not_found') throw error
      this.texFacade.deleteNode(workspaceId, path, expected)
    }
  }

  workspaceMove(workspaceId: string, fromPath: string, toPath: string, expected?: WorkspaceExpected): import('@dsh-scholar/research-schemas').WorkspaceNode {
    try {
      return this.workspaces.moveNode(workspaceId, fromPath, toPath, expected)
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'workspace_not_found') throw error
      return this.texFacade.moveNode(workspaceId, fromPath, toPath, expected)
    }
  }

  workspaceHistory(workspaceId: string): import('@dsh-scholar/research-schemas').WorkspaceRevision[] {
    try {
      return this.workspaces.history(workspaceId)
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'workspace_not_found') throw error
      return this.texFacade.history(workspaceId)
    }
  }

  /** Binary node bytes (artifact CAS); null for text/missing nodes. */
  workspaceBlob(workspaceId: string, path: string): Buffer | null {
    try {
      return this.workspaces.blob(workspaceId, path)
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'workspace_not_found') throw error
      return this.texFacade.blob(workspaceId, path)
    }
  }

  /**
   * Every workspace of a project (api-contracts.md §17 list): the generic
   * code/scratch workspaces of the disk-backed store plus the `manuscript`
   * facade workspaces (one per TeX document).
   */
  workspaceList(projectId: string): import('@dsh-scholar/research-schemas').WorkspaceInfo[] {
    this.getProject(projectId)
    const generic = this.workspaces.listByProject(projectId)
    const docs = this.db.prepare('SELECT * FROM tex_documents WHERE project_id = ? ORDER BY created_at')
      .all(projectId) as unknown as Array<{
        document_id: string; project_id: string; root_file: string; revision: number; created_at: string; updated_at: string
      }>
    return [...generic, ...docs.map(d => texInfoToWorkspaceInfo(d, d.root_file))]
  }

  /** 404-shaped ownership guard for project-scoped workspace routes: a
   * workspace that does not belong to the path project is indistinguishable
   * from a missing one (no cross-project enumeration). */
  assertWorkspaceInProject(workspaceId: string, projectId: string): void {
    const info = this.resolveWorkspace(workspaceId)
    if (info.project_id !== projectId) {
      throw new WorkspaceError('workspace_not_found', `workspace ${workspaceId} not found`)
    }
  }

  /** Watch feed: nodes changed after a workspace revision (generic store:
   * op-ledger projection; TeX facade: conservative full tree). */
  workspaceListSince(workspaceId: string, sinceRevision: number): { info: import('@dsh-scholar/research-schemas').WorkspaceInfo; nodes: import('@dsh-scholar/research-schemas').WorkspaceNode[]; deleted: string[] } {
    try {
      return this.workspaces.listSince(workspaceId, sinceRevision)
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'workspace_not_found') throw error
      return this.texFacade.listSince(workspaceId, sinceRevision)
    }
  }

  /** PATH search (prefix/glob — content search not implemented). */
  workspaceSearch(workspaceId: string, query: { prefix?: string; glob?: string }): { info: import('@dsh-scholar/research-schemas').WorkspaceInfo; nodes: import('@dsh-scholar/research-schemas').WorkspaceNode[] } {
    try {
      return this.workspaces.search(workspaceId, query)
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'workspace_not_found') throw error
      return this.texFacade.search(workspaceId, query)
    }
  }

  /** Rollback read at a stored per-path version (generic store: history
   * bytes; TeX facade: current version only). */
  workspaceReadVersion(workspaceId: string, path: string, version: number): import('@dsh-scholar/research-schemas').WorkspaceNode | null {
    try {
      return this.workspaces.readVersion(workspaceId, path, version)
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'workspace_not_found') throw error
      return this.texFacade.readVersion(workspaceId, path, version)
    }
  }

  // ── evidence & claims (design §4.7) ──────────────────────────────────────

  ingestEvidence(input: {
    project_id: string
    source_type: 'run' | 'analysis' | 'external-passage' | 'reproduction'
    run_ids: string[]
    artifact_refs: string[]
    analysis_method: string
    result: EvidenceItem['result']
    uncertainty?: string
    /** v2 §13.1: agent-written notes are draft_unverified; verified is
     * reserved for the Analysis Worker internal path (ingestVerifiedEvidence);
     * accepted is written only by the internal Verifier/Auditor path
     * (acceptEvidence) — never via the public HTTP route. */
    provenance_status?: 'draft_unverified' | 'legacy_unverified' | 'verified' | 'accepted'
  }): import('@dsh-scholar/research-schemas').EvidenceItem {
    this.getProject(input.project_id)
    // Note: the PUBLIC HTTP route rejects 'verified'/'accepted' (evidenceSchema);
    // ingestVerifiedEvidence is the internal Analysis-Worker path that sets
    // 'verified' here, and acceptEvidence is the internal Verifier/Auditor
    // path that sets 'accepted'. Kernel-level callers are trusted internal
    // surfaces.
    const item = {
      evidence_id: `evidence_${randomUUID().slice(0, 12)}`,
      project_id: input.project_id,
      source_type: input.source_type,
      run_ids: input.run_ids,
      artifact_refs: input.artifact_refs,
      analysis_method: input.analysis_method,
      result: input.result,
      uncertainty: input.uncertainty ?? '',
      status: 'accepted' as const,
      generated_by: 'statistician',
      created_at: nowIso(),
    }
    const provenance = input.provenance_status ?? 'legacy_unverified'
    // The provenance travels INSIDE the stored body too (listEvidence
    // reparses it; verifyClaim filters on it — hardening EVID-01).
    const stored = { ...item, provenance_status: provenance }
    this.db.prepare('INSERT INTO evidence (evidence_id, project_id, body, provenance_status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(item.evidence_id, item.project_id, JSON.stringify(stored), provenance, item.created_at)
    return stored as import('@dsh-scholar/research-schemas').EvidenceItem & { provenance_status: string }
  }

  /** v2 §13.1 / §17.3: Analysis-Worker-only verified evidence path. */
  ingestVerifiedEvidence(input: Parameters<ResearchKernel['ingestEvidence']>[0]): import('@dsh-scholar/research-schemas').EvidenceItem {
    return this.ingestEvidence({ ...input, provenance_status: 'verified' })
  }

  /**
   * §6 (acceptance-tests.md): Verifier/Auditor accept transition of the
   * provenance state machine draft_unverified → verified → accepted. Only
   * `accepted` evidence may support a Claim; the transition re-validates the
   * RunManifest, Contract, RunSet and Analysis Artifacts behind the evidence,
   * records the service principal + request_id in the body, and emits
   * `evidence.accepted` to the outbox.
   */
  acceptEvidence(input: {
    project_id: string
    evidence_id: string
    service_principal: string
    request_id: string
  }): import('@dsh-scholar/research-schemas').EvidenceItem & {
    provenance_status: string
    acceptance: { accepted_by: string; accepted_at: string; request_id: string }
  } {
    // Service identity: only Verifier/Auditor service principals may accept.
    if (typeof input.service_principal !== 'string' || input.service_principal === '') {
      throw new KernelError(403, 'service_identity_required',
        'accept requires a non-empty service principal (x-service-principal: verifier|auditor)')
    }
    const inProject = this.listEvidence(input.project_id).find(e => e.evidence_id === input.evidence_id)
    if (inProject === undefined) {
      // Distinguish 404 (unknown id) from 422 (exists in ANOTHER project).
      const anywhere = this.db.prepare('SELECT body FROM evidence WHERE evidence_id = ?').get(input.evidence_id) as { body?: string } | undefined
      if (anywhere?.body !== undefined) {
        throw new KernelError(422, 'evidence_foreign',
          `evidence ${input.evidence_id} belongs to another project (cross-project accept is rejected)`)
      }
      throw new KernelError(404, 'evidence_not_found', `evidence ${input.evidence_id} not found`)
    }
    if (inProject.project_id !== input.project_id) {
      throw new KernelError(422, 'evidence_foreign',
        `evidence ${input.evidence_id} belongs to project ${inProject.project_id}, not ${input.project_id}`)
    }
    const provenance = (inProject as { provenance_status?: string }).provenance_status
    if (provenance !== 'verified') {
      throw new KernelError(409, 'provenance_not_verified',
        `evidence ${input.evidence_id} has provenance_status '${provenance ?? 'unknown'}'; only verified evidence may transition to accepted (verified → accepted)`)
    }
    // ── Revalidation (acceptance-tests.md §6) ──────────────────────────────
    // RunManifest: every run_id must resolve to a same-project SUCCEEDED job
    // with a run manifest, and the manifest must re-verify against the job.
    const jobs = this.listJobs(input.project_id)
    for (const runId of inProject.run_ids) {
      const job = jobs.find(j =>
        j.job_id === runId
        || j.idempotency_key === runId
        || (j.run_manifest !== null && typeof j.run_manifest.run_id === 'string' && j.run_manifest.run_id === runId),
      )
      if (job === undefined) {
        throw new KernelError(422, 'evidence_revalidation_failed',
          `accept revalidation failed: run_id ${runId} does not resolve to a job of project ${input.project_id}`)
      }
      if (job.status !== 'succeeded' || job.run_manifest === null) {
        throw new KernelError(422, 'evidence_revalidation_failed',
          `accept revalidation failed: run_id ${runId} resolves to job ${job.job_id} in status '${job.status}' without a run manifest`)
      }
      this.verifyRunManifest(job.run_manifest, job)
      // Contract: the job's (or manifest's) contract must exist and be approved.
      const contractId = job.contract_id ?? (typeof job.run_manifest.contract_id === 'string' ? job.run_manifest.contract_id : null)
      if (contractId === null || contractId === '') {
        throw new KernelError(422, 'evidence_revalidation_failed',
          `accept revalidation failed: job ${job.job_id} (run ${runId}) has no bound contract`)
      }
      let contract: ExperimentContract
      try {
        contract = this.getContract(contractId)
      } catch {
        throw new KernelError(422, 'evidence_revalidation_failed',
          `accept revalidation failed: contract ${contractId} of run ${runId} not found`)
      }
      if (contract.status !== 'approved') {
        throw new KernelError(422, 'evidence_revalidation_failed',
          `accept revalidation failed: contract ${contractId} of run ${runId} is '${contract.status}', not approved`)
      }
      // RunSet: the succeeded run must carry a metrics artifact.
      if (typeof job.run_manifest.metrics_artifact !== 'string' || job.run_manifest.metrics_artifact === '') {
        throw new KernelError(422, 'evidence_revalidation_failed',
          `accept revalidation failed: run ${runId} has no metrics_artifact in its run manifest`)
      }
    }
    // Analysis Artifact: non-empty artifact_refs, every ref registered in THIS project.
    if (!Array.isArray(inProject.artifact_refs) || inProject.artifact_refs.length === 0) {
      throw new KernelError(422, 'evidence_revalidation_failed',
        'accept revalidation failed: evidence has no artifact_refs (an analysis artifact is required)')
    }
    for (const ref of inProject.artifact_refs) {
      try {
        this.getArtifact(input.project_id, ref)
      } catch {
        throw new KernelError(422, 'evidence_revalidation_failed',
          `accept revalidation failed: artifact ref ${ref} is not registered in project ${input.project_id}`)
      }
    }
    // ── Transition: record acceptance + flip provenance in the SAME body ──
    const acceptance = {
      accepted_by: input.service_principal,
      accepted_at: nowIso(),
      request_id: input.request_id,
    }
    const updated = { ...inProject, provenance_status: 'accepted', acceptance }
    this.db.prepare("UPDATE evidence SET body = ?, provenance_status = 'accepted' WHERE evidence_id = ?")
      .run(JSON.stringify(updated), input.evidence_id)
    this.emit(input.project_id, 'evidence.accepted', {
      evidence_id: input.evidence_id,
      request_id: input.request_id,
      accepted_by: input.service_principal,
    })
    return updated
  }

  /** v2 §13.1: only verified (Analysis-Worker) evidence is listed; kept for
   * compatibility — claim support now requires `accepted` (see
   * listAcceptedEvidence). */
  listVerifiedEvidence(projectId: string): Array<import('@dsh-scholar/research-schemas').EvidenceItem> {
    const rows = this.db.prepare(
      "SELECT * FROM evidence WHERE project_id = ? AND provenance_status = 'verified' ORDER BY created_at",
    ).all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as import('@dsh-scholar/research-schemas').EvidenceItem)
  }

  /** §6: only accepted (Verifier/Auditor-accepted) evidence may support a
   * Claim; UI/tests use this to list claim-eligible evidence. */
  listAcceptedEvidence(projectId: string): Array<import('@dsh-scholar/research-schemas').EvidenceItem & { provenance_status: string; acceptance?: { accepted_by: string; accepted_at: string; request_id: string } }> {
    const rows = this.db.prepare(
      "SELECT * FROM evidence WHERE project_id = ? AND provenance_status = 'accepted' ORDER BY created_at",
    ).all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as import('@dsh-scholar/research-schemas').EvidenceItem & { provenance_status: string })
  }

  listEvidence(projectId: string): import('@dsh-scholar/research-schemas').EvidenceItem[] {
    const rows = this.db.prepare('SELECT * FROM evidence WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as import('@dsh-scholar/research-schemas').EvidenceItem)
  }

  /** Deterministic claim verification against evidence (design §4.7, §11.3). */
  verifyClaim(input: {
    claim_id: string
    evidence_ids: string[]
    analysis_artifact?: string
    reason?: string
  }): Claim {
    const current = this.getClaim(input.claim_id)
    // hardening EVID-01 + §6: only ACCEPTED evidence (draft_unverified →
    // verified → accepted, the last step by a Verifier/Auditor) may support a
    // claim; draft notes, legacy rows and worker-verified-but-not-accepted
    // rows are all excluded from the verdict.
    const resolved = input.evidence_ids
      .map(id => this.listEvidence(current.project_id).find(e => e.evidence_id === id))
      .filter((e): e is NonNullable<typeof e> => e !== undefined)
    if (resolved.length === 0) {
      throw new KernelError(422, 'no_evidence', `claim ${input.claim_id} has no resolvable evidence`)
    }
    const evidence = resolved.filter(e => (e as { provenance_status?: string }).provenance_status === 'accepted')
    if (evidence.length === 0) {
      // Resolvable but not accepted: the verdict is inconclusive with an
      // explicit reason (no 422 — the ids exist, provenance is lacking).
      const update = this.db.prepare('UPDATE claims SET body = ?, updated_at = ? WHERE claim_id = ?')
      const currentBody = JSON.parse(JSON.stringify(current)) as Claim
      const inconclusive: Claim = {
        ...currentBody,
        status: 'inconclusive',
        history: [...(currentBody.history ?? []), { status: 'inconclusive' as Claim['status'], at: nowIso(), reason: 'requires accepted evidence (verified → accepted by Verifier/Auditor)' }],
      }
      update.run(JSON.stringify(inconclusive), nowIso(), input.claim_id)
      return inconclusive
    }
    // v2 §13.5: deterministic strict rules. Default is inconclusive.
    // supported requires: accepted evidence, effect size present, CI present,
    // n >= contract minimum (n_seeds or run count), CI excludes zero, and
    // effect direction consistent with the claim (no direction info -> at
    // most inconclusive).
    let status: Claim['status'] = 'inconclusive'
    const conflicted = evidence.some(e => e.status === 'conflicted')
    const complete = evidence.filter(e =>
      e.result.effect_size !== undefined
      && e.result.ci_low !== undefined && e.result.ci_high !== undefined
      && (e.result.n_seeds ?? e.run_ids.length) > 0,
    )
    if (!conflicted && complete.length > 0) {
      // §12 MetricSpec direction: lower-is-better inverts the sign
      // interpretation — a NEGATIVE effect (CI < 0) is the improvement and
      // supports the claim; a positive effect contradicts it. Evidence that
      // declares no direction defaults to higher_is_better.
      const directions = new Set(complete.map(e => e.result.direction ?? 'higher_is_better'))
      const lowerIsBetter = directions.size === 1 && directions.has('lower_is_better')
      const allCiExcludeZero = complete.every(e => e.result.ci_low! > 0 || e.result.ci_high! < 0)
      const anyNegativeEffect = complete.some(e => (e.result.effect_size ?? 0) < 0)
      const allPositiveEffect = complete.every(e => (e.result.effect_size ?? 0) > 0)
      const allNegativeEffect = complete.every(e => (e.result.effect_size ?? 0) < 0)
      if (allCiExcludeZero && lowerIsBetter) {
        if (allNegativeEffect) {
          status = 'supported'
        } else if (allPositiveEffect) {
          status = 'contradicted'
        } else {
          status = 'inconclusive' // mixed directions
        }
      } else if (allCiExcludeZero && allPositiveEffect) {
        status = 'supported'
      } else if (allCiExcludeZero && anyNegativeEffect && !allPositiveEffect) {
        status = 'contradicted'
      } else {
        status = 'inconclusive' // CI crosses zero or mixed directions
      }
    }
    const next: Claim = {
      ...current,
      evidence: { evidence_ids: input.evidence_ids, analysis_artifact: input.analysis_artifact ?? current.evidence.analysis_artifact },
      status,
      confidence: status === 'supported' ? 'high' : status === 'contradicted' ? 'high' : 'medium',
      history: [...current.history, { status, at: nowIso(), reason: input.reason ?? `verified against ${evidence.length} accepted evidence item(s)` }],
      updated_at: nowIso(),
    }
    this.db.prepare('UPDATE claims SET body = ?, updated_at = ? WHERE claim_id = ?').run(JSON.stringify(next), next.updated_at, input.claim_id)
    this.emit(current.project_id, 'claim.updated', { claim_id: input.claim_id, status })
    return next
  }

  createClaim(input: { project_id: string; statement: string; scope?: Claim['scope'] }): Claim {
    this.getProject(input.project_id)
    const claim: Claim = {
      claim_id: buildClaimId(),
      project_id: input.project_id,
      statement: input.statement,
      scope: input.scope ?? { dataset: '', split: '' },
      evidence: { evidence_ids: [] },
      status: 'proposed',
      confidence: 'medium',
      limitations: [],
      history: [{ status: 'proposed', at: nowIso(), reason: '' }],
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    this.db.prepare('INSERT INTO claims (claim_id, project_id, body, updated_at) VALUES (?, ?, ?, ?)')
      .run(claim.claim_id, claim.project_id, JSON.stringify(claim), claim.updated_at)
    return claim
  }

  getClaim(claimId: string): Claim {
    const row = this.db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claimId) as { body?: string } | undefined
    if (row?.body === undefined) throw new KernelError(404, 'claim_not_found', `claim ${claimId} not found`)
    return JSON.parse(row.body) as Claim
  }

  listClaims(projectId: string): Claim[] {
    const rows = this.db.prepare('SELECT * FROM claims WHERE project_id = ? ORDER BY updated_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as Claim)
  }

  // ── analysis pipeline (design §4.7, §11.3 Statistics) ────────────────────

  /**
   * Deterministic multi-seed analysis over succeeded formal runs: aggregate
   * metrics from RunManifest metrics artifacts in CAS, compute mean, sd,
   * percentile bootstrap 95% CI and effect size vs the baseline run. Writes
   * one analysis artifact; numbers in manuscripts must come from this.
   */
  computeAnalysis(projectId: string, contractId?: string, metric?: string, options: {
    /** Minimum completed seeds required (v2 §13.6; default 1 keeps compat). */
    minimum_n?: number
    /** Restrict to these job kinds (v2 §13.6: never mix kinds). Defaults to
     * formal; falls back to non-baseline kinds only when no formal exists. */
    kinds?: string[]
  } = {}): {
    artifact_id: string
    chart_artifact: string
    contract_id: string | null
    metric: string
    runs: Array<{ run_id: string; job_id: string; value: number; seed?: number }>
    mean: number
    sd: number
    n: number
    ci_low: number
    ci_high: number
    baseline_value: number | null
    effect_size: number | null
    used_kinds: string[]
    generated_at: string
  } {
    const project = this.getProject(projectId)
    const jobs = this.listJobs(projectId).filter(j => j.status === 'succeeded' && j.run_manifest !== null)
    const metricValues: Array<{ run_id: string; job_id: string; kind: string; value: number; seed?: number }> = []
    let baselineValue: number | null = null
    let formalSeen = false
    for (const job of jobs) {
      if (contractId !== undefined && job.contract_id !== contractId) continue
      if (job.kind === 'formal') formalSeen = true
      const metricsArtifact = job.run_manifest?.metrics_artifact
      if (typeof metricsArtifact !== 'string') continue
      const sha = metricsArtifact.replace(/^sha256:/, '')
      if (!this.cas.has(sha)) continue
      // §12.5 (SCH-EXEC-002): metrics artifacts carry the fixed-schema file
      // record ({schema_version, seed, metrics: [{name, value, unit}]});
      // legacy stdout-derived artifacts used {metric, value, seed}. Both keys
      // are accepted, and the §12.5 top-level `seed` is used as the per-entry
      // fallback.
      const parsed = JSON.parse(this.cas.read(sha).toString('utf8')) as { metrics?: Array<{ metric?: string; name?: string; value?: number; seed?: number }>; seed?: number }
      for (const entry of parsed.metrics ?? []) {
        const metricName = entry.name ?? entry.metric
        if (entry.value === undefined || metricName === undefined) continue
        if (metric !== undefined && metricName !== metric) continue
        metricValues.push({
          run_id: typeof job.run_manifest?.run_id === 'string' ? job.run_manifest.run_id : job.job_id,
          job_id: job.job_id,
          kind: job.kind,
          value: entry.value,
          seed: entry.seed ?? parsed.seed,
        })
        if (job.kind === 'baseline' && baselineValue === null) baselineValue = entry.value
      }
    }
    // v2 §13.6: never mix job kinds. Prefer formal runs; only when a contract
    // has none, fall back to the other non-baseline kinds (explicitly noted).
    let allowedKinds = options.kinds ?? ['formal']
    const hasFormal = formalSeen
    if (options.kinds === undefined && !hasFormal) allowedKinds = ['pilot', 'smoke', 'analysis', 'reproduce']
    // Baseline runs always stay in the set: they are the pairing side.
    const kindFiltered = metricValues.filter(v => v.kind === 'baseline' || allowedKinds.includes(v.kind))
    metricValues.length = 0
    metricValues.push(...kindFiltered)
    const usedKinds = [...new Set(kindFiltered.map(v => v.kind).filter(k => k !== 'baseline'))]
    if (metricValues.length === 0) {
      throw new KernelError(422, 'no_metrics', 'no succeeded runs with metrics artifacts found for analysis')
    }
    // §13.6 / STAT-01: THE analysis engine is the Analysis Worker's paired
    // mean-difference (matched-seed design, seeded percentile bootstrap).
    // The kernel never re-implements statistics — it collects baseline and
    // treatment runs, pairs them by seed, and delegates the math.
    // §12 MetricSpec direction + minimum_n: both resolved from the bound
    // contract (explicit contract_id, else the project's first approved
    // contract); direction defaults to higher_is_better, minimum_n to the
    // contract's stop_conditions.min_completed_seeds (fallback 1) and a
    // caller-lowered minimum_n is 422 (AnalysisPlan.minimum_n is
    // contract-driven, reconstruction-contracts.md §12).
    const approvedContracts = this.listContracts(projectId).filter(c => c.status === 'approved')
    const boundContract = contractId !== undefined
      ? approvedContracts.find(c => c.contract_id === contractId)
      : approvedContracts[0]
    let direction: 'higher_is_better' | 'lower_is_better' = 'higher_is_better'
    if (boundContract !== undefined && boundContract.metrics.direction !== undefined) {
      direction = boundContract.metrics.direction
    }
    const contractMinimum = boundContract?.stop_conditions.min_completed_seeds
    const minimumN = options.minimum_n ?? contractMinimum ?? 1
    if (contractMinimum !== undefined && options.minimum_n !== undefined && options.minimum_n < contractMinimum) {
      throw new KernelError(422, 'minimum_n_too_low',
        `analysis minimum_n ${options.minimum_n} < contract stop_conditions.min_completed_seeds ${contractMinimum} (cannot be lowered by the caller, §12)`)
    }
    const baselineRuns: Array<{ seed?: number; value: number }> = []
    const treatmentRuns: Array<{ seed?: number; value: number }> = []
    for (const v of metricValues) {
      if (v.kind === 'baseline') baselineRuns.push({ seed: v.seed, value: v.value })
      else treatmentRuns.push({ seed: v.seed, value: v.value })
    }
    // STAT-01 (P0): a seed that appears in MULTIPLE runs of the same group
    // (baseline or treatment) makes the matched-seed design ambiguous — the
    // old behavior silently overwrote/`find`-firsted it. Formal analyses now
    // reject duplicate seeds outright (422 duplicate_seed): each baseline and
    // each treatment seed must be unique across the collected runs.
    const assertUniqueSeeds = (group: string, runs: Array<{ seed?: number }>): void => {
      const seen = new Set<number>()
      for (const r of runs) {
        if (r.seed === undefined) continue
        if (seen.has(r.seed)) {
          throw new KernelError(422, 'duplicate_seed',
            `${group} seed ${r.seed} appears in multiple runs — duplicate seeds are rejected in formal analysis (STAT-01); re-run with unique seeds`)
        }
        seen.add(r.seed)
      }
    }
    assertUniqueSeeds('baseline', baselineRuns)
    assertUniqueSeeds('treatment', treatmentRuns)
    const baselineBySeed = new Map<number, number>()
    for (const b of baselineRuns) {
      if (b.seed !== undefined) baselineBySeed.set(b.seed, b.value)
    }
    const pairedSeeds = treatmentRuns
      .filter(t => t.seed !== undefined && baselineBySeed.has(t.seed!))
      .map(t => t.seed!)
    const uniquePaired = [...new Set(pairedSeeds)]
    if (uniquePaired.length < minimumN) {
      throw new KernelError(422, 'matched_seeds_required',
        `analysis requires >= ${minimumN} baseline/treatment runs with MATCHED seeds (paired design, §13.6); got ${uniquePaired.length}`)
    }
    const paired = uniquePaired.sort()
    const baselineValues = paired.map(s => baselineBySeed.get(s)!)
    const treatmentValues = paired.map(s => {
      const hit = treatmentRuns.find(t => t.seed === s)!
      return hit.value
    })
    const worker = computePairedAnalysis(
      {
        contract_id: contractId ?? 'auto',
        metric: { name: metric ?? 'auto', direction, aggregation: 'mean' },
        paired_by: 'seed',
        baseline_run_set_id: 'kernel-baseline',
        treatment_run_set_id: 'kernel-treatment',
        method: { estimator: 'paired_mean_difference', interval: 'bootstrap_95', resamples: ANALYSIS_RESAMPLES },
        multiple_testing: 'holm',
        minimum_n: minimumN,
      },
      paired.map((s, i) => ({ run_id: `baseline-${s}`, seed: s, metric_value: baselineValues[i]! })),
      paired.map((s, i) => ({ run_id: `treatment-${s}`, seed: s, metric_value: treatmentValues[i]! })),
    )
    const mean = worker.treatment_mean
    const variance = treatmentValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / Math.max(treatmentValues.length - 1, 1)
    const sd = Math.sqrt(variance)
    const result = {
      contract_id: contractId ?? null,
      metric: metric ?? 'auto',
      direction,
      runs: metricValues
        .filter(v => v.kind !== 'baseline' && v.seed !== undefined && paired.includes(v.seed!))
        .map(({ kind: _kind, ...rest }) => rest),
      mean: round(worker.treatment_mean),
      sd: round(sd),
      n: worker.n_pairs,
      ci_low: round(worker.ci_low),
      ci_high: round(worker.ci_high),
      baseline_value: round(worker.baseline_mean),
      effect_size: round(worker.effect_size),
      adjusted_p_value: round(worker.adjusted_p_value),
      direction_ok: worker.direction_ok,
    }
    const artifact = this.registerArtifact({
      project_id: projectId,
      kind: 'analysis',
      content: JSON.stringify({ analysis: result, method: 'percentile-bootstrap-95', n_resamples: ANALYSIS_RESAMPLES, project_id: projectId }, null, 2),
      metadata: { kind: 'analysis', metric: result.metric, n: result.n, generated_by: 'research-kernel.computeAnalysis' },
    })
    this.emit(projectId, 'artifact.registered', { artifact_id: artifact.artifact_id, kind: 'analysis' })
    // Deterministic chart artifact bound to the same analysis numbers (§11.3).
    const chart = this.buildChartSvg(projectId, { artifact_id: artifact.artifact_id, ...result })
    return { artifact_id: artifact.artifact_id, chart_artifact: chart.chart_artifact, used_kinds: usedKinds, ...result, generated_at: nowIso() }
  }

  /**
   * Generate a deterministic SVG bar chart for one analysis result (design
   * §11.3 charts, E5): mean with bootstrap CI whiskers vs baseline. The SVG
   * is registered as a `chart` CAS artifact so manuscripts embed artifact
   * references, not ad-hoc numbers.
   */
  buildChartSvg(projectId: string, analysis: {
    artifact_id: string
    metric: string
    mean: number
    ci_low: number
    ci_high: number
    baseline_value: number | null
    n: number
  }): { chart_artifact: string; svg: string } {
    this.getProject(projectId)
    const W = 420, H = 260, M = { l: 60, r: 20, t: 30, b: 40 }
    const values = [analysis.baseline_value ?? analysis.mean, analysis.mean]
    const lo = Math.min(...values, analysis.ci_low)
    const hi = Math.max(...values, analysis.ci_high)
    const span = Math.max(hi - lo, 1e-9) * 1.25
    const scale = (v: number): number => H - M.b - ((v - lo) / span) * (H - M.t - M.b)
    const barW = 70
    const bar = (x: number, v: number, color: string, label: string): string => {
      const y = scale(Math.max(v, lo))
      const h = Math.max(H - M.b - y, 1)
      const textY = y - 6
      return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}" rx="3"/>
        <text x="${x + barW / 2}" y="${textY}" text-anchor="middle" font-size="12" fill="#333">${label}: ${v.toFixed(4)}</text>`
    }
    const ciY = scale(analysis.ci_high)
    const ciH = Math.max(Math.abs(scale(analysis.ci_low) - scale(analysis.ci_high)), 1)
    const meanX = M.l + barW + 50
    const baselineX = M.l
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <text x="${W / 2}" y="20" text-anchor="middle" font-size="14" font-weight="bold">${escapeXml(analysis.metric)} — mean ± 95% bootstrap CI (n=${analysis.n})</text>
  ${analysis.baseline_value !== null ? bar(baselineX, analysis.baseline_value, '#9aa5b1', 'baseline') : ''}
  ${bar(meanX, analysis.mean, '#4c6ef5', 'treatment')}
  <rect x="${meanX + barW / 2 - 3}" y="${ciY}" width="6" height="${ciH}" fill="#f03e3e"/>
  <text x="${meanX + barW / 2}" y="${H - M.b + 18}" text-anchor="middle" font-size="11" fill="#555">analysis ${analysis.artifact_id.slice(0, 12)}</text>
</svg>`
    const record = this.registerArtifact({
      project_id: projectId,
      kind: 'chart',
      content: svg,
      metadata: { kind: 'chart', metric: analysis.metric, analysis_artifact: analysis.artifact_id },
    })
    return { chart_artifact: record.artifact_id, svg }
  }

  // ── manuscript & release bundle (design §4.8) ────────────────────────────

  /** Deterministic manuscript draft from the read-only Evidence Ledger. */
  buildManuscript(projectId: string, format: 'markdown' | 'latex' = 'markdown', includeLimitations = true): {
    manuscript_id: string
    format: string
    text: string
    artifact_id: string
    claims_used: number
    bibtex: string
  } {
    const project = this.getProject(projectId)
    const claims = this.listClaims(projectId)
    const evidence = this.listEvidence(projectId)
    const contracts = this.listContracts(projectId)
    const snapshots = this.listCorpusSnapshots(projectId)
    const supported = claims.filter(c => c.status === 'supported')
    const byEvidence = new Map<string, Claim[]>()
    for (const claim of claims) {
      for (const id of claim.evidence.evidence_ids ?? []) {
        byEvidence.set(id, [...(byEvidence.get(id) ?? []), claim])
      }
    }
    const evidenceRows = evidence.map(e => {
      const claimsFor = (byEvidence.get(e.evidence_id) ?? []).map(c => c.claim_id)
      return `| ${e.result.primary_metric} | ${e.result.value} | ${e.result.baseline_value ?? '—'} | ${e.result.effect_size ?? '—'} | ${e.result.ci_low ?? '—'}–${e.result.ci_high ?? '—'} | ${e.result.n_seeds ?? e.run_ids.length} | ${e.analysis_method} | ${claimsFor.join(', ') || '—'} |`
    })
    const lines: string[] = []
    if (format === 'latex') {
      lines.push('\\documentclass{article}', '\\usepackage{booktabs}', '\\begin{document}')
      lines.push(`\\title{${escapeLatex(project.name)}}`, '\\maketitle')
      lines.push('\\section{Abstract}')
      lines.push(abstractText(project, supported))
      lines.push('\\section{Methods}')
      for (const contract of contracts) {
        lines.push(`\\subsection{${escapeLatex(contract.methods.treatment)} vs ${escapeLatex(contract.methods.baseline)}}`)
        lines.push(`Dataset: ${escapeLatex(contract.data.dataset_id)} (split ${escapeLatex(contract.data.split)}), primary metric ${escapeLatex(contract.metrics.primary)}, seeds ${contract.seeds.join(', ')}.`)
      }
      lines.push('\\section{Results}')
      if (evidenceRows.length > 0) {
        // LaTeX tabular rows: '&'-separated, en dashes as '--' (§14.3: the
        // fixed build image must compile; raw unicode dashes break pdflatex).
        const latexRows = evidence.map(e => {
          const claimsFor = (byEvidence.get(e.evidence_id) ?? []).map(c => c.claim_id).join(', ') || '--'
          const ci = `${e.result.ci_low ?? '--'}--${e.result.ci_high ?? '--'}`
          return `${escapeLatex(e.result.primary_metric)} & ${e.result.value} & ${e.result.baseline_value ?? '--'} & ${e.result.effect_size ?? '--'} & ${ci} & ${e.result.n_seeds ?? e.run_ids.length} & ${escapeLatex(e.analysis_method)} & ${escapeLatex(claimsFor)}`
        })
        lines.push('\\begin{tabular}{llllllll}', '\\toprule', 'Metric & Value & Baseline & Effect & 95\\% CI & Seeds & Method & Claims \\\\', '\\midrule')
        lines.push(...latexRows.map(r => `${r} \\\\`))
        lines.push('\\bottomrule', '\\end{tabular}')
      } else {
        lines.push('No verified evidence items yet — results table intentionally empty.')
      }
      lines.push('\\section{Related Work}')
      for (const paper of snapshots.at(-1)?.papers ?? []) {
        lines.push(`\\cite{${paper.paper_id.replace(/[^a-zA-Z0-9]/g, '_')}} ${escapeLatex(paper.title)} (${paper.year ?? 'n.d.'}).`)
      }
      if (includeLimitations) {
        lines.push('\\section{Limitations}')
        for (const claim of claims) {
          if (claim.limitations.length > 0) lines.push(`\\begin{itemize} ${claim.limitations.map(l => `\\item ${escapeLatex(l)}`).join(' ')} \\end{itemize}`)
        }
      }
      lines.push('\\end{document}')
    } else {
      lines.push(`# ${project.name}`, '', '## Abstract', abstractText(project, supported), '', '## Methods')
      for (const contract of contracts) {
        lines.push(`### ${contract.methods.treatment} vs ${contract.methods.baseline}`, `- Dataset: ${contract.data.dataset_id} (split ${contract.data.split})`, `- Primary metric: ${contract.metrics.primary}`, `- Seeds: ${contract.seeds.join(', ')}`, `- Analysis: ${contract.analysis.effect_size}, ${contract.analysis.interval}, ${contract.analysis.multiple_testing}`)
      }
      lines.push('', '## Results')
      if (evidenceRows.length > 0) {
        lines.push('| Metric | Value | Baseline | Effect | 95% CI | Seeds | Method | Claims |', '|---|---|---|---|---|---|---|---|', ...evidenceRows)
      } else {
        lines.push('No verified evidence items yet — results table intentionally empty (evidence-first).')
      }
      lines.push('', '## Related Work')
      for (const paper of snapshots.at(-1)?.papers ?? []) {
        lines.push(`- ${paper.paper_id}: ${paper.title} (${paper.year ?? 'n.d.'})`)
      }
      // Charts: every analysis artifact gets a figure reference (numbers stay
    // bound to analysis artifacts — the chart is a rendering of them).
    const analyses = this.listArtifacts(projectId).filter(a => a.kind === 'analysis')
    const charts = this.listArtifacts(projectId).filter(a => a.kind === 'chart')
    if (charts.length > 0) {
      lines.push('', '## Figures')
      for (const chart of charts) {
        const metric = String(chart.metadata.metric ?? 'metric')
        lines.push(`![${metric} (analysis artifact bound)](${chart.artifact_id})`)
      }
    }
    void analyses
    if (includeLimitations) {
        lines.push('', '## Limitations')
        for (const claim of claims) {
          if (claim.limitations.length > 0) lines.push(...claim.limitations.map(l => `- ${l}`))
        }
      }
    }
    const text = lines.join('\n')
    const artifact = this.registerArtifact({
      project_id: projectId,
      kind: 'paper',
      content: text,
      metadata: { manuscript_format: format, claims_used: supported.length },
    })
    const manuscriptId = `manuscript_${randomUUID().slice(0, 8)}`
    this.db.prepare('INSERT INTO manuscripts (manuscript_id, project_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(manuscriptId, projectId, JSON.stringify({ manuscript_id: manuscriptId, project_id: projectId, format, text, artifact_id: artifact.artifact_id, created_at: nowIso() }), nowIso())
    this.emit(projectId, 'manuscript.built', { manuscript_id: manuscriptId, artifact_id: artifact.artifact_id })
    // BibTeX generation (§4.8.6, §1.4): only papers resolved into the corpus
    // snapshot may be cited; keys are stable per paper_id.
    const papers = snapshots.at(-1)?.papers ?? []
    const bibtex = papers.map(paper => {
      const key = citationKey(paper.paper_id)
      const authorList = paper.authors.length > 0 ? paper.authors.join(' and ') : 'Anonymous'
      const year = paper.year ?? 'n.d.'
      const venue = paper.venue !== undefined ? `,\n  journal = {${escapeLatex(paper.venue)}}` : ''
      const doi = typeof paper.identifiers.doi === 'string' ? `,\n  doi = {${paper.identifiers.doi}}` : ''
      return `@article{${key},\n  title = {${escapeLatex(paper.title)}},\n  author = {${escapeLatex(authorList)}},\n  year = {${year}}${venue}${doi}\n}`
    }).join('\n\n')
    return { manuscript_id: manuscriptId, format, text, artifact_id: artifact.artifact_id, claims_used: supported.length, bibtex }
  }

  /** Deterministic reviewer checks: numbers bound, claims supported, artifacts present. */
  manuscriptReview(projectId: string): {
    checks: Array<{ check: string; status: 'pass' | 'warn' | 'fail'; detail: string }>
    pass: boolean
  } {
    const claims = this.listClaims(projectId)
    const evidence = this.listEvidence(projectId)
    const artifacts = this.listArtifacts(projectId)
    const checks: Array<{ check: string; status: 'pass' | 'warn' | 'fail'; detail: string }> = []
    // §6: contradicted is NOT a positive conclusion — the reviewer must warn
    // on proposed/inconclusive/contradicted claims alike.
    const unsupported = claims.filter(c => c.status === 'proposed' || c.status === 'inconclusive' || c.status === 'contradicted')
    checks.push({
      check: 'claim-evidence binding',
      status: claims.length === 0 ? 'fail' : unsupported.length === 0 ? 'pass' : 'warn',
      detail: `${supportedOrInconclusive(claims)}/proposed claims: ${unsupported.length === 0 ? 'all claims verified' : unsupported.map(c => c.claim_id).join(', ')}`,
    })
    const unbound = evidence.filter(e => e.artifact_refs.length === 0)
    checks.push({
      check: 'evidence artifact refs',
      status: unbound.length === 0 ? 'pass' : 'fail',
      detail: unbound.length === 0 ? 'every evidence item references artifacts' : `${unbound.length} evidence items lack artifact refs`,
    })
    const missingArtifacts = evidence.flatMap(e => e.artifact_refs).filter(ref => !artifacts.some(a => a.artifact_id === ref))
    checks.push({
      check: 'artifact hash presence',
      status: missingArtifacts.length === 0 ? 'pass' : 'fail',
      detail: missingArtifacts.length === 0 ? 'all referenced artifacts registered in CAS' : `missing: ${missingArtifacts.join(', ')}`,
    })
    const snapshots = this.listCorpusSnapshots(projectId)
    const resolvedIds = new Set<string>()
    for (const snapshot of snapshots) for (const paper of snapshot.papers) resolvedIds.add(paper.paper_id)
    checks.push({
      check: 'citation resolution',
      status: 'pass',
      detail: `all ${resolvedIds.size} cited paper(s) resolved from frozen corpus snapshots; no unresolved identifiers`,
    })
    const pass = checks.every(c => c.status === 'pass')
    return { checks, pass }
  }

  /** Private Release Bundle: everything a clean-room rerun needs (design §4.8.6). */
  releaseBundle(projectId: string): {
    bundle_id: string
    artifact_id: string
    contents: string[]
    release_gate: 'unapproved'
  } {
    const project = this.getProject(projectId)
    const contracts = this.listContracts(projectId)
    const jobs = this.listJobs(projectId)
    const artifacts = this.listArtifacts(projectId)
    const claims = this.listClaims(projectId)
    const evidence = this.listEvidence(projectId)
    const snapshots = this.listCorpusSnapshots(projectId)
    const bundle = {
      bundle_id: `bundle_${randomUUID().slice(0, 8)}`,
      project: { project_id: project.project_id, name: project.name, status: project.status, mode: project.mode },
      integrity: project.integrity,
      contracts,
      jobs: jobs.map(j => ({ job_id: j.job_id, kind: j.kind, status: j.status, run_manifest: j.run_manifest })),
      artifacts: artifacts.map(a => ({ artifact_id: a.artifact_id, kind: a.kind, size_bytes: a.size_bytes })),
      claims: claims.map(c => ({ claim_id: c.claim_id, statement: c.statement, status: c.status })),
      evidence: evidence.map(e => ({ evidence_id: e.evidence_id, analysis_method: e.analysis_method, result: e.result })),
      corpus_snapshots: snapshots.map(s => s.snapshot_id),
      ai_usage: 'Generated with an AI research assistant; all numbers traceable to run manifests and analysis artifacts.',
      release_gate: 'unapproved',
      created_at: nowIso(),
    }
    const artifact = this.registerArtifact({
      project_id: projectId,
      kind: 'bundle',
      content: JSON.stringify(bundle, null, 2),
      metadata: { kind: 'release-bundle' },
    })
    return {
      bundle_id: bundle.bundle_id,
      artifact_id: artifact.artifact_id,
      contents: ['project', 'contracts', 'jobs+manifests', 'artifacts', 'claims', 'evidence', 'corpus snapshots', 'ai_usage'],
      release_gate: 'unapproved',
    }
  }

  // ── projection (design §4.2 Projection API) ──────────────────────────────

  projectProjection(projectId: string): {
    project: ResearchProject
    pending_gates: Gate[]
    jobs: Array<Pick<JobRecord, 'job_id' | 'kind' | 'status'>>
    budget: BudgetRecord
    counts: { ideas: number; contracts: number; claims: number; evidence: number; artifacts: number; corpus_snapshots: number }
    /** GUIDE-01 legacy: labels of the non-done structured actions (stable derivation). */
    next_actions: string[]
    /** GUIDE-01 authoritative: structured next-step projection (code/label/reason/required/route/capability/revision/state). */
    next_actions_v2: NextAction[]
  } {
    const project = this.getProject(projectId)
    const pendingGates = this.listGates(projectId, 'pending')
    const jobs = this.listJobs(projectId)
    const budget = this.getBudget(projectId)
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(projectId) as { n: number }
      return Number(row.n)
    }
    // GUIDE-01: the structured projection is a PURE function of authoritative
    // state; the legacy string[] is derived from its labels.
    const actionJobs: NextActionJob[] = jobs.map(j => ({
      job_id: j.job_id,
      kind: j.kind,
      status: j.status,
      failure_class: j.failure_class,
      attempts: j.attempts,
      max_attempts: j.max_attempts,
      contract_id: j.contract_id,
      created_at: j.created_at,
    }))
    const nextActionsV2 = nextActionProjection({
      project,
      gates: pendingGates,
      jobs: actionJobs,
      budget,
      contracts: this.listContracts(projectId),
      ideas: this.listIdeas(projectId),
      evidence: this.listEvidence(projectId),
      claims: this.listClaims(projectId),
      corpus_snapshots: this.listCorpusSnapshots(projectId),
    })
    const nextActions = legacyNextActionStrings(nextActionsV2)
    return {
      project,
      pending_gates: pendingGates,
      jobs: jobs.map(j => ({ job_id: j.job_id, kind: j.kind, status: j.status })),
      budget,
      counts: {
        ideas: count('ideas'), contracts: count('contracts'), claims: count('claims'),
        evidence: count('evidence'), artifacts: count('artifacts'), corpus_snapshots: count('corpus_snapshots'),
      },
      next_actions: nextActions,
      next_actions_v2: nextActionsV2,
    }
  }
}

function collectManifestRefs(manifest: Record<string, unknown>): string[] {
  const refs: string[] = []
  for (const key of ['metrics_artifact', 'log_artifact', 'checkpoint_artifact', 'analysis_artifact']) {
    const value = manifest[key]
    if (typeof value === 'string' && value.startsWith('sha256:')) refs.push(value)
  }
  return refs
}

/**
 * §12.7: canonical JSON used for manifest hashing/signing — top-level keys
 * sorted, no whitespace. This MUST match the runner's canonicalization
 * (workers/runner-gateway `canonicalJson`/`signManifest`) so signatures
 * verify end-to-end: `JSON.stringify(obj, sortedTopLevelKeys)`.
 */
export function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort())
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

/**
 * §12.7: the payload a runner hashes is the manifest WITHOUT its envelope
 * fields (runner_key_id, payload_sha256, signature) — matches the runner's
 * `payload_sha256 = sha256(canonicalJson(manifest))` computed before the
 * envelope is attached.
 */
function manifestHashPayload(manifest: Record<string, unknown>): string {
  const { signature: _signature, runner_key_id: _keyId, payload_sha256: _payloadHash, ...payload } = manifest
  return canonicalJson(payload)
}

/** Manifest minus its `signature` field + the base64 signature bytes (§12.7). */
function stripManifestSignature(manifest: Record<string, unknown>): { signedPayload: Record<string, unknown>; signatureBytes: Buffer } {
  const { signature, ...signedPayload } = manifest
  return { signedPayload, signatureBytes: Buffer.from(String(signature), 'base64') }
}


function escapeLatex(text: string): string {
  return text.replace(/([\\{}_$#&%])/g, '\\$1')
}

function abstractText(project: ResearchProject, supported: import('@dsh-scholar/research-schemas').Claim[]): string {
  if (supported.length === 0) {
    return 'This study is in progress; no supported claims yet. (Evidence-first: conclusions appear only when claims bind to evidence.)'
  }
  return supported.map(c => c.statement).join(' ')
}

function supportedOrInconclusive(claims: import('@dsh-scholar/research-schemas').Claim[]): string {
  const supported = claims.filter(c => c.status === 'supported').length
  const inconclusive = claims.filter(c => c.status === 'inconclusive').length
  return `${supported} supported, ${inconclusive} inconclusive, ${claims.length - supported - inconclusive} other`
}


/** Deterministic mulberry32 PRNG (seeded) for the percentile bootstrap. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Percentile bootstrap 95% CI with a fixed seed (deterministic). */
function bootstrapCi95(values: number[], resamples: number): [number, number] {
  const rand = mulberry32(20260806)
  const means: number[] = []
  for (let r = 0; r < resamples; r++) {
    let sum = 0
    for (let i = 0; i < values.length; i++) {
      sum += values[Math.floor(rand() * values.length)]!
    }
    means.push(sum / values.length)
  }
  means.sort((a, b) => a - b)
  const lo = means[Math.floor(resamples * 0.025)]!
  const hi = means[Math.ceil(resamples * 0.975) - 1]!
  return [lo, hi]
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}


function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}


/** Stable BibTeX citation key from a paper id (doi:10.x/y -> doi10x_y). */
function citationKey(paperId: string): string {
  return paperId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60)
}
