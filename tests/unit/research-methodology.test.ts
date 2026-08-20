import { describe, expect, it } from 'vitest'
import {
  MethodologyDecisionInput,
  ProtocolRevision,
  ResearchSynthesis,
  type ProtocolRevision as ProtocolRevisionValue,
} from '@dsh-scholar/research-schemas'
import { evaluateResearchMethodology } from '@dsh-scholar/research-kernel'

const now = '2026-08-20T10:00:00.000Z'
const earlier = '2026-08-20T09:00:00.000Z'
const hashA = `sha256:${'a'.repeat(64)}`
const hashB = `sha256:${'b'.repeat(64)}`
const hashC = `sha256:${'c'.repeat(64)}`
const hashD = `sha256:${'d'.repeat(64)}`
const hashE = `sha256:${'e'.repeat(64)}`

function frozenProtocol(overrides: Partial<ProtocolRevisionValue> = {}): ProtocolRevisionValue {
  return ProtocolRevision.parse({
    protocol_id: 'protocol_cnn_ablation',
    project_id: 'rsp_cnn',
    revision: 1,
    supersedes: null,
    status: 'frozen',
    intent: 'confirmatory',
    research_question_ref: 'question_cnn_accuracy',
    target_claim_ref: 'claim_cnn_ablation',
    hypothesis: 'Removing the augmentation lowers held-out accuracy.',
    prediction: 'Mean accuracy decreases by at least two percentage points.',
    variables: {
      manipulated: ['augmentation'],
      controlled: ['architecture', 'optimizer'],
      measured: ['held-out accuracy'],
    },
    metrics: {
      primary: 'accuracy',
      secondary: ['loss'],
      baseline_ref: 'run_baseline',
      analysis_plan_artifact_id: 'art_analysis_plan',
    },
    pins: {
      contract: { ref: 'expc_cnn', sha256: hashA },
      code: { ref: 'snapshot_cnn', sha256: hashB },
      data: { ref: 'dataset_mnist', sha256: hashC },
      environment: { ref: 'runner_local_gpu', sha256: hashD },
    },
    stopping_conditions: ['five completed seeds'],
    failure_criteria: ['data leakage', 'integrity check failure'],
    allowed_deviations: ['retry a transient runner failure'],
    deviation_handling: 'Record every deviation; scientific changes require a new revision.',
    author_principal_id: 'principal_pi',
    created_at: earlier,
    frozen_at: earlier,
    canonical_hash: hashE,
    ...overrides,
  })
}

