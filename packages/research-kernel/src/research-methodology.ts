/**
 * Pure Protocol/loop methodology evaluator.
 *
 * This Module performs no I/O and returns no Project state mutation. Its one
 * interface is the test seam for protocol admission, run interpretation,
 * synthesis triggers and direction governance.
 */

import {
  DirectionAdoption,
  MethodologyDecisionInput,
  type DirectionAdoption as DirectionAdoptionValue,
  type FrozenProtocolPin,
  type InnerLoopStep,
  type MethodologyDecisionInput as MethodologyDecisionInputValue,
  type ProtocolPins,
  type ResearchIntent,
  type ResearchSynthesisStatus,
  type RunValidity,
  type ScientificOutcome,
  type SynthesisTriggerEventKind,
} from '@dsh-scholar/research-schemas'

export type RunAdmissionBlocker =
  | 'protocol_missing'
  | 'protocol_not_frozen'
  | 'protocol_project_mismatch'
  | 'protocol_intent_mismatch'
  | 'protocol_pin_mismatch'
  | 'protocol_frozen_after_request'
  | 'contract_pin_mismatch'
  | 'code_pin_mismatch'
  | 'data_pin_mismatch'
  | 'environment_pin_mismatch'
  | 'contract_not_approved'
  | 'budget_unavailable'
  | 'runner_not_allowed'
  | 'network_policy_blocked'

export interface RunAdmissionReport {
  operation: 'run_admission'
  admitted: boolean
  blockers: RunAdmissionBlocker[]
  protocol_required: boolean
  admitted_protocol: FrozenProtocolPin | null
  /** Methodology evaluation cannot write Project/Gate/Job/Claim state. */
  authoritative_mutations: []
}

export type RunInterpretation =
  | 'evidence_candidate'
  | 'negative_finding_candidate'
  | 'mixed_finding_candidate'
  | 'hypothesis_proposal'
  | 'inconclusive_finding'
  | 'invalid_run_diagnostic'
  | 'infrastructure_diagnostic'
  | 'integrity_diagnostic'

export interface RunClassificationReport {
  operation: 'run_classification'
  intent: ResearchIntent
  outcome: ScientificOutcome
  validity: RunValidity
  job_execution: 'succeeded' | 'failed' | 'cancelled' | 'timed_out'
  interpretation: RunInterpretation
  negative_finding_eligible: boolean
  claim_authority: 'proposal_only'
  authoritative_mutations: []
}

export type SynthesisTriggerReason =
  | 'valid_cycle_threshold'
  | 'stagnation_threshold'
  | 'budget_threshold'
  | SynthesisTriggerEventKind
  | 'human_request'

export interface SynthesisTriggerReport {
  operation: 'synthesis_trigger'
  triggered: boolean
  reasons: SynthesisTriggerReason[]
  window: { from_event_seq: number, to_event_seq: number }
  snapshot_pin: { project_revision: number, next_action_revision: number }
  creates: 'research_synthesis_proposal' | null
  authoritative_mutations: []
}

export type SynthesisStaleReason =
  | 'recorded_stale'
  | 'project_revision_changed'
  | 'next_action_revision_changed'
  | 'input_hash_changed'

export interface SynthesisFreshnessReport {
  operation: 'synthesis_freshness'
  effective_status: ResearchSynthesisStatus
  stale_reasons: SynthesisStaleReason[]
  usable_for_next_action: boolean
  result_authority: 'eligible_for_next_action' | 'proposal_only' | 'diagnostic_only'
  authoritative_mutations: []
}

export type DirectionAdoptionBlocker =
  | 'proposal_stale'
  | 'project_revision_changed'
  | 'next_action_revision_changed'
  | 'input_hash_changed'
  | 'human_required'
  | 'actor_not_authorized'
  | 'approved_gate_required'
  | 'gate_binding_mismatch'
  | 'outside_approved_contract'

export interface DirectionAdoptionReport {
  operation: 'direction_adoption'
  adoptable: boolean
  blockers: DirectionAdoptionBlocker[]
  requires_human: boolean
  requires_gate: boolean
  adoption_candidate: DirectionAdoptionValue | null
  next_step: 'human_review' | 'gate_review' | 'derive_next_action' | 'record_rejection' | 'diagnostic_only'
  authoritative_mutations: []
}

export type InnerLoopBlocker =
  | 'iteration_limit_reached'
  | 'step_out_of_order'
  | 'project_revision_changed'
  | 'next_action_revision_changed'
  | 'outside_approved_contract'
  | 'budget_unavailable'
  | 'runner_not_allowed'
  | 'network_policy_blocked'

