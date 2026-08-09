#!/usr/bin/env bash
# OPS-01 + SEC-UI-01 acceptance: standalone startup reliability and
# token/loopback HTTP surface.
#
#   OPS-01: CLI host/port/dataDir/token parsing, real-URL + token-check
#           readiness, failure -> non-zero exit with log tail, cleanup.
#   SEC-UI-01: --no-token requires loopback (direct + start-standalone-ui.sh);
#           token file 0600 / non-symlink / non-empty; /api/token-check 401
#           on wrong token; /v1/* requires the bearer; cross-origin writes
#           rejected; same 127/8 origin allowed; CSRF session token required
#           on /api writes; /api/chat/survey membership fail-closed with
#           unchanged Corpus Snapshot/Outbox counts; token never in server
#           log or kernel/server argv (0600 token-file handoff); stable
#           error bodies without internal paths/env detail.
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
# Kill ONLY the standalone instances this test started (their argv carries the
# $WORK data dir) — never a user's server (e.g. the 8443-facing 18610
# instance). A broad `pkill -f standalone/server.js` here would take the
# user's UI down on every run.
kill_test_servers() {
  for pid in $(pgrep -f "standalone/server.js" 2>/dev/null || true); do
    if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF "$WORK"; then
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap 'kill_test_servers; rm -rf "$WORK"' EXIT

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

# ── SEC-UI-01: CSRF session token gate on /api writes ───────────────────────
R=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/api/session/csrf")
[ "$R" = "401" ] && ok "SEC: GET /api/session/csrf without token -> 401" || fail "SEC: csrf no-token -> $R"
CSRF=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/api/session/csrf" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.csrf_token||'')})")
if printf '%s' "$CSRF" | grep -qE '^[0-9a-f]{64}$'; then
  ok "SEC: GET /api/session/csrf issues a 32-byte hex token"
else
  fail "SEC: csrf token malformed -> '$CSRF'"
fi
CSRF2=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/api/session/csrf" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.csrf_token||'')})")
[ "$CSRF2" = "$CSRF" ] && ok "SEC: csrf token stable per process" || fail "SEC: csrf token rotated unexpectedly"
R=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$WEB_PORT/api/model" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$WEB_PORT" -H 'content-type: application/json' -d '{"model":"deepseek-v4-flash"}')
[ "$R" = "403" ] && ok "SEC: PUT /api/model without csrf -> 403" || fail "SEC: PUT model no-csrf -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$WEB_PORT/api/model" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$WEB_PORT" -H 'x-csrf-token: deadbeef' -H 'content-type: application/json' -d '{"model":"deepseek-v4-flash"}')
[ "$R" = "403" ] && ok "SEC: PUT /api/model wrong csrf -> 403" || fail "SEC: PUT model bad-csrf -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$WEB_PORT" -H 'content-type: application/json' -d '{"project_id":"x","query":"y"}')
[ "$R" = "403" ] && ok "SEC: survey without csrf -> 403" || fail "SEC: survey no-csrf -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$WEB_PORT" -H 'x-csrf-token: deadbeef' -H 'content-type: application/json' -d '{"project_id":"x","query":"y"}')
[ "$R" = "403" ] && ok "SEC: survey wrong csrf -> 403" || fail "SEC: survey bad-csrf -> $R"

# ── SEC-UI-01: /v1/* requires the bearer ───────────────────────────────────
R=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/v1/projects")
[ "$R" = "401" ] && ok "SEC: /v1/projects without token -> 401" || fail "SEC: no-token /v1/projects -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong" "http://127.0.0.1:$WEB_PORT/v1/projects")
[ "$R" = "401" ] && ok "SEC: /v1/projects bad bearer -> 401" || fail "SEC: bad bearer -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/v1/projects")
[ "$R" = "200" ] && ok "SEC: /v1/projects good bearer -> 200" || fail "SEC: good bearer -> $R"

# ── SEC-UI-01: cross-origin writes rejected, same-127/8 allowed ───────────
# (Origin stays a SECOND layer on top of the CSRF token.)
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $CSRF" -H 'Origin: http://evil.example' -H 'content-type: application/json' -d '{}')
[ "$R" = "403" ] && ok "SEC: foreign Origin + valid csrf -> 403" || fail "SEC: foreign origin -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $CSRF" -H "Origin: http://127.0.0.1:$WEB_PORT" -H 'content-type: application/json' -d '{}')
[ "$R" = "400" ] && ok "SEC: same-origin (127/8 + port) + csrf passes gate (got $R)" || fail "SEC: same-origin -> $R"
# A DIFFERENT loopback port is a different origin — CSRF must reject it.
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $CSRF" -H "Origin: http://127.0.0.1:$(($WEB_PORT + 100))" -H 'content-type: application/json' -d '{}')
[ "$R" = "403" ] && ok "SEC: cross-port loopback origin + valid csrf -> 403" || fail "SEC: cross-port origin -> $R"

