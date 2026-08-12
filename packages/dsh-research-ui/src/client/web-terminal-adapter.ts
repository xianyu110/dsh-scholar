import type { PtyDisplayEntry } from './pty-session-model'

/** The small browser-terminal surface used by the PTY panel and unit tests. */
export interface WebTerminalLike {
  readonly cols: number
  readonly rows: number
  onData(listener: (data: string) => void): { dispose(): void }
  write(data: string): void
  focus(): void
  dispose(): void
}

export interface WebTerminalAdapterOptions {
  terminal: WebTerminalLike
  sendText(text: string): boolean
  resize(cols: number, rows: number): boolean
  fit?(): void
  onGap?(entry: PtyDisplayEntry): void
  onExit?(entry: PtyDisplayEntry): void
}

export interface WebTerminalAdapter {
  /** Feed the model's retained display into the emulator without replaying rows. */
  render(entries: readonly PtyDisplayEntry[]): void
  /** Recompute geometry and notify the PTY only when cols/rows changed. */
  fit(): void
  focus(): void
  dispose(): void
}

function displayKey(entry: PtyDisplayEntry): string {
  return `${entry.kind}:${entry.seq}`
}

/**
 * Connect an xterm-compatible emulator to the PTY model's byte/control seams.
 * Gap and exit metadata intentionally stay outside the ANSI byte channel.
 */
export function createWebTerminalAdapter(options: WebTerminalAdapterOptions): WebTerminalAdapter {
  const seen = new Set<string>()
  let disposed = false
  let lastCols: number | null = null
  let lastRows: number | null = null
  const inputSubscription = options.terminal.onData(data => {
    if (!disposed && data !== '') options.sendText(data)
  })

  return {
    render(entries): void {
      if (disposed) return
      const retainedKeys = new Set(entries.map(displayKey))
      for (const entry of entries) {
        const key = displayKey(entry)
        if (seen.has(key)) continue
        seen.add(key)
        if (entry.kind === 'output') {
          if (entry.text !== undefined && entry.text !== '') options.terminal.write(entry.text)
        } else if (entry.kind === 'gap') {
          options.onGap?.(entry)
        } else {
          options.onExit?.(entry)
        }
      }
      // The model bounds its retained display. Mirror that bound so a long
      // running terminal does not grow an unbounded de-duplication set.
      for (const key of seen) {
        if (!retainedKeys.has(key)) seen.delete(key)
      }
    },
    fit(): void {
      if (disposed) return
      options.fit?.()
      const { cols, rows } = options.terminal
      if (cols === lastCols && rows === lastRows) return
      lastCols = cols
      lastRows = rows
      options.resize(cols, rows)
    },
    focus(): void {
      if (!disposed) options.terminal.focus()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      inputSubscription.dispose()
      seen.clear()
      options.terminal.dispose()
    },
  }
}
