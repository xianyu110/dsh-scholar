#!/usr/bin/env bash
# TEX-02 end-to-end: a real latex-compile job — frozen TeX snapshot →
# runner materialization (hash-verified) → texlive container (pdflatex×3 +
# bibtex) → PDF/log/diagnostics artifacts → tex_builds row finalized.
#
# Needs: docker, the fixed TeX image (texlive/texlive:latest), a built
# repo (packages/*/lib), and a kernel + docker runner on random ports.
# SKIPs with exit 0 when docker or the image is unavailable so the CI job
# stays cheap on machines without the image.
set -eu

REPO=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
if [ ! -f "$REPO/packages/research-kernel/lib/bin/kernel.js" ] && [ -f "$PWD/packages/research-kernel/lib/bin/kernel.js" ]; then
  REPO=$PWD
fi
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
RUNNER_BIN="$REPO/workers/runner-gateway/lib/bin/runner.js"

if [ ! -f "$KERNEL_BIN" ] || [ ! -f "$RUNNER_BIN" ]; then
  echo "latex-compile-e2e: cannot locate built repo (kernel=$KERNEL_BIN runner=$RUNNER_BIN)" >&2
  exit 1
fi

# ── gate: docker + fixed TeX image ─────────────────────────────────────────
if ! docker info > /dev/null 2>&1; then
  echo "SKIP latex-compile-e2e: docker unavailable"
  exit 0
fi
IMAGE="${TEX_BUILD_IMAGE:-texlive/texlive:latest}"
if ! docker image inspect "$IMAGE" > /dev/null 2>&1; then
  echo "SKIP latex-compile-e2e: image $IMAGE not present (CI job pulls it first)"
  exit 0
fi

WORK=$(mktemp -d)
KPID=""
RPID=""
PORT=""
cleanup() {
  [ -n "$RPID" ] && kill "$RPID" 2>/dev/null || true
  [ -n "$KPID" ] && kill "$KPID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

PORT=$((20000 + RANDOM % 20000))
node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --host 127.0.0.1 --port "$PORT" > "$WORK/kernel.log" 2>&1 &
KPID=$!
for _ in $(seq 1 40); do
  curl -sf -m 1 "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break
  sleep 0.5
done
curl -sf -m 2 "http://127.0.0.1:$PORT/v1/health" > /dev/null || { echo "kernel failed to start"; tail -5 "$WORK/kernel.log"; exit 1; }

node "$RUNNER_BIN" --kernel "http://127.0.0.1:$PORT" --owner e2e-tex-runner --poll-ms 200 --mode docker > "$WORK/runner.log" 2>&1 &
RPID=$!
sleep 2

API="http://127.0.0.1:$PORT"
PASS=0
FAIL=0
ok() { echo "  ok: $*"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL+1)); }

# 1. project + TeX workspace with a real \cite so bibtex matters.
PROJ=$(curl -sf -X POST "$API/v1/projects" -H 'content-type: application/json' \
  -d '{"name":"tex-e2e","workspace":"/w/tex-e2e","mode":"gate-only","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).project_id))")
[ -n "$PROJ" ] && ok "project $PROJ" || { fail "project create"; exit 1; }

DOC=$(curl -sf -X POST "$API/v1/projects/$PROJ/manuscript-drafts" -H 'content-type: application/json' -d '{}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).document_id))")
[ -n "$DOC" ] && ok "tex workspace $DOC" || { fail "workspace"; exit 1; }

# Replace paper.tex with one that cites a real bib entry.
cat > "$WORK/paper.tex" <<'TEX'
\documentclass{article}
\usepackage[margin=1in]{geometry}
\begin{document}
\section{Intro}
We follow prior work \cite{knuth1984}.
\bibliographystyle{plain}
\bibliography{main}
\end{document}
TEX
cat > "$WORK/main.bib" <<'BIB'
@book{knuth1984,
  author = {Donald E. Knuth},
  title = {The {TeX}book},
  publisher = {Addison-Wesley},
  year = {1984}
}
BIB
V=$(curl -sf "$API/v1/documents/$DOC/tree" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const t=JSON.parse(d);const f=t.files.find(x=>x.path==='paper.tex');console.log(f?f.version:'')})")
[ -n "$V" ] && [ "$V" != "0" ] && ok "tree read (paper.tex v$V)" || fail "tree"
put_file() {
  local path="$1" file="$2" exp="$3"
  local body
  if [ -n "$exp" ]; then
    body=$(node -e "console.log(JSON.stringify({path:process.argv[1],content:require('fs').readFileSync(process.argv[2],'utf8'),expected_version:Number(process.argv[3])}))" "$path" "$file" "$exp")
  else
    body=$(node -e "console.log(JSON.stringify({path:process.argv[1],content:require('fs').readFileSync(process.argv[2],'utf8')}))" "$path" "$file")
  fi
  local resp
  resp=$(curl -s -w '\n%{http_code}' -X PUT "$API/v1/documents/$DOC/file" -H 'content-type: application/json' -d "$body")
  local code
  code=$(echo "$resp" | tail -1)
  if [ "$code" != "200" ]; then
    echo "  FAIL: PUT $path -> HTTP $code: $(echo "$resp" | head -1)" >&2
    exit 1
  fi
}
put_file paper.tex "$WORK/paper.tex" "$V"
put_file main.bib "$WORK/main.bib" ""
ok "files written"

# 2. freeze + build: submits the latex-compile job with the frozen manifest.
BUILD=$(curl -sf -X POST "$API/v1/documents/$DOC/builds" -H 'content-type: application/json' \
  -d "{\"expected_document_revision\":$(curl -sf "$API/v1/documents/$DOC/tree" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).document.revision))"),\"image_digest\":\"$IMAGE\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.build.build_id)})")
