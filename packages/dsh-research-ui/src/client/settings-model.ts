/**
 * UI-SIMPLE-01 Settings progressive disclosure model (acceptance-tests.md
 * §8 ui-settings, hardening-v0.2-status.md §3 UI-SIMPLE-01): the pure-data
 * Accordion section definitions rendered by modals/settings.ts.
 *
 * PURE DATA — no DOM, no side effects: every section carries a stable `id`,
 * i18n key pairs (titleKey/summaryKey, row labelKey/valueKey/actionKey in
 * `ns.key` form) evaluated by the DOM layer against the current locale, and
 * `defaultCollapsed: true` (Accordion 默认折叠). Rows with a `valueKey` are
 * static copy; rows without one are dynamic slots the modal fills with live
 * controls (kernel health, selects, toggles…). `kind: 'placeholder'`
 * sections honestly surface surfaces that are not yet implemented (runner /
 * workspace / terminal / TeX / agent) with their config-provenance source
 * line instead of fake controls.
 *
 * Unit tests assert the group ids, default-collapsed contract, key parity
 * (zh/en dictionaries) and that every row key resolves — without a browser.
 */
import { t } from './i18n/index'

export interface SettingsRowDef {
  /** Stable row id (also the DOM data-row slot key for dynamic rows). */
  id: string
  /** `ns.key` i18n key for the row label. */
  labelKey: string
  /** `ns.key` i18n key for a static value; absent = dynamic slot. */
  valueKey?: string
  /** Interpolation params for valueKey. */
  valueParams?: Record<string, string>
  /** `ns.key` i18n key for an optional trailing action button label. */
  actionKey?: string
}

export interface SettingsSectionDef {
  /** Stable section id (DOM data-section key + expand-memory key). */
  id: string
  /** `ns.key` i18n key for the Accordion header title. */
  titleKey: string
  /** `ns.key` i18n key for the source / effective-status summary line. */
  summaryKey: string
  /** Accordion 默认折叠: every section starts collapsed. */
  defaultCollapsed: boolean
  /** 'content' = live rows (the modal fills dynamic slots); 'placeholder'
   *  = honest placeholder row for a not-yet-implemented surface. */
  kind: 'content' | 'placeholder'
  rows: SettingsRowDef[]
}

/** Stable section ids (order = Accordion order). */
export const SETTINGS_SECTION_IDS = [
  'connection', 'appearance', 'preferences',
  'runner', 'workspace', 'terminal', 'tex', 'agent', 'config',
] as const
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

/** `ns.key` → evaluated string in the current locale (DOM helper contract;
 *  the model itself stays key-only so tests can assert parity). The dict
 *  key format is the full dotted key (`shell.settings.connection`), so the
 *  first segment is the namespace and the whole key is the lookup key. */
export function settingsKey(key: string, params?: Record<string, string>): string {
  const dot = key.indexOf('.')
  return dot < 0 ? key : t(key.slice(0, dot), key, params)
}

/** UI-SIMPLE-01: Settings Accordion section definitions (pure data). */
export function settingsSections(): SettingsSectionDef[] {
  return [
    {
      id: 'connection',
      titleKey: 'shell.settings.connection',
      summaryKey: 'shell.settings.source.kernel',
      defaultCollapsed: true,
      kind: 'content',
      rows: [
        { id: 'connection.kernel', labelKey: 'shell.settings.kernel' },
        { id: 'connection.bridge', labelKey: 'shell.settings.bridge', valueKey: 'shell.settings.bridgeValue' },
        { id: 'connection.auth', labelKey: 'shell.settings.auth' },
        { id: 'connection.endpoint', labelKey: 'shell.settings.endpoint' },
        { id: 'connection.token', labelKey: 'shell.settings.token' },
      ],
    },
    {
      id: 'appearance',
      titleKey: 'shell.settings.appearance',
      summaryKey: 'shell.settings.source.localStorage',
      defaultCollapsed: true,
      kind: 'content',
      rows: [
        { id: 'appearance.theme', labelKey: 'shell.settings.theme' },
        { id: 'appearance.accent', labelKey: 'shell.settings.accent' },
        { id: 'appearance.corners', labelKey: 'shell.settings.corners' },
        { id: 'appearance.texture', labelKey: 'shell.settings.texture' },
        { id: 'appearance.density', labelKey: 'shell.settings.density' },
      ],
    },
    {
      id: 'preferences',
      titleKey: 'shell.settings.preferences',
      summaryKey: 'shell.settings.source.localStorage',
      defaultCollapsed: true,
      kind: 'content',
      rows: [
        { id: 'preferences.language', labelKey: 'shell.settings.language' },
        { id: 'preferences.autoRefresh', labelKey: 'shell.settings.autoRefresh' },
        { id: 'preferences.transcript', labelKey: 'shell.settings.transcript' },
        { id: 'preferences.summary', labelKey: 'shell.settings.summary' },
        { id: 'preferences.shortcuts', labelKey: 'shell.settings.help', actionKey: 'shell.settings.shortcuts' },
        { id: 'preferences.about', labelKey: 'shell.settings.about', actionKey: 'common.action.open' },
        { id: 'preferences.localData', labelKey: 'shell.settings.localData', actionKey: 'common.action.resetPreferences' },
      ],
    },
    {
      id: 'runner',
      titleKey: 'shell.settings.section.runner',
      summaryKey: 'shell.settings.source.project',
      defaultCollapsed: true,
      kind: 'placeholder',
      rows: [
        { id: 'runner.placeholder', labelKey: 'shell.settings.placeholder.label', valueKey: 'shell.settings.placeholder.value' },
      ],
    },
    {
      id: 'workspace',
      titleKey: 'shell.settings.section.workspace',
      summaryKey: 'shell.settings.source.kernel',
      defaultCollapsed: true,
      kind: 'placeholder',
      rows: [
        { id: 'workspace.placeholder', labelKey: 'shell.settings.placeholder.label', valueKey: 'shell.settings.placeholder.value' },
      ],
    },
    {
      id: 'terminal',
      titleKey: 'shell.settings.section.terminal',
      summaryKey: 'shell.settings.source.kernel',
      defaultCollapsed: true,
      kind: 'placeholder',
      rows: [
        { id: 'terminal.placeholder', labelKey: 'shell.settings.placeholder.label', valueKey: 'shell.settings.placeholder.value' },
      ],
    },
    {
      id: 'tex',
      titleKey: 'shell.settings.section.tex',
      summaryKey: 'shell.settings.source.kernel',
      defaultCollapsed: true,
      kind: 'placeholder',
      rows: [
        { id: 'tex.placeholder', labelKey: 'shell.settings.placeholder.label', valueKey: 'shell.settings.placeholder.value' },
      ],
    },
    {
      id: 'agent',
      titleKey: 'shell.settings.section.agent',
      summaryKey: 'shell.settings.source.registry',
      defaultCollapsed: true,
      kind: 'placeholder',
      rows: [
        { id: 'agent.placeholder', labelKey: 'shell.settings.placeholder.label', valueKey: 'shell.settings.placeholder.value' },
      ],
    },
    {
      id: 'config',
      titleKey: 'shell.settings.section.config',
      summaryKey: 'shell.settings.source.registry',
      defaultCollapsed: true,
      kind: 'content',
      rows: [
        { id: 'config.pin', labelKey: 'shell.settings.configPin' },
        { id: 'config.registry', labelKey: 'shell.settings.configRegistry', valueKey: 'shell.settings.configRegistryDoc' },
        { id: 'config.headers', labelKey: 'shell.settings.configHeadersLabel', valueKey: 'shell.settings.configHeaders' },
      ],
    },
  ]
}
