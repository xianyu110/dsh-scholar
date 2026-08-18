/** DSH plugin adapter for the shared Kernel sidecar lifecycle module. */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  KernelSidecarLifecycle,
  SidecarIdentityError,
  type EndpointRecord,
  type KernelSidecarLifecycleOptions,
} from '@dsh-scholar/research-kernel'

export interface KernelSidecarOptions extends Omit<KernelSidecarLifecycleOptions, 'dataDir' | 'logTag'> {
  dataDir?: string
}

export function resolveDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export class KernelSidecar extends KernelSidecarLifecycle {
  constructor(options: KernelSidecarOptions = {}) {
    super({ ...options, dataDir: options.dataDir ?? join(resolveDshHome(), 'research-kernel'), logTag: 'research-plugin' })
  }
}

export { SidecarIdentityError, type EndpointRecord }
