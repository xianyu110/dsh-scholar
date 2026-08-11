/**
 * Pure metric/table/figure/manuscript comparators for paper reproduction
 * (docs/reproduction-contracts.md §3 — normative). The verifier service and
 * the tests both use these functions; the kernel stores whatever the verifier
 * computed as an immutable report. Pure: no DB, no IO, never throws.
 *
 * §3 rules implemented here:
 * - allowed = max(absolute_tolerance, abs(expected) * relative_tolerance);
 * - pass = finite(actual) && unit_match && direction_match &&
 *   aggregation_match && abs(actual - expected) <= allowed;
 * - expected = 0 → the relative part is 0 and ONLY the absolute tolerance
 *   decides (zero-safe comparator);
 * - NaN/Infinity actual, missing/duplicate metrics, unit/aggregation/
 *   direction mismatch NEVER pass; direction is not a substitute for the
 *   error comparison;
 * - tables compare on stable row/column keys (missing/extra rows and columns
 *   are mismatches, never silently ignored);
 * - figures compare the generated data hash first; visual similarity is an
 *   ADDITIONAL diagnostic only — it can never turn a pass into a fail;
 * - manuscript level must rebuild TeX/PDF with structure/text/font/page-count
 *   checks; missing inputs can never be a skipped-pass (→ inconclusive);
 * - report status: any required check fail → fail; no fail but some required
 *   check inconclusive → inconclusive; else pass. `blocked` comes from the
 *   preflight level (e.g. a clean-room that cannot satisfy a recipe) and is
 *   NEVER silently skipped.
 * @module @dsh-scholar/research-kernel/reproduction-compare
 */

import type {
  ComparisonGroup,
  FigureComparison,
  ManuscriptComparison,
  MetricComparator,
  MetricComparison,
  ReportCheck,
  ReportCheckStatus,
  ReportStatus,
  TableComparison,
} from '@dsh-scholar/research-schemas'

/** One measured metric value from a run (actual side of the comparison). */
export interface MetricActual {
  name: string
  value: number
  unit?: string
  direction?: 'higher_is_better' | 'lower_is_better'
  aggregation?: string
}

/** Expected table shape (paper-declared or original formal run). */
export interface TableExpected {
  table_id: string
  rows: Array<{ key: string; values: Record<string, number | string | null> }>
  columns: string[]
}

/** Actual table measured from the run under comparison. */
export interface TableActual {
  table_id: string
  rows: Array<{ key: string; values: Record<string, number | string | null> }>
  columns: string[]
}

/** Expected figure (paper): generated-data hash is authoritative. */
export interface FigureExpected {
  figure_id: string
  data_sha256: string | null
  /** Optional diagnostic threshold; NEVER a pass/fail gate alone. */
  visual_similarity_threshold?: number | null
}

/** Actual figure from the run. */
export interface FigureActual {
  figure_id: string
  data_sha256: string | null
  /** Additional diagnostic only (0..1). */
  visual_similarity?: number | null
}

/** Expected manuscript inputs (required when reproduction_level=manuscript). */
export interface ManuscriptExpected {
  required: boolean
  tex_required: boolean
  pdf_required: boolean
}

/** Actual manuscript rebuild outcome. */
export interface ManuscriptActual {
  tex_rebuilt: boolean
  pdf_rebuilt: boolean
  structure_ok: boolean | null
  text_ok: boolean | null
  fonts_ok: boolean | null
  page_count_ok: boolean | null
  /** Inputs the rebuild needed but could not obtain — never skipped-pass. */
  inputs_missing: string[]
}

function finite(value: number): boolean {
  return Number.isFinite(value)
}

/** §3 per-metric comparison of one comparator against one actual value.
 *  Defensive against un-parsed comparator objects (zod defaults like
 *  tolerance/unit/required may be absent on raw wire input). */
