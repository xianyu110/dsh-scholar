#!/usr/bin/env bash
# §19.2 P0 blocking test: evidence-missing-effect-is-inconclusive + §6
# Evidence provenance state machine (draft_unverified → verified → accepted).
#
# P0 semantics (acceptance-tests.md §6):
#   - Evidence must reach provenance_status='accepted' to support a Claim:
#     the Analysis Worker creates 'verified' (x-service-principal:
#     analysis-worker) and only a Verifier/Auditor accept transition
#     (x-service-principal: verifier|auditor + request_id) may move it to
#     'accepted'. draft/legacy/verified rows before accept are inconclusive.
#   - The accept transition re-validates RunManifest/Contract/RunSet/Analysis
#     Artifact refs, so accepted evidence references a REAL same-project
#     analysis artifact (artifact_refs). run_ids may be empty (no runs -> no
#     job checks); non-empty run_ids must resolve to succeeded jobs.
#   - Evidence WITHOUT effect_size/CI (only primary_metric + value) must never
#     become "supported" — the deterministic rule (§4.7 / §11.3) requires an
#     effect estimate with CI; the verdict stays "inconclusive".
#
# Usage: bash tests/security/run-evidence-tests.sh
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
PROJ=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"evidence\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
[[ -n "$PROJ" ]] || { echo "failed to create project"; exit 1; }
PROJ2=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"evidence-foreign\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | jfield '.project_id')
[[ -n "$PROJ2" ]] || { echo "failed to create project 2"; exit 1; }
ok "projects $PROJ + $PROJ2 ready"

# §6: accept revalidates Analysis Artifacts -> register a REAL kind=analysis
# artifact in project 1 and reference it from every accepted evidence row.
ART=$(api -X POST "$BASE/v1/artifacts" -d "{\"project_id\":\"$PROJ\",\"kind\":\"analysis\",\"content_base64\":\"$(printf '{"acc":0.91}' | base64 -w0)\",\"metadata\":{\"metric\":\"accuracy\"}}" | jfield '.artifact_id')
[[ "$ART" == sha256:* ]] || { echo "failed to register analysis artifact"; exit 1; }
ok "analysis artifact $ART registered (accept revalidation target)"

# Helper: verified ingestion (Analysis-Worker identity) + optional accept.
verified_evidence() {
  # $1 = result JSON, $2 = extra body JSON (optional)
  local extra="${2:-}"
  if [[ -n "$extra" ]]; then
    api -X POST "$BASE/v1/projects/$PROJ/evidence/verified" -H 'x-service-principal: analysis-worker' -d "{\"source_type\":\"analysis\",\"run_ids\":[],\"artifact_refs\":[\"$ART\"],\"analysis_method\":\"bootstrap-95\",\"result\":$1,$extra}" | jfield '.evidence_id'
  else
    api -X POST "$BASE/v1/projects/$PROJ/evidence/verified" -H 'x-service-principal: analysis-worker' -d "{\"source_type\":\"analysis\",\"run_ids\":[],\"artifact_refs\":[\"$ART\"],\"analysis_method\":\"bootstrap-95\",\"result\":$1}" | jfield '.evidence_id'
  fi
}
accept_evidence() {
  # $1 = project, $2 = evidence_id, $3 = request_id
  api -X POST "$BASE/v1/projects/$1/evidence/$2/accept" -H 'x-service-principal: verifier' -d "{\"request_id\":\"$3\"}" | jfield '.provenance_status'
}

