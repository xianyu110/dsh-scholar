/**
 * Durable Research Orchestrator — state-driven Engine (design §8.3–§8.5).
 *
 * The Engine polls the Research Kernel projection API and, per §8.3, advances
 * each project from its current status toward the next Human Gate, then pauses
 * there. It is a standalone service: it talks to the Kernel only over HTTP and
 * keeps its own durable Action store (see actions.ts). No DSH sessions, no
 * in-process Tasks.
 *
 * Recovery (§8.5): on startup the Engine reads every action from its store and
 * continues purely from the Kernel projection. Each step is idempotent per
 * (project_id, idempotency_key), so a crashed poll is replayed safely. Leader
 * election (§15): one Project Phase Controller per project is enforced via the
 * orchestrator_leases table — this instance claims a lease per project every
 * round (expiry + takeover), skips projects held by another live owner, and
 * releases its leases on close().
 *
 * Failure policy (§8.4, simplified): a failed Kernel call records last_error,
 * bumps attempt, and the step is retried on the next round while
 * attempt < max_attempts; at attempt >= max_attempts it is marked `failed`
 * and never retried again.
 *
 * @module @dsh-scholar/research-orchestrator/engine
 */

import { hostname } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ActionStore, type Action, type ActionLike } from './actions.js'

/** §15: orchestrator_leases default expiry (seconds). */
const DEFAULT_LEASE_SECONDS = 60

/**
 * Read the Kernel bearer token: --token-file (0600 file, §15) wins; without
 * it, the process env `DSH_SCHOLAR_KERNEL_TOKEN` is inherited (a sidecar
 * spawned orchestrator carries it — §5 P0-1). Fails fast when the file was
 * requested but is missing/unreadable — a wrongly configured orchestrator
 * must not silently run without kernel auth.
 */
function readTokenFile(tokenFile: string | undefined, log: (message: string) => void): string | null {
  if (tokenFile !== undefined && tokenFile !== '') {
    if (!existsSync(tokenFile)) {
      throw new Error(`--token-file ${tokenFile} does not exist (kernel bearer token required)`)
    }
    const token = readFileSync(tokenFile, 'utf8').trim()
    if (token === '') {
      throw new Error(`--token-file ${tokenFile} is empty`)
    }
    log(`using kernel bearer token from ${tokenFile}`)
    return token
  }
  const envToken = process.env.DSH_SCHOLAR_KERNEL_TOKEN
  if (envToken !== undefined && envToken !== '') {
    log('using kernel bearer token from DSH_SCHOLAR_KERNEL_TOKEN')
    return envToken
  }
  return null
}

/**
 * Project lifecycle statuses as reported by the Kernel projection
 * (project.project.status). Mirrored locally so the orchestrator stays
 * self-contained (no dependency on @dsh-scholar/research-schemas).
 */
export type ProjectStatus =
  | 'DRAFT'
  | 'SCOPED'
  | 'SURVEYING'
  | 'IDEATING'
  | 'IDEA_APPROVED'
  | 'BASELINE_REPRO'
  | 'CONTRACT_APPROVED'
  | 'EXPERIMENTING'
  | 'EVIDENCE_READY'
  | 'WRITING'
  | 'REVIEWING'
  | 'RELEASE_READY'
  | 'ARCHIVED'
  | 'RELEASED'
  | 'FAILED'
  | 'STOPPED'
  | 'BLOCKED_GATE'

export type ActionPlanKind = 'gate' | 'note' | 'observe'

/** A step the orchestrator *would* run for a project in a given status (§8.3). */
export interface ActionPlan {
  /** Action type recorded in the store, e.g. 'scope-gate' or 'survey-ready'. */
  type: string
  /** Idempotency key (per project). */
  idempotency_key: string
  /**
   * - `gate`: create a Kernel Gate Request (POST /v1/projects/{id}/gates);
   *   ends `blocked` (waiting for the human).
   * - `note`: a pending human/model step the orchestrator must NOT automate;
   *   ends `blocked` with the note in last_error.
   * - `observe`: terminal/blocked statuses — record an observation, ends `done`.
   */
  kind: ActionPlanKind
  /** Kernel gate type for `gate` plans (scope/idea/contract/release). */
  gate_type?: 'scope' | 'idea' | 'contract' | 'release'
  /** Gate title for `gate` plans. */
  title?: string
  /** Human-facing note (stored in last_error for blocked/done actions). */
  note?: string
}

