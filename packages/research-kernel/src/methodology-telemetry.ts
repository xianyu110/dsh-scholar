import {
  AssuranceAuditKind,
  AssuranceExecutionStatus,
  AssuranceVerdict,
  MethodologyRolloutMode,
  type MethodologyRolloutMode as MethodologyRolloutModeValue,
} from '@dsh-scholar/research-schemas'
import type { CounterView, HistogramView, MetricsStore } from './metrics.js'
import type { KnowledgeDeliverySnapshot, KnowledgeDeliverySuppressionReason } from './knowledge-delivery.js'
import type { SynthesisStaleReason, SynthesisTriggerReason } from './research-methodology.js'

export interface RedactedMethodologyMetrics {
  counters: CounterView[]
  histograms: Array<Pick<HistogramView, 'key' | 'tags' | 'count' | 'sum' | 'min' | 'max'>>
}

const KNOWLEDGE_REASONS = new Set<KnowledgeDeliverySuppressionReason>([
  'activation_not_explicit', 'package_not_found', 'package_identity_mismatch',
  'evaluation_not_found', 'evaluation_conflict', 'package_rejected', 'package_revoked',
  'license_not_activatable', 'instruction_source_not_trusted', 'channel_verdict_mismatch',
  'supply_chain_equivocation', 'no_effective_capabilities', 'wrong_project', 'wrong_session',
  'stale_phase', 'stale_next_action', 'deactivated', 'native_pack_missing',
  'native_integrity_failed', 'surface_not_allowed',
])

const SYNTHESIS_STALE_REASONS = new Set<SynthesisStaleReason>([
  'recorded_stale', 'project_revision_changed', 'next_action_revision_changed', 'input_hash_changed',
])

const SYNTHESIS_TRIGGER_REASONS = new Set<SynthesisTriggerReason>([
  'valid_cycle_threshold', 'stagnation_threshold', 'budget_threshold',
  'major_counterevidence', 'contract_stopping_condition', 'corpus_revision_changed',
  'review_blocked', 'human_request',
])

function mode(value: MethodologyRolloutModeValue): MethodologyRolloutModeValue {
  return MethodologyRolloutMode.parse(value)
}

/**
 * The only methodology metrics writer. Every label is parsed or selected
 * from a closed enum here; callers cannot forward ids, paths, package names,
 * hashes, prompts, content or credentials into MetricsStore labels.
 */
export class MethodologyTelemetry {
  constructor(private readonly metrics: MetricsStore) {}

  assuranceExecution(input: {
    mode: MethodologyRolloutModeValue
    audit_kind: string
    execution_status: string
    verdict: string
    duration_ms: number
  }): void {
    const tags = {
      mode: mode(input.mode),
      audit_kind: AssuranceAuditKind.parse(input.audit_kind),
      execution_status: AssuranceExecutionStatus.parse(input.execution_status),
      verdict: AssuranceVerdict.parse(input.verdict),
    }
    this.metrics.count('methodology.assurance.execution_total', tags)
    this.metrics.observe('methodology.assurance.execution_duration_ms', Math.max(0, input.duration_ms), tags)
  }

  reviewer(input: { mode: MethodologyRolloutModeValue, state: 'complete' | 'partial' | 'missing' }): void {
    const state = input.state === 'complete' || input.state === 'partial' || input.state === 'missing'
      ? input.state
      : null
    if (state === null) return
    this.metrics.count('methodology.reviewer.state_total', { mode: mode(input.mode), state })
  }

  knowledgeDelivery(rolloutMode: MethodologyRolloutModeValue, snapshot: KnowledgeDeliverySnapshot): void {
    const safeMode = mode(rolloutMode)
    if (snapshot.deliveries.length > 0) {
      this.metrics.count('methodology.knowledge.delivery_total', {
        mode: safeMode, outcome: 'delivered', reason: 'none',
      }, snapshot.deliveries.length)
    }
    for (const suppressed of snapshot.suppressed) {
      for (const reason of new Set(suppressed.reason_codes)) {
        if (!KNOWLEDGE_REASONS.has(reason)) continue
        this.metrics.count('methodology.knowledge.delivery_total', {
          mode: safeMode, outcome: 'suppressed', reason,
        })
      }
    }
  }

  knowledgeDeactivated(rolloutMode: MethodologyRolloutModeValue): void {
    this.metrics.count('methodology.knowledge.lifecycle_total', {
      mode: mode(rolloutMode), event: 'deactivated',
    })
  }

  synthesisFreshness(input: {
    mode: MethodologyRolloutModeValue
    fresh: boolean
    stale_reasons: SynthesisStaleReason[]
  }): void {
    const safeMode = mode(input.mode)
    if (input.fresh) {
      this.metrics.count('methodology.synthesis.outcome_total', {
        mode: safeMode, event: 'freshness', outcome: 'fresh', reason: 'none',
      })
      return
    }
    const reasons = [...new Set(input.stale_reasons)].filter(reason => SYNTHESIS_STALE_REASONS.has(reason))
    for (const reason of reasons.length === 0 ? ['recorded_stale'] as const : reasons) {
      this.metrics.count('methodology.synthesis.outcome_total', {
        mode: safeMode, event: 'freshness', outcome: 'stale', reason,
      })
    }
  }

  synthesisTrigger(input: {
    mode: MethodologyRolloutModeValue
    triggered: boolean
    reasons: SynthesisTriggerReason[]
  }): void {
    const safeMode = mode(input.mode)
    const reasons = [...new Set(input.reasons)].filter(reason => SYNTHESIS_TRIGGER_REASONS.has(reason))
    if (reasons.length === 0) {
      this.metrics.count('methodology.synthesis.outcome_total', {
        mode: safeMode, event: 'trigger', outcome: input.triggered ? 'triggered' : 'not-triggered', reason: 'none',
      })
      return
    }
    for (const reason of reasons) {
      this.metrics.count('methodology.synthesis.outcome_total', {
        mode: safeMode, event: 'trigger', outcome: input.triggered ? 'triggered' : 'not-triggered', reason,
      })
    }
  }

  writingPatch(input: {
    mode: MethodologyRolloutModeValue
    phase: 'apply' | 'recovery'
    outcome: 'success' | 'failure'
    duration_ms: number
  }): void {
    const tags = { mode: mode(input.mode), phase: input.phase, outcome: input.outcome }
    this.metrics.count('methodology.writing_patch.outcome_total', tags)
    this.metrics.observe('methodology.writing_patch.duration_ms', Math.max(0, input.duration_ms), tags)
  }

  redactedAggregate(): RedactedMethodologyMetrics {
    const snapshot = this.metrics.snapshot()
    return {
      counters: snapshot.counters.filter(series => series.key.startsWith('methodology.')),
      histograms: snapshot.histograms
        .filter(series => series.key.startsWith('methodology.'))
        .map(({ key, tags, count, sum, min, max }) => ({ key, tags, count, sum, min, max })),
    }
  }
}
