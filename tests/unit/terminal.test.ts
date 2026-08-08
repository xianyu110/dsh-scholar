/**
 * Terminal frames + SSE unit tests (execution-runtime.md §6,
 * api-contracts.md §9): monotonic seq, idempotency, lease fencing,
 * bounded retention with dropped/truncated accounting, and the
 * text/event-stream replay endpoint.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, KernelError } from '@dsh-scholar/research-kernel'
import { startKernelServer } from '../../packages/research-kernel/lib/server.js'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-terminal-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas') })
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

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

function chunk(seq: number, text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq, stream_seq: seq, channel: 'stdout', text,
    byte_offset: 0, byte_length: Buffer.byteLength(text), frame_kind: 'chunk', ...overrides,
  }
}

describe('terminal frames (kernel)', () => {
  it('appends chunks with monotonic seq and lists them after afterSeq', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k1', kind: 'echo' })
    const res1 = kernel.appendTerminalFrames({
      jobId: job.job_id, runId: 'run1',
      frames: [chunk(1, 'hello\n'), chunk(2, 'world\n')],
    })
    expect(res1.appended).toBe(2)
    expect(res1.last_seq).toBe(2)
    // Replay of the same seq is an idempotent skip (no duplicate rows).
    const res2 = kernel.appendTerminalFrames({
      jobId: job.job_id, runId: 'run1',
      frames: [chunk(2, 'world\n'), chunk(3, 'done\n')],
    })
    expect(res2.appended).toBe(1)
    expect(res2.last_seq).toBe(3)
    const listed = kernel.listTerminalFrames(job.job_id, 'run1', 0)
    expect(listed.frames.map(f => f.text)).toEqual(['hello\n', 'world\n', 'done\n'])
    expect(listed.frames.map(f => f.seq)).toEqual([1, 2, 3])
    const tail = kernel.listTerminalFrames(job.job_id, 'run1', 2)
    expect(tail.frames.map(f => f.seq)).toEqual([3])
    kernel.close()
  })

  it('rejects malformed chunk frames and stale lease generations', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k2', kind: 'echo' })
    expectKernelError(
      () => kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run1', frames: [{ seq: 1, frame_kind: 'chunk' } as never] }),
      422, 'invalid_chunk_frame',
    )
    // Claim the job (lease_generation = 1); frames from an older generation
    // are rejected by lease fencing.
    const claimed = kernel.claimJobs('runner-1', 300, 8)
    expect(claimed.some(c => c.job_id === job.job_id)).toBe(true)
    expectKernelError(
      () => kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run1', frames: [{ seq: 1, frame_kind: 'chunk', channel: 'stdout', text: 'x', lease_generation: 0 } as never] }),
      409, 'lease_stale',
    )
    // The current generation is accepted.
    const ok = kernel.appendTerminalFrames({
      jobId: job.job_id, runId: 'run1',
      frames: [{ seq: 1, frame_kind: 'chunk', channel: 'stdout', text: 'ok\n', stream_seq: 1, byte_offset: 0, byte_length: 3, lease_generation: 1 }],
    })
    expect(ok.appended).toBe(1)
    kernel.close()
  })

  it('enforces bounded retention: evicts oldest chunks, records dropped/truncated', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k3', kind: 'echo' })
    const frames = [1, 2, 3, 4].map(i => chunk(i, 'x'.repeat(100)))
    const res = kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run1', frames, maxLogBytes: 250 })
    expect(res.truncated).toBe(true)
    expect(res.dropped_bytes).toBeGreaterThan(0)
    expect(res.total_bytes).toBeLessThanOrEqual(250)
    // The exit frame survives eviction and the oldest chunks are gone.
    kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run1', frames: [{ seq: 5, frame_kind: 'exit' }] })
    const listed = kernel.listTerminalFrames(job.job_id, 'run1', 0)
    expect(listed.frames.some(f => f.frame_kind === 'exit')).toBe(true)
    expect(listed.retention.truncated).toBe(true)
    expect(listed.retention.retained_from_seq).toBeGreaterThan(1)
    expect(listed.retention.dropped_bytes).toBeGreaterThan(0)
    kernel.close()
  })
})

describe('terminal SSE endpoint', () => {
  it('streams subscribed, chunks and exit events over text/event-stream', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k4', kind: 'echo' })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      kernel.appendTerminalFrames({
        jobId: job.job_id, runId: job.job_id,
        frames: [chunk(1, 'line1\n'), chunk(2, 'line2\n')],
      })
      kernel.appendTerminalFrames({
        jobId: job.job_id, runId: job.job_id,
        frames: [{ seq: 3, frame_kind: 'exit' }],
      })
      const response = await fetch(`http://127.0.0.1:${port}/v1/jobs/${job.job_id}/terminal?after_seq=0&channel=all&run_id=${job.job_id}`)
      expect(response.ok).toBe(true)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const body = await response.text()
      expect(body).toContain('event: subscribed')
      expect(body).toContain('event: chunk')
      expect(body).toContain('line1')
      expect(body).toContain('line2')
      expect(body).toContain('event: exit')
    } finally {
      server.close()
      kernel.close()
    }
  })
})
