#!/usr/bin/env bash
# §19.3 Golden Path v2 — REAL execution end-to-end (no echo jobs, no message
# fallback, no forged metrics).
#
# Drives the full v2 experiment lifecycle against a small self-contained
# fixture repo (evals/golden-path-v2/fixture-repo) with real code executed by
# real `node` inside a `node:22-alpine` docker container through the runner's
# `--mode docker` path:
#
#   1. fixture-repo tar -> code artifact (kind='code', content-addressed,
#      integrity round-trip via GET /v1/artifacts/{id});
#   2. baseline job  (kind=baseline, seed 0)   — real node execution;
#   3. three formal jobs (kind=formal, seeds 1/2/3) — real node execution;
#   4. each run writes the §12.5 fixed-schema metrics file in-container
#      (/tmp/metrics.json) and `cat`s it (proven by validating the exact
#      record inside the run log artifact);
#   5. metrics are also printed as stdout JSON lines (compat with the current
#      runner, which still extracts metrics from stdout — §12.5 "runner does
#      not derive metrics from arbitrary stdout" is the target mechanism, not
#      yet implemented; both channels must agree);
#   6. POST /v1/projects/{id}/analysis aggregates the real runs: mean,
#      baseline_value, effect_size, seeds — asserted against the
#      deterministic expectation the script computes itself.
#
# How real code reaches the container (verified against
# workers/runner-gateway/src/index.ts runDocker): the runner mounts the job's
# mkdtemp workdir at /work:ro and executes `job.command` verbatim, but only
# smoke+script jobs get files written into that workdir. Baseline/formal jobs
# therefore carry the fixture INSIDE the command itself: `sh -c` materializes
# train.js/baseline.js + the dataset into the container's writable /tmp
# (tmpfs) via heredocs, then runs node on them. /tmp is used instead of the
# §12.5 `/outputs` path because /work is mounted ro and uid 65534 cannot
# create /outputs in the image root fs. The runner does not yet materialize
# CAS artifacts into the container, so the fixture tar registered as a code
# artifact is verified for integrity but is not the execution input.
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

echo "== fixture-repo -> code artifact (content-addressed, integrity round-trip) =="
TAR="$WORK/fixture-repo.tar"
tar --sort=name --mtime=@1767225600 --owner=0 --group=0 --numeric-owner -cf "$TAR" -C "$FIXTURE" .
TAR_SHA=$(sha256sum "$TAR" | awk '{print $1}')
CODE_ART=$(api -X POST "http://127.0.0.1:$PORT/v1/artifacts" -d "{\"project_id\":\"$PROJ\",\"kind\":\"code\",\"content_base64\":\"$(base64 -w0 "$TAR")\",\"metadata\":{\"fixture\":\"golden-path-v2\",\"tar_sha256\":\"$TAR_SHA\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).artifact_id))")
if [[ "$CODE_ART" == "sha256:$TAR_SHA" ]]; then
  ok "fixture-repo tar registered as code artifact $CODE_ART (deterministic tar)"
else
  bad "code artifact id '$CODE_ART' != sha256:$TAR_SHA"
fi
curl -sf "http://127.0.0.1:$PORT/v1/artifacts/$CODE_ART" -o "$WORK/dl.tar"
if [[ "$(sha256sum "$WORK/dl.tar" | awk '{print $1}')" == "$TAR_SHA" ]]; then
  ok "artifact bytes round-trip verified (GET /v1/artifacts/$CODE_ART == local tar)"
else
  bad "artifact download hash mismatch"
fi

# ── helpers ──────────────────────────────────────────────────────────────────

wait_job() { # <idempotency_key> — echoes terminal status (succeeded|failed|cancelled|timeout)
  for _ in $(seq 1 120); do
    S=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).find(x=>x.idempotency_key==='$1');console.log(j?.status??'missing')})")
    case "$S" in succeeded|failed|cancelled) echo "$S"; return 0;; esac
    sleep 0.25
  done
  echo "timeout"
  return 1
}

