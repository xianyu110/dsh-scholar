/**
 * UI-SIMPLE-01 navigation model (acceptance-tests.md §8 ui-start / ui-routes
 * / ui-settings, hardening-v0.2-status.md §3 UI-SIMPLE-01): the logic layer
 * of the simplified shell — Start 三卡, four primary tabs + More, stable
 * deep links, and the Settings progressive-disclosure section model (see
 * settings-model.ts).
 *
 * All definitions are PURE FUNCTIONS / PURE DATA with NO DOM: labels and
 * descriptions evaluate `t()` against the CURRENT locale at call time
 * (same pattern as i18n/chrome.ts), and every entry carries a stable
 * `deepLink` id so the More menu stays deep-linkable. Unit tests assert the
 * grouping, coverage (every panel tab belongs to exactly one group), key
 * stability and zh/en parity without a browser.
 */
import { t } from './i18n/index'
import { chromeTabs } from './i18n/chrome'
import type { ProjectRow } from './types'
import { readNavigationVisibility, type NavigationVisibility } from './navigation-preferences'

/** Every panel tab key that exists in the app (panel renderers in index.ts). */
export const ALL_TAB_KEYS = [
  'chat', 'phase', 'gates', 'runs', 'artifacts', 'evidence', 'budget', 'manuscript', 'terminal',
  // TRAJ-01/SUBAGENT-01 (hardening §5): Trajectory / Topology tabs.
  'trajectory', 'topology',
  // WORK-01 (hardening §5): generic VS Code-style Workspace tree/tabs.
  'workspace',
  // PTY-01 (hardening §5): Interactive Terminal (real pty session).
  'pty',
] as const
export type TabKey = (typeof ALL_TAB_KEYS)[number]

export function isTabKey(key: string): key is TabKey {
  return (ALL_TAB_KEYS as readonly string[]).includes(key)
}

/** Canonical tabs filtered through browser-local optional-page visibility. */
export function visibleTabKeys(visibility: NavigationVisibility = readNavigationVisibility()): TabKey[] {
  return ALL_TAB_KEYS.filter(key => key !== 'budget' || visibility.budgetPage)
}

export function isTabVisible(
  key: string,
  visibility: NavigationVisibility = readNavigationVisibility(),
): key is TabKey {
  return isTabKey(key) && (key !== 'budget' || visibility.budgetPage)
}

export interface VisibleNavigationSelection {
  activeTab: TabKey
  dockPanel: TabKey | null
}

/**
 * Reconcile persisted/live surfaces after optional-page visibility changes.
 * A hidden main page returns to Overview; a hidden dock page is closed.
 */
export function reconcileVisibleNavigation(
  activeTab: string,
  dockPanel: TabKey | null,
  visibility: NavigationVisibility = readNavigationVisibility(),
): VisibleNavigationSelection {
  return {
    activeTab: isTabVisible(activeTab, visibility) ? activeTab : 'phase',
    dockPanel: dockPanel !== null && isTabVisible(dockPanel, visibility) ? dockPanel : null,
  }
}

/** Four primary tabs (概览 / 运行 / 证据 / 文稿). */
export const PRIMARY_TAB_KEYS: readonly TabKey[] = ['phase', 'runs', 'evidence', 'manuscript']

/** Tabs collapsed behind the More menu (Gate、预算、产物、终端、对话、轨迹、拓扑、工作区、PTY). */
export const MORE_TAB_KEYS: readonly TabKey[] = ['chat', 'gates', 'artifacts', 'budget', 'terminal', 'trajectory', 'topology', 'workspace', 'pty']

/** More menu modal entry (Settings). */
export const MORE_MODAL_KEYS = ['settings'] as const

/** Deep-link route ids (stable, hash-based; parsed by parseDeepLink). */
export const DEEP_LINK_TAB_PREFIX = '#tab='
export const DEEP_LINK_SETTINGS = '#settings'

export interface NavTabDef {
  key: string
  label: string
  description: string
  deepLink: string
}
export interface NavModalDef {
  key: string
  label: string
  description: string
  deepLink: string
  /** 'modal' marks a non-tab target (opened as a modal, not a panel). */
  kind: 'modal'
}
export type NavEntry = NavTabDef | NavModalDef

export interface TabGroups {
  primary: NavTabDef[]
  more: NavEntry[]
}

/** Flat reachable order (primary tabs → More entries); Alt+1..9 maps across it. */
export function navOrder(visibility: NavigationVisibility = readNavigationVisibility()): string[] {
  return [
    ...PRIMARY_TAB_KEYS,
    ...MORE_TAB_KEYS.filter(key => isTabVisible(key, visibility)),
    ...MORE_MODAL_KEYS,
  ]
}

/** 1-based Alt shortcut index for a navigation key (0 = no shortcut). */
export function navShortcutIndex(key: string, visibility: NavigationVisibility = readNavigationVisibility()): number {
  return navOrder(visibility).indexOf(key) + 1
}

