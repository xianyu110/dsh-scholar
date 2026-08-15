import { KernelUnavailableError, type ResearchClient } from '@dsh-scholar/research-client'
import { createHash } from 'node:crypto'
import { buildPassages, multiSourceSearch, type ConnectorCache } from '@dsh-scholar/scholar-connectors'
import {
  buildScholarSessionProjection,
  normalizeDshSessionId,
  type ProjectionLike,
  type ScholarNextAction,
  type ScholarSessionProjection,
} from '../shared/research-stage.js'

export type ScholarNativeLocale = 'zh' | 'en'
export type ScholarNativeIntent = 'create' | 'status' | 'next' | 'gates' | 'jobs' | 'ideas' | 'survey' | 'conversation'

export interface ScholarNativeReply extends ScholarSessionProjection {
  assistant_text: string
  intent: { kind: ScholarNativeIntent; confidence: 'deterministic' }
  execution: {
    status: 'read_only' | 'executed' | 'suggested' | 'blocked' | 'needs_human' | 'needs_project'
    operation: string | null
    suggested_command: string | null
  }
}

const READ_PATTERNS: Array<[ScholarNativeIntent, RegExp]> = [
  ['gates', /(?:gate|审批|审核|关卡)/i],
  ['jobs', /(?:jobs?|run (?:status|list)|任务|运行(?:情况|状态|列表|任务)|实验状态)/i],
  ['ideas', /(?:(?:有哪些|查看|列出).{0,8}(?:想法|创意|假设)|(?:show|list|what).{0,12}ideas?)/i],
  ['status', /(?:status|progress|阶段|进度|状态|到哪)/i],
  ['next', /(?:what next|next step|下一步|接下来)/i],
]
// DSH-CREATE-LINK-01 is deliberately conservative: only an anchored,
// affirmative command can authorize creation. Name words are parsed after
// the command, so legitimate names such as “风险评估” or “What” are not
// mistaken for questions/negation.
const ZH_CREATE_COMMAND = /^(?:(?:请|请帮我|帮我)\s*)?(?:创建|新建|建立|发起)\s*(?:(?:一个|个)\s*)?(?:(?:新|新的)\s*)?(?:研究项目|项目)(?:\s*(?:(?:名称|名为|叫)\s*)?[：:]?\s*(.+))?$/u
const EN_CREATE_COMMAND = /^(?:please\s+)?(?:create|start|open|begin)\s+(?:(?:a|the)\s+)?(?:new\s+)?(?:research\s+)?project(?:\s+(?:(?:named|called)\s+)?(.+))?$/i
const AMBIGUOUS_CREATE_NAME = /(?:[,，;；]|不要|不想|不需要|无需|无须|不\s*(?:进行\s*)?(?:应(?:该)?\s*)?(?:创建|新建|建立|发起)|先\s*(?:别|勿)\s*(?:创建|新建|建立|发起)|(?:^|\s)(?:别|勿)\s*(?:创建|新建|建立|发起)|取消|停止|避免|暂缓|而不是|不叫|改成|还是|或者|(?:然后|随后|接着|并且)\s*(?:不要|不|先|再|请|查看|检查|继续|开始|停止|取消|避免|执行|创建|新建|建立|发起)|(?:^|\s)并\s*(?:不要|不|先|再|请|查看|检查|继续|开始|停止|取消|避免|执行|创建|新建|建立|发起)|\b(?:do\s+not|don't|dont|not)\s+(?:create|start|open|begin)\b|\b(?:and|then)\s+(?:do\s+not|don't|dont|not|cancel|stop|avoid|show|list|check|continue|proceed|create|start|open|begin)\b|\b(?:never|cancel|stop|avoid|without|rather\s+than|instead\s+of|but\s+not|or)\b)/i
const NEGATIVE_SURVEY_PATTERN = /(?:(?:不要|不需要|无需|别|停止|取消|避免).{0,12}(?:调研|文献检索|搜索文献|研究)|(?:do\s+not|don't|dont|not|stop|cancel|avoid)\s+(?:run(?:ning)?\s+)?(?:a\s+|the\s+)?(?:survey|literature search|research))/i
const EXPLICIT_SURVEY_PATTERN = /(?:^(?:(?:请|帮我|请帮我)\s*)?(?:(?:开始|继续|执行|进行)\s*)?(?:调研|文献检索|搜索文献)(?:一下|下去)?(?:\s|$)|^(?:我)?(?:要|想要)\s*(?:开始|继续|执行|进行)\s*(?:调研|文献检索|搜索文献)(?:\s|$)|(?:^|\b)(?:please\s+)?(?:run|start|continue|perform|conduct|do)\s+(?:a\s+|the\s+)?(?:survey|literature search|research)(?:\b|$))/i
const IDEA_WRITE_PATTERN = /(?:^(?:(?:请|帮我|请帮我)\s*)?(?:生成|创建|提出).{0,12}(?:想法|创意|假设)|^(?:please\s+)?(?:generate|create|propose)\s+(?:research\s+)?ideas?(?:\b|$))/i
const CONTINUE_PATTERN = /(?:^|\b)(?:continue|proceed)(?:\b|$)|继续(?:推进|执行|研究|调研)?(?:吧|下去)?$/i

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new Error('aborted')
}

export function nativeLocale(text: string, explicit?: unknown): ScholarNativeLocale {
  if (explicit === 'zh' || explicit === 'en') return explicit
  return /[\u3400-\u9fff]/u.test(text) ? 'zh' : 'en'
}

export function classifyNativeIntent(text: string, primary?: Pick<ScholarNextAction, 'code' | 'state'>): ScholarNativeIntent {
  if (parseExplicitCreateCommand(text).matched) return 'create'
  if (!NEGATIVE_SURVEY_PATTERN.test(text) && EXPLICIT_SURVEY_PATTERN.test(text)) return 'survey'
  if (IDEA_WRITE_PATTERN.test(text)) return 'ideas'
  for (const [intent, pattern] of READ_PATTERNS) {
    if (pattern.test(text)) return intent
  }
  if (!NEGATIVE_SURVEY_PATTERN.test(text) && CONTINUE_PATTERN.test(text)) {
    return primary?.code === 'survey_run' && primary.state === 'ready' ? 'survey' : 'next'
  }
  return 'conversation'
}

function normalizeProjectName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const name = value.normalize('NFKC').trim()
  if (name === '' || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error('dsh_scholar project_name must contain 1–120 safe characters')
  }
  return name
}

