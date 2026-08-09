/**
 * ART-02 media-type serving tests (api-contracts.md §artifact GET):
 * stored media_type + kind fallback (pdf → application/pdf), ETag +
 * If-None-Match 304, Content-Disposition, and single-range 206/416.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel } from '@dsh-scholar/research-kernel'
import { startKernelServer } from '../../packages/research-kernel/lib/server.js'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-artifact-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

async function withServer(kernel: ResearchKernel, fn: (base: string) => Promise<void>): Promise<void> {
  const { server, port } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

describe('artifact GET media type (ART-02)', () => {
  it('serves stored media_type with ETag and Content-Disposition', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', mode: 'gate-only', brief: makeBrief(), constraints: {}, execution: {}, integrity: {} })
    const record = kernel.registerArtifact({ project_id: project.project_id, kind: 'pdf', content: '%PDF-1.4 fake', media_type: 'application/pdf', file_name: 'paper.pdf' })
    await withServer(kernel, async (base) => {
      const res = await fetch(`${base}/v1/artifacts/${encodeURIComponent(record.artifact_id)}?project_id=${encodeURIComponent(project.project_id)}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/pdf')
      expect(res.headers.get('etag')).toBe(`"sha256:${record.sha256}"`)
      expect(res.headers.get('content-disposition')).toBe('inline; filename="paper.pdf"')
      expect(await res.text()).toBe('%PDF-1.4 fake')
      // If-None-Match → 304.
      const notModified = await fetch(`${base}/v1/artifacts/${encodeURIComponent(record.artifact_id)}?project_id=${encodeURIComponent(project.project_id)}`, {
        headers: { 'if-none-match': `"sha256:${record.sha256}"` },
      })
      expect(notModified.status).toBe(304)
    })
  })

  it('defaults non-pdf artifacts to octet-stream with attachment disposition', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', mode: 'gate-only', brief: makeBrief(), constraints: {}, execution: {}, integrity: {} })
    const record = kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: 'abc' })
    expect(record.media_type).toBe('application/octet-stream')
    await withServer(kernel, async (base) => {
      const res = await fetch(`${base}/v1/artifacts/${encodeURIComponent(record.artifact_id)}?project_id=${encodeURIComponent(project.project_id)}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/octet-stream')
      expect(res.headers.get('content-disposition')).toContain('attachment')
    })
  })

  it('supports single-range requests (206) and rejects unsatisfiable ranges (416)', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', mode: 'gate-only', brief: makeBrief(), constraints: {}, execution: {}, integrity: {} })
    const body = '0123456789'
    const record = kernel.registerArtifact({ project_id: project.project_id, kind: 'data', content: body })
    await withServer(kernel, async (base) => {
      const url = `${base}/v1/artifacts/${encodeURIComponent(record.artifact_id)}?project_id=${encodeURIComponent(project.project_id)}`
      const partial = await fetch(url, { headers: { range: 'bytes=2-5' } })
      expect(partial.status).toBe(206)
      expect(partial.headers.get('content-range')).toBe('bytes 2-5/10')
      expect(await partial.text()).toBe('2345')
      const suffix = await fetch(url, { headers: { range: 'bytes=-3' } })
      expect(suffix.status).toBe(206)
      expect(await suffix.text()).toBe('789')
      const openEnded = await fetch(url, { headers: { range: 'bytes=7-' } })
      expect(openEnded.status).toBe(206)
      expect(await openEnded.text()).toBe('789')
      const unsat = await fetch(url, { headers: { range: 'bytes=99-100' } })
      expect(unsat.status).toBe(416)
      expect(unsat.headers.get('content-range')).toBe('bytes */10')
    })
  })
})
