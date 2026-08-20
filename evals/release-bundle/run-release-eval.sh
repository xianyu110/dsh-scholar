#!/usr/bin/env bash
# §14.4 / §14.5 Release Bundle eval (Ticket SCH-REL-001) — end-to-end:
#
#   fresh kernel (random port, mkdtemp DB) + docker-mode runner
#   → project + contract
#   → 2 real smoke jobs whose scripts emit metrics JSON lines (non-echo,
#     empty-command jobs are prohibited — kind=smoke + payload.script is the
#     allowed path, per evals/golden-path-v2)
#   → POST /v1/projects/{id}/analysis (aggregate with mean/effect_size)
#   → TeX workspace + latex-compile job (real texlive container → PDF; the
#     bundle's TeX inputs + PDF structure are compared in the clean-room)
#   → corpus snapshot + evidence + claim (bundle manifest sections)
#   → POST /v1/projects/{id}/release-bundle (JSON manifest, bundle_id/artifact_id)
#   → build-bundle.sh assembles the REAL self-contained archive (§14.4)
#   → verify-bundle.sh + the in-bundle verify.sh
#   → clean-room rerun: bundle-only reproduce.sh in a FRESH kernel + FRESH
#     runner (docker mode when available) → reproducibility-report.json
#
# Usage: bash evals/release-bundle/run-release-eval.sh [--keep-bundle <dir>]
#   --keep-bundle <dir>  keep the assembled archive at <dir> (default: a
#                        temp dir removed on exit). On success the final line
#                        BUNDLE_DIR=<path> is printed (consumed by
#                        tests/security/run-release-bundle-tests.sh).
set -eu

REPO=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
if [ ! -f "$REPO/packages/research-kernel/lib/bin/kernel.js" ]; then
  # Robust root detection: `dirname $0/..` may land one level shallow when
  # invoked via an absolute path from another working directory (e.g. the
  # tests/security aggregator) — climb until the kernel bin is found.
  REPO=$PWD
  while [ ! -f "$REPO/packages/research-kernel/lib/bin/kernel.js" ] && [ "$REPO" != "/" ]; do
    REPO=$(dirname "$REPO")
  done
fi
if [ ! -f "$REPO/packages/research-kernel/lib/bin/kernel.js" ]; then
  echo "run-release-eval: cannot locate repo root (tried '$REPO')" >&2
  exit 1
fi
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
RUNNER_BIN="$REPO/workers/runner-gateway/lib/bin/runner.js"
BUILD="$REPO/evals/release-bundle/build-bundle.sh"
VERIFY="$REPO/evals/release-bundle/verify-bundle.sh"

KEEP=""
if [ "${1:-}" = "--keep-bundle" ]; then
  KEEP=${2:?--keep-bundle requires a directory}
fi

WORK=$(mktemp -d)
PORT=$((18800 + $$ % 900))
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL + 1)); }
# §4 P0 (API-01/EVID-01): the kernel runs with the fixed eval service token;
# internal calls (approve/verified/accept) carry x-service-token via the helper
# (runners inherit the env var and authenticate their own internal calls).
export DSH_SCHOLAR_SERVICE_TOKEN='dsh-scholar-eval-service-token'
api() { curl -sf -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" "$@"; }
# GOV-03: this eval exercises the same service-only Human BFF bridge as the
# browser workflow. The obsolete public v1 Gate decision writer is absent.
human_decide() { # <gate-id> <decision-json>
  api -H 'x-service-principal: standalone-human-bff' \
    -X POST "http://127.0.0.1:$PORT/internal/human-gates/$1/decisions" -d "$2"
}
# P0-4: code snapshots are workspace-bound — shared helpers seed the fixture
# into a project workspace and POST workspace_id + root_relative_path.
# shellcheck source=code-snapshot-lib.sh
source "$REPO/evals/code-snapshot-lib.sh"
say() { printf '\033[1;34m== %s ==\033[0m\n' "$*"; }

RUNNER_PID=""
KERNEL_PID=""
cleanup() {
  kill "$RUNNER_PID" "$KERNEL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

say "kernel + runner (docker mode) on random port"
nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
if curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1; then
  ok "kernel healthy (port $PORT)"
else
  bad "kernel failed to start"; tail -5 "$WORK/kernel.log" >&2; exit 1
fi
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT" --owner release-eval --poll-ms 200 --mode docker --timeout-ms 30000 > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
sleep 0.5
ok "runner started (docker mode)"

say "project + contract"
BRIEF='{"problem":"release-bundle evaluation","scope":"smoke","questions":[],"primary_metrics":["m1"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"machine-learning"}'
PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"release-bundle-eval\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"execution\":{\"runner_profile_id\":\"profile_local_docker_cpu_v1\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
[[ "$PROJ" == rsp_* ]] && ok "project $PROJ" || bad "project id '$PROJ'"
# Follow the real gate-controlled lifecycle instead of freezing a Contract on
# an unrelated DRAFT. This leaves the fixture at CONTRACT_PENDING before the
# contract below is registered and approved by its Human Gate.
G_SCOPE=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/gates" -d '{"type":"scope","title":"Release eval scope"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).gate_id))")
human_decide "$G_SCOPE" '{"actor":"release-eval","principal":{"principal_id":"release-eval-pi","auth_method":"dsh-session"},"decision":"approved"}' > /dev/null
for PHASE in SURVEYING IDEATING; do
  REV=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).revision))")
  api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"$PHASE\",\"expected_revision\":$REV}" > /dev/null
