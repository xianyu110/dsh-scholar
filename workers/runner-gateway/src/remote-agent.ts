/**
 * RUN-REMOTE-01 — RemoteRunnerAgent 代理端（docs/remote-runner-wire.md、
 * execution-runtime.md §5.1、hardening-v0.2-status.md §3 RUN-REMOTE-01）。
 *
 * 代理端流程（与本地 runner 同路径，保证 lease/run_id/Manifest 跨 Local/Remote
 * 一致）：
 *
 * 1. register（mTLS service identity；本地 wire 用 x-service-token 等价实现）→
 *    心跳保持 health 新鲜；
 * 2. claims 轮询：拉取匹配的 ExecutionPlan（含签名 + lease generation/token）；
 *    **必须验签**——缺签名/验签失败/未配置公钥 → 拒绝执行（fail closed）；
 * 3. 拉取 CAS 输入（代码快照 + data artifacts）并**复算 sha256**：与响应声明
 *    不一致（或与寻址 hash 不一致）→ 拒绝执行，绝不静默物化；
 * 4. 本地执行（默认 subprocess sandbox；executor 可注入，生产可换 docker 路径）：
 *    按 generation/token 逐帧上报（chunk/exit，全局 seq 单调，owner/token
 *    请求级携带）；
 * 5. artifacts：staged（自生成 stage_id，与 finalize 跨 spool 一致）+ finalize
 *    （sha256 复算由服务端执行，不一致 → 409）；
 * 6. complete：Ed25519 签名的 run_manifest + fencing 字段；lease 过期后
 *    kernel 拒绝（409 lease_stale）——代理端只能丢弃或保留本地诊断，不能完成
 *    Job（不静默降级）；
 * 7. 断网（transport_unreachable 等 retryable 传输错误）→ 本地有界 spool
 *    （frames 可淘汰并合成 gap；artifact/complete 不可淘汰，满则本地失败），
 *    恢复后按序重放。
 *
 * `createRemoteRunnerAgent(registration, transport?, options?)`：
 * - 未提供 transport → fail-closed stub（既有接口层行为不变，任何执行/注册
 *   调用抛 RemoteRunnerAgentNotImplementedError，绝不静默降级）；
 * - 提供 transport → 真实代理端（本模块实现）。
 * @module @dsh-scholar/runner-gateway/remote-agent
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ExecutionPlan as ExecutionPlanSchema,
  executionPlanFingerprint,
  verifyExecutionPlanSignature,
  type AgentClaim,
  type AgentClaimRequest,
  type AgentClaimResponse,
  type AgentHeartbeatRequest,
  type AgentHeartbeatResponse,
  type AgentRegisterRequest,
  type AgentRegisterResponse,
  type CasFetchResponse,
  type ExecutionPlan,
  type RemoteAgentRegistration,
  type RemoteArtifactFinalizeRequest,
  type RemoteArtifactFinalizeResponse,
  type RemoteArtifactStageRequest,
  type RemoteArtifactStageResponse,
  type RemoteCompleteRequest,
  type RemoteCompleteResponse,
  type RemoteFrame,
  type RemoteFramesRequest,
  type RemoteFramesResponse,
} from '@dsh-scholar/research-schemas'
import { AgentOutboundSpool, type AgentSpoolEntry } from './agent-spool.js'
import {
  deepFreezePlan,
  ExecutionPlanMutationError,
  type ExecutionAttachment,
  type ExecutionPreparation,
  type ExecutionRunHandle,
  type ExecutionTarget,
  type OnChunkFn,
  type RunOutcome,
} from './execution-target.js'
import { signManifest, type RunnerSigningKey } from './manifest-signing.js'
import { materializeCodeSnapshot, unpackCodeSnapshot } from './snapshot-materialize.js'

// ── 传输错误 / 传输面 ───────────────────────────────────────────────────────

/**
 * wire 传输错误：status=0 表示传输不可达（网络断开）；code 与服务端错误面
 * 一致（lease_stale/agent_offline/transport_unreachable…）。retryable 的
 * 传输类错误由代理端 spool 保存；lease_stale 为终局（不可重放成功）。
 */
export class RemoteWireError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'RemoteWireError'
  }
}

/** 是否可 spool 重试的传输类错误（网络断开/服务端暂不可用；lease_stale 除外）。 */
export function isSpoolableWireError(error: unknown): error is RemoteWireError {
  return error instanceof RemoteWireError && error.retryable && error.code !== 'lease_stale'
}

/** 远端执行错误基类（环境类——调用方按 retryable 处理，不静默降级）。 */
export class RemoteRunnerAgentError extends Error {}

/** 真实 mTLS 传输未实现时的 fail-closed 错误（保留接口层语义）。 */
export class RemoteRunnerAgentNotImplementedError extends RemoteRunnerAgentError {
  constructor(method: string) {
    super(
      `RemoteRunnerAgent.${method} requires the mTLS service-identity transport, which is not configured; ` +
      'the job stays queued/retryable — no fallback to LocalDocker or subprocess',
    )
    this.name = 'RemoteRunnerAgentNotImplementedError'
  }
}

