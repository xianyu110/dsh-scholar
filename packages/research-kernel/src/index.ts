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
