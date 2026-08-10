#!/usr/bin/env bash
# §14.3 / §19.2 latex-compiles eval: the LaTeX manuscript emitted by
# POST /v1/projects/{id}/manuscripts/build {format:'latex'} must compile in a
# FIXED build image (pdflatex from texlive) — §14.3 Reviewer Pass:
# "LaTeX 在固定构建镜像中编译".
#
# Flow:
#   1. pdflatex availability gate — when pdflatex is absent the eval SKIPs
#      with exit 0: the compile assertion is only meaningful inside the fixed
#      CI image (ubuntu-latest + texlive-latex-base + texlive-latex-
#      recommended), not on a dev machine without TeX. The gate runs BEFORE
#      the kernel starts so a SKIP is cheap and deterministic.
#   2. throwaway kernel (mkdtemp DB/CAS, random port);
#   3. project + minimal ledger: 1 analysis artifact (kind='analysis'),
#      1 contract, 1 corpus snapshot with 1 paper (BibTeX source), 1 claim +
#      1 verified evidence (provenance_status:'verified') accepted by the
#      verifier (provenance_status:'accepted'), claim verified to 'supported'
#      (abstract then carries the claim text);
#   4. POST /v1/projects/{id}/manuscripts/build {format:'latex',
#      include_limitations:true} -> text (LaTeX source) + bibtex;
#   5. assemble paper.tex + refs.bib: the builder emits \cite{...} keys in
#      Related Work but NO \bibliography command — append
#      \bibliographystyle{plain} + \bibliography{refs} before \end{document}
#      (or at EOF when \end{document} is absent);
#   6. pdflatex -interaction=nonstopmode -halt-on-error twice (second pass
#      settles the citation keys collected in the .aux), assert paper.pdf
#      exists with size > 0, and assert the .aux carries both \citation{...}
#      and \bibdata{refs};
#   7. cleanup (kernel killed, temp dir removed).
#
# Usage: bash evals/latex-eval.sh
set -eu

REPO=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
# Robust root detection: `$0` may be an absolute path outside the repo (e.g.
# when driven by a background task runner), in which case the dirname-based
# guess is wrong — fall back to the current working directory.
if [ ! -f "$REPO/packages/research-kernel/lib/bin/kernel.js" ] && [ -f "$PWD/packages/research-kernel/lib/bin/kernel.js" ]; then
  REPO=$PWD
fi
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
if [ ! -f "$KERNEL_BIN" ]; then
  echo "latex-eval: cannot locate repo root (tried '$REPO' and '$PWD')" >&2
  exit 1
fi

# ── gate: fixed build image with pdflatex ────────────────────────────────────
if ! command -v pdflatex > /dev/null 2>&1; then
  echo "SKIP latex-eval: pdflatex not found in PATH"
  echo "  (compile assertion needs the fixed build image: sudo apt-get install -y texlive-latex-base texlive-latex-recommended)"
  echo "  (CI job 'latex-compile' installs it on ubuntu-latest; on this machine the eval is skipped, exit 0)"
  exit 0
fi
PDFLATEX=$(command -v pdflatex)

WORK=$(mktemp -d)
PORT=""
KERNEL_PID=""
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL+1)); }
# §4 P0 (API-01/EVID-01): the kernel runs with the fixed eval service token;
# internal calls (approve/verified/accept) carry x-service-token via the helper
# (runners inherit the env var and authenticate their own internal calls).
export DSH_SCHOLAR_SERVICE_TOKEN='dsh-scholar-eval-service-token'
api() { curl -sf -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" "$@"; }
jfield() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const v=JSON.parse(d);console.log(v$1 ?? '')}catch(e){console.log('')}})" ; }

