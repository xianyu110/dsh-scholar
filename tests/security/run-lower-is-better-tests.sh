#!/usr/bin/env bash
# §19.2 P0 blocking test: lower-is-better-claim-direction — SKELETON.
#
# v2 rule (§4.7 / §11.3): the metric direction (higher-is-better vs
# lower-is-better) comes from a MetricSpec on the contract/analysis plan.
# When a metric is declared lower-is-better, an improvement is a NEGATIVE
# effect_size, and such evidence must be able to SUPPORT a claim.
#
# Current kernel: there is NO MetricSpec / metric-direction support anywhere
# in research-schemas or the kernel (grep MetricSpec/direction -> empty), and
# verifyClaim() hardcodes the higher-is-better rule (negative effect_size ->
# contradicted). The direction-aware rule cannot even be expressed through
# the current API.
#
# SKIP by default — enable with:  RUN_LOWER_IS_BETTER=1 bash tests/security/run-lower-is-better-tests.sh
# Once kernel v2 implements MetricSpec, flip the default to run.
#
# Usage: bash tests/security/run-lower-is-better-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)

if [[ "${RUN_LOWER_IS_BETTER:-0}" != "1" ]]; then
  echo "SKIP lower-is-better-claim-direction: kernel v2 MetricSpec not implemented"
  echo "  (assertion recorded for later: lower-is-better metric + negative effect_size must be 'supported')"
  echo "  (enable with RUN_LOWER_IS_BETTER=1 — expects FAIL on the current kernel)"
  exit 0
fi

KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
WORK=$(mktemp -d)
PORT=""
KERNEL_PID=""
PASS=0
FAIL=0

say() { printf '\033[1;34m== %s ==\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m  ok: %s\033[0m\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '\033[1;31m  FAIL: %s\033[0m\n' "$*"; FAIL=$((FAIL + 1)); }
api() { curl -sf -H 'content-type: application/json' "$@"; }

jfield() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const v=JSON.parse(d);console.log(v$1 ?? '')}catch(e){console.log('')}})" ; }

cleanup() {
  [[ -n "$KERNEL_PID" ]] && kill -9 "$KERNEL_PID" 2>/dev/null || true
  wait "$KERNEL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

start_kernel() {
  local port
  for port in $((20000 + $$ % 400)) $((20500 + $$ % 400)) $((21000 + $$ % 400)); do
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

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["loss"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}'

start_kernel || { echo "kernel failed to start"; exit 1; }
BASE="http://127.0.0.1:$PORT"
PROJ=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"lower-better\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
[[ -n "$PROJ" ]] || { echo "failed to create project"; exit 1; }

say "Test: lower-is-better-claim-direction (RUN_LOWER_IS_BETTER=1)"
say "  NOTE: kernel v2 MetricSpec absent — direction cannot be declared via any current API;"
say "  contract/brief carry no metric_direction field. This run asserts the v2 rule anyway."

# Evidence: loss dropped from 0.83 to 0.71 -> effect_size NEGATIVE, CI < 0
# (an improvement under lower-is-better semantics).
E1=$(api -X POST "$BASE/v1/projects/$PROJ/evidence" -d '{"source_type":"analysis","run_ids":[],"artifact_refs":[],"analysis_method":"bootstrap-95","result":{"primary_metric":"loss","value":0.71,"baseline_value":0.83,"effect_size":-0.12,"ci_low":-0.20,"ci_high":-0.04,"n_seeds":5}}' | jfield '.evidence_id')
C1=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d '{"statement":"The treatment reduces loss (lower is better)","scope":{"dataset":"d1","split":"test"}}' | jfield '.claim_id')
S1=$(api -X POST "$BASE/v1/claims/verify" -d "{\"claim_id\":\"$C1\",\"evidence_ids\":[\"$E1\"]}" | jfield '.status')
if [[ "$S1" == "supported" ]]; then
  ok "lower-is-better improvement (effect_size=-0.12, CI<0) -> supported"
else
  bad "lower-is-better improvement became '$S1' (expected supported once MetricSpec lands; current kernel hardcodes higher-is-better and marks negative effects contradicted) — 待 kernel v2 实现后启用"
fi

say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
