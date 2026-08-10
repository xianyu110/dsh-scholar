/**
 * RUN-REMOTE-01 — 代码快照物化共享工具（§11.3 SCH-EXEC-002）。
 *
 * unpackCodeSnapshot / materializeCodeSnapshot 原为 runner-gateway index.ts
 * 内部实现；远端 Agent 的 CAS 输入物化（拉取→复算 hash→展开进 sandbox）需要
 * 同一契约，因此迁入本模块，index.ts 与 remote-agent.ts 共用（index.ts 保持
 * re-export，既有导入路径不变）。
 * @module @dsh-scholar/runner-gateway/snapshot-materialize
 */

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/**
 * §11.3 (SCH-EXEC-002): unpack a code-snapshot archive artifact (JSON
 * `{schema_version: 1, files: {rel: {sha256, content_base64}}}`) into
 * `Map<relativePath, Buffer>`. Verifies each entry's sha256 — a tampered or
 * truncated archive is rejected instead of silently materialized.
 */
export function unpackCodeSnapshot(content: string | Buffer): Map<string, Buffer> {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.isBuffer(content) ? content.toString('utf8') : content)
  } catch (error) {
    throw new Error(`code snapshot archive is not valid JSON: ${(error as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('code snapshot archive must be a JSON object')
  const record = parsed as { schema_version?: unknown; files?: unknown }
  if (record.schema_version !== 1) {
    throw new Error(`code snapshot archive has unsupported schema_version: ${String(record.schema_version)}`)
  }
  if (typeof record.files !== 'object' || record.files === null) {
    throw new Error('code snapshot archive is missing the files map')
  }
  const files = new Map<string, Buffer>()
  for (const [rel, info] of Object.entries(record.files)) {
    if (typeof rel !== 'string' || rel === '' || rel.startsWith('/') || rel.startsWith('..')) {
      throw new Error(`code snapshot archive contains an unsafe path: ${rel}`)
    }
    const entry = info as { sha256?: unknown; content_base64?: unknown }
    if (typeof entry.content_base64 !== 'string') continue
    const buf = Buffer.from(entry.content_base64, 'base64')
    if (typeof entry.sha256 === 'string' && entry.sha256 !== '') {
      const actual = createHash('sha256').update(buf).digest('hex')
      if (actual !== entry.sha256) {
        throw new Error(`code snapshot integrity mismatch for ${rel}: got ${actual}, archive claims ${entry.sha256}`)
      }
    }
    files.set(rel, buf)
  }
  return files
}

/**
 * §11.3 (SCH-EXEC-002): write an unpacked code snapshot into `workDir` with
 * path-traversal protection (every target must resolve inside workDir).
 * The container mounts workDir read-only at /work — this is the ONLY code
 * the Runner executes; agent host dirs are never mounted.
 */
export function materializeCodeSnapshot(files: Map<string, Buffer>, workDir: string): number {
  const absRoot = resolve(workDir)
  let count = 0
  for (const [rel, buf] of files) {
    const target = resolve(absRoot, rel)
    if (!target.startsWith(`${absRoot}${sep}`) && target !== absRoot) {
      throw new Error(`code snapshot path escapes workDir: ${rel}`)
    }
    mkdirSync(resolve(target, '..'), { recursive: true })
    // The container mounts /work read-only as uid 65534: directories need
    // traversal (+x) for ALL — mkdirSync honors umask (0077 → 0700), so force
    // 0755 on every created directory.
    chmodSync(resolve(target, '..'), 0o755)
    writeFileSync(target, buf)
    // The container runs as uid 65534 against a READ-ONLY /work mount:
    // umask (e.g. 0077) must not strip the world-read bits, or the
    // container cannot open the materialized files (EACCES).
    chmodSync(target, 0o644)
    count++
  }
  return count
}
