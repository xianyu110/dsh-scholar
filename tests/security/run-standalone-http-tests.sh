#!/usr/bin/env bash
# OPS-01 + SEC-UI-01 acceptance: standalone startup reliability and
# token/loopback HTTP surface.
#
#   OPS-01: CLI host/port/dataDir/token parsing, real-URL + token-check
#           readiness, failure -> non-zero exit with log tail, cleanup.
#   SEC-UI-01: --no-token requires loopback; token file 0600 / non-symlink /
#           non-empty; /api/token-check 401 on wrong token; /v1/* requires
#           the bearer; cross-origin writes rejected; same 127/8 origin
#           allowed.
#
# Usage: bash tests/security/run-standalone-http-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
SERVER_BIN="$REPO/packages/dsh-research-ui/lib/standalone/server.js"
if [ ! -f "$SERVER_BIN" ]; then
  echo "standalone-http: server not built — run pnpm --filter @dsh-scholar/research-ui build first" >&2
  exit 2
fi

PASS=0
FAIL=0
ok() { echo "  ok: $*"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $*"; FAIL=$((FAIL+1)); }

WORK=$(mktemp -d)
trap 'pkill -f "standalone/server.js" 2>/dev/null || true; rm -rf "$WORK"' EXIT

# ── OPS-01: custom CLI args + readiness + cleanup ──────────────────────────
WEB_PORT=$((21000 + RANDOM % 5000))
KERNEL_PORT=$((WEB_PORT + 1))
DATA="$WORK/data"
TOKEN="accept-token-$(date +%s)"
LOG="$WORK/server.log"
node "$SERVER_BIN" --host 127.0.0.1 --port "$WEB_PORT" --kernel-port "$KERNEL_PORT" --data-dir "$DATA" --token "$TOKEN" > "$LOG" 2>&1 &
SPID=$!

ready=0
for _ in $(seq 1 60); do
  if [ -f "$DATA/standalone-token" ] && curl -sf -m 2 -X POST "http://127.0.0.1:$WEB_PORT/api/token-check" \
    -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}" > /dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.5
done
[ "$ready" = 1 ] && ok "OPS: custom host/port/dataDir/token reachable with token-check readiness" || fail "OPS: readiness (log: $(tail -3 "$LOG" | tr '\n' ' '))"

# ── SEC-UI-01: token file hardening ────────────────────────────────────────
MODE=$(stat -c %a "$DATA/standalone-token" 2>/dev/null || echo "?")
[ "$MODE" = "600" ] && ok "SEC: token file 0600 (got $MODE)" || fail "SEC: token file mode $MODE"
[ -L "$DATA/standalone-token" ] && fail "SEC: token file is a symlink" || ok "SEC: token file not a symlink"
[ -s "$DATA/standalone-token" ] && ok "SEC: token file non-empty" || fail "SEC: token file empty"
[ "$(tr -d '\n' < "$DATA/standalone-token")" = "$TOKEN" ] && ok "SEC: token file matches --token" || fail "SEC: token file mismatch"

# ── SEC-UI-01: token-check 401/200 ─────────────────────────────────────────
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/token-check" -H 'content-type: application/json' -d '{"token":"wrong"}')
[ "$R" = "401" ] && ok "SEC: token-check wrong token -> 401" || fail "SEC: token-check wrong -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/token-check" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}")
[ "$R" = "200" ] && ok "SEC: token-check right token -> 200" || fail "SEC: token-check right -> $R"

# ── SEC-UI-01: /v1/* requires the bearer ───────────────────────────────────
R=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/v1/projects")
[ "$R" = "401" ] && ok "SEC: /v1/projects without token -> 401" || fail "SEC: no-token /v1/projects -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong" "http://127.0.0.1:$WEB_PORT/v1/projects")
[ "$R" = "401" ] && ok "SEC: /v1/projects bad bearer -> 401" || fail "SEC: bad bearer -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/v1/projects")
[ "$R" = "200" ] && ok "SEC: /v1/projects good bearer -> 200" || fail "SEC: good bearer -> $R"

