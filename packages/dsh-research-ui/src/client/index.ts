/**
 * DSH Research OS — standalone GUI panel (browser half). Tabbed panels:
 * Phase (with a visual pipeline), Gates (approve/reject), Runs (cancel),
 * Artifacts (preview), Evidence, Budget. Polls the same-origin
 * `/research-ui-api` bridge; every decision goes through the Kernel's
 * CAS-protected decideGate.
 *
 * Rendering lives inside a Shadow DOM so the host page styles never leak in
 * and the panel's design system stays consistent. All interactive handlers
 * are attached via addEventListener — no HTML-string sinks (design §15.4).
 * @module @dsh-scholar/research-ui/client
 */

const API = '/research-ui-api'

/**
 * Standalone-mode overrides: when running outside the DSH host (the
 * standalone web plugin), the API base is the same-origin `/v1` proxy and
 * the bridge token comes from a local login instead of the DSH boot
 * manifest. Both default to the DSH-hosted values.
 */
let apiBase: string | undefined
let tokenProvider: (() => Promise<string | undefined>) | undefined
let overlayRoot: ShadowRoot | null = null

export function setStandaloneBridge(options: {
  base: string
  token: () => Promise<string | undefined>
  overlay: ShadowRoot
}): void {
  apiBase = options.base
  tokenProvider = options.token
  overlayRoot = options.overlay
}

/**
 * Bridge token bootstrap (design §15.3). Resolution order:
 * 1. `window.__DSH_BOOT__.researchUi.token` if the host injected one, else
 * 2. GET /research-ui-api/session-token (same-origin only; 404 when token
 *    mode is disabled on the host).
 * The token is attached as `Authorization: Bearer <token>` to every request.
 */
let tokenPromise: Promise<string | undefined> | null = null

function bootToken(): string | undefined {
  const boot = (window as unknown as { __DSH_BOOT__?: { researchUi?: { token?: string } } }).__DSH_BOOT__
  return boot?.researchUi?.token
}

async function fetchSessionToken(): Promise<string | undefined> {
  try {
    const response = await fetch(`${API}/session-token`, { headers: { accept: 'application/json' }, cache: 'no-store' })
    if (!response.ok) return undefined
    const data = (await response.json()) as { token?: string }
    return typeof data.token === 'string' && data.token.length > 0 ? data.token : undefined
  } catch {
    return undefined
  }
}

/** Resolve the bridge token once and cache it (invalidated on 401). */
function resolveBridgeToken(): Promise<string | undefined> {
  if (tokenPromise === null) {
    tokenPromise = (async () => bootToken() ?? (await fetchSessionToken()))()
  }
  return tokenPromise
}

async function authHeaders(): Promise<Record<string, string>> {
  if (tokenProvider !== undefined) {
    const token = await tokenProvider()
    return token !== undefined && token !== '' ? { authorization: `Bearer ${token}` } : {}
  }
  const token = await resolveBridgeToken()
  return token !== undefined ? { authorization: `Bearer ${token}` } : {}
}

function base(): string {
  return apiBase ?? API
}

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
interface GateRow { gate_id?: string; type?: string; title?: string; status?: string; summary?: string }
interface ProjectRow { project_id?: string; name?: string; status?: string }

/* ─────────────────────────── design system ─────────────────────────── */

const STATUS_META: Record<string, { label: string; tone: string }> = {
  // project phases
  DRAFT: { label: 'DRAFT', tone: 'slate' },
  SCOPED: { label: 'SCOPED', tone: 'blue' },
  SURVEYING: { label: 'SURVEYING', tone: 'cyan' },
  IDEATING: { label: 'IDEATING', tone: 'violet' },
  IDEA_APPROVED: { label: 'IDEA ✓', tone: 'green' },
  BASELINE_REPRO: { label: 'BASELINE', tone: 'amber' },
  CONTRACT_APPROVED: { label: 'CONTRACT ✓', tone: 'green' },
  EXPERIMENTING: { label: 'EXPERIMENT', tone: 'blue' },
  EVIDENCE_READY: { label: 'EVIDENCE', tone: 'cyan' },
  WRITING: { label: 'WRITING', tone: 'violet' },
  REVIEWING: { label: 'REVIEW', tone: 'amber' },
  RELEASE_READY: { label: 'RELEASE ✓', tone: 'green' },
  RELEASED: { label: 'RELEASED', tone: 'green' },
  BLOCKED_GATE: { label: 'BLOCKED', tone: 'red' },
  ARCHIVED: { label: 'ARCHIVED', tone: 'slate' },
  // gates
  pending: { label: 'PENDING', tone: 'amber' },
  approved: { label: 'APPROVED', tone: 'green' },
  rejected: { label: 'REJECTED', tone: 'red' },
  // jobs
  queued: { label: 'QUEUED', tone: 'slate' },
  running: { label: 'RUNNING', tone: 'blue' },
  succeeded: { label: 'SUCCEEDED', tone: 'green' },
  failed: { label: 'FAILED', tone: 'red' },
  cancelled: { label: 'CANCELLED', tone: 'slate' },
  retryable: { label: 'RETRYABLE', tone: 'amber' },
  // claims
  supported: { label: 'SUPPORTED', tone: 'green' },
  contradicted: { label: 'CONTRADICTED', tone: 'red' },
  inconclusive: { label: 'INCONCLUSIVE', tone: 'amber' },
  unverified: { label: 'UNVERIFIED', tone: 'slate' },
  // generic
  none: { label: '—', tone: 'slate' },
}

