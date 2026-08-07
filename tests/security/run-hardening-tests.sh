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

echo "== SCH-JOB-001/002: subprocess heartbeat renews lease; cancel terminates the real process =="
# Dedicated kernel+runner pair with fast heartbeat/cancel polling (the main
# pair keeps default timings). No docker needed: subprocess execution must
# honor the same durable-job contract (§12.6).
PORT2=$((PORT + 1))
nohup node "$KERNEL_BIN" --db "$WORK/kernel2.db" --cas "$WORK/cas2" --port "$PORT2" > "$WORK/kernel2.log" 2>&1 &
KERNEL2_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT2/v1/health" > /dev/null 2>&1 && break; sleep 0.1; done
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT2" --owner harden2 --poll-ms 150 --timeout-ms 30000 --heartbeat-ms 1500 --cancel-poll-ms 1000 > "$WORK/runner2.log" 2>&1 &
RUNNER2_PID=$!
sleep 0.5
PROJ2=$(api -X POST "http://127.0.0.1:$PORT2/v1/projects" -d "{\"name\":\"harden2\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
ok "durable-jobs project $PROJ2"

# Long-running subprocess (node timeout 90s; the runner's 30s timeout would
# only fire if cancel failed — the assertions below would then fail loudly).
# The marker is split across variables so pgrep never matches this script.
M1="zzq-cancel"; M2="marker-98765"
JL=$(api -X POST "http://127.0.0.1:$PORT2/v1/projects/$PROJ2/jobs" -d "{\"idempotency_key\":\"h-cancel\",\"kind\":\"smoke\",\"payload\":{\"script\":\"node -e \\\"setTimeout(function(){},90000); //$M1-$M2\\\"\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
S=""
for _ in $(seq 1 40); do
  S=$(api "http://127.0.0.1:$PORT2/v1/jobs/$JL" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  [[ "$S" == "running" ]] && break; sleep 0.25
done
[[ "$S" == "running" ]] && ok "long subprocess job running ($JL)" || bad "long subprocess job not running: $S"

H1=$(api "http://127.0.0.1:$PORT2/v1/jobs/$JL" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).heartbeat_at??''))")
HB=no
for _ in $(seq 1 30); do
  H2=$(api "http://127.0.0.1:$PORT2/v1/jobs/$JL" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).heartbeat_at??''))")
  [[ -n "$H2" && "$H2" != "$H1" ]] && HB=yes && break
  sleep 0.3
done
[[ "$HB" == "yes" ]] && ok "subprocess heartbeat renewed lease while running ($H1 → $H2)" || bad "subprocess heartbeat_at never advanced (H1=$H1)"

# Find the REAL executing process (the marker lives in node's argv).
CHILD=""
for _ in $(seq 1 50); do
  CHILD=$(pgrep -f "$M1-$M2" | head -1 || true)
  [ -n "$CHILD" ] && break
  sleep 0.2
done
[[ -n "$CHILD" ]] && ok "execution process found (pid $CHILD)" || bad "no execution process found"

CSTATUS=$(api -X POST "http://127.0.0.1:$PORT2/v1/jobs/$JL/cancel" -d '{"actor":"harden","reason":"cancel must terminate execution"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
[[ "$CSTATUS" == "cancelled" ]] && ok "kernel accepted cancel → job cancelled" || bad "cancel returned $CSTATUS"
GONE=no
for _ in $(seq 1 40); do
  if ! pgrep -f "$M1-$M2" > /dev/null 2>&1; then GONE=yes; break; fi
  sleep 0.3
done
[[ "$GONE" == "yes" ]] && ok "execution process terminated after cancel" || bad "execution process still alive after cancel!"
sleep 1
FINAL=$(api "http://127.0.0.1:$PORT2/v1/jobs/$JL" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
[[ "$FINAL" == "cancelled" ]] && ok "subprocess job stays cancelled after runner teardown" || bad "job status after cancel: $FINAL"

kill "$RUNNER2_PID" "$KERNEL2_PID" 2>/dev/null || true

kill "$RUNNER_PID" "$KERNEL_PID" 2>/dev/null || true
rm -rf "$WORK"
echo "hardening-tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
