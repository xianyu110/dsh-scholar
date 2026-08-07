/**
 * Controlled scholarly connectors (design §4.4): OpenAlex, Crossref, arXiv.
 * All external content is treated as UNTRUSTED data (design §4.9): connectors
 * return structured fields only, and the caller must never treat retrieved
 * text as instructions.
 * @module @dsh-scholar/scholar-connectors
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Paper, Passage } from '@dsh-scholar/research-schemas'

export type ConnectorSource = 'openalex' | 'crossref' | 'arxiv' | 'semantic-scholar'

export interface SearchOptions {
  limit?: number
  /** Years to restrict (e.g. 2018..2026). */
  fromYear?: number
  toYear?: number
  /** Mailto for polite-pool rate limits (OpenAlex). */
  mailto?: string
  timeoutMs?: number
}

export interface SearchHit {
  paper: Paper
  score: number | null
  /** OpenAlex referenced_works (raw API ids) for citation-graph building. */
  references?: string[]
}

export interface ConnectorCache {
  /** JSON-document cache keyed by source:query-hash. */
  get(key: string): unknown | null
  set(key: string, value: unknown): void
}

export class DiskCache implements ConnectorCache {
  readonly root: string
  private readonly memory = new Map<string, unknown>()

  constructor(root: string) {
    this.root = root
    mkdirSync(root, { recursive: true })
  }

  private pathFor(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 32)
    return join(this.root, `${hash}.json`)
  }

  get(key: string): unknown | null {
    if (this.memory.has(key)) return this.memory.get(key) as unknown
    const path = this.pathFor(key)
    if (!existsSync(path)) return null
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
      this.memory.set(key, value)
      return value
    } catch {
      return null
    }
  }

  set(key: string, value: unknown): void {
    this.memory.set(key, value)
    writeFileSync(this.pathFor(key), JSON.stringify(value))
  }
}

/** No-op cache for tests. */
export const NULL_CACHE: ConnectorCache = { get: () => null, set: () => undefined }

function hashQuery(source: ConnectorSource, query: string, options: SearchOptions): string {
  return `${source}:${query}:${options.limit ?? 20}:${options.fromYear ?? ''}:${options.toYear ?? ''}`
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-scholar/0.1 (research connector)' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${url}`)
    }
    return await response.json() as unknown
  } finally {
    clearTimeout(timer)
  }
}

/** Normalize a title for dedup fingerprinting (design §4.4 step 3). */
export function titleFingerprint(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 80)
}

/** Deduplicate papers by DOI, arXiv id, then title fingerprint. Keeps first. */
export function dedupPapers(papers: Paper[]): { papers: Paper[]; removed: number } {
  const seenDoi = new Set<string>()
  const seenTitle = new Set<string>()
  const result: Paper[] = []
  for (const paper of papers) {
    const doi = paper.identifiers?.doi
    const arxiv = paper.identifiers?.arxiv
    const doiKey = doi !== undefined ? `doi:${doi.toLowerCase()}` : arxiv !== undefined ? `arxiv:${arxiv.toLowerCase()}` : undefined
    const titleKey = `title:${titleFingerprint(paper.title)}`
    // A title-variant of an already-seen DOI record must also dedup, and
    // vice versa: both keys are consulted for every paper.
    if ((doiKey !== undefined && seenDoi.has(doiKey)) || seenTitle.has(titleKey)) continue
    if (doiKey !== undefined) seenDoi.add(doiKey)
    seenTitle.add(titleKey)
    result.push(paper)
  }
  return { papers: result, removed: papers.length - result.length }
}

