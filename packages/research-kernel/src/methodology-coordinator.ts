/**
 * Deep coordination boundary for Methodology runtime decisions.
 *
 * The coordinators own authority derivation, admission ordering, immutable
 * record construction and telemetry sequencing. ResearchKernel supplies only
 * narrow state/effect ports and remains the stable public façade.
 */
import {
  AssuranceAudit,
  KnowledgeActivationIntent,
  KnowledgeCapability,
  MethodTriadWrite,
  SectionGuideActivationWrite,
  WritingAssuranceExecutionInput,
  WritingPatchProposalWrite,
  WritingReviewerPanelWrite,
  randomId,
  type ArtifactRecord,
  type AssuranceSemanticReviewReceipt,
  type ChildExecutionIdentity,
  type Claim,
  type CorpusSnapshot,
  type EvidenceItem,
  type KnowledgeCapability as KnowledgeCapabilityValue,
  type NextAction,
  type ResearchProject,
  type SynthesisRecordRequest,
  type WritingCompilePin,
  type WritingInputPin,
} from '@dsh-scholar/research-schemas'
import { dispatchDeterministicAssuranceProducer } from './assurance.js'
import type { AssuranceStore } from './assurance-store.js'
import type { MethodologyStore } from './methodology-store.js'
import type { MethodologyTelemetry } from './methodology-telemetry.js'
import type { MethodologyRolloutStore } from './rollout-policy.js'
import { assertSynthesisRequestAdmission, SynthesisAdmissionError } from './synthesis-admission.js'
import type { WritingReviewStore } from './writing-review-store.js'
import {
  activateSectionGuide,
  aggregateWritingReviewerPanel,
  assessMethodTriad,
  writingFileSha256,
} from './writing-review.js'
import { writingClaimEvidenceSha256, writingTexSha256 } from './writing-methodology.js'

export type MethodologyFailure = (status: number, code: string, message: string) => never

type Transaction = <T>(work: () => T) => T

export interface KnowledgeMethodologyPorts {
  transaction: Transaction
  fail: MethodologyFailure
  getProject(projectId: string): Pick<ResearchProject, 'revision' | 'status'>
  getLinkedProjectId(sessionId: string): string | null
  getMemberRole(projectId: string, principalId: string): string | null
  getNextActions(projectId: string): readonly NextAction[]
  hasManuscript(projectId: string): boolean
  store: Pick<MethodologyStore, 'activateKnowledgePackage' | 'deactivateKnowledgePackage' | 'resolveKnowledgeDelivery'>
  rollout: Pick<MethodologyRolloutStore, 'projectPin' | 'consumptionPin'>
  telemetry: Pick<MethodologyTelemetry, 'knowledgeDeactivated' | 'knowledgeDelivery'>
}

export class KnowledgeMethodologyCoordinator {
  constructor(private readonly ports: KnowledgeMethodologyPorts) {}

