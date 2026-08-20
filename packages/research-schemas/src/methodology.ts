/**
 * Protocol-before-run and bounded research-loop contracts.
 *
 * These strict schemas describe non-authoritative methodology records. They
 * deliberately contain no Project phase or mutation command: Project, Gate,
 * Job, Evidence, Claim and NextAction authority remains in Research Kernel.
 * @module @dsh-scholar/research-schemas/methodology
 */

import { z } from 'zod'

export const MethodologySha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/)
export type MethodologySha256 = z.infer<typeof MethodologySha256>

export const ResearchIntent = z.enum(['exploratory', 'confirmatory'])
export type ResearchIntent = z.infer<typeof ResearchIntent>

export const ScientificOutcome = z.enum(['positive', 'negative', 'mixed', 'inconclusive'])
export type ScientificOutcome = z.infer<typeof ScientificOutcome>

export const RunValidity = z.enum([
  'valid', 'invalid', 'infrastructure_failure', 'integrity_blocked',
])
export type RunValidity = z.infer<typeof RunValidity>

export const ProtocolPin = z.object({
  ref: z.string().min(1).max(256),
  sha256: MethodologySha256,
}).strict()
export type ProtocolPin = z.infer<typeof ProtocolPin>

export const ProtocolPins = z.object({
  contract: ProtocolPin,
  code: ProtocolPin,
  data: ProtocolPin,
  environment: ProtocolPin,
}).strict()
export type ProtocolPins = z.infer<typeof ProtocolPins>

export const ProtocolRevision = z.object({
  protocol_id: z.string().regex(/^protocol_[a-z0-9_]+$/),
  project_id: z.string().min(1).max(256),
  revision: z.number().int().positive(),
  supersedes: z.string().regex(/^protocol_[a-z0-9_]+$/).nullable(),
  status: z.enum(['draft', 'frozen']),
  intent: ResearchIntent,
  research_question_ref: z.string().min(1).max(256),
  target_claim_ref: z.string().min(1).max(256).nullable().optional(),
  hypothesis: z.string().min(1).max(20_000),
  prediction: z.string().min(1).max(20_000),
  variables: z.object({
    manipulated: z.array(z.string().min(1).max(512)).min(1).max(100),
    controlled: z.array(z.string().min(1).max(512)).max(100),
    measured: z.array(z.string().min(1).max(512)).min(1).max(100),
  }).strict(),
  metrics: z.object({
    primary: z.string().min(1).max(256),
    secondary: z.array(z.string().min(1).max(256)).max(100),
    baseline_ref: z.string().min(1).max(256),
    analysis_plan_artifact_id: z.string().min(1).max(256),
  }).strict(),
  pins: ProtocolPins,
  stopping_conditions: z.array(z.string().min(1).max(2_000)).min(1).max(100),
  failure_criteria: z.array(z.string().min(1).max(2_000)).min(1).max(100),
  allowed_deviations: z.array(z.string().min(1).max(2_000)).max(100),
  deviation_handling: z.string().min(1).max(20_000),
  author_principal_id: z.string().min(1).max(256),
  created_at: z.string().datetime(),
  frozen_at: z.string().datetime().optional(),
  canonical_hash: MethodologySha256.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'frozen') {
    if (value.frozen_at === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'frozen protocol requires frozen_at', path: ['frozen_at'] })
    }
    if (value.canonical_hash === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'frozen protocol requires canonical_hash', path: ['canonical_hash'] })
    }
  } else if (value.frozen_at !== undefined || value.canonical_hash !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'draft protocol cannot carry freeze receipt',
      path: ['status'],
    })
  }
})
export type ProtocolRevision = z.infer<typeof ProtocolRevision>

export const FrozenProtocolPin = z.object({
  protocol_id: z.string().regex(/^protocol_[a-z0-9_]+$/),
  revision: z.number().int().positive(),
  canonical_hash: MethodologySha256,
}).strict()
export type FrozenProtocolPin = z.infer<typeof FrozenProtocolPin>

/** Immutable execution facts captured when one exact Runner attempt reaches
 * a terminal state. This object deliberately carries no ScientificOutcome or
 * RunValidity: those are recorded later by an authorized Human/Agent. */