/**
 * UI-SIMPLE-01: tab grouping — which entries are primary tabs and which are
 * collapsed behind the More menu. Pure: labels/descriptions re-evaluate the
 * current locale, keys/deep links are stable. Every ALL_TAB_KEYS entry is in
 * exactly one group; More also carries the Settings modal entry.
 */
export function tabGroups(visibility: NavigationVisibility = readNavigationVisibility()): TabGroups {
  const defs = new Map(chromeTabs(visibility).map(def => [def.key, def]))
  const tabDef = (key: TabKey): NavTabDef => {
    const def = defs.get(key)
    return {
      key,
      label: def?.label ?? key,
      description: def?.description ?? '',
      deepLink: `${DEEP_LINK_TAB_PREFIX}${key}`,
    }
  }
  const more: NavEntry[] = MORE_TAB_KEYS.filter(key => isTabVisible(key, visibility)).map(tabDef)
  more.push({
    key: 'settings',
    kind: 'modal',
    label: t('shell', 'shell.tab.settings'),
    description: t('shell', 'shell.tab.settings.desc'),
    deepLink: DEEP_LINK_SETTINGS,
  })
  return {
    primary: PRIMARY_TAB_KEYS.map(tabDef),
    more,
  }
}

/** Start 三卡 (acceptance §8 ui-start): the empty-first-screen primary
 *  actions. Codes and routes are the stable contract; labels/descriptions
 *  re-evaluate the current locale. */
export const START_ACTION_CODES = ['new-project', 'open-project', 'import'] as const
export type StartActionCode = (typeof START_ACTION_CODES)[number]

export interface StartAction {
  code: StartActionCode
  label: string
  description: string
  /** Stable route target handled by the DOM layer (no UI copy). */
  route: string
}

export function startActions(): StartAction[] {
  return [
    {
      code: 'new-project',
      label: t('shell', 'shell.start.newProject'),
      description: t('shell', 'shell.start.newProject.desc'),
      route: 'new-project',
    },
    {
      code: 'open-project',
      label: t('shell', 'shell.start.openProject'),
      description: t('shell', 'shell.start.openProject.desc'),
      route: 'open-project',
    },
    {
      code: 'import',
      label: t('shell', 'shell.start.import'),
      description: t('shell', 'shell.start.import.desc'),
      route: 'import',
    },
  ]
}

/* ─────────────────────── Start 三入口选择逻辑 (§5 P1) ───────────────────────
 * ONBOARD-01 landing (2026-08-11): the Start screen is shown whenever no
 * project is selected — projects are NEVER auto-selected (`projects[0]`),
 * the user explicitly picks from the list or types an id. Pure functions
 * keep the selection logic unit-testable without a DOM. */

/** Whether the Start screen (three entries) must be shown: true iff no
 *  project is selected yet (undefined or empty). No auto-select fallback
 *  exists. */
export function startScreenVisible(selectedProjectId: string | undefined): boolean {
  return selectedProjectId === undefined || selectedProjectId === ''
}

/** Filter the open-project list by name or id substring ('' = full list). */
export function filterProjects(projects: readonly ProjectRow[], query: string): ProjectRow[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...projects]
  return projects.filter(p =>
    (p.name ?? '').toLowerCase().includes(q) || (p.project_id ?? '').toLowerCase().includes(q),
  )
}

/**
 * Explicit project pick from user input: exact project_id match wins, then a
 * UNIQUE full-name match, otherwise null. Never falls back to projects[0] —
 * a null result means "show the user the choice again".
 */
export function pickProject(projects: readonly ProjectRow[], input: string): string | null {
  const raw = input.trim()
  if (raw === '') return null
  const byId = projects.find(p => p.project_id === raw)
  if (byId !== undefined) return byId.project_id ?? null
  const byName = projects.filter(p => p.name === raw)
  if (byName.length === 1) return byName[0]!.project_id ?? null
  return null
}

/**
 * Parse a location hash into a navigation target (deep-link support, §8
 * ui-routes). Accepts `#tab=<key>` for every known panel tab and `#settings`
 * for the Settings modal; query strings after `?` are ignored so the hash
 * survives existing query routing. Unknown targets return null (no-op).
 */
export function parseDeepLink(
  hash: string,
  visibility: NavigationVisibility = readNavigationVisibility(),
): { kind: 'tab' | 'modal'; target: string } | null {
  const clean = hash.replace(/^#/, '').split('?')[0] ?? ''
  const head = clean.split('/')[0] ?? ''
  if (head === '') return null
  if (head === 'settings') return { kind: 'modal', target: 'settings' }
  const m = /^tab=(.+)$/.exec(head)
  if (m !== null && isTabVisible(m[1]!, visibility)) return { kind: 'tab', target: m[1]! }
  return null
}