# ── model preference seat (/api/model): catalog + persist + authz ──────────
R=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/api/model")
[ "$R" = "401" ] && ok "MODEL: /api/model without token -> 401" || fail "MODEL: no-token /api/model -> $R"
M=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/api/model")
if echo "$M" | grep -q 'deepseek-v4-flash' && echo "$M" | grep -q '"ok":true'; then
  ok "MODEL: GET /api/model with token -> catalog + current preference"
else
  fail "MODEL: GET /api/model payload -> $M"
fi
R=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$WEB_PORT/api/model" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$WEB_PORT" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -d '{"model":"deepseek-v4-pro"}')
[ "$R" = "200" ] && ok "MODEL: PUT /api/model persists (deepseek-v4-pro)" || fail "MODEL: PUT persist -> $R"
M=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/api/model")
echo "$M" | grep -q '"model":"deepseek-v4-pro"' && ok "MODEL: preference re-read after persist" || fail "MODEL: re-read -> $M"
R=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$WEB_PORT/api/model" \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:$WEB_PORT" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -d '{"model":"gpt-unknown"}')
[ "$R" = "422" ] && ok "MODEL: unknown model -> 422" || fail "MODEL: unknown model -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "http://127.0.0.1:$WEB_PORT/api/model" \
  -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $CSRF" -H 'Origin: http://evil.example' -H 'content-type: application/json' -d '{"model":"deepseek-v4-flash"}')
[ "$R" = "403" ] && ok "MODEL: foreign-origin PUT + valid csrf -> 403" || fail "MODEL: foreign origin -> $R"

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
# ── §9: job-scoped routes (terminal SSE) check membership before streaming ──
if [ "$memready" = 1 ] && [ -n "$MP" ]; then
  # Submit a job on the member project, then verify the terminal SSE route.
  JID=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -X POST "http://127.0.0.1:$MEM_WEB/v1/projects/$MP/jobs" \
    -d '{"idempotency_key":"mem-job-1","kind":"echo","payload":{"message":"hi"}}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.job_id||'')})")
  [ -n "$JID" ] && ok "API-01: member job created ($JID)" || fail "API-01: job create"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/jobs/$JID/terminal" -m 5 || true)
  [ "$R" = "200" ] && ok "API-01: PI opens terminal SSE -> 200" || fail "API-01: PI terminal -> $R"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$((MEM_WEB + 2))/v1/jobs/$JID/terminal" -m 5 || true)
  [ "$R" = "404" ] && ok "API-01: non-member terminal SSE -> 404" || fail "API-01: non-member terminal -> $R"
fi

