import { describe, expect, it, vi } from 'vitest'
import type { ResearchClient } from '@dsh-scholar/research-client'
import { protocolRevisionCanonicalHash } from '@dsh-scholar/research-kernel'
import { ProtocolRevision } from '@dsh-scholar/research-schemas'
import {
  RESEARCH_HUMAN_CONFIRMATION_TOOLS,
  RESEARCH_TOOLS,
  RoleRegistry,
} from '../../src/plugin/acl.js'
import { registerResearchTools, type ResearchToolContext } from '../../src/plugin/tools.js'

const HASH_A = `sha256:${'a'.repeat(64)}`
const HASH_B = `sha256:${'b'.repeat(64)}`
const NOW = '2026-08-20T08:00:00.000Z'

interface RegisteredTool {
  name: string
  description: string
  execute(args: Record<string, unknown>, exec: { agent?: { id: string }; signal: AbortSignal }): Promise<Record<string, unknown>>
}

function protocol(projectId: string): Record<string, unknown> {
  return {
    protocol_id: 'protocol_dsh_1', project_id: projectId, revision: 1, supersedes: null,
    status: 'frozen', intent: 'confirmatory', research_question_ref: 'question:dsh', target_claim_ref: null,
    hypothesis: 'The bounded DSH methodology tool preserves project scope.',
    prediction: 'Only the linked project receives the record.',
    variables: { manipulated: ['tool input'], controlled: ['session link'], measured: ['stored project'] },
    metrics: { primary: 'scope correctness', secondary: [], baseline_ref: 'baseline:dsh', analysis_plan_artifact_id: 'artifact:plan' },
    pins: {
      contract: { ref: 'contract:dsh', sha256: HASH_A }, code: { ref: 'code:dsh', sha256: HASH_A },
      data: { ref: 'data:dsh', sha256: HASH_A }, environment: { ref: 'environment:dsh', sha256: HASH_A },
    },
    stopping_conditions: ['One successful bounded call.'], failure_criteria: ['Any cross-project write.'],
    allowed_deviations: [], deviation_handling: 'Freeze another revision.',
    author_principal_id: 'dsh:operator', created_at: NOW, frozen_at: NOW,
  }
}

const BASIS = {
  provenance: 'explicit', statement: 'Observed in the linked project.',
  source_refs: [{ kind: 'evidence', id: 'evidence_dsh', sha256: HASH_A }],
}

function synthesis(projectId: string): Record<string, unknown> {
  return {
    synthesis_id: 'synth_dsh_1', project_id: projectId,
    window: { from_event_seq: 1, to_event_seq: 2 }, snapshot_pin: { project_revision: 3, next_action_revision: 4 },
    inputs: { accepted_evidence_refs: ['evidence_dsh'], verified_evidence_refs: ['evidence_dsh'], run_refs: [], corpus_snapshot_refs: [] },
    findings: { supported: [BASIS], contradicted: [], negative: [], inconclusive: [], infrastructure_failures: [] },
    patterns: [], open_questions: [], constraints_learned: [], artifact_body_ref: 'artifact:synthesis',
    direction_proposal_id: null, confidence: 'medium', generated_by: 'agent', input_hash: HASH_A,
    status: 'draft', adoption_ref: null, created_at: NOW,
  }
}

function reverseOutline(projectId: string): Record<string, unknown> {
  return {
    outline_id: 'outline_dsh_1',
    input_pin: { project_id: projectId, document_id: 'paper_dsh', document_revision: 3, tex_sha256: HASH_A, claim_evidence_sha256: HASH_B },
    section_ref: 'section:method', section_thesis: 'The method remains scoped.', paragraphs: [], issues: [],
    status: 'diagnostic', created_at: NOW,
  }
}

