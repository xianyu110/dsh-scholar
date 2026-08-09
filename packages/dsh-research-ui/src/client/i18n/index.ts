/**
 * dsh-web local locale adapter (gui-plugin-plan §13.2): bind/getSnapshot/
 * subscribe/setLocale with zh/en dictionaries. Lookup order: active-locale
 * namespace → zh namespace → active-locale common → zh common → the raw key
 * (never an empty string; missing keys log one warning in dev). A second
 * install of the adapter in the same app instance is an assembly error.
 */
import { zh as commonZh, en as commonEn } from './locales/common'
import { zh as standaloneZh, en as standaloneEn } from './locales/standalone'
import { zh as shellZh, en as shellEn } from './locales/shell'
import { zh as terminalZh, en as terminalEn } from './locales/terminal'
import { zh as manuscriptZh, en as manuscriptEn } from './locales/manuscript'
import { zh as overviewZh, en as overviewEn } from './locales/overview'
import { zh as runsZh, en as runsEn } from './locales/runs'
import { zh as artifactsZh, en as artifactsEn } from './locales/artifacts'
import { zh as evidenceZh, en as evidenceEn } from './locales/evidence'
import { zh as budgetZh, en as budgetEn } from './locales/budget'

export type Locale = 'zh' | 'en'

interface NamespaceDicts { [namespace: string]: Record<string, string> }
interface AllDicts { zh: NamespaceDicts; en: NamespaceDicts }

const DICTS: AllDicts = {
  zh: {
    common: commonZh as unknown as Record<string, string>,
    standalone: standaloneZh as unknown as Record<string, string>,
    shell: shellZh as unknown as Record<string, string>,
    terminal: terminalZh as unknown as Record<string, string>,
    manuscript: manuscriptZh as unknown as Record<string, string>,
    overview: overviewZh as unknown as Record<string, string>,
    runs: runsZh as unknown as Record<string, string>,
    artifacts: artifactsZh as unknown as Record<string, string>,
    evidence: evidenceZh as unknown as Record<string, string>,
    budget: budgetZh as unknown as Record<string, string>,
  },
  en: {
    common: commonEn as unknown as Record<string, string>,
    standalone: standaloneEn as unknown as Record<string, string>,
    shell: shellEn as unknown as Record<string, string>,
    terminal: terminalEn as unknown as Record<string, string>,
    manuscript: manuscriptEn as unknown as Record<string, string>,
    overview: overviewEn as unknown as Record<string, string>,
    runs: runsEn as unknown as Record<string, string>,
    artifacts: artifactsEn as unknown as Record<string, string>,
    evidence: evidenceEn as unknown as Record<string, string>,
    budget: budgetEn as unknown as Record<string, string>,
  },
}

export const LOCALE_KEY = 'dsh.locale'

let activeLocale: Locale = resolveLocale()
let localeRevision = 0
const localeListeners = new Set<() => void>()

/**
 * Pure locale-choice logic (§13.2 / acceptance §8): persisted locale wins,
 * then the browser's regional locales (in preference order), then zh.
 * `saved` is the raw persisted value ('' or 'null' when absent), `candidates`
 * the browser locale list. Regional variants map to their base locale
 * (zh-CN → zh, en-US → en). Kept pure so unit tests can assert the
 * precedence without a DOM.
 */
export function pickLocale(saved: string | null, candidates: readonly string[]): Locale {
  if (saved === 'zh' || saved === 'en') return saved
  for (const c of candidates) {
    const base = c.toLowerCase().split('-')[0] ?? ''
    if (base === 'zh' || base === 'zh-hans') return 'zh'
    if (base === 'en') return 'en'
  }
  return 'zh'
}

/** Choice order (§13.2): persisted dsh.locale → navigator.languages →
 * navigator.language → zh; regional variants map to their base locale. */
export function resolveLocale(): Locale {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(LOCALE_KEY)
  } catch { /* private mode */ }
  const candidates: string[] = []
  if (typeof navigator !== 'undefined') {
    if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages)
    if (typeof navigator.language === 'string' && navigator.language !== '') candidates.push(navigator.language)
  }
  return pickLocale(saved, candidates)
}

export function getLocale(): Locale {
  return activeLocale
}

export function getLocaleRevision(): number {
  return localeRevision
}

export function subscribeLocale(fn: () => void): () => void {
  localeListeners.add(fn)
  return () => { localeListeners.delete(fn) }
}

export function setLocale(locale: Locale): void {
  activeLocale = locale
  localeRevision += 1
  try { localStorage.setItem(LOCALE_KEY, locale) } catch { /* private mode */ }
  try { document.documentElement.lang = locale } catch { /* sandboxed */ }
  for (const fn of localeListeners) fn()
}

export function t(namespace: string, key: string, params?: Record<string, string>): string {
  const active = DICTS[activeLocale]?.[namespace] ?? {}
  const zhNs = DICTS.zh?.[namespace] ?? {}
  const activeCommon = DICTS[activeLocale]?.common ?? {}
  const zhCommon = DICTS.zh.common ?? {}
  let text = active[key] ?? zhNs[key] ?? activeCommon[key] ?? zhCommon[key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, value)
    }
  }
  return text
}

/** Static check: zh/en key sets must be exactly equal per namespace.
 * Returns the list of violations (empty when parity holds). */
export function localeParityReport(): string[] {
  const violations: string[] = []
  for (const ns of Object.keys(DICTS.zh)) {
    const zhKeys = Object.keys(DICTS.zh[ns] ?? {}).sort()
    const enKeys = Object.keys(DICTS.en[ns] ?? {}).sort()
    const onlyZh = zhKeys.filter(k => !enKeys.includes(k))
    const onlyEn = enKeys.filter(k => !zhKeys.includes(k))
    if (onlyZh.length === 0 && onlyEn.length === 0) continue
    const detail = [
      ...onlyZh.map(k => `  zh-only: ${k}`),
      ...onlyEn.map(k => `  en-only: ${k}`),
    ].join('\n')
    violations.push(`i18n parity violation in namespace "${ns}":\n${detail}`)
  }
  return violations
}

/** Dev-mode warning + hard failure (acceptance §8: missing keys warn in
 * development and fail the build/CI). */
export function assertLocaleParity(): void {
  const violations = localeParityReport()
  if (violations.length === 0) return
  const msg = violations.join('\n')
  // import.meta.env may be absent in non-Vite builds; treat as production.
  const dev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true
  if (dev) {
    // eslint-disable-next-line no-console
    console.warn('[dsh-scholar i18n] ' + msg)
  }
  throw new Error(msg)
}
