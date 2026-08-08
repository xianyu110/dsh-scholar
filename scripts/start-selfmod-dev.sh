#!/usr/bin/env bash
# Start dsh-scholar with DSH Cordis self-referential tools in an isolated,
# loopback-only development profile. This is intentionally opt-in.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)

if [ "${DSH_SCHOLAR_ENABLE_SELFMOD:-}" != "1" ]; then
  echo "refusing to enable Cordis self-mod tools without DSH_SCHOLAR_ENABLE_SELFMOD=1" >&2
  exit 2
fi

DEV_HOME=$(realpath -m "${DSH_SCHOLAR_SELFMOD_HOME:-$HOME/.dsh-scholar-selfmod-dev}")
USER_HOME=$(realpath -m "$HOME")
PRODUCTION_HOME=$(realpath -m "${DSH_SCHOLAR_PRODUCTION_HOME:-$HOME/.dsh}")
case "$DEV_HOME" in
  /|"$USER_HOME"|"$PRODUCTION_HOME"|"$PRODUCTION_HOME"/*)
    echo "refusing unsafe or production DSH_HOME: $DEV_HOME" >&2
    exit 2
    ;;
esac

export DSH_SCHOLAR_TEST_HOME="$DEV_HOME"
export DSH_SCHOLAR_TEST_PORT="${DSH_SCHOLAR_SELFMOD_PORT:-3082}"
export DSH_SCHOLAR_TEST_KERNEL_PORT="${DSH_SCHOLAR_SELFMOD_KERNEL_PORT:-17414}"
export DSH_SCHOLAR_EXTRA_PATCH="$REPO/configs/research-dev-selfmod.cordis.yml"

echo "WARNING: enabling bash-equivalent Cordis self-mod tools in isolated dev home $DEV_HOME"
exec bash "$REPO/scripts/start-test-dsh.sh"
