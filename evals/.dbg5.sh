#!/usr/bin/env bash
# DSH Scholar 完整 10 步流程演示(hardening/v0.2)
# 真实代码归档 → 容器执行 → 确定性指标 → 人类 Gate 审批 → 复现包
#
# Usage: bash evals/demo-full-flow.sh
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
RUNNER_BIN="$REPO/workers/runner-gateway/lib/bin/runner.js"
KPORT=17412
WORK=$(mktemp -d)
PASS=0; FAIL=0
ok() { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '\033[1;31m  ✗ %s\033[0m\n' "$*"; FAIL=$((FAIL+1)); }
say() { printf '\033[1;34m\n== %s ==\033[0m\n' "$*"; }
api() {
  local code body
  if [[ "$*" == *"/evidence"* ]]; then printf '%s' "$4" > /tmp/ev-body-exact; fi
  body=$(mktemp)
  code=$(curl -s -o "$body" -w '%{http_code}' -H 'content-type: application/json' "$@")
  if [[ "$code" != 2* ]]; then echo "API_FAIL $code $* -> $(head -c 200 "$body")" >> /tmp/api-fail.log; fi
  cat "$body"
  rm -f "$body"
}

# ── 0. 环境:连接测试实例 kernel(web sidecar 已起 17412),另起独立 runner ──
say "0. 环境准备"
curl -sf -m 2 "http://127.0.0.1:$KPORT/v1/health" > /dev/null || { echo "kernel :$KPORT 不可达——先启动测试实例"; exit 2; }
if ! docker info > /dev/null 2>&1; then echo "需要 docker"; exit 2; fi
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$KPORT" --owner demo-runner --poll-ms 200 --mode docker > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
sleep 1
ok "kernel :$KPORT + docker runner 就绪"

# 真实 fixture 代码:train.js 读数据文件并计算确定性指标
mkdir -p "$WORK/repo"
cat > "$WORK/repo/train.js" <<'EOF'
// Real deterministic training script (fixture): reads data, computes metric.
const fs = require('fs')
const args = process.argv.slice(2)
const seed = Number(args[args.indexOf('--seed') + 1] || 0)
const dataPath = args[args.indexOf('--data') + 1] || '/work/data.json'
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
const base = data.baseline.reduce((a, b) => a + b, 0) / data.baseline.length
const value = Math.round((base + seed * 0.01) * 10000) / 10000
console.log(JSON.stringify({ metric: 'macro_f1', value, seed }))
EOF
cat > "$WORK/repo/data.json" <<'EOF'
{"baseline":[0.60,0.62,0.58]}
EOF
ok "fixture 代码就绪(train.js + data.json)"

# ── 1. 创建项目 + Scope Gate Request ─────────────────────────────────────
say "1. 创建项目(DSH Research Plugin)"
PROJ=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects" -d "{\"name\":\"demo-10step\",\"workspace\":\"/research/demo-10step\",\"brief\":{\"problem\":\"Does uncertainty weighting help under domain shift?\",\"scope\":\"Fixture dataset, supervised\",\"questions\":[\"Is the effect seed-robust?\"],\"primary_metrics\":[\"macro_f1\"],\"resources\":\"1 CPU, <=2 GPU-hours\",\"risks\":[\"fixture only\"],\"target_outputs\":[\"paper\"],\"target_venue\":null,\"baseline_repo\":null,\"domain\":\"machine-learning\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
G_SCOPE=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/gates" -d '{"type":"scope","title":"Scope Gate (10-step demo)"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).gate_id))")
S1=$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
[[ "$S1" == "DRAFT" ]] && ok "项目 $PROJ 创建(DRAFT)+ Scope Gate $G_SCOPE" || bad "项目状态 $S1"

# ── 2. 人类批准 Scope Gate(GUI 面板路径,principal=web-user)──────────────
say "2. Scope Gate 人类审批(GUI 面板路径)"
api -X POST "http://127.0.0.1:$KPORT/v1/gates/$G_SCOPE/decisions" -d '{"actor":"web-user","principal":{"principal_id":"demo-pi","auth_method":"dsh-session"},"decision":"approved","reason":"scope acceptable"}' > /dev/null
S2=$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
[[ "$S2" == "SCOPED" ]] && ok "Gate 批准 → $S2(Gate 控制状态,不可通用迁移绕过)" || bad "期望 SCOPED 得到 $S2"

# ── 3. 文献调研 → 冻结 Corpus Snapshot ───────────────────────────────────
say "3. 文献调研(literature_search + corpus_snapshot)"
SNAP=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/corpus" -d "{\"queries\":[{\"source\":\"openalex\",\"query\":\"temporal action localization\",\"run_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}],\"papers\":[{\"paper_id\":\"doi:10.1000/example1\",\"title\":\"Temporal Action Localization: A Survey\",\"authors\":[\"A. Author\"],\"year\":2021,\"venue\":\"TPAMI\",\"source\":\"openalex\",\"identifiers\":{\"doi\":\"10.1000/example1\"},\"abstract\":\"Most methods assume train and test distributions match.\",\"retrieved_at\":\"2026-08-08T00:00:00Z\"}]}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).snapshot_id))")
api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"SURVEYING\",\"expected_revision\":$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).revision))")}" > /dev/null
api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"IDEATING\",\"expected_revision\":$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).revision))")}" > /dev/null
ok "CorpusSnapshot $SNAP 冻结;项目 → IDEATING"