done
G_IDEA=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/gates" -d '{"type":"idea","title":"Release eval idea"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).gate_id))")
human_decide "$G_IDEA" '{"actor":"release-eval","principal":{"principal_id":"release-eval-pi","auth_method":"dsh-session"},"decision":"approved"}' > /dev/null
REV=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).revision))")
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"CONTRACT_PENDING\",\"expected_revision\":$REV}" > /dev/null
# Contract — feeds data/dataset-manifest.json and the manuscript methods section.
CONTRACT=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/contracts" -d '{"idea_id":"idea_release_bundle","data":{"dataset_id":"synth-smoke-v1","version":"1.0.0","split":"official","preprocessing_hash":"sha256:eval"},"methods":{"baseline":"no-treatment","treatment":"smoke-treatment"},"metrics":{"primary":"m1","secondary":["n_samples"]},"seeds":[1,2],"analysis":{"effect_size":"cohens_d","interval":"bootstrap-95","multiple_testing":"none"},"stop_conditions":{"max_gpu_hours":2,"min_completed_seeds":2,"stop_on_data_leakage":true}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).contract_id))")
[[ "$CONTRACT" == expc_* ]] && ok "contract $CONTRACT registered" || bad "contract id '$CONTRACT'"
G_CONTRACT=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/gates" -d "{\"type\":\"contract\",\"title\":\"Release eval Contract\",\"payload\":{\"contract_id\":\"$CONTRACT\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).gate_id))")
human_decide "$G_CONTRACT" '{"actor":"release-eval","principal":{"principal_id":"release-eval-pi","auth_method":"dsh-session"},"decision":"approved"}' > /dev/null
ok "contract $CONTRACT frozen (approval recorded)"

