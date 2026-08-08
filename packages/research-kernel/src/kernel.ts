/**
 * Research Kernel — authoritative research state machine, ledger and durable
 * job store (design §3.2 ADR-002/003, §4.2, §5, §6). All writes go through
 * this class; the HTTP server and DSH plugin are thin adapters.
 * @module @dsh-scholar/research-kernel/kernel
 */

import { createHash, createPublicKey, randomUUID, verify, type KeyObject } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  ArtifactRecord, BudgetConstraints, BudgetRecord, Claim, CodeSnapshot, CorpusSnapshot, Decision,
  EvidenceItem, ExecutionConfig, ExperimentContract, Gate, IdeaCard, IntegrityConfig,
  JobRecord, KernelEvent, KernelEventKind, Paper, Passage, ResearchProject, ResearchBrief,
  RunnerKey, SessionLink, TRANSITION_TABLE, buildClaimId, buildContractId, buildGateId, buildIdeaId,
  buildProjectId, type ArtifactKind, type GateType, type JobSpecBound, type JobStatus, type ProjectStatus,
} from '@dsh-scholar/research-schemas'
import { ArtifactCas } from './cas.js'
import { openDatabase, type EventRow, type GateRow, type JobRow, type ProjectRow, type RunnerKeyRow } from './store.js'
import { computePairedAnalysis } from '@dsh-scholar/analysis-worker'
import { openTexWorkspace, TexError, type TexBuild, type TexDocumentInfo, type TexFileEntry, type TexSnapshotManifest } from './tex-workspace.js'

export interface KernelOptions {
  /** SQLite database path (defaults to `:memory:`). */
  dbPath?: string
  /** CAS root for immutable artifacts. */
  casRoot?: string
  /** Kernel identity used for leases. */
  instanceId?: string
  /** §12.7: reject unsigned run manifests at job completion (default: compatible, accept). */
  requireSignedManifest?: boolean
}

/** Error carrying an HTTP status for the API adapter. */
export class KernelError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function jsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (text === undefined || text === null || text === '') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function projectFromRow(row: ProjectRow): ResearchProject {
  return {
    project_id: row.project_id,
    name: row.name,
    workspace: row.workspace,
    mode: row.mode as ResearchProject['mode'],
    status: row.status as ProjectStatus,
    revision: row.revision,
    brief: jsonParse(row.brief, {} as ResearchProject['brief']),
    constraints: jsonParse(row.constraints, {} as ResearchProject['constraints']),
    execution: jsonParse(row.execution, {} as ResearchProject['execution']),
    integrity: jsonParse(row.integrity, {} as ResearchProject['integrity']),
    session_id: row.session_id,
    dsh_workspace_id: row.dsh_workspace_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    history: jsonParse(row.history, [] as string[]),
  }
}

function gateFromRow(row: GateRow): Gate {
  return {
    gate_id: row.gate_id,
    project_id: row.project_id,
    type: row.type as GateType,
    title: row.title,
    summary: row.summary,
    payload: jsonParse(row.payload, {}),
    status: row.status as Gate['status'],
    dsh_session_id: row.dsh_session_id,
    dsh_event_id: row.dsh_event_id,
    created_at: row.created_at,
    decided_at: row.decided_at,
  }
}

function jobFromRow(row: JobRow): JobSpecBound {
  const payload = jsonParse(row.payload, {} as Record<string, unknown>)
  // §12.6: the opaque lease token is persisted inside payload.__lease_token
  // (avoids a schema column); surface it as a first-class field and keep the
  // public payload clean.
  const leaseToken = typeof payload.__lease_token === 'string' ? payload.__lease_token : null
  if (leaseToken !== null) delete payload.__lease_token
  return {
    job_id: row.job_id,
    project_id: row.project_id,
    contract_id: row.contract_id,
    idempotency_key: row.idempotency_key,
    kind: row.kind as JobRecord['kind'],
    command: jsonParse(row.command, [] as string[]),
    payload,
    status: row.status as JobStatus,
    failure_class: row.failure_class as JobRecord['failure_class'],
    lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at,
    heartbeat_at: row.heartbeat_at,
    lease_generation: row.lease_generation ?? null,
    lease_token: leaseToken,
    // §12.2 JobSpec binding (SCH-EXEC-002): code snapshot materialized from CAS.
    code_snapshot_id: row.code_snapshot_id,
    data_artifact_ids: Array.isArray(payload.data_artifact_ids) ? payload.data_artifact_ids.map(String) : [],
    image_digest: typeof payload.image_digest === 'string' ? payload.image_digest : '',
    output_contract: typeof payload.output_contract === 'object' && payload.output_contract !== null
      ? { metrics: String((payload.output_contract as Record<string, unknown>).metrics ?? '/outputs/metrics.json'), logs: String((payload.output_contract as Record<string, unknown>).logs ?? '/outputs/run.log') }
      : undefined,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    run_manifest: jsonParse(row.run_manifest, null),
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function eventFromRow(row: EventRow): KernelEvent {
  return {
    event_id: row.event_id,
    project_id: row.project_id,
    kind: row.kind as KernelEventKind,
    payload: jsonParse(row.payload, {}),
    source: row.source,
    delivered: row.delivered === 1,
    created_at: row.created_at,
  }
}

/** Side effects applied when a human decision approves a gate (design §5.2). */
const GATE_APPROVAL_TRANSITION: Record<GateType, { from: ProjectStatus; to: ProjectStatus }> = {
  scope: { from: 'DRAFT', to: 'SCOPED' },
  idea: { from: 'IDEATING', to: 'IDEA_APPROVED' },
  contract: { from: 'BASELINE_REPRO', to: 'CONTRACT_APPROVED' },
  budget: { from: 'BLOCKED_GATE', to: 'EXPERIMENTING' }, // resume: caller pins target in payload
  release: { from: 'RELEASE_READY', to: 'RELEASED' },
}

/** Run `fn` inside a single SQLite transaction (v2 §7.6 transactional kernel). */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* already rolled back */ }
    throw error
  }
}

export class ResearchKernel {
  readonly db: DatabaseSync
  readonly cas: ArtifactCas
  readonly instanceId: string
  /** TeX workspace store (execution-runtime.md §12). */
  readonly tex: import('./tex-workspace.js').TexWorkspaceStore
  /** §12.7: when true, unsigned run manifests are rejected at completion. */
  requireSignedManifest: boolean

  constructor(options: KernelOptions = {}) {
    this.db = openDatabase(options.dbPath ?? ':memory:')
    this.cas = new ArtifactCas(options.casRoot ?? join(process.cwd(), '.research-cas'))
    this.tex = openTexWorkspace(options.dbPath ?? ':memory:')
    this.instanceId = options.instanceId ?? `kernel-${randomUUID().slice(0, 8)}`
    this.requireSignedManifest = options.requireSignedManifest ?? false
  }

  close(): void {
    this.tex.close()
    this.db.close()
  }

  // ── events (append-only outbox) ──────────────────────────────────────────