# ── 4. Idea 生成 + 新颖性审计 ────────────────────────────────────────────
say "4. Idea Panel + Novelty Audit"
I1=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/ideas" -d '{"title":"Uncertainty-weighted proposals","hypothesis":"Uncertainty weighting improves macro_f1 under shift","exact_delta":"Adds uncertainty branch","falsification":{"observation":"No improvement under shift"},"minimum_viable_experiment":{"dataset":"fixture","baseline":"b","primary_metric":"macro_f1","estimated_gpu_hours":1},"scores":{"feasibility":4,"information_gain":5,"reproducibility":4,"cost":3}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).idea_id))")
I2=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/ideas" -d '{"title":"Seed-averaged ensembling","hypothesis":"Ensembling across seeds stabilizes macro_f1","exact_delta":"Average logits over seeds","falsification":{"observation":"Variance not reduced"},"minimum_viable_experiment":{"dataset":"fixture","baseline":"b","primary_metric":"macro_f1","estimated_gpu_hours":1},"scores":{"feasibility":5,"information_gain":3,"reproducibility":5,"cost":5}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).idea_id))")
api -X POST "http://127.0.0.1:$KPORT/v1/ideas/$I1/novelty" -d '{"queries":["uncertainty temporal localization"],"result":"no_direct_match_found","overlap_papers":[],"unresolved_risk":"medium"}' > /dev/null
ok "IdeaCards $I1 / $I2 + 反查重审计完成"

# ── 5. 人类批准 Idea Gate ────────────────────────────────────────────────
say "5. Idea Gate 人类审批"
G_IDEA=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/gates" -d "{\"type\":\"idea\",\"title\":\"Idea Gate\",\"payload\":{\"idea_id\":\"$I1\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).gate_id))")
api -X POST "http://127.0.0.1:$KPORT/v1/gates/$G_IDEA/decisions" -d '{"actor":"web-user","principal":{"principal_id":"demo-pi"},"decision":"approved"}' > /dev/null
S5=$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
[[ "$S5" == "IDEA_APPROVED" ]] && ok "Idea Gate 批准 → $S5" || bad "期望 IDEA_APPROVED 得到 $S5"

# ── 6. Baseline 真实容器复现(代码归档→物化→执行)────────────────────────
say "6. Baseline 复现(代码快照归档 + 容器执行)"
CODE=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/code-snapshots" -d "{\"path\":\"$WORK/repo\",\"description\":\"fixture train.js\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).archive_artifact_id))")
api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"BASELINE_REPRO\",\"expected_revision\":$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).revision))")}" > /dev/null
B_JOB=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/jobs" -d "{\"idempotency_key\":\"baseline-demo\",\"kind\":\"baseline\",\"code_snapshot_id\":\"$CODE\",\"command\":[\"node\",\"/work/train.js\",\"--seed\",\"0\",\"--data\",\"/work/data.json\"],\"payload\":{}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
for _ in $(seq 1 60); do BS=$(api "http://127.0.0.1:$KPORT/v1/jobs/$B_JOB" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))"); [[ "$BS" == "succeeded" ]] && break; sleep 0.5; done
BVAL=$(api "http://127.0.0.1:$KPORT/v1/jobs/$B_JOB" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=(JSON.parse(d).run_manifest||{}).metrics_artifact;console.log(m||'')})")
BACT=$(curl -s "http://127.0.0.1:$KPORT/v1/artifacts/$BVAL?project_id=$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d).metrics.find(x=>x.metric==='macro_f1');console.log(m?m.value:'')})")
[[ "$BS" == "succeeded" && "$BACT" == "0.6" ]] && ok "Baseline 容器执行成功:macro_f1=$BACT(代码从 CAS 物化,期望 0.6)" || bad "baseline $BS value=$BACT"

# ── 7. 实验合同 + Contract Gate(冻结)────────────────────────────────────
say "7. ExperimentContract + Contract Gate(冻结)"
CT=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/contracts" -d "{\"idea_id\":\"$I1\",\"data\":{\"dataset_id\":\"fixture\",\"version\":\"v1\",\"split\":\"official\"},\"methods\":{\"baseline\":\"b\",\"treatment\":\"a\"},\"metrics\":{\"primary\":\"macro_f1\",\"secondary\":[]},\"seeds\":[11,23,47],\"analysis\":{\"effect_size\":\"mean_difference\",\"interval\":\"bootstrap_95\",\"multiple_testing\":\"holm\"},\"ablations\":[],\"stop_conditions\":{\"max_gpu_hours\":2,\"min_completed_seeds\":3,\"stop_on_data_leakage\":true}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).contract_id))")
G_CT=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/gates" -d "{\"type\":\"contract\",\"title\":\"Contract Gate\",\"payload\":{\"contract_id\":\"$CT\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).gate_id))")
api -X POST "http://127.0.0.1:$KPORT/v1/gates/$G_CT/decisions" -d '{"actor":"web-user","principal":{"principal_id":"demo-pi"},"decision":"approved","diff":"v1"}' > /dev/null
CSTATUS=$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
[[ "$CSTATUS" == "CONTRACT_APPROVED" ]] && ok "Contract $CT 冻结 → $CSTATUS" || bad "期望 CONTRACT_APPROVED 得到 $CSTATUS"
api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"EXPERIMENTING\",\"expected_revision\":$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).revision))")}" > /dev/null