describe('Research methodology Module', () => {
  it('admits a formal run only against the exact earlier frozen protocol and approved boundary', () => {
    const protocol = frozenProtocol()
    const report = evaluateResearchMethodology({
      operation: 'run_admission',
      project_id: 'rsp_cnn',
      requested_at: now,
      run_class: 'formal',
      intent: 'confirmatory',
      protocol,
      protocol_pin: {
        protocol_id: protocol.protocol_id,
        revision: protocol.revision,
        canonical_hash: protocol.canonical_hash!,
      },
      boundary: {
        contract_approved: true,
        budget_available: true,
        runner_allowed: true,
        network_policy_allowed: true,
        pins: protocol.pins,
      },
    })

    expect(report).toEqual({
      operation: 'run_admission',
      admitted: true,
      blockers: [],
      protocol_required: true,
      admitted_protocol: {
        protocol_id: 'protocol_cnn_ablation',
        revision: 1,
        canonical_hash: hashE,
      },
      authoritative_mutations: [],
    })
  })

  it('fails closed before creating a formal run when protocol or approved boundary is missing', () => {
    const protocol = frozenProtocol()
    const missing = evaluateResearchMethodology({
      operation: 'run_admission',
      project_id: 'rsp_cnn',
      requested_at: now,
      run_class: 'formal',
      intent: 'confirmatory',
      protocol: null,
      protocol_pin: null,
      boundary: {
        contract_approved: true,
        budget_available: true,
        runner_allowed: true,
        network_policy_allowed: true,
        pins: protocol.pins,
      },
    })
    expect(missing).toMatchObject({
      admitted: false,
      blockers: ['protocol_missing'],
      admitted_protocol: null,
      authoritative_mutations: [],
    })

    const changed = evaluateResearchMethodology({
      operation: 'run_admission',
      project_id: 'rsp_cnn',
      requested_at: now,
      run_class: 'formal',
      intent: 'confirmatory',
      protocol,
      protocol_pin: {
        protocol_id: protocol.protocol_id,
        revision: protocol.revision,
        canonical_hash: hashA,
      },
      boundary: {
        contract_approved: false,
        budget_available: false,
        runner_allowed: false,
        network_policy_allowed: false,
        pins: {
          ...protocol.pins,
          code: { ref: protocol.pins.code.ref, sha256: hashA },
        },
      },
    })
    expect(changed).toMatchObject({
      admitted: false,
      blockers: [
        'protocol_pin_mismatch',
        'code_pin_mismatch',
        'contract_not_approved',
        'budget_unavailable',
        'runner_not_allowed',
        'network_policy_blocked',
      ],
      admitted_protocol: null,
      authoritative_mutations: [],
    })
  })

  it('rejects a dangling Protocol pin even for an informal exploratory run', () => {
    const protocol = frozenProtocol()
    const report = evaluateResearchMethodology({
      operation: 'run_admission',
      project_id: 'rsp_cnn',
      requested_at: now,
      run_class: 'informal',
      intent: 'exploratory',
      protocol: null,
      protocol_pin: {
        protocol_id: protocol.protocol_id,
        revision: protocol.revision,
        canonical_hash: protocol.canonical_hash!,
      },
      boundary: {
        contract_approved: true,
        budget_available: true,
        runner_allowed: true,
        network_policy_allowed: true,
        pins: protocol.pins,
      },
    })
    expect(report).toMatchObject({
      admitted: false,
      blockers: ['protocol_pin_mismatch'],
      admitted_protocol: null,
      authoritative_mutations: [],
    })
  })

  it('keeps intent, scientific outcome and run validity orthogonal', () => {
    const protocol = frozenProtocol()
    const report = evaluateResearchMethodology({
      operation: 'run_classification',
      record: {
        run_ref: 'run_cnn_negative',
        project_id: 'rsp_cnn',
        job_execution: 'succeeded',
        intent: 'confirmatory',
        outcome: 'negative',
        validity: 'valid',
        protocol_pin: {
          protocol_id: protocol.protocol_id,
          revision: protocol.revision,
          canonical_hash: protocol.canonical_hash!,
        },
        analysis_artifact_id: 'art_analysis_negative',
        evidence_refs: ['evidence_cnn_negative'],
        recorded_at: now,
      },
    })

    expect(report).toEqual({
      operation: 'run_classification',
      intent: 'confirmatory',
      outcome: 'negative',
      validity: 'valid',
      job_execution: 'succeeded',
      interpretation: 'negative_finding_candidate',
      negative_finding_eligible: true,
      claim_authority: 'proposal_only',
      authoritative_mutations: [],
    })
  })

  it('never turns infrastructure failure into a scientific negative or exploration into a supported Claim', () => {
    const failed = evaluateResearchMethodology({
      operation: 'run_classification',
      record: {
        run_ref: 'run_oom',
        project_id: 'rsp_cnn',
        job_execution: 'failed',
        intent: 'confirmatory',
        outcome: 'negative',
        validity: 'infrastructure_failure',
        protocol_pin: null,
        analysis_artifact_id: null,
        evidence_refs: [],
        recorded_at: now,
      },
    })
    expect(failed).toMatchObject({
      interpretation: 'infrastructure_diagnostic',
      negative_finding_eligible: false,
      claim_authority: 'proposal_only',
      authoritative_mutations: [],
    })

    const explored = evaluateResearchMethodology({
      operation: 'run_classification',
      record: {
        run_ref: 'run_exploratory_pattern',
        project_id: 'rsp_cnn',
        job_execution: 'succeeded',
        intent: 'exploratory',
        outcome: 'positive',
        validity: 'valid',
        protocol_pin: null,
        analysis_artifact_id: 'art_exploratory',
        evidence_refs: [],
        recorded_at: now,
      },
    })
    expect(explored).toMatchObject({
      interpretation: 'hypothesis_proposal',
      claim_authority: 'proposal_only',
      authoritative_mutations: [],
    })

    const exploratoryNegative = evaluateResearchMethodology({
      operation: 'run_classification',
      record: {
        run_ref: 'run_exploratory_negative',
        project_id: 'rsp_cnn',
        job_execution: 'succeeded',
        intent: 'exploratory',
        outcome: 'negative',
        validity: 'valid',
        protocol_pin: {
          protocol_id: 'protocol_cnn_ablation', revision: 1, canonical_hash: hashE,
        },
        analysis_artifact_id: 'art_exploratory_negative',
        evidence_refs: ['evidence_exploratory_negative'],
        recorded_at: now,
      },
    })
    expect(exploratoryNegative).toMatchObject({
      interpretation: 'negative_finding_candidate',
      negative_finding_eligible: false,
      claim_authority: 'proposal_only',
    })
  })

  it('triggers outer synthesis only from deterministic thresholds, typed events or a Human request', () => {
    const report = evaluateResearchMethodology({
      operation: 'synthesis_trigger',
      project_id: 'rsp_cnn',
      checkpoint: {
        event_seq: 120,
        project_revision: 7,
        next_action_revision: 4,
      },
      current: {
        event_seq: 148,
        project_revision: 7,
        next_action_revision: 4,
        valid_cycles_since_checkpoint: 5,
        stagnant_cycles: 1,
        budget_remaining_ratio: 0.4,
      },
      policy: {
        valid_cycles_threshold: 5,
        stagnation_cycles_threshold: 3,
        budget_remaining_ratio_lte: 0.1,
        enabled_events: ['major_counterevidence', 'contract_stopping_condition'],
      },
      events: [
        {
          event_id: 'event_counterevidence',
          project_id: 'rsp_cnn',
          event_seq: 143,
          kind: 'major_counterevidence',
        },
      ],
      human_requested: false,
    })

    expect(report).toEqual({
      operation: 'synthesis_trigger',
      triggered: true,
      reasons: ['valid_cycle_threshold', 'major_counterevidence'],
      window: { from_event_seq: 121, to_event_seq: 148 },
      snapshot_pin: { project_revision: 7, next_action_revision: 4 },
      creates: 'research_synthesis_proposal',
      authoritative_mutations: [],
    })
  })

  it('keeps explicit facts separate from inferred patterns and marks stale fan-in diagnostic-only', () => {
    const synthesis = ResearchSynthesis.parse({
      synthesis_id: 'synth_cnn_window_121_148',
      project_id: 'rsp_cnn',
      window: { from_event_seq: 121, to_event_seq: 148 },
      snapshot_pin: { project_revision: 7, next_action_revision: 4 },
      inputs: {
        accepted_evidence_refs: ['evidence_cnn_negative'],
        verified_evidence_refs: [],
        run_refs: ['run_cnn_negative'],
        corpus_snapshot_refs: ['corpus_mnist'],
      },
      findings: {
        supported: [],
        contradicted: [{
          provenance: 'explicit',
          statement: 'The preregistered prediction was not supported.',
          source_refs: [{ kind: 'evidence', id: 'evidence_cnn_negative', sha256: hashA }],
        }],
        negative: [],
        inconclusive: [],
        infrastructure_failures: [],
      },
      patterns: [{
        provenance: 'inferred',
        statement: 'Augmentation may matter more for low-data regimes.',
        source_refs: [
          { kind: 'evidence', id: 'evidence_cnn_negative', sha256: hashA },
          { kind: 'corpus-snapshot', id: 'corpus_mnist', sha256: hashB },
        ],
        inference: {
          generated_by: 'agent',
          generator_ref: 'model_synthesis',
          input_hash: hashC,
        },
      }],
      open_questions: [],
      constraints_learned: [],
      artifact_body_ref: 'art_synthesis_body',
      direction_proposal_id: null,
      confidence: 'medium',
      generated_by: 'agent',
      input_hash: hashD,
      status: 'adopted',
      adoption_ref: 'adoption_synthesis_cnn',
      created_at: now,
    })

    const report = evaluateResearchMethodology({
      operation: 'synthesis_freshness',
      synthesis,
      current: {
        project_revision: 8,
        next_action_revision: 4,
        input_hash: hashD,
      },
    })
    expect(report).toEqual({
      operation: 'synthesis_freshness',
      effective_status: 'stale',
      stale_reasons: ['project_revision_changed'],
      usable_for_next_action: false,
      result_authority: 'diagnostic_only',
      authoritative_mutations: [],
    })

    expect(() => ResearchSynthesis.parse({
      ...synthesis,
      patterns: [{
        provenance: 'inferred',
        statement: 'Unsupported mechanism inference.',
        source_refs: [],
        inference: { generated_by: 'agent', generator_ref: 'model_synthesis', input_hash: hashC },
      }],
    })).toThrow()

    expect(() => ResearchSynthesis.parse({
      ...synthesis,
      adoption_ref: null,
    })).toThrow()
  })

  it('requires Human and an approved existing Gate to adopt broaden or pivot directions', () => {
    const proposal = {
      proposal_id: 'direction_pivot_dataset',
      project_id: 'rsp_cnn',
      synthesis_id: 'synth_cnn_window_121_148',
      direction: 'pivot' as const,
      rationale_artifact_id: 'art_direction_rationale',
      basis: [{
        provenance: 'explicit' as const,
        statement: 'The approved stopping condition was reached.',
        source_refs: [{ kind: 'contract' as const, id: 'expc_cnn', sha256: hashA }],
      }],
      snapshot_pin: { project_revision: 7, next_action_revision: 4 },
      input_hash: hashD,
      status: 'proposed' as const,
      created_at: now,
    }

    const denied = evaluateResearchMethodology({
      operation: 'direction_adoption',
      proposal,
      request: {
        adoption_id: 'adoption_pivot_denied',
        decision: 'adopt',
        actor: { kind: 'agent', ref: 'agent_researcher' },
        within_approved_contract: false,
        gate_approval: null,
        current: { project_revision: 7, next_action_revision: 4, input_hash: hashD },
        requested_at: now,
      },
    })
    expect(denied).toEqual({
      operation: 'direction_adoption',
      adoptable: false,
      blockers: ['human_required', 'approved_gate_required'],
      requires_human: true,
      requires_gate: true,
      adoption_candidate: null,
      next_step: 'human_review',
      authoritative_mutations: [],
    })

    const allowed = evaluateResearchMethodology({
      operation: 'direction_adoption',
      proposal,
      request: {
        adoption_id: 'adoption_pivot_allowed',
        decision: 'adopt',
        actor: { kind: 'human', ref: 'principal_pi' },
        within_approved_contract: false,
        gate_approval: {
          decision_ref: 'decision_direction_pivot', gate_id: 'gate_direction_pivot',
          gate_type: 'direction', decision: 'approved', human_principal_ref: 'principal_pi',
          binding: {
            purpose: 'direction_adoption', proposal_id: 'direction_pivot_dataset',
            source_synthesis_id: 'synth_cnn_window_121_148', direction: 'pivot',
          },
        },
        current: { project_revision: 7, next_action_revision: 4, input_hash: hashD },
        requested_at: now,
      },
    })
    expect(allowed).toMatchObject({
      operation: 'direction_adoption',
      adoptable: true,
      blockers: [],
      requires_human: true,
      requires_gate: true,
      adoption_candidate: {
        adoption_id: 'adoption_pivot_allowed',
        proposal_id: 'direction_pivot_dataset',
        project_id: 'rsp_cnn',
        decision: 'adopted',
        actor: { kind: 'human', ref: 'principal_pi' },
        gate_decision_ref: 'decision_direction_pivot',
      },
      next_step: 'derive_next_action',
      authoritative_mutations: [],
    })

    const rejected = evaluateResearchMethodology({
      operation: 'direction_adoption',
      proposal,
      request: {
        adoption_id: 'adoption_pivot_rejected',
        decision: 'reject',
        actor: { kind: 'human', ref: 'principal_pi' },
        within_approved_contract: false,
        gate_approval: null,
        current: { project_revision: 7, next_action_revision: 4, input_hash: hashD },
        requested_at: now,
      },
    })
    expect(rejected).toMatchObject({
      adoptable: true,
      blockers: [],
      requires_human: true,
      requires_gate: false,
      adoption_candidate: { decision: 'rejected', gate_decision_ref: null },
      next_step: 'record_rejection',
      authoritative_mutations: [],
    })

    const wrongBinding = evaluateResearchMethodology({
      operation: 'direction_adoption',
      proposal,
      request: {
        adoption_id: 'adoption_pivot_wrong_binding', decision: 'adopt',
        actor: { kind: 'human', ref: 'principal_pi' }, within_approved_contract: false,
        gate_approval: {
          decision_ref: 'decision_direction_other', gate_id: 'gate_direction_other',
          gate_type: 'direction', decision: 'approved', human_principal_ref: 'principal_pi',
          binding: {
            purpose: 'direction_adoption', proposal_id: 'direction_other',
            source_synthesis_id: 'synth_cnn_window_121_148', direction: 'pivot',
          },
        },
        current: { project_revision: 7, next_action_revision: 4, input_hash: hashD },
        requested_at: now,
      },
    })
    expect(wrongBinding).toMatchObject({
      adoptable: false, blockers: ['gate_binding_mismatch'], adoption_candidate: null, next_step: 'gate_review',
    })

    const outsideContractDeepen = evaluateResearchMethodology({
      operation: 'direction_adoption',
      proposal: { ...proposal, proposal_id: 'direction_deepen_outside', direction: 'deepen' },
      request: {
        adoption_id: 'adoption_deepen_outside', decision: 'adopt',
        actor: { kind: 'deterministic_policy', ref: 'policy_direction' }, within_approved_contract: false,
        gate_approval: {
          decision_ref: 'decision_direction_deepen', gate_id: 'gate_direction_deepen',
          gate_type: 'direction', decision: 'approved', human_principal_ref: 'principal_pi',
          binding: {
            purpose: 'direction_adoption', proposal_id: 'direction_deepen_outside',
            source_synthesis_id: 'synth_cnn_window_121_148', direction: 'deepen',
          },
        },
        current: { project_revision: 7, next_action_revision: 4, input_hash: hashD },
        requested_at: now,
      },
    })
    expect(outsideContractDeepen).toMatchObject({
      adoptable: true, blockers: [], requires_gate: true,
      adoption_candidate: { decision: 'adopted', gate_decision_ref: 'decision_direction_deepen' },
    })
  })

  it('keeps the inner loop ordered and bounded by the approved revisions and iteration cap', () => {
    const protocol = frozenProtocol()
    const allowed = evaluateResearchMethodology({
      operation: 'inner_loop_step',
      project_id: 'rsp_cnn',
      cycle_id: 'cycle_cnn_1',
      protocol_pin: {
        protocol_id: protocol.protocol_id,
        revision: protocol.revision,
        canonical_hash: protocol.canonical_hash!,
      },
      iteration: 1,
      max_iterations: 5,
      completed_steps: ['select', 'run'],
      requested_step: 'measure',
      approved_snapshot: { project_revision: 7, next_action_revision: 4 },
      current_snapshot: { project_revision: 7, next_action_revision: 4 },
      boundary: {
        within_approved_contract: true,
        budget_available: true,
        runner_allowed: true,
        network_policy_allowed: true,
      },
    })
    expect(allowed).toEqual({
      operation: 'inner_loop_step',
      allowed: true,
      blockers: [],
      expected_step: 'measure',
      next_step_after_completion: 'record',
      cycle_complete_after_step: false,
      authoritative_mutations: [],
    })

    const exhausted = evaluateResearchMethodology({
      operation: 'inner_loop_step',
      project_id: 'rsp_cnn',
      cycle_id: 'cycle_cnn_6',
      protocol_pin: {
        protocol_id: protocol.protocol_id,
        revision: protocol.revision,
        canonical_hash: protocol.canonical_hash!,
      },
      iteration: 6,
      max_iterations: 5,
      completed_steps: [],
      requested_step: 'run',
      approved_snapshot: { project_revision: 7, next_action_revision: 4 },
      current_snapshot: { project_revision: 8, next_action_revision: 5 },
      boundary: {
        within_approved_contract: false,
        budget_available: false,
        runner_allowed: true,
        network_policy_allowed: true,
      },
    })
    expect(exhausted).toMatchObject({
      allowed: false,
      blockers: [
        'iteration_limit_reached',
        'step_out_of_order',
        'project_revision_changed',
        'next_action_revision_changed',
        'outside_approved_contract',
        'budget_unavailable',
      ],
      expected_step: 'select',
      authoritative_mutations: [],
    })
  })

  it('rejects subjective Agent trigger fields and unknown methodology data', () => {
    expect(() => MethodologyDecisionInput.parse({
      operation: 'synthesis_trigger',
      project_id: 'rsp_cnn',
      checkpoint: { event_seq: 1, project_revision: 1, next_action_revision: 1 },
      current: {
        event_seq: 2,
        project_revision: 1,
        next_action_revision: 1,
        valid_cycles_since_checkpoint: 0,
        stagnant_cycles: 0,
        budget_remaining_ratio: 1,
      },
      policy: {
        valid_cycles_threshold: 5,
        stagnation_cycles_threshold: 3,
        budget_remaining_ratio_lte: 0.1,
        enabled_events: [],
      },
      events: [],
      human_requested: false,
      agent_requested: true,
    })).toThrow()
  })
})
