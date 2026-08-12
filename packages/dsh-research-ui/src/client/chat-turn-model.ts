import type { NextActionV2 } from './types'

export interface ChatTurnProjection {
  project?: { status?: string }
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

function normalized(text: string): string {
  return text.trim().toLocaleLowerCase('en-US')
}

function actionReady(projection: ChatTurnProjection, code: string): boolean {
  return (projection.next_actions_v2 ?? []).some(action => action.code === code && action.state === 'ready' && action.required === true)
}

function surveyQuery(text: string): string {
  return text.trim()
    .replace(/^(?:请|帮我|麻烦)?\s*(?:调研|检索(?:文献)?|搜索(?:论文|文献)?|survey|research)\s*[:：-]?\s*/i, '')
    .trim()
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
  if (/(?:状态|进展|进度|下一步|该做什么|现在做什么)|\b(?:status|progress|next\s+step|what\s+next)\b/.test(input)) {
    return { kind: 'command', intentCode: 'status', command: '/status', effect: 'read' }
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
  if (/(?:运行实验|开始实验|执行实验|run\s+(?:an?\s+)?experiment)/.test(input)) {
    return { kind: 'conversation', intentCode: 'run', effect: 'agent-write', suggestedCommand: '/run ' }
  }
  if (/(?:复现论文|论文复现|reproduce)/.test(input)) {
    return { kind: 'conversation', intentCode: 'reproduce', effect: 'agent-write', suggestedCommand: '/reproduce ' }
  }
  if (/(?:写论文|写作|生成稿件|write\s+(?:the\s+)?paper)/.test(input)) {
    return { kind: 'conversation', intentCode: 'write', effect: 'agent-write', suggestedCommand: '/write' }
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
