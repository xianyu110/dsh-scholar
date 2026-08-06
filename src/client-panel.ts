/**
 * Research OS panel — browser half (E7). A floating status panel rendered
 * with plain DOM (no framework): shows the session-linked research project's
 * phase, pending gates, budget, runs, artifacts, evidence and next actions,
 * polling the same-origin `/research-api` bridge every 8s.
 *
 * Loaded by the client-modules host from this package's `exports["./client"]`;
 * `apply(ctx)` is the browser plugin entry.
 * @module @dsh-scholar/research-plugin/client-panel
 */

interface Projection {
  project?: { project_id?: string; name?: string; status?: string; revision?: number }
  pending_gates?: Array<{ gate_id?: string; type?: string; title?: string; status?: string }>
  jobs?: Array<{ job_id?: string; kind?: string; status?: string }>
  budget?: { model_cost_usd?: number; gpu_hours?: number; api_requests?: number }
  counts?: { ideas?: number; contracts?: number; claims?: number; evidence?: number; artifacts?: number; corpus_snapshots?: number }
  next_actions?: string[]
}

interface SessionLinkResult {
  project_id?: string
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

async function api<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`/research-api${path}`, { headers: { accept: 'application/json' } })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

export function apply(): void {
  const host = document.createElement('div')
  host.id = 'dsh-scholar-panel'
  host.style.cssText = 'position:fixed;right:12px;bottom:64px;width:320px;max-height:60vh;overflow:auto;z-index:9999;background:#1e2430;color:#e6e9ef;border:1px solid #3a4356;border-radius:10px;padding:12px 14px;font:12px/1.5 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.4)'
  document.body.appendChild(host)

  const header = el('div', 'rs-header', '🧪 DSH Research OS')
  header.style.cssText = 'font-weight:700;font-size:13px;margin-bottom:8px;display:flex;justify-content:space-between'
  const close = el('button', 'rs-close', '×')
  close.style.cssText = 'border:0;background:none;color:#8b93a7;font-size:15px;cursor:pointer'
  close.onclick = () => { host.style.display = 'none' }
  header.appendChild(close)
  host.appendChild(header)

  const body = el('div', 'rs-body')
  host.appendChild(body)

  const render = async (): Promise<void> => {
    // Resolve the session-linked project; fall back to the first project.
    let link: SessionLinkResult | null = null
    try {
      const sessId = (window as unknown as { __DSH_BOOT__?: { sessionId?: string } }).__DSH_BOOT__?.sessionId
      if (sessId !== undefined) link = await api<SessionLinkResult>(`/v1/session-links/${encodeURIComponent(sessId)}`)
    } catch { /* no session yet */ }
    let projectId = link?.project_id
    if (projectId === undefined) {
      const projects = await api<Array<{ project_id: string }>>('/v1/projects')
      projectId = projects?.[0]?.project_id
    }
    if (projectId === undefined) {
      body.textContent = 'No research project yet — run /research new <name> in the session.'
      return
    }
    const p = await api<Projection>(`/v1/projects/${encodeURIComponent(projectId)}/projection`)
    if (p === null || p.project === undefined) {
      body.textContent = `Research kernel unreachable (project ${projectId}).`
      return
    }
    body.replaceChildren()
    const title = el('div', 'rs-title', `📁 ${p.project.name} · ${p.project.project_id}`)
    title.style.cssText = 'font-weight:600;margin-bottom:6px'
    body.appendChild(title)
    const phase = el('div', 'rs-phase', `Phase: ${p.project.status ?? '?'} (rev ${p.project.revision ?? 0})`)
    phase.style.cssText = 'display:inline-block;background:#2b6cb0;color:#fff;border-radius:5px;padding:2px 8px;margin-bottom:8px;font-weight:600'
    body.appendChild(phase)

    const gates = el('div', 'rs-gates')
    gates.appendChild(el('div', 'rs-label', '⏳ Pending gates'))
    for (const gate of p.pending_gates ?? []) {
      gates.appendChild(el('div', 'rs-gate', `  · ${gate.type} — ${gate.title ?? ''} (${gate.gate_id ?? ''})`))
    }
    if ((p.pending_gates ?? []).length === 0) gates.appendChild(el('div', 'rs-none', '  none'))
    body.appendChild(gates)

    const jobs = el('div', 'rs-jobs')
    jobs.appendChild(el('div', 'rs-label', '⚙️ Runs'))
    for (const job of (p.jobs ?? []).slice(-6)) {
      jobs.appendChild(el('div', 'rs-job', `  · ${job.job_id ?? ''} [${job.kind ?? ''}] ${job.status ?? ''}`))
    }
    if ((p.jobs ?? []).length === 0) jobs.appendChild(el('div', 'rs-none', '  none'))
    body.appendChild(jobs)

    const budget = el('div', 'rs-budget', `💰 Budget: $${p.budget?.model_cost_usd ?? 0} · ${p.budget?.gpu_hours ?? 0} GPU-h`)
    body.appendChild(budget)

    const counts = el('div', 'rs-counts', `📊 ideas ${p.counts?.ideas ?? 0} · contracts ${p.counts?.contracts ?? 0} · claims ${p.counts?.claims ?? 0} · evidence ${p.counts?.evidence ?? 0} · artifacts ${p.counts?.artifacts ?? 0} · snapshots ${p.counts?.corpus_snapshots ?? 0}`)
    body.appendChild(counts)

    const next = el('div', 'rs-next')
    next.appendChild(el('div', 'rs-label', '➡️ Next actions'))
    for (const action of p.next_actions ?? []) {
      next.appendChild(el('div', 'rs-action', `  · ${action}`))
    }
    body.appendChild(next)
    const stamp = el('div', 'rs-stamp', `updated ${new Date().toLocaleTimeString()}`)
    stamp.style.cssText = 'margin-top:8px;color:#8b93a7;font-size:10px'
    body.appendChild(stamp)
  }

  void render()
  const timer = window.setInterval(() => { void render() }, 8000)
  window.addEventListener('beforeunload', () => window.clearInterval(timer), { once: true })
}