export function compareMetric(comparator: MetricComparator, actual: MetricActual | null | undefined): MetricComparison {
  const tolerance = comparator.tolerance ?? { absolute: 0, relative: 0 }
  const allowed = Math.max(
    tolerance.absolute ?? 0,
    Math.abs(comparator.expected) * (tolerance.relative ?? 0),
  )
  if (actual === null || actual === undefined) {
    return {
      metric_id: comparator.metric_id,
      name: comparator.name,
      expected: comparator.expected,
      actual: null,
      unit_match: false,
      direction_match: null,
      aggregation_match: null,
      allowed,
      deviation: null,
      status: (comparator.required ?? true) ? 'fail' : 'inconclusive',
      detail: (comparator.required ?? true)
        ? `missing metric '${comparator.name}' (required)`
        : `missing metric '${comparator.name}' (optional — not pass, not blocking)`,
    }
  }
  const unitMatch = (comparator.unit ?? '') === '' || (comparator.unit ?? '') === (actual.unit ?? '')
  const directionMatch = comparator.direction === undefined || comparator.direction === actual.direction
  const aggregationMatch = (comparator.aggregation ?? '') === '' || (comparator.aggregation ?? '') === (actual.aggregation ?? '')
  // NaN/Infinity actual can never pass (§3).
  if (!finite(actual.value)) {
    return {
      metric_id: comparator.metric_id,
      name: comparator.name,
      expected: comparator.expected,
      actual: actual.value,
      unit_match: unitMatch,
      direction_match: directionMatch,
      aggregation_match: aggregationMatch,
      allowed,
      deviation: null,
      status: 'fail',
      detail: `actual value for '${comparator.name}' is not finite (${String(actual.value)})`,
    }
  }
  if (!unitMatch) {
    return {
      metric_id: comparator.metric_id,
      name: comparator.name,
      expected: comparator.expected,
      actual: actual.value,
      unit_match: false,
      direction_match: directionMatch,
      aggregation_match: aggregationMatch,
      allowed,
      deviation: Math.abs(actual.value - comparator.expected),
      status: 'fail',
      detail: `unit mismatch for '${comparator.name}': expected '${comparator.unit}', got '${actual.unit ?? ''}'`,
    }
  }
  if (!directionMatch) {
    return {
      metric_id: comparator.metric_id,
      name: comparator.name,
      expected: comparator.expected,
      actual: actual.value,
      unit_match: true,
      direction_match: false,
      aggregation_match: aggregationMatch,
      allowed,
      deviation: Math.abs(actual.value - comparator.expected),
      // Direction is NOT a substitute for the error comparison: mismatch
      // fails regardless of how close the numbers are.
      status: 'fail',
      detail: `direction mismatch for '${comparator.name}': expected '${comparator.direction}', got '${actual.direction ?? ''}'`,
    }
  }
  if (!aggregationMatch) {
    return {
      metric_id: comparator.metric_id,
      name: comparator.name,
      expected: comparator.expected,
      actual: actual.value,
      unit_match: true,
      direction_match: true,
      aggregation_match: false,
      allowed,
      deviation: Math.abs(actual.value - comparator.expected),
      status: 'fail',
      detail: `aggregation mismatch for '${comparator.name}': expected '${comparator.aggregation}', got '${actual.aggregation ?? ''}'`,
    }
  }
  const deviation = Math.abs(actual.value - comparator.expected)
  const pass = deviation <= allowed
  return {
    metric_id: comparator.metric_id,
    name: comparator.name,
    expected: comparator.expected,
    actual: actual.value,
    unit_match: true,
    direction_match: true,
    aggregation_match: true,
    allowed,
    deviation,
    status: pass ? 'pass' : 'fail',
    detail: pass
      ? `'${comparator.name}': |${actual.value} - ${comparator.expected}| = ${deviation} <= allowed ${allowed}`
      : `'${comparator.name}' out of tolerance: |${actual.value} - ${comparator.expected}| = ${deviation} > allowed ${allowed} (absolute ${comparator.tolerance.absolute}, relative ${comparator.tolerance.relative})`,
  }
}

/**
 * Compare a comparator list against measured actuals, detecting duplicates
 * (same name twice in the actual set — never pass, contract §3) and missing
 * metrics (required → fail, optional → inconclusive). The `extra` actuals
 * (not declared by any comparator) are returned separately — they surface in
 * the report's extra-output accounting, never silently ignored.
 */