const TONE_COLORS: Record<string, string> = {
  slate: '#8b93a7', blue: '#4d9fff', cyan: '#22d3ee', violet: '#a78bfa',
  green: '#34d399', amber: '#fbbf24', red: '#f87171',
}

const PHASE_PIPELINE = [
  ['DRAFT', 'Draft'], ['SCOPED', 'Scoped'], ['SURVEYING', 'Survey'],
  ['IDEATING', 'Ideas'], ['IDEA_APPROVED', 'Idea ✓'], ['BASELINE_REPRO', 'Baseline'],
  ['CONTRACT_APPROVED', 'Contract'], ['EXPERIMENTING', 'Run'], ['EVIDENCE_READY', 'Analyze'],
  ['WRITING', 'Write'], ['REVIEWING', 'Review'], ['RELEASE_READY', 'Package'],
  ['RELEASED', 'Released'],
] as const

function toneOf(status: string | undefined): string {
  return TONE_COLORS[STATUS_META[status ?? '']?.tone ?? 'slate'] ?? TONE_COLORS.slate
}

function fmtBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function fmtId(id: string | undefined, head = 12): string {
  if (id === undefined || id === '') return ''
  return id.length > head + 3 ? `${id.slice(0, head)}…` : id
}

function shortType(type: string | undefined): string {
  if (type === undefined) return '—'
  return type.slice(0, 1).toUpperCase() + type.slice(1)
}

/* ─────────────────────────── DOM helpers ─────────────────────────── */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Status pill: colored dot + label, tone-driven. */
function pill(status: string | undefined): HTMLElement {
  const meta = STATUS_META[status ?? ''] ?? { label: status ?? '', tone: 'slate' as const }
  const color = TONE_COLORS[meta.tone] ?? TONE_COLORS.slate
  const node = el('span', 'pill')
  node.style.cssText = `display:inline-flex;align-items:center;gap:5px;font:600 10px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.4px;color:${color};background:${color}1f;border:1px solid ${color}40;border-radius:99px;padding:1px 8px;white-space:nowrap`
  const dot = el('span')
  dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${color};box-shadow:0 0 5px ${color}80`
  node.appendChild(dot)
  node.appendChild(document.createTextNode(meta.label))
  return node
}

async function api<T>(path: string, init?: RequestInit): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${base()}${path}`, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          accept: 'application/json',
          ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(await authHeaders()),
        },
      })
      if (response.status === 401 && attempt === 0) {
        // Token may have rotated: re-resolve once, then retry.
        tokenPromise = null
        continue
      }
      if (!response.ok) return null
      return (await response.json()) as T
    } catch {
      return null
    }
  }
  return null
}

/* ─────────────────────────── panel state ─────────────────────────── */

let activeTab = 'phase'
let projectId: string | undefined
let lastError: string | undefined

/**
 * Assigned by apply() to the full re-render closure. Module-level panel
 * renderers call this after a decision/cancel so the panel refreshes
 * immediately — the per-apply `render` local is not in their scope.
 */
let rerender: () => void = () => {}

export interface ApplyOptions {
  /** Standalone full-page mode (the independent web plugin): the panel
   * fills the viewport instead of floating over the DSH host page. */
  fullscreen?: boolean
}

export function apply(options: ApplyOptions = {}): void {
  const fullscreen = options.fullscreen === true
  const host = document.createElement('div')
  host.id = 'dsh-scholar-ui'
  host.style.cssText = fullscreen
    ? 'position:fixed;inset:0;z-index:9999;font:14px/1.5 system-ui,sans-serif'
    : 'position:fixed;right:12px;bottom:64px;width:430px;max-height:min(76vh,760px);z-index:9999;font:12px/1.5 system-ui,sans-serif'
  const root = host.attachShadow({ mode: 'open' })

  const style = el('style')
  style.textContent = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; }
