/**
 * Validation fixtures for tests and demos: a complete golden-path project
 * state that mirrors design §13.3's end-to-end flow.
 * @module @dsh-scholar/research-schemas
 */

import type { ResearchProject } from './project.js'
import type { IdeaCard } from './idea.js'
import type { ExperimentContract } from './experiment.js'
import type { CorpusSnapshot } from './corpus.js'
import type { EvidenceItem, Claim } from './evidence.js'

export const NOW = '2026-08-06T12:00:00.000Z'

/** Minimal valid DRAFT project (design §6.2 project.yaml shape). */
export function fixtureProject(overrides: Partial<ResearchProject> = {}): ResearchProject {
  return {
    project_id: 'rsp_20260806_001',
    name: 'robust-temporal-localization',
    workspace: '/research/robust-temporal-localization',
    mode: 'gate-only',
    status: 'SCOPED',
    revision: 1,
    brief: {
      problem: 'Temporal localization of events in untrimmed video is brittle under domain shift.',
      scope: 'Supervised temporal action localization on THUMOS14; no new datasets.',
      questions: ['Does a lightweight domain-adaptation head improve mAP under shift?'],
      primary_metrics: ['mAP@0.5'],
      resources: '1 GPU, <=20 GPU-hours',
      risks: ['Baseline may not reproduce on current CUDA stack'],
      target_outputs: ['conference-paper'],
      target_venue: null,
      baseline_repo: 'https://github.com/example/baseline-repo',
      domain: 'machine-learning',
    },
    constraints: {
      datasets: 'public-only',
      external_model_upload: 'prohibited-for-private-data',
      max_model_cost_usd: 250,
      max_gpu_hours: 120,
      max_parallel_jobs: 4,
    },
    execution: {
      runner_profile: 'local-docker-cpu',
      runner_profile_id: null,
      runner_target_id: 'target_local_docker_v1',
      network_policy: 'allowlist',
      artifact_store: 'local-cas',
      fixture_id: null,
    },
    integrity: {
      require_baseline_reproduction: true,
      require_experiment_contract: true,
      require_claim_evidence_links: true,
      require_clean_room_rerun: false,
      allow_automatic_public_release: false,
      require_signed_manifest: false,
    },
    session_id: 'session_abc123',
    dsh_workspace_id: null,
    created_at: NOW,
    updated_at: NOW,
    history: ['created'],
    deleted_at: null,
    deleted_by: null,
    deletion_reason: null,
    ...overrides,
  }
}

/** A plausible IdeaCard after novelty audit (design §6.3). */
export function fixtureIdea(projectId = 'rsp_20260806_001'): IdeaCard {
  return {
    idea_id: 'idea_003',
    project_id: projectId,
    version: 2,
    // v2 shape (domain-model.md §6): bound to the frozen corpus snapshot
    // (fixtureCorpus above) — the binding the Idea Gate validates.
    corpus_snapshot_id: 'corpus_snap_001',
    title: 'Shift-robust temporal localization via uncertainty-weighted proposals',
    hypothesis: 'Uncertainty-weighted proposal scoring improves temporal localization mAP under domain shift without new data.',
    scientific_gap: { claims: ['ext_claim_17', 'ext_claim_42'], statement: 'Existing methods assume train/test distribution match.' },
    nearest_prior_works: [
      { paper_id: 'doi:10.xxxx/xxxx', same: ['task', 'backbone'], different: ['mechanism', 'training_signal'] },
    ],
    exact_delta: 'Adds an uncertainty branch trained with a proposal-level consistency loss; no architectural change to the backbone.',
    falsification: { observation: 'Under shift condition X, mAP@0.5 should not improve over the baseline by more than 0.5.' },
    minimum_viable_experiment: {
      dataset: 'thumos14',
      baseline: 'baseline_b',
      primary_metric: 'mAP@0.5',
      estimated_gpu_hours: 6,
      expected_runtime: '~45 min on 1 GPU',
    },
    novelty_audit: {
      queries: ['uncertainty temporal localization', 'proposal weighting domain shift'],
      result: 'no_direct_match_found',
      overlap_papers: [],
      unresolved_risk: 'medium',
      audited_at: NOW,
    },
    scores: { feasibility: 4, information_gain: 5, reproducibility: 4, cost: 3 },
    risk_notes: 'Depends on baseline reproduction quality.',
    status: 'approved',
    created_at: NOW,
    updated_at: NOW,
  }
}

