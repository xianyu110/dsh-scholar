/**
 * PTY-01 interface-layer tests (execution-runtime.md §6.1, acceptance-tests.md
 * §5): durable session state machine (open → attached → detached → closed),
 * idle TTL close, permission revocation, client_seq idempotent control
 * (duplicate replay, reorder 409), monotonic server seq with gap/retention,
 * lease pinning, adapter spawn failure, and the `pty-not-evidence` invariant
 * (PTY output can never produce Metrics, RunManifest, accepted Evidence or
 * Gate Decision — the pty store has no write path into those tables).
 *
 * The real tty adapter is NOT implemented (LocalDockerPty/RemoteRunnerPty
 * are the later adapter round): these tests drive the kernel API with
 * NullPtyAdapter / a recording mock.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, startKernelServer } from '@dsh-scholar/research-kernel'
import { PtySession, PtyControlRequest, PtyOpenRequest, PtyFramesPage, PtyOutputFrame, PtyControlFrame } from '@dsh-scholar/research-schemas'
import { PtyError, NullPtyAdapter, type PtyAdapter, type PtySpawnPlan } from '../../packages/research-kernel/lib/pty-session.js'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pty-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief() {
  return { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' }
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

function control(seq: number, overrides: Record<string, unknown> = {}): PtyControlRequest {
  return PtyControlRequest.parse({
    client_seq: seq,
    type: 'bytes',
    payload: { text: 'ls\n', byte_length: 3 },
    ...overrides,
  })
}

/** Recording mock adapter (the future LocalDockerPty/RemoteRunnerPty shape). */
class RecordingAdapter implements PtyAdapter {
  readonly id = 'test-mock'
  spawned: PtySpawnPlan[] = []
  deliveries: string[] = []
  spawnResult: { ok: true } | { ok: false; error: string } = { ok: true }
  spawn(plan: PtySpawnPlan): { ok: true } | { ok: false; error: string } {
    this.spawned.push(plan)
    return this.spawnResult
  }
  write(sessionId: string, bytes: string): void { this.deliveries.push(`write:${bytes}`) }
  resize(sessionId: string, cols: number, rows: number): void { this.deliveries.push(`resize:${cols}x${rows}`) }
  signal(sessionId: string, signal: 'INT' | 'TERM' | 'KILL'): void { this.deliveries.push(`signal:${signal}`) }
  kill(sessionId: string): void { this.deliveries.push('kill') }
}