/** 代理端对 fleet 服务端的 wire 依赖面（HTTP 实现见 HttpRemoteFleetTransport）。 */
export interface RemoteFleetTransport {
  readonly kind: string
  register(req: AgentRegisterRequest): Promise<AgentRegisterResponse>
  heartbeat(agentId: string, req: AgentHeartbeatRequest): Promise<AgentHeartbeatResponse>
  claims(agentId: string, req: AgentClaimRequest): Promise<AgentClaimResponse>
  uploadFrames(agentId: string, runId: string, req: RemoteFramesRequest): Promise<RemoteFramesResponse>
  stageArtifact(agentId: string, runId: string, req: RemoteArtifactStageRequest): Promise<RemoteArtifactStageResponse>
  finalizeArtifact(agentId: string, runId: string, req: RemoteArtifactFinalizeRequest): Promise<RemoteArtifactFinalizeResponse>
  complete(agentId: string, runId: string, req: RemoteCompleteRequest): Promise<RemoteCompleteResponse>
  /** 404 cas_missing → null（其余错误抛 RemoteWireError）。 */
  fetchCas(agentId: string, sha: string, projectId: string): Promise<CasFetchResponse | null>
}

/** 接口层占位名（保留既有导出路径；真实传输实现见 RemoteFleetTransport）。 */
export type RemoteTransport = RemoteFleetTransport

/** HTTP 传输：x-service-token 等价实现（生产必须 mTLS，见 docs/remote-runner-wire.md §3）。 */
export class HttpRemoteFleetTransport implements RemoteFleetTransport {
  readonly kind = 'http'

  constructor(
    private readonly baseUrl: string,
    private readonly options: { serviceToken?: string; timeoutMs?: number } = {},
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...this.options.serviceToken !== undefined ? { 'x-service-token': this.options.serviceToken } : {},
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      })
    } catch (error) {
      throw new RemoteWireError(0, 'transport_unreachable', `fleet transport unreachable at ${this.baseUrl}: ${(error as Error).message}`, true)
    }
    if (!response.ok) {
      let envelope: { error?: { code?: string; message?: string; retryable?: boolean } } | null = null
      try {
        envelope = await response.json() as { error?: { code?: string; message?: string; retryable?: boolean } }
      } catch { /* keep empty */ }
      const code = envelope?.error?.code ?? `http_${response.status}`
      const message = envelope?.error?.message ?? `request ${method} ${path} failed`
      const retryable = envelope?.error?.retryable ?? (response.status === 409 || response.status === 404 || response.status === 502 || response.status === 503)
      throw new RemoteWireError(response.status, code, message, retryable)
    }
    return await response.json() as T
  }

  register(req: AgentRegisterRequest): Promise<AgentRegisterResponse> {
    return this.call('POST', '/v1/agents/register', req)
  }

  heartbeat(agentId: string, req: AgentHeartbeatRequest): Promise<AgentHeartbeatResponse> {
    return this.call('POST', `/v1/agents/${encodeURIComponent(agentId)}/heartbeat`, req)
  }

  claims(agentId: string, req: AgentClaimRequest): Promise<AgentClaimResponse> {
    return this.call('POST', `/v1/agents/${encodeURIComponent(agentId)}/claims`, req)
  }

  uploadFrames(agentId: string, runId: string, req: RemoteFramesRequest): Promise<RemoteFramesResponse> {
    return this.call('POST', `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/frames`, req)
  }

  stageArtifact(agentId: string, runId: string, req: RemoteArtifactStageRequest): Promise<RemoteArtifactStageResponse> {
    return this.call('POST', `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/artifacts`, req)
  }

  finalizeArtifact(agentId: string, runId: string, req: RemoteArtifactFinalizeRequest): Promise<RemoteArtifactFinalizeResponse> {
    return this.call('POST', `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/artifacts`, req)
  }

  complete(agentId: string, runId: string, req: RemoteCompleteRequest): Promise<RemoteCompleteResponse> {
    return this.call('POST', `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/complete`, req)
  }

  async fetchCas(agentId: string, sha: string, projectId: string): Promise<CasFetchResponse | null> {
    try {
      return await this.call('GET', `/v1/agents/${encodeURIComponent(agentId)}/cas/${encodeURIComponent(sha)}?project_id=${encodeURIComponent(projectId)}`)
    } catch (error) {
      if (error instanceof RemoteWireError && error.status === 404 && error.code === 'cas_missing') return null
      throw error
    }
  }
}

// ── 本地执行 ───────────────────────────────────────────────────────────────

/** 执行器上下文（与 ExecutionTargetContext 对齐；cwd 为 sandbox 目录，缺省 process.cwd()）。 */
export interface AgentExecutionContext {
  cwd?: string
  signal?: AbortSignal
  onChunk?: OnChunkFn
  runEnv?: Record<string, string>
}

/** 执行器：plan → RunOutcome。测试注入 fake；生产默认 subprocess sandbox。 */
export type AgentExecutor = (plan: ExecutionPlan, context: AgentExecutionContext) => Promise<RunOutcome>

/**
 * 默认执行器：隔离 subprocess sandbox（cwd 由调用方创建并物化代码快照）。
 * env 缩减白名单（PATH/HOME→cwd/TMPDIR→cwd/DSH_RUN_ID）；timeout 与
 * maxLogBytes 取自 plan.limits；超时/取消杀进程树（detached 进程组）。
 * 远端/调度路径永不产生非 sandbox 的宿主执行。
 */
