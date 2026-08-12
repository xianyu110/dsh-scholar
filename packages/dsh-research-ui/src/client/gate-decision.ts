import type { ApiErrorEnvelope } from './api'

export function gateDecisionRequest(
  gateId: string,
  decision: 'approved' | 'rejected' | 'revised',
  reason?: string,
): { path: string; init: RequestInit } {
  return {
    path: `/bff/research/gates/${encodeURIComponent(gateId)}/decision`,
    init: {
      method: 'POST',
      body: JSON.stringify({
        decision,
        ...(reason !== undefined && reason !== '' ? { reason } : {}),
      }),
    },
  }
}

export function gateDecisionErrorKey(error: ApiErrorEnvelope, status: number): string {
  if (error.code === 'network_error' || status === 0) return 'overview.gateFailureNetwork'
  if (error.code === 'unauthorized' || error.code === 'principal_required' || status === 401) return 'overview.gateFailureIdentity'
  if (error.code === 'role_forbidden' || status === 403) return 'overview.gateFailureRole'
  if (error.code === 'project_not_found' || error.code === 'gate_not_found' || status === 404) return 'overview.gateFailureNotFound'
  if (error.code === 'gate_already_decided' || error.code === 'revision_conflict'
    || error.code === 'gate_state_mismatch' || status === 409) return 'overview.gateFailureConflict'
  if (error.code === 'validation_error' || status === 400 || status === 422) return 'overview.gateFailureValidation'
  return 'overview.gateFailureCode'
}
