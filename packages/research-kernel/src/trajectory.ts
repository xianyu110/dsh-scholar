/**
 * TRAJ-01 / SUBAGENT-01 — standalone safe trajectory projection + subagent
 * topology storage (docs/trajectory-subagents.md, authoritative contract).
 *
 * This module owns:
 *
 *  - TRAJECTORY_DDL (migration 0013): `child_links` (durable subagent parent/
 *    child topology, state, mode, role), `child_history` (append-only per-child
 *    event ledger — started/state/followup), `child_followups` (one-shot
 *    read-only followup receipts) and the `events(project_id,event_seq,
 *    event_id)` index that makes 10k-event pagination stable.
 *  - The READ-ONLY projection over the Kernel Outbox: `projectTrajectory`
 *    (keyset pagination by `(event_seq, event_id)` — outbox seqs are
 *    per-aggregate and the aggregate-less bucket can collide numerically, so
 *    the event_id tiebreaker is part of the cursor contract) and
 *    `projectTrajectoryLanes` (Research vs Session lanes).
 *  - Redaction: event payloads are NEVER projected; only allowlisted fields
 *    become a `summary`, which is then scrubbed of tokens/secrets/absolute
 *    host paths and length-capped. Child summaries are redacted at write
 *    time AND on read (defense in depth).
 *  - The child topology surface: exact direct children tree, exact-parent +
 *    breadcrumb (cycle-safe, orphan fail-soft, depth-capped), read-only
 *    history, and one-shot READ-ONLY followup (records the message and
 *    returns message_id WITHOUT activating the child — state never changes;
 *    trajectory-subagents.md §3 "接收只返回 message_id，不冒充已执行").
 *
 * The Kernel Outbox remains the only business ledger; `child_links` is a
 * replayable projection table and never becomes project state authority.
 * @module @dsh-scholar/research-kernel/trajectory
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import type {
  ChildDetail, ChildHistoryPage, ChildLink, ChildLinkInput, ChildMode, ChildState,
  FollowupReceipt, KernelEvent, KernelEventKind, TopologyChildren, TopologyNode,
  TrajectoryEntry, TrajectoryLane, TrajectoryLanes, TrajectoryNodeStatus, TrajectoryPage,
} from '@dsh-scholar/research-schemas'
import { KernelError } from './kernel.js'

/** Default page size and hard cap (10k acceptance: single page ≤ 500). */
export const TRAJECTORY_PAGE_LIMIT_DEFAULT = 200
export const TRAJECTORY_PAGE_LIMIT_MAX = 500

/** Redacted summary length cap (statements truncated server-side). */
export const TRAJECTORY_SUMMARY_MAX_CHARS = 240

/** Breadcrumb depth cap (cycle-safe, trajectory-subagents.md §3 lazy expand). */
export const BREADCRUMB_MAX_DEPTH = 32

/** Terminal child states that pin `ended_at` once. */
const TERMINAL_CHILD_STATES: ReadonlySet<ChildState> = new Set(['succeeded', 'failed', 'redacted'])

/** Migration 0013 DDL — shared with migrations.ts so both connections
 * converge (CREATE IF NOT EXISTS + additive = idempotent). */
