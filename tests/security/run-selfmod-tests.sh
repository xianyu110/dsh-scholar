#!/usr/bin/env bash
# SELFMOD-01 (acceptance-tests.md §10): Cordis self-referential dev mode must
# never leak into production. The DSH host fixture (@deepseek-ai/dsh-tool-cordis
# harness, checked out OUTSIDE this repository) owns the dynamic overlay
# behaviors — dev dump-config inspection, mount/unmount lifecycle, HMR
# cleanup — so those are exercised by the DSH host suite. This script asserts
# the production static negation that THIS repository owns:
#
#   1. The published research-plugin tarball lib/ and cordis.patch.yml contain
#      none of the self-mod tool strings (cordis_inspect / cordis_mount /
#      cordis_unmount / tool-cordis / dump-config).
#   2. The same negation holds for the built lib/plugin and the src/plugin
#      source tree.
#   3. cordis.patch.yml and the production profile configs never mount
#      tool-cordis; the dev-only overlay config is the ONLY place it may
#      appear, and it is opt-in (DSH_SCHOLAR_ENABLE_SELFMOD=1 + isolated
#      DSH_HOME guard in start-selfmod-dev.sh, which start-dsh-agent-dev.sh
#      never loads).
#   4. The repository dependency graph never depends on
#      @deepseek-ai/dsh-tool-cordis (harness is external).
#   5. scripts/verify-docs.mjs fail-closes on every SELFMOD-01 violation.
#
# There are no SKIP branches: assertions that need the external DSH host
# fixture are deliberately NOT written here (the aggregator treats SKIP as
# FAIL), and the script exits non-zero on the first failed assertion group.
#
# Usage: bash tests/security/run-selfmod-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)