/** A frozen corpus snapshot (design §6.1). */
export function fixtureCorpus(projectId = 'rsp_20260806_001'): CorpusSnapshot {
  return {
    snapshot_id: 'corpus_snap_001',
    project_id: projectId,
    // v2 shape (domain-model.md §5): explicit schema version + per-source
    // status (complete = all queries retrieved).
    schema_version: 1,
    source_status: 'complete',
    queries: [{ source: 'openalex', query: 'temporal action localization', run_at: NOW }],
    papers: [
      {
        paper_id: 'doi:10.1000/example1',
        title: 'Temporal Action Localization: A Survey',
        authors: ['A. Author'],
        year: 2021,
        venue: 'TPAMI',
        source: 'openalex',
        identifiers: { doi: '10.1000/example1' },
        abstract: 'Survey of temporal action localization methods.',
        retrieved_at: NOW,
      },
    ],
    passages: [
      {
        passage_id: 'passage_1',
        paper_id: 'doi:10.1000/example1',
        text: 'Most methods assume train and test distributions match.',
        location: 'p.3, §2',
        claim_summary: 'Distribution shift is unaddressed.',
        // v2 shape (domain-model.md §5): sha256(text).
        content_hash: '9f37b91ae03367d0026fea6cb9ebb0e4ab454763494437ca7b53668a73e84ba1',
        is_untrusted: true,
      },
    ],
    citation_edges: [],
    external_claims: [
      {
        ext_claim_id: 'ext_claim_17',
        paper_id: 'doi:10.1000/example1',
        passage_id: 'passage_1',
        statement: 'Most methods assume train and test distributions match.',
        claim_type: 'limitation',
      },
    ],
    quality: { total_papers: 1, dedup_ratio: 0, coverage_note: 'fixture' },
    created_at: NOW,
    frozen: true,
  }
}

/** A frozen ExperimentContract (design §6.4). */
export function fixtureContract(projectId = 'rsp_20260806_001'): ExperimentContract {
  return {
    contract_id: 'expc_007',
    version: 1,
    project_id: projectId,
    idea_id: 'idea_003',
    baseline_run: 'run_baseline_001',
    code_snapshot: 'sha256:abcdef',
    data: { dataset_id: 'thumos14', version: 'v2', split: 'official' },
    methods: { baseline: 'baseline_b', treatment: 'method_a' },
    metrics: { primary: 'mAP@0.5', secondary: ['accuracy'], direction: 'higher_is_better' },
    seeds: [11, 23, 47, 89, 101],
    analysis: { effect_size: 'mean_difference', interval: 'bootstrap_95', multiple_testing: 'holm' },
    ablations: ['component_x'],
    stop_conditions: { max_gpu_hours: 48, min_completed_seeds: 5, stop_on_data_leakage: true },
    status: 'approved',
    approval: { gate_decision_id: 'gate_contract_007', approved_at: NOW, approved_by: 'human-user' },
    created_at: NOW,
    updated_at: NOW,
  }
}

/** An evidence item + bound claim (design §6.5). */
export function fixtureEvidence(projectId = 'rsp_20260806_001'): { evidence: EvidenceItem; claim: Claim } {
  return {
    evidence: {
      evidence_id: 'evidence_001',
      project_id: projectId,
      source_type: 'run',
      run_ids: ['run_a_seed_11', 'run_a_seed_23', 'run_a_seed_47', 'run_a_seed_89', 'run_a_seed_101'],
      artifact_refs: ['sha256:analysis1'],
      analysis_method: 'bootstrap_95_mean_difference',
      result: {
        primary_metric: 'mAP@0.5',
        value: 61.2,
        baseline_value: 58.4,
        effect_size: 2.8,
        ci_low: 1.1,
        ci_high: 4.5,
        n_seeds: 5,
      },
      uncertainty: 'Single dataset; compute-constrained sweep.',
      status: 'accepted',
      generated_by: 'statistician',
      created_at: NOW,
    },
    claim: {
      claim_id: 'claim_method_017',
      project_id: projectId,
      statement: 'Method A improves mAP@0.5 over Baseline B on THUMOS14.',
      scope: { dataset: 'thumos14_v2', split: 'official_test' },
      evidence: { evidence_ids: ['evidence_001'], analysis_artifact: 'sha256:analysis1' },
      status: 'supported',
      confidence: 'high',
      limitations: ['single dataset', 'compute-constrained sweep'],
      history: [
        { status: 'proposed', at: NOW, reason: '' },
        { status: 'supported', at: NOW, reason: '5-seed bootstrap CI excludes zero' },
      ],
      created_at: NOW,
      updated_at: NOW,
    },
  }
}
