/**
 * i18n-static-chrome (docs/acceptance-tests.md §8, UI-02):
 *
 *   header、status pill、tooltip(title=)、aria-label=、placeholder=、toast、
 *   空态、按钮文本不得硬编码英文/中文;zh/en namespace 与 key 精确一致,
 *   缺 key 在开发模式 warning、CI fail。
 *
 * This suite runs inside the ROOT vitest run (`pnpm test` collects
 * tests/unit/**) and scans the research-ui client source tree directly
 * (packages/dsh-research-ui/src/client), so the research-ui package needs no
 * test infra of its own. It composes two checks:
 *
 *   1. KEY PARITY — every zh/en namespace in the client i18n adapter must
 *      have exactly the same key set (reuses `localeParityReport` imported
 *      from the client source, so the test and the app share one definition).
 *
 *   2. STATIC HARDCODED-CHROME SCAN — pragmatic, comment-documented rules:
 *      R1 (Chinese): any string literal containing 2+ CJK chars
 *         ([\u4e00-\u9fff]{2,}) in client source outside i18n/locales/
 *         (the dictionaries themselves) fails. Comment text is not a string
 *         literal, so comments are naturally excluded.
 *      R2 (English): chrome positions — `.title =`, `.placeholder =`,
 *         `setAttribute('title'|'placeholder'|'aria-label', …)`,
 *         `showToast(root, …)`, `.textContent =`, and the text argument of
 *         `el(tag, class, …)` — must not receive a string literal containing
 *         English words ([A-Za-z]{3,}), unless the exact file:line is listed
 *         in ALLOWED_HARDCODED with a reason. Variables, expressions and
 *         t('ns','key') calls are fine. Exclusions reflect §8 line 115:
 *         raw wire/model/Terminal/TeX text, metric/status enum values,
 *         example data and icon-only glyphs stay verbatim.
 *
 * The ALLOWED_HARDCODED list is deliberately small and reviewed: every entry
 * is a raw-data / enum / technical case, never UI chrome copy.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localeParityReport } from '../../packages/dsh-research-ui/src/client/i18n/index'

const CLIENT_ROOT = fileURLToPath(new URL('../../packages/dsh-research-ui/src/client', import.meta.url))
const CJK = /[\u4e00-\u9fff]{2,}/
const ENGLISH_WORD = /[A-Za-z]{3,}/

/** All client .ts files except the locale dictionaries (i18n/locales/). */
function clientSourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (entry.endsWith('.ts') && !p.includes(`${sep}i18n${sep}locales${sep}`)) out.push(p)
    }
  }
  walk(CLIENT_ROOT)
  return out.sort()
}

/**
 * Extract the content of string literals on a line: '…', "…" and `…` spans.
 * Line-based and pragmatic (these sources never rely on exotic escapes):
 * backticks with nested ${…} interpolation are captured per backtick span,
 * which is sufficient for the checks below.
 */
function stringLiteralSpans(line: string): string[] {
  const spans: string[] = []
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (quote === null) {
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch
        start = i + 1
      }
    } else if (ch === quote && (quote !== "'" || line[i - 1] !== '\\')) {
      spans.push(line.slice(start, i))
      quote = null
    }
  }
  return spans
}

/** Chrome-position assignments (R2): returns `file:line` + offending literal. */
interface ChromeHit { file: string; line: number; text: string }

