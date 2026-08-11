#!/usr/bin/env bash
# §19.2 v0.2 blocking-test suite runner — runs every per-concern script in
# tests/security/ and aggregates the results into a PASS/FAIL table.
#
#   run-isolation-tests.sh      cross-project-idempotency-isolated
#                               cross-project-shared-blob-artifacts-isolated
#   run-evidence-tests.sh       evidence-missing-effect-is-inconclusive
#   run-lower-is-better-tests.sh lower-is-better-claim-direction (runs by
#                               default; MetricSpec direction implemented)
#   run-unicode-tests.sh        unicode-title-dedup
#   run-manifest-tests.sh       manifest-missing-artifact-rejected
#   run-formal-binding-tests.sh formal-job-contract-{required,unknown,foreign,not-approved,approved}
#   run-fencing-tests.sh        heartbeat/terminal/complete lease fencing (409 lease_stale)
#   run-hardening-tests.sh      host-execution/fake-experiment defenses + durable cancel
#   run-release-bundle-tests.sh release-bundle self-containment + clean-room rerun
#   run-analysis-consistency-tests.sh analysis repeat byte-determinism + artifact/
#                               chart/manuscript number consistency (§6, real docker runs)
#   run-analysis-spec-tests.sh  §12 formula conformance: estimator identity,
#                               direction_ok semantics, canonical-RNG-rule CI
#                               (independent mirror), + manuscript excludes
#                               draft evidence / accepted chain claims_used
#   run-gate-tests.sh           agent-cannot-decide-gate (kernel-level part)
#                               + §2 gate-state-cannot-transition / five gate
#                               types / budget-gate-resume / concurrent-
#                               decision / human-principal-durable
#   run-terminal-tests.sh       §5 terminal: reconnect-after-seq,
#                               retention-gap, overflow, exit-replay,
#                               log-authz (cross-project 404), cancel-timeout-
#                               distinct
#   run-sse-tests.sh            ART-01 SSE true streaming (§5/§11): real
#                               streamed bodies + live tail + after_seq
#                               resume + cross-project 404 on the kernel,
#                               and the same through the standalone BFF
#                               proxy (401/404, no token leak)
#   run-upload-tests.sh         UPLOAD-01 multipart artifact upload (§3.1):
#                               curl -F success + server-side hash binding,
#                               33 MiB 413, path traversal 422, idempotent
#                               reuse, BFF passthrough + BFF authz negatives
#   run-workspace-tests.sh      WORK-01 generic workspace disk adapter (§7.1):
#                               create/list, node write/read with hash
#                               binding, revision/etag monotonicity, CAS
#                               409s, move/delete, binary asset upload + blob,
#                               413 caps, path traversal + symlink 422, watch
#                               (listSince), search, history rollback,
#                               cross-project 404, manuscript facade list,
#                               BFF passthrough + authz negatives
#   run-selfmod-tests.sh        SELFMOD-01 production static negation
#                               (no cordis_inspect/tool-cordis/dump-config
#                               in the published plugin; dev overlay opt-in)
#
# Deliberately NOT in SCRIPTS (documented so the list stays auditable):
#   * run-latex-tests.sh   — SKIPs (exit 0) when pdflatex is absent, so it is
#                            invoked by the dedicated CI "latex-compile" job
#                            (.github/workflows/ci.yml) after installing TeX,
#                            never by this aggregator (a SKIP here would fail
#                            CI=true fail-closed runs on TeX-less machines).
#   * run-standalone-http-tests.sh — nested INSIDE run-hardening-tests.sh
#                            (invoked at its tail; its non-zero exits and any
#                            SKIP text propagate through hardening into this
#                            aggregator's fail-closed checks).
#
# Usage: bash tests/security/run-all-v2-blocking-tests.sh
# The local CI gateway (scripts/ci-gate.sh, `pnpm test:ci`) runs this script
# with CI=true, so every SKIP/zero-assertion/unexecuted sub-script is
# fail-closed and the aggregator exit code contributes to the gate.
set -u

cd "$(dirname "$0")"

SCRIPTS=(
  run-isolation-tests.sh
  run-evidence-tests.sh
  run-manifest-tests.sh
  run-formal-binding-tests.sh
  run-fencing-tests.sh
  run-hardening-tests.sh
  run-release-bundle-tests.sh
  run-analysis-consistency-tests.sh
  run-analysis-spec-tests.sh
  run-gate-tests.sh
  run-terminal-tests.sh
  run-sse-tests.sh
  run-upload-tests.sh
  run-workspace-tests.sh
  run-unicode-tests.sh
  run-lower-is-better-tests.sh
  run-malformed-path-tests.sh
  run-selfmod-tests.sh
  run-dsh-plugin-tests.sh
)

echo "=== §19.2 v0.2 blocking tests ==="
# repository-blueprint.md: CI=true must FAIL on SKIP / zero-assertion /
# unexecuted sub-scripts. Local non-CI runs may pass --allow-skip; skipped
# scripts never count toward PASS or hardening evidence.
ALLOW_SKIP=0
for a in "$@"; do [ "$a" = "--allow-skip" ] && ALLOW_SKIP=1; done

PASSED=()
FAILED=()
for s in "${SCRIPTS[@]}"; do
  LOG=$(mktemp)
  bash "$s" > "$LOG" 2>&1
  RC=$?
  SKIPPED=0
  if grep -qE "(^|[[:space:]])SKIP([[:space:]:]|$)|(^|[[:space:]])skip([[:space:]:]|$)" "$LOG"; then SKIPPED=1; fi
  ZERO=0
  # "180 passed" must NOT count as "0 passed" — require the count to be a
  # standalone zero (not preceded by another digit).
  if grep -qE "(^|[^0-9])0 passed" "$LOG"; then ZERO=1; fi
  if [[ "$RC" -eq 0 && ( "$SKIPPED" -eq 1 || "$ZERO" -eq 1 ) && ( -n "${CI:-}" || "$ALLOW_SKIP" -eq 0 ) ]]; then
    FAILED+=("$s")
    echo "FAIL  $s  (exit 0 but SKIP/zero-assertion detected; CI=true requires fail-closed)"
  elif [[ "$RC" -eq 0 ]]; then
    PASSED+=("$s")
    echo "PASS  $s"
  else
    FAILED+=("$s")
    echo "FAIL  $s  (exit $RC)"
  fi
  echo "---- tail of $s ----"
  tail -n 4 "$LOG" | sed 's/^/    /'
  rm -f "$LOG"
done

echo
echo "=== summary table ==="
printf '%-42s %s\n' "script" "result"
for s in "${PASSED[@]}"; do printf '%-42s %s\n' "$s" "PASS"; done
for s in "${FAILED[@]}"; do printf '%-42s %s\n' "$s" "FAIL"; done
echo "total: ${#PASSED[@]} passed, ${#FAILED[@]} failed"
[[ "${#FAILED[@]}" -eq 0 ]] || exit 1
