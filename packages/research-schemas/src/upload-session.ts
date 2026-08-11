/**
 * 批量分块上传（chunked upload）会话 schemas（init-grill-upload-models.md
 * §3，规范性契约；api-contracts.md §16 artifact-stages 目标面）。
 *
 * 服务端当前整文件 multipart ≤32 MiB stage 之外，本契约实现分块上传会话：
 * 每个 stage 绑定 intake、project、Principal、文件名、media type、
 * expected size/hash、expiry 与 committed offset；chunk 使用 Content-Range
 * 与 SHA-256 —— `start == committed_offset` 才追加；旧范围同字节/hash 重放
 * 成功且 `replayed=true`；gap、overlap 不同内容或 total 不同返回 409。
 * finalize 只在 offset 等于 expected size 时进行，服务端流式重算完整
 * size/SHA-256；不一致返回 422 且不产生 IntakeArtifact。abort 幂等；开放
 * stage 至少保留 24h 并能查询 offset。扫描前字节只在隔离 Intake staging。
 *
 * 实现选择（2026-08-12，记录于 hardening-v0.2-status.md §3 CHUNK-01 行）：
 * - 端点挂 v1 项目域（/v1/projects/{id}/intake/{iid}/upload-sessions*），
 *   BFF 全量透传 /v1/*；api-contracts.md §16 的 /v2/intakes 面为同一协议
 *   的目标形状，落地时只换路径前缀；
 * - chunk 默认 8 MiB、实例可收紧、最大 32 MiB；单 Intake 预留总量默认
 *   2 GiB、硬上限 10 GiB（kernel 构造选项可覆盖）；
 * - 每个 chunk 携带 `X-Chunk-SHA256` 头 + `Content-Range: bytes a-b[/total]`
 *   头，body 为原始字节；服务端复算 sha256 并与头比对（不一致 422）；
 * - finalize 流式重算整体 sha256/size，成功后在 intake staging 目录注册
 *   IntakeArtifact（sha256 命名 .part），会话状态 → finalized；重复
 *   finalize 返回同一 artifact。
 * @module @dsh-scholar/research-schemas
 */

import { z } from 'zod'

/** 默认 chunk 大小（init-grill-upload-models.md §3：8 MiB）。 */
export const CHUNKED_UPLOAD_DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024

/** chunk 硬上限（§3：最大 32 MiB）。 */
export const CHUNKED_UPLOAD_MAX_CHUNK_BYTES = 32 * 1024 * 1024

/** 默认单 Intake 预留总量（§3：2 GiB）。 */
export const INTAKE_UPLOAD_QUOTA_DEFAULT_BYTES = 2 * 1024 * 1024 * 1024

/** 单 Intake 预留总量硬上限（§3：10 GiB）。 */
export const INTAKE_UPLOAD_QUOTA_MAX_BYTES = 10 * 1024 * 1024 * 1024

/** 开放 stage 最短保留期（§3：≥24h）。 */
export const CHUNKED_UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000

/** 会话状态机。 */
export const UploadSessionStatus = z.enum(['open', 'finalized', 'aborted', 'expired'])
export type UploadSessionStatus = z.infer<typeof UploadSessionStatus>

/** 分块上传会话（服务端权威形态）。 */
export const UploadSession = z.object({
  upload_id: z.string().min(1),
  intake_id: z.string().min(1),
  project_id: z.string().min(1),
  /** Plain basename（validateUploadFileName 契约）。 */
  file_name: z.string().min(1),
  media_type: z.string().default('application/octet-stream'),
  /** 期望总字节数（finalize 前必须 offset 到达此处）。 */
  expected_size: z.number().int().nonnegative(),
  /** 可选整体 sha256（客户端 hashing 阶段提供；服务端 finalize 复算比对）。 */
  expected_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  /** 协商后的 chunk 上限（≤ CHUNKED_UPLOAD_MAX_CHUNK_BYTES）。 */
  chunk_size: z.number().int().positive(),
  /** 已提交字节数（= 下一个可追加 offset）。 */
  committed_offset: z.number().int().nonnegative().default(0),
  status: UploadSessionStatus,
  /** finalize 后服务端复算的整体 sha256（幂等重放用）。 */
  finalized_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  created_by: z.string().default(''),
  created_at: z.string(),
  updated_at: z.string(),
  /** 开放 stage 过期时间（浏览器刷新/断线后 ≥24h 内可续传）。 */
  expires_at: z.string(),
}).strict()
export type UploadSession = z.infer<typeof UploadSession>

/** 一次 chunk 追加的结果（200；replay 时 replayed=true）。 */
export const ChunkAppendResult = z.object({
  upload_id: z.string().min(1),
  committed_offset: z.number().int().nonnegative(),
  replayed: z.boolean().default(false),
}).strict()
export type ChunkAppendResult = z.infer<typeof ChunkAppendResult>

/** 会话查询视图（队列投影：offset/expiry/状态）。 */
export const UploadSessionView = z.object({
  upload_id: z.string().min(1),
  intake_id: z.string().min(1),
  file_name: z.string().min(1),
  media_type: z.string().default('application/octet-stream'),
  expected_size: z.number().int().nonnegative(),
  expected_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  chunk_size: z.number().int().positive(),
  committed_offset: z.number().int().nonnegative(),
  status: UploadSessionStatus,
  finalized_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  expires_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict()
export type UploadSessionView = z.infer<typeof UploadSessionView>

/** 创建会话请求。 */
export const UploadSessionBeginInput = z.object({
  file_name: z.string().min(1).max(512),
  media_type: z.string().max(256).optional(),
  expected_size: z.number().int().nonnegative(),
  /** 可选整体 sha256（客户端 hashing 完成时提供）。 */
  expected_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** 请求的 chunk 大小（服务端 clamp 到 [1, 32 MiB]）。 */
  chunk_size: z.number().int().positive().optional(),
}).strict()
export type UploadSessionBeginInput = z.infer<typeof UploadSessionBeginInput>

/** 稳定错误码（CHUNK-01 分块上传）。 */
export const CHUNKED_UPLOAD_ERROR_CODES = [
  'upload_session_not_found',
  'upload_session_closed',
  'chunk_offset_conflict',
  'chunk_overlap_conflict',
  'chunk_gap',
  'chunk_hash_mismatch',
  'chunk_range_mismatch',
  'chunk_total_mismatch',
  'chunk_too_large',
  'chunk_beyond_size',
  'chunk_incomplete',
  'chunk_size_mismatch',
  'upload_quota_exceeded',
  'invalid_content_range',
  'invalid_chunk_hash_header',
] as const
export type ChunkedUploadErrorCode = typeof CHUNKED_UPLOAD_ERROR_CODES[number]

/**
 * 解析 RFC 7233 Content-Range：`bytes <start>-<end>[/<total>]`。
 * 返回 null 表示格式非法（HTTP 层映射 422 invalid_content_range）。
 */
export function parseContentRange(header: string): { start: number; end: number; total: number | null } | null {
  const match = /^bytes\s+(\d+)-(\d+)(?:\/(\d+|\*))?$/.exec(header.trim())
  if (match === null) return null
  const start = Number(match[1])
  const end = Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  if (end < start) return null
  let total: number | null = null
  if (match[3] !== undefined && match[3] !== '*') {
    total = Number(match[3])
    if (!Number.isSafeInteger(total)) return null
  }
  return { start, end, total }
}
