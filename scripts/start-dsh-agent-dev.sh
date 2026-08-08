#!/usr/bin/env bash
# Start an isolated DSH Agent development instance for the dsh-scholar
# tools, commands, Skills and Cordis lifecycle. This does not install or
# expose a DSH-embedded Scholar browser UI; the only Scholar UI is the
# standalone server started by scripts/start-standalone-ui.sh.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
DEV_HOME="${DSH_SCHOLAR_AGENT_HOME:-$HOME/.dsh-scholar-agent-dev}"
WEB_PORT="${DSH_SCHOLAR_AGENT_PORT:-3081}"
KERNEL_PORT="${DSH_SCHOLAR_AGENT_KERNEL_PORT:-17412}"
EXTRA_PATCH="${DSH_SCHOLAR_EXTRA_PATCH:-}"
PROFILE=web
DEV_CLI="$REPO/scripts/dsh-dev"

mkdir -p "$DEV_HOME/profiles/$PROFILE"

if [ ! -f "$DEV_HOME/profiles/$PROFILE/package.json" ]; then
  cat > "$DEV_HOME/profiles/$PROFILE/package.json" <<EOF
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
EOF
  cat > "$DEV_HOME/profiles/$PROFILE/pnpm-workspace.yaml" <<'EOF'
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
EOF
  echo '[]' > "$DEV_HOME/profiles/$PROFILE/cordis.patch.yml"
  echo "agent profile initialized at $DEV_HOME/profiles/$PROFILE"
fi

PATCH="$DEV_HOME/profiles/$PROFILE/cordis.patch.yml"
cat > "$PATCH" <<EOF
- id: research-plugin
  config:
    kernel:
      host: 127.0.0.1
      port: $KERNEL_PORT
    defaultMode: gate-only
EOF

if ! grep -q '"@dsh-scholar/research-plugin"' "$DEV_HOME/profiles/$PROFILE/package.json" 2>/dev/null; then
  echo "installing @dsh-scholar/research-plugin into $PROFILE ..."
  DSH_HOME="$DEV_HOME" "$DEV_CLI" plugin --profile "$PROFILE" add "$REPO"
fi
grep -q '"@dsh-scholar/research-plugin"' "$DEV_HOME/profiles/$PROFILE/package.json"

EXTRA_ARGS=()
if [ -n "$EXTRA_PATCH" ]; then
  EXTRA_ARGS=(--patch "$EXTRA_PATCH")
fi

echo "starting isolated DSH Agent host: http://127.0.0.1:$WEB_PORT"
echo "Scholar browser UI is not mounted; use scripts/start-standalone-ui.sh."
DSH_HOME="$DEV_HOME" setsid nohup "$DEV_CLI" web "${EXTRA_ARGS[@]}" --host 127.0.0.1 --port "$WEB_PORT" \
  >> "$DEV_HOME/agent-web.log" 2>&1 < /dev/null &
echo "pid $! — log: $DEV_HOME/agent-web.log"

for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$WEB_PORT" > /dev/null 2>&1 && break
  sleep 1
done

kernel_state=down
for _ in $(seq 1 30); do
  if curl -sf -m 1 "http://127.0.0.1:$KERNEL_PORT/v1/health" > /dev/null 2>&1; then
    kernel_state=ok
    break
  fi
  sleep 1
done

if [ "$kernel_state" != ok ]; then
  echo "WARNING: research-plugin kernel is not healthy on :$KERNEL_PORT" >&2
  tail -20 "$DEV_HOME/agent-web.log" 2>/dev/null || true
  exit 1
fi

echo "verification: curl -s http://127.0.0.1:$KERNEL_PORT/v1/health"
echo "Use /research commands in DSH; use http://127.0.0.1:18610 for the Scholar UI."
