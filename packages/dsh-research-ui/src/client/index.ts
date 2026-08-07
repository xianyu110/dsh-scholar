/**
 * DSH Research OS — standalone GUI panel (browser half). Tabbed panels:
 * Phase, Gates (with approve/reject interactions), Runs, Artifacts, Evidence,
 * Budget. Polls the same-origin `/research-ui-api` bridge; every decision
 * goes through the Kernel's CAS-protected decideGate.
 * @module @dsh-scholar/research-ui/client
 */

const API = '/research-ui-api'

interface Projection {
  project?: {
    project_id?: string; name?: string; status?: string; revision?: number
    constraints?: { max_model_cost_usd?: number; max_gpu_hours?: number; max_parallel_jobs?: number }
    history?: string[]
  }
  pending_gates?: Array<{ gate_id?: string; type?: string; title?: string; summary?: string; status?: string }>
  jobs?: Array<{ job_id?: string; kind?: string; status?: string; error?: string; contract_id?: string | null }>
  budget?: { model_cost_usd?: number; gpu_hours?: number; api_requests?: number }
  counts?: { ideas?: number; contracts?: number; claims?: number; evidence?: number; artifacts?: number; corpus_snapshots?: number }
  next_actions?: string[]
}

interface ClaimRow { claim_id?: string; statement?: string; status?: string; confidence?: string }
interface EvidenceRow { evidence_id?: string; analysis_method?: string; result?: { primary_metric?: string; value?: number; effect_size?: number; ci_low?: number; ci_high?: number; n_seeds?: number } }
interface ArtifactRow { artifact_id?: string; kind?: string; size_bytes?: number }
interface GateRow { gate_id?: string; type?: string; title?: string; status?: string }
interface ProjectRow { project_id?: string; name?: string; status?: string }

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