[ -n "$BUILD" ] && ok "build queued ($BUILD)" || { fail "build create"; exit 1; }

# 3. poll until the build finishes (runner compiles in the texlive container).
STATUS=""
PDF=""
for _ in $(seq 1 120); do
  ROW=$(curl -sf "$API/v1/documents/$DOC/builds/$BUILD")
  STATUS=$(echo "$ROW" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  PDF=$(echo "$ROW" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).pdf_artifact||''))")
  case "$STATUS" in
    succeeded|failed|cancelled) break ;;
  esac
  sleep 1
done
echo "  build status: $STATUS pdf: ${PDF:-none}"
[ "$STATUS" = "succeeded" ] && ok "build succeeded" || fail "build status=$STATUS"
[ -n "$PDF" ] && ok "pdf artifact $PDF" || fail "no pdf artifact"

# 4. PDF artifact serves as application/pdf with inline disposition.
if [ -n "$PDF" ]; then
  HDR=$(curl -sI "$API/v1/artifacts/$PDF?project_id=$PROJ")
  echo "$HDR" | grep -qi "content-type: application/pdf" && ok "pdf content-type" || fail "pdf content-type: $(echo "$HDR" | grep -i content-type || true)"
  echo "$HDR" | grep -qi "content-disposition: inline" && ok "pdf disposition inline" || fail "pdf disposition"
fi

# 5. diagnostics + log artifact present.
DIAGS=$(curl -sf "$API/v1/documents/$DOC/builds/$BUILD" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const b=JSON.parse(d);console.log((JSON.parse(b.diagnostics)||[]).length)})")
ok "diagnostics entries: $DIAGS"

# 6. §7 shell-escape negative: \\write18 must be inert (-no-shell-escape,
# network none, read-only rootfs). If it executed, /outputs/PWNED would exist.
DOC2=$(curl -sf -X POST "$API/v1/projects/$PROJ/manuscript-drafts" -H 'content-type: application/json' -d '{}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).document_id))")
V2=$(curl -sf "$API/v1/documents/$DOC2/tree" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const t=JSON.parse(d);const f=t.files.find(x=>x.path==='paper.tex');console.log(f?f.version:'')})")
node -e "console.log(JSON.stringify({path:'paper.tex',content:'\\\\documentclass{article}\\n\\\\immediate\\\\write18{touch /outputs/PWNED}\\n\\\\begin{document}hi\\\\end{document}\\n',expected_version:$V2}))" > "$WORK/pwn.json"
curl -sf -X PUT "$API/v1/documents/$DOC2/file" -H 'content-type: application/json' -d "@$WORK/pwn.json" > /dev/null
REV2=$(curl -sf "$API/v1/documents/$DOC2/tree" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).document.revision))")
BUILD2=$(curl -sf -X POST "$API/v1/documents/$DOC2/builds" -H 'content-type: application/json' -d "{\"expected_document_revision\":$REV2,\"image_digest\":\"$IMAGE\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.build.build_id)})")
S2=""
for _ in $(seq 1 120); do
  S2=$(curl -sf "$API/v1/documents/$DOC2/builds/$BUILD2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).status))")
  case "$S2" in succeeded|failed|cancelled) break ;; esac
  sleep 1
done
echo "  escape build status: $S2"
[ "$S2" = "succeeded" ] && ok "shell-escape paper compiled (\\write18 inert)" || fail "escape build status=$S2"
PWN=$(curl -sf "$API/v1/documents/$DOC2/builds/$BUILD2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const b=JSON.parse(d);const diags=JSON.parse(b.diagnostics||'[]');console.log(diags.filter(x=>String(x.message).includes('write18')).length)})")
[ "$PWN" = "0" ] && ok "no write18 execution diagnostics" || fail "write18 diagnostics present: $PWN"

echo "== latex-compile e2e: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1
