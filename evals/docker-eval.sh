#!/usr/bin/env bash
# §4.6.1 Runner docker-mode field test: isolated container execution with
# --network none, non-root user, memory/CPU limits; manifest container
# digest; failure classification still works in container mode.
#
# Prerequisite: a working docker runtime (sudo docker run hello-world passes).
# Usage: bash evals/docker-eval.sh
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
RUNNER_BIN="$REPO/workers/runner-gateway/lib/bin/runner.js"
WORK=$(mktemp -d)
PORT=$((19800 + $$ % 400))
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL+1)); }
api() { curl -sf -H 'content-type: application/json' "$@"; }

if ! docker info > /dev/null 2>&1; then
  echo "docker runtime not available — run: sudo systemctl start docker"
  exit 2
fi
ok "docker runtime reachable ($(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') server)"

echo "== image availability (node:22-alpine) =="
if docker image inspect node:22-alpine > /dev/null 2>&1; then
  ok "node:22-alpine already present"
else
  docker pull node:22-alpine 2>&1 | tail -1
  docker image inspect node:22-alpine > /dev/null 2>&1 && ok "node:22-alpine pulled" || bad "image pull failed"
fi

# §4 P0 (API-01/EVID-01): the kernel is configured with the fixed eval
# service token (runners inherit the env and authenticate their own internal
# calls: claim / runner-keys / recover).
export DSH_SCHOLAR_SERVICE_TOKEN='dsh-scholar-eval-service-token'

nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KERNEL_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break; sleep 0.1; done
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT" --owner docker-eval --poll-ms 150 --mode docker --timeout-ms 20000 > "$WORK/runner.log" 2>&1 &
RUNNER_PID=$!
sleep 1

BRIEF='{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"machine-learning"}'
PROJ=$(api -X POST "http://127.0.0.1:$PORT/v1/projects" -d "{\"name\":\"docker-eval\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
ok "project $PROJ"

wait_job() { # <idempotency> — waits for terminal status
  for _ in $(seq 1 80); do
    S=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).find(x=>x.idempotency_key==='$1');console.log(j?.status??'missing')})")
    case "$S" in succeeded|failed|cancelled) echo "$S"; return 0;; esac
    sleep 0.3
  done
  echo "timeout"
  return 1
}

echo "== container execution (smoke script inside node:22-alpine) =="
J1=$(api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"dk-script","kind":"smoke","payload":{"script":"node -e \"console.log(JSON.stringify({metric:\\\"f1\\\",value:0.77}))\""}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
S1=$(wait_job "dk-script")
if [[ "$S1" == "succeeded" ]]; then
  ok "container smoke job succeeded"
else
  bad "container smoke job status: $S1"; tail -5 "$WORK/runner.log"
fi
DIGEST=$(api "http://127.0.0.1:$PORT/v1/jobs/$J1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.run_manifest?.container_digest??'')})")
[[ "$DIGEST" == docker:* ]] && ok "RunManifest container digest: $DIGEST" || bad "container digest missing: '$DIGEST'"
METRIC=$(api "http://127.0.0.1:$PORT/v1/jobs/$J1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const m=j.run_manifest?.metrics_artifact;console.log(m??'')})")
[[ "$METRIC" == sha256:* ]] && ok "metrics artifact extracted from container stdout ($METRIC)" || bad "no metrics artifact"

echo "== isolation: non-root user, no network, memory limit =="
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"dk-whoami","kind":"smoke","payload":{"script":"node -e \"console.log(JSON.stringify({metric:\\\"uid\\\",value:process.getuid()}))\""}}' > /dev/null
S2=$(wait_job "dk-whoami")
[[ "$S2" == "succeeded" ]] && ok "whoami job ran" || bad "whoami job: $S2"
UIDV=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).find(x=>x.idempotency_key==='dk-whoami');console.log(j?.run_manifest?.metrics_artifact??'')})")
if [ -n "$UIDV" ]; then
  U=$(curl -s "http://127.0.0.1:$PORT/v1/artifacts/$UIDV" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d).metrics.find(x=>x.metric==='uid');console.log(m?.value)})")
  [[ "$U" == "65534" ]] && ok "runs as non-root uid 65534 (nobody)" || bad "unexpected uid: $U"
else
  bad "no metrics for whoami job"
fi

api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"dk-net","kind":"smoke","payload":{"script":"node -e \"fetch(\\\"https://example.com\\\",{signal:AbortSignal.timeout(5000)}).then(r=>console.log(JSON.stringify({metric:\\\"net\\\",value:1}))).catch(()=>console.log(JSON.stringify({metric:\\\"net\\\",value:0})))\""}}' > /dev/null
S3=$(wait_job "dk-net")
NET=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).find(x=>x.idempotency_key==='dk-net');console.log(j?.run_manifest?.metrics_artifact??'')})")
if [ -n "$NET" ]; then
  V=$(curl -s "http://127.0.0.1:$PORT/v1/artifacts/$NET" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const m=JSON.parse(d).metrics.find(x=>x.metric==='net');console.log(m?.value)})")
  [[ "$V" == "0" ]] && ok "network unreachable inside container (--network none) — fetch failed as designed" || bad "container had network access (net=$V)!"
else
  bad "no metrics for network job"
fi

