/** ART-PREVIEW-01 — safe, DOM-free multi-format preview planning. */
import { describe, expect, it, vi } from 'vitest'
import {
  ARTIFACT_MARKDOWN_MAX_BLOCKS,
  ARTIFACT_MARKDOWN_MAX_LIST_ITEMS,
  ARTIFACT_TABLE_MAX_COLUMNS,
  ARTIFACT_TABLE_MAX_ROWS,
  ARTIFACT_TEXT_MAX_BYTES,
  artifactMediaEssence,
  artifactPreviewPlan,
  formatJsonPreview,
  parseArtifactMarkdown,
  parseDelimitedPreview,
  readArtifactTextPreview,
  readArtifactTextStream,
} from '../../packages/dsh-research-ui/src/client/artifact-preview-model'
import type { ArtifactRow } from '../../packages/dsh-research-ui/src/client/types'

function artifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return { artifact_id: 'sha256:abc', kind: 'data', size_bytes: 12, media_type: 'application/octet-stream', file_name: null, ...overrides }
}

describe('Artifact multi-format preview classification', () => {
  it('normalizes MIME essence and supports native safe media', () => {
    expect(artifactMediaEssence(' Application/PDF ; charset=binary')).toBe('application/pdf')
    expect(artifactPreviewPlan(artifact({ file_name: 'paper.bin' }), 'application/pdf; charset=binary').mode).toBe('pdf')
    expect(artifactPreviewPlan(artifact({ file_name: 'plot.bin' }), 'image/webp').mode).toBe('image')
    expect(artifactPreviewPlan(artifact({ file_name: 'sample.bin' }), 'audio/mpeg').mode).toBe('audio')
    expect(artifactPreviewPlan(artifact({ file_name: 'run.bin' }), 'video/webm').mode).toBe('video')
    expect(artifactPreviewPlan(artifact({ file_name: 'scan.bmp' })).mode).toBe('image')
  })

  it('supports structured text from MIME or safe octet-stream extensions', () => {
    expect(artifactPreviewPlan(artifact({ file_name: 'README.md' })).mode).toBe('markdown')
    expect(artifactPreviewPlan(artifact({ file_name: 'rows.ndjson' }))).toMatchObject({ mode: 'json', ndjson: true })
    expect(artifactPreviewPlan(artifact({ file_name: 'metrics.csv' }))).toMatchObject({ mode: 'table', delimiter: ',' })
    expect(artifactPreviewPlan(artifact({ file_name: 'metrics.tsv' }))).toMatchObject({ mode: 'table', delimiter: '\t' })
    expect(artifactPreviewPlan(artifact({ file_name: 'main.py' })).mode).toBe('text')
    expect(artifactPreviewPlan(artifact({ kind: 'compile-log' })).mode).toBe('text')
    expect(artifactPreviewPlan(artifact({ file_name: 'unknown.bin' }), 'application/ld+json').mode).toBe('json')
    expect(artifactPreviewPlan(artifact({ file_name: 'analysis.ipynb' }))).toMatchObject({ mode: 'json', ndjson: false, format: 'Jupyter Notebook' })
    expect(artifactPreviewPlan(artifact({ kind: 'code', file_name: null }))).toMatchObject({ mode: 'text', readsText: true })
    expect(artifactPreviewPlan(artifact({ file_name: 'paper.qmd' })).mode).toBe('markdown')
    expect(artifactPreviewPlan(artifact({ file_name: 'paper.rmd' })).mode).toBe('markdown')
    expect(artifactPreviewPlan(artifact({ kind: 'manifest', file_name: null }))).toMatchObject({ mode: 'json', ndjson: false })
    expect(artifactPreviewPlan(artifact({ kind: 'analysis', file_name: null }))).toMatchObject({ mode: 'json', ndjson: false })
    expect(artifactPreviewPlan(artifact({ kind: 'paper', file_name: null }))).toMatchObject({ mode: 'markdown' })
  })

  it('safely refines generic text and JSON MIME types from structured extensions', () => {
    expect(artifactPreviewPlan(artifact({ file_name: 'rows.csv' }), 'text/plain')).toMatchObject({ mode: 'table', delimiter: ',' })
    expect(artifactPreviewPlan(artifact({ file_name: 'rows.tsv' }), 'text/plain')).toMatchObject({ mode: 'table', delimiter: '\t' })
    expect(artifactPreviewPlan(artifact({ file_name: 'README.md' }), 'text/plain').mode).toBe('markdown')
    expect(artifactPreviewPlan(artifact({ file_name: 'rows.jsonl' }), 'application/json')).toMatchObject({ mode: 'json', ndjson: true })
  })

  it('never promotes active, Office, archive, model, or unknown binary content', () => {
    expect(artifactPreviewPlan(artifact({ file_name: 'attack.svg' }), 'image/png')).toMatchObject({ mode: 'download', downloadReason: 'active', readsText: false })
    expect(artifactPreviewPlan(artifact({ file_name: 'attack.txt' }), 'text/html')).toMatchObject({ mode: 'download', downloadReason: 'active', readsText: false })
    expect(artifactPreviewPlan(artifact({ file_name: 'paper.docx' }))).toMatchObject({ mode: 'download', downloadReason: 'office' })
    expect(artifactPreviewPlan(artifact({ file_name: 'bundle.zip' }))).toMatchObject({ mode: 'download', downloadReason: 'archive' })
    expect(artifactPreviewPlan(artifact({ file_name: 'weights.safetensors' }))).toMatchObject({ mode: 'download', downloadReason: 'model' })
    expect(artifactPreviewPlan(artifact({ file_name: 'samples.parquet' }))).toMatchObject({ mode: 'download', downloadReason: 'scientific' })
    expect(artifactPreviewPlan(artifact({ file_name: 'signals.hdf5' }))).toMatchObject({ mode: 'download', downloadReason: 'scientific' })
    expect(artifactPreviewPlan(artifact({ file_name: 'random.bin' }))).toMatchObject({ mode: 'download', downloadReason: 'binary' })
    expect(artifactPreviewPlan(artifact({ media_type: 'text/html', file_name: 'attack.txt' }), '')).toMatchObject({ mode: 'download', downloadReason: 'active' })
    expect(artifactPreviewPlan(artifact({ media_type: 'text/html', file_name: 'attack.txt' }), 'text/plain')).toMatchObject({ mode: 'download', downloadReason: 'active' })
  })

  it('uses extensions only when MIME is absent or generic', () => {
    expect(artifactPreviewPlan(artifact({ file_name: 'paper.pdf' }))).toMatchObject({ mode: 'pdf', opensInTab: true })
    expect(artifactPreviewPlan(artifact({ file_name: 'plot.png' }))).toMatchObject({ mode: 'image', opensInTab: true })
    expect(artifactPreviewPlan(artifact({ file_name: 'song.mp3' }))).toMatchObject({ mode: 'audio', opensInTab: true })
    expect(artifactPreviewPlan(artifact({ file_name: 'movie.mp4' }))).toMatchObject({ mode: 'video', opensInTab: true })
    expect(artifactPreviewPlan(artifact({ file_name: 'paper.pdf' }), 'application/vnd.custom')).toMatchObject({ mode: 'download', downloadReason: 'binary' })
  })
})

