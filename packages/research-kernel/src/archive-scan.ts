/**
 * ONBOARD-01 — controlled archive unpack scan (research-onboarding.md
 * §4.1/§4.2, "archive 解包扫描"). Pure, dependency-free (node:zlib only)
 * read-only ZIP / TAR / TAR.GZ entry scanners:
 *
 *  - identification by extension + magic bytes (PK\x03\x04, gzip 1f 8b,
 *    ustar at offset 257);
 *  - ZIP parsed via its End-Of-Central-Directory + central directory
 *    (streaming-created archives with data descriptors are supported);
 *    entries are inflated with a bounded per-entry output cap;
 *  - TAR parsed by walking 512-byte headers (POSIX ustar + GNU longname/
 *    longlink + pax extended headers); TAR.GZ is gunzipped once with a
 *    bounded output cap (`zlib maxOutputLength`), then tar-walked;
 *  - PATH SAFETY: every entry path is validated with the SAME rule set the
 *    workspace store uses (`normalizeWorkspacePath` — absolute paths, `..`/
 *    `.` segments, NUL bytes, Windows drive prefixes and backslashes are
 *    rejected), plus duplicate detection (exact and case-folded — §4.2
 *    "重复大小写冲突");
 *  - BOMB PROTECTION: entry-count / total-decompressed-bytes / per-file
 *    caps and a compression-ratio cap (>100x rejected) — all enforced while
 *    parsing, never after buffering the whole archive;
 *  - SPECIAL ENTRIES: symlinks, hardlinks, devices and FIFOs are REJECTED
 *    (fail closed — an archive containing any of them is refused as a
 *    whole); directories are skipped; unsupported compression methods
 *    (e.g. zip bzip2/lzma/zstd) and zip64 per-entry sizes are rejected.
 *
 * The scan NEVER extracts to the project area: it only reads the staged
 * bytes and returns an "unpacked view" (entry paths + sizes). The kernel
 * records that view into the intake scan_result/scan_summary at scan time
 * and re-extracts entry CONTENT at adoption-time materialization
 * (`extractArchiveEntries`) — pre-accept writes stay limited to the intake
 * tables + the isolated staging CAS (research-onboarding.md §2.1).
 *
 * Implementation note (docs/research-onboarding.md §4.2): this module uses
 * node's built-in `zlib` (gunzip/inflateRawSync with `maxOutputLength`
 * caps) plus hand-rolled minimal ZIP/TAR parsers — it never shells out to
 * system unzip/tar and never executes archive content.
 * @module @dsh-scholar/research-kernel/archive-scan
 */

import { gunzipSync, inflateRawSync } from 'node:zlib'
import { normalizeWorkspacePath, WorkspaceError } from './workspace-store.js'

/** Archive formats the unpack scan can process. */
export type ArchiveKind = 'zip' | 'tar' | 'tgz'

/** Resource limits for one controlled archive unpack (§4.2 bomb protection). */
export interface ArchiveLimits {
  /** Max archive entries (files + dirs) counted during the walk. */
  maxEntries: number
  /** Max total decompressed bytes across all entries. */
  maxTotalBytes: number
  /** Max decompressed size of ONE entry. */
  maxFileBytes: number
  /** Max (uncompressed / compressed) ratio — higher is a bomb. */
  maxRatio: number
}

/** Defaults mirror the kernel's static ResearchKernel.ARCHIVE_* limits. */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 1000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxRatio: 100,
}

/** Stable machine code for an archive scan refusal (→ quarantine reason). */
export type ArchiveScanErrorCode =
  | 'archive_unsupported_format'
  | 'archive_unsupported_compression'
  | 'archive_path_invalid'
  | 'archive_duplicate_path'
  | 'archive_special_entry'
  | 'archive_bomb'
  | 'archive_file_too_large'
  /** A .gz/.tgz whose member is a single file (not a tar) — NOT rejected:
   * recorded as `unsupported` and the file stays adoptable as a code
   * artifact (single-file gzip content is never unpacked). */
  | 'archive_gzip_single_file'

/** Refusal raised while scanning/extracting an archive (fail closed). */
export class ArchiveScanError extends Error {
  readonly code: ArchiveScanErrorCode
  constructor(code: ArchiveScanErrorCode, message: string) {
    super(message)
    this.name = 'ArchiveScanError'
    this.code = code
  }
}

