/**
 * PTY-01 (execution-runtime.md §6.1, acceptance-tests.md §5) — LocalPtyAdapter
 * REAL pseudo-terminal tests (pty-local.ts + python3 bridge).
 *
 * Unlike pty-session.test.ts (interface layer, NullPtyAdapter), these tests
 * allocate an actual tty through `python3 pty.fork()`: shell echo round-trip,
 * resize, INT/TERM/KILL, detach/reconnect with the process surviving, explicit
 * close, idle-TTL close, the environment whitelist (DSH token / host $HOME /
 * host paths must never reach the shell), preset rejection, the HTTP open
 * route (principal + membership) and the `pty-not-evidence` invariant with a
 * REAL adapter behind the session.
 *
 * When python3 (or a usable tty) is unavailable the suite SKIPs honestly —
 * but this machine has python3 3.12 and runs everything for real.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, startKernelServer, LocalPtyAdapter } from '@dsh-scholar/research-kernel'
import { PtyOpenRequest, PtyControlRequest } from '@dsh-scholar/research-schemas'
import type { PtySpawnPlan } from '../../packages/research-kernel/lib/pty-session.js'

/** Honest capability probe: skip (never fake-pass) when no python3/tty. */
const PYTHON_PROBE = spawnSync('python3', ['--version'], { encoding: 'utf8', timeout: 10_000 })
const PTY_AVAILABLE = PYTHON_PROBE.error === undefined && PYTHON_PROBE.status === 0

function freshPtyKernel(): { kernel: ResearchKernel; adapter: LocalPtyAdapter; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pty-local-'))
  const kernel = new ResearchKernel({
    dbPath: join(dir, 'kernel.db'),
    casRoot: join(dir, 'cas'),
    requireSignedManifest: false,
    ptyIdleSweepMs: 0, // deterministic: the suite drives the sweep explicitly
  })
  const adapter = new LocalPtyAdapter({
    workspaceRoot: join(dir, 'pty-workspaces'),
    onOutput: (sessionId, frames) => {
      kernel.ptyAppendOutput(sessionId, frames)
    },
    log: () => { /* silence expected bridge chatter */ },
  })
  kernel.setPtyAdapter(adapter)
  return { kernel, adapter, dir }
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
    payload: { text: 'true\n', byte_length: 5 },
    ...overrides,
  })
}

/** Build a shell line whose OUTPUT contains `marker` but whose ECHOED INPUT
 * never does — the pty echoes typed bytes, so a plain `echo X` would match
 * waitFor on the input echo before the real output exists. */
function markerCmd(marker: string): { text: string; byte_length: number } {
  const text = `echo "${marker}=$(printf ok)"\n`
  return { text, byte_length: Buffer.byteLength(text) }
}

/** Poll the session's frames until `text` appears (or a timeout). */
async function waitForText(kernel: ResearchKernel, sessionId: string, text: string, timeoutMs = 10_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  let last: string[] = []
  while (Date.now() < deadline) {
    const page = kernel.ptyFrames(sessionId, 0)
    last = page.frames.filter(f => f.type === 'output').map(f => (f.type === 'output' ? f.payload.text : ''))
    if (last.join('').includes(text)) return last
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`timeout waiting for ${JSON.stringify(text)} in pty output; frames=${JSON.stringify(last)}`)
}

