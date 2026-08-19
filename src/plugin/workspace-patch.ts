/**
 * Project-scoped unified-diff application.
 *
 * Git is the only patch parser and applier. The patch is checked and applied
 * inside an internally-created temporary directory; user input can never
 * choose a host path. Workspace contents still cross the Kernel API boundary
 * with version/etag CAS, so project membership and concurrent edits remain
 * authoritative in the Kernel.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { TextDecoder } from 'node:util'
import type { WorkspaceNode } from '@dsh-scholar/research-schemas'

const MAX_PATCH_BYTES = 1024 * 1024
const MAX_GIT_OUTPUT_BYTES = 64 * 1024
const GIT_APPLY_TIMEOUT_MS = 10_000
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

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

class GitApplyError extends Error {}

function normalizedWorkspacePath(value: string): string {
  if (
    value === ''
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes('\0')
    || value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`patch path must be a normalized workspace-relative path: ${value}`)
  }
  return value
}

async function runGitApply(cwd: string, args: string[], patch: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', ['apply', '--no-unsafe-paths', ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timeout: NodeJS.Timeout | undefined

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      child.kill()
      reject(error)
    }
    timeout = setTimeout(() => fail(new Error('git apply exceeded the execution time limit')), GIT_APPLY_TIMEOUT_MS)
    timeout.unref()
    child.on('error', error => fail(new Error(`unable to run git apply: ${error.message}`)))
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) {
        fail(new Error('git apply output exceeds the safety limit'))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > MAX_GIT_OUTPUT_BYTES) {
        fail(new Error('git apply diagnostic exceeds the safety limit'))
        return
      }
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      if (code !== 0) {
        const phase = args.includes('--numstat') ? 'parse' : args.includes('--check') ? 'check' : 'apply'
        reject(new GitApplyError(`git apply ${phase} rejected the patch`))
        return
      }
      resolve(Buffer.concat(stdout))
    })
    child.stdin.on('error', error => fail(new Error(`unable to send patch to git apply: ${error.message}`)))
    child.stdin.end(patch, 'utf8')
  })
}

interface GitNumstat {
  path: string
  added: number
  deleted: number
}

function parseGitNumstat(output: Buffer): GitNumstat {
  let text: string
  try {
    text = utf8Decoder.decode(output)
  } catch {
    throw new Error('patch path must be valid UTF-8')
  }
  const fields = text.split('\0')
  if (fields.at(-1) === '') fields.pop()
  if (fields.length !== 1) {
    if (fields[0]?.match(/^(?:\d+|-)\t(?:\d+|-)\t$/)) {
      throw new Error('rename/copy patches must use the Workspace move operation')
    }
    throw new Error('patch_apply accepts exactly one file patch per call')
  }
  const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(fields[0] ?? '')
  if (!match) throw new Error('patch_apply requires exactly one valid text file patch')
  if (match[1] === '-' || match[2] === '-') throw new Error('patch_apply does not accept binary patches')
  const added = Number(match[1])
  const deleted = Number(match[2])
  if (added + deleted === 0) {
    throw new Error('patch_apply rejects rename/copy and mode-only patches; a text hunk is required')
  }
  return { path: normalizedWorkspacePath(match[3]!), added, deleted }
}

function validateGitSummary(output: Buffer): void {
  let summary: string
  try {
    summary = utf8Decoder.decode(output)
  } catch {
    throw new Error('git apply summary must be valid UTF-8')
  }
  for (const line of summary.split('\n').filter(Boolean)) {
    if (/^ (?:rename|copy) /.test(line)) {
      throw new Error('rename/copy patches must use the Workspace move operation')
    }
    // Workspace nodes have no executable, symlink, gitlink or arbitrary mode
    // surface. Only ordinary text-file create/delete metadata is representable.
    if (!/^ (?:create|delete) mode 100644 /.test(line)) {
      throw new Error('patch_apply only supports regular non-executable text files')
    }
  }
}

async function materializeExisting(root: string, path: string, existing: WorkspaceNode): Promise<void> {
  if (existing.binary === true || typeof existing.content !== 'string') {
    throw new Error(`patch_apply only supports text workspace nodes: ${path}`)
  }
  const target = join(root, ...path.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, existing.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
}

async function readPatchedText(root: string, path: string): Promise<string | null> {
  const target = join(root, ...path.split('/'))
  let stats
  try {
    stats = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`patch_apply only supports regular text workspace nodes: ${path}`)
  }
  const content = await readFile(target)
  try {
    return utf8Decoder.decode(content)
  } catch {
    throw new Error(`patch_apply output must be valid UTF-8 text: ${path}`)
  }
}

export async function applyWorkspacePatch(
  client: WorkspacePatchClient,
  projectId: string,
  workspaceId: string,
  patch: string,
): Promise<WorkspacePatchResult> {
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    throw new Error(`patch exceeds the ${MAX_PATCH_BYTES} byte limit`)
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-scholar-patch-'))
  try {
    // -p0 preserves the submitted pathname so absolute/traversal paths cannot
    // be made to look relative by Git's normal a/ and b/ prefix stripping.
    const raw = parseGitNumstat(await runGitApply(root, ['--numstat', '-z', '-p0'], patch))
    const parsed = parseGitNumstat(await runGitApply(root, ['--numstat', '-z'], patch))
    if (raw.added !== parsed.added || raw.deleted !== parsed.deleted) {
      throw new Error('git apply produced inconsistent patch metadata')
    }
    validateGitSummary(await runGitApply(root, ['--summary'], patch))
    const path = parsed.path
    let existing: WorkspaceNode | null = null
    try {
      // A patch that checks against an empty private directory is a creation.
      await runGitApply(root, ['--check', '--whitespace=nowarn'], patch)
    } catch (error) {
      if (!(error instanceof GitApplyError)) throw error
      existing = await client.readWorkspaceNode(projectId, workspaceId, path)
      await materializeExisting(root, path, existing)
      try {
        await runGitApply(root, ['--check', '--whitespace=nowarn'], patch)
      } catch (retryError) {
        if (retryError instanceof GitApplyError) {
          throw new Error(`patch context does not match the current workspace node: ${path}`)
        }
        throw retryError
      }
    }

    // The check and apply use the same private tree, fixed argv and stdin patch.
    await runGitApply(root, ['--whitespace=nowarn'], patch)
    const content = await readPatchedText(root, path)
    if (content === null) {
      if (existing === null) throw new Error(`cannot delete missing workspace node: ${path}`)
      await client.deleteWorkspaceNode(projectId, workspaceId, path, {
        version: existing.version,
        etag: existing.etag,
      })
      return { path, operation: 'delete', version: null }
    }

    const written = await client.writeWorkspaceNode(projectId, workspaceId, {
      path,
      content,
      expected_version: existing?.version ?? 0,
      expected_etag: existing?.etag,
    })
    return { path, operation: existing === null ? 'create' : 'write', version: written.version }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
