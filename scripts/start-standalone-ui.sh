#!/usr/bin/env bash
# Start the FULLY STANDALONE Research OS web plugin — no `dsh web` involved.
#
# Unlike scripts/start-test-dsh.sh (which boots a dsh web host and injects
# the panel into it), this runs the research-ui package's own HTTP server:
#   - its own Research Kernel sidecar (default :17413)
#   - the full-screen UI at http://127.0.0.1:18610 (token-gated)
#   - /v1/* proxied to that kernel with bearer-token auth + CSRF checks
#
# Usage: bash scripts/start-standalone-ui.sh [--port 18610] [--kernel-port 17413]
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
WEB_PORT="${DSH_SCHOLAR_STANDALONE_PORT:-18610}"
KERNEL_PORT="${DSH_SCHOLAR_STANDALONE_KERNEL_PORT:-17413}"
DATA_DIR="${DSH_SCHOLAR_STANDALONE_DATA:-$HOME/.dsh-scholar-standalone}"

BIN="$REPO/packages/dsh-research-ui/lib/standalone/server.js"
if [ ! -f "$BIN" ]; then
  echo "building research-ui (client + standalone server) ..."
  (cd "$REPO/packages/dsh-research-ui" && pnpm run build)
fi

mkdir -p "$DATA_DIR"
echo "starting standalone Research OS web plugin: http://127.0.0.1:$WEB_PORT (kernel :$KERNEL_PORT, data: $DATA_DIR)"
DSH_HOME="$DATA_DIR" setsid nohup node "$BIN" \
  --port "$WEB_PORT" --kernel-port "$KERNEL_PORT" --data-dir "$DATA_DIR/research-ui-standalone" \
  >> "$DATA_DIR/standalone.log" 2>&1 < /dev/null &
echo "pid $! — log: $DATA_DIR/standalone.log"
echo "token: $DATA_DIR/research-ui-standalone/standalone-token"

for _ in $(seq 1 40); do
  curl -sf -m 2 "http://127.0.0.1:$WEB_PORT/" > /dev/null 2>&1 && break
  sleep 1
done
echo ""
echo "open http://127.0.0.1:$WEB_PORT and paste the access token (see above)."
echo "verification: curl -s http://127.0.0.1:$KERNEL_PORT/v1/health"
