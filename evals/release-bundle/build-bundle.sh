#!/usr/bin/env bash
# §14.4 Release Bundle assembler (Ticket SCH-REL-001) — builds a REAL,
# self-contained archive from kernel API data. The kernel is NOT modified:
# its release-bundle endpoint only returns a JSON manifest
# (bundle_id/artifact_id); archive assembly happens here, in the script
# layer, with every §14.4 section materialized as real files on disk.
#
# Usage:
#   bash evals/release-bundle/build-bundle.sh <kernel-port> <project-id> <out-dir> [release-bundle-response.json]
#
# The optional 4th argument is the saved JSON response of
# POST /v1/projects/{id}/release-bundle (bundle_id/artifact_id); when absent
# the endpoint is called here (idempotent — registers a fresh bundle artifact).
#
# Output layout (DSH_Scholar_v2.0.md §14.4):
#   release-bundle/
#   ├── manifest.json          bundle_schema_version=2 + artifact hash map +
#                              runtime section (node/kernel/runner digests,
#                              pinned images.lock digests, §12 clean-room)
#   ├── manuscript/            paper.md + references.bib + figures/ + paper artifacts
#   ├── source/                code artifacts + kernel bundle manifest
#   ├── environment/           system-info.json
#   ├── data/                  dataset-manifest.json (from contracts' data fields)
#   ├── runs/                  contracts/ + manifests/ + metrics/ (normalized §12.5) + logs/
#   ├── analysis/              aggregate.json + outputs/ (analysis + chart artifacts)
#   ├── reproduce.sh           clean-room rerun driver (§14.5, generated)
#   ├── verify.sh              self-contained verifier (byte-copy of verify-bundle.sh)
#   ├── LICENSES/              LICENSE.txt (project license notice)
#   └── AI_USAGE.md            AI usage declaration
set -eu

PORT=${1:?usage: build-bundle.sh <kernel-port> <project-id> <out-dir> [release-bundle-response.json]}
PROJ=${2:?missing project-id}
OUT=${3:?missing out-dir}
RB_RESP=${4:-}
BASE="http://127.0.0.1:$PORT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

api() { curl -sf -H 'content-type: application/json' "$@"; }

mkdir -p "$OUT"/runs/contracts "$OUT"/runs/manifests "$OUT"/runs/metrics "$OUT"/runs/logs \
  "$OUT"/analysis/outputs "$OUT"/manuscript/figures "$OUT"/data "$OUT"/environment \
  "$OUT"/source "$OUT"/artifacts "$OUT"/LICENSES

echo "== fetching kernel state for project $PROJ (port $PORT) =="
api "$BASE/v1/projects/$PROJ" > "$TMP/project.json"
api "$BASE/v1/projects/$PROJ/contracts" > "$TMP/contracts.json"
api "$BASE/v1/projects/$PROJ/jobs" > "$TMP/jobs.json"
api "$BASE/v1/projects/$PROJ/claims" > "$TMP/claims.json"
api "$BASE/v1/projects/$PROJ/evidence" > "$TMP/evidence.json"
api "$BASE/v1/projects/$PROJ/corpus-snapshots" > "$TMP/corpus.json"
# NOTE: the artifacts list is fetched AFTER the release-bundle/analysis/
# manuscript calls below, so every artifact those calls register (bundle
# manifest, aggregate + chart, paper) is included in the archive snapshot.

# Kernel Release Bundle endpoint: JSON manifest (bundle_id/artifact_id).
# Prefer the caller's saved response so the manifest.bundle_id matches the
# bundle the caller exported; otherwise call the endpoint here.
if [ -n "$RB_RESP" ] && [ -s "$RB_RESP" ]; then
  cp "$RB_RESP" "$TMP/release-bundle.json"
else
  api -X POST "$BASE/v1/projects/$PROJ/release-bundle" > "$TMP/release-bundle.json"
fi
BUNDLE_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP/release-bundle.json','utf8')).bundle_id)")
echo "  kernel release-bundle manifest: bundle_id=$BUNDLE_ID"