# ── SEC-UI-01: /api/chat/survey membership fail-closed ──────────────────────
# With --principal ops-1, survey on a FOREIGN project must 404 BEFORE the
# connector runs or the corpus is written: snapshot/outbox counts unchanged.
if [ "$memready" = 1 ] && [ -n "$MP" ]; then
  MEMCSRF=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/api/session/csrf" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.csrf_token||'')})")
  [ -n "$MEMCSRF" ] && ok "SEC: BFF issues its own csrf token for survey" || fail "SEC: BFF csrf fetch"
  # Project B exists on the kernel but ops-1 is NOT a member (foreign PI).
  PB=$(curl -s -H 'content-type: application/json' -X POST "http://127.0.0.1:$MEM_KERNEL/v1/projects" \
    -d '{"name":"foreign-b","workspace":"/w/foreign-b","mode":"gate-only","creator_principal_id":"ops-other","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}' \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.project_id||'')})")
  [ -n "$PB" ] && ok "SEC: foreign project B created on kernel ($PB)" || fail "SEC: foreign project B create"
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$MEM_WEB/v1/projects/$PB")
  [ "$R" = "404" ] && ok "SEC: ops-1 cannot read foreign project B -> 404" || fail "SEC: B read -> $R"
  count_json() { curl -s "http://127.0.0.1:$MEM_KERNEL/v1/projects/$1/$2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const a=JSON.parse(d);console.log(Array.isArray(a)?a.length:'ERR')}catch(e){console.log('ERR')}})"; }
  B_SNAP_BEFORE=$(count_json "$PB" corpus-snapshots)
  B_EVT_BEFORE=$(count_json "$PB" events)
  A_SNAP_BEFORE=$(count_json "$MP" corpus-snapshots)
  A_EVT_BEFORE=$(count_json "$MP" events)
  BODY=$(curl -s -X POST "http://127.0.0.1:$MEM_WEB/api/chat/survey" \
    -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $MEMCSRF" -H "Origin: http://127.0.0.1:$MEM_WEB" \
    -H 'content-type: application/json' -d "{\"project_id\":\"$PB\",\"query\":\"temporal action localization\"}")
  case "$BODY" in
    *'"ok":false'*'project not found or access denied'*) ok "SEC: foreign project survey -> 404 fail-closed body" ;;
    *) fail "SEC: foreign survey body -> $BODY" ;;
  esac
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$MEM_WEB/api/chat/survey" \
    -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $MEMCSRF" -H "Origin: http://127.0.0.1:$MEM_WEB" \
    -H 'content-type: application/json' -d "{\"project_id\":\"$PB\",\"query\":\"temporal action localization\"}")
  [ "$R" = "404" ] && ok "SEC: foreign project survey -> 404" || fail "SEC: foreign survey -> $R"
  [ "$(count_json "$PB" corpus-snapshots)" = "$B_SNAP_BEFORE" ] && ok "SEC: foreign survey leaves B corpus snapshot count unchanged ($B_SNAP_BEFORE)" || fail "SEC: B snapshot count changed"
  [ "$(count_json "$PB" events)" = "$B_EVT_BEFORE" ] && ok "SEC: foreign survey leaves B outbox/events count unchanged ($B_EVT_BEFORE)" || fail "SEC: B events changed"
  BODY=$(curl -s -X POST "http://127.0.0.1:$MEM_WEB/api/chat/survey" \
    -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $MEMCSRF" -H "Origin: http://127.0.0.1:$MEM_WEB" \
    -H 'content-type: application/json' -d '{"project_id":"rsp_nonexistent","query":"temporal action localization"}')
  case "$BODY" in
    *'"ok":false'*'project not found or access denied'*) ok "SEC: unknown project survey -> 404 fail-closed body" ;;
    *) fail "SEC: unknown survey body -> $BODY" ;;
  esac
  # Member's OWN project: survey runs and writes exactly one new snapshot.
  R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$MEM_WEB/api/chat/survey" \
    -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $MEMCSRF" -H "Origin: http://127.0.0.1:$MEM_WEB" \
    -H 'content-type: application/json' -d "{\"project_id\":\"$MP\",\"query\":\"temporal action localization\"}" -m 90)
  [ "$R" = "200" ] && ok "SEC: member project survey -> 200" || fail "SEC: member survey -> $R"
  [ "$(count_json "$MP" corpus-snapshots)" = "$((A_SNAP_BEFORE + 1))" ] && ok "SEC: member survey writes exactly one corpus snapshot ($((A_SNAP_BEFORE + 1)))" || fail "SEC: A snapshot count after survey"
  [ "$(count_json "$MP" events)" = "$((A_EVT_BEFORE + 1))" ] && ok "SEC: member survey emits exactly one outbox event ($((A_EVT_BEFORE + 1)))" || fail "SEC: A events after survey"
  # Stable error codes: the fail-closed body never echoes internal detail.
  for NEEDLE in '/home/' '/dev/' 'http://' 'at ' 'env'; do
    if printf '%s' "$BODY" | grep -qF "$NEEDLE"; then
      fail "SEC: fail-closed body leaks '$NEEDLE' -> $BODY"
    else
      ok "SEC: fail-closed body has no '$NEEDLE'"
    fi
  done
fi

kill "$MEM_PID" "$MEM2_PID" 2>/dev/null || true
for _ in $(seq 1 15); do
  if ! ss -ltn 2>/dev/null | grep -qE ":$MEM_WEB |:$((MEM_WEB + 2)) "; then break; fi
  sleep 0.5
done
ok "API-01: BFF instances cleaned up"

