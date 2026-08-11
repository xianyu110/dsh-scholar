/**
 * MODEL-01 — Model Provider 注册表领域逻辑（init-grill-upload-models.md §4，
 * 规范性契约；api-contracts.md §19 目标面）。Pure/static 构建块：
 *
 *  - PROVIDER_DDL: instance/global Provider 表（model_providers +
 *    model_provider_models），Project 只能引用 opaque provider_id/model_id；
 *  - validateSecretRefInput: SecretRef 严格 schema 之外的显式负向检查
 *    （value/token/password/credential 字段 → 稳定错误码）；
 *  - validateProviderBaseUrl: 服务端 URL 解析 + scheme/host/SSRF 校验
 *    （非法 scheme/userinfo/私有 IP/保留主机名 fail closed）；
 *  - providerConfigHash: 描述符（含 credential 元数据）canonical sha256，
 *    绑定/运行中任务快照 revision+hash；
 *  - providerRedacted: 浏览器响应形态 —— SecretRef metadata + available
 *    布尔，绝不返回 secret value（本模块从不存储 value，无处可泄）；
 *  - secretRefAvailable: file scheme 在服务端 secret root 的存在性检查；
 *    keyring/vault 无 resolver → false（如实记录）。
 *
 * 连接期防护（真实模型调用属 NOT_RUN_MANUAL_PENDING）：传输层必须
 * 不跟随 redirect、不读代理 env、并在 DNS 解析/连接时复检目标地址不在
 * 私有/保留网段（DNS rebinding 防护）；本模块提供静态校验，连接期检查
 * 由尚未实现的模型客户端承担（记录于 hardening §3 MODEL-01 行）。
 * @module @dsh-scholar/research-kernel/provider
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { KernelError } from './kernel.js'
import {
  type ProviderDescriptor,
  type ProviderCreateInput,
  type ProviderUpdateInput,
  type SecretRef,
  ProviderModel,
} from '@dsh-scholar/research-schemas'

/** Provider 注册表 DDL — 幂等、独立于业务表。 */
export const PROVIDER_DDL = `
CREATE TABLE IF NOT EXISTS model_providers (
  provider_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom',
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  capabilities TEXT NOT NULL DEFAULT '["chat"]',
  credential_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_provider_models (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT,
  capabilities TEXT NOT NULL DEFAULT '["chat"]',
  model_revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (provider_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_model_provider_models_provider ON model_provider_models(provider_id);
`

/** SecretRef 字段名黑名单（显式负向，稳定错误码 secret_value_forbidden）。 */
const SECRET_VALUE_FIELDS = ['value', 'token', 'password', 'api_key', 'apikey', 'secret', 'credential', 'credentials']

/**
 * SecretRef 输入负向检查：schema 层 .strict() 已拒绝未知键；这里再点名
 * 拒绝 value/token/password/credential 字段（fail closed，绝不接受内联
 * secret 提交）。
 */
export function validateSecretRefInput(credential: SecretRef): void {
  const obj = credential as unknown as Record<string, unknown>
  for (const forbidden of SECRET_VALUE_FIELDS) {
    if (forbidden in obj) {
      throw new KernelError(422, 'secret_value_forbidden',
        `SecretRef must not carry a '${forbidden}' field — secrets are resolved server-side, never submitted`)
    }
  }
  if (credential.name === '' || credential.name.length > 512) {
    throw new KernelError(422, 'secret_ref_invalid', 'SecretRef name must be 1-512 characters')
  }
}

/** IPv4 私有/保留网段（RFC 1918/3927/5737/6890 等）。 */
const PRIVATE_IPV4: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8  unspecified
  [0x0a000000, 8], // 10.0.0.0/8  RFC1918
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local
  [0xac100000, 12], // 172.16.0.0/12 RFC1918
  [0xc0000000, 24], // 192.0.0.0/24
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
  [0xc0a80000, 16], // 192.168.0.0/16 RFC1918
  [0xc6120000, 15], // 198.18.0.0/15 benchmark
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved
]

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return true // malformed → fail closed
  const value = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
  for (const [base, bits] of PRIVATE_IPV4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    if ((value & mask) === (base & mask)) return true
  }
  return false
}