async function api<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(`${API}${path}`, {
      headers: { accept: 'application/json', ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...init,
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

let activeTab = 'phase'
let projectId: string | undefined

export function apply(): void {
  const host = document.createElement('div')
  host.id = 'dsh-scholar-ui'
  host.style.cssText = 'position:fixed;right:12px;bottom:64px;width:400px;max-height:70vh;overflow:auto;z-index:9999;background:#171c26;color:#e6e9ef;border:1px solid #333d52;border-radius:12px;padding:0;font:12px/1.5 system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5);display:flex;flex-direction:column'
  document.body.appendChild(host)

  const header = el('div', 'ui-header')
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #2a3348;font-weight:700;font-size:13px'
  header.appendChild(el('span', 'ui-title', '🧪 Research OS'))
  const headerRight = el('div', 'ui-header-right')
  headerRight.style.cssText = 'display:flex;gap:8px;align-items:center'
  const refresh = el('button', 'ui-btn', '⟳')
  refresh.title = 'refresh now'
  refresh.style.cssText = 'border:1px solid #3a4356;background:#232b3d;color:#cbd2e0;border-radius:6px;padding:2px 8px;cursor:pointer'
  const close = el('button', 'ui-btn', '×')
  close.style.cssText = 'border:0;background:none;color:#8b93a7;font-size:15px;cursor:pointer'
  close.onclick = () => { host.style.display = 'none' }
  headerRight.append(refresh, close)
  header.appendChild(headerRight)
  host.appendChild(header)

  const tabs = el('div', 'ui-tabs')
  tabs.style.cssText = 'display:flex;gap:2px;padding:6px 10px 0;border-bottom:1px solid #2a3348'
  const TAB_DEFS = [
    ['phase', 'Phase'], ['gates', 'Gates'], ['runs', 'Runs'],
    ['artifacts', 'Artifacts'], ['evidence', 'Evidence'], ['budget', 'Budget'],
  ] as const
  const tabButtons = new Map<string, HTMLElement>()
  for (const [key, label] of TAB_DEFS) {
    const button = el('button', 'ui-tab', label)
    button.style.cssText = 'border:0;background:none;color:#8b93a7;padding:6px 10px;cursor:pointer;border-radius:6px 6px 0 0;font-size:12px'
    button.onclick = () => { activeTab = key; void render() }
    tabButtons.set(key, button)
    tabs.appendChild(button)
  }
  host.appendChild(tabs)

  const body = el('div', 'ui-body')
  body.style.cssText = 'padding:12px 14px;overflow:auto'
  host.appendChild(body)

  const picker = el('select', 'ui-picker')
  picker.style.cssText = 'width:100%;margin-bottom:10px;background:#232b3d;color:#e6e9ef;border:1px solid #3a4356;border-radius:6px;padding:4px 8px'
  picker.onchange = () => { projectId = picker.value || undefined; void render() }

  const styleTab = (): void => {
    for (const [key, button] of tabButtons) {
      button.style.cssText = `border:0;background:none;cursor:pointer;border-radius:6px 6px 0 0;font-size:12px;padding:6px 10px;${key === activeTab ? 'color:#fff;background:#2b6cb0;font-weight:600' : 'color:#8b93a7'}`
    }
  }

  const render = async (): Promise<void> => {
    styleTab()
    // Project picker: session-linked first, then all projects.
    const projects = (await api<ProjectRow[]>('/v1/projects')) ?? []
    const current = picker.options.length === 0
    if (current || projectId === undefined) {
      picker.replaceChildren()
      const placeholder = el('option', '', projectId === undefined ? '— select project —' : '— session-linked —')
      placeholder.value = ''
      picker.appendChild(placeholder)
      for (const p of projects) {
        const option = el('option', '', `${p.name ?? p.project_id} (${p.status ?? ''})`)
        option.value = p.project_id ?? ''
        picker.appendChild(option)
      }
      picker.value = projectId ?? ''
    }
    const target = projectId ?? projects[0]?.project_id
    if (target === undefined) {
      body.replaceChildren(el('div', 'ui-empty', 'No research projects yet — run /research new <name> in the session.'))
      return
    }
    const projection = await api<Projection>(`/v1/projects/${encodeURIComponent(target)}/projection`)
    if (projection === null || projection.project === undefined) {
      body.replaceChildren(el('div', 'ui-empty', `Research kernel unreachable (project ${target}).`))
      return
    }
    projectId = projection.project.project_id
    if (current) picker.value = projectId
    body.replaceChildren()
    const title = el('div', 'ui-project', `📁 ${projection.project.name} · ${projectId} · rev ${projection.project.revision ?? 0}`)
    title.style.cssText = 'font-weight:600;margin-bottom:8px'
    body.appendChild(title)
    switch (activeTab) {
      case 'phase': renderPhase(body, projection); break
      case 'gates': await renderGates(body, target); break
      case 'runs': renderRuns(body, projection); break
      case 'artifacts': await renderArtifacts(body, target); break
      case 'evidence': await renderEvidence(body, target); break
      case 'budget': renderBudget(body, projection); break
    }
    const stamp = el('div', 'ui-stamp', `updated ${new Date().toLocaleTimeString()}`)
    stamp.style.cssText = 'margin-top:10px;color:#6b7488;font-size:10px;text-align:right'
    body.appendChild(stamp)
  }

  refresh.onclick = () => { void render() }
  void render()
  const timer = window.setInterval(() => { void render() }, 8000)
  window.addEventListener('beforeunload', () => window.clearInterval(timer), { once: true })
}

function renderPhase(body: HTMLElement, p: Projection): void {
  const badge = el('div', 'ui-phase', `Phase: ${p.project?.status ?? '?'}`)
  badge.style.cssText = 'display:inline-block;background:#2b6cb0;color:#fff;border-radius:6px;padding:3px 10px;font-weight:700;margin-bottom:8px'
  body.appendChild(badge)
  const next = el('div', 'ui-next')
  next.appendChild(el('div', 'ui-label', '➡️ Next actions'))
  for (const action of p.next_actions ?? []) next.appendChild(el('div', 'ui-item', `· ${action}`))
  body.appendChild(next)
  const history = el('div', 'ui-history')
  history.appendChild(el('div', 'ui-label', '📜 History'))
  for (const h of (p.project?.history ?? []).slice(-8)) history.appendChild(el('div', 'ui-item', `· ${h}`))
  body.appendChild(history)
}

async function renderGates(body: HTMLElement, projectId: string): Promise<void> {
  const gates = (await api<GateRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/gates`)) ?? []
  body.appendChild(el('div', 'ui-label', `⏳ Gates (${gates.length})`))
  for (const gate of gates) {
    const row = el('div', 'ui-gate')
    row.style.cssText = 'border:1px solid #2a3348;border-radius:8px;padding:8px 10px;margin:6px 0'
    row.appendChild(el('div', 'ui-gate-title', `${gate.type ?? ''} — ${gate.title ?? ''} [${gate.status ?? ''}]`))
    const actions = el('div', 'ui-gate-actions')
    actions.style.cssText = 'display:flex;gap:6px;margin-top:6px'
    if (gate.status === 'pending') {
      const approve = el('button', 'ui-btn', '✓ Approve')
      approve.style.cssText = 'border:0;background:#2f9e44;color:#fff;border-radius:6px;padding:3px 10px;cursor:pointer'
      approve.onclick = async () => {
        await api(`/v1/gates/${encodeURIComponent(gate.gate_id ?? '')}/decisions`, { method: 'POST', body: JSON.stringify({ actor: 'web-user', decision: 'approved', reason: 'approved from Research OS panel' }) })
        void render()
      }
      const reject = el('button', 'ui-btn', '✕ Reject')
      reject.style.cssText = 'border:0;background:#e03131;color:#fff;border-radius:6px;padding:3px 10px;cursor:pointer'
      reject.onclick = async () => {
        await api(`/v1/gates/${encodeURIComponent(gate.gate_id ?? '')}/decisions`, { method: 'POST', body: JSON.stringify({ actor: 'web-user', decision: 'rejected', reason: 'rejected from Research OS panel' }) })
        void render()
      }
      actions.append(approve, reject)
    }
    row.appendChild(actions)
    body.appendChild(row)
  }
  if (gates.length === 0) body.appendChild(el('div', 'ui-item', 'none'))
}

function renderRuns(body: HTMLElement, p: Projection): void {
  body.appendChild(el('div', 'ui-label', `⚙️ Runs (${(p.jobs ?? []).length})`))
  const cancellable = new Set(['queued', 'running', 'retryable'])
  for (const job of (p.jobs ?? []).slice(-10).reverse()) {
    const row = el('div', 'ui-job')
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px dashed #232b3d;gap:8px'
    const text = el('span', 'ui-job-text', `${job.job_id ?? ''} [${job.kind ?? ''}] ${job.status ?? ''}${job.error ? ` — ${job.error.slice(0, 40)}` : ''}`)
    row.appendChild(text)
    if (job.job_id !== undefined && cancellable.has(job.status ?? '')) {
      const cancel = el('button', 'ui-btn', '✕')
      cancel.title = `cancel ${job.job_id}`
      cancel.style.cssText = 'border:1px solid #5c1f1f;background:#3a1f1f;color:#ffb3b3;border-radius:6px;padding:1px 8px;cursor:pointer;font-size:11px'
      cancel.onclick = async () => {
        await api(`/v1/jobs/${encodeURIComponent(job.job_id ?? '')}/cancel`, { method: 'POST', body: JSON.stringify({ actor: 'web-user', reason: 'cancelled from Research OS panel' }) })
        void render()
      }
      row.appendChild(cancel)
    }
    body.appendChild(row)
  }
  if ((p.jobs ?? []).length === 0) body.appendChild(el('div', 'ui-item', 'none'))
}

async function renderArtifacts(body: HTMLElement, projectId: string): Promise<void> {
  const artifacts = (await api<ArtifactRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`)) ?? []
  body.appendChild(el('div', 'ui-label', `📦 Artifacts (${artifacts.length}, click to preview)`))
  for (const artifact of artifacts.slice(-15).reverse()) {
    const row = el('div', 'ui-artifact', `${artifact.kind ?? ''} · ${(artifact.artifact_id ?? '').slice(0, 18)}… · ${artifact.size_bytes ?? 0} B`)
    row.style.cssText = 'padding:3px 0;border-bottom:1px dashed #232b3d;font-family:monospace;font-size:11px;cursor:pointer'
    row.title = 'click to preview'
    row.onclick = () => { void previewArtifact(artifact.artifact_id ?? '') }
    body.appendChild(row)
  }
  if (artifacts.length === 0) body.appendChild(el('div', 'ui-item', 'none'))
}

/** Fetch an artifact blob through the bridge and show it in a modal. */
async function previewArtifact(artifactId: string): Promise<void> {
  try {
    const response = await fetch(`${API}/v1/artifacts/${encodeURIComponent(artifactId)}`, { headers: { accept: 'application/octet-stream' } })
    if (!response.ok) return
    const text = await response.text()
    const overlay = el('div', 'ui-overlay')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:40px'
    overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
    const modal = el('div', 'ui-modal')
    modal.style.cssText = 'background:#1a2130;border:1px solid #3a4356;border-radius:10px;max-width:720px;max-height:70vh;overflow:auto;padding:14px 16px;color:#e6e9ef;font:12px/1.5 system-ui,sans-serif'
    const header = el('div', 'ui-modal-header', `📦 ${artifactId.slice(0, 24)}…`)
    header.style.cssText = 'font-weight:700;margin-bottom:10px;display:flex;justify-content:space-between'
    const closeBtn = el('button', 'ui-btn', '×')
    closeBtn.style.cssText = 'border:0;background:none;color:#8b93a7;font-size:15px;cursor:pointer'
    closeBtn.onclick = () => overlay.remove()
    header.appendChild(closeBtn)
    modal.appendChild(header)
    const trimmed = text.trim()
    if (trimmed.startsWith('<svg')) {
      const container = el('div', 'ui-svg')
      container.innerHTML = trimmed
      modal.appendChild(container)
    } else {
      const pre = el('pre', 'ui-pre', text.length > 6000 ? text.slice(0, 6000) + String.fromCharCode(10) + '… (truncated)' : text)
      pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;font-family:monospace;font-size:11px;margin:0'
      modal.appendChild(pre)
    }
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
  } catch { /* bridge unreachable */ }
}

async function renderEvidence(body: HTMLElement, projectId: string): Promise<void> {
  const claims = (await api<ClaimRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/claims`)) ?? []
  const evidence = (await api<EvidenceRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/evidence`)) ?? []
  body.appendChild(el('div', 'ui-label', `🗂️ Claims (${claims.length})`))
  for (const claim of claims.slice(-8).reverse()) {
    const row = el('div', 'ui-claim', `[${claim.status ?? ''}/${claim.confidence ?? ''}] ${(claim.statement ?? '').slice(0, 80)}`)
    row.style.cssText = 'padding:4px 0;border-bottom:1px dashed #232b3d'
    body.appendChild(row)
  }
  body.appendChild(el('div', 'ui-label', `📊 Evidence (${evidence.length})`))
  for (const item of evidence.slice(-8).reverse()) {
    const r = item.result
    const row = el('div', 'ui-evidence', `${item.evidence_id ?? ''}: ${r?.primary_metric ?? '?'} = ${r?.value ?? '?'} (Δ${r?.effect_size ?? '?'}, CI [${r?.ci_low ?? '?'}, ${r?.ci_high ?? '?'}], n=${r?.n_seeds ?? '?'}) via ${item.analysis_method ?? '?'}`)
    row.style.cssText = 'padding:3px 0;border-bottom:1px dashed #232b3d;font-size:11px'
    body.appendChild(row)
  }
}

function renderBudget(body: HTMLElement, p: Projection): void {
  const c = p.project?.constraints
  const b = p.budget
  body.appendChild(el('div', 'ui-label', '💰 Budget'))
  body.appendChild(el('div', 'ui-item', `Model cost: $${b?.model_cost_usd ?? 0} / $${c?.max_model_cost_usd ?? '∞'} max`))
  body.appendChild(el('div', 'ui-item', `GPU hours: ${b?.gpu_hours ?? 0} / ${c?.max_gpu_hours ?? '∞'} max`))
  body.appendChild(el('div', 'ui-item', `API requests: ${b?.api_requests ?? 0}`))
  const counts = p.counts
  body.appendChild(el('div', 'ui-item', `📊 ideas ${counts?.ideas ?? 0} · contracts ${counts?.contracts ?? 0} · snapshots ${counts?.corpus_snapshots ?? 0}`))
  const over = (b?.model_cost_usd ?? 0) > (c?.max_model_cost_usd ?? Infinity) || (b?.gpu_hours ?? 0) > (c?.max_gpu_hours ?? Infinity)
  if (over) {
    const warn = el('div', 'ui-warn', '⚠️ Budget limit exceeded — project is BLOCKED_GATE until a human Budget Gate approves.')
    warn.style.cssText = 'background:#5c1f1f;color:#ffb3b3;border-radius:6px;padding:6px 10px;margin-top:8px'
    body.appendChild(warn)
  }
}
