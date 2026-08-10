/**
 * PTY-01 (hardening-v0.2-status.md §3/§4, execution-runtime.md §6.1) —
 * Interactive Terminal wire schemas.
 *
 * The Interactive Terminal is a separate Interface from the Run Terminal
 * (execution-runtime.md §6 vs §6.1). A PTY session is pinned at open time:
 * Principal, Project, Workspace, Runner profile/target, an allowlisted shell
 * preset, a RELATIVE cwd, the effective config hash and a session lease.
 * The wire never carries Docker sockets, SSH credentials, Kernel tokens or
 * host paths (execution-runtime.md §6.1).
 *
 * Two frame streams, one session:
 *
 * - PtyControlFrame — client → server, one per user action (bytes input,
 *   resize, INT/TERM/KILL signal, close). Each control frame carries a
 *   monotonically increasing `client_seq`; the server treats
 *   `client_seq` as the idempotency key (duplicate seq = replay, out-of-order
 *   seq = 409), exactly like the Job Idempotency-Key rule.
 * - PtyOutputFrame — server → client, append-only with a monotonic
 *   `server_seq` (output | exit | gap). Retention is bounded and explicit:
 *   the session row records `retained_from_seq` / `dropped_bytes`, and a
 *   reader requesting an evicted seq first receives a `gap` frame —
 *   mirroring terminal-frames retention semantics (execution-runtime.md §6).
 *
 * NOT a formal log: PTY output is auditable and retained in a bounded
 * window, but it can never generate Metrics, a RunManifest, accepted
 * Evidence or a Gate Decision (execution-runtime.md §6.1; enforced by the
 * kernel store layout + pty-session.test.ts `pty-not-evidence`).
 * @module @dsh-scholar/research-schemas/pty
 */

import { z } from 'zod'

/** Session lifecycle: open (created, no wire yet) → attached (wire up) →
 * detached (wire down, process alive) → closed (terminal). Permission
 * revocation detaches immediately; idle TTL expiry closes. */
export const PtyState = z.enum(['open', 'attached', 'detached', 'closed'])
export type PtyState = z.infer<typeof PtyState>

/** Signals a PTY adapter must be able to deliver (INT/TERM/KILL). */
export const PtySignal = z.enum(['INT', 'TERM', 'KILL'])
export type PtySignal = z.infer<typeof PtySignal>

/** Allowlisted shell presets — the only argv a PTY may ever run. The open
 * request references a preset, never an arbitrary command line. */
export const PtyShellPreset = z.enum(['sh', 'bash', 'zsh', 'fish'])
export type PtyShellPreset = z.infer<typeof PtyShellPreset>

/** Control frame kinds (client → server). */
export const PtyControlType = z.enum(['bytes', 'resize', 'signal', 'close'])
export type PtyControlType = z.infer<typeof PtyControlType>

/** Reason a session closed (audit field). */
export const PtyCloseReason = z.enum(['explicit', 'idle_ttl', 'permission_revoked', 'adapter_failed', 'lease_expired'])
export type PtyCloseReason = z.infer<typeof PtyCloseReason>

/**
 * A durable Interactive Terminal session row. All fields are pinned at open
 * time; `state`/`generation`/lease/activity are the only mutable surface and
 * every transition goes through the kernel state machine (pty-session.ts).
 */
export const PtySession = z.object({
  pty_session_id: z.string().regex(/^pty_[a-z0-9_]+$/),
  /** Human/agent principal that opened the session (durable identity). */
  principal_id: z.string().min(1),
  tenant_id: z.string().default(''),
  project_id: z.string().min(1),
  workspace_id: z.string().min(1),
  /** Opaque Runner profile/target ids — resolved server-side only. */
  profile: z.string().min(1),
  target: z.string().min(1),
  preset: PtyShellPreset,
  /** Root-relative cwd inside the workspace; never a host path. */
  cwd: z.string().min(1),
  /**
   * sha256 pin of the effective Config Schema at open time (canonical pin
   * format `sha256:<hex>`, see config-registry.pinConfig).
   */
  config_hash: z.string().regex(/^(sha256:)?[0-9a-f]{64}$/, 'config_hash must be a sha256 hex digest (optionally sha256:-prefixed)'),
  state: PtyState.default('open'),
  /** Bumped on every attach/detach — reconnect uses generation + after_seq. */
  generation: z.number().int().nonnegative().default(1),
  /** Session lease (PTY-01): opaque token + expiry, pinned at open. */
  lease_token: z.string().min(1),
  lease_expires_at: z.string().nullable().default(null),
  /** Idle TTL (seconds) — from the Config Schema when not provided. */
  idle_ttl_s: z.number().int().positive().default(900),
  /** Bounded output retention in bytes (Config Schema default). */
  retention_bytes: z.number().int().positive().default(1024 * 1024),
  /** Output frames below this seq were evicted (retention); readers get a
   * gap. 0 = nothing evicted yet (reading from seq 0 is a clean replay). */
  retained_from_seq: z.number().int().nonnegative().default(0),
  /** Last applied control client_seq (idempotency cursor). */
  last_client_seq: z.number().int().nonnegative().default(0),
  /** Last allocated output server_seq. */
  last_event_seq: z.number().int().nonnegative().default(0),
  /** Total output bytes retained (bounded by retention_bytes). */
  total_bytes: z.number().int().nonnegative().default(0),
  /** Output bytes dropped by retention eviction. */
  dropped_bytes: z.number().int().nonnegative().default(0),
  /** Adapter identity: 'none' until a LocalDockerPty/RemoteRunnerPty
   * adapter is registered (interface layer ships with no real tty). */
  adapter_id: z.string().default('none'),
  open_at: z.string(),
  last_activity_at: z.string(),
  closed_at: z.string().nullable().default(null),
  close_reason: PtyCloseReason.nullable().default(null),
})
export type PtySession = z.infer<typeof PtySession>

