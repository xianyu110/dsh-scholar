/**
 * Fixture-only full-auto Gate authority.
 *
 * This module is deliberately pure: it derives a receipt from already
 * resolved authoritative records but owns no persistence and no HTTP. The
 * Kernel calls it inside the same SQLite transaction that writes the Gate
 * Decision, so the Durable Orchestrator never becomes an authority and never
 * manufactures a Human Principal.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  BudgetRecord,
  CorpusSnapshot,
  ExperimentContract,
  FixtureProfile,
  FrozenProtocolPin,
  Gate,
  IdeaCard,
  NextAction,
  ResearchProject,
  RunnerProfile,
  RunnerTargetDescriptor,
} from '@dsh-scholar/research-schemas'
import { CitationEdge, Paper, Passage, runnerTargetConfigHash } from '@dsh-scholar/research-schemas'
import type { RunnerEnvironmentFailure } from './runner-environment-readiness.js'

export const FULL_AUTO_GATE_ALLOWLIST = ['scope', 'idea', 'contract', 'budget'] as const
export type FullAutoGateType = (typeof FULL_AUTO_GATE_ALLOWLIST)[number]

export type FullAutoAuthorityFailureCode =
  | 'full_auto_fixture_required'
  | 'full_auto_gate_not_allowed'
  | 'full_auto_gate_payload_invalid'
  | 'full_auto_gate_target_invalid'
  | 'full_auto_runner_not_ready'
  | 'full_auto_action_not_ready'
  | 'full_auto_budget_not_ready'
  | 'full_auto_survey_query_invalid'
  | 'full_auto_survey_authority_changed'
  | 'revision_conflict'

const Sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/)

/** Strict durable receipt schema; replay never trusts an unchecked Decision.diff. */
export const FullAutoAuthorityReceiptSchema = z.object({
  schema_version: z.literal(1),
  authority: z.literal('full_auto_service'),
  principal_id: z.literal('service:research-orchestrator'),
  project_id: z.string().min(1),
  project_revision: z.number().int().nonnegative(),
  gate_id: z.string().min(1),
  gate_type: z.enum(FULL_AUTO_GATE_ALLOWLIST),
  payload_sha256: Sha256,
  target: z.object({
    kind: z.enum(FULL_AUTO_GATE_ALLOWLIST),
    id: z.string().min(1),
    version: z.number().int().nonnegative(),
    object_sha256: Sha256,
  }).strict(),
  fixture: z.object({ fixture_id: z.string().min(1), profile_sha256: Sha256 }).strict(),
  runner_profile: z.object({ profile_id: z.string().min(1), config_hash: z.string().min(1) }).strict(),
  runner_target: z.object({
    target_id: z.string().min(1), revision: z.number().int().nonnegative(), config_hash: z.string().min(1),
  }).strict(),
  idempotency_key: z.string().min(1),
  issued_at: z.string().datetime(),
}).strict()

export type FullAutoAuthorityReceipt = z.infer<typeof FullAutoAuthorityReceiptSchema>

const SurveyQuery = z.object({
  source: z.enum(['openalex', 'crossref', 'arxiv']),
  query: z.string().min(1),
  run_at: z.string().datetime(),
}).strict()

/** Strict connector output accepted by the fixture-only canonical survey. */
export const FullAutoSurveyResultSchema = z.object({
  queries: z.array(SurveyQuery).length(3),
  papers: z.array(Paper.strict()).max(100),
  passages: z.array(Passage.strict()).max(500),
  citation_edges: z.array(CitationEdge.strict()).max(2_000),
  source_status: z.enum(['pending', 'complete']),
}).strict()
export type FullAutoSurveyResult = z.infer<typeof FullAutoSurveyResultSchema>

const FrozenProtocolPinSchema = z.object({
  protocol_id: z.string().regex(/^protocol_[a-z0-9_]+$/),
  revision: z.number().int().positive(),
  canonical_hash: Sha256,
}).strict()

