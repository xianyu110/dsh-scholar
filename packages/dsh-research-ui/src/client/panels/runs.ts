import type { ContextMenuItem, ProjectRow, Projection } from '../types'
import { api } from '../api'
import { t } from '../i18n/index'
import { state, tabSave } from '../state'
import { copyText, el, fmtId, openContextMenu, pill, rootHost, showToast } from '../ui'
import { terminalLoadSeq } from '../terminal'
export let runsSelecting = false
export let runsSelected = new Set<string>()
/** Runs status filter (dsh-web filter chips). */
export let runsFilter = 'all'
export const RUNS_FILTERS: Array<[string, string]> = [
  ['all', t('runs', 'runs.filter.all')], ['queued', t('runs', 'runs.filter.queued')], ['running', t('runs', 'runs.filter.running')],
  ['succeeded', t('runs', 'runs.filter.succeeded')], ['failed', t('runs', 'runs.filter.failed')], ['cancelled', t('runs', 'runs.filter.cancelled')],
]


export function renderRuns(body: HTMLElement, p: Projection): void {
  const allJobs = p.jobs ?? []
  const jobs = (runsFilter === 'all' ? allJobs : allJobs.filter(j => j.status === runsFilter)).slice(-12).reverse()
  const cancellable = new Set(['queued', 'running', 'retryable'])
  const labelRow = el('div', 'row')
  labelRow.style.cssText = 'justify-content:space-between;align-items:center'
  labelRow.appendChild(el('div', 'section-label', t('runs', 'runs.section', { count: String(allJobs.length) })))
  if (jobs.length > 0) {
    const selBtn = el('button', 'hbtn', runsSelecting ? t('runs', 'runs.selecting') : t('runs', 'runs.select'))
    selBtn.title = runsSelecting ? t('runs', 'runs.selecting.title') : t('runs', 'runs.select.title')
    selBtn.setAttribute('aria-pressed', runsSelecting ? 'true' : 'false')
    selBtn.style.cssText = 'padding:1px 10px;margin-bottom:2px'
    selBtn.onclick = () => {
      runsSelecting = !runsSelecting
      runsSelected.clear()
      state.rerender()
    }
    labelRow.appendChild(selBtn)
  }
  body.appendChild(labelRow)
  // dsh-web filter chips: one-click status filter with live counts.
  const chipsRow = el('div')
  chipsRow.style.cssText = 'display:flex;gap:4px;padding:2px 0 6px;flex-wrap:wrap'
  for (const [key, label] of RUNS_FILTERS) {
    const count = key === 'all' ? allJobs.length : allJobs.filter(j => j.status === key).length
    const chip = el('button', 'hbtn', `${label} (${count})`)
    chip.style.cssText = 'padding:2px 8px;font-size:10px'
    if (runsFilter === key) chip.style.cssText += ';border-color:var(--accent);color:var(--accent-text);background:var(--accent-soft)'
    chip.setAttribute('aria-pressed', runsFilter === key ? 'true' : 'false')
    chip.onclick = () => { runsFilter = key; state.rerender() }
    chipsRow.appendChild(chip)
  }
  body.appendChild(chipsRow)
  if (jobs.length === 0) {
    body.appendChild(el('div', 'empty', allJobs.length === 0
      ? t('runs', 'runs.empty')
      : t('runs', 'runs.noMatch', { status: runsFilter })))
    return
  }
  if (allJobs.length > 12) {
    const notice = el('div', 'muted', t('runs', 'runs.showingNewest', { count: String(allJobs.length) }))
    notice.style.cssText = 'font-size:10px;padding:2px;text-align:center'
    body.appendChild(notice)
  }
  // Bulk cancel bar when selecting.
  if (runsSelecting) {
    const bar = el('div', 'card border-red')
    bar.style.cssText = 'padding:8px 10px;margin:4px 0;display:flex;align-items:center;gap:10px'
    const count = el('span', 'mono', t('common', 'common.selected', { count: String(runsSelected.size) }))
    count.style.cssText = 'font-size:11px;color:var(--text)'
    const cancelSel = el('button', 'btn cancel', t('runs', 'runs.cancelSelected'))
    cancelSel.disabled = runsSelected.size === 0
    cancelSel.onclick = async () => {
      for (const id of runsSelected) {
        await api(`/v1/jobs/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ actor: 'web-user', reason: 'bulk cancelled from Research OS panel' }),
        })
      }
      showToast(rootHost(), t('runs', 'runs.cancelledToast', { count: String(runsSelected.size) }))
      runsSelecting = false
      runsSelected.clear()
      state.rerender()
    }
    const doneSel = el('button', 'hbtn', t('artifacts', 'artifacts.done'))
    doneSel.setAttribute('aria-label', t('runs', 'runs.exitMultiSelect'))
    doneSel.onclick = () => {
      runsSelecting = false
      runsSelected.clear()
      state.rerender()
    }
    const allBtn = el('button', 'hbtn', t('artifacts', 'artifacts.all'))
    allBtn.title = t('runs', 'runs.allTitle')
    allBtn.onclick = () => {
      for (const j of jobs) if (j.job_id !== undefined && cancellable.has(j.status ?? '')) runsSelected.add(j.job_id)
      state.rerender()
    }
    bar.append(count, allBtn, cancelSel, doneSel)
    body.appendChild(bar)
  }
  for (const job of jobs) {
    const card = el('div', 'card')
    card.style.cssText = 'padding:8px 10px;margin:5px 0'
    const row = el('div', 'row')
    const kind = el('span', 'artifact-kind', job.kind ?? '?')
    kind.style.cssText += ';text-transform:uppercase'
    row.appendChild(kind)
    // dsh-web depth: the pre-registered contract this run executed under.
    if (typeof job.contract_id === 'string' && job.contract_id !== '') {
      const chip = el('span', 'artifact-kind', `${t('runs', 'runs.ctr')} ${fmtId(job.contract_id, 12)}`)
      chip.title = t('runs', 'runs.contractTitle', { id: job.contract_id })
      chip.style.cssText += ';color:var(--text-3)'
      row.appendChild(chip)
    }
    // Multi-select checkbox.
    if (runsSelecting && job.job_id !== undefined && cancellable.has(job.status ?? '')) {
      const box = el('span', 'ws-check', runsSelected.has(job.job_id) ? '☑' : '☐')
      box.style.cssText += ';cursor:pointer'
      box.onclick = () => {
        if (job.job_id === undefined) return
        if (runsSelected.has(job.job_id)) runsSelected.delete(job.job_id)
        else runsSelected.add(job.job_id)
        state.rerender()
      }
      row.prepend(box)
      if (runsSelected.has(job.job_id)) card.style.outline = '1px solid var(--tone-red)'
    }
    const text = el('span', 'grow mono', fmtId(job.job_id))
    row.appendChild(text)
    // dsh-web live feel: running jobs get a pulsing dot.
    if (job.status === 'running') {
      const pulse = el('span')
      pulse.style.cssText = 'width:7px;height:7px;border-radius:50%;background:var(--tone-blue);animation:pulse 1.2s ease-in-out infinite;flex-shrink:0'
      pulse.title = t('runs', 'runs.filter.running')
      row.appendChild(pulse)
    }
    row.appendChild(pill(job.status))
    // dsh-web drawer: one-click job details (double-click still works).
    if (job.job_id !== undefined) {
      const detailsBtn = el('button', 'hbtn', '⧉')
      detailsBtn.title = t('runs', 'runs.jobDetails')
      detailsBtn.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      detailsBtn.onclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root != null) void openJobDetailModal(root, job.job_id!)
      }
      row.appendChild(detailsBtn)
      // dsh-web "open terminal": jump to the Terminal tab for this run.
      const termBtn = el('button', 'hbtn', '🖥')
      termBtn.title = t('runs', 'runs.openTerminalTitle')
      termBtn.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      termBtn.onclick = (event) => {
        event.stopPropagation()
        state.terminalRunId = job.job_id!
        state.terminalLines = []
        state.terminalLastSeq = 0
        state.terminalTotalBytes = 0
        state.terminalDroppedBytes = 0
        state.terminalTruncated = false
        state.terminalExitCode = null
        state.terminalExitSignal = null
        state.terminalStatus = 'idle'
        terminalLoadSeq()
        state.activeTab = 'terminal'
        tabSave()
        state.rerender()
      }
      row.appendChild(termBtn)
    }
    card.appendChild(row)
    // dsh-web job drawer: double-click opens the full detail modal.
    card.title = t('runs', 'runs.jobRowTitle')
    card.ondblclick = (event) => {
      event.stopPropagation()
      if (job.job_id === undefined) return
      const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
      if (root != null) void openJobDetailModal(root, job.job_id)
    }
    // dsh-web context menu: details / copy id / cancel.
    card.oncontextmenu = (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (job.job_id === undefined) return
      const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
      if (root == null) return
      const jid = job.job_id
      const items: ContextMenuItem[] = [
        { label: `⧉ ${t('common', 'common.action.details')}`, onPick: () => { void openJobDetailModal(root, jid) } },
        { label: t('common', 'common.action.copyId'), hint: jid, onPick: () => copyText(jid) },
      ]
      if (cancellable.has(job.status ?? '') && !runsSelecting) {
        items.push({
          label: `✕ ${t('common', 'common.action.cancel')}`,
          danger: true,
          onPick: () => {
            void api(`/v1/jobs/${encodeURIComponent(jid)}/cancel`, {
              method: 'POST',
              body: JSON.stringify({ actor: 'web-user', reason: 'cancelled from context menu' }),
            }).then((ok) => {
              showToast(rootHost(), ok === null
                ? t('runs', 'runs.cancelFailed')
                : t('runs', 'runs.cancelledRun', { id: fmtId(jid, 18) }))
              state.rerender()
            })
          },
        })
      }
      openContextMenu(root, event.clientX, event.clientY, items)
    }
    if (job.error !== undefined && job.error !== '') {
      const err = el('div', 'muted', job.error)
      err.style.cssText = 'margin-top:4px;color:var(--tone-red);font-size:10.5px;word-break:break-all'
      card.appendChild(err)
    }
    if (job.job_id !== undefined && cancellable.has(job.status ?? '') && !runsSelecting) {
      const cancel = el('button', 'btn cancel', `✕ ${t('common', 'common.action.cancel')}`)
      cancel.onclick = async () => {
        const ok = await api(`/v1/jobs/${encodeURIComponent(job.job_id ?? '')}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ actor: 'web-user', reason: 'cancelled from Research OS panel' }),
        })
        if (ok === null) {
          state.lastError = t('runs', 'runs.cancelFailedError')
        } else {
          state.lastError = undefined
          showToast(rootHost(), t('runs', 'runs.cancelledRun', { id: fmtId(job.job_id, 18) }))
        }
        state.rerender()
      }
      const wrap = el('div', 'row')
      wrap.style.cssText = 'justify-content:flex-end;margin-top:6px'
      wrap.appendChild(cancel)
      card.appendChild(wrap)
    }
    body.appendChild(card)
  }
}