export interface ProjectionGate {
  gate_id: string
  type: string
  title: string
  status: string
}

/** Minimal structural view of the Kernel projection response (self-contained). */
export interface KernelProjection {
  project: { project_id: string; status: string; brief_status?: 'collecting' | 'confirmed' }
  pending_gates: ProjectionGate[]
}

/** One project's outcome for a poll round. */
export interface ProjectPollDetail {
  project_id: string
  status: string
  planned: ActionPlan[]
  executed: Array<{ type: string; idempotency_key: string; result: 'blocked' | 'done' | 'failed' }>
  skipped: string[]
  errors: string[]
}

export interface PollResult {
  polled_at: string
  projects: number
  planned: number
  executed: number
  errors: string[]
  details: ProjectPollDetail[]
}

export interface EngineOptions {
  /** Base URL of the Research Kernel HTTP API, e.g. http://127.0.0.1:7412. */
  kernelUrl: string
  /** Poll interval for start()/CLI loop. Default 5000 ms. */
  pollMs?: number
  /** Action store SQLite file path. Defaults to ./.orchestrator/actions.db. */
  dbPath?: string
  /** When true, only compute planned actions; never call Kernel write APIs
   * and never persist to the store (test mode). */
  dryRun?: boolean
  /** Max attempts before an action is marked failed (§8.4). Default 3. */
  maxAttempts?: number
  /** Leader-election owner id (§15, orchestrator_leases). Defaults to
   * `orch-<hostname>-<pid>`. One owner holds the lease per project; other
   * instances skip the project until the lease expires or is released. */
  owner?: string
  /** orchestrator_leases expiry in seconds (§15). Default 60. */
  leaseSeconds?: number
  /** Path to a 0600 file holding the Kernel bearer token (--token-file).
   * When set, every Kernel request carries `Authorization: Bearer <token>`.
   * Missing/unreadable file fails fast at construction. */
  tokenFile?: string
}

export class KernelApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'KernelApiError'
    this.status = status
    this.code = code
  }
}

// ── §8.3 automatic-advance rules (pure) ─────────────────────────────────────

/**
 * Pure mapping: project status → the single next action per §8.3.
 * Returns null when nothing should be automated for this status
 * (SURVEYING→IDEATING is model/human work; terminal statuses only observe).
 */
export function planForStatus(status: ProjectStatus): ActionPlan | null {
  switch (status) {
    case 'DRAFT':
      return { type: 'scope-gate', idempotency_key: 'scope-gate', kind: 'gate', gate_type: 'scope', title: 'Scope Gate', note: '等待人类在 Scholar 面板批准 Scope Gate' }
    case 'SCOPED':
      return { type: 'survey-ready', idempotency_key: 'survey-ready', kind: 'note', note: '等待 Scholar 面板:运行文献调研并冻结 corpus snapshot(SCOPED→SURVEYING→IDEATING)' }
    case 'SURVEYING':
      // 不自动:调研→选题是模型/用户工作,orchestrator 不代跑。
      return null
    case 'IDEATING':
      return { type: 'idea-gate', idempotency_key: 'idea-gate', kind: 'gate', gate_type: 'idea', title: 'Idea Gate', note: '等待人类在 Scholar 面板批准 Idea Gate' }
    case 'IDEA_APPROVED':
      return { type: 'baseline-ready', idempotency_key: 'baseline-ready', kind: 'note', note: '等待 baseline 复现执行(隔离 runner;IDEA_APPROVED→BASELINE_REPRO)' }
    case 'BASELINE_REPRO':
      return { type: 'contract-gate', idempotency_key: 'contract-gate', kind: 'gate', gate_type: 'contract', title: 'Contract Gate', note: '等待人类在 Scholar 面板批准 Contract Gate' }
    case 'CONTRACT_APPROVED':
      return { type: 'experiment-ready', idempotency_key: 'experiment-ready', kind: 'note', note: '等待正式实验执行(CONTRACT_APPROVED→EXPERIMENTING)' }
    case 'EXPERIMENTING':
      return { type: 'analysis-ready', idempotency_key: 'analysis-ready', kind: 'note', note: '等待正式运行完成并产出证据(EXPERIMENTING→EVIDENCE_READY)' }
    case 'EVIDENCE_READY':
      return { type: 'manuscript-ready', idempotency_key: 'manuscript-ready', kind: 'note', note: '等待写作(EVIDENCE_READY→WRITING)' }
    case 'WRITING':
      return { type: 'review-ready', idempotency_key: 'review-ready', kind: 'note', note: '等待评审(WRITING→REVIEWING)' }
    case 'REVIEWING':
      return { type: 'release-gate', idempotency_key: 'release-gate', kind: 'gate', gate_type: 'release', title: 'Release Gate', note: '等待人类在 Scholar 面板批准 Release Gate' }
    case 'RELEASE_READY':
      return { type: 'release-pending-human', idempotency_key: 'release-pending-human', kind: 'note', note: 'Release 保持人工:等待人类批准 Release Gate(RELEASE_READY→RELEASED)' }
    case 'BLOCKED_GATE':
      return { type: 'observe', idempotency_key: 'observe:BLOCKED_GATE', kind: 'observe', note: '项目处于 BLOCKED_GATE:等待待决 gate / 预算决策,不自动推进' }
    case 'FAILED':
      return { type: 'observe', idempotency_key: 'observe:FAILED', kind: 'observe', note: '项目 FAILED:终态,不自动推进' }
    case 'STOPPED':
      return { type: 'observe', idempotency_key: 'observe:STOPPED', kind: 'observe', note: '项目 STOPPED:终态,不自动推进' }
    case 'ARCHIVED':
      return { type: 'observe', idempotency_key: 'observe:ARCHIVED', kind: 'observe', note: '项目已 ARCHIVED,不自动推进' }
    case 'RELEASED':
      return { type: 'observe', idempotency_key: 'observe:RELEASED', kind: 'observe', note: '项目已 RELEASED,不自动推进' }
    default:
      return null
  }
}

