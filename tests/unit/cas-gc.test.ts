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
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas') })
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
})
