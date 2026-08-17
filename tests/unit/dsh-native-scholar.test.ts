import { afterEach, describe, expect, it, vi } from 'vitest'
import { KernelApiError, KernelUnavailableError, ResearchClient } from '@dsh-scholar/research-client'
import { RoleRegistry, RESEARCH_TOOLS } from '../../src/plugin/acl.js'
import { classifyNativeIntent, nativeGrillQuestionText, runNativeScholarTurn, suggestedCommand } from '../../src/plugin/native-chat.js'
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
    expect(tool?.description).toContain('project_name')
    expect(tool?.description).toContain('complete name after the create command')
    expect(tool?.description).toContain('never decides Gates')
    expect((tool?.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty('project_name')
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
    expect(classifyNativeIntent('创建研究项目 OCR 复现')).toBe('create')
    expect(classifyNativeIntent('Create a research project named OCR Reproduction')).toBe('create')
    for (const text of ['创建研究项目 风险评估', '创建研究项目 方法学', '创建研究项目 类别识别', 'Create a research project named What']) {
      expect(classifyNativeIntent(text)).toBe('create')
    }
    for (const text of ['开始研究方法', '我不想创建研究项目', '请不要创建研究项目', '能不能创建研究项目？', '可以创建研究项目吗？', '介绍创建项目的方法', "I don't want to create a project", 'Can you create a research project?']) {
      expect(classifyNativeIntent(text)).not.toBe('create')
    }
    for (const text of [
      '创建研究项目 Foo，不要创建', '创建研究项目 Foo，然后取消', 'Create a research project named Foo, do not create',
      '创建研究项目 Foo 不创建', '创建研究项目 Foo 不进行创建', '创建研究项目 Foo 先别创建',
      'Create a research project named Foo not create', '创建研究项目 Foo 然后查看状态',
      'Create a research project named Foo then show status',
    ]) {
      expect(classifyNativeIntent(text)).not.toBe('create')
    }
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

  it('keeps native Brief question copy aligned in Chinese and English', () => {
    expect(nativeGrillQuestionText('grill.question.problem', 'zh')).toBe('你想解决的核心研究问题是什么？')
    expect(nativeGrillQuestionText('grill.question.materialContext', 'en')).toContain('What materials')
    expect(nativeGrillQuestionText('future.prompt', 'zh')).toBe('future.prompt')
  })

  it('collects a linked project Brief one question at a time through the Host question seam', async () => {
    const collecting = projection('DRAFT', action({
      code: 'intake_resume', label: 'Resume intake', reason: 'brief required', route: 'chat',
      required_by: 'human', state: 'ready',
    }))
    collecting.project.brief_status = 'collecting'
    const first = {
      project_id: 'rsp_1', project_revision: 0, intake_id: 'int_1', intake_revision: 0,
      question: { question_code: 'brief.problem', question_revision: 1, prompt_key: 'grill.question.problem', required: true },
      answers: [], brief_preview: {}, ready_to_confirm: false,
    }
    const second = {
      ...first, intake_revision: 1,
      question: { question_code: 'brief.scope', question_revision: 1, prompt_key: 'grill.question.scope', required: true },
      answers: [{ question_code: 'brief.problem', disposition: 'answered' }],
    }
    const ready = {
      ...second, intake_revision: 2, question: null,
      answers: [...second.answers, { question_code: 'brief.scope', disposition: 'unknown' }],
      ready_to_confirm: true,
    }
    const answerProjectGrill = vi.fn().mockResolvedValueOnce(second).mockResolvedValueOnce(ready)
    const client = {
      getProjectBySession: vi.fn().mockResolvedValue({ project_id: 'rsp_1' }),
      projectProjection: vi.fn().mockResolvedValue(collecting),
      projectGrill: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      answerProjectGrill,
    } as unknown as ResearchClient
    const askGrillQuestion = vi.fn()
      .mockResolvedValueOnce({ disposition: 'answered', value: 'Robust low-resource OCR' })
      .mockResolvedValueOnce({ disposition: 'unknown' })

    const reply = await runNativeScholarTurn({
      text: '继续研究', sessionId: 'session_a', client, operatorPrincipal: 'dsh:operator', askGrillQuestion,
      cache: { get: async () => undefined, set: async () => undefined },
    })

    expect(askGrillQuestion).toHaveBeenCalledTimes(2)
    expect(askGrillQuestion).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: 'brief.problem', header: '完善研究 Brief · 1/7', question: '你想解决的核心研究问题是什么？',
    }))
    expect(answerProjectGrill).toHaveBeenNthCalledWith(1, 'rsp_1', {
      question_code: 'brief.problem', question_revision: 1, disposition: 'answered', value: 'Robust low-resource OCR',
    }, 'dsh:operator')
    expect(answerProjectGrill).toHaveBeenNthCalledWith(2, 'rsp_1', {
      question_code: 'brief.scope', question_revision: 1, disposition: 'unknown',
    }, 'dsh:operator')
    expect(reply).toMatchObject({ execution: { status: 'needs_human', operation: 'brief_collect' } })
    expect(reply.assistant_text).toContain('PI 确认 Brief')
  })

  it('reuses the exact live DSH agent in the native user-question composer', async () => {
    const collecting = projection('DRAFT', action({
      code: 'intake_resume', label: 'Resume intake', reason: 'brief required', route: 'chat', required_by: 'human',
    }))
    collecting.project.brief_status = 'collecting'
    const question = {
      project_id: 'rsp_1', project_revision: 0, intake_id: 'int_1', intake_revision: 0,
      question: { question_code: 'brief.problem', question_revision: 1, prompt_key: 'grill.question.problem', required: true },
      answers: [], brief_preview: {}, ready_to_confirm: false,
    }
    const ready = { ...question, question: null, answers: [{ question_code: 'brief.problem', disposition: 'answered' }], ready_to_confirm: true }
    const client = {
      getProjectBySession: vi.fn().mockResolvedValue({ project_id: 'rsp_1' }),
      projectProjection: vi.fn().mockResolvedValue(collecting),
      projectGrill: vi.fn().mockResolvedValue(question),
      answerProjectGrill: vi.fn().mockResolvedValue(ready),
    } as unknown as ResearchClient
    const ask = vi.fn().mockResolvedValue({ answers: [{ id: 'brief.problem', selected: [], custom: 'OCR robustness' }] })
    const registered: Array<{ name: string; execute?: (args: unknown, exec: unknown) => Promise<unknown> }> = []
    registerResearchTools({ tools: { register: tool => registered.push(tool as never) } }, {
      client,
      cache: { get: async () => undefined, set: async () => undefined },
      ctx: { userQuestions: { ask } },
      roles: { set() {}, delete() {} }, projectScopes: new Map(), modelFor: () => undefined,
      operatorPrincipal: 'dsh:operator',
    } as unknown as ResearchToolContext)
    const liveAgent = { id: 'session_a' }
    const tool = registered.find(candidate => candidate.name === 'dsh_scholar')

    await tool?.execute?.({ text: '继续研究' }, { agent: liveAgent, signal: new AbortController().signal })

    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      agent: liveAgent,
      questions: [expect.objectContaining({
        id: 'brief.problem', question: '你想解决的核心研究问题是什么？',
        options: [expect.objectContaining({ label: '暂时未知' })],
      })],
    }))
    expect(client.answerProjectGrill).toHaveBeenCalledWith('rsp_1', expect.objectContaining({
      disposition: 'answered', value: 'OCR robustness',
    }), 'dsh:operator')
  })

  it('asks for a name without mutating when an unlinked DSH session has no explicit project name', async () => {
    const client = {
      getProjectBySession: vi.fn().mockResolvedValue(null),
      createProjectForDshSession: vi.fn(),
    } as unknown as ResearchClient
    const reply = await runNativeScholarTurn({
      text: '创建研究项目', sessionId: 'session_a', client,
      cache: { get: async () => undefined, set: async () => undefined },
    })
    expect(reply).toMatchObject({ linked: false, execution: { status: 'needs_project', suggested_command: null } })
    expect(reply.assistant_text).toContain('准确名称')
    expect((client.createProjectForDshSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    await expect(runNativeScholarTurn({
      text: '查看状态', sessionId: 'session_a', projectId: 'rsp_other', client,
      cache: { get: async () => undefined, set: async () => undefined },
    })).rejects.toThrow('not linked')
  })

  it('creates a name-only project and links the exact unlinked DSH session from explicit natural language', async () => {
    const created = {
      project: { project_id: 'rsp_new', name: 'OCR 复现', status: 'DRAFT', revision: 0, brief_status: 'collecting' },
      intake: { intake_id: 'intk_new' }, budget: {}, membership: [],
      link: { session_id: 'session_a', project_id: 'rsp_new' },
    }
    const createdProjection = projection('DRAFT', action({
      code: 'intake_resume', label: 'Resume intake', reason: 'brief required', route: 'intake',
      required_by: 'human', revision: 0,
    }))
    createdProjection.project = created.project
    const createProjectForDshSession = vi.fn().mockResolvedValue(created)
    const client = {
      getProjectBySession: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(created.project),
      createProjectForDshSession,
      projectProjection: vi.fn().mockResolvedValue(createdProjection),
    } as unknown as ResearchClient

    const signal = new AbortController().signal
    const reply = await runNativeScholarTurn({
      text: '请创建研究项目 OCR 复现', projectName: 'OCR 复现', sessionId: 'session_a', client,
      cache: { get: async () => undefined, set: async () => undefined }, signal,
    })

    expect(createProjectForDshSession).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'session_a', name: 'OCR 复现', idempotency_key: expect.stringMatching(/^dsh-create:/),
    }), signal)
    expect(reply).toMatchObject({
      linked: true,
      project: { project_id: 'rsp_new', brief_status: 'collecting' },
      intent: { kind: 'create' },
      execution: { status: 'executed', operation: 'project_create', suggested_command: null },
      next_action: { code: 'intake_resume', required_by: 'human' },
    })
  })

  it('does not create from a model-supplied project name without explicit create wording', async () => {
    const createProjectForDshSession = vi.fn()
    const client = {
      getProjectBySession: vi.fn().mockResolvedValue(null),
      createProjectForDshSession,
    } as unknown as ResearchClient
    const reply = await runNativeScholarTurn({
      text: '介绍一下 OCR 研究方法', projectName: 'OCR 复现', sessionId: 'session_a', client,
      cache: { get: async () => undefined, set: async () => undefined },
    })
    expect(reply.linked).toBe(false)
    expect(reply.execution.status).toBe('needs_project')
    expect(createProjectForDshSession).not.toHaveBeenCalled()
  })

  it('does not create when project_name is absent from or differs from the current user text', async () => {
    for (const [text, projectName] of [
      ['请创建一个研究项目', '模型补写名称'],
      ['请创建研究项目 OCR 复现', 'OCR'],
      ['请创建研究项目 OCR 复现', '另一个项目'],
      ['请创建研究项目 Foo 而不是 Bar', 'Bar'],
      ['请不要创建研究项目 OCR 复现', 'OCR 复现'],
      ['Can you create a research project named OCR?', 'OCR'],
      ['创建研究项目 Foo，不要创建', 'Foo，不要创建'],
      ['创建研究项目 Foo，然后取消', 'Foo，然后取消'],
      ['Create a research project named Foo, do not create', 'Foo, do not create'],
      ['创建研究项目 Foo 不创建', 'Foo 不创建'],
      ['创建研究项目 Foo 不进行创建', 'Foo 不进行创建'],
      ['创建研究项目 Foo 先别创建', 'Foo 先别创建'],
      ['Create a research project named Foo not create', 'Foo not create'],
      ['创建研究项目 Foo 然后查看状态', 'Foo 然后查看状态'],
      ['Create a research project named Foo then show status', 'Foo then show status'],
    ]) {
      const createProjectForDshSession = vi.fn()
      const client = { getProjectBySession: vi.fn().mockResolvedValue(null), createProjectForDshSession } as unknown as ResearchClient
      const reply = await runNativeScholarTurn({
        text, projectName, sessionId: 'session_a', client,
        cache: { get: async () => undefined, set: async () => undefined },
      })
      expect(reply.linked).toBe(false)
      expect(createProjectForDshSession).not.toHaveBeenCalled()
    }
  })

  it('reconciles a lost create response from the authoritative link without creating twice', async () => {
    const createdProject = { project_id: 'rsp_lost', name: 'Lost Response', status: 'DRAFT', revision: 0, brief_status: 'collecting' }
    const createdProjection = projection('DRAFT', action({
      code: 'intake_resume', label: 'Resume intake', reason: 'brief required', route: 'intake', required_by: 'human', revision: 0,
    }))
    createdProjection.project = createdProject
    const transportError = new KernelUnavailableError('http://127.0.0.1:7412', new Error('socket closed'))
    const controller = new AbortController()
    const createProjectForDshSession = vi.fn()
      .mockImplementationOnce(async () => {
        controller.abort()
        throw transportError
      })
      .mockResolvedValueOnce({ project: createdProject, link: { session_id: 'session_lost', project_id: 'rsp_lost' } })
    const client = {
      getProjectBySession: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(createdProject),
      createProjectForDshSession,
      projectProjection: vi.fn().mockResolvedValue(createdProjection),
    } as unknown as ResearchClient
    const reply = await runNativeScholarTurn({
      text: '创建研究项目 Lost Response', projectName: 'Lost Response', sessionId: 'session_lost', client,
      cache: { get: async () => undefined, set: async () => undefined }, signal: controller.signal,
    })
    expect(reply).toMatchObject({ linked: true, project: { project_id: 'rsp_lost' }, execution: { status: 'executed', operation: 'project_create' } })
    expect(client.createProjectForDshSession).toHaveBeenCalledTimes(2)
    expect(client.createProjectForDshSession).toHaveBeenNthCalledWith(2, expect.objectContaining({ replay_only: true }))
    expect(client.projectProjection).toHaveBeenCalledWith('rsp_lost')
  })

  it('replays an actual ResearchClient create when the successful response body is lost', async () => {
    const createdProject = { project_id: 'rsp_body_lost', name: 'Body Lost', status: 'DRAFT', revision: 0, brief_status: 'collecting' }
    const createdProjection = projection('DRAFT', action({
      code: 'intake_resume', label: 'Resume intake', reason: 'brief required', route: 'intake', required_by: 'human', revision: 0,
    }))
    createdProjection.project = createdProject
    const receipt = {
      project: createdProject, intake: { intake_id: 'intk_body_lost' }, budget: {}, membership: [],
      link: { session_id: 'session_body_lost', project_id: 'rsp_body_lost' },
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('null', { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce({ ok: true, status: 201, json: vi.fn().mockRejectedValue(new Error('response body truncated')) } as unknown as Response)
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(createdProject), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(createdProjection), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ResearchClient({
      endpoint: 'http://127.0.0.1:7412', serviceToken: 'service-secret', dshPluginToken: 'dsh-secret',
    })

    const reply = await runNativeScholarTurn({
      text: '创建研究项目 Body Lost', projectName: 'Body Lost', sessionId: 'session_body_lost', client,
      cache: { get: async () => undefined, set: async () => undefined },
    })

    expect(reply).toMatchObject({ linked: true, project: { project_id: 'rsp_body_lost' }, execution: { status: 'executed' } })
    expect(fetchMock).toHaveBeenCalledTimes(5)
    const replayHeaders = (fetchMock.mock.calls[2]?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined
    expect(replayHeaders?.['x-idempotency-replay-only']).toBe('1')
  })

  it('does not treat a same-name link as this create when the idempotent POST was rejected', async () => {
    const other = { project_id: 'rsp_other', name: 'Same Name', status: 'DRAFT', revision: 0, brief_status: 'collecting' }
    const client = {
      getProjectBySession: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(other),
      createProjectForDshSession: vi.fn().mockRejectedValue(new KernelApiError(409, 'session_link_conflict', 'occupied')),
    } as unknown as ResearchClient
    await expect(runNativeScholarTurn({
      text: '创建研究项目 Same Name', projectName: 'Same Name', sessionId: 'session_conflict', client,
      cache: { get: async () => undefined, set: async () => undefined },
    })).rejects.toMatchObject({ status: 409, code: 'session_link_conflict' })
    expect(client.createProjectForDshSession).toHaveBeenCalledTimes(1)
    expect(client.getProjectBySession).toHaveBeenCalledTimes(1)
  })

  it('keeps the original transport failure when replay-only finds no committed receipt', async () => {
    const transportError = new KernelUnavailableError('http://127.0.0.1:7412', new Error('socket closed'))
    const createProjectForDshSession = vi.fn()
      .mockRejectedValueOnce(transportError)
      .mockRejectedValueOnce(new KernelApiError(404, 'idempotency_receipt_not_found', 'missing'))
    const client = { getProjectBySession: vi.fn().mockResolvedValue(null), createProjectForDshSession } as unknown as ResearchClient
    await expect(runNativeScholarTurn({
      text: '创建研究项目 Missing Receipt', projectName: 'Missing Receipt', sessionId: 'session_missing', client,
      cache: { get: async () => undefined, set: async () => undefined },
    })).rejects.toBe(transportError)
    expect(createProjectForDshSession).toHaveBeenCalledTimes(2)
    expect(client.getProjectBySession).toHaveBeenCalledTimes(1)
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