# job_metric <key> <metric> — reads GET /projects/{id}/jobs JSON on stdin,
# prints the metric value from the run's metrics artifact ('' if missing).
job_metric() {
  KEY="$1" METRIC="$2" PORT="$PORT" node --input-type=module -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",async()=>{
      const jobs=JSON.parse(d)
      const art=jobs.find(x=>x.idempotency_key===process.env.KEY)?.run_manifest?.metrics_artifact
      if(!art){process.stdout.write("");return}
      try{
        const res=await fetch("http://127.0.0.1:"+process.env.PORT+"/v1/artifacts/"+encodeURIComponent(art))
        const parsed=JSON.parse(await res.text())
        const m=(parsed.metrics??[]).find(x=>x.metric===process.env.METRIC)
        process.stdout.write(m!==undefined?String(m.value):"")
      }catch{process.stdout.write("")}
    })'
}

# check_schema <key> <expected-seed> — reads jobs JSON on stdin, finds the
# §12.5 fixed-schema metrics.json record inside the run log artifact (the
# in-container `cat /tmp/metrics.json`) and validates every field.
check_schema() {
  KEY="$1" EXPECT_SEED="$2" PORT="$PORT" node --input-type=module -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",async()=>{
      const jobs=JSON.parse(d)
      const art=jobs.find(x=>x.idempotency_key===process.env.KEY)?.run_manifest?.log_artifact
      if(!art){console.error("no log artifact");process.exit(1)}
      const res=await fetch("http://127.0.0.1:"+process.env.PORT+"/v1/artifacts/"+encodeURIComponent(art))
      const log=await res.text()
      const line=log.split("\n").map(s=>s.trim()).find(s=>s.startsWith("{\"schema_version\":"))
      if(!line){console.error("metrics.json line not found in run log");process.exit(1)}
      const rep=JSON.parse(line)
      const okFields=rep.schema_version===1
        && rep.seed===Number(process.env.EXPECT_SEED)
        && typeof rep.run_id==="string" && typeof rep.contract_id==="string"
        && Array.isArray(rep.metrics) && rep.metrics.length>=2
        && rep.metrics.every(m=>typeof m.name==="string"&&typeof m.value==="number"&&typeof m.unit==="string")
      if(!okFields){console.error("schema mismatch: "+line.slice(0,220));process.exit(1)}
      console.log(JSON.stringify({run_id:rep.run_id,contract_id:rep.contract_id,seed:rep.seed,metrics:rep.metrics.map(m=>m.name+":"+m.value)}))
    })'
}

# embed_run <fixture-js> [node args...] — emits the in-container sh script:
# materializes the fixture files into /tmp, runs node on them (real
# execution), then cats the fixed-schema metrics file.
embed_run() {
  local js="$1"; shift
  { printf "cat > /tmp/golden-run.js <<'DHSH_GOLDEN_EOF'\n"
    cat "$FIXTURE/$js"
    printf '\nDHSH_GOLDEN_EOF\n'
    printf "cat > /tmp/golden-seed-data.json <<'DHSH_GOLDEN_EOF'\n"
    cat "$FIXTURE/data/seed-data.json"
    printf '\nDHSH_GOLDEN_EOF\n'
    # The container has no package.json; mark /tmp as ESM so node interprets
    # the fixture exactly like on the host (repo root is "type":"module").
    printf "printf '%s' > /tmp/package.json\n" '{"type":"module"}'
    printf 'node /tmp/golden-run.js --data /tmp/golden-seed-data.json --output /tmp/metrics.json'
    for a in "$@"; do printf ' %q' "$a"; done
    printf '\ncat /tmp/metrics.json\n'
  }
}

# submit_job <key> <kind> <fixture-js> [node args...] — submits a real
# command job (the runner executes job.command verbatim in the container).
submit_job() {
  local key="$1" kind="$2" js="$3"; shift 3
  local run_sh
  run_sh=$(embed_run "$js" "$@")
  KEY="$key" KIND="$kind" RUN_SH="$run_sh" node -e 'process.stdout.write(JSON.stringify({idempotency_key:process.env.KEY,kind:process.env.KIND,command:["sh","-c",process.env.RUN_SH]}))' \
    | api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d @-
}