/** Poll until an exit frame appears. */
async function waitForExit(kernel: ResearchKernel, sessionId: string, timeoutMs = 10_000): Promise<{ exit_code: number | null; signal: string | null }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const page = kernel.ptyFrames(sessionId, 0)
    const exit = page.frames.find(f => f.type === 'exit')
    if (exit !== undefined) {
      return exit.type === 'exit' ? { exit_code: exit.payload.exit_code, signal: exit.payload.signal } : { exit_code: null, signal: null }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('timeout waiting for pty exit frame')
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('LocalPtyAdapter (PTY-01 real pseudo-terminal)', () => {
  it.skipIf(!PTY_AVAILABLE)('python3 probe: adapter resolves the bridge and allocates a real tty', async () => {
    const { kernel, adapter, dir } = freshPtyKernel()
    try {
      expect(adapter.available).toBe(true)
      expect(adapter.python3Path).toBe('python3')
      // The bridge script is materialized under the runtime dir.
      expect(existsSync(join(dir, 'pty-workspaces', '.dsh-pty-runtime', 'pty-bridge.py'))).toBe(true)
      const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
      const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
      const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' } })
      expect(session.adapter_id).toBe('local-pty')
      expect(session.state).toBe('open')
      expect(adapter.liveSessions).toBe(1)
    } finally {
      kernel.close()
      // close() tears every live tty down (no orphans) — the bridge teardown
      // is async (shutdown op → bridge exits), so poll it down.
      const deadline = Date.now() + 5000
      while (adapter.liveSessions > 0 && Date.now() < deadline) await sleep(50)
      expect(adapter.liveSessions).toBe(0)
    }
  })

  it.skipIf(!PTY_AVAILABLE)('open + write round-trip: real shell echoes input and executes a command', async () => {
    const { kernel } = freshPtyKernel()
    try {
      const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
      const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
      const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' } })
      kernel.ptyAttach(session.pty_session_id)
      // The pty echoes what we type (real tty), then the command output lands.
      // The wait target is output-only: the echoed input says
      // `PTY-ROUNDTRIP-$((40+2))`, the real output says PTY-ROUNDTRIP-42.
      kernel.ptyControl(session.pty_session_id, control(1, { payload: { text: 'echo PTY-ROUNDTRIP-$((40+2))\n', byte_length: 30 } }))
      const frames = await waitForText(kernel, session.pty_session_id, 'PTY-ROUNDTRIP-42')
      expect(frames.join('')).toContain('PTY-ROUNDTRIP-42')
      kernel.ptyClose(session.pty_session_id)
    } finally {
      kernel.close()
    }
  })

  it.skipIf(!PTY_AVAILABLE)('resize: stty reports the new window size', async () => {
    const { kernel } = freshPtyKernel()
    try {
      const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
      const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
      const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' } })
      kernel.ptyAttach(session.pty_session_id)
      kernel.ptyControl(session.pty_session_id, control(1, { type: 'resize', payload: { cols: 132, rows: 43 } }))
      kernel.ptyControl(session.pty_session_id, control(2, { payload: { text: 'stty size\n', byte_length: 10 } }))
      const frames = await waitForText(kernel, session.pty_session_id, '43 132')
      expect(frames.join('')).toContain('43 132')
      kernel.ptyClose(session.pty_session_id)
    } finally {
      kernel.close()
    }
  })

  it.skipIf(!PTY_AVAILABLE)('signal: INT interrupts a foreground job (shell survives); TERM terminates a job; KILL terminates the shell with an exit frame', async () => {
    const { kernel } = freshPtyKernel()
    try {
      const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
      const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
      const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' } })
      kernel.ptyAttach(session.pty_session_id)
      // Long-running foreground job.
      kernel.ptyControl(session.pty_session_id, control(1, { payload: { text: 'sleep 60\n', byte_length: 9 } }))
      await sleep(500)
      // INT → the foreground sleep dies, the shell survives (still usable).
      kernel.ptyControl(session.pty_session_id, control(2, { type: 'signal', payload: { signal: 'INT' } }))
      await sleep(600)
      expect(kernel.ptyFrames(session.pty_session_id, 0).frames.some(f => f.type === 'exit')).toBe(false)
      kernel.ptyControl(session.pty_session_id, control(3, { payload: markerCmd('INT-SURVIVED') }))
      expect((await waitForText(kernel, session.pty_session_id, 'INT-SURVIVED=ok')).join('')).toContain('INT-SURVIVED=ok')
      // TERM → the foreground job (sleep, default TERM disposition) dies;
      // interactive shells ignore SIGTERM by design, so the shell survives.
      kernel.ptyControl(session.pty_session_id, control(4, { payload: { text: 'sleep 60\n', byte_length: 9 } }))
      await sleep(500)
      kernel.ptyControl(session.pty_session_id, control(5, { type: 'signal', payload: { signal: 'TERM' } }))
      await sleep(600)
      kernel.ptyControl(session.pty_session_id, control(6, { payload: markerCmd('TERM-SURVIVED') }))
      expect((await waitForText(kernel, session.pty_session_id, 'TERM-SURVIVED=ok')).join('')).toContain('TERM-SURVIVED=ok')
      // KILL with no foreground job → the shell (fg pgrp) dies, uncatchable;
      // the bridge reports the exit frame with the signal.
      kernel.ptyControl(session.pty_session_id, control(7, { type: 'signal', payload: { signal: 'KILL' } }))
      const exit = await waitForExit(kernel, session.pty_session_id)
      expect(exit.signal).toBe('SIGKILL')
      // The session row survives the process exit (close is still explicit).
      expect(kernel.ptyGet(session.pty_session_id).state).not.toBe('closed')
      kernel.ptyClose(session.pty_session_id)
    } finally {
      kernel.close()
    }
  })

  it.skipIf(!PTY_AVAILABLE)('detach/reconnect: the process keeps running while detached, output is retained, replay is duplicate-free', async () => {
    const { kernel } = freshPtyKernel()
    try {
      const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
      const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
      const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' } })
      const id = session.pty_session_id
      kernel.ptyAttach(id)
      // A command that produces output AFTER a detach would have happened.
      // (markerCmd keeps the wait targets output-only — the pty echoes input.)
      kernel.ptyControl(id, control(1, { payload: {
        text: 'echo "DETACH-BEFORE=$(printf ok)"; sleep 1; echo "DETACH-AFTER=$(printf ok)"\n',
        byte_length: Buffer.byteLength('echo "DETACH-BEFORE=$(printf ok)"; sleep 1; echo "DETACH-AFTER=$(printf ok)"\n'),
      } }))
      // Detach mid-command: the wire is down but the process must live on
      // (execution-runtime.md §6.1 — a PTY disconnect never ends the process).
      const detached = kernel.ptyDetach(id)
      expect(detached.state).toBe('detached')
      // The adapter keeps draining into the store while detached.
      const frames = await waitForText(kernel, id, 'DETACH-AFTER=ok')
      const joined = frames.join('')
      expect(joined).toContain('DETACH-BEFORE=ok')
      expect(joined).toContain('DETACH-AFTER=ok')
      // Reconnect: open|detached → attached, generation bumps (fencing).
      const reattached = kernel.ptyAttach(id)
      expect(reattached.state).toBe('attached')
      expect(reattached.generation).toBeGreaterThan(detached.generation)
      // Monotonic server_seq — no duplicates across the whole replay.
      const all = kernel.ptyFrames(id, 0).frames
      const seqs = all.map(f => f.server_seq)
      expect(new Set(seqs).size).toBe(seqs.length)
      kernel.ptyClose(id)
    } finally {
      kernel.close()
    }
  })

  it.skipIf(!PTY_AVAILABLE)('explicit close: session closes and the real tty/process is torn down (adapter live count drops)', async () => {
    const { kernel, adapter } = freshPtyKernel()
    try {
      const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
      const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
      const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' } })
      const id = session.pty_session_id
      kernel.ptyAttach(id)
      kernel.ptyControl(id, control(1, { payload: markerCmd('BEFORE-CLOSE') }))
      await waitForText(kernel, id, 'BEFORE-CLOSE=ok')
      expect(adapter.liveSessions).toBe(1)
      // close control → state machine closes AND the adapter tears the tty down.
      const closed = kernel.ptyControl(id, control(2, { type: 'close', payload: {} }))
      expect(closed.idempotent).toBe(false)
      expect(kernel.ptyGet(id).state).toBe('closed')
      // The bridge + shell session exit; no orphan processes remain.
      const deadline = Date.now() + 5000
      while (adapter.liveSessions > 0 && Date.now() < deadline) await sleep(50)
      expect(adapter.liveSessions).toBe(0)
      // Controls on a closed session → 409.
      try {
        kernel.ptyControl(id, control(3))
        throw new Error('expected PtyError')
      } catch (error) {
        expect((error as { code: string }).code).toBe('pty_session_closed')
      }
    } finally {
      kernel.close()
    }
  })

  it.skipIf(!PTY_AVAILABLE)('idle TTL: the kernel sweep closes the session and tears the real tty down', async () => {
    const { kernel, adapter } = freshPtyKernel()
    try {
      const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
      const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
      const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id, { idle_ttl_s: 60 }), {
        principal: { principal_id: 'pi' },
      })
      const id = session.pty_session_id
      kernel.ptyAttach(id)
      kernel.ptyControl(id, control(1, { payload: markerCmd('TTL-PROBE') }))
      await waitForText(kernel, id, 'TTL-PROBE=ok')
      expect(adapter.liveSessions).toBe(1)
      const openedAt = Date.parse(kernel.ptyGet(id).last_activity_at)
      const closedIds = kernel.ptySweepIdle(openedAt + 61_000)
      expect(closedIds).toContain(id)
      expect(kernel.ptyGet(id).state).toBe('closed')
      expect(kernel.ptyGet(id).close_reason).toBe('idle_ttl')
      const deadline = Date.now() + 5000
      while (adapter.liveSessions > 0 && Date.now() < deadline) await sleep(50)
      expect(adapter.liveSessions).toBe(0)
    } finally {
      kernel.close()
    }
  })

  it.skipIf(!PTY_AVAILABLE)('env whitelist: DSH/service/model credentials, host $HOME and host paths never reach the shell', async () => {
    // Seed the KERNEL process environment with realistic secrets — the
    // adapter must not forward any of them (whitelist + bridge re-filter).
    const original = {
      DSH_SCHOLAR_KERNEL_TOKEN: process.env.DSH_SCHOLAR_KERNEL_TOKEN,
      DSH_SCHOLAR_SERVICE_TOKEN: process.env.DSH_SCHOLAR_SERVICE_TOKEN,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    }
    process.env.DSH_SCHOLAR_KERNEL_TOKEN = 'secret-kernel-token-abc'
    process.env.DSH_SCHOLAR_SERVICE_TOKEN = 'secret-service-token-xyz'
    process.env.OPENAI_API_KEY = 'sk-model-credential-123'
    const { kernel, adapter, dir } = freshPtyKernel()
    try {
      const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
      const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
      const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' } })
      kernel.ptyAttach(session.pty_session_id)
      const probe = [
        'echo "TOKEN-LEAK=[${DSH_SCHOLAR_KERNEL_TOKEN:-none}]"',
        'echo "SERVICE-LEAK=[${DSH_SCHOLAR_SERVICE_TOKEN:-none}]"',
        'echo "MODEL-LEAK=[${OPENAI_API_KEY:-none}]"',
        'echo "HOME-IS=$HOME"',
        'echo "TERM-IS=$TERM"',
        'echo "PATH-HAS=$(command -v ls)"',
      ].join('; ') + '\n'
      kernel.ptyControl(session.pty_session_id, control(1, { payload: { text: probe, byte_length: Buffer.byteLength(probe) } }))
      // The pty echoes the typed probe; every wait below targets OUTPUT text
      // that cannot appear in the echoed input (e.g. the sandbox path).
      await waitForText(kernel, session.pty_session_id, 'pty-workspaces')
      await waitForText(kernel, session.pty_session_id, 'TERM-IS=xterm-256color')
      await waitForText(kernel, session.pty_session_id, 'PATH-HAS=/')
      const frames = await waitForText(kernel, session.pty_session_id, 'MODEL-LEAK=[none]')
      // and the final joined output
      await waitForText(kernel, session.pty_session_id, 'SERVICE-LEAK=[none]')
      const all = frames.join('')
      expect(all).toContain('TOKEN-LEAK=[none]')
      expect(all).toContain('SERVICE-LEAK=[none]')
      expect(all).toContain('MODEL-LEAK=[none]')
      // HOME is redirected into the workspace sandbox — never the host $HOME.
      const sandboxHome = join(dir, 'pty-workspaces', ws.workspace_id)
      expect(all).toContain(`HOME-IS=${sandboxHome}`)
      expect(all).not.toContain('/home/')
      expect(all).toContain('TERM-IS=xterm-256color')
      expect(all).toContain('PATH-HAS=/')
      // The adapter never touches the host home for the session cwd either.
      expect(adapter.workspaceRoot).toBe(join(dir, 'pty-workspaces'))
      kernel.ptyClose(session.pty_session_id)
    } finally {
      if (original.DSH_SCHOLAR_KERNEL_TOKEN === undefined) delete process.env.DSH_SCHOLAR_KERNEL_TOKEN
      else process.env.DSH_SCHOLAR_KERNEL_TOKEN = original.DSH_SCHOLAR_KERNEL_TOKEN
      if (original.DSH_SCHOLAR_SERVICE_TOKEN === undefined) delete process.env.DSH_SCHOLAR_SERVICE_TOKEN
      else process.env.DSH_SCHOLAR_SERVICE_TOKEN = original.DSH_SCHOLAR_SERVICE_TOKEN
      if (original.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = original.OPENAI_API_KEY
      kernel.close()
    }
  })

  it.skipIf(!PTY_AVAILABLE)('cwd containment + preset rejection: spawn plans are validated at the adapter boundary', () => {
    const { kernel, adapter, dir } = freshPtyKernel()
    try {
      const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
      const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
      // Host-path cwd attempts are rejected even if a caller bypasses the
      // kernel schema (defense in depth at the adapter).
      const bad: PtySpawnPlan = {
        pty_session_id: 'pty_bad_cwd', project_id: project.project_id, workspace_id: ws.workspace_id,
        preset: 'bash', cwd: '../../../etc', cols: 80, rows: 24, profile: 'p', target: 't',
        config_hash: kernel.configPinHash, lease_token: 'lease_x',
      }
      const result = adapter.spawn(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/\.\.|escape|root-relative/)
      // Unknown preset (schema-invalid value smuggled through a cast).
      const badPreset = adapter.spawn({ ...bad, cwd: '.', preset: 'powershell' as never })
      expect(badPreset.ok).toBe(false)
      if (!badPreset.ok) expect(badPreset.error).toMatch(/preset/)
      // The kernel route validates the same boundary (422).
      try {
        kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id, { cwd: '/etc' }), {
          principal: { principal_id: 'pi' },
        })
        throw new Error('expected PtyError')
      } catch (error) {
        expect((error as { code: string }).code).toBe('pty_open_invalid')
      }
      // adapter_failed path: python3 missing → honest spawn failure.
      const kernel2 = new ResearchKernel({ requireSignedManifest: false, ptyIdleSweepMs: 0 })
      const dead = new LocalPtyAdapter({ python3: '/nonexistent/python3', workspaceRoot: join(dir, 'nopython'), onOutput: () => {} })
      kernel2.setPtyAdapter(dead)
      const project2 = kernel2.createProject({ name: 'p2', workspace: '/w2', brief: makeBrief() })
      const ws2 = kernel2.workspaceEnsure(project2.project_id, 'scratch', 's2')
      try {
        kernel2.ptyOpen(openRequest(project2.project_id, ws2.workspace_id), { principal: { principal_id: 'pi' } })
        throw new Error('expected pty_adapter_failed')
      } catch (error) {
        expect((error as { code: string }).code).toBe('pty_adapter_failed')
      }
      const sessions = kernel2.ptyList(project2.project_id)
      expect(sessions[sessions.length - 1]!.close_reason).toBe('adapter_failed')
      kernel2.close()
    } finally {
      kernel.close()
    }
  })

  it.skipIf(!PTY_AVAILABLE)('pty-not-evidence (real adapter): pty traffic never creates Metrics/Manifest/Evidence/Gate rows', async () => {
    const { kernel } = freshPtyKernel()
    try {
      const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
      const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
      const session = kernel.ptyOpen(openRequest(project.project_id, ws.workspace_id), { principal: { principal_id: 'pi' } })
      kernel.ptyAttach(session.pty_session_id)
      kernel.ptyControl(session.pty_session_id, control(1, { payload: markerCmd('METRIC-0.99') }))
      await waitForText(kernel, session.pty_session_id, 'METRIC-0.99=ok')
      // Signals are delivered to the pty's foreground pgrp (real terminal
      // semantics): with no job running that is the shell itself.
      kernel.ptyControl(session.pty_session_id, control(2, { type: 'resize', payload: { cols: 100, rows: 30 } }))
      kernel.ptyControl(session.pty_session_id, control(3, { type: 'signal', payload: { signal: 'INT' } }))
      kernel.ptyControl(session.pty_session_id, control(4, { type: 'close', payload: {} }))
      // PTY output is auditable + retained, but it is NOT a Job log: no
      // business rows anywhere, frames live only in pty_frames.
      expect(kernel.listJobs(project.project_id)).toHaveLength(0)
      expect(kernel.listRuns(project.project_id)).toHaveLength(0)
      expect(kernel.listEvidence(project.project_id)).toHaveLength(0)
      expect(kernel.listClaims(project.project_id)).toHaveLength(0)
      expect(kernel.listGates(project.project_id)).toHaveLength(0)
      expect(kernel.listArtifacts(project.project_id)).toHaveLength(0)
      const db = (kernel as unknown as { db: { prepare: (sql: string) => { get: (...a: unknown[]) => { n: number } } } }).db
      const terminalRows = db.prepare('SELECT COUNT(*) AS n FROM terminal_frames').get() as { n: number }
      expect(terminalRows.n).toBe(0)
      const ptyRows = db.prepare('SELECT COUNT(*) AS n FROM pty_frames').get() as { n: number }
      expect(ptyRows.n).toBeGreaterThan(0)
    } finally {
      kernel.close()
    }
  })

  it.skipIf(!PTY_AVAILABLE)('HTTP open route with a real adapter: 201 + principal/membership fail-closed, control owner check, frames replay', async () => {
    const { kernel } = freshPtyKernel()
    const { server, url } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
    try {
      const project = kernel.createProject({
        name: 't', workspace: '/w', brief: makeBrief(), creator_principal_id: 'pi-1',
      })
      const ws = kernel.workspaceEnsure(project.project_id, 'scratch', 's')
      const jsonHeaders = { 'content-type': 'application/json' }
      const body = (o: Record<string, unknown>, headers: Record<string, string> = {}) => ({
        method: 'POST', headers: { ...jsonHeaders, ...headers }, body: JSON.stringify(o),
      })
      const openBody = {
        project_id: project.project_id, workspace_id: ws.workspace_id, profile: 'p', target: 't', preset: 'bash', cwd: '.',
      }
      // Missing principal → 422 principal_required (fail-closed).
      const noPrincipal = await fetch(`${url}/v1/pty/sessions`, body(openBody))
      expect(noPrincipal.status).toBe(422)
      expect(((await noPrincipal.json()) as { error: { code: string } }).error.code).toBe('principal_required')
      // Non-member principal → 404 project_not_found.
      const nonMember = await fetch(`${url}/v1/pty/sessions`, body(openBody, { 'x-principal-id': 'outsider' }))
      expect(nonMember.status).toBe(404)
      // Member opens a REAL session → 201, pinned principal, adapter id.
      const openResp = await fetch(`${url}/v1/pty/sessions`, body(openBody, { 'x-principal-id': 'pi-1' }))
      expect(openResp.status).toBe(201)
      const session = (await openResp.json()) as { pty_session_id: string; principal_id: string; adapter_id: string; state: string }
      expect(session.principal_id).toBe('pi-1')
      expect(session.adapter_id).toBe('local-pty')
      // Control with a DIFFERENT authenticated principal → 403.
      const wrongOwner = await fetch(`${url}/v1/pty/sessions/${session.pty_session_id}/control`, body(
        { client_seq: 1, type: 'bytes', payload: { text: 'echo X\n', byte_length: 7 } },
        { 'x-principal-id': 'someone-else' },
      ))
      expect(wrongOwner.status).toBe(403)
      expect(((await wrongOwner.json()) as { error: { code: string } }).error.code).toBe('pty_principal_mismatch')
      // Owner drives the real tty over HTTP and replays frames.
      const ctlText = `echo "HTTP-PTY-OK=$(printf ok)"\n`
      const ctl = await fetch(`${url}/v1/pty/sessions/${session.pty_session_id}/control`, body(
        { client_seq: 1, type: 'bytes', payload: { text: ctlText, byte_length: Buffer.byteLength(ctlText) } },
        { 'x-principal-id': 'pi-1' },
      ))
      expect(ctl.status).toBe(200)
      expect(((await ctl.json()) as { delivered: boolean }).delivered).toBe(true)
      const deadline = Date.now() + 10_000
      let text = ''
      while (Date.now() < deadline) {
        const page = (await (await fetch(`${url}/v1/pty/sessions/${session.pty_session_id}/frames?after_seq=0`)).json()) as {
          frames: Array<{ type: string; payload: { text?: string } }>
        }
        text = page.frames.filter(f => f.type === 'output').map(f => f.payload.text ?? '').join('')
        if (text.includes('HTTP-PTY-OK=ok')) break
        await sleep(50)
      }
      expect(text).toContain('HTTP-PTY-OK=ok')
      // Close via HTTP control → closed + the real tty is gone.
      const closeResp = await fetch(`${url}/v1/pty/sessions/${session.pty_session_id}/control`, body(
        { client_seq: 2, type: 'close', payload: {} },
        { 'x-principal-id': 'pi-1' },
      ))
      expect(closeResp.status).toBe(200)
      const afterClose = (await (await fetch(`${url}/v1/pty/sessions/${session.pty_session_id}`)).json()) as { state: string }
      expect(afterClose.state).toBe('closed')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      kernel.close()
    }
  })
})
