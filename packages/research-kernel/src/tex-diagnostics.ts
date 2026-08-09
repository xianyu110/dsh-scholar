/**
 * TeX log diagnostics parser (kernel layer, acceptance-tests.md §7).
 *
 * The runner gateway streams raw pdflatex log bytes to the log artifact and
 * emits a first-pass diagnostics array in the run manifest. The kernel
 * re-parses the authoritative log artifact at latex-compile completion so
 * the durable tex_builds diagnostics carry:
 *
 *   - `file`/`line` location fields (pdflatex `-file-line-error` prefix
 *     `./paper.tex:12: …` and classic `!` errors with `l.<n>` context lines,
 *     resolved against the `(./file.tex` open-paren stack);
 *   - structured `kind`s: `latex_error`, `undefined_citation`,
 *     `undefined_reference`, `missing_file`, `warning`.
 *
 * Raw log bytes stay on the log artifact (gui-plugin-plan §13.4: TeX raw
 * diagnostics are content, not chrome); this parser only shapes them.
 * @module @dsh-scholar/research-kernel/tex-diagnostics
 */

export interface LatexDiagnostic {
  level: 'error' | 'warning' | 'info'
  message: string
  /** Structured diagnosis class (acceptance-tests.md §7). */
  kind?: 'latex_error' | 'undefined_citation' | 'undefined_reference' | 'missing_file' | 'warning'
  /** Source file the diagnostic refers to, when resolvable. */
  file?: string
  /** 1-based source line, when resolvable. */
  line?: number
  /** The undefined citation/reference key (kind=undefined_*). */
  citation?: string
  /** The missing file name (kind=missing_file). */
  missing?: string
}

/** pdflatex -file-line-error prefix: `./paper.tex:12: message`. */
const FILE_LINE_RE = /^([^:\s]+\.(?:tex|sty|cls|bib)):(\d+):\s*(.*)$/

/** Classic `!` error context line: `l.12 \foobar`. */
const LINE_CONTEXT_RE = /^l\.(\d+)\b/

/** `(./paper.tex` … open-paren file markers (nested file scopes). */
const OPEN_FILE_RE = /^\(([^)\s]+)$/

const CLOSE_PAREN_RE = /^\)/

/** Normalize `./paper.tex` -> `paper.tex` for stable file fields. */
function normalizeFile(path: string): string {
  return path.replace(/^\.\//, '')
}

/** `LaTeX Warning: Citation `x' on page 1 undefined on input line 9.` */
const CITATION_WARNING_RE = /^LaTeX Warning: Citation `([^']+)'.*undefined on input line (\d+)\.?$/

/** `LaTeX Warning: Reference `eq:x' on page 1 undefined on input line 9.` */
const REFERENCE_WARNING_RE = /^LaTeX Warning: Reference `([^']+)'.*undefined on input line (\d+)\.?$/

/** `! LaTeX Error: File `missing.sty' not found.` */
const MISSING_FILE_RE = /^LaTeX Error: File `([^']+)' not found\.?$/

const GENERIC_WARNING_RE = /^(.*Warning|Overfull|Underfull).*$/i

/** A `(./x.tex` marker is only a file scope when it names a real source file. */
function looksLikeSourceFile(path: string): boolean {
  return /\.(tex|sty|cls|bib|bbl|aux|fls)$/.test(path)
}

/**
 * Parse a pdflatex .log into structured diagnostics with file/line location
 * and classification. Output is capped at 200 entries (bounded memory on
 * pathological logs); anything not recognized is ignored.
 */
export function parseLatexDiagnostics(logText: string): LatexDiagnostic[] {
  const lines = logText.split('\n')
  const out: LatexDiagnostic[] = []
  // Open-paren file stack: `(./sections/intro.tex` … `)`. The top of the
  // stack is the file an error on the current line refers to.
  const fileStack: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (CLOSE_PAREN_RE.test(trimmed)) {
      fileStack.pop()
      continue
    }
    const open = OPEN_FILE_RE.exec(trimmed)
    if (open !== null) {
      if (looksLikeSourceFile(open[1]!)) fileStack.push(normalizeFile(open[1]!))
      continue
    }
    // -file-line-error prefix — the `!` marker is replaced by `file:line:`.
    const fle = FILE_LINE_RE.exec(trimmed)
    if (fle !== null) {
      const message = fle[3]!.trim()
      const file = normalizeFile(fle[1]!)
      const lineNo = Number(fle[2])
      // With -file-line-error, errors carry the prefix; plain warnings keep
      // the `LaTeX Warning: …` shape (handled below).
      if (message.startsWith('LaTeX Warning')) {
        const citation = CITATION_WARNING_RE.exec(message)
        const reference = REFERENCE_WARNING_RE.exec(message)
        out.push({
          level: 'warning',
          message,
          kind: citation !== null ? 'undefined_citation' : reference !== null ? 'undefined_reference' : 'warning',
          file,
          line: lineNo,
          ...(citation !== null ? { citation: citation[1] } : {}),
          ...(reference !== null ? { citation: reference[1] } : {}),
        })
      } else {
        const missing = MISSING_FILE_RE.exec(message)
        out.push({
          level: 'error',
          message,
          kind: missing !== null ? 'missing_file' : 'latex_error',
          file: missing !== null ? (missing[1] ?? file) : file,
          line: lineNo,
          ...(missing !== null ? { missing: missing[1] } : {}),
        })
      }
      continue
    }
    if (line.startsWith('!')) {
      const context = lines[i + 1]?.trim() ?? ''
      const lineNo = LINE_CONTEXT_RE.exec(context)?.[1]
      const message = trimmed.slice(1).trim()
      const missing = MISSING_FILE_RE.exec(message)
      const currentFile = fileStack.at(-1)
      out.push({
        level: 'error',
        message,
        kind: missing !== null ? 'missing_file' : 'latex_error',
        file: missing !== null ? (missing[1] ?? currentFile) : currentFile,
        line: lineNo !== undefined ? Number(lineNo) : undefined,
        ...(missing !== null ? { missing: missing[1] } : {}),
      })
      continue
    }
    // Structured warnings: undefined citation / reference (with line).
    const citation = CITATION_WARNING_RE.exec(trimmed)
    if (citation !== null) {
      out.push({
        level: 'warning',
        message: trimmed,
        kind: 'undefined_citation',
        citation: citation[1],
        file: fileStack.at(-1),
        line: Number(citation[2]),
      })
      continue
    }
    const reference = REFERENCE_WARNING_RE.exec(trimmed)
    if (reference !== null) {
      out.push({
        level: 'warning',
        message: trimmed,
        kind: 'undefined_reference',
        citation: reference[1],
        file: fileStack.at(-1),
        line: Number(reference[2]),
      })
      continue
    }
    // Generic warnings (Overfull/Underfull/…); pass-1 citation/reference
    // noise was already handled above, other `(…)` parenthetical noise is
    // skipped.
    if (GENERIC_WARNING_RE.test(trimmed) && !/^(\(|\))/.test(trimmed)) {
      out.push({ level: 'warning', kind: 'warning', message: trimmed, file: fileStack.at(-1) })
    }
  }
  return out.slice(0, 200)
}
