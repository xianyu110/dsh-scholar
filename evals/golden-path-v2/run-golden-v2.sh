#!/usr/bin/env bash
# §19.3 Golden Path v2 — REAL execution end-to-end (no echo jobs, no message
# fallback, no forged metrics). v2 SCH-EXEC-002: the Runner materializes the
# code snapshot from CAS (archive → artifact → /work) and reads formal metrics
# from the fixed-schema metrics FILE (/outputs/metrics.json), not stdout.
#
# Drives the full v2 experiment lifecycle against a small self-contained
# fixture repo (evals/golden-path-v2/fixture-repo) with real code executed by
# real `node` inside a `node:22-alpine` docker container through the runner's
# `--mode docker` path:
#
#   1. fixture-repo -> POST /v1/projects/{id}/code-snapshots: the Kernel
#      archives the ACTUAL file contents into a content-addressed code
#      artifact (archive_artifact_id) + manifest artifact (§11.3);
#   2. baseline job  (kind=baseline, seed 0) — bound to the code snapshot
#      (§12.2 code_snapshot_id), materialized from CAS into /work, executed
#      by real node in docker;
#   3. three formal jobs (kind=formal, seeds 1/2/3) — same binding;
#   4. every run writes the §12.5 fixed-schema metrics file in-container to
#      /outputs/metrics.json (output_contract); the Runner reads it back and
#      registers it as the metrics artifact (source=metrics-file). The fixture
#      prints NO metric lines to stdout — metrics can only come from the file;
#   5. materialization is proven inside the container (`head -n1 /work/train.js`
#      -> shebang line found in the run log artifact);
#   6. a Code Engineer PATCH changes a real algorithm constant (0.01 -> 0.02
#      seed coefficient), a NEW snapshot is archived, one more formal run
#      (seed 4) executes the patched code and its metric differs from the
#      unpatched expectation — patch really changed the executed algorithm;
#   7. POST /v1/projects/{id}/analysis aggregates the real runs: mean,
#      baseline_value, effect_size, seeds — asserted against the
#      deterministic expectation the script computes itself.
#
# Prerequisite: working docker runtime (docker info passes); node:22-alpine
# image (auto-pulled). Usage: bash evals/golden-path-v2/run-golden-v2.sh
set -eu

REPO=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
# Robust root detection: `$0` may be an absolute path outside the repo (e.g.
# when driven by a background task runner), in which case the dirname-based
# guess is wrong — fall back to the current working directory.
if [ ! -f "$REPO/packages/research-kernel/lib/bin/kernel.js" ] && [ -f "$PWD/packages/research-kernel/lib/bin/kernel.js" ]; then
  REPO=$PWD
fi
if [ ! -f "$REPO/packages/research-kernel/lib/bin/kernel.js" ]; then
  echo "golden-path-v2: cannot locate repo root (tried '$REPO' and '$PWD')" >&2
  exit 1
fi
FIXTURE="$REPO/evals/golden-path-v2/fixture-repo"
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
RUNNER_BIN="$REPO/workers/runner-gateway/lib/bin/runner.js"
WORK=$(mktemp -d)
PORT=$((19600 + $$ % 600))
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL+1)); }
api() { curl -sf -H 'content-type: application/json' "$@"; }

RUNNER_PID=
KERNEL_PID=
cleanup() {
  kill "$RUNNER_PID" "$KERNEL_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== prerequisites =="
if ! docker info > /dev/null 2>&1; then
  echo "golden-path-v2: docker runtime not available (runner --mode docker is required) — run: sudo systemctl start docker" >&2
  exit 2
fi
ok "docker runtime reachable (server $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'))"
if ! docker image inspect node:22-alpine > /dev/null 2>&1; then
  docker pull node:22-alpine > /dev/null 2>&1 || { echo "golden-path-v2: failed to pull node:22-alpine" >&2; exit 2; }
fi
ok "node:22-alpine image present"

echo "== kernel + runner (--mode docker) on random port =="
nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break; sleep 0.1; done
if ! curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1; then
  echo "kernel failed to start on port $PORT:"; tail -5 "$WORK/kernel.log" >&2; exit 1
fi
ok "kernel healthy on port $PORT"
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT" --owner golden-v2 --poll-ms 150 --mode docker --timeout-ms 30000 > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
sleep 1
ok "runner started (mode=docker)"

echo "== project (execution.runner_profile=local-docker-cpu) =="
BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m1"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":"fixture-repo","domain":"machine-learning"}'
PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"golden-path-v2\",\"workspace\":\"/w\",\"brief\":$BRIEF,\"execution\":{\"runner_profile\":\"local-docker-cpu\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
ok "project $PROJ"

