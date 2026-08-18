/**
 * RunnerProfile — opaque runner profile registry（domain-model.md §2/§9.1，
 * hardening-v0.2-status.md RUN-REMOTE-01 剩余项、最终差距审计 §4 #8）。
 *
 * 语义（domain-model.md §9.1）：
 *
 * - `RunnerProfile` 是 Kernel/gateway 共用的已登记 profile 记录：opaque
 *   `profile_id`、`display_name`、`runner_mode`（local-docker /
 *   isolated-subprocess）、锁内 image digest、network policy、资源 limits、
 *   capabilities 标签与 `config_hash`（profile 记录本身的 sha256 pin）。
 * - **opaque id 语义**：Job/UI 只引用 `profile_id`，绝不携带 docker flags、
 *   hostname、credential、Docker socket 或任意 endpoint；解析由本注册表
 *   完成（`resolveRunnerProfile`）。旧枚举入口已移除，任何非注册 opaque
 *   id 都会 fail closed。
 * - **内置注册表与 `configs/runner-profiles/images.lock.json` 对齐**：锁内
 *   node_fixture digest 是 local-docker CPU/GPU 两个 profile 的固定 image；
 *   锁文件读取失败时回退到与 research-kernel images-lock 相同的硬编码常量
 *   （本机无 GPU 执行路径，GPU profile 明确标注 CPU-only pin）。
 *   `isolated-subprocess` 保留为 trusted-smoke-fixture 专用（不是
 *   ExecutionTarget；execution-runtime.md §1）。
 * - **Job 固定 profile/config hash**（domain-model.md §9.1）：kernel
 *   submitJob 把解析出的 `profile_id` 与 `config_hash` 写入 Job payload；
 *   runner executeJob 按注册表复算 `config_hash`，不一致 → environment
 *   失败（不执行）。`computeProfileConfigHash` 是两端共用的确定性 hash
 *   （canonical JSON，键名排序，排除 config_hash 自身）。
 * @module @dsh-scholar/research-schemas/runner-profile
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/** `<image>@sha256:<64 hex>` — profile image 的合法形状（与 images.lock / config-registry 同一正则）。 */
export const PROFILE_IMAGE_DIGEST_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/

/** `sha256:<64 hex>` — profile config_hash 的合法形状（domain-model.md §1 Hash 约定）。 */
export const PROFILE_CONFIG_HASH_RE = /^sha256:[0-9a-f]{64}$/

/**
 * runner_mode：`local-docker` = 容器 ExecutionTarget 路径；`isolated-subprocess`
 * 不是 ExecutionTarget——它是 trusted-smoke-fixture 专用的非 target 兼容层
 * （execution-runtime.md §1），secure kinds 一律拒绝。
 */
export const RunnerProfileMode = z.enum(['local-docker', 'isolated-subprocess'])
export type RunnerProfileMode = z.infer<typeof RunnerProfileMode>

/** profile 的资源 limits（与 ExecutionPlan ExecutionLimits 默认值一致：行为不变约束）。 */
export const RunnerProfileLimits = z.object({
  memory_mb: z.number().int().positive().default(1024),
  cpus: z.number().positive().default(1),
  pids: z.number().int().positive().default(256),
})
export type RunnerProfileLimits = z.infer<typeof RunnerProfileLimits>

/**
 * 一条已登记的 RunnerProfile 记录。`.strict()`：计划外字段（docker flags、
 * host path、credential、endpoint 等）出现在记录里即解析失败——Job/UI 永远
 * 只见 opaque id，解析由服务端注册表完成。
 */
export const RunnerProfile = z.object({
  /** opaque profile id，如 `profile_local_docker_cpu_v1`（Job 只引用它）。 */
  profile_id: z.string().min(1),
  display_name: z.string().min(1),
  runner_mode: RunnerProfileMode,
  /** 锁内 image digest（configs/runner-profiles/images.lock.json；RUN-02）。 */
  image: z.string().regex(PROFILE_IMAGE_DIGEST_RE, 'profile image must be <image>@sha256:<64 hex>'),
  /** 当前唯一合法网络策略（security-baseline.md §5：host 网络在 floor 层拒绝）。 */
  network_policy: z.literal('none'),
  limits: RunnerProfileLimits,
  /** capability 标签（如 `cpu-only` / `gpu-requested` / `trusted-smoke-fixture-only`）。 */
  capabilities: z.array(z.string()).default([]),
  /** profile 记录本身的 sha256 pin（kernel submitJob 固定进 Job，runner 复算校验）。 */
  config_hash: z.string().regex(PROFILE_CONFIG_HASH_RE, 'config_hash must be sha256:<64 hex>'),
  enabled: z.boolean().default(true),
}).strict()
export type RunnerProfile = z.infer<typeof RunnerProfile>