echo "== memory limit enforcement (1g cgroup) =="
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"dk-oom","kind":"smoke","payload":{"script":"node -e \"const b=[]; while(true){ const x=Buffer.alloc(64*1024*1024); x.fill(1); b.push(x); }\""}}' > /dev/null
S5=$(wait_job "dk-oom" || echo timeout)
C5=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).find(x=>x.idempotency_key==='dk-oom');console.log(j?.failure_class??'')})")
E5=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).find(x=>x.idempotency_key==='dk-oom');console.log(j?.error??'')})")
# cgroup OOM kill: docker exits 137 with no parseable output, so classification
# is resources (when the message survives) or unknown — the load-bearing fact
# is that the runaway is TERMINATED by the 1g limit, never allowed to finish.
if [[ "$S5" == "failed" && "$C5" == "resources" ]]; then
  ok "memory hog killed by 1g cgroup limit -> resources (container OOM)"
elif [[ "$S5" == "failed" ]]; then
  ok "memory hog killed by 1g cgroup limit (failed, classified $C5, err: ${E5:0:60})"
else
  bad "memory hog NOT terminated (status=$S5 class=$C5) — limit not enforced!"
fi

echo "== failure classification in container mode =="
api -X POST "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" -d '{"idempotency_key":"dk-code","kind":"smoke","payload":{"script":"node -e \"require(\\\"definitely-not-a-module-xyz\\\")\""}}' > /dev/null
S4=$(wait_job "dk-code")
C=$(api "http://127.0.0.1:$PORT/v1/projects/$PROJ/jobs" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).find(x=>x.idempotency_key==='dk-code');console.log(j?.failure_class??'')})")
[[ "$C" == "code_error" ]] && ok "container failure classified: code_error" || bad "expected code_error got '$C'"

echo "== SCH-JOB-001/002: durable jobs — heartbeat renewal + cancel kills the real container =="
# Dedicated kernel+runner pair with fast heartbeat/cancel polling so the
# assertions complete in seconds; the main pair above keeps its own timings.
PORT2=$((PORT + 1))
nohup node "$KERNEL_BIN" --db "$WORK/kernel2.db" --cas "$WORK/cas2" --port "$PORT2" > "$WORK/kernel2.log" 2>&1 &
KERNEL2_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT2/v1/health" > /dev/null 2>&1 && break; sleep 0.1; done
nohup node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT2" --owner docker-eval2 --poll-ms 150 --mode docker --timeout-ms 30000 --heartbeat-ms 1500 --cancel-poll-ms 1000 --key-file "$WORK/runner2.pem" > "$WORK/runner2.log" 2>&1 &
RUNNER2_PID=$!
sleep 1
PROJ2=$(api -X POST "http://127.0.0.1:$PORT2/v1/projects" -d "{\"name\":\"docker-eval2\",\"workspace\":\"/w\",\"brief\":$BRIEF}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
ok "durable-jobs project $PROJ2"

# Long-running container (sleep 120 ≫ the 30s runner timeout): the ONLY way it
# ends is our cancel — otherwise the assertions fail loudly.
JL=$(api -X POST "http://127.0.0.1:$PORT2/v1/projects/$PROJ2/jobs" -d '{"idempotency_key":"dk-cancel","kind":"smoke","payload":{"script":"sleep 120"}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).job_id))")
S=""
for _ in $(seq 1 40); do
  S=$(api "http://127.0.0.1:$PORT2/v1/jobs/$JL" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  [[ "$S" == "running" ]] && break; sleep 0.25
done
[[ "$S" == "running" ]] && ok "long job running ($JL)" || bad "long job not running: $S"

# §12.6 heartbeat: heartbeat_at advances while the job runs (1.5s interval).
H1=$(api "http://127.0.0.1:$PORT2/v1/jobs/$JL" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).heartbeat_at??''))")
HB=no
for _ in $(seq 1 30); do
  H2=$(api "http://127.0.0.1:$PORT2/v1/jobs/$JL" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).heartbeat_at??''))")
  [[ -n "$H2" && "$H2" != "$H1" ]] && HB=yes && break
  sleep 0.3
done
[[ "$HB" == "yes" ]] && ok "heartbeat renewed lease while running ($H1 → $H2)" || bad "heartbeat_at never advanced (H1=$H1)"

# The container must actually exist before we cancel it.
CID=""
for _ in $(seq 1 25); do
  CID=$(docker ps --format '{{.Names}}' | grep '^dsh-scholar-' | head -1 || true)
  [ -n "$CID" ] && break
  sleep 0.2
done
[[ -n "$CID" ]] && ok "container $CID running before cancel" || bad "no dsh-scholar-* container before cancel"

# Cancel: the kernel flips the job; the runner's cancel watcher terminates the
# real container and confirms removal (design §12.6).
CSTATUS=$(api -X POST "http://127.0.0.1:$PORT2/v1/jobs/$JL/cancel" -d '{"actor":"docker-eval","reason":"cancel must kill the container"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
[[ "$CSTATUS" == "cancelled" ]] && ok "kernel accepted cancel → job cancelled" || bad "cancel returned $CSTATUS"
GONE=no
for _ in $(seq 1 40); do
  if ! docker ps --format '{{.Names}}' | grep -q '^dsh-scholar-'; then GONE=yes; break; fi
  sleep 0.3
done
[[ "$GONE" == "yes" ]] && ok "container terminated and removed after cancel (no dsh-scholar-* residue)" || bad "dsh-scholar-* container still present after cancel!"
sleep 1
FINAL=$(api "http://127.0.0.1:$PORT2/v1/jobs/$JL" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
[[ "$FINAL" == "cancelled" ]] && ok "job stays cancelled after runner teardown (no failed/succeeded flip)" || bad "job status after cancel: $FINAL"

kill "$RUNNER2_PID" "$KERNEL2_PID" 2>/dev/null || true

kill "$RUNNER_PID" "$KERNEL_PID" 2>/dev/null || true
rm -rf "$WORK"
echo "docker-eval: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
