import { registerOverlayRebuild, t } from '../i18n/index'
import { el, fmtId, pill, trapFocus } from '../ui'
/* ─────────────────────────── contract detail modal ─────────────────────────── */

/** dsh-web contract drawer: full record of an ExperimentContract. */
export function openContractDetailModal(root: ShadowRoot, contract: Record<string, unknown>): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', t('overview', 'overview.contractDetails'))
  const header = el('div', 'modal-header', t('overview', 'overview.contractDetailsModal'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

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
  titleRow.appendChild(el('span', 'pname', fmtId(String(contract.contract_id ?? ''), 28)))
  titleRow.appendChild(el('span', 'grow'))
  titleRow.appendChild(pill(String(contract.status ?? '')))
  modal.appendChild(titleRow)

  const data = contract.data as Record<string, unknown> | undefined
  const methods = contract.methods as Record<string, unknown> | undefined
  const metrics = contract.metrics as Record<string, unknown> | undefined
  const analysis = contract.analysis as Record<string, unknown> | undefined
  modal.appendChild(el('div', 'section-label', t('overview', 'overview.contractSection')))
  row(t('overview', 'overview.detailContract'), String(contract.contract_id ?? '—'))
  row(t('overview', 'overview.detailStatus'), String(contract.status ?? '—'))
  if (typeof contract.version === 'string') row(t('overview', 'overview.detailVersion'), contract.version)
  if (typeof contract.idea_id === 'string') row(t('overview', 'overview.detailIdea'), contract.idea_id)
  if (data !== undefined) {
    modal.appendChild(el('div', 'section-label', t('overview', 'overview.contractData')))
    if (typeof data.dataset_id === 'string') row(t('overview', 'overview.detailDataset'), data.dataset_id)
    if (typeof data.split === 'string') row(t('overview', 'overview.detailSplit'), data.split)
    if (typeof data.version === 'string') row(t('overview', 'overview.detailVersion'), data.version)
  }
  if (methods !== undefined) {
    modal.appendChild(el('div', 'section-label', t('overview', 'overview.contractMethods')))
    row(t('overview', 'overview.detailBaseline'), String(methods.baseline ?? '—'))
    row(t('overview', 'overview.detailTreatment'), String(methods.treatment ?? '—'))
  }
  if (metrics !== undefined) {
    modal.appendChild(el('div', 'section-label', t('overview', 'overview.contractMetrics')))
    row(t('overview', 'overview.detailPrimary'), String(metrics.primary ?? '—'))
    const secondary = Array.isArray(metrics.secondary) ? (metrics.secondary as string[]).join(', ') : '—'
    row(t('overview', 'overview.detailSecondary'), secondary)
  }
  const seeds = Array.isArray(contract.seeds) ? (contract.seeds as number[]).join(', ') : '—'
  modal.appendChild(el('div', 'section-label', t('overview', 'overview.contractAnalysis')))
  row(t('overview', 'overview.detailSeeds'), seeds)
  if (analysis !== undefined) {
    row('Effect', String(analysis.effect_size ?? '—'))
    row('Interval', String(analysis.interval ?? '—'))
    row('Correction', String(analysis.multiple_testing ?? '—'))
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the drawer in the new locale.
  registerOverlayRebuild(overlay, () => { overlay.remove(); openContractDetailModal(root, contract) })
  trapFocus(overlay, null)
}


/* ─────────────────────────── idea detail modal ─────────────────────────── */

/** dsh-web idea drawer: full record of an IdeaCard. */
export function openIdeaDetailModal(root: ShadowRoot, idea: Record<string, unknown>): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:540px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', t('overview', 'overview.ideaDetails'))
  const header = el('div', 'modal-header', t('overview', 'overview.ideaDetailsModal'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

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
  titleRow.appendChild(el('span', 'pname', String(idea.title ?? t('overview', 'overview.untitled'))))
  titleRow.appendChild(el('span', 'grow'))
  titleRow.appendChild(pill(String(idea.status ?? '')))
  modal.appendChild(titleRow)

  const mve = idea.minimum_viable_experiment as Record<string, unknown> | undefined
  const fals = idea.falsification as Record<string, unknown> | undefined
  const scores = idea.scores as Record<string, unknown> | undefined
  modal.appendChild(el('div', 'section-label', t('overview', 'overview.ideaSection')))
  row('Idea', String(idea.idea_id ?? '—'))
  row('Status', String(idea.status ?? '—'))
  if (typeof idea.hypothesis === 'string') row('Hypothesis', idea.hypothesis)
  if (typeof idea.exact_delta === 'string') row('Delta', idea.exact_delta)
  if (fals !== undefined) row('Falsification', String(fals.observation ?? '—'))
  if (mve !== undefined) {
    modal.appendChild(el('div', 'section-label', t('overview', 'overview.ideaMve')))
    row('Dataset', String(mve.dataset ?? '—'))
    row('Baseline', String(mve.baseline ?? '—'))
    row('Metric', String(mve.primary_metric ?? '—'))
    if (typeof mve.estimated_gpu_hours === 'number') row('GPU hours', String(mve.estimated_gpu_hours))
  }
  if (scores !== undefined) {
    modal.appendChild(el('div', 'section-label', t('overview', 'overview.ideaScores')))
    row('Feasibility', String(scores.feasibility ?? '—'))
    row('Information', String(scores.information_gain ?? '—'))
    row('Reproducibility', String(scores.reproducibility ?? '—'))
    row('Cost', String(scores.cost ?? '—'))
  }
  const novelty = idea.novelty_audit as Record<string, unknown> | undefined
  if (novelty !== undefined) {
    modal.appendChild(el('div', 'section-label', t('overview', 'overview.ideaNovelty')))
    row('Result', String(novelty.result ?? '—'))
    if (typeof novelty.unresolved_risk === 'string') row('Risk', novelty.unresolved_risk)
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the drawer in the new locale.
  registerOverlayRebuild(overlay, () => { overlay.remove(); openIdeaDetailModal(root, idea) })
  trapFocus(overlay, null)
}

