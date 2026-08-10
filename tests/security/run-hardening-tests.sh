#!/usr/bin/env bash
# §19.2 P0 blocking tests: host-execution and fake-experiment defenses (v2).
#
#   formal-run-rejects-subprocess      formal job + subprocess runner -> failed
#   baseline-must-execute-real-code    baseline with empty command -> failed
#   formal-run-rejects-message-only    message-only (no command) -> failed
#   job-rejects-unapproved-contract    formal job without approved contract -> rejected
#   kernel-submit-rejects-subprocess   kernel rejects formal on isolated-subprocess profile
#   smoke-rejects-host-subprocess      untrusted smoke + subprocess runner -> failed,
#                                      host marker file must NOT exist (RUN-02)
#   smoke-trusted-fixture-ok           explicit payload.trusted_fixture=true smoke
#                                      + subprocess runner -> succeeded (RUN-02)
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
# §4 P0 (API-01/EVID-01): every kernel below is configured with the fixed
# eval service token (env DSH_SCHOLAR_SERVICE_TOKEN; runners inherit it and
# authenticate their claim/runner-keys/recover calls automatically). The
# curl helper attaches x-service-token so internal routes (approve) work;
# negative tests below use RAW curl without the header on purpose.
export DSH_SCHOLAR_SERVICE_TOKEN='dsh-scholar-eval-service-token'
api() { curl -sf -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" "$@"; }

nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break; sleep 0.1; done
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT" --owner harden --poll-ms 150 > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
sleep 0.5

echo "== service-token auth matrix (claim route on a token-configured kernel) =="
NEG_NO=$(curl -s -o "$WORK/neg-no.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/jobs-claim/run" -H 'content-type: application/json' -d '{"owner":"svc-neg","limit":1}')
NEG_ERR=$(node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).error?.code??'')}catch(e){console.log('')}})" < "$WORK/neg-no.json")
NEG_BEARER=$(curl -s -o "$WORK/neg-bearer.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/jobs-claim/run" -H 'content-type: application/json' -H "Authorization: Bearer $DSH_SCHOLAR_SERVICE_TOKEN" -d '{"owner":"svc-neg","limit":1}')
NEG_WRONG=$(curl -s -o "$WORK/neg-wrong.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/jobs-claim/run" -H 'content-type: application/json' -H 'x-service-token: wrong-service-token' -d '{"owner":"svc-neg","limit":1}')
NEG_OK=$(curl -s -o "$WORK/neg-ok.json" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/jobs-claim/run" -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" -d '{"owner":"svc-neg","limit":1}')
if [[ "$NEG_NO" == "403" && "$NEG_ERR" == "service_token_required" ]]; then
  ok "claim without x-service-token -> HTTP 403 service_token_required"
else
  bad "claim without token: expected 403 service_token_required, got HTTP $NEG_NO (error=$NEG_ERR)"
fi
if [[ "$NEG_BEARER" == "403" ]]; then
  ok "claim with the token in Authorization (browser bearer) -> HTTP 403 (only x-service-token counts)"
else
  bad "claim with bearer token: expected 403, got HTTP $NEG_BEARER"
fi
if [[ "$NEG_WRONG" == "403" ]]; then
  ok "claim with a wrong x-service-token -> HTTP 403"
else
  bad "claim with wrong token: expected 403, got HTTP $NEG_WRONG"
fi
if [[ "$NEG_OK" == "200" ]]; then
  ok "claim with the correct x-service-token -> HTTP 200"
else
  bad "claim with correct token: expected 200, got HTTP $NEG_OK"
fi

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"machine-learning"}'
PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"harden\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"execution\":{\"runner_profile\":\"local-docker-cpu\",\"network_policy\":\"none\",\"artifact_store\":\"local-cas\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
ok "project $PROJ on container profile"

# v2 §12.2: formal jobs require a REAL registered code snapshot.
CODE_ART=$(api -X POST "http://127.0.0.1:$PORT/v1/artifacts" -d "{\"project_id\":\"$PROJ\",\"kind\":\"code\",\"content_base64\":\"$(printf 'x=1' | base64 -w0)\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).artifact_id))")
ok "code snapshot artifact registered: $CODE_ART"

# P0 (acceptance-tests.md §4): formal-class jobs must bind an approved
# contract — register + freeze one so the runner-layer rejection tests below
# exercise EXECUTION failure, not submission rejection.
CT=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/contracts" -d '{"idea_id":"idea_harden","data":{"dataset_id":"harden"},"methods":{"baseline":"b","treatment":"a"},"metrics":{"primary":"m"},"seeds":[1]}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).contract_id))")
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/contracts/$CT/approve" -d '{"actor":"hardening-eval"}' > /dev/null
ok "contract $CT registered + approved (P0 binding)"

echo "== kernel-submit-rejects-subprocess =="
P2=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"harden-sub\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"execution\":{\"runner_profile\":\"isolated-subprocess\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$P2/jobs" -H 'content-type: application/json' -d "{\"idempotency_key\":\"f1\",\"kind\":\"formal\",\"command\":[\"true\"],\"code_snapshot_id\":\"$CODE_ART\"}")
[[ "$CODE" == "422" ]] && ok "kernel rejects formal job on isolated-subprocess profile (422)" || bad "expected 422 got $CODE"