function openAlexPaper(raw: Record<string, unknown>): Paper {
  const ids = raw.ids as Record<string, unknown> | undefined
  const doi = typeof ids?.doi === 'string' ? ids.doi.replace(/^https:\/\/doi\.org\//, '') : undefined
  const title = typeof raw.title === 'string' ? raw.title : 'Untitled'
  const authors = Array.isArray(raw.authorships)
    ? (raw.authorships as Array<{ author?: { display_name?: string } }>).map(a => a.author?.display_name ?? '').filter(Boolean)
    : []
  const year = typeof raw.publication_year === 'number' ? raw.publication_year : undefined
  const venue = (raw.primary_location as { source?: { display_name?: string } } | null | undefined)?.source?.display_name
  const abstractInverted = raw.abstract_inverted_index as Record<string, number[]> | null | undefined
  let abstract = ''
  if (abstractInverted !== undefined && abstractInverted !== null) {
    const positions: Array<[number, string]> = []
    for (const [word, indexes] of Object.entries(abstractInverted)) {
      for (const index of indexes) positions.push([index, word])
    }
    abstract = positions.sort((a, b) => a[0] - b[0]).map(p => p[1]).join(' ')
  }
  return {
    paper_id: doi !== undefined ? `doi:${doi}` : `openalex:${String(raw.id ?? '')}`,
    title,
    authors,
    year,
    venue,
    source: 'openalex',
    identifiers: { ...doi !== undefined ? { doi } : {}, openalex: String(raw.id ?? '') },
    abstract,
    url: typeof raw.doi === 'string' ? raw.doi : undefined,
    retrieved_at: new Date().toISOString(),
  }
}

function crossrefPaper(raw: Record<string, unknown>): Paper {
  const doi = typeof raw.DOI === 'string' ? raw.DOI.toLowerCase() : undefined
  const title = Array.isArray(raw.title) && typeof raw.title[0] === 'string' ? raw.title[0] : 'Untitled'
  const authors = Array.isArray(raw.author)
    ? (raw.author as Array<{ given?: string; family?: string }>).map(a => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean)
    : []
  const issuedValue = raw.issued
  const dateParts = typeof issuedValue === 'object' && issuedValue !== null
    ? (issuedValue as { 'date-parts'?: Array<Array<number | undefined>> })['date-parts']
    : undefined
  const issued = dateParts?.[0]?.[0] as number | undefined
  const container = Array.isArray(raw['container-title']) ? raw['container-title'][0] : undefined
  const abstract = typeof raw.abstract === 'string'
    ? raw.abstract.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    : ''
  return {
    paper_id: `doi:${doi ?? ''}`,
    title,
    authors,
    year: typeof issued === 'number' ? issued : undefined,
    venue: typeof container === 'string' ? container : undefined,
    source: 'crossref',
    identifiers: { ...doi !== undefined ? { doi } : {} },
    abstract,
    license: typeof raw.license === 'string' ? raw.license : undefined,
    retrieved_at: new Date().toISOString(),
  }
}

function arxivPaper(raw: Record<string, unknown>): Paper {
  const arxivId = typeof raw.id === 'string' ? raw.id.split('/abs/').pop() ?? raw.id : ''
  const title = typeof raw.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim() : 'Untitled'
  const authors = Array.isArray(raw.authors)
    ? (raw.authors as Array<{ name?: string }>).map(a => a.name ?? '').filter(Boolean)
    : []
  const published = typeof raw.published === 'string' ? new Date(raw.published).getFullYear() : undefined
  const summary = typeof raw.summary === 'string' ? raw.summary.replace(/\s+/g, ' ').trim() : ''
  return {
    paper_id: `arxiv:${arxivId}`,
    title,
    authors,
    year: published,
    venue: 'arXiv',
    source: 'arxiv',
    identifiers: { arxiv: arxivId },
    abstract: summary,
    url: typeof raw.id === 'string' ? raw.id : undefined,
    retrieved_at: new Date().toISOString(),
  }
}

/** OpenAlex search: broad metadata + citation network. */
export async function searchOpenAlex(query: string, options: SearchOptions = {}, cache: ConnectorCache = NULL_CACHE): Promise<SearchHit[]> {
  const key = hashQuery('openalex', query, options)
  const cached = cache.get(key) as SearchHit[] | null
  if (cached !== null) return cached
  const params = new URLSearchParams({
    search: query,
    'per-page': String(options.limit ?? 20),
    mailto: options.mailto ?? 'research@localhost',
    sort: 'relevance_score:desc',
  })
  if (options.fromYear !== undefined) params.set('filter', `from_publication_date:${options.fromYear}-01-01`)
  if (options.toYear !== undefined) {
    const existing = params.get('filter')
    params.set('filter', existing !== null ? `${existing},to_publication_date:${options.toYear}-12-31` : `to_publication_date:${options.toYear}-12-31`)
  }
  const data = await fetchJson(`https://api.openalex.org/works?${params.toString()}`, options.timeoutMs ?? 20000) as { results?: Array<Record<string, unknown>> }
  const hits: SearchHit[] = (data.results ?? []).map(raw => ({
    paper: openAlexPaper(raw),
    score: typeof raw.relevance_score === 'number' ? raw.relevance_score : null,
    ...Array.isArray(raw.referenced_works) && { references: (raw.referenced_works as string[]).map(String) },
  }))
  cache.set(key, hits)
  return hits
}

/** Crossref search: DOI/ISBN metadata, updates and licenses. */
export async function searchCrossref(query: string, options: SearchOptions = {}, cache: ConnectorCache = NULL_CACHE): Promise<SearchHit[]> {
  const key = hashQuery('crossref', query, options)
  const cached = cache.get(key) as SearchHit[] | null
  if (cached !== null) return cached
  const params = new URLSearchParams({
    query: query,
    rows: String(options.limit ?? 20),
    select: 'DOI,title,author,issued,container-title,abstract,license',
  })
  if (options.fromYear !== undefined) params.set('filter', `from-pub-date:${options.fromYear}-01-01`)
  if (options.toYear !== undefined) {
    const existing = params.get('filter')
    params.set('filter', existing !== null ? `${existing},until-pub-date:${options.toYear}-12-31` : `until-pub-date:${options.toYear}-12-31`)
  }
  const data = await fetchJson(`https://api.crossref.org/works?${params.toString()}`, options.timeoutMs ?? 20000) as { message?: { items?: Array<Record<string, unknown>> } }
  const hits: SearchHit[] = (data.message?.items ?? []).map(raw => ({ paper: crossrefPaper(raw), score: null }))
  cache.set(key, hits)
  return hits
}

/** arXiv search: preprints (Atom feed, structured XML). */
export async function searchArxiv(query: string, options: SearchOptions = {}, cache: ConnectorCache = NULL_CACHE): Promise<SearchHit[]> {
  const key = hashQuery('arxiv', query, options)
  const cached = cache.get(key) as SearchHit[] | null
  if (cached !== null) return cached
  const params = new URLSearchParams({
    search_query: `all:${query}`,
    max_results: String(options.limit ?? 20),
    sortBy: 'relevance',
    sortOrder: 'descending',
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000)
  let xml: string
  try {
    const response = await fetch(`https://export.arxiv.org/api/query?${params.toString()}`, {
      headers: { accept: 'application/atom+xml', 'user-agent': 'dsh-scholar/0.1' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    xml = await response.text()
  } finally {
    clearTimeout(timer)
  }
  const hits: SearchHit[] = []
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g
  let match: RegExpExecArray | null
  while ((match = entryPattern.exec(xml)) !== null) {
    const entry = match[1] ?? ''
    const field = (name: string): string => {
      const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(entry)
      return m !== null ? (m[1] ?? '').trim() : ''
    }
    const raw: Record<string, unknown> = {
      id: field('id'),
      title: field('title'),
      summary: field('summary'),
      published: field('published'),
      authors: [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => ({ name: (m[1] ?? '').trim() })),
    }
    hits.push({ paper: arxivPaper(raw), score: null })
  }
  cache.set(key, hits)
  return hits
}

/** Multi-source search with dedup; returns provenance per query (design §4.4 steps 2-3). */
export async function multiSourceSearch(query: string, options: SearchOptions = {}, cache: ConnectorCache = NULL_CACHE): Promise<{
  hits: SearchHit[]
  queries: Array<{ source: ConnectorSource; query: string; run_at: string }>
  dedup_removed: number
  citation_edges: Array<{ source_paper_id: string; target_paper_id: string; kind: 'reference' }>
}> {
  const runAt = new Date().toISOString()
  const [openalex, crossref, arxiv] = await Promise.allSettled([
    searchOpenAlex(query, options, cache),
    searchCrossref(query, options, cache),
    searchArxiv(query, options, cache),
  ])
  const queries: Array<{ source: ConnectorSource; query: string; run_at: string }> = [
    { source: 'openalex', query, run_at: runAt },
    { source: 'crossref', query, run_at: runAt },
    { source: 'arxiv', query, run_at: runAt },
  ]
  const hits: SearchHit[] = []
  const failures: string[] = []
  for (const [source, settled] of [['openalex', openalex], ['crossref', crossref], ['arxiv', arxiv]] as const) {
    if (settled.status === 'fulfilled') {
      hits.push(...settled.value)
    } else {
      failures.push(`${source}: ${(settled.reason as Error).message}`)
    }
  }
  const { papers, removed } = dedupPapers(hits.map(h => h.paper))
  // Rebuild hits with deduped papers, preserving per-source order.
  const paperIds = new Set(papers.map(p => p.paper_id))
  const finalHits = hits.filter(h => paperIds.has(h.paper.paper_id))
  return { hits: finalHits, queries, dedup_removed: removed, citation_edges: buildCitationEdges(finalHits), ...failures.length > 0 && { failures } }
}

/**
 * Build citation edges among the returned hits (design §4.4 step 4): an edge
 * source->target exists when the source's OpenAlex referenced_works contains
 * the target's OpenAlex id. Only intra-corpus edges are kept, so snapshots
 * stay self-contained.
 */
export function buildCitationEdges(hits: SearchHit[]): Array<{ source_paper_id: string; target_paper_id: string; kind: 'reference' }> {
  const byOpenAlexId = new Map<string, string>()
  for (const hit of hits) {
    const openalexId = hit.paper.identifiers.openalex
    if (typeof openalexId === 'string') byOpenAlexId.set(openalexId, hit.paper.paper_id)
  }
  const edges: Array<{ source_paper_id: string; target_paper_id: string; kind: 'reference' }> = []
  for (const hit of hits) {
    const source = hit.paper.paper_id
    for (const ref of hit.references ?? []) {
      const target = byOpenAlexId.get(ref)
      if (target !== undefined && target !== source) {
        edges.push({ source_paper_id: source, target_paper_id: target, kind: 'reference' })
      }
    }
  }
  // 去重
  const seen = new Set<string>()
  return edges.filter(edge => {
    const key = `${edge.source_paper_id}|${edge.target_paper_id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Resolve one DOI/arXiv id to a paper (design §1.4: identifier resolution). */
export async function resolvePaper(identifier: string, cache: ConnectorCache = NULL_CACHE): Promise<Paper> {
  const normalized = identifier.trim().toLowerCase()
  const key = `resolve:${normalized}`
  const cached = cache.get(key) as Paper | null
  if (cached !== null) return cached
  let paper: Paper
  if (normalized.startsWith('arxiv:')) {
    const arxivId = normalized.slice('arxiv:'.length)
    const hits = await searchArxiv(`id:${arxivId}`, { limit: 1 }, cache)
    const hit = hits[0]
    if (hit === undefined) throw new Error(`arxiv ${arxivId} not found`)
    paper = hit.paper
  } else {
    const doi = normalized.replace(/^doi:/, '').replace(/^https?:\/\/doi\.org\//, '')
    const data = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, 20000) as { message?: Record<string, unknown> }
    if (data.message === undefined) throw new Error(`doi ${doi} not found`)
    paper = crossrefPaper(data.message)
  }
  cache.set(key, paper)
  return paper
}

export { openAlexPaper, crossrefPaper, arxivPaper }


/**
 * Derive quote-level passages from paper abstracts (design §4.4 step 5).
 * Every passage is tagged `is_untrusted: true` — external content must never
 * be treated as instructions (design §4.9).
 */
export function buildPassages(papers: Paper[]): Passage[] {
  const passages: Passage[] = []
  for (const paper of papers) {
    if ((paper.abstract ?? '').trim() === '') continue
    const sentences = (paper.abstract ?? '').split(/(?<=[.!?])\s+/).map(t => t.trim()).filter(t => t.length > 0)
    for (const [index, sentence] of sentences.slice(0, 2).entries()) {
      passages.push({
        passage_id: `passage_${paper.paper_id.replace(/[^a-zA-Z0-9]/g, '_')}_${index}`,
        paper_id: paper.paper_id,
        text: sentence,
        location: 'abstract',
        claim_summary: '',
        is_untrusted: true,
      })
    }
  }
  return passages
}
