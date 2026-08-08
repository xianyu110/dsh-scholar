/**
 * Durable Research Orchestrator tests (design §8.2–§8.5).
 *
 * - Pure rule tests: every Kernel status maps to the correct §8.3 action;
 *   gate idempotency; terminal states produce no automation; §8.4 retry cap.
 * - Engine tests against an embedded fake Kernel (node:http): dry-run mode,
 *   gate creation + idempotent re-polls, pending-gate reconciliation, failure
 *   policy, §8.5 crash recovery of stale `running` rows.
 * - Integration test against a REAL kernel process (spawned
 *   packages/research-kernel/lib/bin/kernel.js): DRAFT → scope gate created,
 *   action persisted, second Engine instance on the same store does not
 *   duplicate the gate; after approving the gate the next poll records the
 *   `survey-ready` note action.
 *
 * Tests run against the built package (lib/); run
 * `pnpm --filter @dsh-scholar/research-orchestrator run build` first.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ActionStore,
  Engine,
  decideActions,
  planForStatus,
  type Action,
  type ActionLike,
  type ActionStatus,
  type ProjectStatus,
} from '../../workers/research-orchestrator/lib/index.js'

// ── helpers ─────────────────────────────────────────────────────────────────

function act(key: string, status: ActionStatus, attempt = 0, maxAttempts = 3): ActionLike {
  return { idempotency_key: key, status, attempt, max_attempts: maxAttempts }
}

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'orch-store-')), 'actions.db')
}

function makeBrief() {
  return {
    problem: 'problem', scope: 'scope', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

interface FakeKernelProject {
  project_id: string
  status: string
  pending_gates?: Array<{ gate_id: string; type: string; title: string; status: string }>
}

interface FakeKernelHandle {
  url: string
  close: () => Promise<void>
  requests: Array<{ method: string; path: string; body: unknown }>
}

/** Embedded fake Kernel: /v1/projects, /v1/projects/{id}/projection,
 * POST /v1/projects/{id}/gates (optionally failing), /v1/health. */
function startFakeKernel(projects: FakeKernelProject[], failGates = false): Promise<FakeKernelHandle> {
  return new Promise((resolve, reject) => {
    const requests: FakeKernelHandle['requests'] = []
    const server: Server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const parts = url.pathname.split('/').filter(Boolean)
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const bodyText = Buffer.concat(chunks).toString('utf8')
      const body = bodyText === '' ? null : JSON.parse(bodyText) as unknown
      requests.push({ method: req.method ?? 'GET', path: url.pathname, body })
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (parts[0] === 'v1' && parts[1] === 'health') return send(200, { ok: true })
      if (parts[0] === 'v1' && parts[1] === 'projects' && parts.length === 2 && req.method === 'GET') {
        return send(200, projects.map(p => ({ project_id: p.project_id, status: p.status })))
      }
      if (parts[0] === 'v1' && parts[1] === 'projects' && parts.length === 4 && parts[3] === 'projection' && req.method === 'GET') {
        const project = projects.find(p => p.project_id === decodeURIComponent(parts[2] ?? ''))
        if (project === undefined) return send(404, { error: { code: 'project_not_found', message: 'nope' } })
        return send(200, { project: { project_id: project.project_id, status: project.status }, pending_gates: project.pending_gates ?? [] })
      }
      if (parts[0] === 'v1' && parts[1] === 'projects' && parts.length === 4 && parts[3] === 'gates' && req.method === 'POST') {
        if (failGates) return send(500, { error: { code: 'internal', message: 'kernel boom' } })
        return send(201, { gate_id: `gate_${requests.length}`, type: (body as { type?: string } | null)?.type ?? 'scope', status: 'pending' })
      }
      return send(404, { error: { code: 'not_found', message: `no route ${req.method} ${url.pathname}` } })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise(resolveClose => server.close(() => resolveClose(undefined))),
        requests,
      })
    })
  })
}

// ── §8.3 pure rules: planForStatus ──────────────────────────────────────────

