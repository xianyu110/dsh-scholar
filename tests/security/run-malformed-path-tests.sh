#!/usr/bin/env bash
# §19.2 / acceptance-tests.md §3 blocking test: malformed percent-encoding
# in the request path must answer JSON 400 and MUST NOT crash the kernel
# (decodeURIComponent throws on %zz / truncated escapes; the server has to
# catch it, not die).
#
# Usage: bash tests/security/run-malformed-path-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js"
WORK=$(mktemp -d)
PORT=""
KERNEL_PID=""
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL+1)); }

for port in $((22200 + $$ % 400)) $((22700 + $$ % 400)); do
  PORT=$port
  nohup node "$KERNEL_BIN" --db "$WORK/kernel.db" --cas "$WORK/cas" --port "$PORT" > "$WORK/kernel.log" 2>&1 &
  KERNEL_PID=$!
  for _ in $(seq 1 40); do
    curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break
    sleep 0.1
  done
  curl -sf "http://127.0.0.1:$PORT/v1/health" > /dev/null 2>&1 && break
  kill -9 "$KERNEL_PID" 2>/dev/null || true
  KERNEL_PID=""
done
if [ -z "$KERNEL_PID" ]; then echo "kernel failed to start"; exit 1; fi

BASE="http://127.0.0.1:$PORT"

# 1. Malformed escape in the path -> JSON 400 with a stable code.
RESP=$(curl -s -w '\n%{http_code}' --path-as-is "$BASE/v1/projects/%zz")
CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | head -n -1)
if [ "$CODE" = "400" ] && echo "$BODY" | grep -q '"code":"invalid_encoding"'; then
  ok "malformed %zz path -> 400 invalid_encoding (JSON)"
else
  bad "malformed path: HTTP $CODE body $BODY"
fi

# 2. Truncated escape at the end of a segment -> 400, still alive.
RESP=$(curl -s -w '\n%{http_code}' --path-as-is "$BASE/v1/projects/rsp_x%2")
CODE=$(echo "$RESP" | tail -1)
if [ "$CODE" = "400" ]; then
  ok "truncated escape -> 400"
else
  bad "truncated escape: HTTP $CODE"
fi

# 3. The server must still answer health (no crash).
H=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$BASE/v1/health")
if [ "$H" = "200" ]; then
  ok "server alive after malformed requests"
else
  bad "server crashed (health -> $H)"
fi

# 4. A normal request still works afterwards.
R=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/projects")
if [ "$R" = "200" ]; then
  ok "normal /v1/projects -> 200 after malformed input"
else
  bad "normal request -> $R"
fi

kill -9 "$KERNEL_PID" 2>/dev/null || true
rm -rf "$WORK"
echo "malformed-path tests: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
