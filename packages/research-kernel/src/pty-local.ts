/**
 * PTY-01 (execution-runtime.md §6.1, hardening-v0.2-status.md §3/§4) —
 * LocalPtyAdapter: a REAL pseudo-terminal behind the PtyAdapter contract
 * (pty-session.ts), allocated through a Python3 bridge.
 *
 * Node has no built-in PTY, so this adapter spawns a small `python3` bridge
 * that calls `pty.fork()` and `os.execvpe(preset shell)` — the child gets a
 * genuine controlling tty (session leader, job control). Wire between the
 * adapter and the bridge:
 *
 *   fd 0  raw bytes  → pty master (input)
 *   fd 1  pty master → raw bytes (output)
 *   fd 2  bridge diagnostics (stderr, adapter log only)
 *   fd 3  control IN,  JSON lines: {"op":"resize"|"signal"|"shutdown", ...}
 *   fd 4  control OUT, JSON lines: {"event":"exit"|"error", ...}
 *
 * SECURITY (execution-runtime.md §6.1):
 *   - the shell preset is an enum→argv whitelist (sh/bash/zsh/fish), the cwd
 *     is re-validated root-relative and contained under the workspace root;
 *   - the environment is a WHITELIST (PATH/TERM/LANG/…, HOME redirected into
 *     the workspace sandbox — the host $HOME with ~/.ssh is never inherited);
 *     the bridge additionally strips DSH_-prefixed / token / secret /
 *     credential names so no Kernel token, service token or model credential
 *     can reach the shell;
 *   - no Docker socket, SSH credential, Kernel token or host path is ever
 *     exposed on the wire — the browser only ever sees opaque session ids,
 *     presets and relative cwds (pty-safe-open).
 *
 * LIFECYCLE: the bridge is owned by the KERNEL adapter, never by a browser
 * wire — a client disconnect (detach) does NOT end the process; output keeps
 * flowing into the session store (server_seq/retention) and a later
 * reconnect replays after the client cursor. Only an explicit close, the
 * idle-TTL sweep or lease expiry (kernel → adapter.kill) tears the session
 * down. Exit ordering: the bridge drains the master before reporting exit,
 * and this adapter waits for the stdout stream to end before emitting the
 * `exit` frame, so output frames always precede the exit frame.
 *
 * NOT a formal Job log: output is auditable + bounded-retained only. Nothing
 * here (or in pty-session.ts) writes to jobs/runs/evidence/gates/metrics
 * (pinned by pty-session.test.ts `pty-not-evidence` and re-asserted in
 * tests/unit/pty-local.test.ts).
 * @module @dsh-scholar/research-kernel/pty-local
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import type { PtySignal } from '@dsh-scholar/research-schemas'
import type { PtyAdapter, PtySpawnPlan } from './pty-session.js'

/** One output/exit frame the adapter pushes into the session store. */
export interface PtyOutputInput {
  type: 'output' | 'exit'
  text?: string
  byte_length?: number
  channel?: 'stdout' | 'stderr'
  exit_code?: number | null
  signal?: string | null
}

export interface LocalPtyAdapterOptions {
  /**
   * Host directory backing workspace cwds: every spawn resolves
   * `<workspaceRoot>/<workspace_id>/<cwd>` (created on demand). This is the
   * ONLY host surface the shell may touch; host paths are never exposed on
   * the wire.
   */
  workspaceRoot: string
  /** Output sink — wire to `kernel.ptyAppendOutput` (never throws). */
  onOutput: (sessionId: string, frames: PtyOutputInput[]) => void
  /** python3 binary name/path (probed once at construction). */
  python3?: string
  /** Extra allowlisted environment entries (merged over the base whitelist). */
  extraEnv?: Record<string, string>
  /** Where the bridge script lives (default `<workspaceRoot>/.dsh-pty-runtime`). */
  runtimeDir?: string
  /** Diagnostics sink (bridge lifecycle only — never shell output). */
  log?: (message: string) => void
}