export const RunOutcomeObservation = z.object({
  observation_id: z.string().regex(/^run_observation_[a-z0-9_]+$/),
  project_id: z.string().min(1).max(256),
  job_id: z.string().min(1).max(256),
  run_id: z.string().min(1).max(256),
  attempt_no: z.number().int().positive(),
  lease_generation: z.number().int().nonnegative(),
  job_execution: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out']),
  failure_class: z.enum([
    'environment', 'resources', 'code_error', 'data_issue', 'no_improvement',
    'unstable_results', 'budget_exhausted', 'unknown',
  ]).nullable(),
  intent: ResearchIntent,
  protocol_pin: FrozenProtocolPin.nullable(),
  manifest_sha256: MethodologySha256.nullable(),
  observed_at: z.string().datetime(),
}).strict()
export type RunOutcomeObservation = z.infer<typeof RunOutcomeObservation>

export const RunAdmissionInput = z.object({
  operation: z.literal('run_admission'),
  project_id: z.string().min(1).max(256),
  requested_at: z.string().datetime(),
  run_class: z.enum(['informal', 'formal']),
  intent: ResearchIntent,
  protocol: ProtocolRevision.nullable(),
  protocol_pin: FrozenProtocolPin.nullable(),
  boundary: z.object({
    contract_approved: z.boolean(),
    budget_available: z.boolean(),
    runner_allowed: z.boolean(),
    network_policy_allowed: z.boolean(),
    pins: ProtocolPins,
  }).strict(),
}).strict()
export type RunAdmissionInput = z.infer<typeof RunAdmissionInput>

export const ResearchRunRecord = z.object({
  run_ref: z.string().min(1).max(256),
  project_id: z.string().min(1).max(256),
  job_execution: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out']),
  intent: ResearchIntent,
  outcome: ScientificOutcome,
  validity: RunValidity,
  protocol_pin: FrozenProtocolPin.nullable(),
  analysis_artifact_id: z.string().min(1).max(256).nullable(),
  evidence_refs: z.array(z.string().min(1).max(256)).max(1_000),
  recorded_at: z.string().datetime(),
}).strict()
export type ResearchRunRecord = z.infer<typeof ResearchRunRecord>

/** Persisted interpretation of a terminal Job. This is deliberately
 * proposal-only: it grants no Evidence/Claim/Gate/Project authority. */
export const ResearchRunClassification = z.object({
  interpretation: z.enum([
    'evidence_candidate',
    'negative_finding_candidate',
    'mixed_finding_candidate',
    'hypothesis_proposal',
    'inconclusive_finding',
    'invalid_run_diagnostic',
    'infrastructure_diagnostic',
    'integrity_diagnostic',
  ]),
  negative_finding_eligible: z.boolean(),
  claim_authority: z.literal('proposal_only'),
}).strict()
export type ResearchRunClassification = z.infer<typeof ResearchRunClassification>

/** Human/agent-authored proposal content supplied alongside a terminal run.
 * The Kernel derives all bindings and the proposal kind from the classified
 * authoritative Job; callers cannot select either. */
export const ResearchClaimProposalInput = z.object({
  proposal_id: z.string().regex(/^claim_proposal_[a-z0-9_]+$/),
  statement: z.string().trim().min(1).max(20_000),
}).strict()
export type ResearchClaimProposalInput = z.infer<typeof ResearchClaimProposalInput>

export const ResearchClaimProposal = z.object({
  proposal_id: z.string().regex(/^claim_proposal_[a-z0-9_]+$/),
  project_id: z.string().min(1).max(256),
  run_ref: z.string().min(1).max(256),
  proposal_kind: z.enum(['negative_finding', 'hypothesis']),
  statement: z.string().min(1).max(20_000),
  analysis_artifact_id: z.string().min(1).max(256).nullable(),
  evidence_refs: z.array(z.string().min(1).max(256)).max(1_000),
  status: z.literal('proposed'),
  authority: z.literal('proposal_only'),
  created_at: z.string().datetime(),
}).strict()
export type ResearchClaimProposal = z.infer<typeof ResearchClaimProposal>

