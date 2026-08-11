/**
 * ONBOARD-01 — intake archive unpack scan + TeX/CodeSnapshot adoption
 * materialization tests (research-onboarding.md §4.2/§6.1, archive-scan.ts,
 * adoptIntake materialization).
 *
 * Covers:
 *  - controlled zip / tar.gz unpack scan (unpacked view, scan_summary
 *    extracted_entries/extracted_bytes, pre-accept zero authority — the
 *    scan only writes intake tables + the isolated staging CAS);
 *  - deep-scan refusals: path escapes (absolute/../NUL/drive/backslash),
 *    duplicate + case-colliding paths, symlink/hardlink/device entries,
 *    zip bombs (compression ratio / entry count / total bytes / per-file);
 *  - single-file gzip → recorded `unsupported`, stays adoptable;
 *  - adoption materialization: TeX entries → tex document (version 1,
 *    document_id rule, import_mappings), code entries → code workspace +
 *    optional CodeSnapshot, direct TeX/code files, non-TeX/code entries →
 *    gap, over-limit materialization failure → gap with adopt still
 *    succeeding, unscannable archives → gap;
 *  - materialization never rolls back the adoption (authoritative import).
 */
import { describe, expect, it, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { gzipSync, deflateRawSync } from 'node:zlib'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel, KernelError } from '@dsh-scholar/research-kernel'
import type { AdoptionReceipt, GrillAnswerView, ImportMapping } from '@dsh-scholar/research-schemas'

const REAL_LIMITS = {
  entries: ResearchKernel.ARCHIVE_MAX_ENTRIES,
  total: ResearchKernel.ARCHIVE_MAX_TOTAL_BYTES,
  file: ResearchKernel.ARCHIVE_MAX_FILE_BYTES,
  ratio: ResearchKernel.ARCHIVE_MAX_RATIO,
}

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-intake-mat-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief() {
  return {
    problem: 'p', scope: 's', questions: [], primary_metrics: ['m'],
    resources: '', risks: [], target_outputs: ['paper'], target_venue: null,
    baseline_repo: null, domain: 'ml',
  }
}

const PRINCIPAL = { principal_id: 'pi-1', tenant_id: 'acme', auth_method: 'dsh-session', session_id: 'sess-1' }

function count(kernel: ResearchKernel, table: string): number {
  const row = kernel.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return Number(row.n)
}

function expectKernelError(fn: () => unknown, status: number, code: string): void {
  try {
    fn()
    throw new Error('expected KernelError to be thrown')
  } catch (error) {
    expect(error).toBeInstanceOf(KernelError)
    expect((error as KernelError).status).toBe(status)
    expect((error as KernelError).code).toBe(code)
  }
}

function allRequiredAnswers(questions: GrillAnswerView[], phase = 'experiment'): Array<{ question_code: string; answer: string; question_revision: number }> {
  return questions.filter(q => q.required).map(q => ({
    question_code: q.question_code,
    answer: q.question_code === 'observed_phase_claim' ? phase : 'yes',
    question_revision: q.question_revision,
  }))
}

/** Run the full pre-accept chain and adopt. */
function adopt(kernel: ResearchKernel, projectId: string, files: Array<{ file_name: string; content: Uint8Array | string }>, targetPhase = 'experiment'): AdoptionReceipt {
  const intake = kernel.beginIntake({ project_id: projectId, source_label: 'imported-package', target_phase: targetPhase })
  for (const file of files) {
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: file.file_name, content: file.content })
  }
  const scanned = kernel.scanIntake(intake.intake_id)
  kernel.submitIntakeAnswers(intake.intake_id, allRequiredAnswers(scanned.questions, targetPhase), PRINCIPAL)
  const proposal = kernel.proposeIntake(intake.intake_id)
  return kernel.adoptIntake({ intake_id: intake.intake_id, expected_proposal_revision: proposal.revision }, PRINCIPAL)
}

// ── minimal ZIP builder (local headers + central directory + EOCD) ───────