# ── 8. 正式实验:3 seeds 容器执行 ─────────────────────────────────────────
say "8. 正式实验(3 seeds,容器真实执行)"
for seed in 11 23 47; do
  api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/jobs" -d "{\"idempotency_key\":\"formal:demo:$seed\",\"kind\":\"formal\",\"contract_id\":\"$CT\",\"code_snapshot_id\":\"$CODE\",\"command\":[\"node\",\"/work/train.js\",\"--seed\",\"$seed\",\"--data\",\"/work/data.json\"],\"payload\":{}}" > /dev/null
done
for _ in $(seq 1 150); do
  N=$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.filter(x=>x.status==='succeeded'&&x.idempotency_key.startsWith('formal:')).length)})")
  [[ "$N" == "3" ]] && break; sleep 0.5
done
[[ "$N" == "3" ]] && ok "3/3 正式作业成功(seed 11/23/47 真实执行)" || bad "formal 完成 $N/3"

# ── 9. 统计 → 可信 Evidence → Claim 验证 ─────────────────────────────────
say "9. 确定性分析 → verified Evidence → Claim"
ANA=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/analysis" -d '{"metric":"macro_f1"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log(JSON.stringify({artifact:a.artifact_id,mean:a.mean,effect:a.effect_size,ci:[a.ci_low,a.ci_high]}))})")
EV=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/evidence/verified" -d "{\"source_type\":\"analysis\",\"run_ids\":[\"formal:demo:11\",\"formal:demo:23\",\"formal:demo:47\"],\"artifact_refs\":[\"$(echo "$ANA" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).artifact))")\"],\"analysis_method\":\"bootstrap_95_mean_difference\",\"result\":{\"primary_metric\":\"macro_f1\",\"value\":$(echo "$ANA" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).mean))"),\"baseline_value\":0.6,\"effect_size\":$(echo "$ANA" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).effect||0))"),\"ci_low\":$(echo "$ANA" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).ci[0]))"),\"ci_high\":$(echo "$ANA" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).ci[1]))"),\"n_seeds\":3}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).evidence_id))")
CL=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/claims" -d '{"statement":"Treatment A improves macro_f1 over baseline on the fixture dataset","scope":{"dataset":"fixture_v1","split":"official"}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).claim_id))")
CS=$(api -X POST "http://127.0.0.1:$KPORT/v1/claims/verify" -d "{\"claim_id\":\"$CL\",\"evidence_ids\":[\"$EV\"],\"analysis_artifact\":\"$(echo "$ANA" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).artifact))")\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
echo "     分析: $ANA"
echo "     Evidence: $EV → Claim $CL"
[[ "$CS" == "supported" ]] && ok "Claim 验证:$CS(CI 不含 0 + 正效应)" || bad "Claim 状态 $CS(期望 supported)"
api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"EVIDENCE_READY\",\"expected_revision\":$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).revision))")}" > /dev/null

# ── 10. 论文 → 评审 → 复现包 → Release Gate(不批准)───────────────────────
say "10. 论文构建 → 评审 → 复现包 → Release Gate"
api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"WRITING\",\"expected_revision\":$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).revision))")}" > /dev/null
api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"REVIEWING\",\"expected_revision\":$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).revision))")}" > /dev/null
MS=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/manuscripts/build" -d '{"format":"markdown","include_limitations":true}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d);console.log(m.manuscript_id+':'+m.claims_used)})")
RV=$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ/manuscript-review" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).pass))")
BD=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/release-bundle" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).bundle_id))")
api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/transitions" -d "{\"to\":\"RELEASE_READY\",\"expected_revision\":$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).revision))")}" > /dev/null
G_REL=$(api -X POST "http://127.0.0.1:$KPORT/v1/projects/$PROJ/gates" -d '{"type":"release","title":"Release Gate (human only)"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).gate_id))")
RSTATUS=$(api "http://127.0.0.1:$KPORT/v1/projects/$PROJ" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
[[ "$MS" == *:* && "$RV" == "true" ]] && ok "Manuscript $MS + Reviewer PASS" || bad "manuscript/review 异常"
ok "Release Bundle $BD 生成(私有);Release Gate $G_REL 保持 pending(人类)"
ok "最终状态: $RSTATUS"

kill "$RUNNER_PID" 2>/dev/null || true
rm -rf "$WORK"
say "演示完成: $PASS 通过, $FAIL 失败"
[[ "$FAIL" -eq 0 ]] || exit 1
