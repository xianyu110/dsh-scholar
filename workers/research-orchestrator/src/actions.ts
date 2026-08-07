/**
 * Durable Research Orchestrator — Action model and SQLite store (design §8.2).
 *
 * The orchestrator does NOT depend on DSH sessions or in-process Tasks. Every
 * automation step it performs is recorded as an Action row in its own SQLite
 * database (node:sqlite). Together with the Kernel projection this gives the
 * recovery semantics of §8.5: after a crash the orchestrator re-reads all
 * actions from this store and continues purely from the Kernel projection —
 * idempotent per (project_id, idempotency_key).
 *
 * @module @dsh-scholar/research-orchestrator/actions
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type ActionStatus = 'queued' | 'running' | 'done' | 'failed' | 'blocked'

/**
 * One orchestrator step for a project (v2 §8.2).
 *
 * - `phase` is the project status (Kernel projection) that produced the action.
 * - `idempotency_key` scopes dedup per project: `(project_id, idempotency_key)`
 *   is UNIQUE, so a crashed/replayed poll never runs the same step twice.
 * - `blocked` marks actions that pause for a human (a created Gate, or a
 *   note-action that only a human/Scholar panel can continue).
 * - `last_error` carries the last failure message, or — for blocked note
 *   actions — the human-facing note explaining what is awaited.
 */
export interface Action {
  action_id: string
  project_id: string
  phase: string
  type: string
  idempotency_key: string
  status: ActionStatus
  attempt: number
  max_attempts: number
  depends_on: string[] | null
  created_at: string
  updated_at: string
  last_error: string | null
}

export interface ActionStoreOptions {
  /** SQLite file path. Defaults to `:memory:` (tests). */
  dbPath?: string
}

/** Minimal shape `decideActions` needs to apply idempotency/retry rules. */
export type ActionLike = Pick<Action, 'idempotency_key' | 'status' | 'attempt' | 'max_attempts'>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orchestrator_actions (
  action_id       TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  phase           TEXT NOT NULL,
  type            TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status          TEXT NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(project_id, idempotency_key)
)`

export function buildActionId(): string {
  return `act_${randomUUID().replaceAll('-', '')}`
}

function nowIso(): string {
  return new Date().toISOString()
}

interface ActionRow {
  action_id: string
  project_id: string
  phase: string
  type: string
  idempotency_key: string
  status: string
  attempt: number
  max_attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
}

function rowToAction(row: ActionRow): Action {
  return {
    action_id: row.action_id,
    project_id: row.project_id,
    phase: row.phase,
    type: row.type,
    idempotency_key: row.idempotency_key,
    status: row.status as ActionStatus,
    attempt: Number(row.attempt),
    max_attempts: Number(row.max_attempts),
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    depends_on: null,
  }
}

/**
 * Durable action store (§8.2). Writes are synchronous (node:sqlite), so a
 * crash between a Kernel write and this store's write is the only at-least-once
 * window; the UNIQUE(project_id, idempotency_key) constraint plus the Kernel
 * projection reconciliation in the Engine close that window.
 */
export class ActionStore {
  readonly db: DatabaseSync

  constructor(options: ActionStoreOptions = {}) {
    const dbPath = options.dbPath ?? ':memory:'
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  /** Insert an action; no-op (returns false) when (project_id, idempotency_key) already exists. */
  insert(action: Action): boolean {
    const result = this.db.prepare(
      `INSERT INTO orchestrator_actions
         (action_id, project_id, phase, type, idempotency_key, status, attempt, max_attempts, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, idempotency_key) DO NOTHING`,
    ).run(
      action.action_id, action.project_id, action.phase, action.type, action.idempotency_key,
      action.status, action.attempt, action.max_attempts, action.last_error, action.created_at, action.updated_at,
    )
    return Number(result.changes) === 1
  }

  get(projectId: string, idempotencyKey: string): Action | null {
    const row = this.db.prepare(
      'SELECT * FROM orchestrator_actions WHERE project_id = ? AND idempotency_key = ?',
    ).get(projectId, idempotencyKey) as ActionRow | undefined
    return row === undefined ? null : rowToAction(row)
  }

  getById(actionId: string): Action | null {
    const row = this.db.prepare('SELECT * FROM orchestrator_actions WHERE action_id = ?').get(actionId) as ActionRow | undefined
    return row === undefined ? null : rowToAction(row)
  }

  listByProject(projectId: string): Action[] {
    const rows = this.db.prepare('SELECT * FROM orchestrator_actions WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as ActionRow[]
    return rows.map(rowToAction)
  }

  /** All actions — used by startup recovery (§8.5). */
  list(): Action[] {
    const rows = this.db.prepare('SELECT * FROM orchestrator_actions ORDER BY created_at').all() as unknown as ActionRow[]
    return rows.map(rowToAction)
  }

  /** Update status (+attempt/last_error) and bump updated_at. */
  updateStatus(actionId: string, status: ActionStatus, patch: { attempt?: number; last_error?: string | null } = {}): void {
    const attempt = patch.attempt
    const lastError = patch.last_error
    if (attempt !== undefined && lastError !== undefined) {
      this.db.prepare('UPDATE orchestrator_actions SET status = ?, attempt = ?, last_error = ?, updated_at = ? WHERE action_id = ?')
        .run(status, attempt, lastError, nowIso(), actionId)
    } else if (attempt !== undefined) {
      this.db.prepare('UPDATE orchestrator_actions SET status = ?, attempt = ?, updated_at = ? WHERE action_id = ?')
        .run(status, attempt, nowIso(), actionId)
    } else if (lastError !== undefined) {
      this.db.prepare('UPDATE orchestrator_actions SET status = ?, last_error = ?, updated_at = ? WHERE action_id = ?')
        .run(status, lastError, nowIso(), actionId)
    } else {
      this.db.prepare('UPDATE orchestrator_actions SET status = ?, updated_at = ? WHERE action_id = ?')
        .run(status, nowIso(), actionId)
    }
  }

  /**
   * Crash recovery (§8.5): any action left `running` by a process that died
   * mid-step is reset to `queued` so the next poll re-attempts it. Returns the
   * number of recovered rows.
   */
  recover(): number {
    const result = this.db.prepare(
      "UPDATE orchestrator_actions SET status = 'queued', updated_at = ? WHERE status = 'running'",
    ).run(nowIso())
    return Number(result.changes)
  }

  /** Create a fresh Action row (not yet persisted). */
  static newAction(input: {
    project_id: string
    phase: string
    type: string
    idempotency_key: string
    status?: ActionStatus
    attempt?: number
    max_attempts?: number
    last_error?: string | null
  }): Action {
    const now = nowIso()
    return {
      action_id: buildActionId(),
      project_id: input.project_id,
      phase: input.phase,
      type: input.type,
      idempotency_key: input.idempotency_key,
      status: input.status ?? 'queued',
      attempt: input.attempt ?? 0,
      max_attempts: input.max_attempts ?? 3,
      depends_on: null,
      created_at: now,
      updated_at: now,
      last_error: input.last_error ?? null,
    }
  }
}
