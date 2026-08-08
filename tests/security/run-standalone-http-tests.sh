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
