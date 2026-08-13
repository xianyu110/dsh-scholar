import type { StandaloneShortcut } from './standalone.js'

/** Dedicated connection channel owned by the Scholar Host/browser pair. */
export const SCHOLAR_RPC_CHANNEL = '/dsh-scholar'
export const SCHOLAR_SETTINGS_NAMESPACE = 'research-plugin'

/** Browser-editable subset of the full Host config. Kernel secrets never enter this type. */
export interface ResearchSettings {
  defaultMode?: 'gate-only' | 'full-auto'
  unattended?: boolean
  standalone?: {
    url?: string
    shortcut?: StandaloneShortcut
  }
}

export type ResearchSettingsField = keyof ResearchSettings

export interface ScholarSettingsWireSnapshot {
  value: ResearchSettings
  base?: ResearchSettings
  user?: ResearchSettings
  revision: number
  writable: boolean
  applies: 'restart'
}

export type ScholarSettingsReadValue =
  | { available: false }
  | { available: true; snapshot: ScholarSettingsWireSnapshot }

export type ScholarSettingsMutation =
  | { op: 'set'; field: ResearchSettingsField; value: unknown; expectedRevision: number }
  | { op: 'unset'; field: ResearchSettingsField; expectedRevision: number }