echo "== analysis: POST /v1/projects/$PROJ/analysis =="
# Prefer the primary metric declared on the first contract; fall back to the
# unparameterized aggregation. Both may 422 when no succeeded run carries
# metrics — in that case the analysis section is left empty.
AN_BODY='{}'
if node -e "process.exit(JSON.parse(require('fs').readFileSync('$TMP/contracts.json','utf8')).length>0?0:1)" 2>/dev/null; then
  METRIC=$(node -e "const c=JSON.parse(require('fs').readFileSync('$TMP/contracts.json','utf8'));console.log(c[0].metrics.primary)")
  AN_BODY="{\"metric\":\"$METRIC\"}"
fi
if ! AN=$(api -X POST "$BASE/v1/projects/$PROJ/analysis" -d "$AN_BODY" 2>/dev/null); then
  if [[ "$AN_BODY" != '{}' ]] && AN=$(api -X POST "$BASE/v1/projects/$PROJ/analysis" -d '{}' 2>/dev/null); then
    AN_BODY='{}'
  else
    echo "  (no aggregate analysis available — analysis section left empty)"
    AN=''
    AN_BODY=''
  fi
fi
if [ -n "$AN" ]; then
  printf '%s' "$AN" > "$TMP/analysis.json"
  printf '%s' "$AN" > "$OUT/analysis/aggregate.json"
  echo "  aggregate written to analysis/aggregate.json (mean=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$TMP/analysis.json','utf8')).mean)"))"
fi

echo "== manuscript: POST /v1/projects/$PROJ/manuscripts/build =="
MS=$(api -X POST "$BASE/v1/projects/$PROJ/manuscripts/build" -d '{"format":"markdown","include_limitations":true}')
printf '%s' "$MS" > "$TMP/manuscript.json"
node - "$TMP/manuscript.json" "$OUT" <<'DHSH_NODE'
const fs = require('fs')
const ms = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const out = process.argv[3]
fs.writeFileSync(`${out}/manuscript/paper.md`, ms.text)
fs.writeFileSync(`${out}/manuscript/references.bib`, ms.bibtex ?? '')
fs.writeFileSync(`${out}/manuscript/manuscript.json`, JSON.stringify(ms, null, 2))
console.log(`  paper.md (${ms.text.length} bytes), references.bib (${(ms.bibtex ?? '').length} bytes), format=${ms.format}`)
DHSH_NODE

echo "== tex workspace export (§4 REL-01: TeX inputs into the bundle) =="
# Every TeX document referenced by a SUCCEEDED latex-compile job is exported:
# the file bytes land in tex-workspace/<document_id>/<path> and the manifest
# tex section records the per-file list + sha256 + size (recomputed from disk),
# so the clean-room rerun can rebuild the same workspace in a FRESH kernel and
# compare TeX inputs field-by-field. Documents with no succeeded build are not
# replayed and therefore not exported.
: > "$TMP/tex.json"
BASE="$BASE" TEX_JSON="$TMP/tex.json" OUT="$OUT" node - "$TMP/jobs.json" <<'DHSH_NODE'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const base = process.env.BASE
const docs = [...new Set(jobs
  .filter(j => j.kind === 'latex-compile' && j.status === 'succeeded'
    && j.payload && typeof j.payload.tex_document_id === 'string')
  .map(j => j.payload.tex_document_id))]
;(async () => {
  const section = { documents: [] }
  for (const docId of docs) {
    const treeRes = await fetch(`${base}/v1/documents/${docId}/tree`)
    if (!treeRes.ok) throw new Error(`tex tree ${treeRes.status} for ${docId}`)
    const tree = await treeRes.json()
    const docDir = path.join(process.env.OUT, 'tex-workspace', docId)
    const files = []
    for (const f of tree.files) {
      const fileRes = await fetch(`${base}/v1/documents/${docId}/file?path=${encodeURIComponent(f.path)}`)
      if (!fileRes.ok) throw new Error(`tex file ${fileRes.status} for ${docId}/${f.path}`)
      const file = await fileRes.json()
      const target = path.join(docDir, f.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.content)
      const sha = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
      files.push({ path: f.path, version: f.version, sha256: sha, size_bytes: fs.statSync(target).size })
    }
    section.documents.push({ document_id: docId, root_file: tree.document.root_file, revision: tree.document.revision, files })
  }
  fs.writeFileSync(process.env.TEX_JSON, JSON.stringify(section, null, 2) + '\n')
  console.log(`  tex export: ${section.documents.length} document(s)`)
})().catch(e => { console.error(e.message); process.exit(1) })
DHSH_NODE

