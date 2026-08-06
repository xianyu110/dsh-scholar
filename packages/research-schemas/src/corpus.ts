/**
 * Survey-layer schemas: papers, passages, corpus snapshots, citation edges.
 * Immutable once snapshotted; every snapshot references its retrieval queries
 * and timestamps so later Idea/Paper work cannot drift (design §4.4, §6.1).
 * @module @dsh-scholar/research-schemas
 */

import { z } from 'zod'

/** Normalized external paper record from a scholarly connector. */
export const Paper = z.object({
  paper_id: z.string().min(1), // e.g. doi:10.xxxx/xxxx, arxiv:2301.00001
  title: z.string().min(1),
  authors: z.array(z.string()).default([]),
  year: z.number().int().optional(),
  venue: z.string().optional(),
  source: z.enum(['openalex', 'crossref', 'arxiv', 'semantic-scholar', 'user']),
  identifiers: z.record(z.string()).default({}),
  abstract: z.string().default(''),
  license: z.string().optional(),
  url: z.string().optional(),
  external_claim: z.string().optional(),
  retrieved_at: z.string(),
})
export type Paper = z.infer<typeof Paper>

/** A quote-level evidence span extracted from a paper. */
export const Passage = z.object({
  passage_id: z.string().min(1),
  paper_id: z.string().min(1),
  text: z.string().min(1),
  location: z.string().default(''), // page / paragraph / section reference
  license: z.string().optional(),
  claim_summary: z.string().default(''),
  is_untrusted: z.boolean().default(true), // external content: prompt-injection tagged
})
export type Passage = z.infer<typeof Passage>

/** Directed citation edge between two papers. */
export const CitationEdge = z.object({
  source_paper_id: z.string().min(1),
  target_paper_id: z.string().min(1),
  kind: z.enum(['forward', 'backward', 'reference']).default('reference'),
})
export type CitationEdge = z.infer<typeof CitationEdge>

/** A structured external claim extracted from a paper or passage. */
export const ExternalClaim = z.object({
  ext_claim_id: z.string().min(1),
  paper_id: z.string().min(1),
  passage_id: z.string().optional(),
  statement: z.string().min(1),
  claim_type: z.enum(['method', 'result', 'limitation', 'contradiction', 'phenomenon']).default('result'),
})
export type ExternalClaim = z.infer<typeof ExternalClaim>

/** Immutable corpus snapshot: papers + passages + edges + provenance. */
export const CorpusSnapshot = z.object({
  snapshot_id: z.string().min(1),
  project_id: z.string().min(1),
  queries: z.array(z.object({
    source: z.enum(['openalex', 'crossref', 'arxiv', 'semantic-scholar']),
    query: z.string(),
    run_at: z.string(),
  })).default([]),
  papers: z.array(Paper).default([]),
  passages: z.array(Passage).default([]),
  citation_edges: z.array(CitationEdge).default([]),
  external_claims: z.array(ExternalClaim).default([]),
  quality: z.object({
    total_papers: z.number().int().nonnegative(),
    dedup_ratio: z.number().min(0).max(1).default(0),
    coverage_note: z.string().default(''),
  }).default({ total_papers: 0 }),
  created_at: z.string(),
  frozen: z.boolean().default(true),
})
export type CorpusSnapshot = z.infer<typeof CorpusSnapshot>
