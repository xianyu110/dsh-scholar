import { describe, expect, it } from 'vitest'
import { createHarnessScholarAgent } from '../../src/plugin/chat-agent'

const project = {
  project_id: 'rsp_1', name: 'cnn test', status: 'SURVEYING', brief_status: 'confirmed',
  brief: { problem: 'improve low-data CNN robustness' }, next_actions_v2: [],
}

describe('Harness-backed Scholar agent boundary', () => {
  it('returns a validated free conversation reply without giving the model tools', async () => {
    let captured: Record<string, unknown> | undefined
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      stream: async function * (options: Record<string, unknown>) {
        captured = options
        yield { type: 'text-delta', index: 0, text: '可以先比较两个假设。' }
        yield { type: 'text-delta', index: 0, text: '下一步可输入 `/ideas` 查看已有想法。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const agent = createHarnessScholarAgent(llm as never, () => 'deepseek-v4-pro')
    await expect(agent({
      operation: 'conversation', text: '聊聊研究方向', locale: 'zh', project, history: [],
    })).resolves.toEqual({
      operation: 'conversation', assistant_text: '可以先比较两个假设。下一步可输入 `/ideas` 查看已有想法。',
    })
    expect(captured?.tools).toBeUndefined()
    expect(captured?.provider).toBe('deepseek')
    expect(captured?.model).toBe('deepseek-v4-pro')
  })

  it('accepts multiline Markdown as free conversation instead of requiring model JSON', async () => {
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      stream: async function * () {
        yield { type: 'text-delta', index: 0, text: '**取舍**\n\n1. 先检查可证伪性\n2. 再比较实验成本' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const agent = createHarnessScholarAgent(llm as never, () => 'deepseek-v4-pro')
    await expect(agent({
      operation: 'conversation', text: '聊聊研究方向', locale: 'zh', project, history: [],
    })).resolves.toEqual({
      operation: 'conversation',
      assistant_text: '**取舍**\n\n1. 先检查可证伪性\n2. 再比较实验成本',
    })
  })

  it('accepts exactly the requested number of structured IdeaDrafts', async () => {
    const draft = {
      title: 'Calibration-aware augmentation',
      hypothesis: 'Calibration-driven augmentation improves low-data robustness.',
      scientific_gap: { claims: ['Prior work does not optimize calibration.'], statement: 'Calibration is missing from augmentation selection.' },
      nearest_prior_works: [{ paper_id: 'doi:10.1/test', same: ['CNN'], different: ['No calibration objective'] }],
      exact_delta: 'Use calibration error to adapt augmentation strength.',
      falsification: { observation: 'No macro-F1 gain across three seeds.' },
      minimum_viable_experiment: { dataset: 'fixture', baseline: 'fixed augmentation', primary_metric: 'macro_f1', estimated_gpu_hours: 1, expected_runtime: '1 hour' },
      scores: { feasibility: 4, information_gain: 4, reproducibility: 5, cost: 2 },
      risk_notes: 'Calibration may overfit the validation split.',
    }
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      stream: async function * () {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ operation: 'generate_ideas', ideas: [draft, { ...draft, title: 'Second' }] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const agent = createHarnessScholarAgent(llm as never, () => 'deepseek-v4-pro')
    await expect(agent({
      operation: 'generate_ideas', text: '生成两个 idea', locale: 'zh', count: 2, project,
      corpus: { snapshot_id: 'corpus_1', papers: [{ paper_id: 'doi:10.1/test', title: 'Prior work', abstract: '' }] },
      history: [],
    })).resolves.toMatchObject({ operation: 'generate_ideas', ideas: [{ title: draft.title }, { title: 'Second' }] })
  })

  it('fails closed when the model returns the wrong count or an invalid draft', async () => {
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      stream: async function * () {
        yield { type: 'text-delta', index: 0, text: '{"operation":"generate_ideas","ideas":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const agent = createHarnessScholarAgent(llm as never, () => 'deepseek-v4-pro')
    await expect(agent({
      operation: 'generate_ideas', text: '生成三个 idea', locale: 'zh', count: 3, project,
      corpus: { snapshot_id: 'corpus_1', papers: [{ paper_id: 'doi:10.1/test', title: 'Prior work', abstract: '' }] },
      history: [],
    })).rejects.toThrow()
  })
})