  activate(input: {
    project_id: string
    session_id: string
    principal_id: string
  } & import('@dsh-scholar/research-schemas').KnowledgeActivationIntent): ReturnType<MethodologyStore['activateKnowledgePackage']> {
    const intent = KnowledgeActivationIntent.parse({
      package_name: input.package_name,
      package_version: input.package_version,
      manifest_sha256: input.manifest_sha256,
      payload_sha256: input.payload_sha256,
      explicit_human_activation: input.explicit_human_activation,
      expected_revision: input.expected_revision,
      expected_registry_revision: input.expected_registry_revision,
      expected_project_revision: input.expected_project_revision,
      expected_next_action_revision: input.expected_next_action_revision,
    })
    return this.ports.transaction(() => {
      const project = this.ports.getProject(input.project_id)
      if (this.ports.getLinkedProjectId(input.session_id) !== input.project_id) {
        return this.ports.fail(409, 'knowledge_activation_session_mismatch', 'activation session is not durably linked to this project')
      }
      const role = this.ports.getMemberRole(input.project_id, input.principal_id)
      if (role !== 'pi' && role !== 'operator') {
        return this.ports.fail(403, 'knowledge_activation_principal_forbidden', 'knowledge activation requires current PI or Operator membership')
      }
      if (project.revision !== intent.expected_project_revision) {
        return this.ports.fail(409, 'knowledge_activation_project_stale', 'project revision changed before knowledge activation')
      }
      const actions = this.ports.getNextActions(input.project_id)
      const currentAction = actions.find(action => action.state === 'ready')
        ?? actions.find(action => action.state !== 'done')
      const currentActionRevision = currentAction?.revision ?? project.revision
      if (currentActionRevision !== intent.expected_next_action_revision) {
        return this.ports.fail(409, 'knowledge_activation_next_action_stale', 'NextAction revision changed before knowledge activation')
      }

      const allCapabilities = [...KnowledgeCapability.options] as KnowledgeCapabilityValue[]
      const nextActionCapabilities: KnowledgeCapabilityValue[] = [
        'project:read-brief',
        'project:read-accepted-evidence',
      ]
      if (this.ports.hasManuscript(input.project_id)
        || ['WRITING', 'REVIEWING', 'RELEASE_READY', 'RELEASED'].includes(project.status)) {
        nextActionCapabilities.push('project:read-manuscript-snapshot')
      }
      if (currentAction !== undefined && ['manuscript_write', 'reviewer_run'].includes(currentAction.code)) {
        nextActionCapabilities.push('proposal:manuscript-patch', 'proposal:review-finding')
      }
      if (currentAction !== undefined && ['survey_run', 'idea_generate', 'synthesis_record'].includes(currentAction.code)) {
        nextActionCapabilities.push('knowledge:retrieve')
      }

      const rolloutPin = this.ports.rollout.projectPin(input.project_id)
      const activated = this.ports.store.activateKnowledgePackage({
        request: {
          project_id: input.project_id,
          session_id: input.session_id,
          package_name: intent.package_name,
          package_version: intent.package_version,
          manifest_sha256: intent.manifest_sha256,
          payload_sha256: intent.payload_sha256,
          phase: project.status,
          next_action_revision: currentActionRevision,
          explicit_human_activation: true,
          principal_capabilities: allCapabilities,
          next_action_capabilities: nextActionCapabilities,
          project_policy_capabilities: [...allCapabilities],
        },
        expected_revision: intent.expected_revision,
        expected_registry_revision: intent.expected_registry_revision,
      })
      const consumption = this.ports.rollout.consumptionPin(
        input.project_id,
        'knowledge-activation',
        activated.record.activation_id,
      )
      if (consumption.policy_revision !== rolloutPin.policy_revision
        || consumption.policy_hash !== rolloutPin.policy_hash
        || consumption.mode !== rolloutPin.mode) {
        return this.ports.fail(409, 'methodology_rollout_consumption_pin_invalid', 'Knowledge activation rollout pin does not match the project pin')
      }
      return activated
    })
  }

  deactivate(
    input: Parameters<MethodologyStore['deactivateKnowledgePackage']>[0],
  ): ReturnType<MethodologyStore['deactivateKnowledgePackage']> {
    const rolloutPin = this.ports.rollout.projectPin(input.request.project_id)
    const deactivated = this.ports.store.deactivateKnowledgePackage(input)
    this.ports.telemetry.knowledgeDeactivated(rolloutPin.mode)
    return deactivated
  }

  resolveDelivery(
    context: Parameters<MethodologyStore['resolveKnowledgeDelivery']>[0],
  ): ReturnType<MethodologyStore['resolveKnowledgeDelivery']> {
    const rolloutPin = this.ports.rollout.projectPin(context.project_id)
    const snapshot = this.ports.store.resolveKnowledgeDelivery(context)
    this.ports.telemetry.knowledgeDelivery(rolloutPin.mode, snapshot)
    return snapshot
  }
}

