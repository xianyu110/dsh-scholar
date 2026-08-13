import { describe, expect, it } from 'vitest'
import { createHarnessChatTurn } from '../../src/plugin/chat-turn'

describe('Harness-backed Scholar freeform turns', () => {
  it('uses a registered Harness model without tools and returns a validated command suggestion', async () => {
    let captured: Record<string, unknown> | undefined
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      stream: async function * (options: Record<string, unknown>) {
        captured = options
        yield { type: 'text-delta', index: 0, text: '{"assistant_text":"可以先跑一个 formal 实验。",' }
        yield { type: 'text-delta', index: 0, text: '"suggested_command":"/run formal {\\"contract_id\\":\\"ctr_1\\"}"}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const turn = createHarnessChatTurn(llm as never, () => 'deepseek-v4-pro')
    await expect(turn({
      text: '帮我生成运行命令', locale: 'zh',
      project: { project_id: 'rsp_1', name: 'demo', status: 'CONTRACT_APPROVED', brief_status: 'confirmed', next_actions_v2: [] },
      history: [],
    })).resolves.toEqual({
      assistant_text: '可以先跑一个 formal 实验。',
      suggested_command: '/run formal {"contract_id":"ctr_1"}',
    })
    expect(captured?.tools).toBeUndefined()
    expect(captured?.provider).toBe('deepseek')
    expect(captured?.model).toBe('deepseek-v4-pro')
  })

  it('fails closed on a model error instead of fabricating an answer', async () => {
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      stream: async function * () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_DOWN', message: 'secret detail' } } }
      },
    }
    const turn = createHarnessChatTurn(llm as never, () => 'deepseek-v4-pro')
    await expect(turn({
      text: '聊聊指标', locale: 'zh',
      project: { project_id: 'rsp_1', status: 'SCOPED', next_actions_v2: [] }, history: [],
    })).rejects.toThrow('Harness model is unavailable')
  })
})
