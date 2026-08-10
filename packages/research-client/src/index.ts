/**
 * Typed Research Kernel API client (design §8.3). All methods are
 * idempotency-aware where the Kernel requires it; a request to an unreachable
 * kernel fails fast with a `KernelUnavailableError`.
 * @module @dsh-scholar/research-client
 */

import type {
  ArtifactRecord, Claim, CorpusSnapshot, Decision, EvidenceItem, ExperimentContract, Gate,
  IdeaCard, JobRecord, KernelEvent, ResearchProject, RunnerKey, SessionLink,
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
  /** §4 P0 (API-01/EVID-01): internal-route service identity — sent as
   * `x-service-token` on every request; the kernel only enforces it on its
   * internal routes (claim/runner-keys/recover/verified/accept/approve). */
  serviceToken?: string
  /** Timeout for each request, ms. */
  timeoutMs?: number
}

export class ResearchClient {
  readonly endpoint: string
  private readonly token: string | undefined
  private readonly serviceToken: string | undefined
  private readonly timeoutMs: number

  constructor(options: KernelClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '')
    this.token = options.token
    this.serviceToken = options.serviceToken
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
          ...this.serviceToken !== undefined ? { 'x-service-token': this.serviceToken } : {},
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

  renameProject(projectId: string, name: string): Promise<ResearchProject> {
    return this.request('PATCH', `/v1/projects/${projectId}`, { name })
  }

  archiveProject(projectId: string): Promise<ResearchProject> {
    return this.request('POST', `/v1/projects/${projectId}/archive`)
  }

  unarchiveProject(projectId: string): Promise<ResearchProject> {
    return this.request('POST', `/v1/projects/${projectId}/unarchive`)
  }

