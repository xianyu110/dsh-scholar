/**
 * P0-4 (hardening-v0.2-status.md §5 SNAPSHOT-01/API-01): the code-snapshot
 * archive root is restricted to an APPROVED project workspace.
 *
 *   - snapshot-root-workspace-only    POST code-snapshots resolves the root
 *                                     server-side from the workspace store;
 *                                     a caller-supplied host path is not
 *                                     accepted anywhere
 *   - snapshot-root-cross-project     a workspace of ANOTHER project is
 *                                     indistinguishable from a missing one
 *                                     (404-shaped workspace_not_found)
 *   - snapshot-root-path-traversal    absolute paths, `..`, Windows drive
 *                                     prefixes and NUL bytes in
 *                                     root_relative_path are rejected
 *   - snapshot-root-symlink-escape    symlinks escaping the root (and a
 *                                     workspace dir replaced by a symlink)
 *                                     are rejected with 422
 *   - snapshot-secret-files           `.env`/tokens/keys/credentials are
 *                                     NEVER archived — 422 with the file
 *                                     list and zero CAS/artifact writes
 *   - snapshot-relative-subdir        a root-relative subdirectory archives
 *                                     with keys relative to that root
 *   - snapshot-limits-retained        SNAPSHOT_MAX_FILES / MAX_FILE_BYTES /
 *                                     MAX_TOTAL_BYTES still apply to the
 *                                     workspace walk
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KernelError, ResearchKernel } from '@dsh-scholar/research-kernel'
import { WorkspaceError } from '../../packages/research-kernel/lib/workspace-store.js'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-snap-root-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

/** Create a disk `code` workspace for the project and write files into it. */
function seedWorkspace(kernel: ResearchKernel, projectId: string, files: Record<string, string>): string {
  const info = kernel.workspaceEnsure(projectId, 'code', 'fixture')
  for (const [rel, content] of Object.entries(files)) {
    kernel.workspaceWrite(info.workspace_id, rel, content)
  }
  return info.workspace_id
}

/** Assert a WorkspaceError with an exact code. */
function expectWorkspaceError(fn: () => unknown, code: string): void {
  try {
    fn()
    throw new Error('expected WorkspaceError to be thrown')
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError)
    expect((error as WorkspaceError).code).toBe(code)
  }
}

