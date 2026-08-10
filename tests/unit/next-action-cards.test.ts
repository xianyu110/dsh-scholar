/**
 * next-action-cards (gui-plugin-plan §5.1, api-contracts.md §21, audit #11):
 * the PURE Overview NextAction v2 card model —
 *
 *   nextActionCardModel(action, locale):  three-state tone (ready/blocked/
 *     done), blocked-with-gaps disablement, missing-precondition list
 *     (known codes translated, unknown codes verbatim), route mapping
 *     (kernel route → panel tab, ideas/contracts/release/overview converge
 *     on the Overview tab), unknown-code safe degradation (read-only, no
 *     CTA, kernel label fallback), blocking note, locale-driven title map;
 *   resolveNextActionInput(p):           v2 structured projection preferred,
 *     legacy `next_actions: string[]` fallback (backward compatible), v2
 *     empty → clean none state, malformed v2 → legacy path;
 *   static tables:                        every NEXT_ACTION_LABEL_KEYS /
 *     NEXT_ACTION_GAP_KEYS value exists in BOTH zh and en dictionaries and
 *     zero missing-key reports when every model is evaluated per locale.
 *
 * Pure logic-layer suite (no DOM), mirroring ui-simple/i18n-runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zh as overviewZh, en as overviewEn } from '../../packages/dsh-research-ui/src/client/i18n/locales/overview'
import {
  getLocale, localeParityReport, resetMissingKeyWarnings, setLocale, setMissingKeyReporter,
} from '../../packages/dsh-research-ui/src/client/i18n/index'
import {
  NEXT_ACTION_GAP_KEYS, NEXT_ACTION_LABEL_KEYS, NEXT_ACTION_UNKNOWN_CODE,
  nextActionCardModel, resolveNextActionInput,
} from '../../packages/dsh-research-ui/src/client/next-action-cards'
import type { NextActionV2 } from '../../packages/dsh-research-ui/src/client/types'

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

/** Minimal valid action; per-test overrides win. */
function action(overrides: Partial<NextActionV2> & { code?: string }): NextActionV2 {
  return { code: 'survey_run', label: 'Run literature survey → corpus snapshot', reason: 'a corpus snapshot is required', state: 'ready', route: 'runs', required: true, blocking: true, ...overrides }
}

describe('nextActionCardModel: three-state tone + disablement', () => {
  it('ready → tone ready, enabled (highlighted CTA)', () => {
    setLocale('en')
    const m = nextActionCardModel(action({ state: 'ready' }))
    expect(m.tone).toBe('ready')
    expect(m.disabled).toBe(false)
    expect(m.stateLabel).toBe('Ready')
  })

  it('blocked with missing preconditions → tone blocked, disabled', () => {
    const m = nextActionCardModel(action({ state: 'blocked', required: ['approved_contract'] }))
    expect(m.tone).toBe('blocked')
    expect(m.disabled).toBe(true)
  })

  it('blocked without a gap list (preconditions met) → tone blocked but enabled', () => {
    const m = nextActionCardModel(action({ state: 'blocked', required: true }))
    expect(m.tone).toBe('blocked')
    expect(m.disabled).toBe(false)
  })

  it('done → tone done, disabled (grayed out), empty missing list', () => {
    const m = nextActionCardModel(action({ state: 'done' }))
    expect(m.tone).toBe('done')
    expect(m.disabled).toBe(true)
    expect(m.missingList).toEqual([])
  })

  it('missing state field degrades to ready', () => {
    const m = nextActionCardModel(action({ state: undefined }))
    expect(m.tone).toBe('ready')
    expect(m.disabled).toBe(false)
  })
})

describe('nextActionCardModel: missing-list mapping', () => {
  it('known gap codes are translated, unknown gap codes stay verbatim', () => {
    setLocale('zh')
    const m = nextActionCardModel(action({ state: 'blocked', required: ['approved_contract', 'some_future_gap'] }))
    expect(m.missingList).toEqual(['缺少已批准的实验合同', 'some_future_gap'])
    setLocale('en')
    const en = nextActionCardModel(action({ state: 'blocked', required: ['approved_contract', 'succeeded_runs'] }))
    expect(en.missingList).toEqual(['No approved experiment contract', 'No succeeded runs'])
  })

  it('required=true yields no missing list', () => {
    const m = nextActionCardModel(action({ required: true }))
    expect(m.missingList).toEqual([])
  })
})

describe('nextActionCardModel: route mapping (kernel route → panel tab)', () => {
  it('panel routes map to the same tab', () => {
    for (const route of ['gates', 'runs', 'evidence', 'manuscript', 'budget']) {
      const m = nextActionCardModel(action({ route }))
      expect(m.route).toBe(route)
      expect(m.hasRoute).toBe(true)
    }
  })

  it('non-panel kernel routes converge on the Overview tab (phase)', () => {
    for (const route of ['ideas', 'contracts', 'release', 'overview']) {
      const m = nextActionCardModel(action({ route }))
      expect(m.route).toBe('phase')
      expect(m.hasRoute).toBe(true)
    }
  })

  it('unknown/future kernel routes fall back to the Overview tab', () => {
    const m = nextActionCardModel(action({ route: 'workspace' }))
    expect(m.route).toBe('phase')
  })

  it('missing route degrades to the Overview tab', () => {
    const m = nextActionCardModel(action({ route: undefined }))
    expect(m.route).toBe('phase')
  })

  it('done actions keep their route but stay disabled', () => {
    const m = nextActionCardModel(action({ state: 'done', route: 'gates' }))
    expect(m.route).toBe('gates')
    expect(m.hasRoute).toBe(true)
    expect(m.disabled).toBe(true)
  })
})