/** 稳定 opaque profile ids（内置注册表的主键）。 */
export const RUNNER_PROFILE_IDS = {
  localDockerCpu: 'profile_local_docker_cpu_v1',
  localDockerGpu: 'profile_local_docker_gpu_v1',
  isolatedSubprocess: 'profile_isolated_subprocess_v1',
} as const
export type RunnerProfileId = (typeof RUNNER_PROFILE_IDS)[keyof typeof RUNNER_PROFILE_IDS]

/** 锁内镜像身份（与 research-kernel images-lock.ts 同源常量；锁文件缺失时回退）。 */
export type LockedProfileImageKind = 'node_fixture' | 'texlive'

const FALLBACK_LOCK: Record<LockedProfileImageKind, string> = {
  node_fixture: 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32',
  texlive: 'texlive/texlive@sha256:8957c916b8160049f89c24d362a6d86c09d8a04095acde37e88404c4afed85b4',
}

/** Repo-relative lock 路径：从 lib（packages/research-schemas/lib）与 src 均上溯 3 级到仓库根。 */
function defaultLockPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', '..', '..', 'configs', 'runner-profiles', 'images.lock.json')
}

function lockPath(): string {
  const override = process.env.DSH_IMAGES_LOCK
  return override !== undefined && override !== '' ? override : defaultLockPath()
}

/**
 * 读取 images.lock 的 node_fixture/texlive digest。只认可锁内的两个条目
 * （形状必须为 `<image>@sha256:<64 hex>`）；文件缺失/不可读/畸形一律回退到
 * 硬编码常量——绝不采纳调用方附加条目（与 research-kernel 同一策略）。
 */
function loadLockDigests(): Record<LockedProfileImageKind, string> {
  let raw: string | null = null
  try {
    raw = readFileSync(lockPath(), 'utf8')
  } catch {
    raw = null
  }
  const entry = (key: LockedProfileImageKind): string | undefined => {
    if (raw === null) return undefined
    try {
      const value = (JSON.parse(raw) as Record<string, unknown>)[key]
      return typeof value === 'string' && PROFILE_IMAGE_DIGEST_RE.test(value) ? value : undefined
    } catch {
      return undefined
    }
  }
  return {
    node_fixture: entry('node_fixture') ?? FALLBACK_LOCK.node_fixture,
    texlive: entry('texlive') ?? FALLBACK_LOCK.texlive,
  }
}

/** 与 images.lock.json 对齐后的锁内 digest（注册表与 kernel 同源）。 */
export const RUNNER_PROFILES_IMAGES_LOCK: Record<LockedProfileImageKind, string> = loadLockDigests()

/** digest 是否 ∈ 锁内条目（注册表与锁对齐断言，测试用）。 */
export function isLockedRunnerImage(digest: string): boolean {
  return digest === RUNNER_PROFILES_IMAGES_LOCK.node_fixture || digest === RUNNER_PROFILES_IMAGES_LOCK.texlive
}

