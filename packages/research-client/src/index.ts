/**
 * Typed Research Kernel API client (design §8.3). All methods are
 * idempotency-aware where the Kernel requires it; a request to an unreachable
 * kernel fails fast with a `KernelUnavailableError`.
 * @module @dsh-scholar/research-client
 */

import type {
  ArtifactRecord, Claim, CorpusSnapshot, Decision, EvidenceItem, ExperimentContract, Gate,
  IdeaCard, JobRecord, KernelEvent, ResearchProject, SessionLink,
} from '@dsh-scholar/research-schemas'

export class KernelUnavailableError extends Error {
  constructor(endpoint: string, cause: unknown) {
    super(`research kernel unreachable at ${endpoint}: ${(cause as Error).message ?? String(cause)}`)
    this.name = 'KernelUnavailableError'
  }
}

export class KernelApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'KernelApiError'
    this.status = status
    this.code = code
  }
}

export interface KernelClientOptions {
  endpoint: string
  token?: string
  /** Timeout for each request, ms. */
  timeoutMs?: number
}

export class ResearchClient {
  readonly endpoint: string
  private readonly token: string | undefined
  private readonly timeoutMs: number

  constructor(options: KernelClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '')
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? 15000
  }

  private async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.endpoint}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {},
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      throw new KernelUnavailableError(this.endpoint, error)
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      let detail = ''
      try {
        const parsed = await response.json() as { error?: { code?: string; message?: string } }
        detail = parsed.error?.message ?? ''
      } catch { /* keep empty */ }
      throw new KernelApiError(response.status, detail || `http_${response.status}`, detail || `request ${method} ${path} failed`)
    }
    return (await response.json()) as T
  }

  health(): Promise<{ ok: boolean; instance: string }> {
    return this.request('GET', '/v1/health')
  }

  // ── projects ─────────────────────────────────────────────────────────────

  createProject(input: {
    name: string
    workspace: string
    brief: unknown
    mode?: 'gate-only' | 'full-auto'
    constraints?: Record<string, unknown>
    execution?: Record<string, unknown>
    integrity?: Record<string, unknown>
    session_id?: string | null
  }): Promise<ResearchProject> {
    return this.request('POST', '/v1/projects', input)
  }

  listProjects(): Promise<ResearchProject[]> {
    return this.request('GET', '/v1/projects')
  }

  getProject(projectId: string): Promise<ResearchProject> {
    return this.request('GET', `/v1/projects/${projectId}`)
  }

  projectProjection(projectId: string): Promise<{
    project: ResearchProject
    pending_gates: Gate[]
    jobs: Array<{ job_id: string; kind: string; status: string }>
    budget: Record<string, unknown>
    counts: Record<string, number>
    next_actions: string[]
  }> {
    return this.request('GET', `/v1/projects/${projectId}/projection`)
  }

  transition(projectId: string, to: string, expectedRevision: number, reason?: string): Promise<ResearchProject> {
    return this.request('POST', `/v1/projects/${projectId}/transitions`, { to, expected_revision: expectedRevision, reason })
  }

  linkSession(sessionId: string, projectId: string): Promise<SessionLink> {
    return this.request('POST', `/v1/projects/${projectId}/session`, { session_id: sessionId })
  }

  getProjectBySession(sessionId: string): Promise<ResearchProject | null> {
    return this.request('GET', `/v1/session-links/${sessionId}`)
  }

  // ── gates ────────────────────────────────────────────────────────────────

  createGate(input: { project_id: string; type: string; title: string; summary?: string; payload?: Record<string, unknown>; session_id?: string | null }): Promise<Gate> {
    return this.request('POST', `/v1/projects/${input.project_id}/gates`, input)
  }

  listGates(projectId: string): Promise<Gate[]> {
    return this.request('GET', `/v1/projects/${projectId}/gates`)
  }

  decideGate(input: {
    gate_id: string
    actor: string
    decision: 'approved' | 'rejected' | 'revised'
    reason?: string
    diff?: string
    session_id?: string | null
    event_id?: string | null
    resume_to?: string
  }): Promise<{ gate: Gate; decision: Decision; project: ResearchProject }> {
    return this.request('POST', `/v1/gates/${input.gate_id}/decisions`, input)
  }

  // ── artifacts ────────────────────────────────────────────────────────────

  registerArtifact(input: { project_id: string; kind: string; content_base64: string; metadata?: Record<string, unknown> }): Promise<ArtifactRecord> {
    return this.request('POST', '/v1/artifacts', input)
  }

  listArtifacts(projectId: string): Promise<ArtifactRecord[]> {
    return this.request('GET', `/v1/projects/${projectId}/artifacts`)
  }

  // ── ideas / contracts / corpus ───────────────────────────────────────────

  createIdea(input: Record<string, unknown>): Promise<IdeaCard> {
    return this.request('POST', `/v1/projects/${String(input.project_id)}/ideas`, input)
  }

  registerContract(input: Record<string, unknown>): Promise<ExperimentContract> {
    return this.request('POST', `/v1/projects/${String(input.project_id)}/contracts`, input)
  }

  snapshotCorpus(input: Record<string, unknown>): Promise<CorpusSnapshot> {
    return this.request('POST', `/v1/projects/${String(input.project_id)}/corpus`, input)
  }

  // ── jobs ─────────────────────────────────────────────────────────────────

  submitJob(input: {
    project_id: string
    idempotency_key: string
    kind: string
    command?: string[]
    payload?: Record<string, unknown>
    contract_id?: string | null
  }): Promise<JobRecord> {
    return this.request('POST', `/v1/projects/${input.project_id}/jobs`, input)
  }

  getJob(jobId: string): Promise<JobRecord> {
    return this.request('GET', `/v1/jobs/${jobId}`)
  }

  listJobs(projectId: string): Promise<JobRecord[]> {
    return this.request('GET', `/v1/projects/${projectId}/jobs`)
  }

  completeJob(input: { job_id: string; owner: string; status: 'succeeded' | 'failed' | 'cancelled'; run_manifest?: Record<string, unknown>; failure_class?: string | null; error?: string }): Promise<JobRecord> {
    return this.request('POST', `/v1/jobs/${input.job_id}/status`, input)
  }

  heartbeatJob(jobId: string, owner: string): Promise<JobRecord> {
    return this.request('POST', `/v1/jobs/${jobId}/heartbeat`, { owner })
  }

  cancelJob(jobId: string, actor: string, reason?: string): Promise<JobRecord> {
    return this.request('POST', `/v1/jobs/${jobId}/cancel`, { actor, reason })
  }

  claimJobs(owner: string, limit = 1, leaseTtlSeconds = 300): Promise<JobRecord[]> {
    return this.request('POST', '/v1/jobs-claim/run', { owner, limit, lease_ttl_seconds: leaseTtlSeconds })
  }

  recoverExpiredLeases(): Promise<{ recovered: number }> {
    return this.request('POST', '/v1/recover/leases')
  }

  // ── claims / evidence ────────────────────────────────────────────────────

  createClaim(input: { project_id: string; statement: string; scope?: Record<string, unknown> }): Promise<Claim> {
    return this.request('POST', `/v1/projects/${input.project_id}/claims`, input)
  }

  ingestEvidence(input: Record<string, unknown>): Promise<EvidenceItem> {
    return this.request('POST', `/v1/projects/${String(input.project_id)}/evidence`, input)
  }

  verifyClaim(input: { claim_id: string; evidence_ids: string[]; analysis_artifact?: string; reason?: string }): Promise<Claim> {
    return this.request('POST', '/v1/claims/verify', input)
  }

  // ── ideas / corpus / manuscript ───────────────────────────────────────────

  listIdeas(projectId: string): Promise<IdeaCard[]> {
    return this.request('GET', `/v1/projects/${projectId}/ideas`)
  }

  getIdea(ideaId: string): Promise<IdeaCard> {
    return this.request('GET', `/v1/ideas/${ideaId}`)
  }

  updateIdeaNovelty(ideaId: string, audit: {
    queries: string[]
    result: 'no_direct_match_found' | 'overlap_found' | 'inconclusive'
    overlap_papers?: string[]
    unresolved_risk?: 'low' | 'medium' | 'high'
  }): Promise<IdeaCard> {
    return this.request('POST', `/v1/ideas/${ideaId}/novelty`, audit)
  }

  corpusSnapshots(projectId: string): Promise<CorpusSnapshot[]> {
    return this.request('GET', `/v1/projects/${projectId}/corpus-snapshots`)
  }

  buildManuscript(projectId: string, format: 'markdown' | 'latex', includeLimitations: boolean): Promise<{
    manuscript_id: string
    format: string
    text: string
    artifact_id: string
    claims_used: number
  }> {
    return this.request('POST', `/v1/projects/${projectId}/manuscripts/build`, { format, include_limitations: includeLimitations })
  }

  manuscriptReview(projectId: string): Promise<{
    checks: Array<{ check: string; status: 'pass' | 'warn' | 'fail'; detail: string }>
    pass: boolean
  }> {
    return this.request('GET', `/v1/projects/${projectId}/manuscript-review`)
  }

  releaseBundle(projectId: string): Promise<{
    bundle_id: string
    artifact_id: string
    contents: string[]
    release_gate: 'unapproved'
  }> {
    return this.request('POST', `/v1/projects/${projectId}/release-bundle`)
  }

  computeAnalysis(projectId: string, contractId?: string, metric?: string): Promise<{
    artifact_id: string
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
  }> {
    return this.request('POST', `/v1/projects/${projectId}/analysis`, { contract_id: contractId, metric })
  }

  // ── budget / events ──────────────────────────────────────────────────────

  recordUsage(projectId: string, usage: { model_cost_usd?: number; gpu_hours?: number; api_requests?: number }): Promise<Record<string, unknown>> {
    return this.request('POST', `/v1/projects/${projectId}/budget`, usage)
  }

  listEvents(projectId?: string): Promise<KernelEvent[]> {
    return this.request('GET', projectId === undefined ? '/v1/events' : `/v1/projects/${projectId}/events`)
  }
}
