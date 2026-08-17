import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chatSource = readFileSync(new URL('../../packages/dsh-research-ui/src/client/chat.ts', import.meta.url), 'utf8')
const pluginSource = readFileSync(new URL('../../src/plugin/index.ts', import.meta.url), 'utf8')

describe('conversational Brief UI contract', () => {
  it('uses one Chat textarea and renders the current Brief question in the transcript', () => {
    expect(chatSource.match(/document\.createElement\('textarea'\)/g)).toHaveLength(1)
    expect(chatSource).toContain("const grillConversationHost = el('div', 'chat-grill-turn-host')")
    expect(chatSource).toContain('stream.appendChild(grillConversationHost)')
    expect(chatSource).not.toContain("el('div', 'grill-guide')")
  })

  it('requires the Harness user-questions service for the DSH-hosted flow', () => {
    expect(pluginSource).toContain("import type {} from '@deepseek-ai/dsh-user-questions'")
    expect(pluginSource).toContain("'userQuestions'")
  })
})
