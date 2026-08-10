/**
 * Research Kernel HTTP API (design §8.3) — a minimal, versioned JSON API on
 * node:http. The DSH plugin and the runner gateway are the primary clients.
 * @module @dsh-scholar/research-kernel/server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { ResearchKernel, KernelError, TEX_ENGINES, validateUploadFileName } from './kernel.js'
import { TexError } from './tex-workspace.js'
import { PtyError } from './pty-session.js'
import { WorkspaceError } from './workspace-store.js'
import { PtyOpenRequest, PtyControlRequest } from '@dsh-scholar/research-schemas'
import {
  UPLOAD_MAX_BODY_BYTES, extractBoundary, parseMultipart,
  type MultipartPart,
} from './uploads.js'

export interface KernelServerOptions {
  kernel: ResearchKernel
  host?: string
  port?: number
  /** Optional static bearer token for local loopback auth. */
  token?: string
  /** §12.7: require signed run manifests (also settable on the kernel itself). */
  requireSignedManifest?: boolean
  /**
   * CONFIG-01: sha256 pin of the deployment's effective config (computed by
   * the CLI through the canonical Config Registry). When omitted the kernel's
   * own configPinHash is used; exposed via the `x-config-pin` response header
   * and the `/v1|v2/health` `config_pin` field.
   */
  configPinHash?: string
}

const idSchema = z.string().min(1)

/** Canonical artifact kind list (schema + upload route share it). */
const ARTIFACT_KINDS = ['code', 'pdf', 'data', 'log', 'model', 'chart', 'paper', 'analysis', 'manifest', 'bundle'] as const

const terminalFramesSchema = z.object({
  run_id: z.string().min(1),
  frames: z.array(z.object({
    seq: z.number().int().nonnegative(),
    stream_seq: z.number().int().nonnegative().nullable().optional(),
    channel: z.enum(['stdout', 'stderr']).nullable().optional(),
    text: z.string().nullable().optional(),
    byte_offset: z.number().int().nonnegative().nullable().optional(),
    byte_length: z.number().int().nonnegative().nullable().optional(),
    frame_kind: z.enum(['chunk', 'gap', 'exit']),
    payload_json: z.string().optional(),
    lease_generation: z.number().int().nonnegative().optional(),
  })).min(1).max(256),
  max_log_bytes: z.number().int().positive().optional(),
  // §4 P0 (TERM-01): lease owner/token MAY travel in the body as a fallback;
  // the x-lease-owner/x-lease-token headers take precedence (runner client).
  owner: z.string().optional(),
  lease_token: z.string().nullable().optional(),
}).strict()

const createProjectSchema = z.object({
  name: z.string().min(1),
  workspace: z.string().min(1),
  brief: z.unknown(),
  mode: z.enum(['gate-only', 'full-auto']).optional(),
  constraints: z.record(z.unknown()).optional(),
  execution: z.record(z.unknown()).optional(),
  integrity: z.record(z.unknown()).optional(),
  session_id: z.string().nullable().optional(),
  dsh_workspace_id: z.string().nullable().optional(),
  // API-01: the caller (BFF) resolves the authenticated principal and seeds
  // the creator PI membership; callers never submit actor/principal fields.
  creator_principal_id: z.string().optional(),
  creator_tenant_id: z.string().optional(),
})

const transitionSchema = z.object({
  to: z.string().min(1),
  expected_revision: z.number().int().nonnegative(),
  reason: z.string().optional(),
})

const gateSchema = z.object({
  type: z.enum(['scope', 'idea', 'contract', 'budget', 'release']),
  title: z.string().min(1),
  summary: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
  session_id: z.string().nullable().optional(),
})

const decisionSchema = z.object({
  // GOV-01: `actor` is a legacy display label only — the identity is the
  // REQUIRED `principal` below. The route rejects requests without a
  // principal (422 principal_required, fail-closed) and defaults actor to
  // principal.principal_id when omitted. The only actor-based exception is
  // the internal orchestrator approve route (contracts/{id}/approve), which
  // is not a Human Gate decision.
  actor: z.string().min(1).optional(),
  principal: z.object({
    principal_id: z.string().min(1),
    tenant_id: z.string().optional(),
    auth_method: z.string().optional(),
    session_id: z.string().nullable().optional(),
  }),
  decision: z.enum(['approved', 'rejected', 'revised']),
  // gui-plugin-plan §6: reject/revise must carry the operator's rationale.
  reason: z.string().optional().superRefine((value, ctx) => {
    // refined below against the decision (schema-level cross-field check).
    void value; void ctx
  }),
  diff: z.string().optional(),
  session_id: z.string().nullable().optional(),
  event_id: z.string().nullable().optional(),
}).superRefine((value, ctx) => {
  if ((value.decision === 'rejected' || value.decision === 'revised') && (value.reason === undefined || value.reason.trim() === '')) {
    ctx.addIssue({ code: 'custom', message: 'reason is required for rejected/revised decisions', path: ['reason'] })
  }
})

const artifactSchema = z.object({
  project_id: z.string().min(1),
  kind: z.enum(ARTIFACT_KINDS),
  content_base64: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  media_type: z.string().min(1).optional(),
  file_name: z.string().min(1).optional(),
})

const corpusSchema = z.object({
  project_id: z.string().min(1).optional(),
  queries: z.array(z.object({ source: z.enum(['openalex', 'crossref', 'arxiv', 'semantic-scholar']), query: z.string(), run_at: z.string() })).default([]),
  papers: z.array(z.unknown()),
  passages: z.array(z.unknown()).optional(),
  citation_edges: z.array(z.unknown()).optional(),
  external_claims: z.array(z.unknown()).optional(),
})

const contractSchema = z.object({
  project_id: z.string().min(1).optional(),
  idea_id: z.string().min(1),
  baseline_run: z.string().optional(),
  code_snapshot: z.string().optional(),
  data: z.object({ dataset_id: z.string().min(1), version: z.string().optional(), split: z.string().optional(), preprocessing_hash: z.string().optional() }),
  methods: z.object({ baseline: z.string().min(1), treatment: z.string().min(1) }),
  metrics: z.object({ primary: z.string().min(1), secondary: z.array(z.string()).optional(), direction: z.enum(['higher_is_better', 'lower_is_better']).optional() }),
  seeds: z.array(z.number().int()).optional(),
  analysis: z.record(z.unknown()).optional(),
  ablations: z.array(z.string()).optional(),
  stop_conditions: z.record(z.unknown()).optional(),
})

const jobSchema = z.object({
  project_id: z.string().min(1).optional(),
  idempotency_key: z.string().min(1),
  kind: z.enum(['echo', 'smoke', 'baseline', 'pilot', 'formal', 'analysis', 'reproduce']),
  command: z.array(z.string()).optional(),
  payload: z.record(z.unknown()).optional(),
  contract_id: z.string().nullable().optional(),
  max_attempts: z.number().int().positive().optional(),
  // §12.2 JobSpec binding (SCH-EXEC-002).
  code_snapshot_id: z.string().nullable().optional(),
  data_artifact_ids: z.array(z.string()).optional(),
  image_digest: z.string().optional(),
  output_contract: z.object({ metrics: z.string(), logs: z.string() }).optional(),
})

const codeSnapshotSchema = z.object({
  path: z.string().min(1),
  description: z.string().optional(),
})

const jobCompleteSchema = z.object({
  owner: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  run_manifest: z.record(z.unknown()).optional(),
  failure_class: z.enum(['environment', 'resources', 'code_error', 'data_issue', 'no_improvement', 'unstable_results', 'budget_exhausted', 'unknown']).nullable().optional(),
  error: z.string().optional(),
  // §12.6 lease fencing: when provided, both must match the current lease.
  lease_generation: z.number().int().nonnegative().nullable().optional(),
  lease_token: z.string().nullable().optional(),
})

const runnerKeySchema = z.object({
  key_id: z.string().min(1),
  public_key_pem: z.string().min(1),
})

