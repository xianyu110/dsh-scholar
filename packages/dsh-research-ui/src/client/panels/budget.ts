import type { Projection } from '../types'
import { t } from '../i18n/index'
import { el, trapFocus } from '../ui'
import { state } from '../state'
export function openBudgetDetailModal(root: ShadowRoot, p: Projection): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:540px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', t('budget', 'budget.detailsModal'))
  const header = el('div', 'modal-header', t('budget', 'budget.detailsModal'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const row = (label: string, value: string): void => {
    const r = el('div', 'row')
    r.style.cssText = 'padding:4px 0;align-items:flex-start'
    const l = el('span', '', label)
    l.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
    const v = el('span', 'mono', value)
    v.style.cssText = 'font-size:11px;color:var(--text);word-break:break-word'
    r.append(l, v)
    modal.appendChild(r)
  }
  const c = p.project?.constraints
  const b = p.budget
  const exec = p.project?.execution as Record<string, unknown> | undefined
  const integ = p.project?.integrity as Record<string, unknown> | undefined
  modal.appendChild(el('div', 'section-label', t('evidence', 'evidence.budget.usage')))
  row(t('budget', 'budget.modelCost'), `$${b?.model_cost_usd ?? 0}${c?.max_model_cost_usd !== undefined ? ` / $${c.max_model_cost_usd}` : ''}`)
  row(t('budget', 'budget.gpuHours'), `${b?.gpu_hours ?? 0}${c?.max_gpu_hours !== undefined ? ` / ${c.max_gpu_hours}` : ''}`)
  row(t('evidence', 'evidence.apiRequests'), String(b?.api_requests ?? 0))
  modal.appendChild(el('div', 'section-label', t('evidence', 'evidence.budget.constraints')))
  row(t('budget', 'budget.datasets'), String(c?.datasets ?? '—'))
  row(t('budget', 'budget.modelUpload'), String(c?.external_model_upload ?? '—'))
  row(t('budget', 'budget.parallelJobs'), String(c?.max_parallel_jobs ?? '—'))
  modal.appendChild(el('div', 'section-label', t('evidence', 'evidence.budget.execution')))
  if (exec !== undefined) {
    row(t('budget', 'budget.runner'), String(exec.runner_profile_id ?? '—'))
    row(t('budget', 'budget.network'), String(exec.network_policy ?? '—'))
    row(t('budget', 'budget.artifacts'), String(exec.artifact_store ?? '—'))
  }
  modal.appendChild(el('div', 'section-label', t('evidence', 'evidence.budget.integrity')))
  if (integ !== undefined) {
    row(t('budget', 'budget.baselineRepro'), String(integ.require_baseline_reproduction ?? '—'))
    row(t('budget', 'budget.contract'), String(integ.require_experiment_contract ?? '—'))
    row(t('budget', 'budget.claimLinks'), String(integ.require_claim_evidence_links ?? '—'))
    row(t('budget', 'budget.cleanRoom'), String(integ.require_clean_room_rerun ?? '—'))
    row(t('budget', 'budget.autoRelease'), String(integ.allow_automatic_public_release ?? '—'))
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  trapFocus(overlay, null)
}

export function renderBudget(body: HTMLElement, p: Projection): void {
  const c = p.project?.constraints
  const b = p.budget
  const model = b?.model_cost_usd ?? 0
  const gpu = b?.gpu_hours ?? 0
  const modelMax = c?.max_model_cost_usd
  const gpuMax = c?.max_gpu_hours
  const labelRow = el('div', 'row')
  labelRow.style.cssText = 'justify-content:space-between;align-items:center'
  labelRow.appendChild(el('div', 'section-label', t('budget', 'budget.section')))
  const detailBtn = el('button', 'hbtn', t('budget', 'budget.details'))
  detailBtn.style.cssText = 'padding:1px 10px;margin-bottom:2px'
  detailBtn.onclick = () => {
    const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
    if (root != null) openBudgetDetailModal(root, p)
  }
  labelRow.appendChild(detailBtn)
  body.appendChild(labelRow)
  const row1 = budgetRow(t('budget', 'budget.modelCost'), model, modelMax, '$', 2)
  const row2 = budgetRow(t('budget', 'budget.gpuHours'), gpu, gpuMax, '', 2)
  const row3 = el('div', 'budget-row')
  row3.appendChild(el('span', 'blabel', t('evidence', 'evidence.apiRequests')))
  row3.appendChild(el('span', 'grow muted', String(b?.api_requests ?? 0)))
  body.append(row1, row2, row3)

  const counts = p.counts
  if (counts !== undefined) {
    body.appendChild(el('div', 'section-label', t('budget', 'budget.projectContents')))
    const chips = el('div', 'count-chips')
    const entries: Array<[string, number]> = [
      ['📚 snapshots', counts.corpus_snapshots ?? 0],
      ['💡 ideas', counts.ideas ?? 0],
      ['📋 contracts', counts.contracts ?? 0],
      ['🧾 claims', counts.claims ?? 0],
      ['📊 evidence', counts.evidence ?? 0],
      ['📦 artifacts', counts.artifacts ?? 0],
    ]
    for (const [label, n] of entries) {
      const chip = el('span', 'chip')
      chip.append(document.createTextNode(label), el('b', '', String(n)))
      chips.appendChild(chip)
    }
    body.appendChild(chips)
  }
  const over = (modelMax !== undefined && model > modelMax) || (gpuMax !== undefined && gpu > gpuMax)
  if (over) {
    const warn = el('div', 'warn', t('evidence', 'evidence.budgetExceeded'))
    body.appendChild(warn)
  }
}

export function budgetRow(label: string, value: number, max: number | undefined, prefix: string, digits: number): HTMLElement {
  const row = el('div', 'budget-row')
  row.appendChild(el('span', 'blabel', label))
  const track = el('div', 'budget-track')
  const fill = el('div', 'budget-fill')
  const ratio = max !== undefined && max > 0 ? Math.min(value / max, 1) : 0
  const color = ratio >= 1 ? 'var(--tone-red)' : ratio >= 0.8 ? 'var(--tone-amber)' : 'var(--accent)'
  fill.style.cssText = `width:${Math.max(ratio * 100, value > 0 ? 4 : 0)}%;background:${color};box-shadow:0 0 6px ${color}`
  track.appendChild(fill)
  row.appendChild(track)
  const val = el('span', 'budget-val', `${prefix}${value.toFixed(digits)}${max !== undefined ? ` / ${prefix}${max}` : ''}`)
  row.appendChild(val)
  return row
}