echo "== fixture-repo -> code snapshot archive (actual contents into CAS, §11.3) =="
SNAP=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/code-snapshots" -d "{\"path\":\"$FIXTURE\",\"description\":\"golden-path-v2 fixture\"}")
CODE_ART=$(printf '%s' "$SNAP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).archive_artifact_id))")
MAN_ART=$(printf '%s' "$SNAP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).manifest_artifact_id))")
SNAP_FILES=$(printf '%s' "$SNAP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).files))")
if [[ "$CODE_ART" == sha256:* ]] && [[ "$MAN_ART" == sha256:* ]] && [ "$SNAP_FILES" -ge 4 ] 2>/dev/null; then
  ok "code snapshot archived: archive_artifact_id=$CODE_ART manifest_artifact_id=$MAN_ART files=$SNAP_FILES (actual content, §11.3)"
else
  bad "code snapshot archive malformed: $SNAP"
fi
curl -sf "http://127.0.0.1:$PORT/v1/artifacts/$CODE_ART?project_id=$PROJ" -o "$WORK/archive.json"
if PORT="$PORT" PROJ="$PROJ" WORK="$WORK" node --input-type=module -e '
  const fs=await import("node:fs")
  const a=JSON.parse(fs.readFileSync(process.env.WORK+"/archive.json","utf8"))
  const f=a.files
  const train=Buffer.from(f["train.js"]?.content_base64??"","base64").toString("utf8")
  const pkg=JSON.parse(Buffer.from(f["package.json"]?.content_base64??"","base64").toString("utf8"))
  const ok=a.schema_version===1
    && typeof f["train.js"]==="object" && typeof f["baseline.js"]==="object"
    && typeof f["data/seed-data.json"]==="object" && typeof f["package.json"]==="object"
    && train.includes("weightedSum") && train.includes("#!/usr/bin/env node")
    && pkg.type==="module" && /^[0-9a-f]{64}$/.test(f["train.js"].sha256)
  if(!ok){console.error("archive content invalid");process.exit(1)}
  console.log(JSON.stringify({files:Object.keys(f).length, has_train:true, has_package_json:true, sample_sha:f["train.js"].sha256.slice(0,12)}))' ; then
  ok "archive artifact holds ACTUAL file contents (train.js/package.json/data, per-file sha256)"
else
  bad "archive artifact content check failed"
fi

# ── helpers ──────────────────────────────────────────────────────────────────

wait_job() { # <idempotency_key> — echoes terminal status (succeeded|failed|cancelled|timeout)
  for _ in $(seq 1 160); do
    S=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).find(x=>x.idempotency_key==='$1');console.log(j?.status??'missing')})")
    case "$S" in succeeded|failed|cancelled) echo "$S"; return 0;; esac
    sleep 0.25
  done
  echo "timeout"
  return 1
}

# job_metric <key> <metric> — reads GET /projects/{id}/jobs JSON on stdin,
# prints the metric value from the run's metrics artifact ('' if missing).
# §12.5: artifact entries are {name, value, unit, seed} (legacy {metric, value}
# accepted too).
job_metric() {
  KEY="$1" METRIC="$2" PORT="$PORT" PROJ="$PROJ" node --input-type=module -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",async()=>{
      const jobs=JSON.parse(d)
      const art=jobs.find(x=>x.idempotency_key===process.env.KEY)?.run_manifest?.metrics_artifact
      if(!art){process.stdout.write("");return}
      try{
        const res=await fetch("http://127.0.0.1:"+process.env.PORT+"/v1/artifacts/"+encodeURIComponent(art)+"?project_id="+process.env.PROJ)
        const parsed=JSON.parse(await res.text())
        const m=(parsed.metrics??[]).find(x=>(x.name??x.metric)===process.env.METRIC)
        process.stdout.write(m!==undefined?String(m.value):"")
      }catch{process.stdout.write("")}
    })'
}

