#!/usr/bin/env bash
# §11.3 Baseline quality eval: reproduction success within tolerance and
# deviation recording (design §4.6 step 2, reproduce-first §1.3). Drives the
# same data path as the baseline_verify tool: baseline job -> RunManifest
# metrics artifact -> deviation vs expected -> pass/fail verdict.
#
# Usage: bash evals/baseline-eval.sh
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
RUNNER_BIN="$REPO/workers/runner-gateway/lib/bin/runner.js"
WORK=$(mktemp -d)
PORT=$((19700 + $$ % 600))
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL+1)); }
api() { curl -sf -H 'content-type: application/json' "$@"; }

nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break; sleep 0.1; done
if ! docker info > /dev/null 2>&1; then echo "baseline-eval requires docker (formal jobs are container-only)"; exit 2; fi
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT" --owner eval-baseline --poll-ms 150 --mode docker > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
sleep 1

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":"https://github.com/example/baseline","domain":"machine-learning"}'

reproduce() { # <idempotency> <metric-value>
  api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d "$(node -e "console.log(JSON.stringify({idempotency_key: process.argv[1], kind: 'smoke', payload: { script: \"echo '\" + JSON.stringify({metric: 'f1', value: Number(process.argv[2]), seed: 0}) + \"'\" }}))" "$1" "$2")" > /dev/null
}

verify() { # <job-key> <expected> <tolerance>
  PORT="$PORT" PROJ="$PROJ" api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | PORT="$PORT" PROJ="$PROJ" EXPECTED="$2" TOLERANCE="$3" node --input-type=module -e "
    let d='';process.stdin.on('data',c=>d+=c).on('end',async()=>{
      const jobs=JSON.parse(d)
      const job=jobs.find(x=>x.idempotency_key==='$1')
      if(!job){console.log('no job');process.exit(1)}
      const art=job.run_manifest?.metrics_artifact
      if(!art){console.log('no metrics artifact');process.exit(1)}
      const res=await fetch('http://127.0.0.1:'+process.env.PORT+'/v1/artifacts/'+encodeURIComponent(art)+'?project_id='+process.env.PROJ)
      const txt=await res.text()
      const parsed=JSON.parse(txt)
      const m=(parsed.metrics||[]).find(x=>x.metric==='f1')
      if(!m){console.log('no f1 metric in '+txt.slice(0,200));process.exit(1)}
      const expected=Number(process.env.EXPECTED), tol=Number(process.env.TOLERANCE)
      const rel=Math.abs(m.value-expected)/Math.abs(expected)
      const pass=rel<=tol
      console.log(JSON.stringify({actual:m.value,expected,tolerance:tol,relative_deviation:Math.round(rel*10000)/10000,pass}))
    })"
}

PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"baseline-eval\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
ok "project $PROJ with baseline repo"

echo "Baseline eval: reproduction within tolerance"
reproduce "bl-good" 0.8123
for _ in $(seq 1 60); do
  S=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).find(x=>x.idempotency_key==='bl-good');console.log(j?.status)})")
  [[ "$S" == "succeeded" ]] && break
  sleep 0.3
done
R1=$(verify "bl-good" 0.8 0.05)
echo "$R1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const v=JSON.parse(d); if(v.pass){console.log('  ok: baseline f1='+v.actual+' vs expected '+v.expected+' (dev '+v.relative_deviation+' <= tol '+v.tolerance+') — reproduction accepted')} else {console.log('  FAIL: unexpected rejection', JSON.stringify(v))}; process.exit(v.pass?0:1)})" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo "Baseline eval: out-of-tolerance deviation is flagged, not silently accepted"
reproduce "bl-bad" 0.9137
for _ in $(seq 1 60); do
  S=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).find(x=>x.idempotency_key==='bl-bad');console.log(j?.status)})")
  [[ "$S" == "succeeded" ]] && break
  sleep 0.3
done
R2=$(verify "bl-bad" 0.8 0.05)
echo "$R2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const v=JSON.parse(d); if(!v.pass){console.log('  ok: deviation '+v.relative_deviation+' > tol '+v.tolerance+' flagged — comparisons blocked')} else {console.log('  FAIL: out-of-tolerance accepted', JSON.stringify(v))}; process.exit(v.pass?1:0)})" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

kill "$RUNNER_PID" "$KERNEL_PID" 2>/dev/null || true
rm -rf "$WORK"
echo "baseline-eval: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