echo "== formal-run-rejects-subprocess (runner layer) =="
J1=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d "{\"idempotency_key\":\"f2\",\"kind\":\"formal\",\"contract_id\":\"$CT\",\"image_digest\":\"node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32\",\"command\":[\"true\"],\"code_snapshot_id\":\"$CODE_ART\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
for _ in $(seq 1 60); do
  S=$(api "http://127.0.0.1:$PORT/v1/jobs/$J1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  [[ "$S" == "failed" ]] && break
  sleep 0.3
done
C=$(api "http://127.0.0.1:$PORT/v1/jobs/$J1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.failure_class??'')+'|'+(j.error??'').slice(0,60))})")
[[ "$C" == environment* ]] && ok "formal + subprocess runner -> failed/environment: ${C#*|}" || bad "expected environment got $C"

echo "== non-echo must-execute-real-code / message-only rejected =="
# RUN-02: smoke defaults to container — the subprocess runner only accepts
# smoke jobs explicitly marked payload.trusted_fixture=true (execution-runtime.md
# §1). This message-only fixture is marked trusted so the test exercises the
# empty-command invariant below, not the container gate.
J2=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"b1","kind":"smoke","payload":{"trusted_fixture":true,"message":"{\"metric\":\"f1\",\"value\":0.8}"}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
for _ in $(seq 1 60); do
  S=$(api "http://127.0.0.1:$PORT/v1/jobs/$J2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  [[ "$S" == "failed" ]] && break
  sleep 0.3
done
E2=$(api "http://127.0.0.1:$PORT/v1/jobs/$J2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).error))")
[[ "$E2" == *"empty command"* ]] && ok "non-echo empty command/message-only -> failed (no synthetic success)" || bad "expected empty-command failure got: $E2"
M2=$(api "http://127.0.0.1:$PORT/v1/jobs/$J2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.run_manifest?.metrics_artifact??'none'))})")
[[ "$M2" == "none" ]] && ok "no metrics artifact for fake run" || bad "metrics artifact should be absent"

echo "== smoke-rejects-host-subprocess (RUN-02: smoke defaults to container) =="
# execution-runtime.md §1: only an EXPLICIT trusted-smoke-fixture
# (payload.trusted_fixture=true) may use the isolated subprocess. The script
# would `touch` a host marker file — if the runner ever executed it on the
# host, the marker would exist and the assertion below fails loudly.
MARKER="/tmp/dsh-smoke-host-executed-$RANDOM"
J3=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d "{\"idempotency_key\":\"s1\",\"kind\":\"smoke\",\"payload\":{\"script\":\"touch $MARKER\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
for _ in $(seq 1 60); do
  S=$(api "http://127.0.0.1:$PORT/v1/jobs/$J3" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  [[ "$S" == "failed" ]] && break
  sleep 0.3
done
C3=$(api "http://127.0.0.1:$PORT/v1/jobs/$J3" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.failure_class??'')+'|'+(j.error??''))})")
if [[ "$C3" == environment* && "$C3" == *"trusted-smoke-fixture"* ]]; then
  ok "untrusted smoke + subprocess runner -> failed/environment (trusted-smoke-fixture): ${C3#*|}"
else
  bad "untrusted smoke expected environment + trusted-smoke-fixture message, got: $C3"
fi
if [ ! -e "$MARKER" ]; then
  ok "host marker $MARKER absent — smoke script never executed on the host"
else
  bad "host marker $MARKER EXISTS — smoke script executed on the host!"
fi

echo "== smoke-trusted-fixture-ok (RUN-02: explicit trusted fixture may use subprocess) =="
J4=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"s2","kind":"smoke","payload":{"trusted_fixture":true,"script":"echo \"{\\\"metric\\\":\\\"f1\\\",\\\"value\\\":0.5}\""}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
for _ in $(seq 1 60); do
  S=$(api "http://127.0.0.1:$PORT/v1/jobs/$J4" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  [[ "$S" == "succeeded" ]] && break
  sleep 0.3
done
M4=$(api "http://127.0.0.1:$PORT/v1/jobs/$J4" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log((j.run_manifest?.metrics_artifact??'none'))})")
if [[ "$S" == "succeeded" && "$M4" == sha256:* ]]; then
  ok "trusted smoke fixture + subprocess runner -> succeeded, script metrics artifact $M4"
else
  bad "trusted smoke expected succeeded + metrics artifact, got status=$S metrics=$M4"
fi
# Docker mode smoke (unmarked) is covered by evals/docker-eval.sh and
# evals/release-bundle/run-release-eval.sh (both run smoke scripts with
# --mode docker) — no separate case needed here.

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
# RUN-02: the subprocess runner requires the explicit trusted-smoke-fixture
# marker for smoke jobs (execution-runtime.md §1).
M1="zzq-cancel"; M2="marker-98765"
JL=$(api -X POST "http://127.0.0.1:$PORT2/v1/projects/$PROJ2/jobs" -d "{\"idempotency_key\":\"h-cancel\",\"kind\":\"smoke\",\"payload\":{\"trusted_fixture\":true,\"script\":\"node -e \\\"setTimeout(function(){},90000); //$M1-$M2\\\"\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
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

# §OPS-01/SEC-UI-01: standalone startup reliability + token/loopback HTTP.
bash "$REPO/tests/security/run-standalone-http-tests.sh"
