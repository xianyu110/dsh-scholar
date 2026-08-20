#!/usr/bin/env bash
# §19.2 P0 blocking test: agent-cannot-decide-gate + acceptance-tests.md §2
# Gate/治理 kernel-level cases.
#
# §19.2 intent: a research gate must only be decided by a human authenticated
# by the standalone BFF. The obsolete public Kernel v1 decision writer is
# absent (404); only the service-token + standalone-human-bff bridge can
# submit the BFF-derived Principal.
#
#   1. every direct public v1 decision write is 404 and records nothing;
#   2. a gate can be decided at most once — a second decision is rejected
#      (409 gate_already_decided), the first decision wins.
#
# The internal orchestrator channel is NOT the gate-decision route: it uses
# the contract approve route (POST /v1/projects/{id}/contracts/{cid}/approve,
# actor-only), which is exercised by the kernel/orchestrator unit tests.
#
# §2 coverage added here (kernel layer):
#   - gate-state-cannot-transition: the four gate-controlled states
#     (SCOPED / IDEA_APPROVED / CONTRACT_APPROVED / RELEASED) answer 422
#     invalid_transition on POST /v1/projects/{id}/transitions — gates are
#     the ONLY path into them;
#   - five gate types each have an independent flow; the release gate migrates
#     RELEASE_READY -> RELEASED (recorded + asserted semantics);
#   - budget-gate-resume: only the Kernel-journaled block provenance is honored;
#     a client-supplied resume_to is ignored;
#   - concurrent-decision: two parallel decisions -> one 200, one 409
#     gate_already_decided, exactly one decision row;
#   - human-principal-durable: a decision re-read via listDecisions keeps
#     principal_id/tenant_id/auth_method/session_id.
#
# Usage: bash tests/security/run-gate-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
WORK=$(mktemp -d)
PORT=""
KERNEL_PID=""
SERVICE_TOKEN="gate-tests-service-token"
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
    DSH_SCHOLAR_SERVICE_TOKEN="$SERVICE_TOKEN" nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
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

say "Test 1: obsolete direct v1 Gate decision writer is absent"
CODE_NO=$(curl -s -o "$WORK/no-actor.json" -w '%{http_code}' -X POST "$BASE/v1/gates/$GATE/decisions" -H 'content-type: application/json' -d '{"decision":"approved"}')
ERR_NO=$(jfield '.error.code' < "$WORK/no-actor.json")
N_DEC0=$(api "$BASE/v1/projects/$PROJ/decisions" | jfield '.length')
if [[ "$CODE_NO" == "404" && "$ERR_NO" == "not_found" && "$N_DEC0" == "0" ]]; then
  ok "direct v1 decision -> HTTP 404 ($ERR_NO), no decision recorded"
else
  bad "expected 404 not_found with no decision recorded, got HTTP $CODE_NO ($ERR_NO), decisions=$N_DEC0"
fi

say "Test 2: internal bridge rejects a self-asserted service identity"
CODE_AGENT=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/internal/human-gates/$GATE/decisions" -H 'content-type: application/json' -H "x-service-token: $SERVICE_TOKEN" -H 'x-service-principal: agent-tool' -d '{"actor":"agent-tool-1","principal":{"principal_id":"agent-tool-1","auth_method":"agent-session"},"decision":"approved"}')
N_DEC_AGENT=$(api "$BASE/v1/projects/$PROJ/decisions" | jfield '.length')
if [[ "$CODE_AGENT" == "403" && "$N_DEC_AGENT" == "0" ]]; then
  ok "non-BFF service identity rejected; no decision recorded"
else
  bad "expected 403 + no decision, got HTTP $CODE_AGENT decisions=$N_DEC_AGENT"
fi

