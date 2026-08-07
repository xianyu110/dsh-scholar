#!/usr/bin/env bash
# §19.2 P0 blocking test: manifest-missing-artifact-rejected.
#
# A run manifest that references artifacts which do not exist in the CAS must
# be rejected at job completion (HTTP 422, error code manifest_refs_missing);
# the job must stay running and never be marked succeeded with a dangling
# manifest.
#
# Current kernel: completeJob() -> verifyArtifactRefs() enforces this.
#
# Usage: bash tests/security/run-manifest-tests.sh
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
MISSING_SHA="sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

start_kernel || { echo "kernel failed to start"; exit 1; }
BASE="http://127.0.0.1:$PORT"
PROJ=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"manifest\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
[[ -n "$PROJ" ]] || { echo "failed to create project"; exit 1; }

say "Test: manifest-missing-artifact-rejected"
J1=$(api -X POST "$BASE/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"mfa-1","kind":"echo","payload":{"message":"x"}}' | jfield '.job_id')
CLAIMED=$(api -X POST "$BASE/v1/jobs-claim/run" -d '{"owner":"runner-mfa","lease_ttl_seconds":60,"limit":8}' | jfield '[0].job_id')
[[ "$CLAIMED" == "$J1" ]] || { echo "claim setup broken: expected $J1 got $CLAIMED"; exit 1; }

CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J1/status" -H 'content-type: application/json' -d "{\"owner\":\"runner-mfa\",\"status\":\"succeeded\",\"run_manifest\":{\"metrics_artifact\":\"$MISSING_SHA\"}}")
ERR_CODE=$(jfield '.error.code' < "$WORK/resp.json")
S1=$(api "$BASE/v1/jobs/$J1" | jfield '.status')
if [[ "$CODE" == "422" && "$ERR_CODE" == "manifest_refs_missing" ]]; then
  ok "completion with missing artifact ref -> 422 ($ERR_CODE); job still '$S1'"
else
  bad "expected 422 manifest_refs_missing, got HTTP $CODE (error=$ERR_CODE), job status '$S1'"
fi

say "Test (control): manifest referencing a REAL artifact is accepted"
META_B64=$(printf '{"metrics":[{"metric":"m","value":0.5,"seed":1}]}' | base64 -w0)
ART=$(api -X POST "$BASE/v1/artifacts" -d "{\"project_id\":\"$PROJ\",\"kind\":\"data\",\"content_base64\":\"$META_B64\"}" | jfield '.artifact_id')
J2=$(api -X POST "$BASE/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"mfa-2","kind":"echo","payload":{"message":"y"}}' | jfield '.job_id')
CLAIMED2=$(api -X POST "$BASE/v1/jobs-claim/run" -d '{"owner":"runner-mfa","lease_ttl_seconds":60,"limit":8}' | jfield '[0].job_id')
[[ "$CLAIMED2" == "$J2" ]] || { echo "claim setup broken: expected $J2 got $CLAIMED2"; exit 1; }
CODE2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/jobs/$J2/status" -H 'content-type: application/json' -d "{\"owner\":\"runner-mfa\",\"status\":\"succeeded\",\"run_manifest\":{\"metrics_artifact\":\"$ART\"}}")
S2=$(api "$BASE/v1/jobs/$J2" | jfield '.status')
if [[ "$CODE2" == "200" && "$S2" == "succeeded" ]]; then
  ok "control: manifest with real artifact -> HTTP 200, job succeeded"
else
  bad "control broken: HTTP $CODE2 status $S2"
fi

say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
