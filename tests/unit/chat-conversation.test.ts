import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeChatTurn } from '../../packages/dsh-research-ui/src/client/chat'
import { state } from '../../packages/dsh-research-ui/src/client/state'

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  state.chatMessages = []
})

describe('project-scoped free conversation', () => {
  it('uses the Host model with a bounded project projection and keeps slash suggestions editable', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = String(input)
      if (path.endsWith('/grill')) {
        return json({
          project_revision: 2,
          intake_revision: 2,
          question: null,
          brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
          ready_to_confirm: false,
        })
      }
      return json({
        project: { project_id: 'prj_1', name: 'Demo', status: 'SCOPED', brief_status: 'confirmed' },
        next_actions_v2: [{
          code: 'survey_run', label: 'Run survey', reason: 'Corpus required',
          state: 'blocked', required: ['scope_gate'], required_by: 'agent', route: 'chat',
        }],
      })
    })
    vi.stubGlobal('fetch', fetch)
    state.chatMessages = [{ role: 'user', text: '调研 temporal localization', time: 'now' }]
    const host = vi.fn().mockResolvedValue({
      assistantText: '我可以先帮你收窄检索问题。',
      suggestedCommand: '/research should-be-rejected',
    })

    const result = await executeChatTurn('调研 temporal localization', 'prj_1', host)

    expect(result.text).toContain('我可以先帮你收窄检索问题。')
    expect(result.text).toContain('survey_run')
    expect(result.suggestedCommand).toBe('/survey temporal localization')
    expect(host).toHaveBeenCalledWith(expect.objectContaining({
      text: '调研 temporal localization',
      project: expect.objectContaining({ project_id: 'prj_1', status: 'SCOPED', brief_status: 'confirmed' }),
      history: [{ role: 'user', text: '调研 temporal localization' }],
    }))
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('falls back to deterministic phase guidance when the Host model is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => String(input).endsWith('/grill')
      ? json({
        project_revision: 2, intake_revision: 2, question: null,
        brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
        ready_to_confirm: false,
      })
      : json({
        project: { project_id: 'prj_1', status: 'SCOPED', brief_status: 'confirmed' },
        next_actions_v2: [{
          code: 'survey_run', label: 'Run survey', reason: 'Corpus required',
          state: 'blocked', required: ['scope_gate'], required_by: 'agent', route: 'chat',
        }],
      })))
    const host = vi.fn().mockRejectedValue(new Error('provider detail must not leak'))

    const result = await executeChatTurn('我想讨论主指标的选择', 'prj_1', host)

    expect(result.text).toMatch(/自由对话|free-form conversation/i)
    expect(result.text).toContain('survey_run')
    expect(result.text).not.toContain('provider detail')
    expect(result.suggestedCommand).toBeUndefined()
  })

  it('freezes the originating session history before asynchronous project reads', async () => {
    let releaseGrill!: (response: Response) => void
    const grill = new Promise<Response>(resolve => { releaseGrill = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/grill')) return grill
      return json({
        project: { project_id: 'prj_a', status: 'SCOPED', brief_status: 'confirmed' },
        next_actions_v2: [],
      })
    }))
    state.chatMessages = [{ role: 'user', text: 'project A history', time: 'now' }]
    const host = vi.fn().mockResolvedValue({ assistantText: 'answer for A' })

    const pending = executeChatTurn('question for A', 'prj_a', host)
    state.chatMessages = [{ role: 'user', text: 'project B private history', time: 'later' }]
    releaseGrill(json({
      project_revision: 2, intake_revision: 2, question: null,
      brief_preview: { problem: '', scope: '', primary_metrics: [], target_outputs: [] },
      ready_to_confirm: false,
    }))
    await pending

    expect(host).toHaveBeenCalledWith(expect.objectContaining({
      project: expect.objectContaining({ project_id: 'prj_a' }),
      history: [{ role: 'user', text: 'project A history' }],
    }))
    expect(JSON.stringify(host.mock.calls)).not.toContain('project B private history')
  })

  it('appends guidance for the explicit command target rather than the active project', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = String(input)
      if (path.includes('/v1/projects/prj_b/projection')) {
        return json({ project: { project_id: 'prj_b', name: 'B', status: 'SURVEYING', revision: 3 }, next_actions: [] })
      }
      if (path.includes('/v2/projects/prj_b/projection')) {
        return json({
          project: { project_id: 'prj_b', name: 'B', status: 'SURVEYING' },
          next_actions_v2: [{
            code: 'idea_generate', label: 'Generate ideas', reason: 'Corpus ready',
            state: 'ready', required: true, required_by: 'agent', route: 'ideas',
          }],
        })
      }
      throw new Error(`unexpected project request: ${path}`)
    }))

    const result = await executeChatTurn('/status prj_b', 'prj_a')

    expect(result.text).toContain('**B**')
    expect(result.text).toContain('idea_generate')
    expect(result.text).not.toContain('prj_a')
  })
})
