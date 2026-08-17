/** DSH-visible project creation honors the plugin row's defaultMode. */
import { describe, expect, it } from 'vitest'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type { ResearchClient } from '@dsh-scholar/research-client'
import { registerResearchTools, type ResearchToolContext } from '../../src/plugin/tools.js'
import { registerResearchCommands, type CommandContext } from '../../src/plugin/commands.js'

const BRIEF = {
  problem: 'compatibility',
  scope: 'plugin config',
  questions: [],
  primary_metrics: [],
  resources: '',
  risks: [],
  target_outputs: ['paper'],
  target_venue: null,
  baseline_repo: null,
  domain: 'machine-learning',
}

describe('DSH plugin defaultMode', () => {
  it('uses a Scholar-specific release command instead of DSH Web reserved /export', () => {
    const commands = new Map<string, unknown>()
    const ctx = {
      commands: { register: (definition: { name: string }) => commands.set(definition.name, definition) },
    }

    registerResearchCommands(ctx as never, {
      client: {} as ResearchClient,
      cache: { get: async () => undefined, set: async () => undefined },
      unattended: false,
      operatorPrincipal: 'dsh:test-operator',
    } as CommandContext)

    expect(commands.has('export')).toBe(false)
    expect(commands.has('release-bundle')).toBe(true)
  })

  it('applies full-auto to research_project create when the tool call omits mode', async () => {
    let createdMode: unknown
    const client = {
      createProject: async (input: { mode?: string }) => {
        createdMode = input.mode
        return { project_id: 'rsp_fixture', name: 'fixture', brief: BRIEF }
      },
    } as unknown as ResearchClient
    const registered: Array<{ name: string; execute(args: Record<string, unknown>, exec: { agent?: { id: string }; signal: AbortSignal }): Promise<unknown> }> = []
    const toolContext = {
      client,
      cache: { get: async () => undefined, set: async () => undefined },
      ctx: {},
      roles: { set() {} },
      modelFor: () => undefined,
      defaultMode: 'full-auto',
      operatorPrincipal: 'dsh:test-operator',
    } as unknown as ResearchToolContext

    registerResearchTools({ tools: { register: tool => registered.push(tool as never) } }, toolContext)
    const create = registered.find(tool => tool.name === 'research_project')
    expect(create).toBeDefined()
    await create?.execute({
      action: 'create',
      name: 'fixture',
      brief_json: JSON.stringify(BRIEF),
      fixture_id: 'golden-path-v2',
    }, { agent: { id: 'pi' }, signal: new AbortController().signal })

    expect(createdMode).toBe('full-auto')
  })

  it('applies full-auto to /new when the command omits a per-project mode', async () => {
    let createdMode: unknown
    const client = {
      createProject: async (input: { mode?: string }) => {
        createdMode = input.mode
        return { project_id: 'rsp_command', name: 'fixture', status: 'DRAFT', brief: BRIEF }
      },
      createGate: async () => ({ gate_id: 'gate_scope' }),
    } as unknown as ResearchClient
    const commands = new Map<string, { handler(invocation: { agent: { id: string }; rawInput: string }): Promise<unknown> }>()
    const ctx = {
      commands: { register: (definition: { name: string; handler(invocation: { agent: { id: string }; rawInput: string }): Promise<unknown> }) => commands.set(definition.name, definition) },
    }

    registerResearchCommands(ctx as never, {
      client,
      cache: { get: async () => undefined, set: async () => undefined },
      unattended: false,
      defaultMode: 'full-auto',
      operatorPrincipal: 'dsh:test-operator',
    } as CommandContext)
    await commands.get('new')?.handler({
      agent: { id: 'pi' },
      rawInput: `fixture ${JSON.stringify({ ...BRIEF, fixture_id: 'golden-path-v2' })}`,
    })

    expect(createdMode).toBe('full-auto')
  })

  it('creates a name-only project from DSH rawInput with its separator whitespace', async () => {
    let created: { session_id: string; name: string; idempotency_key: string } | undefined
    const client = {
      createProjectForDshSession: async (input: { session_id: string; name: string; idempotency_key: string }) => {
        created = input
        return {
          project: { project_id: 'rsp_name_only', name: input.name, status: 'DRAFT', brief_status: 'collecting' },
          intake: {}, budget: {}, membership: [], link: {},
        }
      },
    } as unknown as ResearchClient
    const commands = new Map<string, { handler(invocation: { agent: { id: string }; rawInput: string }): Promise<unknown> }>()
    const ctx = {
      commands: { register: (definition: { name: string; handler(invocation: { agent: { id: string }; rawInput: string }): Promise<unknown> }) => commands.set(definition.name, definition) },
    }

    registerResearchCommands(ctx as never, {
      client,
      cache: { get: async () => undefined, set: async () => undefined },
      unattended: false,
      operatorPrincipal: 'dsh:test-operator',
    } as CommandContext)
    const parsed = parseCommand('/new demo')
    expect(parsed).toEqual({ name: 'new', rawInput: ' demo' })
    const result = await commands.get('new')?.handler({
      agent: { id: 'pi' },
      rawInput: parsed!.rawInput,
    })

    expect(result).toMatchObject({ kind: 'success' })
    expect(created).toMatchObject({
      session_id: 'pi',
      name: 'demo',
      idempotency_key: expect.stringMatching(/^dsh-create:/),
    })
  })
})
