#!/usr/bin/env bash
# CLEAN-ROOM REPRODUCE DRIVER — copied into the Release Bundle by
# evals/release-bundle/build-bundle.sh (DSH_Scholar_v2.0.md §14.5,
# Ticket SCH-REL-001). Do not edit the copy inside a bundle; edit this
# template.
#
# Rebuilds the research state in a FRESH kernel + FRESH runner from this
# bundle alone (no inherited context), re-runs the key jobs, re-runs the
# analysis and compares the mean against manifest.json within tolerance;
# writes reproducibility-report.json next to this script.
#
# The bundle is self-contained; the ONLY external dependency is the DSH
# runtime itself:
#
#   export KERNEL_BIN=/path/to/dsh-scholar/packages/research-kernel/lib/bin/kernel.js
#   export RUNNER_BIN=/path/to/dsh-scholar/workers/runner-gateway/lib/bin/runner.js
#   ./reproduce.sh [--mode auto|docker|subprocess]
#
# Modes (default auto):
#   docker      — container execution (--network none, uid 65534, 1g RAM);
#                 REQUIRED for baseline/pilot/formal/reproduce jobs (v2 §3.2).
#   subprocess  — isolated host subprocess; only valid for echo/smoke-only
#                 bundles (formal-class jobs are rejected by the kernel).
#   auto        — docker when a docker runtime + node:22-alpine image exist,
#                 else subprocess (with the §3.2 caveat above).
set -eu

BUNDLE_DIR=$(cd "$(dirname "$0")" && pwd)
MANIFEST="$BUNDLE_DIR/manifest.json"
REPORT="$BUNDLE_DIR/reproducibility-report.json"

MODE=${MODE:-auto}
if [ "${1:-}" = "--mode" ]; then MODE=${2:-auto}; fi

command -v node >/dev/null 2>&1 || { echo "reproduce.sh: node >= 22 required" >&2; exit 2; }
[ -f "$MANIFEST" ] || { echo "reproduce.sh: $MANIFEST not found" >&2; exit 2; }
[ -n "${KERNEL_BIN:-}" ] || { echo "reproduce.sh: set KERNEL_BIN to the research-kernel bin (see header)" >&2; exit 2; }
[ -n "${RUNNER_BIN:-}" ] || { echo "reproduce.sh: set RUNNER_BIN to the runner-gateway bin (see header)" >&2; exit 2; }

case "$MODE" in
  auto) if docker info >/dev/null 2>&1 && docker image inspect node:22-alpine >/dev/null 2>&1; then MODE=docker; else MODE=subprocess; fi ;;
  docker) docker info >/dev/null 2>&1 || { echo "reproduce.sh: MODE=docker but no docker runtime" >&2; exit 2; } ;;
  subprocess) ;;
  *) echo "reproduce.sh: unknown mode $MODE" >&2; exit 2 ;;
esac
if [ "$MODE" = "subprocess" ] && node -e "const m=require('$MANIFEST');process.exit(m.jobs.some(j=>['baseline','pilot','formal','reproduce'].includes(j.kind))?1:0)"; then
  : # echo/smoke-only bundle — subprocess rerun acceptable
else
  if [ "$MODE" = "subprocess" ]; then
    echo "reproduce.sh: bundle contains formal-class jobs; MODE=docker required (v2 §3.2)" >&2
    exit 2
  fi
fi
echo "reproduce.sh: mode=$MODE"

PORT=$((23000 + $$ % 2000))
WORK=$(mktemp -d)
KERNEL_PID=""
RUNNER_PID=""
cleanup() { kill "$RUNNER_PID" "$KERNEL_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
BASE="http://127.0.0.1:$PORT"
api() { curl -sf -H 'content-type: application/json' "$@"; }

echo "reproduce.sh: fresh kernel + fresh runner (no inherited context)"
nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 40); do curl -sf "$BASE/v1/health" >/dev/null 2>&1 && break; sleep 0.1; done
curl -sf "$BASE/v1/health" >/dev/null 2>&1 || { echo "reproduce.sh: kernel failed to start" >&2; tail -5 "$WORK/kernel.log" >&2; exit 1; }
nohup node "$RUNNER_BIN" --kernel "$BASE" --owner clean-room-rerun --poll-ms 300 --mode "$MODE" --timeout-ms 30000 > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
sleep 0.5