/**
 * §8.3 + §8.4 decision: which plans to execute right now, given the project
 * status and the actions already recorded for that project.
 *
 * Idempotency: an existing `done`/`blocked` action with the same key is never
 * re-run. Retry: `queued`/`running`/`failed` actions are re-run only while
 * attempt < max_attempts; a `failed` action at its attempt cap stays failed.
 */
export function decideActions(status: ProjectStatus, existing: ActionLike[], briefStatus: 'collecting' | 'confirmed' = 'confirmed'): ActionPlan[] {
  if (status === 'DRAFT' && briefStatus === 'collecting') return []
  const plan = planForStatus(status)
  if (plan === null) return []
  const prior = existing.find(a => a.idempotency_key === plan.idempotency_key)
  if (prior === undefined) return [plan]
  if (prior.status === 'done' || prior.status === 'blocked') return []
  if (prior.status === 'failed' && prior.attempt >= prior.max_attempts) return []
  return [plan]
}

// ── Engine ──────────────────────────────────────────────────────────────────

const DEFAULT_POLL_MS = 5000
const DEFAULT_MAX_ATTEMPTS = 3

/**
 * Durable Research Orchestrator Engine: polls the Kernel projection and
 * advances projects toward the next Human Gate (§8.3), persisting every step
 * in its own SQLite Action store and recovering from the store + projection
 * after crashes (§8.5).
 */
export class Engine {
  readonly kernelUrl: string
  readonly pollMs: number
  readonly maxAttempts: number
  readonly dryRun: boolean
  readonly store: ActionStore
  /** Leader-election identity (§15, orchestrator_leases). */
  readonly owner: string
  /** orchestrator_leases expiry in seconds (§15). */
  readonly leaseSeconds: number
  /** Kernel bearer token (--token-file) or null when not configured. */
  readonly token: string | null

  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private log: (message: string) => void
  /** Projects this instance currently holds the phase-controller lease for. */
  private ownedProjects = new Set<string>()

  constructor(options: EngineOptions, log: (message: string) => void = (m) => { console.error(`[research-orchestrator] ${m}`) }) {
    this.kernelUrl = options.kernelUrl.replace(/\/+$/, '')
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.dryRun = options.dryRun ?? false
    this.owner = options.owner ?? `orch-${hostname()}-${process.pid}`
    this.leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS
    this.token = readTokenFile(options.tokenFile, log)
    this.log = log
    this.store = new ActionStore({ dbPath: options.dbPath ?? join(process.cwd(), '.orchestrator', 'actions.db') })
    // §8.5: startup recovery — stale `running` rows from a crashed process
    // become retryable again; everything else is read as-is.
    const recovered = this.store.recover()
    if (recovered > 0) this.log(`recovered ${recovered} stale running action(s) from crash`)
    if (!this.dryRun) this.log(`leader election: owner=${this.owner} lease=${this.leaseSeconds}s${this.token !== null ? ' (kernel bearer token: yes)' : ''}`)
  }

