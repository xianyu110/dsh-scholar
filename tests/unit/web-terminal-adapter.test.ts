import { describe, expect, it } from 'vitest'
import type { PtyDisplayEntry } from '../../packages/dsh-research-ui/src/client/pty-session-model'
import { createWebTerminalAdapter } from '../../packages/dsh-research-ui/src/client/web-terminal-adapter'

class FakeTerminal {
  cols = 80
  rows = 24
  writes: string[] = []
  focused = 0
  disposed = 0
  private listener: ((data: string) => void) | null = null

  onData(listener: (data: string) => void): { dispose(): void } {
    this.listener = listener
    return { dispose: () => { this.listener = null } }
  }

  emit(data: string): void { this.listener?.(data) }
  write(data: string): void { this.writes.push(data) }
  focus(): void { this.focused += 1 }
  dispose(): void { this.disposed += 1 }
}

describe('WEBTERM-01 browser terminal adapter', () => {
  it('forwards keyboard, control and Unicode input to the PTY bytes seam', () => {
    const terminal = new FakeTerminal()
    const sent: string[] = []
    const adapter = createWebTerminalAdapter({
      terminal,
      sendText: text => { sent.push(text); return true },
      resize: () => true,
    })

    terminal.emit('echo WEBTERM_OK\r')
    terminal.emit('\u0003')
    terminal.emit('中文🙂')

    expect(sent).toEqual(['echo WEBTERM_OK\r', '\u0003', '中文🙂'])
    adapter.dispose()
    terminal.emit('ignored')
    expect(sent).toHaveLength(3)
  })

  it('writes each PTY output sequence once and leaves gap/exit outside the ANSI channel', () => {
    const terminal = new FakeTerminal()
    const gaps: PtyDisplayEntry[] = []
    const exits: PtyDisplayEntry[] = []
    const adapter = createWebTerminalAdapter({
      terminal,
      sendText: () => true,
      resize: () => true,
      onGap: entry => { gaps.push(entry) },
      onExit: entry => { exits.push(entry) },
    })
    const first: PtyDisplayEntry[] = [
      { kind: 'output', seq: 1, text: '\u001b[31mred\u001b[0m\r\n' },
      { kind: 'gap', seq: 2, gapFrom: 2, gapTo: 4, droppedBytes: 30 },
      { kind: 'output', seq: 5, text: 'ready $ ' },
      { kind: 'exit', seq: 6, exitCode: 0 },
    ]

    adapter.render(first)
    adapter.render(first)
    adapter.render([...first, { kind: 'output', seq: 7, text: 'late\r\n' }])

    expect(terminal.writes).toEqual(['\u001b[31mred\u001b[0m\r\n', 'ready $ ', 'late\r\n'])
    expect(gaps.map(entry => entry.seq)).toEqual([2])
    expect(exits.map(entry => entry.seq)).toEqual([6])
  })

  it('fits and sends resize only when terminal geometry changes', () => {
    const terminal = new FakeTerminal()
    const sizes: Array<[number, number]> = []
    let fitCalls = 0
    const adapter = createWebTerminalAdapter({
      terminal,
      sendText: () => true,
      resize: (cols, rows) => { sizes.push([cols, rows]); return true },
      fit: () => { fitCalls += 1 },
    })

    adapter.fit()
    adapter.fit()
    terminal.cols = 132
    terminal.rows = 43
    adapter.fit()

    expect(fitCalls).toBe(3)
    expect(sizes).toEqual([[80, 24], [132, 43]])
    adapter.focus()
    expect(terminal.focused).toBe(1)
    adapter.dispose()
    expect(terminal.disposed).toBe(1)
    adapter.fit()
    expect(fitCalls).toBe(3)
  })
})
