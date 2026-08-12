import { describe, expect, it, vi } from 'vitest'
import { runsEmptyStateModel, runsFilterDefinitions } from '../../packages/dsh-research-ui/src/client/runs-model'
import {
  RenderCoordinator,
  focusCandidateScore,
  shouldDeferBackgroundRefresh,
} from '../../packages/dsh-research-ui/src/client/focus-preservation'
import { setLocale } from '../../packages/dsh-research-ui/src/client/i18n/index'

describe('survey-complete Runs guidance', () => {
  it('distinguishes survey completion, generic emptiness and filter misses', () => {
    expect(runsEmptyStateModel('SURVEYING', 1, true, 0, 0)).toEqual({
      kind: 'survey-ready',
      showOverviewCta: true,
    })
    expect(runsEmptyStateModel('SCOPED', 1, true, 0, 0)).toEqual({
      kind: 'empty',
      showOverviewCta: false,
    })
    expect(runsEmptyStateModel('SURVEYING', 1, true, 3, 0)).toEqual({
      kind: 'no-match',
      showOverviewCta: false,
    })
    expect(runsEmptyStateModel('SURVEYING', 1, true, 3, 2)).toBeNull()
    expect(runsEmptyStateModel('SURVEYING', 0, true, 0, 0).kind).toBe('empty')
    expect(runsEmptyStateModel('SURVEYING', 1, false, 0, 0).kind).toBe('empty')
  })

  it('re-evaluates filter labels after locale changes', () => {
    setLocale('zh')
    expect(runsFilterDefinitions()[0]).toEqual(['all', '全部'])
    expect(runsFilterDefinitions().find(([key]) => key === 'retryable')).toEqual(['retryable', '可重试'])
    setLocale('en')
    expect(runsFilterDefinitions()[0]).toEqual(['all', 'All'])
    expect(runsFilterDefinitions().find(([key]) => key === 'retryable')).toEqual(['retryable', 'Retryable'])
  })
})

describe('focus-safe refresh coordination', () => {
  it('defers and coalesces background refreshes while an editor is focused', async () => {
    let focused = true
    const render = vi.fn(async () => {})
    const coordinator = new RenderCoordinator(render, () => focused)

    await Promise.all([
      coordinator.request('background'),
      coordinator.request('background'),
      coordinator.request('background'),
    ])
    expect(render).not.toHaveBeenCalled()
    expect(coordinator.hasDeferredBackgroundRefresh()).toBe(true)

    focused = false
    await coordinator.releaseDeferredBackgroundRefresh()
    expect(render).toHaveBeenCalledTimes(1)
    expect(coordinator.hasDeferredBackgroundRefresh()).toBe(false)
  })

  it('serializes overlapping renders and keeps only one trailing repaint', async () => {
    let releaseFirst: (() => void) | undefined
    const first = new Promise<void>(resolve => { releaseFirst = resolve })
    let calls = 0
    const coordinator = new RenderCoordinator(async () => {
      calls += 1
      if (calls === 1) await first
    }, () => false)

    const a = coordinator.request('interactive')
    const b = coordinator.request('interactive')
    const c = coordinator.request('interactive')
    expect(calls).toBe(1)
    releaseFirst?.()
    await Promise.all([a, b, c])
    expect(calls).toBe(2)
  })

  it('recognizes editable controls and scores the stable focus identity first', () => {
    expect(shouldDeferBackgroundRefresh('textarea', false)).toBe(true)
    expect(shouldDeferBackgroundRefresh('input', false)).toBe(true)
    expect(shouldDeferBackgroundRefresh('div', true)).toBe(true)
    expect(shouldDeferBackgroundRefresh('button', false)).toBe(false)

    const snapshot = {
      tagName: 'TEXTAREA', id: '', name: '', type: '', classes: ['chat-input'],
      data: { chatComposer: 'true' }, ariaLabel: 'Message', placeholder: '', path: [1, 2],
    }
    expect(focusCandidateScore(snapshot, {
      tagName: 'TEXTAREA', id: '', name: '', type: '', classes: ['chat-input'],
      data: { chatComposer: 'true' }, ariaLabel: 'Message', placeholder: '', path: [9],
    })).toBeGreaterThan(focusCandidateScore(snapshot, {
      tagName: 'TEXTAREA', id: '', name: '', type: '', classes: ['other'],
      data: {}, ariaLabel: 'Other', placeholder: '', path: [1, 2],
    }))
  })
})
