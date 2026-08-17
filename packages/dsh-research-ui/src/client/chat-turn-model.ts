import type { NextActionV2 } from './types'
import { CHAT_COMMANDS } from './modals/commands'

export interface ChatTurnProjection {
  project?: { project_id?: string; name?: string; status?: string; brief_status?: string }
  next_actions_v2?: NextActionV2[]
}

export interface ProjectStageGuidance {
  status: string
  code: string
  label: string
  reason: string
  requiredBy: string
  route: string
  state: string
  required: true | string[]
}

export type NaturalChatPlan =
  | { kind: 'command'; intentCode: string; command: string; effect: 'read' | 'agent-write'; actionCode?: string }
  | { kind: 'conversation'; intentCode: string; effect: 'none' | 'human-only' | 'agent-write'; suggestedCommand?: string }

const COMMAND_NAMES = new Set(CHAT_COMMANDS.map(([name]) => name))
const HUMAN_ONLY_COMMANDS = new Set(['confirm-brief', 'release'])

/** Model or heuristic output may suggest, but never execute, one direct command. */
export function safeSuggestedChatCommand(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const command = value.trim()
  if (command.length === 0 || command.length > 8_192) return undefined
  const match = /^\/([a-z][a-z0-9-]*)(?:\s|$)/.exec(command)
  if (match === null || !COMMAND_NAMES.has(match[1]!) || HUMAN_ONLY_COMMANDS.has(match[1]!)) return undefined
  return command
}

function normalized(text: string): string {
  return text.trim().toLocaleLowerCase('en-US')
}

function actionReady(projection: ChatTurnProjection, code: string): boolean {
  return (projection.next_actions_v2 ?? []).some(action => action.code === code && action.state === 'ready'
    && action.required === true && action.required_by === 'agent')
}

function readyNoArgumentCommand(projection: ChatTurnProjection): { code: string; command: string } | null {
  const commands: Record<string, string> = {
    contract_register: '/contract draft',
    manuscript_write: '/write',
    reviewer_run: '/review',
    release_bundle: '/release-bundle',
  }
  const action = (projection.next_actions_v2 ?? []).find(item =>
    typeof item.code === 'string' && item.state === 'ready' && item.required === true && commands[item.code] !== undefined)
  if (action === undefined || typeof action.code !== 'string') return null
  const command = commands[action.code]
  return command === undefined ? null : { code: action.code, command }
}

function surveyQuery(text: string): string {
  return text.trim()
    .replace(/^(?:请|帮我|麻烦)?\s*(?:调研|检索(?:文献)?|搜索(?:论文|文献)?|survey|research)\s*[:：-]?\s*/i, '')
    .trim()
}

function requestedIdeaCount(text: string): number {
  const digit = /(?:生成|创建|提出|想出|generate|create|propose)\D{0,8}([1-5])\s*(?:个|条|种)?\s*(?:想法|创意|假设|ideas?|hypotheses)?/i.exec(text)?.[1]
  if (digit !== undefined) return Number(digit)
  const chinese = /(?:生成|创建|提出|想出)\D{0,8}([一二三四五])\s*(?:个|条|种)?/.exec(text)?.[1]
  return chinese === undefined ? 3 : ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 } as const)[chinese as '一' | '二' | '三' | '四' | '五']
}

