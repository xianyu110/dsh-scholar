/**
 * ONBOARD-01 — Research Intake domain logic (research-onboarding.md,
 * authoritative contract). Pure/static building blocks for the kernel:
 *
 *  - INTAKE_DDL: isolated Intake tables (sessions/artifacts/observations/
 *    questions) — pre-accept the kernel writes ONLY these + the isolated
 *    staging CAS, never Project/Gate/Artifact/Workspace/Job/Run/Terminal/
 *    Evidence/Claim (research-onboarding.md §2.1);
 *  - Grill taxonomy: versioned, deterministic questions per target phase
 *    (§5 — LLM may only translate/rephrase, never invent or judge);
 *  - static scan: extension allow/deny/quarantine, magic sniffing, static
 *    secret patterns (§4.2 — no AV in this environment, recorded honestly;
 *    deep archive extraction is deferred to the adoption-time code-snapshot
 *    walk, which enforces the path/symlink/bomb limits);
 *  - safe phase landing: research-onboarding.md §6 table — observed_phase is
 *    metadata; the kernel derives safe_project_status from the REAL state
 *    machine (a fresh DRAFT project stays DRAFT; gates are created PENDING
 *    and never decided by the intake), and required_gates/plan/risks come
 *    from the deterministic landing map;
 *  - buildPhaseProposal: deterministic PhaseProposal from answers + scans.
 *
 * This module never touches the database — the kernel (kernel.ts) owns all
 * writes. No Gate/Run/Evidence write path exists anywhere in this module or
 * the kernel intake methods (asserted by tests/unit/intake.test.ts).
 * @module @dsh-scholar/research-kernel/intake
 */

import type { ArtifactKind, GrillQuestion, GrillAnswerView, ImportMapping, IntakeArtifact, IntakeObservation, ObservedPhase, PhaseProposal } from '@dsh-scholar/research-schemas'

/** Taxonomy version — bump when question sets change (stable codes stay). */
export const GRILL_TAXONOMY_VERSION = 1

/** Current question revision — answers must carry this (409 on mismatch). */
export const GRILL_QUESTION_REVISION = 1

/** Default intake session TTL before expireIntakes collects it (§7: 7 days). */
export const INTAKE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Default staged-intake-blob TTL for cleanupIntakeStaged (§7: 24 hours). */
export const INTAKE_STAGED_TTL_MS = 24 * 60 * 60 * 1000

/** Per-file cap reuses the UPLOAD-01 limit (research-onboarding.md §4.1). */
export const INTAKE_MAX_FILE_BYTES = 32 * 1024 * 1024

/** Static scan cap: only the first MiB is pattern-scanned (bounded cost). */
const SECRET_SCAN_BYTES = 1024 * 1024

/** Intake DDL — additive, idempotent, isolated from business tables. */
export const INTAKE_DDL = `
CREATE TABLE IF NOT EXISTS intake_sessions (
  intake_id TEXT PRIMARY KEY,
  project_id TEXT,
  owner_principal_id TEXT NOT NULL,
  owner_tenant_id TEXT NOT NULL DEFAULT '',
  owner_auth_method TEXT NOT NULL DEFAULT 'agent',
  owner_session_id TEXT,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  source_label TEXT NOT NULL,
  target_phase TEXT,
  expires_at TEXT NOT NULL,
  scan_summary TEXT NOT NULL DEFAULT '{}',
  proposal_json TEXT,
  receipt_json TEXT,
  audit_json TEXT NOT NULL DEFAULT '[]',
  idempotency_key TEXT,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intake_idempotency ON intake_sessions(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intake_project ON intake_sessions(project_id, status);
CREATE TABLE IF NOT EXISTS intake_artifacts (
  intake_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  quarantine TEXT NOT NULL,
  scan_result TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (intake_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS idx_intake_artifacts_session ON intake_artifacts(intake_id);
CREATE TABLE IF NOT EXISTS intake_observations (
  observation_id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL DEFAULT '',
  locator TEXT NOT NULL DEFAULT '',
  detector TEXT NOT NULL,
  detector_version TEXT NOT NULL DEFAULT '1',
  value TEXT NOT NULL,
  warnings TEXT NOT NULL DEFAULT '[]',
  trust TEXT NOT NULL DEFAULT 'observed_unverified',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intake_observations_session ON intake_observations(intake_id);
CREATE TABLE IF NOT EXISTS intake_questions (
  intake_id TEXT NOT NULL,
  question_code TEXT NOT NULL,
  question_revision INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 0,
  answer TEXT,
  answered_by_principal TEXT,
  answered_by_session TEXT,
  answered_at TEXT,
  PRIMARY KEY (intake_id, question_code)
);
`

