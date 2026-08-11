import type { Projection, TerminalLine } from './types'
import { authHeaders, base } from './api'
import { t } from './i18n/index'
import { copyText, el, fmtId } from './ui'
import { state } from './state'
/* ─────────────────────────── Terminal tab ─────────────────────────── */

/**
 * dsh-web real-time terminal (gui-plugin-plan §8): stdout/stderr of a run
 * streamed over SSE. Frames are appended as text nodes with a minimal ANSI
 * colour whitelist — never HTML-string sinks. The stream survives the 8s panel
 * refresh (module state + direct DOM append); leaving the tab closes it and
 * the next visit resumes from the persisted lastSeq.
 */
export const TERMINAL_MAX_LINES = 10000
export const TERMINAL_SEQ_KEY = 'dsh-scholar-ui-terminal-seq'
export const TERMINAL_ANSI: Record<number, string> = {
  30: '#5b6472', 31: '#e5484d', 32: '#30a46c', 33: '#f5a524', 34: '#3b82f6',
  35: '#d6409f', 36: '#12a594', 37: '#dbe2ee',
  90: '#9aa4b2', 91: '#ff6369', 92: '#46a758', 93: '#f5a524', 94: '#60a5fa',
  95: '#e93d82', 96: '#5eead4', 97: '#ffffff',
}

export function terminalLoadSeq(): void {
  try {
    const raw = localStorage.getItem(TERMINAL_SEQ_KEY)
    if (raw === null || state.terminalRunId === null) return
    const map = JSON.parse(raw) as Record<string, number>
    if (typeof map[state.terminalRunId] === 'number') state.terminalLastSeq = map[state.terminalRunId]!
  } catch { /* private mode */ }
}
export function terminalSaveSeq(): void {
  if (state.terminalRunId === null) return
  try {
    const raw = localStorage.getItem(TERMINAL_SEQ_KEY)
    const map = raw !== null ? JSON.parse(raw) as Record<string, number> : {}
    map[state.terminalRunId] = state.terminalLastSeq
    localStorage.setItem(TERMINAL_SEQ_KEY, JSON.stringify(map))
  } catch { /* private mode */ }
}

export function terminalDisconnect(): void {
  state.terminalAbort?.abort()
  state.terminalAbort = null
  state.terminalStatus = 'idle'
  state.terminalStreamEl = null
}

/**
 * PURE exit-frame facts (USAGE_GUIDE §6: exit code/signal are the visible
 * terminal states; timed-out and cancelled are separate authoritative
 * terminal fates carried by the kernel's exit payload). No DOM — unit-tested.
 */
export function terminalExitFragments(payload: Record<string, unknown>): {
  exitCode: number | null
  exitSignal: string | null
  timedOut: boolean
  cancelled: boolean
  truncated: boolean
  totalBytes: number
  droppedBytes: number
} {
  const exitCode = payload.exit_code !== null && payload.exit_code !== undefined ? Number(payload.exit_code) : null
  const exitSignal = typeof payload.signal === 'string' && payload.signal !== '' ? payload.signal : null
  return {
    exitCode: Number.isFinite(exitCode as number) ? exitCode : null,
    exitSignal,
    timedOut: payload.timed_out === true,
    cancelled: payload.cancelled === true,
    truncated: payload.truncated === true,
    totalBytes: Number(payload.total_bytes ?? 0),
    droppedBytes: Number(payload.dropped_bytes ?? 0),
  }
}

/** Strip/whitelist ANSI SGR codes; output via text nodes only. */
export function terminalAppendText(target: HTMLElement, text: string): void {
  const re = /\x1b\[([0-9;]*)m/g
  let last = 0
  let match: RegExpExecArray | null
  let color = ''
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      const seg = text.slice(last, match.index)
      if (color !== '') {
        const span = el('span')
        span.style.color = color
        span.textContent = seg
        target.appendChild(span)
      } else {
        target.appendChild(document.createTextNode(seg))
      }
    }
    const codes = match[1]!.split(';').map(Number)
    color = ''
    for (const c of codes) {
      if (c === 0) color = ''
      else if (TERMINAL_ANSI[c] !== undefined) color = TERMINAL_ANSI[c]!
    }
    last = match.index + match[0].length
  }
  if (last < text.length) {
    const seg = text.slice(last)
    if (color !== '') {
      const span = el('span')
      span.style.color = color
      span.textContent = seg
      target.appendChild(span)
    } else {
      target.appendChild(document.createTextNode(seg))
    }
  }
}