export const NegativeFinding = z.object({
  finding_id: z.string().regex(/^negative_finding_[a-z0-9_]+$/),
  project_id: z.string().min(1).max(256),
  run_ref: z.string().min(1).max(256),
  protocol_pin: FrozenProtocolPin,
  outcome: z.literal('negative'),
  validity: z.literal('valid'),
  analysis_artifact_id: z.string().min(1).max(256),
  evidence_refs: z.array(z.string().min(1).max(256)).min(1).max(1_000),
  claim_proposal_id: z.string().regex(/^claim_proposal_[a-z0-9_]+$/),
  created_at: z.string().datetime(),
}).strict()
export type NegativeFinding = z.infer<typeof NegativeFinding>

/** One append-only outcome envelope per authoritative terminal Job. Related
 * NegativeFinding/Claim proposal records are stored atomically inside this
 * envelope, so replay cannot produce partial or duplicate relationships. */
export const ResearchRunOutcome = z.object({
  run: ResearchRunRecord,
  classification: ResearchRunClassification,
  negative_finding: NegativeFinding.nullable(),
  claim_proposal: ResearchClaimProposal.nullable(),
}).strict().superRefine((value, ctx) => {
  const { run, classification, negative_finding: finding, claim_proposal: proposal } = value
  const eligibleNegative = run.intent === 'confirmatory'
    && run.job_execution === 'succeeded'
    && run.outcome === 'negative'
    && run.validity === 'valid'
    && run.protocol_pin !== null
    && run.analysis_artifact_id !== null
    && run.evidence_refs.length > 0
  const expectedInterpretation = run.validity === 'infrastructure_failure'
    ? 'infrastructure_diagnostic'
    : run.validity === 'integrity_blocked'
      ? 'integrity_diagnostic'
      : run.validity === 'invalid' || run.job_execution !== 'succeeded'
        ? 'invalid_run_diagnostic'
        : run.outcome === 'negative'
          ? 'negative_finding_candidate'
          : run.outcome === 'mixed'
            ? 'mixed_finding_candidate'
            : run.outcome === 'inconclusive'
              ? 'inconclusive_finding'
              : run.intent === 'exploratory' ? 'hypothesis_proposal' : 'evidence_candidate'
  if (classification.interpretation !== expectedInterpretation) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classification', 'interpretation'], message: 'classification interpretation does not match the terminal run facts' })
  }
  if (classification.negative_finding_eligible !== eligibleNegative) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['classification', 'negative_finding_eligible'], message: 'negative-finding eligibility does not match the terminal run facts' })
  }
  if (finding !== null) {
    if (!classification.negative_finding_eligible
      || run.intent !== 'confirmatory'
      || run.job_execution !== 'succeeded'
      || run.outcome !== 'negative'
      || run.validity !== 'valid'
      || run.protocol_pin === null
      || run.analysis_artifact_id === null
      || finding.project_id !== run.project_id
      || finding.run_ref !== run.run_ref
      || finding.analysis_artifact_id !== run.analysis_artifact_id
      || JSON.stringify(finding.protocol_pin) !== JSON.stringify(run.protocol_pin)
      || JSON.stringify(finding.evidence_refs) !== JSON.stringify(run.evidence_refs)
      || finding.created_at !== run.recorded_at
      || proposal === null
      || proposal.proposal_kind !== 'negative_finding'
      || finding.claim_proposal_id !== proposal.proposal_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['negative_finding'], message: 'negative finding is not exactly bound to an eligible confirmatory run and proposal' })
    }
  } else if (classification.negative_finding_eligible) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['negative_finding'], message: 'eligible negative run requires a typed NegativeFinding' })
  }
  if (proposal !== null && (proposal.project_id !== run.project_id || proposal.run_ref !== run.run_ref)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['claim_proposal'], message: 'claim proposal is not bound to this run' })
  }
  if (proposal !== null && proposal.created_at !== run.recorded_at) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['claim_proposal', 'created_at'], message: 'claim proposal timestamp must equal the immutable run record timestamp' })
  }
  if (classification.negative_finding_eligible && proposal !== null
    && (proposal.analysis_artifact_id !== run.analysis_artifact_id
      || JSON.stringify(proposal.evidence_refs) !== JSON.stringify(run.evidence_refs))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['claim_proposal'], message: 'negative-finding proposal refs must exactly match the run refs' })
  }
  if (classification.interpretation === 'hypothesis_proposal') {
    if (proposal === null || proposal.proposal_kind !== 'hypothesis' || proposal.evidence_refs.length !== 0
      || proposal.analysis_artifact_id !== run.analysis_artifact_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['claim_proposal'], message: 'exploratory positive run requires an evidence-free hypothesis proposal' })
    }
  } else if (!classification.negative_finding_eligible && proposal !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['claim_proposal'], message: 'this run classification cannot carry a Claim proposal' })
  }
})
export type ResearchRunOutcome = z.infer<typeof ResearchRunOutcome>