echo "== downloading artifacts (GET /v1/artifacts/{id}?project_id=$PROJ) =="
mkdir -p "$TMP/dl"
: > "$TMP/downloads.tsv"
api "$BASE/v1/projects/$PROJ/artifacts" > "$TMP/artifacts.json"
# NOTE: listArtifacts returns metadata as an unparsed JSON string, so routing
# decisions cannot rely on it — the post-processing step below discriminates
# by CONTENT (runner metrics artifact vs computeAnalysis aggregate).
while IFS=$'\t' read -r ART_ID KIND; do
  curl -sf "$BASE/v1/artifacts/${ART_ID//:/%3A}?project_id=$PROJ" -o "$TMP/dl/$ART_ID"
  printf '%s\t%s\n' "$ART_ID" "$KIND" >> "$TMP/downloads.tsv"
done < <(node - "$TMP/artifacts.json" <<'DHSH_NODE'
const fs = require('fs')
for (const a of JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))) console.log(`${a.artifact_id}\t${a.kind}`)
DHSH_NODE
)

echo "== routing + post-processing (hash every artifact; normalize metrics to §12.5) =="
node - "$TMP/downloads.tsv" "$TMP/jobs.json" "$OUT" "$TMP" <<'DHSH_NODE'
// Route every artifact to its §14.4 location, then hash it. Artifact kinds:
// log → runs/logs, manifest → runs/manifests, chart → manuscript/figures,
// paper → manuscript, code → source, data → data, bundle → source (the
// kernel's own JSON manifest, provenance), pdf/model → artifacts/. kind=
// 'analysis' is ambiguous (both runner metrics artifacts and computeAnalysis
// aggregates are registered as analysis): discriminate by CONTENT — a runner
// metrics artifact has {run_id, job_id, metrics:[{metric,value}]} (the
// extractMetrics() output, not the §12.5 fixed schema) and is normalized into
// the §12.5 shape (schema_version, run_id, contract_id, seed, metrics with
// name/value/unit) using the job record for contract_id/seed; the raw
// extraction fields stay available under raw_metric. The computeAnalysis
// aggregate has {analysis:{mean,effect_size,...}, ...} and goes to
// analysis/outputs/. Hash + size are recomputed from disk for every artifact
// so manifest hashes always match the actual bundle files.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').filter(Boolean).map(l => l.split('\t'))
const jobs = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
const out = process.argv[4]
const dlDir = path.join(process.argv[5], 'dl')
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const seen = new Map()
const outRows = []
for (const [id, kind] of rows) {
  const file = path.join(dlDir, id)
  let rel = null
  let normalized = false
  if (kind === 'log') rel = `runs/logs/${id}.log`
  else if (kind === 'manifest') rel = `runs/manifests/${id}.json`
  else if (kind === 'chart') rel = `manuscript/figures/${id}.svg`
  else if (kind === 'paper') rel = `manuscript/${id}.md`
  else if (kind === 'code') rel = `source/${id}`
  else if (kind === 'data') rel = `data/${id}`
  else if (kind === 'bundle') rel = 'source/kernel-bundle-manifest.json'
  else if (kind === 'analysis') {
    let parsed = null
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* not JSON */ }
    const isAggregate = parsed !== null && typeof parsed.analysis === 'object' && parsed.analysis !== null && typeof parsed.analysis.mean === 'number'
    if (isAggregate) {
      rel = `analysis/outputs/${id}.json`
    } else if (parsed !== null && Array.isArray(parsed.metrics) && typeof parsed.run_id === 'string') {
      // runner metrics artifact → §12.5 normalization
      const job = (jobs ?? []).find(j => j.job_id === parsed.job_id) ?? {}
      const norm = {
        schema_version: 1,
        run_id: parsed.run_id,
        job_id: parsed.job_id,
        contract_id: job.contract_id ?? null,
        seed: typeof job.payload?.seed === 'number' ? job.payload.seed : null,
        metrics: (parsed.metrics ?? []).map(m => ({
          name: m.metric ?? m.name,
          value: m.value,
          unit: m.unit ?? 'ratio',
          ...(m.seed !== undefined ? { seed: m.seed } : {}),
          raw_metric: m.metric,
        })),
        source_artifact: id,
        normalized_by: 'dsh-scholar/evals/release-bundle/build-bundle.sh (runner metrics artifact -> §12.5 shape)',
      }
      rel = `runs/metrics/${parsed.job_id ?? id}.json`
      fs.mkdirSync(path.join(out, 'runs/metrics'), { recursive: true })
      fs.writeFileSync(path.join(out, rel), JSON.stringify(norm, null, 2) + '\n')
      normalized = true
    } else {
      rel = `analysis/outputs/${id}.json` // unknown analysis-shaped JSON: keep as output
    }
  } else {
    rel = `artifacts/${id}` // pdf / model / future kinds
  }
  if (!normalized) {
    fs.mkdirSync(path.join(out, path.dirname(rel)), { recursive: true })
    fs.copyFileSync(file, path.join(out, rel))
  }
  const n = (seen.get(rel) ?? 0) + 1
  seen.set(rel, n)
  if (n > 1) { // collision (e.g. a second bundle artifact): disambiguate
    const dot = rel.lastIndexOf('.')
    const rel2 = dot === -1 ? `${rel}-${n}` : `${rel.slice(0, dot)}-${n}${rel.slice(dot)}`
    fs.copyFileSync(path.join(out, rel), path.join(out, rel2))
    fs.rmSync(path.join(out, rel))
    rel = rel2
  }
  const finalFile = path.join(out, rel)
  outRows.push([id, rel, sha(finalFile), kind, String(fs.statSync(finalFile).size), String(normalized)])
}
fs.writeFileSync(process.argv[2], outRows.map(r => r.join('\t')).join('\n') + '\n')
console.log(`  routed + hashed ${outRows.length} artifact file(s)`)
DHSH_NODE