/** Live status bar paint (async status changes update the DOM directly).
 *  All copy is evaluated against the CURRENT locale at paint time (§13.4);
 *  raw byte counts stay numeric wire data. */
export function terminalPaintStatus(): void {
  if (state.terminalStatusEl === null) return
  const statusMap: Record<string, string> = {
    idle: t('terminal', 'terminal.status.idle'), connecting: t('terminal', 'terminal.status.connecting'), live: t('terminal', 'terminal.status.live'), reconnecting: t('terminal', 'terminal.status.reconnecting'), exited: t('terminal', 'terminal.status.exited'),
  }
  state.terminalStatusEl.textContent = statusMap[state.terminalStatus] ?? state.terminalStatus
  state.terminalStatusEl.style.color = state.terminalStatus === 'live'
    ? 'var(--tone-green)'
    : (state.terminalStatus === 'reconnecting' || state.terminalStatus === 'connecting' ? 'var(--tone-amber)' : 'var(--text-3)')
  if (state.terminalMetaEl !== null) {
    state.terminalMetaEl.textContent = t('terminal', 'terminal.meta', {
      seq: String(state.terminalLastSeq),
      lines: t('terminal', 'terminal.lines', { shown: String(state.terminalLines.length), max: String(TERMINAL_MAX_LINES) }),
      bytes: String(state.terminalTotalBytes),
      dropped: state.terminalDroppedBytes > 0 ? t('terminal', 'terminal.meta.dropped', { count: String(state.terminalDroppedBytes) }) : '',
      truncated: state.terminalTruncated ? t('terminal', 'terminal.meta.truncated') : '',
      exit: state.terminalExitCode !== null || state.terminalExitSignal !== null
        ? t('terminal', 'terminal.meta.exit', { code: state.terminalExitCode !== null ? String(state.terminalExitCode) : String(state.terminalExitSignal ?? '') })
        : '',
    })
  }
}