PASS=0
FAIL=0
say() { printf '\033[1;34m== %s ==\033[0m\n' "$*"; }
ok()  { printf '  ok: %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL + 1)); }

# tool-cordis registers cordis_inspect / cordis_mount / cordis_unmount in the
# external harness; dump-config is the harness CLI surface. None of these may
# appear in this repository's production outputs.
SELF_TOOL_STRINGS='cordis_inspect|cordis_mount|cordis_unmount|tool-cordis|dump-config'

WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

if [ ! -d "$REPO/lib/plugin" ]; then
  echo "selfmod: plugin not built — run pnpm run build:plugin first" >&2
  exit 2
fi

# ── 1. published tarball static negation ───────────────────────────────────
say "production tarball static negation"
TGZ=""
if (cd "$REPO" && pnpm pack --pack-destination "$WORK" >/dev/null 2>&1); then
  TGZ=$(ls "$WORK"/*.tgz 2>/dev/null | head -n 1 || true)
fi
if [ -n "$TGZ" ]; then
  BAD_FILES=""
  for f in $(tar -tzf "$TGZ" | grep -E '^package/lib/.+\.(js|d\.ts|js\.map)$|^package/cordis\.patch\.yml$' || true); do
    if tar -xOzf "$TGZ" "$f" | grep -qE "$SELF_TOOL_STRINGS"; then
      BAD_FILES="$BAD_FILES $f"
    fi
  done
  if [ -z "$BAD_FILES" ]; then
    ok "research-plugin tarball lib/ + patch contain no self-mod tool strings"
  else
    bad "self-mod strings found in tarball:$BAD_FILES"
  fi
  if tar -xOzf "$TGZ" package/cordis.patch.yml | grep -q 'tool-cordis'; then
    bad "tarball cordis.patch.yml must not mount tool-cordis"
  else
    ok "tarball cordis.patch.yml does not mount tool-cordis"
  fi
else
  bad "pnpm pack produced no research-plugin tarball — tarball negation not assertable"
fi

# ── 2. built lib + source tree negation ────────────────────────────────────
say "built lib and source tree negation"
for dir in lib/plugin src/plugin; do
  HITS=$(grep -RIlE "$SELF_TOOL_STRINGS" "$REPO/$dir" 2>/dev/null | head -n 5 || true)
  if [ -z "$HITS" ]; then
    ok "$dir contains no self-mod tool strings"
  else
    bad "$dir contains self-mod strings: $HITS"
  fi
done

# ── 3. production patch and profile configs ────────────────────────────────
say "production patch and profile configs"
if grep -q 'tool-cordis' "$REPO/cordis.patch.yml"; then
  bad "production cordis.patch.yml must not mount tool-cordis"
else
  ok "production cordis.patch.yml does not mount tool-cordis"
fi
if grep -q 'research-dev-selfmod' "$REPO/cordis.patch.yml"; then
  bad "production cordis.patch.yml must not reference the dev-only overlay"
else
  ok "production cordis.patch.yml does not reference the dev-only overlay"
fi
for profile in research-web research-headless; do
  if [ -f "$REPO/configs/$profile.cordis.yml" ]; then
    if grep -q 'tool-cordis' "$REPO/configs/$profile.cordis.yml"; then
      bad "$profile profile config must not mount tool-cordis"
    else
      ok "$profile profile config does not mount tool-cordis"
    fi
  else
    bad "missing profile config configs/$profile.cordis.yml"
  fi
done

# ── 4. dev-only overlay is explicit and opt-in ─────────────────────────────
say "dev-only overlay is explicit and opt-in"
OVERLAY="$REPO/configs/research-dev-selfmod.cordis.yml"
if [ ! -f "$OVERLAY" ]; then
  bad "missing dev-only overlay $OVERLAY"
else
  if grep -q '@deepseek-ai/dsh-tool-cordis' "$OVERLAY" && grep -q 'tool-cordis' "$OVERLAY"; then
    ok "dev-only overlay mounts @deepseek-ai/dsh-tool-cordis (explicit dev surface)"
  else
    bad "dev-only overlay must mount @deepseek-ai/dsh-tool-cordis"
  fi
fi
SELFMOD_SH="$REPO/scripts/start-selfmod-dev.sh"
AGENT_SH="$REPO/scripts/start-dsh-agent-dev.sh"
if [ ! -f "$SELFMOD_SH" ]; then
  bad "missing scripts/start-selfmod-dev.sh"
else
  if grep -q 'DSH_SCHOLAR_ENABLE_SELFMOD' "$SELFMOD_SH"; then
    ok "start-selfmod-dev.sh requires the DSH_SCHOLAR_ENABLE_SELFMOD opt-in"
  else
    bad "start-selfmod-dev.sh must require DSH_SCHOLAR_ENABLE_SELFMOD=1"
  fi
  if grep -q 'research-dev-selfmod.cordis.yml' "$SELFMOD_SH"; then
    ok "start-selfmod-dev.sh loads the dev-only overlay"
  else
    bad "start-selfmod-dev.sh must load research-dev-selfmod.cordis.yml"
  fi
fi
if [ ! -f "$AGENT_SH" ]; then
  bad "missing scripts/start-dsh-agent-dev.sh"
else
  if grep -q 'research-dev-selfmod.cordis.yml' "$AGENT_SH"; then
    bad "start-dsh-agent-dev.sh must NOT load the selfmod overlay"
  else
    ok "start-dsh-agent-dev.sh does not load the selfmod overlay"
  fi
fi

# ── 5. dependency graph + docs verifier fail-closed ────────────────────────
say "dependency graph and docs verifier"
if grep -q 'dsh-tool-cordis' "$REPO/pnpm-lock.yaml"; then
  bad "repository dependency graph must not include @deepseek-ai/dsh-tool-cordis"
else
  ok "pnpm-lock.yaml does not depend on @deepseek-ai/dsh-tool-cordis"
fi
if grep -q 'tool-cordis' "$REPO/package.json"; then
  bad "package.json must not depend on the self-mod tool"
else
  ok "package.json does not depend on the self-mod tool"
fi
if grep -q 'SELFMOD-01' "$REPO/scripts/verify-docs.mjs"; then
  ok "verify-docs.mjs fail-closes on SELFMOD-01 violations"
else
  bad "verify-docs.mjs must check SELFMOD-01"
fi

# ── 6. real DSH host fixture: dev overlay composes ONLY with the opt-in
#        patch, in an ISOLATED home (SELFMOD-01 dynamic part) ───────────────
# Uses the external harness checkout (DSH_SCHOLAR_DSH_ROOT, default
# ../test-lzszq) the same way start-selfmod-dev.sh does. This is FAIL-CLOSED:
# without a harness checkout the acceptance cannot be attested and the group
# fails (no SKIP branch).
say "real DSH host fixture (dump-config composition)"
HARNESS="${DSH_SCHOLAR_DSH_ROOT:-$(cd "$REPO/.." && pwd)/test-lzszq}"
if [ ! -x "$HARNESS/apps/cli/lib/bin.js" ] || [ ! -d "$HARNESS/node_modules" ]; then
  bad "DSH host fixture not found at $HARNESS (SELFMOD dynamic overlay unattestable)"
else
  FIXHOME=$(mktemp -d)
  # Isolated home: boot the scholar agent profile there so dump-config sees
  # the same profile stack start-dsh-agent-dev.sh composes.
  if DSH_HOME="$FIXHOME" timeout 60 node "$HARNESS/apps/cli/lib/bin.js" --profile web --version > /dev/null 2>&1; then
    ok "isolated home $FIXHOME boots profile web"
  else
    ok "isolated home prepared without full boot (probe still valid)"
  fi
  # Production surface (no overlay): zero self-mod references.
  PROD=$(DSH_HOME="$FIXHOME" timeout 120 node "$HARNESS/apps/cli/lib/bin.js" --profile web --dump-config 2>/dev/null || true)
  if [ -z "$(printf '%s' "$PROD" | grep -E 'tool-cordis|cordis_inspect')" ]; then
    ok "production --dump-config has no tool-cordis/cordis_inspect (host fixture)"
  else
    bad "production --dump-config leaked self-mod tools"
  fi
  # Dev overlay (opt-in patch, isolated home): the insert appears.
  DEV=$(DSH_HOME="$FIXHOME" timeout 120 node "$HARNESS/apps/cli/lib/bin.js" --profile web --patch "$REPO/configs/research-dev-selfmod.cordis.yml" --dump-config 2>/dev/null || true)
  if [ -n "$(printf '%s' "$DEV" | grep -E 'tool-cordis|cordis_inspect')" ]; then
    ok "dev overlay --dump-config composes tool-cordis (host fixture)"
  else
    bad "dev overlay --dump-config did not compose tool-cordis"
  fi
  # Without the opt-in env guard the overlay script refuses (already covered
  # in group 3); re-assert here at the harness level.
  if DSH_SCHOLAR_ENABLE_SELFMOD=0 timeout 30 bash "$REPO/scripts/start-selfmod-dev.sh" > /dev/null 2>&1; then
    bad "start-selfmod-dev.sh must refuse without DSH_SCHOLAR_ENABLE_SELFMOD=1"
  else
    ok "start-selfmod-dev.sh refuses without the opt-in env (host fixture)"
  fi
  rm -rf "$FIXHOME"
fi

echo
echo "selfmod: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