/** Caller-authored scientific portion of one classification. The Kernel
 * derives execution, intent and Protocol facts from RunOutcomeObservation;
 * callers cannot echo or override those authoritative fields. */
export const ResearchRunClassificationWriteRecord = z.object({
  run_ref: z.string().min(1).max(256),
  project_id: z.string().min(1).max(256),
  outcome: ScientificOutcome,
  validity: RunValidity,
  analysis_artifact_id: z.string().min(1).max(256).nullable(),
  evidence_refs: z.array(z.string().min(1).max(256)).max(1_000),
  recorded_at: z.string().datetime(),
}).strict()
export type ResearchRunClassificationWriteRecord = z.infer<typeof ResearchRunClassificationWriteRecord>

export const ResearchRunOutcomeWrite = z.object({
  record: ResearchRunClassificationWriteRecord,
  claim_proposal: ResearchClaimProposalInput.nullable(),
  expected_revision: z.number().int().nonnegative().safe(),
}).strict()
export type ResearchRunOutcomeWrite = z.infer<typeof ResearchRunOutcomeWrite>

export const RunClassificationInput = z.object({
  operation: z.literal('run_classification'),
  record: ResearchRunRecord,
}).strict()
export type RunClassificationInput = z.infer<typeof RunClassificationInput>

export const SynthesisTriggerEventKind = z.enum([
  'major_counterevidence',
  'contract_stopping_condition',
  'budget_threshold',
  'corpus_revision_changed',
  'review_blocked',
])
export type SynthesisTriggerEventKind = z.infer<typeof SynthesisTriggerEventKind>

export const SynthesisTriggerReason = z.enum([
  'valid_cycle_threshold',
  'stagnation_threshold',
  'budget_threshold',
  'major_counterevidence',
  'contract_stopping_condition',
  'corpus_revision_changed',
  'review_blocked',
  'human_request',
])
export type SynthesisTriggerReason = z.infer<typeof SynthesisTriggerReason>

export const SynthesisTriggerPolicy = z.object({
  valid_cycles_threshold: z.number().int().positive(),
  stagnation_cycles_threshold: z.number().int().positive(),
  budget_remaining_ratio_lte: z.number().min(0).max(1),
  enabled_events: z.array(SynthesisTriggerEventKind).max(SynthesisTriggerEventKind.options.length),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<SynthesisTriggerEventKind>()
  for (const [index, kind] of value.enabled_events.entries()) {
    if (seen.has(kind)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate synthesis trigger event kind',
        path: ['enabled_events', index],
      })
    }
    seen.add(kind)
  }
})
export type SynthesisTriggerPolicy = z.infer<typeof SynthesisTriggerPolicy>

export const SynthesisTriggerInput = z.object({
  operation: z.literal('synthesis_trigger'),
  project_id: z.string().min(1).max(256),
  checkpoint: z.object({
    event_seq: z.number().int().nonnegative(),
    project_revision: z.number().int().nonnegative(),
    next_action_revision: z.number().int().nonnegative(),
  }).strict(),
  current: z.object({
    event_seq: z.number().int().nonnegative(),
    project_revision: z.number().int().nonnegative(),
    next_action_revision: z.number().int().nonnegative(),
    valid_cycles_since_checkpoint: z.number().int().nonnegative(),
    stagnant_cycles: z.number().int().nonnegative(),
    budget_remaining_ratio: z.number().min(0).max(1),
  }).strict(),
  policy: SynthesisTriggerPolicy,
  events: z.array(z.object({
    event_id: z.string().min(1).max(256),
    project_id: z.string().min(1).max(256),
    event_seq: z.number().int().nonnegative(),
    kind: SynthesisTriggerEventKind,
  }).strict()).max(10_000),
  human_requested: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.current.event_seq < value.checkpoint.event_seq) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'current event sequence precedes synthesis checkpoint',
      path: ['current', 'event_seq'],
    })
  }

  const eventIds = new Set<string>()
  for (const [index, event] of value.events.entries()) {
    if (event.project_id !== value.project_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'synthesis trigger event belongs to another project',
        path: ['events', index, 'project_id'],
      })
    }
    if (event.event_seq > value.current.event_seq) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'synthesis trigger event is beyond the current snapshot',
        path: ['events', index, 'event_seq'],
      })
    }
    if (eventIds.has(event.event_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'duplicate synthesis trigger event id',
        path: ['events', index, 'event_id'],
      })
    }
    eventIds.add(event.event_id)
  }
})
export type SynthesisTriggerInput = z.infer<typeof SynthesisTriggerInput>

