/**
 * RUN-REMOTE-01 — RemoteRunnerAgent 接口（execution-runtime.md §5.1）。
 *
 * 远端 Agent 通过 mTLS service identity 注册 health/capability/labels，
 * 拉取 CAS 输入并复算 hash，在隔离 sandbox 执行，按 generation/token
 * 上报 frames、stage Artifacts 和 complete。网络断开时 spool 有界保存；
 * lease 过期后旧 Agent 只能丢弃或保留本地诊断，不能完成 Job——
 * generation/token 校验已由 Kernel 强制执行（§12.6，409 lease_stale），
 * 远端路径必须携带 plan 的 lease 绑定（research-schemas planLeaseFencing）。
 *
 * 本轮为接口层：真实 mTLS 传输、远端 sandbox、spool 未实现。
 * `createRemoteRunnerAgent` 返回 fail-closed stub——任何执行方法抛
 * RemoteRunnerAgentNotImplementedError，绝不静默回退 LocalDocker 或
 * subprocess。注册记录本身（RemoteAgentRegistration）由服务端
 * Config/SecretRef 引导的注册源写入注册表（agent-registry.ts）。
 * @module @dsh-scholar/runner-gateway/remote-agent
 */

import type { ExecutionPlan, RemoteAgentRegistration } from '@dsh-scholar/research-schemas'
import type {
  ExecutionAttachment,
  ExecutionPreparation,
  ExecutionRunHandle,
  ExecutionTarget,
  RunOutcome,
} from './execution-target.js'

/** 远端传输（未来：双向 mTLS + service identity wire；本轮仅类型占位）。 */
export interface RemoteTransport {
  readonly kind: 'mtls'
  /** 一次 wire 调用（未来实现 CAS 输入拉取/复算、frames、Artifacts、complete）。 */
  call(method: string, payload: unknown): Promise<unknown>
}

/** 远端执行错误基类（环境类——调用方按 retryable 处理，不静默降级）。 */
export class RemoteRunnerAgentError extends Error {}

/** 真实 mTLS 传输未实现时的 fail-closed 错误。 */
export class RemoteRunnerAgentNotImplementedError extends RemoteRunnerAgentError {
  constructor(method: string) {
    super(
      `RemoteRunnerAgent.${method} requires the mTLS service-identity transport, which is not implemented at the interface layer; ` +
      'the job stays queued/retryable — no fallback to LocalDocker or subprocess',
    )
    this.name = 'RemoteRunnerAgentNotImplementedError'
  }
}

/**
 * RemoteRunnerAgent：ExecutionTarget port 的远端形态。除 port 五方法外，
 * 远端 Agent 还有注册（mTLS service identity handshake）与心跳。
 */
export interface RemoteRunnerAgent extends ExecutionTarget {
  readonly agent_id: string
  /** 注册记录（capability/health/labels/cert_fingerprint 的安全摘要）。 */
  readonly registration: RemoteAgentRegistration
  /** mTLS service identity 注册 handshake（真实传输未实现时抛 NotImplemented）。 */
  register(): Promise<RemoteAgentRegistration>
  /** 心跳（保持 health.last_seen 新鲜；offline 判定见 agent-registry.ts）。 */
  heartbeat(): Promise<void>
}

/**
 * 构造 RemoteRunnerAgent 接口层实例。真实 mTLS 传输未实现：所有执行与
 * 注册方法 fail-closed 抛 RemoteRunnerAgentNotImplementedError——接口存在、
 * 可被调度/组合代码引用，但任何真实执行都明确失败而不是静默降级。
 */
export function createRemoteRunnerAgent(
  registration: RemoteAgentRegistration,
  _transport?: RemoteTransport,
): RemoteRunnerAgent {
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
