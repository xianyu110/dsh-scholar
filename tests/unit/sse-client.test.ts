/**
 * SSE-01 Generic SSE stream consumer (client/sse-client.ts): pure logic —
 * fetch transport + timer scheduler injected, mock ReadableStreams in
 * place of the browser. Covers:
 *
 *   frame parsing:      event/data/id fields, multi-line data ('\n' join),
 *                       retry control dispatch, ':' heartbeat comments,
 *                       CRLF, chunk-boundary splits;
 *   stream lifecycle:   connecting → live, stream-end reconnect with
 *                       exponential backoff RESUMING FROM the last cursor
 *                       (url() builder), max-reconnect-attempts give-up
 *                       (models fall back to polling on it);
 *   heartbeat timeout:  no bytes within heartbeatTimeoutMs → reconnect;
 *   cancellation:       close() aborts the in-flight fetch/read, no
 *                       reconnect afterwards;
 *   transport errors:   fetch rejection / non-ok HTTP / retry budget —
 *                       onError codes + backoff delays.
 *
 * The pty/workspace/trajectory model tests build on this transport via
 * the same MockSseFetch helpers.
 */
import { describe, expect, it } from 'vitest'
import {
  MockSseFetch, MockSseStream, SseClient, createSseParser,
  type SseEvent, type SseScheduler,
} from '../../packages/dsh-research-ui/src/client/sse-client'

/* ─────────────────────────── fakes (no DOM) ─────────────────────────── */

/** Deterministic manual timer queue: runOnce() fires the timers scheduled
 *  BEFORE the batch (newly scheduled ones wait for the next batch). */
class FakeScheduler implements SseScheduler {
  timers: Array<{ id: number; fn: () => void; ms: number }> = []
  private nextId = 1
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId
    this.nextId += 1
    this.timers.push({ id, fn, ms })
    return id
  }
  clearTimeout(timer: unknown): void {
    this.timers = this.timers.filter(t => t.id !== timer)
  }
  get pending(): number {
    return this.timers.length
  }
  runOnce(): void {
    const batch = [...this.timers]
    this.timers = this.timers.filter(t => !batch.includes(t))
    for (const t of batch) t.fn()
  }
  /** The delay of the most recently scheduled timer (backoff assertions). */
  get lastDelay(): number | null {
    return this.timers.at(-1)?.ms ?? null
  }
}

const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

function makeClient(over: Partial<ConstructorParameters<typeof SseClient>[0]> & { url?: () => string }): {
  client: SseClient
  scheduler: FakeScheduler
  fetchMock: MockSseFetch
  events: SseEvent[]
  statuses: string[]
  ends: string[]
  errors: Array<{ code: string; status: number }>
  cursor: { value: number }
} {
  const scheduler = new FakeScheduler()
  const fetchMock = new MockSseFetch()
  const events: SseEvent[] = []
  const statuses: string[] = []
  const ends: string[] = []
  const errors: Array<{ code: string; status: number }> = []
  const cursor = { value: 0 }
  const client = new SseClient({
    url: () => `https://test.local/stream?after_seq=${cursor.value}`,
    fetchImpl: fetchMock.fetchImpl.bind(fetchMock),
    scheduler,
    onEvent: (event) => {
      events.push(event)
      if (event.event !== 'retry') {
        try {
          const data = JSON.parse(event.data) as { seq?: number }
          if (typeof data.seq === 'number') cursor.value = data.seq
        } catch { /* raw data */ }
      }
    },
    onStatus: (status) => { statuses.push(status) },
    onEnd: (reason) => { ends.push(reason) },
    onError: (error) => { errors.push({ code: error.code, status: error.status }) },
    ...over,
  })
  return { client, scheduler, fetchMock, events, statuses, ends, errors, cursor }
}