/** Shell preset → argv whitelist (the only argv a PTY may ever run). */
export const PTY_SHELL_PRESETS: Readonly<Record<string, readonly string[]>> = {
  sh: ['/bin/sh'],
  bash: ['/bin/bash'],
  zsh: ['/bin/zsh'],
  fish: ['/usr/bin/fish'],
} as const

/**
 * Base environment whitelist (spawn() additionally pins HOME to the workspace
 * sandbox — the host $HOME with ~/.ssh must stay unreachable); the bridge
 * re-filters DSH_-prefixed / token / secret names as defense in depth. The
 * host PATH is inherited so the interactive shell behaves like the host
 * shell.
 */
function basePtyEnv(shellPath: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: 'C.utf8',
    LC_ALL: 'C.utf8',
    USER: 'dsh',
    LOGNAME: 'dsh',
    SHELL: shellPath,
  }
}

/**
 * The Python3 PTY bridge (embedded — no build step needed; written to the
 * runtime dir at adapter construction). See the module header for the wire.
 */
const PYTHON_BRIDGE = String.raw`#!/usr/bin/env python3
# DSH LocalPtyAdapter bridge (PTY-01) — real pseudo-terminal via pty.fork().
# fd0 raw input -> master; fd1 master -> raw output; fd3 control in (JSON
# lines); fd4 control out (JSON lines). Signals target the pty's FOREGROUND
# process group (real Ctrl-C semantics); KILL/shutdown target the whole
# session. The bridge never exits because stdin EOFs (detach semantics) and
# never leaks DSH_*/token/secret names into the shell environment.
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import fcntl
import re

SHELLS = {
    "sh": ["/bin/sh"],
    "bash": ["/bin/bash"],
    "zsh": ["/bin/zsh"],
    "fish": ["/usr/bin/fish"],
}

SENSITIVE_ENV = re.compile(
    r"^(DSH_|.*(?:TOKEN|SECRET|CREDENTIAL|PASSWORD|API_?KEY|PRIVATE_?KEY).*$)",
    re.IGNORECASE,
)


def emit(payload):
    try:
        os.write(4, (json.dumps(payload) + "\n").encode("utf-8"))
    except OSError:
        pass


def set_winsize(fd, cols, rows):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ,
                    struct.pack("HHHH", max(1, int(rows)), max(1, int(cols)), 0, 0))
    except (OSError, ValueError, TypeError):
        pass


def signal_session(pid, master, sig):
    """Send a signal to the pty's foreground process group (the shell's own
    session when no job is in the foreground); fall back to the shell pid."""
    target = None
    try:
        target = os.tcgetpgrp(master)
    except OSError:
        target = None
    if target is None or target <= 0:
        target = pid
    try:
        os.killpg(target, sig)
    except OSError:
        try:
            os.kill(target, sig)
        except OSError:
            pass


def drain(master, out):
    while True:
        try:
            data = os.read(master, 65536)
        except OSError:
            break
        if not data:
            break
        try:
            os.write(out, data)
        except OSError:
            break


def sig_name(n):
    try:
        return signal.Signals(n).name
    except ValueError:
        return "SIG" + str(n)


class LineReader(object):
    def __init__(self, fd):
        self.fd = fd
        self.buf = b""

    def feed(self, data):
        self.buf += data
        out = []
        while True:
            idx = self.buf.find(b"\n")
            if idx < 0:
                break
            out.append(self.buf[:idx])
            self.buf = self.buf[idx + 1:]
        return out


def main():
    argv = sys.argv[1:]
    opts = {}
    i = 0
    while i + 1 < len(argv):
        if argv[i].startswith("--"):
            opts[argv[i][2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    preset = opts.get("preset", "sh")
    cwd = opts.get("cwd", ".")
    shell_argv = SHELLS.get(preset)
    if shell_argv is None:
        emit({"event": "error", "message": "unknown preset %r" % preset})
        return 2
    if not os.path.isdir(cwd):
        emit({"event": "error", "message": "cwd not found: %r" % cwd})
        return 2
    pid = None
    master = None
    try:
        pid, master = pty.fork()
        if pid == 0:
            # Child: pty.fork() already created a new session with the pty
            # slave as controlling terminal. Drop the control fds, chdir and
            # exec the preset shell with the sanitized environment.
            for fd in (3, 4):
                try:
                    os.close(fd)
                except OSError:
                    pass
            try:
                os.chdir(cwd)
            except OSError:
                pass
            env = {}
            for key, value in os.environ.items():
                if not SENSITIVE_ENV.match(key):
                    env[key] = value
            env["SHELL"] = shell_argv[0]
            try:
                os.execvpe(shell_argv[0], shell_argv, env)
            except OSError:
                os._exit(127)
        # Parent: the bridge.
        try:
            os.set_blocking(master, False)
        except OSError:
            pass
        set_winsize(master, opts.get("cols") or 80, opts.get("rows") or 24)
        stdin_fd = 0
        stdout_fd = 1
        ctl_in = LineReader(3)
        stdin_open = True
        exit_code = None
        exit_signal = None
        shutdown = False
        while True:
            rlist = [master, 3]
            if stdin_open:
                rlist.append(stdin_fd)
            try:
                ready, _, _ = select.select(rlist, [], [], 0.5)
            except (OSError, ValueError):
                break
            for fd in ready:
                if fd == master:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        data = b""
                    if data:
                        try:
                            os.write(stdout_fd, data)
                        except OSError:
                            # Reader (kernel adapter) is gone — tear the
                            # session down instead of orphaning it.
                            signal_session(pid, master, signal.SIGKILL)
                            shutdown = True
                            break
                elif fd == stdin_fd:
                    try:
                        data = os.read(stdin_fd, 65536)
                    except OSError:
                        data = b""
                    if not data:
                        stdin_open = False  # EOF != kill (detach semantics)
                    else:
                        try:
                            os.write(master, data)
                        except OSError:
                            pass
                elif fd == 3:
                    try:
                        data = os.read(3, 65536)
                    except OSError:
                        data = b""
                    if not data:
                        # Control channel closed (adapter/kernel gone).
                        signal_session(pid, master, signal.SIGKILL)
                        shutdown = True
                        break
                    for line in ctl_in.feed(data):
                        try:
                            msg = json.loads(line.decode("utf-8", "replace"))
                        except ValueError:
                            continue
                        op = msg.get("op")
                        if op == "resize":
                            set_winsize(master, msg.get("cols"), msg.get("rows"))
                        elif op == "signal":
                            sig = getattr(signal, "SIG" + str(msg.get("sig", "")), None)
                            if sig is not None:
                                signal_session(pid, master, sig)
                        elif op == "shutdown":
                            signal_session(pid, master, signal.SIGKILL)
                            shutdown = True
                            break
                if shutdown:
                    break
            if shutdown:
                break
            try:
                wpid, status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                wpid, status = pid, 0
            if wpid == pid:
                if os.WIFEXITED(status):
                    exit_code = os.WEXITSTATUS(status)
                elif os.WIFSIGNALED(status):
                    exit_signal = sig_name(os.WTERMSIG(status))
                else:
                    exit_code = 0
                break
        # Drain remaining output BEFORE reporting exit so the exit event
        # always follows the final bytes (the adapter also waits for stdout
        # to end before emitting its exit frame).
        drain(master, stdout_fd)
        try:
            os.close(master)
        except OSError:
            pass
        emit({"event": "exit", "exit_code": exit_code, "signal": exit_signal})
        return 0
    except BaseException as exc:  # last resort: never orphan the session
        if pid is not None:
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                pass
        if master is not None:
            try:
                os.close(master)
            except OSError:
                pass
        emit({"event": "exit", "exit_code": 127, "signal": None,
              "message": str(exc)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
`