const ideaSchema = z.object({
  project_id: z.string().min(1).optional(),
  title: z.string().min(1),
  hypothesis: z.string().min(1),
  scientific_gap: z.record(z.unknown()).optional(),
  nearest_prior_works: z.array(z.record(z.unknown())).optional(),
  exact_delta: z.string().min(1),
  falsification: z.object({ observation: z.string().min(1) }),
  minimum_viable_experiment: z.record(z.unknown()),
  novelty_audit: z.record(z.unknown()).optional(),
  scores: z.object({
    feasibility: z.number().int().min(1).max(5),
    information_gain: z.number().int().min(1).max(5),
    reproducibility: z.number().int().min(1).max(5),
    cost: z.number().int().min(1).max(5),
  }),
  risk_notes: z.string().optional(),
})

const evidenceSchema = z.object({
  project_id: z.string().min(1).optional(),
  source_type: z.enum(['run', 'analysis', 'external-passage', 'reproduction']),
  run_ids: z.array(z.string()).optional(),
  artifact_refs: z.array(z.string()).optional(),
  analysis_method: z.string().min(1),
  result: z.record(z.unknown()),
  uncertainty: z.string().optional(),
  // v2 §13.1 / §6: agent-facing write defaults to draft_unverified; 'verified'
  // and 'accepted' are internal states (Analysis-Worker / Verifier-Auditor
  // accept) and are REJECTED on the public route (hardening EVID-01).
  provenance_status: z.enum(['draft_unverified', 'legacy_unverified']).optional(),
})

const claimVerifySchema = z.object({
  claim_id: z.string().min(1),
  evidence_ids: z.array(z.string()).min(1),
  analysis_artifact: z.string().optional(),
  reason: z.string().optional(),
})

const claimCreateSchema = z.object({
  project_id: z.string().min(1).optional(),
  statement: z.string().min(1),
  scope: z.record(z.unknown()).optional(),
})

const budgetSchema = z.object({
  model_cost_usd: z.number().nonnegative().optional(),
  gpu_hours: z.number().nonnegative().optional(),
  api_requests: z.number().int().nonnegative().optional(),
})

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 32 * 1024 * 1024) {
        reject(new KernelError(413, 'payload_too_large', 'request body exceeds 32 MiB'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new KernelError(400, 'invalid_json', 'request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * UPLOAD-01: read a raw request body into a Buffer with a hard cap. The cap
 * is the file limit plus a bounded multipart envelope allowance (headers +
 * boundaries), so a file at the exact 32 MiB limit still fits while an
 * oversized upload is rejected mid-stream (413 payload_too_large).
 */
function readBodyBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return // past the cap: keep draining (bounded memory) so
      // the client can still read our 413 response — destroying the socket
      // here would surface as a client-side connection error instead.
      size += chunk.length
      if (size > limit) {
        settle(() => reject(new KernelError(413, 'payload_too_large',
          `upload body exceeds ${limit} bytes (max_file_bytes=${ResearchKernel.UPLOAD_MAX_FILE_BYTES} plus envelope overhead)`)))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks))))
    req.on('error', (error: Error) => settle(() => reject(error)))
    req.on('close', () => settle(() => reject(new KernelError(400, 'invalid_multipart', 'request closed before the upload body was complete'))))
  })
}

/** Form-field text helper: a part's UTF-8 payload trimmed, or undefined. */
function fieldText(parts: MultipartPart[], name: string): string | undefined {
  const part = parts.find(p => p.name === name)
  if (part === undefined) return undefined
  const text = part.data.toString('utf8').trim()
  return text === '' ? undefined : text
}

/**
 * UPLOAD-01 (api-contracts.md §7): POST /v1/projects/{id}/uploads —
 * multipart/form-data single-file artifact upload with staged finalize
 * semantics:
 *
 *   - fields: `kind` (required ArtifactKind), `file` (required file part),
 *     `file_name` (optional, defaults to the part's filename), `media_type`
 *     (optional);
 *   - server-side sha256 binding: the hash recorded on the artifact is
 *     computed over the bytes actually received (never a client claim);
 *   - size cap: ≤ 32 MiB per file (413 payload_too_large; the streaming body
 *     reader rejects oversized requests before they are buffered in full);
 *   - path safety: the file name must be a plain basename (validateUpload-
 *     FileName) — absolute paths, `..`, NUL and Windows drive prefixes are
 *     rejected (422 invalid_file_name); multiple file parts are rejected
 *     (422 multiple_files; duplicate normalized paths are an archive concern
 *     enforced by the code-snapshot walk);
 *   - staged → finalize: bytes land in a session-id'd staging file first,
 *     then finalizeStagedUpload atomically promotes them into the CAS blob
 *     slot + artifact row; any failure rolls the stage back;
 *   - idempotency: the same project + sha256 + file_name returns the
 *     ORIGINAL artifact (HTTP 200, `reused: true`) without re-writing;
 *   - GC/recovery: expired staged files are collected by
 *     kernel.cleanupStagedUploads (24 h default TTL).
 */
async function handleUpload(req: IncomingMessage, res: ServerResponse, kernel: ResearchKernel, projectId: string): Promise<void> {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || !contentType.trim().toLowerCase().startsWith('multipart/form-data')) {
    throw new KernelError(415, 'unsupported_media_type', 'artifact upload requires multipart/form-data')
  }
  const boundary = extractBoundary(contentType)
  if (boundary === null || boundary === '') {
    throw new KernelError(400, 'invalid_multipart', 'multipart/form-data boundary is missing or malformed')
  }
  const body = await readBodyBytes(req, UPLOAD_MAX_BODY_BYTES)
  let parts: MultipartPart[]
  try {
    parts = parseMultipart(body, boundary)
  } catch (error) {
    throw new KernelError(400, 'invalid_multipart', `malformed multipart body: ${(error as Error).message}`)
  }
  const fileParts = parts.filter(p => p.fileName !== undefined)
  if (fileParts.length === 0) {
    throw new KernelError(422, 'missing_file', 'upload requires exactly one file part (name="file", with a filename)')
  }
  if (fileParts.length > 1) {
    throw new KernelError(422, 'multiple_files', 'single-file uploads must not carry more than one file part')
  }
  const filePart = fileParts[0]!
  const kindRaw = fieldText(parts, 'kind')
  const kindCheck = z.enum(ARTIFACT_KINDS).safeParse(kindRaw)
  if (!kindCheck.success) {
    throw new KernelError(422, 'invalid_kind', `upload kind must be one of ${ARTIFACT_KINDS.join('/')}`)
  }
  // The registered download name: explicit file_name field wins, otherwise
  // the part's filename. Both are validated as plain basenames.
  const rawName = fieldText(parts, 'file_name') ?? filePart.fileName!
  validateUploadFileName(rawName)
  if (filePart.data.byteLength > ResearchKernel.UPLOAD_MAX_FILE_BYTES) {
    throw new KernelError(413, 'payload_too_large',
      `upload exceeds the size limit: ${filePart.data.byteLength} bytes (max_file_bytes=${ResearchKernel.UPLOAD_MAX_FILE_BYTES})`)
  }
  const mediaType = fieldText(parts, 'media_type')
  const stage = kernel.stageUploadContent({
    project_id: projectId,
    kind: kindCheck.data,
    file_name: rawName,
    media_type: mediaType,
    content: filePart.data,
  })
  const { record, reused } = kernel.finalizeStagedUpload(stage.stage_id)
  send(res, reused ? 200 : 201, { ...record, reused })
}

function errorEnvelope(code: string, message: string): Record<string, unknown> {
  // api-contracts.md §1: stable retryable flags for the documented codes.
  const retryableCodes = new Set(['lease_conflict', 'lease_stale', 'upload_offset_conflict', 'document_version_conflict'])
  return { code, message, request_id: currentRequestId, retryable: retryableCodes.has(code) }
}

/**
 * §4 P0 (hardening API-01/EVID-01): INTERNAL service routes. When the kernel
 * was configured with a service token, EVERY one of these demands the
 * `x-service-token` header — the loopback bearer credential (browser) and
 * self-reported `x-service-principal` headers do NOT satisfy it, so a
 * browser session can never claim jobs, register runner keys, recover
 * leases, write verified evidence, accept evidence or freeze contracts.
 * Route patterns are matched on the RAW pathname; the handlers below also
 * require the correct x-service-principal on the evidence routes.
 */
