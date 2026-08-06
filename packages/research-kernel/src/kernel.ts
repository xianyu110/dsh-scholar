/**
 * Research Kernel — authoritative research state machine, ledger and durable
 * job store (design §3.2 ADR-002/003, §4.2, §5, §6). All writes go through
 * this class; the HTTP server and DSH plugin are thin adapters.
 * @module @dsh-scholar/research-kernel/kernel
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  ArtifactRecord, BudgetConstraints, BudgetRecord, Claim, CorpusSnapshot, Decision,
  EvidenceItem, ExecutionConfig, ExperimentContract, Gate, IdeaCard, IntegrityConfig,
  JobRecord, KernelEvent, KernelEventKind, Paper, Passage, ResearchProject, ResearchBrief,
  SessionLink, TRANSITION_TABLE, buildClaimId, buildContractId, buildGateId, buildIdeaId,
  buildProjectId, type ArtifactKind, type GateType, type JobStatus, type ProjectStatus,
} from '@dsh-scholar/research-schemas'
import { ArtifactCas } from './cas.js'
import { openDatabase, type EventRow, type GateRow, type JobRow, type ProjectRow } from './store.js'

export interface KernelOptions {
  /** SQLite database path (defaults to `:memory:`). */
  dbPath?: string
  /** CAS root for immutable artifacts. */
  casRoot?: string
  /** Kernel identity used for leases. */
  instanceId?: string
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

