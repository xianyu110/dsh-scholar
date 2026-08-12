/**
 * SSE real-time stream endpoints (acceptance-tests.md §21 "SSE 实时流替代
 * 轮询", api-contracts.md §22) — replay / heartbeat / end semantics over
 * REAL text/event-stream HTTP:
 *
 *   GET /v1/pty/sessions/{id}/frames/stream?after_seq=N   (PTY-01)
 *   GET /v1/projects/{id}/workspaces/{wid}/watch/stream?after_revision=N (WORK-01)
 *   GET /v1/projects/{id}/trajectory/stream?after_seq=N&lane=…  (TRAJ-01)
 *
 * Each stream mirrors the terminal SSE pattern (handleTerminalSse): initial
 * snapshot BEFORE the headers (so 422/403/404 answer JSON), after_seq replay,
 * live tail via the SAME polling data source (server-side ~200ms poll), and
 * named heartbeat events. The pty stream additionally ends on the exit frame.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel } from '@dsh-scholar/research-kernel'
import { PtyOpenRequest } from '@dsh-scholar/research-schemas'
import { startKernelServer, sseStreamTiming } from '../../packages/research-kernel/lib/server.js'

interface SseEvent { event: string; data: Record<string, unknown> }

/**
 * Streaming SSE reader over node fetch: parses `event:`/`data:` blocks as
 * they arrive; `until()` reads (with a 250ms idle poll) until a predicate
 * over the events seen so far holds or the deadline expires; `drain()`
 * waits for the server to END the stream (exit/close semantics); `close()`
 * aborts the connection.
 */
class SseClient {
  readonly events: SseEvent[] = []
  private buffer = ''
  private decoder = new TextDecoder()
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null
  private readonly controller: AbortController

  private constructor(readonly response: Response, controller: AbortController) {
    this.reader = response.body!.getReader()
    this.controller = controller
  }