/** IPv6 保留段：loopback ::1、unspecified ::、link-local fe80::/10、ULA fc00::/7。 */
const PRIVATE_IPV6: Array<[string, number]> = [
  ['0000:0000:0000:0000:0000:0000:0000:0000', 128], // ::
  ['0000:0000:0000:0000:0000:0000:0000:0001', 128], // ::1
  ['fe80:0000:0000:0000:0000:0000:0000:0000', 10], // fe80::/10
  ['fc00:0000:0000:0000:0000:0000:0000:0000', 7], // fc00::/7
  ['ff00:0000:0000:0000:0000:0000:0000:0000', 8], // ff00::/8 multicast
]

function expandIpv6(ip: string): string | null {
  if (!ip.includes(':')) return null
  let head = ip
  let tail = ''
  const doubleColon = ip.indexOf('::')
  if (doubleColon >= 0) {
    head = ip.slice(0, doubleColon)
    tail = ip.slice(doubleColon + 2)
  }
  const headParts = head === '' ? [] : head.split(':')
  const tailParts = tail === '' ? [] : tail.split(':')
  const missing = 8 - headParts.length - tailParts.length
  if (doubleColon >= 0 && missing < 1) return null
  if (doubleColon < 0 && missing !== 0) return null
  const all = [...headParts, ...Array(Math.max(0, missing)).fill('0'), ...tailParts]
  if (all.length !== 8) return null
  return all.map(p => p.padStart(4, '0')).join(':')
}

function isPrivateIpv6(ip: string): boolean {
  const expanded = expandIpv6(ip)
  if (expanded === null) return true // malformed → fail closed
  const ipv4Mapped = /^0000:0000:0000:0000:0000:ffff:([0-9a-f]{4}):([0-9a-f]{4})$/.exec(expanded)
  if (ipv4Mapped !== null) {
    const a = parseInt(ipv4Mapped[1]!, 16)
    const b = parseInt(ipv4Mapped[2]!, 16)
    return isPrivateIpv4(`${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`)
  }
  const valueBig = BigInt('0x' + expanded.replaceAll(':', ''))
  for (const [base, bits] of PRIVATE_IPV6) {
    if (bits === 128) {
      if (expanded === base) return true
      continue
    }
    // Prefix match on the TOP bits: mask keeps the upper `bits` bits.
    const mask = ((BigInt(1) << BigInt(bits)) - BigInt(1)) << BigInt(128 - bits)
    const baseBig = BigInt('0x' + base.replaceAll(':', ''))
    if ((valueBig & mask) === (baseBig & mask)) return true
  }
  return false
}

/** 实例可配置的主机 allowlist（DNS 名；默认空 = 只允许 https + 非私有主机）。 */
export interface ProviderUrlAllowlist {
  /** 允许的 DNS 主机名（精确匹配；如 "models.example.com"）。 */
  hosts?: string[]
  /** 允许 loopback（http://127.0.0.1 / ::1 / localhost）——仅本地开发代理。 */
  allowLoopback?: boolean
}

/**
 * 服务端 base URL 静态校验（init-grill-upload-models.md §4 / §5 示例）：
 *  - scheme 必须 https（allowLoopback 时允许 http 用于 loopback）；
 *  - URL 不得携带 userinfo（provider_url_userinfo_rejected）；
 *  - IP 字面量不得位于私有/保留网段（provider_url_ssrf_rejected）；
 *  - DNS 主机必须命中 allowlist（否则 fail closed —— 本环境不做真实
 *    DNS 解析；连接期 rebinding 复检由模型客户端承担，NOT_RUN）。
 *  - 非法 URL/非法 scheme → provider_url_malformed / provider_url_scheme_invalid。
 */