say "Test: evidence-missing-effect-is-inconclusive"
# Accepted evidence WITHOUT effect_size/CI (only primary_metric + value):
# full provenance pipeline (verified -> accepted) but NO effect estimate ->
# the claim must stay inconclusive.
E1=$(verified_evidence '{"primary_metric":"accuracy","value":0.91}')
[[ -n "$E1" ]] || { echo "failed to ingest verified evidence"; exit 1; }
A1=$(accept_evidence "$PROJ" "$E1" "req-ev-1")
[[ "$A1" == "accepted" ]] && ok "verified evidence $E1 accepted by verifier (provenance=$A1, request_id=req-ev-1)" || { bad "accept failed (provenance='$A1')"; exit 1; }
C1=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d '{"statement":"The treatment improves accuracy","scope":{"dataset":"d1","split":"test"}}' | jfield '.claim_id')
S1=$(api -X POST "$BASE/v1/claims/verify" -d "{\"claim_id\":\"$C1\",\"evidence_ids\":[\"$E1\"]}" | jfield '.status')
if [[ "$S1" == "inconclusive" ]]; then
  ok "claim verified against effect-free ACCEPTED evidence -> inconclusive"
else
  bad "claim verified against effect-free accepted evidence became '$S1' (expected inconclusive) — §19.2 invariant violated: no effect_size/CI must never be supported"
fi

say "Test: draft evidence can never support a claim"
ED=$(api -X POST "$BASE/v1/projects/$PROJ/evidence" -d '{"source_type":"analysis","run_ids":[],"artifact_refs":[],"analysis_method":"descriptive-summary","result":{"primary_metric":"accuracy","value":0.91}}' | jfield '.evidence_id')
[[ -n "$ED" ]] || { echo "failed to ingest draft evidence"; exit 1; }
CD=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d '{"statement":"draft evidence claim","scope":{"dataset":"d1","split":"test"}}' | jfield '.claim_id')
SD=$(api -X POST "$BASE/v1/claims/verify" -d "{\"claim_id\":\"$CD\",\"evidence_ids\":[\"$ED\"]}" | jfield '.status')
[[ "$SD" == "inconclusive" ]] && ok "draft evidence verify -> inconclusive" || bad "draft evidence verify became '$SD' (expected inconclusive)"

say "Test: verified-but-not-accepted evidence is inconclusive"
E2=$(verified_evidence '{"primary_metric":"accuracy","value":0.91,"baseline_value":0.86,"effect_size":0.05,"ci_low":0.01,"ci_high":0.09,"p_value":0.01,"n_seeds":5}')
[[ -n "$E2" ]] || { echo "failed to ingest verified evidence"; exit 1; }
C2=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d '{"statement":"verified but not accepted","scope":{"dataset":"d1","split":"test"}}' | jfield '.claim_id')
S2=$(api -X POST "$BASE/v1/claims/verify" -d "{\"claim_id\":\"$C2\",\"evidence_ids\":[\"$E2\"]}" | jfield '.status')
[[ "$S2" == "inconclusive" ]] && ok "verified (unaccepted) evidence verify -> inconclusive" || bad "verified-unaccepted evidence verify became '$S2' (expected inconclusive)"

say "Test: accept without service identity -> 403"
CODE4=$(curl -s -o "$WORK/resp4.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ/evidence/$E2/accept" -H 'content-type: application/json' -d '{"request_id":"req-ev-4"}')
ERR4=$(jfield '.error.code' < "$WORK/resp4.json")
if [[ "$CODE4" == "403" && "$ERR4" == "service_identity_required" ]]; then
  ok "accept without x-service-principal -> HTTP 403 service_identity_required"
else
  bad "expected 403 service_identity_required, got HTTP $CODE4 (error=$ERR4)"
fi
CODE4B=$(curl -s -o "$WORK/resp4b.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ/evidence/$E2/accept" -H 'content-type: application/json' -H 'x-service-principal: public-user' -d '{"request_id":"req-ev-4b"}')
ERR4B=$(jfield '.error.code' < "$WORK/resp4b.json")
if [[ "$CODE4B" == "403" && "$ERR4B" == "service_identity_required" ]]; then
  ok "accept with a non-verifier/auditor principal -> HTTP 403 service_identity_required"
else
  bad "expected 403 for non-service principal, got HTTP $CODE4B (error=$ERR4B)"
fi