describe('planForStatus — §8.3 automatic-advance mapping', () => {
  it('DRAFT → creates a Scope Gate request', () => {
    const plan = planForStatus('DRAFT')
    expect(plan).not.toBeNull()
    expect(plan?.type).toBe('scope-gate')
    expect(plan?.kind).toBe('gate')
    expect(plan?.gate_type).toBe('scope')
    expect(plan?.title).toBe('Scope Gate')
  })

  it('SCOPED → survey-ready note, blocked for the Scholar panel (no auto survey)', () => {
    const plan = planForStatus('SCOPED')
    expect(plan).not.toBeNull()
    expect(plan?.type).toBe('survey-ready')
    expect(plan?.idempotency_key).toBe('survey-ready')
    expect(plan?.kind).toBe('note')
    expect(plan?.note).toContain('Scholar 面板')
  })

  it('SURVEYING → no automatic action (model/human work)', () => {
    expect(planForStatus('SURVEYING')).toBeNull()
  })

  it('IDEATING → Idea Gate request', () => {
    const plan = planForStatus('IDEATING')
    expect(plan?.type).toBe('idea-gate')
    expect(plan?.kind).toBe('gate')
    expect(plan?.gate_type).toBe('idea')
  })

  it('IDEA_APPROVED → baseline-ready note (waits for baseline reproduction)', () => {
    const plan = planForStatus('IDEA_APPROVED')
    expect(plan?.type).toBe('baseline-ready')
    expect(plan?.kind).toBe('note')
    expect(plan?.note).toContain('baseline')
  })

  it('BASELINE_REPRO → Contract Gate request', () => {
    const plan = planForStatus('BASELINE_REPRO')
    expect(plan?.type).toBe('contract-gate')
    expect(plan?.kind).toBe('gate')
    expect(plan?.gate_type).toBe('contract')
  })

  it('CONTRACT_APPROVED → experiment-ready note', () => {
    const plan = planForStatus('CONTRACT_APPROVED')
    expect(plan?.type).toBe('experiment-ready')
    expect(plan?.kind).toBe('note')
  })

  it('EXPERIMENTING → analysis-ready note (waits for formal runs)', () => {
    const plan = planForStatus('EXPERIMENTING')
    expect(plan?.type).toBe('analysis-ready')
    expect(plan?.kind).toBe('note')
  })

  it('EVIDENCE_READY → manuscript-ready note', () => {
    const plan = planForStatus('EVIDENCE_READY')
    expect(plan?.type).toBe('manuscript-ready')
    expect(plan?.kind).toBe('note')
  })

  it('WRITING → review-ready note', () => {
    const plan = planForStatus('WRITING')
    expect(plan?.type).toBe('review-ready')
    expect(plan?.kind).toBe('note')
  })

  it('REVIEWING → Release Gate request', () => {
    const plan = planForStatus('REVIEWING')
    expect(plan?.type).toBe('release-gate')
    expect(plan?.kind).toBe('gate')
    expect(plan?.gate_type).toBe('release')
  })

  it('RELEASE_READY → release-pending-human note (release stays human)', () => {
    const plan = planForStatus('RELEASE_READY')
    expect(plan?.type).toBe('release-pending-human')
    expect(plan?.kind).toBe('note')
    expect(plan?.note).toContain('人工')
  })

  it.each<ProjectStatus>(['BLOCKED_GATE', 'FAILED', 'STOPPED', 'ARCHIVED', 'RELEASED'])(
    '%s → observe only, no automation',
    (status) => {
      const plan = planForStatus(status)
      expect(plan?.kind).toBe('observe')
      expect(plan?.idempotency_key).toBe(`observe:${status}`)
    },
  )
})

// ── §8.3/§8.4 pure rules: decideActions (idempotency + retry) ───────────────

describe('decideActions — idempotency and retry policy', () => {
  it('fresh project: returns the planned action for its status', () => {
    expect(decideActions('DRAFT', [])).toHaveLength(1)
    expect(decideActions('DRAFT', [])[0]?.type).toBe('scope-gate')
    expect(decideActions('SCOPED', [])[0]?.type).toBe('survey-ready')
  })

  it('gate idempotency: existing done/blocked action is never re-run', () => {
    expect(decideActions('DRAFT', [act('scope-gate', 'done')])).toEqual([])
    expect(decideActions('DRAFT', [act('scope-gate', 'blocked')])).toEqual([])
  })

  it('idempotency is key-scoped: an unrelated recorded action does not suppress the plan', () => {
    const plans = decideActions('DRAFT', [act('observe:FAILED', 'done')])
    expect(plans).toHaveLength(1)
    expect(plans[0]?.type).toBe('scope-gate')
  })

  it('retry: queued/running actions are re-attempted while under the cap', () => {
    expect(decideActions('DRAFT', [act('scope-gate', 'queued', 1, 3)])).toHaveLength(1)
    expect(decideActions('DRAFT', [act('scope-gate', 'running', 1, 3)])).toHaveLength(1)
  })

  it('retry: failed actions are re-attempted while attempt < max_attempts', () => {
    expect(decideActions('DRAFT', [act('scope-gate', 'failed', 2, 3)])).toHaveLength(1)
  })

  it('failure cap: failed at attempt >= max_attempts is never retried', () => {
    expect(decideActions('DRAFT', [act('scope-gate', 'failed', 3, 3)])).toEqual([])
    expect(decideActions('DRAFT', [act('scope-gate', 'failed', 2, 2)])).toEqual([])
  })

  it('terminal statuses: observe action is recorded once and then suppressed', () => {
    expect(decideActions('FAILED', [])[0]?.kind).toBe('observe')
    expect(decideActions('FAILED', [act('observe:FAILED', 'done')])).toEqual([])
  })
})