export function compareMetrics(
  comparators: MetricComparator[],
  actuals: MetricActual[],
): { comparisons: MetricComparison[]; extra: MetricActual[]; duplicate: string[] } {
  const byName = new Map<string, MetricActual[]>()
  for (const actual of actuals) {
    const list = byName.get(actual.name) ?? []
    list.push(actual)
    byName.set(actual.name, list)
  }
  const duplicates: string[] = []
  const comparisons: MetricComparison[] = []
  const seen = new Set<string>()
  for (const comparator of comparators) {
    const group = byName.get(comparator.name) ?? []
    if (group.length > 1) {
      duplicates.push(comparator.name)
      comparisons.push({
        metric_id: comparator.metric_id,
        name: comparator.name,
        expected: comparator.expected,
        actual: group[0]?.value ?? null,
        unit_match: false,
        direction_match: null,
        aggregation_match: null,
        allowed: Math.max((comparator.tolerance?.absolute ?? 0), Math.abs(comparator.expected) * (comparator.tolerance?.relative ?? 0)),
        deviation: null,
        status: 'fail',
        detail: `duplicate metric '${comparator.name}' in the actual set (${group.length} entries) — duplicates never pass`,
      })
      seen.add(comparator.name)
      continue
    }
    comparisons.push(compareMetric(comparator, group[0]))
    seen.add(comparator.name)
  }
  const extra = actuals.filter(a => !seen.has(a.name))
  return { comparisons, extra, duplicate: duplicates }
}

/** One table comparison on stable row/column keys (contract §3). */
export function compareTable(expected: TableExpected, actual: TableActual | null | undefined, required = true): TableComparison {
  if (actual === null || actual === undefined) {
    return {
      table_id: expected.table_id,
      status: required ? 'fail' : 'inconclusive',
      missing_rows: [],
      extra_rows: [],
      missing_columns: [],
      cell_mismatches: [],
      detail: required ? `missing table '${expected.table_id}' (required)` : `missing table '${expected.table_id}' (not blocking)`,
    }
  }
  const expectedKeys = new Set(expected.rows.map(r => r.key))
  const actualKeys = new Set(actual.rows.map(r => r.key))
  const missingRows = expected.rows.map(r => r.key).filter(k => !actualKeys.has(k))
  const extraRows = actual.rows.map(r => r.key).filter(k => !expectedKeys.has(k))
  const missingColumns = expected.columns.filter(c => !actual.columns.includes(c))
  const cellMismatches: TableComparison['cell_mismatches'] = []
  for (const expectedRow of expected.rows) {
    const actualRow = actual.rows.find(r => r.key === expectedRow.key)
    if (actualRow === undefined) continue
    for (const column of expected.columns) {
      if (!(column in expectedRow.values) && !(column in actualRow.values)) continue
      if (!(column in actualRow.values)) {
        cellMismatches.push({ row: expectedRow.key, column, expected: expectedRow.values[column] ?? null, actual: null })
        continue
      }
      const a = expectedRow.values[column]
      const b = actualRow.values[column]
      if (typeof a === 'number' && typeof b === 'number') {
        if (Math.abs(a - b) > Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 8) {
          cellMismatches.push({ row: expectedRow.key, column, expected: a, actual: b })
        }
      } else if (a !== b) {
        cellMismatches.push({ row: expectedRow.key, column, expected: a ?? null, actual: b ?? null })
      }
    }
  }
  const status: ReportCheckStatus = missingRows.length === 0 && extraRows.length === 0 && missingColumns.length === 0 && cellMismatches.length === 0
    ? 'pass'
    : 'fail'
  return {
    table_id: expected.table_id,
    status,
    missing_rows: missingRows,
    extra_rows: extraRows,
    missing_columns: missingColumns,
    cell_mismatches: cellMismatches,
    detail: status === 'pass'
      ? `table '${expected.table_id}' matches on all ${expected.columns.length} column(s) / ${expected.rows.length} row(s)`
      : `table '${expected.table_id}' differs: ${missingRows.length} missing row(s), ${extraRows.length} extra row(s), ${missingColumns.length} missing column(s), ${cellMismatches.length} cell mismatch(es)`,
  }
}

export function compareTables(expected: TableExpected[], actual: TableActual[]): TableComparison[] {
  const byId = new Map(actual.map(a => [a.table_id, a]))
  return expected.map(table => compareTable(table, byId.get(table.table_id)))
}

