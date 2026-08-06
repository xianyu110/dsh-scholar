/**
 * Research Kernel HTTP API (design §8.3) — a minimal, versioned JSON API on
 * node:http. The DSH plugin and the runner gateway are the primary clients.
 * @module @dsh-scholar/research-kernel/server
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { ResearchKernel, KernelError } from './kernel.js'

export interface KernelServerOptions {
  kernel: ResearchKernel
  host?: string
  port?: number
  /** Optional static bearer token for local loopback auth. */
  token?: string
}

const idSchema = z.string().min(1)

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
  decision: z.enum(['approved', 'rejected', 'revised']),
  reason: z.string().optional(),
  diff: z.string().optional(),
  session_id: z.string().nullable().optional(),
  event_id: z.string().nullable().optional(),
  resume_to: z.string().optional(),
})

const artifactSchema = z.object({
  project_id: z.string().min(1),
  kind: z.enum(['code', 'pdf', 'data', 'log', 'model', 'chart', 'paper', 'analysis', 'manifest', 'bundle']),
  content_base64: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
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
})

const jobCompleteSchema = z.object({
  owner: z.string().min(1),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  run_manifest: z.record(z.unknown()).optional(),
  failure_class: z.enum(['environment', 'resources', 'code_error', 'data_issue', 'no_improvement', 'unstable_results', 'budget_exhausted', 'unknown']).nullable().optional(),
  error: z.string().optional(),
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
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const parts = url.pathname.split('/').filter(Boolean) // e.g. ['v1','projects','rsp_x']

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
            if (method === 'POST' && sub === 'evidence') {
              const input = evidenceSchema.parse(body)
              const item = kernel.ingestEvidence({ ...input, project_id: id } as never)
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
            const record = kernel.registerArtifact({ project_id: input.project_id, kind: input.kind, content, metadata: input.metadata })
            send(res, 201, record)
            return
          }
          if (id !== undefined && method === 'GET' && sub === undefined) {
            const record = kernel.getArtifact(id)
            const content = kernel.cas.read(record.sha256)
            res.writeHead(200, {
              'content-type': 'application/octet-stream',
              'content-length': content.byteLength,
              'x-artifact-id': record.artifact_id,
            })
            res.end(content)
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
          if (id !== undefined && method === 'GET') {
            ok(res, kernel.getJob(id))
            return
          }
          if (id !== undefined && sub === 'status' && method === 'POST') {
            const input = jobCompleteSchema.parse(body)
            ok(res, kernel.completeJob({ job_id: id, ...input }))
            return
          }
          if (id !== undefined && sub === 'heartbeat' && method === 'POST') {
            const input = z.object({ owner: z.string().min(1) }).parse(body)
            ok(res, kernel.heartbeatJob(id, input.owner))
            return
          }
          if (id !== undefined && sub === 'cancel' && method === 'POST') {
            const input = z.object({ actor: z.string().min(1), reason: z.string().optional() }).parse(body)
            ok(res, kernel.cancelJob(id, input.actor, input.reason))
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

/** Start the kernel API server; returns the listening server. */
export function startKernelServer(options: KernelServerOptions): Promise<{ server: Server; url: string; port: number }> {
  const { kernel, host = '127.0.0.1', port = 7412, token } = options
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