.panel { display:flex; flex-direction:column; height:100%; max-height:inherit; background:#0e1320; color:#dbe2ee; border:1px solid #263049; border-radius:${fullscreen ? 0 : 14}px; overflow:hidden; box-shadow:${fullscreen ? 'none' : '0 18px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.02) inset'}; font:12px/1.5 system-ui,sans-serif; }
${fullscreen ? '.panel { font-size:13px; }' : ''}
.header { display:flex; align-items:center; gap:8px; padding:${fullscreen ? '14px 20px' : '11px 14px'}; background:linear-gradient(180deg,#151b2c,#101624); border-bottom:1px solid #232d45; }
.header .logo { font-size:${fullscreen ? 18 : 14}px; filter:drop-shadow(0 0 6px rgba(77,159,255,.5)); }
.header .title { font:700 ${fullscreen ? 15 : 13}px/1 system-ui,sans-serif; color:#eef2fa; letter-spacing:.2px; }
.header .spacer { flex:1; }
.hbtn { border:1px solid #2b3652; background:#182034; color:#aab6cc; border-radius:8px; padding:3px 9px; cursor:pointer; font:600 11px/1.6 system-ui,sans-serif; }
.hbtn:hover { background:#1f2942; color:#eef2fa; border-color:#3a4a70; }
.hbtn:active { transform:translateY(1px); }
.hbtn.ghost { border:0; background:none; color:#76839c; font-size:15px; padding:2px 6px; }
.hbtn.ghost:hover { color:#eef2fa; background:#182034; }
.tabs { display:flex; gap:2px; padding:0 ${fullscreen ? 20 : 10}px; background:#0f1522; border-bottom:1px solid #1f2940; }
.tab { flex:1; border:0; background:none; color:#7c88a3; padding:${fullscreen ? '12px 2px 11px' : '9px 2px 8px'}; cursor:pointer; font:600 ${fullscreen ? 12 : 11}px/1 system-ui,sans-serif; border-bottom:2px solid transparent; letter-spacing:.3px; }
.tab:hover { color:#c9d3e5; }
.tab.active { color:#eef2fa; border-bottom-color:#4d9fff; }
.body { flex:1; overflow-y:auto; padding:${fullscreen ? '18px 22px 14px' : '12px 14px 10px'}; scrollbar-width:thin; scrollbar-color:#2b3652 transparent; }
.body::-webkit-scrollbar { width:8px; }
.body::-webkit-scrollbar-thumb { background:#2b3652; border-radius:4px; }
.picker { width:100%; margin-bottom:11px; background:#151b2c; color:#dbe2ee; border:1px solid #2b3652; border-radius:9px; padding:${fullscreen ? '8px 11px' : '6px 9px'}; font:600 ${fullscreen ? 12 : 11}px/1.4 system-ui,sans-serif; outline:none; }
.picker:focus { border-color:#4d9fff; }
.section-label { font:700 10px/1.4 system-ui,sans-serif; color:#5d6b88; text-transform:uppercase; letter-spacing:1px; margin:14px 0 6px; }
.section-label:first-child { margin-top:0; }
.project-title { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.project-title .pname { font:700 13px/1.3 system-ui,sans-serif; color:#eef2fa; }
.project-title .pid { font:500 10px/1.4 ui-monospace,Menlo,monospace; color:#5d6b88; }
.empty { color:#5d6b88; font-size:11px; padding:10px 2px; font-style:italic; }
.card { background:#121829; border:1px solid #222c45; border-radius:10px; padding:10px 12px; margin:6px 0; }
.card.border-amber { border-color:#fbbf2455; }
.card.border-red { border-color:#f8717155; }
.card.border-green { border-color:#34d39955; }
.error-banner { background:#3a1418; border:1px solid #7f1d1d; color:#fda4af; border-radius:9px; padding:8px 10px; margin-bottom:8px; font-size:11px; word-break:break-all; }
.row { display:flex; align-items:center; gap:8px; }
.grow { flex:1; min-width:0; }
.muted { color:#6b7894; font-size:11px; }
.mono { font-family:ui-monospace,Menlo,monospace; font-size:10.5px; }
.btn { border:0; border-radius:8px; padding:6px 14px; cursor:pointer; font:700 11.5px/1 system-ui,sans-serif; letter-spacing:.3px; }
.btn:active { transform:translateY(1px); }
.btn.approve { background:linear-gradient(180deg,#2f9e44,#238636); color:#fff; box-shadow:0 0 10px #2f9e4455; }
.btn.approve:hover { filter:brightness(1.12); }
.btn.reject { background:linear-gradient(180deg,#e03131,#c92a2a); color:#fff; box-shadow:0 0 8px #e0313155; }
.btn.reject:hover { filter:brightness(1.12); }
.btn.cancel { background:#2b1b1b; border:1px solid #6b2626; color:#ffb3b3; border-radius:7px; padding:3px 10px; font-size:11px; }
.btn.cancel:hover { background:#3a1f1f; }
.gate-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 0; border-bottom:1px dashed #1f2940; }
.gate-row:last-child { border-bottom:0; }
.gate-actions { display:flex; gap:7px; flex-shrink:0; }
/* pipeline */
.pipeline { display:flex; gap:0; margin:4px 0 2px; }
.pstep { flex:1; display:flex; flex-direction:column; align-items:center; gap:5px; min-width:0; position:relative; }
.pstep .dot { width:11px; height:11px; border-radius:50%; background:#232d45; border:2px solid #2b3652; z-index:1; transition:all .2s; }
.pstep.done .dot { background:#1e3a2f; border-color:#34d399; box-shadow:0 0 6px #34d39966; }
.pstep.done .dot::after { content:'✓'; position:absolute; top:-9px; font-size:8px; color:#34d399; }
.pstep.current .dot { background:#4d9fff; border-color:#7db8ff; box-shadow:0 0 8px #4d9fff88; animation:pulse 1.6s ease-in-out infinite; }
.pstep .lbl { font:600 8px/1 ui-monospace,Menlo,monospace; color:#4a5670; letter-spacing:.2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
.pstep.done .lbl, .pstep.current .lbl { color:#93a1bc; }
.pstep.current .lbl { color:#bfe0ff; }
.pipeline .pstep + .pstep::before { content:''; position:absolute; top:4px; right:50%; width:100%; height:2px; background:#1c2540; z-index:0; }
.pipeline .pstep.done + .pstep::before, .pipeline .pstep.done.done + .pstep::before { background:linear-gradient(90deg,#34d39966,#1c2540); }
.pipeline .pstep.current + .pstep::before { background:linear-gradient(90deg,#4d9fff66,#1c2540); }
@keyframes pulse { 0%,100% { box-shadow:0 0 4px #4d9fff66; } 50% { box-shadow:0 0 12px #4d9fffcc; } }
.pipeline-wrap { background:#0f1522; border:1px solid #1f2940; border-radius:10px; padding:12px 8px 8px; margin-bottom:4px; }
/* metrics / budget */
.budget-row { display:flex; align-items:center; gap:9px; padding:5px 0; }
.budget-row .blabel { width:86px; color:#8b97b0; font-size:11px; flex-shrink:0; }
.budget-track { flex:1; height:7px; background:#1a2238; border-radius:99px; overflow:hidden; }
.budget-fill { height:100%; border-radius:99px; transition:width .3s; }
.budget-val { width:120px; text-align:right; color:#c9d3e5; font:600 11px/1 ui-monospace,Menlo,monospace; flex-shrink:0; }
.count-chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.chip { display:inline-flex; align-items:center; gap:5px; background:#151b2c; border:1px solid #222c45; border-radius:99px; padding:3px 9px; font-size:10.5px; color:#8b97b0; }
.chip b { color:#eef2fa; font-weight:700; }
/* evidence */
.evidence-card { background:#121829; border:1px solid #222c45; border-radius:10px; padding:10px 12px; margin:6px 0; }
.evidence-metric { font:700 15px/1 ui-monospace,Menlo,monospace; color:#eef2fa; }
.evidence-delta { font:600 11px/1 ui-monospace,Menlo,monospace; }
.stamp { margin-top:10px; color:#55627e; font-size:10px; text-align:right; font-family:ui-monospace,Menlo,monospace; }
/* preview modal */
.overlay { position:fixed; inset:0; background:rgba(5,8,16,.7); z-index:10000; display:flex; align-items:center; justify-content:center; padding:40px; }
.modal { background:#111726; border:1px solid #2b3652; border-radius:12px; max-width:740px; max-height:72vh; overflow:auto; padding:14px 16px; color:#dbe2ee; font:12px/1.5 system-ui,sans-serif; box-shadow:0 20px 70px rgba(0,0,0,.6); }
.modal-header { font:700 12px/1.4 system-ui,sans-serif; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; gap:10px; }
.modal pre { white-space:pre-wrap; word-break:break-all; font-family:ui-monospace,Menlo,monospace; font-size:11px; margin:0; color:#c9d3e5; }
.modal img, .modal embed { max-width:100%; max-height:60vh; background:#fff; border-radius:8px; }
.warn { background:#5c1f1f; color:#ffb3b3; border-radius:8px; padding:7px 10px; margin-top:8px; font-size:11px; }
.dl { color:#7fb3ff; text-decoration:underline; font-size:11px; }
.artifact-row { display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px dashed #1f2940; cursor:pointer; border-radius:6px; }
.artifact-row:hover { background:#151b2c; }
.artifact-row:last-child { border-bottom:0; }
.artifact-kind { font:600 9.5px/1.6 ui-monospace,Menlo,monospace; color:#8b97b0; background:#1a2238; border:1px solid #232d45; border-radius:5px; padding:1px 6px; flex-shrink:0; }
`
  root.appendChild(style)

  const panel = el('div', 'panel')
  root.appendChild(panel)

  // ── header ──
  const header = el('div', 'header')
  header.appendChild(el('span', 'logo', '🧪'))
  header.appendChild(el('span', 'title', 'Research OS'))
  const spacer = el('span', 'spacer')
  header.appendChild(spacer)
  const refresh = el('button', 'hbtn', '⟳ Refresh')
  refresh.title = 'refresh now'
  const close = el('button', 'hbtn ghost', '×')
  close.title = 'collapse'
  close.onclick = () => { panel.style.display = 'none' }
  if (fullscreen) {
    // Standalone mode: an in-panel project creator (the DSH host provides
    // /research new; the standalone web plugin must be self-sufficient).
    const newBtn = el('button', 'hbtn', '＋ New Project')
    newBtn.onclick = () => { openNewProjectModal(root) }
    header.append(newBtn, refresh)
  } else {
    header.append(refresh, close)
  }
  panel.appendChild(header)

  // ── tabs ──
  const tabs = el('div', 'tabs')
  const TAB_DEFS = [
    ['phase', 'Phase'], ['gates', 'Gates'], ['runs', 'Runs'],
    ['artifacts', 'Artifacts'], ['evidence', 'Evidence'], ['budget', 'Budget'],
  ] as const
  const tabButtons = new Map<string, HTMLElement>()
  for (const [key, label] of TAB_DEFS) {
    const button = el('button', 'tab', label)
    button.dataset.tab = key
    button.onclick = () => { activeTab = key; void render() }
    tabButtons.set(key, button)
    tabs.appendChild(button)
  }
  panel.appendChild(tabs)

  // ── body + picker ──
  const body = el('div', 'body')
  panel.appendChild(body)
  const picker = el('select', 'picker')
  picker.style.cssText = 'margin:10px 12px 0;width:calc(100% - 24px)'
  picker.onchange = () => { projectId = picker.value || undefined; void render() }
  panel.insertBefore(picker, body)

  const styleTabs = (): void => {
    for (const [key, button] of tabButtons) button.classList.toggle('active', key === activeTab)
  }

  const render = async (): Promise<void> => {
    styleTabs()
    // Project picker: session-linked first, then all projects.
    const projects = (await api<ProjectRow[]>('/v1/projects')) ?? []
    const current = picker.options.length === 0
    if (current || projectId === undefined) {
      picker.replaceChildren()
      const placeholder = el('option', '', projectId === undefined ? '— select project —' : '— session-linked —')
      placeholder.value = ''
      picker.appendChild(placeholder)
      for (const p of projects) {
        const option = el('option', '', `${p.name ?? p.project_id} · ${p.status ?? ''}`)
        option.value = p.project_id ?? ''
        picker.appendChild(option)
      }
      picker.value = projectId ?? ''
    }
    const target = projectId ?? projects[0]?.project_id
    if (target === undefined) {
      body.replaceChildren(el('div', 'empty', 'No research projects yet — create one with the ＋ New Project button.'))
      return
    }
    const projection = await api<Projection>(`/v1/projects/${encodeURIComponent(target)}/projection`)
    if (projection === null || projection.project === undefined) {
      body.replaceChildren(el('div', 'error-banner', `Research kernel unreachable (project ${target}).`))
      return
    }
    projectId = projection.project.project_id
    if (current) picker.value = projectId
    body.replaceChildren()

    const title = el('div', 'project-title')
    const pname = el('span', 'pname', projection.project.name ?? projectId)
    const pid = el('span', 'pid', `${projectId} · rev ${projection.project.revision ?? 0}`)
    const statusPill = pill(projection.project.status)
    title.append(pname, statusPill, pid)
    body.appendChild(title)

    switch (activeTab) {
      case 'phase': renderPhase(body, projection); break
      case 'gates': await renderGates(body, target); break
      case 'runs': renderRuns(body, projection); break
      case 'artifacts': await renderArtifacts(body, target); break
      case 'evidence': await renderEvidence(body, target); break
      case 'budget': renderBudget(body, projection); break
    }
    const stamp = el('div', 'stamp', `updated ${new Date().toLocaleTimeString()}${lastError !== undefined ? ` · ⚠ ${lastError}` : ''}`)
    body.appendChild(stamp)
  }

  refresh.onclick = () => { void render() }
  rerender = () => { void render() }
  void render()
  const timer = window.setInterval(() => { void render() }, 8000)
  window.addEventListener('beforeunload', () => window.clearInterval(timer), { once: true })
  document.body.appendChild(host)
}

/* ─────────────────────────── tab renderers ─────────────────────────── */

function renderPhase(body: HTMLElement, p: Projection): void {
  const status = p.project?.status ?? ''
  const statusIdx = PHASE_PIPELINE.findIndex(([k]) => k === status)
  const pipeline = el('div', 'pipeline-wrap')
  const steps = el('div', 'pipeline')
  for (const [key, label] of PHASE_PIPELINE) {
    const step = el('div', 'pstep')
    const idx = PHASE_PIPELINE.findIndex(([k]) => k === key)
    if (statusIdx < 0 || idx < statusIdx) step.classList.add('done')
    if (key === status) step.classList.add('current')
    step.appendChild(el('span', 'dot'))
    step.appendChild(el('span', 'lbl', label))
    steps.appendChild(step)
  }
  pipeline.appendChild(steps)
  body.appendChild(pipeline)

  // next actions
  const next = (p.next_actions ?? []).filter(Boolean)
  if (next.length > 0) {
    body.appendChild(el('div', 'section-label', 'Next actions'))
    for (const action of next) {
      const card = el('div', 'card')
      const row = el('div', 'row')
      row.appendChild(el('span', '', '➡️'))
      const text = el('span', 'grow', action)
      row.appendChild(text)
      card.appendChild(row)
      body.appendChild(card)
    }
  } else {
    body.appendChild(el('div', 'section-label', 'Next actions'))
    body.appendChild(el('div', 'empty', 'No pending actions — waiting on human gate decision.'))
  }

  // history
  const history = (p.project?.history ?? []).slice(-8)
  if (history.length > 0) {
    body.appendChild(el('div', 'section-label', 'History'))
    for (const h of history) {
      const row = el('div', 'row')
      row.style.cssText = 'padding:2px 0'
      row.appendChild(el('span', 'muted', '·'))
      row.appendChild(el('span', 'grow muted', h))
      body.appendChild(row)
    }
  }
}

async function renderGates(body: HTMLElement, projectId: string): Promise<void> {
  const gates = (await api<GateRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/gates`)) ?? []
  const pending = gates.filter(g => g.status === 'pending')
  const decided = gates.filter(g => g.status !== 'pending')
  body.appendChild(el('div', 'section-label', `Awaiting your decision (${pending.length})`))
  if (pending.length === 0) {
    body.appendChild(el('div', 'empty', 'No pending gates. All decisions are made — or nothing was requested yet.'))
  }
  for (const gate of pending) {
    const card = el('div', 'card border-amber')
    const top = el('div', 'row')
    top.appendChild(el('span', 'pname', `${shortType(gate.type)} Gate`))
    top.appendChild(pill('pending'))
    card.appendChild(top)
    if (gate.title !== undefined && gate.title !== '') {
      const t = el('div', 'grow', gate.title)
      t.style.cssText = 'margin-top:4px;color:#c9d3e5;font-size:11.5px'
      card.appendChild(t)
    }
    if (gate.summary !== undefined && gate.summary !== '') {
      const s = el('div', 'muted', gate.summary)
      s.style.cssText = 'margin-top:3px'
      card.appendChild(s)
    }
    const actions = el('div', 'gate-actions')
    actions.style.cssText = 'margin-top:10px;display:flex;gap:8px'
    const approve = el('button', 'btn approve', '✓ Approve')
    const reject = el('button', 'btn reject', '✕ Reject')
    const act = async (decision: 'approved' | 'rejected', label: string): Promise<void> => {
      const ok = await api(`/v1/gates/${encodeURIComponent(gate.gate_id ?? '')}/decisions`, {
        method: 'POST',
        body: JSON.stringify({ actor: 'web-user', decision, reason: `${label} from Research OS panel` }),
      })
      lastError = ok === null ? `gate ${label.toLowerCase()} failed (bridge error)` : undefined
      rerender()
    }
    approve.onclick = () => { void act('approved', 'approved') }
    reject.onclick = () => { void act('rejected', 'rejected') }
    actions.append(approve, reject)
    card.appendChild(actions)
    body.appendChild(card)
  }
  if (decided.length > 0) {
    body.appendChild(el('div', 'section-label', `Decided (${decided.length})`))
    const card = el('div', 'card')
    for (const gate of decided) {
      const row = el('div', 'gate-row')
      const info = el('div', 'grow')
      const name = el('div', 'pname', `${shortType(gate.type)} Gate`)
      name.style.cssText = 'font-size:11.5px'
      info.appendChild(name)
      if (gate.title !== undefined && gate.title !== '') info.appendChild(el('div', 'muted', gate.title))
      row.appendChild(info)
      row.appendChild(pill(gate.status))
      card.appendChild(row)
    }
    body.appendChild(card)
  }
}

function renderRuns(body: HTMLElement, p: Projection): void {
  const jobs = (p.jobs ?? []).slice(-12).reverse()
  const cancellable = new Set(['queued', 'running', 'retryable'])
  body.appendChild(el('div', 'section-label', `Runs (${(p.jobs ?? []).length})`))
  if (jobs.length === 0) {
    body.appendChild(el('div', 'empty', 'No experiment runs yet.'))
    return
  }
  for (const job of jobs) {
    const card = el('div', 'card')
    card.style.cssText = 'padding:8px 10px;margin:5px 0'
    const row = el('div', 'row')
    const kind = el('span', 'artifact-kind', job.kind ?? '?')
    kind.style.cssText += ';text-transform:uppercase'
    row.appendChild(kind)
    const text = el('span', 'grow mono', fmtId(job.job_id))
    row.appendChild(text)
    row.appendChild(pill(job.status))
    card.appendChild(row)
    if (job.error !== undefined && job.error !== '') {
      const err = el('div', 'muted', job.error)
      err.style.cssText = 'margin-top:4px;color:#f87171;font-size:10.5px;word-break:break-all'
      card.appendChild(err)
    }
    if (job.job_id !== undefined && cancellable.has(job.status ?? '')) {
      const cancel = el('button', 'btn cancel', '✕ Cancel')
      cancel.onclick = async () => {
        const ok = await api(`/v1/jobs/${encodeURIComponent(job.job_id ?? '')}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ actor: 'web-user', reason: 'cancelled from Research OS panel' }),
        })
        lastError = ok === null ? 'cancel failed (bridge error)' : undefined
        rerender()
      }
      const wrap = el('div', 'row')
      wrap.style.cssText = 'justify-content:flex-end;margin-top:6px'
      wrap.appendChild(cancel)
      card.appendChild(wrap)
    }
    body.appendChild(card)
  }
}

async function renderArtifacts(body: HTMLElement, projectId: string): Promise<void> {
  const artifacts = (await api<ArtifactRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`)) ?? []
  body.appendChild(el('div', 'section-label', `Artifacts (${artifacts.length}, click to preview)`))
  if (artifacts.length === 0) {
    body.appendChild(el('div', 'empty', 'No artifacts yet — runs and analysis produce them.'))
    return
  }
  for (const artifact of artifacts.slice(-15).reverse()) {
    const row = el('div', 'artifact-row')
    row.appendChild(el('span', 'artifact-kind', (artifact.kind ?? '?').toUpperCase()))
    const name = el('span', 'grow mono', fmtId(artifact.artifact_id, 22))
    row.appendChild(name)
    row.appendChild(el('span', 'muted', fmtBytes(artifact.size_bytes)))
    row.title = 'click to preview'
    row.onclick = () => { void previewArtifact(artifact.artifact_id ?? '') }
    body.appendChild(row)
  }
}

/** Download link backed by a blob URL (used for non-previewable types). */
function downloadLink(blob: Blob, name: string): HTMLElement {
  const link = el('a', 'dl', '⬇ Download file')
  link.href = URL.createObjectURL(blob)
  link.download = name
  return link
}

/**
 * Fetch an artifact blob through the bridge and show it in a modal.
 * Security (design §15.4): untrusted artifacts are never rendered through
 * HTML-string sinks. SVG/PDF/images are shown via blob URLs (script
 * execution is isolated/disabled in these contexts); HTML is download-only;
 * text is rendered with textContent.
 */
async function previewArtifact(artifactId: string): Promise<void> {
  try {
    const response = await fetch(`${base()}/v1/artifacts/${encodeURIComponent(artifactId)}`, {
      headers: { accept: 'application/octet-stream', ...(await authHeaders()) },
    })
    if (!response.ok) return
    const blob = await response.blob()
    const root = overlayRoot ?? (document.querySelector('#dsh-scholar-ui')?.shadowRoot ?? null)
    if (root === undefined || root === null) return
    const overlay = el('div', 'overlay')
    const blobUrls: string[] = []
    const revoke = (): void => { for (const url of blobUrls) URL.revokeObjectURL(url) }
    overlay.onclick = (event) => { if (event.target === overlay) { revoke(); overlay.remove() } }
    const modal = el('div', 'modal')
    const header = el('div', 'modal-header', `📦 ${artifactId.slice(0, 28)}${artifactId.length > 28 ? '…' : ''}`)
    const closeBtn = el('button', 'hbtn ghost', '×')
    closeBtn.onclick = () => { revoke(); overlay.remove() }
    header.appendChild(closeBtn)
    modal.appendChild(header)
    const contentType = (blob.type ?? '').toLowerCase()
    const text = contentType.startsWith('text/') ? await blob.text() : undefined
    const trimmed = text?.trim() ?? ''
    const isSvg = contentType === 'image/svg+xml' || trimmed.startsWith('<svg')
    const isHtml = contentType === 'text/html' || /^<!doctype html/i.test(trimmed) || trimmed.startsWith('<html')
    if (isSvg) {
      // SVG as <img src=blobUrl>: no script execution, no HTML-string sink (§15.4).
      const url = URL.createObjectURL(blob)
      blobUrls.push(url)
      const img = document.createElement('img')
      img.src = url
      img.alt = artifactId
      modal.appendChild(img)
    } else if (isHtml) {
      // HTML is untrusted markup: never rendered via HTML strings, download only (§15.4).
      modal.appendChild(el('div', 'warn', '⚠️ HTML preview is disabled for security (design §15.4) — download the file instead.'))
      modal.appendChild(downloadLink(blob, artifactId))
    } else if (contentType.startsWith('image/')) {
      const url = URL.createObjectURL(blob)
      blobUrls.push(url)
      const img = document.createElement('img')
      img.src = url
      img.alt = artifactId
      modal.appendChild(img)
    } else if (contentType === 'application/pdf') {
      const url = URL.createObjectURL(blob)
      blobUrls.push(url)
      const embed = document.createElement('embed')
      embed.src = url
      embed.type = 'application/pdf'
      embed.style.cssText = 'width:100%;height:60vh'
      modal.appendChild(embed)
      modal.appendChild(downloadLink(blob, artifactId))
    } else {
      const content = text ?? (await blob.text())
      const pre = el('pre', '', content.length > 6000 ? content.slice(0, 6000) + String.fromCharCode(10) + '… (truncated)' : content)
      pre.className = 'pre'
      modal.appendChild(pre)
    }
    overlay.appendChild(modal)
    root.appendChild(overlay)
  } catch { /* bridge unreachable */ }
}

async function renderEvidence(body: HTMLElement, projectId: string): Promise<void> {
  const claims = (await api<ClaimRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/claims`)) ?? []
  const evidence = (await api<EvidenceRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/evidence`)) ?? []
  body.appendChild(el('div', 'section-label', `Claims (${claims.length})`))
  if (claims.length === 0) {
    body.appendChild(el('div', 'empty', 'No claims yet.'))
  }
  for (const claim of claims.slice(-8).reverse()) {
    const card = el('div', 'evidence-card')
    const top = el('div', 'row')
    top.appendChild(pill(claim.status))
    const conf = el('span', 'muted', claim.confidence !== undefined && claim.confidence !== '' ? claim.confidence : '')
    top.appendChild(conf)
    card.appendChild(top)
    const stmt = el('div', 'grow', claim.statement ?? '')
    stmt.style.cssText = 'margin-top:5px;color:#c9d3e5;font-size:11.5px'
    card.appendChild(stmt)
    const id = el('div', 'muted mono', fmtId(claim.claim_id))
    id.style.cssText = 'margin-top:4px;font-size:10px'
    card.appendChild(id)
    body.appendChild(card)
  }
  body.appendChild(el('div', 'section-label', `Evidence (${evidence.length})`))
  if (evidence.length === 0) {
    body.appendChild(el('div', 'empty', 'No verified evidence yet — only the Analysis Worker can create it.'))
  }
  for (const item of evidence.slice(-8).reverse()) {
    const r = item.result
    const card = el('div', 'card')
    const row = el('div', 'row')
    const metric = el('span', 'evidence-metric', `${r?.primary_metric ?? '?'} = ${r?.value ?? '?'}`)
    row.appendChild(metric)
    const delta = el('span', 'evidence-delta')
    const effect = r?.effect_size
    if (effect !== undefined) {
      delta.textContent = `Δ${effect >= 0 ? '+' : ''}${effect}`
      delta.style.color = effect > 0 ? '#34d399' : effect < 0 ? '#f87171' : '#8b93a7'
    }
    row.appendChild(delta)
    row.appendChild(el('span', 'grow'))
    row.appendChild(pill('verified'))
    card.appendChild(row)
    const meta = el('div', 'muted', `CI [${r?.ci_low ?? '?'}, ${r?.ci_high ?? '?'}] · n=${r?.n_seeds ?? '?'} · ${item.analysis_method ?? '?'}`)
    meta.style.cssText = 'margin-top:4px'
    card.appendChild(meta)
    const id = el('div', 'muted mono', fmtId(item.evidence_id))
    id.style.cssText = 'margin-top:3px;font-size:10px'
    card.appendChild(id)
    body.appendChild(card)
  }
}

function renderBudget(body: HTMLElement, p: Projection): void {
  const c = p.project?.constraints
  const b = p.budget
  const model = b?.model_cost_usd ?? 0
  const gpu = b?.gpu_hours ?? 0
  const modelMax = c?.max_model_cost_usd
  const gpuMax = c?.max_gpu_hours
  body.appendChild(el('div', 'section-label', 'Budget'))
  const row1 = budgetRow('Model cost', model, modelMax, '$', 2)
  const row2 = budgetRow('GPU hours', gpu, gpuMax, '', 2)
  const row3 = el('div', 'budget-row')
  row3.appendChild(el('span', 'blabel', 'API requests'))
  row3.appendChild(el('span', 'grow muted', String(b?.api_requests ?? 0)))
  body.append(row1, row2, row3)

  const counts = p.counts
  if (counts !== undefined) {
    body.appendChild(el('div', 'section-label', 'Project contents'))
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
    const warn = el('div', 'warn', '⚠️ Budget limit exceeded — project is BLOCKED_GATE until a human Budget Gate approves.')
    body.appendChild(warn)
  }
}

function budgetRow(label: string, value: number, max: number | undefined, prefix: string, digits: number): HTMLElement {
  const row = el('div', 'budget-row')
  row.appendChild(el('span', 'blabel', label))
  const track = el('div', 'budget-track')
  const fill = el('div', 'budget-fill')
  const ratio = max !== undefined && max > 0 ? Math.min(value / max, 1) : 0
  const color = ratio >= 1 ? '#f87171' : ratio >= 0.8 ? '#fbbf24' : '#4d9fff'
  fill.style.cssText = `width:${Math.max(ratio * 100, value > 0 ? 4 : 0)}%;background:${color};box-shadow:0 0 6px ${color}66`
  track.appendChild(fill)
  row.appendChild(track)
  const val = el('span', 'budget-val', `${prefix}${value.toFixed(digits)}${max !== undefined ? ` / ${prefix}${max}` : ''}`)
  row.appendChild(val)
  return row
}

/* ─────────────────────────── standalone project creator ─────────────────────────── */

/**
 * Standalone web plugin: modal form that creates a project + Scope Gate via
 * the same kernel API the /research new command uses. Rendered with
 * textContent-only inputs (no HTML sinks, design §15.4).
 */
function openNewProjectModal(root: ShadowRoot): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'

  const header = el('div', 'modal-header', '＋ New Research Project')
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
    input.style.cssText = 'width:100%;background:#151b2c;color:#dbe2ee;border:1px solid #2b3652;border-radius:8px;padding:7px 10px;font:12px/1.4 system-ui,sans-serif;outline:none'
    input.onfocus = () => { input.style.borderColor = '#4d9fff' }
    input.onblur = () => { input.style.borderColor = '#2b3652' }
    modal.appendChild(lab)
    modal.appendChild(input)
    return input
  }

  const nameInput = field('Project name', 'e.g. shift-localization')
  const problemInput = field('Problem statement', 'e.g. Does uncertainty weighting help under domain shift?')
  const metricInput = field('Primary metric', 'e.g. mAP@0.5')

  const err = el('div', 'error-banner')
  err.style.cssText = 'display:none;margin-top:10px'
  modal.appendChild(err)

  const actions = el('div', 'row')
  actions.style.cssText = 'justify-content:flex-end;gap:8px;margin-top:14px'
  const cancel = el('button', 'hbtn', 'Cancel')
  cancel.onclick = () => overlay.remove()
  const create = el('button', 'btn approve', 'Create Project')
  create.style.cssText = 'padding:7px 18px'
  create.onclick = async () => {
    const name = nameInput.value.trim()
    if (name === '') {
      err.textContent = 'Project name is required.'
      err.style.display = 'block'
      return
    }
    err.style.display = 'none'
    create.disabled = true
    create.textContent = 'Creating…'
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
      err.textContent = 'Create failed — is the kernel reachable?'
      err.style.display = 'block'
      create.disabled = false
      create.textContent = 'Create Project'
      return
    }
    // Scope Gate, exactly like /research new.
    await api(`/v1/projects/${encodeURIComponent(project.project_id)}/gates`, {
      method: 'POST',
      body: JSON.stringify({ type: 'scope', title: `Scope Gate — ${name}`, summary: 'Approve the research scope, data policy, budget and target venue.' }),
    })
    projectId = project.project_id
    overlay.remove()
    rerender()
  }
  actions.append(cancel, create)
  modal.appendChild(actions)

  overlay.appendChild(modal)
  root.appendChild(overlay)
  nameInput.focus()
}