  /** Release every held lease, then close the store. */
  close(): void {
    if (!this.dryRun) {
      for (const projectId of this.ownedProjects) this.store.releaseLease(projectId, this.owner)
      this.ownedProjects.clear()
    }
    this.store.close()
  }

  // ── Kernel HTTP client (self-contained; only node:fetch) ──────────────────

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.kernelUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(this.token !== null ? { authorization: `Bearer ${this.token}` } : {}), ...init?.headers },
      })
    } catch (error) {
      throw new KernelApiError(0, 'network_error', `cannot reach kernel at ${this.kernelUrl}${path}: ${(error as Error).message}`)
    }
    const text = await response.text()
    let body: unknown = null
    if (text !== '') {
      try { body = JSON.parse(text) } catch { body = null }
    }
    if (!response.ok) {
      const err = (body as { error?: { code?: string; message?: string } } | null)?.error
      throw new KernelApiError(response.status, err?.code ?? 'http_error', err?.message ?? `${response.status} ${path}`)
    }
    return body as T
  }

  /** GET /v1/projects — list all projects (read-only). */
  async listProjects(): Promise<Array<{ project_id: string; status: string }>> {
    return this.request<Array<{ project_id: string; status: string }>>('/v1/projects')
  }

  /** GET /v1/projects/{id}/projection (read-only). */
  async getProjection(projectId: string): Promise<KernelProjection> {
    return this.request<KernelProjection>(`/v1/projects/${encodeURIComponent(projectId)}/projection`)
  }

  /** POST /v1/projects/{id}/gates — the only Kernel write the Engine performs. */
  async createGate(projectId: string, plan: ActionPlan): Promise<{ gate_id: string; type: string; status: string }> {
    return this.request<{ gate_id: string; type: string; status: string }>(`/v1/projects/${encodeURIComponent(projectId)}/gates`, {
      method: 'POST',
      body: JSON.stringify({ type: plan.gate_type, title: plan.title ?? `${plan.type} request` }),
    })
  }

  // ── §8.3 execution ─────────────────────────────────────────────────────────

  /**
   * Run one full poll round: list projects, fetch each projection, decide the
   * next action per §8.3 and execute it (idempotent). Never throws for a
   * single project's failure — errors are collected into the result.
   */
  async pollOnce(): Promise<PollResult> {
    const result: PollResult = {
      polled_at: new Date().toISOString(),
      projects: 0,
      planned: 0,
      executed: 0,
      errors: [],
      details: [],
    }
    let projects: Array<{ project_id: string; status: string }>
    try {
      projects = await this.listProjects()
    } catch (error) {
      result.errors.push(`listProjects: ${(error as Error).message}`)
      return result
    }
    result.projects = projects.length
    for (const project of projects) {
      const detail: ProjectPollDetail = { project_id: project.project_id, status: project.status, planned: [], executed: [], skipped: [], errors: [] }
      try {
        // §15 leader election: one Phase Controller per project via
        // orchestrator_leases. When another instance holds a live lease,
        // SKIP the project entirely — no silent double-advance. Leases are
        // refreshed every round and released on close(). (dry-run never
        // persists, so it never claims.)
        if (!this.dryRun) {
          const claim = this.store.claimLease(project.project_id, this.owner, this.leaseSeconds)
          if (!claim.granted) {
            detail.skipped.push(`lease held by another orchestrator owner (generation ${claim.generation})`)
            result.details.push(detail)
            continue
          }
          this.ownedProjects.add(project.project_id)
        }
        const projection = await this.getProjection(project.project_id)
        detail.status = projection.project.status
        const existing = this.dryRun ? [] : this.store.listByProject(project.project_id)
        const plans = decideActions(projection.project.status as ProjectStatus, existing, projection.project.brief_status ?? 'confirmed')
        detail.planned = plans
        result.planned += plans.length
        for (const plan of plans) {
          const outcome = await this.executePlan(project.project_id, projection, plan, detail)
          if (outcome !== 'skipped') {
            result.executed += 1
          }
        }
        // Renew the lease for the next round (§15: lease expiry must not
        // fire while this instance is actively driving the project).
        if (!this.dryRun) this.store.refreshLease(project.project_id, this.owner, this.leaseSeconds)
      } catch (error) {
        detail.errors.push((error as Error).message)
        result.errors.push(`${project.project_id}: ${(error as Error).message}`)
      }
      result.details.push(detail)
    }
    return result
  }

  private async executePlan(projectId: string, projection: KernelProjection, plan: ActionPlan, detail: ProjectPollDetail): Promise<string> {
    // Idempotency guard (§8.3): skip when this step was already recorded
    // (done/blocked) or burned out on retries (failed at attempt cap).
    const existing = this.store.get(projectId, plan.idempotency_key)
    if (existing !== null) {
      if (existing.status === 'done' || existing.status === 'blocked') {
        detail.skipped.push(`${plan.type} (already ${existing.status})`)
        return 'skipped'
      }
      if (existing.status === 'failed' && existing.attempt >= existing.max_attempts) {
        detail.skipped.push(`${plan.type} (failed at attempt cap)`)
        return 'skipped'
      }
    }

    // Gate reconciliation: if the Kernel already shows a pending gate of this
    // type (created by the Scholar panel, or by a crashed earlier poll whose
    // store write was lost), do not create a duplicate — just record the step.
    if (plan.kind === 'gate' && projection.pending_gates.some(g => g.type === plan.gate_type)) {
      if (this.dryRun) {
        detail.skipped.push(`${plan.type} (pending ${plan.gate_type} gate already exists in kernel)`)
        return 'skipped'
      }
      const action = existing ?? ActionStore.newAction({
        project_id: projectId, phase: projection.project.status, type: plan.type,
        idempotency_key: plan.idempotency_key, max_attempts: this.maxAttempts, last_error: plan.note ?? null,
      })
      if (existing === null) this.store.insert(action)
      this.store.updateStatus(action.action_id, 'done', { attempt: action.attempt + 1, last_error: plan.note ?? null })
      detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'done' })
      return 'done'
    }

    // dryRun (§8.5 test mode): compute only — no Kernel writes, no persistence.
    if (this.dryRun) {
      detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: plan.kind === 'observe' ? 'done' : 'blocked' })
      return plan.kind === 'observe' ? 'done' : 'blocked'
    }

    // Persist the step BEFORE the Kernel write so a crash mid-step leaves a
    // recoverable row (§8.5) instead of a silently lost step.
    const action = existing ?? ActionStore.newAction({
      project_id: projectId, phase: projection.project.status, type: plan.type,
      idempotency_key: plan.idempotency_key, max_attempts: this.maxAttempts, last_error: plan.note ?? null,
    })
    if (existing === null) this.store.insert(action)

    let finalStatus: 'done' | 'blocked'
    if (plan.kind === 'gate') {
      try {
        await this.createGate(projectId, plan)
        finalStatus = 'blocked' // Gate created → pause for the human (§8.3)
      } catch (error) {
        this.recordFailure(action, error)
        detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: 'failed' })
        return 'failed'
      }
    } else if (plan.kind === 'observe') {
      finalStatus = 'done'
    } else {
      finalStatus = 'blocked' // note-action: the orchestrator must not automate further
    }
    this.store.updateStatus(action.action_id, finalStatus, { attempt: action.attempt + 1, last_error: plan.note ?? null })
    detail.executed.push({ type: plan.type, idempotency_key: plan.idempotency_key, result: finalStatus })
    return finalStatus
  }

  /** §8.4: failure policy — last_error + attempt+1; at cap mark failed forever. */
  private recordFailure(action: Action, error: unknown): void {
    const attempt = action.attempt + 1
    const message = (error as Error).message ?? String(error)
    const status = attempt >= action.max_attempts ? 'failed' : 'queued'
    this.store.updateStatus(action.action_id, status, { attempt, last_error: message })
    this.log(`action ${action.type} for ${action.project_id} failed (attempt ${attempt}/${action.max_attempts}): ${message}`)
  }

  // ── continuous polling ────────────────────────────────────────────────────

  /** Poll forever (every pollMs) until stop(). */
  async start(): Promise<void> {
    this.stopped = false
    this.log(`polling ${this.kernelUrl} every ${this.pollMs}ms (dryRun=${this.dryRun})`)
    while (!this.stopped) {
      try {
        const result = await this.pollOnce()
        this.log(`round done: ${result.projects} project(s), ${result.planned} planned, ${result.executed} executed, ${result.errors.length} error(s)`)
      } catch (error) {
        this.log(`round failed: ${(error as Error).message}`)
      }
      if (this.stopped) break
      await new Promise<void>(resolve => {
        this.timer = setTimeout(resolve, this.pollMs)
      })
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