/** canonical JSON：递归按键名排序、无空白（与 execution-plan 的 canonical 同构）。 */
function canonicalProfileJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(v => canonicalProfileJson(v)).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalProfileJson(record[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * profile 记录的确定性 sha256 pin（domain-model.md §9.1 config hash）。
 * 输入 = 记录本身（排除 config_hash 字段）；同一记录恒同值，任一字段变更
 * 即变。kernel submitJob 固定此值进 Job，runner executeJob 按注册表复算比对。
 */
export function computeProfileConfigHash(profile: RunnerProfile): string {
  const { config_hash: _excluded, ...rest } = profile
  return `sha256:${createHash('sha256').update(canonicalProfileJson(rest)).digest('hex')}`
}

/** 定义一条内置 profile：先算 config_hash 再 parse（所有字段显式，hash 输入确定）。 */
function defineProfile(record: Omit<RunnerProfile, 'config_hash'>): RunnerProfile {
  const configHash = computeProfileConfigHash(record as RunnerProfile)
  return RunnerProfile.parse({ ...record, config_hash: configHash })
}

/**
 * 内置注册表（与 images.lock.json 对齐）：
 *
 * - `profile_local_docker_cpu_v1`：默认本机容器执行（node_fixture 锁内 digest）；
 * - `profile_local_docker_gpu_v1`：GPU 意图 profile——本环境无 GPU 执行路径，
 *   实际 pin 仍为 CPU-only（digest/limits 与 CPU profile 一致，capability 标注
 *   `gpu-requested` + `cpu-only`），docker 参数与现状字节级一致；
 * - `profile_isolated_subprocess_v1`：trusted-smoke-fixture 专用（非
 *   ExecutionTarget；secure kinds 由 kernel 422 拒绝）。
 */
export const BUILTIN_RUNNER_PROFILES: readonly RunnerProfile[] = [
  defineProfile({
    profile_id: RUNNER_PROFILE_IDS.localDockerCpu,
    display_name: 'Local Docker (CPU)',
    runner_mode: 'local-docker',
    image: RUNNER_PROFILES_IMAGES_LOCK.node_fixture,
    network_policy: 'none',
    limits: { memory_mb: 1024, cpus: 1, pids: 256 },
    capabilities: ['cpu-only'],
    enabled: true,
  }),
  defineProfile({
    profile_id: RUNNER_PROFILE_IDS.localDockerGpu,
    display_name: 'Local Docker (GPU — CPU-only pin: no GPU execution path in this environment)',
    runner_mode: 'local-docker',
    image: RUNNER_PROFILES_IMAGES_LOCK.node_fixture,
    network_policy: 'none',
    limits: { memory_mb: 1024, cpus: 1, pids: 256 },
    capabilities: ['gpu-requested', 'cpu-only'],
    enabled: true,
  }),
  defineProfile({
    profile_id: RUNNER_PROFILE_IDS.isolatedSubprocess,
    display_name: 'Isolated subprocess (trusted-smoke-fixture only)',
    runner_mode: 'isolated-subprocess',
    // subprocess 无容器；image 仅为 schema 完整性保留锁内 digest（不用于执行）。
    image: RUNNER_PROFILES_IMAGES_LOCK.node_fixture,
    network_policy: 'none',
    limits: { memory_mb: 1024, cpus: 1, pids: 256 },
    capabilities: ['trusted-smoke-fixture-only'],
    enabled: true,
  }),
]

/** 按 opaque id 精确解析；未登记 → null（不做 enum 映射）。 */
export function getRunnerProfile(profileId: string): RunnerProfile | null {
  if (profileId === '') return null
  return BUILTIN_RUNNER_PROFILES.find(p => p.profile_id === profileId) ?? null
}

/** 精确解析 opaque id；未登记 → null，不做旧枚举映射。 */
export function resolveRunnerProfileId(ref: string): string | null {
  if (ref === '') return null
  return getRunnerProfile(ref) === null ? null : ref
}

/** 未登记 profile 引用（调用方应 fail closed：kernel 422 / runner environment 失败）。 */
export class RunnerProfileUnknownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerProfileUnknownError'
  }
}

/** 解析并返回注册记录；未知 opaque id → RunnerProfileUnknownError。 */
export function resolveRunnerProfile(ref: string): RunnerProfile {
  const id = resolveRunnerProfileId(ref)
  if (id === null) {
    throw new RunnerProfileUnknownError(
      `runner profile '${ref}' is not a registered opaque profile id (domain-model.md §9.1)`,
    )
  }
  return getRunnerProfile(id) as RunnerProfile
}

/** 容器 profile（local-docker 路径）判定——secure kinds 必须为 true。 */
export function isContainerRunnerProfile(profile: RunnerProfile): boolean {
  return profile.runner_mode === 'local-docker'
}
