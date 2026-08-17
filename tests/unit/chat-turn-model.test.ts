import { describe, expect, it } from 'vitest'
import { planNaturalChatTurn, projectStageGuidance, safeSuggestedChatCommand } from '../../packages/dsh-research-ui/src/client/chat-turn-model'

const projection = {
  project: { status: 'SCOPED' },
  next_actions_v2: [{
    id: 'survey_run:rsp_a', code: 'survey_run', label: 'Run survey', reason: 'Corpus required',
    required: true, route: 'chat', state: 'ready', blocking: true, required_by: 'agent', revision: 2,
  }],
}

describe('project-scoped natural Chat turn planning', () => {
  it('routes read-only Chinese and English intents to canonical direct commands', () => {
    expect(planNaturalChatTurn('现在进展怎么样？', projection)).toMatchObject({ kind: 'command', command: '/status', effect: 'read' })
    expect(planNaturalChatTurn('show me current ideas', projection)).toMatchObject({ kind: 'command', command: '/ideas', effect: 'read' })
    expect(planNaturalChatTurn('看看审批', projection)).toMatchObject({ kind: 'command', command: '/gates', effect: 'read' })
    expect(planNaturalChatTurn('查看运行任务', projection)).toMatchObject({ kind: 'command', command: '/jobs', effect: 'read' })
  })

  it('routes an explicit survey intent only when the authoritative action is ready', () => {
    expect(planNaturalChatTurn('调研 temporal localization', projection)).toMatchObject({
      kind: 'command', command: '/survey temporal localization', effect: 'agent-write', actionCode: 'survey_run',
    })
    expect(planNaturalChatTurn('调研 temporal localization', {
      ...projection,
      next_actions_v2: [{ ...projection.next_actions_v2[0]!, state: 'blocked', required: ['scope_gate'] }],
    })).toMatchObject({ kind: 'conversation', suggestedCommand: '/survey temporal localization' })
  })

  it('never auto-executes human-only, ambiguous or parameter-incomplete requests', () => {
    expect(planNaturalChatTurn('帮我批准这个 gate', projection)).toMatchObject({ kind: 'conversation', effect: 'human-only' })
    expect(planNaturalChatTurn('确认这份 Brief', projection)).toMatchObject({ kind: 'conversation', effect: 'human-only' })
    expect(planNaturalChatTurn('采纳导入的研究材料', projection)).toMatchObject({ kind: 'conversation', effect: 'human-only' })
    expect(planNaturalChatTurn('运行实验', projection)).toMatchObject({ kind: 'conversation', suggestedCommand: '/run ' })
    expect(planNaturalChatTurn('我想讨论指标选择', projection)).toMatchObject({ kind: 'conversation', effect: 'none' })
  })

  it('executes an explicit parameter-free next-stage request only when Kernel guidance marks it ready', () => {
    const writing = {
      project: { status: 'EVIDENCE_READY' },
      next_actions_v2: [{
        ...projection.next_actions_v2[0]!, code: 'manuscript_write', label: 'Write manuscript',
      }],
    }
    expect(planNaturalChatTurn('请写论文', writing)).toMatchObject({
      kind: 'command', command: '/write', effect: 'agent-write', actionCode: 'manuscript_write',
    })
    expect(planNaturalChatTurn('继续', writing)).toMatchObject({ kind: 'command', command: '/write' })
    expect(planNaturalChatTurn('请写论文', {
      ...writing,
      next_actions_v2: [{ ...writing.next_actions_v2[0]!, state: 'blocked', required: ['evidence'] }],
    })).toMatchObject({ kind: 'conversation', suggestedCommand: '/write' })
  })

  it('derives guidance from structured NextAction rather than status labels', () => {
    expect(projectStageGuidance(projection)).toEqual({
      status: 'SCOPED', code: 'survey_run', label: 'Run survey', reason: 'Corpus required',
      requiredBy: 'agent', route: 'chat', state: 'ready', required: true,
    })
  })

  it('keeps only registered non-human direct command suggestions', () => {
    expect(safeSuggestedChatCommand('/run formal {"contract_id":"ctr_1"}')).toBe('/run formal {"contract_id":"ctr_1"}')
    expect(safeSuggestedChatCommand('/research run formal')).toBeUndefined()
    expect(safeSuggestedChatCommand('/confirm-brief')).toBeUndefined()
    expect(safeSuggestedChatCommand('/release')).toBeUndefined()
    expect(safeSuggestedChatCommand('run formal')).toBeUndefined()
  })
})