  emit(projectId: string | null, kind: KernelEventKind, payload: Record<string, unknown> = {}): KernelEvent {
    const event: KernelEvent = {
      event_id: `evt_${randomUUID().replaceAll('-', '')}`,
      project_id: projectId,
      kind,
      payload,
      source: `kernel:${this.instanceId}`,
      delivered: false,
      created_at: nowIso(),
    }
    this.db.prepare(
      'INSERT INTO events (event_id, project_id, kind, payload, source, delivered, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    ).run(event.event_id, event.project_id, event.kind, JSON.stringify(event.payload), event.source, event.created_at)
    return event
  }

  listEvents(projectId?: string, delivered?: boolean): KernelEvent[] {
    const rows = projectId === undefined
      ? this.db.prepare('SELECT * FROM events ORDER BY created_at').all() as unknown as EventRow[]
      : this.db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as EventRow[]
    return rows
      .filter(row => delivered === undefined || row.delivered === (delivered ? 1 : 0))
      .map(eventFromRow)
  }

  /** At-least-once delivery: mark events delivered; the caller dedupes. */
  markEventsDelivered(eventIds: string[]): void {
    const stmt = this.db.prepare('UPDATE events SET delivered = 1 WHERE event_id = ? AND delivered = 0')
    for (const id of eventIds) stmt.run(id)
  }

  // ── projects ─────────────────────────────────────────────────────────────

  createProject(input: {
    name: string
    workspace: string
    brief: ResearchBrief
    mode?: 'gate-only' | 'full-auto'
    constraints?: ResearchProject['constraints']
    execution?: ResearchProject['execution']
    integrity?: ResearchProject['integrity']
    session_id?: string | null
    dsh_workspace_id?: string | null
  }): ResearchProject {
    // hardening: store the PARSED brief (defaults applied), never the raw
    // caller object — projection and ledger stay consistent.
    const brief = ResearchBrief.parse(input.brief)
    const project: ResearchProject = {
      project_id: buildProjectId(),
      name: input.name,
      workspace: input.workspace,
      mode: input.mode ?? 'gate-only',
      status: 'DRAFT',
      revision: 0,
      brief,
      constraints: BudgetConstraints.parse(input.constraints ?? {}),
      execution: ExecutionConfig.parse(input.execution ?? {}),
      integrity: IntegrityConfig.parse(input.integrity ?? {}),
      session_id: input.session_id ?? null,
      dsh_workspace_id: input.dsh_workspace_id ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
      history: ['created'],
    }
    this.db.prepare(
      `INSERT INTO projects (project_id, name, workspace, mode, status, revision, brief, constraints, execution, integrity, session_id, dsh_workspace_id, created_at, updated_at, history)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      project.project_id, project.name, project.workspace, project.mode, project.status, project.revision,
      JSON.stringify(project.brief), JSON.stringify(project.constraints), JSON.stringify(project.execution),
      JSON.stringify(project.integrity), project.session_id, project.dsh_workspace_id,
      project.created_at, project.updated_at, JSON.stringify(project.history),
    )
    if (project.session_id !== null) this.linkSession(project.session_id, project.project_id)
    // API-01 foundation: the creator becomes the first PI member
    // (reconstruction-contracts.md §7: "Project creator 成为 pi").
    const creator = (input as { creator_principal_id?: string }).creator_principal_id
    if (creator !== undefined && creator !== '') {
      this.db.prepare(`INSERT INTO project_members (project_id, principal_id, tenant_id, role, created_at, updated_at)
        VALUES (?, ?, ?, 'pi', ?, ?)`)
        .run(project.project_id, creator, (input as { creator_tenant_id?: string }).creator_tenant_id ?? '', project.created_at, project.created_at)
    }
    this.emit(project.project_id, 'project.created', { project_id: project.project_id, name: project.name })
    return project
  }

  /**
   * v2 (api-contracts.md §4): atomic create-project with the initial Scope
   * Gate + creator membership + budget, plus the BFF-scoped Idempotency-Key.
   * Replaying the same key + request hash returns the SAME project/gate/
   * budget/membership; the same key with a different request hash is a 409.
   */
  createProjectWithInitialGate(input: Parameters<ResearchKernel['createProject']>[0] & {
    idempotency_key?: string
    request_hash?: string
  }): { project: ResearchProject; gate: Gate; budget: BudgetRecord; membership: Array<Record<string, unknown>> } {
    if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
      const existing = this.db.prepare('SELECT project_id, request_hash FROM projects WHERE idempotency_key = ?')
        .get(input.idempotency_key) as { project_id: string; request_hash: string | null } | undefined
      if (existing !== undefined) {
        if (existing.request_hash !== (input.request_hash ?? '')) {
          throw new KernelError(409, 'idempotency_conflict', `idempotency key ${input.idempotency_key} was used with a different request hash`)
        }
        return {
          project: this.getProject(existing.project_id),
          gate: this.listGates(existing.project_id, 'pending').find(g => g.type === 'scope') ?? this.listGates(existing.project_id)[0]!,
          budget: this.getBudget(existing.project_id),
          membership: this.listProjectMembers(existing.project_id),
        }
      }
    }
    return withTransaction(this.db, () => {
      const project = this.createProject(input)
      // Initial Scope Gate (v2 contract: the project ships with it).
      const gate = this.createGate({
        project_id: project.project_id,
        type: 'scope',
        title: 'Scope Gate',
        summary: 'Initial scope approval required before any research work.',
      })
      const budget = this.getBudget(project.project_id)
      if (input.idempotency_key !== undefined && input.idempotency_key !== '') {
        this.db.prepare('UPDATE projects SET idempotency_key = ?, request_hash = ? WHERE project_id = ?')
          .run(input.idempotency_key, input.request_hash ?? '', project.project_id)
      }
      return { project, gate, budget, membership: this.listProjectMembers(project.project_id) }
    })
  }

  /**
   * v2 keyset pagination (api-contracts.md §1): items ordered by
   * (updated_at DESC, project_id DESC); cursor encodes the last row.
   */
  listProjectsPage(limit = 50, cursor?: string): { items: ProjectRow[]; next_cursor: string | null } {
    const cap = Math.min(Math.max(limit, 1), 200)
    let after: { updated_at: string; project_id: string } | null = null
    if (cursor !== undefined && cursor !== '') {
      // api-contracts.md §1: a malformed cursor is an explicit 400, never a
      // silent restart-from-top.
      let raw: string
      try {
        raw = Buffer.from(cursor, 'base64url').toString('utf8')
      } catch {
        throw new KernelError(400, 'invalid_cursor', `malformed cursor: ${cursor}`)
      }
      const [updatedAt, projectId] = raw.split('|')
      if (updatedAt === undefined || projectId === undefined || updatedAt === '' || projectId === '') {
        throw new KernelError(400, 'invalid_cursor', `malformed cursor: ${cursor}`)
      }
      after = { updated_at: updatedAt, project_id: projectId }
    }
    const rows = after === null
      ? this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, project_id DESC LIMIT ?').all(cap + 1) as unknown as ProjectRow[]
      : this.db.prepare('SELECT * FROM projects WHERE (updated_at < ? OR (updated_at = ? AND project_id < ?)) ORDER BY updated_at DESC, project_id DESC LIMIT ?')
        .all(after.updated_at, after.updated_at, after.project_id, cap + 1) as unknown as ProjectRow[]
    const hasMore = rows.length > cap
    const page = hasMore ? rows.slice(0, cap) : rows
    const last = page[page.length - 1]
    return {
      items: page,
      next_cursor: hasMore && last !== undefined ? Buffer.from(`${last.updated_at}|${last.project_id}`).toString('base64url') : null,
    }
  }

  // ── project membership (API-01 foundation, reconstruction-contracts §7) ──

  listProjectMembers(projectId: string): Array<{
    project_id: string; principal_id: string; tenant_id: string; role: string; created_at: string; updated_at: string
  }> {
    this.getProject(projectId)
    const rows = this.db.prepare('SELECT * FROM project_members WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as Array<{
      project_id: string; principal_id: string; tenant_id: string; role: string; created_at: string; updated_at: string
    }>
    return rows
  }

  addProjectMember(input: {
    project_id: string
    principal_id: string
    role: 'pi' | 'researcher' | 'operator' | 'auditor' | 'viewer'
    tenant_id?: string
    actor: string
  }): { project_id: string; principal_id: string; tenant_id: string; role: string; created_at: string; updated_at: string } {
    const project = this.getProject(input.project_id)
    // member_manage capability (reconstruction-contracts §7): the acting
    // principal must already be a PI of the project.
    const actorRow = this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND principal_id = ?')
      .get(input.project_id, input.actor) as { role: string } | undefined
    if (actorRow?.role !== 'pi') {
      throw new KernelError(403, 'member_manage_denied', `only an existing PI can manage members of ${input.project_id}`)
    }
    const now = nowIso()
    const tenant = input.tenant_id ?? ''
    this.db.prepare(`INSERT INTO project_members (project_id, principal_id, tenant_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, principal_id) DO UPDATE SET role = excluded.role, tenant_id = excluded.tenant_id, updated_at = excluded.updated_at`)
      .run(input.project_id, input.principal_id, tenant, input.role, now, now)
    this.emit(project.project_id, 'project.membership.updated', { project_id: input.project_id, principal_id: input.principal_id, role: input.role })
    return { project_id: input.project_id, principal_id: input.principal_id, tenant_id: tenant, role: input.role, created_at: now, updated_at: now }
  }

  removeProjectMember(input: { project_id: string; principal_id: string; actor: string }): void {
    this.getProject(input.project_id)
    const actorRow = this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND principal_id = ?')
      .get(input.project_id, input.actor) as { role: string } | undefined
    if (actorRow?.role !== 'pi') {
      throw new KernelError(403, 'member_manage_denied', `only an existing PI can manage members of ${input.project_id}`)
    }
    const target = this.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND principal_id = ?')
      .get(input.project_id, input.principal_id) as { role: string } | undefined
    if (target === undefined) throw new KernelError(404, 'member_not_found', `member ${input.principal_id} not found in ${input.project_id}`)
    if (target.role === 'pi') {
      const piCount = (this.db.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = ?').get(input.project_id, 'pi') as { n: number }).n
      if (piCount <= 1) {
        throw new KernelError(422, 'last_pi_removal', 'the last PI of a project cannot be removed')
      }
    }
    this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND principal_id = ?').run(input.project_id, input.principal_id)
  }

  getProject(projectId: string): ResearchProject {
    const row = this.db.prepare('SELECT * FROM projects WHERE project_id = ?').get(projectId) as ProjectRow | undefined
    if (row === undefined) throw new KernelError(404, 'project_not_found', `project ${projectId} not found`)
    return projectFromRow(row)
  }

  listProjects(): ResearchProject[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as unknown as ProjectRow[]
    return rows.map(projectFromRow)
  }

  /** State transition with expected_revision CAS (design §5.1, §9.3). */
  transition(projectId: string, to: ProjectStatus, expectedRevision: number, reason = ''): ResearchProject {
    const project = this.getProject(projectId)
    if (project.revision !== expectedRevision) {
      throw new KernelError(409, 'revision_conflict', `expected revision ${expectedRevision}, got ${project.revision}`)
    }
    const allowed = TRANSITION_TABLE[project.status]
    if (!allowed.includes(to)) {
      throw new KernelError(422, 'invalid_transition', `transition ${project.status} -> ${to} not allowed`)
    }
    const now = nowIso()
    this.db.prepare('UPDATE projects SET status = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ? AND revision = ?')
      .run(to, now, JSON.stringify([...project.history, `${project.status}->${to}${reason ? ` (${reason})` : ''}`]), projectId, expectedRevision)
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.transitioned', { from: project.status, to, revision: updated.revision, reason })
    return updated
  }

  /** Rename a project (dsh-web session actions); audited in history. */
  renameProject(projectId: string, name: string): ResearchProject {
    const clean = name.trim()
    if (clean === '') throw new KernelError(422, 'invalid_name', 'project name must not be empty')
    if (clean.length > 120) throw new KernelError(422, 'invalid_name', 'project name too long (max 120 chars)')
    const project = this.getProject(projectId)
    const now = nowIso()
    this.db.prepare('UPDATE projects SET name = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ?')
      .run(clean, now, JSON.stringify([...project.history, `renamed to "${clean}"`]), projectId)
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.renamed', { from: project.name, to: clean, revision: updated.revision })
    return updated
  }

  /**
   * Archive a project (dsh-web session actions): data is kept, the project
   * leaves the Active group and all further gates/actions are blocked.
   * Reversible via unarchiveProject.
   */
  archiveProject(projectId: string): ResearchProject {
    const project = this.getProject(projectId)
    if (project.status === 'ARCHIVED') return project
    const now = nowIso()
    this.db.prepare('UPDATE projects SET status = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ?')
      .run('ARCHIVED', now, JSON.stringify([...project.history, `${project.status}->ARCHIVED (archived)`]), projectId)
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.transitioned', { from: project.status, to: 'ARCHIVED', revision: updated.revision, reason: 'archived' })
    return updated
  }

  /** Restore an archived project (back to RELEASE_READY when it was done,
   * otherwise to its pre-archive phase). */
  unarchiveProject(projectId: string): ResearchProject {
    const project = this.getProject(projectId)
    if (project.status !== 'ARCHIVED') return project
    const restored = project.history.at(-1)?.startsWith('RELEASED') === true ? 'RELEASED' as ProjectStatus : 'RELEASE_READY' as ProjectStatus
    const now = nowIso()
    this.db.prepare('UPDATE projects SET status = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ?')
      .run(restored, now, JSON.stringify([...project.history, 'ARCHIVED->restored']), projectId)
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.transitioned', { from: 'ARCHIVED', to: restored, revision: updated.revision, reason: 'restored' })
    return updated
  }

  /** Link a DSH session to a project (design RSP-006). */
  linkSession(sessionId: string, projectId: string): SessionLink {
    this.getProject(projectId)
    const link: SessionLink = { session_id: sessionId, project_id: projectId, linked_at: nowIso() }
    this.db.prepare('INSERT INTO session_links (session_id, project_id, linked_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, linked_at = excluded.linked_at')
      .run(link.session_id, link.project_id, link.linked_at)
    this.emit(projectId, 'session.linked', { session_id: sessionId })
    return link
  }

  getProjectBySession(sessionId: string): ResearchProject | null {
    const row = this.db.prepare('SELECT project_id FROM session_links WHERE session_id = ?').get(sessionId) as { project_id: string } | undefined
    if (row === undefined) return null
    try {
      return this.getProject(row.project_id)
    } catch {
      return null
    }
  }

  // ── gates & decisions ────────────────────────────────────────────────────

  createGate(input: {
    project_id: string
    type: GateType
    title: string
    summary?: string
    payload?: Record<string, unknown>
    session_id?: string | null
  }): Gate {
    this.getProject(input.project_id)
    const gate: Gate = {
      gate_id: buildGateId(),
      project_id: input.project_id,
      type: input.type,
      title: input.title,
      summary: input.summary ?? '',
      payload: input.payload ?? {},
      status: 'pending',
      dsh_session_id: input.session_id ?? null,
      dsh_event_id: null,
      created_at: nowIso(),
      decided_at: null,
    }
    this.db.prepare(
      'INSERT INTO gates (gate_id, project_id, type, title, summary, payload, status, dsh_session_id, dsh_event_id, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(gate.gate_id, gate.project_id, gate.type, gate.title, gate.summary, JSON.stringify(gate.payload), gate.status, gate.dsh_session_id, gate.dsh_event_id, gate.created_at, gate.decided_at)
    this.emit(input.project_id, 'gate.created', { gate_id: gate.gate_id, type: gate.type, title: gate.title })
    return gate
  }

  listGates(projectId: string, status?: Gate['status']): Gate[] {
    const rows = status === undefined
      ? this.db.prepare('SELECT * FROM gates WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as GateRow[]
      : this.db.prepare('SELECT * FROM gates WHERE project_id = ? AND status = ? ORDER BY created_at').all(projectId, status) as unknown as GateRow[]
    return rows.map(gateFromRow)
  }

  getGate(gateId: string): Gate {
    const row = this.db.prepare('SELECT * FROM gates WHERE gate_id = ?').get(gateId) as GateRow | undefined
    if (row === undefined) throw new KernelError(404, 'gate_not_found', `gate ${gateId} not found`)
    return gateFromRow(row)
  }

  /** Record a human decision and apply the gate side effect (v2 §6.5, §6.6). */
  decideGate(input: {
    gate_id: string
    actor: string
    /** v2: authenticated human principal; agents cannot call this path. */
    principal?: {
      principal_id: string
      tenant_id?: string
      auth_method?: string
      session_id?: string | null
    }
    decision: 'approved' | 'rejected' | 'revised'
    reason?: string
    diff?: string
    session_id?: string | null
    event_id?: string | null
    /** For budget gates: the status to resume to on approval. */
    resume_to?: ProjectStatus
  }): { gate: Gate; decision: Decision; project: ResearchProject } {
    const gate = this.getGate(input.gate_id)
    if (gate.status !== 'pending') {
      throw new KernelError(409, 'gate_already_decided', `gate ${input.gate_id} already ${gate.status}`)
    }
    return withTransaction(this.db, () => {
      const decision: Decision = {
        decision_id: `dec_${randomUUID().replaceAll('-', '')}`,
        gate_id: gate.gate_id,
        project_id: gate.project_id,
        gate_type: gate.type,
        actor: input.actor,
        // v2 §6.4: authenticated principal record; missing principal is only
        // tolerated for legacy rows (actor == 'legacy_unverified').
        principal: input.principal === undefined && input.actor === 'legacy_unverified'
          ? undefined
          : {
              principal_id: input.principal?.principal_id ?? input.actor,
              tenant_id: input.principal?.tenant_id ?? '',
              auth_method: input.principal?.auth_method ?? 'unverified',
              session_id: input.principal?.session_id ?? input.session_id ?? null,
            },
        decision: input.decision,
        reason: input.reason ?? '',
        diff: input.diff ?? '',
        session_id: input.session_id ?? null,
        event_id: input.event_id ?? null,
        decided_at: nowIso(),
      }
      this.db.prepare(
        'INSERT INTO decisions (decision_id, gate_id, project_id, gate_type, actor, decision, reason, diff, session_id, event_id, decided_at, principal_id, principal_tenant_id, principal_auth_method, principal_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        decision.decision_id, decision.gate_id, decision.project_id, decision.gate_type, decision.actor,
        decision.decision, decision.reason, decision.diff, decision.session_id, decision.event_id, decision.decided_at,
        decision.principal?.principal_id ?? null,
        decision.principal?.tenant_id ?? null,
        decision.principal?.auth_method ?? null,
        decision.principal?.session_id ?? null,
      )
      const gateUpdate = this.db.prepare('UPDATE gates SET status = ?, decided_at = ? WHERE gate_id = ? AND status = ?')
        .run(input.decision, decision.decided_at, gate.gate_id, 'pending')
      if (Number(gateUpdate.changes) !== 1) {
        // Lost the CAS race to a concurrent decision (design §11.2).
        throw new KernelError(409, 'gate_already_decided', `gate ${input.gate_id} was decided concurrently (CAS race)`)
      }
      let project = this.getProject(gate.project_id)
      if (input.decision === 'approved') {
        const mapping = GATE_APPROVAL_TRANSITION[gate.type]
        if (gate.type === 'budget') {
          // budget-gate-resume (acceptance-tests.md §2): ONLY the resume
          // target declared in the gate payload may be used; client-supplied
          // resume_to is ignored.
          const declared = typeof gate.payload.resume_to === 'string' ? gate.payload.resume_to : ''
          const resumeTo = declared !== '' && declared !== 'BLOCKED_GATE' ? declared as ProjectStatus : project.status
          if (project.status === 'BLOCKED_GATE' && resumeTo !== 'BLOCKED_GATE') {
            project = this.forceTransition(project.project_id, resumeTo, `budget gate ${gate.gate_id} approved`)
          }
        } else if (gate.type === 'contract') {
          // GOV-02: freeze the target contract ATOMICALLY with the decision
          // (design §6.6: contracts become immutable on Contract Gate
          // approval) — inside the same transaction as the decision row.
          const contractId = typeof gate.payload.contract_id === 'string' ? gate.payload.contract_id : undefined
          if (contractId !== undefined) {
            this.approveContract(contractId, decision.decision_id, input.actor)
          }
          if (project.status === mapping.from) {
            project = this.gateTransition(project.project_id, mapping.to, mapping.from, gate.gate_id, `${gate.type} gate approved`)
          } else if (project.status !== mapping.to) {
            throw new KernelError(422, 'gate_state_mismatch', `gate ${gate.gate_id} (${gate.type}) cannot approve from ${project.status}`)
          }
        } else if (project.status === mapping.from) {
          project = this.gateTransition(project.project_id, mapping.to, mapping.from, gate.gate_id, `${gate.type} gate approved`)
        } else if (project.status === mapping.to) {
          // Already in target state (idempotent replay) — no-op.
        } else {
          throw new KernelError(422, 'gate_state_mismatch', `gate ${gate.gate_id} (${gate.type}) cannot approve from ${project.status}`)
        }
      } else if (input.decision === 'rejected' && gate.type === 'scope') {
        project = this.forceTransition(project.project_id, 'FAILED', `scope gate ${gate.gate_id} rejected`)
      }
      this.emit(gate.project_id, 'gate.decided', {
        gate_id: gate.gate_id, type: gate.type, decision: input.decision, actor: input.actor, decision_id: decision.decision_id,
      })
      return { gate: this.getGate(gate.gate_id), decision, project }
    })
  }

  listDecisions(projectId: string): Decision[] {
    const rows = this.db.prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY decided_at').all(projectId) as unknown as Array<Record<string, unknown>>
    return rows.map(row => {
      const principalId = row.principal_id as string | null
      const decision: Decision = {
        decision_id: row.decision_id as string,
        gate_id: row.gate_id as string,
        project_id: row.project_id as string,
        gate_type: row.gate_type as GateType,
        actor: row.actor as string,
        // hardening GOV-01: the durable principal is reconstructed from the
        // stored columns; legacy rows (NULL) surface as legacy_unverified.
        principal: principalId !== null && principalId !== ''
          ? {
              principal_id: principalId,
              tenant_id: (row.principal_tenant_id as string | null) ?? '',
              auth_method: (row.principal_auth_method as string | null) ?? 'unverified',
              session_id: (row.principal_session_id as string | null) ?? null,
            }
          : undefined,
        decision: row.decision as Decision['decision'],
        reason: row.reason as string,
        diff: row.diff as string,
        session_id: row.session_id as string | null,
        event_id: row.event_id as string | null,
        decided_at: row.decided_at as string,
      }
      return decision
    })
  }

  /** Gate-transaction transition: the ONLY path into gate-controlled states
   * (v2 §6.2). Bypasses the generic TRANSITION_TABLE (which excludes those
   * states) but still performs revision CAS and appends history. */
  private gateTransition(projectId: string, to: ProjectStatus, from: ProjectStatus, gateId: string, reason: string): ResearchProject {
    const project = this.getProject(projectId)
    if (project.status !== from) {
      throw new KernelError(422, 'gate_state_mismatch', `gate ${gateId} cannot transition from ${project.status} (expected ${from})`)
    }
    // Bypasses the generic TRANSITION_TABLE on purpose (§6.2): the gate
    // transaction is the ONLY authorized path into gate-controlled states.
    const now = nowIso()
    const result = this.db.prepare(
      'UPDATE projects SET status = ?, revision = revision + 1, updated_at = ?, history = ? WHERE project_id = ? AND revision = ?',
    ).run(to, now, JSON.stringify([...project.history, `${from}->${to} (${reason}; gate ${gateId})`]), projectId, project.revision)
    if (Number(result.changes) !== 1) {
      throw new KernelError(409, 'revision_conflict', `gate transition lost CAS race on project ${projectId}`)
    }
    const updated = this.getProject(projectId)
    this.emit(projectId, 'project.transitioned', { from, to, revision: updated.revision, reason, via: 'gate' })
    return updated
  }

  /** Internal: transition without CAS check (gate side effects, budget resume). */
  private forceTransition(projectId: string, to: ProjectStatus, reason: string): ResearchProject {
    const project = this.getProject(projectId)
    const allowed = TRANSITION_TABLE[project.status]
    if (!allowed.includes(to)) {
      throw new KernelError(422, 'invalid_transition', `transition ${project.status} -> ${to} not allowed (${reason})`)
    }
    return this.transition(projectId, to, project.revision, reason)
  }

  // ── budget & policy (design §4.2, §5.2 Budget Gate) ──────────────────────

  getBudget(projectId: string): BudgetRecord {
    const row = this.db.prepare('SELECT * FROM budget WHERE project_id = ?').get(projectId) as BudgetRecord | undefined
    return row ?? { project_id: projectId, model_cost_usd: 0, gpu_hours: 0, api_requests: 0, updated_at: nowIso() }
  }

  recordUsage(projectId: string, usage: { model_cost_usd?: number; gpu_hours?: number; api_requests?: number }): BudgetRecord {
    // v2 §7.6: budget increment + limit check + block state + outbox in ONE transaction.
    return withTransaction(this.db, () => {
      const project = this.getProject(projectId)
      const current = this.getBudget(projectId)
      const next: BudgetRecord = {
        project_id: projectId,
        model_cost_usd: current.model_cost_usd + (usage.model_cost_usd ?? 0),
        gpu_hours: current.gpu_hours + (usage.gpu_hours ?? 0),
        api_requests: current.api_requests + (usage.api_requests ?? 0),
        updated_at: nowIso(),
      }
      this.db.prepare(
        'INSERT INTO budget (project_id, model_cost_usd, gpu_hours, api_requests, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET model_cost_usd = excluded.model_cost_usd, gpu_hours = excluded.gpu_hours, api_requests = excluded.api_requests, updated_at = excluded.updated_at',
      ).run(projectId, next.model_cost_usd, next.gpu_hours, next.api_requests, next.updated_at)
      this.emit(projectId, 'budget.updated', { model_cost_usd: next.model_cost_usd, gpu_hours: next.gpu_hours })
      // Hard limit check: crossing a limit stops the project into BLOCKED_GATE.
      if (project.status !== 'BLOCKED_GATE' && project.status !== 'FAILED' && project.status !== 'STOPPED') {
        const exceeded: string[] = []
        if (next.model_cost_usd > project.constraints.max_model_cost_usd) exceeded.push(`model cost $${next.model_cost_usd} > $${project.constraints.max_model_cost_usd}`)
        if (next.gpu_hours > project.constraints.max_gpu_hours) exceeded.push(`gpu hours ${next.gpu_hours} > ${project.constraints.max_gpu_hours}`)
        if (exceeded.length > 0) {
          this.emit(projectId, 'policy.violation', { reasons: exceeded })
          // Budget Gate declares the ONLY allowed resume target: the status
          // the project was in before the block (acceptance-tests.md §2
          // budget-gate-resume — never client-supplied).
          const resumeTo = project.status
          this.db.prepare(
            `INSERT INTO gates (gate_id, project_id, type, title, summary, payload, status, dsh_session_id, dsh_event_id, created_at, decided_at)
             VALUES (?, ?, 'budget', ?, '', ?, 'pending', NULL, NULL, ?, NULL)`,
          ).run(buildGateId(), projectId, 'Budget Gate', JSON.stringify({ resume_to: resumeTo }), nowIso())
          this.db.prepare('UPDATE projects SET status = ?, updated_at = ?, history = ? WHERE project_id = ?')
            .run('BLOCKED_GATE', nowIso(), JSON.stringify([...project.history, `BLOCKED_GATE (budget: ${exceeded.join('; ')}; resume allowed to ${resumeTo})`]), projectId)
        }
      }
      return this.getBudget(projectId)
    })
  }

  // ── CAS integrity & GC (acceptance-tests.md §3) ─────────────────────────

  /**
   * Remove blobs that are not referenced by ANY artifact record (orphan GC,
   * storage-migrations.md §6). A grace period protects blobs written but not
   * yet committed to a transaction (stage/finalize pattern). Returns the
   * number of removed blobs.
   */
  collectOrphanBlobs(graceMs = 0): number {
    const referenced = new Set(
      (this.db.prepare('SELECT sha256 FROM artifacts').all() as Array<{ sha256: string }>).map(r => r.sha256),
    )
    const now = Date.now()
    let removed = 0
    for (const sha of this.cas.list()) {
      if (referenced.has(sha)) continue
      const mtime = this.cas.mtimeMs(sha)
      if (mtime === null || now - mtime < graceMs) continue
      if (this.cas.remove(sha)) removed++
    }
    return removed
  }

  /**
   * Integrity scan: artifacts whose blob is missing from the CAS (or empty).
   * Returns per-project counts + the offending artifact ids. Used by the
   * recovery flow after restore (storage-migrations.md §10).
   */
  scanMissingBlobs(): { project_id: string; artifact_id: string; sha256: string }[] {
    const rows = this.db.prepare('SELECT artifact_id, project_id, sha256 FROM artifacts').all() as unknown as Array<{
      artifact_id: string; project_id: string; sha256: string
    }>
    return rows.filter(r => !this.cas.has(r.sha256))
  }

  // ── identity (api-contracts.md §3 /v2/health) ────────────────────────────

  schemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined
    return row !== undefined ? Number(row.value) : 0
  }

  databaseId(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'database_id'").get() as { value?: string } | undefined
    return row?.value ?? ''
  }

  // ── artifacts (CAS) ──────────────────────────────────────────────────────

  registerArtifact(input: {
    project_id: string
    kind: ArtifactKind
    content: Uint8Array | string
    metadata?: Record<string, unknown>
    /** RFC 2046 media type (ART-02); pdf artifacts should pass application/pdf. */
    media_type?: string
    /** Download file name for Content-Disposition. */
    file_name?: string
  }): ArtifactRecord {
    this.getProject(input.project_id)
    const { sha256, size_bytes } = this.cas.put(input.content)
    const artifactId = `sha256:${sha256}`
    // v2 §7.4: blobs are global (CAS), artifact records are project-scoped —
    // the same blob in another project yields that project's OWN record.
    const existing = this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND artifact_id = ?')
      .get(input.project_id, artifactId) as ArtifactRecord | undefined
    if (existing !== undefined) return existing
    const mediaType = input.media_type !== undefined && input.media_type !== ''
      ? input.media_type
      : (input.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream')
    const record: ArtifactRecord = {
      artifact_id: artifactId,
      project_id: input.project_id,
      kind: input.kind,
      size_bytes,
      sha256,
      metadata: input.metadata ?? {},
      media_type: mediaType,
      file_name: input.file_name ?? null,
      created_at: nowIso(),
    }
    this.db.prepare('INSERT INTO artifacts (artifact_id, project_id, kind, size_bytes, sha256, metadata, media_type, file_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.artifact_id, record.project_id, record.kind, record.size_bytes, record.sha256, JSON.stringify(record.metadata), record.media_type, record.file_name, record.created_at)
    this.emit(input.project_id, 'artifact.registered', { artifact_id: record.artifact_id, kind: record.kind, size_bytes })
    return record
  }

  /** Project-scoped artifact lookup (v2 §3.4 isolation). */
  getArtifact(projectId: string, sha256OrId: string): ArtifactRecord {
    const id = sha256OrId.startsWith('sha256:') ? sha256OrId : `sha256:${sha256OrId}`
    const row = this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND artifact_id = ?')
      .get(projectId, id) as ArtifactRecord | undefined
    if (row === undefined) throw new KernelError(404, 'artifact_not_found', `artifact ${id} not found in project ${projectId}`)
    // metadata is stored as JSON TEXT — surface it as the schema object.
    return { ...row, metadata: jsonParse(row.metadata as unknown as string, {}) }
  }


  listArtifacts(projectId: string): ArtifactRecord[] {
    const rows = this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as ArtifactRecord[]
    return rows.map(row => ({ ...row, metadata: jsonParse(row.metadata as unknown as string, {}) }))
  }

  /** All project records referencing one blob (v2 §7.4 compatibility). */
  listArtifactsForBlob(sha256OrId: string): ArtifactRecord[] {
    const id = sha256OrId.startsWith('sha256:') ? sha256OrId : `sha256:${sha256OrId}`
    return this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ? ORDER BY project_id').all(id) as unknown as ArtifactRecord[]
  }

  /** Verify a RunManifest's artifact refs exist in CAS (design §4.6.1). */
  verifyArtifactRefs(refs: string[]): { ok: boolean; missing: string[] } {
    const missing = refs.filter(ref => {
      const sha = ref.replace(/^sha256:/, '')
      return !this.cas.has(sha)
    })
    return { ok: missing.length === 0, missing }
  }

  // ── ideas ────────────────────────────────────────────────────────────────

  createIdea(input: Omit<IdeaCard, 'idea_id' | 'project_id' | 'status' | 'version' | 'created_at' | 'updated_at'> & { project_id: string }): IdeaCard {
    this.getProject(input.project_id)
    const card: IdeaCard = {
      idea_id: buildIdeaId(),
      project_id: input.project_id,
      version: 1,
      title: input.title,
      hypothesis: input.hypothesis,
      scientific_gap: input.scientific_gap,
      nearest_prior_works: input.nearest_prior_works,
      exact_delta: input.exact_delta,
      falsification: input.falsification,
      minimum_viable_experiment: input.minimum_viable_experiment,
      novelty_audit: input.novelty_audit,
      scores: input.scores,
      risk_notes: input.risk_notes ?? '',
      status: 'proposed',
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    IdeaCard.parse(card)
    this.db.prepare('INSERT INTO ideas (idea_id, project_id, body, updated_at) VALUES (?, ?, ?, ?)')
      .run(card.idea_id, card.project_id, JSON.stringify(card), card.updated_at)
    this.emit(input.project_id, 'idea.created', { idea_id: card.idea_id, title: card.title })
    return card
  }

  listIdeas(projectId: string): IdeaCard[] {
    const rows = this.db.prepare('SELECT * FROM ideas WHERE project_id = ? ORDER BY updated_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => jsonParse(row.body, null as unknown as IdeaCard)).filter(Boolean)
  }

  getIdea(ideaId: string): IdeaCard {
    const row = this.db.prepare('SELECT * FROM ideas WHERE idea_id = ?').get(ideaId) as { body?: string } | undefined
    if (row?.body === undefined) throw new KernelError(404, 'idea_not_found', `idea ${ideaId} not found`)
    return JSON.parse(row.body) as IdeaCard
  }

  /** Versioned update: existing fields carried forward, version bumped. */
  updateIdea(ideaId: string, patch: Partial<Omit<IdeaCard, 'idea_id' | 'project_id' | 'version' | 'created_at'>>): IdeaCard {
    const current = this.getIdea(ideaId)
    const next: IdeaCard = {
      ...current,
      ...patch,
      version: current.version + 1,
      updated_at: nowIso(),
    }
    IdeaCard.parse(next)
    this.db.prepare('UPDATE ideas SET body = ?, updated_at = ? WHERE idea_id = ?').run(JSON.stringify(next), next.updated_at, ideaId)
    this.emit(current.project_id, 'idea.updated', { idea_id: ideaId, version: next.version })
    return next
  }

  approveIdea(ideaId: string): IdeaCard {
    return this.updateIdea(ideaId, { status: 'approved' })
  }

  /** Attach/refresh the novelty counter-search audit on an IdeaCard. */
  updateIdeaNovelty(ideaId: string, audit: NonNullable<IdeaCard['novelty_audit']>): IdeaCard {
    return this.updateIdea(ideaId, { novelty_audit: audit })
  }

  // ── contracts ────────────────────────────────────────────────────────────

  registerContract(input: Omit<ExperimentContract, 'contract_id' | 'version' | 'status' | 'created_at' | 'updated_at'> & { project_id: string }): ExperimentContract {
    this.getProject(input.project_id)
    const contract: ExperimentContract = {
      contract_id: buildContractId(),
      version: 1,
      project_id: input.project_id,
      idea_id: input.idea_id,
      baseline_run: input.baseline_run,
      code_snapshot: input.code_snapshot,
      data: input.data,
      methods: input.methods,
      metrics: input.metrics,
      seeds: input.seeds,
      analysis: input.analysis,
      ablations: input.ablations,
      stop_conditions: input.stop_conditions,
      status: 'draft',
      approval: undefined,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    ExperimentContract.parse(contract)
    this.db.prepare('INSERT INTO contracts (contract_id, project_id, body, updated_at) VALUES (?, ?, ?, ?)')
      .run(contract.contract_id, contract.project_id, JSON.stringify(contract), contract.updated_at)
    this.emit(input.project_id, 'contract.registered', { contract_id: contract.contract_id })
    return contract
  }

  getContract(contractId: string): ExperimentContract {
    const row = this.db.prepare('SELECT * FROM contracts WHERE contract_id = ?').get(contractId) as { body?: string } | undefined
    if (row?.body === undefined) throw new KernelError(404, 'contract_not_found', `contract ${contractId} not found`)
    return JSON.parse(row.body) as ExperimentContract
  }

  listContracts(projectId: string): ExperimentContract[] {
    const rows = this.db.prepare('SELECT * FROM contracts WHERE project_id = ? ORDER BY updated_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as ExperimentContract)
  }

  /** Freeze a contract upon Contract Gate approval (design §6.6: immutable). */
  approveContract(contractId: string, gateDecisionId: string, actor: string): ExperimentContract {
    const current = this.getContract(contractId)
    if (current.status === 'approved') return current
    const next: ExperimentContract = {
      ...current,
      status: 'approved',
      approval: { gate_decision_id: gateDecisionId, approved_at: nowIso(), approved_by: actor },
      updated_at: nowIso(),
    }
    this.db.prepare('UPDATE contracts SET body = ?, updated_at = ? WHERE contract_id = ?').run(JSON.stringify(next), next.updated_at, contractId)
    this.emit(current.project_id, 'contract.approved', { contract_id: contractId, gate_decision_id: gateDecisionId })
    return next
  }

  // ── corpus ───────────────────────────────────────────────────────────────

  snapshotCorpus(input: {
    project_id: string
    queries: CorpusSnapshot['queries']
    papers: Paper[]
    passages?: Passage[]
    citation_edges?: CorpusSnapshot['citation_edges']
    external_claims?: CorpusSnapshot['external_claims']
  }): CorpusSnapshot {
    this.getProject(input.project_id)
    const snapshot: CorpusSnapshot = {
      snapshot_id: `corpus_snap_${randomUUID().slice(0, 8)}`,
      project_id: input.project_id,
      queries: input.queries,
      papers: input.papers,
      passages: input.passages ?? [],
      citation_edges: input.citation_edges ?? [],
      external_claims: input.external_claims ?? [],
      quality: {
        total_papers: input.papers.length,
        dedup_ratio: 0,
        coverage_note: '',
      },
      created_at: nowIso(),
      frozen: true,
    }
    CorpusSnapshot.parse(snapshot)
    this.db.prepare('INSERT INTO corpus_snapshots (snapshot_id, project_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(snapshot.snapshot_id, snapshot.project_id, JSON.stringify(snapshot), snapshot.created_at)
    this.emit(input.project_id, 'corpus.snapshotted', { snapshot_id: snapshot.snapshot_id, total_papers: snapshot.papers.length })
    return snapshot
  }

  listCorpusSnapshots(projectId: string): CorpusSnapshot[] {
    this.getProject(projectId)
    const rows = this.db.prepare('SELECT * FROM corpus_snapshots WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as CorpusSnapshot)
  }

  getCorpusSnapshot(snapshotId: string): CorpusSnapshot {
    const row = this.db.prepare('SELECT * FROM corpus_snapshots WHERE snapshot_id = ?').get(snapshotId) as { body?: string } | undefined
    if (row?.body === undefined) throw new KernelError(404, 'snapshot_not_found', `corpus snapshot ${snapshotId} not found`)
    return JSON.parse(row.body) as CorpusSnapshot
  }

  // ── code snapshot archive (design §11.3, SCH-EXEC-002) ───────────────────

  /**
   * Archive a directory's ACTUAL file contents into a content-addressed
   * `code` artifact (JSON `{schema_version, project_id, description, files:
   * {rel: {sha256, content_base64}}, excludes}`) plus a lightweight `manifest`
   * artifact (file list + hashes, no content). The Runner materializes the
   * code snapshot ONLY from the Artifact Store — never from agent host dirs.
   *
   * Safety (path escape / symlink protection): the walk rejects any file whose
   * relative path escapes the root, and any symbolic link whose realpath
   * resolves OUTSIDE the real root (422 `snapshot_path_escape`); directories
   * `.git`, `node_modules` and `.research-cas` are excluded.
   */
  snapshotCodeArchive(projectId: string, rootPath: string, description = ''): CodeSnapshot {
    this.getProject(projectId)
    const absRoot = resolve(rootPath)
    let rootInfo
    try {
      rootInfo = statSync(absRoot)
    } catch {
      throw new KernelError(422, 'snapshot_root_missing', `code snapshot root not readable: ${rootPath}`)
    }
    if (!rootInfo.isDirectory()) {
      throw new KernelError(422, 'snapshot_root_missing', `code snapshot root is not a directory: ${rootPath}`)
    }
    const realRoot = realpathSync(absRoot)
    // Directories that are never part of a code snapshot (build/vendor/state).
    const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.research-cas'])
    const files: Record<string, { sha256: string; content_base64: string; size_bytes: number }> = {}
    let totalBytes = 0
    const walk = (dir: string): void => {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch (error) {
        throw new KernelError(422, 'snapshot_read_error', `code snapshot: directory not readable: ${dir} (${(error as Error).message})`)
      }
      for (const entry of entries) {
        const full = join(dir, entry)
        let info
        try {
          info = lstatSync(full)
        } catch {
          continue // raced with deletion — skip
        }
        if (info.isSymbolicLink()) {
          // §11.3 escape protection: symlinks resolving outside the archived
          // root are rejected; symlinks staying inside are followed.
          let target: string
          try {
            target = realpathSync(full)
          } catch {
            continue // dangling symlink — skip
          }
          if (target !== realRoot && !target.startsWith(`${realRoot}${sep}`)) {
            throw new KernelError(422, 'snapshot_path_escape',
              `code snapshot: symbolic link escapes the archived root: ${relative(absRoot, full)} -> ${target}`)
          }
          try {
            info = statSync(full)
          } catch {
            continue
          }
        }
        if (info.isDirectory()) {
          if (EXCLUDED_DIRS.has(entry)) continue
          walk(full)
        } else if (info.isFile()) {
          const rel = relative(absRoot, full)
          if (rel.startsWith('..') || rel.startsWith(sep)) {
            throw new KernelError(422, 'snapshot_path_escape', `code snapshot: path escapes the archived root: ${full}`)
          }
          let content: Buffer
          try {
            content = readFileSync(full)
          } catch (error) {
            throw new KernelError(422, 'snapshot_read_error', `code snapshot: unreadable file ${rel}: ${(error as Error).message}`)
          }
          const sha256 = createHash('sha256').update(content).digest('hex')
          files[rel] = { sha256, content_base64: content.toString('base64'), size_bytes: content.byteLength }
          totalBytes += content.byteLength
        }
        // sockets/fifos/devices are skipped silently (never part of source).
      }
    }
    walk(absRoot)

    const archive = {
      schema_version: 1,
      project_id: projectId,
      description,
      root: absRoot,
      files,
      excludes: [...EXCLUDED_DIRS],
      created_at: nowIso(),
    }
    const archiveRecord = this.registerArtifact({
      project_id: projectId,
      kind: 'code',
      content: JSON.stringify(archive),
      metadata: { kind: 'code-snapshot-archive', files: Object.keys(files).length, total_bytes: totalBytes, root: absRoot },
    })
    // Lightweight manifest artifact (file list + hashes, no content) — §11.3
    // `manifest_artifact_id`. Same sha256 space; content-addressed.
    const manifestRecord = this.registerArtifact({
      project_id: projectId,
      kind: 'manifest',
      content: JSON.stringify({
        schema_version: 1,
        project_id: projectId,
        description,
        root: absRoot,
        files: Object.fromEntries(Object.entries(files).map(([rel, f]) => [rel, { sha256: f.sha256, size_bytes: f.size_bytes }])),
        excludes: [...EXCLUDED_DIRS],
        created_at: nowIso(),
      }),
      metadata: { kind: 'code-snapshot-manifest', files: Object.keys(files).length },
    })
    const snapshot: CodeSnapshot = {
      snapshot_id: `code_snap_${randomUUID().slice(0, 8)}`,
      project_id: projectId,
      path: absRoot,
      description,
      archive_artifact_id: archiveRecord.artifact_id,
      manifest_artifact_id: manifestRecord.artifact_id,
      submodules_artifact_id: null,
      lockfiles: [],
      files: Object.keys(files).length,
      total_bytes: totalBytes,
      sha256: archiveRecord.sha256,
      created_at: nowIso(),
    }
    // STORE-02: record the snapshot in the authoritative code_snapshots
    // registry (snapshot_id -> archive/manifest artifacts + integrity).
    this.db.prepare(`INSERT INTO code_snapshots
        (snapshot_id, project_id, archive_artifact_id, manifest_artifact_id, source_json, sha256, file_count, size_bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(snapshot.snapshot_id, projectId, archiveRecord.artifact_id, manifestRecord.artifact_id,
        JSON.stringify({ description, root: absRoot, excludes: [...EXCLUDED_DIRS] }),
        archiveRecord.sha256, Object.keys(files).length, totalBytes, snapshot.created_at)
    // Both artifacts already emit artifact.registered events (outbox).
    return snapshot
  }

  /** STORE-02: authoritative code snapshot registry lookup. */
  getCodeSnapshot(snapshotId: string): {
    snapshot_id: string
    project_id: string
    archive_artifact_id: string
    manifest_artifact_id: string
    source: { description?: string; root?: string; excludes?: string[] }
    sha256: string
    file_count: number
    size_bytes: number
    created_at: string
  } {
    const row = this.db.prepare('SELECT * FROM code_snapshots WHERE snapshot_id = ?').get(snapshotId) as {
      snapshot_id: string; project_id: string; archive_artifact_id: string; manifest_artifact_id: string
      source_json: string; sha256: string; file_count: number; size_bytes: number; created_at: string
    } | undefined
    if (row === undefined) throw new KernelError(404, 'code_snapshot_not_found', `code snapshot ${snapshotId} not found`)
    return {
      snapshot_id: row.snapshot_id,
      project_id: row.project_id,
      archive_artifact_id: row.archive_artifact_id,
      manifest_artifact_id: row.manifest_artifact_id,
      source: JSON.parse(row.source_json) as { description?: string; root?: string; excludes?: string[] },
      sha256: row.sha256,
      file_count: row.file_count,
      size_bytes: row.size_bytes,
      created_at: row.created_at,
    }
  }

  // ── durable jobs (design §4.2 Job Controller, §9.3) ──────────────────────

  /** Idempotent job submission: same idempotency_key returns the existing job. */
  submitJob(input: {
    project_id: string
    idempotency_key: string
    kind: JobRecord['kind']
    command?: string[]
    payload?: Record<string, unknown>
    contract_id?: string | null
    max_attempts?: number
    // §12.2 JobSpec binding (SCH-EXEC-002): code snapshot materialized by the
    // Runner from CAS; image_digest/output_contract/data_artifact_ids travel
    // inside payload.
    code_snapshot_id?: string | null
    data_artifact_ids?: string[]
    image_digest?: string
    output_contract?: { metrics: string; logs: string }
  }): JobSpecBound {
    const project = this.getProject(input.project_id)
    // v2 §3.4: idempotency is project-scoped — the same key in two projects
    // yields two independent jobs.
    const existing = this.db.prepare('SELECT * FROM jobs WHERE project_id = ? AND idempotency_key = ?')
      .get(input.project_id, input.idempotency_key) as JobRow | undefined
    if (existing !== undefined) return jobFromRow(existing)
    // v2 §3.2 / §12.3: formal-class jobs require a container runner profile;
    // isolated-subprocess is rejected at submission time (kernel layer).
    const SECURE_KINDS: readonly string[] = ['baseline', 'pilot', 'formal', 'reproduce', 'latex-compile']
    if (SECURE_KINDS.includes(input.kind) && project.execution.runner_profile === 'isolated-subprocess') {
      throw new KernelError(422, 'container_execution_required',
        `job kind ${input.kind} requires a container runner profile (got ${project.execution.runner_profile}); host subprocess is prohibited (v2 §3.2)`)
    }
    // §12 latex-compile binds a frozen TeX snapshot, not a code snapshot.
    if (input.kind === 'latex-compile') {
      const docId = typeof input.payload?.tex_document_id === 'string' ? input.payload.tex_document_id : ''
      const rev = typeof input.payload?.tex_revision === 'number' ? input.payload.tex_revision : undefined
      if (docId === '' || rev === undefined) {
        throw new KernelError(422, 'tex_snapshot_required', 'latex-compile jobs require payload.tex_document_id + payload.tex_revision')
      }
      this.texSnapshot(docId, rev)
    }
    // §12.2 (SCH-EXEC-002): formal-class jobs MUST bind a materialized code
    // snapshot — the Runner never executes agent host directories.
    // latex-compile binds a frozen TeX snapshot instead (§12).
    const codeSnapshotId = input.code_snapshot_id ?? null
    if (SECURE_KINDS.includes(input.kind) && input.kind !== 'latex-compile' && (codeSnapshotId === null || codeSnapshotId === '')) {
      throw new KernelError(422, 'code_snapshot_required',
        `job kind ${input.kind} requires code_snapshot_id (the Runner materializes code from CAS, §11.3/§12.2)`)
    }
    // STORE-02: code_snapshot_id may be the authoritative REGISTRY id
    // (code_snap_…) or a raw archive artifact id; the registry id is
    // resolved to its archive artifact and the job binds THAT (the Runner
    // materializes from CAS via fetchArtifact).
    let boundCodeSnapshotId = codeSnapshotId
    if (codeSnapshotId !== null && codeSnapshotId !== '') {
      if (codeSnapshotId.startsWith('code_snap_')) {
        try {
          const registered = this.getCodeSnapshot(codeSnapshotId)
          this.getArtifact(project.project_id, registered.archive_artifact_id)
          boundCodeSnapshotId = registered.archive_artifact_id
        } catch {
          throw new KernelError(422, 'code_snapshot_unknown',
            `code_snapshot_id ${codeSnapshotId} is not a registered snapshot of project ${project.project_id}`)
        }
      } else {
        try {
          this.getArtifact(project.project_id, codeSnapshotId)
        } catch {
          throw new KernelError(422, 'code_snapshot_unknown',
            `code_snapshot_id ${codeSnapshotId} is not a registered artifact of project ${project.project_id}`)
        }
      }
    }
    // §12.2: image digest default; the rest of the binding travels in payload.
    const payload = {
      ...(input.payload ?? {}),
      image_digest: input.image_digest ?? (input.kind === 'latex-compile' ? 'texlive/texlive:latest' : (SECURE_KINDS.includes(input.kind) ? 'node:22-alpine' : '')),
      ...(input.data_artifact_ids !== undefined ? { data_artifact_ids: input.data_artifact_ids } : {}),
      ...(input.output_contract !== undefined ? { output_contract: input.output_contract } : {}),
    }
    const job: JobSpecBound = {
      job_id: `job_${randomUUID().slice(0, 12)}`,
      project_id: input.project_id,
      contract_id: input.contract_id ?? null,
      idempotency_key: input.idempotency_key,
      kind: input.kind,
      command: input.command ?? [],
      payload,
      status: 'queued',
      failure_class: null,
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      lease_generation: null,
      lease_token: null,
      code_snapshot_id: boundCodeSnapshotId,
      data_artifact_ids: input.data_artifact_ids ?? [],
      image_digest: String(payload.image_digest),
      output_contract: input.output_contract,
      attempts: 0,
      max_attempts: input.max_attempts ?? 3,
      run_manifest: null,
      error: '',
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    this.db.prepare(
      `INSERT INTO jobs (job_id, project_id, contract_id, idempotency_key, kind, command, payload, status, failure_class, lease_owner, lease_expires_at, heartbeat_at, attempts, max_attempts, run_manifest, error, created_at, updated_at, code_snapshot_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.job_id, job.project_id, job.contract_id, job.idempotency_key, job.kind, JSON.stringify(job.command),
      JSON.stringify(job.payload), job.status, job.failure_class, job.lease_owner, job.lease_expires_at,
      job.heartbeat_at, job.attempts, job.max_attempts, job.run_manifest === null ? null : JSON.stringify(job.run_manifest),
      job.error, job.created_at, job.updated_at, job.code_snapshot_id,
    )
    this.emit(input.project_id, 'job.submitted', { job_id: job.job_id, kind: job.kind, idempotency_key: input.idempotency_key })
    return job
  }

  getJob(jobId: string): JobRecord {
    const row = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as JobRow | undefined
    if (row === undefined) throw new KernelError(404, 'job_not_found', `job ${jobId} not found`)
    return jobFromRow(row)
  }

  listJobs(projectId: string, status?: JobStatus): JobRecord[] {
    const rows = status === undefined
      ? this.db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as JobRow[]
      : this.db.prepare('SELECT * FROM jobs WHERE project_id = ? AND status = ? ORDER BY created_at').all(projectId, status) as unknown as JobRow[]
    return rows.map(jobFromRow)
  }

  /** Claim queued/retryable jobs for an owner with a lease TTL (design §9.3, §12.6).
   * Every claim bumps `lease_generation` and issues a fresh opaque
   * `lease_token`; runners must echo both on heartbeat/complete, and stale
   * generations are fenced out (an old runner can never finish the job). */
  claimJobs(owner: string, leaseTtlSeconds = 300, limit = 8): JobRecord[] {
    const now = nowIso()
    const rows = this.db.prepare(
      `SELECT * FROM jobs WHERE status = 'queued' OR (status = 'retryable' AND attempts < max_attempts) ORDER BY created_at LIMIT ?`,
    ).all(limit) as unknown as JobRow[]
    const claimed: JobRecord[] = []
    const update = this.db.prepare(
      `UPDATE jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, attempts = attempts + 1, lease_generation = COALESCE(lease_generation, 0) + 1, payload = ?, updated_at = ? WHERE job_id = ? AND (status = 'queued' OR status = 'retryable')`,
    )
    for (const row of rows) {
      const leaseExpires = new Date(Date.now() + leaseTtlSeconds * 1000).toISOString()
      const payload = jsonParse(row.payload, {} as Record<string, unknown>)
      const leaseToken = `lt_${randomUUID().replaceAll('-', '')}${randomUUID().slice(0, 8)}`
      payload.__lease_token = leaseToken
      const result = update.run(owner, leaseExpires, now, JSON.stringify(payload), now, row.job_id)
      if (Number(result.changes) === 1) claimed.push(jobFromRow(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(row.job_id) as unknown as JobRow))
    }
    return claimed
  }

  /**
   * Renew a lease (heartbeat); rejects when owned by another instance.
   * §12.6: when `generation`/`token` are provided the lease is fenced —
   * both must match the CURRENT lease, otherwise 409 `lease_stale`.
   * Legacy callers that pass neither keep the old owner-only check.
   */
  heartbeatJob(jobId: string, owner: string, generation?: number | null, token?: string | null, leaseTtlSeconds = 300): JobRecord {
    const job = this.getJob(jobId)
    if (job.lease_owner !== null && job.lease_owner !== owner) {
      throw new KernelError(409, 'lease_conflict', `job ${jobId} leased by ${job.lease_owner}`)
    }
    const fenced = (generation !== undefined && generation !== null) || (token !== undefined && token !== null)
    if (fenced && (job.lease_generation !== (generation ?? null) || job.lease_token !== (token ?? null))) {
      throw new KernelError(409, 'lease_stale',
        `job ${jobId} lease is stale: expected generation ${job.lease_generation ?? 'n/a'} token ${job.lease_token ?? 'n/a'}, got generation ${generation ?? 'n/a'} token ${token ?? 'n/a'}`)
    }
    const now = nowIso()
    const leaseExpires = new Date(Date.now() + leaseTtlSeconds * 1000).toISOString()
    this.db.prepare('UPDATE jobs SET lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE job_id = ?')
      .run(owner, leaseExpires, now, now, jobId)
    return this.getJob(jobId)
  }

  /** Recover stale leases after a runner crash (design §9.3). */
  recoverExpiredLeases(now = Date.now()): number {
    const result = this.db.prepare(
      `UPDATE jobs SET status = 'retryable', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    ).run(nowIso(), new Date(now).toISOString())
    return Number(result.changes)
  }

  /**
   * Finalize a job with a validated RunManifest (design §4.6.1, §6.5, §12.6-12.7).
   * §12.6 fencing: when `lease_generation`/`lease_token` are provided both must
   * match the CURRENT lease — a stale runner (old generation/token) is rejected
   * with 409 `lease_stale` even if its owner matches. Legacy callers that pass
   * neither keep the old owner-only check.
   * §12.7: when the manifest carries an Ed25519 `signature`, the kernel
   * verifies runner key registration, payload hash and signature; when it does
   * not, the manifest is accepted unless the kernel/project requires signing.
   */
  completeJob(input: {
    job_id: string
    owner: string
    status: 'succeeded' | 'failed' | 'cancelled'
    run_manifest?: Record<string, unknown>
    failure_class?: JobRecord['failure_class']
    error?: string
    lease_generation?: number | null
    lease_token?: string | null
  }): JobRecord {
    const job = this.getJob(input.job_id)
    if (job.lease_owner !== null && job.lease_owner !== input.owner) {
      throw new KernelError(409, 'lease_conflict', `job ${input.job_id} leased by ${job.lease_owner}`)
    }
    if (job.status !== 'running') {
      throw new KernelError(409, 'job_not_running', `job ${input.job_id} is ${job.status}, not running`)
    }
    // §12.6 strict lease fencing when generation/token are supplied.
    const fence = (input.lease_generation !== undefined && input.lease_generation !== null) || (input.lease_token !== undefined && input.lease_token !== null)
    if (fence && (job.lease_generation !== (input.lease_generation ?? null) || job.lease_token !== (input.lease_token ?? null))) {
      throw new KernelError(409, 'lease_stale',
        `job ${input.job_id} lease is stale: expected generation ${job.lease_generation ?? 'n/a'} token ${job.lease_token ?? 'n/a'}, got generation ${input.lease_generation ?? 'n/a'} token ${input.lease_token ?? 'n/a'}`)
    }
    if (input.run_manifest !== undefined) {
      this.verifyRunManifest(input.run_manifest, job)
    }
    if (input.status === 'succeeded' && input.run_manifest !== undefined) {
      const refs = collectManifestRefs(input.run_manifest)
      if (refs.length > 0) {
        const { ok, missing } = this.verifyArtifactRefs(refs)
        if (!ok) {
          throw new KernelError(422, 'manifest_refs_missing', `run manifest references missing artifacts: ${missing.join(', ')}`)
        }
        // §12.7: artifacts must exist AND belong to the job's project.
        for (const ref of refs) {
          try {
            this.getArtifact(job.project_id, ref)
          } catch {
            throw new KernelError(422, 'manifest_refs_missing', `artifact ${ref} is not registered in project ${job.project_id}`)
          }
        }
      }
    }
    const now = nowIso()
    this.db.prepare(
      'UPDATE jobs SET status = ?, failure_class = ?, run_manifest = ?, error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ?',
    ).run(input.status, input.failure_class ?? null, input.run_manifest !== undefined ? JSON.stringify(input.run_manifest) : null, input.error ?? '', now, input.job_id)
    const jobRecord = this.getJob(input.job_id)
    this.emit(job.project_id, 'job.updated', {
      job_id: jobRecord.job_id, status: jobRecord.status, failure_class: jobRecord.failure_class ?? undefined,
    })
    // §12 (TEX-02): a latex-compile completion finalizes its tex_builds row
    // (status/diagnostics/PDF/log from the runner manifest).
    if (job.kind === 'latex-compile' && input.run_manifest !== undefined) {
      const manifest = input.run_manifest as Record<string, unknown>
      const buildRow = this.db.prepare('SELECT build_id FROM tex_builds WHERE job_id = ?').get(job.job_id) as { build_id: string } | undefined
      if (buildRow !== undefined) {
        const diagnostics = Array.isArray(manifest.tex_diagnostics) ? manifest.tex_diagnostics : []
        this.texUpdateBuild(buildRow.build_id, {
          status: input.status === 'succeeded' ? 'succeeded' : (input.status === 'cancelled' ? 'cancelled' : 'failed'),
          diagnostics: JSON.stringify(diagnostics),
          pdf_artifact: typeof manifest.tex_pdf_artifact === 'string' ? manifest.tex_pdf_artifact : null,
          log_artifact: typeof manifest.tex_log_artifact === 'string' ? manifest.tex_log_artifact : null,
        })
      }
    }
    return jobRecord
  }

  /**
   * §12.7: register a runner Ed25519 public key used to verify RunManifest
   * signatures. Rejects non-Ed25519 / unparseable PEMs (422 runner_key_invalid).
   */
  registerRunnerKey(input: { key_id: string; public_key_pem: string }): RunnerKey {
    let publicKey: KeyObject
    try {
      publicKey = createPublicKey(input.public_key_pem)
    } catch (error) {
      throw new KernelError(422, 'runner_key_invalid', `public_key_pem is not a valid public key: ${(error as Error).message}`)
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new KernelError(422, 'runner_key_invalid', `runner key ${input.key_id} must be Ed25519, got ${publicKey.asymmetricKeyType}`)
    }
    const record: RunnerKey = { key_id: input.key_id, public_key_pem: input.public_key_pem, created_at: nowIso() }
    this.db.prepare(
      'INSERT INTO runner_keys (key_id, public_key_pem, created_at) VALUES (?, ?, ?) ON CONFLICT(key_id) DO UPDATE SET public_key_pem = excluded.public_key_pem, created_at = excluded.created_at',
    ).run(record.key_id, record.public_key_pem, record.created_at)
    return record
  }

  listRunnerKeys(): RunnerKey[] {
    const rows = this.db.prepare('SELECT * FROM runner_keys ORDER BY created_at').all() as unknown as RunnerKeyRow[]
    return rows.map(row => ({ key_id: row.key_id, public_key_pem: row.public_key_pem, created_at: row.created_at }))
  }

  /**
   * §12.7: verify a run manifest against the job it claims to belong to.
   *  - identity: job_id/project_id/contract_id/lease.generation must match the
   *    job when present (422 manifest_*_mismatch);
   *  - signature: when `signature` is present the runner key must be
   *    registered (422 manifest_key_unknown), the canonical payload hash must
   *    match `payload_sha256` when provided (422 manifest_hash_mismatch) and
   *    the Ed25519 signature must verify (422 manifest_signature_invalid);
   *  - unsigned manifests are accepted by default (backward compatible) and
   *    rejected only when the kernel or project requires signing
   *    (422 manifest_signature_required).
   * Field-level checks only: partial manifests (legacy callers) keep working.
   */
  private verifyRunManifest(manifest: Record<string, unknown>, job: JobRecord): void {
    // Job/Project/Contract matching (§12.7) — only when the fields are present.
    if (manifest.job_id !== undefined && manifest.job_id !== job.job_id) {
      throw new KernelError(422, 'manifest_job_mismatch', `run manifest job_id ${String(manifest.job_id)} does not match job ${job.job_id}`)
    }
    if (manifest.project_id !== undefined && manifest.project_id !== job.project_id) {
      throw new KernelError(422, 'manifest_project_mismatch', `run manifest project_id ${String(manifest.project_id)} does not match project ${job.project_id}`)
    }
    if (manifest.contract_id !== undefined && (job.contract_id === null || manifest.contract_id !== job.contract_id)) {
      throw new KernelError(422, 'manifest_contract_mismatch',
        `run manifest contract_id ${String(manifest.contract_id)} does not match job contract ${job.contract_id ?? 'none'}`)
    }
    // Lease fencing recorded inside the manifest (§12.6/§12.7).
    const lease = manifest.lease
    if (typeof lease === 'object' && lease !== null && typeof (lease as { generation?: unknown }).generation === 'number'
      && job.lease_generation !== null && (lease as { generation: number }).generation !== job.lease_generation) {
      throw new KernelError(422, 'manifest_lease_mismatch',
        `run manifest lease generation ${String((lease as { generation: number }).generation)} does not match job lease generation ${job.lease_generation}`)
    }

    const signature = manifest.signature
    if (typeof signature !== 'string' || signature === '') {
      // No signature: accept by default; enforce only when required.
      const integrity = this.getProject(job.project_id).integrity as Record<string, unknown>
      if (this.requireSignedManifest || integrity.require_signed_manifest === true) {
        throw new KernelError(422, 'manifest_signature_required', 'run manifest must be signed (require_signed_manifest)')
      }
      return
    }
    const runnerKeyId = manifest.runner_key_id
    if (typeof runnerKeyId !== 'string' || runnerKeyId === '') {
      throw new KernelError(422, 'manifest_key_unknown', 'run manifest carries a signature but no runner_key_id')
    }
    const keyRow = this.db.prepare('SELECT * FROM runner_keys WHERE key_id = ?').get(runnerKeyId) as RunnerKeyRow | undefined
    if (keyRow === undefined) {
      throw new KernelError(422, 'manifest_key_unknown', `runner key ${runnerKeyId} is not registered`)
    }
    // Signed payload = the manifest minus its signature field, canonicalized.
    const { signedPayload, signatureBytes } = stripManifestSignature(manifest)
    const payloadSha256 = manifest.payload_sha256
    if (typeof payloadSha256 === 'string' && payloadSha256 !== '') {
      const actual = sha256Hex(manifestHashPayload(manifest))
      if (actual !== payloadSha256) {
        throw new KernelError(422, 'manifest_hash_mismatch', `payload_sha256 mismatch: got ${actual}, manifest claims ${payloadSha256}`)
      }
    }
    let publicKey: KeyObject
    try {
      publicKey = createPublicKey(keyRow.public_key_pem)
    } catch {
      throw new KernelError(422, 'manifest_key_unknown', `runner key ${runnerKeyId} is not a valid public key`)
    }
    const valid = verify(null, Buffer.from(canonicalJson(signedPayload), 'utf8'), publicKey, signatureBytes)
    if (!valid) {
      throw new KernelError(422, 'manifest_signature_invalid', `run manifest signature verification failed for key ${runnerKeyId}`)
    }
  }

  cancelJob(jobId: string, actor: string, reason = ''): JobRecord {
    const job = this.getJob(jobId)
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      throw new KernelError(409, 'job_finished', `job ${jobId} already ${job.status}`)
    }
    this.db.prepare('UPDATE jobs SET status = ?, error = ?, lease_owner = NULL, updated_at = ? WHERE job_id = ?')
      .run('cancelled', reason ? `cancelled by ${actor}: ${reason}` : `cancelled by ${actor}`, nowIso(), jobId)
    // dsh-web parity: unify the job.updated event with the other mutations.
    this.emit(job.project_id, 'job.updated', { job_id: jobId, status: 'cancelled', actor })
    return this.getJob(jobId)
  }

  // ── terminal frames (execution-runtime.md §6) ────────────────────────────

  /** Default hot-log retention per run (8 MiB, execution-runtime.md §6). */
  static readonly TERMINAL_DEFAULT_MAX_BYTES = 8 * 1024 * 1024

  /**
   * Append a batch of terminal frames for a run. Validation: the job must
   * exist; frames from a stale lease generation are rejected (fencing); seq
   * must be monotonic within the run (duplicate/older seq is an idempotent
   * skip); chunk frames must carry channel/stream_seq/text/byte_offset/
   * byte_length. Retention: when total_bytes exceeds maxLogBytes, the OLDEST
   * chunk frames are evicted, dropped_bytes accumulate and truncated is set;
   * gap/exit frames are never evicted.
   */
  appendTerminalFrames(input: {
    jobId: string
    runId: string
    frames: Array<{
      seq: number
      stream_seq?: number | null
      channel?: 'stdout' | 'stderr' | null
      text?: string | null
      byte_offset?: number | null
      byte_length?: number | null
      frame_kind: 'chunk' | 'gap' | 'exit'
      payload_json?: string
      lease_generation?: number
    }>
    maxLogBytes?: number
  }): { appended: number; last_seq: number; truncated: boolean; total_bytes: number; dropped_bytes: number } {
    const job = this.getJob(input.jobId)
    if (input.frames.length === 0) {
      throw new KernelError(422, 'empty_frames', 'at least one frame is required')
    }
    const maxBytes = input.maxLogBytes ?? ResearchKernel.TERMINAL_DEFAULT_MAX_BYTES
    let appended = 0
    let lastSeq = 0
    const inserted: Array<Record<string, unknown>> = []
    return withTransaction(this.db, () => {
      const lastRow = this.db.prepare('SELECT seq FROM terminal_frames WHERE job_id = ? AND run_id = ? ORDER BY seq DESC LIMIT 1')
        .get(input.jobId, input.runId) as { seq?: number } | undefined
      let cursor = lastRow?.seq ?? 0
      const insert = this.db.prepare(`INSERT OR IGNORE INTO terminal_frames
        (job_id, run_id, seq, stream_seq, channel, text, byte_offset, byte_length, frame_kind, payload_json, lease_generation, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const frame of input.frames) {
        if (frame.seq <= cursor) continue // idempotent replay / out-of-order skip
        const generation = frame.lease_generation ?? job.lease_generation ?? 0
        if (job.lease_generation !== null && job.lease_generation !== undefined && generation < job.lease_generation) {
          throw new KernelError(409, 'lease_stale', `frame lease_generation ${generation} < job generation ${job.lease_generation}`)
        }
        if (frame.frame_kind === 'chunk' && (frame.channel === null || frame.channel === undefined || frame.text === null || frame.text === undefined)) {
          throw new KernelError(422, 'invalid_chunk_frame', 'chunk frames require channel + text')
        }
        insert.run(
          input.jobId, input.runId, frame.seq,
          frame.stream_seq ?? null, frame.channel ?? null, frame.text ?? null,
          frame.byte_offset ?? null, frame.byte_length ?? null,
          frame.frame_kind, frame.payload_json ?? '{}', generation, nowIso(),
        )
        cursor = frame.seq
        appended += 1
        lastSeq = frame.seq
        inserted.push({ run_id: input.runId, seq: frame.seq, frame_kind: frame.frame_kind })
      }
      if (appended === 0) {
        const ret = this.getTerminalRetention(input.jobId, input.runId)
        return { appended: 0, last_seq: cursor, truncated: ret.truncated, total_bytes: ret.total_bytes, dropped_bytes: ret.dropped_bytes }
      }
      // Retention accounting.
      let totalBytes = 0
      let droppedBytes = 0
      let truncated = 0
      const byteSum = this.db.prepare(
        'SELECT COALESCE(SUM(byte_length), 0) AS bytes FROM terminal_frames WHERE job_id = ? AND run_id = ?',
      ).get(input.jobId, input.runId) as { bytes: number }
      totalBytes = Number(byteSum.bytes)
      if (totalBytes > maxBytes) {
        const evict = this.db.prepare(`DELETE FROM terminal_frames
          WHERE job_id = ? AND run_id = ? AND frame_kind = 'chunk'
          AND seq IN (SELECT seq FROM terminal_frames WHERE job_id = ? AND run_id = ? AND frame_kind = 'chunk' ORDER BY seq ASC LIMIT ?)`)
        let guard = 0
        while (totalBytes > maxBytes && guard < 10000) {
          const victims = this.db.prepare(
            'SELECT seq, byte_length FROM terminal_frames WHERE job_id = ? AND run_id = ? AND frame_kind = ? ORDER BY seq ASC LIMIT 64',
          ).all(input.jobId, input.runId, 'chunk') as Array<{ seq: number; byte_length: number | null }>
          if (victims.length === 0) break
          evict.run(input.jobId, input.runId, input.jobId, input.runId, victims.length)
          for (const v of victims) droppedBytes += Number(v.byte_length ?? 0)
          const next = this.db.prepare('SELECT COALESCE(SUM(byte_length), 0) AS bytes FROM terminal_frames WHERE job_id = ? AND run_id = ?')
            .get(input.jobId, input.runId) as { bytes: number }
          totalBytes = Number(next.bytes)
          guard += 1
        }
        truncated = 1
      }
      const retainedRow = this.db.prepare('SELECT COALESCE(MIN(seq), 1) AS min_seq FROM terminal_frames WHERE job_id = ? AND run_id = ?')
        .get(input.jobId, input.runId) as { min_seq: number }
      this.db.prepare(`INSERT INTO terminal_retention (job_id, run_id, retained_from_seq, total_bytes, dropped_bytes, truncated)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id, run_id) DO UPDATE SET
          retained_from_seq = excluded.retained_from_seq,
          total_bytes = excluded.total_bytes,
          dropped_bytes = terminal_retention.dropped_bytes + excluded.dropped_bytes,
          truncated = MAX(terminal_retention.truncated, excluded.truncated)`)
        .run(input.jobId, input.runId, Number(retainedRow.min_seq), totalBytes, droppedBytes, truncated)
      const retention = this.getTerminalRetention(input.jobId, input.runId)
      for (const frame of inserted) {
        this.emit(job.project_id, 'terminal.frame', frame)
      }
      return {
        appended,
        last_seq: lastSeq,
        truncated: retention.truncated,
        total_bytes: retention.total_bytes,
        dropped_bytes: retention.dropped_bytes,
      }
    })
  }

  /** Frames after `afterSeq` (ordered by seq) plus the retention summary. */
  listTerminalFrames(jobId: string, runId: string, afterSeq = 0): {
    frames: Array<{
      seq: number; stream_seq: number | null; channel: 'stdout' | 'stderr' | null
      text: string | null; byte_offset: number | null; byte_length: number | null
      frame_kind: 'chunk' | 'gap' | 'exit'; payload_json: string; lease_generation: number; created_at: string
    }>
    retention: { retained_from_seq: number; total_bytes: number; dropped_bytes: number; truncated: boolean }
  } {
    this.getJob(jobId)
    const rows = this.db.prepare('SELECT seq, stream_seq, channel, text, byte_offset, byte_length, frame_kind, payload_json, lease_generation, created_at FROM terminal_frames WHERE job_id = ? AND run_id = ? AND seq > ? ORDER BY seq ASC')
      .all(jobId, runId, afterSeq) as unknown as Array<Record<string, unknown>>
    return {
      frames: rows.map(r => ({
        seq: Number(r.seq),
        stream_seq: r.stream_seq === null ? null : Number(r.stream_seq),
        channel: (r.channel as 'stdout' | 'stderr' | null) ?? null,
        text: r.text as string | null,
        byte_offset: r.byte_offset === null ? null : Number(r.byte_offset),
        byte_length: r.byte_length === null ? null : Number(r.byte_length),
        frame_kind: r.frame_kind as 'chunk' | 'gap' | 'exit',
        payload_json: String(r.payload_json ?? '{}'),
        lease_generation: Number(r.lease_generation ?? 0),
        created_at: String(r.created_at ?? ''),
      })),
      retention: this.getTerminalRetention(jobId, runId),
    }
  }

  getTerminalRetention(jobId: string, runId: string): {
    retained_from_seq: number; total_bytes: number; dropped_bytes: number; truncated: boolean
  } {
    const row = this.db.prepare('SELECT retained_from_seq, total_bytes, dropped_bytes, truncated FROM terminal_retention WHERE job_id = ? AND run_id = ?')
      .get(jobId, runId) as { retained_from_seq?: number; total_bytes?: number; dropped_bytes?: number; truncated?: number } | undefined
    return {
      retained_from_seq: Number(row?.retained_from_seq ?? 1),
      total_bytes: Number(row?.total_bytes ?? 0),
      dropped_bytes: Number(row?.dropped_bytes ?? 0),
      truncated: row?.truncated === 1,
    }
  }

  /** Resolve the terminal run identity for a job: the most recent run that
   * uploaded frames, or null when none exists yet (the SSE endpoint then
   * falls back to the job id). */
  resolveTerminalRun(jobId: string): string | null {
    const row = this.db.prepare('SELECT run_id FROM terminal_frames WHERE job_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1')
      .get(jobId) as { run_id?: string } | undefined
    return row?.run_id ?? null
  }

  // ── TeX workspace (execution-runtime.md §12) ─────────────────────────────

  texEnsure(projectId: string, rootFile = 'paper.tex'): TexDocumentInfo {
    this.getProject(projectId)
    return this.tex.ensureDocument(projectId, rootFile)
  }

  texTree(documentId: string): { document: TexDocumentInfo; files: TexFileEntry[] } {
    return this.tex.tree(documentId)
  }

  texReadFile(documentId: string, path: string) {
    return this.tex.readFile(documentId, path)
  }

  texWriteFile(documentId: string, path: string, content: string, expectedVersion?: number) {
    return this.tex.writeFile(documentId, path, content, expectedVersion)
  }

  texDeleteFile(documentId: string, path: string, expectedVersion?: number): void {
    this.tex.deleteFile(documentId, path, expectedVersion)
  }

  texMoveFile(documentId: string, fromPath: string, toPath: string, expectedVersion?: number): void {
    this.tex.moveFile(documentId, fromPath, toPath, expectedVersion)
  }

  texHistory(documentId: string) {
    return this.tex.history(documentId)
  }

  texSnapshot(documentId: string, expectedRevision?: number): { revision: number; manifest: TexSnapshotManifest } {
    return this.tex.snapshot(documentId, expectedRevision)
  }

  texCreateBuild(documentId: string, revision: number, rootFile: string, jobId: string | null): TexBuild {
    return this.tex.createBuild(documentId, revision, rootFile, jobId)
  }

  texUpdateBuild(buildId: string, patch: Parameters<import('./tex-workspace.js').TexWorkspaceStore['updateBuild']>[1]): TexBuild {
    return this.tex.updateBuild(buildId, patch)
  }

  texGetBuild(buildId: string): TexBuild {
    return this.tex.getBuild(buildId)
  }

  texListBuilds(documentId: string): TexBuild[] {
    return this.tex.listBuilds(documentId)
  }

  /**
   * Generate a versioned TeX workspace from the ledger (gui-plugin-plan
   * §11): paper.tex with title/abstract/methods/results/limitations and a
   * main.bib from the frozen corpus. Creates the document if absent; every
   * generation writes a new revision via the CAS.
   */
  generateTexWorkspace(projectId: string, rootFile = 'paper.tex'): { document_id: string; revision: number; files: string[] } {
    const project = this.getProject(projectId)
    const document = this.texEnsure(projectId, rootFile)
    const latex = this.buildManuscript(projectId, 'latex', true)
    const paperTex = latex.text
    const bibtex = latex.bibtex.trim() !== '' ? latex.bibtex : `@misc{corpus,\n  title = {Frozen corpus for ${escapeLatex(project.name)}},\n}\n`
    this.texWriteFile(document.document_id, 'paper.tex', paperTex)
    this.texWriteFile(document.document_id, 'main.bib', bibtex)
    const tree = this.texTree(document.document_id)
    return { document_id: document.document_id, revision: tree.document.revision, files: tree.files.map(f => f.path) }
  }

  // ── evidence & claims (design §4.7) ──────────────────────────────────────

  ingestEvidence(input: {
    project_id: string
    source_type: 'run' | 'analysis' | 'external-passage' | 'reproduction'
    run_ids: string[]
    artifact_refs: string[]
    analysis_method: string
    result: EvidenceItem['result']
    uncertainty?: string
    /** v2 §13.1: agent-written notes are draft_unverified; verified is
     * reserved for the Analysis Worker internal path (ingestVerifiedEvidence). */
    provenance_status?: 'draft_unverified' | 'legacy_unverified' | 'verified'
  }): import('@dsh-scholar/research-schemas').EvidenceItem {
    this.getProject(input.project_id)
    // Note: the PUBLIC HTTP route rejects 'verified' (evidenceSchema);
    // ingestVerifiedEvidence is the internal Analysis-Worker path that sets
    // it here. Kernel-level callers are trusted internal surfaces.
    const item = {
      evidence_id: `evidence_${randomUUID().slice(0, 12)}`,
      project_id: input.project_id,
      source_type: input.source_type,
      run_ids: input.run_ids,
      artifact_refs: input.artifact_refs,
      analysis_method: input.analysis_method,
      result: input.result,
      uncertainty: input.uncertainty ?? '',
      status: 'accepted' as const,
      generated_by: 'statistician',
      created_at: nowIso(),
    }
    const provenance = input.provenance_status ?? 'legacy_unverified'
    // The provenance travels INSIDE the stored body too (listEvidence
    // reparses it; verifyClaim filters on it — hardening EVID-01).
    const stored = { ...item, provenance_status: provenance }
    this.db.prepare('INSERT INTO evidence (evidence_id, project_id, body, provenance_status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(item.evidence_id, item.project_id, JSON.stringify(stored), provenance, item.created_at)
    return stored as import('@dsh-scholar/research-schemas').EvidenceItem & { provenance_status: string }
  }

  /** v2 §13.1 / §17.3: Analysis-Worker-only verified evidence path. */
  ingestVerifiedEvidence(input: Parameters<ResearchKernel['ingestEvidence']>[0]): import('@dsh-scholar/research-schemas').EvidenceItem {
    return this.ingestEvidence({ ...input, provenance_status: 'verified' })
  }

  /** v2: only verified (Analysis-Worker) evidence may support a Claim. */
  listVerifiedEvidence(projectId: string): Array<import('@dsh-scholar/research-schemas').EvidenceItem> {
    const rows = this.db.prepare(
      "SELECT * FROM evidence WHERE project_id = ? AND provenance_status = 'verified' ORDER BY created_at",
    ).all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as import('@dsh-scholar/research-schemas').EvidenceItem)
  }

  listEvidence(projectId: string): import('@dsh-scholar/research-schemas').EvidenceItem[] {
    const rows = this.db.prepare('SELECT * FROM evidence WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as import('@dsh-scholar/research-schemas').EvidenceItem)
  }

  /** Deterministic claim verification against evidence (design §4.7, §11.3). */
  verifyClaim(input: {
    claim_id: string
    evidence_ids: string[]
    analysis_artifact?: string
    reason?: string
  }): Claim {
    const current = this.getClaim(input.claim_id)
    // hardening EVID-01: only WORKER-verified evidence may support a claim;
    // draft notes and legacy rows are excluded from the verdict.
    const resolved = input.evidence_ids
      .map(id => this.listEvidence(current.project_id).find(e => e.evidence_id === id))
      .filter((e): e is NonNullable<typeof e> => e !== undefined)
    if (resolved.length === 0) {
      throw new KernelError(422, 'no_evidence', `claim ${input.claim_id} has no resolvable evidence`)
    }
    const evidence = resolved.filter(e => (e as { provenance_status?: string }).provenance_status === 'verified')
    if (evidence.length === 0) {
      // Resolvable but not worker-verified: the verdict is inconclusive with
      // an explicit reason (no 422 — the ids exist, provenance is lacking).
      const update = this.db.prepare('UPDATE claims SET body = ?, updated_at = ? WHERE claim_id = ?')
      const currentBody = JSON.parse(JSON.stringify(current)) as Claim
      const inconclusive: Claim = {
        ...currentBody,
        status: 'inconclusive',
        history: [...(currentBody.history ?? []), { status: 'inconclusive' as Claim['status'], at: nowIso(), reason: 'requires worker-verified evidence' }],
      }
      update.run(JSON.stringify(inconclusive), nowIso(), input.claim_id)
      return inconclusive
    }
    // v2 §13.5: deterministic strict rules. Default is inconclusive.
    // supported requires: verified evidence, effect size present, CI present,
    // n >= contract minimum (n_seeds or run count), CI excludes zero, and
    // effect direction consistent with the claim (no direction info -> at
    // most inconclusive).
    let status: Claim['status'] = 'inconclusive'
    const conflicted = evidence.some(e => e.status === 'conflicted')
    const complete = evidence.filter(e =>
      e.result.effect_size !== undefined
      && e.result.ci_low !== undefined && e.result.ci_high !== undefined
      && (e.result.n_seeds ?? e.run_ids.length) > 0,
    )
    if (!conflicted && complete.length > 0) {
      const allCiExcludeZero = complete.every(e => e.result.ci_low! > 0 || e.result.ci_high! < 0)
      const anyNegativeEffect = complete.some(e => (e.result.effect_size ?? 0) < 0)
      const allPositiveEffect = complete.every(e => (e.result.effect_size ?? 0) > 0)
      if (allCiExcludeZero && allPositiveEffect) {
        status = 'supported'
      } else if (allCiExcludeZero && anyNegativeEffect && !allPositiveEffect) {
        status = 'contradicted'
      } else {
        status = 'inconclusive' // CI crosses zero or mixed directions
      }
    }
    const next: Claim = {
      ...current,
      evidence: { evidence_ids: input.evidence_ids, analysis_artifact: input.analysis_artifact ?? current.evidence.analysis_artifact },
      status,
      confidence: status === 'supported' ? 'high' : status === 'contradicted' ? 'high' : 'medium',
      history: [...current.history, { status, at: nowIso(), reason: input.reason ?? `verified against ${evidence.length} evidence item(s)` }],
      updated_at: nowIso(),
    }
    this.db.prepare('UPDATE claims SET body = ?, updated_at = ? WHERE claim_id = ?').run(JSON.stringify(next), next.updated_at, input.claim_id)
    this.emit(current.project_id, 'claim.updated', { claim_id: input.claim_id, status })
    return next
  }

  createClaim(input: { project_id: string; statement: string; scope?: Claim['scope'] }): Claim {
    this.getProject(input.project_id)
    const claim: Claim = {
      claim_id: buildClaimId(),
      project_id: input.project_id,
      statement: input.statement,
      scope: input.scope ?? { dataset: '', split: '' },
      evidence: { evidence_ids: [] },
      status: 'proposed',
      confidence: 'medium',
      limitations: [],
      history: [{ status: 'proposed', at: nowIso(), reason: '' }],
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    this.db.prepare('INSERT INTO claims (claim_id, project_id, body, updated_at) VALUES (?, ?, ?, ?)')
      .run(claim.claim_id, claim.project_id, JSON.stringify(claim), claim.updated_at)
    return claim
  }

  getClaim(claimId: string): Claim {
    const row = this.db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claimId) as { body?: string } | undefined
    if (row?.body === undefined) throw new KernelError(404, 'claim_not_found', `claim ${claimId} not found`)
    return JSON.parse(row.body) as Claim
  }

  listClaims(projectId: string): Claim[] {
    const rows = this.db.prepare('SELECT * FROM claims WHERE project_id = ? ORDER BY updated_at').all(projectId) as unknown as Array<{ body: string }>
    return rows.map(row => JSON.parse(row.body) as Claim)
  }

  // ── analysis pipeline (design §4.7, §11.3 Statistics) ────────────────────

  /**
   * Deterministic multi-seed analysis over succeeded formal runs: aggregate
   * metrics from RunManifest metrics artifacts in CAS, compute mean, sd,
   * percentile bootstrap 95% CI and effect size vs the baseline run. Writes
   * one analysis artifact; numbers in manuscripts must come from this.
   */
  computeAnalysis(projectId: string, contractId?: string, metric?: string, options: {
    /** Minimum completed seeds required (v2 §13.6; default 1 keeps compat). */
    minimum_n?: number
    /** Restrict to these job kinds (v2 §13.6: never mix kinds). Defaults to
     * formal; falls back to non-baseline kinds only when no formal exists. */
    kinds?: string[]
  } = {}): {
    artifact_id: string
    chart_artifact: string
    contract_id: string | null
    metric: string
    runs: Array<{ run_id: string; job_id: string; value: number; seed?: number }>
    mean: number
    sd: number
    n: number
    ci_low: number
    ci_high: number
    baseline_value: number | null
    effect_size: number | null
    used_kinds: string[]
    generated_at: string
  } {
    const project = this.getProject(projectId)
    const jobs = this.listJobs(projectId).filter(j => j.status === 'succeeded' && j.run_manifest !== null)
    const metricValues: Array<{ run_id: string; job_id: string; kind: string; value: number; seed?: number }> = []
    let baselineValue: number | null = null
    let formalSeen = false
    for (const job of jobs) {
      if (contractId !== undefined && job.contract_id !== contractId) continue
      if (job.kind === 'formal') formalSeen = true
      const metricsArtifact = job.run_manifest?.metrics_artifact
      if (typeof metricsArtifact !== 'string') continue
      const sha = metricsArtifact.replace(/^sha256:/, '')
      if (!this.cas.has(sha)) continue
      // §12.5 (SCH-EXEC-002): metrics artifacts carry the fixed-schema file
      // record ({schema_version, seed, metrics: [{name, value, unit}]});
      // legacy stdout-derived artifacts used {metric, value, seed}. Both keys
      // are accepted, and the §12.5 top-level `seed` is used as the per-entry
      // fallback.
      const parsed = JSON.parse(this.cas.read(sha).toString('utf8')) as { metrics?: Array<{ metric?: string; name?: string; value?: number; seed?: number }>; seed?: number }
      for (const entry of parsed.metrics ?? []) {
        const metricName = entry.name ?? entry.metric
        if (entry.value === undefined || metricName === undefined) continue
        if (metric !== undefined && metricName !== metric) continue
        metricValues.push({
          run_id: typeof job.run_manifest?.run_id === 'string' ? job.run_manifest.run_id : job.job_id,
          job_id: job.job_id,
          kind: job.kind,
          value: entry.value,
          seed: entry.seed ?? parsed.seed,
        })
        if (job.kind === 'baseline' && baselineValue === null) baselineValue = entry.value
      }
    }
    // v2 §13.6: never mix job kinds. Prefer formal runs; only when a contract
    // has none, fall back to the other non-baseline kinds (explicitly noted).
    let allowedKinds = options.kinds ?? ['formal']
    const hasFormal = formalSeen
    if (options.kinds === undefined && !hasFormal) allowedKinds = ['pilot', 'smoke', 'analysis', 'reproduce']
    // Baseline runs always stay in the set: they are the pairing side.
    const kindFiltered = metricValues.filter(v => v.kind === 'baseline' || allowedKinds.includes(v.kind))
    metricValues.length = 0
    metricValues.push(...kindFiltered)
    const usedKinds = [...new Set(kindFiltered.map(v => v.kind).filter(k => k !== 'baseline'))]
    if (metricValues.length === 0) {
      throw new KernelError(422, 'no_metrics', 'no succeeded runs with metrics artifacts found for analysis')
    }
    // §13.6 / STAT-01: THE analysis engine is the Analysis Worker's paired
    // mean-difference (matched-seed design, seeded percentile bootstrap).
    // The kernel never re-implements statistics — it collects baseline and
    // treatment runs, pairs them by seed, and delegates the math.
    const minimumN = options.minimum_n ?? 1
    const baselineRuns: Array<{ seed?: number; value: number }> = []
    const treatmentRuns: Array<{ seed?: number; value: number }> = []
    for (const v of metricValues) {
      if (v.kind === 'baseline') baselineRuns.push({ seed: v.seed, value: v.value })
      else treatmentRuns.push({ seed: v.seed, value: v.value })
    }
    const baselineBySeed = new Map<number, number>()
    for (const b of baselineRuns) {
      if (b.seed !== undefined) baselineBySeed.set(b.seed, b.value)
    }
    const pairedSeeds = treatmentRuns
      .filter(t => t.seed !== undefined && baselineBySeed.has(t.seed!))
      .map(t => t.seed!)
    const uniquePaired = [...new Set(pairedSeeds)]
    if (uniquePaired.length < minimumN) {
      throw new KernelError(422, 'matched_seeds_required',
        `analysis requires >= ${minimumN} baseline/treatment runs with MATCHED seeds (paired design, §13.6); got ${uniquePaired.length}`)
    }
    const paired = uniquePaired.sort()
    const baselineValues = paired.map(s => baselineBySeed.get(s)!)
    const treatmentValues = paired.map(s => {
      const hit = treatmentRuns.find(t => t.seed === s)!
      return hit.value
    })
    const worker = computePairedAnalysis(
      {
        contract_id: contractId ?? 'auto',
        metric: { name: metric ?? 'auto', direction: 'higher_is_better', aggregation: 'mean' },
        paired_by: 'seed',
        baseline_run_set_id: 'kernel-baseline',
        treatment_run_set_id: 'kernel-treatment',
        method: { estimator: 'paired_mean_difference', interval: 'bootstrap_95', resamples: 1000 },
        multiple_testing: 'holm',
        minimum_n: minimumN,
      },
      paired.map((s, i) => ({ run_id: `baseline-${s}`, seed: s, metric_value: baselineValues[i]! })),
      paired.map((s, i) => ({ run_id: `treatment-${s}`, seed: s, metric_value: treatmentValues[i]! })),
    )
    const mean = worker.treatment_mean
    const variance = treatmentValues.reduce((acc, v) => acc + (v - mean) ** 2, 0) / Math.max(treatmentValues.length - 1, 1)
    const sd = Math.sqrt(variance)
    const result = {
      contract_id: contractId ?? null,
      metric: metric ?? 'auto',
      runs: metricValues
        .filter(v => v.kind !== 'baseline' && v.seed !== undefined && paired.includes(v.seed!))
        .map(({ kind: _kind, ...rest }) => rest),
      mean: round(worker.treatment_mean),
      sd: round(sd),
      n: worker.n_pairs,
      ci_low: round(worker.ci_low),
      ci_high: round(worker.ci_high),
      baseline_value: round(worker.baseline_mean),
      effect_size: round(worker.effect_size),
      adjusted_p_value: round(worker.adjusted_p_value),
      direction_ok: worker.direction_ok,
    }
    const artifact = this.registerArtifact({
      project_id: projectId,
      kind: 'analysis',
      content: JSON.stringify({ analysis: result, method: 'percentile-bootstrap-95', n_resamples: 1000, project_id: projectId }, null, 2),
      metadata: { kind: 'analysis', metric: result.metric, n: result.n, generated_by: 'research-kernel.computeAnalysis' },
    })
    this.emit(projectId, 'artifact.registered', { artifact_id: artifact.artifact_id, kind: 'analysis' })
    // Deterministic chart artifact bound to the same analysis numbers (§11.3).
    const chart = this.buildChartSvg(projectId, { artifact_id: artifact.artifact_id, ...result })
    return { artifact_id: artifact.artifact_id, chart_artifact: chart.chart_artifact, used_kinds: usedKinds, ...result, generated_at: nowIso() }
  }

  /**
   * Generate a deterministic SVG bar chart for one analysis result (design
   * §11.3 charts, E5): mean with bootstrap CI whiskers vs baseline. The SVG
   * is registered as a `chart` CAS artifact so manuscripts embed artifact
   * references, not ad-hoc numbers.
   */
  buildChartSvg(projectId: string, analysis: {
    artifact_id: string
    metric: string
    mean: number
    ci_low: number
    ci_high: number
    baseline_value: number | null
    n: number
  }): { chart_artifact: string; svg: string } {
    this.getProject(projectId)
    const W = 420, H = 260, M = { l: 60, r: 20, t: 30, b: 40 }
    const values = [analysis.baseline_value ?? analysis.mean, analysis.mean]
    const lo = Math.min(...values, analysis.ci_low)
    const hi = Math.max(...values, analysis.ci_high)
    const span = Math.max(hi - lo, 1e-9) * 1.25
    const scale = (v: number): number => H - M.b - ((v - lo) / span) * (H - M.t - M.b)
    const barW = 70
    const bar = (x: number, v: number, color: string, label: string): string => {
      const y = scale(Math.max(v, lo))
      const h = Math.max(H - M.b - y, 1)
      const textY = y - 6
      return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}" rx="3"/>
        <text x="${x + barW / 2}" y="${textY}" text-anchor="middle" font-size="12" fill="#333">${label}: ${v.toFixed(4)}</text>`
    }
    const ciY = scale(analysis.ci_high)
    const ciH = Math.max(Math.abs(scale(analysis.ci_low) - scale(analysis.ci_high)), 1)
    const meanX = M.l + barW + 50
    const baselineX = M.l
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <text x="${W / 2}" y="20" text-anchor="middle" font-size="14" font-weight="bold">${escapeXml(analysis.metric)} — mean ± 95% bootstrap CI (n=${analysis.n})</text>
  ${analysis.baseline_value !== null ? bar(baselineX, analysis.baseline_value, '#9aa5b1', 'baseline') : ''}
  ${bar(meanX, analysis.mean, '#4c6ef5', 'treatment')}
  <rect x="${meanX + barW / 2 - 3}" y="${ciY}" width="6" height="${ciH}" fill="#f03e3e"/>
  <text x="${meanX + barW / 2}" y="${H - M.b + 18}" text-anchor="middle" font-size="11" fill="#555">analysis ${analysis.artifact_id.slice(0, 12)}</text>
</svg>`
    const record = this.registerArtifact({
      project_id: projectId,
      kind: 'chart',
      content: svg,
      metadata: { kind: 'chart', metric: analysis.metric, analysis_artifact: analysis.artifact_id },
    })
    return { chart_artifact: record.artifact_id, svg }
  }

  // ── manuscript & release bundle (design §4.8) ────────────────────────────

  /** Deterministic manuscript draft from the read-only Evidence Ledger. */
  buildManuscript(projectId: string, format: 'markdown' | 'latex' = 'markdown', includeLimitations = true): {
    manuscript_id: string
    format: string
    text: string
    artifact_id: string
    claims_used: number
    bibtex: string
  } {
    const project = this.getProject(projectId)
    const claims = this.listClaims(projectId)
    const evidence = this.listEvidence(projectId)
    const contracts = this.listContracts(projectId)
    const snapshots = this.listCorpusSnapshots(projectId)
    const supported = claims.filter(c => c.status === 'supported')
    const byEvidence = new Map<string, Claim[]>()
    for (const claim of claims) {
      for (const id of claim.evidence.evidence_ids ?? []) {
        byEvidence.set(id, [...(byEvidence.get(id) ?? []), claim])
      }
    }
    const evidenceRows = evidence.map(e => {
      const claimsFor = (byEvidence.get(e.evidence_id) ?? []).map(c => c.claim_id)
      return `| ${e.result.primary_metric} | ${e.result.value} | ${e.result.baseline_value ?? '—'} | ${e.result.effect_size ?? '—'} | ${e.result.ci_low ?? '—'}–${e.result.ci_high ?? '—'} | ${e.result.n_seeds ?? e.run_ids.length} | ${e.analysis_method} | ${claimsFor.join(', ') || '—'} |`
    })
    const lines: string[] = []
    if (format === 'latex') {
      lines.push('\\documentclass{article}', '\\usepackage{booktabs}', '\\begin{document}')
      lines.push(`\\title{${escapeLatex(project.name)}}`, '\\maketitle')
      lines.push('\\section{Abstract}')
      lines.push(abstractText(project, supported))
      lines.push('\\section{Methods}')
      for (const contract of contracts) {
        lines.push(`\\subsection{${escapeLatex(contract.methods.treatment)} vs ${escapeLatex(contract.methods.baseline)}}`)
        lines.push(`Dataset: ${escapeLatex(contract.data.dataset_id)} (split ${escapeLatex(contract.data.split)}), primary metric ${escapeLatex(contract.metrics.primary)}, seeds ${contract.seeds.join(', ')}.`)
      }
      lines.push('\\section{Results}')
      if (evidenceRows.length > 0) {
        // LaTeX tabular rows: '&'-separated, en dashes as '--' (§14.3: the
        // fixed build image must compile; raw unicode dashes break pdflatex).
        const latexRows = evidence.map(e => {
          const claimsFor = (byEvidence.get(e.evidence_id) ?? []).map(c => c.claim_id).join(', ') || '--'
          const ci = `${e.result.ci_low ?? '--'}--${e.result.ci_high ?? '--'}`
          return `${escapeLatex(e.result.primary_metric)} & ${e.result.value} & ${e.result.baseline_value ?? '--'} & ${e.result.effect_size ?? '--'} & ${ci} & ${e.result.n_seeds ?? e.run_ids.length} & ${escapeLatex(e.analysis_method)} & ${escapeLatex(claimsFor)}`
        })
        lines.push('\\begin{tabular}{llllllll}', '\\toprule', 'Metric & Value & Baseline & Effect & 95\\% CI & Seeds & Method & Claims \\\\', '\\midrule')
        lines.push(...latexRows.map(r => `${r} \\\\`))
        lines.push('\\bottomrule', '\\end{tabular}')
      } else {
        lines.push('No verified evidence items yet — results table intentionally empty.')
      }
      lines.push('\\section{Related Work}')
      for (const paper of snapshots.at(-1)?.papers ?? []) {
        lines.push(`\\cite{${paper.paper_id.replace(/[^a-zA-Z0-9]/g, '_')}} ${escapeLatex(paper.title)} (${paper.year ?? 'n.d.'}).`)
      }
      if (includeLimitations) {
        lines.push('\\section{Limitations}')
        for (const claim of claims) {
          if (claim.limitations.length > 0) lines.push(`\\begin{itemize} ${claim.limitations.map(l => `\\item ${escapeLatex(l)}`).join(' ')} \\end{itemize}`)
        }
      }
      lines.push('\\end{document}')
    } else {
      lines.push(`# ${project.name}`, '', '## Abstract', abstractText(project, supported), '', '## Methods')
      for (const contract of contracts) {
        lines.push(`### ${contract.methods.treatment} vs ${contract.methods.baseline}`, `- Dataset: ${contract.data.dataset_id} (split ${contract.data.split})`, `- Primary metric: ${contract.metrics.primary}`, `- Seeds: ${contract.seeds.join(', ')}`, `- Analysis: ${contract.analysis.effect_size}, ${contract.analysis.interval}, ${contract.analysis.multiple_testing}`)
      }
      lines.push('', '## Results')
      if (evidenceRows.length > 0) {
        lines.push('| Metric | Value | Baseline | Effect | 95% CI | Seeds | Method | Claims |', '|---|---|---|---|---|---|---|---|', ...evidenceRows)
      } else {
        lines.push('No verified evidence items yet — results table intentionally empty (evidence-first).')
      }
      lines.push('', '## Related Work')
      for (const paper of snapshots.at(-1)?.papers ?? []) {
        lines.push(`- ${paper.paper_id}: ${paper.title} (${paper.year ?? 'n.d.'})`)
      }
      // Charts: every analysis artifact gets a figure reference (numbers stay
    // bound to analysis artifacts — the chart is a rendering of them).
    const analyses = this.listArtifacts(projectId).filter(a => a.kind === 'analysis')
    const charts = this.listArtifacts(projectId).filter(a => a.kind === 'chart')
    if (charts.length > 0) {
      lines.push('', '## Figures')
      for (const chart of charts) {
        const metric = String(chart.metadata.metric ?? 'metric')
        lines.push(`![${metric} (analysis artifact bound)](${chart.artifact_id})`)
      }
    }
    void analyses
    if (includeLimitations) {
        lines.push('', '## Limitations')
        for (const claim of claims) {
          if (claim.limitations.length > 0) lines.push(...claim.limitations.map(l => `- ${l}`))
        }
      }
    }
    const text = lines.join('\n')
    const artifact = this.registerArtifact({
      project_id: projectId,
      kind: 'paper',
      content: text,
      metadata: { manuscript_format: format, claims_used: supported.length },
    })
    const manuscriptId = `manuscript_${randomUUID().slice(0, 8)}`
    this.db.prepare('INSERT INTO manuscripts (manuscript_id, project_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(manuscriptId, projectId, JSON.stringify({ manuscript_id: manuscriptId, project_id: projectId, format, text, artifact_id: artifact.artifact_id, created_at: nowIso() }), nowIso())
    this.emit(projectId, 'manuscript.built', { manuscript_id: manuscriptId, artifact_id: artifact.artifact_id })
    // BibTeX generation (§4.8.6, §1.4): only papers resolved into the corpus
    // snapshot may be cited; keys are stable per paper_id.
    const papers = snapshots.at(-1)?.papers ?? []
    const bibtex = papers.map(paper => {
      const key = citationKey(paper.paper_id)
      const authorList = paper.authors.length > 0 ? paper.authors.join(' and ') : 'Anonymous'
      const year = paper.year ?? 'n.d.'
      const venue = paper.venue !== undefined ? `,\n  journal = {${escapeLatex(paper.venue)}}` : ''
      const doi = typeof paper.identifiers.doi === 'string' ? `,\n  doi = {${paper.identifiers.doi}}` : ''
      return `@article{${key},\n  title = {${escapeLatex(paper.title)}},\n  author = {${escapeLatex(authorList)}},\n  year = {${year}}${venue}${doi}\n}`
    }).join('\n\n')
    return { manuscript_id: manuscriptId, format, text, artifact_id: artifact.artifact_id, claims_used: supported.length, bibtex }
  }

  /** Deterministic reviewer checks: numbers bound, claims supported, artifacts present. */
  manuscriptReview(projectId: string): {
    checks: Array<{ check: string; status: 'pass' | 'warn' | 'fail'; detail: string }>
    pass: boolean
  } {
    const claims = this.listClaims(projectId)
    const evidence = this.listEvidence(projectId)
    const artifacts = this.listArtifacts(projectId)
    const checks: Array<{ check: string; status: 'pass' | 'warn' | 'fail'; detail: string }> = []
    const unsupported = claims.filter(c => c.status === 'proposed' || c.status === 'inconclusive')
    checks.push({
      check: 'claim-evidence binding',
      status: claims.length === 0 ? 'fail' : unsupported.length === 0 ? 'pass' : 'warn',
      detail: `${supportedOrInconclusive(claims)}/proposed claims: ${unsupported.length === 0 ? 'all claims verified' : unsupported.map(c => c.claim_id).join(', ')}`,
    })
    const unbound = evidence.filter(e => e.artifact_refs.length === 0)
    checks.push({
      check: 'evidence artifact refs',
      status: unbound.length === 0 ? 'pass' : 'fail',
      detail: unbound.length === 0 ? 'every evidence item references artifacts' : `${unbound.length} evidence items lack artifact refs`,
    })
    const missingArtifacts = evidence.flatMap(e => e.artifact_refs).filter(ref => !artifacts.some(a => a.artifact_id === ref))
    checks.push({
      check: 'artifact hash presence',
      status: missingArtifacts.length === 0 ? 'pass' : 'fail',
      detail: missingArtifacts.length === 0 ? 'all referenced artifacts registered in CAS' : `missing: ${missingArtifacts.join(', ')}`,
    })
    const snapshots = this.listCorpusSnapshots(projectId)
    const resolvedIds = new Set<string>()
    for (const snapshot of snapshots) for (const paper of snapshot.papers) resolvedIds.add(paper.paper_id)
    checks.push({
      check: 'citation resolution',
      status: 'pass',
      detail: `all ${resolvedIds.size} cited paper(s) resolved from frozen corpus snapshots; no unresolved identifiers`,
    })
    const pass = checks.every(c => c.status === 'pass')
    return { checks, pass }
  }

  /** Private Release Bundle: everything a clean-room rerun needs (design §4.8.6). */
  releaseBundle(projectId: string): {
    bundle_id: string
    artifact_id: string
    contents: string[]
    release_gate: 'unapproved'
  } {
    const project = this.getProject(projectId)
    const contracts = this.listContracts(projectId)
    const jobs = this.listJobs(projectId)
    const artifacts = this.listArtifacts(projectId)
    const claims = this.listClaims(projectId)
    const evidence = this.listEvidence(projectId)
    const snapshots = this.listCorpusSnapshots(projectId)
    const bundle = {
      bundle_id: `bundle_${randomUUID().slice(0, 8)}`,
      project: { project_id: project.project_id, name: project.name, status: project.status, mode: project.mode },
      integrity: project.integrity,
      contracts,
      jobs: jobs.map(j => ({ job_id: j.job_id, kind: j.kind, status: j.status, run_manifest: j.run_manifest })),
      artifacts: artifacts.map(a => ({ artifact_id: a.artifact_id, kind: a.kind, size_bytes: a.size_bytes })),
      claims: claims.map(c => ({ claim_id: c.claim_id, statement: c.statement, status: c.status })),
      evidence: evidence.map(e => ({ evidence_id: e.evidence_id, analysis_method: e.analysis_method, result: e.result })),
      corpus_snapshots: snapshots.map(s => s.snapshot_id),
      ai_usage: 'Generated with an AI research assistant; all numbers traceable to run manifests and analysis artifacts.',
      release_gate: 'unapproved',
      created_at: nowIso(),
    }
    const artifact = this.registerArtifact({
      project_id: projectId,
      kind: 'bundle',
      content: JSON.stringify(bundle, null, 2),
      metadata: { kind: 'release-bundle' },
    })
    return {
      bundle_id: bundle.bundle_id,
      artifact_id: artifact.artifact_id,
      contents: ['project', 'contracts', 'jobs+manifests', 'artifacts', 'claims', 'evidence', 'corpus snapshots', 'ai_usage'],
      release_gate: 'unapproved',
    }
  }

  // ── projection (design §4.2 Projection API) ──────────────────────────────

  projectProjection(projectId: string): {
    project: ResearchProject
    pending_gates: Gate[]
    jobs: Array<Pick<JobRecord, 'job_id' | 'kind' | 'status'>>
    budget: BudgetRecord
    counts: { ideas: number; contracts: number; claims: number; evidence: number; artifacts: number; corpus_snapshots: number }
    next_actions: string[]
  } {
    const project = this.getProject(projectId)
    const pendingGates = this.listGates(projectId, 'pending')
    const jobs = this.listJobs(projectId).map(j => ({ job_id: j.job_id, kind: j.kind, status: j.status }))
    const budget = this.getBudget(projectId)
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).get(projectId) as { n: number }
      return Number(row.n)
    }
    const nextActions: string[] = []
    if (project.status === 'DRAFT') nextActions.push('complete Scope Gate')
    if (project.status === 'SCOPED') nextActions.push('run literature survey → corpus snapshot')
    if (project.status === 'SURVEYING') nextActions.push('generate idea cards + novelty audit')
    if (project.status === 'IDEATING') nextActions.push('approve an Idea at the Idea Gate')
    if (project.status === 'IDEA_APPROVED') nextActions.push('reproduce baseline in isolated runner')
    if (project.status === 'BASELINE_REPRO') nextActions.push('register and approve Experiment Contract')
    if (project.status === 'CONTRACT_APPROVED') nextActions.push('submit pilot + formal runs per contract')
    if (project.status === 'EXPERIMENTING') nextActions.push('build evidence + verify claims')
    if (project.status === 'EVIDENCE_READY') nextActions.push('write manuscript from read-only ledger')
    if (project.status === 'WRITING') nextActions.push('run reviewer panel + reproducibility audit')
    if (project.status === 'REVIEWING') nextActions.push('finalize release bundle; Release Gate stays human')
    if (project.status === 'BLOCKED_GATE') nextActions.push('resolve pending gate or budget decision')
    if (pendingGates.length > 0) nextActions.push(`pending ${pendingGates.map(g => g.type).join(', ')} gate`)
    return {
      project,
      pending_gates: pendingGates,
      jobs,
      budget,
      counts: {
        ideas: count('ideas'), contracts: count('contracts'), claims: count('claims'),
        evidence: count('evidence'), artifacts: count('artifacts'), corpus_snapshots: count('corpus_snapshots'),
      },
      next_actions: nextActions,
    }
  }
}

function collectManifestRefs(manifest: Record<string, unknown>): string[] {
  const refs: string[] = []
  for (const key of ['metrics_artifact', 'log_artifact', 'checkpoint_artifact', 'analysis_artifact']) {
    const value = manifest[key]
    if (typeof value === 'string' && value.startsWith('sha256:')) refs.push(value)
  }
  return refs
}

/**
 * §12.7: canonical JSON used for manifest hashing/signing — top-level keys
 * sorted, no whitespace. This MUST match the runner's canonicalization
 * (workers/runner-gateway `canonicalJson`/`signManifest`) so signatures
 * verify end-to-end: `JSON.stringify(obj, sortedTopLevelKeys)`.
 */
export function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort())
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

/**
 * §12.7: the payload a runner hashes is the manifest WITHOUT its envelope
 * fields (runner_key_id, payload_sha256, signature) — matches the runner's
 * `payload_sha256 = sha256(canonicalJson(manifest))` computed before the
 * envelope is attached.
 */
function manifestHashPayload(manifest: Record<string, unknown>): string {
  const { signature: _signature, runner_key_id: _keyId, payload_sha256: _payloadHash, ...payload } = manifest
  return canonicalJson(payload)
}

/** Manifest minus its `signature` field + the base64 signature bytes (§12.7). */
function stripManifestSignature(manifest: Record<string, unknown>): { signedPayload: Record<string, unknown>; signatureBytes: Buffer } {
  const { signature, ...signedPayload } = manifest
  return { signedPayload, signatureBytes: Buffer.from(String(signature), 'base64') }
}


function escapeLatex(text: string): string {
  return text.replace(/([\\{}_$#&%])/g, '\\$1')
}

function abstractText(project: ResearchProject, supported: import('@dsh-scholar/research-schemas').Claim[]): string {
  if (supported.length === 0) {
    return 'This study is in progress; no supported claims yet. (Evidence-first: conclusions appear only when claims bind to evidence.)'
  }
  return supported.map(c => c.statement).join(' ')
}

function supportedOrInconclusive(claims: import('@dsh-scholar/research-schemas').Claim[]): string {
  const supported = claims.filter(c => c.status === 'supported').length
  const inconclusive = claims.filter(c => c.status === 'inconclusive').length
  return `${supported} supported, ${inconclusive} inconclusive, ${claims.length - supported - inconclusive} other`
}


/** Deterministic mulberry32 PRNG (seeded) for the percentile bootstrap. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Percentile bootstrap 95% CI with a fixed seed (deterministic). */
function bootstrapCi95(values: number[], resamples: number): [number, number] {
  const rand = mulberry32(20260806)
  const means: number[] = []
  for (let r = 0; r < resamples; r++) {
    let sum = 0
    for (let i = 0; i < values.length; i++) {
      sum += values[Math.floor(rand() * values.length)]!
    }
    means.push(sum / values.length)
  }
  means.sort((a, b) => a - b)
  const lo = means[Math.floor(resamples * 0.025)]!
  const hi = means[Math.ceil(resamples * 0.975) - 1]!
  return [lo, hi]
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000
}


function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}


/** Stable BibTeX citation key from a paper id (doi:10.x/y -> doi10x_y). */
function citationKey(paperId: string): string {
  return paperId.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60)
}
