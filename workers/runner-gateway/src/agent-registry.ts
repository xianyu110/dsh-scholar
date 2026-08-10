/**
 * RUN-REMOTE-01 — 远端 Agent 注册表（内存实现；kernel 或 runner-gateway 内，
 * 注册/心跳更新 health/offline 判定）。
 *
 * 注册表只持有 RemoteAgentRegistration 的安全摘要（opaque target_id、
 * capability、labels、health、cert_fingerprint）。address/certificate/
 * SSH bootstrap 等连接信息由服务端 Config/SecretRef 解析，不进入注册表。
 * 离线判定与调度纯函数共用 `isTargetAvailable`（research-schemas
 * execution-target.ts）——health.status 非 online 或 last_seen 超时即 offline；
 * 调度结果 assigned:false 恒 retryable，任务留在队列，绝不静默降级。
 * @module @dsh-scholar/runner-gateway/agent-registry
 */

import {
  isTargetAvailable,
  LOCAL_DOCKER_TARGET_ID,
  type AgentHealthStatus,
  type RemoteAgentRegistration,
} from '@dsh-scholar/research-schemas'

/** 注册表接口（未来可换成持久化表实现）。 */
export interface AgentRegistry {
  /** 注册或更新（upsert by agent_id；刷新 health.last_seen）。 */
  register(registration: RemoteAgentRegistration): void
  /** 心跳：刷新 last_seen（可携带状态变更，如 draining）。返回更新后的记录。 */
  heartbeat(agentId: string, status?: AgentHealthStatus, now?: number): RemoteAgentRegistration | null
  /** 移除（注销）。 */
  remove(agentId: string): boolean
  get(agentId: string): RemoteAgentRegistration | undefined
  /** 按 target_id 列出。 */
  getByTarget(targetId: string): RemoteAgentRegistration[]
  /** 全部记录（按 target_id/agent_id 确定性排序）。 */
  list(): RemoteAgentRegistration[]
  /** offline 判定（status/时效），与调度纯函数同一规则。 */
  isOffline(agentId: string, now?: number, offlineAfterMs?: number): boolean
}

/**
 * 内存注册表：注册、心跳更新 health、offline 判定。
 * last_seen 由 register/heartbeat 写入（可用显式 now 保证测试确定性）。
 */
export class InMemoryAgentRegistry implements AgentRegistry {
  private readonly agents = new Map<string, RemoteAgentRegistration>()

  register(registration: RemoteAgentRegistration): void {
    // 只保留注册记录本身：任何 address/cert/凭据字段在 schema 层已被
    // `.strict()` 拒绝（RemoteAgentRegistration），这里不可能携带。
    const parsed = registration // schema 由调用方保证；重复防御性校验见 registerFrom
    this.agents.set(parsed.agent_id, parsed)
  }

  heartbeat(agentId: string, status?: AgentHealthStatus, now: number = Date.now()): RemoteAgentRegistration | null {
    const current = this.agents.get(agentId)
    if (current === undefined) return null
    const updated: RemoteAgentRegistration = {
      ...current,
      health: {
        status: status ?? current.health.status,
        last_seen: new Date(now).toISOString(),
      },
    }
    this.agents.set(agentId, updated)
    return updated
  }

  remove(agentId: string): boolean {
    return this.agents.delete(agentId)
  }

  get(agentId: string): RemoteAgentRegistration | undefined {
    return this.agents.get(agentId)
  }

  getByTarget(targetId: string): RemoteAgentRegistration[] {
    return [...this.agents.values()]
      .filter(r => r.target_id === targetId)
      .sort((a, b) => (a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0))
  }

  list(): RemoteAgentRegistration[] {
    return [...this.agents.values()].sort((a, b) => {
      if (a.target_id !== b.target_id) return a.target_id < b.target_id ? -1 : 1
      return a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0
    })
  }

  isOffline(agentId: string, now: number = Date.now(), offlineAfterMs = 30_000): boolean {
    const current = this.agents.get(agentId)
    if (current === undefined) return true // 未注册 = 不可用（fail closed）
    return !isTargetAvailable(current, now, offlineAfterMs)
  }
}

/**
 * 本地 docker target 的注册记录（gateway 启动时注册进注册表，参与调度；
 * 单 target 部署可跳过调度直接执行）。capabilities.images 为空 =
 * 接受任何 Kernel 锁内 digest；cert_fingerprint=null = 无 mTLS（本地）。
 */
export function localDockerRegistration(runnerVer: string, now: string): RemoteAgentRegistration {
  return {
    schema_version: 1,
    target_id: LOCAL_DOCKER_TARGET_ID,
    agent_id: `${LOCAL_DOCKER_TARGET_ID}-agent`,
    capabilities: {
      os: 'linux',
      arch: 'x64',
      runner_ver: runnerVer,
      images: [],
    },
    labels: { role: 'local-docker' },
    health: { status: 'online', last_seen: now },
    cert_fingerprint: null,
  }
}