export const TRAJECTORY_DDL = `
CREATE TABLE IF NOT EXISTS child_links (
  child_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  label TEXT,
  summary TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'subagent',
  mode TEXT NOT NULL DEFAULT 'one-shot',
  state TEXT NOT NULL DEFAULT 'running',
  role TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CHECK (kind IN ('subagent','task')),
  CHECK (mode IN ('one-shot','continuable','read-only')),
  CHECK (state IN ('running','inactive','diagnostic','succeeded','failed','redacted','unknown'))
);
CREATE INDEX IF NOT EXISTS idx_child_links_project_parent ON child_links(project_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_child_links_parent ON child_links(parent_id);
CREATE TABLE IF NOT EXISTS child_history (
  child_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (child_id, seq),
  FOREIGN KEY (child_id) REFERENCES child_links(child_id)
);
CREATE INDEX IF NOT EXISTS idx_child_history_seq ON child_history(child_id, seq);
CREATE TABLE IF NOT EXISTS child_followups (
  message_id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  request TEXT NOT NULL,
  request_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'accepted_read_only',
  created_at TEXT NOT NULL,
  FOREIGN KEY (child_id) REFERENCES child_links(child_id)
);
CREATE INDEX IF NOT EXISTS idx_child_followups_child ON child_followups(child_id, created_at);
-- 10k-event pagination: keyset (event_seq, event_id) per project.
CREATE INDEX IF NOT EXISTS idx_events_project_seq ON events(project_id, event_seq, event_id);
`

// ── lanes (trajectory-subagents.md §1) ──────────────────────────────────────

/** Research lane: authoritative Kernel business events (research facts). */
const RESEARCH_KINDS: ReadonlySet<string> = new Set([
  'project.created', 'project.transitioned', 'project.renamed',
  'gate.created', 'gate.decided',
  'artifact.registered',
  'idea.created', 'idea.updated',
  'contract.registered', 'contract.approved',
  'job.submitted', 'job.updated',
  'claim.updated', 'evidence.accepted',
  'corpus.snapshotted', 'manuscript.built',
  'budget.updated', 'policy.violation',
  'project.membership.updated',
  'intake.accepted', 'intake.rejected', 'intake.expired',
  // TEX-SAVE: a successful TeX file save is an authoritative research-lane
  // business event (the manuscript artifact being produced), same lane as
  // 'manuscript.built'.
  'tex.file.saved',
])

/** Session lane: observational session/subagent activity (never research
 * facts; unknown kinds are also observational — fail safe). */
const SESSION_KINDS: ReadonlySet<string> = new Set([
  'session.linked', 'terminal.frame',
  'trajectory.child.started', 'trajectory.child.updated', 'trajectory.child.followup',
])

export function laneForKind(kind: string): TrajectoryLane {
  if (RESEARCH_KINDS.has(kind)) return 'research'
  return 'session'
}

function laneKinds(lane: TrajectoryLane): ReadonlySet<string> {
  return lane === 'research' ? RESEARCH_KINDS : SESSION_KINDS
}

// ── redaction (trajectory-subagents.md §3/§4: raw detail never projected) ──

/** Sensitive shapes scrubbed from every projected summary: bearer/API
 * tokens, secret-key assignments, and absolute host paths (POSIX +
 * Windows). The test suite asserts none of these can survive a projection. */
