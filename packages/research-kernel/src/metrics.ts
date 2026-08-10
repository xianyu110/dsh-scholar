/**
 * OBS-01 (reconstruction-contracts.md §18): in-memory MetricsStore.
 *
 * A deliberately minimal counter + histogram store. Node is single-threaded,
 * so no locking is needed; every mutation is a plain Map update. The store
 * is DURABLE-adjacent only for the life of the process — it is a runtime
 * observability snapshot, not a ledger (the outbox stays the only business
 * ledger). A team OpenTelemetry adapter remains the future export surface;
 * `snapshot()` is the wire format consumed by GET /internal/metrics.
 *
 * Security (OBS-01): series KEYS and TAGS are fixed constant strings chosen
 * by the instrumentation call sites — they must never embed request paths,
 * job ids, tokens, file contents or payload bodies. `snapshot()` serializes
 * only keys/tags/numbers, so the JSON can never leak secrets by itself.
 * @module @dsh-scholar/research-kernel/metrics
 */

export type MetricTags = Record<string, string>

/** Fixed histogram bucket upper bounds (ms-oriented). Each observation is
 * counted exactly once, in the FIRST bucket whose upper bound is >= the
 * value; observations above the largest bound accumulate in the `+Inf`
 * bucket. count/sum/min/max are exact regardless of the bucket layout. */
export const HISTOGRAM_BUCKETS: readonly number[] = [
  0.1, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
]

interface CounterSeries {
  key: string
  tags: MetricTags
  value: number
}

export interface HistogramBucket { le: number; count: number }

interface HistogramSeries {
  key: string
  tags: MetricTags
  count: number
  sum: number
  min: number | null
  max: number | null
  buckets: HistogramBucket[]
  inf: number
}

export interface CounterView { key: string; tags: MetricTags; value: number }

export interface HistogramView {
  key: string
  tags: MetricTags
  count: number
  sum: number
  min: number | null
  max: number | null
  buckets: HistogramBucket[]
  /** Observations above the largest bucket bound. */
  inf: number
}

export interface MetricsSnapshot {
  generated_at: string
  /** Process uptime in milliseconds (OBS-01 §18 uptime-style diagnostics). */
  uptime_ms: number
  counters: CounterView[]
  histograms: HistogramView[]
}

/** Canonical series identity: key + tags sorted by tag name (stable JSON). */
function seriesId(key: string, tags: MetricTags): string {
  const names = Object.keys(tags).sort()
  const canonical = JSON.stringify(names.map(n => [n, String(tags[n])]))
  return `${key}\u0000${canonical}`
}

/**
 * Minimal in-memory metrics store (OBS-01, reconstruction-contracts.md §18).
 * Usage: `metrics.count('job.claimed')`, `metrics.observe('http.request.duration_ms', ms)`.
 */
export class MetricsStore {
  private readonly counters = new Map<string, CounterSeries>()
  private readonly histograms = new Map<string, HistogramSeries>()
  private readonly startedAt = Date.now()

  /**
   * Increment a counter (default delta 1). `tags` are optional label pairs;
   * each distinct (key, tags) combination is its own series. Deltas of 0 are
   * no-ops (no empty series is created). Single-threaded node — no locking.
   */
  count(key: string, tags?: MetricTags, delta = 1): void {
    if (delta <= 0) return
    const normalized = tags ?? {}
    const id = seriesId(key, normalized)
    const existing = this.counters.get(id)
    if (existing === undefined) {
      this.counters.set(id, { key, tags: { ...normalized }, value: delta })
      return
    }
    existing.value += delta
  }

  /**
   * Record one observation into a histogram series (exact count/sum/min/max
   * plus fixed-bound buckets — each observation lands in the FIRST bucket
   * whose upper bound is >= the value, or +Inf). Values are expected in
   * milliseconds for latency-style metrics; the exact unit is the caller's
   * contract (documented per key at the instrumentation site).
   */
  observe(key: string, value: number, tags?: MetricTags): void {
    const normalized = tags ?? {}
    const id = seriesId(key, normalized)
    let series = this.histograms.get(id)
    if (series === undefined) {
      series = {
        key,
        tags: { ...normalized },
        count: 0,
        sum: 0,
        min: null,
        max: null,
        buckets: HISTOGRAM_BUCKETS.map(le => ({ le, count: 0 })),
        inf: 0,
      }
      this.histograms.set(id, series)
    }
    series.count += 1
    series.sum += value
    series.min = series.min === null ? value : Math.min(series.min, value)
    series.max = series.max === null ? value : Math.max(series.max, value)
    let placed = false
    for (const bucket of series.buckets) {
      if (value <= bucket.le) {
        bucket.count += 1
        placed = true
        break
      }
    }
    if (!placed) series.inf += 1
  }

  /**
   * OBS-01: JSON-safe snapshot for GET /internal/metrics. Contains only
   * constant series keys/tags and numbers — never tokens, paths or content.
   */
  snapshot(): MetricsSnapshot {
    const counters: CounterView[] = [...this.counters.values()]
      .map(({ key, tags, value }) => ({ key, tags, value }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const histograms: HistogramView[] = [...this.histograms.values()]
      .map(s => ({
        key: s.key,
        tags: s.tags,
        count: s.count,
        sum: s.sum,
        min: s.min,
        max: s.max,
        buckets: s.buckets.map(b => ({ le: b.le, count: b.count })),
        inf: s.inf,
      }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return {
      generated_at: new Date().toISOString(),
      uptime_ms: this.uptimeMs(),
      counters,
      histograms,
    }
  }

  /** Uptime in milliseconds since the store was created. */
  uptimeMs(): number {
    return Date.now() - this.startedAt
  }
}
