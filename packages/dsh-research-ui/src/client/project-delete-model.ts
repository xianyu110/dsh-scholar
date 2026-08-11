export function canDeleteArchivedProject(
  status: string | undefined,
  projectName: string,
  confirmation: string,
  reason: string,
): boolean {
  return status === 'ARCHIVED' && confirmation === projectName && reason.trim() !== ''
}

export function projectDeleteRequest(
  projectId: string,
  expectedRevision: number,
  confirmName: string,
  reason: string,
  requestId: string,
): { path: string; init: RequestInit } {
  return {
    path: `/v1/projects/${encodeURIComponent(projectId)}`,
    init: {
      method: 'DELETE',
      headers: { 'x-request-id': requestId },
      body: JSON.stringify({ expected_revision: expectedRevision, confirm_name: confirmName, reason: reason.trim() }),
    },
  }
}