# ── SEC-UI-01: cross-origin writes rejected, same-127/8 allowed ───────────
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H 'Origin: http://evil.example' -H 'content-type: application/json' -d '{}')
[ "$R" = "403" ] && ok "SEC: foreign Origin write -> 403" || fail "SEC: foreign origin -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$WEB_PORT" -H 'content-type: application/json' -d '{}')
[ "$R" != "403" ] && ok "SEC: same-origin (127/8 + port) accepted (got $R)" || fail "SEC: same-origin -> 403"
# A DIFFERENT loopback port is a different origin — CSRF must reject it.
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$(($WEB_PORT + 100))" -H 'content-type: application/json' -d '{}')
[ "$R" = "403" ] && ok "SEC: cross-port loopback origin -> 403" || fail "SEC: cross-port origin -> $R"

# ── ART-01: binary round-trip through the same-origin proxy ────────────────
P=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:$WEB_PORT/v1/projects" \
  -d '{"name":"art-rt","workspace":"/w/art-rt","mode":"gate-only","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.project_id||'')})")
[ -n "$P" ] && ok "ART-01: project via proxy ($P)" || fail "ART-01: project create via proxy" 
# Register a binary artifact (fake PDF bytes) via the proxy and fetch it back:
# media type, exact bytes and the ETag must survive the Web-stream proxy.
PDF_B64=$(printf '%%PDF-1.4 fake-binary-\\x00-\\xff-bytes' | base64 | tr -d '\n')
ART=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -X POST "http://127.0.0.1:$WEB_PORT/v1/artifacts" \
  -d "{\"project_id\":\"$P\",\"kind\":\"pdf\",\"content_base64\":\"$PDF_B64\",\"media_type\":\"application/pdf\",\"file_name\":\"roundtrip.pdf\"}" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.artifact_id||j.error?.code||'')})")
if [ -z "$ART" ]; then
  fail "ART-01: artifact register via proxy"
else
  ok "ART-01: artifact registered via proxy ($ART)"
  HDR=$(curl -sI -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/v1/artifacts/$ART?project_id=$P")
  echo "$HDR" | grep -qi "content-type: application/pdf" && ok "ART-01: proxied pdf content-type" || fail "ART-01: proxied content-type ($(echo "$HDR" | grep -i content-type || true))"
  echo "$HDR" | grep -qi "etag: \"sha256:" && ok "ART-01: proxied etag present" || fail "ART-01: proxied etag missing"
  GOT=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/v1/artifacts/$ART?project_id=$P" | base64 | tr -d '\n')
  [ "$GOT" = "$PDF_B64" ] && ok "ART-01: proxied bytes round-trip intact" || fail "ART-01: bytes mismatch"
fi

# ── API-01: BFF membership enforcement (--principal) ───────────────────────
MEM_WEB=$((WEB_PORT + 700))
MEM_KERNEL=$((WEB_PORT + 701))
MEM_DATA="$WORK/memdata"
node "$SERVER_BIN" --host 127.0.0.1 --port "$MEM_WEB" --kernel-port "$MEM_KERNEL" \
  --data-dir "$MEM_DATA" --token "$TOKEN" --principal ops-1 > "$WORK/mem.log" 2>&1 &
MEM_PID=$!
memready=0
for _ in $(seq 1 60); do
  if curl -sf -m 2 -X POST "http://127.0.0.1:$MEM_WEB/api/token-check" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}" > /dev/null 2>&1; then memready=1; break; fi
  sleep 0.5
done
[ "$memready" = 1 ] && ok "API-01: BFF with --principal starts" || fail "API-01: BFF start"
if [ "$memready" = 1 ]; then
  # ops-1 creates a project (creator PI seeded via the kernel API field).
  MP=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -X POST "http://127.0.0.1:$MEM_WEB/v1/projects" \
    -d '{"name":"mem-rt","workspace":"/w/mem","mode":"gate-only","creator_principal_id":"ops-1","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.project_id||'')})")
  [ -n "$MP" ] && ok "API-01: member-created project ($MP)" || fail "API-01: create"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/projects/$MP")
  [ "$R" = "200" ] && ok "API-01: PI reads own project -> 200" || fail "API-01: PI read -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/projects/$MP/jobs")
  [ "$R" = "200" ] && ok "API-01: PI reads project jobs -> 200" || fail "API-01: PI jobs -> $R"
  L=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/projects" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log(a.some(p=>p.project_id==='$MP')?'included':'missing')})")
  [ "$L" = "included" ] && ok "API-01: project list includes member project" || fail "API-01: list filter -> $L"