# ── §9: legacy DSH bridge paths must 404 (no SPA/v1 fallback) ─────────────
for PTH in /research-api /research-ui-api /research-api/anything /research-ui-api/x /research-ui-api/v1/projects; do
  R=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT$PTH")
  [ "$R" = "404" ] && ok "SEC: $PTH -> 404" || fail "SEC: $PTH -> $R"
  # Must be a real JSON 404 — never the SPA bootstrap HTML and never a
  # fallback to the /v1 kernel proxy (which would answer 200/401/502).
  BODY=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT$PTH")
  case "$BODY" in
    *'"ok":false'*|*'"error"'*) ok "SEC: $PTH body is a JSON error (not SPA fallback)" ;;
    *) fail "SEC: $PTH body is not a JSON 404: ${BODY:0:60}" ;;
  esac
done
# POST on the legacy bridge paths must also 404 (no accidental proxy).
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$WEB_PORT/research-api/projects")
[ "$R" = "404" ] && ok "SEC: POST /research-api/projects -> 404" || fail "SEC: POST /research-api -> $R"

# ── §9.1: the standalone token must never reach the kernel argv ────────────
KPID_BY_PORT=$(ss -ltnp 2>/dev/null | grep ":$KERNEL_PORT " | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "$KPID_BY_PORT" ]; then
  if tr '\0' ' ' < "/proc/$KPID_BY_PORT/cmdline" 2>/dev/null | grep -q "$TOKEN"; then
    fail "SEC: standalone token leaked into kernel argv"
  else
    ok "SEC: token absent from kernel argv"
  fi
else
  fail "SEC: kernel pid not found for argv check"
fi

# ── §9.1: the token must never be written to the server log ────────────────
if grep -q "$TOKEN" "$LOG" 2>/dev/null; then
  fail "SEC: standalone token leaked into server log"
else
  ok "SEC: token absent from server log"
fi

# ── API-01/v2: Idempotency-Key + X-Request-Id pass through the proxy ──────
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'idempotency-key: v2-proxy-idem-1' -H 'x-request-id: req_proxy_1' \
  "http://127.0.0.1:$WEB_PORT/v2/projects" \
  -d '{"name":"v2-rt","workspace":"/w/v2rt","mode":"gate-only","creator_principal_id":"ops-1","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}')
[ "$R" = "201" ] && ok "API-01: v2 create via proxy (idem-key forwarded) -> 201" || fail "API-01: v2 create via proxy -> $R"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'idempotency-key: v2-proxy-idem-1' \
  "http://127.0.0.1:$WEB_PORT/v2/projects" \
  -d '{"name":"v2-rt","workspace":"/w/v2rt","mode":"gate-only","creator_principal_id":"ops-1","brief":{"problem":"p","scope":"s","questions":[],"primary_metrics":["m"],"resources":"","risks":[],"target_outputs":["paper"],"target_venue":null,"baseline_repo":null,"domain":"ml"}}')
[ "$R" = "201" ] && ok "API-01: v2 idempotent replay via proxy -> 201" || fail "API-01: v2 replay -> $R"

# ── SEC-UI-01: stable error codes (no connector URL / internal paths) ───────
# Survey on a nonexistent project with NO principal: the connector may run,
# but the corpus write fails -> 502 with a generic message; the proxy error
# bodies must never echo internal details.
BODY=$(curl -s -X POST "http://127.0.0.1:$WEB_PORT/api/chat/survey" \
  -H "Authorization: Bearer $TOKEN" -H "x-csrf-token: $CSRF" -H "Origin: http://127.0.0.1:$WEB_PORT" \
  -H 'content-type: application/json' -d '{"project_id":"rsp_nonexistent","query":"temporal action localization"}' -m 90)
case "$BODY" in
  *'"ok":false'*'connector unavailable'*|*'"ok":false'*'corpus snapshot failed'*) ok "SEC: survey 502 body is generic" ;;
  *) fail "SEC: survey 502 body -> $BODY" ;;
esac
BODY=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$WEB_PORT/v1/projects/rsp_nonexistent")
case "$BODY" in
  *'"code"'*'"message"'*) ok "SEC: proxy 404 body is structured and generic" ;;
  *) fail "SEC: proxy 404 body -> $BODY" ;;
esac
for NEEDLE in '/home/' '/dev/' '/usr/' 'http://' 'https://' 'env' ' at '; do
  if printf '%s' "$BODY" | grep -qF "$NEEDLE"; then
    fail "SEC: error body leaks '$NEEDLE' -> $BODY"
  else
    ok "SEC: error body has no '$NEEDLE'"
  fi
done