export function defaultSubprocessExecutor(plan: ExecutionPlan, context: AgentExecutionContext): Promise<RunOutcome> {
  return new Promise<RunOutcome>(resolve => {
    const { cwd, signal, onChunk } = context
    const timeoutMs = plan.limits.timeout_ms
    const maxLogBytes = plan.limits.max_log_bytes
    const startedAt = new Date().toISOString()
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let outOffset = 0
    let errOffset = 0
    let timedOut = false
    let cancelled = false
    let bufferExceeded = false
    let spawnError: string | undefined
    let settled = false

    const command = plan.command.length > 0 ? plan.command : ['true']
    const child: ChildProcess = spawn(command[0] ?? 'true', command.slice(1), {
      cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: cwd,
        TMPDIR: cwd,
        DSH_RUN_ID: plan.run_id,
        ...context.runEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // 独立进程组：取消/超时杀整个执行树（sh → 实际命令）。
      detached: true,
    })

    const killTree = (): void => {
      if (child.pid === undefined) return
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* group gone */ }
      try { child.kill('SIGKILL') } catch { /* already exited */ }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)

    const onAbort = (): void => {
      if (signal?.aborted !== true || settled) return
      cancelled = true
      killTree()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const error = timedOut
        ? `timed out after ${timeoutMs}ms`
        : cancelled
          ? 'cancelled: execution terminated by cancel request'
          : bufferExceeded
            ? `stdout maxBuffer exceeded (${maxLogBytes} bytes)`
            : spawnError
      resolve({
        run_id: plan.run_id,
        exit_code: exitCode,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        error,
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.length
      if (outBytes > maxLogBytes) {
        bufferExceeded = true
        killTree()
        return
      }
      onChunk?.('stdout', chunk.toString('utf8'), outOffset, chunk.length)
      outOffset += chunk.length
      stdoutChunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      errBytes += chunk.length
      if (errBytes > maxLogBytes) {
        bufferExceeded = true
        killTree()
        return
      }
      onChunk?.('stderr', chunk.toString('utf8'), errOffset, chunk.length)
      errOffset += chunk.length
      stderrChunks.push(chunk)
    })
    child.on('error', (error: Error) => { spawnError = error.message })
    child.on('close', (code: number | null) => finish(code === null ? -1 : code))
  })
}

// ── RemoteRunnerAgent（真实代理端）─────────────────────────────────────────

/**
 * RemoteRunnerAgent：ExecutionTarget port 的远端形态。除 port 五方法外，
 * 远端 Agent 还有注册（mTLS service identity handshake）与心跳。
 */
export interface RemoteRunnerAgent extends ExecutionTarget {
  readonly agent_id: string
  /** 注册记录（capability/health/labels/cert_fingerprint 的安全摘要）。 */
  readonly registration: RemoteAgentRegistration
  /** mTLS service identity 注册 handshake（本地 wire：x-service-token）。 */
  register(): Promise<RemoteAgentRegistration>
  /** 心跳（保持 health.last_seen 新鲜；offline 判定见 agent-registry.ts）。 */
  heartbeat(): Promise<void>
}

export interface RemoteAgentOptions {
  registration: RemoteAgentRegistration
  transport: RemoteFleetTransport
  /** fleet 服务端签名 plan 的公钥 PEM（生产由部署配置分发）。缺省 → 拒签/拒执行。 */
  publicKeyPem?: string
  /** 代理端签名 run_manifest 的 Ed25519 密钥（kernel 侧须已注册其公钥）。 */
  signingKey?: RunnerSigningKey
  executor?: AgentExecutor
  /** 有界本地 spool 上限。 */
  spool?: { maxEntries?: number; maxBytes?: number }
  /** 轮询间隔（runPollLoop 用）。 */
  pollIntervalMs?: number
  now?: () => number
}

/** 代理端 run 句柄（port 形态 + outcome promise）。 */
export interface AgentRunHandle extends ExecutionRunHandle {
  state: 'running' | 'done'
  outcome: Promise<RunOutcome>
}

/**
 * RemoteRunnerAgent 真实实现：注册/心跳/claim/执行/上报/spool 全链路。
 * 同时实现 ExecutionTarget port（prepare/start/attach/cancel/wait）。
 */
export class RemoteRunnerAgentImpl implements RemoteRunnerAgent {
  private _target_id: string
  private _agent_id: string
  private _registration: RemoteAgentRegistration
  private readonly transport: RemoteFleetTransport
  private readonly publicKeyPem: string | undefined
  private readonly signingKey: RunnerSigningKey | undefined
  private readonly executor: AgentExecutor
  private readonly spool: AgentOutboundSpool
  private readonly pollIntervalMs: number

  /** prepare 的 fingerprint 基准（start 对账，plan 不可变断言）。 */
  private preparedFingerprint: string | null = null
  /** run_id → 执行中句柄（cancel/wait 用）。 */
  private readonly inflight = new Map<string, { controller: AbortController; outcome: Promise<RunOutcome> }>()
  /** run_id → lease（spool gap frame 上报用；有界 10k 条 FIFO）。 */
  private readonly leaseByRun = new Map<string, { owner: string; token: string | null; generation: number }>()
  /**
   * run_id → 已完成/终局失败结果（resume 幂等：断连恢复后 poll 回放同一 claim
   * 时不重复执行；有界 10k 条 FIFO）。
   */
  private readonly completedRuns = new Map<string, { ok: RunOutcome } | { err: Error }>()
  /** gap frame 上报失败的重试队列（flush 前先补发，保证 seq 单调）。 */
  private pendingGaps: Array<{ runId: string; fromSeq: number; toSeq: number; droppedBytes: number }> = []

