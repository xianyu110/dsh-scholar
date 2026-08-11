/**
 * WORK-01 §5 P2 (hardening-v0.2-status.md §5, storage-migrations.md §10.1):
 * crash-recovery protocol for the disk-backed workspace store.
 *
 * The write/move/delete path is TWO commits on TWO media: the atomic disk
 * mutation (temp+rename / rename / unlink) and the SQLite row + workspace_ops
 * ledger update. A crash between them leaves one of two windows:
 *
 *   - "new bytes on disk + old row" (rename done, row update pending);
 *   - "row pointing at missing bytes" (unlink done, row delete pending).
 *
 * `scanWorkspaceIntegrity()` (run at kernel startup and on demand) must
 * repair or isolate every such window and be IDEMPOTENT. These tests inject
 * each window by hand (disk + raw DB manipulation, never through the store)
 * and assert the recovery outcome, the quarantine lifecycle, orphan
 * `.ws-tmp-*` cleanup and double-scan convergence.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, WorkspaceError } from '@dsh-scholar/research-kernel'
import { workspaceEtag } from '@dsh-scholar/research-schemas'

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface Ctx {
  dir: string
  kernel: ResearchKernel
  dbPath: string
  casRoot: string
  projectId: string
  wsId: string
  root: string
  historyDir: string
}

/** Kernel + project + one code workspace on a REAL db file (so a "restart"
 * can re-open the same database and the constructor's recovery scan runs). */
function setup(extra: { recoverWorkspacesOnOpen?: boolean } = {}): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-crash-'))
  const dbPath = join(dir, 'kernel.db')
  const casRoot = join(dir, 'cas')
  const kernel = new ResearchKernel({ dbPath, casRoot, requireSignedManifest: false, ...extra })
  const project = kernel.createProject({
    name: 'p', workspace: '/w',
    brief: {
      problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [],
      target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml',
    },
  })
  const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
  return {
    dir, kernel, dbPath, casRoot,
    projectId: project.project_id,
    wsId: ws.workspace_id,
    root: kernel.workspaces.workspaceRoot(ws.workspace_id),
    historyDir: join(kernel.workspaces.workspacesRoot, '.ws-meta', ws.workspace_id, 'history'),
  }
}