  static async open(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
    const controller = new AbortController()
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) {
      controller.abort()
      const body = await response.text().catch(() => '')
      throw new Error(`SSE open failed: HTTP ${response.status} ${body}`)
    }
    return new SseClient(response, controller)
  }

  private parseBlock(block: string): void {
    const lines = block.split('\n')
    const eventLine = lines.find(l => l.startsWith('event: '))
    const dataLine = lines.find(l => l.startsWith('data: '))
    if (eventLine === undefined || dataLine === undefined) return
    let data: Record<string, unknown> = {}
    try { data = JSON.parse(dataLine.slice(6)) as Record<string, unknown> } catch { /* opaque */ }
    this.events.push({ event: eventLine.slice(7), data })
  }

  private flushBlocks(): void {
    const blocks = this.buffer.split('\n\n')
    this.buffer = blocks.pop() ?? ''
    for (const block of blocks) this.parseBlock(block)
  }

  private async readChunk(): Promise<{ done: boolean; value?: Uint8Array } | null> {
    const read = this.pendingRead ?? this.reader.read()
    this.pendingRead = null
    const idle = new Promise<null>(resolve => setTimeout(() => resolve(null), 250))
    const result = await Promise.race([read, idle])
    if (result === null) {
      // Idle poll won; the read stays pending and is consumed next call.
      this.pendingRead = read
      return null
    }
    if (result.done) return { done: true }
    return { done: false, value: result.value }
  }

  /** Read until the predicate holds (or the deadline expires). Returns the
   * events seen so far. */
  async until(predicate: (events: SseEvent[]) => boolean, timeoutMs = 6000): Promise<SseEvent[]> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (predicate(this.events)) return [...this.events]
      if (Date.now() >= deadline) {
        throw new Error(`SSE timeout after ${timeoutMs}ms; events: ${JSON.stringify(this.events.map(e => e.event))}`)
      }
      const chunk = await this.readChunk()
      if (chunk === null) continue
      if (chunk.done) {
        if (predicate(this.events)) return [...this.events]
        throw new Error(`SSE stream ended before predicate; events: ${JSON.stringify(this.events.map(e => e.event))}`)
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true })
      this.flushBlocks()
    }
  }

  /** Read for a fixed duration and return the events collected (used to
   * assert that NOTHING arrives — e.g. exact-keyset resume replay checks). */
  async readFor(ms: number): Promise<SseEvent[]> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const chunk = await this.readChunk()
      if (chunk === null) continue
      if (chunk.done) break
      this.buffer += this.decoder.decode(chunk.value, { stream: true })
      this.flushBlocks()
    }
    return [...this.events]
  }

  /** Wait for the server to END the stream (e.g. the pty exit frame). */
  async drain(timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (Date.now() >= deadline) throw new Error('SSE stream did not end (drain timeout)')
      const chunk = await this.readChunk()
      if (chunk === null) continue
      if (chunk.done) return
      this.buffer += this.decoder.decode(chunk.value, { stream: true })
      this.flushBlocks()
    }
  }

  close(): void {
    this.controller.abort()
  }
}

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sse-streams-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief(): Record<string, unknown> {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

function openRequest(projectId: string, workspaceId: string, overrides: Record<string, unknown> = {}): PtyOpenRequest {
  return PtyOpenRequest.parse({
    project_id: projectId,
    workspace_id: workspaceId,
    profile: 'local-docker-cpu',
    target: 'target-1',
    preset: 'bash',
    cwd: 'scratch',
    ...overrides,
  })
}

/** Negative assertion: a JSON error (never SSE bytes) before any stream. */
async function expectSseError(url: string, headers: Record<string, string>, status: number, code: string): Promise<void> {
  const res = await fetch(url, { headers })
  expect(res.status).toBe(status)
  expect(res.headers.get('content-type') ?? '').not.toContain('text/event-stream')
  const body = await res.json() as { error?: { code?: unknown } }
  expect(body.error?.code).toBe(code)
}

const savedTiming = { ...sseStreamTiming }
afterEach(() => {
  sseStreamTiming.pollMs = savedTiming.pollMs
  sseStreamTiming.heartbeatMs = savedTiming.heartbeatMs
})

describe('SSE stream: GET /v1/pty/sessions/{id}/frames/stream (PTY-01)', () => {
  it('replays frames after after_seq without duplicates and ends on the exit frame', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief(), creator_principal_id: 'pi-1' } as never)
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi-1' } })
    kernel.ptyAppendOutput(session.pty_session_id, [
      { type: 'output', text: 'one', byte_length: 3 },
      { type: 'output', text: 'two', byte_length: 3 },
      { type: 'output', text: 'three', byte_length: 5 },
    ])
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}/v1/pty/sessions/${session.pty_session_id}/frames/stream`
      const auth = { 'x-principal-id': 'pi-1' }
      // Replay from seq 0: subscribed + frames 1..3 in order.
      const c1 = await SseClient.open(`${base}?after_seq=0`, auth)
      const evs1 = await c1.until(evs => evs.filter(e => e.event === 'frame').length >= 3)
      expect(c1.response.status).toBe(200)
      expect(c1.response.headers.get('content-type')).toContain('text/event-stream')
      expect(c1.response.headers.get('cache-control')).toBe('no-store')
      expect(evs1[0]?.event).toBe('subscribed')
      expect(evs1[0]?.data).toMatchObject({ session_id: session.pty_session_id, last_seq: 3 })
      const frames1 = evs1.filter(e => e.event === 'frame')
      expect(frames1.map(f => f.data.seq)).toEqual([1, 2, 3])
      expect(frames1[0]?.data).toMatchObject({ session_id: session.pty_session_id, type: 'output' })
      expect(frames1[0]?.data.payload).toMatchObject({ text: 'one', byte_length: 3, channel: 'stdout' })
      c1.close()
      // Resume from seq 2: only frame 3 (no duplicate, no missing).
      const c2 = await SseClient.open(`${base}?after_seq=2`, auth)
      const evs2 = await c2.until(evs => evs.some(e => e.event === 'frame'))
      expect(evs2.filter(e => e.event === 'frame').map(f => f.data.seq)).toEqual([3])
      c2.close()
      // Exit frame ends the stream (authoritative terminal state).
      kernel.ptyAppendOutput(session.pty_session_id, [{ type: 'exit', exit_code: 0, signal: null }])
      const c3 = await SseClient.open(`${base}?after_seq=3`, auth)
      const evs3 = await c3.until(evs => evs.some(e => e.event === 'exit'))
      const exit = evs3.find(e => e.event === 'exit')
      expect(exit?.data).toMatchObject({ session_id: session.pty_session_id, seq: 4, exit_code: 0, signal: null })
      await c3.drain() // the exit event is followed by the connection closing
      c3.close()
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('pushes live frames appended after connect and reports retention gaps', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief(), creator_principal_id: 'pi-1' } as never)
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi-1' } })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}/v1/pty/sessions/${session.pty_session_id}/frames/stream`
      const auth = { 'x-principal-id': 'pi-1' }
      // Live tail: subscribe to the empty session, then append while open.
      const live = await SseClient.open(`${base}?after_seq=0`, auth)
      await live.until(evs => evs.some(e => e.event === 'subscribed'))
      expect(live.events[0]?.data.last_seq).toBe(0)
      kernel.ptyAppendOutput(session.pty_session_id, [
        { type: 'output', text: 'live1', byte_length: 5 },
        { type: 'output', text: 'live2', byte_length: 5 },
      ])
      const evsLive = await live.until(evs => evs.filter(e => e.event === 'frame').length >= 2)
      const liveFrames = evsLive.filter(e => e.event === 'frame')
      expect(liveFrames.map(f => f.data.seq)).toEqual([1, 2])
      expect(liveFrames.some(f => (f.data.payload as { text?: string }).text === 'live2')).toBe(true)
      live.close()
      // Gap: a reader starting at 0 on an evicted window must see the gap
      // event (seq = first dropped seq) followed by the retained frames.
      const small = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id, { retention_bytes: 16 }), { principal: { principal_id: 'pi-1' } })
      kernel.ptyAppendOutput(small.pty_session_id, [
        { type: 'output', text: 'aaaaaaa\n', byte_length: 8 },
        { type: 'output', text: 'bbbbbbb\n', byte_length: 8 },
        { type: 'output', text: 'ccccccc\n', byte_length: 8 },
        { type: 'output', text: 'ddddddd\n', byte_length: 8 },
      ])
      const gapc = await SseClient.open(`${base.replace(session.pty_session_id, small.pty_session_id)}?after_seq=0`, auth)
      // gap and the retained frames are written in order, but fetch/SSE may
      // surface them in separate network chunks. Wait for both observable
      // contract events instead of assuming the first gap chunk contains
      // every subsequent retained frame.
      const evsGap = await gapc.until(evs =>
        evs.some(e => e.event === 'gap') && evs.some(e => e.event === 'frame'))
      const gap = evsGap.find(e => e.event === 'gap')
      expect(gap?.data).toMatchObject({ session_id: small.pty_session_id, gap_from_seq: 1 })
      expect(Number(gap?.data.dropped_bytes)).toBeGreaterThan(0)
      expect(gap?.data.seq).toBe(1) // first dropped seq, terminal-SSE convention
      const gapFrames = evsGap.filter(e => e.event === 'frame').map(f => f.data.seq as number)
      expect(gapFrames.length).toBeGreaterThan(0)
      // retained frames are contiguous from retained_from_seq
      expect(gapFrames[0]).toBe(Number(gap?.data.retained_from_seq))
      gapc.close()
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('emits named heartbeat events and answers 422/403/404 like the polling frames route', async () => {
    sseStreamTiming.heartbeatMs = 60
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief(), creator_principal_id: 'pi-1' } as never)
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi-1' } })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}/v1/pty/sessions/${session.pty_session_id}/frames/stream`
      const hb = await SseClient.open(`${base}?after_seq=0`, { 'x-principal-id': 'pi-1' })
      await hb.until(evs => evs.some(e => e.event === 'heartbeat'), 4000)
      expect(hb.events.filter(e => e.event === 'heartbeat').length).toBeGreaterThan(0)
      hb.close()
      // Auth matrix mirrors the polling frames route exactly.
      await expectSseError(`${base}?after_seq=0`, {}, 422, 'principal_required')
      await expectSseError(`${base}?after_seq=0`, { 'x-principal-id': 'evil' }, 403, 'pty_principal_mismatch')
      await expectSseError(`${base.replace(session.pty_session_id, 'pty_unknown')}?after_seq=0`, { 'x-principal-id': 'pi-1' }, 404, 'pty_session_not_found')
      await expectSseError(`${base}?after_seq=-1`, { 'x-principal-id': 'pi-1' }, 422, 'pty_after_seq_invalid')
      // A wrong OPTIONAL lease is still 403 (never "wrong lease = pass").
      await expectSseError(`${base}?after_seq=0`, { 'x-principal-id': 'pi-1', 'x-pty-lease': 'lease_wrong' }, 403, 'lease_invalid')
    } finally {
      server.close()
      kernel.close()
    }
  })
})