const SERVICE_ROUTES: ReadonlyArray<{ method: string; re: RegExp; label: string }> = [
  { method: 'POST', re: /^\/v1\/jobs-claim\/run$/, label: 'jobs-claim' },
  { method: 'POST', re: /^\/v1\/runner-keys$/, label: 'runner-keys' },
  { method: 'POST', re: /^\/v1\/recover\/leases$/, label: 'recover/leases' },
  { method: 'POST', re: /^\/v1\/projects\/[^/]+\/evidence\/verified$/, label: 'evidence/verified' },
  { method: 'POST', re: /^\/v1\/projects\/[^/]+\/evidence\/[^/]+\/accept$/, label: 'evidence/accept' },
  { method: 'POST', re: /^\/v1\/projects\/[^/]+\/contracts\/[^/]+\/approve$/, label: 'contracts/approve' },
]

function isServiceRoute(method: string, pathname: string): boolean {
  return SERVICE_ROUTES.some(r => r.method === method && r.re.test(pathname))
}

/** Constant-time comparison: hash both sides then timingSafeEqual. */
function serviceTokenEquals(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

let currentRequestId = 'req_unknown'

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function ok(res: ServerResponse, body: unknown): void {
  send(res, 200, body)
}

function fail(res: ServerResponse, error: unknown): void {
  if (error instanceof KernelError) {
    send(res, error.status, { error: errorEnvelope(error.code, error.message) })
  } else if (error instanceof TexError) {
    // CAS write conflicts and invalid TeX paths map to HTTP semantics.
    const status = error.code === 'document_version_conflict' ? 409 : 422
    send(res, status, { error: errorEnvelope(error.code, error.message) })
  } else if (error instanceof PtyError) {
    // PTY-01 wire mapping: not found → 404, idempotency/state conflicts →
    // 409, open/param validation → 422, adapter absence → 501/503.
    const status = error.code === 'pty_session_not_found' ? 404
      : error.code === 'pty_state_conflict' || error.code === 'pty_client_seq_out_of_order' || error.code === 'pty_session_closed' ? 409
        : error.code === 'pty_adapter_failed' ? 503
          : 422
    send(res, status, { error: errorEnvelope(error.code, error.message) })
  } else if (error instanceof WorkspaceError) {
    // WORK-01 wire mapping: version/etag/destination conflicts → 409,
    // missing nodes/workspaces → 404, path/binary/kind validation → 422.
    const status = error.code === 'workspace_not_found' || error.code === 'workspace_file_not_found' ? 404
      : error.code === 'workspace_version_conflict' || error.code === 'workspace_etag_conflict' || error.code === 'workspace_move_destination_exists' ? 409
        : 422
    send(res, status, { error: errorEnvelope(error.code, error.message) })
  } else if (error instanceof z.ZodError) {
    const issues = error.issues.map(i => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
    send(res, 422, { error: errorEnvelope('validation_error', issues) })
  } else {
    send(res, 500, { error: errorEnvelope('internal', (error as Error).message ?? String(error)) })
  }
}

function route(req: IncomingMessage, res: ServerResponse, kernel: ResearchKernel, token: string | undefined, configPin: string | undefined): void {
  currentRequestId = typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'] !== ''
    ? req.headers['x-request-id']
    : `req_${Math.random().toString(36).slice(2, 12)}`
  // CONFIG-01: every response carries the effective-config pin so running
  // objects can be correlated with the config that produced them. The header
  // is set before any writeHead and therefore lands on every answer.
  if (configPin !== undefined && configPin !== '') res.setHeader('x-config-pin', configPin)
  if (token !== undefined) {
    const provided = req.headers.authorization
    if (provided !== `Bearer ${token}`) {
      send(res, 401, { error: { code: 'unauthorized', message: 'missing or invalid bearer token' } })
      return
    }
  }
  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1')
  } catch {
    send(res, 400, { error: { code: 'invalid_url', message: 'malformed request url' } })
    return
  }
  // pathname is percent-encoded; decode segments so ids like sha256:<hex>
  // survive (encodeURIComponent on the client side). A malformed escape
  // (e.g. %zz) must answer JSON 400 — never crash the server (§19.2).
  let parts: string[]
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent) // e.g. ['v1','projects','rsp_x']
  } catch {
    send(res, 400, { error: { code: 'invalid_encoding', message: 'malformed percent-encoding in path' } })
    return
  }

  const method = req.method ?? 'GET'
  // §4 P0 (API-01/EVID-01): internal service routes require the configured
  // service token via `x-service-token` — the loopback bearer (Authorization)
  // and any self-reported x-service-principal do NOT unlock these routes.
  // A missing/wrong/misplaced credential is 403 service_token_required.
  if (kernel.serviceToken !== undefined && isServiceRoute(method, url.pathname)) {
    const provided = req.headers['x-service-token']
    if (typeof provided !== 'string' || !serviceTokenEquals(provided, kernel.serviceToken)) {
      send(res, 403, {
        error: errorEnvelope('service_token_required',
          'internal route requires x-service-token (service identity); browser bearer credentials are not accepted'),
      })
      return
    }
  }
  const [version, resource, id, sub, subId] = parts as [string | undefined, string | undefined, string | undefined, string | undefined, string | undefined]
  if (version !== 'v1' && version !== 'v2') {
    send(res, 404, { error: { code: 'not_found', message: 'unknown api version' } })
    return
  }
  // §4 P1 (UPLOAD-01): multipart artifact upload — staged, hash-bound,
  // idempotent (api-contracts.md §7 / acceptance-tests.md §3.1). Routed
  // before readJson: the body is raw multipart, not JSON.
  if (method === 'POST' && version === 'v1' && resource === 'projects' && id !== undefined && sub === 'uploads' && subId === undefined) {
    void handleUpload(req, res, kernel, id).catch((error: unknown) => fail(res, error))
    return
  }
  if (version === 'v2') {
    void readJson(req).then(async (body) => {
      try {
        await handleV2({ req, res, method, url, id, sub, subId, body, kernel, configPin })
      } catch (error) {
        if (error instanceof KernelError) send(res, error.status, { error: { code: error.code, message: error.message } })
        else {
          console.error(`[kernel] v2 handler error: ${(error as Error).message}`)
          send(res, 500, { error: { code: 'internal_error', message: 'internal error' } })
        }
      }
    })
    return
  }

  void readJson(req).then(async (body) => {
    try {
      switch (resource) {
        case 'health': {
          ok(res, { ok: true, instance: kernel.instanceId, config_pin: configPin ?? kernel.configPinHash, time: new Date().toISOString() })
          return
        }
        case 'projects': {
          if (method === 'POST' && id === undefined) {
            const input = createProjectSchema.parse(body)
            const project = kernel.createProject(input as Parameters<ResearchKernel['createProject']>[0])
            send(res, 201, project)
            return
          }
          if (method === 'GET' && id === undefined) {
            ok(res, kernel.listProjects())
            return
          }
          if (id !== undefined) {
            if (method === 'GET' && sub === undefined) {
              ok(res, kernel.getProject(id))
              return
            }
            if (method === 'PATCH' && sub === undefined) {
              const input = z.object({ name: z.string().min(1) }).parse(body)
              ok(res, kernel.renameProject(id, input.name))
              return
            }
            if (method === 'POST' && sub === 'archive') {
              ok(res, kernel.archiveProject(id))
              return
            }
            if (method === 'POST' && sub === 'unarchive') {
              ok(res, kernel.unarchiveProject(id))
              return
            }
            if (method === 'GET' && sub === 'projection') {
              ok(res, kernel.projectProjection(id))
              return
            }
            if (method === 'GET' && sub === 'gates') {
              ok(res, kernel.listGates(id))
              return
            }
            if (method === 'GET' && sub === 'decisions') {
              ok(res, kernel.listDecisions(id))
              return
            }
            if (method === 'GET' && sub === 'ideas') {
              ok(res, kernel.listIdeas(id))
              return
            }
            if (method === 'GET' && sub === 'contracts') {
              ok(res, kernel.listContracts(id))
              return
            }
            // Internal automation path: freeze a contract by a simulated
            // Human Gate Decision (approveContract). The token-protected
            // route is used by evals/orchestrator; interactive flows use the
            // contract gate decision route instead (GOV-02 atomic freeze).
            if (sub === 'contracts' && subId !== undefined && method === 'POST' && url.pathname.endsWith('/approve')) {
              const input = z.object({ actor: z.string().min(1) }).parse(body)
              ok(res, kernel.approveContract(subId, `dec_${randomUUID().slice(0, 12)}`, input.actor))
              return
            }
            if (sub === 'members' && method === 'GET') {
              ok(res, kernel.listProjectMembers(id))
              return
            }
            if (sub === 'members' && (method === 'POST' || method === 'PATCH')) {
              const input = z.object({
                principal_id: z.string().min(1),
                role: z.enum(['pi', 'researcher', 'operator', 'auditor', 'viewer']),
                tenant_id: z.string().optional(),
                actor: z.string().min(1),
              }).parse(body)
              ok(res, kernel.addProjectMember({ project_id: id, ...input }))
              return
            }
            if (sub === 'members' && subId !== undefined && method === 'DELETE') {
              const input = z.object({ actor: z.string().min(1) }).parse(body)
              kernel.removeProjectMember({ project_id: id, principal_id: subId, actor: input.actor })
              ok(res, { ok: true })
              return
            }
            if (method === 'GET' && sub === 'jobs') {
              ok(res, kernel.listJobs(id))
              return
            }
            if (method === 'GET' && sub === 'runs' && subId === undefined) {
              ok(res, kernel.listRuns(id))
              return
            }
            if (method === 'GET' && sub === 'runs' && subId !== undefined) {
              ok(res, kernel.getRun(id, subId))
              return
            }
            if (method === 'GET' && sub === 'artifacts') {
              ok(res, kernel.listArtifacts(id))
              return
            }
            if (method === 'GET' && sub === 'evidence') {
              ok(res, kernel.listEvidence(id))
              return
            }
            if (method === 'GET' && sub === 'claims') {
              ok(res, kernel.listClaims(id))
              return
            }
            if (method === 'GET' && sub === 'budget') {
              ok(res, kernel.getBudget(id))
              return
            }
            if (method === 'GET' && sub === 'manuscript-review') {
              ok(res, kernel.manuscriptReview(id))
              return
            }
            if (method === 'POST' && sub === 'manuscripts' && subId === 'build') {
              const input = z.object({ format: z.enum(['markdown', 'latex']).optional(), include_limitations: z.boolean().optional() }).parse(body)
              ok(res, kernel.buildManuscript(id, input.format ?? 'markdown', input.include_limitations ?? true))
              return
            }
            if (method === 'POST' && sub === 'release-bundle') {
              ok(res, kernel.releaseBundle(id))
              return
            }
            if (method === 'POST' && sub === 'analysis') {
              const input = z.object({ contract_id: z.string().optional(), metric: z.string().optional() }).parse(body)
              ok(res, kernel.computeAnalysis(id, input.contract_id, input.metric))
              return
            }
            if (method === 'POST' && sub === 'manuscript-drafts') {
              // gui-plugin-plan §11: generate a versioned TeX workspace.
              const input = z.object({ root_file: z.string().optional() }).parse(body)
              ok(res, kernel.generateTexWorkspace(id, input.root_file))
              return
            }
            if (method === 'GET' && sub === 'events') {
              ok(res, kernel.listEvents(id))
              return
            }
            if (method === 'POST' && sub === 'transitions') {
              const input = transitionSchema.parse(body)
              ok(res, kernel.transition(id, input.to as never, input.expected_revision, input.reason))
              return
            }
            if (method === 'POST' && sub === 'gates') {
              const input = gateSchema.parse(body)
              const gate = kernel.createGate({ project_id: id, ...input })
              send(res, 201, gate)
              return
            }
            if (method === 'POST' && sub === 'session') {
              const input = z.object({ session_id: z.string().min(1) }).parse(body)
              ok(res, kernel.linkSession(input.session_id, id))
              return
            }
            if (method === 'POST' && sub === 'budget') {
              const input = budgetSchema.parse(body)
              ok(res, kernel.recordUsage(id, input))
              return
            }
            if (method === 'POST' && sub === 'ideas') {
              const input = ideaSchema.parse(body)
              const idea = kernel.createIdea({ ...input, project_id: id } as never)
              send(res, 201, idea)
              return
            }
            if (method === 'POST' && sub === 'contracts') {
              const input = contractSchema.parse(body)
              const contract = kernel.registerContract({ ...input, project_id: id } as never)
              send(res, 201, contract)
              return
            }
            if (method === 'POST' && sub === 'jobs') {
              const input = jobSchema.parse(body)
              const job = kernel.submitJob({ ...input, project_id: id })
              send(res, 201, job)
              return
            }
            if (method === 'POST' && sub === 'code-snapshots') {
              // §11.3 (SCH-EXEC-002): archive ACTUAL directory contents into
              // a content-addressed `code` artifact (+ manifest artifact).
              const input = codeSnapshotSchema.parse(body)
              const snapshot = kernel.snapshotCodeArchive(id, input.path, input.description ?? '')
              send(res, 201, snapshot)
              return
            }
            if (method === 'POST' && sub === 'claims') {
              const input = claimCreateSchema.parse(body)
              const claim = kernel.createClaim({ project_id: input.project_id ?? id, statement: input.statement, scope: input.scope as never })
              send(res, 201, claim)
              return
            }
            if (method === 'POST' && sub === 'corpus') {
              const input = corpusSchema.parse(body)
              const snapshot = kernel.snapshotCorpus({ ...input, project_id: id } as never)
              send(res, 201, snapshot)
              return
            }
            if (method === 'GET' && sub === 'corpus-snapshots') {
              ok(res, kernel.listCorpusSnapshots(id))
              return
            }
            if (method === 'POST' && sub === 'evidence' && subId === undefined) {
              const input = evidenceSchema.parse(body)
              const item = kernel.ingestEvidence({ ...input, project_id: id } as never)
              send(res, 201, item)
              return
            }
            // Analysis-Worker internal path (v2 §13.1): verified provenance is
            // only reachable here with the Analysis-Worker service identity;
            // the public route rejects it (EVID-01). A missing/mismatched
            // x-service-principal is a 403 — the public cannot masquerade.
            if (method === 'POST' && sub === 'evidence' && subId === 'verified') {
              const servicePrincipal = typeof req.headers['x-service-principal'] === 'string' ? req.headers['x-service-principal'] : ''
              if (servicePrincipal !== 'analysis-worker') {
                send(res, 403, { error: errorEnvelope('service_identity_required', 'verified evidence ingestion requires x-service-principal: analysis-worker') })
                return
              }
              const input = evidenceSchema.parse(body)
              const item = kernel.ingestVerifiedEvidence({ ...input, project_id: id } as never)
              send(res, 201, item)
              return
            }
            // §6 Verifier/Auditor internal accept route:
            // POST /v1/projects/{id}/evidence/{eid}/accept — transitions
            // verified → accepted (provenance state machine) after full
            // revalidation; only service principals 'verifier'/'auditor' may
            // accept. request_id defaults to the x-request-id header.
            if (method === 'POST' && sub === 'evidence' && subId !== undefined && subId !== 'verified' && url.pathname.endsWith('/accept')) {
              const servicePrincipal = typeof req.headers['x-service-principal'] === 'string' ? req.headers['x-service-principal'] : ''
              if (servicePrincipal !== 'verifier' && servicePrincipal !== 'auditor') {
                send(res, 403, { error: errorEnvelope('service_identity_required', 'evidence accept requires x-service-principal: verifier|auditor') })
                return
              }
              const input = z.object({ request_id: z.string().optional() }).parse(body)
              const item = kernel.acceptEvidence({
                project_id: id,
                evidence_id: subId,
                service_principal: servicePrincipal,
                request_id: input.request_id ?? currentRequestId,
              })
              ok(res, item)
              return
            }
          }
          break
        }
        case 'gates': {
          if (id !== undefined && sub === undefined && method === 'GET') {
            // Gate lookup (BFF principal resolver uses it to map a gate
            // decision to the gate's project for membership/role checks).
            ok(res, kernel.getGate(id))
            return
          }
          if (id !== undefined && sub === 'decisions' && method === 'POST') {
            // GOV-01 (fail-closed): a Human Gate decision is only accepted
            // with an authenticated principal — anonymous or bare-actor
            // (forged identity) decisions are 422 principal_required and
            // never recorded. The internal orchestrator approve route
            // (contracts/{id}/approve) is NOT a gate decision and keeps its
            // actor-only semantics.
            const bodyObj = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
            const p = bodyObj.principal as Record<string, unknown> | undefined
            const principalId = typeof p === 'object' && p !== null && !Array.isArray(p)
              && typeof p.principal_id === 'string'
              ? p.principal_id
              : ''
            if (principalId === '') {
              send(res, 422, { error: errorEnvelope('principal_required', 'gate decisions require an authenticated principal (principal.principal_id); anonymous or actor-only decisions are rejected') })
              return
            }
            const input = decisionSchema.parse(body)
            // GOV-01 principal resolver: when the BFF forwarded a durable
            // session (x-principal-session, session.json-derived) and the
            // decision carries no explicit session_id, bind the forwarded
            // session so the recorded decision is traceable to the
            // authenticated session ("Session link 在重启后恢复").
            const forwardedSession = req.headers['x-principal-session']
            if ((input.session_id === undefined || input.session_id === null) && typeof forwardedSession === 'string' && forwardedSession !== '') {
              input.session_id = forwardedSession
            }
            ok(res, kernel.decideGate({ gate_id: id, actor: input.actor ?? principalId, ...input }))
            return
          }
          break
        }
        case 'artifacts': {
          if (method === 'POST' && id === undefined) {
            const input = artifactSchema.parse(body)
            const content = Buffer.from(input.content_base64, 'base64')
            const record = kernel.registerArtifact({
              project_id: input.project_id,
              kind: input.kind,
              content,
              metadata: input.metadata,
              media_type: input.media_type,
              file_name: input.file_name,
            })
            send(res, 201, record)
            return
          }
          if (id !== undefined && (method === 'GET' || method === 'HEAD') && sub === undefined) {
            // v2: project-scoped lookup via ?project_id=; legacy unqualified
            // lookup resolves only when the blob has a single project record.
            const projectId = url.searchParams.get('project_id') ?? undefined
            let record: import('@dsh-scholar/research-schemas').ArtifactRecord
            if (projectId !== undefined) {
              record = kernel.getArtifact(projectId, id)
            } else {
              const matches = kernel.listArtifactsForBlob(id)
              if (matches.length === 0) throw new KernelError(404, 'artifact_not_found', `artifact ${id} not found`)
              if (matches.length > 1) throw new KernelError(409, 'artifact_ambiguous', `artifact ${id} exists in multiple projects; pass project_id`)
              record = matches[0]!
            }
            const content = kernel.cas.read(record.sha256)
            // ART-02: serve the stored media type (PDF artifacts must be
            // application/pdf), with ETag + Content-Disposition + Range
            // (api-contracts.md §artifact GET).
            const mediaType = record.media_type !== null && record.media_type !== '' ? record.media_type
              : (record.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream')
            const etag = `"sha256:${record.sha256}"`
            if (req.headers['if-none-match'] === etag) {
              res.writeHead(304, { etag, 'cache-control': 'no-store' })
              res.end()
              return
            }
            const headOnly = method === 'HEAD'
            const endBody = (status: number, headers: Record<string, string>, body?: Buffer): void => {
              if (headOnly) { res.writeHead(status, headers); res.end(); return }
              res.writeHead(status, headers)
              res.end(body)
            }
            const fileName = record.file_name ?? `${record.kind}-${record.artifact_id.slice(0, 16)}`
            const disposition = record.kind === 'pdf' || record.kind === 'chart' || record.kind === 'paper'
              ? `inline; filename="${fileName.replaceAll('"', '')}"`
              : `attachment; filename="${fileName.replaceAll('"', '')}"`
            const baseHeaders: Record<string, string> = {
              'content-type': mediaType,
              'content-length': String(content.byteLength),
              etag,
              'cache-control': 'no-store',
              'content-disposition': disposition,
              'x-artifact-id': record.artifact_id,
              'x-project-id': record.project_id,
            }
            // Single-range support (api-contracts.md): bytes=a-b.
            const range = req.headers.range
            const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
            if (match !== null && match[1] !== '' && match[2] !== '') {
              let start = Number(match[1])
              const end = Math.min(Number(match[2]), content.byteLength - 1)
              if (start >= content.byteLength) {
                res.writeHead(416, { 'content-range': `bytes */${content.byteLength}` })
                res.end()
                return
              }
              if (end < start) start = 0
              endBody(206, { ...baseHeaders, 'content-range': `bytes ${start}-${end}/${content.byteLength}`, 'content-length': String(end - start + 1) }, content.subarray(start, end + 1))
              return
            }
            if (match !== null && (match[1] !== '' || match[2] !== '')) {
              // bytes=a- or bytes=-n (suffix) — simple forms.
              let start = 0
              let end = content.byteLength - 1
              if (match[1] !== '') start = Math.min(Number(match[1]), content.byteLength - 1)
              if (match[2] !== '') start = Math.max(0, content.byteLength - Number(match[2]))
              endBody(206, { ...baseHeaders, 'content-range': `bytes ${start}-${end}/${content.byteLength}`, 'content-length': String(end - start + 1) }, content.subarray(start, end + 1))
              return
            }
            endBody(200, baseHeaders, content)
            return
          }
          break
        }
        case 'ideas': {
          if (id !== undefined && method === 'GET' && sub === undefined) {
            ok(res, kernel.getIdea(id))
            return
          }
          if (id !== undefined && sub === 'novelty' && method === 'POST') {
            const input = z.object({
              queries: z.array(z.string()),
              result: z.enum(['no_direct_match_found', 'overlap_found', 'inconclusive']),
              overlap_papers: z.array(z.string()).optional(),
              unresolved_risk: z.enum(['low', 'medium', 'high']).optional(),
            }).parse(body)
            ok(res, kernel.updateIdeaNovelty(id, {
              queries: input.queries,
              result: input.result,
              overlap_papers: input.overlap_papers ?? [],
              unresolved_risk: input.unresolved_risk ?? 'medium',
              audited_at: new Date().toISOString(),
            }))
            return
          }
          break
        }
        case 'jobs': {
          if (id !== undefined && sub === undefined && method === 'GET') {
            ok(res, kernel.getJob(id))
            return
          }
          if (id !== undefined && sub === 'status' && method === 'POST') {
            const input = jobCompleteSchema.parse(body)
            ok(res, kernel.completeJob({
              job_id: id, ...input,
              lease_generation: input.lease_generation ?? null,
              lease_token: input.lease_token ?? null,
            }))
            return
          }
          if (id !== undefined && sub === 'heartbeat' && method === 'POST') {
            const input = z.object({
              owner: z.string().min(1),
              lease_generation: z.number().int().nonnegative().nullable().optional(),
              lease_token: z.string().nullable().optional(),
            }).parse(body)
            ok(res, kernel.heartbeatJob(id, input.owner, input.lease_generation ?? null, input.lease_token ?? null))
            return
          }
          if (id !== undefined && sub === 'cancel' && method === 'POST') {
            const input = z.object({ actor: z.string().min(1), reason: z.string().optional() }).parse(body)
            ok(res, kernel.cancelJob(id, input.actor, input.reason))
            return
          }
          if (id !== undefined && sub === 'terminal' && method === 'GET') {
            void handleTerminalSse(req, res, kernel, id, url)
            return
          }
          if (id !== undefined && sub === 'terminal-frames' && method === 'POST') {
            const input = terminalFramesSchema.parse(body)
            // §4 P0 (TERM-01): lease owner/token travel via the
            // x-lease-owner/x-lease-token headers (runner client) or the body
            // fallback; the kernel exact-matches them against the job's
            // current lease when provided — a wrong owner/token is 409
            // lease_stale. The runner gateway ALWAYS sends both, so every
            // frame it produces is owner/token-fenced.
            const owner = typeof req.headers['x-lease-owner'] === 'string' && req.headers['x-lease-owner'] !== ''
              ? req.headers['x-lease-owner']
              : input.owner
            const leaseToken = typeof req.headers['x-lease-token'] === 'string' && req.headers['x-lease-token'] !== ''
              ? req.headers['x-lease-token']
              : input.lease_token ?? undefined
            ok(res, kernel.appendTerminalFrames({
              jobId: id,
              runId: input.run_id,
              frames: input.frames.map(f => ({
                seq: f.seq,
                stream_seq: f.stream_seq ?? null,
                channel: f.channel ?? null,
                text: f.text ?? null,
                byte_offset: f.byte_offset ?? null,
                byte_length: f.byte_length ?? null,
                frame_kind: f.frame_kind,
                payload_json: f.payload_json,
                lease_generation: f.lease_generation,
              })),
              owner,
              lease_token: leaseToken,
              maxLogBytes: input.max_log_bytes,
            }))
            return
          }
          break
        }
        case 'claims': {
          if (method === 'POST' && id === 'verify') {
            const input = claimVerifySchema.parse(body)
            ok(res, kernel.verifyClaim(input))
            return
          }
          break
        }
        case 'documents': {
          // TeX workspace (api-contracts.md §11, execution-runtime.md §12).
          if (id !== undefined && sub === 'tree' && method === 'GET') {
            ok(res, kernel.texTree(id))
            return
          }
          if (id !== undefined && sub === 'file' && method === 'GET') {
            const path = url.searchParams.get('path')
            if (path === null) throw new KernelError(422, 'missing_path', '?path= is required')
            ok(res, kernel.texReadFile(id, path))
            return
          }
          if (id !== undefined && sub === 'file' && method === 'PUT') {
            // expected_version is the CAS guard: undefined = unchecked write,
            // 0 = create-if-absent (the UI "new file" path sends 0; the file
            // must NOT already exist), N>0 = must match the stored version.
            // 0 must be accepted here — a positive-only schema would 422 the
            // create-if-absent call (acceptance-tests.md §7 ui-new-file).
            const input = z.object({
              path: z.string().min(1),
              content: z.string(),
              expected_version: z.number().int().nonnegative().optional(),
            }).parse(body)
            ok(res, kernel.texWriteFile(id, input.path, input.content, input.expected_version))
            return
          }
          if (id !== undefined && sub === 'file' && method === 'DELETE') {
            const path = url.searchParams.get('path')
            if (path === null) throw new KernelError(422, 'missing_path', '?path= is required')
            // Same CAS semantics as PUT: 0 is a legal value (never matches a
            // stored version >= 1 → 409), so it must survive the query parse.
            const raw = url.searchParams.get('expected_version')
            const expected = raw === null || raw === '' ? undefined : Number(raw)
            if (expected !== undefined && (!Number.isInteger(expected) || expected < 0)) {
              throw new KernelError(422, 'invalid_expected_version', 'expected_version must be a non-negative integer')
            }
            kernel.texDeleteFile(id, path, expected)
            ok(res, { ok: true })
            return
          }
          if (id !== undefined && sub === 'moves' && method === 'POST') {
            // expected_version = CAS guard on the source file: 0 is accepted
            // by the schema but never matches a stored version (>= 1), so it
            // answers 409 — reload before moving (acceptance-tests.md §7).
            const input = z.object({
              from_path: z.string().min(1),
              to_path: z.string().min(1),
              expected_version: z.number().int().nonnegative().optional(),
            }).parse(body)
            kernel.texMoveFile(id, input.from_path, input.to_path, input.expected_version)
            ok(res, { ok: true })
            return
          }
          if (id !== undefined && sub === 'history' && method === 'GET') {
            ok(res, kernel.texHistory(id))
            return
          }
          if (id !== undefined && sub === 'snapshots' && method === 'POST') {
            const input = z.object({ expected_revision: z.number().int().positive().optional() }).parse(body)
            ok(res, kernel.texSnapshot(id, input.expected_revision))
            return
          }
          if (id !== undefined && sub === 'snapshot-files' && method === 'GET') {
            // TEX-01 (§4 row 95): frozen, revision-scoped build bytes — the
            // Runner materializes latex-compile input from this route, never
            // from the current file (which may have moved on since freeze).
            const revisionRaw = url.searchParams.get('revision')
            const path = url.searchParams.get('path')
            if (revisionRaw === null || path === null) {
              throw new KernelError(422, 'missing_params', '?revision=&path= are required')
            }
            const revision = Number(revisionRaw)
            if (!Number.isInteger(revision) || revision <= 0) {
              throw new KernelError(422, 'invalid_revision', 'revision must be a positive integer')
            }
            const file = kernel.texSnapshotFile(id, revision, path)
            if (file === null) {
              throw new KernelError(404, 'snapshot_file_not_found',
                `tex snapshot file ${path} not found at revision ${revision} (document ${id})`)
            }
            ok(res, file)
            return
          }
          if (id !== undefined && sub === 'builds' && subId === undefined && method === 'GET') {
            ok(res, kernel.texListBuilds(id))
            return
          }
          if (id !== undefined && sub === 'builds' && subId === undefined && method === 'POST') {
            const input = z.object({
              expected_document_revision: z.number().int().positive(),
              root_file: z.string().optional(),
              engine: z.string().optional(),
              max_passes: z.number().int().positive().optional(),
              idempotency_key: z.string().optional(),
              image_digest: z.string().optional(),
            }).parse(body)
            // §4 P0 (RUN-02/TEX-02): the build engine is a fixed enum —
            // reject anything outside the whitelist before it can be spliced
            // into the container build script (422 engine_invalid).
            const engine = input.engine ?? 'pdflatex'
            if (!TEX_ENGINES.includes(engine)) {
              throw new KernelError(422, 'engine_invalid',
                `latex-compile engine '${engine}' is not in the fixed engine whitelist (${TEX_ENGINES.join('/')})`)
            }
            // Freeze the workspace manifest, then submit the latex-compile job.
            const snap = kernel.texSnapshot(id, input.expected_document_revision)
            const tree = kernel.texTree(id)
            const rootFile = input.root_file ?? tree.document.root_file
            const job = kernel.submitJob({
              project_id: tree.document.project_id,
              idempotency_key: input.idempotency_key ?? `latex:${id}:${snap.revision}:${engine}`,
              kind: 'latex-compile',
              command: [engine, '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-recorder', '-no-shell-escape', rootFile],
              payload: {
                tex_document_id: id,
                tex_revision: snap.revision,
                tex_snapshot: snap.manifest,
                // The runner builds with payload.engine — it MUST see the
                // validated engine so command[0] and the actual build agree.
                engine,
                image_digest: input.image_digest ?? '',
              },
            })
            const build = kernel.texCreateBuild(id, snap.revision, rootFile, job.job_id)
            // §12.1 (TEX-03): the authoritative Compile supersedes every
            // non-terminal preview (queued → cancelled, running →
            // superseded) — previews never block or replace the authority.
            kernel.texSupersedePreviews(id, build.build_id)
            send(res, 201, { build, job })
            return
          }
          if (id !== undefined && sub === 'builds' && subId !== undefined && method === 'GET') {
            ok(res, kernel.texGetBuild(subId))
            return
          }
          if (id !== undefined && sub === 'preview-builds' && subId === undefined && method === 'POST') {
            // §12.1 (TEX-03): save-success hook — the caller (UI/BFF) invokes
            // this after a successful save; the kernel owns the debounce
            // timer and the durable pending request, so preview state is
            // re-projectable after reconnects/restarts.
            const input = z.object({
              debounce_ms: z.number().int().positive().optional(),
              root_file: z.string().optional(),
              engine: z.string().optional(),
            }).parse(body)
            const pending = kernel.texRequestPreview(id, {
              debounce_ms: input.debounce_ms,
              root_file: input.root_file,
              engine: input.engine,
            })
            ok(res, { pending })
            return
          }
          if (id !== undefined && sub === 'preview-builds' && subId === undefined && method === 'GET') {
            // §12.1 (TEX-03): projection for UI reconnects — pending debounce
            // state plus preview builds, each carrying preview=true and the
            // stale flag (build.revision < document.revision).
            ok(res, kernel.texPreviewStatus(id))
            return
          }
          break
        }
        case 'pty': {
          // PTY-01 (execution-runtime.md §6.1, api-contracts.md §18) —
          // Interactive Terminal interface layer. Wire shape: the client
          // never sends endpoint/SSH credential/Docker socket/host path —
          // only opaque profile/target ids, a preset and a relative cwd
          // (pty-safe-open). The REAL tty allocation is the adapter
          // (LocalDockerPty/RemoteRunnerPty, later round): while no adapter
          // is registered the HTTP open route is 501 and control frames are
          // applied to the state machine with delivered=false. Sessions are
          // created through the kernel API (kernel.ptyOpen — the adapter
          // injection point) and then driven over these routes.
          if (id === 'sessions') {
            if (sub === undefined && method === 'POST') {
              // Open: schema + semantics validation ONLY — a session row is
              // intentionally NOT created until an adapter can serve a real
              // pseudo-terminal (an inert session would mislead the UI).
              const input = PtyOpenRequest.parse(body)
              kernel.getProject(input.project_id) // 404 project_not_found
              kernel.resolveWorkspace(input.workspace_id) // 404 workspace_not_found
              send(res, 501, {
                error: errorEnvelope('pty_adapter_not_implemented',
                  'no PTY adapter is registered (LocalDockerPty/RemoteRunnerPty pending) — the interface layer state machine is exercised via the kernel API'),
              })
              return
            }
            if (sub !== undefined && subId === undefined && method === 'GET') {
              // Session state + lease summary (api-contracts.md §18 GET).
              ok(res, kernel.ptyGet(sub))
              return
            }
            if (sub !== undefined && subId === 'control' && method === 'POST') {
              // Control with client_seq idempotency: 422 on schema failure,
              // 404 on unknown session, 409 on reorder/closed, 200 with
              // delivered=false while no adapter is attached.
              const input = PtyControlRequest.parse(body)
              const result = kernel.ptyControl(sub, input)
              ok(res, result)
              return
            }
            if (sub !== undefined && subId === 'frames' && method === 'GET') {
              // Output replay with server seq / gap / retention.
              const raw = url.searchParams.get('after_seq')
              const afterSeq = raw === null ? 0 : Number(raw)
              if (!Number.isInteger(afterSeq) || afterSeq < 0) {
                throw new KernelError(422, 'pty_after_seq_invalid', 'after_seq must be a non-negative integer')
              }
              ok(res, kernel.ptyFrames(sub, afterSeq))
              return
            }
          }
          break
        }
        case 'events': {
          if (method === 'GET' && id === undefined) {
            const projectId = url.searchParams.get('project_id') ?? undefined
            ok(res, kernel.listEvents(projectId))
            return
          }
          break
        }
        case 'session-links': {
          if (id !== undefined && method === 'GET') {
            ok(res, kernel.getProjectBySession(id))
            return
          }
          break
        }
        case 'jobs-claim': {
          if (method === 'POST' && id !== undefined) {
            const input = z.object({ owner: z.string().min(1), lease_ttl_seconds: z.number().int().positive().optional(), limit: z.number().int().positive().max(64).optional() }).parse(body)
            ok(res, kernel.claimJobs(input.owner, input.lease_ttl_seconds, input.limit))
            return
          }
          break
        }
        case 'runner-keys': {
          if (method === 'POST' && id === undefined) {
            const input = runnerKeySchema.parse(body)
            send(res, 201, kernel.registerRunnerKey(input))
            return
          }
          if (method === 'GET' && id === undefined) {
            ok(res, kernel.listRunnerKeys())
            return
          }
          break
        }
        case 'recover': {
          if (method === 'POST' && id === 'leases') {
            ok(res, { recovered: kernel.recoverExpiredLeases() })
            return
          }
          break
        }
        default:
          break
      }
      send(res, 404, { error: { code: 'not_found', message: `no route ${method} ${url.pathname}` } })
    } catch (error) {
      fail(res, error)
    }
  }).catch((error: unknown) => fail(res, error))
}