interface ZipFile {
  name: string
  content: Buffer
  /** Unix mode (high bits of the external attrs), e.g. 0o120777 = symlink. */
  mode?: number
  /** 0 = stored, 8 = deflate (default). */
  method?: number
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function makeZip(files: ZipFile[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  const nameBuf = (name: string): Buffer => Buffer.from(name, 'utf8')
  for (const file of files) {
    const name = nameBuf(file.name)
    const method = file.method ?? 8
    const compressed = method === 8 ? deflateRawSync(file.content) : file.content
    const crc = crc32(file.content)
    const mode = file.mode ?? 0o100644
    // version made by: 3 (unix) << 8 | 20; external attrs carry the mode.
    const versionMadeBy = (3 << 8) | 20
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(file.content.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    // local header offset = bytes of all previous files (chunks so far)
    const localOffset = chunks.reduce((sum, c) => sum + c.length, 0)
    chunks.push(local, name, compressed)
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(versionMadeBy, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(file.content.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra len
    centralHeader.writeUInt16LE(0, 32) // comment len
    centralHeader.writeUInt32LE((mode << 16) >>> 0, 38) // external attrs (mode in high bits)
    centralHeader.writeUInt32LE(localOffset, 42)
    central.push(centralHeader, name)
  }
  const centralDir = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(chunks.reduce((sum, c) => sum + c.length, 0), 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralDir, eocd])
}

// ── minimal TAR builder (POSIX ustar) ─────────────────────────────────────

interface TarFile {
  name: string
  content: Buffer
  typeflag?: string // '0' file (default), '5' dir, '2' symlink, '1' hardlink, '6' fifo
  linkname?: string
}

function tarHeader(name: string, size: number, typeflag: string, linkname = ''): Buffer {
  const header = Buffer.alloc(512)
  header.write(name.slice(0, 100), 0, 'utf8')
  header.write('0000644\0', 100, 'ascii') // mode
  header.write('0000000\0', 108, 'ascii') // uid
  header.write('0000000\0', 116, 'ascii') // gid
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii') // mtime
  header.write(typeflag, 156, 'ascii')
  header.write(linkname.slice(0, 100), 157, 'utf8')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  // checksum: sum of all bytes with the field as spaces
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return header
}

function makeTar(files: TarFile[]): Buffer {
  const chunks: Buffer[] = []
  for (const file of files) {
    chunks.push(tarHeader(file.name, file.content.length, file.typeflag ?? '0', file.linkname))
    chunks.push(file.content)
    if (file.content.length % 512 !== 0) chunks.push(Buffer.alloc(512 - (file.content.length % 512)))
  }
  chunks.push(Buffer.alloc(1024)) // two zero blocks
  return Buffer.concat(chunks)
}

function makeTarGz(files: TarFile[]): Buffer {
  return gzipSync(makeTar(files))
}

// ── helpers ───────────────────────────────────────────────────────────────

function archiveExtractOf(kernel: ResearchKernel, intakeId: string, fileName: string): Record<string, unknown> {
  const projection = kernel.getIntakeProjection(intakeId)
  const artifact = projection.artifacts.find(a => a.file_name === fileName)
  if (artifact === undefined) throw new Error(`artifact ${fileName} not found`)
  return artifact.scan_result.archive_extract as Record<string, unknown>
}

function mappingsOf(receipt: AdoptionReceipt): ImportMapping[] {
  return receipt.import_mappings
}

function mappingBySource(mappings: ImportMapping[], source: string, targetKind?: string): ImportMapping | undefined {
  return mappings.find(m => m.source_file_name === source && (targetKind === undefined || m.target_kind === targetKind))
}

afterEach(() => {
  ResearchKernel.ARCHIVE_MAX_ENTRIES = REAL_LIMITS.entries
  ResearchKernel.ARCHIVE_MAX_TOTAL_BYTES = REAL_LIMITS.total
  ResearchKernel.ARCHIVE_MAX_FILE_BYTES = REAL_LIMITS.file
  ResearchKernel.ARCHIVE_MAX_RATIO = REAL_LIMITS.ratio
})

describe('ONBOARD-01 archive unpack scan (zip)', () => {
  it('produces an unpacked view: scan_result.archive_extract + scan_summary totals, zero authority preserved', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'brief' })
    const zip = makeZip([
      { name: 'src/main.py', content: Buffer.from('print(1)\n') },
      { name: 'paper.tex', content: Buffer.from('\\documentclass{article}\n') },
    ])
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'pkg.zip', content: zip })
    const scanned = kernel.scanIntake(intake.intake_id)
    expect(scanned.artifacts[0]?.quarantine).toBe('clean')
    const extract = archiveExtractOf(kernel, intake.intake_id, 'pkg.zip')
    expect(extract.status).toBe('ok')
    expect(extract.kind).toBe('zip')
    expect(extract.extracted_entries).toBe(2)
    expect(extract.extracted_bytes).toBe('print(1)\n'.length + '\\documentclass{article}\n'.length)
    expect(extract.entries).toEqual([
      { path: 'src/main.py', size_bytes: 'print(1)\n'.length },
      { path: 'paper.tex', size_bytes: '\\documentclass{article}\n'.length },
    ])
    expect(scanned.session.scan_summary.extracted_entries).toBe(2)
    expect(scanned.session.scan_summary.extracted_bytes).toBe(extract.extracted_bytes)
    expect(scanned.observations.some(o => o.detector === 'archive_extract' && o.warnings.includes('archive_extract_ok'))).toBe(true)
    // Pre-accept zero authority: the deep scan wrote ONLY intake tables.
    expect(count(kernel, 'workspaces')).toBe(0)
    expect(count(kernel, 'tex_documents')).toBe(0)
    expect(count(kernel, 'artifacts')).toBe(0)
    expect(readdirSync(join(kernel.intakeStagedRoot, intake.intake_id))).toHaveLength(1)
    kernel.close()
  })

