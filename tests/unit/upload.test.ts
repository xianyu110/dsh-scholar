/**
 * UPLOAD-01 unit + HTTP integration tests (api-contracts.md §7,
 * acceptance-tests.md §3.1): ≤32 MiB multipart upload, staged→finalize
 * atomicity + rollback, server-side sha256 binding, path-safety rejection
 * (absolute / `..` / NUL / Windows drive), idempotent re-upload, staged GC
 * and the multipart parser itself.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, KernelError, validateUploadFileName } from '@dsh-scholar/research-kernel'
import { startKernelServer } from '../../packages/research-kernel/lib/server.js'
import { extractBoundary, parseMultipart } from '../../packages/research-kernel/lib/uploads.js'

const REAL_LIMIT = ResearchKernel.UPLOAD_MAX_FILE_BYTES

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-upload-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

function sha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function withServer(kernel: ResearchKernel, fn: (base: string) => Promise<void>): Promise<void> {
  const { server, port } = await startKernelServer({ kernel, host: '127.0.0.1', port: 0 })
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

function expectKernelError(fn: () => unknown, status: number, code: string): void {
  try {
    fn()
    throw new Error('expected KernelError to be thrown')
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError)
    expect((error as KernelError).status).toBe(status)
    expect((error as KernelError).code).toBe(code)
  }
}

describe('multipart parser (uploads.ts)', () => {
  it('extracts quoted and bare boundaries', () => {
    expect(extractBoundary('multipart/form-data; boundary=abc123')).toBe('abc123')
    expect(extractBoundary('multipart/form-data; charset=utf-8; boundary="b--1"')).toBe('b--1')
    expect(extractBoundary('multipart/form-data')).toBeNull()
    expect(extractBoundary('multipart/form-data; boundary=""')).toBeNull()
    expect(extractBoundary('multipart/form-data; boundary')).toBeNull()
  })

  it('parses a real form: text fields + a file part with binary bytes', () => {
    const boundary = 'TESTBOUNDARY'
    const fileBytes = Buffer.from([0, 1, 2, 253, 254, 255, 0x41, 0x0a, 0x0d])
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="kind"\r\n\r\n'),
      Buffer.from('data\r\n'),
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="file"; filename="a b.bin"\r\n'),
      Buffer.from('Content-Type: application/octet-stream\r\n\r\n'),
      fileBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const parts = parseMultipart(body, boundary)
    expect(parts.map(p => p.name)).toEqual(['kind', 'file'])
    expect(parts[0]!.data.toString('utf8')).toBe('data')
    expect(parts[1]!.fileName).toBe('a b.bin')
    expect(parts[1]!.contentType).toBe('application/octet-stream')
    expect(parts[1]!.data.equals(fileBytes)).toBe(true)
  })

  it('keeps a trailing CRLF that belongs to the data', () => {
    const boundary = 'B2'
    const data = Buffer.from('line1\r\nline2\r\n')
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="file"; filename="crlf.txt"\r\n\r\n'),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const parts = parseMultipart(body, boundary)
    expect(parts).toHaveLength(1)
    expect(parts[0]!.data.equals(data)).toBe(true)
  })

  it('rejects malformed bodies (missing boundary, unterminated part)', () => {
    expect(() => parseMultipart(Buffer.from('no boundary here'), 'XYZ')).toThrow(/boundary/)
    const body = Buffer.from(`--XYZ\r\nContent-Disposition: form-data; name="x"\r\n\r\never`)
    expect(() => parseMultipart(body, 'XYZ')).toThrow(/terminated/)
  })

  it('validateUploadFileName rejects absolute/.. /NUL/Windows drive/nested paths', () => {
    for (const bad of ['../evil.txt', 'a/../../b.txt', '/etc/passwd', 'a\u0000b', 'C:\\evil.txt', 'c:/evil.txt', 'C:evil.txt', 'dir/file.txt', '..', '.', '']) {
      expectKernelError(() => validateUploadFileName(bad), 422, 'invalid_file_name')
    }
    for (const good of ['paper.pdf', 'a b.txt', '训练数据.csv', 'v1.2.tar.gz']) {
      expect(() => validateUploadFileName(good)).not.toThrow()
    }
  })
})

describe('staged upload kernel API (UPLOAD-01)', () => {
  afterEach(() => {
    ResearchKernel.UPLOAD_MAX_FILE_BYTES = REAL_LIMIT
  })

  it('stage + finalize registers a hash-bound artifact and cleans the staging dir', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const content = Buffer.from('research upload payload')
    const stage = kernel.stageUploadContent({ project_id: project.project_id, kind: 'data', file_name: 'notes.txt', content })
    // Staged: a session-id'd .part + .json sidecar exist, no artifact yet.
    const stagedFiles = readdirSync(kernel.stagedUploadsRoot)
    expect(stagedFiles).toContain(`stage_${stage.stage_id}.part`)
    expect(stagedFiles).toContain(`stage_${stage.stage_id}.json`)
    expect(kernel.listArtifacts(project.project_id)).toHaveLength(0)
    // Finalize: atomic promotion into CAS + artifact row.
    const { record, reused } = kernel.finalizeStagedUpload(stage.stage_id)
    expect(reused).toBe(false)
    expect(record.sha256).toBe(sha256(content))
    expect(record.size_bytes).toBe(content.byteLength)
    expect(record.file_name).toBe('notes.txt')
    expect(kernel.cas.has(record.sha256)).toBe(true)
    expect(kernel.cas.read(record.sha256).equals(content)).toBe(true)
    expect(kernel.listArtifacts(project.project_id)).toHaveLength(1)
    // Staging dir is empty after finalize (no GC residue).
    expect(readdirSync(kernel.stagedUploadsRoot)).toHaveLength(0)
    kernel.close()
  })

  it('idempotent re-upload returns the original artifact without re-writing', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const content = Buffer.from('same bytes')
    const s1 = kernel.stageUploadContent({ project_id: project.project_id, kind: 'data', file_name: 'x.bin', content })
    const first = kernel.finalizeStagedUpload(s1.stage_id)
    const s2 = kernel.stageUploadContent({ project_id: project.project_id, kind: 'data', file_name: 'x.bin', content })
    const second = kernel.finalizeStagedUpload(s2.stage_id)
    expect(second.reused).toBe(true)
    expect(second.record.artifact_id).toBe(first.record.artifact_id)
    expect(kernel.listArtifacts(project.project_id)).toHaveLength(1)
    expect(kernel.cas.list()).toHaveLength(1)
    expect(readdirSync(kernel.stagedUploadsRoot)).toHaveLength(0)
    kernel.close()
  })

  it('rolls back a corrupted stage (hash mismatch) with no artifact residue', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const stage = kernel.stageUploadContent({ project_id: project.project_id, kind: 'data', file_name: 'x.bin', content: 'original' })
    // Tamper with the staged bytes AFTER staging (disk corruption / race).
    writeFileSync(kernel.stagedPartPath(stage.stage_id), 'TAMPERED!!!')
    expectKernelError(() => kernel.finalizeStagedUpload(stage.stage_id), 422, 'stage_corrupted')
    expect(readdirSync(kernel.stagedUploadsRoot)).toHaveLength(0)
    expect(kernel.listArtifacts(project.project_id)).toHaveLength(0)
    expect(kernel.cas.list()).toHaveLength(0)
    kernel.close()
  })

  it('missing/expired stage answers 409 artifact_stage_expired', () => {
    const kernel = freshKernel()
    expectKernelError(() => kernel.finalizeStagedUpload('does-not-exist'), 409, 'artifact_stage_expired')
    kernel.close()
  })

  it('rejects unknown project, invalid kind, bad file names and oversized content', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    expectKernelError(
      () => kernel.stageUploadContent({ project_id: 'rsp_nope', kind: 'data', file_name: 'x.bin', content: 'x' }),
      404, 'project_not_found')
    expectKernelError(
      () => kernel.stageUploadContent({ project_id: project.project_id, kind: 'banana' as never, file_name: 'x.bin', content: 'x' }),
      422, 'invalid_kind')
    expectKernelError(
      () => kernel.stageUploadContent({ project_id: project.project_id, kind: 'data', file_name: '../evil.txt', content: 'x' }),
      422, 'invalid_file_name')
    expectKernelError(
      () => kernel.stageUploadContent({ project_id: project.project_id, kind: 'data', file_name: 'a\u0000b', content: 'x' }),
      422, 'invalid_file_name')
    // Oversized content at the REAL limit (cheap: lower the static cap).
    ResearchKernel.UPLOAD_MAX_FILE_BYTES = 1024
    expectKernelError(
      () => kernel.stageUploadContent({ project_id: project.project_id, kind: 'data', file_name: 'x.bin', content: Buffer.alloc(2048) }),
      413, 'payload_too_large')
    kernel.close()
  })

  it('pdf kind defaults media_type to application/pdf', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const stage = kernel.stageUploadContent({ project_id: project.project_id, kind: 'pdf', file_name: 'paper.pdf', content: '%PDF-1.4' })
    const { record } = kernel.finalizeStagedUpload(stage.stage_id)
    expect(record.media_type).toBe('application/pdf')
    kernel.close()
  })

  it('cleanupStagedUploads collects aged stages and keeps fresh ones', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    kernel.stageUploadContent({ project_id: project.project_id, kind: 'data', file_name: 'a.bin', content: 'a' })
    kernel.stageUploadContent({ project_id: project.project_id, kind: 'data', file_name: 'b.bin', content: 'b' })
    expect(readdirSync(kernel.stagedUploadsRoot)).toHaveLength(4)
    // Fresh stages survive a long grace period.
    expect(kernel.cleanupStagedUploads(60_000)).toBe(0)
    expect(readdirSync(kernel.stagedUploadsRoot)).toHaveLength(4)
    // Zero grace collects everything (2 stages × .part + .json).
    expect(kernel.cleanupStagedUploads(0)).toBe(4)
    expect(readdirSync(kernel.stagedUploadsRoot)).toHaveLength(0)
    // Finalized uploads are never touched by the GC (no staged files exist).
    const stage = kernel.stageUploadContent({ project_id: project.project_id, kind: 'data', file_name: 'c.bin', content: 'c' })
    kernel.finalizeStagedUpload(stage.stage_id)
    expect(kernel.cleanupStagedUploads(0)).toBe(0)
    expect(kernel.cas.has(sha256('c'))).toBe(true)
    kernel.close()
  })
})

describe('HTTP multipart upload (POST /v1/projects/{id}/uploads)', () => {
  afterEach(() => {
    ResearchKernel.UPLOAD_MAX_FILE_BYTES = REAL_LIMIT
  })

  it('accepts a ≤32 MiB upload, binds server-side sha256 and serves bytes back', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    await withServer(kernel, async (base) => {
      const content = Buffer.from('multipart upload body')
      const fd = new FormData()
      fd.append('kind', 'data')
      fd.append('file', new Blob([content], { type: 'application/octet-stream' }), 'upload.bin')
      const res = await fetch(`${base}/v1/projects/${project.project_id}/uploads`, { method: 'POST', body: fd })
      expect(res.status).toBe(201)
      const record = (await res.json()) as { artifact_id: string; sha256: string; size_bytes: number; file_name: string; reused: boolean; media_type: string }
      expect(record.reused).toBe(false)
      expect(record.sha256).toBe(sha256(content)) // server-computed, never client-claimed
      expect(record.size_bytes).toBe(content.byteLength)
      expect(record.file_name).toBe('upload.bin')
      expect(record.media_type).toBe('application/octet-stream')
      // Round-trip through the artifact GET route.
      const get = await fetch(`${base}/v1/artifacts/${encodeURIComponent(record.artifact_id)}?project_id=${encodeURIComponent(project.project_id)}`)
      expect(get.status).toBe(200)
      expect(Buffer.from(await get.arrayBuffer()).equals(content)).toBe(true)
    })
    kernel.close()
  })

  it('accepts a file at the exact 32 MiB limit', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    await withServer(kernel, async (base) => {
      const content = Buffer.alloc(REAL_LIMIT, 0x61)
      const fd = new FormData()
      fd.append('kind', 'data')
      fd.append('file', new Blob([content]), 'exact.bin')
      const res = await fetch(`${base}/v1/projects/${project.project_id}/uploads`, { method: 'POST', body: fd })
      expect(res.status).toBe(201)
      const record = (await res.json()) as { sha256: string; size_bytes: number }
      expect(record.size_bytes).toBe(REAL_LIMIT)
      expect(record.sha256).toBe(sha256(content))
    })
    kernel.close()
  })

  it('rejects an oversized upload with 413 payload_too_large (streaming cap)', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    await withServer(kernel, async (base) => {
      // 33 MiB file > 32 MiB file cap AND > 32 MiB + envelope body cap.
      const fd = new FormData()
      fd.append('kind', 'data')
      fd.append('file', new Blob([Buffer.alloc(REAL_LIMIT + 1024 * 1024, 0x62)]), 'big.bin')
      const res = await fetch(`${base}/v1/projects/${project.project_id}/uploads`, { method: 'POST', body: fd })
      expect(res.status).toBe(413)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('payload_too_large')
      expect(kernel.listArtifacts(project.project_id)).toHaveLength(0)
    })
    kernel.close()
  })

  it('enforces the configurable limit via the static cap (lowered for the test)', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    ResearchKernel.UPLOAD_MAX_FILE_BYTES = 1024
    await withServer(kernel, async (base) => {
      const fd = new FormData()
      fd.append('kind', 'data')
      fd.append('file', new Blob([Buffer.alloc(2048)]), 'big.bin')
      const res = await fetch(`${base}/v1/projects/${project.project_id}/uploads`, { method: 'POST', body: fd })
      expect(res.status).toBe(413)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('payload_too_large')
    })
    kernel.close()
  })

  it('rejects path-traversal file names with 422 invalid_file_name', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    await withServer(kernel, async (base) => {
      for (const bad of ['../evil.txt', '/etc/passwd', 'dir/../x.bin']) {
        const fd = new FormData()
        fd.append('kind', 'data')
        fd.append('file', new Blob([Buffer.from('x')]), bad)
        const res = await fetch(`${base}/v1/projects/${project.project_id}/uploads`, { method: 'POST', body: fd })
        expect(res.status).toBe(422)
        const body = (await res.json()) as { error: { code: string } }
        expect(body.error.code).toBe('invalid_file_name')
      }
      expect(kernel.listArtifacts(project.project_id)).toHaveLength(0)
    })
    kernel.close()
  })

  it('honors the explicit file_name field and rejects multiple file parts', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    await withServer(kernel, async (base) => {
      const fd = new FormData()
      fd.append('kind', 'pdf')
      fd.append('file_name', 'renamed.pdf')
      fd.append('file', new Blob([Buffer.from('%PDF-1.4 fake')]), 'client-name.pdf')
      const res = await fetch(`${base}/v1/projects/${project.project_id}/uploads`, { method: 'POST', body: fd })
      expect(res.status).toBe(201)
      const record = (await res.json()) as { file_name: string; media_type: string }
      expect(record.file_name).toBe('renamed.pdf')
      expect(record.media_type).toBe('application/pdf')
      // Two file parts → 422 multiple_files (single-file uploads only).
      const multi = new FormData()
      multi.append('kind', 'data')
      multi.append('file', new Blob([Buffer.from('a')]), 'a.bin')
      multi.append('file', new Blob([Buffer.from('b')]), 'b.bin')
      const res2 = await fetch(`${base}/v1/projects/${project.project_id}/uploads`, { method: 'POST', body: multi })
      expect(res2.status).toBe(422)
      expect(((await res2.json()) as { error: { code: string } }).error.code).toBe('multiple_files')
    })
    kernel.close()
  })

  it('rejects missing file part, invalid kind, non-multipart content type and unknown project', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    await withServer(kernel, async (base) => {
      const noFile = new FormData()
      noFile.append('kind', 'data')
      const r1 = await fetch(`${base}/v1/projects/${project.project_id}/uploads`, { method: 'POST', body: noFile })
      expect(r1.status).toBe(422)
      expect(((await r1.json()) as { error: { code: string } }).error.code).toBe('missing_file')

      const badKind = new FormData()
      badKind.append('kind', 'banana')
      badKind.append('file', new Blob([Buffer.from('x')]), 'x.bin')
      const r2 = await fetch(`${base}/v1/projects/${project.project_id}/uploads`, { method: 'POST', body: badKind })
      expect(r2.status).toBe(422)
      expect(((await r2.json()) as { error: { code: string } }).error.code).toBe('invalid_kind')

      const r3 = await fetch(`${base}/v1/projects/${project.project_id}/uploads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(r3.status).toBe(415)
      expect(((await r3.json()) as { error: { code: string } }).error.code).toBe('unsupported_media_type')

      const r4 = new FormData()
      r4.append('kind', 'data')
      r4.append('file', new Blob([Buffer.from('x')]), 'x.bin')
      const res4 = await fetch(`${base}/v1/projects/rsp_nope/uploads`, { method: 'POST', body: r4 })
      expect(res4.status).toBe(404)
      expect(((await res4.json()) as { error: { code: string } }).error.code).toBe('project_not_found')
    })
    kernel.close()
  })

  it('idempotent HTTP re-upload returns 200 + reused with the original artifact', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    await withServer(kernel, async (base) => {
      const upload = async (): Promise<{ status: number; body: { artifact_id: string; reused: boolean } }> => {
        const fd = new FormData()
        fd.append('kind', 'data')
        fd.append('file', new Blob([Buffer.from('same')]), 'same.bin')
        const res = await fetch(`${base}/v1/projects/${project.project_id}/uploads`, { method: 'POST', body: fd })
        return { status: res.status, body: (await res.json()) as { artifact_id: string; reused: boolean } }
      }
      const first = await upload()
      expect(first.status).toBe(201)
      expect(first.body.reused).toBe(false)
      const second = await upload()
      expect(second.status).toBe(200)
      expect(second.body.reused).toBe(true)
      expect(second.body.artifact_id).toBe(first.body.artifact_id)
      expect(kernel.listArtifacts(project.project_id)).toHaveLength(1)
      expect(kernel.cas.list()).toHaveLength(1)
    })
    kernel.close()
  })
})
