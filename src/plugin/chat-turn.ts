import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'

export interface HarnessChatTurnRequest {
  text: string
  locale?: 'zh' | 'en'
  project: {
    project_id: string
    name?: string
    status?: string
    brief_status?: string
    next_actions_v2?: unknown[]
  }
  history?: Array<{ role: 'user' | 'assistant'; text: string }>
}

export interface HarnessChatTurnReply {
  assistant_text: string
  suggested_command?: string
}

type LlmFace = Pick<LlmRuntime, 'listProviders' | 'listModels' | 'stream'>

const MAX_TEXT = 16_000
const MAX_HISTORY = 12
const MAX_HISTORY_TEXT = 2_000
const MAX_PROJECTION = 8_000
const MAX_ANSWER = 20_000

function clamp(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function safeRequest(input: unknown): HarnessChatTurnRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('invalid Scholar Chat turn')
  const raw = input as Record<string, unknown>
  const projectRaw = typeof raw.project === 'object' && raw.project !== null && !Array.isArray(raw.project)
    ? raw.project as Record<string, unknown>
    : null
  const text = clamp(raw.text, MAX_TEXT)
  const projectId = clamp(projectRaw?.project_id, 256)
  if (text === '' || projectId === '') throw new Error('invalid Scholar Chat turn')
  const history = Array.isArray(raw.history)
    ? raw.history.slice(-MAX_HISTORY).flatMap(item => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
      const row = item as Record<string, unknown>
      if (row.role !== 'user' && row.role !== 'assistant') return []
      const itemText = clamp(row.text, MAX_HISTORY_TEXT)
      const role: 'user' | 'assistant' = row.role
      return itemText === '' ? [] : [{ role, text: itemText }]
    })
    : []
  return {
    text,
    locale: raw.locale === 'en' ? 'en' : 'zh',
    project: {
      project_id: projectId,
      name: clamp(projectRaw?.name, 512),
      status: clamp(projectRaw?.status, 128),
      brief_status: clamp(projectRaw?.brief_status, 128),
      next_actions_v2: Array.isArray(projectRaw?.next_actions_v2) ? projectRaw.next_actions_v2.slice(0, 12) : [],
    },
    history,
  }
}

async function resolveRoute(llm: LlmFace, preference: string): Promise<{ provider: string; model: string }> {
  const providers = llm.listProviders()
  if (providers.length === 0) throw new Error('Harness model is unavailable')
  const preferred = preference.trim()
  const split = /^([^/:]+)[/:](.+)$/.exec(preferred)
  if (split !== null && providers.some(provider => provider.id === split[1])) {
    return { provider: split[1]!, model: split[2]! }
  }
  for (const provider of providers) {
    let models: Awaited<ReturnType<LlmFace['listModels']>> = []
    try { models = await llm.listModels(provider.id) } catch { continue }
    if (preferred !== '') {
      const exact = models.find(model => model.id === preferred)
      if (exact !== undefined) return { provider: provider.id, model: exact.id }
    } else if (models[0] !== undefined) {
      return { provider: provider.id, model: models[0].id }
    }
  }
  if (preferred !== '' && providers.length === 1) return { provider: providers[0]!.id, model: preferred }
  throw new Error('Harness model is unavailable')
}

function promptFor(input: HarnessChatTurnRequest): { system: string; user: string } {
  const projection = JSON.stringify({
    project_id: input.project.project_id,
    name: input.project.name,
    status: input.project.status,
    brief_status: input.project.brief_status,
    next_actions_v2: input.project.next_actions_v2,
  }).slice(0, MAX_PROJECTION)
  const history = (input.history ?? []).map(message => `${message.role}: ${message.text}`).join('\n')
  const language = input.locale === 'en' ? 'English' : 'Simplified Chinese'
  return {
    system: `You are the conversational research guide inside dsh Scholar. Answer in ${language}. You receive a read-only project projection and bounded conversation history. Explain research questions freely and use the authoritative next_actions_v2 for the next-step context. You have no tools and must not claim that you executed a command, changed project state, approved a Gate, confirmed a Brief, adopted an Intake, or released anything. If useful, suggest at most one direct top-level slash command from: /help /new /list /status /survey /ideas /gates /jobs /reproduce /contract /run /evidence /claims /write /review /release-bundle. Never suggest a Human-only confirmation or release decision, use /research, or invent a command. Return JSON only: {"assistant_text":"...","suggested_command":"/..."}. Omit suggested_command when none is useful.`,
    user: `Project projection:\n${projection}\n\nRecent conversation:\n${history || '(none)'}\n\nCurrent user message:\n${input.text}`,
  }
}

function parseReply(text: string): HarnessChatTurnReply {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { throw new Error('Harness model is unavailable') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Harness model is unavailable')
  const value = parsed as Record<string, unknown>
  const assistant = clamp(value.assistant_text, MAX_ANSWER)
  if (assistant === '') throw new Error('Harness model is unavailable')
  const suggested = clamp(value.suggested_command, 8_192)
  return suggested === '' ? { assistant_text: assistant } : { assistant_text: assistant, suggested_command: suggested }
}

/** Build a tool-free, one-shot Harness model adapter for the Scholar Host RPC. */
export function createHarnessChatTurn(
  llm: LlmFace,
  modelPreference: () => string,
): (input: unknown, signal?: AbortSignal) => Promise<HarnessChatTurnReply> {
  return async (inputValue, signal) => {
    const input = safeRequest(inputValue)
    const route = await resolveRoute(llm, modelPreference())
    const prompt = promptFor(input)
    // Keep @deepseek-ai/dsh-llm an optional peer at plugin load time. This
    // runtime helper is only imported after Cordis has actually provided llm.
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm/message')
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      system: prompt.system,
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt.user }], source: { kind: 'user' } })],
      maxTokens: 900,
      temperature: 0.2,
      signal,
    }
    let text = ''
    let blockText = ''
    try {
      for await (const chunk of llm.stream(options)) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'block-end' && chunk.block.type === 'text') blockText += chunk.block.text
        if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          throw new Error('Harness model is unavailable')
        }
        if (text.length > MAX_ANSWER * 2 || blockText.length > MAX_ANSWER * 2) throw new Error('Harness model is unavailable')
      }
    } catch {
      throw new Error('Harness model is unavailable')
    }
    return parseReply(text === '' ? blockText : text)
  }
}
