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
import { ResearchKernel, dshOperatorPrincipal } from '@dsh-scholar/research-kernel'
import { ResearchClient } from '@dsh-scholar/research-client'
import { startKernelServer } from '../../packages/research-kernel/lib/server.js'
import { runNativeScholarTurn } from '../../src/plugin/native-chat.js'

function freshKernel(options: { serviceToken?: string; dshPluginToken?: string } = {}): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v2-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), ...options })
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
  it('uses one credential-derived operator principal across DSH sessions', () => {
    const kernel = freshKernel({ dshPluginToken: 'stable-dsh-secret' })
    const first = kernel.createProjectForDshSession({
      name: 'First session project', session_id: 'session_first',
      idempotency_key: 'first', request_hash: 'first-hash',
    })
    const second = kernel.createProjectForDshSession({
      name: 'Second session project', session_id: 'session_second',
      idempotency_key: 'second', request_hash: 'second-hash',
    })
    const expected = dshOperatorPrincipal('stable-dsh-secret')
    expect(first.membership).toContainEqual(expect.objectContaining({ principal_id: expected, role: 'pi' }))
    expect(second.membership).toContainEqual(expect.objectContaining({ principal_id: expected, role: 'pi' }))
    expect(expected).toMatch(/^dsh:[a-f0-9]{32}$/)
    kernel.close()
  })

  it('service-creates a name-only project and atomically links the exact DSH session', async () => {
    const kernel = freshKernel({ serviceToken: 'service-secret', dshPluginToken: 'dsh-secret' })
    await withServer(kernel, async (base) => {
      const url = `${base}/internal/dsh-sessions/session_native/projects`
      const request = (headers: Record<string, string>, body: Record<string, unknown> = { name: 'Native OCR' }) => fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
      })

      const service = { 'x-service-token': 'service-secret' }
      const plugin = { ...service, 'x-dsh-plugin-token': 'dsh-secret' }
      expect((await request({ 'x-service-principal': 'dsh-plugin', 'idempotency-key': 'native-create-1' })).status).toBe(403)
      expect((await request({ 'x-service-token': 'wrong', 'x-dsh-plugin-token': 'dsh-secret', 'x-service-principal': 'dsh-plugin', 'idempotency-key': 'native-create-1' })).status).toBe(403)
      expect((await request({ ...service, 'x-service-principal': 'dsh-plugin', 'idempotency-key': 'native-create-1' })).status).toBe(403)
      expect((await request({ ...service, 'x-dsh-plugin-token': 'wrong', 'x-service-principal': 'dsh-plugin', 'idempotency-key': 'native-create-1' })).status).toBe(403)
      expect((await request({ ...plugin, 'x-service-principal': 'browser', 'idempotency-key': 'native-create-1' })).status).toBe(403)
      expect((await request({ ...plugin, 'x-service-principal': 'dsh-plugin' })).status).toBe(422)
      expect((await request({
        ...plugin, 'x-service-principal': 'dsh-plugin', 'idempotency-key': 'native-extra-field',
      }, { name: 'Native OCR', session_id: 'forged' })).status).toBe(422)
      const unsafeSession = await fetch(`${base}/internal/dsh-sessions/bad%2Fsession/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', ...plugin,
          'x-service-principal': 'dsh-plugin', 'idempotency-key': 'native-unsafe-session',
        },
        body: JSON.stringify({ name: 'Unsafe session' }),
      })
      expect(unsafeSession.status).toBe(422)

      const createdResponse = await request({
        ...plugin,
        'x-service-principal': 'dsh-plugin',
        'idempotency-key': 'native-create-1',
      })
      expect(createdResponse.status).toBe(201)
      const created = await createdResponse.json() as {
        project: { project_id: string; name: string; brief_status: string; status: string }
        intake: { project_id: string; status: string }
        membership: Array<{ principal_id: string; role: string }>
        link: { session_id: string; project_id: string }
      }
      expect(created.project).toMatchObject({ name: 'Native OCR', brief_status: 'collecting', status: 'DRAFT' })
      expect(created.intake).toMatchObject({ project_id: created.project.project_id, status: 'draft' })
      expect(created.link).toEqual(expect.objectContaining({ session_id: 'session_native', project_id: created.project.project_id }))
      expect(created.membership).toContainEqual(expect.objectContaining({ principal_id: expect.stringMatching(/^dsh:[a-f0-9]{32}$/), role: 'pi' }))
      expect(kernel.getProjectBySession('session_native')?.project_id).toBe(created.project.project_id)
      expect(kernel.listGates(created.project.project_id)).toEqual([])

      const replay = await request({
        ...plugin,
        'x-service-principal': 'dsh-plugin',
        'idempotency-key': 'native-create-1',
      })
      expect(replay.status).toBe(201)
      expect(((await replay.json()) as { project: { project_id: string } }).project.project_id).toBe(created.project.project_id)

      const conflictingName = await request({
        ...plugin,
        'x-service-principal': 'dsh-plugin',
        'idempotency-key': 'native-create-1',
      }, { name: 'Different name' })
      expect(conflictingName.status).toBe(409)
      const secondCreate = await request({
        ...plugin,
        'x-service-principal': 'dsh-plugin',
        'idempotency-key': 'native-create-2',
      }, { name: 'Second project' })
      expect(secondCreate.status).toBe(409)
      expect(kernel.listProjects()).toHaveLength(1)
    })
    kernel.close()
  })

  it('ResearchClient sends both service credentials and create/link never overwrites fenced rows', async () => {
    const kernel = freshKernel({ serviceToken: 'service-secret', dshPluginToken: 'dsh-secret' })
    await withServer(kernel, async (base) => {
      const client = new ResearchClient({ endpoint: base, serviceToken: 'service-secret', dshPluginToken: 'dsh-secret' })
      const first = await client.createProjectForDshSession({
        session_id: 'session_client', name: 'Client Project', idempotency_key: 'client-create-1',
      })
      expect(first.link).toMatchObject({ session_id: 'session_client', project_id: first.project.project_id })

      const archived = kernel.archiveProject(first.project.project_id)
      kernel.deleteProject({
        project_id: first.project.project_id, expected_revision: archived.revision,
        confirm_name: first.project.name, reason: 'test tombstone fence', deleted_by: 'pi_test', request_id: 'delete-client-project',
      })
      await expect(client.createProjectForDshSession({
        session_id: 'session_client', name: 'Replacement', idempotency_key: 'client-create-2',
      })).rejects.toMatchObject({ status: 409, code: 'session_link_conflict' })
      expect((kernel.db.prepare('SELECT project_id FROM session_links WHERE session_id = ?').get('session_client') as { project_id: string }).project_id)
        .toBe(first.project.project_id)

      kernel.db.prepare('INSERT INTO session_links (session_id, project_id, linked_at) VALUES (?, ?, ?)')
        .run('session_dangling', 'rsp_missing', new Date().toISOString())
      await expect(client.createProjectForDshSession({
        session_id: 'session_dangling', name: 'Dangling Replacement', idempotency_key: 'client-create-3',
      })).rejects.toMatchObject({ status: 409, code: 'session_link_conflict' })
      expect((kernel.db.prepare('SELECT project_id FROM session_links WHERE session_id = ?').get('session_dangling') as { project_id: string }).project_id)
        .toBe('rsp_missing')
      expect(kernel.db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toMatchObject({ n: 1 })

      const noPlugin = new ResearchClient({ endpoint: base, serviceToken: 'service-secret' })
      await expect(noPlugin.createProjectForDshSession({
        session_id: 'session_no_plugin', name: 'Denied', idempotency_key: 'client-denied',
      })).rejects.toMatchObject({ status: 403, code: 'dsh_plugin_token_required' })
    })
    kernel.close()
  })

  it('requires the Kernel bearer before either internal credential is considered', async () => {
    const kernel = freshKernel({ serviceToken: 'service-secret', dshPluginToken: 'dsh-secret' })
    const { server, port } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0, token: 'kernel-secret' })
    try {
      const url = `http://127.0.0.1:${port}/internal/dsh-sessions/session_bearer/projects`
      const request = (authorization?: string) => fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorization === undefined ? {} : { authorization }),
          'x-service-token': 'service-secret', 'x-dsh-plugin-token': 'dsh-secret',
          'x-service-principal': 'dsh-plugin', 'idempotency-key': 'bearer-create',
        },
        body: JSON.stringify({ name: 'Bearer Project' }),
      })
      expect((await request()).status).toBe(401)
      expect((await request('Bearer wrong')).status).toBe(401)
      expect((await request('Bearer kernel-secret')).status).toBe(201)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      kernel.close()
    }
  })

  it('treats an empty or blank DSH plugin credential as missing', async () => {
    for (const dshPluginToken of ['', '   ']) {
      const kernel = freshKernel({ serviceToken: 'service-secret', dshPluginToken })
      await withServer(kernel, async (base) => {
        const client = new ResearchClient({ endpoint: base, serviceToken: 'service-secret', dshPluginToken })
        await expect(client.createProjectForDshSession({
          session_id: 'session_blank_plugin', name: 'Denied', idempotency_key: `blank-plugin-${dshPluginToken.length}`,
        })).rejects.toMatchObject({ status: 403, code: 'dsh_plugin_token_required' })
        expect(kernel.listProjects()).toHaveLength(0)
      })
      kernel.close()
    }
  })

  it('keeps public v2 idempotency rows isolated from DSH create/link', async () => {
    const kernel = freshKernel({ serviceToken: 'service-secret', dshPluginToken: 'dsh-secret' })
    await withServer(kernel, async (base) => {
      const forgedBody = await fetch(`${base}/v2/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-principal-id': 'attacker', 'idempotency-key': 'collision-forged' },
        body: JSON.stringify({ route: 'dsh-create-link-v1', session_id: 'sid_collision', name: 'Collision' }),
      })
      // Legacy extra fields remain ignored for compatibility. The internal
      // receipt hash is credential-bound, so exact public bytes cannot forge it.
      expect(forgedBody.status).toBe(201)

      const client = new ResearchClient({ endpoint: base, serviceToken: 'service-secret', dshPluginToken: 'dsh-secret' })
      await expect(client.createProjectForDshSession({
        session_id: 'sid_collision', name: 'Collision', idempotency_key: 'collision-forged',
      })).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' })
      expect(kernel.getProjectBySession('sid_collision')).toBeNull()

      const publicCreate = await fetch(`${base}/v2/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-principal-id': 'attacker', 'idempotency-key': 'collision-key' },
        body: JSON.stringify({ name: 'Collision' }),
      })
      expect(publicCreate.status).toBe(201)
      await expect(client.createProjectForDshSession({
        session_id: 'sid_collision', name: 'Collision', idempotency_key: 'collision-key',
      })).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' })
      expect(kernel.getProjectBySession('sid_collision')).toBeNull()
      expect(kernel.listProjectMembers(kernel.listProjects()[0]!.project_id)).toContainEqual(expect.objectContaining({ principal_id: 'attacker' }))
    })
    kernel.close()
  })

  it('does not expose an internal DSH receipt to a later public v2 collision', async () => {
    const kernel = freshKernel({ serviceToken: 'service-secret', dshPluginToken: 'dsh-secret' })
    await withServer(kernel, async (base) => {
      const client = new ResearchClient({ endpoint: base, serviceToken: 'service-secret', dshPluginToken: 'dsh-secret' })
      const internal = await client.createProjectForDshSession({
        session_id: 'sid_internal_first', name: 'Internal First', idempotency_key: 'internal-first-key',
      })
      const publicCollision = await fetch(`${base}/v2/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-principal-id': 'attacker', 'idempotency-key': 'internal-first-key' },
        body: JSON.stringify({ route: 'dsh-create-link-v1', session_id: 'sid_internal_first', name: 'Internal First' }),
      })
      expect(publicCollision.status).toBe(409)
      expect(await publicCollision.json()).toMatchObject({ error: { code: 'idempotency_conflict' } })
      expect(kernel.getProjectBySession('sid_internal_first')?.project_id).toBe(internal.project.project_id)
      expect(kernel.listProjectMembers(internal.project.project_id)).not.toContainEqual(expect.objectContaining({ principal_id: 'attacker' }))
      expect(kernel.listProjects()).toHaveLength(1)
    })
    kernel.close()
  })

  it('replay-only returns only the committed receipt and never creates one when absent', async () => {
    const kernel = freshKernel({ serviceToken: 'service-secret', dshPluginToken: 'dsh-secret' })
    await withServer(kernel, async (base) => {
      const client = new ResearchClient({ endpoint: base, serviceToken: 'service-secret', dshPluginToken: 'dsh-secret' })
      await expect(client.createProjectForDshSession({
        session_id: 'session_replay_missing', name: 'Missing', idempotency_key: 'missing-key', replay_only: true,
      })).rejects.toMatchObject({ status: 404, code: 'idempotency_receipt_not_found' })
      expect(kernel.listProjects()).toHaveLength(0)

      const created = await client.createProjectForDshSession({
        session_id: 'session_replay', name: 'Replay Project', idempotency_key: 'replay-key',
      })
      const replay = await client.createProjectForDshSession({
        session_id: 'session_replay', name: 'Replay Project', idempotency_key: 'replay-key', replay_only: true,
      })
      expect(replay.project.project_id).toBe(created.project.project_id)
      expect(kernel.listProjects()).toHaveLength(1)
    })
    kernel.close()
  })

  it('serializes concurrent create/link attempts so only one project owns the session', async () => {
    const kernel = freshKernel({ serviceToken: 'service-secret', dshPluginToken: 'dsh-secret' })
    await withServer(kernel, async (base) => {
      const client = new ResearchClient({ endpoint: base, serviceToken: 'service-secret', dshPluginToken: 'dsh-secret' })
      const results = await Promise.allSettled([
        client.createProjectForDshSession({ session_id: 'session_race', name: 'Race A', idempotency_key: 'race-a' }),
        client.createProjectForDshSession({ session_id: 'session_race', name: 'Race B', idempotency_key: 'race-b' }),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      expect(kernel.listProjects()).toHaveLength(1)
      expect(kernel.getProjectBySession('session_race')?.project_id).toBe(kernel.listProjects()[0]?.project_id)
    })
    kernel.close()
  })

  it('runs the native façade through ResearchClient and the real Kernel route', async () => {
    const kernel = freshKernel({ serviceToken: 'service-secret', dshPluginToken: 'dsh-secret' })
    await withServer(kernel, async (base) => {
      const client = new ResearchClient({ endpoint: base, serviceToken: 'service-secret', dshPluginToken: 'dsh-secret' })
      const reply = await runNativeScholarTurn({
        text: '创建研究项目 真实链路', projectName: '真实链路', sessionId: 'session_e2e', client,
        cache: { get: async () => undefined, set: async () => undefined },
      })
      expect(reply).toMatchObject({
        linked: true,
        project: { name: '真实链路', status: 'DRAFT', brief_status: 'collecting' },
        next_action: { code: 'intake_resume', required_by: 'human' },
        execution: { status: 'executed', operation: 'project_create' },
      })
      const linked = kernel.getProjectBySession('session_e2e')
      expect(linked?.project_id).toBe(reply.project?.project_id)
      expect(kernel.listGates(linked!.project_id)).toEqual([])
      expect(kernel.listProjectMembers(linked!.project_id)).toContainEqual(expect.objectContaining({
        principal_id: expect.stringMatching(/^dsh:[a-f0-9]{32}$/), role: 'pi',
      }))
    })
    kernel.close()
  })

  it('creates a name-only collecting project with an active Init Intake and no Gate', async () => {
    const kernel = freshKernel()
    await withServer(kernel, async (base) => {
      const created = await fetch(`${base}/v2/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'init-name-only-1',
          'x-principal-id': 'pi-init',
          'x-principal-role': 'pi',
        },
        body: JSON.stringify({ name: 'Continue my research' }),
      })
      expect(created.status).toBe(201)
      const out = await created.json() as {
        project: { project_id: string; status: string; brief_status: string }
        intake: { intake_id: string; project_id: string; status: string }
        budget: { project_id: string }
        membership: Array<{ principal_id: string; role: string }>
      }
      expect(out.project.status).toBe('DRAFT')
      expect(out.project.brief_status).toBe('collecting')
      expect(out.intake.project_id).toBe(out.project.project_id)
      expect(out.intake.status).toBe('draft')
      expect(out.budget.project_id).toBe(out.project.project_id)
      expect(out.membership).toContainEqual(expect.objectContaining({ principal_id: 'pi-init', role: 'pi' }))
      expect(kernel.listGates(out.project.project_id)).toEqual([])
      const projectionResponse = await fetch(`${base}/v2/projects/${out.project.project_id}/projection`, {
        headers: { 'x-principal-id': 'pi-init', 'x-principal-role': 'pi' },
      })
      const projection = await projectionResponse.json() as { next_actions_v2: Array<{ code: string }> }
      expect(projection.next_actions_v2.map(action => action.code)).toContain('intake_resume')
      expect(projection.next_actions_v2.map(action => action.code)).not.toContain('scope_gate_submit')

      const replay = await fetch(`${base}/v2/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'init-name-only-1',
          'x-principal-id': 'pi-init',
          'x-principal-role': 'pi',
        },
        body: JSON.stringify({ name: 'Continue my research' }),
      })
      expect(replay.status).toBe(201)
      const replayed = await replay.json() as { project: { project_id: string }; intake: { intake_id: string } }
      expect(replayed.project.project_id).toBe(out.project.project_id)
      expect(replayed.intake.intake_id).toBe(out.intake.intake_id)
    })
    kernel.close()
  })

  it('grills one question at a time and only PI confirmation creates the Scope Gate', async () => {
    const kernel = freshKernel()
    await withServer(kernel, async (base) => {
      const headers = {
        'content-type': 'application/json',
        'x-principal-id': 'pi-grill',
        'x-principal-role': 'pi',
      }
      const created = await fetch(`${base}/v2/projects`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'grill-project-1' },
        body: JSON.stringify({ name: 'Grill study' }),
      })
      const init = await created.json() as { project: { project_id: string; revision: number }; intake: { intake_id: string; revision: number } }
      const values: Record<string, unknown> = {
        'brief.problem': 'Does method A improve accuracy?',
        'brief.scope': 'Public benchmark datasets only.',
        'brief.questions': ['What is the effect size?'],
        'brief.primary_metrics': ['accuracy:higher_is_better'],
        'brief.target_outputs': ['conference-paper'],
        'brief.constraints': 'No private data; 40 GPU hours.',
        'brief.material_context': 'Continue from an external literature survey.',
      }

      let projectRevision = init.project.revision
      let intakeRevision = init.intake.revision
      for (const expectedCode of Object.keys(values)) {
        const current = await fetch(`${base}/v2/projects/${init.project.project_id}/grill`, { headers })
        expect(current.status).toBe(200)
        const projection = await current.json() as {
          project_revision: number
          intake_revision: number
          question: { question_code: string; question_revision: number } | null
          ready_to_confirm: boolean
        }
        expect(projection.question?.question_code).toBe(expectedCode)
        expect(projection.ready_to_confirm).toBe(false)
        projectRevision = projection.project_revision
        intakeRevision = projection.intake_revision
        const answered = await fetch(`${base}/v2/projects/${init.project.project_id}/grill/answers`, {
          method: 'POST', headers,
          body: JSON.stringify({
            question_code: expectedCode,
            question_revision: projection.question!.question_revision,
            value: values[expectedCode],
          }),
        })
        expect(answered.status).toBe(200)
      }

      const previewResponse = await fetch(`${base}/v2/projects/${init.project.project_id}/grill`, { headers })
      const preview = await previewResponse.json() as {
        project_revision: number
        intake_revision: number
        question: null
        ready_to_confirm: boolean
        brief_preview: { problem: string; scope: string; primary_metrics: string[] }
      }
      expect(preview.question).toBeNull()
      expect(preview.ready_to_confirm).toBe(true)
      expect(preview.brief_preview.problem).toBe(values['brief.problem'])
      expect(kernel.listGates(init.project.project_id)).toEqual([])
      projectRevision = preview.project_revision
      intakeRevision = preview.intake_revision

      kernel.addProjectMember({ project_id: init.project.project_id, principal_id: 'researcher-grill', role: 'researcher', actor: 'pi-grill' })
      const denied = await fetch(`${base}/v2/projects/${init.project.project_id}/grill/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-principal-id': 'researcher-grill', 'x-principal-role': 'researcher', 'idempotency-key': 'confirm-denied' },
        body: JSON.stringify({ expected_project_revision: projectRevision, expected_intake_revision: intakeRevision }),
      })
      expect(denied.status).toBe(403)
      expect(kernel.listGates(init.project.project_id)).toEqual([])

      const confirmed = await fetch(`${base}/v2/projects/${init.project.project_id}/grill/confirm`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'confirm-grill-1' },
        body: JSON.stringify({ expected_project_revision: projectRevision, expected_intake_revision: intakeRevision }),
      })
      expect(confirmed.status).toBe(200)
      const result = await confirmed.json() as {
        project: { brief_status: string; brief: { problem: string } }
        gate: { gate_id: string; type: string }
      }
      expect(result.project.brief_status).toBe('confirmed')
      expect(result.project.brief.problem).toBe(values['brief.problem'])
      expect(result.gate.type).toBe('scope')

      const replay = await fetch(`${base}/v2/projects/${init.project.project_id}/grill/confirm`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': 'confirm-grill-1' },
        body: JSON.stringify({ expected_project_revision: projectRevision, expected_intake_revision: intakeRevision }),
      })
      expect(replay.status).toBe(200)
      expect(kernel.listGates(init.project.project_id).filter(gate => gate.type === 'scope')).toHaveLength(1)
    })
    kernel.close()
  })

  it('POST /v2/projects requires an Idempotency-Key and returns project+intake+budget+membership', async () => {
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
      const out = await created.json() as { project: { project_id: string }; intake: { project_id: string }; budget: Record<string, unknown>; membership: Array<{ role: string }> }
      expect(out.intake.project_id).toBe(out.project.project_id)
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
      // Malformed cursor -> explicit 400 invalid_cursor (api-contracts §1).
      const badCursor = await fetch(`${base}/v2/projects?cursor=not-a-cursor`)
      expect(badCursor.status).toBe(400)
      expect((await badCursor.json() as { error: { code: string } }).error.code).toBe('invalid_cursor')
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

  it('GET /v2/health reports the canonical HealthResponse (protocol/schema versions + capability object)', async () => {
    const kernel = freshKernel()
    await withServer(kernel, async (base) => {
      const r = await fetch(`${base}/v2/health`)
      expect(r.status).toBe(200)
      const h = await r.json() as {
        ok: boolean
        protocol_version: string
        schema_version: number
        database_id: string
        config_pin: string
        capabilities: Record<string, unknown> & { locales: string[]; locale_contract_revision: number }
      }
      expect(h.ok).toBe(true)
      // reconstruction-contracts.md §5: protocol_version is the string 'v2'.
      expect(h.protocol_version).toBe('v2')
      expect(h.schema_version).toBeGreaterThanOrEqual(6)
      expect(h.database_id.length).toBeGreaterThan(0)
      expect(h.config_pin.startsWith('sha256:')).toBe(true)
      // api-contracts.md §3: capabilities must be an OBJECT listing every
      // implemented server-side capability; locales + contract revision.
      for (const cap of ['terminal_stream', 'interactive_terminal', 'workspace_files', 'tex_workspace', 'latex_compile', 'latex_live_preview', 'remote_runner', 'config_registry', 'research_onboarding', 'trajectory', 'subagent_topology', 'signed_manifest', 'clean_room']) {
        expect(h.capabilities[cap]).toBe(true)
      }
      expect(h.capabilities.locales).toEqual(['zh', 'en'])
      expect(h.capabilities.locale_contract_revision).toBe(1)
    })
  })

  it('errors carry request_id + retryable; X-Request-Id is echoed', async () => {
    const kernel = freshKernel()
    await withServer(kernel, async (base) => {
      const r = await fetch(`${base}/v1/projects/nope`, { headers: { 'x-request-id': 'req_abc' } })
      expect(r.status).toBe(404)
      const body = await r.json() as { error: { code: string; request_id: string; retryable: boolean } }
      expect(body.error.code).toBe('project_not_found')
      expect(body.error.request_id).toBe('req_abc')
      expect(body.error.retryable).toBe(false)
      // Without the header a request id is still present.
      const r2 = await fetch(`${base}/v1/projects/nope`)
      const b2 = await r2.json() as { error: { request_id: string } }
      expect(b2.error.request_id).toMatch(/^req_/)
    })
  })

  it('request hash is deterministic over the body', () => {
    const h1 = createHash('sha256').update(JSON.stringify(makeBody())).digest('hex')
    const h2 = createHash('sha256').update(JSON.stringify(makeBody())).digest('hex')
    expect(h1).toBe(h2)
  })
})