const CHROME_POSITIONS: Array<{ name: string; re: RegExp; firstSpanOnly: boolean }> = [
  { name: 'title', re: /\.title\s*=\s*/, firstSpanOnly: false },
  { name: 'placeholder', re: /\.placeholder\s*=\s*/, firstSpanOnly: false },
  { name: 'aria-label', re: /setAttribute\((?:'|")(?:title|placeholder|aria-label)(?:'|")\s*,\s*/, firstSpanOnly: false },
  { name: 'toast', re: /showToast\(\s*[^,]+,\s*/, firstSpanOnly: false },
  { name: 'textContent', re: /\.textContent\s*=\s*/, firstSpanOnly: false },
  // el(tag, class, text): only matches when the text argument is a string
  // literal right after the class (variable args are skipped — their display
  // values are expressions, checked by the other positions). The text
  // literal is then the FIRST string span of the remainder.
  { name: 'el-text', re: /el\(['"][a-z0-9]+['"]\s*,\s*['"][^'"]*['"]\s*,\s*(?=['"`])/, firstSpanOnly: true },
]

/** Remove single-line t('ns','key'[, {params}]) calls from an expression so
 *  their quoted key strings are not mistaken for hardcoded copy. */
function stripTCalls(expr: string): string {
  return expr.replace(/t\s*\(\s*['"][^'"]*['"]\s*,\s*['"][^'"]*['"]\s*(?:,\s*\{[^}]*\})?\s*\)/g, '')
}

/** Remove `=== 'enum'` / `!== 'enum'` comparison literals: raw enum values
 *  used in conditions, never display copy. */
function stripComparisons(expr: string): string {
  return expr.replace(/(?:===|!==|==|!=)\s*['"][^'"]*['"]/g, '')
}

/** Strip ${…} interpolation segments (code, not copy) from a template
 *  literal, repeatedly so nested templates collapse too. */
function stripInterpolation(span: string): string {
  let prev: string
  let s = span
  do {
    prev = s
    s = s.replace(/\$\{[^{}]*\}/g, '')
  } while (s !== prev)
  return s
}

/** `file:line → reason` for literals that are legitimately NOT i18n chrome.
 *  §8 line 115: wire/model/Terminal/TeX raw text and enum values stay
 *  verbatim; icon-only glyphs carry no language. Kept in sync with the
 *  current sources — any NEW hardcoded string fails the test. The list is
 *  deliberately tiny: raw wire joins and enum comparisons are already
 *  filtered out by the scanner (stripComparisons / stripInterpolation);
 *  what remains here are scanner edge cases on lines that are fully i18n'd
 *  or raw-data by inspection. */
const ALLOWED_HARDCODED: Record<string, string> = {
  // nested-template edge case: the line is already i18n'd —
  // t('common','common.updatedAt') + Intl time + raw lastError wire text.
  'packages/dsh-research-ui/src/client/index.ts:1011': 'stamp line: t(updatedAt) + Intl time + raw lastError (nested template)',
  // nested-template edge case: raw wire join of verification history
  // (timestamp · reason), displayed verbatim.
  'packages/dsh-research-ui/src/client/panels/evidence.ts:254': 'raw history join: when · reason (nested template)',
  // nested-template edge cases on raw wire/number joins (§8 line 115 keeps
  // wire/model/Terminal/TeX raw text verbatim):
  'packages/dsh-research-ui/src/client/panels/budget.ts:120': 'raw budget numbers: value / max (nested template)',
  'packages/dsh-research-ui/src/client/panels/gates.ts:260': 'raw wire join: actor · decision · timestamp (nested template)',
  'packages/dsh-research-ui/src/client/panels/manuscript.ts:269': 'raw wire: rev · build_id (nested template)',
  'packages/dsh-research-ui/src/client/panels/phase.ts:96': 'raw budget numbers: used / max (nested template)',
  'packages/dsh-research-ui/src/client/panels/phase.ts:179': 'raw wire: baseline vs treatment methods · version (nested template)',
}

function scanChromeEnglish(file: string, lines: string[]): ChromeHit[] {
  const hits: ChromeHit[] = []
  lines.forEach((line, idx) => {
    const lineNo = idx + 1
    for (const { re, firstSpanOnly } of CHROME_POSITIONS) {
      const m = re.exec(line)
      if (m === null) continue
      const rhs = line.slice(m.index + m[0].length)
      if (/^\s*t\s*\(/.test(rhs)) continue // t('ns','key') is the i18n path
      const cleaned = stripComparisons(stripTCalls(rhs))
      const spans = stringLiteralSpans(cleaned)
      const checked = firstSpanOnly ? spans.slice(0, 1) : spans
      for (const span of checked) {
        if (ENGLISH_WORD.test(stripInterpolation(span))) hits.push({ file, line: lineNo, text: span })
      }
    }
  })
  return hits
}

describe('i18n static chrome (acceptance-tests.md §8)', () => {
  it('zh/en key sets are exactly equal per namespace', () => {
    expect(localeParityReport()).toEqual([])
  })

  it('client source has no hardcoded Chinese in string literals (R1)', () => {
    const violations: string[] = []
    for (const file of clientSourceFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, idx) => {
        for (const span of stringLiteralSpans(line)) {
          if (CJK.test(span)) violations.push(`${relative(CLIENT_ROOT, file)}:${idx + 1}: ${span.trim()}`)
        }
      })
    }
    expect(violations).toEqual([])
  })

  it('chrome positions never receive hardcoded English literals (R2)', () => {
    const hits: ChromeHit[] = []
    for (const file of clientSourceFiles()) {
      const lines = readFileSync(file, 'utf8').split('\n')
      hits.push(...scanChromeEnglish(file, lines))
    }
    const unexplained = hits.filter(h => ALLOWED_HARDCODED[`${relative(process.cwd(), h.file)}:${h.line}`] === undefined
      && ALLOWED_HARDCODED[`${h.file}:${h.line}`] === undefined)
    if (unexplained.length > 0) {
      const detail = unexplained.map(h => `  ${h.file}:${h.line}: ${h.text}`).join('\n')
      throw new Error(`hardcoded English chrome text (use t('ns','key')):\n${detail}`)
    }
  })
})
