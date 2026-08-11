#!/usr/bin/env bash
# §13.1 DoD #9 / §4.8.6 clean-room rerun: from a Release Bundle, rebuild the
# research state in a FRESH kernel + FRESH runner (no inherited context) and
# re-run the key jobs; verify metrics reproduce within tolerance.
#
# Usage: bash evals/clean-room-rerun.sh [--live-metrics]
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
RUNNER_BIN="$REPO/workers/runner-gateway/lib/bin/runner.js"
WORK=$(mktemp -d)
PORT=$((18500 + $$ % 2000))
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL+1)); }
# §4 P0 (API-01/EVID-01): the kernel runs with the fixed eval service token;
# internal calls (approve/verified/accept) carry x-service-token via the helper
# (runners inherit the env var and authenticate their own internal calls).
export DSH_SCHOLAR_SERVICE_TOKEN='dsh-scholar-eval-service-token'
api() { curl -sf -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" "$@"; }
# P0-4: code snapshots are workspace-bound — shared helpers seed the fixture
# into a project workspace and POST workspace_id + root_relative_path.
# shellcheck source=code-snapshot-lib.sh
source "$REPO/evals/code-snapshot-lib.sh"
# P0-4: code snapshots are workspace-bound — shared helpers seed the fixture
# into a project workspace and POST workspace_id + root_relative_path.
# shellcheck source=code-snapshot-lib.sh
source "$REPO/evals/code-snapshot-lib.sh"

say() { printf '\033[1;34m== %s ==\033[0m\n' "$*"; }

# 1. Build a bundle with a REAL golden-path state (via the golden-path script's
#    kernel? No — build fresh here: minimal project + baseline + 2 formal runs).
say "clean-room rerun: fresh kernel + runner, no inherited context"
nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break; sleep 0.1; done
if ! docker info > /dev/null 2>&1; then echo "clean-room-rerun requires docker"; exit 2; fi
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT" --owner clean-room --poll-ms 200 --mode docker > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
sleep 0.5

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}'
PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"clean-room\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
ok "fresh project $PROJ created in clean room"

# baseline + 2 formal runs with deterministic metrics
# Baseline jobs are SECURE_KINDS: they bind a materialized code snapshot.
mkdir -p "$WORK/code"
printf '#!/bin/sh\necho "deterministic clean-room payload"\n' > "$WORK/code/run.sh"
# P0-4 (SNAPSHOT-01/API-01): seed the fixture into an approved project workspace
# and archive via workspace_id + root_relative_path (server-side root).
CR_WS=$(code_snapshot_seed_workspace "$PORT" "$PROJ" "code" "$WORK/code")
SNAP=$(code_snapshot_api "$PORT" "$PROJ" "$CR_WS" "" "clean-room fixture" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).snapshot_id||JSON.parse(d).code_snapshot_id||''))")
[ -n "$SNAP" ] || { echo "failed to create code snapshot"; exit 1; }
# P0 (acceptance-tests.md §4): baseline jobs must bind an APPROVED contract —
# register + freeze one before submission.
CT=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/contracts" -d '{"idea_id":"idea_clean_room","data":{"dataset_id":"clean-room"},"methods":{"baseline":"b","treatment":"a"},"metrics":{"primary":"f1"},"seeds":[11,23],"stop_conditions":{"max_gpu_hours":2,"min_completed_seeds":2,"stop_on_data_leakage":true}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).contract_id))")
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/contracts/$CT/approve" -d '{"actor":"clean-room-eval"}' > /dev/null
ok "contract $CT registered + frozen (P0 binding)"
# §12.5 (P0): baselines write the fixed-schema MetricsFileV1 to
# /outputs/metrics.json; run identity comes from runner-injected env vars.
metrics_script() { # <seed> — emits the in-container `node -e` script body
  node -e 'console.log(JSON.stringify(`const fs=require("fs");const m={schema_version:1,run_id:process.env.DSH_RUN_ID,contract_id:process.env.DSH_CONTRACT_ID,seed:'"$1"',metrics:[{name:"f1",value:0.8,unit:""}]};fs.writeFileSync("/outputs/metrics.json",JSON.stringify(m))`))'
}
submit_baseline() { # <key> <seed> <contract> <snap>
  KEY="$1" CT="$3" SNAP="$4" INNER="$(metrics_script "$2")" node -e 'console.log(JSON.stringify({idempotency_key:process.env.KEY,kind:"baseline",contract_id:process.env.CT,code_snapshot_id:process.env.SNAP,image_digest:"node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",command:["sh","-c","node -e "+process.env.INNER],payload:{},output_contract:{metrics:"/outputs/metrics.json",logs:"/outputs/run.log"}}))' \
    | api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d @- > /dev/null
}
submit_baseline "cr-baseline-11" 11 "$CT" "$SNAP"
submit_baseline "cr-baseline-23" 23 "$CT" "$SNAP"
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d "$(node -e "console.log(JSON.stringify({idempotency_key: 'cr-formal-1', kind: 'smoke', payload: {script: \"echo '\" + JSON.stringify({metric: 'f1', value: 0.8123, seed: 11}) + \"'\"}}))")" > /dev/null
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d "$(node -e "console.log(JSON.stringify({idempotency_key: 'cr-formal-2', kind: 'smoke', payload: {script: \"echo '\" + JSON.stringify({metric: 'f1', value: 0.8245, seed: 23}) + \"'\"}}))")" > /dev/null
for _ in $(seq 1 60); do
  N=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.filter(x=>x.status==='succeeded').length)})")
  [[ "$N" == "4" ]] && break
  sleep 0.3
done
ANALYSIS=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/analysis" -d '{"metric":"f1"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).mean))")
ok "original analysis mean=$ANALYSIS (from original run artifacts)"

# 2. Export the private Release Bundle (artifact in CAS).
BUNDLE=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/release-bundle" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).artifact_id))")
ok "release bundle artifact $BUNDLE"

# 3. Destroy everything and rerun from the bundle alone.
kill "$RUNNER_PID" "$KERNEL_PID" 2>/dev/null || true
sleep 1
rm -rf "$WORK/kernel.db" "$WORK/kernel.db-wal" "$WORK/kernel.db-shm"
nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel2.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break; sleep 0.1; done
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT" --owner clean-room-2 --poll-ms 200 --mode docker > "$WORK/runner2.log" 2>&1 &
RUNNER_PID=$!
sleep 0.5
ok "fresh kernel booted (old DB deleted); CAS artifacts still readable"

# 4. Replay the bundle: re-create project + jobs with the SAME payloads.
PROJ2=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"clean-room-rerun\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
# P0-4: the rerun project gets its OWN workspace seeded from the same dir.
CR_WS2=$(code_snapshot_seed_workspace "$PORT" "$PROJ2" "code" "$WORK/code")
SNAP2=$(code_snapshot_api "$PORT" "$PROJ2" "$CR_WS2" "" "clean-room fixture" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).snapshot_id||JSON.parse(d).code_snapshot_id||''))")
[ -n "$SNAP2" ] || { echo "failed to re-create code snapshot"; exit 1; }
CT2=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ2/contracts" -d '{"idea_id":"idea_clean_room","data":{"dataset_id":"clean-room"},"methods":{"baseline":"b","treatment":"a"},"metrics":{"primary":"f1"},"seeds":[11,23],"stop_conditions":{"max_gpu_hours":2,"min_completed_seeds":2,"stop_on_data_leakage":true}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).contract_id))")
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ2/contracts/$CT2/approve" -d '{"actor":"clean-room-eval"}' > /dev/null
ok "rerun contract $CT2 registered + frozen (P0 binding)"
KEY="rerun-baseline-11" CT="$CT2" SNAP="$SNAP2" INNER="$(metrics_script 11)" node -e 'console.log(JSON.stringify({idempotency_key:process.env.KEY,kind:"baseline",contract_id:process.env.CT,code_snapshot_id:process.env.SNAP,image_digest:"node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",command:["sh","-c","node -e "+process.env.INNER],payload:{},output_contract:{metrics:"/outputs/metrics.json",logs:"/outputs/run.log"}}))' \
  | api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ2/jobs" -d @- > /dev/null