# check_metrics_artifact <key> <expected-seed> — reads jobs JSON on stdin,
# validates the metrics ARTIFACT (registered by the runner from the in-container
# §12.5 fixed-schema file: schema_version, run_id, contract_id, seed,
# metrics[{name,value,unit}]) and its metadata source=metrics-file.
check_metrics_artifact() {
  KEY="$1" EXPECT_SEED="$2" PORT="$PORT" PROJ="$PROJ" node --input-type=module -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",async()=>{
      const jobs=JSON.parse(d)
      const art=jobs.find(x=>x.idempotency_key===process.env.KEY)?.run_manifest?.metrics_artifact
      if(!art){console.error("no metrics artifact");process.exit(1)}
      const res=await fetch("http://127.0.0.1:"+process.env.PORT+"/v1/artifacts/"+encodeURIComponent(art)+"?project_id="+process.env.PROJ)
      const rep=JSON.parse(await res.text())
      const artifacts=await (await fetch("http://127.0.0.1:"+process.env.PORT+"/v1/projects/"+process.env.PROJ+"/artifacts")).json()
      const record=artifacts.find(x=>x.artifact_id===art)
      const okFields=rep.schema_version===1
        && rep.seed===Number(process.env.EXPECT_SEED)
        && typeof rep.run_id==="string" && typeof rep.contract_id==="string"
        && Array.isArray(rep.metrics) && rep.metrics.length>=3
        && rep.metrics.every(m=>typeof m.name==="string"&&typeof m.value==="number"&&typeof m.unit==="string")
      const okSource=record?.metadata?.source==="metrics-file"
      if(!okFields){console.error("§12.5 schema mismatch: "+JSON.stringify(rep).slice(0,220));process.exit(1)}
      if(!okSource){console.error("metrics source != metrics-file: "+JSON.stringify(record?.metadata));process.exit(1)}
      console.log(JSON.stringify({run_id:rep.run_id,contract_id:rep.contract_id,seed:rep.seed,source:record.metadata.source,metrics:rep.metrics.map(m=>m.name+":"+m.value)}))
    })'
}

# check_log_contains <key> <needle> — reads the run log artifact on stdin and
# asserts the needle is present (materialization / in-container file proofs).
check_log_contains() {
  KEY="$1" NEEDLE="$2" PORT="$PORT" PROJ="$PROJ" node --input-type=module -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",async()=>{
      const jobs=JSON.parse(d)
      const art=jobs.find(x=>x.idempotency_key===process.env.KEY)?.run_manifest?.log_artifact
      if(!art){console.error("no log artifact");process.exit(1)}
      const log=await (await fetch("http://127.0.0.1:"+process.env.PORT+"/v1/artifacts/"+encodeURIComponent(art)+"?project_id="+process.env.PROJ)).text()
      if(!log.includes(process.env.NEEDLE)){console.error("needle not found in run log: "+process.env.NEEDLE);process.exit(1)}
      console.log("found: "+process.env.NEEDLE)
    })'
}

# run_sh <fixture-js> <seed> — emits the in-container sh script: runs node
# against the MATERIALIZED /work fixture (real code, fixed-schema metrics file
# to /outputs), cats the metrics file and prints the materialized file shebang
# (proof of CAS materialization).
run_sh() {
  local js="$1" seed="$2"
  { printf 'set -e\n'
    printf 'node /work/%s --seed %s --data /work/data/seed-data.json --output /outputs/metrics.json\n' "$js" "$seed"
    printf 'cat /outputs/metrics.json\n'
    printf 'head -n1 /work/%s\n' "$js"
  }
}