/** One entry of the unpacked view (metadata only — no content). */
export interface ArchiveScanEntry {
  /** Root-relative POSIX path, already normalizeWorkspacePath-validated. */
  path: string
  /** Decompressed size in bytes. */
  size_bytes: number
}

/** Successful unpacked view of one archive. */
export interface ArchiveScanResult {
  kind: ArchiveKind
  entries: ArchiveScanEntry[]
  /** Sum of entry size_bytes (total decompressed bytes). */
  extracted_bytes: number
}

const ZIP_LOCAL = 0x04034b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_EOCD = 0x06054b50
const ZIP64_EOCD = 0x06064b50
const ZIP64_LOCATOR = 0x07064b50

const TAR_BLOCK = 512
const S_IFMT = 0xf000
const S_IFREG = 0x8000
const S_IFDIR = 0x4000
const S_IFLNK = 0xa000
const S_IFCHR = 0x2000
const S_IFBLK = 0x6000
const S_IFIFO = 0x1000
const S_IFSOCK = 0xc000

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = ''
  for (let i = start; i < end && i < bytes.length; i += 1) {
    const b = bytes[i] ?? 0
    if (b === 0) break
    out += String.fromCharCode(b)
  }
  return out
}

function readU16(bytes: Uint8Array, off: number): number {
  return bytes[off]! | (bytes[off + 1]! << 8)
}

function readU32(bytes: Uint8Array, off: number): number {
  return (bytes[off]! | (bytes[off + 1]! << 8) | (bytes[off + 2]! << 16) | (bytes[off + 3]! << 24)) >>> 0
}

/** Parse a POSIX/GNU octal size field (11 bytes, NUL padded). */
function octalSize(bytes: Uint8Array, off: number): number {
  const raw = ascii(bytes, off, off + 12).trim()
  if (raw === '') return 0
  if (!/^[0-7]+$/.test(raw)) return -1
  return Number.parseInt(raw, 8)
}

/** Shared path-safety gate: normalize + duplicate detection. */
function checkEntryPath(
  path: string,
  seen: Set<string>,
  seenFold: Set<string>,
  fileName: string,
): string {
  let clean: string
  try {
    clean = normalizeWorkspacePath(path)
  } catch (error) {
    const detail = error instanceof WorkspaceError ? error.message : String(error)
    throw new ArchiveScanError('archive_path_invalid', `${fileName}: entry path rejected: ${detail}`)
  }
  if (seen.has(clean)) {
    throw new ArchiveScanError('archive_duplicate_path', `${fileName}: duplicate entry path ${clean}`)
  }
  const folded = clean.toLowerCase()
  if (seenFold.has(folded)) {
    throw new ArchiveScanError('archive_duplicate_path', `${fileName}: case-colliding entry path ${clean} (重复大小写冲突)`)
  }
  seen.add(clean)
  seenFold.add(folded)
  return clean
}

function checkEntryCaps(
  fileName: string,
  size: number,
  limits: ArchiveLimits,
  state: { count: number; total: number },
  ratio?: number,
  enforceCaps = true,
): void {
  if (!enforceCaps) return
  if (state.count >= limits.maxEntries) {
    throw new ArchiveScanError('archive_bomb',
      `${fileName}: entry count ${state.count} >= max_entries=${limits.maxEntries}`)
  }
  if (size > limits.maxFileBytes) {
    throw new ArchiveScanError('archive_file_too_large',
      `${fileName}: entry is ${size} bytes (max_file_bytes=${limits.maxFileBytes})`)
  }
  if (ratio !== undefined && ratio > limits.maxRatio) {
    throw new ArchiveScanError('archive_bomb',
      `${fileName}: compression ratio ${ratio.toFixed(1)}x > max_ratio=${limits.maxRatio}`)
  }
  state.total += size
  if (state.total > limits.maxTotalBytes) {
    throw new ArchiveScanError('archive_bomb',
      `${fileName}: total decompressed ${state.total} bytes > max_total_bytes=${limits.maxTotalBytes}`)
  }
  state.count += 1
}

