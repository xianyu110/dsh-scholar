/**
 * @dsh-scholar/research-kernel — authoritative research state.
 * @module @dsh-scholar/research-kernel
 */

export { ResearchKernel, KernelError, validateUploadFileName, type KernelOptions } from './kernel.js'
export { nextActionProjection, legacyNextActionStrings, type NextActionContext, type NextActionJob, type NextActionRoute } from './next-action.js'
export { IMAGES_LOCK, getLockedDigest, validateImageDigest, type ImagesLock, type LockedImageKind, type SecureJobKind } from './images-lock.js'
export { parseLatexDiagnostics, type LatexDiagnostic } from './tex-diagnostics.js'
export { startKernelServer, type KernelServerOptions } from './server.js'
export { ArtifactCas } from './cas.js'
export { openDatabase, SCHEMA_VERSION } from './store.js'
export { runMigrations, MIGRATIONS, checksumOf } from './migrations.js'
export {
  openPtySessionStore, PtySessionStore, PtyError, NullPtyAdapter,
  PTY_DEFAULT_IDLE_TTL_S, PTY_DEFAULT_RETENTION_BYTES, PTY_DEFAULT_LEASE_TTL_S,
  type PtyAdapter, type PtySpawnPlan, type PtyControlResult, type PtyAppendResult, type PtySessionRow,
} from './pty-session.js'
export {
  openWorkspaceStore, WorkspaceStore, WorkspaceError, normalizeWorkspacePath, mediaTypeOf, withImpliedDirs, EMPTY_CONTENT_HASH,
  type WorkspaceStoreLike, type WorkspaceExpected,
} from './workspace-store.js'
export { TexWorkspaceFacade, texWorkspaceId, texDocumentId, texInfoToWorkspaceInfo, texEntryToWorkspaceNode } from './tex-facade.js'