  projectProjection(projectId: string): Promise<{
    project: ResearchProject
    pending_gates: Gate[]
    jobs: Array<{ job_id: string; kind: string; status: string }>
    budget: Record<string, unknown>
    counts: Record<string, number>
    next_actions: string[]
    /** GUIDE-01: structured next-step projection (kernel-authoritative). */
    next_actions_v2: Array<{
      id: string
      code: string
      label: string
      reason: string
      required: true | string[]
      route: string
      capability?: string
      revision: number | null
      state: 'ready' | 'blocked' | 'done'
      blocking: boolean
      refs: Array<{ kind: string; id: string }>
      required_by: 'human' | 'agent' | 'runner'
    }>
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
  }): Promise<{ gate: Gate; decision: Decision; project: ResearchProject }> {
    return this.request('POST', `/v1/gates/${input.gate_id}/decisions`, input)
  }

  // ── artifacts ────────────────────────────────────────────────────────────

  registerArtifact(input: { project_id: string; kind: string; content_base64: string; metadata?: Record<string, unknown>; media_type?: string; file_name?: string }): Promise<ArtifactRecord> {
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

  /**
   * §11.3 (SCH-EXEC-002): archive a directory's ACTUAL file contents into a
   * content-addressed `code` artifact (+ `manifest` artifact). The Runner
   * materializes jobs from this snapshot — never from agent host dirs.
   */
  snapshotCodeArchive(projectId: string, path: string, description?: string): Promise<{
    snapshot_id: string
    project_id: string
    path: string
    description: string
    archive_artifact_id: string
    manifest_artifact_id: string
    submodules_artifact_id: string | null
    lockfiles: string[]
    files: number
    total_bytes: number
    sha256: string
    created_at: string
  }> {
    return this.request('POST', `/v1/projects/${projectId}/code-snapshots`, { path, description })
  }

  // ── jobs ─────────────────────────────────────────────────────────────────

  submitJob(input: {
    project_id: string
    idempotency_key: string
    kind: string
    command?: string[]
    payload?: Record<string, unknown>
    contract_id?: string | null
    // §12.2 JobSpec binding (SCH-EXEC-002).
    code_snapshot_id?: string | null
    data_artifact_ids?: string[]
    image_digest?: string
    output_contract?: { metrics: string; logs: string }
  }): Promise<JobRecord> {
    return this.request('POST', `/v1/projects/${input.project_id}/jobs`, input)
  }

  getJob(jobId: string): Promise<JobRecord> {
    return this.request('GET', `/v1/jobs/${jobId}`)
  }

  listJobs(projectId: string): Promise<JobRecord[]> {
    return this.request('GET', `/v1/projects/${projectId}/jobs`)
  }

  completeJob(input: {
    job_id: string
    owner: string
    status: 'succeeded' | 'failed' | 'cancelled'
    run_manifest?: Record<string, unknown>
    failure_class?: string | null
    error?: string
    /** §12.6 lease fencing: pass the values returned by claimJobs to prove liveness. */
    lease_generation?: number | null
    lease_token?: string | null
  }): Promise<JobRecord> {
    return this.request('POST', `/v1/jobs/${input.job_id}/status`, input)
  }

  /** §12.6: heartbeat carries the claim's generation/token when available. */
  heartbeatJob(jobId: string, owner: string, leaseGeneration?: number | null, leaseToken?: string | null): Promise<JobRecord> {
    return this.request('POST', `/v1/jobs/${jobId}/heartbeat`, {
      owner,
      lease_generation: leaseGeneration ?? null,
      lease_token: leaseToken ?? null,
    })
  }

  cancelJob(jobId: string, actor: string, reason?: string): Promise<JobRecord> {
    return this.request('POST', `/v1/jobs/${jobId}/cancel`, { actor, reason })
  }

  /** execution-runtime.md §6: upload a batch of terminal frames (Runner side). */
  appendTerminalFrames(jobId: string, runId: string, frames: Array<{
    seq: number
    stream_seq?: number | null
    channel?: 'stdout' | 'stderr' | null
    text?: string | null
    byte_offset?: number | null
    byte_length?: number | null
    frame_kind: 'chunk' | 'gap' | 'exit'
    lease_generation?: number
    payload_json?: string
  }>): Promise<{ appended: number; last_seq: number }> {
    return this.request('POST', `/v1/jobs/${jobId}/terminal-frames`, { run_id: runId, frames })
  }

  claimJobs(owner: string, limit = 1, leaseTtlSeconds = 300): Promise<JobRecord[]> {
    return this.request('POST', '/v1/jobs-claim/run', { owner, limit, lease_ttl_seconds: leaseTtlSeconds })
  }

  /** §12.7: register a runner Ed25519 public key for manifest verification. */
  registerRunnerKey(input: { key_id: string; public_key_pem: string }): Promise<RunnerKey> {
    return this.request('POST', '/v1/runner-keys', input)
  }

  listRunnerKeys(): Promise<RunnerKey[]> {
    return this.request('GET', '/v1/runner-keys')
  }

  recoverExpiredLeases(): Promise<{ recovered: number }> {
    return this.request('POST', '/v1/recover/leases')
  }

  // ── claims / evidence ────────────────────────────────────────────────────

  createClaim(input: { project_id: string; statement: string; scope?: Record<string, unknown> }): Promise<Claim> {
    return this.request('POST', `/v1/projects/${input.project_id}/claims`, input)
  }

  ingestEvidence(input: Record<string, unknown> & { provenance_status?: 'draft_unverified' | 'legacy_unverified' | 'verified' }): Promise<EvidenceItem> {
    return this.request('POST', `/v1/projects/${String(input.project_id)}/evidence`, input)
  }

  /**
   * §4 P0 (EVID-01): internal Analysis-Worker path — ingest evidence with
   * provenance 'verified'. Only reachable with the service token
   * (x-service-token) plus x-service-principal: analysis-worker; the public
   * route rejects 'verified' provenance (422).
   */
  ingestVerifiedEvidence(input: Record<string, unknown>): Promise<EvidenceItem> {
    return this.request('POST', `/v1/projects/${String(input.project_id)}/evidence/verified`, input, {
      'x-service-principal': 'analysis-worker',
    })
  }

  /**
   * §4 P0 (EVID-01): internal Verifier/Auditor path — transition verified →
   * accepted after full revalidation. Requires the service token plus
   * x-service-principal: verifier|auditor (defaults to verifier).
   */
  acceptEvidence(projectId: string, evidenceId: string, input: { request_id?: string; service_principal?: 'verifier' | 'auditor' } = {}): Promise<EvidenceItem> {
    const { service_principal: principal, ...body } = input
    return this.request('POST', `/v1/projects/${projectId}/evidence/${evidenceId}/accept`, body, {
      'x-service-principal': principal ?? 'verifier',
    })
  }

  /**
   * §4 P0 (API-01): internal orchestrator path — freeze a contract by the
   * simulate-Human-Gate-Decision approve route. Requires the service token.
   */
  approveContract(projectId: string, contractId: string, actor: string): Promise<ExperimentContract> {
    return this.request('POST', `/v1/projects/${projectId}/contracts/${contractId}/approve`, { actor })
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
    bibtex: string
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

  /** Read an artifact blob (text) from the CAS (project-scoped, v2 §7.4). */
  async fetchArtifact(projectId: string, sha256OrId: string): Promise<string | null> {
    const id = sha256OrId.startsWith('sha256:') ? sha256OrId : `sha256:${sha256OrId}`
    try {
      const response = await fetch(`${this.endpoint}/v1/artifacts/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`, { signal: AbortSignal.timeout(10000) })
      if (!response.ok) return null
      return await response.text()
    } catch {
      return null
    }
  }

  /** TeX workspace file content at the given path (TEX-02 runner materialization). */
  async getDocumentFile(documentId: string, path: string): Promise<{ path: string; version: number; content: string } | null> {
    try {
      const response = await fetch(`${this.endpoint}/v1/documents/${encodeURIComponent(documentId)}/file?path=${encodeURIComponent(path)}`, {
        headers: { accept: 'application/json', ...this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {} },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) return null
      return await response.json() as { path: string; version: number; content: string }
    } catch {
      return null
    }
  }

  /**
   * TEX-01 (§4 row 95): FROZEN snapshot file bytes at a given revision —
   * the latex-compile build input. The Runner materializes from THIS, never
   * from getDocumentFile (the current file may have moved on since freeze).
   * null → the snapshot revision/path is not materializable: fail closed.
   */
  async getDocumentSnapshotFile(documentId: string, revision: number, path: string): Promise<{ path: string; content: string; content_hash: string } | null> {
    try {
      const response = await fetch(`${this.endpoint}/v1/documents/${encodeURIComponent(documentId)}/snapshot-files?revision=${revision}&path=${encodeURIComponent(path)}`, {
        headers: { accept: 'application/json', ...this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {} },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) return null
      return await response.json() as { path: string; content: string; content_hash: string }
    } catch {
      return null
    }
  }

  // ── budget / events ──────────────────────────────────────────────────────

  recordUsage(projectId: string, usage: { model_cost_usd?: number; gpu_hours?: number; api_requests?: number }): Promise<Record<string, unknown>> {
    return this.request('POST', `/v1/projects/${projectId}/budget`, usage)
  }

  listEvents(projectId?: string): Promise<KernelEvent[]> {
    return this.request('GET', projectId === undefined ? '/v1/events' : `/v1/projects/${projectId}/events`)
  }
}
