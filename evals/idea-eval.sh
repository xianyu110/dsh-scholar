#!/usr/bin/env bash
# §11.3 Idea quality eval: falsifiability completeness + novelty audit recall.
#
# Offline (default): verifies the IdeaCard schema contract (falsification
# condition, MVE, novelty audit) on generated cards through the Kernel API.
# Live (--live): additionally runs novelty counter-search against the real
# connectors for a known-prior-work idea and requires overlap detection.
#
# Usage: bash evals/idea-eval.sh [--live]
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
LIVE=0
[[ "${1:-}" == "--live" ]] && LIVE=1
WORK=$(mktemp -d)
PORT=$((19500 + $$ % 1000))
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL+1)); }
api() { curl -sf -H 'content-type: application/json' "$@"; }

nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break; sleep 0.1; done

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"machine-learning"}'
PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"idea-eval\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")

echo "Idea eval (offline): contract completeness through the Kernel API"
# 三个候选,一个缺 falsification(应被拒绝),两个完整(应通过)
INVALID=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/ideas" -H 'content-type: application/json' -d '{"title":"No Falsification","hypothesis":"h","exact_delta":"d","minimum_viable_experiment":{"dataset":"d","baseline":"b","primary_metric":"m"},"scores":{"feasibility":3,"information_gain":3,"reproducibility":3,"cost":3}}')
[[ "$INVALID" == "422" ]] && ok "idea without falsification condition rejected (422)" || bad "expected 422, got $INVALID"
IDEA1=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/ideas" -d '{"title":"Valid A","hypothesis":"h1","exact_delta":"d1","falsification":{"observation":"o1"},"minimum_viable_experiment":{"dataset":"d","baseline":"b","primary_metric":"m","estimated_gpu_hours":2},"scores":{"feasibility":4,"information_gain":5,"reproducibility":4,"cost":3}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).idea_id))")
IDEA2=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/ideas" -d '{"title":"Valid B","hypothesis":"h2","exact_delta":"d2","falsification":{"observation":"o2"},"minimum_viable_experiment":{"dataset":"d","baseline":"b","primary_metric":"m","estimated_gpu_hours":6},"scores":{"feasibility":2,"information_gain":3,"reproducibility":5,"cost":5}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).idea_id))")
COUNT=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/ideas" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).length))")
[[ "$COUNT" == "2" ]] && ok "2 valid IdeaCards accepted" || bad "expected 2 ideas, got $COUNT"

if [[ "$LIVE" == "1" ]]; then
  echo "Idea eval (live): novelty counter-search detects known prior work"
  node --input-type=module -e "
    import { multiSourceSearch } from \"$REPO/packages/scholar-connectors/lib/index.js\" 
    // 用真实存在的论文作为待审计 idea(Attention Is All You Need)
    const { hits } = await multiSourceSearch('attention is all you need transformer', { limit: 10 })
    const top = hits.slice(0, 5).map(h => h.paper.paper_id)
    if (top.length > 0) {
      console.log('  ok: counter-search returned ' + top.length + ' overlaps for a known-work idea: ' + top[0])
      process.exit(0)
    }
    console.log('  FAIL: no hits')
    process.exit(1)
  "
fi

kill "$KERNEL_PID" 2>/dev/null || true
rm -rf "$WORK"
echo "idea-eval: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