function reviewFinding(projectId: string): Record<string, unknown> {
  return {
    finding_id: 'finding_dsh_1',
    input_pin: { project_id: projectId, document_id: 'paper_dsh', document_revision: 3, tex_sha256: HASH_A, claim_evidence_sha256: HASH_B },
    kind: 'claim-evidence', severity: 'blocking', message: 'Bind the claim to accepted evidence.',
    claim_ref: 'claim_dsh', evidence_refs: [], resolution_status: 'open', status: 'diagnostic', created_at: NOW,
  }
}

function activation(projectId: string, sessionId: string): Record<string, unknown> {
  return {
    project_id: projectId, session_id: sessionId, package_name: 'scholar.dsh-method', package_version: '1.0.0',
    manifest_sha256: HASH_A, payload_sha256: HASH_B, phase: 'WRITING', next_action_revision: 4,
    explicit_human_activation: true,
    principal_capabilities: ['project:read-accepted-evidence'],
    next_action_capabilities: ['project:read-accepted-evidence'],
    project_policy_capabilities: ['project:read-accepted-evidence'],
  }
}

function register(client: ResearchClient, overrides: Partial<ResearchToolContext> = {}): RegisteredTool[] {
  const tools: RegisteredTool[] = []
  registerResearchTools({ tools: { register: tool => tools.push(tool as never) } }, {
    client,
    cache: { get: async () => undefined, set: async () => undefined },
    ctx: {}, roles: { set() {}, delete() {} }, projectScopes: new Map(), modelFor: () => undefined,
    stageSubagents: {}, operatorPrincipal: 'dsh:operator',
    ...overrides,
  } as unknown as ResearchToolContext)
  return tools
}

