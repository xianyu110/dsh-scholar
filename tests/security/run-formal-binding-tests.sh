#!/usr/bin/env bash
# §4 P0 blocking tests: secure-job Contract binding (kernel layer).
#
#   formal-job-contract-required       formal job without contract_id -> 422 contract_required, never queued
#   formal-job-contract-unknown        contract_id pointing at a missing contract -> 422 contract_unknown
#   formal-job-contract-foreign        contract belonging to ANOTHER project -> 422 contract_foreign
#   formal-job-contract-not-approved   contract in status=draft -> 422 contract_not_approved
#   formal-job-contract-approved       approved contract + frozen Protocol -> 201 queued (positive)
#
# P0 (acceptance-tests.md §4): formal/baseline/pilot/reproduce MUST bind a
# same-project, status=approved, Human-Gate-frozen Contract; draft/foreign/
# missing Contracts are 422 and the job never enters queued. A formal Job also
# binds one exact earlier frozen ProtocolRevision and one immutable data
# Artifact (methodology-knowledge-layer.md §4); the positive control exercises
# the combined admission instead of bypassing Protocol-before-run.
#
# Order in kernel.ts submitJob(): runner-profile check -> latex-compile ->
# code_snapshot_id REQUIRED + resolution -> contract binding check -> image
# digest defaulting (the digest itself is not re-validated at the kernel; the
# Runner validates it against the trusted lock). The scripts therefore submit
# every job with a REAL registered kind=code snapshot (POST /v1/artifacts) and
# the canonical digest so the Contract check is the code path under test.
#
# Usage: bash tests/security/run-formal-binding-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
WORK=$(mktemp -d)
PORT=""
KERNEL_PID=""
PASS=0
FAIL=0
RUNNER_TARGET_TOKEN='dsh-scholar-formal-binding-target-token-v1'

