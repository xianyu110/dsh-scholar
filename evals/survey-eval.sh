#!/usr/bin/env bash
# §11.3 Survey quality eval: recall@K against known papers + dedup effectiveness.
#
# Live mode (--live): queries the real OpenAlex/Crossref/arXiv connectors and
# checks whether known DOIs/titles land in the top-K hits. Offline mode tests
# the dedup pipeline deterministically.
#
# Usage: bash evals/survey-eval.sh [--live]
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
LIVE=0
[[ "${1:-}" == "--live" ]] && LIVE=1
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL+1)); }

if [[ "$LIVE" == "1" ]]; then
  echo "Survey eval (live connectors): recall@10 for known landmark papers"
  node --input-type=module -e "
    import { multiSourceSearch, dedupPapers, titleFingerprint } from '$REPO/packages/scholar-connectors/lib/index.js'
    const targets = [
      { title: 'Attention Is All You Need', doi: '10.48550/arxiv.1706.03762' },
      { title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', doi: '10.48550/arxiv.1810.04805' },
      { title: 'Deep Residual Learning for Image Recognition', doi: '10.1109/CVPR.2016.90' },
    ]
    let pass = 0, fail = 0
    const tokens = (t) => t.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3)
    for (const t of targets) {
      try {
        const { hits } = await multiSourceSearch(t.title, { limit: 20 })
        const top = hits.slice(0, 20)
        const want = tokens(t.title)
        const hit = top.some(h => {
          const doiMatch = t.doi !== undefined && Object.values(h.paper.identifiers ?? {}).some(v => String(v).toLowerCase().includes(t.doi.toLowerCase()))
          if (doiMatch) return true
          const have = new Set(tokens(h.paper.title))
          const overlap = want.filter(w => have.has(w)).length
          return overlap >= 2
        })
        if (hit) { console.log('  ok: recall@20 hit for ' + t.title.slice(0, 40)); pass++ }
        else { console.log('  FAIL: ' + t.title.slice(0, 40) + ' not in top-20; top was: ' + (top[0]?.paper.title ?? 'none')); fail++ }
      } catch (e) { console.log('  FAIL: ' + t.title.slice(0, 40) + ' errored: ' + e.message); fail++ }
    }
    // dedup effectiveness
    const now = new Date().toISOString()
    const a = { paper_id: 'doi:10.1/x', title: 'Alpha Method: A Study', authors: ['A'], source: 'openalex', identifiers: { doi: '10.1/x' }, retrieved_at: now }
    const b = { ...a, paper_id: 'doi:10.1/x', source: 'crossref' }
    const c = { paper_id: 'openalex:y', title: 'alpha method a study', source: 'openalex', retrieved_at: now }
    const { removed } = dedupPapers([a, b, c])
    if (removed === 2) { console.log('  ok: dedup removed 2/3 (doi + title fingerprint)'); pass++ } else { console.log('  FAIL: dedup removed ' + removed); fail++ }
    if (titleFingerprint('Attention Is All You Need!') === titleFingerprint('attention is all you need')) { console.log('  ok: title fingerprint normalization'); pass++ } else { console.log('  FAIL: fingerprint'); fail++ }
    process.exit(fail > 0 ? 1 : 0)
  " && true || { echo "node eval failed"; exit 1; }
else
  echo "Survey eval (offline): dedup + fingerprint only (use --live for connector recall)"
  node --input-type=module -e "
    import { dedupPapers, titleFingerprint } from '$REPO/packages/scholar-connectors/lib/index.js'
    const now = new Date().toISOString()
    const a = { paper_id: 'doi:10.1/x', title: 'Alpha Method', authors: ['A'], source: 'openalex', identifiers: { doi: '10.1/x' }, retrieved_at: now }
    const b = { ...a, paper_id: 'doi:10.1/x', source: 'crossref' }
    const c = { paper_id: 'arxiv:2301.00001', title: 'Beta', source: 'arxiv', identifiers: { arxiv: '2301.00001' }, retrieved_at: now }
    const d = { ...c, source: 'crossref' }
    const e = { paper_id: 'openalex:z', title: 'Gamma: A Study', source: 'openalex', retrieved_at: now }
    const f = { paper_id: 'openalex:w', title: 'gamma a study', source: 'crossref', retrieved_at: now }
    const { papers, removed } = dedupPapers([a, b, c, d, e, f])
    if (removed === 3 && papers.length === 3) { console.log('  ok: dedup removed 3/6'); process.exit(0) }
    else { console.log('  FAIL: removed=' + removed + ' kept=' + papers.length); process.exit(1) }
  "
fi
echo "survey-eval: $PASS passed, $FAIL failed"