  it('rejects path escapes: ../, absolute, NUL, backslash, drive prefix → quarantined (fail closed)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const cases: Array<[string, string]> = [
      ['../evil.txt', 'archive_path_invalid'],
      ['/abs.txt', 'archive_path_invalid'],
      ['a\u0000b.txt', 'archive_path_invalid'],
      ['sub\\win.txt', 'archive_path_invalid'],
      ['C:\\win.txt', 'archive_path_invalid'],
    ]
    for (const [entry, code] of cases) {
      const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's' })
      kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'pkg.zip', content: makeZip([{ name: entry, content: Buffer.from('x') }]) })
      const scanned = kernel.scanIntake(intake.intake_id)
      expect(scanned.artifacts[0]?.quarantine).toBe('quarantined')
      const extract = archiveExtractOf(kernel, intake.intake_id, 'pkg.zip')
      expect(extract.status).toBe('rejected')
      expect(extract.code).toBe(code)
      expect(scanned.observations.some(o => o.detector === 'archive_extract' && o.warnings.includes('archive_extract_rejected'))).toBe(true)
      // Quarantined archives block adoption.
      const questions = kernel.getIntakeQuestions(intake.intake_id).questions
      kernel.submitIntakeAnswers(intake.intake_id, allRequiredAnswers(questions, 'brief'), PRINCIPAL)
      const proposal = kernel.proposeIntake(intake.intake_id)
      expectKernelError(
        () => kernel.adoptIntake({ intake_id: intake.intake_id, expected_proposal_revision: proposal.revision }, PRINCIPAL),
        422, 'artifact_quarantined')
    }
    kernel.close()
  })

  it('rejects duplicate and case-colliding paths (archive_duplicate_path)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const dup = kernel.beginIntake({ project_id: project.project_id, source_label: 'd' })
    kernel.stageIntakeArtifact(dup.intake_id, { file_name: 'pkg.zip', content: makeZip([
      { name: 'a/x.txt', content: Buffer.from('1') },
      { name: 'a/x.txt', content: Buffer.from('2') },
    ]) })
    kernel.scanIntake(dup.intake_id)
    expect(archiveExtractOf(kernel, dup.intake_id, 'pkg.zip').code).toBe('archive_duplicate_path')
    const coll = kernel.beginIntake({ project_id: project.project_id, source_label: 'c' })
    kernel.stageIntakeArtifact(coll.intake_id, { file_name: 'pkg.zip', content: makeZip([
      { name: 'A/x.TXT', content: Buffer.from('1') },
      { name: 'a/x.txt', content: Buffer.from('2') },
    ]) })
    kernel.scanIntake(coll.intake_id)
    expect(archiveExtractOf(kernel, coll.intake_id, 'pkg.zip').code).toBe('archive_duplicate_path')
    kernel.close()
  })

  it('rejects symlink and device entries (archive_special_entry) for zip and tar', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    // zip symlink via unix mode S_IFLNK (0o120777).
    const zipLink = kernel.beginIntake({ project_id: project.project_id, source_label: 'z' })
    kernel.stageIntakeArtifact(zipLink.intake_id, { file_name: 'pkg.zip', content: makeZip([
      { name: 'link', content: Buffer.from('../etc/passwd'), mode: 0o120777 },
    ]) })
    kernel.scanIntake(zipLink.intake_id)
    expect(archiveExtractOf(kernel, zipLink.intake_id, 'pkg.zip').code).toBe('archive_special_entry')
    // tar symlink typeflag '2'.
    const tarLink = kernel.beginIntake({ project_id: project.project_id, source_label: 't' })
    kernel.stageIntakeArtifact(tarLink.intake_id, { file_name: 'pkg.tar', content: makeTar([
      { name: 'link', content: Buffer.alloc(0), typeflag: '2', linkname: '/etc/passwd' },
    ]) })
    kernel.scanIntake(tarLink.intake_id)
    expect(archiveExtractOf(kernel, tarLink.intake_id, 'pkg.tar').code).toBe('archive_special_entry')
    // tar fifo typeflag '6'.
    const tarFifo = kernel.beginIntake({ project_id: project.project_id, source_label: 'f' })
    kernel.stageIntakeArtifact(tarFifo.intake_id, { file_name: 'pkg.tar', content: makeTar([
      { name: 'fifo', content: Buffer.alloc(0), typeflag: '6' },
    ]) })
    kernel.scanIntake(tarFifo.intake_id)
    expect(archiveExtractOf(kernel, tarFifo.intake_id, 'pkg.tar').code).toBe('archive_special_entry')
    kernel.close()
  })

  it('rejects zip bombs: compression ratio, entry count, total bytes and per-file caps', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    // Ratio bomb: 2 MiB of zeros deflates to ~2 KiB → >100x.
    const ratioBomb = kernel.beginIntake({ project_id: project.project_id, source_label: 'r' })
    kernel.stageIntakeArtifact(ratioBomb.intake_id, { file_name: 'bomb.zip', content: makeZip([
      { name: 'zeros.bin', content: Buffer.alloc(2 * 1024 * 1024) },
    ]) })
    kernel.scanIntake(ratioBomb.intake_id)
    expect(archiveExtractOf(kernel, ratioBomb.intake_id, 'bomb.zip').code).toBe('archive_bomb')
    // Entry-count cap (lowered for the test).
    ResearchKernel.ARCHIVE_MAX_ENTRIES = 3
    const countBomb = kernel.beginIntake({ project_id: project.project_id, source_label: 'n' })
    kernel.stageIntakeArtifact(countBomb.intake_id, { file_name: 'many.zip', content: makeZip(
      Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, content: Buffer.from(`x${i}`) })),
    ) })
    kernel.scanIntake(countBomb.intake_id)
    expect(archiveExtractOf(kernel, countBomb.intake_id, 'many.zip').code).toBe('archive_bomb')
    ResearchKernel.ARCHIVE_MAX_ENTRIES = REAL_LIMITS.entries
    // Total-bytes cap.
    ResearchKernel.ARCHIVE_MAX_TOTAL_BYTES = 1024
    const totalBomb = kernel.beginIntake({ project_id: project.project_id, source_label: 'o' })
    kernel.stageIntakeArtifact(totalBomb.intake_id, { file_name: 'big.zip', content: makeZip([
      { name: 'a.txt', content: Buffer.alloc(700, 0x61) },
      { name: 'b.txt', content: Buffer.alloc(700, 0x62) },
    ]) })
    kernel.scanIntake(totalBomb.intake_id)
    expect(archiveExtractOf(kernel, totalBomb.intake_id, 'big.zip').code).toBe('archive_bomb')
    ResearchKernel.ARCHIVE_MAX_TOTAL_BYTES = REAL_LIMITS.total
    // Per-file cap.
    ResearchKernel.ARCHIVE_MAX_FILE_BYTES = 100
    const fileBomb = kernel.beginIntake({ project_id: project.project_id, source_label: 'p' })
    kernel.stageIntakeArtifact(fileBomb.intake_id, { file_name: 'one.zip', content: makeZip([
      { name: 'a.txt', content: Buffer.alloc(200, 0x61) },
    ]) })
    kernel.scanIntake(fileBomb.intake_id)
    expect(archiveExtractOf(kernel, fileBomb.intake_id, 'one.zip').code).toBe('archive_file_too_large')
    kernel.close()
  })

  it('single-file gzip is recorded unsupported and stays adoptable', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'data.csv.gz', content: gzipSync(Buffer.from('a,b\n1,2\n')) })
    const scanned = kernel.scanIntake(intake.intake_id)
    expect(scanned.artifacts[0]?.quarantine).toBe('clean')
    expect(archiveExtractOf(kernel, intake.intake_id, 'data.csv.gz').status).toBe('unsupported')
    const questions = kernel.getIntakeQuestions(intake.intake_id).questions
    kernel.submitIntakeAnswers(intake.intake_id, allRequiredAnswers(questions, 'brief'), PRINCIPAL)
    const proposal = kernel.proposeIntake(intake.intake_id)
    const receipt = kernel.adoptIntake({ intake_id: intake.intake_id, expected_proposal_revision: proposal.revision }, PRINCIPAL)
    // The gz is adopted as a code artifact; a gap mapping records that its
    // entries were never unpacked.
    expect(receipt.created_object_refs).toHaveLength(1)
    const gzGap = receipt.import_mappings.find(m => m.source_file_name === 'data.csv.gz' && m.status === 'gap')
    expect(gzGap?.reason).toContain('archive_not_unpacked:unsupported')
    expect(count(kernel, 'workspaces')).toBe(0)
    expect(count(kernel, 'tex_documents')).toBe(0)
    kernel.close()
  })
})