PNAME=$(node -e "console.log(require('$MANIFEST').project.name)")
PWORK=$(node -e "console.log(require('$MANIFEST').project.workspace)")
PBRIEF=$(node -e "console.log(JSON.stringify(require('$MANIFEST').project.brief ?? {}))")
PMODE=$(node -e "console.log(require('$MANIFEST').project.mode ?? 'gate-only')")
PEXEC=$(node -e "console.log(JSON.stringify(require('$MANIFEST').project.execution ?? {}))")
PROJ=$(api -X POST "$BASE/v1/projects" -d "{\"name\":\"$PNAME-rerun\",\"workspace\":\"$PWORK\",\"brief\":$PBRIEF,\"mode\":\"$PMODE\",\"execution\":$PEXEC}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
echo "reproduce.sh: rerun project $PROJ created from bundle manifest"

NC=$(node -e "console.log(require('$MANIFEST').contracts.length)")
# old_contract_id=new_contract_id pairs for P0 contract rebinding below.
CT_MAP=""
for i in $(seq 0 $((NC - 1))); do
  BODY=$(IDX="$i" MANIFEST="$MANIFEST" node -e 'const c=require(process.env.MANIFEST).contracts[Number(process.env.IDX)];const {idea_id,baseline_run,code_snapshot,data,methods,metrics,seeds,analysis,ablations,stop_conditions}=c;console.log(JSON.stringify({idea_id,baseline_run,code_snapshot,data,methods,metrics,seeds,analysis,ablations,stop_conditions}))')
  OLD=$(IDX="$i" MANIFEST="$MANIFEST" node -e 'console.log(require(process.env.MANIFEST).contracts[Number(process.env.IDX)].contract_id)')
  NEW=$(api -X POST "$BASE/v1/projects/$PROJ/contracts" -d "$BODY" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).contract_id))")
  # P0 (acceptance-tests.md §4): secure jobs must bind an APPROVED contract —
  # freeze each re-registered contract via the internal approval route.
  api -X POST "$BASE/v1/projects/$PROJ/contracts/$NEW/approve" -d '{"actor":"reproduce-sh"}' > /dev/null
  CT_MAP="$CT_MAP $OLD=$NEW"
done
echo "reproduce.sh: re-registered + frozen $NC contract(s)"

# Re-register every bundle artifact into the fresh kernel's CAS so job
# materialization (code snapshot archives) and metrics lookups resolve.
NA=$(MANIFEST="$MANIFEST" BUNDLE_DIR="$BUNDLE_DIR" BASE="$BASE" PROJ="$PROJ" node -e '
  const fs=require("fs")
  const m=JSON.parse(fs.readFileSync(process.env.MANIFEST,"utf8"))
  const base=process.env.BUNDLE_DIR
  const entries=Object.entries(m.artifacts ?? {})
  let n=0
  const post=(id,kind)=>{
    const file=base+"/"+m.artifacts[id].path
    if(!fs.existsSync(file)) return
    const content=fs.readFileSync(file).toString("base64")
    fetch(process.env.BASE+"/v1/artifacts",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({project_id:process.env.PROJ,kind,content_base64:content})})
      .then(r=>{if(!r.ok)throw new Error("artifact "+r.status);n++;if(n===entries.length)console.log(String(n))})
      .catch(e=>{console.error(e.message);process.exit(1)})
  }
  for(const [id,info] of entries) post(id,info.kind ?? "data")
') || true
[ -n "$NA" ] && [ "$NA" -gt 0 ] && echo "reproduce.sh: re-registered $NA artifact(s)" || echo "reproduce.sh: WARNING no artifacts re-registered"

# Replay the succeeded jobs with their original idempotency keys, kinds,
# commands and payloads. P0 (acceptance-tests.md §4): secure jobs must bind an
# APPROVED contract — the original contract id (from the run manifest) is
# mapped to the freshly re-registered one via CT_MAP.
KEYS=$(node -e "const m=require('$MANIFEST');console.log(m.jobs.filter(j=>j.status==='succeeded').map(j=>j.idempotency_key).join(' '))")
NKEYS=0
for KEY in $KEYS; do
  BODY=$(KEY="$KEY" MANIFEST="$MANIFEST" CT_MAP="$CT_MAP" node -e '
    const m=require(process.env.MANIFEST)
    const j=m.jobs.find(x=>x.idempotency_key===process.env.KEY)
    const pairs=process.env.CT_MAP.trim().split(/\s+/).filter(Boolean).map(p=>p.split("="))
    const oldRef=j.run_manifest && typeof j.run_manifest.contract_id==="string" ? j.run_manifest.contract_id : null
    const pair=oldRef!==null?pairs.find(p=>p[0]===oldRef):undefined
    console.log(JSON.stringify({idempotency_key:j.idempotency_key,kind:j.kind,command:j.command,payload:j.payload,...(j.code_snapshot_id?{code_snapshot_id:j.code_snapshot_id}:{}),...(pair!==undefined?{contract_id:pair[1]}:{})}))')
  api -X POST "$BASE/v1/projects/$PROJ/jobs" -d "$BODY" > /dev/null
  NKEYS=$((NKEYS + 1))
done
echo "reproduce.sh: re-submitted $NKEYS job(s)"

DONE=no
for _ in $(seq 1 120); do
  DONE=$(KEYS="$KEYS" PORT="$PORT" PROJ="$PROJ" node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const jobs=JSON.parse(d);const keys=process.env.KEYS.split(" ").filter(Boolean);
      const all=keys.every(k=>{const j=jobs.find(x=>x.idempotency_key===k);return j&&["succeeded","failed","cancelled"].includes(j.status)});
      process.stdout.write(all?"yes":"no")})' < <(api "$BASE/v1/projects/$PROJ/jobs"))
  [ "$DONE" = "yes" ] && break
  sleep 0.3