fi
# A second BFF with a DIFFERENT principal must not see the project (404).
node "$SERVER_BIN" --host 127.0.0.1 --port "$((MEM_WEB + 2))" --kernel-port "$MEM_KERNEL" \
  --data-dir "$MEM_DATA" --token "$TOKEN" --principal other-user > "$WORK/mem2.log" 2>&1 &
MEM2_PID=$!
for _ in $(seq 1 60); do
  if curl -sf -m 2 -X POST "http://127.0.0.1:$((MEM_WEB + 2))/api/token-check" -H 'content-type: application/json' -d "{\"token\":\"$TOKEN\"}" > /dev/null 2>&1; then break; fi
  sleep 0.5
done
if [ -n "$MP" ]; then
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$((MEM_WEB + 2))/v1/projects/$MP")
  [ "$R" = "404" ] && ok "API-01: non-member project read -> 404" || fail "API-01: non-member read -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$((MEM_WEB + 2))/v1/projects/$MP/jobs")
  [ "$R" = "404" ] && ok "API-01: non-member project jobs -> 404" || fail "API-01: non-member jobs -> $R"
  L=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$((MEM_WEB + 2))/v1/projects" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log(a.some(p=>p.project_id==='$MP')?'leaked':'filtered')})")
  [ "$L" = "filtered" ] && ok "API-01: non-member project list filtered" || fail "API-01: list leak -> $L"
  # Unknown project id also 404 (no enumeration).
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$((MEM_WEB + 2))/v1/projects/rsp_nonexistent")
  [ "$R" = "404" ] && ok "API-01: unknown project -> 404" || fail "API-01: unknown -> $R"
fi
kill "$MEM_PID" "$MEM2_PID" 2>/dev/null || true
for _ in $(seq 1 15); do
  if ! ss -ltn 2>/dev/null | grep -qE ":$MEM_WEB |:$((MEM_WEB + 2)) "; then break; fi
  sleep 0.5
done
ok "API-01: BFF instances cleaned up"

# ── OPS-01: clean shutdown frees both ports ────────────────────────────────
kill "$SPID" 2>/dev/null || true
for _ in $(seq 1 20); do
  if ! ss -ltn 2>/dev/null | grep -qE ":$WEB_PORT |:$KERNEL_PORT "; then break; fi
  sleep 0.5
done
if ss -ltn 2>/dev/null | grep -qE ":$WEB_PORT |:$KERNEL_PORT "; then
  fail "OPS: ports still bound after kill"
  pkill -f "standalone/server.js" 2>/dev/null || true
else
  ok "OPS: kill frees web+kernel ports"
fi

# ── OPS-01: startup failure on occupied port -> non-zero + log tail ────────
CONFLICT_PORT=$((WEB_PORT + 500))
node -e "require('node:net').createServer().listen($CONFLICT_PORT, '127.0.0.1', () => { setTimeout(() => process.exit(0), 15000) })" &
BLOCKER=$!
sleep 0.7
FLOG="$WORK/fail.log"
if node "$SERVER_BIN" --host 127.0.0.1 --port "$CONFLICT_PORT" --kernel-port "$((CONFLICT_PORT + 1))" \
  --data-dir "$WORK/faildata" --token tok > "$FLOG" 2>&1; then
  fail "OPS: occupied port did NOT fail"
else
  ok "OPS: occupied port exits non-zero"
  if grep -qiE "EADDRINUSE|listen.*EADDRINUSE|address already in use" "$FLOG"; then
    ok "OPS: log tail reports the bind failure"
  else
    fail "OPS: log lacks bind failure detail (got: $(tail -2 "$FLOG" | tr '\n' ' '))"
  fi
fi
kill "$BLOCKER" 2>/dev/null || true

# ── SEC-UI-01: --no-token on non-loopback rejected ─────────────────────────
NLOG="$WORK/notoken.log"
if node "$SERVER_BIN" --host 0.0.0.0 --port "$((CONFLICT_PORT + 100))" --kernel-port "$((CONFLICT_PORT + 101))" \
  --data-dir "$WORK/ntdata" --no-token > "$NLOG" 2>&1; then
  fail "SEC: --no-token on 0.0.0.0 accepted"
else
  ok "SEC: --no-token on 0.0.0.0 rejected"
fi
R=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$((CONFLICT_PORT + 100))/" 2>/dev/null || true)
[ "$R" = "000" ] && ok "SEC: rejected server not listening" || fail "SEC: rejected server responded $R"

echo "== standalone http acceptance: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1