function expectWorkspaceErrorCode(fn: () => unknown, code: string): void {
  try {
    fn()
    throw new Error(`expected WorkspaceError ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError)
    expect((error as WorkspaceError).code).toBe(code)
  }
}

/** The only report for `wsId` (scan all and find it). */
function reportFor(ctx: Ctx, scan = ctx.kernel.scanWorkspaceIntegrity()) {
  const report = scan.find(r => r.workspace_id === ctx.wsId)
  expect(report, 'report for workspace').toBeDefined()
  return report!
}

describe('workspace crash recovery (WORK-01 §5 P2)', () => {
  it('write crash window: rename done, row update pending → row rolled forward to the disk bytes (idempotent)', () => {
    const ctx = setup()
    const v1 = ctx.kernel.workspaceWrite(ctx.wsId, 'a.txt', 'v1')
    expect(v1.version).toBe(1)
    const revBefore = ctx.kernel.workspaceGet(ctx.wsId).revision
    // Simulate the crash: the atomic rename happened (bytes are on disk),
    // the row update + op record never ran.
    writeFileSync(join(ctx.root, 'a.txt'), 'v2-inflight')
    const report = reportFor(ctx)
    const issue = report.issues.find(i => i.path === 'a.txt')
    expect(issue?.kind).toBe('row_disk_hash_mismatch')
    expect(issue?.resolution).toBe('repaired')
    expect(report.status).toBe('repaired')
    // The row now matches the disk bytes: version+1, hash/size from bytes.
    const node = ctx.kernel.workspaceRead(ctx.wsId, 'a.txt')
    expect(node?.version).toBe(2)
    expect(node?.hash).toBe(sha256Hex('v2-inflight'))
    expect(node?.content).toBe('v2-inflight')
    expect(node?.etag).toBe(workspaceEtag(2, sha256Hex('v2-inflight')))
    // The workspace revision advanced (the op was recorded with a new rev).
    expect(ctx.kernel.workspaceGet(ctx.wsId).revision).toBeGreaterThan(revBefore)
    // The ledger carries the replayed write op with the new version+hash.
    expect(ctx.kernel.workspaceHistory(ctx.wsId).some(h => h.ops[0]?.op === 'write' && h.ops[0]?.version === 2 && h.ops[0]?.sha256 === sha256Hex('v2-inflight'))).toBe(true)
    // Idempotent: a second scan finds nothing and changes nothing.
    const again = reportFor(ctx)
    expect(again.status).toBe('clean')
    expect(again.issues.filter(i => i.resolution === 'repaired')).toHaveLength(0)
    expect(ctx.kernel.workspaceRead(ctx.wsId, 'a.txt')?.version).toBe(2)
    expect(ctx.kernel.workspaceGet(ctx.wsId).revision).toBe(ctx.kernel.workspaceGet(ctx.wsId).revision)
    ctx.kernel.close()
  })

  it('create crash window: orphan disk file (rename done, row insert pending) → uncommitted create rolled back', () => {
    const ctx = setup()
    ctx.kernel.workspaceWrite(ctx.wsId, 'committed.txt', 'ok')
    // Simulate the crash of a FIRST create: bytes landed on disk, the row
    // insert + op record never ran.
    writeFileSync(join(ctx.root, 'ghost.txt'), 'never-committed')
    const report = reportFor(ctx)
    const issue = report.issues.find(i => i.path === 'ghost.txt')
    expect(issue?.kind).toBe('orphan_file')
    expect(issue?.resolution).toBe('repaired')
    expect(existsSync(join(ctx.root, 'ghost.txt'))).toBe(false)
    expect(ctx.kernel.workspaceRead(ctx.wsId, 'ghost.txt')).toBeNull()
    // The committed file is untouched.
    expect(ctx.kernel.workspaceRead(ctx.wsId, 'committed.txt')?.content).toBe('ok')
    ctx.kernel.close()
  })

  it('delete crash window: row present + disk gone + history holds the version → delete completed forward, undo preserved', () => {
    const ctx = setup()
    ctx.kernel.workspaceWrite(ctx.wsId, 'c.txt', 'v1')
    const v2 = ctx.kernel.workspaceWrite(ctx.wsId, 'c.txt', 'v2', { version: 1 })
    expect(v2.version).toBe(2)
    // Simulate deleteNode up to the unlink: keepHistory copied the current
    // bytes to {path}@{version}, the live file was unlinked, the row delete
    // + op record never ran.
    writeFileSync(join(ctx.historyDir, 'c.txt@2'), 'v2')
    unlinkSync(join(ctx.root, 'c.txt'))
    const report = reportFor(ctx)
    const issue = report.issues.find(i => i.path === 'c.txt')
    expect(issue?.kind).toBe('row_disk_missing')
    expect(issue?.resolution).toBe('repaired')
    expect(ctx.kernel.workspaceRead(ctx.wsId, 'c.txt')).toBeNull()
    expect(existsSync(join(ctx.root, 'c.txt'))).toBe(false)
    // The delete op was recorded (ledger complete)…
    expect(ctx.kernel.workspaceHistory(ctx.wsId).some(h => h.ops[0]?.op === 'delete' && h.ops[0]?.path === 'c.txt' && h.ops[0]?.version === 2)).toBe(true)
    // …and undo still works (history kept the removed version).
    expect(ctx.kernel.workspaceReadVersion(ctx.wsId, 'c.txt', 2)?.content).toBe('v2')
    ctx.kernel.close()
  })

  it('delete crash window with no history (bytes vanished): workspace quarantined, reads/writes refused, survives restart, heals after restore', () => {
    const ctx = setup()
    ctx.kernel.workspaceWrite(ctx.wsId, 'd.txt', 'v1')
    // Simulate a host-side loss of the only copy of the current bytes:
    // no history file, no CAS copy — nothing to prove a repair from.
    unlinkSync(join(ctx.root, 'd.txt'))
    const report = reportFor(ctx)
    expect(report.isolated).toBe(true)
    expect(report.status).toBe('isolated')
    // Every entry point refuses the workspace (fail closed).
    expectWorkspaceErrorCode(() => ctx.kernel.workspaceRead(ctx.wsId, 'd.txt'), 'workspace_inconsistent')
    expectWorkspaceErrorCode(() => ctx.kernel.workspaceWrite(ctx.wsId, 'd.txt', 'x'), 'workspace_inconsistent')
    expectWorkspaceErrorCode(() => ctx.kernel.workspaceTree(ctx.wsId), 'workspace_inconsistent')
    expectWorkspaceErrorCode(() => ctx.kernel.workspaceHistory(ctx.wsId), 'workspace_inconsistent')
    expectWorkspaceErrorCode(() => ctx.kernel.workspaceBlob(ctx.wsId, 'd.txt'), 'workspace_inconsistent')
    // The quarantine is DURABLE: a "restart" re-opens the same database and
    // the startup recovery scan keeps the workspace isolated.
    ctx.kernel.close()
    const reopened = new ResearchKernel({ dbPath: ctx.dbPath, casRoot: ctx.casRoot, requireSignedManifest: false })
    try {
      expectWorkspaceErrorCode(() => reopened.workspaceRead(ctx.wsId, 'd.txt'), 'workspace_inconsistent')
      const scan = reopened.scanWorkspaceIntegrity()
      const r = scan.find(x => x.workspace_id === ctx.wsId)
      expect(r?.isolated).toBe(true)
      // Operator restores the bytes → the next scan reconciles cleanly and
      // clears the quarantine (self-healing, no manual flag to clear).
      writeFileSync(join(ctx.root, 'd.txt'), 'v1')
      const healed = reportFor({ ...ctx, kernel: reopened }, reopened.scanWorkspaceIntegrity())
      expect(healed.status).toBe('recovered')
      expect(healed.isolated).toBe(false)
      expect(reopened.workspaceRead(ctx.wsId, 'd.txt')?.content).toBe('v1')
      // And the healed workspace is writable again.
      expect(reopened.workspaceWrite(ctx.wsId, 'd.txt', 'v2', { version: 1 }).version).toBe(2)
    } finally {
      reopened.close()
    }
  })

  it('binary node bytes missing on disk → restored from the artifact CAS (exact bytes)', () => {
    const ctx = setup()
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0xfe])
    ctx.kernel.workspaceWriteBinary(ctx.wsId, 'img/plot.png', bytes, 'image/png')
    unlinkSync(join(ctx.root, 'img/plot.png'))
    const report = reportFor(ctx)
    const issue = report.issues.find(i => i.path === 'img/plot.png')
    expect(issue?.kind).toBe('row_disk_missing')
    expect(issue?.resolution).toBe('repaired')
    const blob = ctx.kernel.workspaceBlob(ctx.wsId, 'img/plot.png')
    expect(Buffer.from(blob as Buffer).equals(bytes)).toBe(true)
    expect(Buffer.from(readFileSync(join(ctx.root, 'img/plot.png'))).equals(bytes)).toBe(true)
    // Idempotent: second scan is clean.
    const again = reportFor(ctx)
    expect(again.status).toBe('clean')
    ctx.kernel.close()
  })

  it('move crash window 1: disk rename done, DB untouched → uncommitted move rolled back (bytes re-associated with the source row)', () => {
    const ctx = setup()
    ctx.kernel.workspaceWrite(ctx.wsId, 'm.txt', 'mv')
    // Simulate moveNode up to the atomic rename: the file is at the
    // destination, the destination row / source row delete / move op never
    // ran.
    renameSync(join(ctx.root, 'm.txt'), join(ctx.root, 'moved.txt'))
    const report = reportFor(ctx)
    const issue = report.issues.find(i => i.path === 'm.txt')
    expect(issue?.kind).toBe('row_disk_missing')
    expect(issue?.resolution).toBe('repaired')
    expect(issue?.detail).toContain('moved.txt')
    // Rolled back: source row + source bytes intact, destination gone.
    expect(ctx.kernel.workspaceRead(ctx.wsId, 'm.txt')?.content).toBe('mv')
    expect(existsSync(join(ctx.root, 'moved.txt'))).toBe(false)
    expect(readFileSync(join(ctx.root, 'm.txt'), 'utf8')).toBe('mv')
    expect(reportFor(ctx).status).toBe('clean')
    ctx.kernel.close()
  })

  it('move crash window 2: destination row inserted, source row delete pending → move completed forward', () => {
    const ctx = setup()
    const node = ctx.kernel.workspaceWrite(ctx.wsId, 'm2.txt', 'mv2')
    // Simulate moveNode between the dest INSERT and the source DELETE: a
    // raw second connection inserts the destination row (version 1, same
    // hash/blob refs) while the source row + disk file are still there.
    const db = new DatabaseSync(ctx.dbPath)
    try {
      const at = new Date().toISOString()
      db.prepare(
        'INSERT INTO workspace_nodes (workspace_id, path, version, binary, media, size_bytes, content, blob_sha256, content_hash, created_at, updated_at) VALUES (?, ?, 1, 0, ?, ?, NULL, NULL, ?, ?, ?)',
      ).run(ctx.wsId, 'm2-dest.txt', node.media, node.size, node.hash, at, at)
    } finally {
      db.close()
    }
    renameSync(join(ctx.root, 'm2.txt'), join(ctx.root, 'm2-dest.txt'))
    const report = reportFor(ctx)
    const issue = report.issues.find(i => i.path === 'm2.txt')
    expect(issue?.kind).toBe('row_disk_missing')
    expect(issue?.resolution).toBe('repaired')
    // Forward: source row gone, destination row+bytes intact, move op with
    // from_path recorded.
    expect(ctx.kernel.workspaceRead(ctx.wsId, 'm2.txt')).toBeNull()
    expect(ctx.kernel.workspaceRead(ctx.wsId, 'm2-dest.txt')?.content).toBe('mv2')
    const move = ctx.kernel.workspaceHistory(ctx.wsId).find(h => h.ops[0]?.op === 'move' && h.ops[0]?.path === 'm2-dest.txt')
    expect(move?.ops[0]?.from_path).toBe('m2.txt')
    expect(move?.ops[0]?.version).toBe(1)
    expect(move?.ops[0]?.sha256).toBe(node.hash)
    expect(reportFor(ctx).status).toBe('clean')
    ctx.kernel.close()
  })

  it('orphan .ws-tmp-* cleanup in the tree and the history area; row-covered names are protected', () => {
    const ctx = setup()
    ctx.kernel.workspaceWrite(ctx.wsId, 'e.txt', 'e')
    // A node whose name matches the tmp pattern is a REAL node — the scan
    // must not delete it (only un-referenced tmp debris is removed).
    ctx.kernel.workspaceWrite(ctx.wsId, 'keep.ws-tmp-1234abcd', 'real-node')
    writeFileSync(join(ctx.root, 'e.txt.ws-tmp-deadbeef'), 'junk')
    mkdirSync(join(ctx.historyDir), { recursive: true })
    writeFileSync(join(ctx.historyDir, 'h.ws-tmp-00001111'), 'junk2')
    const report = reportFor(ctx)
    expect(report.orphan_tmp_removed).toBe(2)
    expect(existsSync(join(ctx.root, 'e.txt.ws-tmp-deadbeef'))).toBe(false)
    expect(existsSync(join(ctx.historyDir, 'h.ws-tmp-00001111'))).toBe(false)
    // The real node (even with a tmp-shaped name) and its bytes survive.
    expect(ctx.kernel.workspaceRead(ctx.wsId, 'keep.ws-tmp-1234abcd')?.content).toBe('real-node')
    expect(existsSync(join(ctx.root, 'keep.ws-tmp-1234abcd'))).toBe(true)
    expect(ctx.kernel.workspaceRead(ctx.wsId, 'e.txt')?.content).toBe('e')
    ctx.kernel.close()
  })

  it('recovery is idempotent: multiple injected crashes, two scans, identical converged state', () => {
    const ctx = setup()
    ctx.kernel.workspaceWrite(ctx.wsId, 'a.txt', 'v1')
    ctx.kernel.workspaceWrite(ctx.wsId, 'b.txt', 'b1')
    // Inject three windows at once.
    writeFileSync(join(ctx.root, 'a.txt'), 'v2-crash') // rename done, row pending
    writeFileSync(join(ctx.root, 'ghost.txt'), 'orphan') // create in flight
    mkdirSync(ctx.historyDir, { recursive: true })
    writeFileSync(join(ctx.historyDir, 'b.txt@1'), 'b1') // delete window for b.txt
    unlinkSync(join(ctx.root, 'b.txt'))
    const first = reportFor(ctx)
    expect(first.status).toBe('repaired')
    const state1 = {
      a: ctx.kernel.workspaceRead(ctx.wsId, 'a.txt'),
      b: ctx.kernel.workspaceRead(ctx.wsId, 'b.txt'),
      ghost: ctx.kernel.workspaceRead(ctx.wsId, 'ghost.txt'),
      revision: ctx.kernel.workspaceGet(ctx.wsId).revision,
      history: ctx.kernel.workspaceHistory(ctx.wsId).map(h => ({ op: h.ops[0]?.op, path: h.ops[0]?.path, version: h.ops[0]?.version })),
    }
    expect(state1.a?.version).toBe(2)
    expect(state1.a?.content).toBe('v2-crash')
    expect(state1.b).toBeNull()
    expect(state1.ghost).toBeNull()
    // Second scan: clean, nothing changed.
    const second = reportFor(ctx)
    expect(second.status).toBe('clean')
    expect(second.issues.filter(i => i.resolution === 'repaired')).toHaveLength(0)
    const state2 = {
      a: ctx.kernel.workspaceRead(ctx.wsId, 'a.txt'),
      b: ctx.kernel.workspaceRead(ctx.wsId, 'b.txt'),
      ghost: ctx.kernel.workspaceRead(ctx.wsId, 'ghost.txt'),
      revision: ctx.kernel.workspaceGet(ctx.wsId).revision,
      history: ctx.kernel.workspaceHistory(ctx.wsId).map(h => ({ op: h.ops[0]?.op, path: h.ops[0]?.path, version: h.ops[0]?.version })),
    }
    expect(state2).toEqual(state1)
    ctx.kernel.close()
  })

  it('startup recovery scan repairs on open (recoverWorkspacesOnOpen default true); opt-out keeps the corruption', () => {
    const ctx = setup()
    ctx.kernel.workspaceWrite(ctx.wsId, 's.txt', 's1')
    const dbPath = ctx.dbPath
    const casRoot = ctx.casRoot
    ctx.kernel.close()
    // Corrupt: rename done, row pending — on a CLOSED database.
    writeFileSync(join(ctx.root, 's.txt'), 's2-crash')
    // Re-open: the constructor scan repairs before any route can serve it.
    let repairedClosed = false
    const repaired = new ResearchKernel({ dbPath, casRoot, requireSignedManifest: false })
    try {
      expect(repaired.workspaceRead(ctx.wsId, 's.txt')?.content).toBe('s2-crash')
      expect(repaired.workspaceRead(ctx.wsId, 's.txt')?.version).toBe(2)
      repaired.close()
      repairedClosed = true
      // Opt-out: the corruption survives the open untouched.
      writeFileSync(join(ctx.root, 's.txt'), 's3-crash')
      const raw = new ResearchKernel({ dbPath, casRoot, requireSignedManifest: false, recoverWorkspacesOnOpen: false })
      try {
        const node = raw.workspaceRead(ctx.wsId, 's.txt')
        expect(node?.version).toBe(2) // row still old…
        expect(node?.hash).toBe(sha256Hex('s2-crash')) // …disk already new
        // A manual scan then repairs it.
        const report = raw.scanWorkspaceIntegrity().find(r => r.workspace_id === ctx.wsId)
        expect(report?.status).toBe('repaired')
        expect(raw.workspaceRead(ctx.wsId, 's.txt')?.version).toBe(3)
      } finally {
        raw.close()
      }
    } finally {
      if (!repairedClosed) repaired.close()
    }
  })

  it('healthy workspaces scan clean and no-op', () => {
    const ctx = setup()
    ctx.kernel.workspaceWrite(ctx.wsId, 'ok.txt', 'fine')
    ctx.kernel.workspaceWrite(ctx.wsId, 'src/deep/ok.ts', 'fine2')
    ctx.kernel.workspaceMove(ctx.wsId, 'ok.txt', 'renamed.txt')
    const report = reportFor(ctx)
    expect(report.status).toBe('clean')
    expect(report.isolated).toBe(false)
    expect(report.issues.filter(i => i.resolution !== 'informational')).toHaveLength(0)
    expect(report.orphan_tmp_removed).toBe(0)
    expect(ctx.kernel.workspaceRead(ctx.wsId, 'renamed.txt')?.content).toBe('fine')
    ctx.kernel.close()
  })
})
