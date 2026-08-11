/**
 * CHUNK-01 — 批量分块上传会话领域逻辑（init-grill-upload-models.md §3，
 * 规范性契约；api-contracts.md §16 artifact-stages 目标面）。Pure/static：
 *
 *  - CHUNKED_UPLOAD_DDL: 会话 + chunk 表（upload_sessions/upload_chunks），
 *    扫描前字节只存在于隔离 intake staging（intake-staged/<intake_id>/）；
 *  - intakeQuotaCheck: 单 Intake 预留总量（开放会话 expected_size 之和 +
 *    已 staged  artifact size 之和 ≤ 配额；默认 2 GiB，硬上限 10 GiB）；
 *  - uploadStagedPath: 会话临时文件路径（`<upload_id>.part`）。
 *
 * 协议（2026-08-12 实现选择，记录于 hardening §3 CHUNK-01 行）：
 *  - begin：事务性创建会话并预留配额（超限 413 upload_quota_exceeded）；
 *  - append：`Content-Range: bytes <start>-<end>[/<total>]` +
 *    `X-Chunk-SHA256: <hex>`，body 为原始字节。`start == committed_offset`
 *    才追加；旧范围同字节/hash 重放成功（replayed=true）；gap、overlap
 *    不同内容或 total 不同返回 409；hash 不匹配 422；chunk 超上限 413；
 *  - finalize：offset 必须等于 expected_size（422 chunk_incomplete），
 *    服务端流式重算 size/SHA-256（不一致 422，不产生 IntakeArtifact），
 *    成功注册 IntakeArtifact（staged→scan 前零权威写）；重复 finalize
 *    返回同一 artifact；
 *  - abort 幂等；开放 stage ≥24h（CHUNKED_UPLOAD_SESSION_TTL_MS），
 *    cleanupUploadSessions GC 过期会话。
 * @module @dsh-scholar/research-kernel/chunked-upload
 */

/** 分块上传会话 + chunk DDL — 幂等、独立于业务表。 */
export const CHUNKED_UPLOAD_DDL = `
CREATE TABLE IF NOT EXISTS upload_sessions (
  upload_id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  expected_size INTEGER NOT NULL,
  expected_sha256 TEXT,
  chunk_size INTEGER NOT NULL,
  committed_offset INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  finalized_sha256 TEXT,
  created_by_principal TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_intake ON upload_sessions(intake_id, status);
CREATE TABLE IF NOT EXISTS upload_chunks (
  upload_id TEXT NOT NULL,
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (upload_id, offset)
);
`

/** 会话临时文件：`intake-staged/<intake_id>/<upload_id>.part`。 */
export function uploadStagedPath(intakeStagedRoot: string, intakeId: string, uploadId: string): string {
  return `${intakeStagedRoot}/${intakeId}/${uploadId}.part`
}

/**
 * 单 Intake 配额检查（init-grill-upload-models.md §3：默认 2 GiB，
 * 实例可配置、硬上限 10 GiB）。纯函数：开放会话 expected_size 之和 +
 * 已 staged artifact size 之和必须 ≤ quota；返回用量供 kernel 抛
 * 413 upload_quota_exceeded（本模块保持零 kernel 依赖）。
 */
export function intakeQuotaCheck(input: {
  quotaBytes: number
  openSessions: Array<{ expected_size: number }>
  stagedArtifacts: Array<{ size_bytes: number }>
  /** 本次 begin 拟新增的 expected_size。 */
  additionalBytes: number
}): { used: number; limit: number; exceeded: boolean } {
  const used = input.openSessions.reduce((sum, s) => sum + s.expected_size, 0)
    + input.stagedArtifacts.reduce((sum, a) => sum + a.size_bytes, 0)
  return { used, limit: input.quotaBytes, exceeded: used + input.additionalBytes > input.quotaBytes }
}