cleanup() {
  [[ -n "$KERNEL_PID" ]] && kill -9 "$KERNEL_PID" 2>/dev/null || true
  wait "$KERNEL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

start_kernel() {
  local port
  for port in $((21200 + $$ % 400)) $((21700 + $$ % 400)) $((22200 + $$ % 400)); do
    PORT=$port
    nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
    KERNEL_PID=$!
    for _ in $(seq 1 50); do
      curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && return 0
      sleep 0.1
    done
    kill -9 "$KERNEL_PID" 2>/dev/null || true
    wait "$KERNEL_PID" 2>/dev/null || true
    KERNEL_PID=""
  done
  return 1
}

start_kernel || { echo "latex-eval: kernel failed to start"; tail -5 "$WORK/kernel.log" >&2 || true; exit 1; }
BASE="http://127.0.0.1:$PORT"
ok "kernel healthy on port $PORT (pdflatex: $PDFLATEX)"

echo "== project + minimal ledger =="
BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["mAP@0.5"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"machine-learning"}'
PROJ=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"latex-eval\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
[[ -n "$PROJ" ]] || { echo "latex-eval: failed to create project"; exit 1; }
ok "project $PROJ"

ART=$(api -X POST "$BASE/v1/artifacts" -d "{\"project_id\":\"$PROJ\",\"kind\":\"analysis\",\"content_base64\":\"$(printf '{"mean_diff":2.8,"n":3}' | base64 -w0)\",\"metadata\":{\"metric\":\"mAP@0.5\"}}" | jfield '.artifact_id')
[[ "$ART" == sha256:* ]] && ok "analysis artifact $ART registered (kind='analysis')" || bad "analysis artifact registration: '$ART'"

IDEA=$(api -X POST "$BASE/v1/projects/$PROJ/ideas" -d '{"title":"Latex eval idea","hypothesis":"h","exact_delta":"d","falsification":{"observation":"o"},"minimum_viable_experiment":{"dataset":"d1","baseline":"b","primary_metric":"mAP@0.5","estimated_gpu_hours":1},"scores":{"feasibility":3,"information_gain":3,"reproducibility":3,"cost":3}}' | jfield '.idea_id')
[[ -n "$IDEA" ]] && ok "idea $IDEA" || bad "idea creation failed"

CONTRACT=$(api -X POST "$BASE/v1/projects/$PROJ/contracts" -d "{\"idea_id\":\"$IDEA\",\"data\":{\"dataset_id\":\"thumos14\",\"version\":\"v2\",\"split\":\"official\"},\"methods\":{\"baseline\":\"baseline_b\",\"treatment\":\"method_a\"},\"metrics\":{\"primary\":\"mAP@0.5\"},\"seeds\":[11,23,47],\"analysis\":{\"effect_size\":\"mean_difference\",\"interval\":\"bootstrap_95\",\"multiple_testing\":\"holm\"}}" | jfield '.contract_id')
[[ -n "$CONTRACT" ]] && ok "contract $CONTRACT" || bad "contract creation failed"

SNAP=$(api -X POST "$BASE/v1/projects/$PROJ/corpus" -d "{\"queries\":[{\"source\":\"openalex\",\"query\":\"temporal action localization\",\"run_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}],\"papers\":[{\"paper_id\":\"doi:10.1000/example1\",\"title\":\"Temporal Action Localization: A Survey\",\"authors\":[\"A. Author\"],\"year\":2021,\"venue\":\"TPAMI\",\"source\":\"openalex\",\"identifiers\":{\"doi\":\"10.1000/example1\"},\"abstract\":\"Survey.\",\"retrieved_at\":\"2026-08-06T12:00:00Z\"}]}" | jfield '.snapshot_id')
[[ -n "$SNAP" ]] && ok "corpus snapshot $SNAP (1 paper for BibTeX)" || bad "corpus snapshot failed"

EVID=$(api -X POST "$BASE/v1/projects/$PROJ/evidence/verified" -H 'x-service-principal: analysis-worker' -d "{\"source_type\":\"analysis\",\"run_ids\":[],\"artifact_refs\":[\"$ART\"],\"analysis_method\":\"bootstrap_95_mean_difference\",\"result\":{\"primary_metric\":\"mAP@0.5\",\"value\":61.2,\"baseline_value\":58.4,\"effect_size\":2.8,\"ci_low\":1.1,\"ci_high\":4.5,\"n_seeds\":3}" | jfield '.evidence_id')
[[ -n "$EVID" ]] && ok "verified evidence $EVID (provenance_status='verified')" || bad "evidence ingestion failed"
# §6: Verifier accept transition (verified -> accepted) before Claim support.
ACCP=$(api -X POST "$BASE/v1/projects/$PROJ/evidence/$EVID/accept" -H 'x-service-principal: verifier' -d '{"request_id":"latex-accept-1"}' | jfield '.provenance_status')
[[ "$ACCP" == "accepted" ]] && ok "evidence $EVID accepted by verifier (provenance_status='$ACCP')" || bad "evidence accept failed (provenance='$ACCP')"

CLAIM=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d '{"statement":"Method A improves mAP@0.5 over Baseline B on THUMOS14","scope":{"dataset":"thumos14_v2","split":"official_test"}}' | jfield '.claim_id')
CSTATUS=$(api -X POST "$BASE/v1/claims/verify" -d "{\"claim_id\":\"$CLAIM\",\"evidence_ids\":[\"$EVID\"],\"reason\":\"bootstrap CI excludes zero\"}" | jfield '.status')
[[ "$CSTATUS" == "supported" ]] && ok "claim $CLAIM verified: $CSTATUS" || bad "claim status: '$CSTATUS'"

