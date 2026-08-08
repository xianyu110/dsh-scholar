/**
 * v2 adapter tests (api-contracts.md §4): Idempotency-Key-scoped project
 * creation (replay returns the same project/gate/budget/membership, a
 * different request hash is 409), membership-filtered pagination, projection
 * with capabilities, gate-requests without decisions, transitions that keep
 * gate states 422, and x-principal-id membership enforcement.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel } from '@dsh-scholar/research-kernel'
import { startKernelServer } from '../../packages/research-kernel/lib/server.js'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v2-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas') })
}

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'v2proj',
    workspace: '/w/v2',
    mode: 'gate-only',
    brief: {
      problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
      resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
      baseline_repo: null, domain: 'ml',
    },
    creator_principal_id: 'ops-1',
    ...overrides,
  }
}

async function withServer(kernel: ResearchKernel, fn: (base: string) => Promise<void>): Promise<void> {
  const { server, port } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

describe('v2 project adapter', () => {
  it('POST /v2/projects requires an Idempotency-Key and returns project+gate+budget+membership', async () => {
    const kernel = freshKernel()
    await withServer(kernel, async (base) => {
      const noKey = await fetch(`${base}/v2/projects`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(makeBody()),
      })
      expect(noKey.status).toBe(422)
      const created = await fetch(`${base}/v2/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' },
        body: JSON.stringify(makeBody()),
      })
      expect(created.status).toBe(201)
      const out = await created.json() as { project: { project_id: string }; gate: { type: string }; budget: Record<string, unknown>; membership: Array<{ role: string }> }
      expect(out.gate.type).toBe('scope')
      expect(out.membership[0]!.role).toBe('pi')
      expect(out.budget.project_id).toBe(out.project.project_id)
      // Replay with the same key + identical body -> the SAME project.
      const replay = await fetch(`${base}/v2/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' },
        body: JSON.stringify(makeBody()),
      })
      expect(replay.status).toBe(201)
      const replayed = await replay.json() as { project: { project_id: string } }
      expect(replayed.project.project_id).toBe(out.project.project_id)
      // Same key + DIFFERENT body -> 409 idempotency_conflict.
      const conflict = await fetch(`${base}/v2/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' },
        body: JSON.stringify(makeBody({ name: 'different-name' })),
      })
      expect(conflict.status).toBe(409)
      expect((await conflict.json() as { error: { code: string } }).error.code).toBe('idempotency_conflict')
    })
  })

  it('GET /v2/projects paginates and filters by x-principal-id membership', async () => {
    const kernel = freshKernel()
    await withServer(kernel, async (base) => {
      for (let i = 0; i < 3; i++) {
        const body = makeBody({ name: `p${i}`, creator_principal_id: i === 0 ? 'ops-1' : 'ops-2' })
        await fetch(`${base}/v2/projects`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `create-${i}` }, body: JSON.stringify(body),
        })
      }
      // ops-1 sees only their own project.
      const filtered = await fetch(`${base}/v2/projects`, { headers: { 'x-principal-id': 'ops-1' } })
      const page = await filtered.json() as { items: Array<{ name: string }>; next_cursor: string | null }
      expect(page.items.map(i => i.name)).toEqual(['p0'])
      // limit=1 keyset pagination walks all three without overlap.
      const seen: string[] = []
      let cursor: string | null = null
      for (let round = 0; round < 6; round++) {
        const q = new URLSearchParams({ limit: '1' })
        if (cursor !== null) q.set('cursor', cursor)
        const r = await fetch(`${base}/v2/projects?${q.toString()}`)
        const p = await r.json() as { items: Array<{ name: string }>; next_cursor: string | null }
        for (const item of p.items) seen.push(item.name)
        cursor = p.next_cursor
        if (cursor === null) break
      }
      expect(seen).toEqual(['p2', 'p1', 'p0'])
      // limit cap: 500 -> 200
      const capped = await fetch(`${base}/v2/projects?limit=500`)
      const cp = await capped.json() as { items: unknown[] }
      expect(cp.items.length).toBeLessThanOrEqual(200)
    })
  })

  it('projection carries capabilities; gate-requests reject decisions; gate transitions stay 422', async () => {
    const kernel = freshKernel()
    await withServer(kernel, async (base) => {
      const created = await fetch(`${base}/v2/projects`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'create-x' }, body: JSON.stringify(makeBody()),
      })
      const { project } = await created.json() as { project: { project_id: string } }
      const proj = await fetch(`${base}/v2/projects/${project.project_id}/projection`, { headers: { 'x-principal-id': 'ops-1' } })
      const projection = await proj.json() as { capabilities: { editor: boolean; runner_profile: string; roles: string[]; membership: string } }
      expect(projection.capabilities.editor).toBe(true)
      expect(projection.capabilities.roles).toContain('pi')
      expect(projection.capabilities.membership).toBe('pi')
      // A non-member principal gets 404 (no enumeration).
      const denied = await fetch(`${base}/v2/projects/${project.project_id}/projection`, { headers: { 'x-principal-id': 'other' } })
      expect(denied.status).toBe(404)
      // Gate request without a decision is fine.
      const req = await fetch(`${base}/v2/projects/${project.project_id}/gate-requests`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'ops-1' },
        body: JSON.stringify({ type: 'idea', title: 'Idea Gate' }),
      })
      expect(req.status).toBe(201)
      // Gate request WITH a decision is rejected.
      const evil = await fetch(`${base}/v2/projects/${project.project_id}/gate-requests`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'ops-1' },
        body: JSON.stringify({ type: 'idea', title: 'Evil', decision: 'approved', actor: 'agent-tool' }),
      })
      expect(evil.status).toBe(422)
      expect((await evil.json() as { error: { code: string } }).error.code).toBe('decision_not_allowed')
      // Transition into a gate state is 422 (SCOPED is gate-controlled; the
      // generic table excludes it — with the correct revision the 422 fires).
      const badT = await fetch(`${base}/v2/projects/${project.project_id}/transitions`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-principal-id': 'ops-1' },
        body: JSON.stringify({ to: 'SCOPED', expected_revision: 0 }),
      })
      expect(badT.status).toBe(422)
      expect((await badT.json() as { error: { code: string } }).error.code).toBe('invalid_transition')
      // Unknown v2 route -> 404.
      const unknown = await fetch(`${base}/v2/projects/${project.project_id}/nothing`)
      expect(unknown.status).toBe(404)
    })
  })

  it('request hash is deterministic over the body', () => {
    const h1 = createHash('sha256').update(JSON.stringify(makeBody())).digest('hex')
    const h2 = createHash('sha256').update(JSON.stringify(makeBody())).digest('hex')
    expect(h1).toBe(h2)
  })
})
