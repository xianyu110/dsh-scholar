/**
 * Deterministic, read-only Research Graph projection.
 *
 * The graph is rebuilt from already-authoritative or immutable methodology
 * records. It owns no state and cannot mutate Project, Gate, Evidence, Claim,
 * Job, Run or TeX objects.
 */
import type {
  DirectionAdoption,
  DirectionProposal,
  ProtocolRevision,
  ResearchSourceRef,
  ResearchSynthesis,
  ResearchSynthesisStatement,
  ResearchRunOutcome,
} from '@dsh-scholar/research-schemas'

export type ResearchGraphNodeKind =
  | 'protocol'
  | 'synthesis'
  | 'direction'
  | 'adoption'
  | 'artifact'
  | 'claim'
  | 'contract'
  | 'corpus-snapshot'
  | 'decision'
  | 'evidence'
  | 'run'
  | 'negative-finding'
  | 'claim-proposal'
  | 'code'
  | 'data'
  | 'environment'

export type ResearchGraphEdgeKind =
  | 'pins'
  | 'input_to'
  | 'supports_statement_in'
  | 'inferred_for'
  | 'proposes'
  | 'classifies_as'
  | 'decides'

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
  provenance: 'explicit' | 'inferred'
}

export interface ResearchGraphProjection {
  project_id: string
  nodes: ResearchGraphNode[]
  edges: ResearchGraphEdge[]
}

export interface ResearchGraphInput {
  project_id: string
  protocols: ProtocolRevision[]
  syntheses: ResearchSynthesis[]
  directions: DirectionProposal[]
  adoptions: DirectionAdoption[]
  run_outcomes: ResearchRunOutcome[]
}

function nodeId(kind: ResearchGraphNodeKind, ref: string): string {
  return `${kind}:${ref}`
}

function sourceKind(kind: ResearchSourceRef['kind']): ResearchGraphNodeKind {
  return kind
}

