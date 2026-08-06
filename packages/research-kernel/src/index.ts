/**
 * @dsh-scholar/research-kernel — authoritative research state.
 * @module @dsh-scholar/research-kernel
 */

export { ResearchKernel, KernelError, type KernelOptions } from './kernel.js'
export { startKernelServer, type KernelServerOptions } from './server.js'
export { ArtifactCas } from './cas.js'
export { openDatabase, SCHEMA_VERSION } from './store.js'
