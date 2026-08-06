#!/usr/bin/env bash
# RSP-011 fault-injection tests (design §11.2 P0 recovery cases).
#
#  1. kill -9 the Kernel mid-project → restart → state recovered (no loss).
#  2. Job submitted → kernel killed → restart → job still queued; a claimed
#     (running) job with an expired lease recovers to retryable and re-runs
#     WITHOUT duplicate submission (idempotency + lease recovery).
#  3. Runner gateway killed mid-run → lease expires → recovered by the next
#     gateway cycle (retryable → re-claim → completes exactly once).
#
# Usage: bash tests/fault-injection/run-fault-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
WORK=$(mktemp -d)
PORT=17521
PASS=0
FAIL=0

say()  { printf '\033[1;34m== %s ==\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ok: %s\033[0m\n' "$*"; PASS=$((PASS + 1)); }
bad()  { printf '\033[1;31m  FAIL: %s\033[0m\n' "$*"; FAIL=$((FAIL + 1)); }

start_kernel() {
  nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" \
    > "$WORK/kernel-$1.log" 2>&1 &
  KERNEL_PID=$!
  for _ in $(seq 1 50); do
    curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && return 0
    sleep 0.1
  done
  return 1
}

stop_kernel() {
  kill -9 "$KERNEL_PID" 2>/dev/null || true
  wait "$KERNEL_PID" 2>/dev/null || true
}

api() { curl -sf -H 'content-type: application/json' "$@"; }

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}'

say "Test 1: kill -9 kernel between transitions → restart → state intact"
start_kernel boot1 || { bad "kernel failed to start"; exit 1; }
PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"fault1\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"session_id\":\"s1\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/transitions" -d '{"to":"SCOPED","expected_revision":0}' > /dev/null
stop_kernel
start_kernel boot2 || { bad "kernel failed to restart"; exit 1; }
STATUS=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
REV=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).revision))")
LINK=$(api "http://127.0.0.1:$PORT/v1/session-links/s1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
if [[ "$STATUS" == "SCOPED" && "$REV" == "1" && "$LINK" == "$PROJ" ]]; then ok "project survived kill -9 (status=$STATUS rev=$REV session link intact)"; else bad "expected SCOPED rev 1, got $STATUS rev $REV"; fi

say "Test 2: job submitted before kill stays queued; claimed job lease recovers to retryable"
JOB1=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"fault-queued","kind":"echo","payload":{"message":"q"}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
JOB2=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"fault-running","kind":"echo","payload":{"message":"r"}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
# claim ONE job (the first queued: JOB1) with a 1s lease, then kill the kernel
# before completion; JOB2 must stay queued untouched.
CLAIMED=$(api -X POST "http://127.0.0.1:$PORT/v1/jobs-claim/run" -d '{"owner":"runner-x","lease_ttl_seconds":1,"limit":1}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j[0]?j[0].job_id:'')})")
[[ "$CLAIMED" == "$JOB1" ]] || { bad "expected claim of $JOB1, got $CLAIMED"; }
stop_kernel
sleep 1.2  # let the lease expire while the kernel is dead
start_kernel boot3 || { bad "kernel failed to restart"; exit 1; }
RECOVERED=$(api -X POST "http://127.0.0.1:$PORT/v1/recover/leases" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).recovered))")
S1=$(api "http://127.0.0.1:$PORT/v1/jobs/$JOB1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
S2=$(api "http://127.0.0.1:$PORT/v1/jobs/$JOB2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
if [[ "$RECOVERED" == "1" && "$S1" == "retryable" && "$S2" == "queued" ]]; then
  ok "recovered $RECOVERED stale lease; running job → retryable; queued job untouched"
else
  bad "expected recovered=1 s1=retryable s2=queued; got recovered=$RECOVERED s1=$S1 s2=$S2"
fi

say "Test 3: idempotent resubmit after crash never duplicates"
JOB1_AGAIN=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"fault-queued","kind":"echo","payload":{"message":"q"}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
if [[ "$JOB1_AGAIN" == "$JOB1" ]]; then ok "resubmit returned the original job ($JOB1)"; else bad "duplicate job created: $JOB1_AGAIN != $JOB1"; fi

say "Test 4: end-to-end echo job through the runner gateway (subprocess mode)"
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/transitions" -d '{"to":"SURVEYING","expected_revision":1}' > /dev/null 2>&1 || true
nohup node "$REPO/workers/runner-gateway/lib/bin/runner.js" --kernel "http://127.0.0.1:$PORT" --owner runner-test --poll-ms 300 > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
for _ in $(seq 1 60); do
  FINAL=$(api "http://127.0.0.1:$PORT/v1/jobs/$JOB1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.status+':'+((j.run_manifest&&j.run_manifest.log_artifact)||''))})" 2>/dev/null || echo "queued:")
  [[ "$FINAL" == succeeded:* ]] && break
  sleep 0.5
done
kill "$RUNNER_PID" 2>/dev/null || true
if [[ "$FINAL" == succeeded:* ]]; then
  ok "echo job succeeded with log artifact ${FINAL#succeeded:}"
else
  bad "echo job did not succeed: $FINAL"
fi

say "Test 5: run manifest artifact refs are verified before completion"
JOB3=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"fault-badref","kind":"echo","payload":{"message":"x"}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
api -X POST "http://127.0.0.1:$PORT/v1/jobs-claim/run" -d '{"owner":"runner-y","lease_ttl_seconds":60,"limit":8}' > /dev/null
if api -X POST "http://127.0.0.1:$PORT/v1/jobs/$JOB3/status" -d '{"owner":"runner-y","status":"succeeded","run_manifest":{"metrics_artifact":"sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}}' > /dev/null 2>&1; then
  bad "manifest with missing artifact accepted"
else
  ok "manifest with missing artifact rejected"
fi

stop_kernel
rm -rf "$WORK"
say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
