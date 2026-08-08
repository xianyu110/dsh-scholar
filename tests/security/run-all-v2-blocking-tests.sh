#!/usr/bin/env bash
# §19.2 v0.2 blocking-test suite runner — runs every per-concern script in
# tests/security/ and aggregates the results into a PASS/FAIL table.
#
#   run-isolation-tests.sh      cross-project-idempotency-isolated
#                               cross-project-shared-blob-artifacts-isolated
#   run-evidence-tests.sh       evidence-missing-effect-is-inconclusive
#   run-lower-is-better-tests.sh lower-is-better-claim-direction (SKIP by
#                               default; enable with RUN_LOWER_IS_BETTER=1)
#   run-unicode-tests.sh        unicode-title-dedup
#   run-manifest-tests.sh       manifest-missing-artifact-rejected
#   run-gate-tests.sh           agent-cannot-decide-gate (kernel-level part)
#
# Usage: bash tests/security/run-all-v2-blocking-tests.sh
set -u

cd "$(dirname "$0")"

SCRIPTS=(
  run-isolation-tests.sh
  run-evidence-tests.sh
  run-manifest-tests.sh
  run-gate-tests.sh
  run-unicode-tests.sh
  run-lower-is-better-tests.sh
  run-malformed-path-tests.sh
)

echo "=== §19.2 v0.2 blocking tests ==="
PASSED=()
FAILED=()
for s in "${SCRIPTS[@]}"; do
  LOG=$(mktemp)
  bash "$s" > "$LOG" 2>&1
  RC=$?
  if [[ "$RC" -eq 0 ]]; then
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