describe('pty session (PTY-01 interface layer)', () => {
  it('open pins principal/project/workspace/profile/preset/relative cwd/config hash/lease', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 'scratch-1')
    const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), {
      principal: { principal_id: 'pi-1', tenant_id: 't1' },
    })
    expect(session.state).toBe('open')
    expect(session.generation).toBe(1)
    expect(session.principal_id).toBe('pi-1')
    expect(session.tenant_id).toBe('t1')
    expect(session.project_id).toBe(project.project_id)
    expect(session.workspace_id).toBe(ws.workspace_id)
    expect(session.profile).toBe('local-docker-cpu')
    expect(session.target).toBe('target-1')
    expect(session.preset).toBe('bash')
    expect(session.cwd).toBe('scratch')
    expect(session.config_hash).toMatch(/^(sha256:)?[0-9a-f]{64}$/)
    expect(session.lease_token).toMatch(/^lease_/)
    expect(session.lease_expires_at).not.toBeNull()
    expect(session.adapter_id).toBe('none')
    // The session row round-trips through the schema.
    expect(PtySession.parse(kernel.ptyGet(session.pty_session_id))).toMatchObject({ pty_session_id: session.pty_session_id })
    kernel.close()
  })

  it('state machine: open → attached → detached → closed, closed is terminal', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' } })
    // open → attached bumps generation (reconnect fencing).
    const attached = kernel.ptyAttach(session.pty_session_id)
    expect(attached.state).toBe('attached')
    expect(attached.generation).toBe(2)
    // attached → detached keeps the process alive; generation bumps again.
    const detached = kernel.ptyDetach(session.pty_session_id)
    expect(detached.state).toBe('detached')
    expect(detached.generation).toBe(3)
    // detached → attached = reconnect.
    expect(kernel.ptyAttach(session.pty_session_id).state).toBe('attached')
    // attached → closed.
    const closed = kernel.ptyClose(session.pty_session_id)
    expect(closed.state).toBe('closed')
    expect(closed.close_reason).toBe('explicit')
    expect(closed.closed_at).not.toBeNull()
    // closed is terminal: attach/close are rejected / idempotent.
    expect(() => kernel.ptyAttach(session.pty_session_id)).toThrowError(/expected open\/detached/)
    expect(kernel.ptyClose(session.pty_session_id).state).toBe('closed') // idempotent
    kernel.close()
  })

  it('idle TTL closes the session; activity resets the TTL', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id, { idle_ttl_s: 3600 }), {
      principal: { principal_id: 'pi' },
    })
    expect(session.idle_ttl_s).toBe(3600)
    const openedAt = Date.parse(kernel.ptyGet(session.pty_session_id).last_activity_at)
    // Activity (a control frame) moves last_activity_at forward.
    kernel.ptyControl(session.pty_session_id, control(1))
    const afterControl = Date.parse(kernel.ptyGet(session.pty_session_id).last_activity_at)
    expect(afterControl).toBeGreaterThan(openedAt)
    // Sweep past the OPEN time + 60s: the activity already reset the TTL.
    expect(kernel.ptySweepIdle(openedAt + 61_000)).not.toContain(session.pty_session_id)
    // Sweep past the LAST activity + TTL → idle_ttl close.
    const closedIds = kernel.ptySweepIdle(afterControl + 3600_000 + 5_000)
    expect(closedIds).toContain(session.pty_session_id)
    const closed = kernel.ptyGet(session.pty_session_id)
    expect(closed.state).toBe('closed')
    expect(closed.close_reason).toBe('idle_ttl')
    kernel.close()
  })

  it('permission revocation detaches immediately (process survives); no-op when already detached', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' } })
    kernel.ptyAttach(session.pty_session_id)
    const revoked = kernel.ptyRevoke(session.pty_session_id)
    expect(revoked.state).toBe('detached')
    expect(revoked.close_reason).toBeNull() // session itself stays alive
    const again = kernel.ptyRevoke(session.pty_session_id) // no-op
    expect(again.state).toBe('detached')
    kernel.close()
  })

  it('client_seq idempotency: duplicate seq replays, reorder/gap is 409', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' } })
    const adapter = new RecordingAdapter()
    kernel.setPtyAdapter(adapter)
    const first = kernel.ptyControl(session.pty_session_id, control(1))
    expect(first.idempotent).toBe(false)
    expect(first.delivered).toBe(true)
    expect(adapter.deliveries).toEqual(['write:ls\n'])
    // Duplicate of the LAST applied seq → idempotent replay, no delivery.
    const replay = kernel.ptyControl(session.pty_session_id, control(1, { payload: { text: 'DIFFERENT', byte_length: 9 } }))
    expect(replay.idempotent).toBe(true)
    expect(replay.delivered).toBe(false)
    expect(adapter.deliveries).toEqual(['write:ls\n'])
    // Gap (2 skipped) → 409.
    try {
      kernel.ptyControl(session.pty_session_id, control(3))
      throw new Error('expected PtyError')
    } catch (error) {
      expect(error).toBeInstanceOf(PtyError)
      expect((error as PtyError).code).toBe('pty_client_seq_out_of_order')
    }
    // Next seq after the last applied one succeeds.
    const second = kernel.ptyControl(session.pty_session_id, control(2, { type: 'signal', payload: { signal: 'TERM' } }))
    expect(second.idempotent).toBe(false)
    expect(adapter.deliveries).toEqual(['write:ls\n', 'signal:TERM'])
    // Every control frame is audited in pty_frames (2 frames, 1 per seq);
    // control frames never leak into the OUTPUT replay stream.
    const frames = kernel.ptyFrames(session.pty_session_id, 0)
    expect(frames.frames).toHaveLength(0)
    expect(kernel.pty.frameCount(session.pty_session_id)).toBe(2)
    expect(kernel.ptyGet(session.pty_session_id).last_client_seq).toBe(2)
    kernel.close()
  })

  it('resize and signal controls deliver to the adapter; close control closes the session', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' } })
    const adapter = new RecordingAdapter()
    kernel.setPtyAdapter(adapter)
    kernel.ptyControl(session.pty_session_id, control(1, { type: 'resize', payload: { cols: 132, rows: 43 } }))
    kernel.ptyControl(session.pty_session_id, control(2, { type: 'signal', payload: { signal: 'INT' } }))
    expect(adapter.deliveries).toEqual(['resize:132x43', 'signal:INT'])
    const closed = kernel.ptyControl(session.pty_session_id, control(3, { type: 'close', payload: {} }))
    expect(closed.idempotent).toBe(false)
    expect(kernel.ptyGet(session.pty_session_id).state).toBe('closed')
    expect(kernel.ptyGet(session.pty_session_id).close_reason).toBe('explicit')
    // Controls on a closed session → 409.
    try {
      kernel.ptyControl(session.pty_session_id, control(4))
      throw new Error('expected PtyError')
    } catch (error) {
      expect((error as PtyError).code).toBe('pty_session_closed')
    }
    kernel.close()
  })

  it('output frames: monotonic server seq, replay after_seq, closed rejects more output', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' } })
    kernel.ptyAppendOutput(session.pty_session_id, [
      { type: 'output', text: 'one\n', byte_length: 4 },
      { type: 'output', text: 'two\n', byte_length: 4 },
    ])
    kernel.ptyAppendOutput(session.pty_session_id, [{ type: 'exit', exit_code: 0, signal: null }])
    const page = kernel.ptyFrames(session.pty_session_id, 0)
    expect(page.gap).toBe(false)
    expect(page.frames.map(f => f.server_seq)).toEqual([1, 2, 3])
    expect(page.frames[0]).toMatchObject({ type: 'output', payload: { text: 'one\n' } })
    expect(page.frames[2]).toMatchObject({ type: 'exit', payload: { exit_code: 0 } })
    // Schema round-trip of the page and frames.
    expect(PtyFramesPage.parse(page).frames.length).toBe(3)
    for (const f of page.frames) expect(PtyOutputFrame.parse(f).server_seq).toBeGreaterThan(0)
    // after_seq replay: no duplicates, no loss.
    const tail = kernel.ptyFrames(session.pty_session_id, 2)
    expect(tail.frames.map(f => f.server_seq)).toEqual([3])
    // Exit is not terminal for the SESSION (the process ended, the session
    // stays until explicit close / TTL — but no further output is sane).
    expect(kernel.ptyGet(session.pty_session_id).state).not.toBe('closed')
    // Closed session rejects further output.
    kernel.ptyClose(session.pty_session_id)
    try {
      kernel.ptyAppendOutput(session.pty_session_id, [{ type: 'output', text: 'x', byte_length: 1 }])
      throw new Error('expected PtyError')
    } catch (error) {
      expect((error as PtyError).code).toBe('pty_session_closed')
    }
    kernel.close()
  })

  it('retention: evicted seqs surface as a gap with dropped-byte accounting', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id, { retention_bytes: 16 }), {
      principal: { principal_id: 'pi' },
    })
    // 4 frames of 8 bytes each → retention budget 16 evicts the oldest 2.
    kernel.ptyAppendOutput(session.pty_session_id, [
      { type: 'output', text: 'aaaaaaa\n', byte_length: 8 },
      { type: 'output', text: 'bbbbbbb\n', byte_length: 8 },
    ])
    const second = kernel.ptyAppendOutput(session.pty_session_id, [
      { type: 'output', text: 'ccccccc\n', byte_length: 8 },
      { type: 'output', text: 'ddddddd\n', byte_length: 8 },
    ])
    expect(second.dropped_bytes).toBeGreaterThan(0)
    const s = kernel.ptyGet(session.pty_session_id)
    expect(s.retained_from_seq).toBeGreaterThan(1)
    expect(s.dropped_bytes).toBeGreaterThan(0)
    // A reader starting at seq 0 must be told about the gap, not silence.
    const page = kernel.ptyFrames(session.pty_session_id, 0)
    expect(page.gap).toBe(true)
    expect(page.frames[0]?.type).toBe('gap')
    const gap = page.frames[0] as PtyOutputFrame & { type: 'gap' }
    if (gap.type === 'gap') {
      expect(gap.payload.gap_from_seq).toBe(1)
      expect(gap.payload.dropped_bytes).toBeGreaterThan(0)
    }
    // Reading from the retained cursor replays without a gap.
    const tail = kernel.ptyFrames(session.pty_session_id, s.retained_from_seq)
    expect(tail.gap).toBe(false)
    expect(tail.frames.every(f => f.type === 'output')).toBe(true)
    kernel.close()
  })

  it('open rejects unsafe cwd / unknown project or workspace (fail-closed)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    for (const bad of ['/etc', 'a/../../b', '..', 'C:\\x', 'a\\b']) {
      try {
        kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id, { cwd: bad }), { principal: { principal_id: 'pi' } })
        throw new Error(`expected PtyError for cwd ${bad}`)
      } catch (error) {
        expect(error).toBeInstanceOf(PtyError)
        expect((error as PtyError).code).toBe('pty_open_invalid')
      }
    }
    try {
      kernel.ptyOpen(openRequest('rsp_unknown', ws.workspace_id), { principal: { principal_id: 'pi' } })
      throw new Error('expected unknown-project rejection')
    } catch (error) {
      expect((error as { code: string }).code).toBe('project_not_found')
    }
    try {
      kernel.ptyOpen(openRequest(project.project_id, 'ws_unknown'), { principal: { principal_id: 'pi' } })
      throw new Error('expected unknown-workspace rejection')
    } catch (error) {
      expect((error as PtyError).code).toBe('workspace_not_found')
    }
    // A tex document is a valid workspace (facade resolution).
    const doc = kernel.texEnsure(project.project_id)
    const session = kernel.ptyOpen(openRequest(project.project_id, `ws_${doc.document_id}`), { principal: { principal_id: 'pi' } })
    expect(session.workspace_id).toBe(`ws_${doc.document_id}`)
    kernel.close()
  })

  it('adapter spawn failure closes the session with adapter_failed (row stays for audit)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    const failing = new RecordingAdapter()
    failing.spawnResult = { ok: false, error: 'docker unavailable' }
    try {
      kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' }, adapter: failing })
      throw new Error('expected PtyError')
    } catch (error) {
      expect(error).toBeInstanceOf(PtyError)
      expect((error as PtyError).code).toBe('pty_adapter_failed')
    }
    const sessions = kernel.ptyList(project.project_id)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.state).toBe('closed')
    expect(sessions[0]!.close_reason).toBe('adapter_failed')
    kernel.close()
  })

  it('pty-not-evidence: pty activity never creates Metrics/Manifest/Evidence/Gate rows', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
    const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' } })
    kernel.ptyAttach(session.pty_session_id)
    // Plenty of PTY traffic: input, resize, signal, output, exit.
    for (let i = 1; i <= 5; i += 1) kernel.ptyControl(session.pty_session_id, control(i))
    kernel.ptyAppendOutput(session.pty_session_id, [
      { type: 'output', text: 'experiment result: 0.99\n', byte_length: 26 },
      { type: 'exit', exit_code: 0, signal: null },
    ])
    kernel.ptyDetach(session.pty_session_id)
    kernel.ptyClose(session.pty_session_id)
    // No Job/Run/Evidence/Claim/Gate/Metrics artifacts anywhere in the kernel.
    expect(kernel.listJobs(project.project_id)).toHaveLength(0)
    expect(kernel.listRuns(project.project_id)).toHaveLength(0)
    expect(kernel.listEvidence(project.project_id)).toHaveLength(0)
    expect(kernel.listClaims(project.project_id)).toHaveLength(0)
    expect(kernel.listGates(project.project_id)).toHaveLength(0)
    expect(kernel.listArtifacts(project.project_id)).toHaveLength(0)
    // The only frame rows are the pty frames themselves.
    const db = (kernel as unknown as { db: { prepare: (sql: string) => { get: (...a: unknown[]) => { n: number } } } }).db
    const terminalRows = db.prepare('SELECT COUNT(*) AS n FROM terminal_frames').get() as { n: number }
    expect(terminalRows.n).toBe(0)
    const ptyRows = db.prepare('SELECT COUNT(*) AS n FROM pty_frames').get() as { n: number }
    expect(ptyRows.n).toBeGreaterThan(0)
    kernel.close()
  })

  it('wire schemas validate strictly: bad presets/seqs/payloads are rejected', () => {
    // PtyOpenRequest: unknown preset / extra keys / bad config hash.
    expect(() => PtyOpenRequest.parse({ project_id: 'p', workspace_id: 'w', profile: 'x', target: 't', preset: 'powershell', cwd: '.' })).toThrowError()
    expect(() => PtyOpenRequest.parse({ project_id: 'p', workspace_id: 'w', profile: 'x', target: 't', preset: 'sh', cwd: '.', extra: 1 })).toThrowError(/Unrecognized key/)
    expect(() => PtyOpenRequest.parse({ project_id: 'p', workspace_id: 'w', profile: 'x', target: 't', preset: 'sh', cwd: '.', config_hash: 'nope' })).toThrowError()
    // PtyControlRequest: negative seq, zero cols, unknown signal, unknown type.
    expect(() => PtyControlRequest.parse({ client_seq: -1, type: 'bytes', payload: { text: 'x', byte_length: 1 } })).toThrowError()
    expect(() => PtyControlRequest.parse({ client_seq: 1, type: 'resize', payload: { cols: 0, rows: 24 } })).toThrowError()
    expect(() => PtyControlRequest.parse({ client_seq: 1, type: 'signal', payload: { signal: 'SIGKILL' } })).toThrowError()
    expect(() => PtyControlRequest.parse({ client_seq: 1, type: 'explode', payload: {} })).toThrowError()
    // PtyControlFrame (full wire record) round-trips.
    const frame = PtyControlFrame.parse({ pty_session_id: 'pty_x', client_seq: 1, type: 'signal', payload: { signal: 'TERM' }, created_at: new Date().toISOString() })
    expect(frame.type).toBe('signal')
    expect(() => PtyControlFrame.parse({ pty_session_id: 'pty_x', client_seq: 1, type: 'signal', payload: { signal: 'TERM' } })).toThrowError() // created_at required
    // NullPtyAdapter is the shipped default (no real tty).
    const adapter = new NullPtyAdapter()
    expect(adapter.id).toBe('null')
    expect(adapter.spawn({} as PtySpawnPlan)).toEqual({ ok: true })
    adapter.write('s', 'x')
    expect(adapter.deliveries).toHaveLength(1)
  })

  it('HTTP /v1/pty/*: schema validation (422), open is 501 until an adapter, control/frames work on kernel-created sessions', async () => {
    const kernel = freshKernel()
    const { server, url } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
    try {
      const projResp = await fetch(`${url}/v1/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 't', workspace: '/w', brief: makeBrief() }),
      })
      expect(projResp.status).toBe(201)
      const project = (await projResp.json()) as { project_id: string }
      const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
      const body = (o: Record<string, unknown>) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) })

      // Open: schema validation first — bad preset → 422 validation_error.
      const badOpen = await fetch(`${url}/v1/pty/sessions`, body({
        project_id: project.project_id, workspace_id: ws.workspace_id, profile: 'p', target: 't', preset: 'powershell', cwd: '.',
      }))
      expect(badOpen.status).toBe(422)
      const badOpenJson = (await badOpen.json()) as { error: { code: string } }
      expect(badOpenJson.error.code).toBe('validation_error')
      // Open: unknown project → 404; valid request → 501 pty_adapter_not_implemented
      // (no adapter is registered — the interface layer never fakes a session).
      const unknownProject = await fetch(`${url}/v1/pty/sessions`, body({
        project_id: 'rsp_missing', workspace_id: ws.workspace_id, profile: 'p', target: 't', preset: 'bash', cwd: '.',
      }))
      expect(unknownProject.status).toBe(404)
      const openResp = await fetch(`${url}/v1/pty/sessions`, body({
        project_id: project.project_id, workspace_id: ws.workspace_id, profile: 'p', target: 't', preset: 'bash', cwd: '.',
      }))
      expect(openResp.status).toBe(501)
      expect(((await openResp.json()) as { error: { code: string } }).error.code).toBe('pty_adapter_not_implemented')

      // Control/frames against an unknown session → 404 (fail-closed).
      const control404 = await fetch(`${url}/v1/pty/sessions/pty_nope/control`, body({ client_seq: 1, type: 'bytes', payload: { text: 'x', byte_length: 1 } }))
      expect(control404.status).toBe(404)
      expect(((await control404.json()) as { error: { code: string } }).error.code).toBe('pty_session_not_found')
      // Control schema validation → 422.
      const control422 = await fetch(`${url}/v1/pty/sessions/pty_nope/control`, body({ client_seq: -1, type: 'bytes', payload: { text: 'x', byte_length: 1 } }))
      expect(control422.status).toBe(422)
      // Frames: bad after_seq → 422; unknown session → 404.
      const frames422 = await fetch(`${url}/v1/pty/sessions/pty_nope/frames?after_seq=abc`)
      expect(frames422.status).toBe(422)
      expect(((await frames422.json()) as { error: { code: string } }).error.code).toBe('pty_after_seq_invalid')
      const frames404 = await fetch(`${url}/v1/pty/sessions/pty_nope/frames?after_seq=0`)
      expect(frames404.status).toBe(404)

      // A session created through the kernel API (the adapter injection point)
      // is drivable over HTTP: control applies with delivered=false, frames
      // replay, and the session record is readable.
      const session = kernel.ptyOpen({ project_id: project.project_id, workspace_id: ws.workspace_id, profile: 'p', target: 't', preset: 'sh', cwd: '.' }, {
        principal: { principal_id: 'pi' },
      })
      const getResp = await fetch(`${url}/v1/pty/sessions/${session.pty_session_id}`)
      expect(getResp.status).toBe(200)
      expect(((await getResp.json()) as { state: string }).state).toBe('open')
      const ctlResp = await fetch(`${url}/v1/pty/sessions/${session.pty_session_id}/control`, body({ client_seq: 1, type: 'bytes', payload: { text: 'ls\n', byte_length: 3 } }))
      expect(ctlResp.status).toBe(200)
      const ctl = (await ctlResp.json()) as { idempotent: boolean; delivered: boolean }
      expect(ctl.idempotent).toBe(false)
      expect(ctl.delivered).toBe(false) // honest: no real tty behind the session
      const dupResp = await fetch(`${url}/v1/pty/sessions/${session.pty_session_id}/control`, body({ client_seq: 1, type: 'bytes', payload: { text: 'ls\n', byte_length: 3 } }))
      expect(((await dupResp.json()) as { idempotent: boolean }).idempotent).toBe(true)
      const framesResp = await fetch(`${url}/v1/pty/sessions/${session.pty_session_id}/frames?after_seq=0`)
      expect(framesResp.status).toBe(200)
      const page = (await framesResp.json()) as { pty_session_id: string; gap: boolean; frames: unknown[] }
      expect(page.pty_session_id).toBe(session.pty_session_id)
      expect(page.gap).toBe(false)
      expect(page.frames).toHaveLength(0) // control frames never leak into output
      // Close via HTTP control.
      const closeResp = await fetch(`${url}/v1/pty/sessions/${session.pty_session_id}/control`, body({ client_seq: 2, type: 'close', payload: {} }))
      expect(closeResp.status).toBe(200)
      expect((await fetch(`${url}/v1/pty/sessions/${session.pty_session_id}`)).status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      kernel.close()
    }
  })
})
