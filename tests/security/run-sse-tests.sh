#!/usr/bin/env bash
# ART-01 SSE real-streaming acceptance (acceptance-tests.md §5/§11),
# probing lib/bin/kernel.js directly and through the standalone BFF proxy:
#
#   kernel-sse-real-body     GET /v1/jobs/{id}/terminal -> text/event-stream;
#                            subscribed + chunk events carry the APPENDED
#                            text bytes (真实 body, not empty event shells)
#   kernel-sse-live-tail     frames appended AFTER the connection is open
#                            reach the reader while the stream stays open
#                            (live push, not just replay)
#   kernel-sse-after-seq     after_seq=3 resumes at seq 4,5 — no duplicate,
#                            no missing (断线续传无重复无缺失)
#   kernel-sse-cross-project terminal read pinned to a foreign project_id
#                            -> 404 project_not_found (跨项目 AuthZ)
#   bff-sse-proxy-body       the same terminal SSE read through the
#                            standalone BFF proxy delivers real frames
#   bff-sse-no-token         no/wrong bearer token -> 401
#   bff-sse-cross-project    BFF job-membership check answers 404 BEFORE any
#                            SSE bytes are streamed
#
# Fencing note: appendTerminalFrames requires frames to carry the claim's
# lease_generation (P0), so every run below claims the job first and reuses
# the claim's generation on all frames.
#
# Not covered (documented in the run report): revoke-on-disconnect and
# backpressure — neither the kernel nor the BFF implements them.
#
# Usage: bash tests/security/run-sse-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
SERVER_BIN="$REPO/packages/dsh-research-ui/lib/standalone/server.js"
if [ ! -f "$SERVER_BIN" ]; then
  echo "sse: standalone server not built — run pnpm --filter @dsh-scholar/research-ui build first" >&2
  exit 2
fi
WORK=$(mktemp -d)
PORT=""
KERNEL_PID=""
BFF_PID=""
PASS=0
FAIL=0