say "baseline jobs (kind=baseline, seeds 1/2, matched-seed design §13.6)"
mkdir -p "$WORK/fixture"
printf '#!/bin/sh\necho "release-bundle fixture"\n' > "$WORK/fixture/run.sh"
# P0-4 (SNAPSHOT-01/API-01): seed the fixture into an approved project workspace
# and archive via workspace_id + root_relative_path (server-side root).
REL_WS=$(code_snapshot_seed_workspace "$PORT" "$PROJ" "fixture" "$WORK/fixture")
SNAP=$(code_snapshot_api "$PORT" "$PROJ" "$REL_WS" "" "release-bundle fixture" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).snapshot_id||JSON.parse(d).code_snapshot_id||''))")
[ -n "$SNAP" ] || { echo "failed to create code snapshot"; exit 1; }
# §12.5 (P0): baseline jobs MUST produce a MetricsFileV1 at the output
# contract path — the command writes it from the runner-injected run identity.
mfile() { # <value> <seed> — emits the in-container `node -e` script body
  node -e 'console.log(JSON.stringify(`const fs=require("fs");const m={schema_version:1,run_id:process.env.DSH_RUN_ID,contract_id:process.env.DSH_CONTRACT_ID,seed:'"$2"',metrics:[{name:"m1",value:'"$1"',unit:""}]};fs.writeFileSync("/outputs/metrics.json",JSON.stringify(m))`))'
}
REV=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).revision))")
B11=$(KEY="rel-base-1" CT="$CONTRACT" SNAP="$SNAP" REV="$REV" INNER="$(mfile 0.450 1)" node -e 'console.log(JSON.stringify({expected_revision:Number(process.env.REV),idempotency_key:process.env.KEY,contract_id:process.env.CT,code_snapshot_id:process.env.SNAP,image_digest:"node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",command:["sh","-c","node -e "+process.env.INNER],output_contract:{metrics:"/outputs/metrics.json",logs:"/outputs/run.log"}}))')
BASE1=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/baseline-runs" -d "$B11")
REV=$(printf '%s' "$BASE1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project.revision))")
B12=$(KEY="rel-base-2" CT="$CONTRACT" SNAP="$SNAP" REV="$REV" INNER="$(mfile 0.550 2)" node -e 'console.log(JSON.stringify({expected_revision:Number(process.env.REV),idempotency_key:process.env.KEY,contract_id:process.env.CT,code_snapshot_id:process.env.SNAP,image_digest:"node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",command:["sh","-c","node -e "+process.env.INNER],output_contract:{metrics:"/outputs/metrics.json",logs:"/outputs/run.log"}}))')
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/baseline-runs" -d "$B12" > /dev/null
say "2 smoke jobs (kind=smoke + payload.script emitting metrics JSON lines)"
submit_smoke() { # <idempotency-key> <m1-value> <seed>
  KEY="$1" VAL="$2" SEED="$3" PORT="$PORT" PROJ="$PROJ" node -e '
    const body = JSON.stringify({ idempotency_key: process.env.KEY, kind: "smoke", payload: { script: `echo \u0027{"metric":"m1","value":${process.env.VAL},"seed":${process.env.SEED}}\u0027` } })
    fetch(`http://127.0.0.1:${process.env.PORT}/v1/projects/${process.env.PROJ}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body })
      .then(r => r.json()).then(j => console.log(j.job_id))'
}
J1=$(submit_smoke "rel-smoke-1" "0.500" "1")
J2=$(submit_smoke "rel-smoke-2" "0.600" "2")
ok "submitted $J1 (m1=0.500) and $J2 (m1=0.600)"

wait_job() { # <idempotency-key> — echoes terminal status
  for _ in $(seq 1 120); do
    S=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).find(x=>x.idempotency_key==='$1');console.log(j?.status??'missing')})")
    case "$S" in succeeded|failed|cancelled) echo "$S"; return 0;; esac
    sleep 0.25
  done
  echo "timeout"
  return 1
}
B1=$(wait_job "rel-base-1"); B2=$(wait_job "rel-base-2")
if [[ "$B1" == "succeeded" && "$B2" == "succeeded" ]]; then
  ok "baseline jobs succeeded ($B1/$B2, matched seeds 1/2)"
else
  bad "baseline job statuses $B1/$B2"; tail -5 "$WORK/runner.log" >&2 || true
fi
S1=$(wait_job "rel-smoke-1"); S2=$(wait_job "rel-smoke-2")
if [[ "$S1" == "succeeded" && "$S2" == "succeeded" ]]; then
  ok "both smoke jobs succeeded ($S1/$S2)"
else
  bad "smoke job statuses $S1/$S2"; tail -5 "$WORK/runner.log" >&2 || true
fi
# Metrics artifacts must exist (runner extracted the JSON lines).
M1=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).find(x=>x.idempotency_key==='rel-smoke-1');console.log(j?.run_manifest?.metrics_artifact??'')})")
M2=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).find(x=>x.idempotency_key==='rel-smoke-2');console.log(j?.run_manifest?.metrics_artifact??'')})")
if [[ "$M1" == sha256:* && "$M2" == sha256:* ]]; then
  ok "metrics artifacts registered ($M1, $M2)"
else
  bad "metrics artifacts missing: '$M1'/'$M2'"
fi

say "analysis: POST /v1/projects/$PROJ/analysis (aggregate real runs)"
AN=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/analysis" -d '{"metric":"m1"}')
printf '%s' "$AN" > "$WORK/analysis.json"
if AN_JSON="$AN" node -e '
  const a = JSON.parse(process.env.AN_JSON)
  const tol = 1e-9
  const checks = {
    mean: Math.abs(a.mean - 0.55) < tol,
    n: a.n === 2,
    runs: Array.isArray(a.runs) && a.runs.length === 2,
    effect_size_field: "effect_size" in a,
    artifact: String(a.artifact_id).startsWith("sha256:"),
    chart: String(a.chart_artifact).startsWith("sha256:"),
  }
  const bad = Object.entries(checks).filter(([, v]) => !v)
  if (bad.length) { console.error("analysis assertion failed: " + JSON.stringify(bad)); process.exit(1) }
  console.log(JSON.stringify({ mean: a.mean, sd: a.sd, n: a.n, baseline_value: a.baseline_value, effect_size: a.effect_size }))'; then
  ok "analysis aggregated over real runs: mean=0.55, n=2, effect_size field present"
else
  bad "analysis assertions failed"; printf '%s' "$AN" | head -c 300; echo
fi

say "tex workspace + latex-compile job (real texlive container, §4 REL-01)"
DOC=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/manuscript-drafts" -d '{}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).document_id))")
if [[ "$DOC" == doc_* ]]; then
  ok "tex workspace document $DOC"
else
  bad "tex document id '$DOC'"
fi
cat > "$WORK/paper.tex" <<'TEX'
\documentclass{article}
\usepackage[margin=1in]{geometry}
\begin{document}
\section{Intro}
Release-bundle clean-room fixture \cite{knuth1984}.
\bibliographystyle{plain}
\bibliography{main}
\end{document}
TEX
cat > "$WORK/main.bib" <<'BIB'
@book{knuth1984,
  author = {Donald E. Knuth},
  title = {The {TeX}book},
  publisher = {Addison-Wesley},
  year = {1984}
}
BIB
V0=$(api "http://127.0.0.1:$PORT/v1/documents/$DOC/tree" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const t=JSON.parse(d);const f=t.files.find(x=>x.path==='paper.tex');console.log(f?f.version:'')})")
V1=$(api "http://127.0.0.1:$PORT/v1/documents/$DOC/tree" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const t=JSON.parse(d);const f=t.files.find(x=>x.path==='main.bib');console.log(f?f.version:'')})")
if [[ "$V0" =~ ^[0-9]+$ && "$V1" =~ ^[0-9]+$ ]]; then
  node -e "console.log(JSON.stringify({path:'paper.tex',content:require('fs').readFileSync('$WORK/paper.tex','utf8'),expected_version:Number('$V0')}))" > "$WORK/put-paper.json"
  api -X PUT "http://127.0.0.1:$PORT/v1/documents/$DOC/file" -d @"$WORK/put-paper.json" > /dev/null
  node -e "console.log(JSON.stringify({path:'main.bib',content:require('fs').readFileSync('$WORK/main.bib','utf8'),expected_version:Number('$V1')}))" > "$WORK/put-bib.json"
  api -X PUT "http://127.0.0.1:$PORT/v1/documents/$DOC/file" -d @"$WORK/put-bib.json" > /dev/null
  ok "paper.tex + main.bib written to the workspace (versions $V0/$V1)"
else
  bad "cannot read workspace file versions ('$V0'/'$V1')"
fi
REV=$(api "http://127.0.0.1:$PORT/v1/documents/$DOC/tree" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).document.revision))")
TXRESP=$(api -X POST "http://127.0.0.1:$PORT/v1/documents/$DOC/builds" -d "{\"expected_document_revision\":$REV,\"image_digest\":\"texlive/texlive@sha256:8957c916b8160049f89c24d362a6d86c09d8a04095acde37e88404c4afed85b4\"}")
TXBUILD=$(printf '%s' "$TXRESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).build.build_id))")
TXJOB=$(printf '%s' "$TXRESP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job.job_id))")
if [[ "$TXBUILD" == build_* && "$TXJOB" == job_* ]]; then
  ok "latex-compile queued (build $TXBUILD, job $TXJOB)"
else
  bad "latex-compile queue failed: '$TXRESP'"
fi
TSTATUS=""
TPDF=""
for _ in $(seq 1 120); do
  ROW=$(api "http://127.0.0.1:$PORT/v1/documents/$DOC/builds/$TXBUILD")
  TSTATUS=$(printf '%s' "$ROW" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  TPDF=$(printf '%s' "$ROW" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).pdf_artifact||''))")
  case "$TSTATUS" in succeeded|failed|cancelled) break;; esac
  sleep 0.5
done
if [[ "$TSTATUS" == "succeeded" && "$TPDF" == sha256:* ]]; then
  ok "latex-compile succeeded; pdf artifact $TPDF"
else
  bad "latex build status=$TSTATUS pdf=${TPDF:-none}"; tail -5 "$WORK/runner.log" >&2 || true
fi

say "corpus snapshot + evidence + claim (bundle manifest sections)"
SNAP=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/corpus" -d "{\"papers\":[{\"paper_id\":\"arxiv:9999.00001\",\"title\":\"Release Bundle Evaluation Fixture\",\"authors\":[\"Fixture Author\"],\"year\":2024,\"source\":\"arxiv\",\"identifiers\":{},\"abstract\":\"Fixture paper for the release-bundle eval.\",\"retrieved_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}]}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).snapshot_id))")
[[ "$SNAP" == corpus_snap_* ]] && ok "corpus snapshot $SNAP frozen" || bad "corpus snapshot id '$SNAP'"
AN_ART=$(printf '%s' "$AN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).artifact_id))")
EVID=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/evidence" -d "{\"source_type\":\"analysis\",\"run_ids\":[\"$J1\",\"$J2\"],\"artifact_refs\":[\"$AN_ART\"],\"analysis_method\":\"bootstrap-95-ci\",\"result\":{\"primary_metric\":\"m1\",\"value\":0.55,\"baseline_value\":null,\"effect_size\":null,\"n_seeds\":2}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).evidence_id))")
[[ "$EVID" == evidence_* ]] && ok "evidence $EVID ingested (binds analysis artifact)" || bad "evidence id '$EVID'"
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/claims" -d '{"statement":"smoke runs achieve m1=0.55 on the release-bundle fixture","scope":{"metric":"m1"}}' > /dev/null
ok "claim registered"

say "release-bundle endpoint (kernel JSON manifest)"
RB=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/release-bundle")
printf '%s' "$RB" > "$WORK/release-bundle.json"
BID=$(printf '%s' "$RB" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).bundle_id))")
AID=$(printf '%s' "$RB" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).artifact_id))")
if [[ "$BID" == bundle_* && "$AID" == sha256:* ]]; then
  ok "release bundle manifest: bundle_id=$BID artifact_id=$AID"
else
  bad "release-bundle response malformed: '$BID' / '$AID'"
fi

say "build-bundle.sh: assemble the REAL self-contained archive (§14.4)"
BUNDLE_DIR="$KEEP"
[ -z "$BUNDLE_DIR" ] && BUNDLE_DIR="$WORK/bundle"
if bash "$BUILD" "$PORT" "$PROJ" "$BUNDLE_DIR" "$WORK/release-bundle.json" > "$WORK/build.log" 2>&1; then
  ok "archive assembled at $BUNDLE_DIR"
else
  bad "build-bundle.sh failed"; tail -30 "$WORK/build.log" >&2; exit 1
fi
[ -f "$BUNDLE_DIR/manifest.json" ] && ok "manifest.json present" || bad "manifest.json missing"

say "verify: repo verifier + in-bundle verifier"
if bash "$VERIFY" "$BUNDLE_DIR" > "$WORK/verify1.log" 2>&1; then
  ok "verify-bundle.sh: all checks passed ($(grep -c '  ok:' "$WORK/verify1.log") ok)"
else
  bad "verify-bundle.sh failed"; cat "$WORK/verify1.log" >&2
fi
if bash "$BUNDLE_DIR/verify.sh" "$BUNDLE_DIR" > "$WORK/verify2.log" 2>&1; then
  ok "in-bundle verify.sh: all checks passed"
else
  bad "in-bundle verify.sh failed"; cat "$WORK/verify2.log" >&2
fi
# The manifest must not be a bare JSON list — it must carry the §14.4 shape.
if node -e "const m=require('$BUNDLE_DIR/manifest.json');process.exit(m.bundle_schema_version===2&&Array.isArray(m.artifacts)===false?0:1)"; then
  ok "manifest has bundle_schema_version=2 and artifacts map"
else
  bad "manifest shape wrong (bundle_schema_version / artifacts)"
fi

say "clean-room rerun: bundle-only reproduce.sh in a fresh kernel + fresh runner"
kill "$RUNNER_PID" "$KERNEL_PID" 2>/dev/null || true
sleep 0.5
RUNNER_PID=""
KERNEL_PID=""
if KERNEL_BIN="$KERNEL_BIN" RUNNER_BIN="$RUNNER_BIN" bash "$BUNDLE_DIR/reproduce.sh" --mode auto > "$WORK/reproduce.log" 2>&1; then
  ok "reproduce.sh clean-room rerun passed (see log tail below)"
else
  bad "reproduce.sh failed"; tail -30 "$WORK/reproduce.log" >&2 || true
fi
if [ -f "$BUNDLE_DIR/reproducibility-report.json" ]; then
  RPT=$(node -e "const r=require('$BUNDLE_DIR/reproducibility-report.json');console.log(r.status)")
  if [ "$RPT" = "pass" ]; then
    ok "reproducibility-report.json status=pass"
  else
    bad "reproducibility-report.json status=$RPT"; cat "$BUNDLE_DIR/reproducibility-report.json" >&2
  fi
else
  bad "reproducibility-report.json not generated by reproduce.sh"
fi

say "summary"
echo "release-bundle eval: $PASS passed, $FAIL failed"
if [ -n "$KEEP" ]; then
  echo "BUNDLE_DIR=$BUNDLE_DIR"
  echo "bundle tree:"; find "$BUNDLE_DIR" -type f | sed 's/^/  /' | sort
fi
[ "$FAIL" -eq 0 ] || exit 1
