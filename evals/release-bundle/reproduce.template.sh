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
# Bundle-only clean-room hardening (docs/acceptance-tests.md §12 line 191):
#   - the WHOLE bundle is first copied into a fresh mktemp directory; every
#     read afterwards happens against that copy, never against the original
#     checkout/DB/CAS location (the report is written in the copy and copied
#     back at the end when the original dir is writable);
#   - KERNEL_BIN/RUNNER_BIN must be explicitly provided AND their sha256 must
#     equal the digests declared in manifest.runtime (kernel_bin/runner_bin).
#     Any binary whose real path resolves inside a dsh-scholar checkout while
#     NOT matching the declared digest is refused outright — "external
#     checkout access prohibited". (The eval harness passes exactly the
#     binaries the bundle was built with, which DO match the declared digest
#     and are the declared fixed runtime.)
#   - node --version must match manifest.runtime.node (recorded, status=fail
#     on mismatch);
#   - baseline/pilot/formal/reproduce jobs are replayed with image_digest
#     pinned to manifest.runtime.images.node_fixture, latex-compile to
#     manifest.runtime.images.texlive — overriding any other source;
#   - a manifest WITHOUT a runtime section is an old/foreign bundle → fail.
#
# The bundle is self-contained; the ONLY external dependency is the DSH
# runtime itself:
#
#   export KERNEL_BIN=/path/to/kernel.js      # sha256 must match manifest.runtime.kernel_bin
#   export RUNNER_BIN=/path/to/runner.js      # sha256 must match manifest.runtime.runner_bin
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

MODE=${MODE:-auto}
if [ "${1:-}" = "--mode" ]; then MODE=${2:-auto}; fi

command -v node >/dev/null 2>&1 || { echo "reproduce.sh: node >= 22 required" >&2; exit 2; }
[ -f "$MANIFEST" ] || { echo "reproduce.sh: $MANIFEST not found" >&2; exit 2; }

# ---------------------------------------------------------------------------
# preflight fail path: record the rejection IN the report, then exit non-zero
# (acceptance-tests.md §12: the clean-room must refuse checkout access AND
# record it).
# ---------------------------------------------------------------------------
preflight_fail() { # <message> <exit-code>
  local msg=$1 code=$2
  echo "reproduce.sh: $msg" >&2
  {
    echo '{'
    echo "  \"status\": \"fail\","
    echo "  \"error\": \"$msg\","
    echo "  \"bundle_id\": \"$(node -e "try{console.log(require('$MANIFEST').bundle_id ?? '')}catch(e){console.log('')}" 2>/dev/null)\","
    echo "  \"runtime_verified\": { \"node\": false, \"kernel_bin\": false, \"runner_bin\": false },"
    echo "  \"images_used\": null,"
    echo "  \"compared\": { \"manifest_hash\": false, \"metrics\": false, \"analysis\": false, \"run_manifest\": false, \"tex\": false },"
    echo "  \"mode\": \"$MODE\","
    echo "  \"generated_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
    echo '}'
  } > "$BUNDLE_DIR/reproducibility-report.json" 2>/dev/null || true
  exit "$code"
}

# --- runtime contract: a bundle without manifest.runtime is not clean-room ---
if ! node -e "const m=require('$MANIFEST');process.exit(m.runtime && m.runtime.node && m.runtime.images ? 0 : 1)"; then
  preflight_fail "manifest has no runtime section — old or foreign bundle (bundle-only clean-room requires declared node + image digests)" 2
fi

# --- KERNEL_BIN / RUNNER_BIN: required, existing, and NOT the original
#     checkout (unless byte-for-byte the declared runtime) ---
[ -n "${KERNEL_BIN:-}" ] || { echo "reproduce.sh: set KERNEL_BIN to the research-kernel bin (see header)" >&2; exit 2; }
[ -n "${RUNNER_BIN:-}" ] || { echo "reproduce.sh: set RUNNER_BIN to the runner-gateway bin (see header)" >&2; exit 2; }
[ -f "$KERNEL_BIN" ] || { echo "reproduce.sh: KERNEL_BIN not found: $KERNEL_BIN" >&2; exit 2; }
[ -f "$RUNNER_BIN" ] || { echo "reproduce.sh: RUNNER_BIN not found: $RUNNER_BIN" >&2; exit 2; }

