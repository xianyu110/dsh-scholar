/**
 * WORK-01 (hardening-v0.2-status.md §3/§4) — VS Code-style generic Workspace
 * wire schemas.
 *
 * A unified workspace interface for the general code/scratch tree: every
 * node carries path/kind/media/size/revision/etag/hash, every mutation is a
 * versioned CAS write (expected version/etag → 409 on conflict) and binary
 * content lives in the artifact CAS (blob_sha256) while text content stays
 * inline — the exact revision/etag/CAS semantics the TeX workspace already
 * implements (tex-workspace.ts is the facade reference, tex-facade.ts maps
 * it onto this interface). TeX documents are a domain facade over a
 * `manuscript`-kind workspace subtree; they must never maintain a second
 * byte/revision authority (storage-migrations.md §5.1).
 * @module @dsh-scholar/research-schemas/workspace
 */

import { z } from 'zod'

/** Workspace kinds (api-contracts.md §17). */
export const WorkspaceKind = z.enum(['code', 'manuscript', 'scratch'])
export type WorkspaceKind = z.infer<typeof WorkspaceKind>

/** Node kinds: `dir` nodes are projected from path prefixes (implied); only
 * `file` nodes are stored. */
export const WorkspaceNodeKind = z.enum(['file', 'dir'])
export type WorkspaceNodeKind = z.infer<typeof WorkspaceNodeKind>

/** Durable mutation ops (workspace_ops history). */
export const WorkspaceOpType = z.enum(['create', 'write', 'delete', 'move'])
export type WorkspaceOpType = z.infer<typeof WorkspaceOpType>

/** Workspace header row. `revision` bumps on every mutation. */
export const WorkspaceInfo = z.object({
  workspace_id: z.string().regex(/^ws_[a-z0-9_]+$/),
  project_id: z.string().min(1),
  kind: WorkspaceKind,
  name: z.string().min(1),
  revision: z.number().int().nonnegative().default(1),
  created_at: z.string(),
  updated_at: z.string(),
})
export type WorkspaceInfo = z.infer<typeof WorkspaceInfo>

/**
 * One node of the file tree. `etag` is the strong CAS tag
 * (`"<version>-<sha256-prefix>"`, see workspaceEtag); writes must carry the
 * expected version or etag and get 409 on mismatch. `content` is present
 * only for text reads; binary nodes carry blob_sha256 (artifact CAS) and are
 * read-only for text writes (replaced via the binary upload path).
 */
export const WorkspaceNode = z.object({
  path: z.string().min(1),
  kind: WorkspaceNodeKind,
  /** true when the node stores bytes in the artifact CAS, not inline text. */
  binary: z.boolean().default(false),
  media: z.string().default('text/plain'),
  size: z.number().int().nonnegative(),
  /** Per-path version (bumped on every write of that path). */
  version: z.number().int().nonnegative(),
  etag: z.string().min(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/, 'hash must be a sha256 hex digest'),
  /** Text content (inline nodes only; null/absent for dirs and binary). */
  content: z.string().nullable().default(null),
  /** Binary nodes: artifact CAS blob reference (sha256 hex). */
  blob_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
})
export type WorkspaceNode = z.infer<typeof WorkspaceNode>

/** One recorded mutation (workspace_ops / history projection). */
export const WorkspaceOp = z.object({
  seq: z.number().int().nonnegative(),
  op: WorkspaceOpType,
  path: z.string().min(1),
  from_path: z.string().nullable().default(null),
  /** Node version after the op (CAS target). */
  version: z.number().int().nonnegative().nullable().default(null),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  at: z.string(),
})
export type WorkspaceOp = z.infer<typeof WorkspaceOp>

/** One workspace revision (history projection, newest first). */
export const WorkspaceRevision = z.object({
  workspace_id: z.string().min(1),
  revision: z.number().int().positive(),
  at: z.string(),
  ops: z.array(WorkspaceOp),
})
export type WorkspaceRevision = z.infer<typeof WorkspaceRevision>

/** Text write/create (POST/PUT files). `expected_version`/`expected_etag`:
 * 0 = create-if-absent (create), N/etag = must match (else 409). */
export const WorkspaceWriteRequest = z.object({
  path: z.string().min(1),
  content: z.string(),
  expected_version: z.number().int().nonnegative().optional(),
  expected_etag: z.string().optional(),
}).strict()
export type WorkspaceWriteRequest = z.infer<typeof WorkspaceWriteRequest>

/** Binary node record (bytes go through the artifact CAS — the server
 * computes sha256, the client never declares it). */
export const WorkspaceBinaryUpload = z.object({
  path: z.string().min(1),
  media: z.string().default('application/octet-stream'),
  expected_version: z.number().int().nonnegative().optional(),
  expected_etag: z.string().optional(),
}).strict()
export type WorkspaceBinaryUpload = z.infer<typeof WorkspaceBinaryUpload>

/** Delete with version CAS. */
export const WorkspaceDeleteRequest = z.object({
  path: z.string().min(1),
  expected_version: z.number().int().nonnegative().optional(),
  expected_etag: z.string().optional(),
}).strict()
export type WorkspaceDeleteRequest = z.infer<typeof WorkspaceDeleteRequest>

/** Move/rename: expected CAS guards the SOURCE. */
export const WorkspaceMoveRequest = z.object({
  from_path: z.string().min(1),
  to_path: z.string().min(1),
  expected_version: z.number().int().nonnegative().optional(),
  expected_etag: z.string().optional(),
}).strict()
export type WorkspaceMoveRequest = z.infer<typeof WorkspaceMoveRequest>

/** Strong etag of a node: `"<version>-<sha256[0..12]>"`. Deterministic —
 * identical (version, hash) always yields the same etag, and any content or
 * version change yields a different one. */
export function workspaceEtag(version: number, sha256Hex: string): string {
  return `"${version}-${sha256Hex.slice(0, 12)}"`
}
