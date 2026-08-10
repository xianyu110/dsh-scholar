#!/usr/bin/env bash
# §4 P0 blocking tests: full-field lease fencing (kernel layer).
#
#   heartbeat-missing-fencing-rejected     heartbeat w/o generation/token -> 409 lease_stale
#   heartbeat-stale-generation-rejected    heartbeat with wrong generation (99) -> 409 lease_stale
#   heartbeat-wrong-token-rejected         heartbeat with wrong token -> 409 lease_stale
#   heartbeat-current-credentials-ok       heartbeat with current gen+token -> 200
#   terminal-frame-stale-generation-409    frame with generation < current -> 409 lease_stale
#   terminal-frame-current-generation-ok   frame with current generation -> 200
#   terminal-frame-wrong-owner-409         frame with wrong x-lease-owner -> 409 lease_stale
#   terminal-frame-wrong-token-409         frame with wrong x-lease-token -> 409 lease_stale
#   complete-missing-fencing-rejected      complete w/o generation/token -> 409 lease_stale
#   complete-future-generation-rejected    complete with generation 2 (> current 1) -> 409 lease_stale
#   complete-current-fencing-ok            complete with current gen+token -> 200, job succeeded
#   complete-manifest-required-422         succeeded w/o run_manifest (analysis kind) -> 422
#   artifact-finalize-route-absent         no artifact finalize route exists (404) — noted
#
# P0 (acceptance-tests.md §4): heartbeat/Terminal frame/complete MUST carry
# the current owner/generation/token; missing fields, old generation, future
# generation and wrong tokens are all 409 lease_stale — no owner-only
# compatibility pass. Terminal frames additionally authenticate the lease
# owner/token (x-lease-owner/x-lease-token) whenever provided — the runner
# gateway always sends them.
#
# Actual kernel behavior probed against lib/bin/kernel.js:
#  - heartbeatJob/completeJob reject missing OR mismatched generation/token
#    with 409 lease_stale (equality check — both old AND future generations).
#  - appendTerminalFrames rejects a frame WITHOUT lease_generation with
#    409 lease_stale (fail-closed, P0) and any generation != current.
#  - there is NO artifact finalize route (POST .../finalize -> 404 not_found),
#    so no finalize fencing case exists to run; the route probe is asserted.
#
# Usage: bash tests/security/run-fencing-tests.sh
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
PROJ=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"fence\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
[[ -n "$PROJ" ]] || { echo "failed to create project"; exit 1; }

# One echo job, claimed once; every fencing probe below targets it. Echo jobs
# complete with an empty run_manifest (no metrics artifact requirements).
J=$(api -X POST "$BASE/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"fence-1","kind":"echo","payload":{"message":"fence"}}' | jfield '.job_id')
[[ -n "$J" ]] || { echo "failed to submit echo job"; exit 1; }
CLAIM=$(api -X POST "$BASE/v1/jobs-claim/run" -d '{"owner":"runner-fence","lease_ttl_seconds":60,"limit":8}')
G=$(printf '%s' "$CLAIM" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const row=j.find(x=>x.job_id==='$J');console.log(row?row.lease_generation:'')})")
T=$(printf '%s' "$CLAIM" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const row=j.find(x=>x.job_id==='$J');console.log(row?row.lease_token:'')})")
RID=$(printf '%s' "$CLAIM" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const row=j.find(x=>x.job_id==='$J');console.log(row?row.run_id:'')})")
if [[ "$G" == "1" && -n "$T" && "$RID" == run_* ]]; then
  ok "claim returned lease_generation=$G + lease_token + durable run_id=$RID for $J (RUN-01 P0)"
else
  bad "claim must return lease_generation=1, a lease_token and the durable run_id (got gen=$G token=$T run_id=$RID)"
  exit 1
fi

say "Test: heartbeat fencing (missing / stale generation / wrong token / current)"
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J/heartbeat" -H 'content-type: application/json' -d '{"owner":"runner-fence"}')
ERR=$(jfield '.error.code' < "$WORK/resp.json")
if [[ "$CODE" == "409" && "$ERR" == "lease_stale" ]]; then
  ok "heartbeat without generation/token -> HTTP 409 lease_stale (no owner-only pass)"
else
  bad "heartbeat missing fencing: expected 409 lease_stale, got HTTP $CODE (error=$ERR)"
fi
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J/heartbeat" -H 'content-type: application/json' -d "{\"owner\":\"runner-fence\",\"lease_generation\":99,\"lease_token\":\"$T\"}")
ERR=$(jfield '.error.code' < "$WORK/resp.json")
if [[ "$CODE" == "409" && "$ERR" == "lease_stale" ]]; then
  ok "heartbeat with wrong generation 99 -> HTTP 409 lease_stale"