// ── §8.2 ActionStore ────────────────────────────────────────────────────────

describe('ActionStore — SQLite persistence (§8.2)', () => {
  it('insert/get/update roundtrip', () => {
    const store = new ActionStore({ dbPath: freshDbPath() })
    const action = ActionStore.newAction({
      project_id: 'rsp_1', phase: 'DRAFT', type: 'scope-gate', idempotency_key: 'scope-gate',
    })
    expect(store.insert(action)).toBe(true)
    const loaded = store.get('rsp_1', 'scope-gate')
    expect(loaded?.action_id).toBe(action.action_id)
    expect(loaded?.status).toBe('queued')
    expect(loaded?.max_attempts).toBe(3)
    store.updateStatus(action.action_id, 'blocked', { attempt: 1, last_error: '等待人类' })
    const updated = store.get('rsp_1', 'scope-gate')
    expect(updated?.status).toBe('blocked')
    expect(updated?.attempt).toBe(1)
    expect(updated?.last_error).toBe('等待人类')
    store.close()
  })

  it('UNIQUE(project_id, idempotency_key): same key in same project is a no-op, other projects are independent', () => {
    const store = new ActionStore({ dbPath: freshDbPath() })
    const a = ActionStore.newAction({ project_id: 'rsp_1', phase: 'DRAFT', type: 'scope-gate', idempotency_key: 'scope-gate' })
    const dup = ActionStore.newAction({ project_id: 'rsp_1', phase: 'DRAFT', type: 'scope-gate', idempotency_key: 'scope-gate' })
    const other = ActionStore.newAction({ project_id: 'rsp_2', phase: 'DRAFT', type: 'scope-gate', idempotency_key: 'scope-gate' })
    expect(store.insert(a)).toBe(true)
    expect(store.insert(dup)).toBe(false)
    expect(store.insert(other)).toBe(true)
    expect(store.listByProject('rsp_1')).toHaveLength(1)
    expect(store.list()).toHaveLength(2)
    store.close()
  })

  it('recover(): stale running rows become queued again (§8.5)', () => {
    const store = new ActionStore({ dbPath: freshDbPath() })
    const running = ActionStore.newAction({ project_id: 'rsp_1', phase: 'DRAFT', type: 'scope-gate', idempotency_key: 'scope-gate', status: 'running' })
    const done = ActionStore.newAction({ project_id: 'rsp_1', phase: 'FAILED', type: 'observe', idempotency_key: 'observe:FAILED', status: 'done' })
    store.insert(running)
    store.insert(done)
    expect(store.recover()).toBe(1)
    expect(store.get('rsp_1', 'scope-gate')?.status).toBe('queued')
    expect(store.get('rsp_1', 'observe:FAILED')?.status).toBe('done')
    store.close()
  })
})

// ── Engine against the embedded fake Kernel ─────────────────────────────────