export function terminalHandleData(event: string, payload: Record<string, unknown>, runId: string): void {
  const seq = Number(payload.seq ?? 0)
  if (event === 'subscribed') {
    // dsh-web: last_seq tells how far the server has; the client cursor
    // must NOT jump there, or the catch-up chunks would be dropped as
    // replay. Only the client's own processed seq is authoritative.
    state.terminalStatus = 'live'
    state.terminalAttempt = 0
    state.terminalRetainedSeq = Number(payload.retained_from_seq ?? 1)
    terminalSaveSeq()
  } else if (event === 'chunk') {
    const channel = payload.channel === 'stderr' ? 'stderr' : 'stdout'
    if (seq <= state.terminalLastSeq) return // idempotent replay
    state.terminalLastSeq = seq
    state.terminalTotalBytes = Number(payload.byte_offset ?? 0) + Number(payload.byte_length ?? 0)
    const text = String(payload.text ?? '')
    state.terminalLines.push({ seq, channel, text })
    if (state.terminalLines.length > TERMINAL_MAX_LINES) state.terminalLines = state.terminalLines.slice(-TERMINAL_MAX_LINES)
    if (state.terminalStreamEl !== null && state.terminalSearch === '') {
      const row = el('div')
      row.style.cssText = channel === 'stderr'
        ? 'color:var(--tone-red);white-space:pre'
        : 'white-space:pre'
      terminalAppendText(row, text)
      state.terminalStreamEl.appendChild(row)
      if (state.terminalAutoScroll) state.terminalStreamEl.scrollTop = state.terminalStreamEl.scrollHeight
    }
    if (state.terminalSaveTimer !== undefined) window.clearTimeout(state.terminalSaveTimer)
    state.terminalSaveTimer = window.setTimeout(() => terminalSaveSeq(), 1500)
  } else if (event === 'gap') {
    state.terminalDroppedBytes += Number(payload.dropped_bytes ?? 0)
    state.terminalRetainedSeq = Number(payload.retained_from_seq ?? state.terminalRetainedSeq)
    state.terminalLastSeq = Math.max(state.terminalLastSeq, seq)
    if (state.terminalStreamEl !== null && state.terminalSearch === '') {
      const warn = el('div', 'term-gap')
      warn.style.cssText = 'color:var(--tone-amber);white-space:pre;font-weight:700'
      warn.textContent = t('terminal', 'terminal.gapWarning', { dropped: String(state.terminalDroppedBytes), retained: String(state.terminalRetainedSeq) })
      state.terminalStreamEl.appendChild(warn)
    }
    void runId
  } else if (event === 'exit') {
    // USAGE_GUIDE §6: exit code/signal, timeout and cancelled are distinct
    // authoritative terminal fates — the kernel exit payload carries
    // timed_out/cancelled flags; the exit line renders them explicitly.
    const facts = terminalExitFragments(payload)
    state.terminalStatus = 'exited'
    state.terminalExitCode = facts.exitCode
    state.terminalExitSignal = facts.exitSignal
    state.terminalTruncated = facts.truncated
    state.terminalTotalBytes = Number(payload.total_bytes ?? state.terminalTotalBytes)
    state.terminalDroppedBytes = Number(payload.dropped_bytes ?? state.terminalDroppedBytes)
    state.terminalLastSeq = Math.max(state.terminalLastSeq, seq)
    terminalSaveSeq()
    state.terminalAbort?.abort()
    state.terminalAbort = null
    terminalPaintStatus()
    if (state.terminalStreamEl !== null && state.terminalSearch === '') {
      const end = el('div', 'term-exit')
      end.style.cssText = 'color:var(--text-3);white-space:pre;font-weight:700'
      const fate = facts.timedOut
        ? t('terminal', 'terminal.exit.timedOut')
        : facts.cancelled ? t('terminal', 'terminal.exit.cancelled') : ''
      const code = state.terminalExitCode !== null ? t('terminal', 'terminal.exit.code', { code: String(state.terminalExitCode) }) : ''
      const signal = state.terminalExitSignal !== null ? t('terminal', 'terminal.exit.signal', { signal: state.terminalExitSignal }) : ''
      const truncated = state.terminalTruncated ? t('terminal', 'terminal.meta.truncated') : ''
      const dropped = state.terminalDroppedBytes > 0 ? t('terminal', 'terminal.meta.dropped', { count: String(state.terminalDroppedBytes) }) : ''
      end.textContent = t('terminal', 'terminal.exitLine', { fate, code, signal, truncated, bytes: String(state.terminalTotalBytes), dropped })
      state.terminalStreamEl.appendChild(end)
      state.terminalStreamEl.scrollTop = state.terminalStreamEl.scrollHeight
    }
  }
  terminalPaintStatus()
}

export async function terminalConnect(projectId: string, jobId: string): Promise<void> {
  state.terminalAbort?.abort()
  state.terminalAbort = new AbortController()
  const controller = state.terminalAbort
  const runId = state.terminalRunId ?? ''
  state.terminalStatus = 'connecting'
  state.terminalAttempt = 0
  const readLoop = async (): Promise<void> => {
    // dsh-web: the server resolves the job's current run identity (frames
    // are stored under the runner's run_id); the client keys its cursor by
    // the job id.
    const url = `${base()}/v1/jobs/${encodeURIComponent(jobId)}/terminal?after_seq=${state.terminalLastSeq}&channel=${state.terminalChannel}`
    try {
      const response = await fetch(url, { headers: { accept: 'text/event-stream', ...(await authHeaders()) }, signal: controller.signal })
      if (!response.ok || response.body === null) throw new Error(`terminal http ${response.status}`)
      state.terminalStatus = 'live'
      state.terminalAttempt = 0
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let pendingEvent = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '')
          buffer = buffer.slice(idx + 1)
          if (line.startsWith(':')) continue // SSE heartbeat comment
          if (line.startsWith('event: ')) { pendingEvent = line.slice(7).trim(); continue }
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data === '') continue
            try {
              terminalHandleData(pendingEvent, JSON.parse(data) as Record<string, unknown>, runId)
            } catch { /* malformed frame: skip */ }
            pendingEvent = ''
            continue
          }
          if (line === '') { pendingEvent = '' }
        }
        if (controller.signal.aborted) return
      }
      if (!controller.signal.aborted) throw new Error('stream ended')
    } catch {
      if (controller.signal.aborted) return
      state.terminalStatus = 'reconnecting'
      state.terminalAttempt += 1
      terminalPaintStatus()
      const delay = Math.min(10000, 500 * 2 ** Math.min(state.terminalAttempt - 1, 5))
      window.setTimeout(() => { if (!controller.signal.aborted) void readLoop() }, delay)
    }
  }
  void readLoop()
}

