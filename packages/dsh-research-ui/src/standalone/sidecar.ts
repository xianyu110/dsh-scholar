/** Standalone BFF adapter for the shared Kernel sidecar lifecycle module. */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  KernelSidecarLifecycle,
  SidecarIdentityError,
  type EndpointRecord,
  type KernelSidecarLifecycleOptions,
} from '@dsh-scholar/research-kernel'

export interface UiKernelSidecarOptions extends Omit<KernelSidecarLifecycleOptions, 'dataDir' | 'token' | 'logTag'> {
  dataDir?: string
}

export class UiKernelSidecar extends KernelSidecarLifecycle {
  constructor(options: UiKernelSidecarOptions = {}) {
    const base = process.env.DSH_HOME ?? join(homedir(), '.dsh-scholar-standalone')
    super({ ...options, dataDir: options.dataDir ?? join(base, 'research-ui-standalone'), logTag: 'research-ui' })
  }
}

export { SidecarIdentityError, type EndpointRecord }
