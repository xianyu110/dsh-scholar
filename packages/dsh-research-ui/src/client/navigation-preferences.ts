/**
 * Browser-local visibility preferences for optional diagnostic pages.
 *
 * These preferences affect navigation only. They never alter Kernel budget
 * accounting, policy enforcement, project configuration, or the config pin.
 */

export interface NavigationVisibility {
  budgetPage: boolean
}

export interface NavigationPreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const NAVIGATION_VISIBILITY_KEY = 'dsh-scholar-ui-navigation-visibility'
export const DEFAULT_NAVIGATION_VISIBILITY: Readonly<NavigationVisibility> = Object.freeze({
  budgetPage: false,
})

function browserStorage(): NavigationPreferenceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Invalid, unavailable, and old preference values fail closed to hidden. */
export function readNavigationVisibility(
  storage: NavigationPreferenceStorage | null = browserStorage(),
): NavigationVisibility {
  if (storage === null) return { ...DEFAULT_NAVIGATION_VISIBILITY }
  try {
    const raw = storage.getItem(NAVIGATION_VISIBILITY_KEY)
    if (raw === null) return { ...DEFAULT_NAVIGATION_VISIBILITY }
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULT_NAVIGATION_VISIBILITY }
    }
    return {
      budgetPage: (parsed as Record<string, unknown>).budgetPage === true,
    }
  } catch {
    return { ...DEFAULT_NAVIGATION_VISIBILITY }
  }
}

export function writeBudgetPageVisible(
  visible: boolean,
  storage: NavigationPreferenceStorage | null = browserStorage(),
): boolean {
  if (storage === null) return false
  try {
    storage.setItem(NAVIGATION_VISIBILITY_KEY, JSON.stringify({ budgetPage: visible === true }))
    return true
  } catch {
    return false
  }
}

export function budgetPageVisible(): boolean {
  return readNavigationVisibility().budgetPage
}
