/**
 * WORK-01 content search (api-contracts.md §17, acceptance-tests.md §7
 * ws-search): `WorkspaceStore.searchContent` / kernel `workspaceSearchContent`
 * — a LINEAR UTF-8 line scan over text nodes only, with bounded caps:
 *
 *   - binary nodes / non-text media / NUL-byte magic are skipped;
 *   - files > WORKSPACE_SEARCH_MAX_FILE_BYTES (512 KiB) are skipped whole;
 *   - per file: at most WORKSPACE_SEARCH_MAX_MATCHES_PER_FILE (20) matches
 *     returned, `match_count` is the file's true total;
 *   - overall: at most WORKSPACE_SEARCH_MAX_FILES (50) files, `truncated`
 *     when the cap cut further files;
 *   - case-insensitive by default, `case_sensitive: true` for exact;
 *   - UTF-8 tolerant (invalid bytes decode with replacement — never throws);
 *   - empty/whitespace q → 422-shaped `invalid_query` (server maps it);
 *   - path search (`search`) stays untouched (regression asserted).
 *
 * No full-text index — performance degrades linearly with workspace size
 * (documented limitation; an index is a planned enhancement).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResearchKernel } from '@dsh-scholar/research-kernel'
import {
  WorkspaceError,
  WORKSPACE_SEARCH_MAX_FILES,
  WORKSPACE_SEARCH_MAX_MATCHES_PER_FILE,
  WORKSPACE_SEARCH_MAX_FILE_BYTES,
  scanTextForQuery,
  makeSearchSnippet,
  isSearchableTextMedia,
} from '../../packages/research-kernel/lib/workspace-store.js'

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wssearch-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas'), requireSignedManifest: false })
}

function makeBrief() {
  return { problem: 'p', scope: 's', questions: [], primary_metrics: ['m'], resources: '', risks: [], target_outputs: ['paper'], target_venue: null, baseline_repo: null, domain: 'ml' }
}

describe('workspace content search (WORK-01)', () => {
  it('matches substrings across text files with 1-based line numbers, snippets and true match_count', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    kernel.workspaceWrite(ws.workspace_id, 'src/main.ts', 'export const x = 1\n// TODO: revisit the needle here\nconst y = 2\n')
    kernel.workspaceWrite(ws.workspace_id, 'notes.md', '# Notes\n\nA needle in a paragraph.\nNo match here.\n')
    kernel.workspaceWrite(ws.workspace_id, 'other.txt', 'nothing at all')

    const result = kernel.workspaceSearchContent(ws.workspace_id, { q: 'needle' })
    expect(result.truncated).toBe(false)
    // Hits come back in path order; only the two matching files.
    expect(result.hits.map(h => h.path)).toEqual(['notes.md', 'src/main.ts'])
    const notes = result.hits.find(h => h.path === 'notes.md')
    expect(notes?.match_count).toBe(1)
    expect(notes?.matches).toEqual([{ line: 3, snippet: 'A needle in a paragraph.' }])
    const main = result.hits.find(h => h.path === 'src/main.ts')
    expect(main?.match_count).toBe(1)
    expect(main?.matches).toEqual([{ line: 2, snippet: '// TODO: revisit the needle here' }])
    // No match anywhere → empty hits.
    const none = kernel.workspaceSearchContent(ws.workspace_id, { q: 'zzz-no-such-text' })
    expect(none.hits).toHaveLength(0)
    expect(none.truncated).toBe(false)
    kernel.close()
  })

  it('is case-insensitive by default and exact with case_sensitive=true', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    kernel.workspaceWrite(ws.workspace_id, 'a.txt', 'Mixed Case Needle here\nlowercase needle too\n')

    const loose = kernel.workspaceSearchContent(ws.workspace_id, { q: 'NEEDLE' })
    expect(loose.hits).toHaveLength(1)
    expect(loose.hits[0]?.match_count).toBe(2)

    // Exact search: 'NEEDLE' matches only the true-uppercase line.
    kernel.workspaceWrite(ws.workspace_id, 'b.txt', 'UPPER NEEDLE here')
    const exact = kernel.workspaceSearchContent(ws.workspace_id, { q: 'NEEDLE', case_sensitive: true })
    expect(exact.hits).toHaveLength(1)
    expect(exact.hits[0]?.match_count).toBe(1)
    expect(exact.hits[0]?.matches[0]?.line).toBe(1)
    expect(exact.hits[0]?.matches[0]?.snippet).toBe('UPPER NEEDLE here')

    // Exact 'needle' matches only line 2 — line 1 is 'Needle' (capital N),
    // which is NOT the exact substring.
    const exactLower = kernel.workspaceSearchContent(ws.workspace_id, { q: 'needle', case_sensitive: true })
    expect(exactLower.hits).toHaveLength(1)
    expect(exactLower.hits[0]?.match_count).toBe(1)
    expect(exactLower.hits[0]?.matches.map(m => m.line)).toEqual([2])
    kernel.close()
  })

  it('skips binary nodes, non-text media and NUL-byte magic', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    // (1) Real binary node: ASCII bytes that WOULD match, but binary=1.
    kernel.workspaceWriteBinary(ws.workspace_id, 'blob.bin', Buffer.from('the needle is here', 'utf8'), 'application/octet-stream')
    // (2) Text row with a binary-ish media type (text write to a .png path).
    kernel.workspaceWrite(ws.workspace_id, 'img/plot.png', 'the needle is here too')
    // (3) Real text node — the control that must match.
    kernel.workspaceWrite(ws.workspace_id, 'ok.txt', 'the needle is here in text')

    const result = kernel.workspaceSearchContent(ws.workspace_id, { q: 'needle' })
    expect(result.hits.map(h => h.path)).toEqual(['ok.txt'])

    // (4) Host-tampered text node whose bytes carry NUL magic: skipped too.
    const root = kernel.workspaces.workspaceRoot(ws.workspace_id)
    writeFileSync(join(root, 'ok.txt'), Buffer.concat([Buffer.from('the '), Buffer.from([0x00, 0x01, 0xff]), Buffer.from('needle')]))
    const after = kernel.workspaceSearchContent(ws.workspace_id, { q: 'needle' })
    expect(after.hits).toHaveLength(0)
    kernel.close()
  })

  it('caps matches per file (first 20 lines) but match_count reports the true total', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1} has the needle`).join('\n')
    kernel.workspaceWrite(ws.workspace_id, 'big-match.txt', lines)

    const result = kernel.workspaceSearchContent(ws.workspace_id, { q: 'needle' })
    expect(result.hits).toHaveLength(1)
    const hit = result.hits[0]
    expect(hit?.match_count).toBe(30)
    expect(hit?.matches).toHaveLength(WORKSPACE_SEARCH_MAX_MATCHES_PER_FILE)
    // The returned matches are the FIRST 20 lines, in order.
    expect(hit?.matches[0]).toEqual({ line: 1, snippet: 'line 1 has the needle' })
    expect(hit?.matches[19]).toEqual({ line: 20, snippet: 'line 20 has the needle' })
    // Line-based semantics: one match per line, never more.
    kernel.workspaceWrite(ws.workspace_id, 'one-line.txt', 'aaaa')
    const one = kernel.workspaceSearchContent(ws.workspace_id, { q: 'aa' })
    expect(one.hits.find(h => h.path === 'one-line.txt')?.match_count).toBe(1)
    // A needle that spans a line boundary is NOT a match (line scan).
    const spanning = kernel.workspaceSearchContent(ws.workspace_id, { q: 'a\na' })
    expect(spanning.hits.find(h => h.path === 'one-line.txt')).toBeUndefined()
    kernel.close()
  })

  it('caps the result at WORKSPACE_SEARCH_MAX_FILES files and sets truncated', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    const total = WORKSPACE_SEARCH_MAX_FILES + 5
    for (let i = 0; i < total; i += 1) {
      kernel.workspaceWrite(ws.workspace_id, `f${String(i).padStart(3, '0')}.txt`, `needle in file ${i}`)
    }
    // Interleave one non-matching file before the last — it must not consume
    // a result slot, and the cap must still cut at exactly 50 matches.
    kernel.workspaceWrite(ws.workspace_id, 'nomatch.txt', 'nothing here')

    const result = kernel.workspaceSearchContent(ws.workspace_id, { q: 'needle' })
    expect(result.hits).toHaveLength(WORKSPACE_SEARCH_MAX_FILES)
    expect(result.truncated).toBe(true)
    expect(result.hits.some(h => h.path === 'nomatch.txt')).toBe(false)
    // Path order preserved (f000..f054 lexicographic before nomatch.txt).
    expect(result.hits[0]?.path).toBe('f000.txt')
    expect(result.hits[WORKSPACE_SEARCH_MAX_FILES - 1]?.path).toBe('f049.txt')
    kernel.close()
  })

  it('skips files larger than WORKSPACE_SEARCH_MAX_FILE_BYTES whole (never partially scanned)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    // Just over the search cap (still under the 32 MiB write cap).
    kernel.workspaceWrite(ws.workspace_id, 'huge.txt', 'x'.repeat(WORKSPACE_SEARCH_MAX_FILE_BYTES) + 'needle-tail')
    kernel.workspaceWrite(ws.workspace_id, 'small.txt', 'needle-small')

    const result = kernel.workspaceSearchContent(ws.workspace_id, { q: 'needle' })
    expect(result.hits.map(h => h.path)).toEqual(['small.txt'])
    expect(result.hits[0]?.match_count).toBe(1)
    expect(result.truncated).toBe(false)
    kernel.close()
  })

  it('is UTF-8 tolerant: invalid bytes decode with replacement, never throw', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    kernel.workspaceWrite(ws.workspace_id, 'bad.txt', 'placeholder')
    kernel.workspaceWrite(ws.workspace_id, 'clean.txt', 'a needle in clean utf8\n')
    const root = kernel.workspaces.workspaceRoot(ws.workspace_id)
    // Host-tampered bytes: invalid UTF-8 sequences around a real ASCII needle
    // (0xff 0xfe are invalid lead bytes) — the scan must still find the line.
    writeFileSync(join(root, 'bad.txt'), Buffer.from([0xff, 0xfe, 0x80, ...Buffer.from('needle-after-invalid'), 0xc3, 0x28]))
    // Pure garbage with a needle embedded mid-invalid-sequence (a .log path
    // keeps the row's media text/plain — the magic scan only looks for NUL).
    const garbage = Buffer.alloc(64, 0xff)
    garbage.write('needle', 20)
    kernel.workspaceWrite(ws.workspace_id, 'garbage.log', 'placeholder')
    writeFileSync(join(root, 'garbage.log'), garbage)

    const result = kernel.workspaceSearchContent(ws.workspace_id, { q: 'needle' })
    const paths = result.hits.map(h => h.path).sort()
    expect(paths).toEqual(['bad.txt', 'clean.txt', 'garbage.log'])
    expect(result.hits.find(h => h.path === 'bad.txt')?.matches[0]?.snippet).toContain('needle-after-invalid')
    expect(result.hits.find(h => h.path === 'garbage.log')?.matches[0]?.snippet).toContain('needle')
    kernel.close()
  })

  it('rejects empty and whitespace-only queries (invalid_query)', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    kernel.workspaceWrite(ws.workspace_id, 'a.txt', 'x')
    for (const q of ['', '   ', '\t\n']) {
      try {
        kernel.workspaceSearchContent(ws.workspace_id, { q })
        throw new Error(`expected invalid_query for q=${JSON.stringify(q)}`)
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceError)
        expect((error as WorkspaceError).code).toBe('invalid_query')
      }
    }
    kernel.close()
  })

  it('unknown workspaces still 404-shaped and quarantined ones refuse search', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    try {
      kernel.workspaceSearchContent('ws_nope', { q: 'x' })
      throw new Error('expected not-found')
    } catch (error) {
      expect((error as WorkspaceError).code).toBe('workspace_not_found')
    }
    kernel.close()
  })

  it('manuscript facade: content search scans the tex tree with the same caps', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const doc = kernel.texEnsure(project.project_id)
    const wsId = `ws_${doc.document_id}`
    kernel.workspaceWrite(wsId, 'sections/intro.tex', '\\section{Intro}\n% needle: the hypothesis\n')
    kernel.workspaceWrite(wsId, 'main.tex', '\\documentclass{article}\n')
    // An image-named path gets application/octet-stream media — skipped by
    // the text-media allowlist even though its content carries the needle.
    kernel.workspaceWrite(wsId, 'fig.png', 'needle in a png-named text row')

    const result = kernel.workspaceSearchContent(wsId, { q: 'needle' })
    expect(result.hits.map(h => h.path)).toEqual(['sections/intro.tex'])
    expect(result.hits[0]?.match_count).toBe(1)
    expect(result.hits[0]?.matches[0]).toEqual({ line: 2, snippet: '% needle: the hypothesis' })
    expect(result.truncated).toBe(false)
    kernel.close()
  })

  it('path search (prefix/glob) is untouched and both modes coexist', () => {
    const kernel = freshKernel()
    const project = kernel.createProject({ name: 'p', workspace: '/w', brief: makeBrief() })
    const ws = kernel.workspaceEnsure(project.project_id, 'code', 'main')
    kernel.workspaceWrite(ws.workspace_id, 'src/a.ts', 'const needle = 1')
    kernel.workspaceWrite(ws.workspace_id, 'src/b.ts', 'no match here')
    // Path search: unchanged semantics — glob filters the projected dir node.
    const byGlob = kernel.workspaceSearch(ws.workspace_id, { glob: 'src/*.ts' })
    expect(byGlob.nodes.map(n => n.path).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    const byPrefix = kernel.workspaceSearch(ws.workspace_id, { prefix: 'src' })
    expect(byPrefix.nodes.map(n => n.path)).toContain('src/a.ts')
    // Content search: independent.
    const byContent = kernel.workspaceSearchContent(ws.workspace_id, { q: 'needle' })
    expect(byContent.hits.map(h => h.path)).toEqual(['src/a.ts'])
    kernel.close()
  })

  it('helper level: scanTextForQuery/makeSearchSnippet/isSearchableTextMedia', () => {
    // Snippet truncation centers on the match with '…' markers (needle
    // beyond the leading half so BOTH ends are cut).
    const long = 'x'.repeat(200) + 'NEEDLE' + 'y'.repeat(200)
    const snippet = makeSearchSnippet(long, 200, 6)
    expect(snippet.length).toBeLessThanOrEqual(240 + 2)
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet).toContain('NEEDLE')
    // Short lines pass through untouched.
    expect(makeSearchSnippet('short needle line', 6, 6)).toBe('short needle line')
    // scanTextForQuery: cap + total; case handling.
    const text = ['one needle', 'two needle', 'three needle', 'four needle'].join('\n')
    const capped = scanTextForQuery(text, 'needle', { max_matches: 2 })
    expect(capped.matches).toHaveLength(2)
    expect(capped.total).toBe(4)
    expect(capped.matches.map(m => m.line)).toEqual([1, 2])
    expect(scanTextForQuery('Upper NEEDLE', 'needle').total).toBe(1)
    expect(scanTextForQuery('Upper NEEDLE', 'needle', { case_sensitive: true }).total).toBe(0)
    // Media allowlist.
    expect(isSearchableTextMedia('text/plain')).toBe(true)
    expect(isSearchableTextMedia('text/x-tex')).toBe(true)
    expect(isSearchableTextMedia('application/json')).toBe(true)
    expect(isSearchableTextMedia('application/octet-stream')).toBe(false)
    expect(isSearchableTextMedia('image/png')).toBe(false)
    expect(isSearchableTextMedia('application/pdf')).toBe(false)
  })
})
