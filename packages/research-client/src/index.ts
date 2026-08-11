/**
 * Typed Research Kernel API client (design §8.3). All methods are
 * idempotency-aware where the Kernel requires it; a request to an unreachable
 * kernel fails fast with a `KernelUnavailableError`.
 * @module @dsh-scholar/research-client
 */

import type {
  AdoptionReceipt, ArtifactRecord, Claim, CorpusSnapshot, Decision, EvidenceItem, ExperimentContract, Gate,
  GrillAnswerInput, GrillAnswerView, HumanPrincipal, IdeaCard, IntakeArtifact, IntakeProjection, IntakeSession,
  JobRecord, KernelEvent, ObservedPhase, PaperRef, PaperReproductionSpec, PhaseProposal, ProjectDeletionReceipt,
  ReproductionAttempt, ReproductionReportInput, ReproducibilityReport, ResearchProject, RunnerKey, SessionLink,
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
      // api-contracts.md §1: the server envelope carries the STABLE machine
      // code in error.code and the human message in error.message — expose
      // both faithfully (error.code = machine code, error.message =
      // `${code}: ${message}`), so callers can map stable copy per code.
      let code = ''
      let message = ''
      try {
        const parsed = await response.json() as { error?: { code?: string; message?: string } }
        code = parsed.error?.code ?? ''
        message = parsed.error?.message ?? ''
      } catch { /* keep empty */ }
      if (code === '') code = `http_${response.status}`
      if (message === '') message = `request ${method} ${path} failed`
      throw new KernelApiError(response.status, code, message)
    }
    return (await response.json()) as T
  }

  /**
   * Raw-body request (multipart uploads): identical error semantics to
   * {@link request} (KernelUnavailableError / KernelApiError with the stable
   * server error code), but the caller supplies the exact body bytes and the
   * content-type header instead of a JSON payload.
   */
  private async requestRaw<T>(method: string, path: string, body: Uint8Array, headers: Record<string, string> = {}): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.endpoint}${path}`, {
        method,
        headers: {
          ...this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {},
          ...this.serviceToken !== undefined ? { 'x-service-token': this.serviceToken } : {},
          ...headers,
        },
        body: body as BodyInit,
        signal: controller.signal,
      })
    } catch (error) {
      throw new KernelUnavailableError(this.endpoint, error)
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      let code = ''
      let message = ''
      try {
        const parsed = await response.json() as { error?: { code?: string; message?: string } }
        code = parsed.error?.code ?? ''
        message = parsed.error?.message ?? ''
      } catch { /* keep empty */ }
      if (code === '') code = `http_${response.status}`
      if (message === '') message = `request ${method} ${path} failed`
      throw new KernelApiError(response.status, code, message)
    }
    return (await response.json()) as T
  }

  health(): Promise<{ ok: boolean; instance: string }> {
    return this.request('GET', '/v1/health')
  }

  // ── paper reproduction (docs/reproduction-contracts.md §4) ───────────────

  /** REPRO-01: create (or idempotently restore) a PaperReproductionSpec. */
  createReproductionSpec(input: {
    project_id: string
    paper_ref: PaperRef
    source_locator?: string
    source_artifact_id?: string | null
    reproduction_level?: string
    claims_to_reproduce?: unknown[]
    code_source?: unknown | null
    data_inputs?: unknown[]
    execution_binding?: unknown | null
    environment_lock?: unknown
    expected_outputs?: string[]
    metric_comparators?: unknown[]
    idempotency_key?: string
  }): Promise<PaperReproductionSpec> {
    return this.request('POST', `/v2/projects/${input.project_id}/reproduction-specs`, input)
  }

  listReproductionSpecs(projectId: string): Promise<PaperReproductionSpec[]> {
    return this.request('GET', `/v2/projects/${projectId}/reproduction-specs`)
  }

  getReproductionSpec(projectId: string, specId: string): Promise<PaperReproductionSpec> {
    return this.request('GET', `/v2/projects/${projectId}/reproduction-specs/${specId}`)
  }

  /** REPRO-01: revision-CAS patch of a spec (stale revision → 409). */
  updateReproductionSpec(projectId: string, specId: string, input: {
    expected_revision: number
    patch: Record<string, unknown>
  }): Promise<PaperReproductionSpec> {
    return this.request('PATCH', `/v2/projects/${projectId}/reproduction-specs/${specId}`, input)
  }

  /** REPRO-01: start one attempt — returns attempt + generation + lease
   *  token (the token is the caller's fencing credential for the report). */
  startReproductionAttempt(projectId: string, specId: string, input: {
    submitter_principal?: string
    reason?: string
    job_id?: string | null
    run_id?: string | null
    code_snapshot_id?: string | null
    approved_contract_version?: number | null
    idempotency_key?: string
  }): Promise<{ attempt: ReproductionAttempt; generation: number; lease_token: string | null }> {
    return this.request('POST', `/v2/projects/${projectId}/reproduction-specs/${specId}/attempts`, input)
  }

  getReproductionAttempt(projectId: string, attemptId: string): Promise<ReproductionAttempt> {
    return this.request('GET', `/v2/projects/${projectId}/reproduction-attempts/${attemptId}`)
  }

  /**
   * REPRO-01 §4: verifier service path — record the immutable report on an
   * attempt. Only reachable with the service token (x-service-token) plus
   * x-service-principal: verifier; the report is fenced by the attempt
   * generation + lease token from startReproductionAttempt.
   */
  reportReproductionAttempt(attemptId: string, input: ReproductionReportInput & {
    idempotency_key?: string
  }): Promise<ReproducibilityReport> {
    const { idempotency_key: idem, ...report } = input
    return this.request('POST', `/internal/reproduction-attempts/${attemptId}/reports`, report, {
      'x-service-principal': 'verifier',
      ...(idem !== undefined && idem !== '' ? { 'idempotency-key': idem } : {}),
    })
  }

  getReproductionReport(projectId: string, reportId: string): Promise<ReproducibilityReport> {
    return this.request('GET', `/v2/projects/${projectId}/reproduction-reports/${reportId}`)
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

  deleteProject(projectId: string, input: {
    expected_revision: number
    confirm_name: string
    reason: string
    principal_id: string
    request_id: string
  }): Promise<ProjectDeletionReceipt> {
    const { principal_id, request_id, ...body } = input
    return this.request('DELETE', `/v1/projects/${projectId}`, body, {
      'x-principal-id': principal_id,
      'x-request-id': request_id,
    })
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

  // ── onboarding intake (ONBOARD-01, research-onboarding.md) ────────────────
  // Agent-facing prepare pipeline: begin → stage → scan → answers → propose.
  // Adoption (adopt/reject) is NOT exposed here — the Agent surface stops at
  // propose (research-onboarding.md §2; only the Human PI/BFF path adopts).

  /** Create (or recover the single active) Intake session for a project. */
  beginIntake(projectId: string, input: {
    source_label: string
    target_phase?: ObservedPhase | null
    expires_in_ms?: number
    idempotency_key?: string
    request_hash?: string
  }): Promise<IntakeSession> {
    return this.request('POST', `/v1/projects/${projectId}/intake`, {
      source_label: input.source_label,
      target_phase: input.target_phase ?? null,
      expires_in_ms: input.expires_in_ms,
      idempotency_key: input.idempotency_key,
      request_hash: input.request_hash,
    })
  }

  listIntakes(projectId: string): Promise<IntakeSession[]> {
    return this.request('GET', `/v1/projects/${projectId}/intake`)
  }

  /** Full resumable intake state (session + artifacts + observations + questions + proposal). */
  intakeProjection(projectId: string, intakeId: string): Promise<IntakeProjection> {
    return this.request('GET', `/v1/projects/${projectId}/intake/${encodeURIComponent(intakeId)}`)
  }

  /**
   * Stage ONE file into the isolated intake staging CAS (multipart, ≤32 MiB,
   * server-computed sha256; identical bytes are content-addressed idempotent).
   * The client decodes base64 and builds the multipart body itself — no
   * project artifact row is written before adoption (pre-accept zero authority).
   */
  stageIntakeArtifact(projectId: string, intakeId: string, input: {
    file_name: string
    content_base64: string
    media_type?: string
  }): Promise<IntakeArtifact> {
    const bytes = Buffer.from(input.content_base64, 'base64')
    const boundary = `----dshScholarIntake${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
    const mediaType = input.media_type ?? 'application/octet-stream'
    const crlf = Buffer.from('\r\n')
    const enc = (text: string): Buffer => Buffer.from(text, 'utf8')
    const chunks: Buffer[] = []
    const pushField = (name: string, value: string): void => {
      chunks.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
    }
    pushField('file_name', input.file_name)
    pushField('media_type', mediaType)
    chunks.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.file_name.replaceAll('"', '')}"\r\nContent-Type: ${mediaType}\r\n\r\n`))
    chunks.push(bytes, crlf, enc(`--${boundary}--\r\n`))
    const body = Buffer.concat(chunks)
    return this.requestRaw('POST', `/v1/projects/${projectId}/intake/${encodeURIComponent(intakeId)}/artifacts`, body, {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    })
  }

  /** Deterministic static security scan; returns the resumable projection. */
  scanIntake(projectId: string, intakeId: string): Promise<IntakeProjection> {
    return this.request('POST', `/v1/projects/${projectId}/intake/${encodeURIComponent(intakeId)}/scan`)
  }

  /** Deterministic Grill Me question set for the session's target phase. */
  intakeQuestions(projectId: string, intakeId: string): Promise<{ questions: GrillAnswerView[] }> {
    return this.request('GET', `/v1/projects/${projectId}/intake/${encodeURIComponent(intakeId)}/questions`)
  }

  /** Record Grill Me answers (provenance recorded server-side per principal). */
  submitIntakeAnswers(projectId: string, intakeId: string, answers: GrillAnswerInput[], principal: HumanPrincipal): Promise<IntakeProjection> {
    return this.request('POST', `/v1/projects/${projectId}/intake/${encodeURIComponent(intakeId)}/answers`, { answers, principal })
  }

  /** Deterministic PhaseProposal; the intake then waits for a Human PI. */
  proposeIntake(projectId: string, intakeId: string): Promise<PhaseProposal> {
    return this.request('POST', `/v1/projects/${projectId}/intake/${encodeURIComponent(intakeId)}/propose`)
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
   * §11.3 (SCH-EXEC-002): archive a project workspace's ACTUAL file contents
   * into a content-addressed `code` artifact (+ `manifest` artifact). The
   * Runner materializes jobs from this snapshot — never from agent host dirs.
   * P0-4 (SNAPSHOT-01/API-01): only `workspace_id` + a root-relative path are
   * accepted; `rootRelativePath` '' (default) archives the whole workspace.
   * The deprecated host-`path` shape is refused by the server (422).
   */
  snapshotCodeArchive(projectId: string, workspaceId: string, rootRelativePath = '', description?: string): Promise<{
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
    return this.request('POST', `/v1/projects/${projectId}/code-snapshots`, { workspace_id: workspaceId, root_relative_path: rootRelativePath, description })
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
      const response = await fetch(`${this.endpoint}/v1/artifacts/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`, {
        // §5 P0-1 (hardening API-01/SIDE-01): token-configured kernels reject
        // bearer-less requests with 401 — the client must authenticate here
        // exactly like the typed request() path above.
        headers: { ...this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {} },
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) return null
      return await response.text()
    } catch {
      return null
    }
  }

  /**
   * RUN-REMOTE-01（hardening §5 两行 / acceptance remote-cas-binary-auth）：
   * **字节流** CAS 拉取——`arrayBuffer()` 原样返回，绝不经过 `text()`/
   * UTF-8 编解码（随机二进制/PDF/压缩包/NUL 字节往返无损）。404 → null；
   * 其余非 2xx（含 token-configured kernel 的 401）抛 KernelApiError——
   * 调用方 fail fast，不把鉴权失败误判为 cas_missing。
   */
  async fetchArtifactBytes(projectId: string, sha256OrId: string): Promise<{ content: Buffer; media_type: string | null } | null> {
    const id = sha256OrId.startsWith('sha256:') ? sha256OrId : `sha256:${sha256OrId}`
    let response: Response
    try {
      response = await fetch(`${this.endpoint}/v1/artifacts/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`, {
        headers: { ...this.token !== undefined ? { authorization: `Bearer ${this.token}` } : {} },
        signal: AbortSignal.timeout(15000),
      })
    } catch (error) {
      throw new KernelUnavailableError(this.endpoint, error)
    }
    if (response.status === 404) return null
    if (!response.ok) {
      let detail = ''
      try {
        const parsed = await response.json() as { error?: { code?: string; message?: string } }
        detail = parsed.error?.message ?? ''
      } catch { /* keep empty */ }
      throw new KernelApiError(response.status, detail || `http_${response.status}`, detail || `request GET artifact ${id} failed`)
    }
    const mediaType = response.headers.get('content-type')
    return { content: Buffer.from(await response.arrayBuffer()), media_type: mediaType }
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

  // ── trajectory & subagent topology (TRAJ-01/SUBAGENT-01) ────────────────

  /** Read-only, redacted outbox projection (keyset pagination; single page
   * ≤ 500). `lane` filters Research vs Session; pass `next_after_seq` +
   * `next_after_event_id` from the previous page to continue. */
  projectTrajectory(projectId: string, opts: {
    after_seq?: number
    after_event_id?: string
    limit?: number
    lane?: 'research' | 'session'
  } = {}): Promise<{
    project_id: string
    entries: Array<{
      entry_id: string
      event_seq: number
      event_version: number
      project_id: string
      aggregate_type: string | null
      aggregate_id: string | null
      kind: string
      lane: 'research' | 'session'
      source: string
      occurred_at: string
      session_id: string | null
      summary: string
      status: string | null
    }>
    next_after_seq: number | null
    next_after_event_id: string | null
    has_more: boolean
    total: number
    limit: number
    lane: 'research' | 'session' | null
  }> {
    const query = new URLSearchParams()
    if (opts.after_seq !== undefined) query.set('after_seq', String(opts.after_seq))
    if (opts.after_event_id !== undefined) query.set('after_event_id', opts.after_event_id)
    if (opts.limit !== undefined) query.set('limit', String(opts.limit))
    if (opts.lane !== undefined) query.set('lane', opts.lane)
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return this.request('GET', `/v1/projects/${projectId}/trajectory${suffix}`)
  }

  /** Research + Session lanes for one project (both always returned). */
  projectTrajectoryLanes(projectId: string, opts: { limit?: number } = {}): Promise<Record<string, unknown>> {
    const query = opts.limit !== undefined ? `?limit=${opts.limit}` : ''
    return this.request('GET', `/v1/projects/${projectId}/trajectory-lanes${query}`)
  }

  /** Exact direct children of a parent (or roots when parent_id omitted). */
  projectTopology(projectId: string, opts: {
    parent_id?: string | null
    after_seq?: number
    limit?: number
  } = {}): Promise<{
    project_id: string
    parent_id: string | null
    items: Array<{
      child_id: string
      project_id: string
      parent_id: string | null
      label: string | null
      summary: string
      kind: 'subagent' | 'task'
      mode: 'one-shot' | 'continuable' | 'read-only'
      state: string
      role: string | null
      started_at: string
      ended_at: string | null
      has_children: boolean
      children_count: number
      seq: number
      refs: Array<{ kind: string; id: string }>
    }>
    total: number
    next_after_seq: number | null
    has_more: boolean
  }> {
    const query = new URLSearchParams()
    if (opts.parent_id !== undefined && opts.parent_id !== null) query.set('parent_id', opts.parent_id)
    if (opts.after_seq !== undefined) query.set('after_seq', String(opts.after_seq))
    if (opts.limit !== undefined) query.set('limit', String(opts.limit))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return this.request('GET', `/v1/projects/${projectId}/topology${suffix}`)
  }

  /** Exact parent + breadcrumb for one child (opaque deep-link id). */
  childDetail(childId: string): Promise<{
    child_id: string
    project_id: string
    node: Record<string, unknown>
    parent: Record<string, unknown> | null
    breadcrumb: Array<Record<string, unknown>>
  }> {
    return this.request('GET', `/v1/topology/${encodeURIComponent(childId)}`)
  }

  /** Read-only per-child history (started/state/followup) — never activates
   * the child. */
  childHistory(childId: string, opts: { after_seq?: number; limit?: number } = {}): Promise<{
    child_id: string
    project_id: string
    items: Array<{
      seq: number
      event_id: string
      child_id: string
      type: string
      occurred_at: string
      summary: string
    }>
    next_after_seq: number | null
    has_more: boolean
    total: number
  }> {
    const query = new URLSearchParams()
    if (opts.after_seq !== undefined) query.set('after_seq', String(opts.after_seq))
    if (opts.limit !== undefined) query.set('limit', String(opts.limit))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return this.request('GET', `/v1/topology/${encodeURIComponent(childId)}/history${suffix}`)
  }

  /** One-shot READ-ONLY followup: records the message and returns
   * message_id WITHOUT executing it — child state never changes. */
  childFollowup(childId: string, message: string): Promise<{
    message_id: string
    child_id: string
    project_id: string
    accepted: boolean
    read_only: boolean
    state_unchanged: boolean
    note: string
  }> {
    return this.request('POST', `/v1/topology/${encodeURIComponent(childId)}/followup`, { message })
  }

  /** Record a spawned subagent child (research_panel wiring; the kernel
   * surface + unit tests cover the contract this round). */
  registerChildLink(input: {
    child_id: string
    parent_id?: string | null
    label?: string | null
    summary?: string
    kind?: 'subagent' | 'task'
    mode?: 'one-shot' | 'continuable' | 'read-only'
    role?: string | null
    state?: 'running' | 'inactive' | 'diagnostic' | 'succeeded' | 'failed' | 'redacted' | 'unknown'
  } & { project_id: string }): Promise<Record<string, unknown>> {
    const { project_id: projectId, ...body } = input
    return this.request('POST', `/v1/projects/${projectId}/topology/children`, body)
  }

  /** Transition a child's state (append-only history + outbox). */
  updateChildState(childId: string, state: 'running' | 'inactive' | 'diagnostic' | 'succeeded' | 'failed' | 'redacted' | 'unknown'): Promise<Record<string, unknown>> {
    return this.request('PATCH', `/v1/topology/${encodeURIComponent(childId)}/state`, { state })
  }
}
