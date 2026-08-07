/**
 * Scholar connector + runner unit tests (design §11.1, §4.6).
 */
import { describe, expect, it, vi } from 'vitest'
import { buildCitationEdges, buildPassages, dedupPapers, titleFingerprint } from '@dsh-scholar/scholar-connectors'
import { classifyFailure, extractMetrics } from '@dsh-scholar/runner-gateway'
import type { Paper } from '@dsh-scholar/research-schemas'

describe('scholar connectors', () => {
  it('title fingerprints normalize aggressively', () => {
    expect(titleFingerprint('Attention Is All You Need!')).toBe('attentionisallyouneed')
    expect(titleFingerprint('Attention is all you need')).toBe(titleFingerprint('ATTENTION IS ALL YOU NEED'))
  })

  it('dedups by DOI, arXiv id and title fingerprint', () => {
    const now = new Date().toISOString()
    const base: Paper = { paper_id: 'doi:10.1/x', title: 'Alpha Method', authors: ['A'], source: 'openalex', identifiers: { doi: '10.1/x' }, retrieved_at: now }
    const duplicateDoi: Paper = { ...base, paper_id: 'doi:10.1/x', source: 'crossref' }
    const arxiv1: Paper = { paper_id: 'arxiv:2301.00001', title: 'Beta', source: 'arxiv', identifiers: { arxiv: '2301.00001' }, retrieved_at: now }
    const arxivDup: Paper = { ...arxiv1, paper_id: 'arxiv:2301.00001', source: 'crossref', identifiers: { arxiv: '2301.00001' } }
    const titleDup: Paper = { paper_id: 'openalex:x', title: 'Gamma: A Study', source: 'openalex', retrieved_at: now }
    const titleDup2: Paper = { paper_id: 'openalex:y', title: 'gamma a study', source: 'crossref', retrieved_at: now }
    const { papers, removed } = dedupPapers([base, duplicateDoi, arxiv1, arxivDup, titleDup, titleDup2])
    expect(removed).toBe(3)
    expect(papers).toHaveLength(3)
  })
})

describe('passage derivation (§4.4)', () => {
  it('builds untrusted passages from abstracts', () => {
    const now = new Date().toISOString()
    const paper: Paper = {
      paper_id: 'doi:10.1/abc',
      title: 'A Study',
      authors: ['A'],
      source: 'openalex',
      identifiers: { doi: '10.1/abc' },
      abstract: 'First claim sentence. Second claim sentence. Third one.',
      retrieved_at: now,
    }
    const passages = buildPassages([paper])
    expect(passages).toHaveLength(2)
    expect(passages[0]?.text).toContain('First claim')
    expect(passages.every(p => p.is_untrusted === true)).toBe(true)
    expect(passages.every(p => p.paper_id === 'doi:10.1/abc')).toBe(true)
  })

  it('skips papers without abstracts', () => {
    const now = new Date().toISOString()
    expect(buildPassages([{ paper_id: 'doi:1/x', title: 'No Abstract', authors: [], source: 'crossref', identifiers: {}, retrieved_at: now }])).toHaveLength(0)
  })
})

describe('citation graph (§4.4 step 4)', () => {
  it('builds intra-corpus edges from OpenAlex referenced_works', () => {
    const now = new Date().toISOString()
    const mk = (id: string, title: string, refs: string[] = []): SearchHit => ({
      paper: { paper_id: `doi:${id}`, title, authors: [], source: 'openalex', identifiers: { doi: `10.1/${id}`, openalex: `https://api.openalex.org/W${id}` }, retrieved_at: now },
      score: null,
      ...refs.length > 0 && { references: refs },
    })
    const a = mk('a', 'Paper A', ['https://api.openalex.org/Wb', 'https://api.openalex.org/Wc'])
    const b = mk('b', 'Paper B', ['https://api.openalex.org/Wa'])
    const c = mk('c', 'Paper C')
    const edges = buildCitationEdges([a, b, c])
    expect(edges).toContainEqual({ source_paper_id: 'doi:a', target_paper_id: 'doi:b', kind: 'reference' })
    expect(edges).toContainEqual({ source_paper_id: 'doi:a', target_paper_id: 'doi:c', kind: 'reference' })
    expect(edges).toContainEqual({ source_paper_id: 'doi:b', target_paper_id: 'doi:a', kind: 'reference' })
    expect(edges).toHaveLength(3)
  })

  it('ignores references outside the corpus and dedupes edges', () => {
    const now = new Date().toISOString()
    const mk = (id: string, title: string, refs: string[] = []): SearchHit => ({
      paper: { paper_id: `doi:${id}`, title, authors: [], source: 'openalex', identifiers: { doi: `10.1/${id}`, openalex: `https://api.openalex.org/W${id}` }, retrieved_at: now },
      score: null,
      ...refs.length > 0 && { references: refs },
    })
    const a = mk('a', 'A', ['https://api.openalex.org/Wzzz', 'https://api.openalex.org/Wb', 'https://api.openalex.org/Wb'])
    const b = mk('b', 'B')
    const edges = buildCitationEdges([a, b])
    expect(edges).toHaveLength(1) // only Wb resolves; duplicate Wb deduped
  })
})

describe('runner gateway', () => {
  it('extracts JSON-lines metrics from stdout', () => {
    const metrics = extractMetrics('training done\n{"metric":"macro_f1","value":0.812}\n{"metric":"acc","value":0.9,"seed":11}\nnot json\n')
    expect(metrics).toHaveLength(2)
    expect(metrics[0]).toEqual({ metric: 'macro_f1', value: 0.812 })
    expect(metrics[1]).toMatchObject({ seed: 11 })
  })

  it('classifies resource exhaustion and code errors deterministically', () => {
    expect(classifyFailure({ run_id: 'r', exit_code: 124, started_at: '', finished_at: '', stdout: '', stderr: '' }).failure_class).toBe('unknown')
    const timeout = classifyFailure({ run_id: 'r', exit_code: -1, started_at: '', finished_at: '', stdout: '', stderr: '', error: 'timed out after 60000ms' })
    expect(timeout.failure_class).toBe('resources')
    const code = classifyFailure({ run_id: 'r', exit_code: 1, started_at: '', finished_at: '', stdout: 'Traceback (most recent call last):\nModuleNotFoundError', stderr: '' })
    expect(code.failure_class).toBe('code_error')
    const leak = classifyFailure({ run_id: 'r', exit_code: 1, started_at: '', finished_at: '', stdout: 'warning: test set labels leaked into training', stderr: '' })
    expect(leak.failure_class).toBe('data_issue')
    const ok = classifyFailure({ run_id: 'r', exit_code: 0, started_at: '', finished_at: '', stdout: '', stderr: '' })
    expect(ok.failure_class).toBeNull()
  })
})
