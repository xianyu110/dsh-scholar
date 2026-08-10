#!/usr/bin/env bash
# §5 Terminal kernel-level blocking tests (acceptance-tests.md §5), probing
# lib/bin/kernel.js over HTTP:
#
#   reconnect-after-seq   SSE after_seq=N resumes at N+1.. — no duplicate, no
#                         missing frames (断线续传无重复无缺失)
#   retention-gap         requested evicted seqs first receive a gap event
#                         with dropped_bytes (请求已淘汰 seq 先收 gap + dropped)
#   overflow              reaching the cap marks truncated=true; the final log
#                         artifact stays downloadable
#   exit-replay           exit frames keep exit_code/signal/timed_out/cancelled
#                         readable for success/nonzero/signal/timeout/cancel
#   log-authz             terminal reads are project-scoped: a foreign
#                         project_id answers 404 (跨项目读 terminal 404)
#   cancel-timeout-distinct timed_out and cancelled stay distinct in the exit
#                         frame and the SSE exit event
#
# Fencing note: appendTerminalFrames now requires frames to carry the claim's
# lease_generation (P0), so every run below claims the job first and reuses
# the claim's generation on all frames.
#
# Usage: bash tests/security/run-terminal-tests.sh
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

# sse_events <url> -> lines "event|json" for every event block, one per line.
sse_events() {
  curl -s "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{for(const block of d.split('\n\n')){const e=block.split('\n').find(l=>l.startsWith('event: '));const data=block.split('\n').find(l=>l.startsWith('data: '));if(e&&data){try{console.log(e.slice(7)+'|'+JSON.stringify(JSON.parse(data.slice(6))))}catch{}}}})"
}

cleanup() {
  [[ -n "$KERNEL_PID" ]] && kill -9 "$KERNEL_PID" 2>/dev/null || true
  wait "$KERNEL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

start_kernel() {
  local port
  for port in $((22000 + $$ % 400)) $((22500 + $$ % 400)) $((23000 + $$ % 400)); do
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
PROJ=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"terminal\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
[[ -n "$PROJ" ]] || { echo "failed to create project"; exit 1; }

# One echo job, claimed once; all runs below reuse this claim's generation.
J=$(api -X POST "$BASE/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"term-1","kind":"echo","payload":{"message":"term"}}' | jfield '.job_id')
[[ -n "$J" ]] || { echo "failed to submit echo job"; exit 1; }
CLAIM=$(api -X POST "$BASE/v1/jobs-claim/run" -d '{"owner":"runner-term","lease_ttl_seconds":60,"limit":8}')
G=$(printf '%s' "$CLAIM" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const row=j.find(x=>x.job_id==='$J');console.log(row?row.lease_generation:'')})")
T=$(printf '%s' "$CLAIM" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const row=j.find(x=>x.job_id==='$J');console.log(row?row.lease_token:'')})")
if [[ "$G" == "1" && -n "$T" ]]; then
  ok "claim returned lease_generation=$G + lease_token for $J (frames must carry both, P0 fencing)"
else
  bad "claim must return lease_generation=1 and a lease_token (got gen='$G' token='$T')"
  exit 1
fi
# frame <seq> <kind> [payload-json-object] -> frame JSON (payload_json is a STRING)
frame() {
  node -e 'const [, seq, kind, gen, payloadRaw] = process.argv; const payload = payloadRaw ? JSON.parse(payloadRaw) : {}; console.log(JSON.stringify({ seq: Number(seq), frame_kind: kind, lease_generation: Number(gen), ...(Object.keys(payload).length > 0 ? { payload_json: JSON.stringify(payload) } : {}) }))' "$1" "$2" "$G" "${3:-}"
}
# chunk <seq> <text>
chunk() {
  local seq="$1" text="$2"
  printf '{"seq":%s,"stream_seq":%s,"channel":"stdout","text":"%s","byte_offset":0,"byte_length":%s,"frame_kind":"chunk","lease_generation":%s}' "$seq" "$seq" "$text" "${#text}" "$G"
}
# append <run> <maxlog> <frames...> -> response body
# P0 (TERM-01): every append carries the claim's lease owner + token via
# x-lease-owner/x-lease-token headers — leased jobs reject frames without them.
append() {
  local run="$1" maxlog="$2"
  shift 2
  local frames=""
  for f in "$@"; do [[ -n "$frames" ]] && frames="$frames,"; frames="$frames$f"; done
  if [[ -n "$maxlog" ]]; then
    curl -s -X POST "$BASE/v1/jobs/$J/terminal-frames" -H 'content-type: application/json' -H "x-lease-owner: runner-term" -H "x-lease-token: $T" -d "{\"run_id\":\"$run\",\"max_log_bytes\":$maxlog,\"frames\":[$frames]}"
  else
    curl -s -X POST "$BASE/v1/jobs/$J/terminal-frames" -H 'content-type: application/json' -H "x-lease-owner: runner-term" -H "x-lease-token: $T" -d "{\"run_id\":\"$run\",\"frames\":[$frames]}"
  fi
}

say "Test 1: reconnect-after-seq — SSE after_seq=N resumes at N+1.. (no dup, no missing)"
FRAMES=""
for i in 1 2 3 4 5; do
  [[ -n "$FRAMES" ]] && FRAMES="$FRAMES,"
  FRAMES="$FRAMES$(chunk "$i" "line$i")"
done
append run_replay "" "$FRAMES" "$(frame 6 exit)" > /dev/null
EV0=$(sse_events "$BASE/v1/jobs/$J/terminal?after_seq=0&run_id=run_replay")
SEQS0=$(printf '%s\n' "$EV0" | grep '^chunk|' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(d.trim().split('\n').filter(Boolean).map(l=>JSON.parse(l.slice(6)).seq).join(','))})")
EV3=$(sse_events "$BASE/v1/jobs/$J/terminal?after_seq=3&run_id=run_replay")
SEQS3=$(printf '%s\n' "$EV3" | grep '^chunk|' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(d.trim().split('\n').filter(Boolean).map(l=>JSON.parse(l.slice(6)).seq).join(','))})")
if [[ "$SEQS0" == "1,2,3,4,5" && "$SEQS3" == "4,5" ]]; then
  ok "after_seq=0 -> [$SEQS0]; after_seq=3 -> [$SEQS3] (seq 3 not re-sent, no gaps)"
