/**
 * Canonical JSON for authority hashes and signatures.
 *
 * Object keys are sorted recursively, array order is preserved, and no
 * insignificant whitespace is emitted. Inputs must be JSON values; rejecting
 * non-finite numbers and non-JSON array members keeps every signed byte
 * sequence reproducible across processes.
 */
export function canonicalJsonDeep(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON accepts finite numbers only')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalJsonDeep(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJsonDeep(record[key])}`)
      .join(',')}}`
  }
  throw new TypeError('canonical JSON accepts JSON values only')
}