else
  bad "heartbeat wrong generation: expected 409 lease_stale, got HTTP $CODE (error=$ERR)"
fi
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J/heartbeat" -H 'content-type: application/json' -d "{\"owner\":\"runner-fence\",\"lease_generation\":$G,\"lease_token\":\"wrong-token\"}")
ERR=$(jfield '.error.code' < "$WORK/resp.json")
if [[ "$CODE" == "409" && "$ERR" == "lease_stale" ]]; then
  ok "heartbeat with wrong token -> HTTP 409 lease_stale"
else
  bad "heartbeat wrong token: expected 409 lease_stale, got HTTP $CODE (error=$ERR)"
fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/jobs/$J/heartbeat" -H 'content-type: application/json' -d "{\"owner\":\"runner-fence\",\"lease_generation\":$G,\"lease_token\":\"$T\"}")
if [[ "$CODE" == "200" ]]; then
  ok "heartbeat with current generation/token -> HTTP 200"
else
  bad "heartbeat current credentials: expected 200, got HTTP $CODE"
fi

say "Test: Terminal frame fencing (stale generation / current generation / missing field / owner+token)"
# P0 (TERM-01): a leased job's terminal frames MUST carry the lease owner and
# token (x-lease-owner/x-lease-token headers) IN ADDITION to the generation —
# missing, wrong-owner and wrong-token frames are all 409 lease_stale.
# Route existence verified by curl: POST /v1/jobs/{id}/terminal-frames is
# implemented (422 validation_error on an empty frames body proves the route).
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J/terminal-frames" -H 'content-type: application/json' -H "x-lease-owner: runner-fence" -H "x-lease-token: $T" -d '{"run_id":"run_fence_1","frames":[{"seq":1,"frame_kind":"chunk","channel":"stdout","text":"x","lease_generation":0}]}')
ERR=$(jfield '.error.code' < "$WORK/resp.json")
if [[ "$CODE" == "409" && "$ERR" == "lease_stale" ]]; then
  ok "terminal frame with generation 0 (stale vs current $G) -> HTTP 409 lease_stale"
else
  bad "terminal frame stale generation: expected 409 lease_stale, got HTTP $CODE (error=$ERR)"
fi
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J/terminal-frames" -H 'content-type: application/json' -H "x-lease-owner: runner-fence" -H "x-lease-token: $T" -d "{\"run_id\":\"run_fence_1\",\"frames\":[{\"seq\":2,\"frame_kind\":\"chunk\",\"channel\":\"stdout\",\"text\":\"y\",\"lease_generation\":$G}]}")
APPENDED=$(jfield '.appended' < "$WORK/resp.json")
if [[ "$CODE" == "200" && "$APPENDED" == "1" ]]; then
  ok "terminal frame with current generation + owner/token -> HTTP 200, appended=$APPENDED"
else
  bad "terminal frame current generation: expected 200 appended=1, got HTTP $CODE appended=$APPENDED"
fi
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J/terminal-frames" -H 'content-type: application/json' -H "x-lease-owner: runner-fence" -H "x-lease-token: $T" -d '{"run_id":"run_fence_1","frames":[{"seq":3,"frame_kind":"chunk","channel":"stdout","text":"z"}]}')
ERR=$(jfield '.error.code' < "$WORK/resp.json")
if [[ "$CODE" == "409" && "$ERR" == "lease_stale" ]]; then
  ok "terminal frame WITHOUT lease_generation -> HTTP 409 lease_stale (fail-closed, P0)"
else
  bad "terminal frame missing generation: expected 409 lease_stale, got HTTP $CODE (error=$ERR)"
fi
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J/terminal-frames" -H 'content-type: application/json' -H "x-lease-owner: intruder" -H "x-lease-token: $T" -d "{\"run_id\":\"run_fence_1\",\"frames\":[{\"seq\":5,\"frame_kind\":\"chunk\",\"channel\":\"stdout\",\"text\":\"v\",\"lease_generation\":$G}]}")
ERR=$(jfield '.error.code' < "$WORK/resp.json")
if [[ "$CODE" == "409" && "$ERR" == "lease_stale" ]]; then
  ok "terminal frame with WRONG x-lease-owner -> HTTP 409 lease_stale"
else
  bad "terminal frame wrong owner: expected 409 lease_stale, got HTTP $CODE (error=$ERR)"
