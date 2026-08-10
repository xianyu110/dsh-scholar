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

  it('STORE-05: same seq with DIFFERENT content is a terminal_frame_conflict', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k-store-05', kind: 'echo' })
    kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_s05', frames: [chunk(1, 'original\n')] })
    // Replay with identical content stays an idempotent skip.
    const replay = kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_s05', frames: [chunk(1, 'original\n')] })
    expect(replay.appended).toBe(0)
    // Replay with different TEXT on the same seq is an integrity error.
    expectKernelError(
      () => kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_s05', frames: [chunk(1, 'tampered\n')] }),
      409, 'terminal_frame_conflict',
    )
    // Different channel on the same seq is an integrity error too.
    expectKernelError(
      () => kernel.appendTerminalFrames({
        jobId: job.job_id, runId: 'run_s05',
        frames: [{ seq: 1, stream_seq: 1, channel: 'stderr', text: 'original\n', byte_offset: 0, byte_length: 9, frame_kind: 'chunk' }],
      }),
      409, 'terminal_frame_conflict',
    )
    // Same content but a different byte_length is still a conflict (content
    // signature covers byte_offset/byte_length — the raw stream extent).
    expectKernelError(
      () => kernel.appendTerminalFrames({
        jobId: job.job_id, runId: 'run_s05',
        frames: [{ seq: 1, stream_seq: 1, channel: 'stdout', text: 'original\n', byte_offset: 0, byte_length: 99, frame_kind: 'chunk' }],
      }),
      409, 'terminal_frame_conflict',
    )
    // An exit frame replaying a chunk seq with different frame_kind conflicts.
    expectKernelError(
      () => kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_s05', frames: [{ seq: 1, frame_kind: 'exit' }] }),
      409, 'terminal_frame_conflict',
    )
    // The stored frame is untouched by the rejected replays.
    const listed = kernel.listTerminalFrames(job.job_id, 'run_s05', 0)
    expect(listed.frames).toHaveLength(1)
    expect(listed.frames[0]!.text).toBe('original\n')
    kernel.close()
  })

  it('STORE-05: gap/exit frame content conflicts are detected via payload_json', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k-store-05b', kind: 'echo' })
    kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_s05b', frames: [{ seq: 1, frame_kind: 'exit', payload_json: JSON.stringify({ exit_code: 0, signal: null }) }] })
    // Identical exit replay is an idempotent skip.
    const replay = kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_s05b', frames: [{ seq: 1, frame_kind: 'exit', payload_json: JSON.stringify({ exit_code: 0, signal: null }) }] })
    expect(replay.appended).toBe(0)
    // Same seq, different exit payload -> integrity error.
    expectKernelError(
      () => kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_s05b', frames: [{ seq: 1, frame_kind: 'exit', payload_json: JSON.stringify({ exit_code: 1, signal: 'SIGKILL' }) }] }),
      409, 'terminal_frame_conflict',
    )
    kernel.close()
  })

  it('STORE-05: evicted (retention-dropped) seqs replay without conflict', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k-store-05c', kind: 'echo' })
    const frames = [...[1, 2, 3, 4].map(i => chunk(i, 'x'.repeat(100))), { seq: 5, frame_kind: 'exit' }]
    const res = kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_s05c', frames, maxLogBytes: 250 })
    expect(res.truncated).toBe(true)
    expect(res.dropped_bytes).toBeGreaterThan(0)
    // The oldest chunks were evicted (gap/exit frames never are); replaying
    // an evicted seq must not throw — eviction already surfaced via
    // terminal_retention/gap frames, and the row is gone.
    const replay = kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_s05c', frames: [chunk(1, 'x'.repeat(100))] })
    expect(replay.appended).toBe(0)
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

  it('reconnect-after-seq: after_seq=N resumes with N+1.. without duplicates or gaps', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k5', kind: 'echo' })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      kernel.appendTerminalFrames({
        jobId: job.job_id, runId: 'run_replay',
        frames: [1, 2, 3, 4, 5].map(i => chunk(i, `line${i}\n`)),
      })
      kernel.appendTerminalFrames({
        jobId: job.job_id, runId: 'run_replay',
        frames: [{ seq: 6, frame_kind: 'exit' }],
      })
      const seqs = async (after: number): Promise<number[]> => {
        const response = await fetch(`http://127.0.0.1:${port}/v1/jobs/${job.job_id}/terminal?after_seq=${after}&run_id=run_replay`)
        const body = await response.text()
        return [...body.matchAll(/event: chunk\ndata: (.*)\n\n/g)]
          .map(m => JSON.parse(m[1]!) as { seq?: number })
          .map(d => d.seq!)
          .sort((a, b) => a - b)
      }
      // Full replay from 0: 1..5 (no missing, no duplicate).
      expect(await seqs(0)).toEqual([1, 2, 3, 4, 5])
      // Resume after seq 3: exactly 4, 5 — seq 3 is NOT re-sent.
      expect(await seqs(3)).toEqual([4, 5])
      // Resume after the last chunk: nothing but the exit.
      const tail = await fetch(`http://127.0.0.1:${port}/v1/jobs/${job.job_id}/terminal?after_seq=5&run_id=run_replay`)
      const tailBody = await tail.text()
      expect(tailBody).not.toContain('event: chunk')
      expect(tailBody).toContain('event: exit')
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('retention-gap: evicted seqs surface a gap event with dropped_bytes before the tail', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k6', kind: 'echo' })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      // 70 chunks × 10 B with a 250 B cap: the first 64 chunks are evicted,
      // seq 65..70 survive — a reader starting at 0 must see the gap first.
      const frames = Array.from({ length: 70 }, (_, i) => chunk(i + 1, '0123456789'))
      const res = kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_gap', frames, maxLogBytes: 250 })
      expect(res.truncated).toBe(true)
      expect(res.dropped_bytes).toBe(640)
      kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_gap', frames: [{ seq: 71, frame_kind: 'exit' }] })
      const response = await fetch(`http://127.0.0.1:${port}/v1/jobs/${job.job_id}/terminal?after_seq=0&run_id=run_gap`)
      const body = await response.text()
      const gapMatch = /event: gap\ndata: (.*)\n\n/.exec(body)
      expect(gapMatch).not.toBeNull()
      const gap = JSON.parse(gapMatch![1]!) as { dropped_bytes?: number; retained_from_seq?: number; seq?: number }
      expect(gap.dropped_bytes).toBe(640)
      expect(gap.retained_from_seq).toBe(65)
      expect(gap.seq).toBe(1)
      const chunkSeqs = [...body.matchAll(/event: chunk\ndata: (.*)\n\n/g)]
        .map(m => JSON.parse(m[1]!) as { seq?: number })
        .map(d => d.seq!)
      expect(chunkSeqs).toEqual(Array.from({ length: 6 }, (_, i) => i + 65))
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('overflow: truncation is reported and the final log artifact stays downloadable', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k7', kind: 'echo' })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      const frames = Array.from({ length: 70 }, (_, i) => chunk(i + 1, '0123456789'))
      const res = kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_overflow', frames, maxLogBytes: 250 })
      expect(res.truncated).toBe(true)
      expect(res.total_bytes).toBeLessThanOrEqual(250)
      expect(res.dropped_bytes).toBeGreaterThan(0)
      // The runner registers the final log artifact; it must remain
      // downloadable even though the hot log was truncated.
      const logContent = 'full canonical log content (truncated hot log is separate)'
      const log = kernel.registerArtifact({ project_id: project.project_id, kind: 'log', content: logContent, media_type: 'text/plain' })
      const response = await fetch(`http://127.0.0.1:${port}/v1/artifacts/${encodeURIComponent(log.artifact_id)}?project_id=${project.project_id}`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(logContent)
      expect(response.headers.get('content-type')).toContain('text/plain')
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('exit-replay: exit frames keep exit_code/signal/timed_out/cancelled readable', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k8', kind: 'echo' })
    const cases: Array<{ run: string; payload: string; expect: Record<string, unknown> }> = [
      { run: 'run_ok', payload: JSON.stringify({ exit_code: 0, signal: null, timed_out: false, cancelled: false }), expect: { exit_code: 0, signal: null, timed_out: false, cancelled: false } },
      { run: 'run_fail', payload: JSON.stringify({ exit_code: 1, signal: null, timed_out: false, cancelled: false }), expect: { exit_code: 1 } },
      { run: 'run_signal', payload: JSON.stringify({ exit_code: null, signal: 'SIGKILL', timed_out: false, cancelled: false }), expect: { signal: 'SIGKILL' } },
      { run: 'run_timeout', payload: JSON.stringify({ exit_code: null, signal: 'SIGTERM', timed_out: true, cancelled: false }), expect: { timed_out: true, cancelled: false } },
      { run: 'run_cancel', payload: JSON.stringify({ exit_code: null, signal: null, timed_out: false, cancelled: true }), expect: { cancelled: true, timed_out: false } },
    ]
    for (const c of cases) {
      kernel.appendTerminalFrames({ jobId: job.job_id, runId: c.run, frames: [{ seq: 1, frame_kind: 'exit', payload_json: c.payload }] })
    }
    for (const c of cases) {
      const listed = kernel.listTerminalFrames(job.job_id, c.run, 0)
      expect(listed.frames).toHaveLength(1)
      expect(listed.frames[0]!.frame_kind).toBe('exit')
      const parsed = JSON.parse(listed.frames[0]!.payload_json) as Record<string, unknown>
      for (const [key, value] of Object.entries(c.expect)) {
        expect(parsed[key]).toEqual(value)
      }
    }
    kernel.close()
  })

  it('cancel-timeout-distinct: timed_out and cancelled stay distinct in exit frames and the SSE exit event', async () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k9', kind: 'echo' })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_timeout', frames: [{ seq: 1, frame_kind: 'exit', payload_json: JSON.stringify({ exit_code: null, signal: 'SIGTERM', timed_out: true, cancelled: false }) }] })
      kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_cancel', frames: [{ seq: 1, frame_kind: 'exit', payload_json: JSON.stringify({ exit_code: null, signal: null, timed_out: false, cancelled: true }) }] })
      const readExit = async (run: string): Promise<Record<string, unknown>> => {
        const response = await fetch(`http://127.0.0.1:${port}/v1/jobs/${job.job_id}/terminal?after_seq=0&run_id=${run}`)
        const body = await response.text()
        const match = /event: exit\ndata: (.*)\n\n/.exec(body)
        expect(match).not.toBeNull()
        return JSON.parse(match![1]!) as Record<string, unknown>
      }
      const timeout = await readExit('run_timeout')
      expect(timeout.timed_out).toBe(true)
      expect(timeout.cancelled).toBe(false)
      const cancelled = await readExit('run_cancel')
      expect(cancelled.cancelled).toBe(true)
      expect(cancelled.timed_out).toBe(false)
      // And they stay distinct when re-read from the frame store.
      const storedTimeout = JSON.parse(kernel.listTerminalFrames(job.job_id, 'run_timeout', 0).frames[0]!.payload_json) as Record<string, unknown>
      const storedCancel = JSON.parse(kernel.listTerminalFrames(job.job_id, 'run_cancel', 0).frames[0]!.payload_json) as Record<string, unknown>
      expect(storedTimeout.timed_out).toBe(true)
      expect(storedTimeout.cancelled).toBe(false)
      expect(storedCancel.cancelled).toBe(true)
      expect(storedCancel.timed_out).toBe(false)
    } finally {
      server.close()
      kernel.close()
    }
  })

  it('log-authz: terminal reads are project-scoped — a foreign project_id answers 404', async () => {
    const kernel = freshKernel()
    const projectA = kernel.createProject({ name: 'a', workspace: '/w', brief: makeBrief() })
    const projectB = kernel.createProject({ name: 'b', workspace: '/w', brief: makeBrief() })
    const job = kernel.submitJob({ project_id: projectA.project_id, idempotency_key: 'k10', kind: 'echo' })
    kernel.appendTerminalFrames({ jobId: job.job_id, runId: 'run_a', frames: [chunk(1, 'secret\n'), { seq: 2, frame_kind: 'exit' } as never] })
    const { server, port } = await startKernelServer({ kernel, port: 0 })
    try {
      // Cross-project read with the foreign project_id -> 404 JSON.
      const foreign = await fetch(`http://127.0.0.1:${port}/v1/jobs/${job.job_id}/terminal?project_id=${projectB.project_id}&run_id=run_a`)
      expect(foreign.status).toBe(404)
      const envelope = await foreign.json() as { error?: { code?: string } }
      expect(envelope.error?.code).toBe('project_not_found')
      // The owning project_id streams normally.
      const own = await fetch(`http://127.0.0.1:${port}/v1/jobs/${job.job_id}/terminal?project_id=${projectA.project_id}&run_id=run_a`)
      expect(own.status).toBe(200)
      expect(await own.text()).toContain('secret')
      // Legacy unqualified reads keep working (the BFF enforces membership).
      const legacy = await fetch(`http://127.0.0.1:${port}/v1/jobs/${job.job_id}/terminal?run_id=run_a`)
      expect(legacy.status).toBe(200)
    } finally {
      server.close()
      kernel.close()
    }
  })
})