describe('ONBOARD-01 archive unpack scan (tar.gz)', () => {
  it('scans tar.gz entries (path safety + caps shared with zip)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's' })
    const tgz = makeTarGz([
      { name: 'src/run.py', content: Buffer.from('import os\n') },
      { name: 'refs.bib', content: Buffer.from('@article{x}\n') },
    ])
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'pkg.tar.gz', content: tgz })
    const scanned = kernel.scanIntake(intake.intake_id)
    expect(scanned.artifacts[0]?.quarantine).toBe('clean')
    const extract = archiveExtractOf(kernel, intake.intake_id, 'pkg.tar.gz')
    expect(extract.status).toBe('ok')
    expect(extract.kind).toBe('tgz')
    expect(extract.entries).toEqual([
      { path: 'src/run.py', size_bytes: 'import os\n'.length },
      { path: 'refs.bib', size_bytes: '@article{x}\n'.length },
    ])
    // tar.gz path escape → quarantined.
    const evil = kernel.beginIntake({ project_id: project.project_id, source_label: 'e' })
    kernel.stageIntakeArtifact(evil.intake_id, { file_name: 'evil.tar.gz', content: makeTarGz([
      { name: '../../escape.txt', content: Buffer.from('x') },
    ]) })
    kernel.scanIntake(evil.intake_id)
    expect(archiveExtractOf(kernel, evil.intake_id, 'evil.tar.gz').code).toBe('archive_path_invalid')
    // tar.gz total-bytes bomb (lowered cap).
    ResearchKernel.ARCHIVE_MAX_TOTAL_BYTES = 2048
    const bomb = kernel.beginIntake({ project_id: project.project_id, source_label: 'b' })
    kernel.stageIntakeArtifact(bomb.intake_id, { file_name: 'big.tar.gz', content: makeTarGz([
      { name: 'a.txt', content: Buffer.alloc(3000, 0x61) },
    ]) })
    kernel.scanIntake(bomb.intake_id)
    expect(archiveExtractOf(kernel, bomb.intake_id, 'big.tar.gz').code).toBe('archive_bomb')
    kernel.close()
  })

  it('rejects corrupt gzip and non-ustar tar content (archive_unsupported_format)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const corrupt = kernel.beginIntake({ project_id: project.project_id, source_label: 'c' })
    kernel.stageIntakeArtifact(corrupt.intake_id, { file_name: 'x.tar.gz', content: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02]) })
    kernel.scanIntake(corrupt.intake_id)
    expect(archiveExtractOf(kernel, corrupt.intake_id, 'x.tar.gz').code).toBe('archive_unsupported_format')
    const notTar = kernel.beginIntake({ project_id: project.project_id, source_label: 'n' })
    kernel.stageIntakeArtifact(notTar.intake_id, { file_name: 'x.tar', content: Buffer.from('plain text, not a tar') })
    kernel.scanIntake(notTar.intake_id)
    expect(archiveExtractOf(kernel, notTar.intake_id, 'x.tar').code).toBe('archive_unsupported_format')
    kernel.close()
  })
})