const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bbearer\s+[A-Za-z0-9._\-+/=]{8,}/gi,
  /\bsk-[A-Za-z0-9_\-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9\-]{20,}\b/g,
  /\b(?:token|secret|api[_-]?key|password|passwd|credential|private[_-]?key)\s*[:=]\s*"?[^\s"']{6,}"?/gi,
  /\/(?:home|Users|tmp|var|etc|opt|root|workspace|data)(?:\/[A-Za-z0-9_.@+~-]+){1,}/g,
  /[A-Za-z]:\\(?:[^\\\s"']+\\)*[^\\\s"']*/g,
]

function scrubSensitive(text: string): string {
  let out = text
  for (const pattern of SENSITIVE_PATTERNS) out = out.replace(pattern, '[redacted]')
  return out
}

/** Redact + collapse + truncate any projected string (length cap: statements
 * are truncated server-side, never streamed raw). */
export function redactTrajectorySummary(text: string | null | undefined, maxChars = TRAJECTORY_SUMMARY_MAX_CHARS): string {
  if (text === undefined || text === null) return ''
  const scrubbed = scrubSensitive(String(text)).replace(/\s+/g, ' ').trim()
  if (scrubbed.length <= maxChars) return scrubbed
  return `${scrubbed.slice(0, maxChars - 1)}…`
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Allowlisted summary per kind — ONLY fields listed here may appear; the
 * raw payload is never part of the projection. */
export function summaryForKind(kind: string, payload: Record<string, unknown>): string {
  const label = str(payload.label) ?? str(payload.title) ?? str(payload.name) ?? str(payload.type)
  const id = str(payload.gate_id) ?? str(payload.job_id) ?? str(payload.artifact_id) ?? str(payload.idea_id)
    ?? str(payload.contract_id) ?? str(payload.evidence_id) ?? str(payload.claim_id) ?? str(payload.snapshot_id)
    ?? str(payload.manuscript_id) ?? str(payload.intake_id) ?? str(payload.child_id) ?? str(payload.project_id)
  const ref = id !== null ? ` ${id}` : ''
  switch (kind) {
    case 'project.created':
      return `project created${label !== null ? ` "${label}"` : ''}`
    case 'project.transitioned': {
      const from = str(payload.from)
      const to = str(payload.to)
      return from !== null && to !== null ? `project ${from} → ${to}` : `project transition${ref}`
    }
    case 'project.renamed':
      return `project renamed to ${label ?? '?'}`
    case 'gate.created':
      return `gate ${str(payload.type) ?? '?'} created${label !== null ? `: ${label}` : ''}`
    case 'gate.decided': {
      const decision = str(payload.decision)
      return `gate ${str(payload.type) ?? '?'} decided: ${decision ?? 'unknown'}${ref}`
    }
    case 'artifact.registered':
      return `artifact ${str(payload.kind) ?? '?'} registered${ref}`
    case 'idea.created':
      return `idea created${label !== null ? `: ${label}` : ''}`
    case 'idea.updated':
      return `idea updated${label !== null ? `: ${label}` : ''}`
    case 'contract.registered':
      return `contract registered${ref}`
    case 'contract.approved':
      return `contract approved${ref}`
    case 'job.submitted':
      return `job ${str(payload.kind) ?? '?'} submitted${ref}`
    case 'job.updated': {
      const status = str(payload.status)
      return `job ${status ?? 'status-changed'}${ref}${str(payload.failure_class) !== null ? ` (${str(payload.failure_class)})` : ''}`
    }
    case 'claim.updated':
      return `claim updated${ref}`
    case 'evidence.accepted':
      return `evidence accepted${ref}`
    case 'corpus.snapshotted': {
      const n = num(payload.total_papers)
      return `corpus snapshot${n !== null ? ` (${n} papers)` : ''}${ref}`
    }
    case 'manuscript.built':
      return `manuscript built${ref}`
    case 'session.linked':
      return `session linked${str(payload.session_id) !== null ? `: ${str(payload.session_id)}` : ''}`
    case 'budget.updated': {
      const cost = num(payload.model_cost_usd)
      const gpu = num(payload.gpu_hours)
      const parts: string[] = []
      if (cost !== null) parts.push(`$${cost}`)
      if (gpu !== null) parts.push(`${gpu} gpu-h`)
      return `budget updated${parts.length > 0 ? `: ${parts.join(', ')}` : ''}`
    }
    case 'policy.violation':
      return `policy violation${ref}`
    case 'terminal.frame':
      return `terminal frame${ref}`
    case 'project.membership.updated':
      return `membership updated: ${str(payload.principal_id) ?? '?'} → ${str(payload.role) ?? '?'}`
    case 'intake.accepted':
      return `intake accepted${ref}`
    case 'intake.rejected':
      return `intake rejected${ref}`
    case 'intake.expired':
      return `intake expired${ref}`
    case 'trajectory.child.started': {
      const mode = str(payload.mode)
      return `subagent started${label !== null ? `: ${label}` : ''}${mode !== null ? ` (${mode})` : ''}${ref}`
    }
    case 'trajectory.child.updated': {
      const state = str(payload.state)
      return `subagent ${state !== null ? `state → ${state}` : 'updated'}${ref}`
    }
    case 'trajectory.child.followup':
      return `followup message recorded${ref}`
    case 'tex.file.saved': {
      const path = str(payload.path)
      const docId = str(payload.document_id)
      return `tex file saved${path !== null ? `: ${path}` : ''}${docId !== null ? ` (${docId})` : ''}`
    }
    default:
      return `event ${kind}`
  }
}

/** Conservative status derivation — never guesses: only kinds whose payload
 * carries a node-status-like field map to TrajectoryNodeStatus. */
export function statusForKind(kind: string, payload: Record<string, unknown>): TrajectoryNodeStatus | null {
  if (kind === 'job.updated' || kind === 'trajectory.child.updated') {
    const status = str(payload.status) ?? str(payload.state)
    if (status !== null && ['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'expired', 'redacted', 'unknown'].includes(status)) {
      return status as TrajectoryNodeStatus
    }
  }
  if (kind === 'trajectory.child.started') {
    const state = str(payload.state)
    // ChildState inactive/diagnostic have no TrajectoryNodeStatus equivalent —
    // never guess, leave null.
    if (state !== null && ['running', 'succeeded', 'failed', 'redacted', 'unknown'].includes(state)) {
      return state as TrajectoryNodeStatus
    }
  }
  if (kind === 'intake.accepted') return 'succeeded'
  if (kind === 'intake.rejected') return 'failed'
  if (kind === 'intake.expired') return 'expired'
  return null
}

// ── row shapes ──────────────────────────────────────────────────────────────

interface ChildLinkRow {
  child_id: string
  project_id: string
  parent_id: string | null
  label: string | null
  summary: string
  kind: string
  mode: string
  state: string
  role: string | null
  created_at: string
  updated_at: string
  ended_at: string | null
}

interface ChildLinkNodeRow extends ChildLinkRow {
  seq: number
  children_count: number
}

interface ChildHistoryRow {
  child_id: string
  seq: number
  event_id: string
  event_type: string
  payload: string
  occurred_at: string
}

function nodeFromRow(row: ChildLinkNodeRow): TopologyNode {
  return {
    child_id: row.child_id,
    project_id: row.project_id,
    parent_id: row.parent_id,
    label: row.label,
    // defense in depth: summaries are redacted on write AND on read.
    summary: redactTrajectorySummary(row.summary),
    kind: row.kind === 'task' ? 'task' : 'subagent',
    mode: (['one-shot', 'continuable', 'read-only'].includes(row.mode) ? row.mode : 'one-shot') as ChildMode,
    state: (['running', 'inactive', 'diagnostic', 'succeeded', 'failed', 'redacted', 'unknown'].includes(row.state) ? row.state : 'unknown') as ChildState,
    role: row.role,
    started_at: row.created_at,
    ended_at: row.ended_at,
    has_children: row.children_count > 0,
    children_count: row.children_count,
    seq: row.seq,
    refs: [],
  }
}

function linkFromRow(row: ChildLinkRow): ChildLink {
  return {
    child_id: row.child_id,
    project_id: row.project_id,
    parent_id: row.parent_id,
    label: row.label,
    summary: redactTrajectorySummary(row.summary),
    kind: row.kind === 'task' ? 'task' : 'subagent',
    mode: (['one-shot', 'continuable', 'read-only'].includes(row.mode) ? row.mode : 'one-shot') as ChildMode,
    state: (['running', 'inactive', 'diagnostic', 'succeeded', 'failed', 'redacted', 'unknown'].includes(row.state) ? row.state : 'unknown') as ChildState,
    role: row.role,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ended_at: row.ended_at,
  }
}

const CHILD_NODE_SELECT = `
  SELECT c.*, rowid AS seq,
    (SELECT COUNT(*) FROM child_links cc WHERE cc.parent_id = c.child_id) AS children_count
  FROM child_links c`

// ── store ──────────────────────────────────────────────────────────────────

export class TrajectoryStore {
  private readonly db: DatabaseSync
  private readonly emitEvent: (projectId: string, kind: KernelEventKind, payload?: Record<string, unknown>) => KernelEvent

  constructor(db: DatabaseSync, emitEvent: (projectId: string, kind: KernelEventKind, payload?: Record<string, unknown>) => KernelEvent) {
    this.db = db
    this.emitEvent = emitEvent
  }

  private assertProject(projectId: string): void {
    const row = this.db.prepare('SELECT 1 AS x FROM projects WHERE project_id = ?').get(projectId)
    if (row === undefined) throw new KernelError(404, 'project_not_found', `project ${projectId} not found`)
  }

  private assertChild(childId: string): ChildLinkRow {
    const row = this.db.prepare('SELECT * FROM child_links WHERE child_id = ?').get(childId) as ChildLinkRow | undefined
    if (row === undefined) throw new KernelError(404, 'child_not_found', `subagent child ${childId} not found`)
    return row
  }

  private appendHistory(childId: string, eventType: string, payload: Record<string, unknown>): void {
    const next = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM child_history WHERE child_id = ?').get(childId) as { next: number }).next
    this.db.prepare(
      'INSERT INTO child_history (child_id, seq, event_id, event_type, payload, occurred_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(childId, next, `hist_${randomUUID().replaceAll('-', '')}`, eventType, JSON.stringify(payload), new Date().toISOString())
  }

  private static clampLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) return TRAJECTORY_PAGE_LIMIT_DEFAULT
    return Math.min(Math.max(Math.floor(limit), 1), TRAJECTORY_PAGE_LIMIT_MAX)
  }

  // ── trajectory projection (read-only, redacted) ──────────────────────────

  /** Keyset-paginated read-only projection of the Kernel Outbox. Cursor is
   * `(after_seq, after_event_id)`: outbox event_seq is per-aggregate, and
   * the aggregate-less bucket (e.g. session.linked) allocates from its own
   * sequence, so equal seqs across buckets are ordered and resumed by
   * event_id. Never exposes raw payloads. */
  projectTrajectory(projectId: string, opts: { after_seq?: number; after_event_id?: string; limit?: number; lane?: TrajectoryLane } = {}): TrajectoryPage {
    this.assertProject(projectId)
    const limit = TrajectoryStore.clampLimit(opts.limit)
    const afterSeq = opts.after_seq !== undefined && Number.isFinite(opts.after_seq) ? Math.max(0, Math.floor(opts.after_seq)) : 0
    const afterEventId = opts.after_event_id ?? ''
    const lane = opts.lane === 'research' || opts.lane === 'session' ? opts.lane : null
    const kinds = lane !== null ? [...laneKinds(lane)] : null
    let rows: Array<Record<string, unknown>>
    if (kinds !== null) {
      const placeholders = kinds.map(() => '?').join(',')
      rows = this.db.prepare(
        `SELECT * FROM events WHERE project_id = ? AND kind IN (${placeholders})
           AND (event_seq > ? OR (event_seq = ? AND event_id > ?))
         ORDER BY event_seq ASC, event_id ASC LIMIT ?`,
      ).all(projectId, ...kinds, afterSeq, afterSeq, afterEventId, limit + 1) as Array<Record<string, unknown>>
    } else {
      rows = this.db.prepare(
        `SELECT * FROM events WHERE project_id = ?
           AND (event_seq > ? OR (event_seq = ? AND event_id > ?))
         ORDER BY event_seq ASC, event_id ASC LIMIT ?`,
      ).all(projectId, afterSeq, afterSeq, afterEventId, limit + 1) as Array<Record<string, unknown>>
    }
    const total = kinds !== null
      ? (this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND kind IN (${kinds.map(() => '?').join(',')})`).get(projectId, ...kinds) as { n: number }).n
      : (this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE project_id = ?').get(projectId) as { n: number }).n
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      project_id: projectId,
      entries: page.map(row => {
        const kind = String(row.kind ?? 'unknown')
        const payload = jsonParse(row.payload as string | null, {})
        return {
          entry_id: String(row.event_id),
          event_seq: Number(row.event_seq ?? 0),
          event_version: Number(row.event_version ?? 1),
          project_id: String(row.project_id),
          aggregate_type: row.aggregate_type === null ? null : String(row.aggregate_type),
          aggregate_id: row.aggregate_id === null ? null : String(row.aggregate_id),
          kind,
          lane: laneForKind(kind),
          source: typeof row.source === 'string' && row.source !== '' ? String(row.source) : 'kernel-outbox',
          occurred_at: String(row.created_at),
          session_id: row.session_id === null ? null : String(row.session_id),
          summary: redactTrajectorySummary(summaryForKind(kind, payload)),
          status: statusForKind(kind, payload),
        }
      }),
      next_after_seq: last === undefined ? null : Number(last.event_seq),
      next_after_event_id: last === undefined ? null : String(last.event_id),
      has_more: rows.length > limit,
      total,
      limit,
      lane,
    }
  }

  /** Research + Session lanes for the initial view (trajectory-subagents.md
   * §1/§6): both lanes are always returned with their own cursors — the UI
   * marks Research authoritative and Session observational. */
  projectTrajectoryLanes(projectId: string, opts: { limit?: number } = {}): TrajectoryLanes {
    this.assertProject(projectId)
    return {
      project_id: projectId,
      research: this.projectTrajectory(projectId, { ...opts, lane: 'research' }),
      session: this.projectTrajectory(projectId, { ...opts, lane: 'session' }),
    }
  }

  // ── child topology (SUBAGENT-01 server side) ─────────────────────────────

  /** Register (or refresh) one subagent child link. `state` only changes via
   * updateChildState — a re-registration (e.g. plugin reload) never
   * resurrects a settled child. Summary is redacted + truncated on write. */
  registerChildLink(input: ChildLinkInput): ChildLink {
    this.assertProject(input.project_id)
    const now = new Date().toISOString()
    const existing = this.db.prepare('SELECT child_id FROM child_links WHERE child_id = ?').get(input.child_id) as { child_id: string } | undefined
    const summary = redactTrajectorySummary(input.summary)
    this.db.prepare(
      `INSERT INTO child_links (child_id, project_id, parent_id, label, summary, kind, mode, state, role, created_at, updated_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(child_id) DO UPDATE SET
         project_id = excluded.project_id,
         parent_id = excluded.parent_id,
         label = COALESCE(excluded.label, child_links.label),
         summary = excluded.summary,
         kind = excluded.kind,
         mode = excluded.mode,
         role = excluded.role,
         updated_at = excluded.updated_at`,
    ).run(
      input.child_id, input.project_id, input.parent_id ?? null, input.label ?? null, summary,
      input.kind ?? 'subagent', input.mode ?? 'one-shot', input.state ?? 'running', input.role ?? null,
      now, now,
    )
    const kind = input.kind ?? 'subagent'
    const mode = input.mode ?? 'one-shot'
    const state = input.state ?? 'running'
    if (existing === undefined) {
      this.appendHistory(input.child_id, 'started', { label: input.label, mode, kind, state, project_id: input.project_id, child_id: input.child_id })
      this.emitEvent(input.project_id, 'trajectory.child.started', {
        project_id: input.project_id, child_id: input.child_id, parent_id: input.parent_id ?? null,
        label: input.label, mode, kind, state,
      })
    } else {
      this.appendHistory(input.child_id, 'registered', { label: input.label, mode, kind, state, project_id: input.project_id, child_id: input.child_id })
      this.emitEvent(input.project_id, 'trajectory.child.updated', {
        project_id: input.project_id, child_id: input.child_id, note: 're-registered (state preserved)',
      })
    }
    return this.getChildLink(input.child_id)
  }

  getChildLink(childId: string): ChildLink {
    return linkFromRow(this.assertChild(childId))
  }

  /** State transition — appends history + outbox; `ended_at` pins once at
   * the first terminal state. Never touches child_followups/history reads. */
  updateChildState(childId: string, state: ChildState, detail?: string): ChildLink {
    const row = this.assertChild(childId)
    const now = new Date().toISOString()
    const terminal = TERMINAL_CHILD_STATES.has(state)
    this.db.prepare(
      `UPDATE child_links SET state = ?, updated_at = ?,
         ended_at = CASE WHEN ? THEN COALESCE(child_links.ended_at, ?) ELSE child_links.ended_at END
       WHERE child_id = ?`,
    ).run(state, now, terminal ? 1 : 0, terminal ? now : null, childId)
    this.appendHistory(childId, 'state', { state, detail: detail ?? null, child_id: childId })
    this.emitEvent(row.project_id, 'trajectory.child.updated', { child_id: childId, state, detail: detail ?? null })
    return this.getChildLink(childId)
  }

  /** Exact direct children of one parent (or roots when parent_id is null) —
   * trajectory-subagents.md §3: list returns ONLY exact direct children.
   * Cursor: `seq` (rowid ordinal), cap 500/page. */
  projectTopology(projectId: string, opts: { parent_id?: string | null; after_seq?: number; limit?: number } = {}): TopologyChildren {
    this.assertProject(projectId)
    const limit = TrajectoryStore.clampLimit(opts.limit)
    const afterSeq = opts.after_seq !== undefined && Number.isFinite(opts.after_seq) ? Math.max(0, Math.floor(opts.after_seq)) : 0
    const parentId = opts.parent_id ?? null
    const rows = this.db.prepare(
      `${CHILD_NODE_SELECT} WHERE c.project_id = ? AND c.parent_id IS ? AND rowid > ?
       ORDER BY rowid ASC LIMIT ?`,
    ).all(projectId, parentId, afterSeq, limit + 1) as unknown as ChildLinkNodeRow[]
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM child_links WHERE project_id = ? AND parent_id IS ?').get(projectId, parentId) as { n: number }).n
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      project_id: projectId,
      parent_id: parentId,
      items: page.map(nodeFromRow),
      total,
      next_after_seq: last === undefined ? null : last.seq,
      has_more: rows.length > limit,
    }
  }

  /** Exact parent + breadcrumb (root → parent), cycle-safe and orphan
   * fail-soft (trajectory-subagents.md §3). */
  getChildDetail(childId: string): ChildDetail {
    const row = this.db.prepare(`${CHILD_NODE_SELECT} WHERE c.child_id = ?`).get(childId) as ChildLinkNodeRow | undefined
    if (row === undefined) throw new KernelError(404, 'child_not_found', `subagent child ${childId} not found`)
    const node = nodeFromRow(row)
    if (row.parent_id === null) {
      return { child_id: childId, project_id: row.project_id, node, parent: null, breadcrumb: [] }
    }
    // Walk parents upward: cycle-safe (visited), depth-capped, orphans
    // fail-soft (missing rows stop the chain, parent → null).
    const seen = new Set<string>([childId])
    const chain: Array<ChildLinkNodeRow | null> = []
    let cursor: string | null = row.parent_id
    for (let depth = 0; depth < BREADCRUMB_MAX_DEPTH && cursor !== null; depth++) {
      if (seen.has(cursor)) break
      seen.add(cursor)
      const prow = this.db.prepare(`${CHILD_NODE_SELECT} WHERE c.child_id = ?`).get(cursor) as ChildLinkNodeRow | undefined
      chain.push(prow ?? null)
      cursor = prow?.parent_id ?? null
    }
    const present = chain.filter((r): r is ChildLinkNodeRow => r !== null)
    const breadcrumb = present.slice().reverse()
    return {
      child_id: childId,
      project_id: row.project_id,
      node,
      parent: chain[0] !== null && chain[0] !== undefined ? nodeFromRow(chain[0]) : null,
      breadcrumb: breadcrumb.map(nodeFromRow),
    }
  }

  /** Read-only per-child history (started/registered/state/followup) with
   * per-child monotonic seq cursor. Never activates the child. */
  childHistory(childId: string, opts: { after_seq?: number; limit?: number } = {}): ChildHistoryPage {
    const row = this.assertChild(childId)
    const limit = TrajectoryStore.clampLimit(opts.limit)
    const afterSeq = opts.after_seq !== undefined && Number.isFinite(opts.after_seq) ? Math.max(0, Math.floor(opts.after_seq)) : 0
    const rows = this.db.prepare(
      'SELECT * FROM child_history WHERE child_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
    ).all(childId, afterSeq, limit + 1) as unknown as ChildHistoryRow[]
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM child_history WHERE child_id = ?').get(childId) as { n: number }).n
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return {
      child_id: childId,
      project_id: row.project_id,
      items: page.map(h => ({
        seq: h.seq,
        event_id: h.event_id,
        child_id: h.child_id,
        type: h.event_type,
        occurred_at: h.occurred_at,
        summary: redactTrajectorySummary(historySummaryFor(h.event_type, jsonParse(h.payload, {}))),
      })),
      next_after_seq: last === undefined ? null : last.seq,
      has_more: rows.length > limit,
      total,
    }
  }

  /** One-shot READ-ONLY followup: records the message and returns
   * `message_id` WITHOUT executing it — child state is never touched
   * (trajectory-subagents.md §3: "接收只返回 message_id，不冒充已执行").
   * Execution with exact live-parent validation requires the DSH host. */
  childFollowup(childId: string, message: string, requestId?: string): FollowupReceipt {
    const row = this.assertChild(childId)
    const messageId = `msg_${randomUUID().replaceAll('-', '')}`
    const redacted = redactTrajectorySummary(message)
    const hash = createHash('sha256').update(message).digest('hex')
    this.db.prepare(
      `INSERT INTO child_followups (message_id, child_id, project_id, request, request_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'accepted_read_only', ?)`,
    ).run(messageId, childId, row.project_id, redacted, hash, new Date().toISOString())
    this.appendHistory(childId, 'followup', { message_id: messageId, message: redacted, request_id: requestId ?? null, child_id: childId })
    this.emitEvent(row.project_id, 'trajectory.child.followup', {
      project_id: row.project_id, child_id: childId, message_id: messageId, read_only: true,
    })
    return {
      message_id: messageId,
      child_id: childId,
      project_id: row.project_id,
      accepted: true,
      read_only: true,
      state_unchanged: true,
      note: 'recorded without activating the child (standalone kernel); exact live-parent validation and execution require the DSH host (trajectory-subagents.md §3)',
    }
  }

  /** Project of a child (BFF membership pre-check + route resolution);
   * null when the child is unknown (404, no enumeration). */
  childProjectId(childId: string): string | null {
    const row = this.db.prepare('SELECT project_id FROM child_links WHERE child_id = ?').get(childId) as { project_id: string } | undefined
    return row === undefined ? null : row.project_id
  }
}

function historySummaryFor(eventType: string, payload: Record<string, unknown>): string {
  switch (eventType) {
    case 'started':
      return `subagent started${typeof payload.label === 'string' && payload.label !== '' ? `: ${payload.label}` : ''} (mode ${String(payload.mode ?? 'one-shot')})`
    case 'registered':
      return `subagent re-registered (state preserved)`
    case 'state':
      return `state → ${String(payload.state ?? 'unknown')}`
    case 'followup':
      return `followup message recorded (${String(payload.message_id ?? '?')})`
    default:
      return `event ${eventType}`
  }
}

function jsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (text === undefined || text === null || text === '') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}