const FullAutoSurveyAuthorityContextBodySchema = z.object({
  schema_version: z.literal(1),
  authority: z.literal('full_auto_service'),
  principal_id: z.literal('service:research-orchestrator'),
  project_id: z.string().min(1),
  project_revision: z.number().int().nonnegative(),
  action: z.object({
    id: z.string().min(1),
    code: z.literal('survey_run'),
    revision: z.number().int().nonnegative(),
    object_sha256: Sha256,
  }).strict(),
  query: z.string().min(1),
  query_sha256: Sha256,
  fixture: z.object({ fixture_id: z.string().min(1), profile_sha256: Sha256 }).strict(),
  runner_profile: z.object({ profile_id: z.string().min(1), config_hash: z.string().min(1) }).strict(),
  runner_target: z.object({
    target_id: z.string().min(1), revision: z.number().int().nonnegative(), config_hash: z.string().min(1),
  }).strict(),
  budget: z.object({
    model_cost_usd: z.number().nonnegative(),
    gpu_hours: z.number().nonnegative(),
    api_requests: z.number().int().nonnegative(),
    storage_bytes: z.number().int().nonnegative(),
    object_sha256: Sha256,
  }).strict(),
  protocol_pin: FrozenProtocolPinSchema.nullable(),
}).strict()

/** Read-only admission context pinned before connector I/O. */
export const FullAutoSurveyAuthorityContextSchema = FullAutoSurveyAuthorityContextBodySchema.extend({
  authority_sha256: Sha256,
}).strict()
export type FullAutoSurveyAuthorityContext = z.infer<typeof FullAutoSurveyAuthorityContextSchema>

/** Durable authority receipt embedded in the atomic corpus outbox event. */
export const FullAutoSurveyAuthorityReceiptSchema = FullAutoSurveyAuthorityContextBodySchema.extend({
  authority_sha256: Sha256,
  result_sha256: Sha256,
  snapshot_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  issued_at: z.string().datetime(),
}).strict()
export type FullAutoSurveyAuthorityReceipt = z.infer<typeof FullAutoSurveyAuthorityReceiptSchema>
export type FullAutoSurveyAuthorityReceiptBase = Omit<FullAutoSurveyAuthorityReceipt, 'snapshot_id'>

export type FullAutoAuthorityEvaluation =
  | { ok: true; receipt: FullAutoAuthorityReceipt }
  | { ok: false; code: FullAutoAuthorityFailureCode; message: string }

export interface FullAutoAuthorityInput {
  project: ResearchProject
  gate: Gate
  expected_project_revision: number
  idempotency_key: string
  issued_at: string
  fixture: FixtureProfile | null
  runner_profile: RunnerProfile | null
  runner_target: RunnerTargetDescriptor | null
  runner_failures: RunnerEnvironmentFailure[]
  idea?: IdeaCard | null
  idea_corpus?: CorpusSnapshot | null
  contract?: ExperimentContract | null
}

export interface FullAutoSurveyAuthorityContextInput {
  project: ResearchProject
  action: NextAction
  expected_project_revision: number
  action_id: string
  action_revision: number
  fixture: FixtureProfile | null
  runner_profile: RunnerProfile | null
  runner_target: RunnerTargetDescriptor | null
  runner_failures: RunnerEnvironmentFailure[]
  budget: BudgetRecord
  protocol_pin: FrozenProtocolPin | null
}