say "Test 3: authenticated Human BFF bridge decides once"
CODE1=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/internal/human-gates/$GATE/decisions" -H 'content-type: application/json' -H "x-service-token: $SERVICE_TOKEN" -H 'x-service-principal: standalone-human-bff' -d '{"actor":"browser-x","principal":{"principal_id":"browser-x","auth_method":"dsh-session"},"decision":"approved"}')
CODE2=$(curl -s -o "$WORK/second.json" -w '%{http_code}' -X POST "$BASE/internal/human-gates/$GATE/decisions" -H 'content-type: application/json' -H "x-service-token: $SERVICE_TOKEN" -H 'x-service-principal: standalone-human-bff' -d '{"actor":"browser-x","principal":{"principal_id":"browser-x","auth_method":"dsh-session"},"decision":"approved"}')
ERR2=$(jfield '.error.code' < "$WORK/second.json")
N_DEC=$(api "$BASE/v1/projects/$PROJ/decisions" | jfield '.length')
if [[ "$CODE1" == "200" && "$CODE2" == "409" && "$ERR2" == "gate_already_decided" && "$N_DEC" == "1" ]]; then
  ok "second decision -> HTTP 409 ($ERR2), exactly one decision recorded"
else
  bad "expected 409 gate_already_decided with 1 decision, got HTTP $CODE2 ($ERR2), decisions=$N_DEC"
fi

# ── §2 helpers ───────────────────────────────────────────────────────────────
# trans <project> <to> <expected_revision> -> new revision or ERR:<code>
trans() {
  local resp err
  resp=$(curl -s -X POST "$BASE/v1/projects/$1/transitions" -H 'content-type: application/json' -d "{\"to\":\"$2\",\"expected_revision\":$3}")
  err=$(printf '%s' "$resp" | jfield '.error.code')
  if [[ -n "$err" ]]; then printf 'ERR:%s' "$err"; return 0; fi
  printf '%s' "$resp" | jfield '.revision'
}
# decide <gate> <actor> <decision> [extra-json] -> HTTP code (curl -o body)
decide() {
  local gate="$1" actor="$2" decision="$3" extra="${4:-}"
  local body="{\"actor\":\"$actor\",\"principal\":{\"principal_id\":\"$actor\",\"tenant_id\":\"acme\",\"auth_method\":\"dsh-session\",\"session_id\":\"sess-$actor\"},\"decision\":\"$decision\""
  [[ -n "$extra" ]] && body="$body,$extra"
  body="$body}"
  curl -s -o "$WORK/dec.json" -w '%{http_code}' -X POST "$BASE/internal/human-gates/$gate/decisions" \
    -H 'content-type: application/json' -H "x-service-token: $SERVICE_TOKEN" -H 'x-service-principal: standalone-human-bff' -d "$body"
}

say "Test 4: gate-state-cannot-transition — the four gate-controlled states answer 422 via POST /v1/projects/{id}/transitions"
P2=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"gate-states\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
[[ -n "$P2" ]] || { echo "failed to create project for gate-state test"; exit 1; }
# 1) DRAFT -> SCOPED (gate-controlled) must be 422.
CODE=$(curl -s -o "$WORK/t.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$P2/transitions" -H 'content-type: application/json' -d '{"to":"SCOPED","expected_revision":0}')
ERR=$(jfield '.error.code' < "$WORK/t.json")
if [[ "$CODE" == "422" && "$ERR" == "invalid_transition" ]]; then
  ok "DRAFT->SCOPED generic transition -> HTTP 422 ($ERR)"
else
  bad "DRAFT->SCOPED: expected 422 invalid_transition, got HTTP $CODE ($ERR)"
fi
# Walk DRAFT -> SCOPED -> SURVEYING -> IDEATING via the scope gate.
G2=$(api -X POST "$BASE/v1/projects/$P2/gates" -d '{"type":"scope","title":"Scope Gate"}' | jfield '.gate_id')
CODE=$(decide "$G2" human-1 approved)
[[ "$CODE" == "200" ]] || bad "scope gate approve failed (HTTP $CODE)"
REV=$(trans "$P2" SURVEYING 1)
REV=$(trans "$P2" IDEATING "$REV")
# 2) IDEATING -> IDEA_APPROVED (gate-controlled) must be 422.
CODE=$(curl -s -o "$WORK/t.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$P2/transitions" -H 'content-type: application/json' -d "{\"to\":\"IDEA_APPROVED\",\"expected_revision\":$REV}")
ERR=$(jfield '.error.code' < "$WORK/t.json")
if [[ "$CODE" == "422" && "$ERR" == "invalid_transition" ]]; then
  ok "IDEATING->IDEA_APPROVED generic transition -> HTTP 422 ($ERR)"