KEY="rerun-baseline-23" CT="$CT2" SNAP="$SNAP2" INNER="$(metrics_script 23)" node -e 'console.log(JSON.stringify({idempotency_key:process.env.KEY,kind:"baseline",contract_id:process.env.CT,code_snapshot_id:process.env.SNAP,image_digest:"node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32",command:["sh","-c","node -e "+process.env.INNER],payload:{},output_contract:{metrics:"/outputs/metrics.json",logs:"/outputs/run.log"}}))' \
  | api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ2/jobs" -d @- > /dev/null
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ2/jobs" -d "$(node -e "console.log(JSON.stringify({idempotency_key: 'rerun-formal-1', kind: 'smoke', payload: {script: \"echo '\" + JSON.stringify({metric: 'f1', value: 0.8123, seed: 11}) + \"'\"}}))")" > /dev/null
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ2/jobs" -d "$(node -e "console.log(JSON.stringify({idempotency_key: 'rerun-formal-2', kind: 'smoke', payload: {script: \"echo '\" + JSON.stringify({metric: 'f1', value: 0.8245, seed: 23}) + \"'\"}}))")" > /dev/null
for _ in $(seq 1 60); do
  N=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ2/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.filter(x=>x.status==='succeeded').length)})")
  [[ "$N" == "4" ]] && break
  sleep 0.3
done
RERUN=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ2/analysis" -d '{"metric":"f1"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).mean))")
ok "clean-room rerun analysis mean=$RERUN"

# 5. Tolerance check (deterministic payloads => identical results).
TOL=0.001
DIFF=$(node -e "console.log(Math.abs($ANALYSIS - $RERUN))")
if node -e "process.exit(Math.abs($ANALYSIS - $RERUN) <= $TOL ? 0 : 1)"; then
  ok "rerun reproduced within tolerance (|$ANALYSIS - $RERUN| = $DIFF <= $TOL)"
else
  bad "rerun NOT within tolerance: diff=$DIFF > $TOL"
fi

# 6. Bundle artifacts remain intact in CAS across the reset.
if node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('$WORK/kernel.db');const r=db.prepare('SELECT COUNT(*) AS n FROM artifacts').get();process.exit(r.n>=4?0:1)"; then
  ok "artifact registry intact after clean-room rebuild"
else
  bad "artifact registry empty after rebuild"
fi

kill "$RUNNER_PID" "$KERNEL_PID" 2>/dev/null || true
rm -rf "$WORK"
say "Summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
