#!/usr/bin/env bash
# Start an ISOLATED DSH test instance for the dsh-scholar research plugin,
# fully separate from the production GUI (:3080 / ~/.dsh).
#
# Isolation (see docs/test-instance-plan.md):
#   DSH_HOME           ~/.dsh-scholar-test   (override: DSH_SCHOLAR_TEST_HOME)
#   web port           3081                  (override: DSH_SCHOLAR_TEST_PORT)
#   kernel port        17412                 (override: DSH_SCHOLAR_TEST_KERNEL_PORT)
#
# IMPORTANT: `dsh web` is an alias for `--profile web`, so the profile name
# MUST be `web` inside the isolated home (the alias never resolves another
# profile name). A brand-new DSH_HOME has no profiles/web, so `dsh web`
# would auto-initialize an EMPTY web profile without the plugin — this
# script creates profiles/web first and installs the plugin into it.
#
# Idempotent: initializes the profile and installs the plugin on first run.
# Usage: bash scripts/start-test-dsh.sh
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
TEST_HOME="${DSH_SCHOLAR_TEST_HOME:-$HOME/.dsh-scholar-test}"
WEB_PORT="${DSH_SCHOLAR_TEST_PORT:-3081}"
KERNEL_PORT="${DSH_SCHOLAR_TEST_KERNEL_PORT:-17412}"
PROFILE=web
BIN=/home/dev/Desktop/test-lzszq/apps/cli/lib/bin.js
DEV_CLI="$REPO/scripts/dsh-dev"

mkdir -p "$TEST_HOME/profiles/$PROFILE"

# 1. Profile manifest (first run only) — MUST be profile `web` (see above).
if [ ! -f "$TEST_HOME/profiles/$PROFILE/package.json" ]; then
  cat > "$TEST_HOME/profiles/$PROFILE/package.json" <<EOF
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
EOF
  cat > "$TEST_HOME/profiles/$PROFILE/pnpm-workspace.yaml" <<'EOF'
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
EOF
  echo '[]' > "$TEST_HOME/profiles/$PROFILE/cordis.patch.yml"
  echo "test profile initialized at $TEST_HOME/profiles/$PROFILE"
fi

# 2. Kernel port override for the plugin sidecar (prevents reuse of the
#    production kernel on 7412). The bundle already inserts the plugin row;
#    this layer id-targets it and REPLACES its config (patch semantics:
#    last write wins per row).
PATCH="$TEST_HOME/profiles/$PROFILE/cordis.patch.yml"
cat > "$PATCH" <<EOF
- id: research-plugin
  config:
    kernel:
      host: 127.0.0.1
      port: $KERNEL_PORT
    defaultMode: gate-only
EOF

# 3. Install the plugin into the test profile (idempotent via pnpm).
if ! grep -q '"@dsh-scholar/research-plugin"' "$TEST_HOME/profiles/$PROFILE/package.json" 2>/dev/null; then
  echo "installing @dsh-scholar/research-plugin into $PROFILE ..."
  DSH_HOME="$TEST_HOME" "$DEV_CLI" plugin --profile "$PROFILE" add "$REPO" || true
fi

# 4. Boot the isolated instance. The SOURCE CLI (tsx) is used instead of the
#    prebuilt lib/bin.js: the built artifact predates profile patch-layer
#    id-targeted config overrides, so kernel.port overrides silently fail
#    with it (the plugin then spawns on the default 7412).
echo "starting isolated test DSH: http://127.0.0.1:$WEB_PORT (DSH_HOME=$TEST_HOME, kernel :$KERNEL_PORT)"
DSH_HOME="$TEST_HOME" setsid nohup "$DEV_CLI" web --host 127.0.0.1 --port "$WEB_PORT" \
  >> "$TEST_HOME/test-web.log" 2>&1 < /dev/null &
echo "pid $! — log: $TEST_HOME/test-web.log"

# 5. Wait for health and print verification commands.
for _ in $(seq 1 60); do
  curl -sf -m 2 "http://127.0.0.1:$WEB_PORT" > /dev/null 2>&1 && break
  sleep 1
done

# 6. Wait for BOTH kernels (main plugin sidecar + research-ui sidecar).
#    Both may open the same SQLite DB; a cold start can race on the
#    migration write-lock, leaving the main kernel dead while the web
#    process itself looks healthy — /research then hangs with no response.
#    Detect that here instead of letting it surface as "no reaction".
for _ in $(seq 1 30); do
  K1=$(curl -sf -m 1 "http://127.0.0.1:$KERNEL_PORT/v1/health" > /dev/null 2>&1 && echo ok || echo down)
  K2=$(curl -sf -m 1 "http://127.0.0.1:7412/v1/health" > /dev/null 2>&1 && echo ok || echo down)
  [ "$K1" = ok ] && [ "$K2" = ok ] && break
  sleep 1
done
if [ "$K1" != ok ] || [ "$K2" != ok ]; then
  echo ""
  echo "WARNING: kernel(s) not healthy after startup:"
  echo "  main plugin kernel  :$KERNEL_PORT -> $K1"
  echo "  research-ui kernel  :7412         -> $K2"
  echo "  web log tail:"
  tail -20 "$TEST_HOME/test-web.log" 2>/dev/null || true
  echo ""
  echo "If :$KERNEL_PORT is down, restart once more (cold-start DB lock race):"
  echo "  pkill -f 'apps/cli/src/bin.ts web'; pkill -f 'research-kernel/lib/bin/kernel.js'; sleep 2; bash scripts/start-test-dsh.sh"
fi

echo ""
echo "verification:"
echo "  curl -s http://127.0.0.1:$WEB_PORT/research-api/v1/health"
echo "  curl -s http://127.0.0.1:$KERNEL_PORT/v1/health"
echo "  curl -s http://127.0.0.1:$WEB_PORT/plugins/@dsh-scholar/research-plugin/client.js | head"