export function validateProviderBaseUrl(baseUrl: string, allowlist: ProviderUrlAllowlist = {}): void {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new KernelError(422, 'provider_url_malformed', `provider base_url is not a valid URL`)
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (scheme !== 'https' && scheme !== 'http') {
    throw new KernelError(422, 'provider_url_scheme_invalid', `provider base_url scheme '${scheme}' is not allowed (https only; http only for loopback when allowlisted)`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new KernelError(422, 'provider_url_userinfo_rejected', 'provider base_url must not carry userinfo (user:pass@) — credentials go through SecretRef only')
  }
  if (parsed.hostname === '') {
    throw new KernelError(422, 'provider_url_malformed', 'provider base_url has no host')
  }
  const hostname = parsed.hostname.toLowerCase()
  // Strip IPv6 brackets.
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const allow = new Set((allowlist.hosts ?? []).map(h => h.toLowerCase()))
  const isLoopbackHost = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (scheme === 'http' && !(allowLoopback(allowlist) && isLoopbackHost)) {
    throw new KernelError(422, 'provider_url_scheme_invalid', 'http base_url is only allowed for allowlisted loopback hosts')
  }
  // allowLoopback explicitly whitelists loopback targets (dev proxies) —
  // the SSRF private-range check below must then NOT reject them.
  if (allowLoopback(allowlist) && isLoopbackHost) return
  if (host.includes(':')) {
    // IPv6 literal (brackets stripped).
    if (isPrivateIpv6(host)) {
      throw new KernelError(422, 'provider_url_ssrf_rejected', 'provider base_url resolves to a private/reserved IPv6 range — refused (SSRF fail closed)')
    }
    return
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4 !== null) {
    if (isPrivateIpv4(host)) {
      throw new KernelError(422, 'provider_url_ssrf_rejected', 'provider base_url resolves to a private/reserved IPv4 range — refused (SSRF fail closed)')
    }
    return
  }
  // DNS hostname: must be allowlisted (fail closed; no DNS resolution here).
  if (!allow.has(host)) {
    throw new KernelError(422, 'provider_url_ssrf_rejected',
      `provider base_url host '${host}' is not in the instance allowlist — DNS rebinding protection requires an explicit entry (fail closed)`)
  }
}

function allowLoopback(allowlist: ProviderUrlAllowlist): boolean {
  return allowlist.allowLoopback === true
}

/** canonical 描述符 hash（含 credential 元数据；不含任何 value）。 */
export function providerConfigHash(descriptor: {
  provider_id: string
  display_name: string
  kind: string
  base_url: string
  enabled: boolean
  capabilities: string[]
  models: Array<{ model_id: string; display_name?: string; capabilities: string[]; revision?: number }>
  credential: SecretRef
}): string {
  const canonical = JSON.stringify({
    provider_id: descriptor.provider_id,
    display_name: descriptor.display_name,
    kind: descriptor.kind,
    base_url: descriptor.base_url,
    enabled: descriptor.enabled,
    capabilities: [...descriptor.capabilities].sort(),
    models: [...descriptor.models]
      .map(m => ({ model_id: m.model_id, display_name: m.display_name ?? '', capabilities: [...m.capabilities].sort(), revision: m.revision ?? 1 }))
      .sort((a, b) => (a.model_id < b.model_id ? -1 : a.model_id > b.model_id ? 1 : 0)),
    credential: { scheme: descriptor.credential.scheme, name: descriptor.credential.name, version: descriptor.credential.version ?? null, scope: descriptor.credential.scope ?? null },
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/** 模型目录条目校验（provider 目录内 model_id 唯一由 PK 保证）。 */
export function parseProviderModels(models: ProviderCreateInput['models'] | ProviderUpdateInput['models'] | undefined): Array<ReturnType<typeof ProviderModel.parse>> {
  if (models === undefined) return []
  const seen = new Set<string>()
  const out: Array<ReturnType<typeof ProviderModel.parse>> = []
  for (const m of models) {
    if (seen.has(m.model_id)) {
      throw new KernelError(422, 'model_unknown', `duplicate model_id '${m.model_id}' in provider models catalog`)
    }
    seen.add(m.model_id)
    out.push(ProviderModel.parse({ ...m, revision: 1 }))
  }
  return out
}

/**
 * 浏览器响应形态：credential → {scheme,name,version?,scope?,available}。
 * `name` 属配置数据保持原文（init-grill-upload-models.md §4）；value 无处
 * 存在。available：file scheme 检查 secret root 下的存在性；keyring/vault
 * 无 resolver → false（如实记录，不伪装）。
 */
export function providerRedacted(
  descriptor: ProviderDescriptor,
  secretRoot: string | null,
): Omit<ProviderDescriptor, 'credential'> & {
  credential: SecretRef & { available: boolean }
} {
  return {
    ...descriptor,
    credential: {
      ...descriptor.credential,
      available: secretRefAvailable(descriptor.credential, secretRoot),
    },
  }
}

/** SecretRef 可用性（服务端视角，无 secret 值参与）。 */
export function secretRefAvailable(ref: SecretRef, secretRoot: string | null): boolean {
  if (ref.scheme === 'file') {
    if (secretRoot === null || secretRoot === '') return false
    // 只做存在性检查；路径拼接在服务端 secret root 内（name 不得越界）。
    const safeName = ref.name.replace(/^[/\\]+/, '').split('/').filter(s => s !== '' && s !== '..').join('/')
    if (safeName === '') return false
    try {
      return existsSync(join(secretRoot, safeName))
    } catch {
      return false
    }
  }
  // keyring/vault：本实例无 resolver（如实记录）。
  return false
}