describe('SSE stream: GET /v1/projects/{id}/workspaces/{wid}/watch/stream (WORK-01)', () => {
  it('emits change events with revision advance and delete tombstones; after_revision resumes without replay', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief(), creator_principal_id: 'pi-1' } as never)
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'code-1')
    kernel.workspaceWrite(ws.workspace_id, 'a.txt', 'hello')
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}/v1/projects/${project.project_id}/workspaces/${ws.workspace_id}/watch/stream`
      const auth = { 'x-principal-id': 'pi-1' }
      const c1 = await SseClient.open(`${base}?after_revision=0`, auth)
      const evs1 = await c1.until(evs => evs.some(e => e.event === 'change'))
      expect(c1.response.status).toBe(200)
      expect(c1.response.headers.get('content-type')).toContain('text/event-stream')
      expect(evs1[0]?.event).toBe('subscribed')
      expect(evs1[0]?.data).toMatchObject({ workspace_id: ws.workspace_id, project_id: project.project_id, after_revision: 0 })
      const subRevision = evs1[0]?.data.revision as number
      const change = evs1.find(e => e.event === 'change')
      expect((change?.data.node as { path?: string })?.path).toBe('a.txt')
      expect(change?.data.revision).toBeGreaterThanOrEqual(subRevision)
      // Delete tombstone + revision advance on the SAME connection.
      kernel.workspaceDelete(ws.workspace_id, 'a.txt')
      const evs2 = await c1.until(evs => evs.some(e => e.event === 'delete'))
      const del = evs2.find(e => e.event === 'delete')
      expect(del?.data).toMatchObject({ workspace_id: ws.workspace_id, path: 'a.txt' })
      expect(Number(del?.data.revision)).toBeGreaterThan(Number(change?.data.revision))
      c1.close()
      // Reconnect with after_revision = current → nothing replayed.
      const info = kernel.resolveWorkspace(ws.workspace_id)
      const c2 = await SseClient.open(`${base}?after_revision=${info.revision}`, auth)
      const evsC2 = await c2.readFor(700)
      expect(evsC2.filter(e => e.event === 'change' || e.event === 'delete')).toHaveLength(0)
      c2.close()
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('pushes live changes, emits heartbeats, and fails closed (422/404/cross-project 404)', async () => {
    sseStreamTiming.heartbeatMs = 60
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief(), creator_principal_id: 'pi-1' } as never)
    const other = kernel.createProject({ name: 'o', workspace: '/w', brief: makeBrief(), creator_principal_id: 'pi-1' } as never)
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'code-1')
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}/v1/projects/${project.project_id}/workspaces/${ws.workspace_id}/watch/stream`
      const auth = { 'x-principal-id': 'pi-1' }
      // Live change: subscribe at the CURRENT revision, then write.
      const info = kernel.resolveWorkspace(ws.workspace_id)
      const live = await SseClient.open(`${base}?after_revision=${info.revision}`, auth)
      await live.until(evs => evs.some(e => e.event === 'subscribed'))
      kernel.workspaceWrite(ws.workspace_id, 'live.txt', 'pushed')
      const evsLive = await live.until(evs => evs.some(e => e.event === 'change'))
      expect((evsLive.find(e => e.event === 'change')?.data.node as { path?: string })?.path).toBe('live.txt')
      // Heartbeat on the open stream.
      await live.until(evs => evs.some(e => e.event === 'heartbeat'), 4000)
      live.close()
      // Fail-closed auth matrix.
      await expectSseError(`${base}?after_revision=0`, {}, 422, 'principal_required')
      await expectSseError(`${base}?after_revision=0`, { 'x-principal-id': 'evil' }, 404, 'project_not_found')
      await expectSseError(`${base}?after_revision=-1`, auth, 422, 'invalid_revision')
      // Cross-project workspace via the OTHER project's path → 404 (path binding).
      const foreign = `http://127.0.0.1:${port}/v1/projects/${other.project_id}/workspaces/${ws.workspace_id}/watch/stream?after_revision=0`
      await expectSseError(foreign, auth, 404, 'workspace_not_found')
      // Unknown workspace id → 404.
      await expectSseError(`${base.replace(ws.workspace_id, 'ws_nope')}?after_revision=0`, auth, 404, 'workspace_not_found')
    } finally {
      server.close()
      kernel.close()
    }
  })
})

