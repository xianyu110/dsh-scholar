import { describe, expect, it } from 'vitest'
import { buildResearchGraph } from '../../packages/research-kernel/src/research-graph.js'

const HASH = `sha256:${'a'.repeat(64)}`

describe('Research Graph projection', () => {
  it('rebuilds typed explicit and inferred edges without owning authority', () => {
    const graph = buildResearchGraph({
      project_id: 'project_graph',
      protocols: [{
        protocol_id: 'protocol_graph', project_id: 'project_graph', revision: 1, supersedes: null,
        status: 'frozen', intent: 'confirmatory', research_question_ref: 'question:graph', target_claim_ref: 'claim_graph',
        hypothesis: 'The graph is reproducible.', prediction: 'The projection has typed edges.',
        variables: { manipulated: ['projection'], controlled: [], measured: ['edges'] },
        metrics: { primary: 'edges', secondary: [], baseline_ref: 'baseline', analysis_plan_artifact_id: 'artifact_plan' },
        pins: {
          contract: { ref: 'contract_graph', sha256: HASH }, code: { ref: 'code_graph', sha256: HASH },
          data: { ref: 'data_graph', sha256: HASH }, environment: { ref: 'env_graph', sha256: HASH },
        },
        stopping_conditions: ['Projection is complete.'], failure_criteria: ['An edge is missing.'],
        allowed_deviations: [], deviation_handling: 'Freeze another protocol.', author_principal_id: 'pi_graph',
        created_at: '2026-08-20T00:00:00.000Z', frozen_at: '2026-08-20T00:01:00.000Z', canonical_hash: HASH,
      }],
      syntheses: [{
        synthesis_id: 'synth_graph', project_id: 'project_graph', window: { from_event_seq: 1, to_event_seq: 2 },
        snapshot_pin: { project_revision: 1, next_action_revision: 1 },
        inputs: { accepted_evidence_refs: ['evidence_graph'], verified_evidence_refs: [], run_refs: ['run_graph'], corpus_snapshot_refs: [] },
        findings: {
          supported: [{ provenance: 'explicit', statement: 'Observed.', source_refs: [{ kind: 'evidence', id: 'evidence_graph', sha256: HASH }] }],
          contradicted: [], negative: [], inconclusive: [], infrastructure_failures: [],
        },
        patterns: [{
          provenance: 'inferred', statement: 'Pattern.', source_refs: [{ kind: 'run', id: 'run_graph' }],
          inference: { generated_by: 'agent', generator_ref: 'agent_graph', input_hash: HASH },
        }],
        open_questions: [], constraints_learned: [], artifact_body_ref: 'artifact_synthesis',
        direction_proposal_id: 'direction_graph', confidence: 'medium', generated_by: 'agent', input_hash: HASH,
        status: 'reviewed', adoption_ref: null, created_at: '2026-08-20T00:02:00.000Z',
      }],
      directions: [{
        proposal_id: 'direction_graph', project_id: 'project_graph', synthesis_id: 'synth_graph', direction: 'deepen',
        rationale_artifact_id: 'artifact_direction',
        basis: [{ provenance: 'explicit', statement: 'Observed.', source_refs: [{ kind: 'evidence', id: 'evidence_graph', sha256: HASH }] }],
        snapshot_pin: { project_revision: 1, next_action_revision: 1 }, input_hash: HASH,
        status: 'proposed', created_at: '2026-08-20T00:03:00.000Z',
      }],
      adoptions: [{
        adoption_id: 'adoption_graph', proposal_id: 'direction_graph', project_id: 'project_graph', decision: 'adopted',
        actor: { kind: 'human', ref: 'pi_graph' }, gate_decision_ref: 'decision_graph', created_at: '2026-08-20T00:04:00.000Z',
      }],
      run_outcomes: [],
    })

    expect(graph.nodes.some(node => node.id === 'protocol:protocol_graph')).toBe(true)
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'evidence:evidence_graph', to: 'synthesis:synth_graph', kind: 'supports_statement_in', provenance: 'explicit' }),
      expect.objectContaining({ from: 'run:run_graph', to: 'synthesis:synth_graph', kind: 'inferred_for', provenance: 'inferred' }),
      expect.objectContaining({ from: 'synthesis:synth_graph', to: 'direction:direction_graph', kind: 'proposes' }),
      expect.objectContaining({ from: 'decision:decision_graph', to: 'adoption:adoption_graph', kind: 'input_to' }),
    ]))
  })

  it('fails closed on cross-project records and conflicting source pins', () => {
    expect(() => buildResearchGraph({
      project_id: 'project_a', protocols: [], syntheses: [], directions: [],
      adoptions: [{
        adoption_id: 'adoption_cross', proposal_id: 'direction_cross', project_id: 'project_b', decision: 'rejected',
        actor: { kind: 'human', ref: 'pi' }, gate_decision_ref: null, created_at: '2026-08-20T00:00:00.000Z',
      }],
      run_outcomes: [],
    })).toThrow('research_graph_project_mismatch')
  })
})