echo "== data/dataset-manifest.json (from contracts' data fields) =="
node - "$TMP/contracts.json" "$OUT/data/dataset-manifest.json" <<'DHSH_NODE'
const fs = require('fs')
const contracts = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const manifest = {
  schema_version: 2,
  datasets: contracts.map(c => ({
    dataset_id: c.data.dataset_id,
    version: c.data.version ?? null,
    split: c.data.split ?? 'official',
    preprocessing_hash: c.data.preprocessing_hash ?? null,
    contract_id: c.contract_id,
  })),
  note: 'Compiled from contract data fields (§14.4 data/); raw dataset blobs, when present, are registered CAS artifacts under data/.',
}
fs.writeFileSync(process.argv[3], JSON.stringify(manifest, null, 2) + '\n')
DHSH_NODE

echo "== environment/system-info.json =="
node - "$OUT/environment/system-info.json" "$PORT" "$PROJ" <<'DHSH_NODE'
const fs = require('fs')
const { execSync } = require('child_process')
const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8' }).trim() } catch { return null } }
const info = {
  os: sh('uname -srm'),
  hostname: sh('hostname'),
  node: sh('node --version'),
  kernel_port: Number(process.argv[3]),
  project_id: process.argv[4],
  tools: { curl: sh('curl --version | head -1'), sha256sum: sh('sha256sum --version | head -1') },
  generated_at: new Date().toISOString(),
}
fs.writeFileSync(process.argv[2], JSON.stringify(info, null, 2) + '\n')
DHSH_NODE