export interface InnerLoopStepReport {
  operation: 'inner_loop_step'
  allowed: boolean
  blockers: InnerLoopBlocker[]
  expected_step: InnerLoopStep | null
  next_step_after_completion: InnerLoopStep | null
  cycle_complete_after_step: boolean
  authoritative_mutations: []
}

export type ResearchMethodologyReport =
  | RunAdmissionReport
  | RunClassificationReport
  | SynthesisTriggerReport
  | SynthesisFreshnessReport
  | DirectionAdoptionReport
  | InnerLoopStepReport

function pinsMatch(expected: ProtocolPins, current: ProtocolPins, blockers: RunAdmissionBlocker[]): void {
  for (const kind of ['contract', 'code', 'data', 'environment'] as const) {
    if (expected[kind].ref !== current[kind].ref || expected[kind].sha256 !== current[kind].sha256) {
      blockers.push(`${kind}_pin_mismatch`)
    }
  }
}

function evaluateRunAdmission(input: Extract<MethodologyDecisionInputValue, { operation: 'run_admission' }>): RunAdmissionReport {
  const protocolRequired = input.run_class === 'formal' || input.intent === 'confirmatory'
  const blockers: RunAdmissionBlocker[] = []
  const protocol = input.protocol

  if (protocolRequired && (protocol === null || input.protocol_pin === null)) {
    blockers.push('protocol_missing')
  }
  if (protocol === null && input.protocol_pin !== null) blockers.push('protocol_pin_mismatch')

  if (protocol !== null) {
    if (protocol.status !== 'frozen' || protocol.frozen_at === undefined || protocol.canonical_hash === undefined) {
      blockers.push('protocol_not_frozen')
    }
    if (protocol.project_id !== input.project_id) blockers.push('protocol_project_mismatch')
    if (protocol.intent !== input.intent) blockers.push('protocol_intent_mismatch')
    if (protocol.frozen_at !== undefined && Date.parse(protocol.frozen_at) >= Date.parse(input.requested_at)) {
      blockers.push('protocol_frozen_after_request')
    }
    if (input.protocol_pin === null
      || protocol.protocol_id !== input.protocol_pin.protocol_id
      || protocol.revision !== input.protocol_pin.revision
      || protocol.canonical_hash !== input.protocol_pin.canonical_hash) {
      blockers.push('protocol_pin_mismatch')
    }
    pinsMatch(protocol.pins, input.boundary.pins, blockers)
  }

  if (!input.boundary.contract_approved) blockers.push('contract_not_approved')
  if (!input.boundary.budget_available) blockers.push('budget_unavailable')
  if (!input.boundary.runner_allowed) blockers.push('runner_not_allowed')
  if (!input.boundary.network_policy_allowed) blockers.push('network_policy_blocked')

  const admitted = blockers.length === 0
  const admittedProtocol = admitted && protocol !== null && protocol.canonical_hash !== undefined
    ? {
        protocol_id: protocol.protocol_id,
        revision: protocol.revision,
        canonical_hash: protocol.canonical_hash,
      }
    : null

  return {
    operation: 'run_admission',
    admitted,
    blockers,
    protocol_required: protocolRequired,
    admitted_protocol: admittedProtocol,
    authoritative_mutations: [],
  }
}

function evaluateRunClassification(
  input: Extract<MethodologyDecisionInputValue, { operation: 'run_classification' }>,
): RunClassificationReport {
  const { record } = input
  let interpretation: RunInterpretation

  if (record.validity === 'infrastructure_failure') {
    interpretation = 'infrastructure_diagnostic'
  } else if (record.validity === 'integrity_blocked') {
    interpretation = 'integrity_diagnostic'
  } else if (record.validity === 'invalid' || record.job_execution !== 'succeeded') {
    interpretation = 'invalid_run_diagnostic'
  } else if (record.outcome === 'negative') {
    interpretation = 'negative_finding_candidate'
  } else if (record.outcome === 'mixed') {
    interpretation = 'mixed_finding_candidate'
  } else if (record.outcome === 'inconclusive') {
    interpretation = 'inconclusive_finding'
  } else if (record.intent === 'exploratory') {
    interpretation = 'hypothesis_proposal'
  } else {
    interpretation = 'evidence_candidate'
  }

  const negativeFindingEligible = interpretation === 'negative_finding_candidate'
    && record.intent === 'confirmatory'
    && record.job_execution === 'succeeded'
    && record.validity === 'valid'
    && record.protocol_pin !== null
    && record.analysis_artifact_id !== null
    && record.evidence_refs.length > 0

  return {
    operation: 'run_classification',
    intent: record.intent,
    outcome: record.outcome,
    validity: record.validity,
    job_execution: record.job_execution,
    interpretation,
    negative_finding_eligible: negativeFindingEligible,
    claim_authority: 'proposal_only',
    authoritative_mutations: [],
  }
}

