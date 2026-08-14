import { afterEach, describe, expect, it, vi } from 'vitest'
import { KernelUnavailableError, ResearchClient } from '@dsh-scholar/research-client'
import { RoleRegistry, RESEARCH_TOOLS } from '../../src/plugin/acl.js'
import { classifyNativeIntent, runNativeScholarTurn, suggestedCommand } from '../../src/plugin/native-chat.js'
import { registerResearchTools, type ResearchToolContext } from '../../src/plugin/tools.js'
import { buildScholarSessionProjection, stagesForProject, type ProjectionLike } from '../../src/shared/research-stage.js'

const action = (overrides: Partial<ProjectionLike['next_actions_v2'][number]> = {}): ProjectionLike['next_actions_v2'][number] => ({
  code: 'survey_run', label: 'Run survey', reason: 'corpus required', route: 'chat', state: 'ready',
  blocking: false, required_by: 'agent', required: true, revision: 2, ...overrides,
})

function projection(status = 'SCOPED', next = action()): ProjectionLike {
  return {
    project: { project_id: 'rsp_1', name: 'Test research', status, revision: 2, brief_status: 'confirmed' },
    pending_gates: [], jobs: [], counts: { corpora: 0 }, next_actions_v2: [next],
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('DSH native Scholar conversation façade', () => {
  it('keeps unknown roles default-deny except for the bounded façade', () => {
    const roles = new RoleRegistry()
    expect(RESEARCH_TOOLS).toContain('dsh_scholar')
    expect(roles.get('root-session')).toBe('none')
    expect(roles.allows('none', 'dsh_scholar')).toBe(true)
    expect(roles.allows('none', 'research_project')).toBe(false)
    expect(roles.allows('none', 'research_status')).toBe(false)
    expect(roles.allows('none', 'experiment_submit')).toBe(false)
    expect(roles.allows('director', 'dsh_scholar')).toBe(true)
  })

  it('registers the façade with native-chat guidance for the Harness model', () => {
    const registered: Array<{ name: string; description: string; parameters?: unknown; output?: { schema?: unknown } }> = []
    registerResearchTools({ tools: { register: tool => registered.push(tool as never) } }, {
      client: {} as ResearchClient,
      cache: { get: async () => undefined, set: async () => undefined },
      ctx: {}, roles: { set() {} }, modelFor: () => undefined,
    } as unknown as ResearchToolContext)
    const tool = registered.find(item => item.name === 'dsh_scholar')
    expect(tool?.description).toContain('ordinary language')
    expect(tool?.description).toContain('calling DSH session')
    expect(tool?.description).toContain('never decides Gates')
    expect(tool?.output?.schema).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it('maps authoritative project states into one ten-stage timeline', () => {
    expect(stagesForProject('DRAFT').find(stage => stage.id === 'init')?.state).toBe('current')
    expect(stagesForProject('SCOPED').find(stage => stage.id === 'survey')?.state).toBe('current')
    expect(stagesForProject('EXPERIMENTING').find(stage => stage.id === 'experiment')?.state).toBe('current')
    expect(stagesForProject('RELEASED').every(stage => stage.state === 'done')).toBe(true)
    const blocked = stagesForProject('BLOCKED_GATE', action({ code: 'baseline_reproduce', state: 'blocked' }))
    expect(blocked.find(stage => stage.id === 'reproduce')?.state).toBe('blocked')
    const releaseGate = stagesForProject('BLOCKED_GATE', action({ code: 'gate_resolve', state: 'ready' }), [{ type: 'release' }])
    expect(releaseGate.find(stage => stage.id === 'release')?.state).toBe('blocked')
    expect(blocked).toHaveLength(10)
  })

  it('builds a secret-free session projection and job summary', () => {
    const value = projection('EXPERIMENTING', action({ code: 'evidence_verify', state: 'blocked', blocking: true }))
    value.jobs = [{ status: 'queued' }, { status: 'running' }, { status: 'leased' }, { status: 'failed' }]
    value.pending_gates = [{}]
    const snapshot = buildScholarSessionProjection('session_a', value)
    expect(snapshot).toMatchObject({
      linked: true, session_id: 'session_a', project: { project_id: 'rsp_1' },
      next_action: { code: 'evidence_verify' },
      summary: { pending_gates: 1, jobs: { total: 4, queued: 1, running: 2, failed: 1 } },
    })
    expect(snapshot).not.toHaveProperty('token')
  })

  it('classifies natural intents and produces canonical slash suggestions', () => {
    expect(classifyNativeIntent('现在研究到哪一步了？')).toBe('status')
    expect(classifyNativeIntent('有哪些运行任务？')).toBe('jobs')
    expect(classifyNativeIntent('下一步是什么？', action())).toBe('next')
    expect(classifyNativeIntent('继续', action())).toBe('survey')
    expect(classifyNativeIntent('run a survey', action())).toBe('survey')
    expect(classifyNativeIntent('research', action())).toBe('conversation')
    expect(classifyNativeIntent('tell me about research methods', action())).toBe('conversation')
    expect(classifyNativeIntent('不要调研', action())).toBe('conversation')
    expect(classifyNativeIntent('please do not research', action())).toBe('conversation')
    expect(classifyNativeIntent('生成想法', action({ code: 'idea_generate' }))).toBe('ideas')
    expect(suggestedCommand(action({ code: 'manuscript_write' }))).toBe('/write')
  })

  it('guides an unlinked DSH session without mutating or accepting a project id', async () => {
    const client = { getProjectBySession: vi.fn().mockResolvedValue(null) } as unknown as ResearchClient
    const reply = await runNativeScholarTurn({
      text: '开始一个研究', sessionId: 'session_a', client,
      cache: { get: async () => undefined, set: async () => undefined },
    })
    expect(reply).toMatchObject({ linked: false, execution: { status: 'needs_project', suggested_command: '/new <项目名>' } })
    await expect(runNativeScholarTurn({
      text: '查看状态', sessionId: 'session_a', projectId: 'rsp_other', client,
      cache: { get: async () => undefined, set: async () => undefined },
    })).rejects.toThrow('not linked')
  })

  it('rejects a project id that differs from the calling session link', async () => {
    const client = { getProjectBySession: vi.fn().mockResolvedValue({ project_id: 'rsp_1' }) } as unknown as ResearchClient
    await expect(runNativeScholarTurn({
      text: '查看状态', sessionId: 'session_a', projectId: 'rsp_other', client,
      cache: { get: async () => undefined, set: async () => undefined },
    })).rejects.toThrow('not linked')
  })

  it('rejects unsafe session ids before any Kernel lookup', async () => {
    const client = { getProjectBySession: vi.fn() } as unknown as ResearchClient
    for (const sessionId of ['x/../../projects/rsp_other', 'session?x', 'session #x', 'session%2fother', ' session_a', '会话']) {
      await expect(runNativeScholarTurn({
        text: '查看状态', sessionId, client,
        cache: { get: async () => undefined, set: async () => undefined },
      })).rejects.toThrow('valid DSH session')
    }
    expect(client.getProjectBySession).not.toHaveBeenCalled()
  })

  it('executes only an explicitly requested ready survey and returns the post-action projection', async () => {
    const scoped = projection()
    ;(scoped.project as ProjectionLike['project'] & { brief: { problem: string } }).brief = { problem: 'robust OCR' }
    const surveyed = projection('SURVEYING', action({ code: 'idea_generate' }))
    const snapshotCorpus = vi.fn().mockResolvedValue({ snapshot_id: 'corpus_1' })
    const client = {
      getProjectBySession: vi.fn().mockResolvedValue({ project_id: 'rsp_1' }),
      projectProjection: vi.fn().mockResolvedValueOnce(scoped).mockResolvedValueOnce(scoped).mockResolvedValueOnce(surveyed),
      snapshotCorpus,
    } as unknown as ResearchClient
    const search = vi.fn().mockResolvedValue({
      hits: [], queries: [{ query: 'robust OCR' }], citation_edges: [],
      source_status: [{ source: 'openalex', status: 'complete' }], dedup_removed: 0,
    })
    const reply = await runNativeScholarTurn({
      text: '继续调研', sessionId: 'session_a', client,
      cache: { get: async () => undefined, set: async () => undefined }, search: search as never,
    })
    expect(search).toHaveBeenCalledWith('robust OCR', { limit: 20 }, expect.anything())
    expect(snapshotCorpus).toHaveBeenCalledOnce()
    expect(snapshotCorpus).toHaveBeenCalledWith(expect.objectContaining({ expected_revision: 2, expected_session_id: 'session_a' }))
    expect(reply).toMatchObject({
      project: { status: 'SURVEYING' }, intent: { kind: 'survey' },
      execution: { status: 'executed', operation: 'survey_run', suggested_command: null },
      next_action: { code: 'idea_generate' },
    })
  })

  it('never executes blocked or human-only next actions', async () => {
    for (const next of [
      action({ code: 'pilot_formal_submit', state: 'blocked', blocking: true }),
      action({ code: 'release_gate', required_by: 'human', blocking: true }),
    ]) {
      const client = {
        getProjectBySession: vi.fn().mockResolvedValue({ project_id: 'rsp_1' }),
        projectProjection: vi.fn().mockResolvedValue(projection('BLOCKED_GATE', next)),
        snapshotCorpus: vi.fn(),
      } as unknown as ResearchClient
      const reply = await runNativeScholarTurn({
        text: '下一步', sessionId: 'session_a', client,
        cache: { get: async () => undefined, set: async () => undefined },
      })
      expect(['blocked', 'needs_human']).toContain(reply.execution.status)
      expect((client.snapshotCorpus as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    }
  })

  it('does not write for ambiguous or negative survey wording', async () => {
    for (const text of ['research', 'tell me about research methods', '不要调研', 'please do not research']) {
      const client = {
        getProjectBySession: vi.fn().mockResolvedValue({ project_id: 'rsp_1' }),
        projectProjection: vi.fn().mockResolvedValue(projection()),
        snapshotCorpus: vi.fn(),
      } as unknown as ResearchClient
      const reply = await runNativeScholarTurn({
        text, sessionId: 'session_a', client,
        cache: { get: async () => undefined, set: async () => undefined },
      })
      expect(reply.execution.status).not.toBe('executed')
      expect((client.snapshotCorpus as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    }
  })

  it('returns an editable /ideas suggestion for a natural idea-generation request', async () => {
    const client = {
      getProjectBySession: vi.fn().mockResolvedValue({ project_id: 'rsp_1' }),
      projectProjection: vi.fn().mockResolvedValue(projection('SURVEYING', action({ code: 'idea_generate' }))),
    } as unknown as ResearchClient
    const reply = await runNativeScholarTurn({
      text: '生成想法', sessionId: 'session_a', client,
      cache: { get: async () => undefined, set: async () => undefined },
    })
    expect(reply).toMatchObject({ intent: { kind: 'ideas' }, execution: { status: 'suggested', suggested_command: '/ideas' } })
  })

  it('revalidates survey readiness and revision after search before writing', async () => {
    const blocked = projection('BLOCKED_GATE', action({ state: 'blocked', blocking: true }))
    blocked.project.revision = 3
    const snapshotCorpus = vi.fn()
    const client = {
      getProjectBySession: vi.fn().mockResolvedValue({ project_id: 'rsp_1' }),
      projectProjection: vi.fn().mockResolvedValueOnce(projection()).mockResolvedValueOnce(blocked),
      snapshotCorpus,
    } as unknown as ResearchClient
    const search = vi.fn().mockResolvedValue({ hits: [], queries: [], citation_edges: [], source_status: [], dedup_removed: 0 })
    const reply = await runNativeScholarTurn({
      text: '继续调研', sessionId: 'session_a', client,
      cache: { get: async () => undefined, set: async () => undefined }, search: search as never,
    })
    expect(snapshotCorpus).not.toHaveBeenCalled()
    expect(reply.execution.status).toBe('blocked')
    expect(reply.project?.revision).toBe(3)
  })

  it('fails closed when the DSH session is relinked during survey search', async () => {
    const snapshotCorpus = vi.fn()
    const client = {
      getProjectBySession: vi.fn()
        .mockResolvedValueOnce({ project_id: 'rsp_1' })
        .mockResolvedValueOnce({ project_id: 'rsp_1' })
        .mockResolvedValueOnce({ project_id: 'rsp_2' }),
      projectProjection: vi.fn().mockResolvedValue(projection()),
      snapshotCorpus,
    } as unknown as ResearchClient
    const search = vi.fn().mockResolvedValue({ hits: [], queries: [], citation_edges: [], source_status: [], dedup_removed: 0 })
    await expect(runNativeScholarTurn({
      text: '继续调研', sessionId: 'session_a', client,
      cache: { get: async () => undefined, set: async () => undefined }, search: search as never,
    })).rejects.toThrow('session link changed')
    expect(snapshotCorpus).not.toHaveBeenCalled()
  })

  it('does not snapshot a survey after the DSH tool call is cancelled', async () => {
    const controller = new AbortController()
    const snapshotCorpus = vi.fn()
    const client = {
      getProjectBySession: vi.fn().mockResolvedValue({ project_id: 'rsp_1' }),
      projectProjection: vi.fn().mockResolvedValue(projection()),
      snapshotCorpus,
    } as unknown as ResearchClient
    const search = vi.fn().mockImplementation(async () => {
      controller.abort()
      return { hits: [], queries: [], citation_edges: [], source_status: [], dedup_removed: 0 }
    })
    await expect(runNativeScholarTurn({
      text: '继续调研', sessionId: 'session_a', client, signal: controller.signal,
      cache: { get: async () => undefined, set: async () => undefined }, search: search as never,
    })).rejects.toThrow('aborted')
    expect(snapshotCorpus).not.toHaveBeenCalled()
  })

  it('reports an already-started survey commit as executed even if cancellation arrives inside the commit', async () => {
    const controller = new AbortController()
    const scoped = projection()
    const surveyed = projection('SURVEYING', action({ code: 'idea_generate' }))
    const snapshotCorpus = vi.fn().mockImplementation(async () => {
      controller.abort()
      return { snapshot_id: 'corpus_1' }
    })
    const client = {
      getProjectBySession: vi.fn().mockResolvedValue({ project_id: 'rsp_1' }),
      projectProjection: vi.fn().mockResolvedValueOnce(scoped).mockResolvedValueOnce(scoped).mockResolvedValueOnce(surveyed),
      snapshotCorpus,
    } as unknown as ResearchClient
    const search = vi.fn().mockResolvedValue({ hits: [], queries: [], citation_edges: [], source_status: [], dedup_removed: 0 })
    const reply = await runNativeScholarTurn({
      text: '继续调研', sessionId: 'session_a', client, signal: controller.signal,
      cache: { get: async () => undefined, set: async () => undefined }, search: search as never,
    })
    expect(reply.execution.status).toBe('executed')
    expect(snapshotCorpus).toHaveBeenCalledOnce()
  })

  it('encodes session ids as one path segment and propagates read cancellation', async () => {
    const seen: Array<{ url: string; signal?: AbortSignal | null }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), signal: init?.signal })
      return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const client = new ResearchClient({ endpoint: 'http://127.0.0.1:7412' })
    await client.getProjectBySession('x/../../projects/rsp_other')
    expect(seen[0]?.url).toBe('http://127.0.0.1:7412/v1/session-links/x%2F..%2F..%2Fprojects%2Frsp_other')

    vi.stubGlobal('fetch', vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })))
    const controller = new AbortController()
    const pending = client.getProjectBySession('session_a', controller.signal)
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(KernelUnavailableError)
  })

  it('masks Kernel endpoint details at the public tool boundary', async () => {
    const registered: Array<{ name: string; execute?: (args: unknown, exec: unknown) => Promise<unknown> }> = []
    registerResearchTools({ tools: { register: tool => registered.push(tool as never) } }, {
      client: {
        getProjectBySession: vi.fn().mockRejectedValue(new KernelUnavailableError('http://127.0.0.1:7444', new Error('connect failed'))),
      } as unknown as ResearchClient,
      cache: { get: async () => undefined, set: async () => undefined },
      ctx: {}, roles: { set() {} }, modelFor: () => undefined,
    } as unknown as ResearchToolContext)
    const tool = registered.find(candidate => candidate.name === 'dsh_scholar')
    await expect(tool?.execute?.(
      { text: 'status' },
      { agent: { id: 'session_a' }, signal: new AbortController().signal },
    )).rejects.toThrow('dsh_scholar is temporarily unavailable')
    await expect(tool?.execute?.(
      { text: 'status' },
      { agent: { id: 'session_a' }, signal: new AbortController().signal },
    )).rejects.not.toThrow('7444')
  })
})
