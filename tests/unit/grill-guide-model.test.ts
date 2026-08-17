/**
 * INIT-GRILL-02 conversational Brief prompt model
 * (client/grill-guide-model.ts): the PURE logic behind asking each question
 * as a Chat turn while reusing the normal composer —
 *
 *   grillGuideModel(projection, projectStatus): visible/current/readyToConfirm/
 *     progress/nextActionKey state transitions (collecting+question →
 *     visible; all answered → readyToConfirm; confirmed → invisible);
 *   grillAnswerPayload / grillConfirmPayload:  wire payload builders
 *     (disposition three-state answered/skipped/unknown);
 *   grillErrorKey: stable kernel error codes → i18n keys (intake.error.*
 *     reuse + grill-guide.error.* specifics, unmapped verbatim);
 *   grillQuestionLabelKey: answered-row code → prompt key;
 *   loadGrillGuideState: async projection+status load with an INJECTABLE
 *     fetcher (chat.ts injects its api() bridge; this test injects mocks),
 *     incl. the status-fallback when the project GET fails;
 *   i18n: every grill-guide key resolves in BOTH locales with zero
 *     missing-key reports, and zh/en parity still holds adapter-wide.
 *
 * Pure logic-layer suite (no DOM), mirroring next-action-cards.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { zh as grillGuideZh, en as grillGuideEn } from '../../packages/dsh-research-ui/src/client/i18n/locales/grill-guide'
import {
  getLocale, localeParityReport, resetMissingKeyWarnings, setLocale, setMissingKeyReporter, t,
} from '../../packages/dsh-research-ui/src/client/i18n/index'
import {
  GRILL_GUIDE_NEXT_ANSWER, GRILL_GUIDE_NEXT_CONFIRM, GRILL_GUIDE_NEXT_DONE, GRILL_GUIDE_TITLE_KEY,
  GRILL_TOTAL_QUESTIONS,
  grillAnswerPayload, grillConfirmPayload, grillErrorKey, grillGuideModel, grillQuestionLabelKey,
  isGrillProjection, loadGrillGuideState,
  type GrillProjection,
} from '../../packages/dsh-research-ui/src/client/grill-guide-model'

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

/** Minimal valid projection; per-test overrides win. */
function projection(overrides: Partial<GrillProjection> = {}): GrillProjection {
  return {
    project_id: 'rsp_1',
    project_revision: 3,
    intake_id: 'int_1',
    intake_revision: 2,
    question: { question_code: 'brief.problem', question_revision: 1, prompt_key: 'grill.question.problem', required: true },
    answers: [],
    brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
    ready_to_confirm: false,
    ...overrides,
  }
}

/** Build a projection with the first `answered` questions handled. */
function collectingWith(answered: string[], ready = false): GrillProjection {
  const codes = ['brief.problem', 'brief.scope', 'brief.questions', 'brief.primary_metrics', 'brief.target_outputs', 'brief.constraints', 'brief.material_context']
  const handled = new Set(answered)
  const next = codes.find(c => !handled.has(c))
  const answers = answered.map((code, i) => ({
    question_code: code,
    question_revision: 1,
    value: `answer ${i}`,
    disposition: 'answered',
    answered_by: 'pi@example.com',
    answered_at: '2026-08-12T00:00:00.000Z',
  }))
  return {
    ...projection({
      question: next === undefined ? null : { question_code: next, question_revision: 1, prompt_key: `grill.question.${next.split('.').pop()}`, required: true },
      answers,
      ready_to_confirm: ready,
    }),
  }
}

