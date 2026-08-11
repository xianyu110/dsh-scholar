#!/usr/bin/env bash
# Link the DSH installation's packages into this repo's node_modules so local
# typechecking/tests can resolve @deepseek-ai/* and the vendored Cordis
# framework (@cordisjs/*, cosmokit) — none of these are on the npm registry.
# At RUNTIME inside DSH, the profile's flat node_modules fallback provides
# them; this script only serves local development.
#
# Usage: bash scripts/link-dsh-deps.sh [<dsh-checkout-or-install>]
#   default candidates: $DSH_SCHOLAR_DSH_ROOT, ../test-lzszq, ~/.dsh/source/current
set -eu

find_dsh_root() {
  if [[ -n "${DSH_SCHOLAR_DSH_ROOT:-}" && -d "$DSH_SCHOLAR_DSH_ROOT" ]]; then
    echo "$DSH_SCHOLAR_DSH_ROOT"; return
  fi
  local candidates=(
    "$(cd "$(dirname "$0")/../.." && pwd)/test-lzszq"
    "$HOME/.dsh/source/current"
  )
  for c in "${candidates[@]}"; do
    if [[ -d "$c/packages" ]]; then echo "$c"; return; fi
  done
  echo "" >&2; echo "error: no DSH checkout found (set DSH_SCHOLAR_DSH_ROOT)" >&2; exit 1
}

root=$(find_dsh_root)
repo=$(cd "$(dirname "$0")/.." && pwd)
nm="$repo/node_modules"
linked=0

link_one() { # <package.json path>
  local pkg="$1"
  local name
  name=$(node -e "console.log(require('$pkg').name || '')" 2>/dev/null || true)
  [[ -n "$name" ]] || return 0
  local dir
  dir=$(dirname "$pkg")
  local link_path
  case "$name" in
    @*/*)
      local scope leaf
      scope=${name%%/*}
      leaf=${name#*/}
      mkdir -p "$nm/$scope"
      link_path="$nm/$scope/$leaf"
      ;;
    *)
      link_path="$nm/$name"
      ;;
  esac
  # DSH occasionally reorganizes workspace package directories. A dangling
  # development symlink must be replaced instead of making this helper fail
  # with `File exists`; live links and real installed packages stay untouched.
  if [[ -L "$link_path" && ! -e "$link_path" ]]; then
    rm -- "$link_path"
  fi
  if [[ ! -e "$link_path" ]]; then
    ln -s "$dir" "$link_path"
    linked=$((linked + 1))
  fi
}

for pkg in "$root"/packages/*/*/package.json; do
  name=$(node -e "console.log(require('$pkg').name || '')" 2>/dev/null || true)
  case "$name" in
    @deepseek-ai/*) link_one "$pkg" ;;
  esac
done

for pkg in "$root"/vendor/*/package.json; do
  name=$(node -e "console.log(require('$pkg').name || '')" 2>/dev/null || true)
  case "$name" in
    @deepseek-ai/cordis | cordis | @cordisjs/* | cosmokit) link_one "$pkg" ;;
  esac
done

echo "linked $linked packages from $root"
