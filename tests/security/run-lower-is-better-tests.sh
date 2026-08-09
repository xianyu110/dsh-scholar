#!/usr/bin/env bash
# §19.2 P0 blocking test: lower-is-better-claim-direction.
#
# v2 rule (§4.7 / §11.3 / §12): the metric direction (higher_is_better vs
# lower_is_better) comes from the contract's MetricSpec
# (metrics.direction). When a metric is declared lower-is-better, an
# improvement is a NEGATIVE effect_size, and such evidence must SUPPORT a
# claim (the sign interpretation is inverted vs higher-is-better).
#
# Test path (real API, no mocks):
#   1. register an approved contract with metrics.direction=lower_is_better
#   2. ingest WORKER-VERIFIED evidence (POST /evidence/verified with
#      x-service-principal: analysis-worker) with effect_size < 0 and CI < 0
#      (the improvement direction)
#   3. accept the evidence (POST /evidence/{id}/accept with
#      x-service-principal: verifier + request_id) — §6: only accepted
#      evidence may support a claim
#   4. verify the claim -> must be 'supported'
#   5. control: evidence with default higher_is_better + negative effect
#      -> 'contradicted' (sign interpretation preserved for the default)
#
# Usage: bash tests/security/run-lower-is-better-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
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

say "Test: lower-is-better-claim-direction"
# Contract declares the primary metric lower-is-better (MetricSpec direction).
CT=$(api -X POST "$BASE/v1/projects/$PROJ/contracts" -d '{"idea_id":"idea_lib","data":{"dataset_id":"d1"},"methods":{"baseline":"b","treatment":"a"},"metrics":{"primary":"loss","secondary":[],"direction":"lower_is_better"},"seeds":[1,2,3,4,5]}' | jfield '.contract_id')
api -X POST "$BASE/v1/projects/$PROJ/contracts/$CT/approve" -d '{"actor":"lib-eval"}' > /dev/null
ok "contract $CT registered + frozen with direction=lower_is_better"

# §6: accept revalidates Analysis Artifacts -> register a REAL kind=analysis
# artifact and reference it from every accepted evidence row.
ART=$(api -X POST "$BASE/v1/artifacts" -d "{\"project_id\":\"$PROJ\",\"kind\":\"analysis\",\"content_base64\":\"$(printf '{"loss":0.71}' | base64 -w0)\",\"metadata\":{\"metric\":\"loss\"}}" | jfield '.artifact_id')
[[ "$ART" == sha256:* ]] || { bad "analysis artifact registration: '$ART'"; exit 1; }
ok "analysis artifact $ART registered (accept revalidation target)"

# Evidence: loss dropped from 0.83 to 0.71 -> effect_size NEGATIVE, CI < 0
# (an improvement under lower-is-better semantics). Ingested via the
# Analysis-Worker internal path (x-service-principal: analysis-worker) and
# then ACCEPTED by the verifier (§6: only accepted evidence supports claims).
E1=$(api -X POST "$BASE/v1/projects/$PROJ/evidence/verified" -H 'x-service-principal: analysis-worker' -d '{"source_type":"analysis","run_ids":[],"artifact_refs":["'"$ART"'"],"analysis_method":"bootstrap-95","result":{"primary_metric":"loss","value":0.71,"baseline_value":0.83,"effect_size":-0.12,"ci_low":-0.20,"ci_high":-0.04,"n_seeds":5,"direction":"lower_is_better"}}' | jfield '.evidence_id')
[[ "$E1" == evidence_* ]] || { bad "verified evidence id '$E1'"; exit 1; }
A1=$(api -X POST "$BASE/v1/projects/$PROJ/evidence/$E1/accept" -H 'x-service-principal: verifier' -d '{"request_id":"req-lib-1"}' | jfield '.provenance_status')
[[ "$A1" == "accepted" ]] || { bad "evidence $E1 accept failed (provenance='$A1')"; exit 1; }
ok "evidence $E1 verified -> accepted (provenance=$A1)"
C1=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d '{"statement":"The treatment reduces loss (lower is better)","scope":{"dataset":"d1","split":"test"}}' | jfield '.claim_id')
S1=$(api -X POST "$BASE/v1/claims/verify" -d "{\"claim_id\":\"$C1\",\"evidence_ids\":[\"$E1\"]}" | jfield '.status')
if [[ "$S1" == "supported" ]]; then
  ok "lower-is-better improvement (effect_size=-0.12, CI<0) -> supported"
else
  bad "lower-is-better improvement became '$S1' (expected supported)"
fi

say "Test (control): higher_is_better default with negative effect -> contradicted"
E2=$(api -X POST "$BASE/v1/projects/$PROJ/evidence/verified" -H 'x-service-principal: analysis-worker' -d '{"source_type":"analysis","run_ids":[],"artifact_refs":["'"$ART"'"],"analysis_method":"bootstrap-95","result":{"primary_metric":"loss","value":0.71,"baseline_value":0.83,"effect_size":-0.12,"ci_low":-0.20,"ci_high":-0.04,"n_seeds":5}}' | jfield '.evidence_id')
[[ "$E2" == evidence_* ]] || { bad "verified evidence id '$E2'"; exit 1; }
A2=$(api -X POST "$BASE/v1/projects/$PROJ/evidence/$E2/accept" -H 'x-service-principal: verifier' -d '{"request_id":"req-lib-2"}' | jfield '.provenance_status')
[[ "$A2" == "accepted" ]] || { bad "evidence $E2 accept failed (provenance='$A2')"; exit 1; }
C2=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d '{"statement":"Treatment effect (default higher-is-better direction)","scope":{"dataset":"d1","split":"test"}}' | jfield '.claim_id')
S2=$(api -X POST "$BASE/v1/claims/verify" -d "{\"claim_id\":\"$C2\",\"evidence_ids\":[\"$E2\"]}" | jfield '.status')
if [[ "$S2" == "contradicted" ]]; then
  ok "higher-is-better default + negative effect -> contradicted"
else
  bad "higher-is-better control became '$S2' (expected contradicted)"
fi

say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
