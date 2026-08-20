import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/client/i18n/index.js'
import {
  methodologyGraphModel,
  methodologyGraphPath,
  type ResearchGraphProjection,
} from '../../src/client/methodology-graph.js'
import type { CompactMethodologyProjection } from '../../src/client/methodology-projection.js'

const graph: ResearchGraphProjection = {
  project_id: 'rsp_graph_a',
  nodes: [
    { id: 'protocol:protocol_2', kind: 'protocol', ref: 'protocol_2', revision: 2, sha256: `sha256:${'a'.repeat(64)}` },
    { id: 'contract:contract_1', kind: 'contract', ref: 'contract_1', revision: null, sha256: `sha256:${'b'.repeat(64)}` },
    { id: 'synthesis:synth_4', kind: 'synthesis', ref: 'synth_4', revision: null, sha256: null },
    { id: 'evidence:evidence_1', kind: 'evidence', ref: 'evidence_1', revision: null, sha256: null },
    { id: 'run:run_1', kind: 'run', ref: 'run_1', revision: null, sha256: null },
    { id: 'direction:direction_1', kind: 'direction', ref: 'direction_1', revision: null, sha256: null },
    { id: 'adoption:adoption_1', kind: 'adoption', ref: 'adoption_1', revision: null, sha256: null },
    { id: 'decision:dec_1', kind: 'decision', ref: 'dec_1', revision: null, sha256: null },
  ],
  edges: [
    { id: 'pins:explicit:contract:contract_1->protocol:protocol_2', from: 'contract:contract_1', to: 'protocol:protocol_2', kind: 'pins', provenance: 'explicit' },
    { id: 'input_to:explicit:evidence:evidence_1->synthesis:synth_4', from: 'evidence:evidence_1', to: 'synthesis:synth_4', kind: 'input_to', provenance: 'explicit' },
    { id: 'inferred_for:inferred:run:run_1->synthesis:synth_4', from: 'run:run_1', to: 'synthesis:synth_4', kind: 'inferred_for', provenance: 'inferred' },
    { id: 'proposes:explicit:synthesis:synth_4->direction:direction_1', from: 'synthesis:synth_4', to: 'direction:direction_1', kind: 'proposes', provenance: 'explicit' },
    { id: 'decides:explicit:direction:direction_1->adoption:adoption_1', from: 'direction:direction_1', to: 'adoption:adoption_1', kind: 'decides', provenance: 'explicit' },
    { id: 'input_to:explicit:decision:dec_1->adoption:adoption_1', from: 'decision:dec_1', to: 'adoption:adoption_1', kind: 'input_to', provenance: 'explicit' },
  ],
}

const compact: CompactMethodologyProjection = {
  project_id: 'rsp_graph_a',
  protocol: { current_id: 'protocol_2', revision: 2, status: 'frozen', intent: 'confirmatory' },
  synthesis: { current_id: 'synth_4', fresh: false, stale_reasons: ['project_revision_changed'] },
}

afterEach(() => { setLocale('zh') })

describe('project-scoped Research Graph view model', () => {
  it('groups nodes and filters related edges while preserving provenance, endpoints and authority-backed status', () => {
    setLocale('zh')
    const all = methodologyGraphModel(graph, compact, 'rsp_graph_a', 'all')

    expect(all.unavailableReason).toBeNull()
    expect(all.groups.map(group => [group.kind, group.label, group.nodes.length])).toEqual([
      ['protocol', '研究协议', 1],
      ['synthesis', '研究综合', 1],
      ['direction', '研究方向', 1],
      ['adoption', '采纳记录', 1],
      ['contract', '实验合同', 1],
      ['decision', '人工决策', 1],
      ['evidence', '证据', 1],
      ['run', '运行', 1],
    ])
    expect(all.groups[0]?.nodes[0]?.statusText).toBe('已冻结')
    expect(all.groups[1]?.nodes[0]?.statusText).toBe('已过期 · project_revision_changed')
    expect(all.edges.map(edge => edge.provenance)).toEqual([
      'explicit', 'explicit', 'explicit', 'explicit', 'explicit', 'inferred',
    ])

    const synthesis = methodologyGraphModel(graph, compact, 'rsp_graph_a', 'synthesis')
    expect(synthesis.groups.map(group => group.kind)).toEqual(['synthesis'])
    expect(synthesis.edges.map(edge => [edge.provenanceLabel, edge.source, edge.target])).toEqual([
      ['显式', '证据 · evidence_1', '研究综合 · synth_4'],
      ['显式', '研究综合 · synth_4', '研究方向 · direction_1'],
      ['推断', '运行 · run_1', '研究综合 · synth_4'],
    ])
  })

  it('encodes the graph GET path and fails closed for cross-project or malformed projections', () => {
    expect(methodologyGraphPath('rsp/a b')).toBe('/v2/projects/rsp%2Fa%20b/methodology/graph')
    expect(methodologyGraphModel({ ...graph, project_id: 'rsp_other' }, compact, 'rsp_graph_a', 'all')).toMatchObject({
      groups: [], edges: [], unavailableReason: 'project_mismatch',
    })
    expect(methodologyGraphModel({ ...graph, edges: [{ ...graph.edges[0]!, from: 'run:foreign' }] }, compact, 'rsp_graph_a', 'all')).toMatchObject({
      groups: [], edges: [], unavailableReason: 'invalid_graph',
    })
  })

  it('localizes English graph chrome and never borrows status from another project compact projection', () => {
    setLocale('en')
    const model = methodologyGraphModel(graph, { ...compact, project_id: 'rsp_other' }, 'rsp_graph_a', 'protocol')
    expect(model.filterOptions[0]).toEqual({ value: 'all', label: 'All node types' })
    expect(model.groups[0]?.label).toBe('Protocol')
    expect(model.groups[0]?.nodes[0]?.statusText).toBe('Not provided by graph projection')
    expect(model.edges[0]).toMatchObject({
      kindLabel: 'pins', provenanceLabel: 'explicit',
      source: 'Contract · contract_1', target: 'Protocol · protocol_2',
    })
  })
})