  constructor(options: RemoteAgentOptions) {
    this.transport = options.transport
    this._registration = options.registration
    this._target_id = options.registration.target_id
    this._agent_id = options.registration.agent_id
    this.publicKeyPem = options.publicKeyPem
    this.signingKey = options.signingKey
    this.executor = options.executor ?? defaultSubprocessExecutor
    this.spool = new AgentOutboundSpool(options.spool)
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000
  }

  get target_id(): string {
    return this._target_id
  }

  get agent_id(): string {
    return this._agent_id
  }

  get registration(): RemoteAgentRegistration {
    return this._registration
  }

  // ── 注册 / 心跳 ──────────────────────────────────────────────────────────

  /** mTLS service identity 注册 handshake（本地 wire：x-service-token）。 */
  async register(): Promise<RemoteAgentRegistration> {
    const response = await this.transport.register(this.registration)
    if (!response.acknowledged) {
      throw new RemoteRunnerAgentError(`fleet server did not acknowledge agent ${this.agent_id} (target ${this.target_id})`)
    }
    return this.registration
  }

  /** 心跳（保持 health.last_seen 新鲜；服务端不认可 → 明确错误，须重新注册）。 */
  async heartbeat(): Promise<void> {
    const response = await this.transport.heartbeat(this.agent_id, { schema_version: 1 })
    if (!response.accepted) {
      throw new RemoteRunnerAgentError(`fleet server does not acknowledge agent ${this.agent_id} — re-register required`)
    }
  }

  // ── claim / 轮询 ─────────────────────────────────────────────────────────

  /** 拉取匹配 claim（capability 匹配由服务端执行；空 = 无工作）。 */
  async claimOnce(limit = 1): Promise<AgentClaim[]> {
    const response = await this.transport.claims(this.agent_id, { schema_version: 1, limit })
    return response.claims
  }

  /**
   * 轮询循环：heartbeat → flush spool → claim → 执行。任何单步错误不终止
   * 循环（离线期间照常轮询；spool 在恢复后重放）。返回执行的 run 数。
   */
  async runPollLoop(signal?: AbortSignal): Promise<number> {
    let runs = 0
    while (signal?.aborted !== true) {
      try {
        await this.heartbeat()
      } catch { /* 离线；继续轮询 */ }
      try {
        await this.flushSpool()
      } catch { /* 下次再试 */ }
      let claims: AgentClaim[] = []
      try {
        claims = await this.claimOnce(1)
      } catch { /* 无工作/离线 */ }
      for (const claim of claims) {
        try {
          await this.runClaim(claim, { signal })
          runs += 1
        } catch { /* 单 run 失败不终止轮询 */ }
      }
      await delay(this.pollIntervalMs, signal)
    }
    return runs
  }

  // ── ExecutionTarget port ─────────────────────────────────────────────────

  /** 校验 plan 签名（fail closed）+ zod 解析 + 深度冻结 + fingerprint。 */
  async prepare(plan: ExecutionPlan): Promise<ExecutionPreparation> {
    const parsed = ExecutionPlanSchema.parse(plan)
    const verification = verifyExecutionPlanSignature(parsed, this.publicKeyPem ?? '')
    if (!verification.valid) {
      throw new RemoteRunnerAgentError(`refusing to prepare plan ${parsed.plan_id}: ${verification.reason}`)
    }
    this.preparedFingerprint = executionPlanFingerprint(deepFreezePlan(parsed))
    return { target_id: this.target_id, fingerprint: this.preparedFingerprint }
  }