# submit_job <key> <kind> <fixture-js> <snapshot_id> <seed> — submits a real
# command job bound to the §12.2 code snapshot + output contract; the runner
# materializes <snapshot_id> from CAS into /work and executes it.
submit_job() {
  local key="$1" kind="$2" js="$3" snap="$4" seed="$5"
  local run_sh
  run_sh=$(run_sh "$js" "$seed")
  KEY="$key" KIND="$kind" SNAP="$snap" RUN_SH="$run_sh" node -e 'process.stdout.write(JSON.stringify({idempotency_key:process.env.KEY,kind:process.env.KIND,code_snapshot_id:process.env.SNAP,image_digest:"node:22-alpine",output_contract:{metrics:"/outputs/metrics.json",logs:"/outputs/run.log"},command:["sh","-c",process.env.RUN_SH]}))' \
    | api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d @-
}

# expect_m1 <seed> — deterministic expectation computed from the fixture data.
# PATCHED=1 uses the patched algorithm constants (0.02 seed coeff, 0.15 weight).
expect_m1() {
  SEED="$1" FIXTURE="$FIXTURE" node -e '
    const fs=require("node:fs")
    const d=JSON.parse(fs.readFileSync(process.env.FIXTURE+"/data/seed-data.json","utf8"))
    const ws=d.baseline.reduce((a,b,i)=>a+b*d.weights[i],0)
    const [sc,wc]=process.env.PATCHED==="1"?[0.02,0.15]:[0.01,0.1]
    process.stdout.write(String(0.5+sc*Number(process.env.SEED)+wc*ws))'
}

approx() { # <actual> <expected> — within 1e-9
  A="$1" E="$2" node -e 'process.exit(Math.abs(Number(process.env.A)-Number(process.env.E))<1e-9?0:1)'
}