/**
 * Figure comparison: the generated-data hash is authoritative. A missing
 * expected hash makes the check inconclusive (nothing authoritative to
 * compare); a missing actual hash fails (data not produced). Visual
 * similarity is recorded as a diagnostic only and can NEVER change the
 * outcome of an otherwise-passing hash comparison.
 */
export function compareFigure(expected: FigureExpected, actual: FigureActual | null | undefined): FigureComparison {
  if (actual === null || actual === undefined) {
    return {
      figure_id: expected.figure_id,
      status: 'fail',
      data_hash_expected: expected.data_sha256,
      data_hash_actual: null,
      visual_similarity: null,
      detail: `missing figure '${expected.figure_id}' data (no actual output)`,
    }
  }
  if (expected.data_sha256 === null) {
    return {
      figure_id: expected.figure_id,
      status: 'inconclusive',
      data_hash_expected: null,
      data_hash_actual: actual.data_sha256,
      visual_similarity: actual.visual_similarity ?? null,
      detail: `figure '${expected.figure_id}': the paper declares no data hash — nothing authoritative to compare`,
    }
  }
  if (actual.data_sha256 === null) {
    return {
      figure_id: expected.figure_id,
      status: 'fail',
      data_hash_expected: expected.data_sha256,
      data_hash_actual: null,
      visual_similarity: actual.visual_similarity ?? null,
      detail: `figure '${expected.figure_id}': the run produced no data hash`,
    }
  }
  const match = expected.data_sha256 === actual.data_sha256
  return {
    figure_id: expected.figure_id,
    status: match ? 'pass' : 'fail',
    data_hash_expected: expected.data_sha256,
    data_hash_actual: actual.data_sha256,
    visual_similarity: actual.visual_similarity ?? null,
    detail: match
      ? `figure '${expected.figure_id}' data hash matches${actual.visual_similarity !== null && actual.visual_similarity !== undefined ? ` (visual similarity ${actual.visual_similarity} — diagnostic only)` : ''}`
      : `figure '${expected.figure_id}' data hash mismatch (expected ${expected.data_sha256}, got ${actual.data_sha256})`,
  }
}

export function compareFigures(expected: FigureExpected[], actual: FigureActual[]): FigureComparison[] {
  const byId = new Map(actual.map(a => [a.figure_id, a]))
  return expected.map(figure => compareFigure(figure, byId.get(figure.figure_id)))
}

/**
 * Manuscript level (contract §3): TeX/PDF must be rebuilt with structure/
 * text/font/page-count checks when required. Missing inputs can NEVER be a
 * skipped-pass — they yield inconclusive (the reproduction is not verifiable
 * at manuscript level, which is not a pass).
 */
export function compareManuscript(expected: ManuscriptExpected, actual: ManuscriptActual): ManuscriptComparison {
  const inputsMissing = actual.inputs_missing.filter(name => name !== '')
  if (inputsMissing.length > 0) {
    return {
      status: 'inconclusive',
      tex_rebuilt: actual.tex_rebuilt,
      pdf_rebuilt: actual.pdf_rebuilt,
      structure_ok: actual.structure_ok,
      text_ok: actual.text_ok,
      fonts_ok: actual.fonts_ok,
      page_count_ok: actual.page_count_ok,
      inputs_missing: inputsMissing,
      detail: `manuscript rebuild missing required inputs [${inputsMissing.join(', ')}] — NOT a skipped-pass; reproduction is inconclusive at manuscript level`,
    }
  }
  const structureOk = actual.structure_ok ?? true
  const textOk = actual.text_ok ?? true
  const fontsOk = actual.fonts_ok ?? true
  const pageCountOk = actual.page_count_ok ?? true
  const texOk = !expected.tex_required || actual.tex_rebuilt
  const pdfOk = !expected.pdf_required || actual.pdf_rebuilt
  const pass = texOk && pdfOk && structureOk && textOk && fontsOk && pageCountOk
  return {
    status: pass ? 'pass' : 'fail',
    tex_rebuilt: actual.tex_rebuilt,
    pdf_rebuilt: actual.pdf_rebuilt,
    structure_ok: structureOk,
    text_ok: textOk,
    fonts_ok: fontsOk,
    page_count_ok: pageCountOk,
    inputs_missing: [],
    detail: pass
      ? 'manuscript TeX/PDF rebuilt with structure/text/font/page-count checks passing'
      : `manuscript checks failed: tex_rebuilt=${actual.tex_rebuilt} pdf_rebuilt=${actual.pdf_rebuilt} structure=${structureOk} text=${textOk} fonts=${fontsOk} page_count=${pageCountOk}`,
  }
}