function parseExplicitCreateCommand(text: string): { matched: boolean; name?: string } {
  const normalized = text.normalize('NFKC').trim()
  if (/[?？]/u.test(normalized) || /(?:吗|么|呢)\s*[。！!]*$/u.test(normalized)) return { matched: false }
  const withoutTerminal = normalized.replace(/[。！!.]\s*$/u, '').trim()
  const match = ZH_CREATE_COMMAND.exec(withoutTerminal) ?? EN_CREATE_COMMAND.exec(withoutTerminal)
  if (match === null) return { matched: false }
  const rawName = match[1]?.trim()
  if (rawName === undefined || rawName === '') return { matched: true }
  if (AMBIGUOUS_CREATE_NAME.test(rawName)) return { matched: false }
  const quotePairs: Array<[string, string]> = [['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"]]
  let unquoted = rawName
  for (const [open, close] of quotePairs) {
    if (unquoted.startsWith(open) && unquoted.endsWith(close) && unquoted.length >= open.length + close.length) {
      unquoted = unquoted.slice(open.length, -close.length).trim()
      break
    }
  }
  return { matched: true, name: normalizeProjectName(unquoted) }
}

function projectCreateIdempotencyKey(sessionId: string, name: string): string {
  const digest = createHash('sha256').update(`${sessionId}\u0000${name}`).digest('hex')
  return `dsh-create:${digest}`
}

export function suggestedCommand(action: ScholarNextAction | undefined, query = ''): string | null {
  if (action === undefined) return '/status'
  const map: Record<string, string | undefined> = {
    survey_run: `/survey ${query}`.trimEnd(),
    idea_generate: '/ideas',
    baseline_reproduce: '/reproduce ',
    contract_register: '/contract ',
    pilot_formal_submit: '/run ',
    evidence_verify: '/evidence',
    manuscript_write: '/write',
    reviewer_run: '/review',
    release_bundle: '/release-bundle',
  }
  return map[action.code] ?? null
}

function surveyQuery(text: string, project: ProjectionLike['project'] & { brief?: { problem?: unknown } }): string {
  const stripped = text
    .replace(/^(?:请|帮我|please|could you|can you)\s*/i, '')
    .replace(/^(?:开始|继续|进行|run|start|continue)?\s*(?:调研|文献检索|survey|research|literature search)\s*/i, '')
    .trim()
  if (stripped !== '') return stripped
  const problem = project.brief?.problem
  return typeof problem === 'string' && problem.trim() !== '' ? problem.trim() : project.name
}

function replyText(locale: ScholarNativeLocale, snapshot: ScholarSessionProjection, status: ScholarNativeReply['execution']['status']): string {
  if (!snapshot.linked) return locale === 'zh'
    ? '当前 DSH 会话还没有关联研究项目。请先使用 /new <项目名>，之后可以继续用自然语言推进研究。'
    : 'This DSH session is not linked to a research project yet. Start with /new <project name>, then continue in natural language.'
  const project = snapshot.project!
  const next = snapshot.next_action
  const nextText = next === undefined ? (locale === 'zh' ? '暂无下一步动作' : 'no next action') : `${next.code} (${next.state}, ${next.required_by})`
  if (status === 'executed') return locale === 'zh'
    ? `已按本次对话完成调研快照。项目“${project.name}”现在处于 ${project.status}，下一步是 ${nextText}。可打开 dsh Scholar 查看完整阶段和产物。`
    : `The survey snapshot was completed from this turn. “${project.name}” is now at ${project.status}; next: ${nextText}. Open dsh Scholar for the full timeline and artifacts.`
  if (status === 'needs_human') return locale === 'zh'
    ? `项目“${project.name}”处于 ${project.status}，下一步 ${nextText} 需要人工完成。请在 dsh Scholar 中处理对应页面。`
    : `“${project.name}” is at ${project.status}. The next action, ${nextText}, requires a human in dsh Scholar.`
  if (status === 'blocked') return locale === 'zh'
    ? `项目“${project.name}”处于 ${project.status}，当前动作受阻：${next?.reason ?? '请查看权威下一步'}。`
    : `“${project.name}” is at ${project.status}. The current action is blocked: ${next?.reason ?? 'check the authoritative next action'}.`
  return locale === 'zh'
    ? `项目“${project.name}”当前处于 ${project.status}（rev ${project.revision}），下一步是 ${nextText}。你可以继续直接描述要做的研究工作。`
    : `“${project.name}” is at ${project.status} (rev ${project.revision}); next: ${nextText}. You can keep describing the research work in natural language.`
}

function projectCreatedText(locale: ScholarNativeLocale, snapshot: ScholarSessionProjection): string {
  const project = snapshot.project!
  return locale === 'zh'
    ? `已在当前 DSH 会话创建并关联研究项目“${project.name}”。项目正处于 Init 信息收集阶段；请继续回答 Grill Me 问题，或打开 dsh Scholar 查看阶段和材料。`
    : `Created and linked “${project.name}” to this DSH session. The project is collecting its Init brief; continue with Grill Me or open dsh Scholar for stages and materials.`
}

function projectNameRequiredText(locale: ScholarNativeLocale): string {
  return locale === 'zh'
    ? '可以直接在当前 DSH 会话创建研究项目。请告诉我项目的准确名称，例如“创建研究项目 OCR 复现”。'
    : 'I can create the research project directly in this DSH session. Please give its exact name, for example: “Create a research project named OCR Reproduction.”'
}

export async function runNativeScholarTurn(input: {
  text: string
  projectName?: string
  projectId?: string
  locale?: unknown
  sessionId?: string
  client: ResearchClient
  cache: ConnectorCache
  search?: typeof multiSourceSearch
  signal?: AbortSignal
}): Promise<ScholarNativeReply> {
  const text = input.text.trim()
  if (text === '' || text.length > 4000) throw new Error('dsh_scholar text must contain 1–4000 characters')
  const sessionId = normalizeDshSessionId(input.sessionId)
  if (sessionId === undefined) throw new Error('dsh_scholar requires a valid DSH session')
  const locale = nativeLocale(text, input.locale)
  const projectName = normalizeProjectName(input.projectName)
  assertNotAborted(input.signal)
  const linked = await input.client.getProjectBySession(sessionId, input.signal)
  assertNotAborted(input.signal)
  if (linked === null) {
    if (input.projectId !== undefined && input.projectId !== '') throw new Error('project_id is not linked to the calling DSH session')
    const createCommand = parseExplicitCreateCommand(text)
    const intent = createCommand.matched ? 'create' : classifyNativeIntent(text)
    if (projectName !== undefined && intent === 'create' && createCommand.name === projectName) {
      const finishFromAuthority = async (projectId: string): Promise<ScholarNativeReply> => {
        const confirmed = await input.client.getProjectBySession(sessionId)
        if (confirmed?.project_id !== projectId || normalizeProjectName(confirmed.name) !== projectName || confirmed.brief_status !== 'collecting') {
          throw new Error('DSH session link changed during project creation')
        }
        const projection = await input.client.projectProjection(projectId) as ProjectionLike
        const snapshot = buildScholarSessionProjection(sessionId, projection)
        return {
          ...snapshot,
          assistant_text: projectCreatedText(locale, snapshot),
          intent: { kind: 'create', confidence: 'deterministic' },
          execution: { status: 'executed', operation: 'project_create', suggested_command: null },
        }
      }
      try {
        const created = await input.client.createProjectForDshSession({
          session_id: sessionId,
          name: projectName,
          idempotency_key: projectCreateIdempotencyKey(sessionId, projectName),
        }, input.signal)
        // The POST is the commit boundary. All reconciliation deliberately
        // ignores the caller signal so a post-commit abort is not reported as
        // zero-write cancellation.
        return await finishFromAuthority(created.project.project_id)
      } catch (originalError) {
        if (!(originalError instanceof KernelUnavailableError)) throw originalError
        try {
          // A transport can fail after SQLite COMMIT but before the response
          // reaches DSH. Replay-only proves this exact idempotency receipt;
          // when it is absent the Kernel performs zero writes.
          const replay = await input.client.createProjectForDshSession({
            session_id: sessionId,
            name: projectName,
            idempotency_key: projectCreateIdempotencyKey(sessionId, projectName),
            replay_only: true,
          })
          return await finishFromAuthority(replay.project.project_id)
        } catch { /* preserve the original transport/conflict error */ }
        throw originalError
      }
    }
    const snapshot = buildScholarSessionProjection(sessionId)
    const asksForCreateName = intent === 'create'
    return {
      ...snapshot,
      assistant_text: asksForCreateName ? projectNameRequiredText(locale) : replyText(locale, snapshot, 'needs_project'),
      intent: { kind: intent, confidence: 'deterministic' },
      execution: { status: 'needs_project', operation: null, suggested_command: asksForCreateName ? null : '/new <项目名>' },
    }
  }
  if (input.projectId !== undefined && input.projectId !== '' && input.projectId !== linked.project_id) {
    throw new Error('project_id is not linked to the calling DSH session')
  }
  let projection = await input.client.projectProjection(linked.project_id, input.signal) as ProjectionLike
  assertNotAborted(input.signal)
  const projectionLink = await input.client.getProjectBySession(sessionId, input.signal)
  assertNotAborted(input.signal)
  if (projectionLink?.project_id !== linked.project_id) throw new Error('DSH session link changed during the request')
  let snapshot = buildScholarSessionProjection(sessionId, projection)
  const intent = classifyNativeIntent(text, snapshot.next_action)
  let status: ScholarNativeReply['execution']['status'] = 'read_only'
  let operation: string | null = intent === 'conversation' ? 'research_status' : `research_${intent}`
  let command: string | null = null
  const primary = snapshot.next_action

  if (intent === 'survey') {
    const query = surveyQuery(text, projection.project as ProjectionLike['project'] & { brief?: { problem?: unknown } })
    if (primary?.code === 'survey_run' && primary.state === 'ready' && primary.required_by === 'agent') {
      const result = await (input.search ?? multiSourceSearch)(query, { limit: 20 }, input.cache)
      assertNotAborted(input.signal)
      // Search is external and may outlive the projection that authorized it.
      // Re-read before the commit and pin the exact revision in the Kernel
      // transaction so a Gate/state race cannot snapshot the wrong phase.
      const revalidated = await input.client.projectProjection(linked.project_id, input.signal) as ProjectionLike
      assertNotAborted(input.signal)
      const revalidatedLink = await input.client.getProjectBySession(sessionId, input.signal)
      assertNotAborted(input.signal)
      if (revalidatedLink?.project_id !== linked.project_id) throw new Error('DSH session link changed during the request')
      const revalidatedSnapshot = buildScholarSessionProjection(sessionId, revalidated)
      const latest = revalidatedSnapshot.next_action
      if (revalidated.project.project_id !== linked.project_id
        || revalidated.project.revision !== projection.project.revision
        || latest?.code !== 'survey_run' || latest.state !== 'ready' || latest.required_by !== 'agent') {
        projection = revalidated
        snapshot = revalidatedSnapshot
        if (latest?.state === 'blocked') status = 'blocked'
        else if (latest?.required_by === 'human') status = 'needs_human'
        else status = 'suggested'
        operation = latest?.code ?? 'survey_run'
        command = status === 'suggested' ? (suggestedCommand(latest, query) ?? `/survey ${query}`) : null
      } else {
        const papers = result.hits.map(hit => hit.paper)
        assertNotAborted(input.signal)
        // Commit boundary: after this mutation begins cancellation cannot
        // truthfully mean zero writes. The expected_revision CAS remains the
        // atomic state fence; post-commit reconciliation is deliberately not
        // tied to the now-cancelled caller signal.
        await input.client.snapshotCorpus({
          project_id: linked.project_id,
          expected_revision: revalidated.project.revision,
          expected_session_id: sessionId,
          queries: result.queries,
          papers,
          passages: buildPassages(papers),
          citation_edges: result.citation_edges,
          source_status: result.source_status.some(source => source.status === 'failed') ? 'pending' : 'complete',
        })
        projection = await input.client.projectProjection(linked.project_id) as ProjectionLike
        snapshot = buildScholarSessionProjection(sessionId, projection)
        status = 'executed'
        operation = 'survey_run'
      }
    } else if (primary?.state === 'blocked') {
      status = 'blocked'
      operation = primary?.code ?? 'survey_run'
    } else if (primary?.required_by === 'human') {
      status = 'needs_human'
      operation = primary.code
    } else {
      status = 'suggested'
      operation = primary?.code ?? 'survey_run'
      command = suggestedCommand(primary, query) ?? `/survey ${query}`
    }
  } else if (intent === 'ideas' && IDEA_WRITE_PATTERN.test(text)) {
    if (primary?.state === 'blocked') status = 'blocked'
    else if (primary?.required_by === 'human') status = 'needs_human'
    else {
      status = 'suggested'
      command = '/ideas'
    }
    operation = primary?.code ?? 'idea_generate'
  } else if (intent === 'create') {
    status = 'blocked'
    operation = 'project_create'
  } else if (intent === 'next' || intent === 'conversation') {
    if (primary?.state === 'blocked') status = 'blocked'
    else if (primary?.required_by === 'human') status = 'needs_human'
    else if (primary?.state === 'ready' && !NEGATIVE_SURVEY_PATTERN.test(text)) {
      status = 'suggested'
      command = suggestedCommand(primary)
    }
    operation = primary?.code ?? operation
  }

  const assistantText = intent === 'create' && status === 'blocked'
    ? (locale === 'zh'
        ? `当前 DSH 会话已关联项目“${snapshot.project!.name}”。如需创建另一个项目，请新建 DSH 会话，系统不会静默替换当前关联。`
        : `This DSH session is already linked to “${snapshot.project!.name}”. Start a new DSH session for another project; the current link will not be replaced silently.`)
    : command === null ? replyText(locale, snapshot, status) : `${replyText(locale, snapshot, status)} ${locale === 'zh' ? '建议命令' : 'Suggested command'}: ${command}`
  return {
    ...snapshot,
    assistant_text: assistantText,
    intent: { kind: intent, confidence: 'deterministic' },
    execution: { status, operation, suggested_command: command },
  }
}