function evaluateSynthesisTrigger(
  input: Extract<MethodologyDecisionInputValue, { operation: 'synthesis_trigger' }>,
): SynthesisTriggerReport {
  const reasons: SynthesisTriggerReason[] = []
  if (input.current.valid_cycles_since_checkpoint >= input.policy.valid_cycles_threshold) {
    reasons.push('valid_cycle_threshold')
  }
  if (input.current.stagnant_cycles >= input.policy.stagnation_cycles_threshold) {
    reasons.push('stagnation_threshold')
  }
  if (input.current.budget_remaining_ratio <= input.policy.budget_remaining_ratio_lte) {
    reasons.push('budget_threshold')
  }

  const eventKinds = new Set(input.events
    .filter(event => event.event_seq > input.checkpoint.event_seq)
    .map(event => event.kind))
  const enabledEventKinds = new Set(input.policy.enabled_events)
  for (const kind of ['major_counterevidence', 'contract_stopping_condition', 'budget_threshold',
    'corpus_revision_changed', 'review_blocked'] as const) {
    if (enabledEventKinds.has(kind) && eventKinds.has(kind) && !reasons.includes(kind)) reasons.push(kind)
  }
  if (input.human_requested) reasons.push('human_request')

  return {
    operation: 'synthesis_trigger',
    triggered: reasons.length > 0,
    reasons,
    window: {
      from_event_seq: input.checkpoint.event_seq + 1,
      to_event_seq: input.current.event_seq,
    },
    snapshot_pin: {
      project_revision: input.current.project_revision,
      next_action_revision: input.current.next_action_revision,
    },
    creates: reasons.length > 0 ? 'research_synthesis_proposal' : null,
    authoritative_mutations: [],
  }
}

function evaluateSynthesisFreshness(
  input: Extract<MethodologyDecisionInputValue, { operation: 'synthesis_freshness' }>,
): SynthesisFreshnessReport {
  const reasons: SynthesisStaleReason[] = []
  if (input.synthesis.status === 'stale') reasons.push('recorded_stale')
  if (input.synthesis.snapshot_pin.project_revision !== input.current.project_revision) {
    reasons.push('project_revision_changed')
  }
  if (input.synthesis.snapshot_pin.next_action_revision !== input.current.next_action_revision) {
    reasons.push('next_action_revision_changed')
  }
  if (input.synthesis.input_hash !== input.current.input_hash) reasons.push('input_hash_changed')

  const stale = reasons.length > 0
  const effectiveStatus: ResearchSynthesisStatus = stale ? 'stale' : input.synthesis.status
  const usable = effectiveStatus === 'adopted'

  return {
    operation: 'synthesis_freshness',
    effective_status: effectiveStatus,
    stale_reasons: reasons,
    usable_for_next_action: usable,
    result_authority: stale
      ? 'diagnostic_only'
      : usable
        ? 'eligible_for_next_action'
        : 'proposal_only',
    authoritative_mutations: [],
  }
}