else
  bad "reconnect: expected [1,2,3,4,5] and [4,5], got [$SEQS0] and [$SEQS3]"
fi
EV5=$(sse_events "$BASE/v1/jobs/$J/terminal?after_seq=5&run_id=run_replay")
if ! printf '%s\n' "$EV5" | grep -q '^chunk|' && printf '%s\n' "$EV5" | grep -q '^exit|'; then
  ok "after_seq=5 tail: no chunk, exit frame still delivered"
else
  bad "after_seq=5: expected no chunks and an exit event"
fi

say "Test 2: retention-gap — evicted seqs first receive a gap event with dropped_bytes"
FRAMES=""
for i in $(seq 1 70); do
  [[ -n "$FRAMES" ]] && FRAMES="$FRAMES,"
  FRAMES="$FRAMES$(chunk "$i" '0123456789')"
done
R=$(append run_gap 250 "$FRAMES" "$(frame 71 exit)")
TRUNC=$(printf '%s' "$R" | jfield '.truncated')
DROPPED=$(printf '%s' "$R" | jfield '.dropped_bytes')
if [[ "$TRUNC" == "true" && "$DROPPED" == "640" ]]; then
  ok "overflow append -> truncated=true dropped_bytes=640"
else
  bad "expected truncated=true dropped_bytes=640, got truncated=$TRUNC dropped=$DROPPED"
fi
EVG=$(sse_events "$BASE/v1/jobs/$J/terminal?after_seq=0&run_id=run_gap")
GAPLINE=$(printf '%s\n' "$EVG" | grep '^gap|' | head -1)
GAP_DROP=$(printf '%s' "$GAPLINE" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d.slice(4));console.log(j.dropped_bytes+'/'+j.retained_from_seq+'/'+j.seq)})")
GAP_SEQS=$(printf '%s\n' "$EVG" | grep '^chunk|' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(d.trim().split('\n').filter(Boolean).map(l=>JSON.parse(l.slice(6)).seq).join(','))})")
if [[ "$GAP_DROP" == "640/65/1" && "$GAP_SEQS" == "65,66,67,68,69,70" ]]; then
  ok "gap event first (dropped=640 retained_from=65 seq=1), then chunks [$GAP_SEQS]"
else
  bad "gap semantics: expected 640/65/1 + chunks 65..70, got gap='$GAP_DROP' chunks='$GAP_SEQS'"
fi

say "Test 3: overflow — truncated flag + final log artifact downloadable"
R=$(append run_overflow 250 "$FRAMES")
TRUNC=$(printf '%s' "$R" | jfield '.truncated')
TOTAL=$(printf '%s' "$R" | jfield '.total_bytes')
if [[ "$TRUNC" == "true" && -n "$TOTAL" && "$TOTAL" -le 250 ]]; then
  ok "append response reports truncated=true total_bytes=$TOTAL (cap honored)"
