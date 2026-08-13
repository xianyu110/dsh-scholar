import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_STANDALONE_SHORTCUT,
  normalizeStandaloneUrl,
} from '../shared/standalone.js'
import {
  SCHOLAR_SETTINGS_NAMESPACE,
  type ResearchSettings,
  type ResearchSettingsField,
  type ScholarSettingsMutation,
  type ScholarSettingsReadValue,
  type ScholarSettingsWireSnapshot,
} from '../shared/settings-rpc.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Copy only browser-owned fields; Host kernel/model/cache data and secrets are excluded by construction. */
function projectSettings(value: unknown): ResearchSettings {
  if (!isRecord(value)) return {}
  const result: ResearchSettings = {}
  if (value.defaultMode === 'gate-only' || value.defaultMode === 'full-auto') result.defaultMode = value.defaultMode
  if (typeof value.unattended === 'boolean') result.unattended = value.unattended
  if (isRecord(value.standalone)) {
    const standalone: NonNullable<ResearchSettings['standalone']> = {}
    if (typeof value.standalone.url === 'string') standalone.url = normalizeStandaloneUrl(value.standalone.url)
    if (value.standalone.shortcut === DEFAULT_STANDALONE_SHORTCUT || value.standalone.shortcut === 'disabled') {
      standalone.shortcut = value.standalone.shortcut
    }
    result.standalone = standalone
  }
  return result
}

function snapshot(settings: SettingsProvider): ScholarSettingsReadValue {
  const descriptor = settings.describe({ redactSecrets: true })
    .find(entry => String(entry.ns) === SCHOLAR_SETTINGS_NAMESPACE)
  if (descriptor === undefined) return { available: false }
  const wire: ScholarSettingsWireSnapshot = {
    value: projectSettings(descriptor.value),
    ...(descriptor.base === undefined ? {} : { base: projectSettings(descriptor.base) }),
    ...(descriptor.user === undefined ? {} : { user: projectSettings(descriptor.user) }),
    revision: descriptor.revision,
    writable: settings.writable,
    applies: 'restart',
  }
  return { available: true, snapshot: wire }
}

function field(value: unknown): ResearchSettingsField | undefined {
  return value === 'defaultMode' || value === 'unattended' || value === 'standalone' ? value : undefined
}

function mutation(payload: unknown): ScholarSettingsMutation | undefined {
  if (!isRecord(payload) || (payload.op !== 'set' && payload.op !== 'unset')) return undefined
  const selected = field(payload.field)
  if (selected === undefined || !Number.isSafeInteger(payload.expectedRevision) || (payload.expectedRevision as number) < 0) return undefined
  if (payload.op === 'unset') return { op: 'unset', field: selected, expectedRevision: payload.expectedRevision as number }
  if (selected === 'defaultMode' && payload.value !== 'gate-only' && payload.value !== 'full-auto') return undefined
  if (selected === 'unattended' && typeof payload.value !== 'boolean') return undefined
  if (selected === 'standalone') {
    if (!isRecord(payload.value) || typeof payload.value.url !== 'string'
      || (payload.value.shortcut !== DEFAULT_STANDALONE_SHORTCUT && payload.value.shortcut !== 'disabled')) return undefined
    try {
      return {
        op: 'set', field: selected,
        value: { url: normalizeStandaloneUrl(payload.value.url), shortcut: payload.value.shortcut },
        expectedRevision: payload.expectedRevision as number,
      }
    } catch { return undefined }
  }
  return { op: 'set', field: selected, value: payload.value, expectedRevision: payload.expectedRevision as number }
}

const internal = (message: string) => ({ ok: false as const, error: { code: 'internal' as const, message, details: {} } })

/** Public DSH Connection extension handler owned entirely by the Scholar plugin. */
export function createScholarRpcHandler(
  settings: SettingsProvider,
  readStandaloneToken: () => string,
): ConnectionRpcHandler {
  return async (endpoint, payload) => {
    if (endpoint === 'standalone-token') {
      try { return { ok: true, value: { token: readStandaloneToken() } } }
      catch { return internal('standalone token is unavailable') }
    }
    if (endpoint === 'settings-snapshot') {
      try { return { ok: true, value: snapshot(settings) } }
      catch { return internal('Scholar settings are unavailable') }
    }
    if (endpoint === 'settings-mutate') {
      const parsed = mutation(payload)
      if (parsed === undefined) return internal('invalid Scholar settings mutation')
      try {
        await settings.mutate(
          settingsNamespace(SCHOLAR_SETTINGS_NAMESPACE),
          parsed.op === 'set'
            ? [{ op: 'set', path: [parsed.field], value: parsed.value }]
            : [{ op: 'unset', path: [parsed.field] }],
          parsed.expectedRevision,
        )
        return { ok: true, value: snapshot(settings) }
      } catch { return internal('Scholar settings update failed') }
    }
    return internal('unsupported Scholar endpoint')
  }
}