describe('Engine — poll loop over the fake Kernel', () => {
  it('dryRun: computes the plan without Kernel writes and without persistence', async () => {
    const fake = await startFakeKernel([{ project_id: 'rsp_a', status: 'DRAFT' }])
    try {
      const engine = new Engine({ kernelUrl: fake.url, dbPath: freshDbPath(), dryRun: true })
      const result = await engine.pollOnce()
      expect(result.planned).toBe(1)
      expect(result.details[0]?.planned[0]?.type).toBe('scope-gate')
      expect(fake.requests.filter(r => r.method === 'POST')).toHaveLength(0)
      expect(engine.store.list()).toHaveLength(0)
      engine.close()
    } finally {
      await fake.close()
    }
  })

  it('creates the Gate, marks the action blocked, and is idempotent on the next poll', async () => {
    const fake = await startFakeKernel([{ project_id: 'rsp_a', status: 'DRAFT' }])
    try {
      const engine = new Engine({ kernelUrl: fake.url, dbPath: freshDbPath() })
      const first = await engine.pollOnce()
      expect(first.executed).toBe(1)
      const posts = fake.requests.filter(r => r.method === 'POST' && r.path.endsWith('/gates'))
      expect(posts).toHaveLength(1)
      expect((posts[0]?.body as { type?: string })?.type).toBe('scope')
      const action = engine.store.get('rsp_a', 'scope-gate')
      expect(action?.status).toBe('blocked')
      expect(action?.attempt).toBe(1)

      const second = await engine.pollOnce()
      expect(second.planned).toBe(0)
      expect(fake.requests.filter(r => r.method === 'POST' && r.path.endsWith('/gates'))).toHaveLength(1)
      engine.close()
    } finally {
      await fake.close()
    }
  })

  it('reconciles when a pending gate of the right type already exists in the Kernel', async () => {
    const fake = await startFakeKernel([{
      project_id: 'rsp_a', status: 'DRAFT',
      pending_gates: [{ gate_id: 'gate_1', type: 'scope', title: 'Scope Gate', status: 'pending' }],
    }])
    try {
      const engine = new Engine({ kernelUrl: fake.url, dbPath: freshDbPath() })
      const result = await engine.pollOnce()
      expect(fake.requests.filter(r => r.method === 'POST' && r.path.endsWith('/gates'))).toHaveLength(0)
      expect(engine.store.get('rsp_a', 'scope-gate')?.status).toBe('done')
      expect(result.errors).toEqual([])
      engine.close()
    } finally {
      await fake.close()
    }
  })

  it('§8.4 failure policy: retries on 500, then marks failed at the attempt cap and stops', async () => {
    const fake = await startFakeKernel([{ project_id: 'rsp_a', status: 'DRAFT' }], true)
    try {
      const engine = new Engine({ kernelUrl: fake.url, dbPath: freshDbPath(), maxAttempts: 3 })
      await engine.pollOnce()
      let action = engine.store.get('rsp_a', 'scope-gate')
      expect(action?.status).toBe('queued')
      expect(action?.attempt).toBe(1)
      expect(action?.last_error).toContain('kernel boom')

      await engine.pollOnce()
      action = engine.store.get('rsp_a', 'scope-gate')
      expect(action?.attempt).toBe(2)
      expect(action?.status).toBe('queued')

      await engine.pollOnce()
      action = engine.store.get('rsp_a', 'scope-gate')
      expect(action?.attempt).toBe(3)
      expect(action?.status).toBe('failed')

      const fourth = await engine.pollOnce()
      expect(fourth.planned).toBe(0)
      expect(fake.requests.filter(r => r.method === 'POST' && r.path.endsWith('/gates'))).toHaveLength(3)
      engine.close()
    } finally {
      await fake.close()
    }
  })

  it('observe actions on terminal statuses are recorded done and never repeated', async () => {
    const fake = await startFakeKernel([{ project_id: 'rsp_a', status: 'FAILED' }])
    try {
      const engine = new Engine({ kernelUrl: fake.url, dbPath: freshDbPath() })
      const first = await engine.pollOnce()
      expect(first.executed).toBe(1)
      expect(engine.store.get('rsp_a', 'observe:FAILED')?.status).toBe('done')
      const second = await engine.pollOnce()
      expect(second.planned).toBe(0)
      engine.close()
    } finally {
      await fake.close()
    }
  })

  it('§8.5 crash recovery: a new Engine re-attempts actions a crashed process left running', async () => {
    const dbPath = freshDbPath()
    const store = new ActionStore({ dbPath })
    store.insert(ActionStore.newAction({
      project_id: 'rsp_a', phase: 'DRAFT', type: 'scope-gate', idempotency_key: 'scope-gate', status: 'running',
    }))
    store.close()
    const fake = await startFakeKernel([{ project_id: 'rsp_a', status: 'DRAFT' }])
    try {
      const engine = new Engine({ kernelUrl: fake.url, dbPath })
      // constructor ran recover(): stale running → queued, so the poll retries
      const result = await engine.pollOnce()
      expect(result.planned).toBe(1)
      expect(engine.store.get('rsp_a', 'scope-gate')?.status).toBe('blocked')
      engine.close()
    } finally {
      await fake.close()
    }
  })
})

// ── Integration: real Kernel process ────────────────────────────────────────

const KERNEL_BIN = fileURLToPath(new URL('../../packages/research-kernel/lib/bin/kernel.js', import.meta.url))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
}