export interface SynthesisMethodologyPorts {
  fail: MethodologyFailure
  getProjectRevision(projectId: string): number
  getNextActions(projectId: string): readonly NextAction[]
  getPendingRequests(projectId: string): readonly SynthesisRecordRequest[]
  store: Pick<MethodologyStore, 'recordResearchSynthesis'>
  rollout: Pick<MethodologyRolloutStore, 'projectPin'>
  telemetry: Pick<MethodologyTelemetry, 'synthesisTrigger'>
}

export class SynthesisMethodologyCoordinator {
  constructor(private readonly ports: SynthesisMethodologyPorts) {}

  record(
    input: Parameters<MethodologyStore['recordResearchSynthesis']>[0] & { request_id: string },
  ): ReturnType<MethodologyStore['recordResearchSynthesis']> {
    try {
      assertSynthesisRequestAdmission({
        request_id: input.request_id,
        record: input.record,
        pending_requests: this.ports.getPendingRequests(input.record.project_id),
        current_project_revision: this.ports.getProjectRevision(input.record.project_id),
        current_actions: this.ports.getNextActions(input.record.project_id),
      })
    } catch (error) {
      if (error instanceof SynthesisAdmissionError) {
        return this.ports.fail(422, error.code, error.message)
      }
      throw error
    }
    const rolloutPin = this.ports.rollout.projectPin(input.record.project_id)
    const { request_id: _requestId, ...storeInput } = input
    const recorded = this.ports.store.recordResearchSynthesis(storeInput)
    this.ports.telemetry.synthesisTrigger({
      mode: rolloutPin.mode,
      triggered: true,
      reasons: input.record.generated_by === 'human' ? ['human_request'] : [],
    })
    return recorded
  }
}

interface ChildDetailView {
  project_id: string
  node: {
    parent_id: string | null
    kind: string
    mode: string
    state: string
    role: string | null
  }
}

export interface WritingMethodologyPorts {
  transaction: Transaction
  fail: MethodologyFailure
  now(): string
  getProject(projectId: string): Pick<ResearchProject, 'revision' | 'status' | 'brief'>
  getLinkedProjectId(sessionId: string): string | null
  getNextActions(projectId: string): readonly NextAction[]
  getChildDetail(childId: string): ChildDetailView
  getChildExecutionIdentity(childId: string): ChildExecutionIdentity | null
  listArtifacts(projectId: string): ArtifactRecord[]
  registerFindingsArtifact(input: {
    project_id: string
    content: string
    metadata: Record<string, unknown>
    file_name: string
  }): ArtifactRecord
  listClaims(projectId: string): Claim[]
  listAcceptedEvidence(projectId: string): EvidenceItem[]
  listCorpusSnapshots(projectId: string): CorpusSnapshot[]
  manuscriptChecks(projectId: string): Array<{ check: string; status: 'pass' | 'warn' | 'fail'; detail: string }>
  tex: {
    getDocument(documentId: string): { project_id: string; revision: number }
    tree(documentId: string): { files: Array<{ path: string; content_hash: string }> }
    listBuilds(documentId: string): Array<{
      build_id: string
      revision: number
      status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'superseded'
    }>
    readFile(documentId: string, path: string): { content: string } | null
  }
  methodology: Pick<MethodologyStore, 'listProtocolRevisions' | 'listReviewFindings'>
  assurance: Pick<AssuranceStore, 'list' | 'record'>
  writing: Pick<WritingReviewStore,
    'recordMethodTriad' | 'listMethodTriads' | 'recordSectionGuide' | 'recordReviewerPanel'
    | 'getReviewerPanel' | 'recordPatchProposal'>
  rollout: Pick<MethodologyRolloutStore, 'projectPin' | 'consumptionPin'>
  telemetry: Pick<MethodologyTelemetry, 'reviewer' | 'assuranceExecution'>
}

export class WritingMethodologyCoordinator {
  constructor(private readonly ports: WritingMethodologyPorts) {}