export interface FullAutoSurveyAuthorityInput extends FullAutoSurveyAuthorityContextInput {
  idempotency_key: string
  issued_at: string
  expected_authority_sha256: string
  result: FullAutoSurveyResult
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Canonical hash used to pin a Gate payload to the exact authority input. */
export function fullAutoAuthorityHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function failure(code: FullAutoAuthorityFailureCode, message: string): { ok: false; code: FullAutoAuthorityFailureCode; message: string } {
  return { ok: false, code, message }
}

/** Derive an exact service authority receipt, or a typed fail-closed reason. */
export function evaluateFullAutoGateAuthority(input: FullAutoAuthorityInput): FullAutoAuthorityEvaluation {
  const { project, gate, fixture, runner_profile: runnerProfile, runner_target: runnerTarget } = input
  if (project.mode !== 'full-auto' || fixture === null || project.execution.fixture_id !== fixture.fixture_id) {
    return failure('full_auto_fixture_required', 'automatic Gate decisions require a persisted full-auto project bound to a registered FixtureProfile')
  }
  if (project.brief_status !== 'confirmed') {
    return failure('full_auto_fixture_required', 'automatic Gate decisions cannot confirm or bypass a collecting Research Brief')
  }
  if (project.revision !== input.expected_project_revision) {
    return failure('revision_conflict', `expected project revision ${input.expected_project_revision}, got ${project.revision}`)
  }
  if (gate.project_id !== project.project_id || gate.status !== 'pending') {
    return failure('full_auto_gate_target_invalid', 'automatic Gate decision requires a pending Gate of the exact project')
  }
  if (!(FULL_AUTO_GATE_ALLOWLIST as readonly string[]).includes(gate.type)) {
    return failure('full_auto_gate_not_allowed', `Gate type ${gate.type} is not in the fixture full-auto allowlist; Release always stays Human`)
  }
  if (runnerProfile === null || project.execution.runner_profile_id !== runnerProfile.profile_id
    || runnerTarget === null || project.execution.runner_target_id !== runnerTarget.target_id
    || runnerProfile.image !== fixture.image || input.runner_failures.length > 0) {
    return failure('full_auto_runner_not_ready', `fixture runner is not exactly ready: ${input.runner_failures.join(',') || 'profile/target/image binding mismatch'}`)
  }

  const payload = gate.payload
  let target: FullAutoAuthorityReceipt['target']
  if (gate.type === 'scope') {
    if (!exactKeys(payload, [])) return failure('full_auto_gate_payload_invalid', 'Scope Gate payload must be empty')
    target = { kind: 'scope', id: project.project_id, version: project.revision, object_sha256: fullAutoAuthorityHash(project.brief) }
  } else if (gate.type === 'idea') {
    if (!exactKeys(payload, ['idea_id', 'idea_version', 'idea_sha256'])
      || typeof payload.idea_id !== 'string'
      || typeof payload.idea_version !== 'number' || !Number.isInteger(payload.idea_version) || payload.idea_version < 0
      || !Sha256.safeParse(payload.idea_sha256).success) {
      return failure('full_auto_gate_payload_invalid', 'Idea Gate payload must contain exactly idea_id, idea_version and idea_sha256')
    }
    const idea = input.idea
    const corpus = input.idea_corpus
    if (idea === undefined || idea === null || idea.idea_id !== payload.idea_id || idea.project_id !== project.project_id
      || idea.status !== 'proposed' || idea.novelty_audit === null || idea.novelty_audit === undefined
      || idea.corpus_snapshot_id === null || corpus === undefined || corpus === null
      || corpus.snapshot_id !== idea.corpus_snapshot_id || corpus.project_id !== project.project_id || !corpus.frozen) {
      return failure('full_auto_gate_target_invalid', 'Idea Gate must bind an exact proposed IdeaCard with novelty audit and a frozen same-project corpus')
    }
    const ideaSha256 = fullAutoAuthorityHash(idea)
    if (payload.idea_version !== idea.version || payload.idea_sha256 !== ideaSha256) {
      return failure('full_auto_gate_target_invalid', 'Idea Gate version/hash pins no longer match the authoritative IdeaCard')
    }
    target = { kind: 'idea', id: idea.idea_id, version: idea.version, object_sha256: ideaSha256 }
  } else if (gate.type === 'contract') {
    if (!exactKeys(payload, ['contract_id', 'contract_version', 'contract_sha256'])
      || typeof payload.contract_id !== 'string'
      || typeof payload.contract_version !== 'number' || !Number.isInteger(payload.contract_version) || payload.contract_version < 0
      || !Sha256.safeParse(payload.contract_sha256).success) {
      return failure('full_auto_gate_payload_invalid', 'Contract Gate payload must contain exactly contract_id, contract_version and contract_sha256')
    }
    const contract = input.contract
    if (contract === undefined || contract === null || contract.contract_id !== payload.contract_id
      || contract.project_id !== project.project_id || contract.status !== 'draft') {
      return failure('full_auto_gate_target_invalid', 'Contract Gate must bind an exact draft Contract of the same project')
    }
    const contractSha256 = fullAutoAuthorityHash(contract)
    if (payload.contract_version !== contract.version || payload.contract_sha256 !== contractSha256) {
      return failure('full_auto_gate_target_invalid', 'Contract Gate version/hash pins no longer match the authoritative Contract')
    }
    target = { kind: 'contract', id: contract.contract_id, version: contract.version, object_sha256: contractSha256 }
  } else {
    if (!exactKeys(payload, ['resume_to']) || typeof payload.resume_to !== 'string'
      || payload.resume_to === 'BLOCKED_GATE' || project.status !== 'BLOCKED_GATE') {
      return failure('full_auto_gate_payload_invalid', 'Budget Gate must contain exactly the Kernel-derived non-BLOCKED resume_to while the project is BLOCKED_GATE')
    }
    target = { kind: 'budget', id: project.project_id, version: project.revision, object_sha256: fullAutoAuthorityHash(payload) }
  }

  return {
    ok: true,
    receipt: {
      schema_version: 1,
      authority: 'full_auto_service',
      principal_id: 'service:research-orchestrator',
      project_id: project.project_id,
      project_revision: project.revision,
      gate_id: gate.gate_id,
      gate_type: gate.type as FullAutoGateType,
      payload_sha256: fullAutoAuthorityHash(gate.payload),
      target,
      fixture: { fixture_id: fixture.fixture_id, profile_sha256: fullAutoAuthorityHash(fixture) },
      runner_profile: { profile_id: runnerProfile.profile_id, config_hash: runnerProfile.config_hash },
      runner_target: {
        target_id: runnerTarget.target_id,
        revision: runnerTarget.revision,
        config_hash: runnerTargetConfigHash(runnerTarget),
      },
      idempotency_key: input.idempotency_key,
      issued_at: input.issued_at,
    },
  }
}

export type FullAutoSurveyAuthorityEvaluation =
  | { ok: true; receipt: FullAutoSurveyAuthorityReceiptBase }
  | { ok: false; code: FullAutoAuthorityFailureCode; message: string }

export type FullAutoSurveyAuthorityContextEvaluation =
  | { ok: true; context: FullAutoSurveyAuthorityContext }
  | { ok: false; code: FullAutoAuthorityFailureCode; message: string }

/**
 * Derive and validate the exact authority context before connector I/O. The
 * returned hash is a CAS token over every workflow/environment input that the
 * later corpus mutation is allowed to consume.
 */
export function evaluateFullAutoSurveyAuthorityContext(
  input: FullAutoSurveyAuthorityContextInput,
): FullAutoSurveyAuthorityContextEvaluation {
  const { project, action, fixture, runner_profile: runnerProfile, runner_target: runnerTarget, budget } = input
  if (project.mode !== 'full-auto' || fixture === null || project.execution.fixture_id !== fixture.fixture_id
    || project.brief_status !== 'confirmed') {
    return failure('full_auto_fixture_required', 'canonical survey requires a confirmed full-auto project bound to a registered FixtureProfile')
  }
  if (project.revision !== input.expected_project_revision) {
    return failure('revision_conflict', `expected project revision ${input.expected_project_revision}, got ${project.revision}`)
  }
  if (project.status !== 'SCOPED' || action.id !== input.action_id || action.code !== 'survey_run'
    || action.revision !== input.action_revision || action.revision !== project.revision
    || action.state !== 'ready' || action.required !== true || action.required_by !== 'agent'
    || action.refs.length !== 0) {
    return failure('full_auto_action_not_ready', 'canonical survey requires the exact ready survey_run NextAction pinned to the current SCOPED revision')
  }
  if (runnerProfile === null || project.execution.runner_profile_id !== runnerProfile.profile_id
    || runnerTarget === null || project.execution.runner_target_id !== runnerTarget.target_id
    || runnerProfile.image !== fixture.image || input.runner_failures.length > 0) {
    return failure('full_auto_runner_not_ready', `fixture runner is not exactly ready: ${input.runner_failures.join(',') || 'profile/target/image binding mismatch'}`)
  }
  if (budget.project_id !== project.project_id
    || budget.model_cost_usd > project.constraints.max_model_cost_usd
    || budget.gpu_hours > project.constraints.max_gpu_hours) {
    return failure('full_auto_budget_not_ready', 'canonical survey is parked because the authoritative project budget is unavailable or exhausted')
  }

  const query = project.brief.problem.trim()
  if (query === '') {
    return failure('full_auto_survey_query_invalid', 'canonical survey requires the complete Research Brief problem')
  }
  const body = FullAutoSurveyAuthorityContextBodySchema.parse({
    schema_version: 1,
    authority: 'full_auto_service',
    principal_id: 'service:research-orchestrator',
    project_id: project.project_id,
    project_revision: project.revision,
    action: {
      id: action.id,
      code: 'survey_run',
      revision: action.revision,
      object_sha256: fullAutoAuthorityHash(action),
    },
    query,
    query_sha256: fullAutoAuthorityHash(query),
    fixture: { fixture_id: fixture.fixture_id, profile_sha256: fullAutoAuthorityHash(fixture) },
    runner_profile: { profile_id: runnerProfile.profile_id, config_hash: runnerProfile.config_hash },
    runner_target: {
      target_id: runnerTarget.target_id,
      revision: runnerTarget.revision,
      config_hash: runnerTargetConfigHash(runnerTarget),
    },
    budget: {
      model_cost_usd: budget.model_cost_usd,
      gpu_hours: budget.gpu_hours,
      api_requests: budget.api_requests,
      storage_bytes: budget.storage_bytes,
      object_sha256: fullAutoAuthorityHash({
        project_id: budget.project_id,
        model_cost_usd: budget.model_cost_usd,
        gpu_hours: budget.gpu_hours,
        api_requests: budget.api_requests,
        storage_bytes: budget.storage_bytes,
      }),
    },
    protocol_pin: input.protocol_pin,
  })
  return {
    ok: true,
    context: FullAutoSurveyAuthorityContextSchema.parse({
      ...body,
      authority_sha256: fullAutoAuthorityHash(body),
    }),
  }
}

/**
 * Verify one canonical survey against the pre-I/O authority CAS and the exact
 * current projection. Connector records are still untrusted and grant no
 * workflow authority.
 */
export function evaluateFullAutoSurveyAuthority(input: FullAutoSurveyAuthorityInput): FullAutoSurveyAuthorityEvaluation {
  const admitted = evaluateFullAutoSurveyAuthorityContext(input)
  if (!admitted.ok) return admitted
  const { context } = admitted
  if (input.expected_authority_sha256 !== context.authority_sha256) {
    return failure('full_auto_survey_authority_changed', 'canonical survey authority changed after connector admission; discard the result and re-plan from a fresh projection')
  }
  const { result } = input
  const query = context.query
  const sources = result.queries.map(item => item.source).sort()
  if (result.queries.some(item => item.query !== query)
    || sources.join(',') !== 'arxiv,crossref,openalex') {
    return failure('full_auto_survey_query_invalid', 'survey connector queries must be exactly the complete Research Brief problem across OpenAlex, Crossref and arXiv')
  }
  const paperIds = new Set(result.papers.map(paper => paper.paper_id))
  if (paperIds.size !== result.papers.length
    || result.passages.some(passage => !paperIds.has(passage.paper_id))
    || result.citation_edges.some(edge => !paperIds.has(edge.source_paper_id) || !paperIds.has(edge.target_paper_id))) {
    return failure('full_auto_survey_query_invalid', 'survey result contains duplicate papers or passage/citation references outside its paper set')
  }

  return {
    ok: true,
    receipt: {
      ...context,
      result_sha256: fullAutoAuthorityHash(result),
      idempotency_key: input.idempotency_key,
      issued_at: input.issued_at,
    },
  }
}
