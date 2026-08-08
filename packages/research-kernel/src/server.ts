/**
 * Research Kernel HTTP API (design §8.3) — a minimal, versioned JSON API on
 * node:http. The DSH plugin and the runner gateway are the primary clients.
 * @module @dsh-scholar/research-kernel/server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { ResearchKernel, KernelError } from './kernel.js'
import { TexError } from './tex-workspace.js'

export interface KernelServerOptions {
  kernel: ResearchKernel
  host?: string
  port?: number
  /** Optional static bearer token for local loopback auth. */
  token?: string
  /** §12.7: require signed run manifests (also settable on the kernel itself). */
  requireSignedManifest?: boolean
}

const idSchema = z.string().min(1)

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
  actor: z.string().min(1),
  // hardening GOV-01: the authenticated human principal (BFF injects it from
  // the login identity; the UI no longer sends a bare actor).
  principal: z.object({
    principal_id: z.string().min(1),
    tenant_id: z.string().optional(),
    auth_method: z.string().optional(),
    session_id: z.string().nullable().optional(),
  }).optional(),
  decision: z.enum(['approved', 'rejected', 'revised']),
  // gui-plugin-plan §6: reject/revise must carry the operator's rationale.
  reason: z.string().optional().superRefine((value, ctx) => {
    // refined below against the decision (schema-level cross-field check).
    void value; void ctx
  }),
  diff: z.string().optional(),
  session_id: z.string().nullable().optional(),
  event_id: z.string().nullable().optional(),
  resume_to: z.string().optional(),
}).superRefine((value, ctx) => {
  if ((value.decision === 'rejected' || value.decision === 'revised') && (value.reason === undefined || value.reason.trim() === '')) {
    ctx.addIssue({ code: 'custom', message: 'reason is required for rejected/revised decisions', path: ['reason'] })
  }
})

const artifactSchema = z.object({
  project_id: z.string().min(1),
  kind: z.enum(['code', 'pdf', 'data', 'log', 'model', 'chart', 'paper', 'analysis', 'manifest', 'bundle']),
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
  metrics: z.object({ primary: z.string().min(1), secondary: z.array(z.string()).optional() }),
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
  // v2 §13.1: agent-facing write defaults to draft_unverified; 'verified' is
  // the Analysis-Worker internal path (ingestVerifiedEvidence) and is REJECTED
  // on the public route (hardening EVID-01).
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
    send(res, error.status, { error: { code: error.code, message: error.message } })
  } else if (error instanceof TexError) {
    // CAS write conflicts and invalid TeX paths map to HTTP semantics.
    const status = error.code === 'document_version_conflict' ? 409 : 422
    send(res, status, { error: { code: error.code, message: error.message } })
  } else if (error instanceof z.ZodError) {
    const issues = error.issues.map(i => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
    send(res, 422, { error: { code: 'validation_error', message: issues } })
  } else {
    send(res, 500, { error: { code: 'internal', message: (error as Error).message ?? String(error) } })
  }
}

function route(req: IncomingMessage, res: ServerResponse, kernel: ResearchKernel, token: string | undefined): void {
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
  const [version, resource, id, sub, subId] = parts as [string | undefined, string | undefined, string | undefined, string | undefined, string | undefined]
  if (version !== 'v1') {
    send(res, 404, { error: { code: 'not_found', message: 'unknown api version' } })
    return
  }

  void readJson(req).then(async (body) => {
    try {
      switch (resource) {
        case 'health': {
          ok(res, { ok: true, instance: kernel.instanceId, time: new Date().toISOString() })
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
            if (sub === 'members' && method === 'GET') {
              ok(res, kernel.listProjectMembers(id))
              return
            }
            if (sub === 'members' && method === 'POST') {
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
            // only reachable here; the public route rejects it (EVID-01).
            if (method === 'POST' && sub === 'evidence' && subId === 'verified') {
              const input = evidenceSchema.parse(body)
              const item = kernel.ingestVerifiedEvidence({ ...input, project_id: id } as never)
              send(res, 201, item)
              return
            }
          }
          break
        }
        case 'gates': {
          if (id !== undefined && sub === 'decisions' && method === 'POST') {
            const input = decisionSchema.parse(body)
            ok(res, kernel.decideGate({ gate_id: id, ...input, resume_to: input.resume_to as never }))
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
            const input = z.object({
              path: z.string().min(1),
              content: z.string(),
              expected_version: z.number().int().positive().optional(),
            }).parse(body)
            ok(res, kernel.texWriteFile(id, input.path, input.content, input.expected_version))
            return
          }
          if (id !== undefined && sub === 'file' && method === 'DELETE') {
            const path = url.searchParams.get('path')
            const expected = Number(url.searchParams.get('expected_version') ?? '') || undefined
            if (path === null) throw new KernelError(422, 'missing_path', '?path= is required')
            kernel.texDeleteFile(id, path, expected)
            ok(res, { ok: true })
            return
          }
          if (id !== undefined && sub === 'moves' && method === 'POST') {
            const input = z.object({
              from_path: z.string().min(1),
              to_path: z.string().min(1),
              expected_version: z.number().int().positive().optional(),
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
            // Freeze the workspace manifest, then submit the latex-compile job.
            const snap = kernel.texSnapshot(id, input.expected_document_revision)
            const tree = kernel.texTree(id)
            const rootFile = input.root_file ?? tree.document.root_file
            const job = kernel.submitJob({
              project_id: tree.document.project_id,
              idempotency_key: input.idempotency_key ?? `latex:${id}:${snap.revision}:${input.engine ?? 'pdflatex'}`,
              kind: 'latex-compile',
              command: [input.engine ?? 'pdflatex', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-recorder', '-no-shell-escape', rootFile],
              payload: {
                tex_document_id: id,
                tex_revision: snap.revision,
                tex_snapshot: snap.manifest,
                image_digest: input.image_digest ?? '',
              },
            })
            const build = kernel.texCreateBuild(id, snap.revision, rootFile, job.job_id)
            send(res, 201, { build, job })
            return
          }
          if (id !== undefined && sub === 'builds' && subId !== undefined && method === 'GET') {
            ok(res, kernel.texGetBuild(subId))
            return
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
export function startKernelServer(options: KernelServerOptions): Promise<{ server: Server; url: string; port: number }> {  const { kernel, host = '127.0.0.1', port = 7412, token } = options
  // §12.7 server-level startup parameter (see also KernelOptions.requireSignedManifest).
  if (options.requireSignedManifest !== undefined) kernel.requireSignedManifest = options.requireSignedManifest
  const server = createServer((req, res) => route(req, res, kernel, token))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      const actualPort = typeof address === 'object' && address !== null ? address.port : port
      resolve({ server, url: `http://${host}:${actualPort}`, port: actualPort })
    })
  })
}