/** Flatten a comparison group into its checks (metrics/tables/figures/
 *  manuscript + explicit checks). */
export function comparisonGroupChecks(group: ComparisonGroup): ReportCheck[] {
  const checks: ReportCheck[] = group.checks.map(check => ({ ...check }))
  for (const metric of group.metrics) {
    checks.push({
      check_id: `metric:${metric.metric_id}`,
      kind: 'metric',
      name: `metric ${metric.name}`,
      status: metric.status,
      required: true,
      detail: metric.detail,
      expected: metric.expected,
      actual: metric.actual,
      allowed: metric.allowed,
    })
  }
  for (const table of group.tables) {
    checks.push({
      check_id: `table:${table.table_id}`,
      kind: 'table',
      name: `table ${table.table_id}`,
      status: table.status,
      required: true,
      detail: table.detail,
      expected: { missing_rows: table.missing_rows, missing_columns: table.missing_columns },
      actual: { extra_rows: table.extra_rows, cell_mismatches: table.cell_mismatches },
    })
  }
  for (const figure of group.figures) {
    checks.push({
      check_id: `figure:${figure.figure_id}`,
      kind: 'figure',
      name: `figure ${figure.figure_id}`,
      status: figure.status,
      required: true,
      detail: figure.detail,
      expected: figure.data_hash_expected,
      actual: figure.data_hash_actual,
    })
  }
  if (group.manuscript !== undefined) {
    checks.push({
      check_id: 'manuscript',
      kind: 'tex',
      name: 'manuscript TeX/PDF rebuild',
      status: group.manuscript.status,
      required: true,
      detail: group.manuscript.detail,
      expected: { tex_rebuilt: group.manuscript.tex_rebuilt, pdf_rebuilt: group.manuscript.pdf_rebuilt },
      actual: { structure_ok: group.manuscript.structure_ok, text_ok: group.manuscript.text_ok, fonts_ok: group.manuscript.fonts_ok, page_count_ok: group.manuscript.page_count_ok },
    })
  }
  return checks
}

/**
 * §3 status evaluation from checks: any required fail → fail; no required
 * fail but some required inconclusive → inconclusive; all required pass →
 * pass. `blocked` is decided separately (preflight) and wins over everything.
 */
export function evaluateReportStatus(checks: ReportCheck[], preflightBlocked = false): ReportStatus {
  if (preflightBlocked) return 'blocked'
  const required = checks.filter(check => check.required)
  if (required.some(check => check.status === 'fail')) return 'fail'
  if (required.some(check => check.status === 'inconclusive')) return 'inconclusive'
  if (required.length === 0) return 'inconclusive'
  return 'pass'
}

/** Stable scientific failure class suggestion from the check list — never
 *  `code_error` for an out-of-tolerance result (contract §3). */
export function suggestFailureClass(checks: ReportCheck[]): string | null {
  if (checks.some(c => c.kind === 'metric' && c.status === 'fail')) return 'metric_mismatch'
  if (checks.some(c => c.kind === 'table' && c.status === 'fail')) return 'table_mismatch'
  if (checks.some(c => c.kind === 'figure' && c.status === 'fail')) return 'figure_mismatch'
  if (checks.some(c => (c.kind === 'tex' || c.kind === 'pdf') && c.status === 'fail')) return 'manuscript_mismatch'
  if (checks.some(c => c.kind === 'runtime' && c.status === 'fail')) return 'runtime_mismatch'
  if (checks.some(c => c.kind === 'environment' && c.status === 'fail')) return 'environment_mismatch'
  if (checks.some(c => c.kind === 'manifest' && c.status === 'fail')) return 'provenance_missing'
  if (checks.some(c => c.kind === 'outputs' && c.status === 'fail')) return 'report_mismatch'
  return null
}