/** Identify a supported archive by extension + magic (null = not scannable). */
export function archiveKindOf(fileName: string, bytes: Uint8Array): ArchiveKind | null {
  const lower = fileName.toLowerCase()
  const gzipMagic = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
  if (lower.endsWith('.zip') && bytes.length >= 4 && readU32(bytes, 0) === ZIP_LOCAL) return 'zip'
  if (lower.endsWith('.tar') && ascii(bytes, 257, 263).startsWith('ustar')) return 'tar'
  if ((lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.gz')) && gzipMagic) return 'tgz'
  return null
}

/**
 * Controlled unpack SCAN of one staged archive. Returns the unpacked view
 * (entry paths + sizes) or throws ArchiveScanError (fail closed — the
 * caller quarantines the artifact). Never writes anywhere.
 */
export function scanArchive(bytes: Uint8Array, fileName: string, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): ArchiveScanResult {
  const kind = archiveKindOf(fileName, bytes)
  if (kind === null) {
    throw new ArchiveScanError('archive_unsupported_format', `${fileName}: not a supported archive (zip/tar/tar.gz by extension + magic)`)
  }
  if (kind === 'zip') return scanZip(bytes, fileName, limits)
  if (kind === 'tgz') return scanTarGz(bytes, fileName, limits)
  return scanTar(bytes, fileName, limits, bytes.length)
}

/** ── ZIP ─────────────────────────────────────────────────────────────── */

interface ZipEntryInfo {
  path: string
  size: number
  method: number
  compSize: number
  dataStart: number
}

function findZipEocd(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.length - 22 - 65535)
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (readU32(bytes, i) === ZIP_EOCD) return i
  }
  return -1
}

/** Read the central directory into a list of entry infos (with caps).
 * `enforceCaps=false` keeps path safety + special-entry rejection but skips
 * the size/count/ratio caps — used by adoption materialization, where the
 * scan already validated the archive and each entry is inflated under the
 * per-entry output cap. */
