import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_STANDALONE_SHORTCUT,
  normalizeStandaloneUrl,
} from '../shared/standalone.js'
import {
  SCHOLAR_RPC_CHANNEL,
  type ResearchSettings,
  type ResearchSettingsField,
  type ScholarSettingsMutation,
  type ScholarSettingsWireSnapshot,
} from '../shared/settings-rpc.js'

export type ScholarSettingsRpcCaller = {
  call(channel: string, endpoint: string, payload: unknown): Promise<unknown>
}

const unavailable = (mode: 'host' | 'memory'): SettingsScopeSnapshot<ResearchSettings> => ({
  status: 'unavailable', value: undefined, base: undefined, user: undefined,
  revision: undefined, writable: false, mode,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeSettings(value: unknown): ResearchSettings | undefined {
  if (!isRecord(value)) return undefined
  const result: ResearchSettings = {}
  if ('defaultMode' in value) {
    if (value.defaultMode !== 'gate-only' && value.defaultMode !== 'full-auto') return undefined
    result.defaultMode = value.defaultMode
  }
  if ('unattended' in value) {
    if (typeof value.unattended !== 'boolean') return undefined
    result.unattended = value.unattended
  }
  if ('standalone' in value) {
    if (!isRecord(value.standalone)) return undefined
    const standalone: NonNullable<ResearchSettings['standalone']> = {}
    if ('url' in value.standalone) {
      if (typeof value.standalone.url !== 'string') return undefined
      try { standalone.url = normalizeStandaloneUrl(value.standalone.url) } catch { return undefined }
    }
    if ('shortcut' in value.standalone) {
      if (value.standalone.shortcut !== DEFAULT_STANDALONE_SHORTCUT && value.standalone.shortcut !== 'disabled') return undefined
      standalone.shortcut = value.standalone.shortcut
    }
    result.standalone = standalone
  }
  return result
}

function decodeWireSnapshot(value: unknown): ScholarSettingsWireSnapshot | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || typeof value.writable !== 'boolean' || value.applies !== 'restart') return undefined
  const resolved = decodeSettings(value.value)
  if (resolved === undefined) return undefined
  const base = value.base === undefined ? undefined : decodeSettings(value.base)
  const user = value.user === undefined ? undefined : decodeSettings(value.user)
  if ((value.base !== undefined && base === undefined) || (value.user !== undefined && user === undefined)) return undefined
  return {
    value: resolved,
    ...(base === undefined ? {} : { base }),
    ...(user === undefined ? {} : { user }),
    revision: value.revision as number,
    writable: value.writable,
    applies: 'restart',
  }
}

function decodeRpcSnapshot(response: unknown): ScholarSettingsWireSnapshot | null | undefined {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.value)) return undefined
  if (response.value.available === false) return null
  if (response.value.available !== true) return undefined
  return decodeWireSnapshot(response.value.snapshot)
}

/** Scholar-owned SettingsScope facade over the public Connection RPC extension seam. */
export class ScholarSettingsScope implements SettingsScope<ResearchSettings> {
  private snapshot: SettingsScopeSnapshot<ResearchSettings>
  private readonly listeners = new Set<() => void>()
  private writeTail: Promise<void> = Promise.resolve()
  private epoch = 0
  private disposed = false

  constructor(private readonly rpc: ScholarSettingsRpcCaller, private readonly isLoopback: boolean) {
    this.snapshot = isLoopback
      ? { status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' }
      : unavailable('memory')
  }

  getSnapshot(): SettingsScopeSnapshot<ResearchSettings> { return this.snapshot }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async refresh(): Promise<void> {
    if (this.disposed || !this.isLoopback) return
    const epoch = ++this.epoch
    try {
      const response = await this.rpc.call(SCHOLAR_RPC_CHANNEL, 'settings-snapshot', {})
      if (this.disposed || epoch !== this.epoch) return
      const decoded = decodeRpcSnapshot(response)
      if (decoded === undefined || decoded === null) {
        this.publish(unavailable('host'))
        return
      }
      this.publish({
        status: 'ready', value: decoded.value, base: decoded.base, user: decoded.user,
        revision: decoded.revision, writable: decoded.writable, mode: 'host',
      })
    } catch {
      if (!this.disposed && epoch === this.epoch) this.publish(unavailable('host'))
    }
  }

  set(field: string, value: unknown): Promise<void> {
    return this.enqueue({ op: 'set', field: this.field(field), value, expectedRevision: this.revision() })
  }

  unset(field: string): Promise<void> {
    return this.enqueue({ op: 'unset', field: this.field(field), expectedRevision: this.revision() })
  }

  dispose(): void {
    this.disposed = true
    this.epoch++
    this.listeners.clear()
  }

  private field(field: string): ResearchSettingsField {
    if (field === 'defaultMode' || field === 'unattended' || field === 'standalone') return field
    throw new TypeError('unsupported Scholar settings field')
  }

  private revision(): number {
    if (this.snapshot.status !== 'ready' || this.snapshot.revision === undefined || !this.snapshot.writable) {
      throw new Error('Scholar settings are not writable')
    }
    return this.snapshot.revision
  }

  private enqueue(mutation: ScholarSettingsMutation): Promise<void> {
    const operation = this.writeTail.then(async () => {
      if (this.disposed) throw new Error('Scholar settings scope is disposed')
      // Rebind the queued mutation to the revision produced by its predecessor.
      const current = { ...mutation, expectedRevision: this.revision() }
      const response = await this.rpc.call(SCHOLAR_RPC_CHANNEL, 'settings-mutate', current)
      const decoded = decodeRpcSnapshot(response)
      if (decoded === undefined || decoded === null) {
        await this.refresh()
        throw new Error('Scholar settings update failed')
      }
      this.publish({
        status: 'ready', value: decoded.value, base: decoded.base, user: decoded.user,
        revision: decoded.revision, writable: decoded.writable, mode: 'host',
      })
    })
    this.writeTail = operation.catch(() => {})
    return operation
  }

  private publish(next: SettingsScopeSnapshot<ResearchSettings>): void {
    if (this.disposed) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
