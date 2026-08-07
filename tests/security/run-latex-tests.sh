#!/usr/bin/env bash
# §19.2 P0 blocking test: latex-compiles.
#
# §14.3 Reviewer Pass requires "LaTeX 在固定构建镜像中编译" — the LaTeX
# manuscript emitted by POST /v1/projects/{id}/manuscripts/build
# {format:'latex'} must compile with pdflatex. Compilation is only meaningful
# in a FIXED build image, so this test:
#
#   - SKIPs (exit 0, reason printed) when pdflatex is not installed — a dev
#     machine without TeX cannot attest to compilation;
#   - runs evals/latex-eval.sh and requires PASS when pdflatex IS present.
#     CI installs the fixed image before invoking this test
#     (sudo apt-get install -y texlive-latex-base texlive-latex-recommended
#     on ubuntu-latest), so the CI run is a real compile gate; the eval exits
#     non-zero on any failed assertion, which propagates here as a test FAIL.
#
# Usage: bash tests/security/run-latex-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)

if ! command -v pdflatex >/dev/null 2>&1; then
  echo "SKIP latex-compiles: no pdflatex in PATH"
  echo "  (compile check needs the fixed build image: sudo apt-get install -y texlive-latex-base texlive-latex-recommended)"
  echo "  (CI job 'latex-compile' installs it on ubuntu-latest; on this machine the test is skipped, exit 0)"
  exit 0
fi

echo "latex-compiles: pdflatex present ($(pdflatex --version | head -n 1)) — running full eval"
bash "$REPO/evals/latex-eval.sh"
echo "latex-compiles: PASS (LaTeX manuscript compiled in the fixed build image)"
