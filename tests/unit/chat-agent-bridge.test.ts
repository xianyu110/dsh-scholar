import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScholarAgentBridge } from '../../src/plugin/chat-agent-service'
import { requestScholarAgent } from '../../packages/dsh-research-ui/src/standalone/chat-agent-client'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('private Scholar agent bridge', () => {
  it('keeps endpoint credentials private and carries only validated local model turns', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scholar-agent-bridge-'))
    dirs.push(dataDir)
    const service = new ScholarAgentBridge({
      dataDir,
      handler: () => async payload => {
        const request = payload as { operation?: string; text?: string }
        return { operation: 'conversation', assistant_text: `answer:${request.text}` }
      },
    })
    await service.start()
    const endpointFile = join(dataDir, 'agent-bridge-endpoint.json')
    const tokenFile = join(dataDir, 'agent-bridge-token')
    expect(lstatSync(endpointFile).mode & 0o777).toBe(0o600)
    expect(lstatSync(tokenFile).mode & 0o777).toBe(0o600)

    await expect(requestScholarAgent(dataDir, {
      operation: 'conversation', text: 'hello', locale: 'en',
      project: { project_id: 'rsp_1', next_actions_v2: [] }, history: [],
    })).resolves.toEqual({ operation: 'conversation', assistant_text: 'answer:hello' })

    await service.stop()
    expect(existsSync(endpointFile)).toBe(false)
    expect(existsSync(tokenFile)).toBe(false)
  })

  it('fails closed while the DSH llm service is unavailable', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'scholar-agent-bridge-'))
    dirs.push(dataDir)
    const service = new ScholarAgentBridge({ dataDir, handler: () => undefined })
    await service.start()
    await expect(requestScholarAgent(dataDir, {
      operation: 'conversation', text: 'hello', locale: 'en',
      project: { project_id: 'rsp_1', next_actions_v2: [] }, history: [],
    }, 2_000)).rejects.toThrow()
    await service.stop()
  })
})