function evaluateDirectionAdoption(
  input: Extract<MethodologyDecisionInputValue, { operation: 'direction_adoption' }>,
): DirectionAdoptionReport {
  const { proposal, request } = input
  const directionRequiresHuman = proposal.direction === 'pivot' || proposal.direction === 'broaden'
  const directionRequiresGate = request.decision === 'adopt'
    && (directionRequiresHuman || (proposal.direction === 'deepen' && !request.within_approved_contract))
  const gateBindingMatches = request.gate_approval !== null
    && request.gate_approval.binding.proposal_id === proposal.proposal_id
    && request.gate_approval.binding.source_synthesis_id === proposal.synthesis_id
    && request.gate_approval.binding.direction === proposal.direction
  const blockers: DirectionAdoptionBlocker[] = []

  if (proposal.status === 'stale') blockers.push('proposal_stale')
  if (proposal.snapshot_pin.project_revision !== request.current.project_revision) {
    blockers.push('project_revision_changed')
  }
  if (proposal.snapshot_pin.next_action_revision !== request.current.next_action_revision) {
    blockers.push('next_action_revision_changed')
  }
  if (proposal.input_hash !== request.current.input_hash) blockers.push('input_hash_changed')

  if (directionRequiresHuman && request.actor.kind !== 'human') {
    blockers.push('human_required')
  } else if (request.actor.kind === 'agent') {
    blockers.push('actor_not_authorized')
  }

  if (directionRequiresGate && request.gate_approval === null) {
    blockers.push('approved_gate_required')
  } else if (directionRequiresGate && !gateBindingMatches) {
    blockers.push('gate_binding_mismatch')
  }
  if (request.decision === 'adopt'
    && proposal.direction === 'deepen'
    && !request.within_approved_contract
    && !gateBindingMatches) {
    blockers.push('outside_approved_contract')
  }

  const adoptable = blockers.length === 0
  const adoptionCandidate = adoptable
    ? DirectionAdoption.parse({
        adoption_id: request.adoption_id,
        proposal_id: proposal.proposal_id,
        project_id: proposal.project_id,
        decision: request.decision === 'adopt' ? 'adopted' : 'rejected',
        actor: request.actor,
        gate_decision_ref: request.gate_approval?.decision_ref ?? null,
        created_at: request.requested_at,
      })
    : null

  let nextStep: DirectionAdoptionReport['next_step']
  if (blockers.some(blocker => blocker === 'proposal_stale'
    || blocker === 'project_revision_changed'
    || blocker === 'next_action_revision_changed'
    || blocker === 'input_hash_changed')) {
    nextStep = 'diagnostic_only'
  } else if (blockers.includes('human_required')) {
    nextStep = 'human_review'
  } else if (blockers.includes('approved_gate_required') || blockers.includes('gate_binding_mismatch') || blockers.includes('outside_approved_contract')) {
    nextStep = 'gate_review'
  } else if (request.decision === 'reject') {
    nextStep = 'record_rejection'
  } else {
    nextStep = 'derive_next_action'
  }

  return {
    operation: 'direction_adoption',
    adoptable,
    blockers,
    requires_human: directionRequiresHuman,
    requires_gate: directionRequiresGate,
    adoption_candidate: adoptionCandidate,
    next_step: nextStep,
    authoritative_mutations: [],
  }
}

function evaluateInnerLoopStep(
  input: Extract<MethodologyDecisionInputValue, { operation: 'inner_loop_step' }>,
): InnerLoopStepReport {
  const orderedSteps = ['select', 'run', 'measure', 'record'] as const
  const expectedStep = orderedSteps[input.completed_steps.length] ?? null
  const requestedIndex = orderedSteps.indexOf(input.requested_step)
  const blockers: InnerLoopBlocker[] = []

  if (input.iteration > input.max_iterations) blockers.push('iteration_limit_reached')
  if (input.requested_step !== expectedStep) blockers.push('step_out_of_order')
  if (input.approved_snapshot.project_revision !== input.current_snapshot.project_revision) {
    blockers.push('project_revision_changed')
  }
  if (input.approved_snapshot.next_action_revision !== input.current_snapshot.next_action_revision) {
    blockers.push('next_action_revision_changed')
  }
  if (!input.boundary.within_approved_contract) blockers.push('outside_approved_contract')
  if (!input.boundary.budget_available) blockers.push('budget_unavailable')
  if (!input.boundary.runner_allowed) blockers.push('runner_not_allowed')
  if (!input.boundary.network_policy_allowed) blockers.push('network_policy_blocked')

  return {
    operation: 'inner_loop_step',
    allowed: blockers.length === 0,
    blockers,
    expected_step: expectedStep,
    next_step_after_completion: orderedSteps[requestedIndex + 1] ?? null,
    cycle_complete_after_step: input.requested_step === 'record',
    authoritative_mutations: [],
  }
}

export function evaluateResearchMethodology(rawInput: MethodologyDecisionInputValue): ResearchMethodologyReport {
  const input = MethodologyDecisionInput.parse(rawInput)
  switch (input.operation) {
    case 'run_admission': return evaluateRunAdmission(input)
    case 'run_classification': return evaluateRunClassification(input)
    case 'synthesis_trigger': return evaluateSynthesisTrigger(input)
    case 'synthesis_freshness': return evaluateSynthesisFreshness(input)
    case 'direction_adoption': return evaluateDirectionAdoption(input)
    case 'inner_loop_step': return evaluateInnerLoopStep(input)
  }
}
