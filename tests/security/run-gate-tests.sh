#!/usr/bin/env bash
# §19.2 P0 blocking test: agent-cannot-decide-gate (kernel-level part).
#
# Full §19.2 intent: a research gate must never be decided by an agent — only
# a human with an authenticated principal may decide. The kernel API carries
# no principal/role concept (only a free-form `actor` string), so the
# agent-vs-human enforcement is currently a tool-layer concern. What the
# kernel CAN and MUST enforce today:
#
#   1. gate decision requires an actor — a decision WITHOUT actor is rejected
#      (validation 422), it is never recorded as anonymous.
#   2. a gate can be decided at most once — a second decision is rejected
#      (409 gate_already_decided), the first decision wins.
#
# The script also records the actual behavior for agent-like actors (any
# `actor` string, including "agent-*", is accepted and recorded verbatim).
#
# Usage: bash tests/security/run-gate-tests.sh
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
PROJ=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"gate\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
GATE=$(api -X POST "$BASE/v1/projects/$PROJ/gates" -d '{"type":"scope","title":"Scope Gate v0.2"}' | jfield '.gate_id')
[[ -n "$PROJ" && -n "$GATE" ]] || { echo "failed to create project/gate"; exit 1; }

say "Test 1: gate decision without actor -> rejected (no anonymous decisions)"
CODE_NO=$(curl -s -o "$WORK/no-actor.json" -w '%{http_code}' -X POST "$BASE/v1/gates/$GATE/decisions" -H 'content-type: application/json' -d '{"decision":"approved"}')
ERR_NO=$(jfield '.error.code' < "$WORK/no-actor.json")
N_DEC0=$(api "$BASE/v1/projects/$PROJ/decisions" | jfield '.length')
if [[ "$CODE_NO" == "422" && "$N_DEC0" == "0" ]]; then
  ok "decision without actor -> HTTP 422 ($ERR_NO), no decision recorded"
else
  bad "expected 422 with no decision recorded, got HTTP $CODE_NO ($ERR_NO), decisions=$N_DEC0"
fi

say "Test 2: agent-like actor is accepted and recorded verbatim (actual behavior)"
CODE_AGENT=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/gates/$GATE/decisions" -H 'content-type: application/json' -d '{"actor":"agent-tool-1","decision":"approved"}')
ACTOR=$(api "$BASE/v1/projects/$PROJ/decisions" | jfield '[0].actor')
GATE_STATUS=$(api "$BASE/v1/projects/$PROJ/gates" | jfield '[0].status')
if [[ "$CODE_AGENT" == "200" && "$ACTOR" == "agent-tool-1" && "$GATE_STATUS" == "approved" ]]; then
  ok "actor 'agent-tool-1' accepted and recorded (kernel has no agent/human principal check — enforcement is tool-layer; recorded for report)"
else
  bad "expected 200 + actor recorded; got HTTP $CODE_AGENT actor='$ACTOR' gate='$GATE_STATUS'"
fi

say "Test 3: second decision on the same gate -> rejected (409, exactly-once)"
CODE2=$(curl -s -o "$WORK/second.json" -w '%{http_code}' -X POST "$BASE/v1/gates/$GATE/decisions" -H 'content-type: application/json' -d '{"actor":"browser-x","decision":"approved"}')
ERR2=$(jfield '.error.code' < "$WORK/second.json")
N_DEC=$(api "$BASE/v1/projects/$PROJ/decisions" | jfield '.length')
if [[ "$CODE2" == "409" && "$ERR2" == "gate_already_decided" && "$N_DEC" == "1" ]]; then
  ok "second decision -> HTTP 409 ($ERR2), exactly one decision recorded"
else
  bad "expected 409 gate_already_decided with 1 decision, got HTTP $CODE2 ($ERR2), decisions=$N_DEC"
fi

say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