  /** 按 plan 启动远端执行（本地 sandbox 执行 + wire 上报；plan 不可变断言）。 */
  async start(plan: ExecutionPlan, context: AgentExecutionContext = {}): Promise<AgentRunHandle> {
    if (this.preparedFingerprint === null) {
      throw new ExecutionPlanMutationError('start() called before prepare() — target requires a prepared plan')
    }
    const parsed = ExecutionPlanSchema.parse(plan)
    if (executionPlanFingerprint(parsed) !== this.preparedFingerprint) {
      throw new ExecutionPlanMutationError('ExecutionPlan mutated between prepare() and start() — targets never rewrite the plan')
    }
    const claim: AgentClaim = {
      claim_id: `clm_local_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      plan: parsed,
      lease: {
        owner: parsed.lease.owner,
        generation: parsed.lease.generation,
        token: parsed.lease.token,
        expires_at: parsed.lease.expires_at,
      },
      claimed_at: new Date(this.now()).toISOString(),
    }
    const controller = new AbortController()
    const executionContext: AgentExecutionContext = {
      cwd: context.cwd ?? process.cwd(),
      signal: context.signal ?? controller.signal,
      onChunk: context.onChunk,
      runEnv: context.runEnv,
    }
    const outcome = this.executeClaim(claim, executionContext)
    this.inflight.set(parsed.run_id, { controller, outcome })
    void outcome.then(
      () => this.inflight.delete(parsed.run_id),
      () => this.inflight.delete(parsed.run_id),
    )
    const handle: AgentRunHandle = {
      handle_id: `handle_${parsed.job_id}`,
      target_id: this.target_id,
      job_id: parsed.job_id,
      run_id: parsed.run_id,
      started_at: new Date(this.now()).toISOString(),
      state: 'running',
      outcome,
    }
    return handle
  }

  async attach(run: ExecutionRunHandle): Promise<ExecutionAttachment> {
    const inflight = this.inflight.get(run.run_id)
    return { run_id: run.run_id, job_id: run.job_id, target_id: this.target_id, state: inflight !== undefined ? 'running' : 'done' }
  }

  /** 终止执行（abort → executor 杀进程树）。返回是否确有执行在飞。 */
  async cancel(run: ExecutionRunHandle): Promise<boolean> {
    const inflight = this.inflight.get(run.run_id)
    if (inflight === undefined) return false
    inflight.controller.abort()
    return true
  }

  async wait(run: ExecutionRunHandle): Promise<RunOutcome> {
    const inflight = this.inflight.get(run.run_id)
    if (inflight !== undefined) return inflight.outcome
    throw new RemoteRunnerAgentError(`run ${run.run_id} is not in flight on agent ${this.agent_id}`)
  }

  // ── spool ────────────────────────────────────────────────────────────────

  /** 当前 spool 字节/条数（诊断/测试）。 */
  spoolStats(): { entries: number; bytes: number } {
    return { entries: this.spool.size, bytes: this.spool.totalBytes }
  }

  /**
   * 重放本地 spool：先为每个 overflow run 合成 gap frame（seq=淘汰区间起点，
   * kernel 保留其 retention 记账，不静默降级；失败进 pendingGaps 下次先补发），
   * 再按序 dispatch 其余条目。
   *
   * 重放语义：
   * - 传输类 retryable 错误（断网）→ 立即停止（顺序保留，下次再试）；
   * - lease_stale（该 run 已被新 attempt 接管 / claim 已 settled）→ 死条目，
   *   丢弃并继续——它永远不会被接受，留在队列只会阻塞后续条目（该 run 的
   *   log artifact 与 complete 才是权威输出记录）。
   */
  async flushSpool(): Promise<void> {
    // 1) 上次失败的 gap 先补发（保证 gap 永远先于该 run 的存活帧）。
    const gaps = [...this.pendingGaps, ...this.spool.takeOverflowGaps()]
    this.pendingGaps = []
    for (const gap of gaps) {
      const lease = this.leaseByRun.get(gap.runId)
      if (lease === undefined) continue // run 已完结且 lease 已清理——无意义补发
      try {
        await this.transport.uploadFrames(this.agent_id, gap.runId, {
          schema_version: 1,
          frames: [{
            seq: gap.fromSeq,
            frame_kind: 'gap',
            lease_generation: lease.generation,
            payload_json: JSON.stringify({
              dropped_from_seq: gap.fromSeq,
              dropped_to_seq: gap.toSeq,
              dropped_bytes: gap.droppedBytes,
              reason: 'agent_spool_overflow',
            }),
          }],
          owner: lease.owner,
          lease_token: lease.token,
        })
      } catch (error) {
        if (isSpoolableWireError(error)) this.pendingGaps.push(gap)
        // lease_stale → 死 gap（run 已被接管）：丢弃（保留本地诊断）。
      }
    }
    // 2) 按序重放 spool 条目。
    await this.spool.drain(async entry => {
      try {
        await this.dispatch(entry)
      } catch (error) {
        if (error instanceof RemoteWireError && error.code === 'lease_stale') return // 死条目：丢弃并继续
        throw error // 传输类错误：停止重放，保序重试
      }
    })
  }

  /** spool 中是否仍有该 run 的条目（complete 发送顺序保证用）。 */
  private spoolHasEntriesFor(runId: string): boolean {
    return this.spool.hasEntriesFor(runId)
  }

  // ── 核心：执行一个 claim ─────────────────────────────────────────────────

  /**
   * 执行一个 claim：验签 → CAS 输入拉取 + 复算 hash → sandbox 物化 →
   * 本地执行（onChunk 逐帧上报）→ exit frame → log artifact（staged +
   * finalize）→ 签名 manifest + complete。断网时经 sendWithSpool 有界保存。
   */
  async runClaim(claim: AgentClaim, context: AgentExecutionContext = {}): Promise<RunOutcome> {
    const plan = claim.plan
    const runId = plan.run_id
    const existing = this.inflight.get(runId)
    if (existing !== undefined) return existing.outcome // 同 run 幂等（执行中）
    const done = this.completedRuns.get(runId)
    if (done !== undefined) {
      // resume 幂等：断连恢复后 poll 回放同一 claim——不重复执行。
      if ('err' in done) throw done.err
      return done.ok
    }
    const controller = new AbortController()
    const outcome = this.executeClaim(claim, {
      signal: context.signal ?? controller.signal,
      onChunk: context.onChunk,
      runEnv: context.runEnv,
    })
    this.inflight.set(runId, { controller, outcome })
    void outcome.then(
      result => {
        this.inflight.delete(runId)
        this.rememberCompleted(runId, { ok: result })
      },
      error => {
        this.inflight.delete(runId)
        this.rememberCompleted(runId, { err: error as Error })
      },
    )
    return outcome
  }

  /** completedRuns 有界记忆（10k FIFO）。 */
  private rememberCompleted(runId: string, entry: { ok: RunOutcome } | { err: Error }): void {
    if (this.completedRuns.size > 10_000) {
      const oldest = this.completedRuns.keys().next().value as string | undefined
      if (oldest !== undefined) this.completedRuns.delete(oldest)
    }
    this.completedRuns.set(runId, entry)
  }

  private async executeClaim(claim: AgentClaim, context: AgentExecutionContext): Promise<RunOutcome> {
    const plan = claim.plan
    const runId = plan.run_id
    const fencing = { owner: plan.lease.owner, generation: plan.lease.generation, token: plan.lease.token }
    this.leaseByRun.set(runId, fencing)

    // 1) plan 验签（fail closed：缺签名/验签失败/未配置公钥 → 拒绝执行）。
    const verification = verifyExecutionPlanSignature(plan, this.publicKeyPem ?? '')
    if (!verification.valid) {
      throw new RemoteRunnerAgentError(`run ${runId}: refusing to execute — ${verification.reason}`)
    }

    // 2) CAS 输入拉取 + 复算 sha256（不一致 → 拒绝执行）。
    const casInputs: string[] = []
    if (plan.snapshot.code_snapshot_id !== null && plan.snapshot.code_snapshot_id !== '') {
      casInputs.push(plan.snapshot.code_snapshot_id)
    }
    casInputs.push(...plan.artifact_refs.data_artifact_ids)
    const casContents = new Map<string, Buffer>()
    for (const id of casInputs) {
      const response = await this.transport.fetchCas(this.agent_id, id, plan.project_id)
      if (response === null) {
        throw new RemoteRunnerAgentError(`run ${runId}: CAS input ${id} missing — refusing to execute`)
      }
      const content = Buffer.from(response.content_base64, 'base64')
      const actual = createHash('sha256').update(content).digest('hex')
      if (actual !== response.sha256) {
        throw new RemoteRunnerAgentError(
          `run ${runId}: CAS hash mismatch for ${id} — agent recomputed ${actual}, server declared ${response.sha256}; refusing to execute`,
        )
      }
      // 寻址 hash 断言：id 为内容 hash 形态时响应 hash 必须一致。
      const expected = id.startsWith('sha256:') ? id.slice('sha256:'.length) : /^[0-9a-f]{64}$/.test(id) ? id : null
      if (expected !== null && actual !== expected) {
        throw new RemoteRunnerAgentError(
          `run ${runId}: CAS content ${id} does not match the addressed hash ${expected} (got ${actual}) — refusing to execute`,
        )
      }
      casContents.set(id, content)
    }

    // 3) sandbox 物化。
    const workDir = mkdtempSync(join(tmpdir(), 'dsh-scholar-remote-run-'))
    chmodSync(workDir, 0o755)
    try {
      const codeSnapshotId = plan.snapshot.code_snapshot_id
      if (codeSnapshotId !== null && codeSnapshotId !== '') {
        const content = casContents.get(codeSnapshotId)
        if (content === undefined) throw new RemoteRunnerAgentError(`run ${runId}: code snapshot ${codeSnapshotId} not fetched`)
        const files = unpackCodeSnapshot(content)
        const materialized = materializeCodeSnapshot(files, workDir)
        if (materialized === 0) {
          throw new RemoteRunnerAgentError(`run ${runId}: code snapshot ${codeSnapshotId} materialized zero files`)
        }
      }

      // 4) frames 管线（全局 seq 单调；owner/token 请求级携带）。
      let frameSeq = 0
      const streamSeq = { stdout: 0, stderr: 0 }
      let pendingFrames: RemoteFrame[] = []
      let pendingMinSeq = 0
      let pendingMaxSeq = 0
      let flushChain: Promise<void> = Promise.resolve()
      const flushFrames = (): Promise<void> => {
        const batch = pendingFrames
        const minSeq = pendingMinSeq
        const maxSeq = pendingMaxSeq
        pendingFrames = []
        pendingMinSeq = 0
        pendingMaxSeq = 0
        if (batch.length === 0) return Promise.resolve()
        flushChain = flushChain.then(async () => {
          await this.sendWithSpool({
            kind: 'frames',
            agentId: this.agent_id,
            runId,
            payload: {
              schema_version: 1,
              frames: batch,
              owner: fencing.owner,
              lease_token: fencing.token,
              max_log_bytes: plan.limits.max_log_bytes,
            },
            minSeq,
            maxSeq,
            byteSize: 0,
          })
        })
        return flushChain
      }
      const onChunk: OnChunkFn = (channel, text, byteOffset, byteLength) => {
        frameSeq += 1
        const seq = frameSeq
        if (pendingFrames.length === 0) pendingMinSeq = seq
        pendingMaxSeq = seq
        streamSeq[channel] += 1
        pendingFrames.push({
          seq,
          stream_seq: streamSeq[channel],
          channel,
          text,
          byte_offset: byteOffset,
          byte_length: byteLength,
          frame_kind: 'chunk',
          lease_generation: fencing.generation,
        })
        if (pendingFrames.length >= 64) void flushFrames()
      }

      // 5) 本地执行（sandbox 内；onChunk 逐帧上报）。
      const outcome = await this.executor(plan, { cwd: workDir, signal: context.signal, onChunk, runEnv: context.runEnv })

      // 6) exit frame（业务终态仍由 complete 决定）。先冲刷剩余 chunk 帧，
      //    再把 exit 作为独立条目发送——spool 中 exit_frame 不可淘汰（§6：
      //    exit frame 必须在任务终态之前持久化）。
      await flushFrames()
      frameSeq += 1
      const exitFrame: RemoteFrame = {
        seq: frameSeq,
        frame_kind: 'exit',
        lease_generation: fencing.generation,
        payload_json: JSON.stringify({
          exit_code: outcome.exit_code,
          signal: null,
          timed_out: outcome.error !== undefined && outcome.error.includes('timed out'),
          cancelled: outcome.error !== undefined && outcome.error.includes('cancelled'),
        }),
      }
      await this.sendWithSpool({
        kind: 'exit_frame',
        agentId: this.agent_id,
        runId,
        payload: {
          schema_version: 1,
          frames: [exitFrame],
          owner: fencing.owner,
          lease_token: fencing.token,
          max_log_bytes: plan.limits.max_log_bytes,
        },
        minSeq: frameSeq,
        maxSeq: frameSeq,
        byteSize: 0,
      })

      // 7) log artifact（staged + finalize；stage_id 由代理端生成，跨 spool 一致）。
      const logContent = `=== dsh-scholar remote run ${runId} (job ${plan.job_id}, kind ${plan.kind}) ===\nstarted: ${outcome.started_at}\nfinished: ${outcome.finished_at}\nexit: ${outcome.exit_code}\n\n--- stdout ---\n${outcome.stdout}\n\n--- stderr ---\n${outcome.stderr}\n${outcome.error !== undefined ? `\n--- error ---\n${outcome.error}\n` : ''}`
      const stageId = `stg_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      const logSha256 = createHash('sha256').update(logContent, 'utf8').digest('hex')
      const staged = await this.sendWithSpool({
        kind: 'artifact_stage',
        agentId: this.agent_id,
        runId,
        payload: {
          schema_version: 1,
          run_id: runId,
          stage_id: stageId,
          sha256: logSha256,
          size: Buffer.byteLength(logContent, 'utf8'),
          kind: 'log',
          media_type: 'text/plain; charset=utf-8',
          file_name: `run-${runId}.log`,
          metadata: { run_id: runId, job_id: plan.job_id, source: 'remote-agent' },
        },
        minSeq: 0,
        maxSeq: 0,
        byteSize: 0,
      }) as RemoteArtifactStageResponse | undefined
      const finalized = await this.sendWithSpool({
        kind: 'artifact_finalize',
        agentId: this.agent_id,
        runId,
        payload: {
          schema_version: 1,
          run_id: runId,
          stage_id: staged?.stage_id ?? stageId,
          content_base64: Buffer.from(logContent, 'utf8').toString('base64'),
        },
        minSeq: 0,
        maxSeq: 0,
        byteSize: 0,
      }) as RemoteArtifactFinalizeResponse | undefined

      // 8) 签名 manifest + complete（fencing 字段必带）。
      const manifest: Record<string, unknown> = {
        run_id: runId,
        project_id: plan.project_id,
        ...plan.output_contract.contract_id !== null && { contract_id: plan.output_contract.contract_id },
        job_id: plan.job_id,
        command: plan.command,
        container_digest: '',
        data_hash: '',
        resources: { gpu: 0, cpu: 1, memory_gb: 1 },
        started_at: outcome.started_at,
        finished_at: outcome.finished_at,
        exit_code: outcome.exit_code,
        ...finalized !== undefined ? { log_artifact: finalized.artifact_id } : {},
        lease: { generation: fencing.generation, token: fencing.token },
      }
      const finalManifest = this.signingKey !== undefined
        ? signManifest({ ...manifest, signed_by: fencing.owner }, this.signingKey)
        : { ...manifest, signed_by: fencing.owner }
      // 8) complete 必须是该 run 的最后一条 wire 消息：先冲刷 spool（恢复期内
      //    补发的 frames/stage/finalize 先于 complete 送达）；若本 run 仍有
      //    spool 条目（网络仍断），complete 强制入队（顺序保证，服务端不会在
      //    complete 之后拒绝已 settle claim 的补发帧）。
      const completeEntry: Omit<AgentSpoolEntry, 'id'> = {
        kind: 'complete',
        agentId: this.agent_id,
        runId,
        payload: {
          schema_version: 1,
          claim_id: claim.claim_id,
          run_id: runId,
          job_id: plan.job_id,
          status: outcome.exit_code === 0 ? 'succeeded' : 'failed',
          failure_class: outcome.exit_code === 0 ? null : 'unknown',
          error: outcome.error ?? (outcome.exit_code === 0 ? null : `exit code ${outcome.exit_code}`),
          run_manifest: finalManifest,
          lease: { owner: fencing.owner, generation: fencing.generation, token: fencing.token },
        },
        minSeq: 0,
        maxSeq: 0,
        byteSize: 0,
      }
      await this.flushSpool()
      let completed: RemoteCompleteResponse | undefined
      if (this.spoolHasEntriesFor(runId)) {
        const queued = this.spool.push(completeEntry)
        if (!queued.accepted) {
          throw new RemoteRunnerAgentError(
            `run ${runId}: outbound spool overflow while queueing complete (${queued.reason}) — run fails locally (fail closed)`,
          )
        }
      } else {
        completed = await this.sendWithSpool(completeEntry, true) as RemoteCompleteResponse | undefined
      }
      if (completed !== undefined && !completed.accepted) {
        // 服务端显式拒绝（未来非 409 形态）——本地诊断，不重试。
        throw new RemoteRunnerAgentError(`run ${runId}: complete rejected by server (${completed.code ?? 'unknown'})`)
      }
      return outcome
    } finally {
      rmSync(workDir, { recursive: true, force: true })
      // lease 缓存有界（10k FIFO）：gap 补发需要 lease，run 完结后保留。
      if (this.leaseByRun.size > 10_000) {
        const oldest = this.leaseByRun.keys().next().value as string | undefined
        if (oldest !== undefined) this.leaseByRun.delete(oldest)
      }
    }
  }

