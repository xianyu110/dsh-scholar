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
#      every compared + runtime_verified entry is true;
#   8. manifest.tex TeX inputs: every tex-workspace/<doc>/<path> file exists
#      with a matching sha256, and the latex-compile pdf artifact is in the
#      bundle with its recorded size (PDF structure input);
#   9. report.tex_comparison is field-level (inputs files_matched == files,
#      pdf size_matched) and report.cleanroom records fresh snapshot/DB/CAS
#      paths that never point into the original checkout or bundle dir;
#  10. clean-room replay still passes when the ORIGINAL CHECKOUT IS RENAMED
#      AWAY (KERNEL_BIN/RUNNER_BIN point at the renamed tree; any read of the
#      original path would fail the run) — empty-dir, no-original-checkout
#      replay (§4 REL-01);
#  11. preflight refuses a KERNEL_BIN/RUNNER_BIN OUTSIDE the checkout whose
#      sha256 does not match manifest.runtime ('sha256 do not match',
#      non-zero exit, fail report) — external runtime fails immediately;
#  12. node version mismatch → runtime_verified.node=false, status=fail (the
#      replay still completes and the compared fields stay computed).
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
# Assertion 10 renames the original checkout away during the replay; the
# EXIT trap restores it even when the replay fails or the script aborts.
HIDDEN="$REPO.rel01-cleanroom-hidden"
REPO_RENAMED=0
restore_repo() {
  if [ "$REPO_RENAMED" = "1" ]; then
    mv "$HIDDEN" "$REPO" 2>/dev/null || true
    REPO_RENAMED=0
  fi
}
cleanup() { restore_repo; rm -rf "$WORK"; }
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

say "blocking assertion 8: manifest.tex TeX inputs (file list + per-file sha256) and pdf artifact in the bundle"
TEX_DOCS=$(node -e "const m=require('$MANIFEST');console.log((m.tex&&Array.isArray(m.tex.documents))?m.tex.documents.length:0)" 2>/dev/null || echo '0')
if [ "$TEX_DOCS" -gt 0 ]; then
  TX_TOTAL=0
  TX_OK=0
  while IFS=$'\t' read -r doc path sha; do
    TX_TOTAL=$((TX_TOTAL + 1))
    if [ -f "$BUNDLE_DIR/tex-workspace/$doc/$path" ] && [ "$(sha256sum "$BUNDLE_DIR/tex-workspace/$doc/$path" | awk '{print $1}')" = "$sha" ]; then
      TX_OK=$((TX_OK + 1))
    else
      bad "tex input missing or hash mismatch: $doc/$path"
    fi
  done < <(node -e "const m=require('$MANIFEST');for (const d of m.tex.documents) for (const f of d.files) console.log(d.document_id + '\t' + f.path + '\t' + f.sha256)")
  if [ "$TX_TOTAL" -gt 0 ] && [ "$TX_OK" = "$TX_TOTAL" ]; then
    ok "all $TX_TOTAL TeX input file(s) across $TEX_DOCS document(s) match recorded sha256"
  else
    bad "TeX input verification incomplete ($TX_OK/$TX_TOTAL)"
  fi
  if node -e "
    const m=require('$MANIFEST')
    const j=m.jobs.find(x=>x.kind==='latex-compile'&&x.status==='succeeded')
    if(!j||!j.run_manifest||typeof j.run_manifest.tex_pdf_artifact!=='string'){console.error('no succeeded latex-compile job with tex_pdf_artifact');process.exit(1)}
    const aid=j.run_manifest.tex_pdf_artifact
    const rec=m.artifacts?.[aid]??m.artifacts?.[String(aid).replace(/^sha256:/,'')]
    if(!rec){console.error('pdf artifact not in manifest.artifacts: '+aid);process.exit(2)}
    const fs=require('fs')
    const p='$BUNDLE_DIR'+'/'+rec.path
    if(!fs.existsSync(p)){console.error('pdf artifact file missing: '+p);process.exit(3)}
    const size=fs.statSync(p).size
    if(size<1){console.error('pdf artifact empty');process.exit(4)}
    if(rec.size_bytes!==size){console.error('pdf size mismatch: recorded '+rec.size_bytes+' got '+size);process.exit(5)}
  " > /dev/null 2>&1; then
    ok "latex-compile pdf artifact present in the bundle with recorded byte size"
  else
    bad "pdf artifact assertion failed (rc=$?)"
  fi
