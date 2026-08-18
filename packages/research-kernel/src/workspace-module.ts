/**
 * Unified Workspace module over the generic disk store and TeX adapter.
 * Callers use one interface and never need to know which backend owns an id.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { WorkspaceInfo, WorkspaceKind, WorkspaceNode, WorkspaceRevision } from '@dsh-scholar/research-schemas'
import { texInfoToWorkspaceInfo, type TexWorkspaceFacade } from './tex-facade.js'
import {
  WorkspaceError,
  type WorkspaceContentSearchQuery,
  type WorkspaceContentSearchResult,
  type WorkspaceExpected,
  type WorkspaceIntegrityReport,
  type WorkspaceStore,
} from './workspace-store.js'

export class WorkspaceModule {
  constructor(
    private readonly db: DatabaseSync,
    private readonly generic: WorkspaceStore,
    private readonly tex: TexWorkspaceFacade,
    private readonly assertProject: (projectId: string) => void,
  ) {}

  private withBackend<T>(generic: () => T, tex: () => T): T {
    try {
      return generic()
    } catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'workspace_not_found') throw error
      return tex()
    }
  }

  resolve(workspaceId: string): WorkspaceInfo {
    return this.withBackend(
      () => this.generic.get(workspaceId),
      () => {
        try { return this.tex.get(workspaceId) } catch { throw new WorkspaceError('workspace_not_found', `workspace ${workspaceId} not found`) }
      },
    )
  }

  ensure(projectId: string, kind: WorkspaceKind, name: string): WorkspaceInfo {
    this.assertProject(projectId)
    return this.generic.ensure(projectId, kind, name)
  }

  get(workspaceId: string): WorkspaceInfo { return this.resolve(workspaceId) }
  tree(workspaceId: string): { info: WorkspaceInfo; nodes: WorkspaceNode[] } {
    return this.withBackend(() => this.generic.tree(workspaceId), () => this.tex.tree(workspaceId))
  }
  read(workspaceId: string, path: string): WorkspaceNode | null {
    return this.withBackend(
      () => { this.generic.get(workspaceId); return this.generic.read(workspaceId, path) },
      () => this.tex.read(workspaceId, path),
    )
  }
  write(workspaceId: string, path: string, content: string, expected?: WorkspaceExpected): WorkspaceNode {
    return this.withBackend(() => this.generic.write(workspaceId, path, content, expected), () => this.tex.write(workspaceId, path, content, expected))
  }
  writeBinary(workspaceId: string, path: string, bytes: Uint8Array, media: string, expected?: WorkspaceExpected): WorkspaceNode {
    return this.withBackend(() => this.generic.writeBinary(workspaceId, path, bytes, media, expected), () => this.tex.writeBinary(workspaceId, path, bytes, media, expected))
  }
  delete(workspaceId: string, path: string, expected?: WorkspaceExpected): void {
    this.withBackend(() => this.generic.deleteNode(workspaceId, path, expected), () => this.tex.deleteNode(workspaceId, path, expected))
  }
  move(workspaceId: string, fromPath: string, toPath: string, expected?: WorkspaceExpected): WorkspaceNode {
    return this.withBackend(() => this.generic.moveNode(workspaceId, fromPath, toPath, expected), () => this.tex.moveNode(workspaceId, fromPath, toPath, expected))
  }
  history(workspaceId: string): WorkspaceRevision[] {
    return this.withBackend(() => this.generic.history(workspaceId), () => this.tex.history(workspaceId))
  }
  blob(workspaceId: string, path: string): Buffer | null {
    return this.withBackend(
      () => { this.generic.get(workspaceId); return this.generic.blob(workspaceId, path) },
      () => this.tex.blob(workspaceId, path),
    )
  }
  list(projectId: string): WorkspaceInfo[] {
    this.assertProject(projectId)
    const generic = this.generic.listByProject(projectId)
    const docs = this.db.prepare('SELECT * FROM tex_documents WHERE project_id = ? ORDER BY created_at').all(projectId) as unknown as Array<{
      document_id: string; project_id: string; root_file: string; revision: number; created_at: string; updated_at: string
    }>
    return [...generic, ...docs.map(document => texInfoToWorkspaceInfo(document, document.root_file))]
  }
  assertInProject(workspaceId: string, projectId: string): void {
    if (this.resolve(workspaceId).project_id !== projectId) throw new WorkspaceError('workspace_not_found', `workspace ${workspaceId} not found`)
  }
  listSince(workspaceId: string, revision: number): { info: WorkspaceInfo; nodes: WorkspaceNode[]; deleted: string[] } {
    return this.withBackend(() => this.generic.listSince(workspaceId, revision), () => this.tex.listSince(workspaceId, revision))
  }
  search(workspaceId: string, query: { prefix?: string; glob?: string }): { info: WorkspaceInfo; nodes: WorkspaceNode[] } {
    return this.withBackend(() => this.generic.search(workspaceId, query), () => this.tex.search(workspaceId, query))
  }
  searchContent(workspaceId: string, query: WorkspaceContentSearchQuery): WorkspaceContentSearchResult {
    return this.withBackend(() => this.generic.searchContent(workspaceId, query), () => this.tex.searchContent(workspaceId, query))
  }
  readVersion(workspaceId: string, path: string, version: number): WorkspaceNode | null {
    return this.withBackend(
      () => { this.generic.get(workspaceId); return this.generic.readVersion(workspaceId, path, version) },
      () => this.tex.readVersion(workspaceId, path, version),
    )
  }
  scanIntegrity(workspaceId?: string): WorkspaceIntegrityReport[] { return this.generic.scanWorkspaceIntegrity(workspaceId) }
}