async function waitForHealth(url: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/v1/health`)
      if (response.ok) return
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('kernel process did not become healthy in time')
}

describe('integration — Engine against a real Kernel process', () => {
  let kernel: ChildProcess | undefined
  let kernelUrl: string
  let tmpDir: string
  let projectId: string
  const kernelStderr: Buffer[] = []

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orch-it-'))
    const port = await freePort()
    kernelUrl = `http://127.0.0.1:${port}`
    kernel = spawn(process.execPath, [
      KERNEL_BIN, '--db', join(tmpDir, 'kernel.db'), '--cas', join(tmpDir, 'cas'), '--port', String(port),
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    kernel.stderr?.on('data', (chunk: Buffer) => kernelStderr.push(chunk))
    kernel.on('exit', (code) => { kernel = undefined; void code })
    await waitForHealth(kernelUrl)
    const response = await fetch(`${kernelUrl}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'orchestrator-it', workspace: '/tmp/orch', brief: makeBrief() }),
    })
    expect(response.status).toBe(201)
    const project = await response.json() as { project_id: string }
    projectId = project.project_id
  })

  afterAll(() => {
    if (kernel !== undefined) kernel.kill('SIGTERM')
    rmSync(tmpDir, { recursive: true, force: true })
  })

  async function listGates(): Promise<Array<{ gate_id: string; type: string; status: string }>> {
    const response = await fetch(`${kernelUrl}/v1/projects/${projectId}/gates`)
    return response.json() as Promise<Array<{ gate_id: string; type: string; status: string }>>
  }

  async function approveGate(gateId: string): Promise<void> {
    const response = await fetch(`${kernelUrl}/v1/gates/${gateId}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'human', decision: 'approved' }),
    })
    expect(response.ok).toBe(true)
  }

  it('DRAFT: first poll creates exactly one Scope Gate and persists a blocked action', async () => {
    const dbPath = join(tmpDir, 'orch-actions.db')
    const engine = new Engine({ kernelUrl, dbPath })
    const result = await engine.pollOnce()
    expect(result.projects).toBe(1)
    expect(result.planned).toBe(1)
    expect(result.errors).toEqual([])

    const gates = await listGates()
    expect(gates).toHaveLength(1)
    expect(gates[0]?.type).toBe('scope')
    expect(gates[0]?.status).toBe('pending')

    const action = engine.store.get(projectId, 'scope-gate')
    expect(action?.type).toBe('scope-gate')
    expect(action?.status).toBe('blocked')
    expect(action?.phase).toBe('DRAFT')
    engine.close()
  })

  it('§8.5: a second Engine instance on the same store does not duplicate the gate', async () => {
    const dbPath = join(tmpDir, 'orch-actions.db')
    const engine = new Engine({ kernelUrl, dbPath })
    const result = await engine.pollOnce()
    expect(result.planned).toBe(0)
    expect(await listGates()).toHaveLength(1)
    engine.close()
  })

  it('after human approval, the next poll records survey-ready (blocked, waits for the Scholar panel)', async () => {
    const dbPath = join(tmpDir, 'orch-actions.db')
    const engine = new Engine({ kernelUrl, dbPath })
    const gates = await listGates()
    await approveGate(gates[0]!.gate_id)

    const projection = await (await fetch(`${kernelUrl}/v1/projects/${projectId}/projection`)).json() as { project: { status: string } }
    expect(projection.project.status).toBe('SCOPED')

    const result = await engine.pollOnce()
    expect(result.planned).toBe(1)
    const action = engine.store.get(projectId, 'survey-ready')
    expect(action?.status).toBe('blocked')
    expect(action?.last_error).toContain('Scholar 面板')
    // SCOPED must not create any additional gate
    expect(await listGates()).toHaveLength(1)
    engine.close()
  })

  it('terminal project (FAILED): only an observe action is recorded', async () => {
    const dbPath = join(tmpDir, 'orch-actions.db')
    const engine = new Engine({ kernelUrl, dbPath })
    const project = await (await fetch(`${kernelUrl}/v1/projects/${projectId}`)).json() as { revision: number }
    const transition = await fetch(`${kernelUrl}/v1/projects/${projectId}/transitions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'FAILED', expected_revision: project.revision, reason: 'it-test' }),
    })
    expect(transition.ok).toBe(true)
    const result = await engine.pollOnce()
    expect(result.planned).toBe(1)
    expect(engine.store.get(projectId, 'observe:FAILED')?.status).toBe('done')
    expect(engine.store.get(projectId, 'survey-ready')?.status).toBe('blocked') // history preserved
    engine.close()
  })
})