else
  bad "manifest.tex missing — the eval must produce TeX inputs (latex-compile job)"
fi

say "blocking assertion 9: report tex_comparison (field-level) + cleanroom fresh-state fields"
RPT="$BUNDLE_DIR/reproducibility-report.json"
if [ -f "$RPT" ]; then
  if REPO_ABS="$REPO" BUNDLE_ABS="$BUNDLE_DIR" node -e "
    const r=require('$RPT')
    const tc=r.tex_comparison
    if(!tc||typeof tc.inputs!=='object'||typeof tc.pdf!=='object'){console.error('tex_comparison missing');process.exit(1)}
    if(tc.inputs.files<1||tc.inputs.files_matched!==tc.inputs.files){console.error('tex inputs not fully hash-matched: '+JSON.stringify(tc.inputs));process.exit(2)}
    if(tc.inputs.list_matched!==true){console.error('tex input file list DIFFER');process.exit(3)}
    if(tc.pdf.original<1||tc.pdf.rerun<1||tc.pdf.size_matched!==true){console.error('pdf structure not size-matched: '+JSON.stringify(tc.pdf));process.exit(4)}
    const cr=r.cleanroom
    if(!cr||!cr.snapshot_dir||!cr.kernel_db||!cr.kernel_cas||!cr.work_dir){console.error('cleanroom fields missing');process.exit(5)}
    for(const k of ['snapshot_dir','kernel_db','kernel_cas','work_dir']){
      const v=String(cr[k]||'')
      if(v.includes(process.env.REPO_ABS)){console.error('cleanroom path resolves into the original checkout: '+k+'='+v);process.exit(6)}
      if(v.includes(process.env.BUNDLE_ABS)){console.error('cleanroom path resolves into the original bundle dir: '+k+'='+v);process.exit(7)}
    }
    if(cr.snapshot_dir===process.env.BUNDLE_ABS){console.error('snapshot_dir equals the original bundle dir');process.exit(8)}
    if(r.compared.tex!==true){console.error('compared.tex not true');process.exit(9)}
  "; then
    ok "tex_comparison field-level (inputs files+hashes, pdf byte size) and cleanroom fresh-state fields verified"
  else
    bad "report tex_comparison/cleanroom assertions failed (rc=$?)"; cat "$RPT" >&2 || true
  fi
else
  bad "reproducibility-report.json missing (cannot assert tex_comparison/cleanroom)"
fi

say "blocking assertion 11: external runtime digest mismatch fails immediately (preflight, no kernel start)"
mkdir -p "$WORK/fakebin"
printf '#!/bin/sh\necho fake kernel\n' > "$WORK/fakebin/fake-kernel.js"
printf '#!/bin/sh\necho fake runner\n' > "$WORK/fakebin/fake-runner.js"
BAD2="$WORK/bad-bundle-digest"
cp -a "$BUNDLE_DIR" "$BAD2"
if KERNEL_BIN="$WORK/fakebin/fake-kernel.js" RUNNER_BIN="$WORK/fakebin/fake-runner.js" bash "$BAD2/reproduce.sh" --mode subprocess > "$WORK/digest-mismatch.log" 2>&1; then
  bad "reproduce.sh unexpectedly accepted a non-declared runtime binary"
else
  if grep -q "sha256 do not match" "$WORK/digest-mismatch.log"; then
    ok "reproduce.sh refused digest-mismatched external runtime ('sha256 do not match')"
  else
    bad "reproduce.sh failed but without the digest-mismatch message"; cat "$WORK/digest-mismatch.log" >&2 || true
  fi
  if [ -f "$BAD2/reproducibility-report.json" ]; then
    if node -e "
      const r=require('$BAD2/reproducibility-report.json')
      if(r.status!=='fail'){console.error('status='+r.status);process.exit(1)}
      if(r.runtime_verified.kernel_bin!==false||r.runtime_verified.runner_bin!==false){console.error('runtime_verified not false');process.exit(2)}
      const c=r.compared
      if(c.manifest_hash||c.metrics||c.analysis||c.run_manifest||c.tex){console.error('compared not all false: '+JSON.stringify(c));process.exit(3)}
    "; then
      ok "preflight fail report recorded (status=fail, runtime_verified false, compared all false)"
    else
      bad "preflight fail report wrong (rc=$?)"; cat "$BAD2/reproducibility-report.json" >&2 || true
    fi
  else
    bad "no fail report written by the preflight"
  fi
