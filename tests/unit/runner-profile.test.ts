/**
 * RunnerProfile 注册表（domain-model.md §2/§9.1，审计 §4 #8）：
 * opaque profile id 解析、config_hash 稳定/变更敏感、未知 id 拒绝、
 * legacy enum 拒绝、isolated-subprocess 限制、与 images.lock 对齐。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUILTIN_RUNNER_PROFILES,
  computeProfileConfigHash,
  getRunnerProfile,
  isContainerRunnerProfile,
  isLockedRunnerImage,
  resolveRunnerProfile,
  resolveRunnerProfileId,
  RUNNER_PROFILE_IDS,
  RUNNER_PROFILES_IMAGES_LOCK,
  RunnerProfile,
  RunnerProfileUnknownError,
} from '@dsh-scholar/research-schemas'

/** 与 images.lock.json 同源断言：锁内 digest 必须与注册表一致。 */
function readLockFile(): Record<string, string> {
  const raw = readFileSync(join(process.cwd(), 'configs', 'runner-profiles', 'images.lock.json'), 'utf8')
  return JSON.parse(raw) as Record<string, string>
}

describe('RunnerProfile 注册表 — opaque id 解析', () => {
  it('三个内置 opaque id 均可解析（cpu/gpu/isolated-subprocess）', () => {
    for (const id of Object.values(RUNNER_PROFILE_IDS)) {
      const profile = getRunnerProfile(id)
      expect(profile, `registered id ${id}`).not.toBeNull()
      expect(profile!.profile_id).toBe(id)
      expect(profile!.display_name.length).toBeGreaterThan(0)
      expect(profile!.enabled).toBe(true)
    }
    expect(BUILTIN_RUNNER_PROFILES).toHaveLength(3)
    // opaque id 集合与 RUNNER_PROFILE_IDS 完全一致（无漂移）
    expect(BUILTIN_RUNNER_PROFILES.map(p => p.profile_id).sort())
      .toEqual(Object.values(RUNNER_PROFILE_IDS).sort())
  })

  it('解析由注册表完成——Job 只引用 opaque id，记录内无 docker flags/endpoint/凭据', () => {
    const profile = resolveRunnerProfile(RUNNER_PROFILE_IDS.localDockerCpu)
    expect(profile.runner_mode).toBe('local-docker')
    expect(profile.network_policy).toBe('none')
    // .strict()：docker flags / host path / credential / endpoint 出现在记录即拒绝
    for (const foreign of [
      { docker_socket: '/var/run/docker.sock' },
      { hostname: 'worker-1' },
      { ssh_bootstrap: 'user@host:22' },
      { credential: 'secret' },
      { privileged: true },
    ]) {
      expect(() => RunnerProfile.parse({ ...profile, ...foreign }), JSON.stringify(foreign)).toThrow()
    }
  })

  it('只接受 opaque id；已删除的 v1 enum fail closed', () => {
    for (const obsolete of ['local-docker-cpu', 'local-docker-gpu', 'isolated-subprocess']) {
      expect(resolveRunnerProfileId(obsolete)).toBeNull()
      expect(() => resolveRunnerProfile(obsolete)).toThrow(RunnerProfileUnknownError)
    }
    expect(resolveRunnerProfileId(RUNNER_PROFILE_IDS.localDockerCpu)).toBe(RUNNER_PROFILE_IDS.localDockerCpu)
  })

  it('未知 id 拒绝（null / RunnerProfileUnknownError）——调用方必须 fail closed', () => {
    for (const unknown of ['profile_nonexistent_v1', 'profile_local_docker_v1', 'local-docker', 'not-a-profile', '']) {
      expect(getRunnerProfile(unknown), `getRunnerProfile('${unknown}')`).toBeNull()
      expect(resolveRunnerProfileId(unknown), `resolveRunnerProfileId('${unknown}')`).toBeNull()
      expect(() => resolveRunnerProfile(unknown), `resolveRunnerProfile('${unknown}')`).toThrow(RunnerProfileUnknownError)
    }
  })

  it('image digest 与 images.lock.json 对齐（node_fixture 是 local-docker profile 的固定 image）', () => {
    const lock = readLockFile()
    expect(RUNNER_PROFILES_IMAGES_LOCK.node_fixture).toBe(lock.node_fixture)
    expect(RUNNER_PROFILES_IMAGES_LOCK.texlive).toBe(lock.texlive)
    for (const id of [RUNNER_PROFILE_IDS.localDockerCpu, RUNNER_PROFILE_IDS.localDockerGpu]) {
      const profile = getRunnerProfile(id)!
      expect(profile.image).toBe(lock.node_fixture)
      expect(isLockedRunnerImage(profile.image)).toBe(true)
    }
    // 锁外 digest 一律拒绝（RUN-02 语义：profile 只 pin 锁内条目）
    expect(() => RunnerProfile.parse({
      profile_id: 'p', display_name: 'x', runner_mode: 'local-docker',
      image: 'node:22-alpine', network_policy: 'none', limits: { memory_mb: 1024, cpus: 1, pids: 256 },
      capabilities: [], config_hash: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    })).toThrow()
  })

  it('GPU profile 无 GPU 执行路径——明确 CPU-only pin（capability 标注，参数与 CPU profile 一致）', () => {
    const gpu = getRunnerProfile(RUNNER_PROFILE_IDS.localDockerGpu)!
    const cpu = getRunnerProfile(RUNNER_PROFILE_IDS.localDockerCpu)!
    expect(gpu.runner_mode).toBe('local-docker')
    expect(gpu.image).toBe(cpu.image)
    expect(gpu.limits).toEqual(cpu.limits)
    expect(gpu.capabilities).toContain('cpu-only')
    expect(gpu.capabilities).toContain('gpu-requested')
    expect(gpu.display_name).toMatch(/CPU-only/)
  })

  it('isolated-subprocess 限制：trusted-smoke-fixture 专用，非容器 profile', () => {
    const iso = getRunnerProfile(RUNNER_PROFILE_IDS.isolatedSubprocess)!
    expect(iso.runner_mode).toBe('isolated-subprocess')
    expect(isContainerRunnerProfile(iso)).toBe(false)
    expect(iso.capabilities).toContain('trusted-smoke-fixture-only')
    expect(isContainerRunnerProfile(getRunnerProfile(RUNNER_PROFILE_IDS.localDockerCpu)!)).toBe(true)
    expect(isContainerRunnerProfile(getRunnerProfile(RUNNER_PROFILE_IDS.localDockerGpu)!)).toBe(true)
  })
})

