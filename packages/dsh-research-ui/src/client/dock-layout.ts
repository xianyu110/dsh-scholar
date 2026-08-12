/**
 * UI-DOCK-01 presentation-only layout model.
 *
 * This is the public seam for panel docking. It deliberately knows nothing
 * about DOM nodes, panel renderers, project authority or research state. The
 * browser host supplies a storage adapter; tests use an in-memory adapter.
 */
import { isTabKey, type TabKey } from './nav'

export type DockPosition = 'right' | 'bottom'

export interface DockLayout {
  version: 1
  openPanel: TabKey | null
  position: DockPosition
  rightSize: number
  bottomSize: number
}

export type DockLayoutAction =
  | { type: 'open'; panel: TabKey }
  | { type: 'close' }
  | { type: 'move'; position: DockPosition }
  | { type: 'resize'; position: DockPosition; size: number }

export interface DockStorageAdapter {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface DockStateStore {
  load(): DockLayout
  save(layout: DockLayout): boolean
}

export const DOCK_LAYOUT_KEY = 'dsh-scholar-ui-dock-v1'
export const DOCK_NARROW_BREAKPOINT = 720
export const DOCK_RIGHT_MIN = 280
export const DOCK_RIGHT_MAX = 720
export const DOCK_BOTTOM_MIN = 180
export const DOCK_BOTTOM_MAX = 640

export const DEFAULT_DOCK_LAYOUT: DockLayout = Object.freeze({
  version: 1,
  openPanel: null,
  position: 'right',
  rightSize: 420,
  bottomSize: 320,
})

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Parse persisted input at the interface; unknown versions/keys fail closed. */
export function normalizeDockLayout(input: unknown): DockLayout {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ...DEFAULT_DOCK_LAYOUT }
  const row = input as Record<string, unknown>
  if (row.version !== 1) return { ...DEFAULT_DOCK_LAYOUT }
  if (row.position !== 'right' && row.position !== 'bottom') return { ...DEFAULT_DOCK_LAYOUT }
  if (row.openPanel !== null && (typeof row.openPanel !== 'string' || !isTabKey(row.openPanel))) {
    return { ...DEFAULT_DOCK_LAYOUT }
  }
  return {
    version: 1,
    openPanel: row.openPanel as TabKey | null,
    position: row.position,
    rightSize: clamp(
      typeof row.rightSize === 'number' ? row.rightSize : DEFAULT_DOCK_LAYOUT.rightSize,
      DOCK_RIGHT_MIN,
      DOCK_RIGHT_MAX,
    ),
    bottomSize: clamp(
      typeof row.bottomSize === 'number' ? row.bottomSize : DEFAULT_DOCK_LAYOUT.bottomSize,
      DOCK_BOTTOM_MIN,
      DOCK_BOTTOM_MAX,
    ),
  }
}

/** Reducer used by both the shell and tests; never mutates the previous layout. */
export function updateDockLayout(layout: DockLayout, action: DockLayoutAction): DockLayout {
  switch (action.type) {
    case 'open': return { ...layout, openPanel: action.panel }
    case 'close': return { ...layout, openPanel: null }
    case 'move': return { ...layout, position: action.position }
    case 'resize': return action.position === 'right'
      ? { ...layout, rightSize: clamp(action.size, DOCK_RIGHT_MIN, DOCK_RIGHT_MAX) }
      : { ...layout, bottomSize: clamp(action.size, DOCK_BOTTOM_MIN, DOCK_BOTTOM_MAX) }
  }
}

/** Narrow screens visually project a right dock to bottom without changing preference. */
export function effectiveDockPosition(layout: DockLayout, viewportWidth: number): DockPosition {
  return viewportWidth < DOCK_NARROW_BREAKPOINT ? 'bottom' : layout.position
}

/** Keep one live renderer per panel: docking the main page selects a safe main fallback. */
export function mainTabAfterDock(currentMain: TabKey, dockPanel: TabKey): TabKey {
  if (currentMain !== dockPanel) return currentMain
  return dockPanel === 'phase' ? 'runs' : 'phase'
}

export function createDockStore(storage: DockStorageAdapter, key = DOCK_LAYOUT_KEY): DockStateStore {
  return {
    load(): DockLayout {
      try {
        const raw = storage.getItem(key)
        return raw === null ? { ...DEFAULT_DOCK_LAYOUT } : normalizeDockLayout(JSON.parse(raw))
      } catch {
        return { ...DEFAULT_DOCK_LAYOUT }
      }
    },
    save(layout: DockLayout): boolean {
      try {
        storage.setItem(key, JSON.stringify(normalizeDockLayout(layout)))
        return true
      } catch {
        return false
      }
    },
  }
}