describe('ONBOARD-01 adoption materialization (TeX + code)', () => {
  it('materializes archive TeX entries into the tex document (version 1, document_id rule, mappings)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const receipt = adopt(kernel, project.project_id, [
      { file_name: 'manuscript.zip', content: makeZip([
        { name: 'paper.tex', content: Buffer.from('\\documentclass{article}\\begin{document}hi\\end{document}') },
        { name: 'refs.bib', content: Buffer.from('@article{key,title={T}}') },
        { name: 'README.md', content: Buffer.from('# readme') },
      ]) },
    ], 'writing')
    // TeX document appeared in the project.
    const document = kernel.tex.findDocument(project.project_id)
    expect(document).not.toBeNull()
    expect(document!.root_file).toBe('paper.tex')
    // document_id rule: tex-workspace ensureDocument `doc_<uuid12>`.
    expect(document!.document_id).toMatch(/^doc_[0-9a-f-]{12}$/)
    const tree = kernel.tex.tree(document!.document_id)
    const texFile = tree.files.find(f => f.path === 'paper.tex')
    const bibFile = tree.files.find(f => f.path === 'refs.bib')
    expect(texFile?.version).toBe(1)
    expect(bibFile?.version).toBe(1)
    expect(kernel.tex.readFile(document!.document_id, 'paper.tex')?.content).toBe('\\documentclass{article}\\begin{document}hi\\end{document}')
    // Mappings: tex entries materialized to the document; README.md stays a
    // gap (paper-kind entry is not TeX/code) — the zip itself is adopted.
    const mappings = mappingsOf(receipt)
    const texMapping = mappingBySource(mappings, 'paper.tex', 'tex_document')
    expect(texMapping?.status).toBe('materialized')
    expect(texMapping?.target).toBe(document!.document_id)
    const bibMapping = mappingBySource(mappings, 'refs.bib', 'tex_document')
    expect(bibMapping?.status).toBe('materialized')
    expect(mappingBySource(mappings, 'README.md')?.status).toBe('gap')
    expect(mappingBySource(mappings, 'README.md')?.reason).toBe('entry_type_not_materialized')
    const archiveMapping = mappingBySource(mappings, 'manuscript.zip')
    expect(archiveMapping?.status).toBe('materialized')
    // No code entries → no code workspace, no snapshot.
    expect(kernel.workspaces.listByProject(project.project_id)).toHaveLength(0)
    expect(receipt.code_snapshot_refs).toHaveLength(0)
    // The staged dir is gone (materialization ran before GC).
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    expect(existsSync(join(kernel.intakeStagedRoot, receipt.intake_id))).toBe(false)
    kernel.close()
  })

  it('materializes code entries into the code workspace and generates a CodeSnapshot', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const receipt = adopt(kernel, project.project_id, [
      { file_name: 'repro.zip', content: makeZip([
        { name: 'src/main.py', content: Buffer.from('print("hello")\n') },
        { name: 'run.sh', content: Buffer.from('#!/bin/sh\necho run\n') },
      ]) },
    ])
    const workspaces = kernel.workspaces.listByProject(project.project_id)
    expect(workspaces).toHaveLength(1)
    const ws = workspaces[0]!
    expect(ws.kind).toBe('code')
    expect(ws.name).toMatch(/^intake-/)
    const node = kernel.workspaces.read(ws.workspace_id, 'src/main.py')
    expect(node?.version).toBe(1)
    expect(node?.content).toBe('print("hello")\n')
    expect(kernel.workspaces.read(ws.workspace_id, 'run.sh')?.content).toBe('#!/bin/sh\necho run\n')
    // Mappings point at the code workspace paths.
    const main = mappingBySource(receipt.import_mappings, 'src/main.py', 'code_workspace')
    expect(main?.status).toBe('materialized')
    expect(main?.target).toBe('code/src/main.py')
    // Optional CodeSnapshot over the workspace (workspace semantics).
    expect(receipt.code_snapshot_refs).toHaveLength(1)
    const snapshot = kernel.getCodeSnapshot(receipt.code_snapshot_refs[0]!)
    expect(snapshot.project_id).toBe(project.project_id)
    expect(snapshot.source.workspace_id).toBe(ws.workspace_id)
    expect(snapshot.file_count).toBe(2)
    // Staged files GC'd after materialization; artifacts include the zip +
    // the snapshot's code archive + manifest.
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    expect(existsSync(join(kernel.intakeStagedRoot, receipt.intake_id))).toBe(false)
    expect(kernel.listArtifacts(project.project_id).length).toBe(3)
    kernel.close()
  })

  it('materializes direct TeX and code files (non-archive) with mappings', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const receipt = adopt(kernel, project.project_id, [
      { file_name: 'paper.tex', content: '\\documentclass{article}\n' },
      { file_name: 'train.py', content: 'import torch\n' },
      { file_name: 'results.csv', content: 'm,1\n' },
    ], 'writing')
    const document = kernel.tex.findDocument(project.project_id)!
    const texFile = kernel.tex.readFile(document.document_id, 'paper.tex')
    expect(texFile?.version).toBe(1)
    const texMapping = mappingBySource(receipt.import_mappings, 'paper.tex', 'tex_document')
    expect(texMapping?.status).toBe('materialized')
    expect(texMapping?.target).toBe(document.document_id)
    const codeWorkspaces = kernel.workspaces.listByProject(project.project_id)
    expect(codeWorkspaces).toHaveLength(1)
    expect(kernel.workspaces.read(codeWorkspaces[0]!.workspace_id, 'train.py')?.content).toBe('import torch\n')
    const codeMapping = mappingBySource(receipt.import_mappings, 'train.py', 'code_workspace')
    expect(codeMapping?.status).toBe('materialized')
    expect(codeMapping?.target).toBe('code/train.py')
    // Direct non-TeX/code files stay artifacts only (mapping materialized
    // at the artifact level; no workspace row).
    const csvMapping = mappingBySource(receipt.import_mappings, 'results.csv')
    expect(csvMapping?.target_kind).toBe('data')
    expect(csvMapping?.status).toBe('materialized')
    expect(csvMapping?.reason).toBe('adopted as project artifact')
    expect(codeWorkspaces[0]!.name).toMatch(/^intake-/)
    kernel.close()
  })

  it('over-limit CODE entry at materialization → gap mapping, adopt succeeds, other entries materialized', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    // Incompressible content: passes the scan's ratio cap, but exceeds the
    // per-file cap when materialization re-extracts it.
    const big = randomBytes(2048)
    const zip = makeZip([
      { name: 'ok.py', content: Buffer.from('print(1)\n') },
      { name: 'big.py', content: big },
    ])
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'brief' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'pkg.zip', content: zip })
    const scanned = kernel.scanIntake(intake.intake_id)
    expect(scanned.artifacts[0]?.quarantine).toBe('clean')
    kernel.submitIntakeAnswers(intake.intake_id, allRequiredAnswers(scanned.questions, 'brief'), PRINCIPAL)
    const proposal = kernel.proposeIntake(intake.intake_id)
    ResearchKernel.ARCHIVE_MAX_FILE_BYTES = 1024
    const receipt = kernel.adoptIntake({ intake_id: intake.intake_id, expected_proposal_revision: proposal.revision }, PRINCIPAL)
    // Adoption succeeded (authoritative import) with a gap for big.py.
    expect(kernel.getIntakeProjection(intake.intake_id).session.status).toBe('accepted')
    const ok = mappingBySource(receipt.import_mappings, 'ok.py', 'code_workspace')
    expect(ok?.status).toBe('materialized')
    const gap = receipt.import_mappings.find(m => m.source_file_name === 'big.py')
    expect(gap?.status).toBe('gap')
    expect(gap?.reason).toContain('archive_file_too_large')
    // ok.py is still in the code workspace.
    const ws = kernel.workspaces.listByProject(project.project_id)[0]!
    expect(kernel.workspaces.read(ws.workspace_id, 'ok.py')?.content).toBe('print(1)\n')
    expect(kernel.workspaces.read(ws.workspace_id, 'big.py')).toBeNull()
    kernel.close()
  })

  it('two archives with the same code path: second write conflicts → gap, no silent overwrite', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const receipt = adopt(kernel, project.project_id, [
      { file_name: 'a.zip', content: makeZip([{ name: 'src/x.py', content: Buffer.from('v1\n') }]) },
      { file_name: 'b.zip', content: makeZip([{ name: 'src/x.py', content: Buffer.from('v2\n') }]) },
    ], 'brief')
    const first = mappingBySource(receipt.import_mappings, 'src/x.py', 'code_workspace')
    expect(first?.status).toBe('materialized')
    const ws = kernel.workspaces.listByProject(project.project_id)[0]!
    expect(kernel.workspaces.read(ws.workspace_id, 'src/x.py')?.content).toBe('v1\n')
    // The second archive's entry failed with a workspace version conflict.
    const conflicts = receipt.import_mappings.filter(m => m.source_artifact_id !== first?.source_artifact_id && m.source_file_name === 'src/x.py')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.status).toBe('gap')
    expect(conflicts[0]?.reason).toContain('workspace_version_conflict')
    kernel.close()
  })

  it('adoption replay returns the same receipt including import_mappings', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const intake = kernel.beginIntake({ project_id: project.project_id, source_label: 's', target_phase: 'brief' })
    kernel.stageIntakeArtifact(intake.intake_id, { file_name: 'pkg.zip', content: makeZip([{ name: 'paper.tex', content: Buffer.from('% t') }]) })
    const scanned = kernel.scanIntake(intake.intake_id)
    kernel.submitIntakeAnswers(intake.intake_id, allRequiredAnswers(scanned.questions, 'brief'), PRINCIPAL)
    const proposal = kernel.proposeIntake(intake.intake_id)
    const first = kernel.adoptIntake({
      intake_id: intake.intake_id, expected_proposal_revision: proposal.revision,
      idempotency_key: 'adopt-1', request_hash: 'h1',
    }, PRINCIPAL)
    expect(first.import_mappings.length).toBeGreaterThan(0)
    const replay = kernel.adoptIntake({
      intake_id: intake.intake_id, expected_proposal_revision: proposal.revision,
      idempotency_key: 'adopt-1', request_hash: 'h1',
    }, PRINCIPAL)
    expect(replay.adoption_id).toBe(first.adoption_id)
    expect(replay.import_mappings).toEqual(first.import_mappings)
    kernel.close()
  })

  it('keeps pre-existing adopt semantics: metrics/log/pdf intakes materialize nothing extra', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 't', workspace: '/w', brief: makeBrief() })
    const receipt = adopt(kernel, project.project_id, [
      { file_name: 'paper.pdf', content: '%PDF-1.4' },
      { file_name: 'run.log', content: 'epoch 1\n' },
      { file_name: 'metrics.json', content: JSON.stringify({ schema_version: 1, metrics: [{ name: 'acc', value: 1, unit: null }] }) },
    ], 'brief')
    expect(count(kernel, 'workspaces')).toBe(0)
    expect(count(kernel, 'tex_documents')).toBe(0)
    expect(receipt.code_snapshot_refs).toHaveLength(0)
    expect(receipt.draft_evidence_refs).toHaveLength(1)
    // Artifact-level mappings only (adopted as project artifacts).
    expect(receipt.import_mappings).toHaveLength(3)
    expect(receipt.import_mappings.every(m => m.status === 'materialized' && m.target === '')).toBe(true)
    kernel.close()
  })
})