# ── OPS-01: clean shutdown frees both ports ────────────────────────────────
kill "$SPID" 2>/dev/null || true
for _ in $(seq 1 20); do
  if ! ss -ltn 2>/dev/null | grep -qE ":$WEB_PORT |:$KERNEL_PORT "; then break; fi
  sleep 0.5
done
if ss -ltn 2>/dev/null | grep -qE ":$WEB_PORT |:$KERNEL_PORT "; then
  fail "OPS: ports still bound after kill"
  kill_test_servers
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
# §9.1: --no-token accepts ONLY localhost / ::1 / 127.0.0.0/8. Every
# non-loopback combination (wildcard, LAN, hostname) must fail in loadOptions
# BEFORE listen — nothing may bind.
for BAD_HOST in 0.0.0.0 192.168.1.9 10.0.0.5 example.test; do
  NLOG="$WORK/notoken-$BAD_HOST.log"
  if node "$SERVER_BIN" --host "$BAD_HOST" --port "$((CONFLICT_PORT + 100))" --kernel-port "$((CONFLICT_PORT + 101))" \
    --data-dir "$WORK/ntdata-$BAD_HOST" --no-token > "$NLOG" 2>&1; then
    fail "SEC: --no-token on $BAD_HOST accepted"
  else
    ok "SEC: --no-token on $BAD_HOST rejected before listen"
  fi
  R=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$((CONFLICT_PORT + 100))/" 2>/dev/null || true)
  [ "$R" = "000" ] && ok "SEC: rejected $BAD_HOST server not listening" || fail "SEC: rejected $BAD_HOST server responded $R"
done
# Loopback 127.0.0.0/8 outside 127.0.0.1 stays allowed with --no-token.
NLOG="$WORK/notoken-lo.log"
node "$SERVER_BIN" --host 127.0.0.2 --port "$((CONFLICT_PORT + 100))" --kernel-port "$((CONFLICT_PORT + 101))" \
  --data-dir "$WORK/ntdata-lo" --no-token > "$NLOG" 2>&1 &
NOTOKEN_PID=$!
sleep 1
if kill -0 "$NOTOKEN_PID" 2>/dev/null; then
  ok "SEC: --no-token on 127.0.0.2 (127/8) accepted"
else
  fail "SEC: --no-token on 127.0.0.2 rejected (log: $(tail -2 "$NLOG" | tr '\n' ' '))"
fi
kill "$NOTOKEN_PID" 2>/dev/null || true

# ── SEC-UI-01: start-standalone-ui.sh --no-token host combos ────────────────
# §9.1: the SUPPORTED launcher must fail the same way before anything binds,
# with a stable error message that contains no internal path.
for BAD_HOST in 0.0.0.0 192.168.1.9 example.test; do
  SLOG="$WORK/script-nt-$BAD_HOST.log"
  if DSH_SCHOLAR_STANDALONE_PORT="$((CONFLICT_PORT + 110))" DSH_SCHOLAR_STANDALONE_KERNEL_PORT="$((CONFLICT_PORT + 111))" \
      DSH_SCHOLAR_STANDALONE_DATA="$WORK/script-ntdata-$BAD_HOST" \
      bash "$REPO/scripts/start-standalone-ui.sh" --host "$BAD_HOST" --no-token > "$SLOG" 2>&1; then
    fail "SEC: script --no-token on $BAD_HOST accepted"
  else
    ok "SEC: script --no-token on $BAD_HOST fails non-zero"
  fi
  if grep -q "loopback" "$SLOG"; then
    ok "SEC: script $BAD_HOST error names the loopback requirement"
  else
    fail "SEC: script $BAD_HOST error message (got: $(tail -3 "$SLOG" | tr '\n' ' '))"
  fi
  if grep -qE "/home/|/dev/|/usr/|\.ts[0-9]?:" "$SLOG"; then
    fail "SEC: script $BAD_HOST error leaks an internal path"
  else
    ok "SEC: script $BAD_HOST error has no internal path"
  fi
  R=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$((CONFLICT_PORT + 110))/" 2>/dev/null || true)
  [ "$R" = "000" ] && ok "SEC: script rejected $BAD_HOST not listening" || fail "SEC: script rejected $BAD_HOST responded $R"
done

