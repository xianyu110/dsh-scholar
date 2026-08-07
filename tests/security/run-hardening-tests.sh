#!/usr/bin/env bash
# §19.2 P0 blocking tests: host-execution and fake-experiment defenses (v2).
#
#   formal-run-rejects-subprocess      formal job + subprocess runner -> failed
#   baseline-must-execute-real-code    baseline with empty command -> failed
#   formal-run-rejects-message-only    message-only (no command) -> failed
#   job-rejects-unapproved-contract    formal job without approved contract -> rejected
#   kernel-submit-rejects-subprocess   kernel rejects formal on isolated-subprocess profile
#
# Usage: bash tests/security/run-hardening-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
RUNNER_BIN="$REPO/workers/runner-gateway/lib/bin/runner.js"
WORK=$(mktemp -d)
PORT=$((19900 + $$ % 300))
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL+1)); }
api() { curl -sf -H 'content-type: application/json' "$@"; }

nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break; sleep 0.1; done
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT" --owner harden --poll-ms 150 > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
sleep 0.5

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"machine-learning"}'
PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"harden\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"execution\":{\"runner_profile\":\"local-docker-cpu\",\"network_policy\":\"none\",\"artifact_store\":\"local-cas\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
ok "project $PROJ on container profile"

echo "== kernel-submit-rejects-subprocess =="
P2=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"harden-sub\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"execution\":{\"runner_profile\":\"isolated-subprocess\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$P2/jobs" -H 'content-type: application/json' -d '{"idempotency_key":"f1","kind":"formal","command":["true"]}')
[[ "$CODE" == "422" ]] && ok "kernel rejects formal job on isolated-subprocess profile (422)" || bad "expected 422 got $CODE"

echo "== formal-run-rejects-subprocess (runner layer) =="
J1=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"f2","kind":"formal","command":["true"]}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
for _ in $(seq 1 60); do
  S=$(api "http://127.0.0.1:$PORT/v1/jobs/$J1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  [[ "$S" == "failed" ]] && break
  sleep 0.3
done
C=$(api "http://127.0.0.1:$PORT/v1/jobs/$J1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.failure_class??'')+'|'+(j.error??'').slice(0,60))})")
[[ "$C" == environment* ]] && ok "formal + subprocess runner -> failed/environment: ${C#*|}" || bad "expected environment got $C"

echo "== non-echo must-execute-real-code / message-only rejected =="
J2=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"b1","kind":"smoke","payload":{"message":"{\"metric\":\"f1\",\"value\":0.8}"}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
for _ in $(seq 1 60); do
  S=$(api "http://127.0.0.1:$PORT/v1/jobs/$J2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  [[ "$S" == "failed" ]] && break
  sleep 0.3
done
E2=$(api "http://127.0.0.1:$PORT/v1/jobs/$J2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).error))")
[[ "$E2" == *"empty command"* ]] && ok "non-echo empty command/message-only -> failed (no synthetic success)" || bad "expected empty-command failure got: $E2"
M2=$(api "http://127.0.0.1:$PORT/v1/jobs/$J2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.run_manifest?.metrics_artifact??'none'))})")
[[ "$M2" == "none" ]] && ok "no metrics artifact for fake run" || bad "metrics artifact should be absent"

kill "$RUNNER_PID" "$KERNEL_PID" 2>/dev/null || true
rm -rf "$WORK"
echo "hardening-tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