/**
 * Terminal SSE (api-contracts.md §9): text/event-stream replay + live
 * tail of a run's terminal frames. Polls the kernel's frame store with a
 * bounded cursor; gap frames are emitted before evicted sequences; comment
 * frames act as heartbeats; the exit frame ends the stream (replayable via
 * after_seq on reconnect).
 */
function handleTerminalSse(
  req: IncomingMessage,
  res: ServerResponse,
  kernel: ResearchKernel,
  jobId: string,
  url: URL,
): void {
  // log-authz (acceptance-tests.md §5): when the caller pins a project with
  // ?project_id=, the job must belong to THAT project — a cross-project read
  // answers 404 (no enumeration). Callers without a project_id (legacy direct
  // kernel access; the BFF enforces membership itself) keep the job-scoped
  // behavior. Synchronous throw -> the router's fail() sends the 404 JSON.
  const projectId = url.searchParams.get('project_id')
  if (projectId !== null && projectId !== '') {
    const job = kernel.getJob(jobId)
    if (job.project_id !== projectId) {
      throw new KernelError(404, 'project_not_found', 'project not found or access denied')
    }
  }
  const runId = url.searchParams.get('run_id')
    ?? kernel.resolveTerminalRun(jobId)
    ?? jobId
  const afterSeq = Math.max(0, Number(url.searchParams.get('after_seq') ?? 0) || 0)
  const writeEvent = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  // Initial snapshot before the headers: a missing job propagates to the
  // router's error handler (404 JSON) instead of half-open SSE.
  const initial = kernel.listTerminalFrames(jobId, runId, 0)
  const initialLastSeq = initial.frames.length > 0 ? initial.frames[initial.frames.length - 1]!.seq : 0
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })
  writeEvent('subscribed', {
    run_id: runId,
    last_seq: initialLastSeq,
    retained_from_seq: initial.retention.retained_from_seq,
  })
  let cursor = afterSeq
  let gapSent = false
  let heartbeat: NodeJS.Timeout | undefined
  let poll: NodeJS.Timeout | undefined
  let closed = false
  const cleanup = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    if (poll !== undefined) clearInterval(poll)
  }
  req.on('close', cleanup)
  req.on('error', cleanup)
  res.on('error', cleanup)

  const sendBatch = (): void => {
    if (closed) return
    let data
    try {
      data = kernel.listTerminalFrames(jobId, runId, cursor)
    } catch {
      cleanup()
      res.end()
      return
    }
    const retention = data.retention
    // Gap: requested sequences were already evicted.
    if (!gapSent && cursor + 1 < retention.retained_from_seq) {
      writeEvent('gap', {
        kind: 'gap',
        job_id: jobId,
        run_id: runId,
        seq: cursor + 1,
        requested_after: cursor,
        retained_from_seq: retention.retained_from_seq,
        dropped_bytes: retention.dropped_bytes,
        lease_generation: 0,
        time: new Date().toISOString(),
      })
      gapSent = true
      cursor = retention.retained_from_seq - 1
    }
    for (const frame of data.frames) {
      const base = {
        kind: frame.frame_kind,
        job_id: jobId,
        run_id: runId,
        seq: frame.seq,
        lease_generation: frame.lease_generation,
        time: frame.created_at,
      }
      if (frame.frame_kind === 'chunk') {
        writeEvent('chunk', {
          ...base,
          stream_seq: frame.stream_seq,
          channel: frame.channel,
          text: frame.text,
          byte_offset: frame.byte_offset,
          byte_length: frame.byte_length,
        })
      } else if (frame.frame_kind === 'exit') {
        // The exit frame carries the terminal-side facts; business terminal
        // state remains authoritative in the job record.
        let exitPayload: Record<string, unknown> = {}
        try { exitPayload = JSON.parse(frame.payload_json) as Record<string, unknown> } catch { /* opaque */ }
        writeEvent('exit', {
          ...base,
          exit_code: exitPayload.exit_code ?? null,
          signal: exitPayload.signal ?? null,
          cancelled: exitPayload.cancelled ?? false,
          timed_out: exitPayload.timed_out ?? false,
          truncated: retention.truncated,
          total_bytes: retention.total_bytes,
          dropped_bytes: retention.dropped_bytes,
        })
      } else {
        writeEvent(frame.frame_kind, base)
      }
      cursor = frame.seq
      if (frame.frame_kind === 'exit') {
        // Exit is authoritative; the client replays via after_seq if needed.
        cleanup()
        res.end()
        return
      }
    }
    void data
  }

  // Initial snapshot + live tail.
  sendBatch()
  poll = setInterval(sendBatch, 500)
  heartbeat = setInterval(() => { if (!closed) res.write(`: heartbeat ${Date.now()}\n\n`) }, 15000)
}