fi

say "blocking assertion 12: node version mismatch -> runtime_verified.node=false, status=fail"
REAL_NODE=$(command -v node)
mkdir -p "$WORK/node-shim"
cat > "$WORK/node-shim/node" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "--version" ] || [ "\$1" = "-v" ]; then
  echo "v99.0.0"
  exit 0
fi
exec "$REAL_NODE" "\$@"
EOF
chmod +x "$WORK/node-shim/node"
NODEB="$WORK/node-mismatch-bundle"
cp -a "$BUNDLE_DIR" "$NODEB"
rm -f "$NODEB/reproducibility-report.json"
if PATH="$WORK/node-shim:$PATH" KERNEL_BIN="$REPO/packages/research-kernel/lib/bin/kernel.js" RUNNER_BIN="$REPO/workers/runner-gateway/lib/bin/runner.js" bash "$NODEB/reproduce.sh" --mode auto > "$WORK/node-mismatch.log" 2>&1; then
  bad "reproduce.sh passed despite node version mismatch (v99.0.0 vs declared)"
else
  if [ -f "$NODEB/reproducibility-report.json" ]; then
    if node -e "
      const r=require('$NODEB/reproducibility-report.json')
      if(r.status!=='fail'){console.error('status='+r.status);process.exit(1)}
      if(r.runtime_verified.node!==false){console.error('runtime_verified.node not false');process.exit(2)}
      if(r.compared.manifest_hash!==true||r.compared.metrics!==true||r.compared.analysis!==true||r.compared.run_manifest!==true||r.compared.tex!==true){console.error('compared not all true: '+JSON.stringify(r.compared));process.exit(3)}
    "; then
      ok "node mismatch replay finished: status=fail + runtime_verified.node=false, compared fields still computed true"
    else
      bad "node-mismatch report wrong (rc=$?)"; head -60 "$NODEB/reproducibility-report.json" >&2 || true
    fi
  else
    bad "no report written by the node-mismatch replay"; tail -30 "$WORK/node-mismatch.log" >&2 || true
  fi
fi

say "blocking assertion 10: clean-room replay from an empty dir — original checkout renamed away"
CLEAN="$WORK/clean-bundle"
cp -a "$BUNDLE_DIR" "$CLEAN"
rm -f "$CLEAN/reproducibility-report.json"
if [ -e "$HIDDEN" ]; then
  bad "leftover hidden checkout dir exists: $HIDDEN"
else
  mv "$REPO" "$HIDDEN"
  REPO_RENAMED=1
  if KERNEL_BIN="$HIDDEN/packages/research-kernel/lib/bin/kernel.js" RUNNER_BIN="$HIDDEN/workers/runner-gateway/lib/bin/runner.js" bash "$CLEAN/reproduce.sh" --mode auto > "$WORK/renamed-checkout.log" 2>&1; then
    ok "replay passed with the original checkout renamed away (no original path is ever read)"
  else
    bad "replay failed with the original checkout renamed away"; tail -30 "$WORK/renamed-checkout.log" >&2 || true
  fi
  restore_repo
  if [ -d "$REPO" ]; then
    ok "original checkout restored"
  else
    bad "original checkout NOT restored — manual recovery: mv '$HIDDEN' '$REPO'"
  fi
  if [ -f "$CLEAN/reproducibility-report.json" ]; then
    RPT2=$(node -e "console.log(require('$CLEAN/reproducibility-report.json').status)")
    if [ "$RPT2" = "pass" ]; then
      ok "renamed-checkout replay report status=pass"
    else
      bad "renamed-checkout replay report status=$RPT2"; cat "$CLEAN/reproducibility-report.json" >&2 || true
    fi
  else
    bad "no report generated by the renamed-checkout replay"
  fi
fi

say "summary"
echo "release-bundle-tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
