/**
 * CAS GC + integrity scan tests (acceptance-tests.md §3): orphan collection
 * with grace period, missing-blob scan after corruption, and the idempotent
 * put/read path.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel } from '@dsh-scholar/research-kernel'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-casgc-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

describe('CAS orphan GC + blob scan', () => {
  it('collects unreferenced blobs and keeps referenced ones', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    // Referenced blob: registered as an artifact.
    const record = kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'keep me' })
    // Orphan blob: written directly into the CAS without an artifact row.
    const orphan = kernel.cas.put('orphan bytes').sha256
    const orphan2 = kernel.cas.put('orphan bytes 2').sha256
    expect(kernel.cas.has(orphan)).toBe(true)
    expect(kernel.cas.has(orphan2)).toBe(true)
    // Fresh orphans are younger than the grace period -> untouched.
    expect(kernel.collectOrphanBlobs(60_000)).toBe(0)
    expect(kernel.cas.has(orphan)).toBe(true)
    // Zero grace: both orphans go, the referenced blob stays.
    const removed = kernel.collectOrphanBlobs(0)
    expect(removed).toBe(2)
    expect(kernel.cas.has(orphan)).toBe(false)
    expect(kernel.cas.has(orphan2)).toBe(false)
    expect(kernel.cas.has(record.sha256)).toBe(true)
    // Idempotent: nothing left to remove.
    expect(kernel.collectOrphanBlobs(0)).toBe(0)
    kernel.close()
  })

  it('scanMissingBlobs reports artifacts whose blob disappeared', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const a = kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'present' })
    const b = kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'vanished' })
    expect(kernel.scanMissingBlobs()).toEqual([])
    // Simulate disk corruption / failed restore: delete the blob file.
    const casRoot = kernel.cas.root
    const blobPath = join(casRoot, b.sha256)
    rmSync(blobPath, { force: true })
    const missing = kernel.scanMissingBlobs()
    expect(missing).toHaveLength(1)
    expect(missing[0]!.artifact_id).toBe(b.artifact_id)
    expect(missing[0]!.project_id).toBe(project.project_id)
    expect(missing[0]!.sha256).toBe(b.sha256)
    // The intact artifact is not reported.
    expect(missing.some(m => m.artifact_id === a.artifact_id)).toBe(false)
    // Re-putting the same content heals the scan.
    kernel.cas.put('vanished')
    expect(kernel.scanMissingBlobs()).toEqual([])
    kernel.close()
  })

  it('put is idempotent and list enumerates blobs', () => {
    const kernel = freshKernel()
    const p1 = kernel.cas.put('same content')
    const p2 = kernel.cas.put('same content')
    expect(p1.sha256).toBe(p2.sha256)
    const blobs = kernel.cas.list()
    expect(blobs).toContain(p1.sha256)
    // Remove is a no-op for missing/invalid ids.
    expect(kernel.cas.remove('not-a-hash')).toBe(false)
    expect(kernel.cas.remove(p1.sha256)).toBe(true)
    expect(kernel.cas.remove(p1.sha256)).toBe(false)
    kernel.close()
  })

  it('put re-verifies an EXISTING blob by size — a corrupted blob at the content address is rejected (storage-migrations.md §6)', () => {
    const kernel = freshKernel()
    const p = kernel.cas.put('original bytes')
    // Corrupt the blob in place (same content address, different size).
    writeFileSync(kernel.cas.pathFor(p.sha256), 'x')
    expect(() => kernel.cas.put('original bytes')).toThrowError(/blob corruption/)
    kernel.close()
  })

  it('scanIntegrity (STORAGE-07): reports missing/orphan/size/hash mismatches and heals after repair', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intact = kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'intact bytes' })
    const vanished = kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'vanished bytes' })
    const tampered = kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'tamper me bytes' })
    // Baseline: clean scan.
    expect(kernel.scanIntegrity()).toEqual({
      missing_blobs: [], orphan_blobs: [], size_mismatch: [], hash_mismatch: [],
      scanned_blobs: 3, skipped_blobs: 0, total_blobs: 3,
    })
    // 1) missing blob (deleted file) + 2) orphan blob (never referenced).
    rmSync(join(kernel.cas.root, vanished.sha256), { force: true })
    const orphanSha = kernel.cas.put('orphan for scan').sha256
    // 3) tampered blob: same-size content swap → hash mismatch.
    const tamperedPath = join(kernel.cas.root, tampered.sha256)
    writeFileSync(tamperedPath, 'TAMPERED! bytes') // same length, different bytes
    // 4) size mismatch: truncated blob (different size).
    const sizePath = join(kernel.cas.root, intact.sha256)
    writeFileSync(sizePath, 'small')
    const report = kernel.scanIntegrity()
    expect(report.missing_blobs).toHaveLength(1)
    expect(report.missing_blobs[0]).toEqual({ project_id: project.project_id, artifact_id: vanished.artifact_id, sha256: vanished.sha256 })
    expect(report.orphan_blobs).toContain(orphanSha)
    expect(report.orphan_blobs).not.toContain(intact.sha256)
    const hashBad = report.hash_mismatch.find(m => m.sha256 === tampered.sha256)
    expect(hashBad).toBeDefined()
    expect(hashBad!.artifact_id).toBe(tampered.artifact_id)
    const sizeBad = report.size_mismatch.find(m => m.sha256 === intact.sha256)
    expect(sizeBad).toBeDefined()
    expect(sizeBad!.recorded_size).toBe(Buffer.byteLength('intact bytes'))
    expect(sizeBad!.actual_size).toBe(Buffer.byteLength('small'))
    // Healing: restore the correct bytes at each content address (the
    // same-size tampered blob must be removed first — put only re-verifies
    // size on existing blobs, which is exactly why the scan re-hashes).
    kernel.cas.put('vanished bytes')
    rmSync(join(kernel.cas.root, intact.sha256), { force: true })
    kernel.cas.put('intact bytes')
    rmSync(join(kernel.cas.root, tampered.sha256), { force: true })
    kernel.cas.put('tamper me bytes')
    kernel.cas.remove(orphanSha)
    const healed = kernel.scanIntegrity()
    expect(healed.missing_blobs).toEqual([])
    expect(healed.orphan_blobs).toEqual([])
    expect(healed.size_mismatch).toEqual([])
    expect(healed.hash_mismatch).toEqual([])
    kernel.close()
  })

  it('scanIntegrity limit caps blob re-verification and reports skipped_blobs', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    for (let i = 0; i < 5; i++) kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: `blob content ${i}` })
    const report = kernel.scanIntegrity({ limit: 2 })
    expect(report.scanned_blobs).toBe(2)
    expect(report.skipped_blobs).toBe(3)
    expect(report.total_blobs).toBe(5)
    expect(report.missing_blobs).toEqual([])
    kernel.close()
  })
})