echo "== LICENSES + AI_USAGE =="
cat > "$OUT/LICENSES/LICENSE.txt" <<EOF
Project license: BSD-3-Clause (dsh-scholar, see repository LICENSE).
This bundle was generated from the research kernel API by
evals/release-bundle/build-bundle.sh (Ticket SCH-REL-001).
All data, logs, metrics and analysis artifacts are content-addressed
(sha256) and recorded in manifest.json.
EOF
cat > "$OUT/AI_USAGE.md" <<EOF
# AI Usage Declaration

Generated with an AI research assistant; all numbers traceable to run
manifests and analysis artifacts.

- Archive assembled by evals/release-bundle/build-bundle.sh at $(date -u +%Y-%m-%dT%H:%M:%SZ)
- Every artifact is content-addressed (sha256) and recorded in manifest.json
- Rerun: ./reproduce.sh (clean-room, §14.5); verify: ./verify.sh
EOF

echo "== runtime declaration (bundle-only clean-room, acceptance-tests.md §12) =="
# The runtime section pins the exact node/kernel/runner/image identities the
# bundle was built with. kernel_bin/runner_bin are sha256 of the binaries the
# assembler ran with (KERNEL_BIN/RUNNER_BIN env when set, else the repo
# defaults — the same binaries run-release-eval.sh hands to reproduce.sh), so
# the clean-room rerun can refuse any OTHER binary (acceptance-tests.md line
# 191: "仅允许 Bundle 文件及其中声明的固定 runtime/image digest"). The image
# entries MUST equal configs/runner-profiles/images.lock.json (mirrors the
# kernel's images-lock fallback when the file is unreadable).
REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
RT_KERNEL_BIN="${KERNEL_BIN:-}"
if [ -z "$RT_KERNEL_BIN" ] && [ -f "$REPO_ROOT/packages/research-kernel/lib/bin/kernel.js" ]; then
  RT_KERNEL_BIN="$REPO_ROOT/packages/research-kernel/lib/bin/kernel.js"
fi
RT_RUNNER_BIN="${RUNNER_BIN:-}"
if [ -z "$RT_RUNNER_BIN" ] && [ -f "$REPO_ROOT/workers/runner-gateway/lib/bin/runner.js" ]; then
  RT_RUNNER_BIN="$REPO_ROOT/workers/runner-gateway/lib/bin/runner.js"
fi
RT_KERNEL_SHA=""
if [ -n "$RT_KERNEL_BIN" ] && [ -f "$RT_KERNEL_BIN" ]; then
  RT_KERNEL_SHA=$(sha256sum "$RT_KERNEL_BIN" | awk '{print $1}')
fi
RT_RUNNER_SHA=""
if [ -n "$RT_RUNNER_BIN" ] && [ -f "$RT_RUNNER_BIN" ]; then
  RT_RUNNER_SHA=$(sha256sum "$RT_RUNNER_BIN" | awk '{print $1}')
fi
IMAGES_LOCK="$REPO_ROOT/configs/runner-profiles/images.lock.json"
echo "  kernel_bin sha256=${RT_KERNEL_SHA:-null} runner_bin sha256=${RT_RUNNER_SHA:-null} images.lock=$IMAGES_LOCK"

