/**
 * Read-only browser view model for the project-scoped Research Graph.
 *
 * The Kernel projection remains authoritative. This module validates the
 * wire scope and references, localizes chrome, and applies display filters;
 * it never derives graph facts or exposes mutations.
 */
import { t } from './i18n/index'
import type { CompactMethodologyProjection, MethodologyTone } from './methodology-projection'
import { el } from './ui'

export const RESEARCH_GRAPH_NODE_KINDS = [
  'protocol', 'synthesis', 'direction', 'adoption', 'artifact', 'claim', 'contract',
  'corpus-snapshot', 'decision', 'evidence', 'run', 'code', 'data', 'environment',
] as const

export type ResearchGraphNodeKind = typeof RESEARCH_GRAPH_NODE_KINDS[number]
export type ResearchGraphFilter = 'all' | ResearchGraphNodeKind
export type ResearchGraphEdgeKind = 'pins' | 'input_to' | 'supports_statement_in' | 'inferred_for' | 'proposes' | 'decides'
export type ResearchGraphProvenance = 'explicit' | 'inferred'

export interface ResearchGraphNode {
  id: string
  kind: ResearchGraphNodeKind
  ref: string
  revision: number | null
  sha256: string | null
}

export interface ResearchGraphEdge {
  id: string
  from: string
  to: string
  kind: ResearchGraphEdgeKind
  provenance: ResearchGraphProvenance
}

export interface ResearchGraphProjection {
  project_id: string
  nodes: ResearchGraphNode[]
  edges: ResearchGraphEdge[]
}

export interface MethodologyGraphNodeView extends ResearchGraphNode {
  kindLabel: string
  statusText: string
  statusTone: MethodologyTone
}

export interface MethodologyGraphGroupView {
  kind: ResearchGraphNodeKind
  label: string
  nodes: MethodologyGraphNodeView[]
}

export interface MethodologyGraphEdgeView extends ResearchGraphEdge {
  kindLabel: string
  provenanceLabel: string
  source: string
  target: string
}

export interface MethodologyGraphModel {
  title: string
  groups: MethodologyGraphGroupView[]
  edges: MethodologyGraphEdgeView[]
  filterOptions: Array<{ value: ResearchGraphFilter; label: string }>
  selectedFilter: ResearchGraphFilter
  nodeCount: number
  edgeCount: number
  unavailableReason: null | 'project_mismatch' | 'invalid_graph'
}

export type MethodologyGraphLoadState = 'idle' | 'loading' | 'ready' | 'error'

const NODE_KIND_SET = new Set<string>(RESEARCH_GRAPH_NODE_KINDS)
const EDGE_KINDS = new Set<string>(['pins', 'input_to', 'supports_statement_in', 'inferred_for', 'proposes', 'decides'])
const PROVENANCE = new Set<string>(['explicit', 'inferred'])