/** Static deny list: native executables / binary payloads (never adoptable). */
export const INTAKE_DENY_EXTENSIONS: readonly string[] = [
  'exe', 'com', 'bat', 'cmd', 'msi', 'msix', 'msp', 'scr', 'pif', 'gadget',
  'dll', 'sys', 'so', 'dylib', 'bundle', 'app', 'apk', 'deb', 'rpm', 'bin',
  'iso', 'img', 'elf', 'o', 'a', 'lib', 'pyc', 'pyo', 'class', 'jar', 'war',
  'wasm', 'dmg', 'vxd', 'ocx', 'cpl', 'drv', 'ko', 'efi', 'node',
]

/** Quarantine list: active content / credentials / unknown — human review. */
export const INTAKE_QUARANTINE_EXTENSIONS: readonly string[] = [
  'html', 'htm', 'svg', 'env', 'pem', 'key', 'p12', 'pfx', 'pcap', '',
]

/** Allow list: importable research material (scripts import but never run). */
export const INTAKE_ALLOW_EXTENSIONS: readonly string[] = [
  'pdf', 'docx', 'doc', 'tex', 'bib', 'md', 'txt', 'rst',
  'py', 'ipynb', 'r', 'jl', 'js', 'ts', 'c', 'h', 'cpp', 'hpp', 'cc', 'rs',
  'go', 'java', 'scala', 'kt', 'cs', 'sh',
  'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'parquet', 'npy',
  'npz', 'h5', 'hdf5', 'sql',
  'log', 'out', 'err',
  'png', 'jpg', 'jpeg', 'gif', 'webp',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z',
  'lock', 'lockfile', 'toml', 'ini', 'cfg',
]

/** Archive extensions: extract-time code-snapshot walk limits apply (§4.1). */
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z'])

/** Script/notebook extensions: importable as code, NEVER auto-executed. */
const SCRIPT_EXTENSIONS = new Set(['py', 'ipynb', 'r', 'jl', 'js', 'ts', 'c', 'h', 'cpp', 'hpp', 'cc', 'rs', 'go', 'java', 'scala', 'kt', 'cs', 'sh'])

