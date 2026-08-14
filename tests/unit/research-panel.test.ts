import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_STAGE_SUBAGENT_CONFIG,
  StageSubagentCoordinator,
  parsePanelPerspectives,
  type StagePanelClient,
  type StagePanelInput,
  type SubagentRuntimeLike,
} from '../../src/plugin/stage-subagents.js'
import { stageProjectScopeDenial } from '../../src/plugin/acl.js'

function projection(overrides: Record<string, unknown> = {}) {
  return {
    project: {
      project_id: 'rsp_panel',
      name: 'Panel project',
      status: 'SCOPED',
      revision: 4,
      constraints: { max_model_cost_usd: 250, max_gpu_hours: 120 },
    },
    pending_gates: [],
    budget: { model_cost_usd: 0, gpu_hours: 0, api_requests: 0 },
    next_actions_v2: [{
      id: 'survey_run:rsp_panel',
      code: 'survey_run',
      revision: 4,
      state: 'ready' as const,
      required_by: 'agent' as const,
    }],
    ...overrides,
  }
}

function clientWith(projections: ReturnType<typeof projection>[] = [projection(), projection()]): StagePanelClient & {
  getProjectBySession: ReturnType<typeof vi.fn>
  projectProjection: ReturnType<typeof vi.fn>
  registerChildLinkFromSession: ReturnType<typeof vi.fn>
  updateChildStateFromSession: ReturnType<typeof vi.fn>
  recordUsage: ReturnType<typeof vi.fn>
} {
  let index = 0
  return {
    getProjectBySession: vi.fn().mockResolvedValue({ project_id: 'rsp_panel' }),
    projectProjection: vi.fn().mockImplementation(async () => projections[Math.min(index++, projections.length - 1)]),
    registerChildLinkFromSession: vi.fn().mockResolvedValue({}),
    updateChildStateFromSession: vi.fn().mockResolvedValue({}),
    recordUsage: vi.fn().mockResolvedValue({}),
  }
}

function input(overrides: Partial<StagePanelInput> = {}): StagePanelInput {
  return {
    projectId: 'rsp_panel',
    sessionId: 'parent-session',
    parent: { id: 'parent-session' },
    signal: new AbortController().signal,
    kind: 'scholar',
    perspectives: [{ label: 'classics' }, { label: 'frontier' }],
    task: 'Survey the field from independent perspectives.',
    idempotencyKey: 'panel-turn-1',
    ...overrides,
  }
}

function coordinator(overrides: Partial<typeof DEFAULT_STAGE_SUBAGENT_CONFIG> = {}): StageSubagentCoordinator {
  return new StageSubagentCoordinator({
    ...DEFAULT_STAGE_SUBAGENT_CONFIG,
    enabled: true,
    ...overrides,
  })
}

function dependencies(client: StagePanelClient, runtime: SubagentRuntimeLike) {
  return {
    client,
    runtime,
    roles: { set: vi.fn(), delete: vi.fn() },
    projectScopes: new Map<string, string>(),
    modelFor: vi.fn().mockReturnValue('model-for-panel'),
  }
}

function run(id: string, stopReason = 'completed', structured: unknown = {
  summary: 'safe summary',
  notes: ['note'],
  references: ['doi:10.1/example'],
}) {
  const dispose = vi.fn().mockResolvedValue(undefined)
  return {
    id,
    result: Promise.resolve({ stopReason, structured, output: [{ type: 'text', text: 'raw output must not be returned' }] }),
    dispose,
  }
}