jobs_api() { api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs"; }

# ── baseline jobs (kind=baseline, seeds 1/2/3, materialized from CAS) ─────

echo "== baseline jobs: kind=baseline, code snapshot materialized to /work, real node in docker (seeds 1/2/3) =="
for BSEED in 1 2 3; do
  submit_job "gpv2-baseline-$BSEED" "baseline" "baseline.js" "$CODE_ART" "$BSEED" > /dev/null
  S=$(wait_job "gpv2-baseline-$BSEED" || echo timeout)
  if [[ "$S" == "succeeded" ]]; then
    ok "baseline job seed=$BSEED succeeded (kind=baseline, docker mode, real execution from materialized CAS snapshot)"
  else
    bad "baseline job seed=$BSEED status=$S"; tail -5 "$WORK/runner.log" || true
  fi
done
B_M1=$(jobs_api | job_metric "gpv2-baseline-1" "m1")
B_EXP=$(A=$(expect_m1 1) B=$(expect_m1 2) C=$(expect_m1 3) node -e "console.log((Number(process.env.A)+Number(process.env.B)+Number(process.env.C))/3)")
if [ -n "$B_M1" ] && approx "$B_M1" "$(expect_m1 1)"; then
  ok "baseline-1 m1=$B_M1 matches deterministic expectation $(expect_m1 1)"
else
  bad "baseline-1 m1='$B_M1' != expected $(expect_m1 1)"
fi
if B_S=$(jobs_api | check_metrics_artifact "gpv2-baseline-1" 1); then
  ok "baseline metrics artifact from fixed-schema FILE (§12.5, source=metrics-file): $B_S"
else
  bad "baseline metrics artifact §12.5 check failed"
fi
if jobs_api | check_log_contains "gpv2-baseline-1" "#!/usr/bin/env node" > /dev/null; then
  ok "materialized baseline.js readable IN the container (shebang found in run log)"
else
  bad "baseline materialization proof failed"
fi
if jobs_api | check_log_contains "gpv2-baseline-1" '{"schema_version":1' > /dev/null; then
  ok "in-container /outputs/metrics.json written and cat'ed (fixed-schema line in log)"
else
  bad "baseline metrics.json proof failed"
fi

echo "== formal jobs: kind=formal, seeds 1/2/3, real node execution in docker =="
for seed in 1 2 3; do
  submit_job "gpv2-seed-$seed" "formal" "train.js" "$CODE_ART" "$seed" > /dev/null
  S=$(wait_job "gpv2-seed-$seed" || echo timeout)
  if [[ "$S" == "succeeded" ]]; then
    ok "formal job seed=$seed succeeded (materialized from CAS)"
  else
    bad "formal job seed=$seed status=$S"; tail -5 "$WORK/runner.log" || true
  fi
done

V1=$(jobs_api | job_metric "gpv2-seed-1" "m1")
V2=$(jobs_api | job_metric "gpv2-seed-2" "m1")
V3=$(jobs_api | job_metric "gpv2-seed-3" "m1")
E1=$(expect_m1 1); E2=$(expect_m1 2); E3=$(expect_m1 3)
if [ -n "$V1" ] && [ -n "$V2" ] && [ -n "$V3" ] && approx "$V1" "$E1" && approx "$V2" "$E2" && approx "$V3" "$E3"; then
  ok "extracted m1 matches deterministic expectation (m1(1)=$V1 m1(2)=$V2 m1(3)=$V3)"
else
  bad "metric mismatch: got '$V1'/'$V2'/'$V3' expected $E1/$E2/$E3"
fi
if M1="$V1" M2="$V2" M3="$V3" node -e 'const [a,b,c]=[process.env.M1,process.env.M2,process.env.M3].map(Number);process.exit(a<b&&b<c?0:1)'; then
  ok "m1 strictly increases with seed ($V1 < $V2 < $V3) — values really computed, not forged"
else
  bad "monotonicity violated: $V1 $V2 $V3"
fi
NS=$(jobs_api | job_metric "gpv2-seed-3" "n_samples")
if [[ "$NS" == "4" ]]; then
  ok "n_samples=4 extracted (data file really read inside the container)"
else
  bad "n_samples='$NS' != 4"
fi
if S2=$(jobs_api | check_metrics_artifact "gpv2-seed-2" 2); then
  ok "formal job metrics artifact from fixed-schema FILE (§12.5): $S2"
else
  bad "formal job metrics artifact §12.5 check failed"
fi
if jobs_api | check_log_contains "gpv2-seed-3" "#!/usr/bin/env node" > /dev/null; then
  ok "materialized train.js readable IN the container (shebang found in run log)"
else
  bad "formal materialization proof failed"
fi

# ── multi-seed analysis over the real runs ───────────────────────────────────

echo "== analysis: POST /v1/projects/$PROJ/analysis (aggregate real runs) =="
AN=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/analysis" -d '{"metric":"m1"}')
jfield() { printf '%s' "$AN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).$1))"; }
# Expected: kernel rounds to 4 decimals (Math.round(x*1e4)/1e4) exactly like
# the host-side computation of the same formula (bit-identical doubles).
EXPECT_MEAN=$(node -e "const r=(Number('$E1')+Number('$E2')+Number('$E3'))/3;console.log(Math.round(r*1e4)/1e4)")
EXPECT_BASE=$(node -e "console.log(Math.round(Number('$B_EXP')*1e4)/1e4)")
# Paired design (§13.6): effect = mean(formal_i - baseline_i) over matched seeds.
EXPECT_EFF2=$(node -e "const f=(Number('$E1')+Number('$E2')+Number('$E3'))/3;const b=Number('$B_EXP');console.log(Math.round((f-b)*1e4)/1e4)")
EXPECT_EFF=$(node -e "const r=(Number('$E1')+Number('$E2')+Number('$E3'))/3-Number('$B_EXP');console.log(Math.round(r*1e4)/1e4)")
if AN_RES=$(AN_JSON="$AN" EXPECT_MEAN="$EXPECT_MEAN" EXPECT_BASE="$EXPECT_BASE" EXPECT_EFF="$EXPECT_EFF" node --input-type=module -e '
  const a=JSON.parse(process.env.AN_JSON)
  const tol=1e-9
  const checks={
    n:a.n===3,
    mean:Math.abs(a.mean-Number(process.env.EXPECT_MEAN))<tol,
    baseline_value:Math.abs(a.baseline_value-Number(process.env.EXPECT_BASE))<tol,
    effect_size:Math.abs(a.effect_size-Number(process.env.EXPECT_EFF))<tol,
    seeds:JSON.stringify((a.runs??[]).map(r=>r.seed).sort((x,y)=>x-y))===JSON.stringify([1,2,3]),
    artifacts:String(a.artifact_id).startsWith("sha256:")&&String(a.chart_artifact).startsWith("sha256:"),
  }
  const bad=Object.entries(checks).filter(([,v])=>!v)
  if(bad.length){console.error("analysis assertion failed: "+JSON.stringify(bad));process.exit(1)}
  console.log(JSON.stringify({mean:a.mean,sd:a.sd,n:a.n,baseline_value:a.baseline_value,effect_size:a.effect_size,seeds:(a.runs??[]).map(r=>r.seed)}))'); then
  ok "analysis aggregated over real runs: $AN_RES (expected mean $EXPECT_MEAN, baseline $EXPECT_BASE, effect $EXPECT_EFF)"
else
  bad "analysis assertions failed"; printf '%s' "$AN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log(JSON.stringify({mean:a.mean,sd:a.sd,n:a.n,baseline_value:a.baseline_value,effect_size:a.effect_size,adjusted_p:a.adjusted_p_value}))})"; echo "expected: MEAN=$EXPECT_MEAN BASE=$EXPECT_BASE EFF=$EXPECT_EFF B_EXP=$B_EXP"
fi

# ── patch changes the REAL algorithm (§19.3 step 4) ─────────────────────────

echo "== patch: Code Engineer changes a real algorithm constant, re-archive, run seed 4 =="
PATCHED="$WORK/fixture-patched"
cp -r "$FIXTURE" "$PATCHED"
sed -i 's/0.5 + 0.01 \* seed + 0.1 \* weightedSum/0.5 + 0.02 * seed + 0.15 * weightedSum/' "$PATCHED/train.js"
if grep -q '0.02 \* seed + 0.15 \* weightedSum' "$PATCHED/train.js"; then
  ok "patch applied to train.js (seed coefficient 0.01 -> 0.02, weight 0.1 -> 0.15)"
else
  bad "patch application failed"
fi
PAT_SNAP=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/code-snapshots" -d "{\"path\":\"$PATCHED\",\"description\":\"golden-path-v2 patched fixture\"}")
PAT_ART=$(printf '%s' "$PAT_SNAP" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).archive_artifact_id))")
if [[ "$PAT_ART" == sha256:* ]] && [[ "$PAT_ART" != "$CODE_ART" ]]; then
  ok "patched snapshot archived: $PAT_ART (new content -> new CAS address)"
