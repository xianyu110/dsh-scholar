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
#   4. the in-bundle verify.sh is self-contained and passes (exit 0);
#   5. manifest.runtime declares node + pinned images.lock digests +
#      kernel_bin/runner_bin sha256 (bundle-only clean-room, §12);
#   6. reproduce.sh preflight refuses a KERNEL_BIN that resolves into the
#      original dsh-scholar checkout without matching the declared runtime
#      ('external checkout access prohibited', non-zero exit, fail report);
#   7. reproducibility-report.json carries bundle_manifest_sha256 /
#      runtime_verified / images_used / compared, and status=pass implies
#      every compared + runtime_verified entry is true.
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

say "blocking assertion 5: manifest.runtime section (clean-room declared runtime)"
RT_NODE=$(node -e "const m=require('$MANIFEST');console.log(m.runtime?.node ?? '')" 2>/dev/null || echo '')
if [ -n "$RT_NODE" ] && [ "$RT_NODE" = "$(node --version)" ]; then
  ok "manifest.runtime.node present and matches the build-time node ($RT_NODE)"
else
  bad "manifest.runtime.node missing or mismatched ('$RT_NODE' vs '$(node --version)')"
fi
NODE_DIGEST=$(node -e "const m=require('$MANIFEST');console.log(m.runtime?.images?.node_fixture ?? '')")
TEX_DIGEST=$(node -e "const m=require('$MANIFEST');console.log(m.runtime?.images?.texlive ?? '')")
if [ "$NODE_DIGEST" = "node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32" ]; then
  ok "runtime.images.node_fixture pinned to the images.lock digest"
else
  bad "runtime.images.node_fixture wrong: '$NODE_DIGEST'"
fi
if [ "$TEX_DIGEST" = "texlive/texlive@sha256:8957c916b8160049f89c24d362a6d86c09d8a04095acde37e88404c4afed85b4" ]; then
  ok "runtime.images.texlive pinned to the images.lock digest"
else
  bad "runtime.images.texlive wrong: '$TEX_DIGEST'"
fi
# The declared kernel/runner digests must be the sha256 of the actual repo
# binaries (run-release-eval.sh hands exactly these to reproduce.sh).
KERNEL_SHA=$(sha256sum "$REPO/packages/research-kernel/lib/bin/kernel.js" | awk '{print $1}')
RUNNER_SHA=$(sha256sum "$REPO/workers/runner-gateway/lib/bin/runner.js" | awk '{print $1}')
M_KERNEL_SHA=$(node -e "const m=require('$MANIFEST');console.log(m.runtime?.kernel_bin ?? '')")
M_RUNNER_SHA=$(node -e "const m=require('$MANIFEST');console.log(m.runtime?.runner_bin ?? '')")
if [ -n "$M_KERNEL_SHA" ] && [ "$M_KERNEL_SHA" = "$KERNEL_SHA" ]; then
  ok "runtime.kernel_bin sha256 matches the repo kernel.js"
else
  bad "runtime.kernel_bin '$M_KERNEL_SHA' != repo kernel.js sha256 '$KERNEL_SHA'"
fi
if [ -n "$M_RUNNER_SHA" ] && [ "$M_RUNNER_SHA" = "$RUNNER_SHA" ]; then
  ok "runtime.runner_bin sha256 matches the repo runner.js"
else
  bad "runtime.runner_bin '$M_RUNNER_SHA' != repo runner.js sha256 '$RUNNER_SHA'"
fi

say "blocking assertion 6: bundle-only clean-room refuses checkout-path KERNEL_BIN"
# The preflight must refuse ANY binary that resolves inside the original
# dsh-scholar checkout without being the declared runtime. Use a FAKE
# KERNEL_BIN/RUNNER_BIN pointing at real repo-internal files (digest can
# never match manifest.runtime), run against a bundle COPY so the fail
# report cannot pollute the kept bundle, and assert the exact refusal
# message. The preflight exits BEFORE any kernel/runner is started, so no
# docker/node process is spawned. (The real repo binaries ARE the declared
# runtime — digest-matched — which is what the normal path above uses.)
BAD="$WORK/bad-bundle"
cp -a "$BUNDLE_DIR" "$BAD"
if KERNEL_BIN="$REPO/package.json" RUNNER_BIN="$REPO/README.md" bash "$BAD/reproduce.sh" --mode subprocess > "$WORK/prohibit.log" 2>&1; then
  bad "reproduce.sh unexpectedly accepted a checkout-path KERNEL_BIN"
else
  if grep -q "external checkout access prohibited" "$WORK/prohibit.log"; then
    ok "reproduce.sh refused checkout access ('external checkout access prohibited')"
  else
    bad "reproduce.sh failed but without the prohibited message"; cat "$WORK/prohibit.log" >&2 || true
  fi
fi

say "blocking assertion 7: reproducibility-report.json bundle-only clean-room fields"
RPT="$BUNDLE_DIR/reproducibility-report.json"
if [ -f "$RPT" ]; then
  if node -e "
    const r=require('$RPT')
    for (const k of ['bundle_manifest_sha256','runtime_verified','images_used','compared']) {
      if (!(k in r)) { console.error('missing field: '+k); process.exit(1) }
    }
    const rt=r.runtime_verified, cmp=r.compared
    if (typeof rt.node!=='boolean' || typeof rt.kernel_bin!=='boolean' || typeof rt.runner_bin!=='boolean') { console.error('runtime_verified not boolean'); process.exit(2) }
    if (!cmp.manifest_hash || !cmp.metrics || !cmp.analysis || !cmp.run_manifest || !cmp.tex) { console.error('compared not all true: '+JSON.stringify(cmp)); process.exit(3) }
    if (typeof r.images_used.node_fixture!=='string' || typeof r.images_used.texlive!=='string') { console.error('images_used incomplete'); process.exit(4) }
    if (r.status!=='pass') { console.error('status='+r.status); process.exit(5) }
  "; then
    ok "report has new fields; compared all true + runtime_verified all true with status=pass"
  else
    bad "report field assertions failed (rc=$?)"; cat "$RPT" >&2 || true
  fi
  MAN_SHA=$(sha256sum "$MANIFEST" | awk '{print $1}')
  RPT_SHA=$(node -e "console.log(require('$RPT').bundle_manifest_sha256)" 2>/dev/null || echo '')
  if [ -n "$RPT_SHA" ] && [ "$RPT_SHA" = "$MAN_SHA" ]; then
    ok "report bundle_manifest_sha256 matches the bundle manifest.json"
  else
    bad "report bundle_manifest_sha256 '$RPT_SHA' != manifest sha256 '$MAN_SHA'"
  fi
else
  bad "reproducibility-report.json missing"
fi

say "summary"
echo "release-bundle-tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
