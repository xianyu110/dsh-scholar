/**
 * @dsh-scholar/research-kernel — authoritative research state.
 * @module @dsh-scholar/research-kernel
 */

export { ResearchKernel, KernelError, validateUploadFileName, type KernelOptions, type IntegrityScanReport } from './kernel.js'
export { createStartupBackup, type StartupBackupResult } from './backup.js'
export { nextActionProjection, legacyNextActionStrings, INTAKE_ACTIVE_STATUSES, type NextActionContext, type NextActionJob, type NextActionIntake, type NextActionReproduction, type NextActionRoute } from './next-action.js'
export { REPRODUCTION_DDL, reproductionCanonicalJson, reproductionSha256 } from './reproduction.js'
export {
  compareMetric, compareMetrics, compareTable, compareTables, compareFigure, compareFigures, compareManuscript,
  comparisonGroupChecks, evaluateReportStatus, suggestFailureClass,
  type MetricActual, type TableExpected, type TableActual, type FigureExpected, type FigureActual,
  type ManuscriptExpected, type ManuscriptActual,
} from './reproduction-compare.js'
export {
  INTAKE_DDL, GRILL_TAXONOMY_VERSION, GRILL_QUESTION_REVISION, INTAKE_DEFAULT_TTL_MS, INTAKE_STAGED_TTL_MS,
  GRILL_QUESTION_BANK, questionsForTargetPhase, requiredQuestionCodes, scanIntakeArtifactStatic,
  artifactKindForFile, isImportableMetricsFile, parseMetricsFileV1, buildPhaseProposal, questionViews,
  SAFE_PHASE_LANDING, isTexMaterializableFile, isCodeMaterializableFile,
  TEX_MATERIALIZE_EXTENSIONS, CODE_MATERIALIZE_EXTENSIONS, ARCHIVE_SCAN_EXTENSIONS, INTAKE_ARCHIVE_EXTENSIONS,
  type GrillQuestionDef, type StaticScanVerdict, type PhaseLanding, type ParsedMetricsFile,
} from './intake.js'
export {
  scanArchive, extractArchiveEntries, archiveKindOf, ArchiveScanError, DEFAULT_ARCHIVE_LIMITS,
  type ArchiveKind, type ArchiveLimits, type ArchiveScanEntry, type ArchiveScanResult, type ArchiveScanErrorCode,
} from './archive-scan.js'
export { IMAGES_LOCK, getLockedDigest, validateImageDigest, type ImagesLock, type LockedImageKind, type SecureJobKind } from './images-lock.js'
export { parseLatexDiagnostics, type LatexDiagnostic } from './tex-diagnostics.js'
export { startKernelServer, type KernelServerOptions } from './server.js'
export { ArtifactCas, type CasInventoryEntry } from './cas.js'
export { MetricsStore, HISTOGRAM_BUCKETS, type MetricsSnapshot, type CounterView, type HistogramView, type HistogramBucket, type MetricTags } from './metrics.js'
export { openDatabase, SCHEMA_VERSION } from './store.js'
export { runMigrations, MIGRATIONS, checksumOf } from './migrations.js'
export {
  openPtySessionStore, PtySessionStore, PtyError, NullPtyAdapter,
  PTY_DDL, PTY_SESSIONS_TABLE_DDL,
  PTY_DEFAULT_IDLE_TTL_S, PTY_DEFAULT_RETENTION_BYTES, PTY_DEFAULT_LEASE_TTL_S,
  type PtyAdapter, type PtySpawnPlan, type PtyControlResult, type PtyAppendResult, type PtySessionRow,
} from './pty-session.js'
export {
  LocalPtyAdapter, PTY_SHELL_PRESETS,
  type LocalPtyAdapterOptions, type PtyOutputInput,
} from './pty-local.js'
export {
  openWorkspaceStore, WorkspaceStore, WorkspaceError, normalizeWorkspacePath, mediaTypeOf, withImpliedDirs, EMPTY_CONTENT_HASH,
  matchWorkspaceGlob, HISTORY_KEEP_VERSIONS, WORKSPACE_MAX_FILE_BYTES,
  type WorkspaceStoreLike, type WorkspaceExpected, type WorkspaceIntegrityIssue, type WorkspaceIntegrityReport,
} from './workspace-store.js'
export { TexWorkspaceFacade, texWorkspaceId, texDocumentId, texInfoToWorkspaceInfo, texEntryToWorkspaceNode } from './tex-facade.js'
export {
  TrajectoryStore, laneForKind, redactTrajectorySummary, summaryForKind, statusForKind,
  TRAJECTORY_DDL, TRAJECTORY_PAGE_LIMIT_DEFAULT, TRAJECTORY_PAGE_LIMIT_MAX, TRAJECTORY_SUMMARY_MAX_CHARS,
  BREADCRUMB_MAX_DEPTH,
} from './trajectory.js'