describe('config_hash（profile 记录 sha256 pin）', () => {
  it('稳定：同一记录恒同值；且与注册表记录的 config_hash 自洽', () => {
    for (const id of Object.values(RUNNER_PROFILE_IDS)) {
      const profile = getRunnerProfile(id)!
      expect(computeProfileConfigHash(profile)).toBe(profile.config_hash)
      expect(computeProfileConfigHash(profile)).toBe(computeProfileConfigHash(profile))
      expect(profile.config_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
  })

  it('变更敏感：任一字段变更即改变 hash（limits/image/display_name/capabilities）', () => {
    const base = getRunnerProfile(RUNNER_PROFILE_IDS.localDockerCpu)!
    const baseHash = computeProfileConfigHash(base)
    const variants: Array<Partial<typeof base>> = [
      { display_name: 'Local Docker (CPU, renamed)' },
      { image: 'node@sha256:1111111111111111111111111111111111111111111111111111111111111111' },
      { limits: { memory_mb: 2048, cpus: 1, pids: 256 } },
      { limits: { memory_mb: 1024, cpus: 2, pids: 256 } },
      { limits: { memory_mb: 1024, cpus: 1, pids: 512 } },
      { capabilities: ['cpu-only', 'extra'] },
      { enabled: false },
    ]
    for (const variant of variants) {
      expect(computeProfileConfigHash({ ...base, ...variant }), JSON.stringify(variant)).not.toBe(baseHash)
    }
  })

  it('profile_id 属于 hash 输入（换 id 即换 hash——Job pin 绑定具体记录）', () => {
    const base = getRunnerProfile(RUNNER_PROFILE_IDS.localDockerCpu)!
    const renamed = { ...base, profile_id: 'profile_local_docker_cpu_v2' }
    expect(computeProfileConfigHash(renamed)).not.toBe(computeProfileConfigHash(base))
  })

  it('schema 强制合法形状：config_hash 必须 sha256:<64 hex>', () => {
    const base = getRunnerProfile(RUNNER_PROFILE_IDS.localDockerCpu)!
    expect(() => RunnerProfile.parse({ ...base, config_hash: 'deadbeef' })).toThrow()
    expect(() => RunnerProfile.parse({ ...base, config_hash: 'sha256:xyz' })).toThrow()
    expect(() => RunnerProfile.parse({ ...base, config_hash: 'md5:abc' })).toThrow()
  })
})