describe('P0-4 code-snapshot root = approved project workspace (SNAPSHOT-01/API-01)', () => {
  it('archives the WHOLE workspace root and a root-relative subdirectory', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const ws = seedWorkspace(kernel, project.project_id, {
      'train.js': 'console.log("top")\n',
      'src/lib/util.js': 'export const u = 1\n',
      'src/main.js': 'console.log("main")\n',
    })

    // root_relative_path '' (default) = the whole workspace.
    const whole = kernel.snapshotCodeArchive(project.project_id, ws, '', 'whole workspace')
    expect(whole.files).toBe(3)
    expect(whole.sha256).toBe(whole.archive_artifact_id.replace('sha256:', ''))
    const archive = JSON.parse(kernel.cas.read(whole.sha256).toString('utf8')) as {
      files: Record<string, { sha256: string; content_base64: string }>
    }
    expect(Object.keys(archive.files).sort()).toEqual(['src/lib/util.js', 'src/main.js', 'train.js'])
    expect(Buffer.from(archive.files['src/main.js']!.content_base64, 'base64').toString()).toBe('console.log("main")\n')

    // A root-relative subdirectory archives with keys relative to THAT root.
    const sub = kernel.snapshotCodeArchive(project.project_id, ws, 'src', 'subdir')
    expect(sub.files).toBe(2)
    const subArchive = JSON.parse(kernel.cas.read(sub.sha256).toString('utf8')) as {
      files: Record<string, { sha256: string; content_base64: string }>
    }
    expect(Object.keys(subArchive.files).sort()).toEqual(['lib/util.js', 'main.js'])
    // The registry row records the workspace binding, never a host path.
    const row = kernel.getCodeSnapshot(sub.snapshot_id)
    expect(row.source.workspace_id).toBe(ws)
    expect(row.source.root_relative_path).toBe('src')
    expect(row.source.root).toBe('~')
    expect(JSON.stringify(row)).not.toContain(kernel.workspaces.workspaceRoot(ws))
    kernel.close()
  })

  it('rejects a workspace of ANOTHER project (404-shaped workspace_not_found)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const other = kernel.createProject({ name: 'o', workspace: '/o', brief: makeBrief() })
    const foreignWs = seedWorkspace(kernel, other.project_id, { 'leak.js': 'x' })
    // The foreign workspace is indistinguishable from a missing one.
    expectWorkspaceError(
      () => kernel.snapshotCodeArchive(project.project_id, foreignWs, '', 'cross-project'),
      'workspace_not_found',
    )
    // A totally unknown workspace id is rejected the same way.
    expectWorkspaceError(
      () => kernel.snapshotCodeArchive(project.project_id, 'ws_does_not_exist', '', 'missing'),
      'workspace_not_found',
    )
    kernel.close()
  })

  it('rejects absolute paths, `..`, drive prefixes and NUL in root_relative_path', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const ws = seedWorkspace(kernel, project.project_id, { 'a.js': 'a' })
    const badPaths = [
      '/etc/passwd',           // absolute
      '..',                    // parent segment
      '../x',                  // parent segment
      'a/../../b',             // nested parent
      'C:evil',                // Windows drive prefix
      'c:\\evil',              // Windows drive prefix + backslash
      'a\u0000b',              // NUL byte
      'a//b',                  // empty segment
      'a/./b',                 // dot segment
      'a/',                    // trailing empty segment (after trim → 'a' is fine? no: 'a/'.replace(/\/+$/,'')='a')
    ]
    for (const bad of badPaths) {
      // 'a/' normalizes to 'a' (trailing slashes are trimmed and accepted).
      if (bad === 'a/') continue
      expectWorkspaceError(
        () => kernel.snapshotCodeArchive(project.project_id, ws, bad, 'traversal'),
        'invalid_path',
      )
    }
    // No artifacts were created by any rejected attempt.
    expect(kernel.listArtifacts(project.project_id)).toHaveLength(0)
    kernel.close()
  })

  it('accepts a trailing-slash root-relative path as the trimmed directory', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const ws = seedWorkspace(kernel, project.project_id, { 'src/a.js': 'a' })
    const snap = kernel.snapshotCodeArchive(project.project_id, ws, 'src/', 'trailing slash')
    expect(snap.files).toBe(1)
    kernel.close()
  })

  it('rejects symlink escape INSIDE the workspace and a workspace dir replaced by a symlink', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const ws = seedWorkspace(kernel, project.project_id, { 'ok.js': 'fine' })
    const outside = mkdtempSync(join(tmpdir(), 'dsh-snap-root-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'secret')

    // 1) A symlink planted inside the workspace pointing outside the root.
    symlinkSync(join(outside, 'secret.txt'), join(kernel.workspaces.workspaceRoot(ws), 'leak.txt'))
    try {
      kernel.snapshotCodeArchive(project.project_id, ws, '', 'escape')
      throw new Error('expected KernelError snapshot_path_escape')
    } catch (error) {
      expect(error).toBeInstanceOf(KernelError)
      expect((error as KernelError).status).toBe(422)
      expect((error as KernelError).code).toBe('snapshot_path_escape')
    }
    rmSync(join(kernel.workspaces.workspaceRoot(ws), 'leak.txt'))

    // 2) The workspace root dir itself replaced by a symlink: the resolved
    //    root escapes the workspaces area → 422 (realpath containment).
    const root = kernel.workspaces.workspaceRoot(ws)
    rmSync(root, { recursive: true })
    symlinkSync(outside, root)
    try {
      kernel.snapshotCodeArchive(project.project_id, ws, '', 'root symlink')
      throw new Error('expected KernelError snapshot_path_escape')
    } catch (error) {
      expect(error).toBeInstanceOf(KernelError)
      expect((error as KernelError).status).toBe(422)
      expect((error as KernelError).code).toBe('snapshot_path_escape')
    }
    // No artifacts from either rejected attempt.
    expect(kernel.listArtifacts(project.project_id)).toHaveLength(0)
    kernel.close()
  })

  it('rejects secret files with the full list and writes ZERO artifacts/CAS blobs', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const ws = seedWorkspace(kernel, project.project_id, {
      'src/train.js': 'console.log("ok")\n',
      '.env': 'DSH_SERVICE_TOKEN=super-secret',
      'config/github_token': 'ghp_secret',
      'keys/server.key': 'PRIVATE KEY',
      '.aws/credentials': '[default]\naws_secret_access_key = x',
      'id_rsa': 'PRIVATE KEY',
    })
    const casBefore = kernel.cas.list().length
    try {
      kernel.snapshotCodeArchive(project.project_id, ws, '', 'secret test')
      throw new Error('expected KernelError snapshot_secret_file')
    } catch (error) {
      expect(error).toBeInstanceOf(KernelError)
      const err = error as KernelError
      expect(err.status).toBe(422)
      expect(err.code).toBe('snapshot_secret_file')
      // The error lists EVERY offending file (not just the first).
      expect(err.message).toContain('.env')
      expect(err.message).toContain('config/github_token')
      expect(err.message).toContain('keys/server.key')
      expect(err.message).toContain('.aws/credentials')
      expect(err.message).toContain('id_rsa')
    }
    // Fail closed: no artifact rows, no manifest, no CAS blobs written.
    expect(kernel.listArtifacts(project.project_id)).toHaveLength(0)
    expect(kernel.cas.list().length).toBe(casBefore)
    kernel.close()
  })

  it('applies SNAPSHOT_MAX_FILES / MAX_TOTAL_BYTES to the workspace walk', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const ws = seedWorkspace(kernel, project.project_id, { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' })
    const savedFiles = ResearchKernel.SNAPSHOT_MAX_FILES
    const savedTotal = ResearchKernel.SNAPSHOT_MAX_TOTAL_BYTES
    try {
      ResearchKernel.SNAPSHOT_MAX_FILES = 2
      try {
        kernel.snapshotCodeArchive(project.project_id, ws, '', 'limit')
        throw new Error('expected snapshot_too_large')
      } catch (error) {
        expect((error as KernelError).code).toBe('snapshot_too_large')
        expect((error as KernelError).message).toContain('max_files=2')
      }
      ResearchKernel.SNAPSHOT_MAX_FILES = savedFiles
      ResearchKernel.SNAPSHOT_MAX_TOTAL_BYTES = 3
      kernel.workspaceWrite(ws, 'a.js', 'aa')
      kernel.workspaceWrite(ws, 'b.js', 'bb')
      kernel.workspaceWrite(ws, 'c.js', 'cc')
      try {
        kernel.snapshotCodeArchive(project.project_id, ws, '', 'limit')
        throw new Error('expected snapshot_too_large')
      } catch (error) {
        expect((error as KernelError).code).toBe('snapshot_too_large')
        expect((error as KernelError).message).toContain('max_total_bytes=3')
      }
    } finally {
      ResearchKernel.SNAPSHOT_MAX_FILES = savedFiles
      ResearchKernel.SNAPSHOT_MAX_TOTAL_BYTES = savedTotal
    }
    kernel.close()
  })

  it('archives content byte-identically (sha256 of the archive matches the artifact)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const content = 'export const answer = 42\n'
    const ws = seedWorkspace(kernel, project.project_id, { 'answer.js': content })
    const snap = kernel.snapshotCodeArchive(project.project_id, ws, '', 'byte-identical')
    const archive = JSON.parse(kernel.cas.read(snap.sha256).toString('utf8')) as {
      files: Record<string, { sha256: string; content_base64: string }>
    }
    expect(archive.files['answer.js']!.sha256).toBe(createHash('sha256').update(content).digest('hex'))
    expect(Buffer.from(archive.files['answer.js']!.content_base64, 'base64').toString()).toBe(content)
    kernel.close()
  })
})
