/**
 * terminalExitFragments (client/terminal.ts, USAGE_GUIDE §6): the PURE
 * exit-frame fact extraction used by the terminal exit line — exit code,
 * signal, and the distinct timed-out / cancelled authoritative fates the
 * kernel's exit payload carries (server.ts handleTerminalSse exit event:
 * exit_code/signal/cancelled/timed_out/truncated). No DOM — the module is
 * import-safe under vitest (same graph as i18n-runtime/next-action-cards).
 */
import { describe, expect, it } from 'vitest'
import { terminalExitFragments } from '../../packages/dsh-research-ui/src/client/terminal'

describe('terminalExitFragments: authoritative exit facts', () => {
  it('exit code + signal are extracted verbatim', () => {
    const f = terminalExitFragments({ exit_code: 42, signal: 'SIGTERM', total_bytes: 1024 })
    expect(f.exitCode).toBe(42)
    expect(f.exitSignal).toBe('SIGTERM')
    expect(f.totalBytes).toBe(1024)
    expect(f.timedOut).toBe(false)
    expect(f.cancelled).toBe(false)
    expect(f.truncated).toBe(false)
  })

  it('timed out and cancelled are distinct terminal fates', () => {
    const t = terminalExitFragments({ timed_out: true, exit_code: null })
    expect(t.timedOut).toBe(true)
    expect(t.cancelled).toBe(false)
    const c = terminalExitFragments({ cancelled: true, exit_code: null })
    expect(c.cancelled).toBe(true)
    expect(c.timedOut).toBe(false)
  })

  it('missing/null fields degrade safely', () => {
    const f = terminalExitFragments({})
    expect(f.exitCode).toBeNull()
    expect(f.exitSignal).toBeNull()
    expect(f.timedOut).toBe(false)
    expect(f.cancelled).toBe(false)
    expect(f.truncated).toBe(false)
    expect(f.totalBytes).toBe(0)
    expect(f.droppedBytes).toBe(0)
  })

  it('truncated and dropped bytes are carried through', () => {
    const f = terminalExitFragments({ truncated: true, dropped_bytes: 512, total_bytes: 4096 })
    expect(f.truncated).toBe(true)
    expect(f.droppedBytes).toBe(512)
    expect(f.totalBytes).toBe(4096)
  })

  it('signal is null when empty or non-string', () => {
    expect(terminalExitFragments({ signal: '' }).exitSignal).toBeNull()
    expect(terminalExitFragments({ signal: 0 as unknown as string }).exitSignal).toBeNull()
  })
})