function sseFrame(event: string, data: unknown, id?: string): string {
  const idLine = id !== undefined ? `id: ${id}\n` : ''
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/* ───────────────────────────── frame parsing ───────────────────────────── */

describe('SSE-01 frame parsing (event/data/id/multi-line/retry)', () => {
  it('parses event + data + id fields and dispatches on the blank line', async () => {
    const { client, fetchMock, events } = makeClient()
    const stream = fetchMock.enqueueStream('https://test.local/stream?after_seq=0')
    client.open()
    await flush()
    stream.push('id: 42\nevent: frame\ndata: {"seq":1}\n\n')
    await flush()
    expect(client.status).toBe('live')
    expect(events).toEqual([{ event: 'frame', data: '{"seq":1}', id: '42' }])
  })

  it('multi-line data joins with \\n (spec); CRLF endings are accepted', async () => {
    const { client, fetchMock, events } = makeClient()
    const stream = fetchMock.enqueueStream('https://test.local/stream?after_seq=0')
    client.open()
    await flush()
    stream.push('event: chunk\r\ndata: line one\r\ndata: line two\r\n\r\n')
    await flush()
    expect(events).toEqual([{ event: 'chunk', data: 'line one\nline two', id: null }])
  })

  it('comment lines (: heartbeat) are skipped without producing events', async () => {
    const { client, fetchMock, events } = makeClient()
    const stream = fetchMock.enqueueStream('https://test.local/stream?after_seq=0')
    client.open()
    await flush()
    stream.push(': ping 123\n\n: ping 456\n\nevent: frame\ndata: {"seq":2}\n\n')
    await flush()
    expect(events.map(e => e.event)).toEqual(['frame'])
  })

  it('frames split across chunk boundaries still parse (carry-over buffer)', async () => {
    const { client, fetchMock, events } = makeClient()
    const stream = fetchMock.enqueueStream('https://test.local/stream?after_seq=0')
    client.open()
    await flush()
    stream.push('event: frame\nda')
    stream.push('ta: {"seq')
    stream.push('":3}\n\n')
    await flush()
    expect(events.map(e => e.event)).toEqual(['frame'])
    expect(events[0]!.data).toBe('{"seq":3}')
  })

  it('retry: field is honored as the next reconnect delay (transport control)', async () => {
    const { client, fetchMock, scheduler, ends } = makeClient({ reconnectBaseMs: 100 })
    const stream = fetchMock.enqueueStream('https://test.local/stream?after_seq=0')
    client.open()
    await flush()
    stream.push('retry: 2000\n\n')
    stream.push('event: frame\ndata: {"seq":1}\n\n')
    await flush()
    // the client never forwards retry to the consumer (transport control);
    // the next reconnect uses the server-requested delay instead of the
    // backoff base.
    expect(ends).toEqual([])
    stream.end()
    await flush()
    expect(ends).toEqual(['stream-end'])
    expect(scheduler.lastDelay).toBe(2000)
  })

  it('malformed JSON data still dispatches (the consumer parses; the client transports)', async () => {
    const { client, fetchMock, events } = makeClient()
    const stream = fetchMock.enqueueStream('https://test.local/stream?after_seq=0')
    client.open()
    await flush()
    stream.push('event: frame\ndata: {broken\n\nevent: frame\ndata: {"seq":4}\n\n')
    await flush()
    expect(events.map(e => e.event)).toEqual(['frame', 'frame'])
    expect(events[0]!.data).toBe('{broken')
    expect(events[1]!.data).toBe('{"seq":4}')
  })

  it('createSseParser (pure) handles multi-line data + retry + unknown fields', () => {
    const out: SseEvent[] = []
    const parser = createSseParser(e => out.push(e))
    parser.feed('event: a\ndata: 1\ndata: 2\nunknown-field: x\n\nretry: 500\n\n')
    expect(out).toEqual([
      { event: 'a', data: '1\n2', id: null },
      { event: 'retry', data: '500', id: null },
    ])
  })
})

/* ─────────────────── reconnect (cursor resume + backoff) ─────────────────── */

describe('SSE-01 stream-end reconnect (from the last seq/rev, backoff)', () => {
  it('stream end reconnects with exponential backoff and RESUMES from the last cursor', async () => {
    const { client, fetchMock, scheduler, statuses, ends, cursor } = makeClient({ reconnectBaseMs: 250 })
    const stream = fetchMock.enqueueStream('https://test.local/stream?after_seq=0')
    client.open()
    await flush()
    expect(statuses).toContain('live')
    stream.push(sseFrame('frame', { seq: 1 }))
    stream.push(sseFrame('frame', { seq: 3 }))
    await flush()
    expect(cursor.value).toBe(3)
    // server closes the stream (EOF) → reconnect scheduled
    stream.end()
    await flush()
    expect(ends).toEqual(['stream-end'])
    expect(statuses).toContain('reconnecting')
    expect(scheduler.lastDelay).toBe(250) // attempt 1 → base * 2^0
    // fire the reconnect → a NEW fetch resumes after_seq=3
    const stream2 = fetchMock.enqueueStream('https://test.local/stream?after_seq=3')
    scheduler.runOnce()
    await flush()
    expect(fetchMock.calls.map(c => c.url)).toContain('https://test.local/stream?after_seq=3')
    expect(client.status).toBe('live')
    stream2.push(sseFrame('frame', { seq: 4 }))
    await flush()
    expect(cursor.value).toBe(4)
  })

  it('backoff doubles per failed attempt (base * 2^n, capped at reconnectMaxMs)', async () => {
    const { client, fetchMock, scheduler } = makeClient({ reconnectBaseMs: 100, reconnectMaxMs: 1000 })
    for (let i = 0; i < 6; i += 1) fetchMock.enqueueError('https://test.local/stream?after_seq=0')
    client.open()
    await flush()
    expect(scheduler.lastDelay).toBe(100) // attempt 1
    scheduler.runOnce(); await flush()
    expect(scheduler.lastDelay).toBe(200) // attempt 2
    scheduler.runOnce(); await flush()
    expect(scheduler.lastDelay).toBe(400) // attempt 3
    scheduler.runOnce(); await flush()
    expect(scheduler.lastDelay).toBe(800) // attempt 4
    scheduler.runOnce(); await flush()
    expect(scheduler.lastDelay).toBe(1000) // attempt 5 → capped
    client.close()
  })

  it('maxReconnectAttempts bounds the loop: onEnd(max-retries), status closed, no more fetches', async () => {
    const { client, fetchMock, scheduler, ends, errors } = makeClient({
      reconnectBaseMs: 100,
      maxReconnectAttempts: 3,
    })
    for (let i = 0; i < 4; i += 1) fetchMock.enqueueError('https://test.local/stream?after_seq=0', 500)
    client.open()
    await flush()
    expect(client.status).toBe('reconnecting')
    scheduler.runOnce(); await flush()
    scheduler.runOnce(); await flush()
    expect(fetchMock.calls).toHaveLength(3)
    expect(errors).toEqual([
      { code: 'http_error', status: 500 },
      { code: 'http_error', status: 500 },
      { code: 'http_error', status: 500 },
    ])
    // third failed attempt → give up
    expect(ends).toContain('max-retries')
    expect(client.status).toBe('closed')
    scheduler.runOnce()
    await flush()
    expect(fetchMock.calls).toHaveLength(3) // nothing left scheduled
  })

  it('fetch rejection (network) is a transport error that reconnects', async () => {
    const { scheduler, errors } = makeClient()
    let calls = 0
    const client2 = new SseClient({
      url: () => 'https://test.local/stream?after_seq=0',
      fetchImpl: (url, init) => {
        calls += 1
        if (calls === 1) return Promise.reject(new Error('socket hang up'))
        return Promise.resolve({ ok: true, status: 200, body: new MockSseStream().stream })
      },
      scheduler,
      onError: (e) => { errors.push({ code: e.code, status: e.status }) },
    })
    client2.open()
    await flush()
    expect(errors[0]).toEqual({ code: 'network_error', status: 0 })
    expect(client2.status).toBe('reconnecting')
    scheduler.runOnce()
    await flush()
    expect(client2.status).toBe('live')
    client2.close()
  })

  it('an empty body (null stream) is a transport error, not a hang', async () => {
    const { client, fetchMock, errors } = makeClient()
    fetchMock.enqueue('https://test.local/stream?after_seq=0', { ok: true, status: 200, body: null })
    client.open()
    await flush()
    expect(errors[0]!.code).toBe('empty_body')
    expect(client.status).toBe('reconnecting')
    client.close()
  })
})

/* ─────────────────────────── heartbeat timeout ─────────────────────────── */

describe('SSE-01 heartbeat timeout (dead stream detection)', () => {
  it('silence past heartbeatTimeoutMs aborts the stream and reconnects', async () => {
    const { client, fetchMock, scheduler, ends, errors } = makeClient({
      heartbeatTimeoutMs: 5000,
      reconnectBaseMs: 100,
    })
    const stream = fetchMock.enqueueStream('https://test.local/stream?after_seq=0')
    client.open()
    await flush()
    expect(client.status).toBe('live')
    expect(scheduler.lastDelay).toBe(5000) // the watchdog is armed
    // any bytes reset the watchdog; silence then trips it
    stream.push(sseFrame('frame', { seq: 1 }))
    await flush()
    stream.push(': keepalive\n\n')
    await flush()
    scheduler.runOnce() // watchdog fires (no bytes since the comment)
    await flush()
    expect(errors.map(e => e.code)).toContain('heartbeat_timeout')
    expect(ends).toContain('heartbeat-timeout')
    expect(client.status).toBe('reconnecting')
    expect(scheduler.lastDelay).toBe(100)
    // the reconnect opens a fresh stream
    fetchMock.enqueueStream('https://test.local/stream?after_seq=1')
    scheduler.runOnce()
    await flush()
    expect(client.status).toBe('live')
  })
})

/* ─────────────────────────── cancellation (abort) ─────────────────────────── */

describe('SSE-01 Abort cancellation (close() while live / mid-connect)', () => {
  it('close() aborts the in-flight fetch signal and stops all reconnects', async () => {
    const { client, fetchMock, scheduler, ends } = makeClient()
    const stream = fetchMock.enqueueStream('https://test.local/stream?after_seq=0')
    client.open()
    await flush()
    expect(client.status).toBe('live')
    expect(fetchMock.calls[0]!.signal?.aborted).toBe(false)
    client.close()
    expect(client.status).toBe('closed')
    expect(fetchMock.calls[0]!.signal?.aborted).toBe(true)
    // nothing is scheduled (no reconnect), no end event, no further fetches
    expect(scheduler.pending).toBe(0)
    expect(ends).toEqual([])
    scheduler.runOnce()
    await flush()
    expect(fetchMock.calls).toHaveLength(1)
    void stream
  })

  it('close() while the read is pending interrupts it (abort rejects the mock read)', async () => {
    const { client, fetchMock, scheduler, ends } = makeClient()
    const stream = new MockSseStream()
    fetchMock.enqueue('https://test.local/stream?after_seq=0', { ok: true, status: 200, body: stream.stream })
    // wire the fetch signal to the mock stream: abort → read rejects
    const abortWired = new MockSseFetch()
    abortWired.enqueue('https://test.local/stream?after_seq=0', { ok: true, status: 200, body: stream.stream })
    const client2 = new SseClient({
      url: () => 'https://test.local/stream?after_seq=0',
      fetchImpl: (url, init) => {
        init.signal?.addEventListener('abort', () => { stream.error(new DOMException('AbortError', 'AbortError')) })
        return abortWired.fetchImpl(url, init)
      },
      scheduler,
    })
    client2.open()
    await flush()
    expect(client2.status).toBe('live')
    client2.close()
    await flush()
    expect(client2.status).toBe('closed')
    expect(ends).toEqual([])
    expect(scheduler.pending).toBe(0)
    void fetchMock
  })

  it('close() during a scheduled reconnect cancels it (timer cleared)', async () => {
    const { client, scheduler, fetchMock } = makeClient({ reconnectBaseMs: 100 })
    fetchMock.enqueueError('https://test.local/stream?after_seq=0')
    client.open()
    await flush()
    expect(client.status).toBe('reconnecting')
    expect(scheduler.pending).toBeGreaterThan(0)
    client.close()
    expect(scheduler.pending).toBe(0)
    scheduler.runOnce()
    await flush()
    expect(fetchMock.calls).toHaveLength(1) // the reconnect never fired
  })
})