describe('SSE stream: GET /v1/projects/{id}/trajectory/stream (TRAJ-01)', () => {
  it('replays entries after after_seq with the lane filter (no duplicates, redacted summaries)', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief(), creator_principal_id: 'pi-1' } as never)
    // Seed research + session lane events (payload project_id → one project
    // aggregate bucket, so event_seq is strictly increasing in emit order);
    // the projection redacts raw secrets from every summary.
    kernel.emit(project.project_id, 'job.submitted', { project_id: project.project_id, job_id: 'job_1', kind: 'echo', secret: 'sk-abcdefgh12345678' })
    kernel.emit(project.project_id, 'session.linked', { project_id: project.project_id, session_id: 'sess_1' })
    kernel.emit(project.project_id, 'job.updated', { project_id: project.project_id, job_id: 'job_1', state: 'running' })
    kernel.emit(project.project_id, 'terminal.frame', { project_id: project.project_id, job_id: 'job_1', seq: 1 })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}/v1/projects/${project.project_id}/trajectory/stream`
      const auth = { 'x-principal-id': 'pi-1' }
      // Research lane only: project.created + job.submitted + job.updated.
      const r = await SseClient.open(`${base}?after_seq=0&lane=research`, auth)
      const evsR = await r.until(evs => evs.filter(e => e.event === 'entry').length >= 3)
      expect(r.response.status).toBe(200)
      expect(r.response.headers.get('content-type')).toContain('text/event-stream')
      expect(evsR[0]?.event).toBe('subscribed')
      expect(evsR[0]?.data).toMatchObject({ project_id: project.project_id, lane: 'research', after_seq: 0 })
      const entriesR = evsR.filter(e => e.event === 'entry')
      expect(entriesR.map(e => (e.data as { kind?: string }).kind)).toEqual(['project.created', 'job.submitted', 'job.updated'])
      // Redaction is guaranteed by the projection: no raw secret survives.
      expect(JSON.stringify(evsR)).not.toContain('sk-abcdefgh12345678')
      const lastSeq = entriesR[2]!.data.event_seq as number
      const lastEid = entriesR[2]!.data.entry_id as string
      r.close()
      // Session lane: the 2 session entries only.
      const s = await SseClient.open(`${base}?after_seq=0&lane=session`, auth)
      const evsS = await s.until(evs => evs.filter(e => e.event === 'entry').length >= 2)
      expect(evsS.filter(e => e.event === 'entry').map(e => (e.data as { kind?: string }).kind)).toEqual(['session.linked', 'terminal.frame'])
      s.close()
      // Exact keyset resume from the last research entry ((after_seq,
      // after_event_id) tie-breaker, same as the polling trajectory page):
      // nothing replayed, no duplicate.
      const r2 = await SseClient.open(`${base}?after_seq=${lastSeq}&after_event_id=${lastEid}&lane=research`, auth)
      const evsR2 = await r2.readFor(700)
      expect(evsR2.filter(e => e.event === 'entry')).toHaveLength(0)
      r2.close()
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('pushes live entries, emits heartbeats, and fails closed (422/404)', async () => {
    sseStreamTiming.heartbeatMs = 60
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief(), creator_principal_id: 'pi-1' } as never)
    const other = kernel.createProject({ name: 'o', workspace: '/w', brief: makeBrief(), creator_principal_id: 'bob' } as never)
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const base = `http://127.0.0.1:${port}/v1/projects/${project.project_id}/trajectory/stream`
      const auth = { 'x-principal-id': 'pi-1' }
      // Live: subscribe at seq 0 (project.created replays first), then emit
      // while open — the next entry on the SAME connection is gate.created.
      const live = await SseClient.open(`${base}?after_seq=0&lane=research`, auth)
      await live.until(evs => evs.some(e => e.event === 'entry'))
      kernel.emit(project.project_id, 'gate.created', { project_id: project.project_id, gate_id: 'g_1', type: 'scope' })
      const evsLive = await live.until(evs => evs.filter(e => e.event === 'entry').length >= 2)
      const entriesLive = evsLive.filter(e => e.event === 'entry')
      expect(entriesLive[0]?.data.kind).toBe('project.created')
      expect(entriesLive[1]?.data.kind).toBe('gate.created')
      await live.until(evs => evs.some(e => e.event === 'heartbeat'), 4000)
      live.close()
      // Fail-closed auth matrix.
      await expectSseError(`${base}?after_seq=0`, {}, 422, 'principal_required')
      await expectSseError(`${base}?after_seq=0`, { 'x-principal-id': 'evil' }, 404, 'project_not_found')
      // Non-member of the OTHER project (created by bob) → 404, never forwarded.
      await expectSseError(`http://127.0.0.1:${port}/v1/projects/${other.project_id}/trajectory/stream?after_seq=0`, { 'x-principal-id': 'pi-1' }, 404, 'project_not_found')
    } finally {
      server.close()
      kernel.close()
    }
  })
})
