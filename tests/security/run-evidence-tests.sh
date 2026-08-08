#!/usr/bin/env bash
# §19.2 P0 blocking test: evidence-missing-effect-is-inconclusive.
#
# A claim verified against evidence that carries NO effect_size / CI (only
# primary_metric + value) must NEVER become "supported" — the deterministic
# rule (§4.7 / §11.3) requires an effect estimate with CI to support a claim;
# otherwise the result must be "inconclusive".
#
# Current kernel behavior: verifyClaim() initializes status='supported' and
# only downgrades when an effect_size is present but weak/negative — evidence
# WITHOUT effect_size leaves the claim "supported". This invariant is expected
# to FAIL here; the script records the actual behavior instead of modifying
# the kernel.
#
# Usage: bash tests/security/run-evidence-tests.sh
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

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}'

start_kernel || { echo "kernel failed to start"; exit 1; }
BASE="http://127.0.0.1:$PORT"
PROJ=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"evidence\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
[[ -n "$PROJ" ]] || { echo "failed to create project"; exit 1; }

say "Test: evidence-missing-effect-is-inconclusive"
# Evidence WITHOUT effect_size/CI (only primary_metric + value).
E1=$(api -X POST "$BASE/v1/projects/$PROJ/evidence" -d '{"source_type":"analysis","run_ids":[],"artifact_refs":[],"analysis_method":"descriptive-summary","result":{"primary_metric":"accuracy","value":0.91}}' | jfield '.evidence_id')
[[ -n "$E1" ]] || { echo "failed to ingest evidence"; exit 1; }
C1=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d '{"statement":"The treatment improves accuracy","scope":{"dataset":"d1","split":"test"}}' | jfield '.claim_id')
S1=$(api -X POST "$BASE/v1/claims/verify" -d "{\"claim_id\":\"$C1\",\"evidence_ids\":[\"$E1\"]}" | jfield '.status')
if [[ "$S1" == "inconclusive" ]]; then
  ok "claim verified against effect-free evidence -> inconclusive"
else
  bad "claim verified against effect-free evidence became '$S1' (expected inconclusive) — §19.2 invariant violated: verifyClaim() defaults to supported when no effect_size is present"
fi

say "Test (control): evidence WITH effect_size + CI can be supported"
E2=$(api -X POST "$BASE/v1/projects/$PROJ/evidence" -d '{"source_type":"analysis","run_ids":[],"artifact_refs":[],"analysis_method":"bootstrap-95","result":{"primary_metric":"accuracy","value":0.91,"baseline_value":0.86,"effect_size":0.05,"ci_low":0.01,"ci_high":0.09,"p_value":0.01,"n_seeds":5}}' | jfield '.evidence_id')
C2=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d '{"statement":"The treatment improves accuracy (effect with CI)","scope":{"dataset":"d1","split":"test"}}' | jfield '.claim_id')
S2=$(api -X POST "$BASE/v1/claims/verify" -d "{\"claim_id\":\"$C2\",\"evidence_ids\":[\"$E2\"]}" | jfield '.status')
if [[ "$S2" == "supported" ]]; then
  ok "control: evidence with effect_size>0 and CI>0 -> supported (API wiring correct)"
else
  bad "control broken: expected supported, got '$S2'"
fi

say "Test (control): negative effect with CI -> contradicted (direction rule exists)"
E3=$(api -X POST "$BASE/v1/projects/$PROJ/evidence" -d '{"source_type":"analysis","run_ids":[],"artifact_refs":[],"analysis_method":"bootstrap-95","result":{"primary_metric":"accuracy","value":0.80,"baseline_value":0.86,"effect_size":-0.06,"ci_low":-0.10,"ci_high":-0.02,"n_seeds":5}}' | jfield '.evidence_id')
C3=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d '{"statement":"The treatment hurts accuracy","scope":{"dataset":"d1","split":"test"}}' | jfield '.claim_id')
S3=$(api -X POST "$BASE/v1/claims/verify" -d "{\"claim_id\":\"$C3\",\"evidence_ids\":[\"$E3\"]}" | jfield '.status')
if [[ "$S3" == "contradicted" ]]; then
  ok "control: negative effect_size with CI excluding zero -> contradicted"
else
  bad "control broken: expected contradicted, got '$S3'"
fi

say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