describe('nextActionCardModel: unknown-code safe degradation (api-contracts §21)', () => {
  it('code unknown → read-only: no route CTA, disabled, isUnknown', () => {
    setLocale('zh')
    const m = nextActionCardModel(action({ code: NEXT_ACTION_UNKNOWN_CODE, label: 'Unknown project state — inspect project', state: 'blocked', required: ['state_mapping'], route: 'overview' }))
    expect(m.isUnknown).toBe(true)
    expect(m.hasRoute).toBe(false)
    expect(m.route).toBe('')
    expect(m.disabled).toBe(true)
    expect(m.missingList).toEqual(['未知状态 — 只读'])
  })

  it('missing code degrades to the unknown read-only card (mapped title)', () => {
    setLocale('en')
    const m = nextActionCardModel(action({ code: undefined, label: undefined }))
    expect(m.isUnknown).toBe(true)
    expect(m.disabled).toBe(true)
    expect(m.hasRoute).toBe(false)
    expect(m.title).toBe('Unknown project state — inspect project')
  })

  it('codes absent from the label table render the kernel label verbatim (wire data)', () => {
    setLocale('zh')
    const zh = nextActionCardModel(action({ code: 'gate_decide', label: 'Decide pending scope gate' }))
    expect(zh.title).toBe('Decide pending scope gate')
    setLocale('en')
    const en = nextActionCardModel(action({ code: 'job_retry', label: 'Retry failed job' }))
    expect(en.title).toBe('Retry failed job')
  })
})

describe('nextActionCardModel: i18n label mapping + blocking note', () => {
  it('known codes map through t() per locale; zh ≠ en titles', () => {
    setLocale('zh')
    const zh = nextActionCardModel(action({ code: 'scope_gate_submit' }))
    setLocale('en')
    const en = nextActionCardModel(action({ code: 'scope_gate_submit' }))
    expect(zh.title).toBe('完成范围 Gate')
    expect(en.title).toBe('Complete Scope Gate')
    expect(zh.title).not.toBe(en.title)
  })

  it('blocking=true carries the chrome note; blocking=false carries none', () => {
    setLocale('zh')
    const blocked = nextActionCardModel(action({ blocking: true }))
    expect(blocked.blockingNote).toContain('阻断')
    const free = nextActionCardModel(action({ blocking: false }))
    expect(free.blockingNote).toBe('')
  })

  it('reason text is the kernel wire text, verbatim', () => {
    const m = nextActionCardModel(action({ reason: 'gate g1 is pending' }))
    expect(m.reasonText).toBe('gate g1 is pending')
  })

  it('every NEXT_ACTION_LABEL_KEYS / NEXT_ACTION_GAP_KEYS value exists in BOTH dictionaries', () => {
    const miss: string[] = []
    for (const key of Object.values(NEXT_ACTION_LABEL_KEYS)) {
      if (!(key in overviewZh)) miss.push(`zh missing ${key}`)
      if (!(key in overviewEn)) miss.push(`en missing ${key}`)
    }
    for (const key of Object.values(NEXT_ACTION_GAP_KEYS)) {
      if (!(key in overviewZh)) miss.push(`zh missing ${key}`)
      if (!(key in overviewEn)) miss.push(`en missing ${key}`)
    }
    expect(miss).toEqual([])
    // static zh/en parity still holds (localeParityReport gate kept)
    expect(localeParityReport()).toEqual([])
  })

  it('evaluating every known code in BOTH locales reports zero missing keys', () => {
    const sample: NextActionV2[] = Object.keys(NEXT_ACTION_LABEL_KEYS).map(code => action({ code }))
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      for (const a of sample) nextActionCardModel(a)
    }
    expect(missing).toEqual([])
    expect(getLocale()).toBe('en')
  })
})

describe('resolveNextActionInput: v2 preferred, legacy fallback', () => {
  it('v2 projection wins over legacy strings (both present)', () => {
    const input = resolveNextActionInput({ next_actions: ['old label'], next_actions_v2: [{ code: 'survey_run' }] })
    expect(input).toEqual({ kind: 'v2', actions: [{ code: 'survey_run' }] })
  })

  it('empty v2 array → clean v2 none state (terminal projects)', () => {
    const input = resolveNextActionInput({ next_actions: [], next_actions_v2: [] })
    expect(input).toEqual({ kind: 'v2', actions: [] })
  })

  it('missing v2 → legacy string list (backward compatibility)', () => {
    const input = resolveNextActionInput({ next_actions: ['Complete Scope Gate', 'Resolve Budget Gate'] })
    expect(input).toEqual({ kind: 'legacy', labels: ['Complete Scope Gate', 'Resolve Budget Gate'] })
  })

  it('empty/missing both → legacy empty list', () => {
    expect(resolveNextActionInput({})).toEqual({ kind: 'legacy', labels: [] })
    expect(resolveNextActionInput({ next_actions: [] })).toEqual({ kind: 'legacy', labels: [] })
  })

  it('legacy labels are filtered to non-empty strings', () => {
    const input = resolveNextActionInput({ next_actions: [null, '', 'x', 'y'] as unknown as string[] })
    expect(input).toEqual({ kind: 'legacy', labels: ['x', 'y'] })
  })

  it('malformed v2 (mixed types) degrades to the legacy path', () => {
    const input = resolveNextActionInput({ next_actions: ['a'], next_actions_v2: ['bad', 42] as unknown as NextActionV2[] })
    expect(input).toEqual({ kind: 'legacy', labels: ['a'] })
  })
})