/** dsh-web Terminal page: run selector, channels, live output, status bar. */
export function renderTerminal(body: HTMLElement, p: Projection, projectId: string): void {
  const jobs = p.jobs ?? []
  const selected = jobs.find(j => j.job_id === state.terminalRunId) ?? jobs[0]
  const selectedId = selected?.job_id ?? null
  if (selectedId !== null && state.terminalRunId !== selectedId) {
    state.terminalRunId = selectedId
    state.terminalLines = []
    state.terminalLastSeq = 0
    state.terminalTotalBytes = 0
    state.terminalDroppedBytes = 0
    state.terminalTruncated = false
    state.terminalExitCode = null
    state.terminalExitSignal = null
    state.terminalStatus = 'idle'
    terminalLoadSeq()
  }
  if (jobs.length === 0) {
    body.appendChild(el('div', 'empty', t('terminal', 'terminal.empty')))
    return
  }

  const toolbar = el('div')
  toolbar.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px'

  // Run selector (dsh-web "Run" list).
  const runSelect = el('select', 'picker')
  runSelect.style.cssText = 'flex:1;min-width:180px;padding:5px 8px;font-size:11px'
  runSelect.setAttribute('aria-label', t('terminal', 'terminal.selectRun'))
  for (const j of jobs) {
    const opt = el('option', '', `${j.kind ?? '?'} · ${j.status ?? '?'} · ${fmtId(j.job_id ?? '', 18)}`)
    opt.value = j.job_id ?? ''
    runSelect.appendChild(opt)
  }
  runSelect.value = selectedId ?? ''
  runSelect.onchange = () => {
    terminalDisconnect()
    state.terminalRunId = runSelect.value || null
    state.terminalLines = []
    state.terminalLastSeq = 0
    state.terminalTotalBytes = 0
    state.terminalDroppedBytes = 0
    state.terminalTruncated = false
    state.terminalExitCode = null
    state.terminalExitSignal = null
    terminalLoadSeq()
    state.rerender()
  }
  toolbar.appendChild(runSelect)

  // Channel filter (dsh-web All/stdout/stderr).
  const channelChips = el('div')
  channelChips.style.cssText = 'display:flex;gap:4px'
  const CHANNELS: Array<['all' | 'stdout' | 'stderr', string]> = [['all', t('terminal', 'terminal.channel.all')], ['stdout', t('terminal', 'terminal.channel.stdout')], ['stderr', t('terminal', 'terminal.channel.stderr')]]
  for (const [key, label] of CHANNELS) {
    const chip = el('button', 'hbtn', label)
    const active = state.terminalChannel === key
    chip.style.cssText = `padding:2px 10px;font-size:10px${active ? ';border-color:var(--accent);color:var(--accent-text);background:var(--accent-soft)' : ''}`
    chip.setAttribute('aria-pressed', active ? 'true' : 'false')
    chip.onclick = () => {
      state.terminalChannel = key
      state.terminalLines = []
      state.terminalLastSeq = 0
      terminalLoadSeq()
      terminalDisconnect()
      state.rerender()
    }
    channelChips.appendChild(chip)
  }
  toolbar.appendChild(channelChips)

  // Search within retained output.
  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = t('terminal', 'terminal.filterPlaceholder')
  searchInput.value = state.terminalSearch
  searchInput.style.cssText = 'flex:1;min-width:140px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:4px 8px;font:11px/1.4 system-ui,sans-serif;outline:none'
  searchInput.oninput = () => { state.terminalSearch = searchInput.value; state.rerender() }
  toolbar.appendChild(searchInput)

  // Actions (dsh-web copy / download).
  const copyAll = el('button', 'hbtn', `⧉ ${t('terminal', 'terminal.action.copyVisible')}`)
  copyAll.title = t('terminal', 'terminal.action.copyVisible')
  copyAll.onclick = () => copyText(state.terminalLines.map(l => l.text).join(''))
  const download = el('button', 'hbtn', `⬇ ${t('terminal', 'terminal.action.downloadLog')}`)
  download.title = t('terminal', 'terminal.action.downloadLog')
  download.onclick = () => {
    const blob = new Blob([state.terminalLines.map(l => l.text).join('')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = el('a', 'dl', t('common', 'common.action.download'))
    a.href = url
    a.download = `run-${(selectedId ?? 'run').slice(0, 18)}.log`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }
  toolbar.append(copyAll, download)
  body.appendChild(toolbar)

  // Output viewport.
  const wrap = el('div')
  wrap.style.cssText = 'position:relative;flex:1;min-height:320px;display:flex;flex-direction:column'
  const stream = el('div')
  stream.style.cssText = 'flex:1;overflow:auto;background:var(--bg-3);border:1px solid var(--border);border-radius:10px;padding:10px 12px;font:11px/1.5 ui-monospace,Menlo,monospace;white-space:pre'
  stream.setAttribute('aria-label', t('terminal', 'terminal.streamAria'))
  stream.setAttribute('aria-live', 'polite')
  const renderLines = (): void => {
    stream.replaceChildren()
    const q = state.terminalSearch.trim().toLowerCase()
    for (const line of state.terminalLines) {
      if (state.terminalChannel !== 'all' && line.channel !== state.terminalChannel) continue
      if (q !== '' && !line.text.toLowerCase().includes(q)) continue
      const row = el('div')
      row.style.cssText = line.channel === 'stderr' ? 'color:var(--tone-red)' : ''
      terminalAppendText(row, line.text)
      stream.appendChild(row)
    }
  }
  renderLines()
  state.terminalStreamEl = stream
  stream.onscroll = () => {
    const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120
    state.terminalAutoScroll = nearBottom
    jumpBtn.style.display = nearBottom ? 'none' : 'inline-block'
  }
  const jumpBtn = el('button', 'hbtn', t('terminal', 'terminal.action.jumpLatest'))
  jumpBtn.title = t('terminal', 'terminal.jumpLatestTitle')
  jumpBtn.style.cssText = 'position:absolute;right:12px;bottom:12px;display:none'
  jumpBtn.onclick = () => { stream.scrollTop = stream.scrollHeight; state.terminalAutoScroll = true; jumpBtn.style.display = 'none' }
  wrap.append(stream, jumpBtn)
  body.appendChild(wrap)

  // Status bar (dsh-web connecting/live/reconnecting/exited + bytes).
  const statusRow = el('div', 'row')
  statusRow.style.cssText = 'margin-top:8px;gap:10px;font-size:10px;color:var(--text-3);flex-wrap:wrap'
  state.terminalStatusEl = el('span', 'artifact-kind', '')
  const metaEl = el('span', '')
  state.terminalMetaEl = metaEl
  statusRow.append(state.terminalStatusEl, metaEl)
  body.appendChild(statusRow)

  // (Re)connect: idle terminal with a run selected (exit frames are
  // replayable via after_seq, but an exited run is not re-streamed).
  if (selectedId !== null && state.terminalStatus === 'idle' && state.terminalAbort === null) {
    void terminalConnect(projectId, selectedId)
  }
  terminalPaintStatus()
}