function readZipCentralDir(bytes: Uint8Array, fileName: string, limits: ArchiveLimits, enforceCaps = true): ZipEntryInfo[] {
  const eocd = findZipEocd(bytes)
  if (eocd < 0) {
    throw new ArchiveScanError('archive_unsupported_format', `${fileName}: zip end-of-central-directory not found`)
  }
  let entriesTotal = readU16(bytes, eocd + 10)
  let cdOffset = readU32(bytes, eocd + 16)
  if (entriesTotal === 0xffff || cdOffset === 0xffffffff) {
    // zip64: locate the zip64 EOCD record via the locator 20 bytes before.
    const locator = eocd - 20
    if (locator < 0 || readU32(bytes, locator) !== ZIP64_LOCATOR) {
      throw new ArchiveScanError('archive_unsupported_format', `${fileName}: zip64 end-of-central-directory locator not found`)
    }
    const z64 = readU32(bytes, locator + 8) // offset of the zip64 EOCD record
    if (z64 + 56 > bytes.length || readU32(bytes, z64) !== ZIP64_EOCD) {
      throw new ArchiveScanError('archive_unsupported_format', `${fileName}: zip64 end-of-central-directory record not found`)
    }
    // 8-byte fields (zip64): entriesTotal @+32, cdSize @+40, cdOffset @+48.
    const readU64 = (off: number): number => {
      let v = 0
      for (let i = 0; i < 8; i += 1) v = v * 256 + bytes[off + i]!
      return v
    }
    const z64Total = readU64(z64 + 32)
    const z64CdOffset = readU64(z64 + 48)
    entriesTotal = z64Total > 0x7fffffff ? 0x7fffffff : z64Total
    cdOffset = z64CdOffset > 0x7fffffff ? 0xffffffff : z64CdOffset
  }
  if (enforceCaps && entriesTotal > limits.maxEntries) {
    throw new ArchiveScanError('archive_bomb',
      `${fileName}: zip entry count ${entriesTotal} >= max_entries=${limits.maxEntries}`)
  }
  if (cdOffset === 0xffffffff || cdOffset + 4 > bytes.length) {
    throw new ArchiveScanError('archive_unsupported_format', `${fileName}: zip central directory out of range`)
  }
  const seen = new Set<string>()
  const seenFold = new Set<string>()
  const entries: ZipEntryInfo[] = []
  const state = { count: 0, total: 0 }
  let off = cdOffset
  for (let i = 0; i < entriesTotal; i += 1) {
    if (off + 46 > bytes.length || readU32(bytes, off) !== ZIP_CENTRAL) {
      throw new ArchiveScanError('archive_unsupported_format', `${fileName}: zip central directory truncated at entry ${i}`)
    }
    const method = readU16(bytes, off + 10)
    const compSize = readU32(bytes, off + 20)
    const uncompSize = readU32(bytes, off + 24)
    const nameLen = readU16(bytes, off + 28)
    const extraLen = readU16(bytes, off + 30)
    const commentLen = readU16(bytes, off + 32)
    const externalAttr = readU32(bytes, off + 38)
    const localOffset = readU32(bytes, off + 42)
    const madeBy = readU16(bytes, off + 4)
    if (off + 46 + nameLen > bytes.length) {
      throw new ArchiveScanError('archive_unsupported_format', `${fileName}: zip central directory name out of range`)
    }
    const rawName = bytes.subarray(off + 46, off + 46 + nameLen)
    const name = (readU16(bytes, off + 8) & 0x800) !== 0
      ? Buffer.from(rawName).toString('utf8')
      : Buffer.from(rawName).toString('latin1')
    const unixMode = (madeBy >> 8) === 3 ? (externalAttr >>> 16) & 0xffff : 0
    const isDir = name.endsWith('/') || (unixMode !== 0 && (unixMode & S_IFMT) === S_IFDIR)
    // Special entries (symlink / device / fifo / socket) are rejected.
    if (unixMode !== 0 && !isDir) {
      const type = unixMode & S_IFMT
      if (type !== S_IFREG && type !== S_IFDIR) {
        throw new ArchiveScanError('archive_special_entry',
          `${fileName}: entry ${name} is a special file (mode 0${(type >> 12).toString(8)}) — symlink/device/FIFO are rejected`)
      }
    }
    if (!isDir) {
      if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
        throw new ArchiveScanError('archive_unsupported_format',
          `${fileName}: entry ${name} uses zip64 per-entry sizes (unsupported)`)
      }
      if (method !== 0 && method !== 8) {
        throw new ArchiveScanError('archive_unsupported_compression',
          `${fileName}: entry ${name} uses unsupported zip method ${method} (only stored/deflate)`)
      }
      const clean = checkEntryPath(name, seen, seenFold, fileName)
      const ratio = uncompSize / Math.max(1, compSize)
      checkEntryCaps(fileName, uncompSize, limits, state, ratio, enforceCaps)
      // Verify the local header + data window (a corrupt offset is rejected
      // rather than mis-extracted later).
      if (localOffset + 30 + 4 > bytes.length || readU32(bytes, localOffset) !== ZIP_LOCAL) {
        throw new ArchiveScanError('archive_unsupported_format',
          `${fileName}: entry ${name} local header out of range`)
      }
      const lNameLen = readU16(bytes, localOffset + 26)
      const lExtraLen = readU16(bytes, localOffset + 28)
      const dataStart = localOffset + 30 + lNameLen + lExtraLen
      if (dataStart + compSize > bytes.length) {
        throw new ArchiveScanError('archive_unsupported_format',
          `${fileName}: entry ${name} data window out of range (truncated)`)
      }
      entries.push({ path: clean, size: uncompSize, method, compSize, dataStart })
    } else if (enforceCaps) {
      // Directories count toward the entry cap too (a dir-stuffed archive is
      // still a bomb), but consume no decompressed bytes.
      state.count += 1
      if (state.count > limits.maxEntries) {
        throw new ArchiveScanError('archive_bomb',
          `${fileName}: entry count ${state.count} > max_entries=${limits.maxEntries}`)
      }
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function inflateEntry(fileName: string, entry: ZipEntryInfo, bytes: Uint8Array, limits: ArchiveLimits): Buffer {
  const data = bytes.subarray(entry.dataStart, entry.dataStart + entry.compSize)
  let out: Buffer
  try {
    out = entry.method === 0
      ? Buffer.from(data)
      : inflateRawSync(data, { maxOutputLength: limits.maxFileBytes + 1 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ArchiveScanError('archive_file_too_large',
        `${fileName}: entry ${entry.path} exceeds max_file_bytes=${limits.maxFileBytes} when inflated`)
    }
    throw new ArchiveScanError('archive_unsupported_format',
      `${fileName}: entry ${entry.path} failed to inflate: ${(error as Error).message}`)
  }
  if (out.byteLength !== entry.size) {
    throw new ArchiveScanError('archive_unsupported_format',
      `${fileName}: entry ${entry.path} inflated to ${out.byteLength} bytes but the central directory declared ${entry.size}`)
  }
  return out
}

function scanZip(bytes: Uint8Array, fileName: string, limits: ArchiveLimits): ArchiveScanResult {
  const entries = readZipCentralDir(bytes, fileName, limits)
  return {
    kind: 'zip',
    entries: entries.map(e => ({ path: e.path, size_bytes: e.size })),
    extracted_bytes: entries.reduce((sum, e) => sum + e.size, 0),
  }
}

/** ── TAR / TAR.GZ ────────────────────────────────────────────────────── */

interface TarEntryInfo {
  path: string
  size: number
  contentStart: number
}

/** Walk a decompressed tar buffer, applying the shared safety gates.
 * `enforceCaps=false` keeps path safety + special-entry rejection but skips
 * the size/count/ratio caps (adoption materialization — see
 * readZipCentralDir). */
function walkTar(tar: Uint8Array, fileName: string, limits: ArchiveLimits, compressedBytes: number, enforceCaps = true): TarEntryInfo[] {
  if (!ascii(tar, 257, 263).startsWith('ustar')) {
    throw new ArchiveScanError('archive_unsupported_format', `${fileName}: not a ustar tar archive`)
  }
  const seen = new Set<string>()
  const seenFold = new Set<string>()
  const entries: TarEntryInfo[] = []
  const state = { count: 0, total: 0 }
  const totalRatio = tar.length / Math.max(1, compressedBytes)
  if (enforceCaps && totalRatio > limits.maxRatio) {
    throw new ArchiveScanError('archive_bomb',
      `${fileName}: overall compression ratio ${totalRatio.toFixed(1)}x > max_ratio=${limits.maxRatio}`)
  }
  let off = 0
  let gnuLongName: string | null = null
  while (off + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(off, off + TAR_BLOCK)
    if (header.every(b => b === 0)) break // two zero blocks = end
    const rawName = ascii(header, 0, 100)
    const rawSize = header.subarray(124, 136)
    let size: number
    if ((rawSize[0]! & 0x80) !== 0) {
      // GNU base-256 size field — only used for >= 8 GiB entries: a bomb.
      throw new ArchiveScanError('archive_bomb', `${fileName}: entry uses a GNU base-256 size (>= 8 GiB)`)
    }
    size = octalSize(header, 124)
    if (size < 0) {
      throw new ArchiveScanError('archive_unsupported_format', `${fileName}: entry ${rawName} has a malformed size field`)
    }
    const typeflag = String.fromCharCode(header[156]!)
    const contentStart = off + TAR_BLOCK
    const contentLen = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    if (contentStart + contentLen > tar.length) {
      throw new ArchiveScanError('archive_unsupported_format', `${fileName}: entry ${rawName} content out of range (truncated)`)
    }
    if (typeflag === 'L') {
      // GNU longname: the NEXT block's content is the entry name.
      gnuLongName = Buffer.from(tar.subarray(contentStart, contentStart + size)).toString('utf8')
      off = contentStart + contentLen
      continue
    }
    if (typeflag === 'K') {
      // GNU longlink: consumed here; the actual entry (rejected if a link).
      off = contentStart + contentLen
      continue
    }
    let name = rawName
    if (typeflag === 'x' || typeflag === 'g') {
      // pax extended header: parse `path=` records, otherwise skip.
      const records = Buffer.from(tar.subarray(contentStart, contentStart + size)).toString('utf8')
      for (const record of records.split('\n')) {
        const sp = record.indexOf(' ')
        if (sp <= 0) continue
        const len = Number.parseInt(record.slice(0, sp), 10)
        if (Number.isNaN(len) || len <= 0) continue
        const body = record.slice(sp + 1)
        if (body.startsWith('path=')) {
          name = body.slice('path='.length).replace(/[ \t]+$/, '')
        }
        // linkpath= would only matter for rejected link entries.
      }
      off = contentStart + contentLen
      continue
    }
    if (typeflag === '5') {
      // Directory: skip (never materialized, counted toward the caps).
      state.count += 1
      if (enforceCaps && state.count > limits.maxEntries) {
        throw new ArchiveScanError('archive_bomb',
          `${fileName}: entry count ${state.count} > max_entries=${limits.maxEntries}`)
      }
      off = contentStart + contentLen
      continue
    }
    if (typeflag !== '0' && typeflag !== '\u0000') {
      // '1' hardlink, '2' symlink, '3'/'4' char/block device, '6' fifo,
      // '7' contiguous — all rejected (fail closed).
      throw new ArchiveScanError('archive_special_entry',
        `${fileName}: entry ${name} has typeflag '${typeflag}' — symlink/hardlink/device/FIFO are rejected`)
    }
    if (gnuLongName !== null) {
      name = gnuLongName
      gnuLongName = null
    } else {
      const prefix = ascii(header, 345, 500)
      if (prefix !== '') name = `${prefix}/${name}`
    }
    if (name === '') {
      throw new ArchiveScanError('archive_path_invalid', `${fileName}: empty entry name`)
    }
    const clean = checkEntryPath(name, seen, seenFold, fileName)
    checkEntryCaps(fileName, size, limits, state, undefined, enforceCaps)
    entries.push({ path: clean, size, contentStart })
    off = contentStart + contentLen
  }
  return entries
}

function scanTar(bytes: Uint8Array, fileName: string, limits: ArchiveLimits, compressedBytes: number, enforceCaps = true): ArchiveScanResult {
  const entries = walkTar(bytes, fileName, limits, compressedBytes, enforceCaps)
  return {
    kind: 'tar',
    entries: entries.map(e => ({ path: e.path, size_bytes: e.size })),
    extracted_bytes: entries.reduce((sum, e) => sum + e.size, 0),
  }
}

function gunzipBounded(bytes: Uint8Array, fileName: string, limits: ArchiveLimits): Buffer {
  try {
    return gunzipSync(bytes, { maxOutputLength: limits.maxTotalBytes + 1 })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ArchiveScanError('archive_bomb',
        `${fileName}: decompressed size exceeds max_total_bytes=${limits.maxTotalBytes}`)
    }
    throw new ArchiveScanError('archive_unsupported_format',
      `${fileName}: gzip decompression failed: ${(error as Error).message}`)
  }
}

function scanTarGz(bytes: Uint8Array, fileName: string, limits: ArchiveLimits): ArchiveScanResult {
  const tar = gunzipBounded(bytes, fileName, limits)
  if (!ascii(tar, 257, 263).startsWith('ustar')) {
    // A .gz that is not a tar (e.g. data.csv.gz) — not scannable, but it is
    // a legitimate format: the caller records `unsupported` (NOT rejected)
    // and the file stays adoptable as an opaque code artifact.
    throw new ArchiveScanError('archive_gzip_single_file',
      `${fileName}: gzip member is not a tar archive (single-file gzip is not unpacked)`)
  }
  const result = scanTar(tar, fileName, limits, bytes.length)
  return { ...result, kind: 'tgz' }
}

/**
 * Extract the CONTENT of specific entries (adoption-time materialization).
 * Re-parses the archive (bounded) and returns wanted path → bytes. Unknown
 * paths are simply absent from the map. Throws ArchiveScanError on any
 * safety violation (the caller records a gap — never fails the adoption).
 */
export function extractArchiveEntries(
  bytes: Uint8Array,
  fileName: string,
  wanted: string[],
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
  opts: { enforceCaps?: boolean } = {},
): Map<string, Buffer> {
  const kind = archiveKindOf(fileName, bytes)
  if (kind === null) {
    throw new ArchiveScanError('archive_unsupported_format', `${fileName}: not a supported archive`)
  }
  const enforceCaps = opts.enforceCaps ?? true
  const want = new Set(wanted)
  const out = new Map<string, Buffer>()
  if (kind === 'zip') {
    for (const entry of readZipCentralDir(bytes, fileName, limits, enforceCaps)) {
      if (want.has(entry.path)) out.set(entry.path, inflateEntry(fileName, entry, bytes, limits))
    }
    return out
  }
  // tar / tgz
  const tar = kind === 'tgz' ? gunzipBounded(bytes, fileName, limits) : Buffer.from(bytes)
  for (const entry of walkTar(tar, fileName, limits, bytes.length, enforceCaps)) {
    if (want.has(entry.path)) {
      out.set(entry.path, Buffer.from(tar.subarray(entry.contentStart, entry.contentStart + entry.size)))
    }
  }
  return out
}