  /**
   * 发送（或 spool）一个 wire 消息：
   * - 传输类 retryable 错误（transport_unreachable/agent_offline 等）→ 有界 spool，
   *   恢复后重放；spool 满（不可淘汰条目挡住）→ 本地失败（fail closed）；
   * - lease_stale → 终局拒绝：丢弃（保留本地诊断）；complete 场景抛
   *   RemoteRunnerAgentError（旧 agent 不能完成 Job，不静默降级）；
   * - 其余错误原样抛出。
   */
  private async sendWithSpool(entry: Omit<AgentSpoolEntry, 'id'>, fatalOnReject = false): Promise<unknown> {
    try {
      return await this.dispatch({ ...entry, id: `tmp_${randomUUID().replaceAll('-', '').slice(0, 8)}` })
    } catch (error) {
      if (isSpoolableWireError(error)) {
        const result = this.spool.push(entry)
        if (!result.accepted) {
          throw new RemoteRunnerAgentError(
            `run ${entry.runId}: outbound spool overflow (${result.reason}) — entry type ${entry.kind} cannot be dropped; run fails locally (fail closed)`,
          )
        }
        return undefined
      }
      if (error instanceof RemoteWireError && error.code === 'lease_stale') {
        // lease 过期：旧 agent 只能丢弃或保留本地诊断，不能完成 Job。
        if (fatalOnReject) {
          throw new RemoteRunnerAgentError(
            `run ${entry.runId}: server rejected ${entry.kind} with lease_stale — the lease expired; the agent cannot complete the job (no silent success)`,
          )
        }
        return undefined
      }
      throw error
    }
  }

