/**
 * Project-scoped unified-diff application.
 *
 * The module never accepts a host path. It reads and CAS-writes exactly one
 * text node through the Kernel Workspace interface, so traversal, symlink,
 * project membership and concurrent-edit checks stay authoritative there.
 */
import { applyPatch, parsePatch, type StructuredPatch } from 'diff'
import type { WorkspaceNode } from '@dsh-scholar/research-schemas'

const MAX_PATCH_BYTES = 1024 * 1024
type GitStructuredPatch = StructuredPatch & { isBinary?: boolean; isRename?: boolean; isCopy?: boolean }

export interface WorkspacePatchClient {
  readWorkspaceNode(projectId: string, workspaceId: string, path: string): Promise<WorkspaceNode>
  writeWorkspaceNode(
    projectId: string,
    workspaceId: string,
    input: { path: string; content: string; expected_version?: number; expected_etag?: string },
  ): Promise<WorkspaceNode>
  deleteWorkspaceNode(
    projectId: string,
    workspaceId: string,
    path: string,
    expected?: { version?: number; etag?: string },
  ): Promise<{ ok: true }>
}

export interface WorkspacePatchResult {
  path: string
  operation: 'create' | 'write' | 'delete'
  version: number | null
}

function normalizedPatchPath(value: string | undefined, side: 'a' | 'b'): string | null {
  if (value === undefined || value === '') throw new Error(`patch is missing the ${side}/ file path`)
  if (value === '/dev/null') return null
  const candidate = value.startsWith(`${side}/`) ? value.slice(2) : value
  if (
    candidate === ''
    || candidate.startsWith('/')
    || candidate.includes('\\')
    || candidate.includes('\0')
    || candidate.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`patch path must be a normalized workspace-relative path: ${value}`)
  }
  return candidate
}

function parseSingleTextPatch(patch: string): { parsed: StructuredPatch; oldPath: string | null; newPath: string | null } {
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    throw new Error(`patch exceeds the ${MAX_PATCH_BYTES} byte limit`)
  }
  const parsed = parsePatch(patch)
  if (parsed.length !== 1) throw new Error('patch_apply accepts exactly one file patch per call')
  const file = parsed[0] as GitStructuredPatch
  if (file.isBinary === true || file.hunks.length === 0) throw new Error('patch_apply accepts text patches with at least one hunk')
  if (file.isRename === true || file.isCopy === true) throw new Error('rename/copy patches must use the Workspace move operation')
  const oldPath = normalizedPatchPath(file.oldFileName, 'a')
  const newPath = normalizedPatchPath(file.newFileName, 'b')
  if (oldPath === null && newPath === null) throw new Error('patch cannot use /dev/null on both sides')
  if (oldPath !== null && newPath !== null && oldPath !== newPath) {
    throw new Error('patch changes a file path; use the Workspace move operation first')
  }
  return { parsed: file, oldPath, newPath }
}

export async function applyWorkspacePatch(
  client: WorkspacePatchClient,
  projectId: string,
  workspaceId: string,
  patch: string,
): Promise<WorkspacePatchResult> {
  const { parsed, oldPath, newPath } = parseSingleTextPatch(patch)
  const path = newPath ?? oldPath as string
  const existing = oldPath === null ? null : await client.readWorkspaceNode(projectId, workspaceId, oldPath)
  if (existing?.binary === true || (existing !== null && typeof existing.content !== 'string')) {
    throw new Error(`patch_apply only supports text workspace nodes: ${path}`)
  }
  const next = applyPatch(existing?.content ?? '', parsed, { fuzzFactor: 0, autoConvertLineEndings: true })
  if (next === false) throw new Error(`patch context does not match the current workspace node: ${path}`)

  if (newPath === null) {
    if (existing === null) throw new Error(`cannot delete missing workspace node: ${path}`)
    await client.deleteWorkspaceNode(projectId, workspaceId, path, { version: existing.version, etag: existing.etag })
    return { path, operation: 'delete', version: null }
  }
  const written = await client.writeWorkspaceNode(projectId, workspaceId, {
    path,
    content: next,
    expected_version: existing?.version ?? 0,
    expected_etag: existing?.etag,
  })
  return { path, operation: existing === null ? 'create' : 'write', version: written.version }
}