  currentInputPin(projectId: string, documentId: string): WritingInputPin {
    const document = this.ports.tex.getDocument(documentId)
    if (document.project_id !== projectId) {
      return this.ports.fail(422, 'writing_document_project_mismatch', `TeX document ${documentId} belongs to another project`)
    }
    const accepted = new Set(this.ports.listAcceptedEvidence(projectId).map(item => item.evidence_id))
    const claimBindings = this.ports.listClaims(projectId).map(claim => ({
      claim_ref: claim.claim_id,
      accepted_evidence_refs: claim.evidence.evidence_ids.filter(ref => accepted.has(ref)),
    }))
    return {
      project_id: projectId,
      document_id: documentId,
      document_revision: document.revision,
      tex_sha256: writingTexSha256(this.ports.tex.tree(documentId).files),
      claim_evidence_sha256: writingClaimEvidenceSha256(claimBindings),
    }
  }

  currentCompilePin(projectId: string, documentId: string): WritingCompilePin {
    const document = this.ports.tex.getDocument(documentId)
    if (document.project_id !== projectId) {
      return this.ports.fail(422, 'writing_document_project_mismatch', `TeX document ${documentId} belongs to another project`)
    }
    const latest = this.ports.tex.listBuilds(documentId)[0]
    return latest === undefined
      ? { latest_build_id: null, latest_build_revision: null, latest_build_status: null }
      : { latest_build_id: latest.build_id, latest_build_revision: latest.revision, latest_build_status: latest.status }
  }

  assertInputPin(expected: WritingInputPin): WritingInputPin {
    const current = this.currentInputPin(expected.project_id, expected.document_id)
    if (current.document_revision !== expected.document_revision
      || current.tex_sha256 !== expected.tex_sha256
      || current.claim_evidence_sha256 !== expected.claim_evidence_sha256) {
      return this.ports.fail(409, 'writing_input_stale', 'writing input revision or content hash no longer matches the current manuscript')
    }
    return current
  }