# expect_m1 <seed> — deterministic expectation computed from the fixture data.
expect_m1() {
  SEED="$1" FIXTURE="$FIXTURE" node -e '
    const fs=require("node:fs")
    const d=JSON.parse(fs.readFileSync(process.env.FIXTURE+"/data/seed-data.json","utf8"))
    const ws=d.baseline.reduce((a,b,i)=>a+b*d.weights[i],0)
    process.stdout.write(String(0.5+0.01*Number(process.env.SEED)+0.1*ws))'
}

approx() { # <actual> <expected> — within 1e-9
  A="$1" E="$2" node -e 'process.exit(Math.abs(Number(process.env.A)-Number(process.env.E))<1e-9?0:1)'
}

jobs_api() { api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs"; }

# ── baseline job (kind=baseline, seed 0) ─────────────────────────────────────

echo "== baseline job: kind=baseline, real node execution in docker (seed 0) =="
submit_job "gpv2-baseline" "baseline" "baseline.js" --seed 0 > /dev/null
S=$(wait_job "gpv2-baseline" || echo timeout)
if [[ "$S" == "succeeded" ]]; then
  ok "baseline job succeeded (kind=baseline, docker mode, real execution)"
else
  bad "baseline job status=$S"; tail -3 "$WORK/runner.log" || true
fi
B_M1=$(jobs_api | job_metric "gpv2-baseline" "m1")
B_EXP=$(expect_m1 0)
if [ -n "$B_M1" ] && approx "$B_M1" "$B_EXP"; then
  ok "baseline m1=$B_M1 matches deterministic expectation $B_EXP"
else
  bad "baseline m1='$B_M1' != expected $B_EXP"
fi
if B_S=$(jobs_api | check_schema "gpv2-baseline" 0); then
  ok "baseline metrics.json fixed schema verified in-container: $B_S"
else
  bad "baseline fixed-schema metrics.json check failed"
fi

# ── three formal jobs (seeds 1/2/3) ──────────────────────────────────────────

echo "== formal jobs: kind=formal, seeds 1/2/3, real node execution in docker =="
for seed in 1 2 3; do
  submit_job "gpv2-seed-$seed" "formal" "train.js" --seed "$seed" > /dev/null
  S=$(wait_job "gpv2-seed-$seed" || echo timeout)
  if [[ "$S" == "succeeded" ]]; then
    ok "formal job seed=$seed succeeded"
  else
    bad "formal job seed=$seed status=$S"; tail -3 "$WORK/runner.log" || true
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
if S2=$(jobs_api | check_schema "gpv2-seed-2" 2); then
  ok "formal job metrics.json fixed schema verified in-container: $S2"
else
  bad "formal job fixed-schema metrics.json check failed"
fi

# ── multi-seed analysis over the real runs ───────────────────────────────────

echo "== analysis: POST /v1/projects/$PROJ/analysis (aggregate real runs) =="
AN=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/analysis" -d '{"metric":"m1"}')
jfield() { printf '%s' "$AN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).$1))"; }
# Expected: kernel rounds to 4 decimals (Math.round(x*1e4)/1e4) exactly like
# the host-side computation of the same formula (bit-identical doubles).
EXPECT_MEAN=$(node -e "const r=(Number('$E1')+Number('$E2')+Number('$E3'))/3;console.log(Math.round(r*1e4)/1e4)")
EXPECT_BASE=$(node -e "console.log(Math.round(Number('$B_EXP')*1e4)/1e4)")
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
  bad "analysis assertions failed"; printf '%s' "$AN" | head -c 400; echo
fi

echo "== cleanup =="
kill "$RUNNER_PID" "$KERNEL_PID" 2>/dev/null || true
rm -rf "$WORK"
echo "golden-path-v2: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