else
  bad "IDEATING->IDEA_APPROVED: expected 422, got HTTP $CODE ($ERR)"
fi
GI=$(api -X POST "$BASE/v1/projects/$P2/gates" -d '{"type":"idea","title":"Idea Gate"}' | jfield '.gate_id')
CODE=$(decide "$GI" human-1 approved)
[[ "$CODE" == "200" ]] || bad "idea gate approve failed (HTTP $CODE)"
REV=$(api "$BASE/v1/projects/$P2" | jfield '.revision')
# Move into CONTRACT_PENDING, then verify CONTRACT_APPROVED stays gate-only.
REV=$(trans "$P2" CONTRACT_PENDING "$REV")
# 3) CONTRACT_PENDING -> CONTRACT_APPROVED (gate-controlled) must be 422.
CODE=$(curl -s -o "$WORK/t.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$P2/transitions" -H 'content-type: application/json' -d "{\"to\":\"CONTRACT_APPROVED\",\"expected_revision\":$REV}")
ERR=$(jfield '.error.code' < "$WORK/t.json")
if [[ "$CODE" == "422" && "$ERR" == "invalid_transition" ]]; then
  ok "CONTRACT_PENDING->CONTRACT_APPROVED generic transition -> HTTP 422 ($ERR)"
else
  bad "CONTRACT_PENDING->CONTRACT_APPROVED: expected 422, got HTTP $CODE ($ERR)"
fi
CT=$(api -X POST "$BASE/v1/projects/$P2/contracts" -H 'content-type: application/json' -d '{"idea_id":"idea_x","data":{"dataset_id":"d"},"methods":{"baseline":"b","treatment":"a"},"metrics":{"primary":"macro_f1"},"seeds":[1],"analysis":{},"ablations":[],"stop_conditions":{}}' | jfield '.contract_id')
GC=$(api -X POST "$BASE/v1/projects/$P2/gates" -H 'content-type: application/json' -d "{\"type\":\"contract\",\"title\":\"Contract Gate\",\"payload\":{\"contract_id\":\"$CT\"}}" | jfield '.gate_id')
CODE=$(decide "$GC" human-1 approved)
[[ "$CODE" == "200" ]] || bad "contract gate approve failed (HTTP $CODE)"
REV=$(api "$BASE/v1/projects/$P2" | jfield '.revision')
for TO in BASELINE_REPRO EXPERIMENTING EVIDENCE_READY WRITING REVIEWING RELEASE_READY; do
  REV=$(trans "$P2" "$TO" "$REV")
done
# 4) RELEASE_READY -> RELEASED (gate-controlled) must be 422.
CODE=$(curl -s -o "$WORK/t.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$P2/transitions" -H 'content-type: application/json' -d "{\"to\":\"RELEASED\",\"expected_revision\":$REV}")
ERR=$(jfield '.error.code' < "$WORK/t.json")
if [[ "$CODE" == "422" && "$ERR" == "invalid_transition" ]]; then
  ok "RELEASE_READY->RELEASED generic transition -> HTTP 422 ($ERR)"
else
  bad "RELEASE_READY->RELEASED: expected 422, got HTTP $CODE ($ERR)"
fi

say "Test 5: five gate types each have an independent flow; release gate migrates RELEASE_READY -> RELEASED"
GR=$(api -X POST "$BASE/v1/projects/$P2/gates" -d '{"type":"release","title":"Release Gate"}' | jfield '.gate_id')
CODE=$(decide "$GR" human-1 approved)
STATUS=$(api "$BASE/v1/projects/$P2" | jfield '.status')
TYPES=$(api "$BASE/v1/projects/$P2/gates" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const g=JSON.parse(d);console.log(g.map(x=>x.type+':'+x.status).join(','))})")
if [[ "$CODE" == "200" && "$STATUS" == "RELEASED" && "$TYPES" == "scope:approved,idea:approved,contract:approved,release:approved" ]]; then
  ok "release gate approved from RELEASE_READY -> project RELEASED (gate-only path); gate flow: $TYPES"
