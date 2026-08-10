import type { Projection } from '../types'
import { api } from '../api'
import { registerOverlayRebuild, t } from '../i18n/index'
import { state, tabSave } from '../state'
import { copyText, el, pill, trapFocus } from '../ui'
/* ─────────────────────────── standalone project creator ─────────────────────────── */

/**
 * Standalone web plugin: modal form that creates a project + Scope Gate via
 * the same kernel API the /research new command uses. Rendered with
 * textContent-only inputs (no HTML sinks, design §15.4).
 */
export function openNewProjectModal(root: ShadowRoot | null | undefined): void {
  if (root == null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'

  const header = el('div', 'modal-header', t('budget', 'budget.modal.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const field = (label: string, placeholder: string, value = ''): HTMLInputElement => {
    const lab = el('label', 'section-label', label)
    lab.style.cssText = 'display:block;margin:10px 0 4px'
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = placeholder
    input.value = value
    input.style.cssText = 'width:100%;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 10px;font:12px/1.4 system-ui,sans-serif;outline:none'
    input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
    input.onblur = () => { input.style.borderColor = 'var(--border)' }
    modal.appendChild(lab)
    modal.appendChild(input)
    return input
  }

  const nameInput = field(t('budget', 'budget.modal.fieldName'), t('budget', 'budget.modal.placeholderName'))
  const problemInput = field(t('budget', 'budget.modal.fieldProblem'), t('budget', 'budget.modal.placeholderProblem'))
  const metricInput = field(t('budget', 'budget.modal.fieldMetric'), t('budget', 'budget.modal.placeholderMetric'))

  const err = el('div', 'error-banner')
  err.style.cssText = 'display:none;margin-top:10px'
  modal.appendChild(err)

  const actions = el('div', 'row')
  actions.style.cssText = 'justify-content:flex-end;gap:8px;margin-top:14px'
  const cancel = el('button', 'hbtn', t('budget', 'budget.modal.cancel'))
  cancel.onclick = () => overlay.remove()
  const create = el('button', 'btn approve', t('budget', 'budget.modal.create'))
  create.style.cssText = 'padding:7px 18px'
  create.onclick = async () => {
    const name = nameInput.value.trim()
    if (name === '') {
      err.textContent = t('common', 'common.projectNameRequired')
      err.style.display = 'block'
      return
    }
    err.style.display = 'none'
    create.disabled = true
    create.textContent = t('common', 'common.action.creating')
    const project = await api<{ project_id?: string; status?: string }>('/v1/projects', {
      method: 'POST',
      body: JSON.stringify({
        name,
        workspace: `/research/${name}`,
        brief: {
          problem: problemInput.value.trim() || 'To be specified in the Scope Gate.',
          scope: 'To be specified in the Scope Gate.',
          questions: [],
          primary_metrics: metricInput.value.trim() !== '' ? [metricInput.value.trim()] : [],
          resources: '',
          risks: [],
          target_outputs: ['conference-paper'],
          target_venue: null,
          baseline_repo: null,
          domain: 'machine-learning',
        },
        mode: 'gate-only',
      }),
    })
    if (project === null || project.project_id === undefined) {
      err.textContent = t('common', 'common.createFailed')
      err.style.display = 'block'
      create.disabled = false
      create.textContent = t('budget', 'budget.modal.create')
      return
    }
    // Scope Gate, exactly like /research new.
    await api(`/v1/projects/${encodeURIComponent(project.project_id)}/gates`, {
      method: 'POST',
      body: JSON.stringify({ type: 'scope', title: `Scope Gate — ${name}`, summary: 'Approve the research scope, data policy, budget and target venue.' }),
    })
    state.projectId = project.project_id
    overlay.remove()
    state.rerender()
  }
  actions.append(cancel, create)
  modal.appendChild(actions)

  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the form in the new locale.
  registerOverlayRebuild(overlay, () => { overlay.remove(); openNewProjectModal(root) })
  trapFocus(overlay, nameInput)
  nameInput.focus()
}


/* ─────────────────────────── rename modal ─────────────────────────── */

/**
 * dsh-web "session actions" rename: PATCH /v1/projects/:id {name}, audited
 * in the kernel history ledger.
 */
export function openRenameModal(root: ShadowRoot, projectId: string, currentName: string, onDone: () => void): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:440px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', t('shell', 'shell.renameProject.title'))
  const header = el('div', 'modal-header', t('shell', 'shell.renameProject.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const hint = el('div', 'muted', t('shell', 'shell.renameProject.hint', { name: currentName }))
  hint.style.cssText = 'margin-bottom:10px;font-size:11.5px'
  modal.appendChild(hint)

  const input = document.createElement('input')
  input.type = 'text'
  input.value = currentName
  input.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 11px;font:12px/1.4 system-ui,sans-serif;outline:none'
  input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
  input.onblur = () => { input.style.borderColor = 'var(--border)' }
  modal.appendChild(input)

  const err = el('div', 'error-banner')
  err.style.cssText = 'display:none;margin-top:10px'
  modal.appendChild(err)

  const actions = el('div', 'row')
  actions.style.cssText = 'justify-content:flex-end;gap:8px;margin-top:14px'
  const cancel = el('button', 'hbtn', t('budget', 'budget.modal.cancel'))
  cancel.onclick = () => overlay.remove()
  const save = el('button', 'btn approve', t('common', 'common.action.rename'))
  save.style.cssText = 'padding:7px 18px'
  save.onclick = async () => {
    const name = input.value.trim()
    if (name === '') {
      err.textContent = t('common', 'common.nameRequired')
      err.style.display = 'block'
      return
    }
    err.style.display = 'none'
    save.disabled = true
    save.textContent = t('common', 'common.action.saving')
    const result = await api<{ project_id?: string; name?: string }>(`/v1/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
    if (result === null || result.project_id === undefined) {
      err.textContent = t('common', 'common.renameFailed')
      err.style.display = 'block'
      save.disabled = false
      save.textContent = t('common', 'common.action.rename')
      return
    }
    overlay.remove()
    onDone()
  }
  actions.append(cancel, save)
  modal.appendChild(actions)

  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the rename dialog (the typed
  // name is preserved via the currentName argument captured below).
  registerOverlayRebuild(overlay, () => { overlay.remove(); openRenameModal(root, projectId, currentName, onDone) })
  input.focus()
  input.select()
}


/* ─────────────────────────── project detail modal ─────────────────────────── */

/**
 * dsh-web project drawer: full detail of one project (brief, constraints,
 * counts, pending gates, recent jobs, audit history).
 */
export async function openProjectDetailModal(root: ShadowRoot, projectId: string): Promise<void> {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:600px;max-width:94vw'
  const header = el('div', 'modal-header', t('shell', 'shell.projectDetails.title'))
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const loading = el('div', 'muted', t('common', 'common.status.loading'))
  modal.appendChild(loading)
  overlay.appendChild(modal)
  root.appendChild(overlay)
  // dsh-web i18n §13.4: locale switch re-opens the drawer in the new locale.
  registerOverlayRebuild(overlay, () => { overlay.remove(); void openProjectDetailModal(root, projectId) })

  const p = await api<Projection>(`/v1/projects/${encodeURIComponent(projectId)}/projection`)
  if (p === null || p.project === undefined) {
    loading.textContent = t('shell', 'shell.projectDetails.unavailable')
    return
  }
  modal.removeChild(loading)
  const proj = p.project as import('@dsh-scholar/research-schemas').ResearchProject
  const row = (label: string, value: string): void => {
    const r = el('div', 'row')
    r.style.cssText = 'padding:4px 0;align-items:flex-start'
    const l = el('span', '', label)
    l.style.cssText = 'width:120px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
    const v = el('span', '', value)
    v.style.cssText = 'font-size:11.5px;color:var(--text);word-break:break-word'
    r.append(l, v)
    modal.appendChild(r)
  }

  const titleRow = el('div', 'row')
  titleRow.style.cssText = 'align-items:center;gap:8px;margin-bottom:8px'
  titleRow.appendChild(el('span', 'pname', proj.name ?? projectId))
  titleRow.appendChild(pill(proj.status ?? ''))
  titleRow.appendChild(el('span', 'grow'))
  // dsh-web affordance: copy the project id straight from the drawer.
  const copyId = el('button', 'hbtn', '⧉')
  copyId.title = t('common', 'common.copyProjectId')
  copyId.style.cssText = 'padding:1px 8px'
  copyId.onclick = () => copyText(projectId)
  titleRow.appendChild(copyId)
  modal.appendChild(titleRow)

  modal.appendChild(el('div', 'section-label', t('shell', 'shell.projectDetails.overview')))
  row(t('shell', 'shell.projectDetails.rowProject'), `\`${projectId}\` · rev ${proj.revision ?? 0}`)
  row(t('shell', 'shell.projectDetails.rowProblem'), proj.brief?.problem ?? '—')
  row(t('shell', 'shell.projectDetails.rowMetrics'), (proj.brief?.primary_metrics ?? []).join(', ') || '—')
  row(t('shell', 'shell.projectDetails.rowWorkspace'), proj.workspace ?? '—')

  const c = proj.constraints
  modal.appendChild(el('div', 'section-label', t('evidence', 'evidence.budget.constraints')))
  row(t('shell', 'shell.projectDetails.rowBudget'), `$${c?.max_model_cost_usd ?? '∞'} max`)
  row(t('budget', 'budget.gpuHours'), `${c?.max_gpu_hours ?? '∞'} max`)
  row(t('budget', 'budget.parallelJobs'), String(c?.max_parallel_jobs ?? '—'))

  const counts = p.counts
  if (counts !== undefined) {
    modal.appendChild(el('div', 'section-label', t('budget', 'budget.projectContents')))
    row(t('shell', 'shell.projectDetails.rowCorpus'), String(counts.corpus_snapshots ?? 0))
    row(t('shell', 'shell.projectDetails.rowIdeasContracts'), `${counts.ideas ?? 0} / ${counts.contracts ?? 0}`)
    row(t('shell', 'shell.projectDetails.rowClaimsEvidence'), `${counts.claims ?? 0} / ${counts.evidence ?? 0}`)
    row(t('shell', 'shell.projectDetails.rowArtifacts'), String(counts.artifacts ?? 0))
  }

  const pending = p.pending_gates ?? []
  modal.appendChild(el('div', 'section-label', t('shell', 'shell.projectDetails.pendingGates')))
  if (pending.length === 0) {
    modal.appendChild(el('div', 'empty', t('common', 'common.none')))
  }
  for (const g of pending) {
    modal.appendChild(el('div', '', t('shell', 'shell.projectDetails.gateLine', { type: String(g.type ?? '?'), id: String(g.gate_id ?? ''), title: String(g.title ?? ''), status: String(g.status ?? '') })))
  }
  if (pending.length > 0) {
    // dsh-web depth: jump from the drawer to the Gates tab.
    const goGates = el('button', 'hbtn', t('shell', 'shell.openApprovals'))
    goGates.style.cssText = 'margin-top:8px'
    goGates.onclick = () => {
      overlay.remove()
      state.activeTab = 'gates'
      tabSave()
      state.rerender()
    }
    modal.appendChild(goGates)
  }

  const jobs = (p.jobs ?? []).slice(-5)
  modal.appendChild(el('div', 'section-label', t('shell', 'shell.projectDetails.recentJobs')))
  if (jobs.length === 0) {
    modal.appendChild(el('div', 'empty', t('common', 'common.none')))
  }
  for (const j of jobs) {
    const jrow = el('div', '', `- \`${j.job_id}\` [${j.kind}] ${j.status}`)
    // dsh-web depth: jump to the Runs tab from a recent job.
    jrow.style.cssText = 'cursor:pointer'
    jrow.title = t('runs', 'runs.openRunsTab')
    jrow.onclick = () => {
      overlay.remove()
      state.activeTab = 'runs'
      tabSave()
      state.rerender()
    }
    modal.appendChild(jrow)
  }

  // dsh-web guidance: next actions of the kernel for this project.
  const nextActions = (p.next_actions ?? []).filter(Boolean)
  if (nextActions.length > 0) {
    modal.appendChild(el('div', 'section-label', t('overview', 'overview.nextActions')))
    for (const a of nextActions) {
      modal.appendChild(el('div', '', `➡️ ${a}`))
    }
  }

  const history = (proj.history ?? []).slice(-6)
  modal.appendChild(el('div', 'section-label', t('overview', 'overview.auditHistory')))
  for (const h of history) {
    modal.appendChild(el('div', 'muted', `· ${h}`))
  }

  // dsh-web export: full project JSON (projection + gates + jobs + ideas
  // + contracts + evidence + artifacts) as a downloadable file.
  const exportRow = el('div', 'row')
  exportRow.style.cssText = 'justify-content:flex-end;gap:8px;margin-top:16px'
  const exportBtn = el('button', 'btn approve', t('common', 'common.action.exportJson'))
  exportBtn.style.cssText = 'padding:7px 16px'
  exportBtn.onclick = async () => {
    exportBtn.textContent = t('common', 'common.action.exporting')
    const data: Record<string, unknown> = {
      project: p,
      gates: (await api(`/v1/projects/${encodeURIComponent(projectId)}/gates`)) ?? [],
      jobs: (await api(`/v1/projects/${encodeURIComponent(projectId)}/jobs`)) ?? [],
      ideas: (await api(`/v1/projects/${encodeURIComponent(projectId)}/ideas`)) ?? [],
      contracts: (await api(`/v1/projects/${encodeURIComponent(projectId)}/contracts`)) ?? [],
      evidence: (await api(`/v1/projects/${encodeURIComponent(projectId)}/evidence`)) ?? [],
      claims: (await api(`/v1/projects/${encodeURIComponent(projectId)}/claims`)) ?? [],
      artifacts: (await api(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`)) ?? [],
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = el('a', 'dl', t('common', 'common.action.download'))
    a.href = url
    a.download = `${proj.name ?? projectId}.research.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    exportBtn.textContent = t('common', 'common.action.exported')
    setTimeout(() => { exportBtn.textContent = t('common', 'common.action.exportJson') }, 2000)
  }
  exportRow.appendChild(exportBtn)
  // dsh-web share: copy a compact markdown summary of this project.
  const summaryBtn = el('button', 'hbtn', t('common', 'common.action.copySummary'))
  summaryBtn.title = t('common', 'common.action.copySummary.title')
  summaryBtn.onclick = () => {
    const counts = p.counts ?? {}
    const lines = [
      `# ${proj.name ?? projectId}`,
      '',
      `- Project: \`${projectId}\``,
      `- Phase: \`${proj.status}\` (rev ${proj.revision ?? 0})`,
      `- Problem: ${proj.brief?.problem ?? '—'}`,
      `- Budget: $${p.budget?.model_cost_usd ?? 0} / ${proj.constraints?.max_model_cost_usd ?? '∞'} max`,
      `- Contents: ${counts.ideas ?? 0} ideas · ${counts.contracts ?? 0} contracts · ${counts.claims ?? 0} claims · ${counts.evidence ?? 0} evidence · ${counts.artifacts ?? 0} artifacts`,
    ]
    const md = lines.join('\n')
    void navigator.clipboard.writeText(md).then(
      () => { summaryBtn.textContent = t('common', 'common.action.copied') },
      () => { summaryBtn.textContent = t('common', 'common.action.copyFailed') },
    )
    setTimeout(() => { summaryBtn.textContent = t('common', 'common.action.copySummary') }, 1600)
  }
  exportRow.appendChild(summaryBtn)
  modal.appendChild(exportRow)
}