else
  bad "overflow: expected truncated=true total<=250, got truncated=$TRUNC total=$TOTAL"
fi
LOG_B64=$(printf '%s' 'full canonical log (hot log truncated separately)' | base64 | tr -d '\n')
ART=$(api -X POST "$BASE/v1/artifacts" -d "{\"project_id\":\"$PROJ\",\"kind\":\"log\",\"content_base64\":\"$LOG_B64\",\"media_type\":\"text/plain\"}" | jfield '.artifact_id')
CODE=$(curl -s -o "$WORK/log.bin" -w '%{http_code}' "$BASE/v1/artifacts/$ART?project_id=$PROJ")
BODY=$(cat "$WORK/log.bin")
if [[ "$CODE" == "200" && "$BODY" == "full canonical log (hot log truncated separately)" ]]; then
  ok "final log artifact GET -> HTTP 200 with exact bytes (download after truncation)"
else
  bad "log artifact download: expected 200 + exact bytes, got HTTP $CODE body='$BODY'"
fi

say "Test 4: exit-replay — exit_code/signal/timed_out/cancelled readable per terminal"
append run_ok "" "$(frame 1 exit '{"exit_code":0,"signal":null,"timed_out":false,"cancelled":false}')" > /dev/null
append run_fail "" "$(frame 1 exit '{"exit_code":1,"signal":null,"timed_out":false,"cancelled":false}')" > /dev/null
append run_signal "" "$(frame 1 exit '{"exit_code":null,"signal":"SIGKILL","timed_out":false,"cancelled":false}')" > /dev/null
append run_timeout "" "$(frame 1 exit '{"exit_code":null,"signal":"SIGTERM","timed_out":true,"cancelled":false}')" > /dev/null
append run_cancel "" "$(frame 1 exit '{"exit_code":null,"signal":null,"timed_out":false,"cancelled":true}')" > /dev/null
EX_OK=$(sse_events "$BASE/v1/jobs/$J/terminal?after_seq=0&run_id=run_ok" | grep '^exit|' | head -1)
EX_FAIL=$(sse_events "$BASE/v1/jobs/$J/terminal?after_seq=0&run_id=run_fail" | grep '^exit|' | head -1)
EX_SIG=$(sse_events "$BASE/v1/jobs/$J/terminal?after_seq=0&run_id=run_signal" | grep '^exit|' | head -1)
if printf '%s' "$EX_OK" | grep -q '"exit_code":0' && printf '%s' "$EX_FAIL" | grep -q '"exit_code":1' && printf '%s' "$EX_SIG" | grep -q '"signal":"SIGKILL"'; then
  ok "exit events replay exit_code/signal (0 / 1 / SIGKILL)"
else
  bad "exit replay: ok='$EX_OK' fail='$EX_FAIL' sig='$EX_SIG'"
fi

say "Test 5: log-authz — cross-project terminal read returns 404"
PROJ2=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"terminal-foreign\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
CODE=$(curl -s -o "$WORK/foreign.json" -w '%{http_code}' "$BASE/v1/jobs/$J/terminal?project_id=$PROJ2&run_id=run_ok")
ERR=$(jfield '.error.code' < "$WORK/foreign.json")
if [[ "$CODE" == "404" && "$ERR" == "project_not_found" ]]; then
  ok "terminal read with foreign project_id -> HTTP 404 ($ERR)"
else
  bad "log-authz: expected 404 project_not_found, got HTTP $CODE ($ERR)"
fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/jobs/$J/terminal?project_id=$PROJ&run_id=run_ok")
if [[ "$CODE" == "200" ]]; then
  ok "terminal read with OWNING project_id -> HTTP 200"
else
  bad "owning project_id: expected 200, got HTTP $CODE"
fi

say "Test 6: cancel-timeout-distinct — timed_out and cancelled stay distinct"
EX_TO=$(sse_events "$BASE/v1/jobs/$J/terminal?after_seq=0&run_id=run_timeout" | grep '^exit|' | head -1)
EX_CA=$(sse_events "$BASE/v1/jobs/$J/terminal?after_seq=0&run_id=run_cancel" | grep '^exit|' | head -1)
if printf '%s' "$EX_TO" | grep -q '"timed_out":true' && printf '%s' "$EX_TO" | grep -q '"cancelled":false' \
   && printf '%s' "$EX_CA" | grep -q '"cancelled":true' && printf '%s' "$EX_CA" | grep -q '"timed_out":false'; then
  ok "timeout exit (timed_out=true, cancelled=false) vs cancel exit (cancelled=true, timed_out=false)"
else
  bad "cancel-timeout-distinct: timeout='$EX_TO' cancel='$EX_CA'"
fi

say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