/** Build a stable graph without introducing a second persistence authority. */
export function buildResearchGraph(input: ResearchGraphInput): ResearchGraphProjection {
  const nodes = new Map<string, ResearchGraphNode>()
  const edges = new Map<string, ResearchGraphEdge>()

  const addNode = (
    kind: ResearchGraphNodeKind,
    ref: string,
    revision: number | null = null,
    sha256: string | null = null,
  ): string => {
    const id = nodeId(kind, ref)
    const existing = nodes.get(id)
    if (existing === undefined) {
      nodes.set(id, { id, kind, ref, revision, sha256 })
    } else if ((revision !== null && existing.revision !== null && revision !== existing.revision)
      || (sha256 !== null && existing.sha256 !== null && sha256 !== existing.sha256)) {
      throw new Error(`research_graph_ref_conflict:${id}`)
    } else {
      nodes.set(id, {
        ...existing,
        revision: existing.revision ?? revision,
        sha256: existing.sha256 ?? sha256,
      })
    }
    return id
  }

  const addEdge = (
    from: string,
    to: string,
    kind: ResearchGraphEdgeKind,
    provenance: ResearchGraphEdge['provenance'],
  ): void => {
    const id = `${kind}:${provenance}:${from}->${to}`
    if (!edges.has(id)) edges.set(id, { id, from, to, kind, provenance })
  }

  const addSource = (source: ResearchSourceRef): string => addNode(
    sourceKind(source.kind),
    source.id,
    source.revision ?? null,
    source.sha256 ?? null,
  )

  const connectStatement = (statement: ResearchSynthesisStatement, synthesisId: string): void => {
    for (const source of statement.source_refs) {
      addEdge(
        addSource(source),
        synthesisId,
        statement.provenance === 'explicit' ? 'supports_statement_in' : 'inferred_for',
        statement.provenance,
      )
    }
  }

  for (const protocol of input.protocols) {
    if (protocol.project_id !== input.project_id) throw new Error('research_graph_project_mismatch')
    const protocolId = addNode(
      'protocol', protocol.protocol_id, protocol.revision, protocol.canonical_hash ?? null,
    )
    for (const kind of ['contract', 'code', 'data', 'environment'] as const) {
      const pin = protocol.pins[kind]
      addEdge(addNode(kind, pin.ref, null, pin.sha256), protocolId, 'pins', 'explicit')
    }
  }

  for (const synthesis of input.syntheses) {
    if (synthesis.project_id !== input.project_id) throw new Error('research_graph_project_mismatch')
    const synthesisId = addNode('synthesis', synthesis.synthesis_id)
    const inputRefs: ReadonlyArray<readonly [ResearchGraphNodeKind, string]> = [
      ...synthesis.inputs.accepted_evidence_refs.map(ref => ['evidence', ref] as const),
      ...synthesis.inputs.verified_evidence_refs.map(ref => ['evidence', ref] as const),
      ...synthesis.inputs.run_refs.map(ref => ['run', ref] as const),
      ...synthesis.inputs.corpus_snapshot_refs.map(ref => ['corpus-snapshot', ref] as const),
    ]
    for (const [kind, ref] of inputRefs) addEdge(addNode(kind, ref), synthesisId, 'input_to', 'explicit')
    const statements = [
      ...synthesis.findings.supported,
      ...synthesis.findings.contradicted,
      ...synthesis.findings.negative,
      ...synthesis.findings.inconclusive,
      ...synthesis.findings.infrastructure_failures,
      ...synthesis.patterns,
      ...synthesis.open_questions,
      ...synthesis.constraints_learned,
    ]
    for (const statement of statements) connectStatement(statement, synthesisId)
  }

  for (const direction of input.directions) {
    if (direction.project_id !== input.project_id) throw new Error('research_graph_project_mismatch')
    const synthesisId = addNode('synthesis', direction.synthesis_id)
    const directionId = addNode('direction', direction.proposal_id)
    addEdge(synthesisId, directionId, 'proposes', 'explicit')
    for (const statement of direction.basis) connectStatement(statement, directionId)
  }

  for (const adoption of input.adoptions) {
    if (adoption.project_id !== input.project_id) throw new Error('research_graph_project_mismatch')
    const directionId = addNode('direction', adoption.proposal_id)
    const adoptionId = addNode('adoption', adoption.adoption_id)
    addEdge(directionId, adoptionId, 'decides', 'explicit')
    if (adoption.gate_decision_ref !== null) {
      addEdge(addNode('decision', adoption.gate_decision_ref), adoptionId, 'input_to', 'explicit')
    }
  }

  for (const outcome of input.run_outcomes) {
    const run = outcome.run
    if (run.project_id !== input.project_id) throw new Error('research_graph_project_mismatch')
    const runId = addNode('run', run.run_ref)
    if (run.protocol_pin !== null) {
      addEdge(
        addNode('protocol', run.protocol_pin.protocol_id, run.protocol_pin.revision, run.protocol_pin.canonical_hash),
        runId,
        'pins',
        'explicit',
      )
    }
    if (run.analysis_artifact_id !== null) {
      addEdge(addNode('artifact', run.analysis_artifact_id), runId, 'input_to', 'explicit')
    }
    for (const evidenceRef of run.evidence_refs) {
      addEdge(addNode('evidence', evidenceRef), runId, 'input_to', 'explicit')
    }
    const finding = outcome.negative_finding
    const proposal = outcome.claim_proposal
    if (finding !== null) {
      const findingId = addNode('negative-finding', finding.finding_id)
      addEdge(runId, findingId, 'classifies_as', 'explicit')
      if (proposal !== null) {
        addEdge(findingId, addNode('claim-proposal', proposal.proposal_id), 'proposes', 'explicit')
      }
    } else if (proposal !== null) {
      addEdge(runId, addNode('claim-proposal', proposal.proposal_id), 'proposes', 'explicit')
    }
  }

  return {
    project_id: input.project_id,
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
  }
}
