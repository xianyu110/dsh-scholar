/**
 * Scholar connector + runner unit tests (design §11.1, §4.6).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCitationEdges, buildPassages, crossrefPaper, dedupPapers, multiSourceSearch,
  openAlexPaper, parseArxivFeed, titleFingerprint, NULL_CACHE,
} from '@dsh-scholar/scholar-connectors'
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

describe('unicode-aware title fingerprint (§9.3)', () => {
  it('keeps CJK and Cyrillic — pure non-ASCII titles are never emptied', () => {
    const zh = titleFingerprint('基于深度学习的文本分类研究')
    expect(zh).not.toBe('')
    expect(zh).toBe('基于深度学习的文本分类研究')
    expect(titleFingerprint('基于深度学习的文本分类研究!')).toBe(zh)
    expect(titleFingerprint('Методы машинного обучения')).toBe('методымашинногообучения')
    expect(titleFingerprint('ελληνικά κείμενα')).toBe('ελληνικάκείμενα')
  })

  it('NFKC folds full-width forms and composes decomposed accents', () => {
    // Full-width ＡＢＣ (U+FF21…) folds to ASCII via NFKC.
    expect(titleFingerprint('Ａｔｔｅｎｔｉｏｎ Ｉｓ Ａｌｌ Ｙｏｕ Ｎｅｅｄ')).toBe('attentionisallyouneed')
    // Full-width space U+3000 folds to U+0020, then the run collapses away.
    expect(titleFingerprint('Ａｔｔｅｎｔｉｏｎ　Ｉｓ')).toBe('attentionis')
    // é (precomposed) and e + combining acute (decomposed) are the same after NFKC.
    expect(titleFingerprint('café')).toBe(titleFingerprint('cafe\u0301'))
    // Distinct words stay distinct: é ≠ e.
    expect(titleFingerprint('café')).not.toBe(titleFingerprint('cafe'))
  })

  it('collapses punctuation and whitespace runs to a single unit', () => {
    expect(titleFingerprint('Attention, Is  All You Need!!')).toBe(titleFingerprint('Attention Is All You Need!'))
    expect(titleFingerprint('A—B (C) [D]')).toBe(titleFingerprint('A B C D'))
  })

  it('treats traditional and simplified Chinese as distinct fingerprints', () => {
    expect(titleFingerprint('深度学习')).not.toBe(titleFingerprint('深度學習'))
  })

  it('truncates to 80 code points without splitting surrogate pairs', () => {
    expect(Array.from(titleFingerprint('长'.repeat(200)))).toHaveLength(80)
    // 𠀀 (U+20000) is an astral letter stored as a surrogate pair; the
    // fingerprint must truncate by code points and stay well-formed.
    expect(titleFingerprint('𠀀'.repeat(200))).toBe('𠀀'.repeat(80))
    expect(Array.from(titleFingerprint('𠀀'.repeat(200)))).toHaveLength(80)
  })

  it('dedups CJK title variants while keeping 繁/简 distinct', () => {
    const now = new Date().toISOString()
    const mk = (id: string, title: string, source: Paper['source']): Paper => ({
      paper_id: id, title, authors: [], source, retrieved_at: now,
    })
    const simplified = mk('openalex:a', '基于深度学习的文本分类研究', 'openalex')
    const punctuationVariant = mk('openalex:b', '基于深度学习的文本分类研究!!', 'crossref')
    const fullWidthVariant = mk('openalex:c', '基于深度学习的文本分类研究', 'arxiv')
    const traditional = mk('openalex:d', '基于深度学习的文本分類研究', 'openalex')
    const { papers, removed } = dedupPapers([simplified, punctuationVariant, fullWidthVariant, traditional])
    expect(removed).toBe(2)
    expect(papers.map(p => p.paper_id)).toEqual(['openalex:a', 'openalex:d'])
  })
})

describe('multi-source search failure transparency (§9.4)', () => {
  const feed = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<feed xmlns="http://www.w3.org/2005/Atom">'
    + '<entry><id>http://arxiv.org/abs/1706.03762</id><title>Attention Is All You Need</title>'
    + '<published>2017-06-12T00:00:00Z</published><author><name>Vaswani</name></author></entry>'
    + '</feed>'

  const stubFetch = (routes: Record<string, () => Response | never>): void => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const hit = Object.entries(routes).find(([prefix]) => url.includes(prefix))
      if (hit === undefined) throw new Error(`unexpected url: ${url}`)
      return hit[1]()
    }))
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('marks every source ok and omits failures when all succeed', async () => {
    stubFetch({
      'api.openalex.org': () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
      'api.crossref.org': () => new Response(JSON.stringify({ message: { items: [] } }), { status: 200 }),
      'export.arxiv.org': () => new Response(feed, { status: 200 }),
    })
    const result = await multiSourceSearch('transformer', { limit: 5 }, NULL_CACHE)
    expect(result.source_status).toEqual([
      { source: 'openalex', status: 'ok' },
      { source: 'crossref', status: 'ok' },
      { source: 'arxiv', status: 'ok' },
    ])
    expect(result.failures).toBeUndefined()
    expect(result.hits.length).toBeGreaterThan(0)
  })

  it('records failed sources with name and error; ok sources stay ok', async () => {
    stubFetch({
      'api.openalex.org': () => { throw new Error('network down for openalex') },
      'api.crossref.org': () => new Response(JSON.stringify({ message: { items: [] } }), { status: 200 }),
      'export.arxiv.org': () => new Response('<html><body>upstream error</body></html>', { status: 503 }),
    })
    const result = await multiSourceSearch('transformer', { limit: 5 }, NULL_CACHE)
    expect(result.source_status).toEqual([
      { source: 'openalex', status: 'failed', error: 'network down for openalex' },
      { source: 'crossref', status: 'ok' },
      { source: 'arxiv', status: 'failed', error: expect.stringContaining('503') },
    ])
    // Legacy field stays compatible: source name + error, only when non-empty.
    expect(result.failures).toEqual([
      'openalex: network down for openalex',
      expect.stringContaining('arxiv: 503'),
    ])
    expect(result.hits).toHaveLength(0)
  })
})

describe('defensive connector parsing (§9.4)', () => {
  it('openAlexPaper degrades malformed records to placeholders instead of throwing', () => {
    const raw: Record<string, unknown> = {
      ids: 'garbage', // wrong type: not an object
      title: 42, // wrong type: not a string
      authorships: [null, undefined, { author: null }, { author: { display_name: 'Ada' } }],
      abstract_inverted_index: { word: 'not-an-array', ok: [0, 1] }, // one malformed word, one valid
      publication_year: '2020', // wrong type: not a number
      primary_location: 'nope', // wrong type: not an object
    }
    expect(() => openAlexPaper(raw)).not.toThrow()
    const paper = openAlexPaper(raw)
    expect(paper.title).toBe('Untitled')
    expect(paper.authors).toEqual(['Ada'])
    expect(paper.year).toBeUndefined()
    expect(paper.venue).toBeUndefined()
    expect(paper.abstract).toBe('ok ok') // malformed word skipped, valid positions kept
  })

  it('openAlexPaper survives a non-object abstract_inverted_index', () => {
    const raw: Record<string, unknown> = { id: 123, abstract_inverted_index: ['a', 'b'] }
    expect(() => openAlexPaper(raw)).not.toThrow()
    expect(openAlexPaper(raw).abstract).toBe('')
  })

  it('crossrefPaper degrades malformed records to placeholders instead of throwing', () => {
    const raw: Record<string, unknown> = {
      DOI: 123, // wrong type
      title: ['Only a title'],
      author: [null, 'not-an-object', { given: 'Grace', family: 'Hopper' }],
      issued: '2020', // wrong type: not an object
      'container-title': [42],
      abstract: '<jats:p>Hello <i>world</i></jats:p>',
      license: null,
    }
    expect(() => crossrefPaper(raw)).not.toThrow()
    const paper = crossrefPaper(raw)
    expect(paper.title).toBe('Only a title')
    expect(paper.authors).toEqual(['Grace Hopper'])
    expect(paper.year).toBeUndefined()
    expect(paper.venue).toBeUndefined()
    expect(paper.abstract).toBe('Hello world')
  })

  it('parseArxivFeed returns [] for empty, garbage or unclosed feeds instead of throwing', () => {
    expect(parseArxivFeed('')).toEqual([])
    expect(parseArxivFeed('<html><body>rate limited</body></html>')).toEqual([])
    expect(parseArxivFeed('<entry><title>unclosed')).toEqual([])
    expect(parseArxivFeed('not xml at all \x00\x01')).toEqual([])
  })

  it('parseArxivFeed keeps well-formed entries and tolerates missing fields', () => {
    const hits = parseArxivFeed(
      '<entry><title>Only Title</title></entry>'
      + '<entry><id>http://arxiv.org/abs/2301.00001</id><title>  Full  Entry </title>'
      + '<summary>Abstract here</summary><published>2023-01-01T00:00:00Z</published>'
      + '<author><name>Jane Doe</name></author></entry>',
    )
    expect(hits).toHaveLength(2)
    expect(hits[0]?.paper.title).toBe('Only Title')
    expect(hits[0]?.paper.paper_id).toBe('arxiv:') // missing id → placeholder, no throw
    expect(hits[1]?.paper.paper_id).toBe('arxiv:2301.00001')
    expect(hits[1]?.paper.title).toBe('Full Entry')
    expect(hits[1]?.paper.year).toBe(2023)
    expect(hits[1]?.paper.authors).toEqual(['Jane Doe'])
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