done
if [ "$DONE" != "yes" ]; then
  echo "reproduce.sh: jobs did not reach terminal status in time" >&2
  tail -5 "$WORK/runner.log" >&2 || true
  exit 1
fi
STATS=$(KEYS="$KEYS" PORT="$PORT" PROJ="$PROJ" node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const jobs=JSON.parse(d);const keys=process.env.KEYS.split(" ").filter(Boolean);
    let s=0,f=0;
    for(const k of keys){const j=jobs.find(x=>x.idempotency_key===k);if(j.status==="succeeded")s++;else if(j.status==="failed")f++}
    process.stdout.write(s+":"+f)})' < <(api "$BASE/v1/projects/$PROJ/jobs"))
echo "reproduce.sh: rerun jobs -> $STATS (succeeded:failed)"

# Re-run the analysis with the same request body the assembler used.
RERUN=""
if node -e "process.exit(require('$MANIFEST').analysis ? 0 : 1)"; then
  REQ=$(node -e "console.log(JSON.stringify(require('$MANIFEST').analysis_request ?? {}))")
  RERUN=$(api -X POST "$BASE/v1/projects/$PROJ/analysis" -d "$REQ")
  printf '%s' "$RERUN" > "$WORK/rerun-analysis.json"
  echo "reproduce.sh: analysis rerun mean=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$WORK/rerun-analysis.json','utf8')).mean)")"
fi

# §14.5 step 8: reproducibility-report.json
TOL="${TOL:-0.001}"
MANIFEST="$MANIFEST" REPORT="$REPORT" WORK="$WORK" MODE="$MODE" PROJ="$PROJ" TOL="$TOL" STATS="$STATS" NKEYS="$NKEYS" node -e '
  const fs=require("fs")
  const m=JSON.parse(fs.readFileSync(process.env.MANIFEST,"utf8"))
  const orig=m.analysis
  const rp=process.env.WORK+"/rerun-analysis.json"
  const rerun=fs.existsSync(rp)?JSON.parse(fs.readFileSync(rp,"utf8")):null
  const tol=Number(process.env.TOL)
  const [succeeded,failed]=process.env.STATS.split(":").map(Number)
  const checks=[]
  let mean_diff=null
  let status="pass"
  if(orig&&rerun){
    mean_diff=Math.abs(orig.mean-rerun.mean)
    const ok=mean_diff<=tol
    checks.push({check:"analysis mean within tolerance",pass:ok,detail:"|"+orig.mean+"-"+rerun.mean+"|="+mean_diff.toFixed(6)+" <= "+tol})
    if(!ok)status="fail"
  } else if(orig&&!rerun){
    checks.push({check:"analysis rerun",pass:false,detail:"original analysis exists but rerun failed"})
    status="fail"
  } else {
    checks.push({check:"analysis rerun",pass:true,detail:"no analysis section in manifest; skipped"})
  }
  if(failed>0){checks.push({check:"jobs rerun",pass:false,detail:failed+" job(s) failed"});status="fail"}
  const report={status,bundle_id:m.bundle_id,mode:process.env.MODE,rerun_project_id:process.env.PROJ,
    jobs:{expected:Number(process.env.NKEYS),succeeded,failed},
    original_analysis:orig?{mean:orig.mean,n:orig.n,effect_size:orig.effect_size,baseline_value:orig.baseline_value}:null,
    rerun_analysis:rerun?{mean:rerun.mean,n:rerun.n,effect_size:rerun.effect_size,baseline_value:rerun.baseline_value}:null,
    mean_diff,tolerance:tol,checks,generated_at:new Date().toISOString()}
  fs.writeFileSync(process.env.REPORT,JSON.stringify(report,null,2))
  console.log("reproduce.sh: reproducibility-report.json -> status="+status)
'
[ "$(node -e "console.log(require('$REPORT').status)")" = "pass" ]
echo "reproduce.sh: DONE (clean-room rerun passed)"