/** Durable request projected after the deterministic synthesis policy fires.
 * It asks an authorized Human/Agent to record content; it never contains or
 * grants authority to generated synthesis prose. */
export const SynthesisRecordRequest = z.object({
  request_id: z.string().regex(/^synthesis_request_[a-z0-9_]+$/),
  project_id: z.string().min(1).max(256),
  trigger_run_ref: z.string().min(1).max(256),
  /** Exact classified Run set in the deterministic fan-in window. A
   * synthesis must bind this set verbatim; the trigger run alone is not an
   * authority grant for arbitrary or stale source refs. */
  source_run_refs: z.array(z.string().min(1).max(256)).min(1).max(10_000),
  reasons: z.array(SynthesisTriggerReason).min(1).max(16),
  window: z.object({
    from_event_seq: z.number().int().nonnegative(),
    to_event_seq: z.number().int().nonnegative(),
  }).strict(),
  snapshot_pin: z.object({
    project_revision: z.number().int().nonnegative(),
    next_action_revision: z.number().int().nonnegative(),
  }).strict(),
  requested_at: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (value.window.to_event_seq < value.window.from_event_seq) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'synthesis request window ends before it starts', path: ['window'] })
  }
  if (!value.source_run_refs.includes(value.trigger_run_ref)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'synthesis trigger run must be included in source_run_refs', path: ['source_run_refs'] })
  }
  if (new Set(value.source_run_refs).size !== value.source_run_refs.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'synthesis source_run_refs must be unique', path: ['source_run_refs'] })
  }
})
export type SynthesisRecordRequest = z.infer<typeof SynthesisRecordRequest>

export const ResearchSourceRef = z.object({
  kind: z.enum([
    'artifact',
    'claim',
    'contract',
    'corpus-snapshot',
    'decision',
    'evidence',
    'protocol',
    'run',
  ]),
  id: z.string().min(1).max(256),
  revision: z.number().int().nonnegative().optional(),
  sha256: MethodologySha256.optional(),
}).strict()
export type ResearchSourceRef = z.infer<typeof ResearchSourceRef>

export const ExplicitSynthesisStatement = z.object({
  provenance: z.literal('explicit'),
  statement: z.string().min(1).max(20_000),
  source_refs: z.array(ResearchSourceRef).min(1).max(1_000),
}).strict()
export type ExplicitSynthesisStatement = z.infer<typeof ExplicitSynthesisStatement>

export const InferredSynthesisStatement = z.object({
  provenance: z.literal('inferred'),
  statement: z.string().min(1).max(20_000),
  source_refs: z.array(ResearchSourceRef).min(1).max(1_000),
  inference: z.object({
    generated_by: z.enum(['human', 'agent', 'panel']),
    generator_ref: z.string().min(1).max(256),
    input_hash: MethodologySha256,
  }).strict(),
}).strict()
export type InferredSynthesisStatement = z.infer<typeof InferredSynthesisStatement>

export const ResearchSynthesisStatement = z.discriminatedUnion('provenance', [
  ExplicitSynthesisStatement,
  InferredSynthesisStatement,
])
export type ResearchSynthesisStatement = z.infer<typeof ResearchSynthesisStatement>

export const ResearchSynthesisStatus = z.enum(['draft', 'reviewed', 'adopted', 'stale'])
export type ResearchSynthesisStatus = z.infer<typeof ResearchSynthesisStatus>