else
  bad "five-gate flow: expected release approval -> RELEASED with all four gates approved, got HTTP $CODE status=$STATUS types='$TYPES'"
fi

say "Test 6: budget-gate-resume — only the Kernel-recorded block provenance is honored"
P3=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"budget-resume\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"constraints\":{\"max_model_cost_usd\":10,\"max_gpu_hours\":10,\"max_api_requests\":100,\"max_parallel_jobs\":2}}" | jfield '.project_id')
[[ -n "$P3" ]] || { echo "failed to create project for budget-resume test"; exit 1; }
G3=$(api -X POST "$BASE/v1/projects/$P3/gates" -d '{"type":"scope","title":"Scope Gate"}' | jfield '.gate_id')
decide "$G3" human-1 approved > /dev/null
REV=$(trans "$P3" SURVEYING 1)
REV=$(trans "$P3" IDEATING "$REV")
GI3=$(api -X POST "$BASE/v1/projects/$P3/gates" -d '{"type":"idea","title":"Idea Gate"}' | jfield '.gate_id')
decide "$GI3" human-1 approved > /dev/null
REV=$(api "$BASE/v1/projects/$P3" | jfield '.revision')
REV=$(trans "$P3" CONTRACT_PENDING "$REV")
GC3=$(api -X POST "$BASE/v1/projects/$P3/gates" -d '{"type":"contract","title":"Contract Gate"}' | jfield '.gate_id')
decide "$GC3" human-1 approved > /dev/null
REV=$(api "$BASE/v1/projects/$P3" | jfield '.revision')
REV=$(trans "$P3" BASELINE_REPRO "$REV")
REV=$(trans "$P3" EXPERIMENTING "$REV")
# Cross the model-cost limit -> BLOCKED_GATE + a budget gate declaring resume_to.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/projects/$P3/budget" -H 'content-type: application/json' -d '{"model_cost_usd":11}')
STATUS=$(api "$BASE/v1/projects/$P3" | jfield '.status')
GB=$(api "$BASE/v1/projects/$P3/gates" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const g=JSON.parse(d);const b=g.find(x=>x.type==='budget');console.log(b?b.gate_id:'')})")
DECLARED=$(api "$BASE/v1/projects/$P3/gates" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const g=JSON.parse(d);const b=g.find(x=>x.type==='budget');console.log(b?(b.payload||{}).resume_to||'':'')})")
if [[ "$CODE" == "200" && "$STATUS" == "BLOCKED_GATE" && "$DECLARED" == "EXPERIMENTING" ]]; then
  ok "budget limit crossed -> BLOCKED_GATE + budget gate declares resume_to=EXPERIMENTING"
else
  bad "budget block: expected BLOCKED_GATE + resume_to=EXPERIMENTING, got HTTP $CODE status=$STATUS declared='$DECLARED'"
fi
# Approving with a CLIENT-supplied resume_to of RELEASED must be ignored.
CODE=$(decide "$GB" human-1 approved '"resume_to":"RELEASED"')
STATUS=$(api "$BASE/v1/projects/$P3" | jfield '.status')
if [[ "$CODE" == "200" && "$STATUS" == "EXPERIMENTING" ]]; then
  ok "client resume_to=RELEASED ignored; approval resumed to Kernel-recorded EXPERIMENTING"
else
  bad "budget resume: expected EXPERIMENTING (Kernel-recorded), got HTTP $CODE status=$STATUS"
fi

