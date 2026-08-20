import { afterEach, describe, expect, it } from 'vitest'
import { assertLocaleParity, setLocale } from '../../src/client/i18n/index.js'
import {
  methodologyProjectionModel,
  methodologyProjectionPath,
  type CompactMethodologyProjection,
} from '../../src/client/methodology-projection.js'

const fullProjection: CompactMethodologyProjection = {
  project_id: 'rsp_methodology',
  revision: 12,
  assurance: { level: 'submission', ready: false, reason_codes: ['citation_missing'] },
  protocol: { current_id: 'protocol_confirmatory_2', revision: 2, status: 'frozen', intent: 'confirmatory' },
  synthesis: { current_id: 'synthesis_4', fresh: false, stale_reasons: ['project_revision_changed'] },
  knowledge: {
    active_count: 2,
    package_names: ['scholar.paper.reverse-outline', 'external.method.reference'],
    suppressed_count: 1,
    status: 'delivery-ready',
  },
  writing: { outline_id: 'outline_method_12', blocking_count: 1, stale: true, reason_codes: ['tex_hash_changed'] },
  topology: {
    assurance_audit_count: 3, latest_audit_id: 'audit_claim_evidence',
    research_node_count: 9, research_edge_count: 12,
  },
  next_recommendation: { code: 'review_writing', label_key: 'methodology.next.reviewWriting' },
}

afterEach(() => { setLocale('zh') })

describe('compact methodology projection model', () => {
  it('uses the one project-scoped compact GET and encodes the project id', () => {
    expect(methodologyProjectionPath('rsp/a b')).toBe('/v2/projects/rsp%2Fa%20b/methodology')
  })

  it('projects Overview Assurance, Protocol, Synthesis and Knowledge in Chinese', () => {
    setLocale('zh')
    const model = methodologyProjectionModel(fullProjection, 'overview')

    expect(model.title).toBe('研究方法摘要')
    expect(model.rows.map(row => [row.key, row.label, row.value, row.tone])).toEqual([
      ['assurance', '保证审查', '投稿级 · 未就绪 · citation_missing', 'blocking'],
      ['protocol', '研究协议', 'protocol_confirmatory_2 · rev 2 · 已冻结 · 验证性', 'ok'],
      ['synthesis', '研究综合', 'synthesis_4 · 已过期 · project_revision_changed', 'warning'],
      ['knowledge', '知识激活', '2 个已激活 · scholar.paper.reverse-outline, external.method.reference · 当前会话可投递', 'ok'],
    ])
    expect(model.recommendation).toEqual({
      code: 'review_writing',
      label: '检查 Reverse Outline 与阻断项',
    })
  })

  it('projects manuscript and topology summaries in English without translating wire ids', () => {
    setLocale('en')
    const manuscript = methodologyProjectionModel(fullProjection, 'manuscript')
    expect(manuscript.rows.map(row => [row.key, row.label, row.value])).toEqual([
      ['writing', 'Reverse Outline / Review Findings', 'outline_method_12 · 1 blocking · stale · tex_hash_changed'],
      ['assurance', 'Assurance', 'submission · Not ready · citation_missing'],
    ])

    const topology = methodologyProjectionModel(fullProjection, 'topology')
    expect(topology.rows.map(row => [row.key, row.label, row.value])).toEqual([
      ['topology', 'Assurance topology', '3 audits · latest audit_claim_evidence · research graph 9 nodes / 12 edges'],
      ['knowledge', 'Knowledge activation', '2 active · scholar.paper.reverse-outline, external.method.reference · ready for this session'],
    ])
    expect(manuscript.rows[0]?.value).toContain('outline_method_12')
  })

  it('fails soft on missing, null and malformed optional fields', () => {
    setLocale('en')
    expect(() => methodologyProjectionModel({
      project_id: 'rsp_partial',
      revision: 1,
      assurance: null,
      protocol: null,
      synthesis: null,
      knowledge: { active_count: Number.NaN, package_names: ['valid', 1] as unknown as string[] },
      writing: null,
      topology: null,
      next_recommendation: { code: '', label_key: 'untrusted.dynamic.key' },
    }, 'overview')).not.toThrow()

    const model = methodologyProjectionModel({}, 'overview')
    expect(model.rows.map(row => row.value)).toEqual([
      'Unavailable',
      'No frozen protocol',
      'No synthesis',
      '0 active',
    ])
    expect(model.recommendation).toBeNull()
    expect(methodologyProjectionModel(null, 'overview').unavailable).toBe(true)
  })

  it('displays only the Kernel-issued Direction recommendation and never infers one from an untrusted label key', () => {
    setLocale('en')
    expect(methodologyProjectionModel({
      ...fullProjection,
      next_recommendation: { code: 'direction_pivot_intake', label_key: 'methodology.next.directionPivotIntake' },
    }, 'overview').recommendation).toEqual({
      code: 'direction_pivot_intake', label: 'Propose the adopted pivot through Intake',
    })
    expect(methodologyProjectionModel({
      ...fullProjection,
      next_recommendation: { code: 'direction_pivot_intake', label_key: 'methodology.next.runSynthesis' },
    }, 'overview').recommendation).toBeNull()
  })

  it('keeps the new methodology locale namespace in zh/en parity', () => {
    expect(assertLocaleParity()).toBeUndefined()
  })
})