/** Magic-byte expectations for a handful of well-known formats. */
const MAGIC_RULES: Record<string, { check: string; bytes: number[] }> = {
  pdf: { check: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  docx: { check: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK\x03\x04
  zip: { check: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  gz: { check: 'gzip', bytes: [0x1f, 0x8b] },
  tgz: { check: 'gzip', bytes: [0x1f, 0x8b] },
  png: { check: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  jpg: { check: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  jpeg: { check: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  gif: { check: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
}

/** Native binary magic (ELF / MZ) — content is executable regardless of name. */
const BINARY_MAGICS: Array<{ kind: string; bytes: number[] }> = [
  { kind: 'elf', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { kind: 'pe', bytes: [0x4d, 0x5a] },
]

/** Static secret patterns (documented as NOT a substitute for a real detector). */
const SECRET_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { kind: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'github_token', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { kind: 'openai_api_key', re: /\bsk-[A-Za-z0-9]{20,64}\b/ },
]

/** One question definition in the versioned taxonomy. */
export interface GrillQuestionDef {
  code: string
  label_key: string
  prompt: string
  reason: string
  question_type: 'text' | 'choice' | 'boolean'
  /** Phases the question applies to; 'all' = every phase. */
  phases: ObservedPhase[] | 'all'
  /** Phases in which the question is REQUIRED. */
  required_in: ObservedPhase[]
}

/** Stable, versioned question bank (research-onboarding.md §5 coverage). */
export const GRILL_QUESTION_BANK: readonly GrillQuestionDef[] = [
  {
    code: 'owner_scope_license', label_key: 'grill.owner_scope_license',
    prompt: 'Who owns this material, what is its scope, and under which license is it shared?',
    reason: 'ownership/scope/license are mandatory provenance for every import',
    question_type: 'text', phases: 'all',
    required_in: ['brief', 'survey', 'idea', 'baseline', 'contract', 'experiment', 'evidence', 'writing', 'review', 'release'],
  },
  {
    code: 'observed_phase_claim', label_key: 'grill.observed_phase_claim',
    prompt: 'Which phase do you believe this material has reached (brief/survey/idea/baseline/contract/experiment/evidence/writing/review/release)?',
    reason: 'the claimed phase drives the safe landing mapping — it is metadata, never an automatic status',
    question_type: 'choice', phases: 'all',
    required_in: ['brief', 'survey', 'idea', 'baseline', 'contract', 'experiment', 'evidence', 'writing', 'review', 'release'],
  },
  {
    code: 'privacy_secret_network', label_key: 'grill.privacy_secret_network',
    prompt: 'Does the material contain private data, secrets, or require network access?',
    reason: 'privacy/secret/network exposure must be declared before adoption',
    question_type: 'text', phases: 'all',
    required_in: ['brief', 'survey', 'idea', 'baseline', 'contract', 'experiment', 'evidence', 'writing', 'review', 'release'],
  },
  {
    code: 'tex_root_engine', label_key: 'grill.tex_root_engine',
    prompt: 'Which TeX root file and engine does the manuscript use?',
    reason: 'imported TeX must be rebuilt locally; the uploaded PDF is immediately stale',
    question_type: 'text', phases: ['writing', 'review', 'release'],
    required_in: ['writing', 'review', 'release'],
  },
  {
    code: 'code_commit_lock_image', label_key: 'grill.code_commit_lock_image',
    prompt: 'Which code commit, lockfile and container image does the reproduction use?',
    reason: 'reproducibility requires a pinned commit/lock/image for clean verification',
    question_type: 'text', phases: ['baseline', 'contract', 'experiment', 'evidence'],
    required_in: ['baseline', 'contract', 'experiment', 'evidence'],
  },
  {
    code: 'data_version_split_preprocess', label_key: 'grill.data_version_split_preprocess',
    prompt: 'What is the data version, split and preprocessing?',
    reason: 'data lineage (version/split/preprocess) is required for trustworthy metrics',
    question_type: 'text', phases: ['baseline', 'contract', 'experiment', 'evidence'],
    required_in: ['baseline', 'contract', 'experiment', 'evidence'],
  },
  {
    code: 'seed', label_key: 'grill.seed',
    prompt: 'Which random seed(s) were used?',
    reason: 'seeded runs are required for deterministic re-analysis',
    question_type: 'text', phases: ['experiment', 'evidence'],
    required_in: ['experiment', 'evidence'],
  },
  {
    code: 'metric_definition_direction', label_key: 'grill.metric_definition_direction',
    prompt: 'What is the metric definition and direction (higher/lower is better)?',
    reason: 'metric direction is required to interpret imported effect sizes',
    question_type: 'text', phases: ['baseline', 'contract', 'experiment', 'evidence'],
    required_in: ['baseline', 'contract', 'experiment', 'evidence'],
  },
  {
    code: 'run_manifest_signature', label_key: 'grill.run_manifest_signature',
    prompt: 'Is a Run ID / signed RunManifest available for the results?',
    reason: 'without a signed RunManifest no RunSet/accepted Evidence can be synthesized',
    question_type: 'text', phases: ['experiment', 'evidence', 'release'],
    required_in: ['experiment', 'evidence', 'release'],
  },
  {
    code: 'statistics_ci_n', label_key: 'grill.statistics_ci_n',
    prompt: 'Which statistics, confidence intervals and number of runs (n) are reported?',
    reason: 'statistical claims need CI/n provenance to be re-verified',
    question_type: 'text', phases: ['experiment', 'evidence', 'review'],
    required_in: ['experiment', 'evidence', 'review'],
  },
  {
    code: 'target_venue', label_key: 'grill.target_venue',
    prompt: 'Which venue is this material targeting?',
    reason: 'venue constraints shape release and review requirements',
    question_type: 'text', phases: ['writing', 'review', 'release'],
    required_in: ['writing', 'review', 'release'],
  },
]

/**
 * Deterministic question set for a target phase (research-onboarding.md §5):
 * same inputs → same question codes (grill-deterministic). The LLM may only
 * translate/rephrase tone — the taxonomy above is the only source.
 */
export function questionsForTargetPhase(targetPhase: ObservedPhase | null): GrillQuestion[] {
  return GRILL_QUESTION_BANK
    .filter(q => q.phases === 'all' || q.phases.includes(targetPhase ?? 'brief'))
    .map(q => ({
      question_code: q.code,
      label_key: q.label_key,
      prompt: q.prompt,
      reason: q.reason,
      required: q.required_in.includes(targetPhase ?? 'brief'),
      depends_on: [],
      question_revision: GRILL_QUESTION_REVISION,
      question_type: q.question_type,
    }))
}

/** Question codes REQUIRED for a target phase (deterministic). */
export function requiredQuestionCodes(targetPhase: ObservedPhase | null): Set<string> {
  return new Set(
    GRILL_QUESTION_BANK
      .filter(q => q.phases === 'all' || q.phases.includes(targetPhase ?? 'brief'))
      .filter(q => q.required_in.includes(targetPhase ?? 'brief'))
      .map(q => q.code),
  )
}

function extensionOf(fileName: string): string {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** Sanitized verdict reason for scan_result (never contains secret values). */
export interface StaticScanVerdict {
  quarantine: IntakeArtifact['quarantine']
  scan_result: Record<string, unknown>
  observations: Array<Pick<IntakeObservation, 'detector' | 'detector_version' | 'locator' | 'value' | 'warnings'>>
}

/**
 * Static security scan (research-onboarding.md §4.2) — NO AV in this
 * environment (recorded honestly in scan_result). Checks:
 *  1. extension allow/deny/quarantine (executable content → rejected);
 *  2. magic-byte verification for known formats (mismatch → quarantined);
 *  3. native binary magic regardless of name (ELF/PE → rejected);
 *  4. static secret patterns in the first 1 MiB (hit → quarantined; the
 *     secret VALUE is never echoed into scan_result/observations);
 *  5. size cap (caller-enforced 413 before bytes land in staging);
 *  6. archive bomb/nesting/symlink/path checks are DEEPER than static scan —
 *     they run at adoption-time code-snapshot extraction (existing walk);
 *     the observation below records that honestly.
 */
export function scanIntakeArtifactStatic(fileName: string, mediaType: string, bytes: Uint8Array): StaticScanVerdict {
  const ext = extensionOf(fileName)
  const warnings: string[] = []
  const observations: StaticScanVerdict['observations'] = []
  const base = { scanner: 'static-rules-v1', av_available: false }

  if (INTAKE_DENY_EXTENSIONS.includes(ext)) {
    return {
      quarantine: 'rejected',
      scan_result: { ...base, extension: ext, verdict: 'rejected', reason: 'executable_extension', warnings: ['executable content is statically rejected (no AV available)'] },
      observations: [{ detector: 'extension', detector_version: '1', locator: fileName, value: `rejected extension .${ext}`, warnings: ['executable_extension'] }],
    }
  }
  if (INTAKE_QUARANTINE_EXTENSIONS.includes(ext)) {
    const reason = ext === '' ? 'no_extension' : `active_or_sensitive_extension_${ext}`
    return {
      quarantine: 'quarantined',
      scan_result: { ...base, extension: ext, verdict: 'quarantined', reason, warnings: ['human review required before adoption'] },
      observations: [{ detector: 'extension', detector_version: '1', locator: fileName, value: `quarantined extension ${ext === '' ? '(none)' : `.${ext}`}`, warnings: [reason] }],
    }
  }
  if (!INTAKE_ALLOW_EXTENSIONS.includes(ext)) {
    return {
      quarantine: 'quarantined',
      scan_result: { ...base, extension: ext, verdict: 'quarantined', reason: 'unknown_extension', warnings: ['human review required before adoption'] },
      observations: [{ detector: 'extension', detector_version: '1', locator: fileName, value: `unknown extension ${ext === '' ? '(none)' : `.${ext}`}`, warnings: ['unknown_extension'] }],
    }
  }

  // Magic-byte verification for well-known formats.
  const magicRule = MAGIC_RULES[ext]
  const sniff = (prefix: number[]): boolean => prefix.every((b, i) => (bytes as Uint8Array)[i] === b)
  if (magicRule !== undefined && !sniff(magicRule.bytes)) {
    // A known format whose header does not match — likely renamed content.
    return {
      quarantine: 'quarantined',
      scan_result: { ...base, extension: ext, verdict: 'quarantined', reason: 'magic_mismatch', warnings: [`extension .${ext} does not match its magic bytes`] },
      observations: [{ detector: 'magic', detector_version: '1', locator: fileName, value: `magic mismatch for .${ext} (expected ${magicRule.check})`, warnings: ['magic_mismatch'] }],
    }
  }
  for (const binary of BINARY_MAGICS) {
    if (sniff(binary.bytes)) {
      return {
        quarantine: 'rejected',
        scan_result: { ...base, extension: ext, verdict: 'rejected', reason: `binary_content_${binary.kind}`, warnings: ['native executable content is statically rejected'] },
        observations: [{ detector: 'magic', detector_version: '1', locator: fileName, value: `${binary.kind.toUpperCase()} binary magic detected`, warnings: ['binary_content'] }],
      }
    }
  }

  // Static secret patterns (first MiB; bounded cost).
  const head = Buffer.from(bytes.subarray(0, Math.min(SECRET_SCAN_BYTES, bytes.byteLength))).toString('utf8')
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(head)) {
      // The scan result records the PATTERN KIND only — never the value.
      return {
        quarantine: 'quarantined',
        scan_result: { ...base, extension: ext, verdict: 'quarantined', reason: `secret_detected_${pattern.kind}`, warnings: ['secret value is never echoed; delete/replace the file or create a server-side SecretRef'] },
        observations: [{ detector: 'secret_static', detector_version: '1', locator: fileName, value: `${pattern.kind} pattern detected (value redacted)`, warnings: ['secret_detected'] }],
      }
    }
  }

  // Honest notes for allowed material.
  if (ARCHIVE_EXTENSIONS.has(ext)) {
    warnings.push('archive: path/symlink/duplicate/bomb limits are enforced by the adoption-time code-snapshot extraction walk')
    observations.push({ detector: 'archive', detector_version: '1', locator: fileName, value: 'archive registered as single blob; extraction limits apply at adoption', warnings: ['archive_extract_pending'] })
  }
  if (SCRIPT_EXTENSIONS.has(ext)) {
    warnings.push('script/notebook imports are never auto-executed by the platform')
    observations.push({ detector: 'script', detector_version: '1', locator: fileName, value: 'script material imported as code; no auto-execution', warnings: ['script_never_auto_execute'] })
  }
  observations.push({ detector: 'size', detector_version: '1', locator: fileName, value: `${bytes.byteLength} bytes (<= ${INTAKE_MAX_FILE_BYTES})`, warnings: [] })
  return {
    quarantine: 'clean',
    scan_result: { ...base, extension: ext, magic: magicRule?.check ?? null, media_type_hint: mediaType, verdict: 'clean', warnings },
    observations,
  }
}

/** Project artifact kind for an adopted intake file (research-onboarding.md §6.1). */
export function artifactKindForFile(fileName: string): ArtifactKind {
  const ext = extensionOf(fileName)
  switch (ext) {
    case 'pdf': return 'pdf'
    case 'docx': case 'doc': case 'tex': case 'bib': case 'md': case 'txt': case 'rst': return 'paper'
    case 'csv': case 'tsv': case 'json': case 'jsonl': case 'yaml': case 'yml': case 'xml': case 'parquet': case 'npy': case 'npz': case 'h5': case 'hdf5': return 'data'
    case 'log': case 'out': case 'err': return 'log'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': return 'chart'
    case 'zip': case 'tar': case 'gz': case 'tgz': case 'bz2': case 'xz': case '7z': return 'code'
    case 'lock': case 'lockfile': case 'toml': case 'ini': case 'cfg': return 'manifest'
    default: return 'code'
  }
}

/** Whether a file name suggests importable metrics/results (draft evidence). */
export function isImportableMetricsFile(fileName: string): boolean {
  const ext = extensionOf(fileName)
  if (!['json', 'csv', 'tsv'].includes(ext)) return false
  return /(metrics|results|analysis)/i.test(fileName)
}

/** Parsed MetricsFileV1-like payload (schema_version=1 + metrics[]). */
export interface ParsedMetricsFile {
  metrics: Array<{ name: string; unit: string | null; value: number; seed: number | null }>
}

/**
 * Parse a MetricsFileV1-like JSON file (runner output format). Only fully
 * valid files (schema_version=1, non-empty metrics, finite values) yield
 * draft evidence — anything else stays a plain data artifact (no fabricated
 * results).
 */
export function parseMetricsFileV1(bytes: Uint8Array): ParsedMetricsFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (obj.schema_version !== 1 || !Array.isArray(obj.metrics)) return null
  const metrics: ParsedMetricsFile['metrics'] = []
  for (const m of obj.metrics as unknown[]) {
    if (typeof m !== 'object' || m === null) return null
    const row = m as Record<string, unknown>
    if (typeof row.name !== 'string' || row.name === '') return null
    if (typeof row.value !== 'number' || !Number.isFinite(row.value)) return null
    metrics.push({
      name: row.name,
      unit: typeof row.unit === 'string' ? row.unit : null,
      value: row.value,
      seed: typeof row.seed === 'number' && Number.isFinite(row.seed) ? row.seed : null,
    })
  }
  if (metrics.length === 0) return null
  return { metrics }
}

/** Safe landing map — research-onboarding.md §6 table, kernel-state-machine safe. */
export interface PhaseLanding {
  /** Kernel-derived safe status (a fresh DRAFT project stays DRAFT). */
  safe_project_status: string
  /** Gate types created PENDING at adoption (never decided by the intake). */
  required_gates: string[]
  plan: string
  risks: string[]
  /** Post-adoption action codes (GUIDE-01 style). */
  actions: Array<{ code: string; label: string; reason: string; route: string; required_by: 'human' | 'agent' | 'runner' }>
}

/** Deterministic phase landing (research-onboarding.md §6 table). */
export const SAFE_PHASE_LANDING: Record<ObservedPhase, PhaseLanding> = {
  brief: {
    safe_project_status: 'DRAFT',
    required_gates: ['scope'],
    plan: 'Adopt as a DRAFT project: import background/data only, then complete the Scope Gate like any new project.',
    risks: ['Imported material provenance is unverified; nothing is accepted as evidence yet'],
    actions: [{ code: 'intake_scope_gate', label: 'Complete Scope Gate', reason: 'imported background is adopted into DRAFT; the Scope Gate decides SCOPED', route: 'gates', required_by: 'human' }],
  },
  survey: {
    safe_project_status: 'DRAFT',
    required_gates: ['scope'],
    plan: 'Adopt corpus/background as draft material into DRAFT; create the Scope Gate (no verifiable scope decision exists).',
    risks: ['Corpus claims are unverified', 'Citations remain untrusted observations'],
    actions: [{ code: 'intake_scope_gate', label: 'Complete Scope Gate', reason: 'adopted corpus stays draft until the Scope Gate decides SCOPED', route: 'gates', required_by: 'human' }],
  },
  idea: {
    safe_project_status: 'DRAFT',
    required_gates: ['idea'],
    plan: 'Adopt idea material; create a PENDING Idea Gate (IDEA_APPROVED is never faked). The project stays DRAFT and must pass the normal gate flow.',
    risks: ['Idea claims are unverified', 'No IDEA_APPROVED can be synthesized from an import'],
    actions: [{ code: 'intake_idea_gate', label: 'Approve Idea at the Idea Gate', reason: 'the imported idea must pass the human Idea Gate before the baseline phase', route: 'gates', required_by: 'human' }],
  },
  baseline: {
    safe_project_status: 'DRAFT',
    required_gates: [],
    plan: 'Adopt reproduction package; require a CLEAN baseline verification run before any contract binds to it.',
    risks: ['Baseline numbers are unverified', 'Imported environment may differ from the pinned image'],
    actions: [{ code: 'intake_clean_baseline', label: 'Run clean baseline verification', reason: 'imported baseline must be reproduced in the isolated runner before contracts bind', route: 'runs', required_by: 'agent' }],
  },
  contract: {
    safe_project_status: 'DRAFT',
    required_gates: ['contract'],
    plan: 'Adopt contract material; create a PENDING Contract Gate (CONTRACT_APPROVED is never faked).',
    risks: ['Contract claims are unverified', 'No CONTRACT_APPROVED can be synthesized from an import'],
    actions: [{ code: 'intake_contract_gate', label: 'Approve Contract at the Contract Gate', reason: 'the imported contract must pass the human Contract Gate and freeze a project-owned contract', route: 'gates', required_by: 'human' }],
  },
  experiment: {
    safe_project_status: 'DRAFT',
    required_gates: [],
    plan: 'Adopt experiment material; imported results stay UNVERIFIED and require a clean run/reanalysis before any claim.',
    risks: ['Imported results are unverified', 'No RunSet/accepted Evidence can be synthesized without a signed RunManifest'],
    actions: [{ code: 'intake_clean_reanalysis', label: 'Run clean re-analysis', reason: 'imported results stay unverified until a clean run/reanalysis reproduces them', route: 'runs', required_by: 'agent' }],
  },
  evidence: {
    safe_project_status: 'DRAFT',
    required_gates: [],
    plan: 'Adopt evidence material; imported results stay UNVERIFIED and require a clean run/reanalysis before any claim.',
    risks: ['Imported evidence is unverified', 'No accepted Evidence can be synthesized without a signed RunManifest'],
    actions: [{ code: 'intake_clean_reanalysis', label: 'Run clean re-analysis', reason: 'imported evidence stays unverified until reproduced', route: 'runs', required_by: 'agent' }],
  },
  writing: {
    safe_project_status: 'DRAFT',
    required_gates: [],
    plan: 'Adopt TeX/paper material; the imported PDF is immediately STALE and requires a local build from the imported sources.',
    risks: ['Imported PDF is stale by definition', 'TeX sources may not compile in the pinned image'],
    actions: [{ code: 'intake_tex_build', label: 'Rebuild TeX from imported sources', reason: 'imported PDF is stale; a local build from imported sources is required', route: 'manuscript', required_by: 'agent' }],
  },
  review: {
    safe_project_status: 'DRAFT',
    required_gates: [],
    plan: 'Adopt review-stage material; require review/clean-room gaps to be closed before release.',
    risks: ['Review claims are unverified', 'Clean-room rerun gap remains open'],
    actions: [{ code: 'intake_clean_room_review', label: 'Close review/clean-room gaps', reason: 'review-stage imports need independent review and a clean-room rerun', route: 'runs', required_by: 'agent' }],
  },
  release: {
    safe_project_status: 'DRAFT',
    required_gates: ['release'],
    plan: 'Adopt release material; create a PENDING Release Gate (RELEASED is never faked).',
    risks: ['Release claims are unverified', 'No RELEASED can be synthesized from an import'],
    actions: [{ code: 'intake_release_gate', label: 'Complete Release Gate', reason: 'public release requires a human Release Gate decision', route: 'gates', required_by: 'human' }],
  },
}

const PRE_ACCEPT_CHECKLIST = [
  'All required Grill questions answered by a Human Principal (provenance human_assertion)',
  'Every staged artifact passed the static scan (no quarantined/rejected content)',
  'Imported scripts/notebooks are never auto-executed by the platform',
  'Imported results/evidence stay unverified until a clean run/reanalysis',
]

/** Deterministic proposal builder — same inputs → same proposal fields. */
export function buildPhaseProposal(input: {
  intakeId: string
  revision: number
  targetPhase: ObservedPhase | null
  answers: Map<string, { answer: string; answered_at: string }>
  artifacts: IntakeArtifact[]
  observations: IntakeObservation[]
  projectStatus: string
  now: string
}): PhaseProposal {
  const { intakeId, revision, targetPhase, answers, artifacts, observations, projectStatus, now } = input

  // observed_phase: the human's claim wins when valid, else the target phase,
  // else 'brief' — with the gap recorded (unknown/partial keeps a gap).
  const claim = answers.get('observed_phase_claim')?.answer ?? ''
  const claimedPhase = (['brief', 'survey', 'idea', 'baseline', 'contract', 'experiment', 'evidence', 'writing', 'review', 'release'] as const)
    .find(p => p === claim)
  const observedPhase: ObservedPhase = claimedPhase ?? targetPhase ?? 'brief'

  const questions = questionsForTargetPhase(targetPhase)
  const required = requiredQuestionCodes(targetPhase)
  const gaps: string[] = []
  if (claimedPhase === undefined && claim !== '') gaps.push('observed_phase_claim_invalid')
  if (claimedPhase === undefined && targetPhase === null) gaps.push('observed_phase_unclaimed')

  // Confidence: deterministic function of answers + scan verdicts.
  let confidence = 0.4
  let requiredAnswered = 0
  for (const q of questions) {
    if (!q.required) continue
    const answer = answers.get(q.question_code)
    if (answer !== undefined && answer.answer !== '' && answer.answer.toLowerCase() !== 'unknown') {
      requiredAnswered += 1
    } else {
      gaps.push(`${q.question_code}_required_unanswered`)
      if (answer !== undefined) gaps.push(`${q.question_code}_unknown`)
    }
  }
  confidence += Math.min(0.3, requiredAnswered * 0.05)
  let cleanCount = 0
  let quarantined = 0
  let rejected = 0
  for (const artifact of artifacts) {
    if (artifact.quarantine === 'clean') cleanCount += 1
    else if (artifact.quarantine === 'quarantined') quarantined += 1
    else if (artifact.quarantine === 'rejected') rejected += 1
  }
  if (artifacts.length > 0 && cleanCount === artifacts.length) confidence += 0.2
  if (quarantined > 0) confidence -= 0.15
  if (rejected > 0) confidence -= 0.25
  // Optional (non-required) unanswered questions keep gaps + lower confidence.
  for (const q of questions) {
    if (q.required) continue
    const answer = answers.get(q.question_code)
    if (answer === undefined) gaps.push(`${q.question_code}_unanswered`)
  }
  confidence = Math.max(0.1, Math.min(0.95, confidence))
  confidence = Math.round(confidence * 100) / 100

  // Scan warnings surface as gaps.
  for (const observation of observations) {
    if (observation.warnings.length > 0) {
      gaps.push(`${observation.detector}:${observation.value}`)
    }
  }
  // Unverified-run gap for phases whose results would need a RunManifest.
  if (['experiment', 'evidence', 'release'].includes(observedPhase)) {
    const hasManifest = answers.get('run_manifest_signature')
    if (hasManifest === undefined || /^(no|none|n\/a|unknown)$/i.test(hasManifest.answer)) {
      gaps.push('run_manifest_unverified')
    }
  }
  const archivePresent = artifacts.some(a => {
    const ext = a.file_name.slice(a.file_name.lastIndexOf('.') + 1).toLowerCase()
    return ARCHIVE_EXTENSIONS.has(ext)
  })
  if (archivePresent) gaps.push('archive_extract_pending')

  const landing = SAFE_PHASE_LANDING[observedPhase]
  const mappings: ImportMapping[] = artifacts.map(a => ({
    source_artifact_id: a.artifact_id,
    target_kind: artifactKindForFile(a.file_name),
    note: a.file_name,
  }))

  const nextActions = landing.actions.map((a, index) => ({
    id: `${a.code}:${intakeId}`,
    code: a.code,
    label: a.label,
    reason: a.reason,
    required: true as const,
    route: a.route,
    revision: null,
    state: 'ready' as const,
    blocking: false,
    refs: [{ kind: 'intake', id: intakeId }],
    required_by: a.required_by,
  }))
  for (const gateType of landing.required_gates) {
    nextActions.push({
      id: `gate_decide:${intakeId}:${gateType}`,
      code: 'gate_decide',
      label: `Decide pending ${gateType} gate`,
      reason: `adoption created a PENDING ${gateType} gate — a human decides it (never the intake)`,
      route: 'gates',
      required: true,
      revision: null,
      state: 'ready',
      blocking: true,
      refs: [{ kind: 'intake', id: intakeId }, { kind: 'gate_type', id: gateType }],
      required_by: 'human',
    })
  }

  return {
    proposal_id: `proposal_${intakeId.slice(-12)}_r${revision}`,
    intake_id: intakeId,
    revision,
    observed_phase: observedPhase,
    safe_project_status: projectStatus,
    confidence,
    plan: landing.plan,
    risks: landing.risks,
    pre_accept_checklist: [...PRE_ACCEPT_CHECKLIST],
    unresolved_gaps: [...new Set(gaps)],
    suggested_mappings: mappings,
    required_gates: landing.required_gates,
    next_actions: nextActions,
    created_at: now,
  }
}

/** Question view with recorded answer state (resume/GET projection). */
export function questionViews(questions: GrillQuestion[], answers: Map<string, { answer: string; answered_at: string; answered_by: string | null }>): GrillAnswerView[] {
  return questions.map(q => {
    const a = answers.get(q.question_code)
    return {
      ...q,
      answer: a?.answer ?? null,
      answered_at: a?.answered_at ?? null,
      answered_by: a?.answered_by ?? null,
      provenance: a === undefined ? 'unanswered' : 'human_assertion',
    }
  })
}