say "Test 7: concurrent-decision — two parallel decisions, only one succeeds (409)"
P4=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"concurrent\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
G4=$(api -X POST "$BASE/v1/projects/$P4/gates" -d '{"type":"scope","title":"Scope Gate"}' | jfield '.gate_id')
BODY='{"actor":"human-a","principal":{"principal_id":"p-a","tenant_id":"acme","auth_method":"dsh-session","session_id":"sess-a"},"decision":"approved"}'
(curl -s -o "$WORK/c1.json" -w '%{http_code}' -X POST "$BASE/internal/human-gates/$G4/decisions" -H 'content-type: application/json' -H "x-service-token: $SERVICE_TOKEN" -H 'x-service-principal: standalone-human-bff' -d "$BODY" > "$WORK/c1.code") &
C1=$!
(curl -s -o "$WORK/c2.json" -w '%{http_code}' -X POST "$BASE/internal/human-gates/$G4/decisions" -H 'content-type: application/json' -H "x-service-token: $SERVICE_TOKEN" -H 'x-service-principal: standalone-human-bff' -d "$BODY" > "$WORK/c2.code") &
C2=$!
wait "$C1" "$C2"
R1=$(cat "$WORK/c1.code")
R2=$(cat "$WORK/c2.code")
N_DEC4=$(api "$BASE/v1/projects/$P4/decisions" | jfield '.length')
if { [[ "$R1" == "200" && "$R2" == "409" ]] || [[ "$R1" == "409" && "$R2" == "200" ]]; } && [[ "$N_DEC4" == "1" ]]; then
  ok "parallel decisions -> one HTTP 200 + one HTTP 409, exactly one decision recorded"
else
  bad "concurrent decision: expected (200,409) with 1 decision, got ($R1,$R2) decisions=$N_DEC4"
fi
LOSER=$(node -e "const a=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const b=JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));const l=a.error?a:b;console.log(l.error?l.error.code:'')" "$WORK/c1.json" "$WORK/c2.json")
if [[ "$LOSER" == "gate_already_decided" ]]; then
  ok "loser error code is gate_already_decided"
else
  bad "expected loser error gate_already_decided, got '$LOSER'"
fi

say "Test 8: human-principal-durable — decision re-read keeps principal/tenant/auth_method/session"
P5=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"principal\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
G5=$(api -X POST "$BASE/v1/projects/$P5/gates" -d '{"type":"scope","title":"Scope Gate"}' | jfield '.gate_id')
CODE=$(decide "$G5" ops-42 approved)
PID=$(api "$BASE/v1/projects/$P5/decisions" | jfield '[0].principal.principal_id')
TEN=$(api "$BASE/v1/projects/$P5/decisions" | jfield '[0].principal.tenant_id')
AUTH=$(api "$BASE/v1/projects/$P5/decisions" | jfield '[0].principal.auth_method')
SID=$(api "$BASE/v1/projects/$P5/decisions" | jfield '[0].principal.session_id')
if [[ "$CODE" == "200" && "$PID" == "ops-42" && "$TEN" == "acme" && "$AUTH" == "dsh-session" && "$SID" == "sess-ops-42" ]]; then
  ok "decision re-read via GET /projects/{id}/decisions keeps principal_id=$PID tenant_id=$TEN auth_method=$AUTH session_id=$SID"
else
  bad "durable principal: expected ops-42/acme/dsh-session/sess-ops-42, got ($PID/$TEN/$AUTH/$SID) HTTP $CODE"
fi

say "Test 9: public v1 writer stays absent even for actor/principal payloads"
P9=$(api -X POST "$BASE/v1/projects" -d '{"name":"gov-principal","workspace":"/w","mode":"gate-only","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' | jfield '.project_id')
G9=$(api -X POST "$BASE/v1/projects/$P9/gates" -d '{"type":"scope","title":"principal gate"}' | jfield '.gate_id')
CODE=$(curl -s -o "$WORK/gov9.json" -w '%{http_code}' -X POST "$BASE/v1/gates/$G9/decisions" -H 'content-type: application/json' -d '{"actor":"anon","decision":"approved"}')
ERR=$(jfield '.error.code' < "$WORK/gov9.json")
if [[ "$CODE" == "404" && "$ERR" == "not_found" ]]; then
  ok "bare-actor direct gate decision -> HTTP 404 not_found"
else
  bad "bare-actor decision: expected 404 not_found, got HTTP $CODE (error=$ERR)"
fi
# A principal body cannot restore the removed route.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/gates/$G9/decisions" -H 'content-type: application/json' -d '{"actor":"web-user","principal":{"principal_id":"pi-gov","auth_method":"dsh-session"},"decision":"approved"}')
if [[ "$CODE" == "404" ]]; then
  ok "principal-bearing direct decision remains HTTP 404"
else
  bad "principal decision: expected 404, got HTTP $CODE"
fi

say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