/** POST /v1/pty/sessions body (PTY-01 open contract). `cwd` is relative;
 * `config_hash`/`idle_ttl_s`/`retention_bytes` default from the Config
 * Schema when omitted (registry keys land with the adapter round). */
export const PtyOpenRequest = z.object({
  project_id: z.string().min(1),
  workspace_id: z.string().min(1),
  profile: z.string().min(1),
  target: z.string().min(1),
  preset: PtyShellPreset,
  cwd: z.string().min(1),
  /** sha256 pin of the effective Config Schema (may carry the canonical
   * `sha256:` prefix). */
  config_hash: z.string().regex(/^(sha256:)?[0-9a-f]{64}$/).optional(),
  idle_ttl_s: z.number().int().positive().optional(),
  retention_bytes: z.number().int().positive().optional(),
  cols: z.number().int().positive().max(500).default(80),
  rows: z.number().int().positive().max(300).default(24),
}).strict()
export type PtyOpenRequest = z.infer<typeof PtyOpenRequest>

/** One control frame sent by the client (full wire record). */
export const PtyControlFrame = z.discriminatedUnion('type', [
  z.object({
    pty_session_id: z.string().min(1),
    client_seq: z.number().int().nonnegative(),
    type: z.literal('bytes'),
    /** UTF-8-safe text (sanitized before the wire, like run terminal chunks). */
    payload: z.object({ text: z.string(), byte_length: z.number().int().nonnegative() }).strict(),
    created_at: z.string(),
  }),
  z.object({
    pty_session_id: z.string().min(1),
    client_seq: z.number().int().nonnegative(),
    type: z.literal('resize'),
    payload: z.object({ cols: z.number().int().positive().max(500), rows: z.number().int().positive().max(300) }).strict(),
    created_at: z.string(),
  }),
  z.object({
    pty_session_id: z.string().min(1),
    client_seq: z.number().int().nonnegative(),
    type: z.literal('signal'),
    payload: z.object({ signal: PtySignal }).strict(),
    created_at: z.string(),
  }),
  z.object({
    pty_session_id: z.string().min(1),
    client_seq: z.number().int().nonnegative(),
    type: z.literal('close'),
    payload: z.object({}).strict(),
    created_at: z.string(),
  }),
])
export type PtyControlFrame = z.infer<typeof PtyControlFrame>

/** POST /v1/pty/sessions/{id}/control body (no session id / timestamps —
 * the server fills them). */
export const PtyControlRequest = z.discriminatedUnion('type', [
  z.object({
    client_seq: z.number().int().nonnegative(),
    type: z.literal('bytes'),
    payload: z.object({ text: z.string(), byte_length: z.number().int().nonnegative() }).strict(),
  }).strict(),
  z.object({
    client_seq: z.number().int().nonnegative(),
    type: z.literal('resize'),
    payload: z.object({ cols: z.number().int().positive().max(500), rows: z.number().int().positive().max(300) }).strict(),
  }).strict(),
  z.object({
    client_seq: z.number().int().nonnegative(),
    type: z.literal('signal'),
    payload: z.object({ signal: PtySignal }).strict(),
  }).strict(),
  z.object({
    client_seq: z.number().int().nonnegative(),
    type: z.literal('close'),
    payload: z.object({}).strict(),
  }).strict(),
])
export type PtyControlRequest = z.infer<typeof PtyControlRequest>

/** One output frame produced by the server (append-only, server_seq
 * monotonic per session). */
export const PtyOutputFrame = z.discriminatedUnion('type', [
  z.object({
    pty_session_id: z.string().min(1),
    server_seq: z.number().int().nonnegative(),
    type: z.literal('output'),
    payload: z.object({
      text: z.string(),
      byte_length: z.number().int().nonnegative(),
      channel: z.enum(['stdout', 'stderr']).default('stdout'),
    }).strict(),
    created_at: z.string(),
  }),
  z.object({
    pty_session_id: z.string().min(1),
    server_seq: z.number().int().nonnegative(),
    type: z.literal('exit'),
    payload: z.object({
      exit_code: z.number().int().nullable().default(null),
      signal: z.string().nullable().default(null),
    }).strict(),
    created_at: z.string(),
  }),
  z.object({
    pty_session_id: z.string().min(1),
    server_seq: z.number().int().nonnegative(),
    type: z.literal('gap'),
    payload: z.object({
      /** First seq the client asked for but retention already evicted. */
      gap_from_seq: z.number().int().nonnegative(),
      gap_to_seq: z.number().int().nonnegative(),
      dropped_bytes: z.number().int().nonnegative(),
      dropped_frames: z.number().int().nonnegative(),
    }).strict(),
    created_at: z.string(),
  }),
])
export type PtyOutputFrame = z.infer<typeof PtyOutputFrame>

/** GET /v1/pty/sessions/{id}/frames?after_seq= response projection. */
export const PtyFramesPage = z.object({
  pty_session_id: z.string().min(1),
  after_seq: z.number().int().nonnegative(),
  retained_from_seq: z.number().int().nonnegative(),
  dropped_bytes: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  /** true when after_seq < retained_from_seq — the client must resync. */
  gap: z.boolean(),
  frames: z.array(PtyOutputFrame),
})
export type PtyFramesPage = z.infer<typeof PtyFramesPage>