function explicitIdeaGeneration(text: string): boolean {
  const normalizedText = text.normalize('NFKC').trim()
  const negative = /(?:(?:不要|别|无需|不需要|停止|取消|避免).{0,20}(?:生成|创建|提出|想出|构思).{0,40}(?:想法|创意|假设|ideas?|hypotheses)|\b(?:do\s+not|don't|dont|stop|cancel|avoid)\b.{0,24}\b(?:generate|create|propose)\b.{0,30}\b(?:ideas?|hypotheses)\b)/i
  if (negative.test(normalizedText)) return false
  return /^(?:(?:请|帮我|请帮我|麻烦|请你|我想(?:让你)?|我需要你|能否|可以(?:帮我)?)\s*)?(?:给我\s*)?(?:生成|创建|提出|想出|构思).{0,40}(?:想法|创意|假设|ideas?|hypotheses)/i.test(normalizedText)
    || /^(?:please\s+|could\s+you\s+|can\s+you\s+|i\s+(?:want|need)\s+you\s+to\s+)?(?:generate|create|propose)\s+.{0,30}(?:ideas?|hypotheses)(?:\b|$)/i.test(normalizedText)
}

/**
 * Deterministic natural-language intent adapter. It never invents project
 * state or permissions: mutating routes are only executable when the same
 * code is ready in the kernel-authored NextAction projection.
 */
export function planNaturalChatTurn(text: string, projection: ChatTurnProjection): NaturalChatPlan {
  const input = normalized(text)
  if (/(?:批准|同意|拒绝|决定).*(?:gate|审批|门控)|(?:gate|审批|门控).*(?:批准|同意|拒绝|决定)|\bapprove\b|\breject\b/.test(input)) {
    return { kind: 'conversation', intentCode: 'human_gate', effect: 'human-only' }
  }
  if (/(?:发布|release).*(?:批准|决定|确认)|(?:批准|决定|确认).*(?:发布|release)/.test(input)) {
    return { kind: 'conversation', intentCode: 'human_release', effect: 'human-only' }
  }
  if (/(?:确认|提交).*(?:brief|研究简报)|(?:brief|研究简报).*(?:确认|提交)|\bconfirm\s+(?:the\s+)?brief\b/.test(input)) {
    return { kind: 'conversation', intentCode: 'human_brief_confirm', effect: 'human-only' }
  }
  if (/(?:接纳|采纳|合并|导入).*(?:intake|材料|研究)|\badopt(?:ion)?\b|\baccept\s+intake\b/.test(input)) {
    return { kind: 'conversation', intentCode: 'human_intake_adopt', effect: 'human-only' }
  }
  if (/(?:状态|进展|进度|下一步|该做什么|现在做什么)|\b(?:status|progress|next\s+step|what\s+next)\b/.test(input)) {
    return { kind: 'command', intentCode: 'status', command: '/status', effect: 'read' }
  }
  if (/^(?:请|帮我|请帮我)?\s*(?:继续|推进|执行下一步|开始下一步)(?:研究|执行|吧|下去)?$|^(?:please\s+)?(?:continue|proceed|run\s+the\s+next\s+step)$/i.test(input)) {
    const next = readyNoArgumentCommand(projection)
    if (next !== null) return { kind: 'command', intentCode: 'continue', command: next.command, effect: 'agent-write', actionCode: next.code }
    return { kind: 'conversation', intentCode: 'continue', effect: 'agent-write' }
  }
  if (explicitIdeaGeneration(input)) {
    const command = `/ideas generate ${requestedIdeaCount(input)}`
    return actionReady(projection, 'idea_generate')
      ? { kind: 'command', intentCode: 'idea_generate', command, effect: 'agent-write', actionCode: 'idea_generate' }
      : { kind: 'conversation', intentCode: 'idea_generate', effect: 'agent-write', suggestedCommand: command }
  }
  if (/(?:生成|创建|起草|准备|拟定).{0,12}(?:实验)?合同|(?:draft|create|prepare)\s+(?:the\s+)?(?:experiment\s+)?contract/i.test(input)) {
    return actionReady(projection, 'contract_register')
      ? { kind: 'command', intentCode: 'contract_register', command: '/contract draft', effect: 'agent-write', actionCode: 'contract_register' }
      : { kind: 'conversation', intentCode: 'contract_register', effect: 'agent-write', suggestedCommand: '/contract draft' }
  }
  if (/(?:想法|创意|idea|hypothesis)/.test(input)) {
    return { kind: 'command', intentCode: 'ideas', command: '/ideas', effect: 'read' }
  }
  if (/(?:审批|门控|\bgates?\b)/.test(input)) {
    return { kind: 'command', intentCode: 'gates', command: '/gates', effect: 'read' }
  }
  if (/(?:运行任务|运行作业|任务状态|作业状态|运行记录)|\b(?:jobs?|runs?)\s*(?:status|list)?\b/.test(input)) {
    return { kind: 'command', intentCode: 'jobs', command: '/jobs', effect: 'read' }
  }
  if (/(?:论断|主张|claims?)/.test(input)) {
    return { kind: 'command', intentCode: 'claims', command: '/claims', effect: 'read' }
  }
  if (/^(?:请|帮我|麻烦)?\s*(?:调研|检索(?:文献)?|搜索(?:论文|文献)?|survey(?:\s|$)|research(?:\s|$))/i.test(text.trim())) {
    const query = surveyQuery(text)
    const command = `/survey${query === '' ? ' ' : ` ${query}`}`
    if (query !== '' && actionReady(projection, 'survey_run')) {
      return { kind: 'command', intentCode: 'survey', command, effect: 'agent-write', actionCode: 'survey_run' }
    }
    return { kind: 'conversation', intentCode: 'survey', effect: 'agent-write', suggestedCommand: command }
  }
  if (/(?:准备|启动|运行|执行|复现).{0,8}(?:基线|baseline)|(?:prepare|start|run|reproduce)\s+(?:the\s+)?baseline/i.test(input)) {
    return { kind: 'conversation', intentCode: 'baseline_reproduce', effect: 'agent-write', suggestedCommand: '/reproduce' }
  }
  if (/(?:运行实验|开始实验|执行实验|run\s+(?:an?\s+)?experiment)/.test(input)) {
    return { kind: 'conversation', intentCode: 'run', effect: 'agent-write', suggestedCommand: '/run ' }
  }
  if (/(?:复现论文|论文复现|reproduce)/.test(input)) {
    return { kind: 'conversation', intentCode: 'reproduce', effect: 'agent-write', suggestedCommand: '/reproduce ' }
  }
  if (/(?:写论文|写作|生成稿件|write\s+(?:the\s+)?paper)/.test(input)) {
    return actionReady(projection, 'manuscript_write')
      ? { kind: 'command', intentCode: 'write', command: '/write', effect: 'agent-write', actionCode: 'manuscript_write' }
      : { kind: 'conversation', intentCode: 'write', effect: 'agent-write', suggestedCommand: '/write' }
  }
  if (/(?:审阅稿件|评审稿件|检查论文|review\s+(?:the\s+)?(?:paper|manuscript))/.test(input)) {
    return actionReady(projection, 'reviewer_run')
      ? { kind: 'command', intentCode: 'review', command: '/review', effect: 'agent-write', actionCode: 'reviewer_run' }
      : { kind: 'conversation', intentCode: 'review', effect: 'agent-write', suggestedCommand: '/review' }
  }
  if (/(?:生成|构建).*(?:发布包|release bundle)|(?:release bundle).*(?:generate|build)/.test(input)) {
    return actionReady(projection, 'release_bundle')
      ? { kind: 'command', intentCode: 'release_bundle', command: '/release-bundle', effect: 'agent-write', actionCode: 'release_bundle' }
      : { kind: 'conversation', intentCode: 'release_bundle', effect: 'agent-write', suggestedCommand: '/release-bundle' }
  }
  return { kind: 'conversation', intentCode: 'freeform', effect: 'none' }
}

/** Pick the primary structured action without interpreting localized labels. */
export function projectStageGuidance(projection: ChatTurnProjection): ProjectStageGuidance | null {
  const actions = Array.isArray(projection.next_actions_v2) ? projection.next_actions_v2 : []
  const action = actions.find(item => item.state === 'ready')
    ?? actions.find(item => item.state === 'blocked')
    ?? actions.find(item => item.state === 'done')
  if (action === undefined) return null
  return {
    status: projection.project?.status ?? '',
    code: action.code ?? 'unknown',
    label: action.label ?? action.code ?? 'unknown',
    reason: action.reason ?? '',
    requiredBy: action.required_by ?? '',
    route: action.route ?? 'overview',
    state: action.state ?? 'blocked',
    required: action.required === true || Array.isArray(action.required) ? action.required : [],
  }
}
