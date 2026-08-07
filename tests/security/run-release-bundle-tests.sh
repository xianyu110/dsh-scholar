#!/usr/bin/env bash
# §19.2 / Ticket SCH-REL-001 blocking tests: Release Bundle self-containment.
#
# The main entry is evals/release-bundle/run-release-eval.sh (fresh kernel →
# real smoke jobs → analysis → release-bundle endpoint → build-bundle.sh →
# verify-bundle.sh → clean-room reproduce.sh). This script runs it and then
# re-asserts the load-bearing facts directly against the produced bundle:
#
#   1. bundle self-contained: manifest.json (bundle_schema_version=2) plus
#      every manifest.artifacts entry present on disk with a matching sha256
#      (structure + hash);
#   2. reproduce.sh exists and is executable (clean-room entry point);
#   3. runs/metrics/ contains ≥1 file in the §12.5 shape (schema_version +
#      metrics array) — the runner's raw extraction artifacts are normalized
#      by the assembler, so this is an invariant of the bundle itself;
#   4. the in-bundle verify.sh is self-contained and passes (exit 0).
#
# Usage: bash tests/security/run-release-bundle-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
EVAL="$REPO/evals/release-bundle/run-release-eval.sh"
WORK=$(mktemp -d)
PASS=0
FAIL=0
say() { printf '\033[1;34m== %s ==\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m  ok: %s\033[0m\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '\033[1;31m  FAIL: %s\033[0m\n' "$*"; FAIL=$((FAIL + 1)); }
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

say "run-release-eval.sh (main entry) with --keep-bundle"
OUT="$WORK/eval.log"
if bash "$EVAL" --keep-bundle "$WORK/bundle" > "$OUT" 2>&1; then
  ok "run-release-eval.sh passed end-to-end"
else
  bad "run-release-eval.sh failed (see tail)"; tail -40 "$OUT" >&2 || true
fi
BUNDLE_DIR=$(grep '^BUNDLE_DIR=' "$OUT" | tail -1 | cut -d= -f2-)
if [ -n "$BUNDLE_DIR" ] && [ -d "$BUNDLE_DIR" ]; then
  ok "bundle kept at $BUNDLE_DIR"
else
  bad "no BUNDLE_DIR reported by run-release-eval.sh"
  echo "release-bundle-tests: $PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ] || exit 1
fi
MANIFEST="$BUNDLE_DIR/manifest.json"

say "blocking assertion 1: bundle self-contained (structure + hashes)"
if [ -f "$MANIFEST" ]; then
  ok "manifest.json present"
else
  bad "manifest.json missing"
fi
V=$(node -e "const m=require('$MANIFEST');console.log(m.bundle_schema_version ?? '')" 2>/dev/null || echo '')
if [ "$V" = "2" ]; then
  ok "manifest bundle_schema_version=2"
else
  bad "bundle_schema_version='$V' (expected 2)"
fi
ART_N=0
while IFS=$'\t' read -r path sha; do
  ART_N=$((ART_N + 1))
  if [ ! -f "$BUNDLE_DIR/$path" ]; then
    bad "artifact file missing: $path"
  elif [ "$(sha256sum "$BUNDLE_DIR/$path" | awk '{print $1}')" != "$sha" ]; then
    bad "artifact sha256 mismatch: $path"
  fi
done < <(node -e "const m=require('$MANIFEST');for (const rec of Object.values(m.artifacts ?? {})) console.log(rec.path + '\t' + rec.sha256)")
if [ "$ART_N" -gt 0 ]; then
  ok "all $ART_N artifact file(s) exist and match recorded sha256"
else
  bad "no artifacts recorded in manifest"
fi

say "blocking assertion 2: reproduce.sh present + executable (clean-room entry point)"
if [ -x "$BUNDLE_DIR/reproduce.sh" ]; then
  ok "reproduce.sh exists and is executable"
else
  bad "reproduce.sh missing or not executable"
fi

say "blocking assertion 3: runs/metrics/ §12.5 schema (schema_version + metrics array)"
MET_OK=0
for f in "$BUNDLE_DIR"/runs/metrics/*.json; do
  [ -f "$f" ] || continue
  if node -e "const m=require('$f');if (!('schema_version' in m) || !Array.isArray(m.metrics)) process.exit(1)"; then
    MET_OK=$((MET_OK + 1))
  fi
done
if [ "$MET_OK" -gt 0 ]; then
  ok "$MET_OK metrics file(s) conform to §12.5 (schema_version + metrics array)"
else
  bad "no §12.5-conformant metrics file in runs/metrics/"
fi

say "blocking assertion 4: in-bundle verify.sh is self-contained and passes"
if [ -x "$BUNDLE_DIR/verify.sh" ]; then
  if bash "$BUNDLE_DIR/verify.sh" "$BUNDLE_DIR" > "$WORK/verify.log" 2>&1; then
    ok "in-bundle verify.sh passed (exit 0)"
  else
    bad "in-bundle verify.sh failed"; cat "$WORK/verify.log" >&2 || true
  fi
else
  bad "verify.sh missing or not executable"
fi

say "summary"
echo "release-bundle-tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
