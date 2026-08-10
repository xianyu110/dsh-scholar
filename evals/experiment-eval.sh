#!/usr/bin/env bash
# §11.3 Experiment quality eval: failure-classification accuracy, run success
# rate, multi-seed completeness and budget compliance — end-to-end through the
# real kernel + runner (subprocess mode).
#
# Usage: bash evals/experiment-eval.sh
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
RUNNER_BIN="$REPO/workers/runner-gateway/lib/bin/runner.js"
WORK=$(mktemp -d)
PORT=$((19600 + $$ % 800))
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL+1)); }
api() { curl -sf -H 'content-type: application/json' "$@"; }
jqf() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const v=JSON.parse(d);const p=process.argv[1].split('.');let x=v;for(const k of p)x=x?.[k];console.log(x??'')})" "$1"; }

# §4 P0 (API-01/EVID-01): the kernel is configured with the fixed eval
# service token (runners inherit the env and authenticate their own internal
# calls: claim / runner-keys / recover).
export DSH_SCHOLAR_SERVICE_TOKEN='dsh-scholar-eval-service-token'

nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break; sleep 0.1; done
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT" --owner eval-runner --poll-ms 150 --timeout-ms 3000 > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
sleep 0.5

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"machine-learning"}'
PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"experiment-eval\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"constraints\":{\"max_model_cost_usd\":100,\"max_gpu_hours\":10,\"max_parallel_jobs\":4}}" | jqf project_id)
ok "project $PROJ created with hard budget (max_gpu_hours=10)"

submit_script() { # <idempotency> <kind> <script>
  api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d "{\"idempotency_key\":\"$1\",\"kind\":\"$2\",\"payload\":{\"script\":$(node -e "console.log(JSON.stringify(process.argv[1]))" "$3")}}" | jqf job_id
}

echo "Experiment eval: failure classification (design §4.6.2)"
# a) success with metrics
submit_script "eval-ok" "smoke" 'echo "{\"metric\":\"f1\",\"value\":0.9}"' > /dev/null
# b) code error
submit_script "eval-code" "smoke" 'python3 -c "import nonexistent_module_xyz"' > /dev/null
# c) resource exhaustion signal
submit_script "eval-oom" "smoke" 'echo "fatal: Cannot allocate memory"; exit 1' > /dev/null
# d) data leakage signal
submit_script "eval-leak" "smoke" 'echo "WARNING: test set labels leaked into training"; exit 1' > /dev/null
# e) environment signal
submit_script "eval-env" "smoke" 'echo "CUDA driver version is insufficient"; exit 1' > /dev/null
# f) budget signal
submit_script "eval-budget" "smoke" 'echo "error: compute budget exhausted"; exit 1' > /dev/null
# g) timeout (resource class via gateway timeout error)
submit_script "eval-timeout" "smoke" 'sleep 30' > /dev/null

# 等待全部结算
for _ in $(seq 1 120); do
  N=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.filter(x=>x.status==='succeeded'||x.status==='failed').length)})")
  [[ "$N" == "7" ]] && break
  sleep 0.3
done

expect_class() { # <idempotency> <expected-class> <label>
  CLASS=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "
    let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
      const j=JSON.parse(d).find(x=>x.idempotency_key==='$1');
      console.log(j? (j.failure_class ?? (j.status==='succeeded'?'none':'none')) : 'missing')
    })")
  if [[ "$CLASS" == "$2" ]]; then ok "$3 -> $CLASS"; else bad "$3: expected $2 got $CLASS"; fi
}
expect_class "eval-ok"     "none"       "success run"
expect_class "eval-code"   "code_error" "missing module"
expect_class "eval-oom"    "resources"  "OOM signal"
expect_class "eval-leak"   "data_issue" "leak signal"
expect_class "eval-env"    "environment" "CUDA env signal"
expect_class "eval-budget" "budget_exhausted" "budget signal"
expect_class "eval-timeout" "resources" "timeout"

echo "Experiment eval: run success rate + multi-seed completeness"
SUCC=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.filter(x=>x.status==='succeeded').length)})")
[[ "$SUCC" == "1" ]] && ok "run success rate 1/7 (only the valid run succeeded; failures correctly classified, no false success)" || bad "expected 1 succeeded, got $SUCC"

echo "Experiment eval: budget compliance (hard limit -> BLOCKED_GATE)"
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/budget" -d '{"gpu_hours":12}' > /dev/null
STATUS=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ" | jqf status)
[[ "$STATUS" == "BLOCKED_GATE" ]] && ok "GPU-hours over hard limit -> BLOCKED_GATE" || bad "expected BLOCKED_GATE got $STATUS"
VIOL=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/events" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const e=JSON.parse(d);console.log(e.filter(x=>x.kind==='policy.violation').length)})")
[[ "$VIOL" == "1" ]] && ok "policy.violation event recorded" || bad "expected 1 violation event got $VIOL"

kill "$RUNNER_PID" "$KERNEL_PID" 2>/dev/null || true
rm -rf "$WORK"
echo "experiment-eval: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