  private async dispatch(entry: AgentSpoolEntry): Promise<unknown> {
    switch (entry.kind) {
      case 'frames':
      case 'exit_frame':
        return this.transport.uploadFrames(entry.agentId, entry.runId, entry.payload as RemoteFramesRequest)
      case 'artifact_stage':
        return this.transport.stageArtifact(entry.agentId, entry.runId, entry.payload as RemoteArtifactStageRequest)
      case 'artifact_finalize':
        return this.transport.finalizeArtifact(entry.agentId, entry.runId, entry.payload as RemoteArtifactFinalizeRequest)
      case 'complete':
        return this.transport.complete(entry.agentId, entry.runId, entry.payload as RemoteCompleteRequest)
    }
  }

  private now(): number {
    return Date.now()
  }
}

// ── 构造 ───────────────────────────────────────────────────────────────────

/**
 * 构造 RemoteRunnerAgent：
 * - 未提供 transport → fail-closed stub（接口层行为不变，任何执行/注册调用
 *   抛 RemoteRunnerAgentNotImplementedError）；
 * - 提供 transport → 真实代理端（注册/心跳/claim/执行/上报/spool 全链路）。
 */
export function createRemoteRunnerAgent(
  registration: RemoteAgentRegistration,
  transport?: RemoteFleetTransport,
  options?: Omit<RemoteAgentOptions, 'registration' | 'transport'>,
): RemoteRunnerAgent {
  if (transport === undefined) {
    const notImplemented = (method: string): never => {
      throw new RemoteRunnerAgentNotImplementedError(method)
    }
    return {
      target_id: registration.target_id,
      agent_id: registration.agent_id,
      registration,
      prepare: async (_plan: ExecutionPlan): Promise<ExecutionPreparation> => notImplemented('prepare'),
      start: async (_plan: ExecutionPlan): Promise<ExecutionRunHandle> => notImplemented('start'),
      attach: async (_run: ExecutionRunHandle): Promise<ExecutionAttachment> => notImplemented('attach'),
      cancel: async (_run: ExecutionRunHandle): Promise<boolean> => notImplemented('cancel'),
      wait: async (_run: ExecutionRunHandle): Promise<RunOutcome> => notImplemented('wait'),
      register: async (): Promise<RemoteAgentRegistration> => notImplemented('register'),
      heartbeat: async (): Promise<void> => notImplemented('heartbeat'),
    }
  }
  return new RemoteRunnerAgentImpl({ ...options, registration, transport })
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