else
  bad "patched snapshot archive failed: $PAT_ART"
fi
submit_job "gpv2-seed-4" "formal" "train.js" "$PAT_ART" 4 > /dev/null
S=$(wait_job "gpv2-seed-4" || echo timeout)
if [[ "$S" == "succeeded" ]]; then
  ok "formal job seed=4 succeeded (patched code materialized from CAS)"
else
  bad "formal job seed=4 status=$S"; tail -5 "$WORK/runner.log" || true
fi
V4=$(jobs_api | job_metric "gpv2-seed-4" "m1")
E4_PATCHED=$(PATCHED=1 expect_m1 4)
E4_UNPATCHED=$(expect_m1 4)
if [ -n "$V4" ] && approx "$V4" "$E4_PATCHED" && ! approx "$V4" "$E4_UNPATCHED"; then
  ok "patched m1(4)=$V4 == patched expectation $E4_PATCHED != unpatched $E4_UNPATCHED — patch changed the executed algorithm"
else
  bad "patched metric mismatch: got '$V4', patched-expected $E4_PATCHED, unpatched-expected $E4_UNPATCHED"
fi
if jobs_api | check_metrics_artifact "gpv2-seed-4" 4 > /dev/null; then
  ok "patched run metrics artifact from fixed-schema FILE (seed 4)"
else
  bad "patched run metrics artifact §12.5 check failed"
fi

echo "== cleanup =="
kill "$RUNNER_PID" "$KERNEL_PID" 2>/dev/null || true
rm -rf "$WORK"
echo "golden-path-v2: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
