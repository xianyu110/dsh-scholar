import { describe, expect, it } from 'vitest'
import { MethodologyTelemetry, MetricsStore } from '@dsh-scholar/research-kernel'

describe('redacted methodology telemetry', () => {
  it('records the required bounded outcomes and exposes only known low-cardinality series', () => {
    const metrics = new MetricsStore()
    const telemetry = new MethodologyTelemetry(metrics)
    telemetry.assuranceExecution({
      mode: 'opt-in-dev', audit_kind: 'writing', execution_status: 'succeeded', verdict: 'PASS', duration_ms: 12,
    })
    telemetry.reviewer({ mode: 'opt-in-dev', state: 'complete' })
    telemetry.reviewer({ mode: 'opt-in-dev', state: 'partial' })
    telemetry.reviewer({ mode: 'opt-in-dev', state: 'missing' })
    telemetry.knowledgeDelivery('opt-in-dev', {
      context: {
        project_id: 'project-secret', session_id: 'session-secret', phase: 'WRITING',
        next_action_revision: 4, surface: 'scholar-chat',
      },
      deliveries: [{
        activation_id: 'activation-secret', package_name: 'package-secret', package_version: '1.0.0',
        manifest_sha256: `sha256:${'a'.repeat(64)}`, payload_sha256: `sha256:${'b'.repeat(64)}`,
        trust: 'untrusted-external-reference', effective_capabilities: [], content: null,
      }],
      suppressed: [{ activation_id: 'revoked-secret', reason_codes: ['package_revoked'] }],
    })
    telemetry.knowledgeDeactivated('opt-in-dev')
    telemetry.synthesisFreshness({ mode: 'opt-in-dev', fresh: false, stale_reasons: ['input_hash_changed'] })
    telemetry.synthesisTrigger({ mode: 'opt-in-dev', triggered: true, reasons: ['human_request'] })
    telemetry.writingPatch({ mode: 'opt-in-dev', phase: 'apply', outcome: 'success', duration_ms: 8 })
    telemetry.writingPatch({ mode: 'opt-in-dev', phase: 'recovery', outcome: 'failure', duration_ms: 2 })

    const aggregate = telemetry.redactedAggregate()
    expect(aggregate.counters.map(item => item.key)).toEqual(expect.arrayContaining([
      'methodology.assurance.execution_total',
      'methodology.reviewer.state_total',
      'methodology.knowledge.delivery_total',
      'methodology.knowledge.lifecycle_total',
      'methodology.synthesis.outcome_total',
      'methodology.writing_patch.outcome_total',
    ]))
    expect(aggregate.histograms.map(item => item.key)).toEqual(expect.arrayContaining([
      'methodology.assurance.execution_duration_ms',
      'methodology.writing_patch.duration_ms',
    ]))
    expect(JSON.stringify(aggregate)).not.toMatch(/project-secret|session-secret|package-secret|activation-secret|revoked-secret|sha256|prompt|token/i)
    for (const series of [...aggregate.counters, ...aggregate.histograms]) {
      expect(Object.keys(series.tags).sort()).toEqual(expect.not.arrayContaining([
        'project_id', 'session_id', 'package_name', 'path', 'hash', 'prompt', 'token',
      ]))
    }
  })

  it('does not increase series cardinality for different project/session/package identities', () => {
    const metrics = new MetricsStore()
    const telemetry = new MethodologyTelemetry(metrics)
    for (let index = 0; index < 100; index += 1) {
      telemetry.knowledgeDelivery('opt-in-user', {
        context: {
          project_id: `project-${index}`, session_id: `session-${index}`, phase: `phase-${index}`,
          next_action_revision: index, surface: 'assurance-reviewer',
        },
        deliveries: [{
          activation_id: `activation-${index}`, package_name: `package-${index}`, package_version: `${index}`,
          manifest_sha256: `sha256:${'a'.repeat(64)}`, payload_sha256: `sha256:${'b'.repeat(64)}`,
          trust: 'untrusted-external-reference', effective_capabilities: [], content: null,
        }],
        suppressed: [{ activation_id: `suppressed-${index}`, reason_codes: ['wrong_session'] }],
      })
    }
    const aggregate = telemetry.redactedAggregate()
    const delivery = aggregate.counters.filter(item => item.key === 'methodology.knowledge.delivery_total')
    expect(delivery).toHaveLength(2)
    expect(delivery.map(item => item.value).sort((a, b) => a - b)).toEqual([100, 100])
  })
})
