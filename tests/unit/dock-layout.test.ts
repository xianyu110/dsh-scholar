import { describe, expect, it } from 'vitest'
import { ALL_TAB_KEYS } from '../../packages/dsh-research-ui/src/client/nav'
import {
  DEFAULT_DOCK_LAYOUT,
  createDockStore,
  effectiveDockPosition,
  mainTabAfterDock,
  normalizeDockLayout,
  updateDockLayout,
} from '../../packages/dsh-research-ui/src/client/dock-layout'

describe('UI-DOCK-01 panel sidebar layout', () => {
  it('opens every current page in one dock and moves it between right and bottom', () => {
    for (const panel of ALL_TAB_KEYS) {
      const opened = updateDockLayout(DEFAULT_DOCK_LAYOUT, { type: 'open', panel })
      expect(opened.openPanel).toBe(panel)
      expect(opened.position).toBe('right')
      expect(updateDockLayout(opened, { type: 'move', position: 'bottom' })).toMatchObject({
        openPanel: panel,
        position: 'bottom',
      })
      expect(updateDockLayout(opened, { type: 'close' }).openPanel).toBeNull()
    }
  })

  it('moves a docked full page out of the main slot to prevent duplicate live instances', () => {
    expect(mainTabAfterDock('terminal', 'terminal')).toBe('phase')
    expect(mainTabAfterDock('phase', 'phase')).toBe('runs')
    expect(mainTabAfterDock('chat', 'terminal')).toBe('chat')
  })

  it('keeps right and bottom sizes independently and clamps unsafe geometry', () => {
    const right = updateDockLayout(DEFAULT_DOCK_LAYOUT, { type: 'resize', position: 'right', size: 9999 })
    expect(right.rightSize).toBe(720)
    const bottom = updateDockLayout(right, { type: 'resize', position: 'bottom', size: 10 })
    expect(bottom.bottomSize).toBe(180)
    expect(bottom.rightSize).toBe(720)
  })

  it('projects a right dock to bottom on narrow screens without overwriting the preference', () => {
    const right = updateDockLayout(DEFAULT_DOCK_LAYOUT, { type: 'open', panel: 'terminal' })
    expect(effectiveDockPosition(right, 1024)).toBe('right')
    expect(effectiveDockPosition(right, 719)).toBe('bottom')
    expect(right.position).toBe('right')
  })

  it('normalizes corrupt or stale snapshots fail closed', () => {
    expect(normalizeDockLayout(null)).toEqual(DEFAULT_DOCK_LAYOUT)
    expect(normalizeDockLayout({ version: 1, openPanel: 'unknown', position: 'left' })).toEqual(DEFAULT_DOCK_LAYOUT)
    expect(normalizeDockLayout({
      version: 1,
      openPanel: 'chat',
      position: 'bottom',
      rightSize: 400,
      bottomSize: 320,
    })).toEqual({ version: 1, openPanel: 'chat', position: 'bottom', rightSize: 400, bottomSize: 320 })
  })

  it('round-trips through the store and treats storage failures as an empty layout', () => {
    const values = new Map<string, string>()
    const memory = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    const store = createDockStore(memory)
    const layout = updateDockLayout(DEFAULT_DOCK_LAYOUT, { type: 'open', panel: 'workspace' })
    expect(store.save(layout)).toBe(true)
    expect(store.load()).toEqual(layout)

    const broken = createDockStore({
      getItem: () => { throw new Error('private mode') },
      setItem: () => { throw new Error('quota') },
    })
    expect(broken.load()).toEqual(DEFAULT_DOCK_LAYOUT)
    expect(broken.save(layout)).toBe(false)
  })
})
