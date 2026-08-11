/**
 * RUN-REMOTE-01 — kernel client 共享工具：ResearchClient 的 request 管道 +
 * lease 头 terminal frames 上传（TERM-01 §4 P0）。
 *
 * appendTerminalFramesWithLease 原为 runner-gateway index.ts 内部实现；远端
 * fleet 服务端转发 frames 需要与本地 runner 完全相同的路径（owner/token 走
 * x-lease-owner/x-lease-token 头，kernel 精确匹配），因此迁入本模块，
 * index.ts 与 remote-fleet-server.ts 共用（index.ts 保持 re-export）。
 * @module @dsh-scholar/runner-gateway/kernel-client
 */

import type { ResearchClient } from '@dsh-scholar/research-client'

/**
 * §4 P0 (TERM-01): upload terminal frames WITH the lease owner/token — the
 * kernel exact-matches them against the job's current lease (a wrong owner or
 * token is 409 lease_stale), so the gateway must always attach both. The
 * ResearchClient's typed method does not carry headers, so this reuses the
 * client's request pipeline (same endpoint/bearer handling) with the lease
 * headers attached.
 */
type ResearchRequestFn = <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<T>

export function appendTerminalFramesWithLease(
  client: ResearchClient,
  jobId: string,
  runId: string,
  frames: Array<{
    seq: number
    stream_seq?: number | null
    channel?: 'stdout' | 'stderr' | null
    text?: string | null
    byte_offset?: number | null
    byte_length?: number | null
    frame_kind: 'chunk' | 'gap' | 'exit'
    lease_generation?: number
    payload_json?: string
  }>,
  owner: string,
  token: string | null,
  maxLogBytes?: number,
): Promise<{ appended: number; last_seq: number }> {
  // The typed ResearchClient has no header-carrying frames method, so this
  // reuses its private request pipeline. request is bound to the client:
  // ResearchClient.request reads `this.timeoutMs` — an unbound call crashes
  // with "Cannot read properties of undefined (reading 'timeoutMs')" and the
  // frames are silently dropped (the local runner's .catch() masked this;
  // the fleet server surfaced it as 502 kernel_unreachable).
  const clientWithRequest = client as unknown as { request: ResearchRequestFn }
  return clientWithRequest.request.call(
    clientWithRequest,
    'POST',
    `/v1/jobs/${jobId}/terminal-frames`,
    {
      run_id: runId,
      frames,
      ...maxLogBytes !== undefined ? { max_log_bytes: maxLogBytes } : {},
    },
    {
      'x-lease-owner': owner,
      'x-lease-token': token ?? '',
    },
  ) as Promise<{ appended: number; last_seq: number }>
}