export function methodologyGraphPath(projectId: string): string {
  return `/v2/projects/${encodeURIComponent(projectId)}/methodology/graph`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseNode(value: unknown): ResearchGraphNode | null {
  if (!isRecord(value)) return null
  const { id, kind, ref, revision, sha256 } = value
  if (typeof id !== 'string' || typeof kind !== 'string' || typeof ref !== 'string'
    || id === '' || ref === '' || !NODE_KIND_SET.has(kind)) return null
  if (id !== `${kind}:${ref}`) return null
  if (revision !== null && !(typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0)) return null
  if (sha256 !== null && !(typeof sha256 === 'string' && sha256 !== '')) return null
  return { id, kind: kind as ResearchGraphNodeKind, ref, revision, sha256 }
}

function parseEdge(value: unknown, nodeIds: ReadonlySet<string>): ResearchGraphEdge | null {
  if (!isRecord(value)) return null
  const { id, from, to, kind, provenance } = value
  if (typeof id !== 'string' || typeof from !== 'string' || typeof to !== 'string'
    || typeof kind !== 'string' || typeof provenance !== 'string'
    || !EDGE_KINDS.has(kind) || !PROVENANCE.has(provenance)
    || !nodeIds.has(from) || !nodeIds.has(to)) return null
  if (id !== `${kind}:${provenance}:${from}->${to}`) return null
  return {
    id, from, to,
    kind: kind as ResearchGraphEdgeKind,
    provenance: provenance as ResearchGraphProvenance,
  }
}

function parseProjection(raw: unknown): ResearchGraphProjection | null {
  if (!isRecord(raw) || typeof raw.project_id !== 'string'
    || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null
  const nodes: ResearchGraphNode[] = []
  const nodeIds = new Set<string>()
  for (const rawNode of raw.nodes) {
    const node = parseNode(rawNode)
    if (node === null || nodeIds.has(node.id)) return null
    nodes.push(node)
    nodeIds.add(node.id)
  }
  const edges: ResearchGraphEdge[] = []
  const edgeIds = new Set<string>()
  for (const rawEdge of raw.edges) {
    const edge = parseEdge(rawEdge, nodeIds)
    if (edge === null || edgeIds.has(edge.id)) return null
    edges.push(edge)
    edgeIds.add(edge.id)
  }
  return { project_id: raw.project_id, nodes, edges }
}

function kindLabel(kind: ResearchGraphNodeKind): string {
  return t('methodology', `methodology.graph.kind.${kind}`)
}

function provenanceLabel(provenance: ResearchGraphProvenance): string {
  return provenance === 'explicit'
    ? t('methodology', 'methodology.graph.provenance.explicit')
    : t('methodology', 'methodology.graph.provenance.inferred')
}

function nodeStatus(
  node: ResearchGraphNode,
  compact: CompactMethodologyProjection | null,
): Pick<MethodologyGraphNodeView, 'statusText' | 'statusTone'> {
  if (compact !== null && node.kind === 'protocol' && compact.protocol?.current_id === node.ref) {
    if (compact.protocol.status === 'frozen') {
      return { statusText: t('methodology', 'methodology.graph.status.frozen'), statusTone: 'ok' }
    }
    if (compact.protocol.status === 'draft') {
      return { statusText: t('methodology', 'methodology.graph.status.draft'), statusTone: 'warning' }
    }
  }
  if (compact !== null && node.kind === 'synthesis' && compact.synthesis?.current_id === node.ref) {
    const reasons = Array.isArray(compact.synthesis.stale_reasons)
      ? compact.synthesis.stale_reasons.filter((reason): reason is string => typeof reason === 'string' && reason !== '')
      : []
    if (compact.synthesis.fresh === true) {
      return { statusText: t('methodology', 'methodology.graph.status.fresh'), statusTone: 'ok' }
    }
    if (compact.synthesis.fresh === false) {
      const stale = t('methodology', 'methodology.graph.status.stale')
      return { statusText: reasons.length === 0 ? stale : `${stale} · ${reasons.join(', ')}`, statusTone: 'warning' }
    }
  }
  return { statusText: t('methodology', 'methodology.graph.status.notProvided'), statusTone: 'neutral' }
}

function emptyModel(
  filter: ResearchGraphFilter,
  reason: Exclude<MethodologyGraphModel['unavailableReason'], null>,
): MethodologyGraphModel {
  return {
    title: t('methodology', 'methodology.graph.title'),
    groups: [], edges: [],
    filterOptions: [{ value: 'all', label: t('methodology', 'methodology.graph.filter.all') }],
    selectedFilter: filter,
    nodeCount: 0, edgeCount: 0,
    unavailableReason: reason,
  }
}

/**
 * Build the localized, filtered graph display. A project mismatch or invalid
 * reference fails closed and returns no nodes/edges.
 */
export function methodologyGraphModel(
  raw: unknown,
  compactRaw: CompactMethodologyProjection | null | undefined,
  expectedProjectId: string,
  filter: ResearchGraphFilter,
): MethodologyGraphModel {
  if (isRecord(raw) && typeof raw.project_id === 'string' && raw.project_id !== expectedProjectId) {
    return emptyModel(filter, 'project_mismatch')
  }
  const graph = parseProjection(raw)
  if (graph === null || graph.project_id !== expectedProjectId) return emptyModel(filter, 'invalid_graph')
  const compact = compactRaw?.project_id === expectedProjectId ? compactRaw : null
  const byId = new Map(graph.nodes.map(node => [node.id, node] as const))
  const kindsPresent = RESEARCH_GRAPH_NODE_KINDS.filter(kind => graph.nodes.some(node => node.kind === kind))
  const selected = filter === 'all' || kindsPresent.includes(filter) ? filter : 'all'
  const visibleNodes = selected === 'all' ? graph.nodes : graph.nodes.filter(node => node.kind === selected)
  const groups = RESEARCH_GRAPH_NODE_KINDS.flatMap(kind => {
    const nodes = visibleNodes
      .filter(node => node.kind === kind)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(node => ({ ...node, kindLabel: kindLabel(node.kind), ...nodeStatus(node, compact) }))
    return nodes.length === 0 ? [] : [{ kind, label: kindLabel(kind), nodes }]
  })
  const edges = graph.edges
    .filter(edge => selected === 'all' || byId.get(edge.from)?.kind === selected || byId.get(edge.to)?.kind === selected)
    .sort((left, right) => {
      const provenanceOrder = (left.provenance === 'explicit' ? 0 : 1) - (right.provenance === 'explicit' ? 0 : 1)
      return provenanceOrder !== 0 ? provenanceOrder : left.id.localeCompare(right.id)
    })
    .map(edge => {
      const source = byId.get(edge.from)!
      const target = byId.get(edge.to)!
      return {
        ...edge,
        kindLabel: t('methodology', `methodology.graph.edge.${edge.kind}`),
        provenanceLabel: provenanceLabel(edge.provenance),
        source: `${kindLabel(source.kind)} · ${source.ref}`,
        target: `${kindLabel(target.kind)} · ${target.ref}`,
      }
    })
  return {
    title: t('methodology', 'methodology.graph.title'),
    groups,
    edges,
    filterOptions: [
      { value: 'all', label: t('methodology', 'methodology.graph.filter.all') },
      ...kindsPresent.map(kind => ({ value: kind, label: kindLabel(kind) })),
    ],
    selectedFilter: selected,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    unavailableReason: null,
  }
}

function graphToneColor(tone: MethodologyTone): string {
  if (tone === 'ok') return 'var(--tone-green)'
  if (tone === 'warning') return 'var(--tone-amber)'
  if (tone === 'blocking') return 'var(--tone-red)'
  return 'var(--text-3)'
}

function shortHash(hash: string): string {
  return hash.length <= 22 ? hash : `${hash.slice(0, 19)}…`
}

function graphNodeCard(node: MethodologyGraphNodeView): HTMLElement {
  const card = el('article', 'methodology-graph-node')
  card.setAttribute('role', 'listitem')
  card.style.cssText = 'min-width:0;padding:7px 8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-2)'
  const top = el('div')
  top.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:6px;min-width:0'
  const ref = el('code', '', node.ref)
  ref.title = node.ref
  ref.style.cssText = 'min-width:0;overflow-wrap:anywhere;font:600 10.5px/1.45 ui-monospace,Menlo,monospace;color:var(--text)'
  const status = el('span', '', node.statusText)
  status.setAttribute('aria-label', `${t('methodology', 'methodology.graph.status')}: ${node.statusText}`)
  status.style.cssText = `flex-shrink:0;max-width:55%;overflow-wrap:anywhere;font-size:9.5px;color:${graphToneColor(node.statusTone)}`
  top.append(ref, status)
  card.appendChild(top)
  const metadata: string[] = []
  if (node.revision !== null) {
    metadata.push(t('methodology', 'methodology.graph.revision', { revision: String(node.revision) }))
  }
  if (node.sha256 !== null) metadata.push(shortHash(node.sha256))
  if (metadata.length > 0) {
    const meta = el('div', 'muted', metadata.join(' · '))
    meta.style.cssText = 'margin-top:3px;overflow-wrap:anywhere;font:9px/1.4 ui-monospace,Menlo,monospace'
    if (node.sha256 !== null) meta.title = `${t('methodology', 'methodology.graph.hash')}: ${node.sha256}`
    card.appendChild(meta)
  }
  return card
}

function graphEdgeCard(edge: MethodologyGraphEdgeView): HTMLElement {
  const card = el('li', 'methodology-graph-edge')
  card.style.cssText = 'list-style:none;min-width:0;padding:6px 8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-2)'
  const badges = el('div')
  badges.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px'
  const provenance = el('span', '', edge.provenanceLabel)
  provenance.dataset.provenance = edge.provenance
  provenance.style.cssText = edge.provenance === 'explicit'
    ? 'font:650 9.5px/1.5 ui-monospace,Menlo,monospace;color:var(--tone-green)'
    : 'font:650 9.5px/1.5 ui-monospace,Menlo,monospace;color:var(--tone-amber)'
  const kind = el('span', 'muted', edge.kindLabel)
  kind.style.cssText = 'font-size:9.5px'
  badges.append(provenance, kind)
  card.appendChild(badges)
  for (const [labelKey, value] of [
    ['methodology.graph.source', edge.source],
    ['methodology.graph.target', edge.target],
  ] as const) {
    const line = el('div')
    line.style.cssText = 'display:grid;grid-template-columns:minmax(42px,auto) minmax(0,1fr);gap:6px;font-size:10px;line-height:1.45'
    const label = el('span', 'muted', t('methodology', labelKey))
    const text = el('span', '', value)
    text.style.cssText = 'min-width:0;overflow-wrap:anywhere;color:var(--text)'
    line.append(label, text)
    card.appendChild(line)
  }
  return card
}

/** Assemble the compact graph inside an existing Topology surface. */
export function methodologyGraphSectionNode(
  raw: unknown,
  compact: CompactMethodologyProjection | null | undefined,
  expectedProjectId: string,
  filter: ResearchGraphFilter,
  onFilter: (next: ResearchGraphFilter) => void,
  loadState: MethodologyGraphLoadState = 'ready',
): HTMLElement {
  const section = el('section', 'methodology-graph')
  section.setAttribute('aria-label', t('methodology', 'methodology.graph.aria'))
  section.style.cssText = 'margin:8px 0 12px;padding:9px 10px;border:1px solid var(--border);border-radius:10px;background:var(--bg-3);min-width:0'
  const model = methodologyGraphModel(raw, compact, expectedProjectId, filter)
  const header = el('div')
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px'
  const heading = el('div', 'section-label', model.title)
  heading.style.cssText = 'margin:0'
  const counts = el('span', 'muted', `${model.nodeCount} ${t('methodology', 'methodology.graph.nodes')} · ${model.edgeCount} ${t('methodology', 'methodology.graph.edges')}`)
  counts.style.cssText = 'font-size:9.5px'
  header.append(heading, counts)
  section.appendChild(header)

  if ((loadState === 'idle' || loadState === 'loading') && raw == null) {
    section.appendChild(el('div', 'muted', t('methodology', 'methodology.graph.loading')))
    return section
  }
  if (loadState === 'error' || model.unavailableReason !== null) {
    const key = model.unavailableReason === 'project_mismatch'
      ? 'methodology.graph.projectMismatch'
      : 'methodology.graph.error'
    const error = el('div', 'error-banner', t('methodology', key))
    error.setAttribute('role', 'alert')
    section.appendChild(error)
    return section
  }

  const filterLabel = el('label')
  filterLabel.style.cssText = 'display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:8px;font-size:10px;color:var(--text-3)'
  filterLabel.appendChild(document.createTextNode(t('methodology', 'methodology.graph.filter')))
  const select = el('select', 'picker')
  select.setAttribute('aria-label', t('methodology', 'methodology.graph.filter'))
  select.style.cssText = 'width:auto;max-width:100%;min-height:28px;margin:0;padding:3px 25px 3px 8px;font-size:10px'
  for (const option of model.filterOptions) {
    const node = el('option', '', option.label)
    node.value = option.value
    node.selected = option.value === model.selectedFilter
    select.appendChild(node)
  }
  select.onchange = () => {
    const next = select.value
    if (next === 'all' || NODE_KIND_SET.has(next)) onFilter(next as ResearchGraphFilter)
  }
  filterLabel.appendChild(select)
  section.appendChild(filterLabel)

  if (model.nodeCount === 0) {
    section.appendChild(el('div', 'empty', t('methodology', 'methodology.graph.empty')))
    return section
  }
  if (model.groups.length === 0) {
    section.appendChild(el('div', 'empty', t('methodology', 'methodology.graph.emptyFiltered')))
  } else {
    const groups = el('div', 'methodology-graph-groups')
    groups.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:8px;min-width:0'
    for (const group of model.groups) {
      const wrapper = el('section')
      wrapper.dataset.nodeKind = group.kind
      wrapper.style.cssText = 'min-width:0'
      const groupHeading = el('h3', '', `${group.label} · ${group.nodes.length}`)
      groupHeading.style.cssText = 'margin:0 0 4px;font-size:10px;font-weight:650;color:var(--text-2)'
      const list = el('div')
      list.setAttribute('role', 'list')
      list.style.cssText = 'display:grid;gap:4px'
      for (const node of group.nodes) list.appendChild(graphNodeCard(node))
      wrapper.append(groupHeading, list)
      groups.appendChild(wrapper)
    }
    section.appendChild(groups)
  }

  const relations = el('section')
  relations.style.cssText = 'margin-top:9px;padding-top:8px;border-top:1px dashed var(--border-2)'
  const relationHeading = el('h3', '', t('methodology', 'methodology.graph.edges'))
  relationHeading.style.cssText = 'margin:0 0 5px;font-size:10px;font-weight:650;color:var(--text-2)'
  relations.appendChild(relationHeading)
  if (model.edges.length === 0) {
    relations.appendChild(el('div', 'muted', t('methodology', 'methodology.graph.edges.none')))
  } else {
    for (const provenance of ['explicit', 'inferred'] as const) {
      const edges = model.edges.filter(edge => edge.provenance === provenance)
      if (edges.length === 0) continue
      const provenanceHeading = el('h4', '', `${provenanceLabel(provenance)} · ${edges.length}`)
      provenanceHeading.style.cssText = 'margin:7px 0 4px;font-size:9.5px;font-weight:650;color:var(--text-3)'
      const list = el('ul')
      list.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:5px;margin:0;padding:0;min-width:0'
      for (const edge of edges) list.appendChild(graphEdgeCard(edge))
      relations.append(provenanceHeading, list)
    }
  }
  section.appendChild(relations)
  return section
}
