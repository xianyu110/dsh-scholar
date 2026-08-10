/**
 * ui-simple (docs/acceptance-tests.md §8 ui-start / ui-routes / ui-settings,
 * hardening-v0.2-status.md §3 UI-SIMPLE-01): the logic layer of the
 * simplified shell —
 *
 *   startActions():    Start 三卡 (新建研究 / 打开已有项目 / 上传·接入) with
 *                      stable codes/routes, labels re-evaluated per locale;
 *   tabGroups():       four primary tabs + More with FULL coverage (every
 *                      panel tab in exactly one group), stable deep links;
 *   navOrder():        flat reachable order incl. the Settings modal;
 *   parseDeepLink():   `#tab=<key>` / `#settings` deep links (More 深链可达)
 *                      survive reload and existing query routing;
 *   settingsSections():Settings progressive disclosure — nine stable
 *                      Accordion groups, all default-collapsed, every
 *                      title/summary/row key present in BOTH zh and en
 *                      dictionaries, no missing-key report at runtime.
 *
 * Pure logic-layer suite (no DOM), mirroring i18n-chrome/i18n-runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zh as shellZh, en as shellEn } from '../../packages/dsh-research-ui/src/client/i18n/locales/shell'
import { zh as commonZh, en as commonEn } from '../../packages/dsh-research-ui/src/client/i18n/locales/common'
import {
  getLocale, localeParityReport, resetMissingKeyWarnings, setLocale, setMissingKeyReporter,
} from '../../packages/dsh-research-ui/src/client/i18n/index'
import {
  ALL_TAB_KEYS, MORE_TAB_KEYS, PRIMARY_TAB_KEYS, START_ACTION_CODES,
  isTabKey, navOrder, navShortcutIndex, parseDeepLink, startActions, tabGroups,
} from '../../packages/dsh-research-ui/src/client/nav'
import { SETTINGS_SECTION_IDS, settingsKey, settingsSections } from '../../packages/dsh-research-ui/src/client/settings-model'

interface Missing { namespace: string; key: string; locale: string }

let missing: Missing[] = []

beforeEach(() => {
  missing = []
  setMissingKeyReporter(r => { missing.push(r) })
})

afterEach(() => {
  setMissingKeyReporter(null)
  resetMissingKeyWarnings()
})

describe('UI-SIMPLE-01 Start 三卡 (acceptance §8 ui-start)', () => {
  it('startActions(): exactly three cards with stable codes and routes', () => {
    const actions = startActions()
    expect(actions.map(a => a.code)).toEqual([...START_ACTION_CODES])
    expect(actions.map(a => a.route)).toEqual(['new-project', 'open-project', 'import'])
    // codes are unique and all carry non-empty copy
    expect(new Set(actions.map(a => a.code)).size).toBe(actions.length)
    for (const action of actions) {
      expect(action.label).not.toBe('')
      expect(action.description).not.toBe('')
      expect(action.route).not.toBe('')
    }
    // the three primary actions are the only Start actions
    expect(actions).toHaveLength(3)
  })

  it('startActions(): labels/descriptions re-evaluate with the locale (zh ↔ en)', () => {
    setLocale('zh')
    const zh = startActions()
    setLocale('en')
    const en = startActions()
    expect(en.map(a => a.code)).toEqual(zh.map(a => a.code))
    expect(en.map(a => a.route)).toEqual(zh.map(a => a.route))
    for (let i = 0; i < zh.length; i += 1) {
      expect(zh[i]!.label).not.toBe(en[i]!.label)
      expect(zh[i]!.description).not.toBe(en[i]!.description)
    }
  })
})

describe('UI-SIMPLE-01 four primary tabs + More (acceptance §8 ui-routes)', () => {
  it('tabGroups(): exactly four primary tabs in stable order', () => {
    const groups = tabGroups()
    expect(groups.primary.map(t => t.key)).toEqual(['phase', 'runs', 'evidence', 'manuscript'])
    expect(groups.primary).toHaveLength(4)
    for (const tab of groups.primary) {
      expect(tab.label).not.toBe('')
      expect(tab.description).not.toBe('')
      expect(tab.deepLink).toBe(`#tab=${tab.key}`)
    }
  })

  it('tabGroups(): FULL coverage — every panel tab belongs to primary or More', () => {
    const groups = tabGroups()
    const tabEntries = [
      ...groups.primary.map(t => t.key),
      ...groups.more.filter(e => e.kind !== 'modal').map(e => e.key),
    ]
    // no duplicates, exactly the canonical key set
    expect(tabEntries).toHaveLength(ALL_TAB_KEYS.length)
    expect(new Set(tabEntries)).toEqual(new Set(ALL_TAB_KEYS))
    // More carries the expected tabs in stable order
    expect(groups.more.filter(e => e.kind !== 'modal').map(e => e.key)).toEqual([...MORE_TAB_KEYS])
    // More also carries the Settings modal entry with a stable deep link
    const settings = groups.more.find(e => e.kind === 'modal')
    expect(settings).toBeDefined()
    expect(settings?.key).toBe('settings')
    expect(settings?.deepLink).toBe('#settings')
  })

  it('tabGroups(): deep-link ids are stable, unique and non-empty', () => {
    const groups = tabGroups()
    const links = [...groups.primary, ...groups.more].map(e => e.deepLink)
    expect(links.length).toBeGreaterThan(0)
    expect(new Set(links).size).toBe(links.length)
    for (const link of links) expect(link.startsWith('#')).toBe(true)
  })

  it('tabGroups(): labels/descriptions re-evaluate with the locale (zh ↔ en)', () => {
    setLocale('zh')
    const zh = tabGroups()
    setLocale('en')
    const en = tabGroups()
    expect(en.primary.map(t => t.key)).toEqual(zh.primary.map(t => t.key))
    expect(en.more.map(m => m.key)).toEqual(zh.more.map(m => m.key))
    for (const z of zh.primary) {
      const e = en.primary.find(t => t.key === z.key)
      expect(e).toBeDefined()
      expect(e!.label).not.toBe(z.label)
      expect(e!.description).not.toBe(z.description)
    }
    // More entries stay reachable in both locales (settings entry included)
    expect(en.more.find(m => m.kind === 'modal')?.key).toBe('settings')
  })

  it('navOrder()/navShortcutIndex(): every reachable target has a stable index', () => {
    const order = navOrder()
    expect(order).toEqual([...PRIMARY_TAB_KEYS, ...MORE_TAB_KEYS, 'settings'])
    expect(new Set(order).size).toBe(order.length)
    for (let i = 0; i < order.length; i += 1) {
      expect(navShortcutIndex(order[i]!)).toBe(i + 1)
    }
    expect(navShortcutIndex('bogus')).toBe(0)
    // every panel tab is reachable through the flat order (深链/键盘可达)
    for (const key of ALL_TAB_KEYS) expect(order).toContain(key)
  })

  it('parseDeepLink(): #tab=<key> / #settings deep links resolve; unknown is null', () => {
    for (const key of ALL_TAB_KEYS) {
      expect(parseDeepLink(`#tab=${key}`)).toEqual({ kind: 'tab', target: key })
    }
    expect(parseDeepLink('#settings')).toEqual({ kind: 'modal', target: 'settings' })
    // existing query routing survives (query strings are stripped)
    expect(parseDeepLink('#tab=manuscript?x=1')).toEqual({ kind: 'tab', target: 'manuscript' })
    // unknown / empty hashes are a no-op
    expect(parseDeepLink('#tab=bogus')).toBeNull()
    expect(parseDeepLink('#unknown')).toBeNull()
    expect(parseDeepLink('')).toBeNull()
    expect(parseDeepLink('#')).toBeNull()
    expect(isTabKey('runs')).toBe(true)
    expect(isTabKey('settings')).toBe(false)
    expect(isTabKey('bogus')).toBe(false)
  })
})

describe('UI-SIMPLE-01 Settings progressive disclosure (acceptance §8 ui-settings)', () => {
  it('settingsSections(): nine stable Accordion groups, ALL default-collapsed', () => {
    const sections = settingsSections()
    expect(sections.map(s => s.id)).toEqual([...SETTINGS_SECTION_IDS])
    expect(sections).toHaveLength(9)
    const ids = new Set(sections.map(s => s.id))
    for (const required of ['connection', 'appearance', 'preferences', 'runner', 'workspace', 'terminal', 'tex', 'agent', 'config']) {
      expect(ids.has(required)).toBe(true)
    }
    for (const section of sections) {
      // Accordion 默认折叠 — every section starts collapsed
      expect(section.defaultCollapsed).toBe(true)
      expect(section.rows.length).toBeGreaterThan(0)
      // row ids are unique within a section
      expect(new Set(section.rows.map(r => r.id)).size).toBe(section.rows.length)
    }
  })

  it('settingsSections(): every title/summary/row key exists in BOTH zh and en dictionaries', () => {
    const miss: string[] = []
    const dicts = { zh: { shell: shellZh, common: commonZh }, en: { shell: shellEn, common: commonEn } }
    const check = (key: string): void => {
      const ns = key.slice(0, key.indexOf('.'))
      for (const locale of ['zh', 'en'] as const) {
        const dict = dicts[locale][ns as keyof typeof dicts.zh]
        if (dict === undefined || !(key in dict)) miss.push(`${locale} missing ${key}`)
      }
    }
    for (const section of settingsSections()) {
      check(section.titleKey)
      check(section.summaryKey)
      for (const row of section.rows) {
        check(row.labelKey)
        if (row.valueKey !== undefined) check(row.valueKey)
        if (row.actionKey !== undefined) check(row.actionKey)
      }
    }
    expect(miss).toEqual([])
    // static zh/en parity still holds (localeParityReport gate kept)
    expect(localeParityReport()).toEqual([])
  })

  it('settingsSections(): evaluated titles re-evaluate with the locale (zh ↔ en)', () => {
    setLocale('zh')
    const zh = settingsSections().map(s => settingsKey(s.titleKey))
    setLocale('en')
    const en = settingsSections().map(s => settingsKey(s.titleKey))
    expect(en).not.toEqual(zh)
    for (const title of en) expect(title).not.toBe('')
  })

  it('evaluating every UI-SIMPLE-01 model in BOTH locales reports zero missing keys', () => {
    setLocale('zh')
    startActions(); tabGroups(); settingsSections()
    setLocale('en')
    startActions(); tabGroups(); settingsSections()
    expect(missing).toEqual([])
    // sanity: the adapter is actually evaluating the active locale
    expect(getLocale()).toBe('en')
  })
})