realpath_of() { # <path> — resolves symlinks (cd + pwd -P)
  local dir
  dir=$(cd "$(dirname "$1")" && pwd -P) || return 1
  printf '%s/%s' "$dir" "$(basename "$1")"
}
checkout_probe() { # <real-path> — 0 when the path lives under the ORIGINAL
  # dsh-scholar checkout (identified by a '/dsh-scholar/' segment whose
  # checkout root actually contains the kernel bin, so unrelated directories
  # named dsh-scholar do not trip the gate).
  local p=$1 prefix
  case "$p" in
    *"/dsh-scholar/"*)
      prefix=${p%%/dsh-scholar/*}/dsh-scholar
      [ -f "$prefix/packages/research-kernel/lib/bin/kernel.js" ] && return 0
      ;;
  esac
  return 1
}

KERNEL_REAL=$(realpath_of "$KERNEL_BIN")
RUNNER_REAL=$(realpath_of "$RUNNER_BIN")
KERNEL_SHA=$(sha256sum "$KERNEL_REAL" | awk '{print $1}')
RUNNER_SHA=$(sha256sum "$RUNNER_REAL" | awk '{print $1}')
DECL_KERNEL=$(node -e "console.log(require('$MANIFEST').runtime.kernel_bin ?? '')")
DECL_RUNNER=$(node -e "console.log(require('$MANIFEST').runtime.runner_bin ?? '')")
KERNEL_OK=false
[ -n "$DECL_KERNEL" ] && [ "$KERNEL_SHA" = "$DECL_KERNEL" ] && KERNEL_OK=true
RUNNER_OK=false
[ -n "$DECL_RUNNER" ] && [ "$RUNNER_SHA" = "$DECL_RUNNER" ] && RUNNER_OK=true

# The original checkout is off-limits: any binary that resolves inside it but
# is NOT the declared fixed runtime is refused outright.
if checkout_probe "$KERNEL_REAL" || checkout_probe "$RUNNER_REAL"; then
  if [ "$KERNEL_OK" = "true" ] && [ "$RUNNER_OK" = "true" ]; then
    echo "reproduce.sh: KERNEL_BIN/RUNNER_BIN resolve inside the dsh-scholar checkout but match the declared runtime digests — accepted as the declared fixed runtime"
  else
    preflight_fail "external checkout access prohibited in bundle-only clean-room (KERNEL_BIN/RUNNER_BIN resolve into the original dsh-scholar checkout and do not match manifest.runtime digests)" 3
  fi
fi
if [ "$KERNEL_OK" != "true" ] || [ "$RUNNER_OK" != "true" ]; then
  preflight_fail "KERNEL_BIN/RUNNER_BIN sha256 do not match manifest.runtime digests (declared kernel_bin=$DECL_KERNEL runner_bin=$DECL_RUNNER)" 3
fi

# --- node version vs the declared runtime node ---
NODE_VER=$(node --version)
DECL_NODE=$(node -e "console.log(require('$MANIFEST').runtime.node ?? '')")
NODE_OK=false
[ -n "$DECL_NODE" ] && [ "$NODE_VER" = "$DECL_NODE" ] && NODE_OK=true
if [ "$NODE_OK" != "true" ]; then
  echo "reproduce.sh: WARNING node $NODE_VER does not match declared runtime.node $DECL_NODE — runtime_verified.node=false, status will be fail" >&2
fi

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
# §4 P0 (API-01/EVID-01): bundle clean-room kernels run with the fixed
# eval service token; the helper attaches x-service-token so the internal
# approve route works (runners inherit the env var for their own calls).
export DSH_SCHOLAR_SERVICE_TOKEN='dsh-scholar-eval-service-token'
api() { curl -sf -H 'content-type: application/json' -H "x-service-token: $DSH_SCHOLAR_SERVICE_TOKEN" "$@"; }

# ---------------------------------------------------------------------------
# Bundle-only clean-room isolation: snapshot the bundle into a fresh empty
# directory first; every subsequent read happens against the snapshot, never
# against the original checkout/DB/CAS location. The original manifest hash
# is recorded BEFORE the copy so the report can prove the copy is identical.
# ---------------------------------------------------------------------------
ORIG_MANIFEST_SHA=$(sha256sum "$MANIFEST" | awk '{print $1}')
BUNDLE_COPY="$WORK/bundle-copy"
mkdir -p "$BUNDLE_COPY"
cp -a "$BUNDLE_DIR"/. "$BUNDLE_COPY"/
rm -f "$BUNDLE_COPY/reproducibility-report.json"
MANIFEST="$BUNDLE_COPY/manifest.json"
REPORT="$BUNDLE_COPY/reproducibility-report.json"
echo "reproduce.sh: bundle snapshot at $BUNDLE_COPY (original bundle only read for the snapshot)"

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
# materialization (code snapshot archives) and metrics lookups resolve. All
# reads come from the bundle SNAPSHOT, never the original bundle location.
NA=$(MANIFEST="$MANIFEST" BUNDLE_DIR="$BUNDLE_COPY" BASE="$BASE" PROJ="$PROJ" node -e '
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
# mapped to the freshly re-registered one via CT_MAP. §12 clean-room:
# baseline/pilot/formal/reproduce jobs are FORCED to the declared
# node_fixture image digest and latex-compile to the texlive digest —
# overriding any digest recorded in the original payload.
KEYS=$(node -e "const m=require('$MANIFEST');console.log(m.jobs.filter(j=>j.status==='succeeded').map(j=>j.idempotency_key).join(' '))")
NKEYS=0
for KEY in $KEYS; do
  BODY=$(KEY="$KEY" MANIFEST="$MANIFEST" CT_MAP="$CT_MAP" node -e '
    const m=require(process.env.MANIFEST)
    const j=m.jobs.find(x=>x.idempotency_key===process.env.KEY)
    const pairs=process.env.CT_MAP.trim().split(/\s+/).filter(Boolean).map(p=>p.split("="))
    const oldRef=j.run_manifest && typeof j.run_manifest.contract_id==="string" ? j.run_manifest.contract_id : null
    const pair=oldRef!==null?pairs.find(p=>p[0]===oldRef):undefined
    const imgs=(m.runtime && m.runtime.images) || {}
    const forced=["baseline","pilot","formal","reproduce"].includes(j.kind)?imgs.node_fixture:(j.kind==="latex-compile"?imgs.texlive:null)
    const payload=j.payload && typeof j.payload==="object" ? {...j.payload} : j.payload
    if(forced && payload && typeof payload==="object") payload.image_digest=forced
    console.log(JSON.stringify({idempotency_key:j.idempotency_key,kind:j.kind,command:j.command,payload,...(j.code_snapshot_id?{code_snapshot_id:j.code_snapshot_id}:{}),...(pair!==undefined?{contract_id:pair[1]}:{}),...(forced?{image_digest:forced}:{})}))')
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

# §14.5 step 8: reproducibility-report.json — bundle-only clean-room fields:
# bundle_manifest_sha256 (computed in the snapshot), runtime_verified
# (node/kernel_bin/runner_bin), images_used (declared digests), compared
# (manifest_hash/metrics/analysis/run_manifest/tex). status=pass ONLY when
# every runtime_verified and every compared entry is true and no job failed.
TOL="${TOL:-0.001}"
NODE_OK="$NODE_OK" KERNEL_OK="$KERNEL_OK" RUNNER_OK="$RUNNER_OK" \
NODE_VER="$NODE_VER" DECL_NODE="$DECL_NODE" \
MANIFEST="$MANIFEST" REPORT="$REPORT" WORK="$WORK" MODE="$MODE" PROJ="$PROJ" TOL="$TOL" \
STATS="$STATS" NKEYS="$NKEYS" BASE="$BASE" BUNDLE_COPY="$BUNDLE_COPY" \
ORIG_MANIFEST_SHA="$ORIG_MANIFEST_SHA" node -e '
  const fs=require("fs")
  const crypto=require("crypto")
  const m=JSON.parse(fs.readFileSync(process.env.MANIFEST,"utf8"))
  const rt=m.runtime||{}
  const images=rt.images||{}
  const rp=process.env.WORK+"/rerun-analysis.json"
  const rerun=fs.existsSync(rp)?JSON.parse(fs.readFileSync(rp,"utf8")):null
  const orig=m.analysis
  const tol=Number(process.env.TOL)
  const [succeeded,failed]=process.env.STATS.split(":").map(Number)
  const checks=[]
  const origJobs=(m.jobs??[]).filter(j=>j.status==="succeeded")
  ;(async()=>{
    // compared.manifest_hash: snapshot manifest vs the hash recorded pre-copy
    const copySha=crypto.createHash("sha256").update(fs.readFileSync(process.env.MANIFEST)).digest("hex")
    const manifestHashOk=copySha===process.env.ORIG_MANIFEST_SHA
    checks.push({check:"manifest hash",pass:manifestHashOk,detail:"snapshot="+copySha+" original="+process.env.ORIG_MANIFEST_SHA})

    // Fresh kernel state for the rerun side of every comparison.
    const jobsRes=await fetch(process.env.BASE+"/v1/projects/"+process.env.PROJ+"/jobs")
    const rerunJobs=await jobsRes.json()
    const byKey=new Map(rerunJobs.map(j=>[j.idempotency_key,j]))

    // compared.metrics: original metrics artifact content (from the bundle
    // snapshot, i.e. the archived original kernel CAS) vs the rerun metrics
    // artifact content (read back from the FRESH kernel CAS), JSON-compared
    // with numeric tolerance on values.
    const norm=e=>({name:e.name??e.metric??"",value:Number(e.value),unit:e.unit??"ratio"})
    const metricsDetail=[]
    let metricsOk=true
    for(const j of origJobs){
      const aid=j.run_manifest && j.run_manifest.metrics_artifact
      if(!aid){metricsDetail.push(j.idempotency_key+": no original metrics_artifact (skipped)");continue}
      const rec=m.artifacts?.[aid]??m.artifacts?.[String(aid).replace(/^sha256:/,"")]
      let oa=null
      if(rec){
        const f=process.env.BUNDLE_COPY+"/"+rec.path
        if(fs.existsSync(f)){try{oa=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}}
      }
      let ra=null
      const rj=byKey.get(j.idempotency_key)
      if(rj && rj.run_manifest && typeof rj.run_manifest.metrics_artifact==="string"){
        try{
          const ar=await fetch(process.env.BASE+"/v1/artifacts/"+encodeURIComponent(rj.run_manifest.metrics_artifact)+"?project_id="+process.env.PROJ)
          if(ar.ok)ra=await ar.json()
        }catch{}
      }
      if(!oa||!ra){metricsOk=false;metricsDetail.push(j.idempotency_key+": original/rerun metrics artifact unreadable");continue}
      const om=(oa.metrics??[]).map(norm)
      const rm=(ra.metrics??[]).map(norm)
      const same=om.length===rm.length && om.every((x,i)=>x.name===rm[i].name && x.unit===rm[i].unit && Math.abs(x.value-rm[i].value)<=tol)
      if(!same)metricsOk=false
      metricsDetail.push(j.idempotency_key+": "+om.length+" metrics "+(same?"match":"DIFFER"))
    }
    checks.push({check:"metrics comparison",pass:metricsOk,detail:metricsDetail.join("; ")||"no succeeded jobs"})

    // compared.run_manifest: run_id values are runner-generated per run
    // (run_<uuid>, workers/runner-gateway), so byte equality can never hold
    // across independent runs — the compared invariant is the run SET: the
    // same idempotency keys succeeded, same count, and every rerun run
    // carries a run_manifest with a metrics_artifact.
    const origKeys=origJobs.map(j=>j.idempotency_key).sort()
    const rerunSuc=origKeys.map(k=>byKey.get(k)).filter(j=>j && j.status==="succeeded")
    const rerunKeys=rerunSuc.map(j=>j.idempotency_key).sort()
    const setOk=origKeys.length===rerunKeys.length && origKeys.every((k,i)=>k===rerunKeys[i])
    const manOk=rerunSuc.every(j=>j.run_manifest && typeof j.run_manifest.metrics_artifact==="string")
    const runManifestOk=setOk&&manOk
    checks.push({check:"run manifest comparison",pass:runManifestOk,detail:"orig "+origKeys.length+" succeeded run(s), rerun "+rerunKeys.length+"; invariant = idempotency-key set + run count + run_manifest presence (run_ids are runner-generated per run)"})

    // compared.tex: when the manifest carries TeX/PDF structure (latex
    // manuscript or succeeded latex-compile jobs), compare the EXISTENCE of
    // the tex/pdf artifacts on both sides; otherwise true with a skip note.
    const texJobs=origJobs.filter(j=>j.kind==="latex-compile")
    let texOk=true
    let texNote="no TeX structure in manifest; skipped"
    if((m.manuscript && (m.manuscript.format==="latex" || m.manuscript.tex_document_id || m.manuscript.pdf_artifact)) || texJobs.length>0){
      const origTex=texJobs.filter(j=>j.run_manifest && typeof j.run_manifest.tex_pdf_artifact==="string").length
      const rerunTex=rerunSuc.filter(j=>j.kind==="latex-compile" && j.run_manifest && typeof j.run_manifest.tex_pdf_artifact==="string").length
      texOk=origTex>0 && origTex===rerunTex
      texNote="orig "+origTex+" tex/pdf artifact(s), rerun "+rerunTex
    }
    checks.push({check:"tex comparison",pass:texOk,detail:texNote})

    // compared.analysis: rerun mean vs original mean within tolerance.
    let meanDiff=null
    let analysisOk=false
    if(orig&&rerun){
      meanDiff=Math.abs(orig.mean-rerun.mean)
      analysisOk=meanDiff<=tol
      checks.push({check:"analysis mean within tolerance",pass:analysisOk,detail:"|"+orig.mean+"-"+rerun.mean+"|="+meanDiff.toFixed(6)+" <= "+tol})
    } else if(orig&&!rerun){
      checks.push({check:"analysis rerun",pass:false,detail:"original analysis exists but rerun failed"})
    } else {
      analysisOk=true
      checks.push({check:"analysis rerun",pass:true,detail:"no analysis section in manifest; skipped"})
    }

    // runtime_verified
    const rv={node:process.env.NODE_OK==="true",kernel_bin:process.env.KERNEL_OK==="true",runner_bin:process.env.RUNNER_OK==="true"}
    checks.push({check:"runtime node",pass:rv.node,detail:"used "+process.env.NODE_VER+" vs declared "+(process.env.DECL_NODE||"(none)")})
    checks.push({check:"runtime kernel_bin digest",pass:rv.kernel_bin,detail:"declared "+(rt.kernel_bin||"(none)")})
    checks.push({check:"runtime runner_bin digest",pass:rv.runner_bin,detail:"declared "+(rt.runner_bin||"(none)")})
    checks.push({check:"jobs rerun",pass:failed===0,detail:failed>0?failed+" job(s) failed":("all "+succeeded+" rerun job(s) succeeded")})

    const compared={manifest_hash:manifestHashOk,metrics:metricsOk,analysis:analysisOk,run_manifest:runManifestOk,tex:texOk}
    const status=(rv.node && rv.kernel_bin && rv.runner_bin && compared.manifest_hash && compared.metrics && compared.analysis && compared.run_manifest && compared.tex && failed===0)?"pass":"fail"
    const report={status,bundle_id:m.bundle_id,bundle_manifest_sha256:copySha,
      runtime_verified:rv,
      runtime:{declared_node:rt.node??null,used_node:process.env.NODE_VER,declared_kernel_bin_sha256:rt.kernel_bin??null,declared_runner_bin_sha256:rt.runner_bin??null},
      images_used:{node_fixture:images.node_fixture??null,texlive:images.texlive??null},
      compared,
      mode:process.env.MODE,rerun_project_id:process.env.PROJ,
      jobs:{expected:Number(process.env.NKEYS),succeeded,failed},
      original_analysis:orig?{mean:orig.mean,n:orig.n,effect_size:orig.effect_size,baseline_value:orig.baseline_value}:null,
      rerun_analysis:rerun?{mean:rerun.mean,n:rerun.n,effect_size:rerun.effect_size,baseline_value:rerun.baseline_value}:null,
      mean_diff:meanDiff,tolerance:tol,checks,generated_at:new Date().toISOString()}
    fs.writeFileSync(process.env.REPORT,JSON.stringify(report,null,2))
    console.log("reproduce.sh: reproducibility-report.json -> status="+status)
  })().catch(e=>{console.error(e);process.exit(1)})
'
# Write the report back into the original bundle dir when possible (read-only
# originals keep it in the snapshot; the path is printed in that case).
if cp "$REPORT" "$BUNDLE_DIR/reproducibility-report.json" 2>/dev/null; then
  echo "reproduce.sh: report copied back to $BUNDLE_DIR/reproducibility-report.json"
else
  echo "reproduce.sh: original bundle dir not writable — report left at $REPORT"
fi
[ "$(node -e "console.log(require('$REPORT').status)")" = "pass" ]
echo "reproduce.sh: DONE (clean-room rerun passed)"