function jobFromRow(row: JobRow): JobRecord {
  return {
    job_id: row.job_id,
    project_id: row.project_id,
    contract_id: row.contract_id,
    idempotency_key: row.idempotency_key,
    kind: row.kind as JobRecord['kind'],
    command: jsonParse(row.command, [] as string[]),
    payload: jsonParse(row.payload, {}),
    status: row.status as JobStatus,
    failure_class: row.failure_class as JobRecord['failure_class'],
    lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at,
    heartbeat_at: row.heartbeat_at,
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

export class ResearchKernel {
  readonly db: DatabaseSync
  readonly cas: ArtifactCas
  readonly instanceId: string

  constructor(options: KernelOptions = {}) {
    this.db = openDatabase(options.dbPath ?? ':memory:')
    this.cas = new ArtifactCas(options.casRoot ?? join(process.cwd(), '.research-cas'))
    this.instanceId = options.instanceId ?? `kernel-${randomUUID().slice(0, 8)}`
  }

  close(): void {
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
    ResearchBrief.parse(input.brief)
    const project: ResearchProject = {
      project_id: buildProjectId(),
      name: input.name,
      workspace: input.workspace,
      mode: input.mode ?? 'gate-only',
      status: 'DRAFT',
      revision: 0,
      brief: input.brief,
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
    this.emit(project.project_id, 'project.created', { project_id: project.project_id, name: project.name })
    return project
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

  /** Record a human decision and apply the gate side effect (design §5.2, §6.6). */
  decideGate(input: {
    gate_id: string
    actor: string
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
    const decision: Decision = {
      decision_id: `dec_${randomUUID().replaceAll('-', '')}`,
      gate_id: gate.gate_id,
      project_id: gate.project_id,
      gate_type: gate.type,
      actor: input.actor,
      decision: input.decision,
      reason: input.reason ?? '',
      diff: input.diff ?? '',
      session_id: input.session_id ?? null,
      event_id: input.event_id ?? null,
      decided_at: nowIso(),
    }
    this.db.prepare(
      'INSERT INTO decisions (decision_id, gate_id, project_id, gate_type, actor, decision, reason, diff, session_id, event_id, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(decision.decision_id, decision.gate_id, decision.project_id, decision.gate_type, decision.actor, decision.decision, decision.reason, decision.diff, decision.session_id, decision.event_id, decision.decided_at)
    const gateUpdate = this.db.prepare('UPDATE gates SET status = ?, decided_at = ? WHERE gate_id = ? AND status = ?')
      .run(input.decision, decision.decided_at, gate.gate_id, 'pending')
    if (Number(gateUpdate.changes) !== 1) {
      // Lost the CAS race to a concurrent decision (design §11.2: two browsers
      // deciding the same gate — exactly one wins, the conflict is recorded).
      this.db.prepare('DELETE FROM decisions WHERE decision_id = ?').run(decision.decision_id)
      throw new KernelError(409, 'gate_already_decided', `gate ${input.gate_id} was decided concurrently (CAS race)`)
    }

    let project = this.getProject(gate.project_id)
    const now = nowIso()
    if (input.decision === 'approved') {
      const mapping = GATE_APPROVAL_TRANSITION[gate.type]
      if (gate.type === 'budget') {
        const resumeTo = input.resume_to ?? project.status
        if (project.status === 'BLOCKED_GATE' && resumeTo !== 'BLOCKED_GATE') {
          // Budget gate approval may resume from BLOCKED_GATE to any prior state.
          project = this.forceTransition(project.project_id, resumeTo, `budget gate ${gate.gate_id} approved`)
        }
      } else if (project.status === mapping.from) {
        project = this.forceTransition(project.project_id, mapping.to, `gate ${gate.gate_id} approved`)
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
  }

  listDecisions(projectId: string): Decision[] {
    const rows = this.db.prepare('SELECT * FROM decisions WHERE project_id = ? ORDER BY decided_at').all(projectId) as unknown as Array<Record<string, unknown>>
    return rows.map(row => ({
      decision_id: row.decision_id as string,
      gate_id: row.gate_id as string,
      project_id: row.project_id as string,
      gate_type: row.gate_type as GateType,
      actor: row.actor as string,
      decision: row.decision as Decision['decision'],
      reason: row.reason as string,
      diff: row.diff as string,
      session_id: row.session_id as string | null,
      event_id: row.event_id as string | null,
      decided_at: row.decided_at as string,
    }))
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
        this.db.prepare('UPDATE projects SET status = ?, updated_at = ?, history = ? WHERE project_id = ?')
          .run('BLOCKED_GATE', nowIso(), JSON.stringify([...project.history, `BLOCKED_GATE (budget: ${exceeded.join('; ')})`]), projectId)
      }
    }
    return this.getBudget(projectId)
  }

  // ── artifacts (CAS) ──────────────────────────────────────────────────────

  registerArtifact(input: {
    project_id: string
    kind: ArtifactKind
    content: Uint8Array | string
    metadata?: Record<string, unknown>
  }): ArtifactRecord {
    this.getProject(input.project_id)
    const { sha256, size_bytes } = this.cas.put(input.content)
    const existing = this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(`sha256:${sha256}`) as ArtifactRecord | undefined
    if (existing !== undefined) return existing // content-addressed dedupe (RSP-008)
    const record: ArtifactRecord = {
      artifact_id: `sha256:${sha256}`,
      project_id: input.project_id,
      kind: input.kind,
      size_bytes,
      sha256,
      metadata: input.metadata ?? {},
      created_at: nowIso(),
    }
    this.db.prepare('INSERT INTO artifacts (artifact_id, project_id, kind, size_bytes, sha256, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(record.artifact_id, record.project_id, record.kind, record.size_bytes, record.sha256, JSON.stringify(record.metadata), record.created_at)
    this.emit(input.project_id, 'artifact.registered', { artifact_id: record.artifact_id, kind: record.kind, size_bytes })
    return record
  }

  getArtifact(sha256OrId: string): ArtifactRecord {
    const id = sha256OrId.startsWith('sha256:') ? sha256OrId : `sha256:${sha256OrId}`
    const row = this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(id) as ArtifactRecord | undefined
    if (row === undefined) throw new KernelError(404, 'artifact_not_found', `artifact ${id} not found`)
    return row
  }

  listArtifacts(projectId: string): ArtifactRecord[] {
    return this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as ArtifactRecord[]
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
  }): JobRecord {
    this.getProject(input.project_id)
    const existing = this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(input.idempotency_key) as JobRow | undefined
    if (existing !== undefined) return jobFromRow(existing)
    const job: JobRecord = {
      job_id: `job_${randomUUID().slice(0, 12)}`,
      project_id: input.project_id,
      contract_id: input.contract_id ?? null,
      idempotency_key: input.idempotency_key,
      kind: input.kind,
      command: input.command ?? [],
      payload: input.payload ?? {},
      status: 'queued',
      failure_class: null,
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      attempts: 0,
      max_attempts: input.max_attempts ?? 3,
      run_manifest: null,
      error: '',
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    this.db.prepare(
      `INSERT INTO jobs (job_id, project_id, contract_id, idempotency_key, kind, command, payload, status, failure_class, lease_owner, lease_expires_at, heartbeat_at, attempts, max_attempts, run_manifest, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      job.job_id, job.project_id, job.contract_id, job.idempotency_key, job.kind, JSON.stringify(job.command),
      JSON.stringify(job.payload), job.status, job.failure_class, job.lease_owner, job.lease_expires_at,
      job.heartbeat_at, job.attempts, job.max_attempts, job.run_manifest === null ? null : JSON.stringify(job.run_manifest),
      job.error, job.created_at, job.updated_at,
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

  /** Claim queued/retryable jobs for an owner with a lease TTL (design §9.3). */
  claimJobs(owner: string, leaseTtlSeconds = 300, limit = 8): JobRecord[] {
    const now = nowIso()
    const expired = new Date(Date.now() - leaseTtlSeconds * 1000).toISOString()
    const rows = this.db.prepare(
      `SELECT * FROM jobs WHERE status = 'queued' OR (status = 'retryable' AND attempts < max_attempts) ORDER BY created_at LIMIT ?`,
    ).all(limit) as unknown as JobRow[]
    const claimed: JobRecord[] = []
    const update = this.db.prepare(
      `UPDATE jobs SET status = 'running', lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, attempts = attempts + 1, updated_at = ? WHERE job_id = ? AND (status = 'queued' OR status = 'retryable')`,
    )
    for (const row of rows) {
      const leaseExpires = new Date(Date.now() + leaseTtlSeconds * 1000).toISOString()
      const result = update.run(owner, leaseExpires, now, now, row.job_id)
      if (Number(result.changes) === 1) claimed.push(jobFromRow(this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(row.job_id) as unknown as JobRow))
    }
    void expired
    return claimed
  }

  /** Renew a lease (heartbeat); rejects when owned by another instance. */
  heartbeatJob(jobId: string, owner: string, leaseTtlSeconds = 300): JobRecord {
    const job = this.getJob(jobId)
    if (job.lease_owner !== null && job.lease_owner !== owner) {
      throw new KernelError(409, 'lease_conflict', `job ${jobId} leased by ${job.lease_owner}`)
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

  /** Finalize a job with a validated RunManifest (design §4.6.1, §6.5). */
  completeJob(input: {
    job_id: string
    owner: string
    status: 'succeeded' | 'failed' | 'cancelled'
    run_manifest?: Record<string, unknown>
    failure_class?: JobRecord['failure_class']
    error?: string
  }): JobRecord {
    const job = this.getJob(input.job_id)
    if (job.lease_owner !== null && job.lease_owner !== input.owner) {
      throw new KernelError(409, 'lease_conflict', `job ${input.job_id} leased by ${job.lease_owner}`)
    }
    if (job.status !== 'running') {
      throw new KernelError(409, 'job_not_running', `job ${input.job_id} is ${job.status}, not running`)
    }
    if (input.status === 'succeeded' && input.run_manifest !== undefined) {
      const refs = collectManifestRefs(input.run_manifest)
      if (refs.length > 0) {
        const { ok, missing } = this.verifyArtifactRefs(refs)
        if (!ok) {
          throw new KernelError(422, 'manifest_refs_missing', `run manifest references missing artifacts: ${missing.join(', ')}`)
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
    return jobRecord
  }

  cancelJob(jobId: string, actor: string, reason = ''): JobRecord {
    const job = this.getJob(jobId)
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      throw new KernelError(409, 'job_finished', `job ${jobId} already ${job.status}`)
    }
    this.db.prepare('UPDATE jobs SET status = ?, error = ?, lease_owner = NULL, updated_at = ? WHERE job_id = ?')
      .run('cancelled', reason ? `cancelled by ${actor}: ${reason}` : `cancelled by ${actor}`, nowIso(), jobId)
    return this.getJob(jobId)
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
  }): import('@dsh-scholar/research-schemas').EvidenceItem {
    this.getProject(input.project_id)
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
    this.db.prepare('INSERT INTO evidence (evidence_id, project_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(item.evidence_id, item.project_id, JSON.stringify(item), item.created_at)
    return item
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
    const evidence = input.evidence_ids
      .map(id => this.listEvidence(current.project_id).find(e => e.evidence_id === id))
      .filter((e): e is NonNullable<typeof e> => e !== undefined)
    if (evidence.length === 0) {
      throw new KernelError(422, 'no_evidence', `claim ${input.claim_id} has no resolvable evidence`)
    }
    // Rule (deterministic): supported when all evidence accepted and CIs
    // exclude zero or effect_size > 0; contradicted when CI includes zero
    // with negative effect; else inconclusive.
    let status: Claim['status'] = 'supported'
    const effects = evidence.filter(e => e.result.effect_size !== undefined)
    if (evidence.some(e => e.status === 'conflicted')) {
      status = 'inconclusive'
    } else if (effects.length > 0) {
      const allPositive = effects.every(e => (e.result.effect_size ?? 0) > 0 && (e.result.ci_low ?? -Infinity) > 0)
      const anyNegative = effects.some(e => (e.result.effect_size ?? 0) < 0)
      status = allPositive ? 'supported' : anyNegative ? 'contradicted' : 'inconclusive'
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
  computeAnalysis(projectId: string, contractId?: string, metric?: string): {
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
    generated_at: string
  } {
    const project = this.getProject(projectId)
    const jobs = this.listJobs(projectId).filter(j => j.status === 'succeeded' && j.run_manifest !== null)
    const metricValues: Array<{ run_id: string; job_id: string; value: number; seed?: number }> = []
    let baselineValue: number | null = null
    for (const job of jobs) {
      if (contractId !== undefined && job.contract_id !== contractId) continue
      const metricsArtifact = job.run_manifest?.metrics_artifact
      if (typeof metricsArtifact !== 'string') continue
      const sha = metricsArtifact.replace(/^sha256:/, '')
      if (!this.cas.has(sha)) continue
      const parsed = JSON.parse(this.cas.read(sha).toString('utf8')) as { metrics?: Array<{ metric?: string; value?: number; seed?: number }> }
      for (const entry of parsed.metrics ?? []) {
        if (entry.value === undefined || entry.metric === undefined) continue
        if (metric !== undefined && entry.metric !== metric) continue
        const targetMetric = entry.metric
        if (job.kind === 'baseline') {
          baselineValue = entry.value
        } else {
          metricValues.push({ run_id: typeof job.run_manifest?.run_id === 'string' ? job.run_manifest.run_id : job.job_id, job_id: job.job_id, value: entry.value, seed: entry.seed })
        }
        void targetMetric
      }
    }
    if (metricValues.length === 0) {
      throw new KernelError(422, 'no_metrics', 'no succeeded runs with metrics artifacts found for analysis')
    }
    const values = metricValues.map(v => v.value)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / Math.max(values.length - 1, 1)
    const sd = Math.sqrt(variance)
    const [ciLow, ciHigh] = bootstrapCi95(values, 1000)
    const effectSize = baselineValue !== null ? mean - baselineValue : null
    const result = {
      contract_id: contractId ?? null,
      metric: metric ?? 'auto',
      runs: metricValues,
      mean: round(mean),
      sd: round(sd),
      n: values.length,
      ci_low: round(ciLow),
      ci_high: round(ciHigh),
      baseline_value: baselineValue !== null ? round(baselineValue) : null,
      effect_size: effectSize !== null ? round(effectSize) : null,
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
    return { artifact_id: artifact.artifact_id, chart_artifact: chart.chart_artifact, ...result, generated_at: nowIso() }
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
        lines.push('\\begin{tabular}{llllllll}', '\\toprule', 'Metric & Value & Baseline & Effect & 95\\% CI & Seeds & Method & Claims \\\\', '\\midrule')
        lines.push(...evidenceRows.map(r => `${r} \\\\`))
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
    return { manuscript_id: manuscriptId, format, text, artifact_id: artifact.artifact_id, claims_used: supported.length }
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
