#!/usr/bin/env bash
# §19.2 P0 blocking tests: cross-project isolation (v2 E7/E8 — project-scoped
# idempotency and artifact records).
#
#   cross-project-idempotency-isolated
#       Two projects submit the SAME idempotency_key -> each project must get
#       its own independent job. A project must never receive another
#       project's job record.
#   cross-project-shared-blob-artifacts-isolated
#       Project A registers a blob; project B registers the SAME content ->
#       B must get its own artifact record bound to B (project-scoped
#       artifact identity), and B's artifact list must contain it.
#
# NOTE on current kernel: idempotency dedup is GLOBAL (jobs.idempotency_key
# has no project scope) and artifact dedup is content-addressed GLOBAL
# (artifacts.artifact_id == sha256:<hash>). Both invariants are expected to
# FAIL here; the script records the actual behavior instead of modifying the
# kernel.
#
# Usage: bash tests/security/run-isolation-tests.sh
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

# Print a field path (".project_id", "[0].job_id", ".length") from stdin JSON.
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

PROJ_A=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"iso-a\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
PROJ_B=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"iso-b\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
[[ -n "$PROJ_A" && -n "$PROJ_B" ]] || { echo "failed to create projects"; exit 1; }

# ── Test 1: cross-project-idempotency-isolated ─────────────────────────────
say "Test 1: cross-project-idempotency-isolated"
# control: distinct keys -> distinct jobs owned by each project
JOB_A=$(api -X POST "$BASE/v1/projects/$PROJ_A/jobs" -d '{"idempotency_key":"iso-ctrl-a","kind":"echo","payload":{"message":"a"}}' | jfield '.job_id')
JOB_B=$(api -X POST "$BASE/v1/projects/$PROJ_B/jobs" -d '{"idempotency_key":"iso-ctrl-b","kind":"echo","payload":{"message":"b"}}' | jfield '.job_id')
PA=$(api "$BASE/v1/jobs/$JOB_A" | jfield '.project_id')
PB=$(api "$BASE/v1/jobs/$JOB_B" | jfield '.project_id')
if [[ -n "$JOB_A" && -n "$JOB_B" && "$JOB_A" != "$JOB_B" && "$PA" == "$PROJ_A" && "$PB" == "$PROJ_B" ]]; then
  ok "control: distinct keys -> job $JOB_A in A, job $JOB_B in B"
else
  bad "control setup broken: jobs $JOB_A/$JOB_B owners $PA/$PB"
fi

# invariant: B submits A's key -> must yield a NEW job owned by B
JOB_B_SAME=$(api -X POST "$BASE/v1/projects/$PROJ_B/jobs" -d '{"idempotency_key":"iso-ctrl-a","kind":"echo","payload":{"message":"b-same-key"}}' | jfield '.job_id')
P_B_SAME=$(api "$BASE/v1/jobs/$JOB_B_SAME" | jfield '.project_id')
NB_A=$(api "$BASE/v1/projects/$PROJ_A/jobs" | jfield '.length')
NB_B=$(api "$BASE/v1/projects/$PROJ_B/jobs" | jfield '.length')
SA=$(api "$BASE/v1/jobs/$JOB_A" | jfield '.status')
if [[ "$JOB_B_SAME" != "$JOB_A" && "$P_B_SAME" == "$PROJ_B" ]]; then
  ok "cross-project same key -> independent job (B got $JOB_B_SAME, A keeps $JOB_A)"
else
  bad "cross-project idempotency NOT isolated: B's submit with A's key returned job '$JOB_B_SAME' (project '$P_B_SAME') — kernel dedups by global idempotency_key; B's own job is invisible in B's job list (A has $NB_A job(s), B has $NB_B job(s))"
fi
[[ "$SA" == "queued" ]] && ok "A's original job untouched by B's resubmit (status=$SA)" || bad "A's job state changed: $SA"

# ── Test 2: cross-project-shared-blob-artifacts-isolated ───────────────────
say "Test 2: cross-project-shared-blob-artifacts-isolated"
BLOB_B64=$(printf 'isolation-blob-v0.2' | base64 -w0)
ART_A=$(api -X POST "$BASE/v1/artifacts" -d "{\"project_id\":\"$PROJ_A\",\"kind\":\"data\",\"content_base64\":\"$BLOB_B64\",\"metadata\":{\"owner\":\"A\"}}" | jfield '.artifact_id')
OWN_A=$(api "$BASE/v1/projects/$PROJ_A/artifacts" | jfield '[0].project_id')
[[ "$OWN_A" == "$PROJ_A" ]] && ok "A registered blob -> artifact $ART_A owned by A" || bad "A's artifact record not owned by A: $OWN_A"

ART_B=$(api -X POST "$BASE/v1/artifacts" -d "{\"project_id\":\"$PROJ_B\",\"kind\":\"data\",\"content_base64\":\"$BLOB_B64\",\"metadata\":{\"owner\":\"B\"}}" | jfield '.artifact_id')
OWN_B=$(api "$BASE/v1/projects/$PROJ_B/artifacts" | jfield '[0].project_id')
COUNT_B=$(api "$BASE/v1/projects/$PROJ_B/artifacts" | jfield '.length')
# v2 §7.4: blob is global (same artifact_id = sha256) but each project owns
# its own RECORD — isolation is proven by B's list containing a record owned
# by B, and by project-scoped lookup resolving B's record.
if [[ "$ART_B" == "$ART_A" && "$OWN_B" == "$PROJ_B" && "$COUNT_B" -ge 1 ]]; then
  ok "same blob in B -> same artifact_id (shared blob) with B-owned record (owner=$OWN_B)"
else
  bad "shared blob isolation broken: ART_B=$ART_B OWN_B=$OWN_B COUNT_B=$COUNT_B (expected same id, B-owned record)"
fi

# control: different content in B -> B's own record
BLOB2_B64=$(printf 'isolation-blob-v0.2-b-different' | base64 -w0)
ART_B2=$(api -X POST "$BASE/v1/artifacts" -d "{\"project_id\":\"$PROJ_B\",\"kind\":\"data\",\"content_base64\":\"$BLOB2_B64\"}" | jfield '.artifact_id')
OWN_B2=$(api "$BASE/v1/projects/$PROJ_B/artifacts" | jfield '[0].project_id')
if [[ -n "$ART_B2" && "$ART_B2" != "$ART_A" && "$OWN_B2" == "$PROJ_B" ]]; then
  ok "control: different content in B -> own record $ART_B2"
else
  bad "control broken: B2=$ART_B2 owner=$OWN_B2"
fi

say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
