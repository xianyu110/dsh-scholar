#!/usr/bin/env bash
# §19.2 P0 blocking test: unicode-title-dedup.
#
# titleFingerprint() in scholar-connectors must survive non-ASCII scholarly
# titles: CJK titles must produce a NON-EMPTY fingerprint, fullwidth
# (full/half-width) variants of the SAME title must normalize to the SAME
# fingerprint (NFKC), and two DIFFERENT CJK titles must never collide.
#
# The check imports the BUILT lib (packages/scholar-connectors/lib/index.js)
# via node ESM. NOTE: the built artifact currently implements the v2
# Unicode-aware fingerprint (NFKC + \p{L}\p{N}, slice by code points); the
# src/index.ts copy is stale ASCII-only (title.toLowerCase().replace(/[^a-z0-9]+/g,''))
# — if lib/ is ever rebuilt from the current src, these checks will FAIL
# (CJK titles fingerprint to '') and the failure will flag that regression.
#
# Usage: bash tests/security/run-unicode-tests.sh
set -eu

REPO=$(cd "$(dirname "$0")/../.." && pwd)
CONN_LIB="$REPO/packages/scholar-connectors/lib/index.js"
WORK=$(mktemp -d)
PASS=0
FAIL=0

ok()  { printf '\033[1;32m  ok: %s\033[0m\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '\033[1;31m  FAIL: %s\033[0m\n' "$*"; FAIL=$((FAIL + 1)); }
trap 'rm -rf "$WORK"' EXIT

[[ -f "$CONN_LIB" ]] || { echo "scholar-connectors lib not built: $CONN_LIB"; exit 1; }

# Run the checks in node (ESM import of the built lib). Each check prints
#   RESULT|<id>|<detail>
# where RESULT is PASS or FAIL. Output is captured to a file so the parent
# shell can tally PASS/FAIL (a pipe would run the tally in a subshell).
CONN_LIB="$CONN_LIB" node --input-type=module > "$WORK/results.txt" <<'EOF'
const lib = process.env.CONN_LIB
const { titleFingerprint, dedupPapers } = await import('file://' + lib)

const report = (id, pass, detail) => console.log(`${pass ? 'PASS' : 'FAIL'}|${id}|${detail}`)

// 1. CJK title -> non-empty fingerprint (must not be stripped to '')
const cjk = titleFingerprint('基于深度学习的图像识别方法研究')
report('cjk-nonempty', cjk !== '', `titleFingerprint(CJK) = '${cjk}' (expected non-empty)`)
// 1b. CJK fingerprints must be distinct across different titles (no collisions)
const cjk2 = titleFingerprint('面向自然语言处理的预训练模型综述')
report('cjk-distinct', cjk !== '' && cjk2 !== '' && cjk !== cjk2, `'${cjk}' vs '${cjk2}' (expected distinct non-empty)`)
// 1c. identical CJK titles (differing only in trailing punctuation) must match
const cjkSame = titleFingerprint('基于深度学习的图像识别方法研究。')
report('cjk-same-normalized', cjk !== '' && cjk === cjkSame, `'${cjk}' vs '${cjkSame}' (expected equal)`)

// 1d. fullwidth/halfwidth normalization: the SAME title in fullwidth
// (ＡＢＣ１２３) and halfwidth (ABC123) characters must produce one key
const fw = titleFingerprint('ＡＢＣ１２３：全角标题')
const hw = titleFingerprint('ABC123: 全角标题')
report('fullwidth-normalized', fw !== '' && fw === hw, `fullwidth '${fw}' vs halfwidth '${hw}' (expected equal non-empty)`)

// 2. dedupPapers must NOT merge two different CJK titles (empty-key collision)
const papers = [
  { title: '基于深度学习的图像识别方法研究' },
  { title: '面向自然语言处理的预训练模型综述' },
]
const deduped = dedupPapers(papers)
report('dedup-cjk-distinct', deduped.removed === 0, `dedupPapers removed ${deduped.removed} of 2 different CJK titles (expected 0)`)

// 3. control: ASCII title normalization still works
const a1 = titleFingerprint('Hello, World!')
const a2 = titleFingerprint('hello world')
report('ascii-control', a1 === a2 && a1 !== '', `'${a1}' vs '${a2}' (expected equal non-empty)`)
EOF

while IFS='|' read -r RESULT ID DETAIL; do
  [[ -z "$RESULT" ]] && continue
  if [[ "$RESULT" == "PASS" ]]; then ok "$ID: $DETAIL"; else bad "$ID: $DETAIL"; fi
done < "$WORK/results.txt"

echo "unicode-title-dedup summary: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