echo "== manuscript build (format=latex, include_limitations=true) =="
api -X POST "$BASE/v1/projects/$PROJ/manuscripts/build" -d '{"format":"latex","include_limitations":true}' > "$WORK/manuscript.json"
if WORK="$WORK" node -e '
  const fs = require("node:fs")
  const m = JSON.parse(fs.readFileSync(process.env.WORK + "/manuscript.json", "utf8"))
  if (!m.text || !m.bibtex) { console.error("manuscript build response missing text/bibtex: " + JSON.stringify(m).slice(0, 300)); process.exit(1) }
  if (!m.text.includes("\\documentclass") || !m.text.includes("\\cite{")) { console.error("latex text missing documentclass/cite"); process.exit(1) }
  if (!m.bibtex.includes("@article{")) { console.error("bibtex missing @article entry"); process.exit(1) }
  // The builder emits \cite{...} but no \bibliography command — append one
  // pointing at refs.bib before \end{document} (or at EOF if absent).
  const end = m.text.lastIndexOf("\\end{document}")
  const paper = end >= 0
    ? m.text.slice(0, end) + "\\bibliographystyle{plain}\n\\bibliography{refs}\n" + m.text.slice(end)
    : m.text + "\n\\bibliographystyle{plain}\n\\bibliography{refs}\n"
  fs.writeFileSync(process.env.WORK + "/paper.tex", paper)
  fs.writeFileSync(process.env.WORK + "/refs.bib", m.bibtex)
  console.log(JSON.stringify({ text_bytes: m.text.length, bibtex_bytes: m.bibtex.length, has_end_document: end >= 0 }))
' > "$WORK/assembly.json"; then
  ok "paper.tex + refs.bib assembled: $(cat "$WORK/assembly.json")"
else
  bad "manuscript extraction/assembly failed"; head -c 400 "$WORK/manuscript.json"; echo
fi

echo "== pdflatex + bibtex in fixed build image (citation resolution) =="
if (cd "$WORK" && pdflatex -interaction=nonstopmode -halt-on-error paper.tex > pass1.log 2>&1); then
  ok "pdflatex pass 1 succeeded"
else
  bad "pdflatex pass 1 failed"; tail -20 "$WORK/pass1.log" >&2 || true
fi
# bibtex pass resolves \cite keys; warnings about undefined citations are
# expected on the first run (aux just collected them).
if (cd "$WORK" && bibtex paper > bibtex.log 2>&1); then
  ok "bibtex succeeded ($(grep -c '\\bibitem' "$WORK/paper.bbl" 2>/dev/null || echo 0) bibitems)"
else
  bad "bibtex failed"; tail -10 "$WORK/bibtex.log" >&2 || true
fi
if (cd "$WORK" && pdflatex -interaction=nonstopmode -halt-on-error paper.tex > pass2.log 2>&1); then
  ok "pdflatex pass 2 succeeded (citations resolved)"
else
  bad "pdflatex pass 2 failed"; tail -20 "$WORK/pass2.log" >&2 || true
fi
if (cd "$WORK" && pdflatex -interaction=nonstopmode -halt-on-error paper.tex > pass3.log 2>&1); then
  ok "pdflatex pass 3 succeeded (final)"
else
  bad "pdflatex pass 3 failed"; tail -20 "$WORK/pass3.log" >&2 || true
fi
if [[ -s "$WORK/paper.pdf" ]]; then
  ok "paper.pdf generated ($(wc -c < "$WORK/paper.pdf") bytes)"
else
  bad "paper.pdf missing or empty"
fi
if grep -Fq '\citation{doi_10_1000_example1}' "$WORK/paper.aux" && grep -Fq '\bibdata{refs}' "$WORK/paper.aux"; then
  ok "paper.aux carries \citation{doi_10_1000_example1} and \bibdata{refs} (references resolvable)"
else
  bad "citation/bibdata missing from paper.aux"
fi

echo "latex-eval: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