say "Test: public evidence route rejects forged verified/accepted provenance"
CODE5=$(curl -s -o "$WORK/resp5.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ/evidence" -H 'content-type: application/json' -d '{"source_type":"analysis","run_ids":[],"artifact_refs":[],"analysis_method":"bootstrap-95","result":{"primary_metric":"accuracy","value":0.91},"provenance_status":"verified"}')
ERR5=$(jfield '.error.code' < "$WORK/resp5.json")
CODE5B=$(curl -s -o "$WORK/resp5b.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ/evidence" -H 'content-type: application/json' -d '{"source_type":"analysis","run_ids":[],"artifact_refs":[],"analysis_method":"bootstrap-95","result":{"primary_metric":"accuracy","value":0.91},"provenance_status":"accepted"}')
ERR5B=$(jfield '.error.code' < "$WORK/resp5b.json")
if [[ "$CODE5" == "422" && "$ERR5" == "validation_error" && "$CODE5B" == "422" && "$ERR5B" == "validation_error" ]]; then
  ok "forged provenance_status=verified/accepted on public route -> HTTP 422 validation_error"
else
  bad "expected 422 validation_error for forged provenance, got HTTP $CODE5 (error=$ERR5) / HTTP $CODE5B (error=$ERR5B)"
fi

say "Test: cross-project accept -> 422"
CODE6=$(curl -s -o "$WORK/resp6.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ2/evidence/$E2/accept" -H 'content-type: application/json' -H 'x-service-principal: verifier' -d '{"request_id":"req-ev-6"}')
ERR6=$(jfield '.error.code' < "$WORK/resp6.json")
if [[ "$CODE6" == "422" && "$ERR6" == "evidence_foreign" ]]; then
  ok "accepting evidence of another project -> HTTP 422 evidence_foreign"
else
  bad "expected 422 evidence_foreign, got HTTP $CODE6 (error=$ERR6)"
fi

say "Test (control): accepted evidence WITH effect_size + CI can be supported"
E7=$(verified_evidence '{"primary_metric":"accuracy","value":0.91,"baseline_value":0.86,"effect_size":0.05,"ci_low":0.01,"ci_high":0.09,"p_value":0.01,"n_seeds":5}')
A7=$(accept_evidence "$PROJ" "$E7" "req-ev-7")
[[ "$A7" == "accepted" ]] || { bad "positive accept failed (provenance='$A7')"; exit 1; }
C7=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d '{"statement":"The treatment improves accuracy (effect with CI)","scope":{"dataset":"d1","split":"test"}}' | jfield '.claim_id')
S7=$(api -X POST "$BASE/v1/claims/verify" -d "{\"claim_id\":\"$C7\",\"evidence_ids\":[\"$E7\"]}" | jfield '.status')
if [[ "$S7" == "supported" ]]; then
  ok "control: accepted evidence with effect_size>0 and CI>0 -> supported (API wiring correct)"
else
  bad "control broken: expected supported, got '$S7'"
fi

say "Test (control): accepted negative effect with CI -> contradicted (direction rule exists)"
E8=$(verified_evidence '{"primary_metric":"accuracy","value":0.80,"baseline_value":0.86,"effect_size":-0.06,"ci_low":-0.10,"ci_high":-0.02,"n_seeds":5}')
A8=$(accept_evidence "$PROJ" "$E8" "req-ev-8")
[[ "$A8" == "accepted" ]] || { bad "negative accept failed (provenance='$A8')"; exit 1; }
C8=$(api -X POST "$BASE/v1/projects/$PROJ/claims" -d '{"statement":"The treatment hurts accuracy","scope":{"dataset":"d1","split":"test"}}' | jfield '.claim_id')
S8=$(api -X POST "$BASE/v1/claims/verify" -d "{\"claim_id\":\"$C8\",\"evidence_ids\":[\"$E8\"]}" | jfield '.status')
if [[ "$S8" == "contradicted" ]]; then
  ok "control: accepted negative effect_size with CI excluding zero -> contradicted"
else
  bad "control broken: expected contradicted, got '$S8'"
fi

say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