describe('stage-aware research_panel coordinator', () => {
  it('denies explicit project and job references outside the child project scope', async () => {
    const projectForJob = vi.fn(async (jobId: string) => jobId === 'job-local' ? 'rsp_panel' : 'rsp_foreign')
    await expect(stageProjectScopeDenial('rsp_panel', { project_id: 'rsp_panel' }, projectForJob)).resolves.toBeUndefined()
    await expect(stageProjectScopeDenial('rsp_panel', { project_id: 'rsp_foreign' }, projectForJob)).resolves.toContain('project_id')
    await expect(stageProjectScopeDenial('rsp_panel', { job_id: 'job-foreign' }, projectForJob)).resolves.toContain('job_id')
    await expect(stageProjectScopeDenial('rsp_panel', { job_id: 'job-local' }, projectForJob)).resolves.toBeUndefined()
  })
  it('strictly validates bounded perspective objects', () => {
    expect(parsePanelPerspectives([{ label: ' a ', role: ' classics ' }], 2))
      .toEqual([{ label: 'a', role: 'classics' }])
    expect(() => parsePanelPerspectives([], 2)).toThrow('1-2 perspectives')
    expect(() => parsePanelPerspectives([{ label: 'a', extra: true }], 2)).toThrow('unknown field')
    expect(() => parsePanelPerspectives([{ label: 'a' }, { label: 'b' }, { label: 'c' }], 2)).toThrow('1-2 perspectives')
  })

  it('fails closed before spawn when disabled, cross-session, gated or wrong-stage', async () => {
    const start = vi.fn()
    const runtime = { start } as unknown as SubagentRuntimeLike
    const client = clientWith()

    await expect(new StageSubagentCoordinator(DEFAULT_STAGE_SUBAGENT_CONFIG)
      .execute(input(), dependencies(client, runtime))).rejects.toThrow('disabled')
    await expect(coordinator().execute(input({ sessionId: 'foreign-session' }), dependencies(client, runtime)))
      .rejects.toThrow('exact DSH session')
    await expect(coordinator().execute(input({ projectId: 'rsp_foreign' }), dependencies(client, runtime)))
      .rejects.toThrow('not linked')

    const gated = clientWith([projection({ pending_gates: [{ gate_id: 'gate_1', type: 'idea', status: 'pending' }] })])
    await expect(coordinator().execute(input(), dependencies(gated, runtime))).rejects.toThrow('Human Gate')

    const wrong = clientWith([projection({
      next_actions_v2: [{ id: 'idea_generate:rsp_panel', code: 'idea_generate', revision: 4, state: 'ready', required_by: 'agent' }],
    })])
    await expect(coordinator().execute(input(), dependencies(wrong, runtime))).rejects.toThrow('not allowed')
    expect(start).not.toHaveBeenCalled()
  })

  it('runs bounded one-shot children, writes topology lifecycle, disposes and records actual requests', async () => {
    const first = run('child-1', 'completed', {
      summary: 'token=super-secret /home/dev/private/result',
      notes: ['n1'],
      references: ['doi:10.1/a'],
    })
    const second = run('child-2')
    const start = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const runtime = { start } as unknown as SubagentRuntimeLike
    const client = clientWith()
    const deps = dependencies(client, runtime)

    const result = await coordinator().execute(input(), deps)

    expect(result.panel).toMatchObject({
      kind: 'scholar',
      stage: 'survey',
      project_id: 'rsp_panel',
      session_id: 'parent-session',
      action_code: 'survey_run',
      project_revision: 4,
      stale: false,
    })
    expect(result.panel.members).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain('super-secret')
    expect(JSON.stringify(result)).not.toContain('/home/dev')
    expect(JSON.stringify(result)).not.toContain('raw output must not be returned')
    expect(result.panel.members[0]?.structured.summary).toContain('[redacted]')
    expect(result.panel.policy_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.panel.input_hash).toMatch(/^[0-9a-f]{64}$/)

    expect(start).toHaveBeenCalledTimes(2)
    for (const call of start.mock.calls) {
      expect(call[0]).toBe('spawn')
      expect(call[1]).toMatchObject({
        parent: { id: 'parent-session' },
        agentOptions: { model: 'model-for-panel' },
        maxDepth: 1,
        toolFilter: { allow: ['literature_search', 'paper_resolve', 'passage_lookup', 'research_status'] },
      })
      expect(call[1].prompt[0].text).toContain('Never approve a Gate')
      expect(call[1].prompt[0].text).not.toContain('idea_create')
    }
    expect(client.registerChildLinkFromSession).toHaveBeenCalledTimes(2)
    expect(client.registerChildLinkFromSession).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'rsp_panel',
      child_id: 'child-1',
      parent_id: 'parent-session',
      mode: 'one-shot',
      state: 'running',
    }), 'parent-session', expect.anything())
    expect(client.updateChildStateFromSession).toHaveBeenCalledWith('child-1', 'succeeded', 'parent-session', 'stop_reason=completed', expect.anything())
    expect(client.updateChildStateFromSession).toHaveBeenCalledWith('child-2', 'succeeded', 'parent-session', 'stop_reason=completed', expect.anything())
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(second.dispose).toHaveBeenCalledOnce()
    expect(client.recordUsage).toHaveBeenCalledWith('rsp_panel', { api_requests: 2 })
    expect(result.budget_recorded).toEqual({ api_requests: 2 })
  })

  it('maps failed and aborted children to terminal topology states and always disposes', async () => {
    const failed = run('child-failed', 'error')
    const aborted = run('child-aborted', 'aborted')
    const runtime = {
      start: vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(aborted),
    } as unknown as SubagentRuntimeLike
    const client = clientWith()

    const result = await coordinator().execute(input(), dependencies(client, runtime))

    expect(result.panel.members).toEqual([])
    expect(result.panel.failures).toHaveLength(2)
    expect(client.updateChildStateFromSession).toHaveBeenCalledWith('child-failed', 'failed', 'parent-session', expect.any(String), expect.anything())
    expect(client.updateChildStateFromSession).toHaveBeenCalledWith('child-aborted', 'cancelled', 'parent-session', expect.any(String), expect.anything())
    expect(failed.dispose).toHaveBeenCalledOnce()
    expect(aborted.dispose).toHaveBeenCalledOnce()
    expect(client.recordUsage).toHaveBeenCalledWith('rsp_panel', { api_requests: 2 })
  })

  it('enforces plugin-wide concurrency and stable idempotent replay', async () => {
    let resolveFirst!: (value: { stopReason: string; structured: unknown; output: never[] }) => void
    const firstResult = new Promise<{ stopReason: string; structured: unknown; output: never[] }>(resolve => { resolveFirst = resolve })
    const first = { id: 'child-1', result: firstResult, dispose: vi.fn().mockResolvedValue(undefined) }
    const second = run('child-2')
    const runtime = {
      start: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
    } as unknown as SubagentRuntimeLike
    const client = clientWith()
    const deps = dependencies(client, runtime)
    const owner = coordinator({ maxConcurrency: 1 })

    const pending = owner.execute(input(), deps)
    await vi.waitFor(() => expect(runtime.start).toHaveBeenCalledTimes(1))
    resolveFirst({ stopReason: 'completed', structured: { summary: 'first' }, output: [] })
    const result = await pending
    expect(runtime.start).toHaveBeenCalledTimes(2)

    const replay = await owner.execute(input(), deps)
    expect(replay).toEqual(result)
    expect(runtime.start).toHaveBeenCalledTimes(2)
    await expect(owner.execute(input({ task: 'different input' }), deps)).rejects.toThrow('idempotency_key conflicts')
    expect(runtime.start).toHaveBeenCalledTimes(2)
    await expect(owner.execute(input({ idempotencyKey: 'another-key' }), deps)).rejects.toThrow('already exists for the current action')
  })

  it('marks fan-in results stale when revision or NextAction changes', async () => {
    const runtime = { start: vi.fn().mockResolvedValue(run('child-1')) } as unknown as SubagentRuntimeLike
    const changed = projection({
      project: {
        project_id: 'rsp_panel',
        name: 'Panel project',
        status: 'SURVEYING',
        revision: 5,
        constraints: { max_model_cost_usd: 250, max_gpu_hours: 120 },
      },
      next_actions_v2: [{ id: 'idea_generate:rsp_panel', code: 'idea_generate', revision: 5, state: 'ready', required_by: 'agent' }],
    })
    const client = clientWith([projection(), changed])

    const result = await coordinator().execute(input({ perspectives: [{ label: 'one' }] }), dependencies(client, runtime))
    expect(result.panel.stale).toBe(true)
    expect(result.panel.members).toEqual([])
    expect(result.panel.failures).toContain('panel findings discarded because the project/session/action changed during fan-in')
    expect(result.note).toContain('were discarded')
  })

  it('rejects oversized or open structured output without leaking raw content', async () => {
    const invalid = run('child-invalid', 'completed', { summary: 'safe', extra: 'secret' })
    const runtime = { start: vi.fn().mockResolvedValue(invalid) } as unknown as SubagentRuntimeLike
    const client = clientWith()

    const result = await coordinator().execute(input({ perspectives: [{ label: 'one' }] }), dependencies(client, runtime))
    expect(result.panel.members).toEqual([])
    expect(result.panel.failures[0]).toContain('unknown field')
    expect(client.updateChildStateFromSession).toHaveBeenCalledWith('child-invalid', 'failed', 'parent-session', expect.any(String), expect.anything())
    expect(invalid.dispose).toHaveBeenCalledOnce()
  })

  it('redacts prompt inputs and treats timeout as cancelled even if the provider completes late', async () => {
    let resolveResult!: (value: { stopReason: string; structured: unknown; output: never[] }) => void
    const lateResult = new Promise<{ stopReason: string; structured: unknown; output: never[] }>(resolve => { resolveResult = resolve })
    const child = { id: 'child-timeout', result: lateResult, dispose: vi.fn().mockResolvedValue(undefined) }
    const runtime = { start: vi.fn().mockResolvedValue(child) } as unknown as SubagentRuntimeLike
    const client = clientWith()
    const pending = coordinator({ timeoutMs: 10 }).execute(input({
      perspectives: [{ label: '/home/dev/private' }],
      task: 'Authorization: Basic abcdefghijklmnop -----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
    }), dependencies(client, runtime))
    const result = await pending
    resolveResult({ stopReason: 'completed', structured: { summary: 'late' }, output: [] })

    const prompt = (runtime.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[1].prompt[0].text as string
    expect(prompt).not.toContain('abcdefghijklmnop')
    expect(prompt).not.toContain('BEGIN PRIVATE KEY')
    expect(prompt).not.toContain('/home/dev')
    expect(result.panel.members).toEqual([])
    expect(client.updateChildStateFromSession).toHaveBeenCalledWith('child-timeout', 'cancelled', 'parent-session', expect.any(String), expect.anything())
    expect(child.dispose).toHaveBeenCalledOnce()
  })

  it('does not let a hanging topology update block child disposal or the panel forever', async () => {
    const child = run('child-update-hangs')
    const runtime = { start: vi.fn().mockResolvedValue(child) } as unknown as SubagentRuntimeLike
    const client = clientWith()
    client.updateChildStateFromSession.mockImplementation(() => new Promise(() => undefined))
    const deps = dependencies(client, runtime)

    const pending = coordinator({ timeoutMs: 10 }).execute(input({ perspectives: [{ label: 'one' }] }), deps)
    await vi.waitFor(() => expect(child.dispose).toHaveBeenCalledOnce())
    const result = await pending

    expect(result.panel.members).toEqual([])
    expect(result.panel.failures[0]).toContain('topology update timed out')
    expect(deps.projectScopes.size).toBe(0)
    expect(deps.roles.delete).toHaveBeenCalledWith('child-update-hangs')
  })
})