/** Start the kernel API server; returns the listening server. */
/**
 * v2 adapter (api-contracts.md §4): the /v2 surface the BFF exposes to the
 * UI. Idempotency-Key-scoped project creation, membership-filtered paginated
 * listing, projection with capabilities, gate-requests (decision fields are
 * rejected — agents cannot attach a decision) and transitions (gate states
 * stay 422). x-principal-id is the BFF-resolved operator identity; when
 * present, project-scoped routes enforce membership (404 on non-member).
 */
async function handleV2(ctx: {
  req: IncomingMessage
  res: ServerResponse
  method: string
  url: URL
  id?: string
  sub?: string
  subId?: string
  body: unknown
  kernel: ResearchKernel
  configPin?: string
}): Promise<void> {
  const { req, res, method, url, id, sub, subId, body, kernel, configPin } = ctx
  const principal = typeof req.headers['x-principal-id'] === 'string' ? req.headers['x-principal-id'] : undefined
  // API-01 role capabilities: the BFF injects x-principal-role from ITS OWN
  // membership lookup (client-supplied values are never trusted). When
  // present, the role gates the surface: viewer/auditor are read-only and
  // researcher cannot perform governance writes. A present-but-invalid role
  // is 403 role_required (fail-closed); an absent header means the caller
  // has no BFF identity and the route falls back to principal/member checks.
  const role = typeof req.headers['x-principal-role'] === 'string' ? req.headers['x-principal-role'] : undefined
  const roleOk = role === undefined || role === 'pi' || role === 'researcher' || role === 'operator' || role === 'auditor' || role === 'viewer'
  // Governance writes (API-01): transitions, gate creation/decisions
  // (incl. gate-requests), budget and the internal approve/accept channels.
  // researcher may submit ordinary work but never these.
  const governanceWrite = /(?:transitions|gate(?:s)?(?:\/|$)|decisions|budget|approve|accept)/.test(url.pathname)
  if (!roleOk) {
    send(res, 403, { error: { code: 'role_required', message: 'invalid x-principal-role; BFF must inject pi|researcher|operator|auditor|viewer' } })
    return
  }
  if (role !== undefined && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (role === 'viewer' || role === 'auditor' || (role === 'researcher' && governanceWrite)) {
      send(res, 403, { error: { code: 'role_forbidden', message: 'role forbidden for this operation' } })
      return
    }
  }
  const memberOr404 = (projectId: string): void => {
    if (principal === undefined) return
    const members = kernel.listProjectMembers(projectId)
    if (!members.some(m => m.principal_id === principal)) {
      throw new KernelError(404, 'project_not_found', 'project not found or access denied')
    }
  }
  if (id === undefined && sub === undefined && method === 'GET' && url.pathname === '/v2/health') {
    // api-contracts.md §3: capability discovery with protocol/schema version.
    send(res, 200, {
      ok: true,
      instance_id: kernel.instanceId,
      protocol_version: 2,
      schema_version: kernel.schemaVersion(),
      database_id: kernel.databaseId(),
      config_pin: configPin ?? kernel.configPinHash,
      capabilities: ['terminal_stream', 'tex_workspace', 'latex_compile', 'signed_manifest', 'clean_room', 'locales'],
      time: new Date().toISOString(),
    })
    return
  }
  if (id === undefined && method === 'POST') {
    // POST /v2/projects — Idempotency-Key REQUIRED (api-contracts §4).
    const idem = typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key'] !== ''
      ? req.headers['idempotency-key']
      : undefined
    if (idem === undefined) {
      send(res, 422, { error: { code: 'idempotency_key_required', message: 'POST /v2/projects requires an Idempotency-Key header' } })
      return
    }
    const input = createProjectSchema.parse(body)
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const out = kernel.createProjectWithInitialGate({ ...input as Parameters<ResearchKernel['createProject']>[0], idempotency_key: idem, request_hash: requestHash })
    send(res, 201, { project: out.project, gate: out.gate, budget: out.budget, membership: out.membership })
    return
  }
  if (id === undefined && method === 'GET') {
    // GET /v2/projects — membership-filtered paginated list.
    const limit = Number(url.searchParams.get('limit') ?? '50')
    const cursor = url.searchParams.get('cursor') ?? undefined
    const page = kernel.listProjectsPage(Number.isFinite(limit) ? limit : 50, cursor)
    const items = principal === undefined
      ? page.items
      : page.items.filter(p => kernel.listProjectMembers(p.project_id).some(m => m.principal_id === principal))
    send(res, 200, { items, next_cursor: page.next_cursor })
    return
  }
  if (id !== undefined && sub === undefined && method === 'GET') {
    memberOr404(id)
    ok(res, kernel.getProject(id))
    return
  }
  if (id !== undefined && sub === 'projection' && method === 'GET') {
    memberOr404(id)
    const projection = kernel.projectProjection(id)
    const members = kernel.listProjectMembers(id)
    const project = kernel.getProject(id)
    const capabilities = {
      editor: true,
      runner_profile: project.execution.runner_profile,
      gates: ['scope', 'idea', 'contract', 'release'],
      roles: members.map(m => m.role),
      membership: principal === undefined ? null : members.find(m => m.principal_id === principal)?.role ?? null,
    }
    send(res, 200, { ...projection, capabilities })
    return
  }
  if (id !== undefined && sub === 'gate-requests' && subId === undefined && method === 'POST') {
    memberOr404(id)
    const input = z.object({
      type: z.enum(['scope', 'idea', 'contract', 'release']),
      title: z.string().min(1),
      summary: z.string().optional(),
      payload: z.record(z.unknown()).optional(),
    }).parse(body)
    // Gate requests must NOT carry a decision (agents cannot attach one).
    const bodyObj = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    for (const forbidden of ['decision', 'actor', 'principal', 'resume_to']) {
      if (forbidden in bodyObj) {
        throw new KernelError(422, 'decision_not_allowed', `gate-requests must not carry '${forbidden}'`)
      }
    }
    const gate = kernel.createGate({
      project_id: id,
      type: input.type,
      title: input.title,
      summary: input.summary,
      payload: input.payload,
    })
    send(res, 201, { gate })
    return
  }
  if (id !== undefined && sub === 'jobs' && method === 'POST') {
    // v2 ordinary work submission (API-01): allowed for pi/operator/
    // researcher; viewer/auditor are read-only (enforced above).
    memberOr404(id)
    const input = jobSchema.parse(body)
    const job = kernel.submitJob({ ...input, project_id: id })
    send(res, 201, job)
    return
  }
  if (id !== undefined && sub === 'transitions' && method === 'POST') {
    memberOr404(id)
    const input = z.object({
      to: z.string().min(1),
      expected_revision: z.number().int().nonnegative(),
      reason: z.string().optional(),
    }).parse(body)
    const project = kernel.transition(id, input.to as never, input.expected_revision, input.reason)
    ok(res, project)
    return
  }
  send(res, 404, { error: { code: 'not_found', message: 'unknown v2 route' } })
}

export function startKernelServer(options: KernelServerOptions): Promise<{ server: Server; url: string; port: number }> {  const { kernel, host = '127.0.0.1', port = 7412, token } = options
  // §12.7 server-level startup parameter (see also KernelOptions.requireSignedManifest).
  if (options.requireSignedManifest !== undefined) kernel.requireSignedManifest = options.requireSignedManifest
  // CONFIG-01: the deployment config pin (CLI-computed) or the kernel's own.
  const configPin = options.configPinHash ?? kernel.configPinHash
  const server = createServer((req, res) => route(req, res, kernel, token, configPin))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      const actualPort = typeof address === 'object' && address !== null ? address.port : port
      resolve({ server, url: `http://${host}:${actualPort}`, port: actualPort })
    })
  })
}