export const ResearchSynthesis = z.object({
  synthesis_id: z.string().regex(/^synth_[a-z0-9_]+$/),
  project_id: z.string().min(1).max(256),
  window: z.object({
    from_event_seq: z.number().int().nonnegative(),
    to_event_seq: z.number().int().nonnegative(),
  }).strict(),
  snapshot_pin: z.object({
    project_revision: z.number().int().nonnegative(),
    next_action_revision: z.number().int().nonnegative(),
  }).strict(),
  inputs: z.object({
    accepted_evidence_refs: z.array(z.string().min(1).max(256)).max(10_000),
    verified_evidence_refs: z.array(z.string().min(1).max(256)).max(10_000),
    run_refs: z.array(z.string().min(1).max(256)).max(10_000),
    corpus_snapshot_refs: z.array(z.string().min(1).max(256)).max(10_000),
  }).strict(),
  findings: z.object({
    supported: z.array(ResearchSynthesisStatement).max(10_000),
    contradicted: z.array(ResearchSynthesisStatement).max(10_000),
    negative: z.array(ResearchSynthesisStatement).max(10_000),
    inconclusive: z.array(ResearchSynthesisStatement).max(10_000),
    infrastructure_failures: z.array(ExplicitSynthesisStatement).max(10_000),
  }).strict(),
  patterns: z.array(InferredSynthesisStatement).max(10_000),
  open_questions: z.array(ResearchSynthesisStatement).max(10_000),
  constraints_learned: z.array(ResearchSynthesisStatement).max(10_000),
  artifact_body_ref: z.string().min(1).max(256),
  direction_proposal_id: z.string().regex(/^direction_[a-z0-9_]+$/).nullable(),
  confidence: z.enum(['low', 'medium', 'high']),
  generated_by: z.enum(['human', 'deterministic', 'agent', 'panel']),
  input_hash: MethodologySha256,
  status: ResearchSynthesisStatus,
  adoption_ref: z.string().min(1).max(256).nullable(),
  created_at: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (value.window.to_event_seq < value.window.from_event_seq) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'synthesis window ends before it starts',
      path: ['window', 'to_event_seq'],
    })
  }
  if (value.status === 'adopted' && value.adoption_ref === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'adopted synthesis requires an adoption receipt ref',
      path: ['adoption_ref'],
    })
  }
})
export type ResearchSynthesis = z.infer<typeof ResearchSynthesis>

export const SynthesisFreshnessInput = z.object({
  operation: z.literal('synthesis_freshness'),
  synthesis: ResearchSynthesis,
  current: z.object({
    project_revision: z.number().int().nonnegative(),
    next_action_revision: z.number().int().nonnegative(),
    input_hash: MethodologySha256,
  }).strict(),
}).strict()
export type SynthesisFreshnessInput = z.infer<typeof SynthesisFreshnessInput>

export const ResearchDirection = z.enum(['deepen', 'broaden', 'pivot', 'conclude', 'pause'])
export type ResearchDirection = z.infer<typeof ResearchDirection>

/** Immutable semantic binding carried by a dedicated Direction Gate. */
export const DirectionGatePayload = z.object({
  purpose: z.literal('direction_adoption'),
  proposal_id: z.string().regex(/^direction_[a-z0-9_]+$/),
  source_synthesis_id: z.string().regex(/^synth_[a-z0-9_]+$/),
  direction: ResearchDirection,
}).strict()
export type DirectionGatePayload = z.infer<typeof DirectionGatePayload>

/** Facts resolved from the durable Gate + Decision by the authoritative
 * adapter. Callers cannot substitute an `approved` boolean for this receipt. */
export const VerifiedDirectionGateApproval = z.object({
  decision_ref: z.string().min(1).max(256),
  gate_id: z.string().regex(/^gate_[a-z0-9_]+$/),
  gate_type: z.literal('direction'),
  decision: z.literal('approved'),
  human_principal_ref: z.string().min(1).max(256),
  binding: DirectionGatePayload,
}).strict()
export type VerifiedDirectionGateApproval = z.infer<typeof VerifiedDirectionGateApproval>