describe('grillGuideModel: state transitions', () => {
  it('collecting + first question unanswered → visible, current=question 1', () => {
    const m = grillGuideModel(projection(), 'collecting')
    expect(m.visible).toBe(true)
    expect(m.titleKey).toBe(GRILL_GUIDE_TITLE_KEY)
    expect(m.current).toEqual({ questionCode: 'brief.problem', promptKey: 'grill.question.problem', required: true })
    expect(m.readyToConfirm).toBe(false)
    expect(m.answeredCount).toBe(0)
    expect(m.totalCount).toBe(GRILL_TOTAL_QUESTIONS)
    expect(m.nextActionKey).toBe(GRILL_GUIDE_NEXT_ANSWER)
  })

  it('collecting + 3 answered → current advances to question 4, progress 3/7', () => {
    const p = collectingWith(['brief.problem', 'brief.scope', 'brief.questions'])
    const m = grillGuideModel(p, 'collecting')
    expect(m.visible).toBe(true)
    expect(m.current?.questionCode).toBe('brief.primary_metrics')
    expect(m.answeredCount).toBe(3)
    expect(m.progressText).toBe('3 / 7')
    expect(m.nextActionKey).toBe(GRILL_GUIDE_NEXT_ANSWER)
  })

  it('collecting + all 7 handled → visible, current=null, readyToConfirm', () => {
    const codes = ['brief.problem', 'brief.scope', 'brief.questions', 'brief.primary_metrics', 'brief.target_outputs', 'brief.constraints', 'brief.material_context']
    const p = collectingWith(codes, true)
    const m = grillGuideModel(p, 'collecting')
    expect(m.visible).toBe(true)
    expect(m.current).toBeNull()
    expect(m.readyToConfirm).toBe(true)
    expect(m.answeredCount).toBe(7)
    expect(m.progressText).toBe('7 / 7')
    expect(m.nextActionKey).toBe(GRILL_GUIDE_NEXT_CONFIRM)
  })

  it('confirmed project → invisible, guide done', () => {
    const p = collectingWith(['brief.problem', 'brief.scope', 'brief.questions', 'brief.primary_metrics', 'brief.target_outputs', 'brief.constraints', 'brief.material_context'], false)
    const m = grillGuideModel(p, 'confirmed')
    expect(m.visible).toBe(false)
    expect(m.current).toBeNull()
    expect(m.readyToConfirm).toBe(false)
    expect(m.nextActionKey).toBe(GRILL_GUIDE_NEXT_DONE)
  })

  it('collecting + no question + not ready (degenerate) → invisible', () => {
    const m = grillGuideModel(projection({ question: null, ready_to_confirm: false }), 'collecting')
    expect(m.visible).toBe(false)
    expect(m.readyToConfirm).toBe(false)
  })

  it('undefined status degrades to invisible (status fetch failed)', () => {
    const m = grillGuideModel(projection(), undefined)
    expect(m.visible).toBe(false)
  })
})

describe('grillAnswerPayload / grillConfirmPayload', () => {
  it('answered payload carries the trimmed value', () => {
    expect(grillAnswerPayload({ question_code: 'brief.problem', question_revision: 1 }, '  My problem  ', 'answered'))
      .toEqual({ question_code: 'brief.problem', question_revision: 1, value: 'My problem', disposition: 'answered' })
  })

  it('skipped / unknown omit the value field when empty', () => {
    expect(grillAnswerPayload({ question_code: 'brief.scope', question_revision: 1 }, '', 'skipped'))
      .toEqual({ question_code: 'brief.scope', question_revision: 1, disposition: 'skipped' })
    expect(grillAnswerPayload({ question_code: 'brief.scope', question_revision: 1 }, '   ', 'unknown'))
      .toEqual({ question_code: 'brief.scope', question_revision: 1, disposition: 'unknown' })
  })

  it('confirm payload carries expected revisions', () => {
    expect(grillConfirmPayload({ project_revision: 3, intake_revision: 2 }))
      .toEqual({ expected_project_revision: 3, expected_intake_revision: 2 })
  })
})

describe('grillErrorKey: stable code → copy key', () => {
  it('reuses intake.error.* for common envelope codes', () => {
    expect(grillErrorKey('principal_required')).toBe('intake.error.principal_required')
    expect(grillErrorKey('question_required')).toBe('intake.error.question_required')
    expect(grillErrorKey('question_revision_conflict')).toBe('intake.error.question_revision_conflict')
    expect(grillErrorKey('idempotency_conflict')).toBe('intake.error.idempotency_conflict')
    expect(grillErrorKey('intake_state_conflict')).toBe('intake.error.intake_state_conflict')
    expect(grillErrorKey('project_not_found')).toBe('intake.error.project_not_found')
    expect(grillErrorKey('validation_error')).toBe('intake.error.validation_error')
    expect(grillErrorKey('unauthorized')).toBe('intake.error.unauthorized')
    expect(grillErrorKey('network_error')).toBe('intake.error.network_error')
    expect(grillErrorKey('http_error')).toBe('intake.error.http_error')
    expect(grillErrorKey('grill_question_unknown')).toBe('intake.error.unknown_question')
    expect(grillErrorKey('role_forbidden')).toBe('intake.error.acceptance_required')
  })

  it('maps grill-specific codes to grill-guide.error.* keys', () => {
    expect(grillErrorKey('revision_conflict')).toBe('grill-guide.error.revisionConflict')
    expect(grillErrorKey('intake_revision_conflict')).toBe('grill-guide.error.intakeRevisionConflict')
    expect(grillErrorKey('brief_already_confirmed')).toBe('grill-guide.error.briefConfirmed')
    expect(grillErrorKey('scope_gate_exists')).toBe('grill-guide.error.briefConfirmed')
  })

  it('unmapped / missing codes stay verbatim', () => {
    expect(grillErrorKey('some_future_code')).toBe('some_future_code')
    expect(grillErrorKey(undefined)).toBe('')
  })
})