/* ─────────────────────────── job detail modal ─────────────────────────── */

/**
 * dsh-web job drawer: full record of one run (kind, status, error,
 * contract, run manifest digest) plus a cancel action when cancellable.
 */
export async function openJobDetailModal(root: ShadowRoot, jobId: string): Promise<void> {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:560px;max-width:94vw'
  const header = el('div', 'modal-header', t('runs', 'runs.jobDetailsModal'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const loading = el('div', 'muted', t('common', 'common.status.loading'))
  modal.appendChild(loading)
  overlay.appendChild(modal)
  root.appendChild(overlay)

  const jobs = (await api<Array<Record<string, unknown>>>(`/v1/jobs?job_id=${encodeURIComponent(jobId)}`))
  let job = Array.isArray(jobs) ? jobs.find(j => j.job_id === jobId) : undefined
  if (job === undefined) {
    // Fall back to scanning projects' job lists.
    const projects = (await api<ProjectRow[]>('/v1/projects')) ?? []
    for (const p of projects) {
      if (p.project_id === undefined) continue
      const list = (await api<Array<Record<string, unknown>>>(`/v1/projects/${encodeURIComponent(p.project_id)}/jobs`)) ?? []
      job = list.find(j => j.job_id === jobId)
      if (job !== undefined) break
    }
  }
  if (job === undefined) {
    loading.textContent = t('runs', 'runs.jobNotFound')
    return
  }
  modal.removeChild(loading)

  const row = (label: string, value: string): void => {
    const r = el('div', 'row')
    r.style.cssText = 'padding:4px 0;align-items:flex-start'
    const l = el('span', '', label)
    l.style.cssText = 'width:110px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
    const v = el('span', 'mono', value)
    v.style.cssText = 'font-size:11px;color:var(--text);word-break:break-word'
    r.append(l, v)
    modal.appendChild(r)
  }
  const titleRow = el('div', 'row')
  titleRow.style.cssText = 'align-items:center;gap:8px;margin-bottom:8px'
  titleRow.appendChild(el('span', 'artifact-kind', String(job.kind ?? '?')))
  titleRow.appendChild(el('span', 'pname', fmtId(String(job.job_id), 30)))
  titleRow.appendChild(el('span', 'grow'))
  titleRow.appendChild(pill(String(job.status ?? '')))
  modal.appendChild(titleRow)

  modal.appendChild(el('div', 'section-label', t('runs', 'runs.sectionRun')))
  row(t('runs', 'runs.detailJob'), `\`${String(job.job_id)}\``)
  row(t('runs', 'runs.detailKind'), String(job.kind ?? '—'))
  row(t('runs', 'runs.detailStatus'), String(job.status ?? '—'))
  if (typeof job.contract_id === 'string' && job.contract_id !== '') row(t('runs', 'runs.detailContract'), job.contract_id)
  if (typeof job.failure_class === 'string' && job.failure_class !== '') row(t('runs', 'runs.detailFailure'), job.failure_class)
  if (typeof job.error === 'string' && job.error !== '') row(t('runs', 'runs.detailError'), job.error)

  const manifest = job.run_manifest
  if (typeof manifest === 'object' && manifest !== null) {
    modal.appendChild(el('div', 'section-label', t('runs', 'runs.sectionManifest')))
    const m = manifest as Record<string, unknown>
    if (typeof m.run_id === 'string') row(t('runs', 'runs.detailRun'), m.run_id)
    if (typeof m.exit_code === 'number') row(t('runs', 'runs.detailExitCode'), String(m.exit_code))
    if (typeof m.container_digest === 'string' && m.container_digest !== '') row(t('runs', 'runs.detailContainer'), m.container_digest)
    if (typeof m.runner_key_id === 'string') row(t('runs', 'runs.detailSigner'), m.runner_key_id)
    if (typeof m.metrics_artifact === 'string') row(t('runs', 'runs.detailMetrics'), fmtId(m.metrics_artifact, 24))
    // dsh-web depth: copy the signed manifest for external verification.
    const copyManifest = el('button', 'hbtn', t('common', 'common.action.copyManifest'))
    copyManifest.title = t('common', 'common.action.copyManifest.title')
    copyManifest.style.cssText = 'margin-top:8px'
    copyManifest.onclick = () => {
      void navigator.clipboard.writeText(JSON.stringify(m, null, 2)).then(
        () => { copyManifest.textContent = t('common', 'common.action.copied') },
        () => { copyManifest.textContent = t('common', 'common.action.copyFailed') },
      )
      setTimeout(() => { copyManifest.textContent = t('common', 'common.action.copyManifest') }, 1600)
    }
    modal.appendChild(copyManifest)
  }

  const status = String(job.status ?? '')
  if (['queued', 'running', 'retryable'].includes(status)) {
    const cancelRow = el('div', 'row')
    cancelRow.style.cssText = 'justify-content:flex-end;margin-top:12px'
    const cancel = el('button', 'btn cancel', t('common', 'common.action.cancelJob'))
    cancel.onclick = async () => {
      const ok = await api(`/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ actor: 'web-user', reason: 'cancelled from job details' }),
      })
      if (ok !== null) overlay.remove()
      state.rerender()
    }
    cancelRow.appendChild(cancel)
    modal.appendChild(cancelRow)
  }
}

