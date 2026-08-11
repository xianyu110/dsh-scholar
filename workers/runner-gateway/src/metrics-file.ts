/**
 * §12.5 (SCH-EXEC-002) — MetricsFileV1 共享实现（本地 runner 与远端 Agent
 * 复用同一契约：hardening-v0.2-status.md §5 RUN-REMOTE-01 两行）。
 *
 * 本地执行路径（index.ts executeJob）与远端代理（remote-agent.ts
 * executeClaim）必须对容器写回的 metrics 文件做完全相同的解析与严格
 * provenance 校验（run_id/contract_id/seed/duplicate/contract 名），
 * manifest 的 metrics_artifact/seed facts 同源。原实现位于 index.ts，
 * 本轮抽取为共享模块（index.ts 保持 re-export，公共 API 不变）。
 * @module @dsh-scholar/runner-gateway/metrics-file
 */

import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/**
 * §4 P0 (RUN-02): resolve the output-contract metrics path to a readable file
 * STRICTLY inside the outputs directory. `../` escapes, absolute paths and
 * symlinks pointing outside outputs return null — a malicious job must never
 * read host files through the metrics path. The caller treats null as a
 * failed output-contract validation.
 */
export function resolveMetricsFileWithin(outputsDir: string, metricsPath: string): string | null {
  const rel = metricsPath.replace(/^\/outputs\/?/, '')
  const absOutputs = resolve(outputsDir)
  const target = resolve(absOutputs, rel)
  if (!target.startsWith(`${absOutputs}${sep}`)) return null
  try {
    // realpath re-check: a container-created symlink may resolve outside.
    const real = realpathSync(target)
    if (!real.startsWith(`${realpathSync(absOutputs)}${sep}`)) return null
    return real
  } catch {
    return null // missing/unreadable file
  }
}

/** Deterministic metrics extraction from stdout JSON-lines (`{"metric":...,"value":...}`). */
export function extractMetrics(stdout: string): Array<{ metric: string; value: number; seed?: number }> {
  const metrics: Array<{ metric: string; value: number; seed?: number }> = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as { metric?: unknown; value?: unknown; seed?: unknown }
      if (typeof parsed.metric === 'string' && typeof parsed.value === 'number') {
        metrics.push({
          metric: parsed.metric,
          value: parsed.value,
          ...typeof parsed.seed === 'number' && { seed: parsed.seed },
        })
      }
    } catch { /* not a metrics line */ }
  }
  return metrics
}

/**
 * §12.5 (SCH-EXEC-002): parse the fixed-schema metrics file written
 * in-container to the output contract path:
 * `{schema_version: 1, run_id, contract_id, seed, metrics: [{name, value, unit}]}`.
 * Returns null when the file is absent or does not match the schema (the
 * caller then falls back to legacy stdout extraction).
 */
export interface MetricsFileRecord {
  schema_version: number
  run_id?: string
  contract_id?: string
  seed?: number
  metrics: Array<{ name?: string; metric?: string; value: number; unit?: string; seed?: number }>
}

export function parseMetricsFile(content: string): MetricsFileRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as { schema_version?: unknown; run_id?: unknown; contract_id?: unknown; seed?: unknown; metrics?: unknown }
  if (record.schema_version !== 1 || !Array.isArray(record.metrics)) return null
  const entries = record.metrics
    .map((m): { name?: string; metric?: string; value: number; unit?: string; seed?: number } | null => {
      if (typeof m !== 'object' || m === null) return null
      const entry = m as { name?: unknown; metric?: unknown; value?: unknown; unit?: unknown; seed?: unknown }
      if (typeof entry.value !== 'number') return null
      const name = typeof entry.name === 'string' ? entry.name : typeof entry.metric === 'string' ? entry.metric : undefined
      if (name === undefined) return null
      return {
        name,
        value: entry.value,
        ...typeof entry.unit === 'string' && { unit: entry.unit },
        ...typeof entry.seed === 'number' && { seed: entry.seed },
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
  if (entries.length === 0) return null
  return {
    schema_version: 1,
    ...typeof record.run_id === 'string' && { run_id: record.run_id },
    ...typeof record.contract_id === 'string' && { contract_id: record.contract_id },
    ...typeof record.seed === 'number' && { seed: record.seed },
    metrics: entries,
  }
}

/**
 * §12.5 (P0, RUN-01c): strict provenance validation of a MetricsFileV1 record
 * for SECURE kinds — mirrors the local runner's inline validation exactly.
 * Returns the problem list (empty = valid). The caller must treat any problem
 * as a failed completion (never succeeded).
 */
export function validateMetricsFileRecord(
  record: MetricsFileRecord,
  opts: { run_id: string; contract_id: string | null; seed: number | null; contract_metrics?: unknown },
): string[] {
  const problems: string[] = []
  if (record.run_id !== undefined && record.run_id !== opts.run_id) {
    problems.push(`run_id mismatch: file '${record.run_id}' != execution '${opts.run_id}'`)
  }
  if (opts.contract_id !== null && record.contract_id !== undefined && record.contract_id !== opts.contract_id) {
    problems.push(`contract_id mismatch: file '${record.contract_id}' != job '${opts.contract_id}'`)
  }
  if (record.seed === undefined || !Number.isFinite(record.seed)) {
    problems.push('seed missing or not a finite number')
  } else if (opts.seed !== null && record.seed !== opts.seed) {
    problems.push(`seed mismatch: file ${record.seed} != job seed ${opts.seed}`)
  }
  for (const m of record.metrics) {
    if (m.value === undefined || !Number.isFinite(m.value)) {
      problems.push(`non-finite metric value for '${m.name ?? m.metric ?? '?'}'`)
    }
  }
  const names = record.metrics.map(m => m.name ?? m.metric ?? '')
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  if (dupes.length > 0) problems.push(`duplicate metric name(s): ${[...new Set(dupes)].join(', ')}`)
  if (Array.isArray(opts.contract_metrics)) {
    const allowed = new Set(opts.contract_metrics.filter((x): x is string => typeof x === 'string'))
    const foreign = names.filter(n => n !== '' && !allowed.has(n))
    if (foreign.length > 0) problems.push(`metric(s) not in contract: ${foreign.join(', ')}`)
  }
  return problems
}

/**
 * §12.5: the manifest's metrics_artifact content (MetricsFileV1 record →
 * canonical JSON with the top-level seed injected into entries that lack
 * their own). Identical shape for local and remote manifests.
 */
export function metricsArtifactContent(
  record: MetricsFileRecord | null,
  fallback: { run_id: string; job_id: string; contract_id: string | null; metrics: Array<{ metric: string; value: number; seed?: number }> },
): string {
  if (record !== null) {
    return JSON.stringify({
      schema_version: 1,
      run_id: record.run_id ?? fallback.run_id,
      job_id: fallback.job_id,
      contract_id: record.contract_id ?? fallback.contract_id ?? undefined,
      seed: record.seed,
      metrics: record.metrics.map(m => ({
        name: m.name ?? m.metric ?? '',
        value: m.value,
        unit: m.unit ?? '',
        seed: m.seed ?? record.seed,
      })),
      source: 'metrics-file',
    }, null, 2)
  }
  return JSON.stringify({ run_id: fallback.run_id, job_id: fallback.job_id, metrics: fallback.metrics }, null, 2)
}