echo "== manifest.json (generator) =="
OUT="$OUT" TMPD="$TMP" AN_BODY="$AN_BODY" RT_KERNEL_SHA="$RT_KERNEL_SHA" RT_RUNNER_SHA="$RT_RUNNER_SHA" IMAGES_LOCK="$IMAGES_LOCK" node - <<'DHSH_NODE'
const fs = require('fs')
const out = process.env.OUT
const tmp = process.env.TMPD
const j = (p) => JSON.parse(fs.readFileSync(`${tmp}/${p}`, 'utf8'))
const rb = j('release-bundle.json')
const project = j('project.json')
const contracts = j('contracts.json')
const jobs = j('jobs.json')
const claims = j('claims.json')
const evidence = j('evidence.json')
const snapshots = j('corpus.json')
const analysis = fs.existsSync(`${tmp}/analysis.json`) ? j('analysis.json') : null
const manuscript = j('manuscript.json')
const filesRows = fs.readFileSync(`${tmp}/downloads.tsv`, 'utf8').trim().split('\n').filter(Boolean).map(l => l.split('\t'))
const artifacts = {}
for (const [id, rel, sha, kind, size, normalized] of filesRows) {
  artifacts[id] = { path: rel, sha256: sha, kind, size_bytes: Number(size), normalized: normalized === 'true' }
}
// §12 bundle-only clean-room: declared fixed runtime + image digests. The
// rerun (reproduce.sh) refuses any binary/image that is not exactly this.
let images = { node_fixture: null, texlive: null }
try {
  const lock = JSON.parse(fs.readFileSync(process.env.IMAGES_LOCK, 'utf8'))
  images = {
    node_fixture: typeof lock.node_fixture === 'string' ? lock.node_fixture : null,
    texlive: typeof lock.texlive === 'string' ? lock.texlive : null,
  }
} catch { /* lock unreadable: images stay null — reproduce.sh fails closed */ }
if (images.node_fixture === null || images.texlive === null) {
  // Kernel-side fallback (packages/research-kernel/src/images-lock.ts) — the
  // pinned entries are the only ones ever honored; never caller-supplied.
  if (images.node_fixture === null) images.node_fixture = 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
  if (images.texlive === null) images.texlive = 'texlive/texlive@sha256:8957c916b8160049f89c24d362a6d86c09d8a04095acde37e88404c4afed85b4'
}
const runtime = {
  node: process.version,
  kernel_bin: process.env.RT_KERNEL_SHA || null,
  runner_bin: process.env.RT_RUNNER_SHA || null,
  images,
}
// §4 REL-01: TeX inputs exported alongside the artifacts (file list + sha256
// + size per document); null when the project has no succeeded latex-compile
// build. The rerun rebuilds these inputs in a fresh kernel and compares them
// field-by-field (compared.tex).
let tex = null
if (fs.existsSync(`${tmp}/tex.json`)) {
  const t = JSON.parse(fs.readFileSync(`${tmp}/tex.json`, 'utf8'))
  if (Array.isArray(t.documents) && t.documents.length > 0) tex = t
}
const manifest = {
  bundle_id: rb.bundle_id,
  bundle_schema_version: 2,
  project,
  contracts,
  jobs,
  artifacts,
  tex,
  claims,
  evidence,
  corpus: snapshots,
  analysis,
  analysis_request: analysis !== null ? JSON.parse(process.env.AN_BODY || '{}') : null,
  manuscript,
  environment: JSON.parse(fs.readFileSync(`${out}/environment/system-info.json`, 'utf8')),
  runtime,
  release_gate: 'unapproved',
  created_at: new Date().toISOString(),
  builder: {
    script: 'evals/release-bundle/build-bundle.sh',
    role: 'archive assembler: kernel API -> §14.4 layout (kernel itself unchanged)',
    verify_script: 'verify.sh is a byte-copy of evals/release-bundle/verify-bundle.sh',
  },
}
fs.writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n')
console.log(`  manifest.json written (bundle_id=${manifest.bundle_id}, ${filesRows.length} artifacts)`)
DHSH_NODE

echo "== reproduce.sh (copy of reproduce.template.sh) =="
TEMPLATE=$(cd "$(dirname "$0")" && pwd)/reproduce.template.sh
if [ -f "$TEMPLATE" ]; then
  cp "$TEMPLATE" "$OUT/reproduce.sh"
  chmod +x "$OUT/reproduce.sh"
else
  echo "warning: reproduce.template.sh not found next to build-bundle.sh — reproduce.sh not generated" >&2
fi

echo "== verify.sh (self-contained: byte-copy of verify-bundle.sh) =="
VERIFY_SRC=$(cd "$(dirname "$0")" && pwd)/verify-bundle.sh
if [ -f "$VERIFY_SRC" ]; then
  cp "$VERIFY_SRC" "$OUT/verify.sh"
  chmod +x "$OUT/verify.sh"
else
  echo "warning: verify-bundle.sh not found next to build-bundle.sh — verify.sh not generated" >&2
fi

echo "== bundle assembled: $OUT =="
du -sh "$OUT" | sed 's/^/  /'
