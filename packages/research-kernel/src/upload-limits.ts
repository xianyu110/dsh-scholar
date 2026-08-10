/**
 * UPLOAD-01 fixed upload limits (dependency-free so both the kernel and the
 * multipart parser can import them without a cycle). Documented in
 * api-contracts.md §1/§7 and acceptance-tests.md §3.1.
 * @module @dsh-scholar/research-kernel/upload-limits
 */

/** Hard cap for ONE uploaded file (api-contracts.md §1: "Artifact upload 可单独配置至 32 MiB"). */
export const UPLOAD_MAX_FILE_BYTES = 32 * 1024 * 1024

/**
 * Multipart envelope overhead allowance (headers + boundaries + trailing
 * CRLF). The body cap is the file cap plus this allowance, so a file at the
 * exact 32 MiB limit still fits while an oversized file always trips 413.
 */
export const UPLOAD_BODY_OVERHEAD_BYTES = 1024 * 1024

/** Total request-body cap for multipart uploads (file + envelope). */
export const UPLOAD_MAX_BODY_BYTES = UPLOAD_MAX_FILE_BYTES + UPLOAD_BODY_OVERHEAD_BYTES

/** Default staged-upload TTL before cleanupStagedUploads collects them. */
export const STAGED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000