describe('DSH session-bound methodology tools', () => {
  it('registers the bounded surface and keeps Knowledge activation behind Host confirmation', () => {
    const names = register({} as ResearchClient).map(tool => tool.name)
    for (const name of [
      'research_methodology_status', 'research_protocol_record', 'research_synthesis_record',
      'research_writing_review_record', 'research_knowledge_activate', 'research_knowledge_deactivate', 'research_assurance_run',
    ]) {
      expect(names).toContain(name)
      expect(RESEARCH_TOOLS).toContain(name)
      expect(new RoleRegistry().allows('none', name), `${name} must be callable from the root DSH conversation`).toBe(true)
    }
    expect(RESEARCH_HUMAN_CONFIRMATION_TOOLS).toContain('research_knowledge_activate')
    expect(RESEARCH_HUMAN_CONFIRMATION_TOOLS).toContain('research_knowledge_deactivate')
    expect(RESEARCH_HUMAN_CONFIRMATION_TOOLS).toContain('research_assurance_run')
    expect(RESEARCH_HUMAN_CONFIRMATION_TOOLS).not.toContain('research_methodology_status')
  })

  it('runs deterministic assurance only for the exact linked session and derives Store CAS itself', async () => {
    const getProjectBySession = vi.fn(async () => ({ project_id: 'rsp_linked' }))
    const listAssuranceAudits = vi.fn(async () => ({ project_id: 'rsp_linked', revision: 5, audits: [] }))
    const runWritingAssuranceForDshSession = vi.fn(async (_sessionId, input) => ({ revision: 6, audit: input }))
    const tool = register({
      getProjectBySession,
      listAssuranceAudits,
      runWritingAssuranceForDshSession,
    } as unknown as ResearchClient).find(candidate => candidate.name === 'research_assurance_run')!
    expect(JSON.stringify(tool)).not.toContain('"project_id"')

    await tool.execute({ audit_kind: 'claim-evidence', mode: 'deterministic' }, {
      agent: { id: 'root-session' }, signal: new AbortController().signal,
    })
    expect(getProjectBySession).toHaveBeenCalledWith('root-session')
    expect(listAssuranceAudits).toHaveBeenCalledWith('rsp_linked', 'dsh:operator')
    expect(runWritingAssuranceForDshSession).toHaveBeenCalledWith('root-session', {
      expected_revision: 5,
      audit_kind: 'claim-evidence',
      mode: 'deterministic',
      semantic_review: null,
    }, expect.any(AbortSignal))

    await expect(tool.execute({ audit_kind: 'claim-evidence', mode: 'deterministic', project_id: 'rsp_other' }, {
      signal: new AbortController().signal,
    })).rejects.toThrow('calling DSH session')
    await expect(tool.execute({ audit_kind: 'citation', mode: 'deterministic' }, {
      agent: { id: 'root-session' }, signal: new AbortController().signal,
    })).rejects.toThrow('"audit_kind" must be one of ["writing","claim-evidence"]')
    expect(runWritingAssuranceForDshSession).toHaveBeenCalledTimes(1)
  })

  it('records provider-unavailable semantic review as missing instead of falling back to deterministic PASS', async () => {
    const getProjectBySession = vi.fn(async () => ({ project_id: 'rsp_linked' }))
    const projectProjection = vi.fn(async () => ({
      project: {
        project_id: 'rsp_linked', name: 'review', status: 'WRITING', revision: 4,
        constraints: { max_model_cost_usd: 100, max_gpu_hours: 10 },
      },
      pending_gates: [], budget: {},
      next_actions_v2: [{
        id: 'reviewer_run:4', code: 'reviewer_run', revision: 4,
        state: 'ready', required_by: 'agent',
      }],
    }))
    const listAssuranceAudits = vi.fn(async () => ({ project_id: 'rsp_linked', revision: 2, audits: [] }))
    const runWritingAssuranceForDshSession = vi.fn(async (_sessionId, input) => ({ audit: input }))
    const execute = vi.fn(async () => { throw new Error('provider unavailable') })
    const client = {
      getProjectBySession, projectProjection, listAssuranceAudits, runWritingAssuranceForDshSession,
    } as unknown as ResearchClient
    const tool = register(client, { stageSubagents: { execute } as never })
      .find(candidate => candidate.name === 'research_assurance_run')!

    await tool.execute({ audit_kind: 'writing', mode: 'semantic' }, {
      agent: { id: 'root-session' }, signal: new AbortController().signal,
    })

    expect(runWritingAssuranceForDshSession).toHaveBeenCalledWith('root-session', expect.objectContaining({
      expected_revision: 2,
      audit_kind: 'writing',
      mode: 'semantic',
      semantic_review: expect.objectContaining({
        project_id: 'rsp_linked', session_id: 'root-session', state: 'missing',
        reviewers: [], failures: ['semantic_reviewer_unavailable'], independence: 'same-family',
      }),
    }), expect.any(AbortSignal))
  })

  it('reads only the project linked to the calling DSH session', async () => {
    const getProjectBySession = vi.fn(async () => ({ project_id: 'rsp_linked' }))
    const getMethodology = vi.fn(async () => ({ project_id: 'rsp_linked', revision: 7 }))
    const listSynthesisRecordRequests = vi.fn(async () => ({ project_id: 'rsp_linked', requests: [], pending: [] }))
    const status = register({ getProjectBySession, getMethodology, listSynthesisRecordRequests } as unknown as ResearchClient)
      .find(tool => tool.name === 'research_methodology_status')!

    await expect(status.execute({}, { agent: { id: 'root-session' }, signal: new AbortController().signal }))
      .resolves.toEqual({ ok: true, methodology: { project_id: 'rsp_linked', revision: 7 }, synthesis_requests: [] })
    expect(getProjectBySession).toHaveBeenCalledWith('root-session')
    expect(getMethodology).toHaveBeenCalledWith('rsp_linked', 'dsh:operator')
    expect(listSynthesisRecordRequests).toHaveBeenCalledWith('rsp_linked', 'dsh:operator')

    await expect(status.execute({}, { signal: new AbortController().signal }))
      .rejects.toThrow('calling DSH session')
  })

  it('strictly parses and project-binds Protocol, Synthesis and Writing records before client writes', async () => {
    const getProjectBySession = vi.fn(async () => ({ project_id: 'rsp_linked' }))
    const recordProtocol = vi.fn(async (_projectId, _principal, input) => input)
    const recordSynthesis = vi.fn(async (_projectId, _principal, input) => input)
    const recordReverseOutline = vi.fn(async (_projectId, _principal, input) => input)
    const recordReviewFinding = vi.fn(async (_projectId, _principal, input) => input)
    const client = { getProjectBySession, recordProtocol, recordSynthesis, recordReverseOutline, recordReviewFinding } as unknown as ResearchClient
    const tools = register(client)
    const exec = { agent: { id: 'root-session' }, signal: new AbortController().signal }

    await tools.find(tool => tool.name === 'research_protocol_record')!.execute({
      record_json: JSON.stringify(protocol('rsp_linked')), expected_revision: 0,
    }, exec)
    await tools.find(tool => tool.name === 'research_synthesis_record')!.execute({
      request_id: 'synthesis_request_dsh_1', record_json: JSON.stringify(synthesis('rsp_linked')), expected_revision: 1,
    }, exec)
    await tools.find(tool => tool.name === 'research_writing_review_record')!.execute({
      kind: 'reverse-outline', record_json: JSON.stringify(reverseOutline('rsp_linked')), expected_revision: 2,
    }, exec)
    await tools.find(tool => tool.name === 'research_writing_review_record')!.execute({
      kind: 'review-finding', record_json: JSON.stringify(reviewFinding('rsp_linked')), expected_revision: 3,
    }, exec)

    const expectedProtocolHash = protocolRevisionCanonicalHash(ProtocolRevision.parse({
      ...protocol('rsp_linked'),
      canonical_hash: HASH_A,
    }))
    expect(recordProtocol).toHaveBeenCalledWith('rsp_linked', 'dsh:operator', {
      expected_revision: 0,
      record: expect.objectContaining({ canonical_hash: expectedProtocolHash }),
    })
    expect(recordSynthesis).toHaveBeenCalledWith('rsp_linked', 'dsh:operator', expect.objectContaining({
      request_id: 'synthesis_request_dsh_1', expected_revision: 1,
    }))
    expect(recordReverseOutline).toHaveBeenCalledWith('rsp_linked', 'dsh:operator', expect.objectContaining({ expected_revision: 2 }))
    expect(recordReviewFinding).toHaveBeenCalledWith('rsp_linked', 'dsh:operator', expect.objectContaining({ expected_revision: 3 }))

    await expect(tools.find(tool => tool.name === 'research_protocol_record')!.execute({
      record_json: JSON.stringify(protocol('rsp_other')), expected_revision: 3,
    }, exec)).rejects.toThrow('linked project')
    await expect(tools.find(tool => tool.name === 'research_protocol_record')!.execute({
      record_json: JSON.stringify({ ...protocol('rsp_linked'), author_principal_id: 'another-principal' }), expected_revision: 3,
    }, exec)).rejects.toThrow('authenticated Scholar operator')
    await expect(tools.find(tool => tool.name === 'research_protocol_record')!.execute({
      record_json: JSON.stringify({ ...protocol('rsp_linked'), canonical_hash: HASH_B }), expected_revision: 3,
    }, exec)).rejects.toThrow('canonical_hash does not match the deterministic Protocol receipt')
    await expect(tools.find(tool => tool.name === 'research_protocol_record')!.execute({
      record_json: JSON.stringify({ ...protocol('rsp_linked'), unexpected: true }), expected_revision: 3,
    }, exec)).rejects.toThrow('strict schema validation')
    await expect(tools.find(tool => tool.name === 'research_synthesis_record')!.execute({
      request_id: 'synthesis_request_dsh_1', record_json: JSON.stringify({ ...synthesis('rsp_linked'), generated_by: 'human' }), expected_revision: 3,
    }, exec)).rejects.toThrow('generated_by=agent')
    expect(recordProtocol).toHaveBeenCalledTimes(1)
    expect(recordSynthesis).toHaveBeenCalledTimes(1)
  })

  it('activates only an exact linked-session Human request and never manufactures one', async () => {
    const getProjectBySession = vi.fn(async () => ({ project_id: 'rsp_linked' }))
    const projectProjection = vi.fn(async () => ({
      project: { project_id: 'rsp_linked', revision: 3 },
      next_actions_v2: [{ id: 'action', revision: 4, state: 'ready' }],
    }))
    const activateKnowledgePackageForDshSession = vi.fn(async (_sessionId, input) => input)
    const tool = register({ getProjectBySession, projectProjection, activateKnowledgePackageForDshSession } as unknown as ResearchClient)
      .find(candidate => candidate.name === 'research_knowledge_activate')!
    const exec = { agent: { id: 'root-session' }, signal: new AbortController().signal }

    await tool.execute({
      package_name: 'scholar.dsh-method', package_version: '1.0.0',
      manifest_sha256: HASH_A, payload_sha256: HASH_B,
      expected_revision: 2, expected_registry_revision: 4,
    }, exec)
    expect(activateKnowledgePackageForDshSession).toHaveBeenCalledWith('root-session', expect.objectContaining({
      expected_revision: 2, expected_registry_revision: 4, expected_project_revision: 3,
      expected_next_action_revision: 4, explicit_human_activation: true,
    }))

    await expect(tool.execute({
      package_name: 'scholar.dsh-method', package_version: '1.0.0',
      manifest_sha256: HASH_A, payload_sha256: HASH_B,
      expected_revision: 3, expected_registry_revision: 4,
    }, { signal: new AbortController().signal })).rejects.toThrow('calling DSH session')
    await expect(tool.execute({
      package_name: 'scholar.dsh-method', package_version: '1.0.0',
      manifest_sha256: 'not-a-hash', payload_sha256: HASH_B,
      expected_revision: 3, expected_registry_revision: 4,
    }, exec)).rejects.toThrow()
    expect(activateKnowledgePackageForDshSession).toHaveBeenCalledTimes(1)
  })

  it('deactivates only an activation owned by the exact calling session without a project argument', async () => {
    const getProjectBySession = vi.fn(async () => ({ project_id: 'rsp_linked' }))
    const listKnowledgeActivations = vi.fn(async () => ({
      project_id: 'rsp_linked', stream_revision: 5,
      records: [{
        project_id: 'rsp_linked', stream_revision: 5, recorded_revision: 4,
        record: { activation_id: 'activation_4', request: activation('rsp_linked', 'root-session') },
      }],
    }))
    const deactivateKnowledgePackage = vi.fn(async (_projectId, _activationId, _principal, input) => input)
    const tool = register({ getProjectBySession, listKnowledgeActivations, deactivateKnowledgePackage } as unknown as ResearchClient)
      .find(candidate => candidate.name === 'research_knowledge_deactivate')!
    expect((tool as unknown as { parameters: { properties: Record<string, unknown> } }).parameters.properties.project_id).toBeUndefined()
    const exec = { agent: { id: 'root-session' }, signal: new AbortController().signal }
    await tool.execute({ activation_id: 'activation_4', reason: 'superseded', expected_revision: 5 }, exec)
    expect(deactivateKnowledgePackage).toHaveBeenCalledWith('rsp_linked', 'activation_4', 'dsh:operator', {
      request: {
        project_id: 'rsp_linked', session_id: 'root-session', activation_id: 'activation_4',
        explicit_human_deactivation: true, reason: 'superseded',
      },
      expected_revision: 5,
    })

    listKnowledgeActivations.mockResolvedValueOnce({
      project_id: 'rsp_linked', stream_revision: 5,
      records: [{
        project_id: 'rsp_linked', stream_revision: 5, recorded_revision: 4,
        record: { activation_id: 'activation_4', request: activation('rsp_linked', 'other-session') },
      }],
    } as never)
    await expect(tool.execute({ activation_id: 'activation_4', reason: 'superseded', expected_revision: 5 }, exec))
      .rejects.toThrow('calling DSH session')
    expect(deactivateKnowledgePackage).toHaveBeenCalledTimes(1)
  })
})