describe('grillQuestionLabelKey', () => {
  it('maps every fixed question code to its prompt key', () => {
    expect(grillQuestionLabelKey('brief.problem')).toBe('grill.question.problem')
    expect(grillQuestionLabelKey('brief.scope')).toBe('grill.question.scope')
    expect(grillQuestionLabelKey('brief.questions')).toBe('grill.question.questions')
    expect(grillQuestionLabelKey('brief.primary_metrics')).toBe('grill.question.primaryMetrics')
    expect(grillQuestionLabelKey('brief.target_outputs')).toBe('grill.question.targetOutputs')
    expect(grillQuestionLabelKey('brief.constraints')).toBe('grill.question.constraints')
    expect(grillQuestionLabelKey('brief.material_context')).toBe('grill.question.materialContext')
  })

  it('unknown codes stay verbatim', () => {
    expect(grillQuestionLabelKey('brief.unknown_thing')).toBe('brief.unknown_thing')
  })
})

describe('loadGrillGuideState (injectable fetcher)', () => {
  it('loads project status + grill projection in parallel', async () => {
    const p = collectingWith(['brief.problem'])
    const calls: string[] = []
    const loaded = await loadGrillGuideState(async (path) => {
      calls.push(path)
      return path.endsWith('/grill') ? p : { project_id: 'rsp_1', brief_status: 'collecting' }
    }, 'rsp_1')
    expect(loaded?.projectStatus).toBe('collecting')
    expect(loaded?.projection).toBe(p)
    expect([...calls].sort()).toEqual(['/v2/projects/rsp_1', '/v2/projects/rsp_1/grill'])
  })

  it('confirmed project status flows through', async () => {
    const loaded = await loadGrillGuideState(async (path) => (
      path.endsWith('/grill') ? projection({ question: null, ready_to_confirm: false }) : { brief_status: 'confirmed' }
    ), 'rsp_1')
    expect(loaded?.projectStatus).toBe('confirmed')
  })

  it('status falls back to the projection when the project GET fails', async () => {
    const p = collectingWith(['brief.problem'])
    const loaded = await loadGrillGuideState(async (path) => (path.endsWith('/grill') ? p : null), 'rsp_1')
    expect(loaded?.projectStatus).toBe('collecting')
  })

  it('returns null on a missing / malformed projection (caller stays silent)', async () => {
    expect(await loadGrillGuideState(async () => null, 'rsp_1')).toBeNull()
    expect(await loadGrillGuideState(async () => ({ not: 'a projection' }), 'rsp_1')).toBeNull()
  })

  it('isGrillProjection validates the wire shape', () => {
    expect(isGrillProjection(projection())).toBe(true)
    expect(isGrillProjection(null)).toBe(false)
    expect(isGrillProjection({ project_id: 'rsp_1' })).toBe(false)
    expect(isGrillProjection({ ...projection(), question: { question_code: 7 } })).toBe(false)
    expect(isGrillProjection({ ...projection(), answers: 'nope' })).toBe(false)
  })
})

describe('grill-guide i18n', () => {
  it('zh/en key sets are exactly equal (localeParityReport adapter-wide)', () => {
    expect(localeParityReport()).toEqual([])
  })

  it('every grill-guide key resolves in BOTH locales with zero missing reports', () => {
    const params: Record<string, string> = { answered: '3', total: '7', count: '3', code: 'x', status: '500' }
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      const dict = locale === 'zh' ? grillGuideZh : grillGuideEn
      for (const key of Object.keys(dict)) {
        expect(t('grill-guide', key, params)).not.toBe(key)
      }
      // every reused intake.error.* target key must also resolve
      for (const key of [
        'intake.error.principal_required', 'intake.error.question_required',
        'intake.error.question_revision_conflict', 'intake.error.idempotency_conflict',
        'intake.error.intake_state_conflict', 'intake.error.project_not_found',
        'intake.error.validation_error', 'intake.error.unauthorized',
        'intake.error.network_error', 'intake.error.http_error',
        'intake.error.unknown_question', 'intake.grill.required', 'grill.ready', 'grill.confirmed',
      ]) {
        expect(t('intake', key, params)).not.toBe(key)
      }
      expect(missing).toEqual([])
    }
  })

  it('current question prompt keys resolve per locale (grill.question.*)', () => {
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      for (const promptKey of [
        'grill.question.problem', 'grill.question.scope', 'grill.question.questions',
        'grill.question.primaryMetrics', 'grill.question.targetOutputs',
        'grill.question.constraints', 'grill.question.materialContext',
      ]) {
        expect(t('intake', promptKey)).not.toBe(promptKey)
      }
      expect(missing).toEqual([])
    }
  })

  it('model title/progress/next-action keys are stable constants', () => {
    expect(GRILL_GUIDE_TITLE_KEY).toBe('grill-guide.title')
    expect(GRILL_GUIDE_NEXT_ANSWER).toBe('grill-guide.next.answer')
    expect(GRILL_GUIDE_NEXT_CONFIRM).toBe('grill-guide.next.confirm')
    expect(GRILL_GUIDE_NEXT_DONE).toBe('grill-guide.next.done')
    expect(getLocale()).toBeTruthy()
  })
})