say() { printf '\033[1;34m== %s ==\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m  ok: %s\033[0m\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '\033[1;31m  FAIL: %s\033[0m\n' "$*"; FAIL=$((FAIL + 1)); }
# §4 P0 (API-01): the kernel runs with the fixed eval service token; the
# helper attaches x-service-token so the internal approve route works.
export DSH_SCHOLAR_SERVICE_TOKEN='dsh-scholar-eval-service-token'
api() { curl -sf -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" "$@"; }

jfield() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const v=JSON.parse(d);console.log(v$1 ?? '')}catch(e){console.log('')}})" ; }

cleanup() {
  [[ -n "$KERNEL_PID" ]] && kill -9 "$KERNEL_PID" 2>/dev/null || true
  wait "$KERNEL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

start_kernel() {
  local port
  mkdir -p "$WORK/secrets/runner-targets"
  chmod 700 "$WORK/secrets" "$WORK/secrets/runner-targets"
  printf '%s' "$RUNNER_TARGET_TOKEN" > "$WORK/secrets/runner-targets/target_local_docker_v1.token"
  chmod 600 "$WORK/secrets/runner-targets/target_local_docker_v1.token"
  for port in $((20000 + $$ % 400)) $((20500 + $$ % 400)) $((21000 + $$ % 400)); do
    PORT=$port
    nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --secret-root "$WORK/secrets" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
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
IMG='node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'

start_kernel || { echo "kernel failed to start"; exit 1; }
BASE="http://127.0.0.1:$PORT"

PROJ1=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"fb-p1\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"creator_principal_id\":\"formal-binding-pi\",\"execution\":{\"runner_profile_id\":\"profile_local_docker_cpu_v1\"}}" | jfield '.project_id')
[[ -n "$PROJ1" ]] || { echo "failed to create project 1"; exit 1; }
PROJ2=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"fb-p2\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"execution\":{\"runner_profile_id\":\"profile_local_docker_cpu_v1\"}}" | jfield '.project_id')
[[ -n "$PROJ2" ]] || { echo "failed to create project 2"; exit 1; }
ok "projects $PROJ1 (binding target) + $PROJ2 (foreign source)"

# §12.2 (SCH-EXEC-002): formal-class jobs require a REAL registered code
# snapshot — the contract binding check runs AFTER the code_snapshot_id check,
# so every submission below carries this artifact id.
CODE_ART=$(api -X POST "$BASE/v1/artifacts" -d "{\"project_id\":\"$PROJ1\",\"kind\":\"code\",\"content_base64\":\"$(printf '#!/bin/sh\necho hi\n' | base64 -w0)\"}" | jfield '.artifact_id')
[[ -n "$CODE_ART" ]] || { echo "failed to register code snapshot"; exit 1; }
ok "code snapshot artifact registered: $CODE_ART"
DATA_ART=$(api -X POST "$BASE/v1/artifacts" -d "{\"project_id\":\"$PROJ1\",\"kind\":\"data\",\"content_base64\":\"$(printf 'fixture-data\n' | base64 -w0)\"}" | jfield '.artifact_id')
[[ -n "$DATA_ART" ]] || { echo "failed to register data artifact"; exit 1; }
ok "data artifact registered: $DATA_ART"

# One contract per scenario: draft (same project), foreign (project 2),
# approved (frozen via the internal approve route for the positive case).
CT_DRAFT=$(api -X POST "$BASE/v1/projects/$PROJ1/contracts" -d '{"idea_id":"idea_fb","data":{"dataset_id":"fb1"},"methods":{"baseline":"b","treatment":"t"},"metrics":{"primary":"m"}}' | jfield '.contract_id')
CT_FOREIGN=$(api -X POST "$BASE/v1/projects/$PROJ2/contracts" -d '{"idea_id":"idea_fb","data":{"dataset_id":"fb2"},"methods":{"baseline":"b","treatment":"t"},"metrics":{"primary":"m"}}' | jfield '.contract_id')
CT_OK=$(api -X POST "$BASE/v1/projects/$PROJ1/contracts" -d '{"idea_id":"idea_fb","data":{"dataset_id":"fb3"},"methods":{"baseline":"b","treatment":"t"},"metrics":{"primary":"m"}}' | jfield '.contract_id')
[[ -n "$CT_DRAFT" && -n "$CT_FOREIGN" && -n "$CT_OK" ]] || { echo "failed to register contracts"; exit 1; }
ok "contracts registered: draft=$CT_DRAFT foreign=$CT_FOREIGN to-approve=$CT_OK"

say "Test: formal-job-contract-required (missing contract_id -> 422, never queued)"
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ1/jobs" -H 'content-type: application/json' -d "{\"idempotency_key\":\"fb-a\",\"kind\":\"formal\",\"code_snapshot_id\":\"$CODE_ART\",\"image_digest\":\"$IMG\",\"payload\":{\"message\":\"x\"}}")
ERR_CODE=$(jfield '.error.code' < "$WORK/resp.json")
QUEUED=$(api "$BASE/v1/projects/$PROJ1/jobs" | grep -c 'fb-a' || true)
if [[ "$CODE" == "422" && "$ERR_CODE" == "contract_required" && "$QUEUED" == "0" ]]; then
  ok "formal job without contract_id -> HTTP 422 contract_required; job never entered queued"
else
  bad "expected 422 contract_required + no queued job, got HTTP $CODE (error=$ERR_CODE) queued_matches=$QUEUED"
fi

say "Test: formal-job-contract-unknown (missing contract -> 422)"
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ1/jobs" -H 'content-type: application/json' -d "{\"idempotency_key\":\"fb-b\",\"kind\":\"formal\",\"contract_id\":\"expc_missing_contract_000\",\"code_snapshot_id\":\"$CODE_ART\",\"image_digest\":\"$IMG\",\"payload\":{\"message\":\"x\"}}")
ERR_CODE=$(jfield '.error.code' < "$WORK/resp.json")
if [[ "$CODE" == "422" && "$ERR_CODE" == "contract_unknown" ]]; then
  ok "formal job with unknown contract_id -> HTTP 422 contract_unknown"
else
  bad "expected 422 contract_unknown, got HTTP $CODE (error=$ERR_CODE)"
fi

say "Test: formal-job-contract-foreign (cross-project binding -> 422)"
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ1/jobs" -H 'content-type: application/json' -d "{\"idempotency_key\":\"fb-c\",\"kind\":\"formal\",\"contract_id\":\"$CT_FOREIGN\",\"code_snapshot_id\":\"$CODE_ART\",\"image_digest\":\"$IMG\",\"payload\":{\"message\":\"x\"}}")
ERR_CODE=$(jfield '.error.code' < "$WORK/resp.json")
if [[ "$CODE" == "422" && "$ERR_CODE" == "contract_foreign" ]]; then
  ok "formal job binding a foreign-project contract -> HTTP 422 contract_foreign"
else
  bad "expected 422 contract_foreign, got HTTP $CODE (error=$ERR_CODE)"
fi

say "Test: formal-job-contract-not-approved (draft contract -> 422)"
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ1/jobs" -H 'content-type: application/json' -d "{\"idempotency_key\":\"fb-d\",\"kind\":\"formal\",\"contract_id\":\"$CT_DRAFT\",\"code_snapshot_id\":\"$CODE_ART\",\"image_digest\":\"$IMG\",\"payload\":{\"message\":\"x\"}}")
ERR_CODE=$(jfield '.error.code' < "$WORK/resp.json")
if [[ "$CODE" == "422" && "$ERR_CODE" == "contract_not_approved" ]]; then
  ok "formal job binding a draft contract -> HTTP 422 contract_not_approved"
else
  bad "expected 422 contract_not_approved, got HTTP $CODE (error=$ERR_CODE)"
fi

say "Test: formal-job-contract-approved (approve route + positive submission)"
APPROVE_CODE=$(curl -s -o "$WORK/approve.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ1/contracts/$CT_OK/approve" -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" -d '{"actor":"formal-binding-eval"}')
APPROVED_STATUS=$(jfield '.status' < "$WORK/approve.json")
if [[ "$APPROVE_CODE" == "200" && "$APPROVED_STATUS" == "approved" ]]; then
  ok "internal approve route froze contract -> HTTP 200 status=approved"
else
  bad "approve route expected 200 approved, got HTTP $APPROVE_CODE status=$APPROVED_STATUS"
fi
CONTRACT_JSON=$(api "$BASE/v1/projects/$PROJ1/contracts" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const rows=JSON.parse(d);const row=rows.find(v=>v.contract_id===process.argv[1]);if(!row)process.exit(2);process.stdout.write(JSON.stringify(row))})" "$CT_OK")
TARGET_ID=$(api "$BASE/v1/projects/$PROJ1/projection" | jfield '.project.execution.runner_target_id')
TARGET_REVISION=$(api "$BASE/v1/runner-targets/$TARGET_ID" | jfield '.revision')
HEARTBEAT_CODE=$(curl -s -o "$WORK/heartbeat.json" -w '%{http_code}' -X POST "$BASE/v1/runner-targets/$TARGET_ID/heartbeat" \
  -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" -H "x-runner-target-token: $RUNNER_TARGET_TOKEN" \
  -d "{\"expected_revision\":$TARGET_REVISION,\"health\":\"online\"}")
if [[ "$HEARTBEAT_CODE" == "200" ]]; then
  ok "target-scoped heartbeat observed the formal Job runner online"
else
  bad "runner target heartbeat expected HTTP 200, got HTTP $HEARTBEAT_CODE"
fi
TARGET_HASH=$(api "$BASE/v1/runner-targets/$TARGET_ID" | jfield '.config_hash')
PROTOCOL_BODY=$(cd "$REPO" && CONTRACT_JSON="$CONTRACT_JSON" PROJ1="$PROJ1" CT_OK="$CT_OK" CODE_ART="$CODE_ART" DATA_ART="$DATA_ART" TARGET_ID="$TARGET_ID" TARGET_HASH="$TARGET_HASH" node --input-type=module - <<'NODE'
import { createHash } from 'node:crypto'
import { canonicalJson } from './packages/research-kernel/lib/kernel.js'
import { protocolRevisionCanonicalHash } from './packages/research-kernel/lib/methodology-store.js'
const contract = JSON.parse(process.env.CONTRACT_JSON)
const record = {
  protocol_id: 'protocol_formal_binding_v1', project_id: process.env.PROJ1, revision: 1, supersedes: null,
  status: 'frozen', intent: 'confirmatory', research_question_ref: 'question_formal_binding',
  target_claim_ref: null, hypothesis: 'The approved treatment changes the primary metric.',
  prediction: 'The primary metric differs from the approved baseline.',
  variables: { manipulated: ['treatment'], controlled: ['fixture data'], measured: ['m'] },
  metrics: { primary: 'm', secondary: [], baseline_ref: 'baseline_formal_binding', analysis_plan_artifact_id: process.env.DATA_ART },
  pins: {
    contract: { ref: process.env.CT_OK, sha256: `sha256:${createHash('sha256').update(canonicalJson(contract)).digest('hex')}` },
    code: { ref: process.env.CODE_ART, sha256: process.env.CODE_ART },
    data: { ref: process.env.DATA_ART, sha256: process.env.DATA_ART },
    environment: { ref: process.env.TARGET_ID, sha256: process.env.TARGET_HASH },
  },
  stopping_conditions: ['one complete formal run'], failure_criteria: ['integrity failure'],
  allowed_deviations: [], deviation_handling: 'Freeze a new Protocol revision before retrying.',
  author_principal_id: 'formal-binding-pi', created_at: '2026-08-20T00:00:00.000Z', frozen_at: '2026-08-20T00:00:00.000Z',
}
record.canonical_hash = protocolRevisionCanonicalHash(record)
process.stdout.write(JSON.stringify({ record, expected_revision: 0 }))
NODE
)
PROTOCOL_CODE=$(curl -s -o "$WORK/protocol.json" -w '%{http_code}' -X POST "$BASE/v2/projects/$PROJ1/protocols" -H 'content-type: application/json' -H 'x-principal-id: formal-binding-pi' -d "$PROTOCOL_BODY")
PROTOCOL_ID=$(jfield '.record.protocol_id' < "$WORK/protocol.json")
PROTOCOL_HASH=$(jfield '.record.canonical_hash' < "$WORK/protocol.json")
if [[ "$PROTOCOL_CODE" == "201" && -n "$PROTOCOL_ID" && -n "$PROTOCOL_HASH" ]]; then
  ok "frozen Protocol registered before the formal Job"
else
  bad "frozen Protocol expected HTTP 201, got HTTP $PROTOCOL_CODE"
fi
CODE=$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ1/jobs" -H 'content-type: application/json' -d "{\"idempotency_key\":\"fb-e\",\"kind\":\"formal\",\"contract_id\":\"$CT_OK\",\"code_snapshot_id\":\"$CODE_ART\",\"data_artifact_ids\":[\"$DATA_ART\"],\"image_digest\":\"$IMG\",\"run_intent\":\"confirmatory\",\"protocol_pin\":{\"protocol_id\":\"$PROTOCOL_ID\",\"revision\":1,\"canonical_hash\":\"$PROTOCOL_HASH\"},\"payload\":{\"message\":\"x\"}}")
STATUS=$(jfield '.status' < "$WORK/resp.json")
CONTRACT_BOUND=$(jfield '.contract_id' < "$WORK/resp.json")
METRIC_INJECTED=$(jfield '.payload.contract_metrics[0]' < "$WORK/resp.json")
FINAL_ERROR=$(jfield '.error.code' < "$WORK/resp.json")
if [[ "$CODE" == "201" && "$STATUS" == "queued" && "$CONTRACT_BOUND" == "$CT_OK" && "$METRIC_INJECTED" == "m" ]]; then
  ok "formal job with approved contract -> HTTP 201 queued, contract bound, contract_metrics injected"
else
  bad "expected 201 queued with contract binding, got HTTP $CODE error=$FINAL_ERROR status=$STATUS contract=$CONTRACT_BOUND metrics=$METRIC_INJECTED"
fi

say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
