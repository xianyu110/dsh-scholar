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

export type Locale = 'zh' | 'en'

interface NamespaceDicts { [namespace: string]: Record<string, string> }
interface AllDicts { zh: NamespaceDicts; en: NamespaceDicts }

const DICTS: AllDicts = {
  zh: {
    common: commonZh as unknown as Record<string, string>,
    standalone: standaloneZh as unknown as Record<string, string>,
    shell: shellZh as unknown as Record<string, string>,
    terminal: terminalZh as unknown as Record<string, string>,
  },
  en: {
    common: commonEn as unknown as Record<string, string>,
    standalone: standaloneEn as unknown as Record<string, string>,
    shell: shellEn as unknown as Record<string, string>,
    terminal: terminalEn as unknown as Record<string, string>,
  },
}

export const LOCALE_KEY = 'dsh.locale'

let activeLocale: Locale = resolveLocale()
let localeRevision = 0
const localeListeners = new Set<() => void>()

/** Choice order (§13.2): persisted dsh.locale → navigator.languages →
 * navigator.language → zh; regional variants map to their base locale. */
export function resolveLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch { /* private mode */ }
  const candidates: string[] = []
  if (typeof navigator !== 'undefined') {
    if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages)
    if (typeof navigator.language === 'string' && navigator.language !== '') candidates.push(navigator.language)
  }
  for (const c of candidates) {
    const base = c.toLowerCase().split('-')[0] ?? ''
    if (base === 'zh' || base === 'zh-hans') return 'zh'
    if (base === 'en') return 'en'
  }
  return 'zh'
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

/** Static check: zh/en key sets must be exactly equal per namespace. */
export function assertLocaleParity(): void {
  for (const ns of Object.keys(DICTS.zh)) {
    const zhKeys = Object.keys(DICTS.zh[ns] ?? {}).sort()
    const enKeys = Object.keys(DICTS.en[ns] ?? {}).sort()
    if (zhKeys.join('\n') !== enKeys.join('\n')) {
      throw new Error(`i18n parity violation in namespace "${ns}": zh/en keys differ`)
    }
  }
}