export const DirectionProposal = z.object({
  proposal_id: z.string().regex(/^direction_[a-z0-9_]+$/),
  project_id: z.string().min(1).max(256),
  synthesis_id: z.string().regex(/^synth_[a-z0-9_]+$/),
  direction: ResearchDirection,
  rationale_artifact_id: z.string().min(1).max(256),
  basis: z.array(ResearchSynthesisStatement).min(1).max(10_000),
  snapshot_pin: z.object({
    project_revision: z.number().int().nonnegative(),
    next_action_revision: z.number().int().nonnegative(),
  }).strict(),
  input_hash: MethodologySha256,
  status: z.enum(['proposed', 'stale']),
  created_at: z.string().datetime(),
}).strict()
export type DirectionProposal = z.infer<typeof DirectionProposal>

export const DirectionAdoption = z.object({
  adoption_id: z.string().regex(/^adoption_[a-z0-9_]+$/),
  proposal_id: z.string().regex(/^direction_[a-z0-9_]+$/),
  project_id: z.string().min(1).max(256),
  decision: z.enum(['adopted', 'rejected']),
  actor: z.object({
    kind: z.enum(['human', 'deterministic_policy']),
    ref: z.string().min(1).max(256),
  }).strict(),
  gate_decision_ref: z.string().min(1).max(256).nullable(),
  created_at: z.string().datetime(),
}).strict()
export type DirectionAdoption = z.infer<typeof DirectionAdoption>

export const DirectionAdoptionInput = z.object({
  operation: z.literal('direction_adoption'),
  proposal: DirectionProposal,
  request: z.object({
    adoption_id: z.string().regex(/^adoption_[a-z0-9_]+$/),
    decision: z.enum(['adopt', 'reject']),
    actor: z.object({
      kind: z.enum(['human', 'deterministic_policy', 'agent']),
      ref: z.string().min(1).max(256),
    }).strict(),
    within_approved_contract: z.boolean(),
    gate_approval: VerifiedDirectionGateApproval.nullable(),
    current: z.object({
      project_revision: z.number().int().nonnegative(),
      next_action_revision: z.number().int().nonnegative(),
      input_hash: MethodologySha256,
    }).strict(),
    requested_at: z.string().datetime(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.request.decision === 'reject' && value.request.gate_approval !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'rejected direction does not accept a Gate approval receipt',
      path: ['request', 'gate_approval'],
    })
  }
})
export type DirectionAdoptionInput = z.infer<typeof DirectionAdoptionInput>

export const InnerLoopStep = z.enum(['select', 'run', 'measure', 'record'])
export type InnerLoopStep = z.infer<typeof InnerLoopStep>

export const InnerLoopStepInput = z.object({
  operation: z.literal('inner_loop_step'),
  project_id: z.string().min(1).max(256),
  cycle_id: z.string().regex(/^cycle_[a-z0-9_]+$/),
  protocol_pin: FrozenProtocolPin,
  iteration: z.number().int().positive(),
  max_iterations: z.number().int().positive().max(1_000),
  completed_steps: z.array(InnerLoopStep).max(InnerLoopStep.options.length),
  requested_step: InnerLoopStep,
  approved_snapshot: z.object({
    project_revision: z.number().int().nonnegative(),
    next_action_revision: z.number().int().nonnegative(),
  }).strict(),
  current_snapshot: z.object({
    project_revision: z.number().int().nonnegative(),
    next_action_revision: z.number().int().nonnegative(),
  }).strict(),
  boundary: z.object({
    within_approved_contract: z.boolean(),
    budget_available: z.boolean(),
    runner_allowed: z.boolean(),
    network_policy_allowed: z.boolean(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  for (const [index, step] of value.completed_steps.entries()) {
    if (step !== InnerLoopStep.options[index]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'completed inner-loop steps must be an ordered prefix',
        path: ['completed_steps', index],
      })
    }
  }
})
export type InnerLoopStepInput = z.infer<typeof InnerLoopStepInput>

export const MethodologyDecisionInput = z.union([
  RunAdmissionInput,
  RunClassificationInput,
  SynthesisTriggerInput,
  SynthesisFreshnessInput,
  DirectionAdoptionInput,
  InnerLoopStepInput,
])
export type MethodologyDecisionInput = z.infer<typeof MethodologyDecisionInput>
