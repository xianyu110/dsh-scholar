/**
 * UPLOAD-01 (hardening §4 P1): multipart artifact upload primitives.
 *
 * Single-file multipart uploads are staged on disk (session-id'd temp files
 * under the CAS root) and atomically finalized into the content-addressed
 * store — the HTTP layer never trusts the client's hash, name or size:
 *
 *  - the server streams the body with a hard cap (32 MiB file + bounded
 *    multipart overhead), computes sha256 over the received bytes and binds
 *    it to the registered artifact record;
 *  - the file name is validated as a plain basename (no absolute path,
 *    no `..` segment, no NUL, no Windows drive prefix, no backslash
 *    ambiguity) — see validateUploadFileName (defined in kernel.ts);
 *  - identical re-uploads (same project + sha256 + file_name) return the
 *    original artifact without writing anything (idempotency);
 *  - expired staged files are garbage-collected by the kernel's
 *    cleanupStagedUploads (same grace-period model as the CAS orphan GC).
 *
 * Archive semantics (duplicate normalized paths, symlink escapes, device/
 * FIFO rejection) are enforced by the existing code-snapshot walk
 * (kernel.ts snapshotCodeArchive / unpackCodeSnapshot) and apply to
 * research-package archives — a single-file multipart upload cannot contain
 * more than one file (multiple file parts are rejected).
 * @module @dsh-scholar/research-kernel/uploads
 */

import { UPLOAD_MAX_FILE_BYTES, UPLOAD_MAX_BODY_BYTES, STAGED_UPLOAD_TTL_MS } from './upload-limits.js'

export { UPLOAD_MAX_FILE_BYTES, UPLOAD_BODY_OVERHEAD_BYTES, UPLOAD_MAX_BODY_BYTES, STAGED_UPLOAD_TTL_MS } from './upload-limits.js'

/** One parsed multipart part (RFC 7578 subset sufficient for uploads). */
export interface MultipartPart {
  /** Form field name (content-disposition name="..."). */
  name: string
  /** filename="..." from content-disposition (file parts only). */
  fileName?: string
  /** Part-level content-type, when present. */
  contentType?: string
  /** Raw part bytes (no trailing CRLF). */
  data: Buffer
}

/**
 * Extract the boundary parameter from a multipart/form-data content-type.
 * Accepts both quoted (`boundary="abc"`) and bare (`boundary=abc`) forms.
 * Returns null when absent or empty (the server then answers 400
 * invalid_multipart — a boundary is mandatory per RFC 2046 §5.1.1).
 */
export function extractBoundary(contentType: string): string | null {
  for (const param of contentType.split(';').slice(1)) {
    const eq = param.indexOf('=')
    if (eq < 0) continue
    const key = param.slice(0, eq).trim().toLowerCase()
    if (key !== 'boundary') continue
    let value = param.slice(eq + 1).trim()
    if (value.startsWith('"')) {
      if (!value.endsWith('"') || value.length < 2) return null
      value = value.slice(1, -1)
    }
    if (value === '') return null
    return value
  }
  return null
}

/** RFC 2047 / quoted-string unescape for header values (used for names). */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  return trimmed
}

/**
 * Parse a multipart/form-data body. Delimiters follow RFC 7578: parts are
 * separated by CRLF--boundary, the body ends with CRLF--boundary--. A body
 * beginning with `--boundary` at offset 0 (curl -F) is accepted as well.
 * Malformed bodies throw a plain Error — the HTTP layer maps it to 400
 * invalid_multipart. A missing file part, multiple file parts and invalid
 * names/kinds are NOT parser errors: the route validates them afterwards
 * (422 with a specific code).
 */
export function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const delimiter = Buffer.from(`\r\n--${boundary}`)
  const closeDelimiter = Buffer.from(`\r\n--${boundary}--`)
  const parts: MultipartPart[] = []
  let cursor = 0
  // The first boundary may appear at the very start (no leading CRLF).
  if (body.length >= 2 + boundary.length && body.subarray(0, 2 + boundary.length).toString('latin1') === `--${boundary}`) {
    cursor = 2 + boundary.length
  } else {
    const first = body.indexOf(delimiter)
    if (first < 0) throw new Error('boundary delimiter not found')
    cursor = first + delimiter.length
  }
  for (;;) {
    // Skip the CRLF that follows a boundary.
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2
    else if (body[cursor] === 0x0a) cursor += 1
    // `--` right after a boundary marks the final (closing) delimiter.
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break
    const headerEndCrlf = body.indexOf(Buffer.from('\r\n\r\n'), cursor)
    const headerEndLf = headerEndCrlf < 0 ? body.indexOf(Buffer.from('\n\n'), cursor) : -1
    if (headerEndCrlf < 0 && headerEndLf < 0) throw new Error('part headers not terminated')
    const headerEnd = headerEndCrlf >= 0 ? headerEndCrlf : headerEndLf
    const headerBlock = body.subarray(cursor, headerEnd).toString('utf8')
    const dataStart = headerEndCrlf >= 0 ? headerEndCrlf + 4 : headerEndLf + 2
    // The next NON-closing delimiter (a closing delimiter starts with the
    // same bytes plus `--` — skip those matches).
    const findNext = (from: number): number => {
      let idx = body.indexOf(delimiter, from)
      while (idx >= 0 && body[idx + delimiter.length] === 0x2d) {
        idx = body.indexOf(delimiter, idx + delimiter.length)
      }
      return idx
    }
    const next = findNext(dataStart)
    const close = body.indexOf(closeDelimiter, dataStart)
    let dataEnd: number
    if (close >= 0 && (next < 0 || close < next)) {
      dataEnd = close
    } else if (next >= 0) {
      dataEnd = next
    } else {
      throw new Error('part body not terminated by a boundary')
    }
    // The delimiter match STARTS at its own leading CRLF, so the part data
    // is everything before dataEnd — including any CRLF that belongs to the
    // data itself (data + `\r\n` + `--boundary` keeps the data's `\r\n`).
    parts.push(parsePart(headerBlock, body.subarray(dataStart, dataEnd)))
    if (close >= 0 && (next < 0 || close < next)) break
    cursor = dataEnd + delimiter.length
  }
  return parts
}

function parsePart(headerBlock: string, data: Buffer): MultipartPart {
  let name = ''
  let fileName: string | undefined
  let contentType: string | undefined
  for (const line of headerBlock.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (key === 'content-disposition') {
      // form-data; name="file"; filename="a.txt"
      for (const param of value.split(';').slice(1)) {
        const eq = param.indexOf('=')
        if (eq < 0) continue
        const pkey = param.slice(0, eq).trim().toLowerCase()
        const pvalue = unquote(param.slice(eq + 1))
        if (pkey === 'name') name = pvalue
        else if (pkey === 'filename') fileName = pvalue
      }
    } else if (key === 'content-type') {
      contentType = value
    }
  }
  if (name === '') throw new Error('part missing content-disposition name')
  return { name, fileName: fileName === undefined ? undefined : fileName, contentType, data }
}