fi
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J/terminal-frames" -H 'content-type: application/json' -H "x-lease-owner: runner-fence" -H "x-lease-token: wrong-token" -d "{\"run_id\":\"run_fence_1\",\"frames\":[{\"seq\":6,\"frame_kind\":\"chunk\",\"channel\":\"stdout\",\"text\":\"u\",\"lease_generation\":$G}]}")
ERR=$(jfield '.error.code' < "$WORK/resp.json")
if [[ "$CODE" == "409" && "$ERR" == "lease_stale" ]]; then
  ok "terminal frame with WRONG x-lease-token -> HTTP 409 lease_stale"
else
  bad "terminal frame wrong token: expected 409 lease_stale, got HTTP $CODE (error=$ERR)"
fi

say "Test: complete fencing (missing / future generation / current)"
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J/status" -H 'content-type: application/json' -d '{"owner":"runner-fence","status":"succeeded"}')
ERR=$(jfield '.error.code' < "$WORK/resp.json")
if [[ "$CODE" == "409" && "$ERR" == "lease_stale" ]]; then
  ok "complete without generation/token -> HTTP 409 lease_stale"
else
  bad "complete missing fencing: expected 409 lease_stale, got HTTP $CODE (error=$ERR)"
fi
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J/status" -H 'content-type: application/json' -d "{\"owner\":\"runner-fence\",\"status\":\"succeeded\",\"lease_generation\":2,\"lease_token\":\"$T\",\"run_manifest\":{}}")
ERR=$(jfield '.error.code' < "$WORK/resp.json")
if [[ "$CODE" == "409" && "$ERR" == "lease_stale" ]]; then
  ok "complete with FUTURE generation 2 (current $G) -> HTTP 409 lease_stale"
else
  bad "complete future generation: expected 409 lease_stale, got HTTP $CODE (error=$ERR)"
fi
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J/status" -H 'content-type: application/json' -d "{\"owner\":\"runner-fence\",\"status\":\"succeeded\",\"lease_generation\":$G,\"lease_token\":\"$T\"}")
STATUS=$(jfield '.status' < "$WORK/resp.json")
if [[ "$CODE" == "200" && "$STATUS" == "succeeded" ]]; then
  ok "complete with current generation/token -> HTTP 200, job '$STATUS'"
else
  bad "complete current credentials: expected 200 succeeded, got HTTP $CODE status=$STATUS"
fi

say "Test: succeeded completion REQUIRES a run manifest (non-fixture kinds, RUN-01)"
# kind 'analysis' is not an echo/smoke fixture: a succeeded completion without
# a RunManifest is rejected 422 run_manifest_required (echo fixtures stay
# exempt — they execute nothing in-process, §3.2 invariant 1).
J2=$(api -X POST "$BASE/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"fence-manifest","kind":"analysis","payload":{"metric":"m"}}' | jfield '.job_id')
[[ -n "$J2" ]] || { echo "failed to submit analysis job"; exit 1; }
CLAIM2=$(api -X POST "$BASE/v1/jobs-claim/run" -d '{"owner":"runner-fence","lease_ttl_seconds":60,"limit":8}')
G2=$(printf '%s' "$CLAIM2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const row=j.find(x=>x.job_id==='$J2');console.log(row?row.lease_generation:'')})")
T2=$(printf '%s' "$CLAIM2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const row=j.find(x=>x.job_id==='$J2');console.log(row?row.lease_token:'')})")
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/jobs/$J2/status" -H 'content-type: application/json' -d "{\"owner\":\"runner-fence\",\"status\":\"succeeded\",\"lease_generation\":$G2,\"lease_token\":\"$T2\"}")
ERR=$(jfield '.error.code' < "$WORK/resp.json")
S2=$(api "$BASE/v1/jobs/$J2" | jfield '.status')
if [[ "$CODE" == "422" && "$ERR" == "run_manifest_required" && "$S2" == "running" ]]; then
  ok "succeeded without run_manifest -> HTTP 422 run_manifest_required; job still '$S2'"
else
  bad "succeeded w/o manifest: expected 422 run_manifest_required, got HTTP $CODE (error=$ERR) status=$S2"
fi

say "Artifact finalize route probe"
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/artifacts/sha256:0000000000000000000000000000000000000000000000000000000000000000/finalize" -H 'content-type: application/json' -d '{}')
if [[ "$CODE" == "404" ]]; then
  ok "no artifact finalize route exists (POST /v1/artifacts/{id}/finalize -> HTTP 404 not_found); 注明: 该能力不存在, 无 finalize fencing 用例可执行"
else
  bad "artifact finalize route probe: expected 404 (route absent), got HTTP $CODE"
fi

say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