# ── SEC-UI-01: script --no-token on loopback starts and readies ─────────────
SLOOP_WEB=$((CONFLICT_PORT + 120))
SLOOP_KERNEL=$((CONFLICT_PORT + 121))
SLOOP_DATA="$WORK/script-lo-data"
if DSH_SCHOLAR_STANDALONE_DATA="$SLOOP_DATA" \
    bash "$REPO/scripts/start-standalone-ui.sh" --host 127.0.0.1 --port "$SLOOP_WEB" --kernel-port "$SLOOP_KERNEL" \
    --data-dir "$SLOOP_DATA/research-ui-standalone" --no-token > "$WORK/script-lo.log" 2>&1; then
  ok "SEC: script --no-token on 127.0.0.1 exits 0 after readiness"
else
  fail "SEC: script --no-token loopback did not become ready (log: $(tail -3 "$WORK/script-lo.log" | tr '\n' ' '))"
fi
SLOOP_PID=$(ss -ltnp 2>/dev/null | grep ":$SLOOP_WEB " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "$SLOOP_PID" ]; then
  kill "$SLOOP_PID" 2>/dev/null || true
  for _ in $(seq 1 15); do
    if ! ss -ltn 2>/dev/null | grep -qE ":$SLOOP_WEB |:$SLOOP_KERNEL "; then break; fi
    sleep 0.5
  done
  ok "SEC: script --no-token instance cleaned up"
else
  fail "SEC: script --no-token server pid not found for cleanup"
  kill_test_servers
fi

# ── SEC-UI-01: script --token never reaches argv or logs ────────────────────
# §9.1: token mode must keep the secret out of the server/Kernel argv and the
# server log; the launcher hands it over through the 0600 token file only.
SECRET="secret-token-xyz-$(date +%s)"
SWEB=$((CONFLICT_PORT + 130))
SKERNEL=$((CONFLICT_PORT + 131))
SDATA="$WORK/script-tok-data"
if DSH_SCHOLAR_STANDALONE_DATA="$SDATA" \
    bash "$REPO/scripts/start-standalone-ui.sh" --host 127.0.0.1 --port "$SWEB" --kernel-port "$SKERNEL" \
    --data-dir "$SDATA/research-ui-standalone" --token "$SECRET" > "$WORK/script-tok.log" 2>&1; then
  ok "SEC: script --token exits 0 after token-check readiness"
else
  fail "SEC: script --token did not become ready (log: $(tail -3 "$WORK/script-tok.log" | tr '\n' ' '))"
fi
if grep -q "$SECRET" "$WORK/script-tok.log" 2>/dev/null; then
  fail "SEC: launcher echoed the token in its own output"
else
  ok "SEC: launcher output does not contain the token"
fi
if grep -q "$SECRET" "$SDATA/standalone.log" 2>/dev/null; then
  fail "SEC: token leaked into standalone.log"
else
  ok "SEC: standalone.log does not contain the token"
fi
[ "$(stat -c %a "$SDATA/research-ui-standalone/standalone-token" 2>/dev/null || echo '?')" = "600" ] \
  && ok "SEC: script-written token file 0600" || fail "SEC: script token file mode"
[ "$(tr -d '\n' < "$SDATA/research-ui-standalone/standalone-token")" = "$SECRET" ] \
  && ok "SEC: script token file carries the exact secret" || fail "SEC: script token file mismatch"
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$SWEB/api/token-check" -H 'content-type: application/json' -d "{\"token\":\"$SECRET\"}")
[ "$R" = "200" ] && ok "SEC: script-started server accepts the token" || fail "SEC: script token-check -> $R"
for PORT in "$SWEB" "$SKERNEL"; do
  PID=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
  if [ -z "$PID" ]; then
    fail "SEC: no pid found on port $PORT for argv scan"
    continue
  fi
  if tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null | grep -q "$SECRET"; then
    fail "SEC: token leaked into argv of pid $PID (port $PORT)"
  else
    ok "SEC: token absent from argv of pid $PID (port $PORT)"
  fi
done
# Cleanup the script-started instance (setsid process group).
SWEB_PID=$(ss -ltnp 2>/dev/null | grep ":$SWEB " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "$SWEB_PID" ]; then
  kill -- "-$SWEB_PID" 2>/dev/null || kill "$SWEB_PID" 2>/dev/null || true
  for _ in $(seq 1 15); do
    if ! ss -ltn 2>/dev/null | grep -qE ":$SWEB |:$SKERNEL "; then break; fi
    sleep 0.5
  done
  ok "SEC: script token instance cleaned up"
else
  fail "SEC: script token server pid not found for cleanup"
  kill_test_servers
fi

echo "== standalone http acceptance: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] || exit 1