  assertCompilePin(projectId: string, documentId: string, expected: WritingCompilePin): WritingCompilePin {
    const current = this.currentCompilePin(projectId, documentId)
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      return this.ports.fail(409, 'writing_compile_generation_conflict', 'TeX compile generation changed after the proposal was reviewed')
    }
    return current
  }

  private assertSemanticReview(
    receipt: AssuranceSemanticReviewReceipt,
    projectId: string,
  ): 'unverified' | 'same-model' | 'same-family' | 'cross-family' {
    const project = this.ports.getProject(projectId)
    if (receipt.project_id !== projectId) {
      return this.ports.fail(422, 'semantic_review_project_mismatch', 'semantic review receipt belongs to another project')
    }
    if (receipt.project_revision !== project.revision) {
      return this.ports.fail(409, 'semantic_review_stale', 'semantic review receipt is bound to a stale project revision')
    }
    if (this.ports.getLinkedProjectId(receipt.session_id) !== projectId) {
      return this.ports.fail(422, 'semantic_review_session_mismatch', 'semantic review session is not linked to this project')
    }
    const action = this.ports.getNextActions(projectId).find(candidate => candidate.id === receipt.action_id)
    if (action === undefined || action.code !== 'reviewer_run' || action.revision !== receipt.action_revision || action.state !== 'ready') {
      return this.ports.fail(409, 'semantic_review_action_stale', 'semantic review receipt is not bound to the current ready reviewer action')
    }
    if (receipt.state === 'missing' || receipt.reviewers.length === 0) {
      if (receipt.failures.includes('semantic_reviewer_unavailable')) {
        return this.ports.fail(503, 'semantic_reviewer_unavailable', 'semantic reviewer provider is unavailable; no Assurance record was written')
      }
      return this.ports.fail(422, 'semantic_reviewer_required', 'semantic assurance requires at least one completed durable reviewer output')
    }
    const identities: ChildExecutionIdentity[] = []
    for (const reviewer of receipt.reviewers) {
      const detail = this.ports.getChildDetail(reviewer.child_id)
      if (detail.project_id !== projectId
        || detail.node.parent_id !== receipt.session_id
        || detail.node.kind !== 'subagent'
        || detail.node.mode !== 'one-shot'
        || detail.node.state !== 'succeeded'
        || (detail.node.role !== 'reviewer' && detail.node.role !== 'auditor')) {
        return this.ports.fail(422, 'semantic_reviewer_topology_invalid', `reviewer ${reviewer.child_id} is not a succeeded read-only reviewer child of the exact session`)
      }
      const identity = this.ports.getChildExecutionIdentity(reviewer.child_id)
      if (identity === null) {
        return this.ports.fail(422, 'semantic_reviewer_identity_missing', `reviewer ${reviewer.child_id} has no durable execution identity`)
      }
      identities.push(identity)
    }
    const models = new Set(identities.map(identity => `${identity.provider_ref}:${identity.model_ref}:${identity.config_hash}`))
    if (models.size === 1) return 'same-model'
    const families = new Set(identities.map(identity => `${identity.provider_ref}:${identity.family_ref}`))
    return families.size === 1 ? 'same-family' : 'cross-family'
  }

  recordMethodTriad(input: MethodTriadWrite) {
    const parsed = MethodTriadWrite.parse(input)
    this.ports.getProject(parsed.record.input_pin.project_id)
    this.assertInputPin(parsed.record.input_pin)
    const acceptedMeasurable = this.ports.listAcceptedEvidence(parsed.record.input_pin.project_id)
      .filter(item => Number.isFinite(item.result.value))
      .map(item => item.evidence_id)
    const diagnostic = assessMethodTriad(parsed.record, acceptedMeasurable)
    return this.ports.writing.recordMethodTriad(
      parsed.record.input_pin.project_id,
      { triad: parsed.record, diagnostic },
      parsed.expected_revision,
    )
  }

  recordSectionGuide(input: SectionGuideActivationWrite) {
    const parsed = SectionGuideActivationWrite.parse(input)
    const projectId = parsed.request.input_pin.project_id
    const project = this.ports.getProject(projectId)
    this.assertInputPin(parsed.request.input_pin)
    const latestTriad = this.ports.writing.listMethodTriads(projectId).records.at(-1)?.record
    const available: Array<'research_problem' | 'method_triad' | 'protocol' | 'accepted_evidence' | 'analysis' | 'limitations' | 'citations' | 'review_findings'> = []
    if (project.brief.problem.trim() !== '') available.push('research_problem')
    if (latestTriad?.diagnostic.status === 'ready'
      && JSON.stringify(latestTriad.triad.input_pin) === JSON.stringify(parsed.request.input_pin)) available.push('method_triad')
    if (this.ports.methodology.listProtocolRevisions(projectId).records.at(-1)?.record.status === 'frozen') available.push('protocol')
    if (this.ports.listAcceptedEvidence(projectId).length > 0) available.push('accepted_evidence')
    if (this.ports.listArtifacts(projectId).some(item => item.kind === 'analysis')) available.push('analysis')
    if (this.ports.listClaims(projectId).some(claim => claim.limitations.length > 0)) available.push('limitations')
    if (this.ports.listCorpusSnapshots(projectId).length > 0) available.push('citations')
    if (this.ports.methodology.listReviewFindings(projectId).records.length > 0
      || this.ports.assurance.list(projectId).audits.some(item => item.audit.audit_kind === 'writing')) available.push('review_findings')
    return this.ports.writing.recordSectionGuide(
      activateSectionGuide({ ...parsed.request, available_inputs: available }),
      parsed.expected_revision,
    )
  }

  recordReviewerPanel(input: WritingReviewerPanelWrite) {
    const parsed = WritingReviewerPanelWrite.parse(input)
    const rolloutPin = this.ports.rollout.projectPin(parsed.input_pin.project_id)
    this.assertInputPin(parsed.input_pin)
    this.assertSemanticReview(parsed.semantic_review, parsed.input_pin.project_id)
    const aggregate = aggregateWritingReviewerPanel({
      aggregate_id: parsed.aggregate_id,
      input_pin: parsed.input_pin,
      semantic_review: parsed.semantic_review,
      created_at: parsed.created_at,
    })
    const recorded = this.ports.writing.recordReviewerPanel(aggregate, parsed.expected_revision)
    this.ports.telemetry.reviewer({ mode: rolloutPin.mode, state: aggregate.state })
    return recorded
  }

  recordPatchProposal(input: WritingPatchProposalWrite) {
    const parsed = WritingPatchProposalWrite.parse(input)
    const proposal = parsed.record
    this.assertInputPin(proposal.input_pin)
    this.assertCompilePin(proposal.project_id, proposal.input_pin.document_id, proposal.compile_pin)
    const panel = this.ports.writing.getReviewerPanel(proposal.project_id, proposal.aggregate_id).record
    if (JSON.stringify(panel.input_pin) !== JSON.stringify(proposal.input_pin)) {
      return this.ports.fail(409, 'writing_reviewer_panel_stale', 'reviewer panel is bound to a different manuscript input')
    }
    const source = panel.roles.find(item => item.role === proposal.reviewer_role)
    if (source?.state !== 'complete' || source.child_id !== proposal.reviewer_child_id) {
      return this.ports.fail(422, 'writing_patch_reviewer_invalid', 'patch proposal must be bound to a completed reviewer role and exact child')
    }
    const currentFile = this.ports.tex.readFile(proposal.input_pin.document_id, proposal.file_path)
    if (currentFile === null || writingFileSha256(currentFile.content) !== proposal.expected_file_sha256) {
      return this.ports.fail(409, 'writing_patch_file_stale', 'patch proposal base file hash does not match the current TeX file')
    }
    if (writingFileSha256(proposal.replacement_content) !== proposal.replacement_sha256) {
      return this.ports.fail(422, 'writing_patch_hash_invalid', 'replacement_sha256 does not match replacement_content')
    }
    return this.ports.writing.recordPatchProposal(proposal, parsed.expected_revision)
  }

  runAssurance(input: WritingAssuranceExecutionInput): ReturnType<AssuranceStore['record']> {
    const parsed = WritingAssuranceExecutionInput.parse(input)
    const startedAt = performance.now()
    const rolloutPin = this.ports.rollout.projectPin(parsed.project_id)
    const project = this.ports.getProject(parsed.project_id)
    const target = this.ports.listArtifacts(parsed.project_id)
      .filter(artifact => artifact.kind === 'paper' || artifact.kind === 'tex-source')
      .at(-1)
    if (target === undefined) {
      return this.ports.fail(422, 'assurance_target_missing', 'writing assurance requires a registered paper or tex-source artifact')
    }
    const listed = this.ports.assurance.list(parsed.project_id)
    if (listed.revision !== parsed.expected_revision) {
      return this.ports.fail(409, 'assurance_revision_conflict', `project ${parsed.project_id} assurance revision ${listed.revision} does not match expected ${parsed.expected_revision}`)
    }
    const claims = this.ports.listClaims(parsed.project_id)
    const acceptedEvidence = new Set(this.ports.listAcceptedEvidence(parsed.project_id).map(item => item.evidence_id))
    const claimEvidenceHash = writingClaimEvidenceSha256(claims.map(claim => ({
      claim_ref: claim.claim_id,
      accepted_evidence_refs: claim.evidence.evidence_ids.filter(ref => acceptedEvidence.has(ref)),
    })))
    const deterministic = dispatchDeterministicAssuranceProducer({
      audit_kind: parsed.audit_kind,
      claim_count: claims.length,
      manuscript_checks: this.ports.manuscriptChecks(parsed.project_id),
    })
    const inputPins = [
      { ref: `artifact:${target.artifact_id}`, sha256: `sha256:${target.sha256}` as const },
      ...(parsed.audit_kind === 'claim-evidence'
        ? [{ ref: `claim-evidence:${parsed.project_id}`, sha256: claimEvidenceHash }]
        : []),
    ]
    let semantic: AssuranceSemanticReviewReceipt | null = null
    let semanticIndependence: 'unverified' | 'same-model' | 'same-family' | 'cross-family' = 'unverified'
    if (deterministic.applicability.applicable && parsed.mode === 'semantic') {
      semantic = parsed.semantic_review
      semanticIndependence = this.assertSemanticReview(semantic, parsed.project_id)
    }
    const hasFailure = deterministic.checks.some(check => check.status === 'fail')
    const hasWarning = deterministic.checks.some(check => check.status === 'warn')
    const verdict = !deterministic.applicability.applicable ? 'NOT_APPLICABLE'
      : hasFailure ? 'FAIL'
        : semantic?.state === 'partial' || hasWarning ? 'WARN'
          : 'PASS'
    const reasonCode = !deterministic.applicability.applicable ? 'claim_evidence_no_claims'
      : hasFailure ? semantic?.state === 'partial' ? 'deterministic_checks_failed_semantic_partial' : 'deterministic_checks_failed'
        : semantic?.state === 'partial' ? 'semantic_review_partial'
          : hasWarning ? 'deterministic_checks_warned'
            : semantic?.state === 'complete' ? 'semantic_review_complete' : 'deterministic_checks_passed'
    const auditId = randomId('audit')
    const createdAt = this.ports.now()
    const findings = {
      schema_version: 1,
      audit_id: auditId,
      project_id: parsed.project_id,
      project_revision: project.revision,
      audit_kind: parsed.audit_kind,
      target: { artifact_id: target.artifact_id, sha256: `sha256:${target.sha256}` },
      applicability: deterministic.applicability,
      input_pins: inputPins,
      deterministic: { producer: deterministic.producer, checks: deterministic.checks },
      semantic_review: semantic,
      semantic_independence: semanticIndependence,
      created_at: createdAt,
    }
    const currentAudit = listed.audits.filter(item => item.audit.audit_kind === parsed.audit_kind).at(-1)?.audit
    const recorded = this.ports.transaction(() => {
      const artifact = this.ports.registerFindingsArtifact({
        project_id: parsed.project_id,
        content: JSON.stringify(findings),
        metadata: {
          kind: 'assurance-findings', audit_kind: parsed.audit_kind, producer: deterministic.producer,
          target_artifact_id: target.artifact_id, target_project_revision: project.revision,
        },
        file_name: `${auditId}.json`,
      })
      const audit = AssuranceAudit.parse({
        audit_id: auditId,
        project_id: parsed.project_id,
        audit_kind: parsed.audit_kind,
        target_refs: [{ kind: 'artifact', id: target.artifact_id, revision: project.revision }],
        assurance_level: 'draft',
        execution: { status: 'succeeded', run_ref: semantic?.panel_id ?? auditId },
        verdict,
        reason_code: reasonCode,
        findings_artifact_id: artifact.artifact_id,
        input_pins: inputPins,
        review: semantic === null
          ? { method: 'deterministic', independence: 'deterministic', executor_ref: deterministic.producer }
          : {
              method: 'semantic', independence: semanticIndependence, executor_ref: deterministic.producer,
              reviewer_ref: semantic.panel_id,
              ...(semantic.reviewers[0] === undefined ? {} : { topology_node_id: semantic.reviewers[0].child_id }),
            },
        acceptance_status: !deterministic.applicability.applicable || semantic !== null ? 'provisional' : 'pending',
        created_at: createdAt,
        ...(currentAudit === undefined ? {} : { supersedes: currentAudit.audit_id }),
      })
      return this.ports.assurance.record({ audit, expected_revision: parsed.expected_revision })
    })
    this.ports.rollout.consumptionPin(parsed.project_id, 'assurance-execution', recorded.audit.audit_id)
    this.ports.telemetry.assuranceExecution({
      mode: rolloutPin.mode,
      audit_kind: recorded.audit.audit_kind,
      execution_status: recorded.audit.execution.status,
      verdict: recorded.audit.verdict,
      duration_ms: performance.now() - startedAt,
    })
    if (parsed.mode === 'semantic') {
      this.ports.telemetry.reviewer({ mode: rolloutPin.mode, state: parsed.semantic_review.state })
    }
    return recorded
  }
}