say() { printf '\033[1;34m== %s ==\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m  ok: %s\033[0m\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '\033[1;31m  FAIL: %s\033[0m\n' "$*"; FAIL=$((FAIL + 1)); }
# §4 P0 (API-01/EVID-01): the kernel runs with the fixed eval service token;
# positive internal calls carry x-service-token via the helper (runners inherit
# the env var and authenticate their claim/runner-keys/recover calls themselves).
export DSH_SCHOLAR_SERVICE_TOKEN='dsh-scholar-eval-service-token'
api() { curl -sf -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" "$@"; }

jfield() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const v=JSON.parse(d);console.log(v$1 ?? '')}catch(e){console.log('')}})" ; }

# sse_read <outfile> <hdrfile> <seconds> <url> [curl extra args...]
# Reads an SSE stream with --no-buffer. Open-ended streams are killed by
# timeout (exit 124 is expected and ignored); the body/headers land in the
# given files either way.
sse_read() {
  local out="$1" hdr="$2" secs="$3" url="$4"
  shift 4
  timeout "$secs" curl -sN --no-buffer -D "$hdr" -o "$out" "$@" "$url" > /dev/null 2>&1 || true
}

# ctype <hdrfile> -> normalized content-type value (lowercase, params stripped)
ctype() {
  tr -d '\r' < "$1" | grep -i '^content-type:' | head -1 \
    | sed 's/^[Cc]ontent-[Tt]ype:[[:space:]]*//' | sed 's/;.*//' | tr 'A-Z' 'a-z' | tr -d ' '
}

# sse_chunk_seqs <bodyfile> -> comma-joined seqs of chunk events, in order
sse_chunk_seqs() {
  [[ -f "$1" ]] || { echo ""; return; }
  node -e 'let d=require("fs").readFileSync(process.argv[1],"utf8");const out=[];for(const block of d.split("\n\n")){const e=block.split("\n").find(l=>l.startsWith("event: "));const data=block.split("\n").find(l=>l.startsWith("data: "));if(e&&e.slice(7)==="chunk"&&data){try{out.push(JSON.parse(data.slice(6)).seq)}catch{}}}console.log(out.join(","))' "$1"
}

cleanup() {
  if [[ -n "$BFF_PID" ]]; then
    kill "$BFF_PID" 2>/dev/null || true
    for _ in $(seq 1 15); do
      kill -0 "$BFF_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$BFF_PID" 2>/dev/null || true
  fi
  # A kill -9'd BFF cannot run its sidecar shutdown, and the kernel it
  # spawned (identifiable by the $WORK/bff* data dir in its argv) would
  # otherwise survive; reap it by argv, never by broad pkill.
  for pid in $(pgrep -f "research-kernel/lib/bin/kernel.js" 2>/dev/null || true); do
    if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$WORK/bff"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  [[ -n "$KERNEL_PID" ]] && kill -9 "$KERNEL_PID" 2>/dev/null || true
  wait "$KERNEL_PID" 2>/dev/null || true
  wait "$BFF_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

start_kernel() {
  local port
  for port in $((24000 + $$ % 300)) $((24500 + $$ % 300)) $((25000 + $$ % 300)); do
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

# start_bff -> the standalone BFF (with its own kernel sidecar) is ready.
# Sets BPORT/BFF_KPORT/BTOKEN/BFF_DATA; auth for /v1/* is Bearer $BTOKEN; the
# loopback operator principal is "alice". BFF_DATA is the BFF's dataDir — it
# holds the sidecar's 0600 kernel-token for direct-kernel calls (§5 P0-1).
start_bff() {
  local bport kport attempt
  for attempt in 1 2; do
    bport=$((26000 + ($$ + attempt * 37) % 400))
    kport=$((bport + 1))
    BPORT=$bport
    BFF_KPORT=$kport
    BFF_DATA="$WORK/bff$attempt"
    BTOKEN="sse-test-token-$$-$attempt"
    nohup node "$SERVER_BIN" --host 127.0.0.1 --port "$bport" --kernel-port "$kport" \
      --data-dir "$BFF_DATA" --token "$BTOKEN" --principal alice > "$WORK/bff.log" 2>&1 &
    BFF_PID=$!
    for _ in $(seq 1 100); do
      if ! kill -0 "$BFF_PID" 2>/dev/null; then break; fi
      if curl -sf -m 2 -X POST "http://127.0.0.1:$bport/api/token-check" -H 'content-type: application/json' \
          -d "{\"token\":\"$BTOKEN\"}" > /dev/null 2>&1; then return 0; fi
      sleep 0.2
    done
    kill -9 "$BFF_PID" 2>/dev/null || true
    wait "$BFF_PID" 2>/dev/null || true
    BFF_PID=""
    for pid in $(pgrep -f "research-kernel/lib/bin/kernel.js" 2>/dev/null || true); do
      if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$WORK/bff$attempt"; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  done
  return 1
}

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}'

# ── kernel direct ───────────────────────────────────────────────────────────
start_kernel || { echo "kernel failed to start"; exit 1; }
BASE="http://127.0.0.1:$PORT"
PROJ=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"sse\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
[[ -n "$PROJ" ]] || { echo "failed to create project"; exit 1; }

J=$(api -X POST "$BASE/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"sse-1","kind":"echo","payload":{"message":"sse"}}' | jfield '.job_id')
[[ -n "$J" ]] || { echo "failed to submit echo job"; exit 1; }
CLAIM=$(api -X POST "$BASE/v1/jobs-claim/run" -d '{"owner":"runner-sse","lease_ttl_seconds":60,"limit":8}')
G=$(printf '%s' "$CLAIM" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const row=j.find(x=>x.job_id==='$J');console.log(row?row.lease_generation:'')})")
if [[ "$G" == "1" ]]; then
  ok "kernel claim: lease_generation=$G (frames must carry it, P0 fencing)"
else
  bad "kernel claim: expected lease_generation=1 (got '$G')"
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
append() {
  local run="$1" maxlog="$2"
  shift 2
  local frames=""
  for f in "$@"; do [[ -n "$frames" ]] && frames="$frames,"; frames="$frames$f"; done
  if [[ -n "$maxlog" ]]; then
    curl -s -X POST "$BASE/v1/jobs/$J/terminal-frames" -H 'content-type: application/json' -d "{\"run_id\":\"$run\",\"max_log_bytes\":$maxlog,\"frames\":[$frames]}"
  else
    curl -s -X POST "$BASE/v1/jobs/$J/terminal-frames" -H 'content-type: application/json' -d "{\"run_id\":\"$run\",\"frames\":[$frames]}"
  fi
}

say "Test 1: kernel-sse-real-body — text/event-stream with appended text bytes"
FRAMES=""
for i in 1 2 3 4 5; do
  [[ -n "$FRAMES" ]] && FRAMES="$FRAMES,"
  FRAMES="$FRAMES$(chunk "$i" "line$i")"
done
append run_direct "" "$FRAMES" > /dev/null
sse_read "$WORK/b1.txt" "$WORK/h1.txt" 2 "$BASE/v1/jobs/$J/terminal?after_seq=0&run_id=run_direct"
CT=$(ctype "$WORK/h1.txt")
if [[ "$CT" == "text/event-stream" ]]; then
  ok "response header content-type: $CT"
else
  bad "expected content-type text/event-stream, got '$CT'"
fi
SEQS=$(sse_chunk_seqs "$WORK/b1.txt")
if [[ "$SEQS" == "1,2,3,4,5" ]]; then
  ok "chunk seqs replayed in order: [$SEQS]"
else
  bad "expected chunk seqs 1,2,3,4,5, got [$SEQS]"
fi
if grep -qF 'event: subscribed' "$WORK/b1.txt" && grep -qF '"run_id":"run_direct"' "$WORK/b1.txt"; then
  ok "subscribed event carries the run_id"
else
  bad "subscribed event missing run_id"
fi
if grep -qF '"text":"line1"' "$WORK/b1.txt" && grep -qF '"text":"line3"' "$WORK/b1.txt" \
   && grep -qF '"text":"line5"' "$WORK/b1.txt" && grep -qF '"channel":"stdout"' "$WORK/b1.txt"; then
  ok "real body: appended text bytes (line1..line5) present in the stream"
else
  bad "real body missing appended text bytes"
fi

say "Test 2: kernel-sse-live-tail — frames appended AFTER connect are pushed live"
(timeout 6 curl -sN --no-buffer -D "$WORK/h2.txt" -o "$WORK/b2.txt" \
  "$BASE/v1/jobs/$J/terminal?after_seq=0&run_id=run_live" > /dev/null 2>&1 || true) &
SSE_PID=$!
sleep 1.5
append run_live "" "$(chunk 1 live1)" "$(chunk 2 live2)" "$(chunk 3 live3)" "$(frame 4 exit)" > /dev/null
wait "$SSE_PID" 2>/dev/null || true
if grep -qF '"last_seq":0' "$WORK/b2.txt"; then
  ok "subscribed while the run was empty (last_seq=0) — frames arrived after connect"
else
  bad "expected to subscribe at the empty tail (last_seq=0)"
fi
SEQS=$(sse_chunk_seqs "$WORK/b2.txt")
if [[ "$SEQS" == "1,2,3" ]] && grep -qF '"text":"live1"' "$WORK/b2.txt" && grep -qF '"text":"live3"' "$WORK/b2.txt"; then
  ok "live chunks [$SEQS] pushed on the open connection"
else
  bad "live tail: expected chunks 1,2,3 with live text, got [$SEQS]"
fi
if grep -qF 'event: exit' "$WORK/b2.txt"; then
  ok "exit event ended the same connection after the live frames"
else
  bad "exit event missing after live frames"
fi

say "Test 3: kernel-sse-after-seq — after_seq=3 resumes at seq 4,5 (no dup, no miss)"
sse_read "$WORK/b3.txt" "$WORK/h3.txt" 2 "$BASE/v1/jobs/$J/terminal?after_seq=3&run_id=run_direct"
SEQS3=$(sse_chunk_seqs "$WORK/b3.txt")
if [[ "$SEQS3" == "4,5" ]]; then
  ok "after_seq=3 -> chunks [$SEQS3] (seq 1..3 not re-sent)"
else
  bad "after_seq=3: expected chunks 4,5, got [$SEQS3]"
fi
sse_read "$WORK/b5.txt" "$WORK/h5.txt" 2 "$BASE/v1/jobs/$J/terminal?after_seq=5&run_id=run_direct"
SEQS5=$(sse_chunk_seqs "$WORK/b5.txt")
if [[ -z "$SEQS5" ]]; then
  ok "after_seq=5 -> no chunk replayed"
else
  bad "after_seq=5: expected no chunks, got [$SEQS5]"
fi

say "Test 4: kernel-sse-cross-project — foreign project_id -> 404 project_not_found"
PROJ2=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"sse-foreign\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
CODE=$(curl -s -o "$WORK/f4.json" -w '%{http_code}' "$BASE/v1/jobs/$J/terminal?project_id=$PROJ2&run_id=run_direct")
ERR=$(jfield '.error.code' < "$WORK/f4.json")
if [[ "$CODE" == "404" && "$ERR" == "project_not_found" ]]; then
  ok "terminal read with foreign project_id -> HTTP 404 ($ERR)"
else
  bad "expected 404 project_not_found, got HTTP $CODE ($ERR)"
fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$BASE/v1/jobs/$J/terminal?project_id=$PROJ&run_id=run_direct" || true)
if [[ "$CODE" == "200" ]]; then
  ok "terminal read with OWNING project_id -> HTTP 200"
else
  bad "owning project_id: expected 200, got HTTP $CODE"
fi

# ── standalone BFF proxy ────────────────────────────────────────────────────
start_bff || { bad "standalone BFF failed to start"; }
BFF="http://127.0.0.1:$BPORT"
BAPI() { curl -sf -H "Authorization: Bearer $BTOKEN" -H 'content-type: application/json' "$@"; }

say "Test 5: bff-sse-proxy-body — terminal SSE through the standalone BFF proxy"
BP=$(BAPI -X POST "$BFF/v1/projects" \
  -d "{\"name\":\"sse-bff\",\"workspace\":\"/w\",\"creator_principal_id\":\"alice\",\"brief\":$BRIEF}" | jfield '.project_id')
if [[ -n "$BP" ]]; then
  ok "project created via proxy (creator alice) -> $BP"
else
  bad "project create via proxy"
fi
BJ=$(BAPI -X POST "$BFF/v1/projects/$BP/jobs" -d '{"idempotency_key":"sse-bff-1","kind":"echo","payload":{"message":"sse-bff"}}' | jfield '.job_id')
[[ -n "$BJ" ]] || { bad "job create via proxy"; }
CLAIMB=$(BAPI -X POST "$BFF/v1/jobs-claim/run" -d '{"owner":"runner-sse-bff","lease_ttl_seconds":60,"limit":8}')
BG=$(printf '%s' "$CLAIMB" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const row=j.find(x=>x.job_id==='$BJ');console.log(row?row.lease_generation:'')})")
if [[ "$BG" == "1" ]]; then
  ok "claim via proxy: lease_generation=$BG"
else
  bad "claim via proxy: expected lease_generation=1 (got '$BG')"
  BG=1
fi
RB=$(curl -s -H "Authorization: Bearer $BTOKEN" -H 'content-type: application/json' \
  -X POST "$BFF/v1/jobs/$BJ/terminal-frames" \
  -d "{\"run_id\":\"run_bff\",\"frames\":[{\"seq\":1,\"stream_seq\":1,\"channel\":\"stdout\",\"text\":\"bff1\",\"byte_offset\":0,\"byte_length\":4,\"frame_kind\":\"chunk\",\"lease_generation\":$BG},{\"seq\":2,\"stream_seq\":2,\"channel\":\"stdout\",\"text\":\"bff2\",\"byte_offset\":0,\"byte_length\":4,\"frame_kind\":\"chunk\",\"lease_generation\":$BG},{\"seq\":3,\"stream_seq\":3,\"channel\":\"stdout\",\"text\":\"bff3\",\"byte_offset\":0,\"byte_length\":4,\"frame_kind\":\"chunk\",\"lease_generation\":$BG}]}")
if printf '%s' "$RB" | grep -q '"appended":3'; then
  ok "frames appended via proxy ($(printf '%s' "$RB" | jfield '.appended') frames)"
else
  bad "frames append via proxy: $RB"
fi
sse_read "$WORK/bb5.txt" "$WORK/hb5.txt" 3 "$BFF/v1/jobs/$BJ/terminal?after_seq=0&run_id=run_bff" -H "Authorization: Bearer $BTOKEN"
CT5=$(ctype "$WORK/hb5.txt")
if [[ "$CT5" == "text/event-stream" ]]; then
  ok "proxied SSE content-type: $CT5"
else
  bad "proxied SSE: expected content-type text/event-stream, got '$CT5'"
fi
SEQS5=$(sse_chunk_seqs "$WORK/bb5.txt")
if [[ "$SEQS5" == "1,2,3" ]] && grep -qF '"text":"bff1"' "$WORK/bb5.txt" && grep -qF '"text":"bff3"' "$WORK/bb5.txt"; then
  ok "proxied chunks [$SEQS5] with real text delivered through the BFF"
else
  bad "proxied chunks: expected 1,2,3 with bff text, got [$SEQS5]"
fi
if grep -qF 'event: subscribed' "$WORK/bb5.txt" && grep -qF '"run_id":"run_bff"' "$WORK/bb5.txt"; then
  ok "proxied stream carries the subscribed event with run_id"
else
  bad "proxied stream missing subscribed event"
fi

say "Test 6: bff-sse-no-token — terminal SSE without the bearer -> 401"
CODE=$(curl -s -o "$WORK/b6.json" -w '%{http_code}' "$BFF/v1/jobs/$BJ/terminal?run_id=run_bff" || true)
if [[ "$CODE" == "401" ]]; then
  ok "no token -> HTTP 401"
else
  bad "no token: expected 401, got HTTP $CODE"
fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong-token" "$BFF/v1/jobs/$BJ/terminal?run_id=run_bff" || true)
if [[ "$CODE" == "401" ]]; then
  ok "wrong bearer -> HTTP 401"
else
  bad "wrong bearer: expected 401, got HTTP $CODE"
fi

say "Test 7: bff-sse-cross-project — non-member job terminal -> 404 before streaming"
# Foreign project owned by bob, created directly on the BFF's kernel; the BFF
# (principal alice) must answer 404 WITHOUT proxying any SSE bytes. Direct
# kernel calls carry the sidecar's kernel-token bearer (§5 P0-1 — the
# sidecar-spawned kernel demands it).
BFFKTOKEN=$(tr -d '\n' < "$BFF_DATA/kernel-token" 2>/dev/null || true)
FP=$(curl -sf -H 'content-type: application/json' -H "Authorization: Bearer $BFFKTOKEN" -X POST "http://127.0.0.1:$BFF_KPORT/v1/projects" \
  -d "{\"name\":\"sse-foreign-b\",\"workspace\":\"/w\",\"creator_principal_id\":\"bob\",\"brief\":$BRIEF}" | jfield '.project_id')
FJ=$(curl -sf -H 'content-type: application/json' -H "Authorization: Bearer $BFFKTOKEN" -X POST "http://127.0.0.1:$BFF_KPORT/v1/projects/$FP/jobs" \
  -d '{"idempotency_key":"sse-bff-foreign","kind":"echo","payload":{"message":"x"}}' | jfield '.job_id')
if [[ -n "$FP" && -n "$FJ" ]]; then
  ok "foreign job created on the BFF kernel (owner bob) -> $FJ"
else
  bad "foreign job create on BFF kernel"
fi
CODE=$(curl -s -o "$WORK/b7.json" -w '%{http_code}' -H "Authorization: Bearer $BTOKEN" "$BFF/v1/jobs/$FJ/terminal")
ERR=$(jfield '.error.code' < "$WORK/b7.json")
if [[ "$CODE" == "404" && "$ERR" == "project_not_found" ]]; then
  ok "non-member terminal via BFF -> HTTP 404 ($ERR) before any SSE bytes"
else
  bad "expected 404 project_not_found via BFF, got HTTP $CODE ($ERR)"
fi
if grep -q 'event: ' "$WORK/b7.json" 2>/dev/null; then
  bad "non-member response leaked SSE bytes"
else
  ok "non-member response body is a plain error (no SSE events)"
fi

say "Note: revoke-on-disconnect and backpressure are NOT covered — the kernel and BFF do not implement them"
say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