/** One live bridge session managed by the adapter. */
interface LocalPtyHandle {
  child: ChildProcess
  sessionId: string
  /** kill() was requested — the session is being torn down. */
  killed: boolean
  /** The bridge reported exit (and stdout ended) — the exit frame went out. */
  exited: boolean
}

/**
 * The shipped LOCAL adapter (PTY-01): a real pseudo-terminal per session,
 * daemonized in the kernel (survives client detach), driven by the same
 * PtyAdapter contract as a future LocalDockerPty/RemoteRunnerPty. Register
 * via `kernel.setPtyAdapter(new LocalPtyAdapter({...}))`; the kernel bin
 * does this automatically (workspaceRoot = <dataDir>/pty-workspaces).
 */
export class LocalPtyAdapter implements PtyAdapter {
  readonly id = 'local-pty'

  private readonly workspaceRootValue: string
  private readonly onOutput: (sessionId: string, frames: PtyOutputInput[]) => void
  private readonly python3: string
  private readonly extraEnv: Record<string, string>
  private readonly log: (message: string) => void
  private readonly bridgePath: string
  private readonly sessions = new Map<string, LocalPtyHandle>()

  /** Resolved python3 binary, or null when the probe failed. */
  readonly python3Path: string | null

  constructor(options: LocalPtyAdapterOptions) {
    if (options.workspaceRoot === '' || !resolve(options.workspaceRoot).startsWith(sep)) {
      throw new Error('LocalPtyAdapter: workspaceRoot must be an absolute host directory')
    }
    this.workspaceRootValue = resolve(options.workspaceRoot)
    this.onOutput = options.onOutput
    this.extraEnv = options.extraEnv ?? {}
    this.log = options.log ?? (() => {})
    const python3 = options.python3 ?? 'python3'
    // Probe once: a missing python3 fails every spawn honestly instead of
    // surfacing as an async crash per session.
    const probe = spawnSync(python3, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    this.python3Path = probe.error === undefined && probe.status === 0 ? python3 : null
    this.python3 = this.python3Path ?? python3
    const runtimeDir = options.runtimeDir ?? join(this.workspaceRootValue, '.dsh-pty-runtime')
    mkdirSync(runtimeDir, { recursive: true })
    this.bridgePath = join(runtimeDir, 'pty-bridge.py')
    writeFileSync(this.bridgePath, PYTHON_BRIDGE, { mode: 0o600 })
    if (this.python3Path === null) {
      this.log(`LocalPtyAdapter: ${python3} not available — every spawn will fail (pty_adapter_failed)`)
    }
  }

  /** True when a real tty can be allocated (python3 probe passed). */
  get available(): boolean {
    return this.python3Path !== null
  }

  /** The host sandbox root backing workspace cwds (test/audit surface). */
  get workspaceRoot(): string {
    return this.workspaceRootValue
  }

  /** Number of live bridge sessions (test/audit surface). */
  get liveSessions(): number {
    return this.sessions.size
  }

  spawn(plan: PtySpawnPlan): { ok: true } | { ok: false; error: string } {
    if (this.python3Path === null) {
      return { ok: false, error: `${this.python3} is not available on this host (python3 --version probe failed)` }
    }
    let absCwd: string
    try {
      absCwd = this.resolveWorkspaceCwd(plan)
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
    const shellArgv = PTY_SHELL_PRESETS[plan.preset]
    if (shellArgv === undefined || shellArgv.length === 0) {
      return { ok: false, error: `unknown shell preset: ${plan.preset}` }
    }
    const shellPath = shellArgv[0]!
    if (!existsSync(shellPath)) {
      return { ok: false, error: `preset shell not found on host: ${shellPath}` }
    }
    const env: Record<string, string> = { ...basePtyEnv(shellPath), ...this.extraEnv }
    // HOME is pinned to the workspace sandbox (never inherited from the
    // kernel process — the host $HOME with ~/.ssh stays unreachable).
    env.HOME = join(this.workspaceRootValue, plan.workspace_id)
    // The bridge's own environment is the whitelist (it re-filters for the
    // shell as defense in depth) — no kernel/service/model credential
    // survives into the child.
    let child: ChildProcess
    try {
      child = spawn(this.python3, [
        this.bridgePath,
        '--session', plan.pty_session_id,
        '--preset', plan.preset,
        '--cwd', absCwd,
        '--cols', String(plan.cols),
        '--rows', String(plan.rows),
      ], {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
        env,
        // The bridge must never be killed when the adapter's own process
        // group is signalled; give it its own process group (killpg-able).
        detached: true,
      })
    } catch (error) {
      return { ok: false, error: `failed to spawn python3 pty bridge: ${(error as Error).message}` }
    }
    const handle: LocalPtyHandle = { child, sessionId: plan.pty_session_id, killed: false, exited: false }
    this.sessions.set(plan.pty_session_id, handle)
    this.wire(handle)
    return { ok: true }
  }

  /** Resolve + create the workspace sandbox cwd for a spawn plan. */
  private resolveWorkspaceCwd(plan: PtySpawnPlan): string {
    const cwd = plan.cwd === '' ? '.' : plan.cwd
    // Defense in depth (the kernel already validated): root-relative only.
    if (cwd.includes('\u0000') || cwd.includes('\\') || cwd.startsWith('/')) {
      throw new Error(`pty cwd must be root-relative inside the workspace: ${cwd}`)
    }
    if (cwd.split('/').some(part => part === '..')) {
      throw new Error(`pty cwd must not contain '..' segments: ${cwd}`)
    }
    const base = join(this.workspaceRootValue, plan.workspace_id)
    mkdirSync(base, { recursive: true })
    const abs = resolve(join(base, cwd))
    const prefix = base.endsWith(sep) ? base : base + sep
    if (abs !== base && !abs.startsWith(prefix)) {
      throw new Error(`pty cwd escapes the workspace root: ${cwd}`)
    }
    mkdirSync(abs, { recursive: true })
    return abs
  }

  /** Hook the bridge's five pipes and the exit handshake. */
  private wire(handle: LocalPtyHandle): void {
    const { child, sessionId } = handle
    const emitFrames = (frames: PtyOutputInput[]): void => {
      try {
        this.onOutput(sessionId, frames)
      } catch {
        // The session may already be closed (race with close/sweep) — the
        // store owns that error; the adapter never throws into the kernel.
      }
    }
    // stdout: pty output (UTF-8-safe; Node decodes multi-byte boundaries).
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (text: string) => {
      if (handle.killed) return
      if (text === '') return
      // Cap frames at 16 KiB so a single retention frame stays bounded.
      if (text.length <= 16384) {
        emitFrames([{ type: 'output', text, byte_length: Buffer.byteLength(text, 'utf8'), channel: 'stdout' }])
      } else {
        for (let i = 0; i < text.length; i += 16384) {
          const part = text.slice(i, i + 16384)
          emitFrames([{ type: 'output', text: part, byte_length: Buffer.byteLength(part, 'utf8'), channel: 'stdout' }])
        }
      }
    })
    child.stdout!.on('error', () => { /* reader teardown race — ignore */ })
    // stderr: bridge diagnostics only (never shell output).
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (text: string) => {
      const line = text.trimEnd()
      if (line !== '') this.log(`[pty ${sessionId}] bridge: ${line}`)
    })
    child.stderr!.on('error', () => { /* ignore */ })
    child.stdin!.on('error', () => { /* bridge already gone — ignore */ })
    // fd 3 (control out): bridge events. readline handles partial lines.
    const ctl = child.stdio[4] as unknown as Readable | undefined
    if (ctl === undefined) {
      this.log(`[pty ${sessionId}] bridge control channel missing — session unusable`)
      handle.killed = true
      this.sessions.delete(sessionId)
      return
    }
    const rl = createInterface({ input: ctl })
    let exitEvent: { exit_code: number | null; signal: string | null } | null = null
    let stdoutEnded = false
    let exitTimer: NodeJS.Timeout | null = null
    const emitExit = (): void => {
      if (exitTimer !== null) { clearTimeout(exitTimer); exitTimer = null }
      if (handle.exited || handle.killed) return
      handle.exited = true
      this.sessions.delete(sessionId)
      emitFrames([{ type: 'exit', exit_code: exitEvent?.exit_code ?? null, signal: exitEvent?.signal ?? null }])
    }
    const maybeEmitExit = (): void => {
      if (exitEvent === null) return
      if (stdoutEnded) {
        emitExit()
      } else if (exitTimer === null) {
        // Fallback: the bridge reported exit but stdout has not ended yet
        // (normally it ends a tick later). Bound the wait, never lose the
        // exit frame on a wedged stream.
        exitTimer = setTimeout(emitExit, 500)
        exitTimer.unref()
      }
    }
    child.stdout!.once('end', () => {
      stdoutEnded = true
      maybeEmitExit()
    })
    rl.on('line', (line: string) => {
      let msg: { event?: string; exit_code?: unknown; signal?: unknown; message?: unknown }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        return
      }
      if (msg.event === 'exit') {
        exitEvent = {
          exit_code: typeof msg.exit_code === 'number' ? msg.exit_code : null,
          signal: typeof msg.signal === 'string' ? msg.signal : null,
        }
        maybeEmitExit()
      } else if (msg.event === 'error') {
        this.log(`[pty ${sessionId}] bridge error: ${String(msg.message ?? '')}`)
      }
    })
    rl.on('error', () => { /* ignore */ })
    // Bridge process fell over without an exit event (crash) — report an
    // exit frame so the UI never hangs on a dead wire.
    child.on('close', (code: number | null) => {
      if (exitEvent === null) {
        exitEvent = { exit_code: code ?? null, signal: null }
        stdoutEnded = true
        maybeEmitExit()
      }
      this.sessions.delete(sessionId)
    })
    child.on('error', (error: Error) => {
      this.log(`[pty ${sessionId}] bridge spawn error: ${error.message}`)
      exitEvent = { exit_code: null, signal: null }
      stdoutEnded = true
      maybeEmitExit()
    })
  }

  private sendControl(sessionId: string, message: Record<string, unknown>): void {
    const handle = this.sessions.get(sessionId)
    if (handle === undefined || handle.exited || handle.killed) return
    try {
      ;(handle.child.stdio[3] as unknown as { write(chunk: string): boolean } | undefined)?.write(JSON.stringify(message) + '\n')
    } catch {
      /* bridge gone — ignore */
    }
  }

  write(sessionId: string, bytes: string): void {
    const handle = this.sessions.get(sessionId)
    if (handle === undefined || handle.exited || handle.killed) return
    try {
      handle.child.stdin!.write(bytes)
    } catch {
      /* bridge gone — ignore */
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sendControl(sessionId, { op: 'resize', cols, rows })
  }

  signal(sessionId: string, signal: PtySignal): void {
    this.sendControl(sessionId, { op: 'signal', sig: signal })
  }

  /** Tear down the real session (explicit close / idle TTL / lease expiry). */
  kill(sessionId: string): void {
    const handle = this.sessions.get(sessionId)
    if (handle === undefined || handle.killed) return
    handle.killed = true
    this.sendControl(sessionId, { op: 'shutdown' })
    // Belt-and-braces: if the bridge does not exit (wedged select), force
    // the bridge itself down; the session pgrp was already SIGKILLed by the
    // shutdown op. Idempotent by construction.
    const timer = setTimeout(() => {
      try {
        handle.child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, 3000)
    timer.unref()
    handle.child.once('close', () => {
      clearTimeout(timer)
      this.sessions.delete(sessionId)
    })
  }

  /** Kill every live session (kernel shutdown path). */
  dispose(): void {
    for (const sessionId of [...this.sessions.keys()]) this.kill(sessionId)
  }
}