describe('Artifact bounded text and structured previews', () => {
  it('does not call text() when a payload exceeds the byte limit', async () => {
    const text = vi.fn(async () => { throw new Error('must not read') })
    const preview = await readArtifactTextPreview({ size: ARTIFACT_TEXT_MAX_BYTES + 1, text })
    expect(preview).toMatchObject({ tooLarge: true, truncated: true, text: '' })
    expect(text).not.toHaveBeenCalled()
  })

  it('detects binary bytes and truncates bounded text', async () => {
    expect(await readArtifactTextPreview({ size: 4, text: async () => 'a\0b' })).toMatchObject({ binary: true, text: '' })
    const long = 'x'.repeat(100_001)
    const preview = await readArtifactTextPreview({ size: long.length, text: async () => long })
    expect(preview.truncated).toBe(true)
    expect(preview.text).toHaveLength(100_000)
  })

  it('bounds streamed text without trusting Content-Length and cancels overflow/abort', async () => {
    const encoder = new TextEncoder()
    let overflowCancelled = false
    const chunks = [encoder.encode('ok'), new Uint8Array(ARTIFACT_TEXT_MAX_BYTES)]
    const overflow = await readArtifactTextStream({
      getReader: () => ({
        read: async () => chunks.length === 0 ? { done: true } : { done: false, value: chunks.shift() },
        cancel: async () => { overflowCancelled = true },
      }),
    })
    expect(overflow).toMatchObject({ tooLarge: true, truncated: true, text: '' })
    expect(overflowCancelled).toBe(true)

    const controller = new AbortController()
    let abortCancelled = false
    const pending = readArtifactTextStream({
      getReader: () => ({
        read: async () => await new Promise<{ done: boolean; value?: Uint8Array }>(resolve => {
          controller.signal.addEventListener('abort', () => resolve({ done: true }), { once: true })
        }),
        cancel: async () => { abortCancelled = true },
      }),
    }, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('artifact preview aborted')
    expect(abortCancelled).toBe(true)
  })

  it('pretty-prints JSON and NDJSON while preserving invalid input as inert text', () => {
    expect(formatJsonPreview('{"x":1}')).toEqual({ text: '{\n  "x": 1\n}', valid: true })
    const ndjson = formatJsonPreview('{"x":1}\n{"x":2}\n', true)
    expect(ndjson.valid).toBe(true)
    expect(ndjson.text).toContain('"x": 2')
    expect(formatJsonPreview('<script>alert(1)</script>')).toEqual({ text: '<script>alert(1)</script>', valid: false })
  })

  it('preserves scientific JSON number lexemes, negative zero, and duplicate keys', () => {
    const source = '{"id":9007199254740993,"zero":-0,"sample":1e-400,"id":9007199254740995}'
    const preview = formatJsonPreview(source)
    expect(preview.valid).toBe(true)
    expect(preview.text).toContain('9007199254740993')
    expect(preview.text).toContain('9007199254740995')
    expect(preview.text).toContain('"zero": -0')
    expect(preview.text).toContain('1e-400')
    expect(preview.text.match(/"id"/g)).toHaveLength(2)
    const ndjson = formatJsonPreview('{"id":9007199254740993}\n{"zero":-0}', true)
    expect(ndjson).toMatchObject({ valid: true })
    expect(ndjson.text).toContain('9007199254740993')
    expect(ndjson.text).toContain('"zero": -0')
  })

  it('treats notebooks as standard JSON and bounds formatter expansion', () => {
    const notebook = '{\n "cells": [],\n "metadata": {},\n "nbformat": 4\n}'
    expect(formatJsonPreview(notebook)).toMatchObject({ valid: true })
    const depth = 16_000
    const nested = `${'['.repeat(depth)}${']'.repeat(depth)}`
    const preview = formatJsonPreview(nested)
    expect(preview).toEqual({ text: nested, valid: true })
    expect(preview.text.length).toBe(nested.length)
  })

  it('parses quoted CSV/TSV into inert bounded cells', () => {
    const csv = parseDelimitedPreview('name,note\r\n"a,b","=HYPERLINK(""x"")"\r\n', ',')
    expect(csv.rows).toEqual([['name', 'note'], ['a,b', '=HYPERLINK("x")']])
    const tsv = parseDelimitedPreview('a\tb\n1\t2', '\t')
    expect(tsv.rows).toEqual([['a', 'b'], ['1', '2']])
    const oversized = parseDelimitedPreview(Array.from({ length: ARTIFACT_TABLE_MAX_ROWS + 2 }, (_, index) => `${index},x`).join('\n'), ',')
    expect(oversized.rows).toHaveLength(ARTIFACT_TABLE_MAX_ROWS)
    expect(oversized.truncated).toBe(true)
  })

  it('parses only allowlisted Markdown blocks and keeps raw HTML inert', () => {
    const parsed = parseArtifactMarkdown('# Title\n\n- one\n- two\n\n```js\nalert(1)\n```\n<script onload=x>bad</script>')
    expect(parsed.blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'list', ordered: false, items: ['one', 'two'] },
      { kind: 'code', language: 'js', text: 'alert(1)' },
      { kind: 'paragraph', text: '<script onload=x>bad</script>' },
    ])
    const many = parseArtifactMarkdown(Array.from({ length: ARTIFACT_MARKDOWN_MAX_BLOCKS + 1 }, (_, index) => `line ${index}`).join('\n'))
    expect(many.blocks).toHaveLength(ARTIFACT_MARKDOWN_MAX_BLOCKS)
    expect(many.truncated).toBe(true)
  })

  it('bounds Markdown list items and consumes oversized table rows/columns', () => {
    const list = parseArtifactMarkdown(Array.from({ length: ARTIFACT_MARKDOWN_MAX_LIST_ITEMS + 2 }, (_, index) => `- item ${index}`).join('\n'))
    expect(list.blocks).toHaveLength(1)
    expect(list.blocks[0]).toMatchObject({ kind: 'list' })
    if (list.blocks[0]?.kind === 'list') expect(list.blocks[0].items).toHaveLength(ARTIFACT_MARKDOWN_MAX_LIST_ITEMS)
    expect(list.truncated).toBe(true)

    const columns = Array.from({ length: ARTIFACT_TABLE_MAX_COLUMNS + 2 }, (_, index) => `c${index}`)
    const tableText = `${columns.join('|')}\n${columns.map(() => '---').join('|')}\n${Array.from({ length: ARTIFACT_TABLE_MAX_ROWS + 2 }, (_, row) => `${row}|value`).join('\n')}`
    const table = parseArtifactMarkdown(tableText)
    expect(table.blocks).toHaveLength(1)
    expect(table.blocks[0]).toMatchObject({ kind: 'table' })
    if (table.blocks[0]?.kind === 'table') {
      expect(table.blocks[0].headers).toHaveLength(ARTIFACT_TABLE_MAX_COLUMNS)
      expect(table.blocks[0].rows).toHaveLength(ARTIFACT_TABLE_MAX_ROWS)
    }
    expect(table.truncated).toBe(true)
  })
})
