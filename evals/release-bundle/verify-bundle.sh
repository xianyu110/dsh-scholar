#!/usr/bin/env bash
# §14.5 Clean-room Verifier step 1 — bundle hash + structure verification
# (Ticket SCH-REL-001). Validates a Release Bundle produced by
# evals/release-bundle/build-bundle.sh:
#
#   - manifest.json present, bundle_schema_version = 2
#   - every manifest.artifacts entry: file exists + sha256 matches
#   - manuscript/paper.md (or .tex) + manuscript/references.bib present
#   - reproduce.sh + verify.sh present and executable
#   - runs/metrics/ has ≥1 valid §12.5 JSON (schema_version + metrics array)
#   - analysis/aggregate.json has mean/effect_size fields
#
# Prints a PASS/FAIL checklist; exit code 0 iff every check passes.
# This script is self-contained (only needs the bundle dir) so
# build-bundle.sh copies it INTO the bundle as verify.sh.
#
# Usage: bash evals/release-bundle/verify-bundle.sh <bundle-dir>
set -eu

BUNDLE_DIR=${1:-$(cd "$(dirname "$0")" && pwd)}
MANIFEST="$BUNDLE_DIR/manifest.json"
PASS=0
FAIL=0
ok() { printf '  ok: %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL: %s\n' "$*"; FAIL=$((FAIL + 1)); }

if [ ! -f "$MANIFEST" ]; then
  bad "manifest.json missing in $BUNDLE_DIR"
  echo "verify-bundle: 0 passed, 1 failed"
  exit 1
fi
ok "manifest.json present"

V=$(node -e "const m=require('$MANIFEST');console.log(m.bundle_schema_version ?? '')")
if [ "$V" = "2" ]; then
  ok "manifest bundle_schema_version=2"
else
  bad "bundle_schema_version='$V' (expected 2)"
fi

# Artifact hash map: every entry must exist on disk and match its sha256.
ART_N=0
while IFS=$'\t' read -r path sha; do
  ART_N=$((ART_N + 1))
  if [ ! -f "$BUNDLE_DIR/$path" ]; then
    bad "artifact file missing: $path"
  else
    A=$(sha256sum "$BUNDLE_DIR/$path" | awk '{print $1}')
    if [ "$A" = "$sha" ]; then
      ok "artifact sha256 ok: $path"
    else
      bad "artifact sha256 MISMATCH: $path (recorded $sha, got $A)"
    fi
  fi
done < <(node -e "const m=require('$MANIFEST');for (const rec of Object.values(m.artifacts ?? {})) console.log(rec.path + '\t' + rec.sha256)")
if [ "$ART_N" -gt 0 ]; then
  ok "$ART_N artifact file(s) verified"
else
  bad "no artifacts recorded in manifest"
fi

# Manuscript.
if [ -f "$BUNDLE_DIR/manuscript/paper.md" ] || [ -f "$BUNDLE_DIR/manuscript/paper.tex" ]; then
  ok "manuscript paper present (paper.md/paper.tex)"
else
  bad "manuscript paper missing (paper.md or paper.tex)"
fi
if [ -f "$BUNDLE_DIR/manuscript/references.bib" ]; then
  ok "manuscript references.bib present"
else
  bad "manuscript references.bib missing"
fi

# Executable clean-room entry points.
if [ -x "$BUNDLE_DIR/reproduce.sh" ]; then
  ok "reproduce.sh present + executable"
else
  bad "reproduce.sh missing or not executable"
fi
if [ -x "$BUNDLE_DIR/verify.sh" ]; then
  ok "verify.sh present + executable"
else
  bad "verify.sh missing or not executable"
fi

# runs/metrics/: at least one file with the §12.5 shape.
MET_OK=0
for f in "$BUNDLE_DIR"/runs/metrics/*.json; do
  [ -f "$f" ] || continue
  if node -e "const m=require('$f');if (!('schema_version' in m) || !Array.isArray(m.metrics)) process.exit(1)"; then
    MET_OK=$((MET_OK + 1))
  fi
done
if [ "$MET_OK" -gt 0 ]; then
  ok "$MET_OK metrics file(s) with §12.5 shape (schema_version + metrics array)"
else
  bad "no valid §12.5 metrics file in runs/metrics/"
fi

# analysis/aggregate.json with mean/effect_size.
if [ -f "$BUNDLE_DIR/analysis/aggregate.json" ]; then
  if node -e "const a=require('$BUNDLE_DIR/analysis/aggregate.json');if (typeof a.mean !== 'number' || !('effect_size' in a)) process.exit(1)"; then
    ok "analysis/aggregate.json present with mean/effect_size (mean=$(node -e "console.log(require('$BUNDLE_DIR/analysis/aggregate.json').mean)"))"
  else
    bad "analysis/aggregate.json lacks mean/effect_size fields"
  fi
else
  bad "analysis/aggregate.json missing"
fi

echo "verify-bundle: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
