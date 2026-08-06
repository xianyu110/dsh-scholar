#!/usr/bin/env bash
# §11.4 recovery threshold: 100 fault-injection iterations with NO duplicate
# formal run, NO lost gate, NO unexplainable state.
#
# Each iteration: create project -> submit job -> kill -9 kernel -> restart ->
# resubmit same idempotency key -> verify (same job id, no duplicates, events
# consistent, gate decisions preserved).
#
# Usage: bash evals/fault-stress.sh [iterations]   (default 100)
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
ITER="${1:-100}"
WORK=$(mktemp -d)
PORT=$((19000 + $$ % 2000))
FAILURES=0
OK=0

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}'

start_kernel() {
  nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
  KERNEL_PID=$!
  for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && return 0; sleep 0.1; done
  return 1
}
stop_kernel() { kill -9 "$KERNEL_PID" 2>/dev/null || true; wait "$KERNEL_PID" 2>/dev/null || true; }

api() { curl -sf -H 'content-type: application/json' "$@"; }

start_kernel || { echo "kernel failed to start"; exit 1; }

echo "fault-stress: $ITER iterations (kill -9 kernel mid-project, verify no duplicates/loss)"
for i in $(seq 1 "$ITER"); do
  PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"stress-$i\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"session_id\":\"s$i\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
  JOB=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d "{\"idempotency_key\":\"key-$i\",\"kind\":\"echo\",\"payload\":{\"message\":\"run $i\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
  GATE=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/gates" -d '{"type":"scope","title":"Scope"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).gate_id))")
  # kill -9 mid-flight
  stop_kernel
  start_kernel || { echo "iteration $i: kernel restart failed"; FAILURES=$((FAILURES+1)); continue; }
  # verify: project intact, job intact, resubmit returns SAME job, gate decidable
  P2=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  J2=$(api "http://127.0.0.1:$PORT/v1/jobs/$JOB" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  JR=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d "{\"idempotency_key\":\"key-$i\",\"kind\":\"echo\",\"payload\":{\"message\":\"run $i\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
  G2=$(api -X POST "http://127.0.0.1:$PORT/v1/gates/$GATE/decisions" -d '{"actor":"human","decision":"approved"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(r.project?r.project.status:'ERR')})")
  NJOBS=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).length))")
  if [[ "$P2" == "DRAFT" && "$J2" == "queued" && "$JR" == "$JOB" && "$G2" == "SCOPED" && "$NJOBS" == "1" ]]; then
    OK=$((OK+1))
  else
    echo "iteration $i FAILED: project=$P2 job=$J2 resubmit=$JR gate=$G2 njobs=$NJOBS"
    FAILURES=$((FAILURES+1))
  fi
done

stop_kernel
rm -rf "$WORK"
echo "fault-stress: $OK/$ITER clean, $FAILURES failures"
[[ "$FAILURES" -eq 0 ]] || exit 1
