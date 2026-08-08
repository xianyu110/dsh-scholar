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

const PHASE_PIPELINE = [
  ['DRAFT', 'Draft'], ['SCOPED', 'Scoped'], ['SURVEYING', 'Survey'],
  ['IDEATING', 'Ideas'], ['IDEA_APPROVED', 'Idea ✓'], ['BASELINE_REPRO', 'Baseline'],
  ['CONTRACT_APPROVED', 'Contract'], ['EXPERIMENTING', 'Run'], ['EVIDENCE_READY', 'Analyze'],
  ['WRITING', 'Write'], ['REVIEWING', 'Review'], ['RELEASE_READY', 'Package'],
  ['RELEASED', 'Released'],
] as const

/* ─────────────────────────── theme (light default) ─────────────────────────── */

const THEME_KEY = 'dsh-scholar-ui-theme'

function readTheme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    return saved === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function writeTheme(theme: 'light' | 'dark'): void {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch { /* private mode */ }
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
  const node = el('span', 'pill')
  node.style.cssText = `display:inline-flex;align-items:center;gap:5px;font:600 10px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.4px;color:var(--tone-${meta.tone});background:var(--tone-${meta.tone}-bg);border:1px solid var(--tone-${meta.tone});border-radius:99px;padding:1px 8px;white-space:nowrap`
  const dot = el('span')
  dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:var(--tone-${meta.tone});box-shadow:0 0 5px var(--tone-${meta.tone})`
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
  // Theme: LIGHT is the default; persisted per browser.
  host.dataset.theme = readTheme()

  const style = el('style')
  style.textContent = `

:host { all: initial; }
/* Design tokens — LIGHT is the default theme. */
:host { color-scheme: light; }
:host([data-theme="dark"]) { color-scheme: dark; }
:host {
  --bg: #f7f9fc; --bg-2: #ffffff; --bg-3: #eef2f8;
  --bg-input: #ffffff; --bg-hover: #e8eef7;
  --border: #d9e1ee; --border-2: #e4eaf4; --border-strong: #b9c6da;
  --text: #1a2333; --text-2: #4a5a78; --text-3: #6b7a99;
  --accent: #2563eb; --accent-soft: #dbe7fd; --accent-text: #1d4ed8;
  --header-grad: linear-gradient(180deg,#ffffff,#f2f6fc);
  --shadow: 0 18px 60px rgba(30,45,80,.18), 0 0 0 1px rgba(255,255,255,.6) inset;
  --tone-slate: #64748b; --tone-blue: #2563eb; --tone-cyan: #0891b2;
  --tone-violet: #7c3aed; --tone-green: #16a34a; --tone-amber: #b45309; --tone-red: #dc2626;
  --tone-slate-bg: #e8edf4; --tone-blue-bg: #dbe7fd; --tone-cyan-bg: #d5f1f6;
  --tone-violet-bg: #ece2fc; --tone-green-bg: #d9f2e2; --tone-amber-bg: #fbe9d0; --tone-red-bg: #fbe0de;
}
:host([data-theme="dark"]) {
  --bg: #0e1320; --bg-2: #121829; --bg-3: #0f1522;
  --bg-input: #151b2c; --bg-hover: #182034;
  --border: #263049; --border-2: #1f2940; --border-strong: #3a4a70;
  --text: #dbe2ee; --text-2: #8b97b0; --text-3: #5d6b88;
  --accent: #4d9fff; --accent-soft: #1c3352; --accent-text: #bfe0ff;
  --header-grad: linear-gradient(180deg,#151b2c,#101624);
  --shadow: 0 18px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.02) inset;
  --tone-slate: #8b93a7; --tone-blue: #4d9fff; --tone-cyan: #22d3ee;
  --tone-violet: #a78bfa; --tone-green: #34d399; --tone-amber: #fbbf24; --tone-red: #f87171;
  --tone-slate-bg: #232b3d; --tone-blue-bg: #1c3352; --tone-cyan-bg: #123a44;
  --tone-violet-bg: #31275a; --tone-green-bg: #1e3a2f; --tone-amber-bg: #3d2f14; --tone-red-bg: #4a1f24;
}

* { box-sizing: border-box; margin: 0; }
.panel { display:flex; flex-direction:column; height:100%; max-height:inherit; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:${fullscreen ? 0 : 14}px; overflow:hidden; box-shadow:${fullscreen ? 'none' : 'var(--shadow)'}; font:12px/1.5 system-ui,sans-serif; }
${fullscreen ? '.panel { font-size:13px; }' : ''}
.header { display:flex; align-items:center; gap:8px; padding:${fullscreen ? '14px 20px' : '11px 14px'}; background:var(--header-grad); border-bottom:1px solid var(--border); }
.header .logo { font-size:${fullscreen ? 18 : 14}px; filter:drop-shadow(0 0 6px var(--accent)); }
.header .title { font:700 ${fullscreen ? 15 : 13}px/1 system-ui,sans-serif; color:var(--text); letter-spacing:.2px; }
.header .spacer { flex:1; }
.hbtn { border:1px solid var(--border); background:var(--bg-2); color:var(--text-2); border-radius:8px; padding:3px 9px; cursor:pointer; font:600 11px/1.6 system-ui,sans-serif; }
.hbtn:hover { background:var(--bg-hover); color:var(--text); border-color:var(--border-strong); }
.hbtn:active { transform:translateY(1px); }
.hbtn.ghost { border:0; background:none; color:var(--text-3); font-size:15px; padding:2px 6px; }
.hbtn.ghost:hover { color:var(--text); background:var(--bg-hover); }
.tabs { display:flex; gap:2px; padding:0 ${fullscreen ? 20 : 10}px; background:var(--bg-3); border-bottom:1px solid var(--border); }
.tab { flex:1; border:0; background:none; color:var(--text-2); padding:${fullscreen ? '12px 2px 11px' : '9px 2px 8px'}; cursor:pointer; font:600 ${fullscreen ? 12 : 11}px/1 system-ui,sans-serif; border-bottom:2px solid transparent; letter-spacing:.3px; }
.tab:hover { color:var(--text-2); }
.tab.active { color:var(--text); border-bottom-color:var(--accent); }
.body { flex:1; overflow-y:auto; padding:${fullscreen ? '18px 22px 14px' : '12px 14px 10px'}; scrollbar-width:thin; scrollbar-color:var(--border) transparent; }
.body::-webkit-scrollbar { width:8px; }
.body::-webkit-scrollbar-thumb { background:var(--border); border-radius:4px; }
.picker { width:100%; margin-bottom:11px; background:var(--bg-input); color:var(--text); border:1px solid var(--border); border-radius:9px; padding:${fullscreen ? '8px 11px' : '6px 9px'}; font:600 ${fullscreen ? 12 : 11}px/1.4 system-ui,sans-serif; outline:none; }
.picker:focus { border-color:var(--accent); }
.section-label { font:700 10px/1.4 system-ui,sans-serif; color:var(--text-3); text-transform:uppercase; letter-spacing:1px; margin:14px 0 6px; }
.section-label:first-child { margin-top:0; }
.project-title { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.project-title .pname { font:700 13px/1.3 system-ui,sans-serif; color:var(--text); }
.project-title .pid { font:500 10px/1.4 ui-monospace,Menlo,monospace; color:var(--text-3); }
.empty { color:var(--text-3); font-size:11px; padding:10px 2px; font-style:italic; }
.card { background:var(--bg-2); border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin:6px 0; }
.card.border-amber { border-color:var(--tone-amber); }
.card.border-red { border-color:var(--tone-red); }
.card.border-green { border-color:var(--tone-green); }
.error-banner { background:var(--tone-red-bg); border:1px solid var(--tone-red); color:var(--tone-red); border-radius:9px; padding:8px 10px; margin-bottom:8px; font-size:11px; word-break:break-all; }
.row { display:flex; align-items:center; gap:8px; }
.grow { flex:1; min-width:0; }
.muted { color:var(--text-2); font-size:11px; }
.mono { font-family:ui-monospace,Menlo,monospace; font-size:10.5px; }
.btn { border:0; border-radius:8px; padding:6px 14px; cursor:pointer; font:700 11.5px/1 system-ui,sans-serif; letter-spacing:.3px; }
.btn:active { transform:translateY(1px); }
.btn.approve { background:linear-gradient(180deg,#2f9e44,#238636); color:#fff; box-shadow:0 0 10px var(--tone-green); }
.btn.approve:hover { filter:brightness(1.12); }
.btn.reject { background:linear-gradient(180deg,#e03131,#c92a2a); color:#fff; box-shadow:0 0 8px var(--tone-red); }
.btn.reject:hover { filter:brightness(1.12); }
.btn.cancel { background:var(--tone-red-bg); border:1px solid var(--tone-red); color:var(--tone-red); border-radius:7px; padding:3px 10px; font-size:11px; }
.btn.cancel:hover { background:var(--tone-red-bg); }
.gate-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 0; border-bottom:1px dashed var(--border-2); }
.gate-row:last-child { border-bottom:0; }
.gate-actions { display:flex; gap:7px; flex-shrink:0; }
/* pipeline */
.pipeline { display:flex; gap:0; margin:4px 0 2px; }
.pstep { flex:1; display:flex; flex-direction:column; align-items:center; gap:5px; min-width:0; position:relative; }
.pstep .dot { width:11px; height:11px; border-radius:50%; background:var(--bg-3); border:2px solid var(--border); z-index:1; transition:all .2s; }
.pstep.done .dot { background:var(--tone-green-bg); border-color:var(--tone-green); box-shadow:0 0 6px var(--tone-green); }
.pstep.done .dot::after { content:'✓'; position:absolute; top:-9px; font-size:8px; color:var(--tone-green); }
.pstep.current .dot { background:var(--accent); border-color:var(--accent); box-shadow:0 0 8px var(--accent); animation:pulse 1.6s ease-in-out infinite; }
.pstep .lbl { font:600 8px/1 ui-monospace,Menlo,monospace; color:var(--text-3); letter-spacing:.2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
.pstep.done .lbl, .pstep.current .lbl { color:var(--text-2); }
.pstep.current .lbl { color:var(--accent-text); }
.pipeline .pstep + .pstep::before { content:''; position:absolute; top:4px; right:50%; width:100%; height:2px; background:var(--border); z-index:0; }
.pipeline .pstep.done + .pstep::before, .pipeline .pstep.done.done + .pstep::before { background:linear-gradient(90deg,var(--tone-green),var(--border)); }
.pipeline .pstep.current + .pstep::before { background:linear-gradient(90deg,var(--accent),var(--border)); }
@keyframes pulse { 0%,100% { box-shadow:0 0 4px var(--accent); } 50% { box-shadow:0 0 12px var(--accent); } }
.pipeline-wrap { background:var(--bg-3); border:1px solid var(--border); border-radius:10px; padding:12px 8px 8px; margin-bottom:4px; }
/* metrics / budget */
.budget-row { display:flex; align-items:center; gap:9px; padding:5px 0; }
.budget-row .blabel { width:86px; color:var(--text-2); font-size:11px; flex-shrink:0; }
.budget-track { flex:1; height:7px; background:var(--bg-3); border-radius:99px; overflow:hidden; }
.budget-fill { height:100%; border-radius:99px; transition:width .3s; }
.budget-val { width:120px; text-align:right; color:var(--text); font:600 11px/1 ui-monospace,Menlo,monospace; flex-shrink:0; }
.count-chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.chip { display:inline-flex; align-items:center; gap:5px; background:var(--bg-input); border:1px solid var(--border); border-radius:99px; padding:3px 9px; font-size:10.5px; color:var(--text-2); }
.chip b { color:var(--text); font-weight:700; }
/* evidence */
.evidence-card { background:var(--bg-2); border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin:6px 0; }
.evidence-metric { font:700 15px/1 ui-monospace,Menlo,monospace; color:var(--text); }
.evidence-delta { font:600 11px/1 ui-monospace,Menlo,monospace; }
.stamp { margin-top:10px; color:var(--text-3); font-size:10px; text-align:right; font-family:ui-monospace,Menlo,monospace; }
/* preview modal */
.overlay { position:fixed; inset:0; background:rgba(10,15,30,.55); z-index:10000; display:flex; align-items:center; justify-content:center; padding:40px; }
.modal { background:var(--bg-2); border:1px solid var(--border); border-radius:12px; max-width:740px; max-height:72vh; overflow:auto; padding:14px 16px; color:var(--text); font:12px/1.5 system-ui,sans-serif; box-shadow:0 20px 70px rgba(10,15,30,.4); }
.modal-header { font:700 12px/1.4 system-ui,sans-serif; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; gap:10px; }
.modal pre { white-space:pre-wrap; word-break:break-all; font-family:ui-monospace,Menlo,monospace; font-size:11px; margin:0; color:var(--text); }
.modal img, .modal embed { max-width:100%; max-height:60vh; background:#fff; border-radius:8px; }
.warn { background:var(--tone-red-bg); color:var(--tone-red); border-radius:8px; padding:7px 10px; margin-top:8px; font-size:11px; }
.dl { color:var(--accent); text-decoration:underline; font-size:11px; }
.artifact-row { display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px dashed var(--border-2); cursor:pointer; border-radius:6px; }
.artifact-row:hover { background:var(--bg-hover); }
.artifact-row:last-child { border-bottom:0; }
.artifact-kind { font:600 9.5px/1.6 ui-monospace,Menlo,monospace; color:var(--text-2); background:var(--bg-3); border:1px solid var(--border); border-radius:5px; padding:1px 6px; flex-shrink:0; }
/* dsh-web-style layout: left workspace sidebar + main column */
.panel.row { flex-direction: row; }
.main { flex:1; display:flex; flex-direction:column; min-width:0; }
.sidebar { width:230px; flex-shrink:0; display:flex; flex-direction:column; background:var(--bg-3); border-right:1px solid var(--border); overflow:hidden; }
.sidebar-head { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid var(--border); }
.sidebar-title { font:700 11px/1 system-ui,sans-serif; color:var(--text-2); letter-spacing:.8px; text-transform:uppercase; }
.sidebar-new { border:1px solid var(--border); background:var(--bg-2); color:var(--text); border-radius:8px; padding:3px 10px; cursor:pointer; font:600 11px/1.6 system-ui,sans-serif; }
.sidebar-new:hover { background:var(--bg-hover); border-color:var(--border-strong); }
.sidebar-list { flex:1; overflow-y:auto; padding:6px; scrollbar-width:thin; scrollbar-color:var(--border) transparent; }
.ws-item { display:flex; align-items:center; gap:8px; width:100%; border:0; background:none; color:var(--text); text-align:left; padding:8px 10px; border-radius:8px; cursor:pointer; margin-bottom:2px; }
.ws-item:hover { background:var(--bg-hover); }
.ws-item.active { background:var(--accent-soft); box-shadow:inset 2px 0 0 var(--accent); }
.ws-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; background:var(--tone-slate); }
.ws-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:600 12px/1.3 system-ui,sans-serif; }
.ws-status { font:600 8.5px/1 ui-monospace,Menlo,monospace; color:var(--text-3); letter-spacing:.3px; flex-shrink:0; }
.sidebar-foot { padding:10px 12px; border-top:1px solid var(--border); color:var(--text-3); font-size:10px; }
.sidebar.collapsed { width:44px; }
.sidebar.collapsed .sidebar-head { justify-content:center; padding:12px 6px; }
.sidebar.collapsed .sidebar-title, .sidebar.collapsed .sidebar-new, .sidebar.collapsed .sidebar input,
.sidebar.collapsed .ws-name, .sidebar.collapsed .ws-status, .sidebar.collapsed .sidebar-foot { display:none; }
.sidebar.collapsed .ws-item { justify-content:center; padding:8px 0; }
.sidebar.collapsed .ws-dot { width:10px; height:10px; }
.main.expanded { flex:1; }
`
  root.appendChild(style)

  const panel = el('div', 'panel')
  root.appendChild(panel)

  // Fullscreen (standalone) mode uses a dsh-web-style layout: a left
  // workspace sidebar (project list) + a main column (header, top tabs,
  // body). The floating mode keeps the compact picker + tabs column.
  const main = fullscreen ? el('div', 'main') : panel
  let sidebar: HTMLElement | null = null
  if (fullscreen) {
    panel.classList.add('row')
    sidebar = el('div', 'sidebar')
    panel.appendChild(sidebar)
    panel.appendChild(main)
  }

  // ── header ──
  const header = el('div', 'header')
  header.appendChild(el('span', 'logo', '🧪'))
  header.appendChild(el('span', 'title', 'Research OS'))
  const spacer = el('span', 'spacer')
  header.appendChild(spacer)
  const themeBtn = el('button', 'hbtn')
  const paintTheme = (): void => {
    const dark = host.dataset.theme === 'dark'
    themeBtn.textContent = dark ? '☀️ Light' : '🌙 Dark'
    themeBtn.title = dark ? 'switch to light theme' : 'switch to dark theme'
  }
  themeBtn.onclick = () => {
    host.dataset.theme = host.dataset.theme === 'dark' ? 'light' : 'dark'
    writeTheme(host.dataset.theme)
    paintTheme()
  }
  paintTheme()
  const refresh = el('button', 'hbtn', '⟳ Refresh')
  refresh.title = 'refresh now'
  const close = el('button', 'hbtn ghost', '×')
  close.title = 'collapse'
  close.onclick = () => { panel.style.display = 'none' }
  const commandsBtn = el('button', 'hbtn', '⌘ Commands')
  commandsBtn.title = 'browse /research commands'
  commandsBtn.onclick = () => { openCommandsModal(root) }
  const modeBadge = el('span', 'hbtn')
  modeBadge.textContent = '🧭 gate-only'
  modeBadge.title = 'research mode: every gate requires a human decision'
  modeBadge.style.cssText = 'cursor:default;opacity:.9'
  // dsh-web "Collapse sidebar": toggles the workspace sidebar width.
  let sidebarCollapsed = false
  const sidebarToggle = el('button', 'hbtn', '◧')
  sidebarToggle.title = 'collapse / expand sidebar'
  sidebarToggle.onclick = () => {
    sidebarCollapsed = !sidebarCollapsed
    if (sidebar !== null) sidebar.classList.toggle('collapsed', sidebarCollapsed)
    if (main !== null) main.classList.toggle('expanded', sidebarCollapsed)
    sidebarToggle.textContent = sidebarCollapsed ? '◨' : '◧'
    void render()
  }
  if (fullscreen) {
    // Standalone mode: project creation lives in the sidebar.
    header.append(sidebarToggle, modeBadge, commandsBtn, themeBtn, refresh)
  } else {
    header.append(themeBtn, refresh, close)
  }
  main.appendChild(header)

  // ── tabs ──
  const tabs = el('div', 'tabs')
  const TAB_DEFS = [
    ['chat', '💬 Chat'], ['phase', 'Phase'], ['gates', 'Gates'], ['runs', 'Runs'],
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
  main.appendChild(tabs)

  // ── body + picker ──
  const body = el('div', 'body')
  main.appendChild(body)
  const picker = el('select', 'picker')
  picker.style.cssText = 'margin:10px 12px 0;width:calc(100% - 24px)'
  picker.onchange = () => { projectId = picker.value || undefined; void render() }
  if (!fullscreen) main.insertBefore(picker, body)

  const styleTabs = (): void => {
    for (const [key, button] of tabButtons) button.classList.toggle('active', key === activeTab)
  }

  const render = async (): Promise<void> => {
    styleTabs()
    // Project list: drives the sidebar (fullscreen) or the picker (float).
    const projects = (await api<ProjectRow[]>('/v1/projects')) ?? []
    if (fullscreen && sidebar !== null) {
      renderSidebar(sidebar, projects, projectId, (id) => { projectId = id; void render() })
    } else {
      // Rebuild when empty, when there is no active project, or when the
      // active project id is not among the options (chat /research new
      // creates projects outside the picker's own onchange).
      const hasActive = projectId !== undefined && [...picker.options].some(o => o.value === projectId)
      if (picker.options.length === 0 || projectId === undefined || !hasActive) {
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
    if (!fullscreen) {
      // Keep the picker in sync with the active project (the chat /research
      // new command switches it outside the picker's own onchange).
      picker.value = projectId ?? ''
    }
    body.replaceChildren()

    const title = el('div', 'project-title')
    const pname = el('span', 'pname', projection.project.name ?? projectId)
    const pid = el('span', 'pid', `${projectId} · rev ${projection.project.revision ?? 0}`)
    const statusPill = pill(projection.project.status)
    title.append(pname, statusPill, pid)
    body.appendChild(title)

    switch (activeTab) {
      case 'chat': await renderChat(body, target); break
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
  chatLoad()
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
      t.style.cssText = 'margin-top:4px;color:var(--text);font-size:11.5px'
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
      err.style.cssText = 'margin-top:4px;color:var(--tone-red);font-size:10.5px;word-break:break-all'
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
    stmt.style.cssText = 'margin-top:5px;color:var(--text);font-size:11.5px'
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
      delta.style.color = effect > 0 ? 'var(--tone-green)' : effect < 0 ? 'var(--tone-red)' : 'var(--tone-slate)'
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
  const color = ratio >= 1 ? 'var(--tone-red)' : ratio >= 0.8 ? 'var(--tone-amber)' : 'var(--accent)'
  fill.style.cssText = `width:${Math.max(ratio * 100, value > 0 ? 4 : 0)}%;background:${color};box-shadow:0 0 6px ${color}`
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
    input.style.cssText = 'width:100%;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:7px 10px;font:12px/1.4 system-ui,sans-serif;outline:none'
    input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
    input.onblur = () => { input.style.borderColor = 'var(--border)' }
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

/* ─────────────────────────── commands modal ─────────────────────────── */

const CHAT_COMMANDS: Array<[string, string]> = [
  ['new', '/research new demo1', 'create a project + Scope Gate'],
  ['list', '/research list', 'list all projects'],
  ['status', '/research status', 'phase, gates, jobs, budget of the active project'],
  ['survey', '/research survey temporal action localization', 'multi-source literature search + frozen snapshot'],
  ['ideas', '/research ideas', 'list IdeaCards of the active project'],
  ['gates', '/research gates', 'gate list + decisions of the active project'],
  ['jobs', '/research jobs', 'job list of the active project'],
  ['contract', '/research contract {"idea_id":"...","dataset_id":"fixture","baseline":"b","treatment":"a","primary_metric":"macro_f1","seeds":[11,23,47]}', 'pre-register an ExperimentContract'],
  ['run', '/research run {"kind":"echo","command":["echo","hi"]}', 'submit a durable runner job'],
  ['evidence', '/research evidence {"analysis_method":"bootstrap_95_mean_difference","result":{"primary_metric":"acc","value":0.9,"baseline_value":0.8,"effect_size":0.1,"ci_low":0.05,"ci_high":0.15,"n_seeds":3}}', 'ingest an EvidenceItem'],
  ['claims', '/research claims', 'claims + verification status'],
  ['write', '/research write', 'build the manuscript from the Evidence Ledger'],
  ['review', '/research review', 'deterministic reviewer checks'],
  ['export', '/research export', 'generate a private Release Bundle'],
  ['release', '/research release', 'create the human Release Gate'],
]

/**
 * dsh-web "Commands" palette: every /research command with a one-line
 * description. Clicking one switches to the Chat tab, fills the composer
 * and runs it.
 */
function openCommandsModal(root: ShadowRoot): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:560px;max-width:92vw'
  const header = el('div', 'modal-header', '⌘ Research Commands')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const hint = el('div', 'muted', 'Click a command to run it in the Chat tab (or type it there directly).')
  hint.style.cssText = 'margin-bottom:10px;font-size:11.5px'
  modal.appendChild(hint)

  const list = el('div')
  list.style.cssText = 'max-height:46vh;overflow-y:auto'
  for (const [name, line, desc] of CHAT_COMMANDS) {
    const row = el('button')
    row.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;border:0;background:none;color:var(--text);text-align:left;padding:8px 10px;border-radius:8px;cursor:pointer'
    row.onmouseenter = () => { row.style.background = 'var(--bg-hover)' }
    row.onmouseleave = () => { row.style.background = 'none' }
    const nameEl = el('span', 'artifact-kind', name.toUpperCase())
    const bodyEl = el('span', 'grow')
    bodyEl.style.cssText = 'min-width:0'
    const lineEl = el('div', 'mono', line)
    lineEl.style.cssText = 'font-size:10.5px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    const descEl = el('div', 'muted', desc)
    descEl.style.cssText = 'font-size:10.5px'
    bodyEl.append(lineEl, descEl)
    row.append(nameEl, bodyEl)
    row.onclick = () => {
      overlay.remove()
      chatDraft = line
      activeTab = 'chat'
      rerender()
    }
    list.appendChild(row)
  }
  modal.appendChild(list)
  overlay.appendChild(modal)
  root.appendChild(overlay)
}

/* ─────────────────────────── settings modal ─────────────────────────── */

/**
 * dsh-web "Settings" counterpart: connection status (kernel health +
 * endpoint), access token state, theme and conversation controls. Reads
 * live kernel health through the bridge.
 */
async function openSettingsModal(root: ShadowRoot): Promise<void> {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'
  const header = el('div', 'modal-header', '⚙ Settings')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const section = (title: string): HTMLElement => {
    const label = el('div', 'section-label', title)
    label.style.cssText = 'margin-top:14px'
    return label
  }
  const row = (label: string, value: string, valueClass = 'mono'): void => {
    const r = el('div', 'row')
    r.style.cssText = 'padding:4px 0'
    const l = el('span', '', label)
    l.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
    const v = el('span', valueClass, value)
    v.style.cssText = 'font-size:11px;color:var(--text);word-break:break-all'
    r.append(l, v)
    modal.appendChild(r)
  }

  // Connection: live kernel health through the bridge.
  modal.appendChild(section('Connection'))
  const healthRow = el('div', 'row')
  healthRow.style.cssText = 'padding:4px 0'
  const healthLabel = el('span', '', 'Kernel')
  healthLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const healthValue = el('span', 'mono', 'checking…')
  healthValue.style.cssText = 'font-size:11px'
  healthRow.append(healthLabel, healthValue)
  modal.appendChild(healthRow)
  const health = await api<{ ok?: boolean; instance?: string }>('/v1/health')
  if (health === null || health.ok !== true) {
    healthValue.textContent = 'unreachable'
    healthValue.style.color = 'var(--tone-red)'
  } else {
    healthValue.textContent = `connected · ${health.instance ?? ''}`
    healthValue.style.color = 'var(--tone-green)'
  }
  row('Bridge', 'same-origin /v1 proxy')
  row('Auth', tokenProvider !== undefined ? 'bearer token (session)' : 'DSH boot token')

  // Access token (standalone only).
  if (tokenProvider !== undefined) {
    modal.appendChild(section('Access'))
    const tokRow = el('div', 'row')
    tokRow.style.cssText = 'padding:4px 0'
    const tokLabel = el('span', '', 'Token')
    tokLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
    const tokValue = el('span', 'mono', '••••••••')
    tokValue.style.cssText = 'font-size:11px'
    const reveal = el('button', 'hbtn', 'Show')
    reveal.style.cssText = 'padding:1px 8px'
    reveal.onclick = async () => {
      const t = await tokenProvider()
      tokValue.textContent = t ?? '(none)'
      reveal.remove()
    }
    tokRow.append(tokLabel, tokValue, reveal)
    modal.appendChild(tokRow)
  }

  // Appearance.
  modal.appendChild(section('Appearance'))
  const themeRow = el('div', 'row')
  themeRow.style.cssText = 'padding:4px 0'
  const themeLabel = el('span', '', 'Theme')
  themeLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const themeValue = el('span', 'mono', readTheme() === 'dark' ? 'dark' : 'light')
  themeValue.style.cssText = 'font-size:11px'
  const themeToggle = el('button', 'hbtn', 'Toggle')
  themeToggle.style.cssText = 'padding:1px 8px'
  themeToggle.onclick = () => {
    const next = readTheme() === 'dark' ? 'light' : 'dark'
    writeTheme(next)
    const hostEl = root.host as HTMLElement
    hostEl.dataset.theme = next
    themeValue.textContent = next
    // Refresh the header button label too.
    document.dispatchEvent(new Event('dsh-scholar-theme-changed'))
  }
  themeRow.append(themeLabel, themeValue, themeToggle)
  modal.appendChild(themeRow)

  // Conversation.
  modal.appendChild(section('Conversation'))
  const convRow = el('div', 'row')
  convRow.style.cssText = 'padding:4px 0'
  const convLabel = el('span', '', 'Transcript')
  convLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const convValue = el('span', 'mono', `${chatMessages.length} messages`)
  convValue.style.cssText = 'font-size:11px'
  const clearBtn = el('button', 'hbtn', 'Clear')
  clearBtn.style.cssText = 'padding:1px 8px'
  clearBtn.onclick = () => {
    chatClear()
    convValue.textContent = '0 messages'
    rerender()
  }
  convRow.append(convLabel, convValue, clearBtn)
  modal.appendChild(convRow)

  const about = el('div', 'muted', 'DSH Scholar · Research OS standalone web plugin · v0.2 hardening')
  about.style.cssText = 'margin-top:16px;font-size:10.5px'
  modal.appendChild(about)

  overlay.appendChild(modal)
  root.appendChild(overlay)
}

/* ─────────────────────────── Chat (dialogue) tab ─────────────────────────── */

/**
 * Chat transcript + built-in /research command executor. Mirrors the dsh web
 * dialogue feel (message bubbles + composer) while talking straight to the
 * Kernel API through the same bridge the panels use — no agent loop needed.
 * The composer persists across 8s panel refreshes via chatDraft.
 */
interface ChatMessage {
  role: 'user' | 'assistant' | 'error'
  text: string
  time: string
}

let chatMessages: ChatMessage[] = []
let chatDraft = ''
const CHAT_STORAGE_KEY = 'dsh-scholar-ui-chat'
const CHAT_MAX = 200

/** Restore the transcript persisted in localStorage (dsh-web session feel). */
function chatLoad(): void {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY)
    if (raw === null) return
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      chatMessages = parsed
        .filter((m): m is ChatMessage => typeof m === 'object' && m !== null
          && typeof (m as ChatMessage).role === 'string'
          && (m as ChatMessage).role in { user: 1, assistant: 1, error: 1 }
          && typeof (m as ChatMessage).text === 'string')
        .slice(-CHAT_MAX)
    }
  } catch { /* corrupt or private mode */ }
}

function chatPersist(): void {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatMessages.slice(-CHAT_MAX)))
  } catch { /* private mode */ }
}

function chatClear(): void {
  chatMessages = []
  chatPersist()
}

function chatPush(role: ChatMessage['role'], text: string): void {
  chatMessages.push({ role, text, time: new Date().toLocaleTimeString() })
  chatPersist()
}

function fmtProjectRow(p: { project_id?: string; name?: string; status?: string }): string {
  return `- **${p.name ?? '?'}** (\`${p.project_id ?? '?'}\`) — ${p.status ?? '?'}`
}

/** Parse `key=value` pairs from a JSON-ish argument string. */
function chatJsonArg(rest: string): Record<string, unknown> | null {
  const start = rest.indexOf('{')
  if (start < 0) return null
  try {
    const parsed = JSON.parse(rest.slice(start)) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * Execute one chat line: either a /research subcommand or a bare word that
 * maps to one. Returns the assistant answer text.
 */
async function executeChatCommand(line: string, activeProjectId: string | undefined): Promise<string> {
  const trimmed = line.trim().replace(/^\/research\s+/i, '').replace(/^\//, '')
  const parts = trimmed.split(/\s+/)
  const sub = (parts[0] ?? '').toLowerCase()
  const rest = trimmed.slice(sub.length).trim()

  switch (sub) {
    case '':
    case 'help': {
      return 'Commands:\n'
        + '  /research new <name> [json]      create project + Scope Gate\n'
        + '  /research list                   all projects\n'
        + '  /research status [project_id]    phase, gates, jobs, budget\n'
        + '  /research survey <query>         multi-source search + snapshot\n'
        + '  /research ideas                  IdeaCards\n'
        + '  /research gates [project_id]     gate list + decisions\n'
        + '  /research jobs [project_id]      job list\n'
        + '  /research contract <json>        pre-register a contract\n'
        + '  /research run <json>             submit a job\n'
        + '  /research evidence <json>        ingest evidence\n'
        + '  /research claims [project_id]    claims + verification status\n'
        + '  /research write / review / export / release\n'
        + '\nTry: /research new demo1 or /research status'
    }
    case 'new': {
      const name = parts[1] ?? ''
      if (name === '') return 'usage: /research new <name> [json]'
      const json = chatJsonArg(rest)
      const brief = {
        problem: String(json?.problem ?? 'To be specified in the Scope Gate.'),
        scope: String(json?.scope ?? 'To be specified in the Scope Gate.'),
        questions: Array.isArray(json?.questions) ? json.questions.map(String) : [],
        primary_metrics: Array.isArray(json?.primary_metrics) ? json.primary_metrics.map(String) : [],
        resources: String(json?.resources ?? ''),
        risks: [],
        target_outputs: ['conference-paper'],
        target_venue: null,
        baseline_repo: null,
        domain: 'machine-learning',
      }
      const project = await api<{ project_id?: string; name?: string; status?: string }>('/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ name, workspace: `/research/${name}`, brief, mode: 'gate-only' }),
      })
      if (project === null || project.project_id === undefined) return 'create failed — kernel unreachable?'
      await api(`/v1/projects/${encodeURIComponent(project.project_id)}/gates`, {
        method: 'POST',
        body: JSON.stringify({ type: 'scope', title: `Scope Gate — ${name}`, summary: 'Approve the research scope, data policy, budget and target venue.' }),
      })
      projectId = project.project_id
      void rerender()
      return `Project **${project.project_id}** (${name}) created — DRAFT.\nScope Gate opened: approve it in the Gates tab (human only).`
    }
    case 'list': {
      const projects = (await api<Array<{ project_id?: string; name?: string; status?: string }>>('/v1/projects')) ?? []
      if (projects.length === 0) return 'No projects yet — try /research new demo1'
      return `Projects (${projects.length}):\n${projects.map(fmtProjectRow).join('\n')}`
    }
    case 'status': {
      const id = parts[1] ?? activeProjectId
      if (id === undefined) return 'No project selected — /research new <name> or /research status <project_id>'
      const p = await api<Projection>(`/v1/projects/${encodeURIComponent(id)}/projection`)
      if (p === null || p.project === undefined) return `project ${id} not found`
      const pending = (p.pending_gates ?? []).map(g => `- ${g.type} gate ${g.gate_id}: ${g.title} (${g.status})`).join('\n') || 'none'
      const jobs = (p.jobs ?? []).slice(-5).map(j => `- ${j.job_id} [${j.kind}] ${j.status}`).join('\n') || 'none'
      return `**${p.project.name}** (\`${id}\`) — phase \`${p.project.status}\` rev ${p.project.revision ?? 0}\n\n`
        + `Next actions:\n${(p.next_actions ?? []).map(a => `- ${a}`).join('\n') || 'none'}\n\n`
        + `Pending gates:\n${pending}\n\n`
        + `Recent jobs:\n${jobs}\n\n`
        + `Budget: $${p.budget?.model_cost_usd ?? 0} / ${p.project.constraints?.max_model_cost_usd ?? '∞'} max, `
        + `${p.budget?.gpu_hours ?? 0} / ${p.project.constraints?.max_gpu_hours ?? '∞'} GPU-h`
    }
    case 'survey': {
      const query = rest.trim()
      if (query === '') return 'usage: /research survey <query>'
      if (activeProjectId === undefined) return 'No project selected — /research new <name> first'
      const response = await fetch(`${base()}/api/chat/survey`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ project_id: activeProjectId, query }),
      })
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '')
        return `survey unavailable on this host (${response.status} ${bodyText.slice(0, 120)})`
      }
      const result = (await response.json()) as { snapshot_id?: string; papers?: number; removed?: number; top?: Array<{ paper_id: string; title: string; year?: number }> }
      const top = (result.top ?? []).slice(0, 5).map(h => `- ${h.paper_id}: ${h.title} (${h.year ?? 'n.d.'})`).join('\n')
      return `Survey complete: **${result.snapshot_id}** — ${result.papers ?? 0} papers after dedup (${result.removed ?? 0} removed).\n\nTop hits:\n${top}\n\nNext: /research ideas`
    }
    case 'ideas': {
      if (activeProjectId === undefined) return 'No project selected — /research new <name> first'
      const ideas = (await api<Array<Record<string, unknown>>>(`/v1/projects/${encodeURIComponent(activeProjectId)}/ideas`)) ?? []
      if (ideas.length === 0) return 'No IdeaCards yet — create them with the idea_create tool, then novelty_audit before the Idea Gate.'
      return `IdeaCards:\n${ideas.map(i => `- \`${String(i.idea_id)}\` [${String(i.status ?? '')}] ${String(i.title ?? '')}`).join('\n')}`
    }
    case 'gates': {
      const id = parts[1] ?? activeProjectId
      if (id === undefined) return 'No project selected'
      const gates = (await api<GateRow[]>(`/v1/projects/${encodeURIComponent(id)}/gates`)) ?? []
      if (gates.length === 0) return 'No gates yet.'
      return `Gates:\n${gates.map(g => `- ${g.type} \`${g.gate_id}\` [${g.status}] ${g.title ?? ''}`).join('\n')}`
    }
    case 'jobs': {
      const id = parts[1] ?? activeProjectId
      if (id === undefined) return 'No project selected'
      const jobs = (await api<Array<{ job_id?: string; kind?: string; status?: string }>>(`/v1/projects/${encodeURIComponent(id)}/jobs`)) ?? []
      if (jobs.length === 0) return 'No jobs yet.'
      return `Jobs:\n${jobs.map(j => `- \`${j.job_id}\` [${j.kind}] ${j.status}`).join('\n')}`
    }
    case 'contract': {
      if (activeProjectId === undefined) return 'No project selected'
      const json = chatJsonArg(rest)
      if (json === null) return 'usage: /research contract {"idea_id":"...","dataset_id":"...","baseline":"b","treatment":"a","primary_metric":"m","seeds":[11,23,47]}'
      const seeds = Array.isArray(json.seeds) ? json.seeds.map(Number) : [11, 23, 47]
      const c = await api<{ contract_id?: string; status?: string }>(`/v1/projects/${encodeURIComponent(activeProjectId)}/contracts`, {
        method: 'POST',
        body: JSON.stringify({
          idea_id: String(json.idea_id ?? ''),
          data: { dataset_id: String(json.dataset_id ?? ''), version: 'official', split: 'official' },
          methods: { baseline: String(json.baseline ?? ''), treatment: String(json.treatment ?? '') },
          metrics: { primary: String(json.primary_metric ?? ''), secondary: [] },
          seeds,
          analysis: { effect_size: 'mean_difference', interval: 'bootstrap_95', multiple_testing: 'holm' },
          ablations: [],
          stop_conditions: { max_gpu_hours: 48, min_completed_seeds: seeds.length, stop_on_data_leakage: true },
        }),
      })
      if (c === null || c.contract_id === undefined) return 'contract registration failed'
      return `Contract **${c.contract_id}** registered — approve it in the Gates tab (human).`
    }
    case 'run': {
      if (activeProjectId === undefined) return 'No project selected'
      const json = chatJsonArg(rest)
      if (json === null || !Array.isArray(json.command)) return 'usage: /research run {"kind":"echo","command":["echo","hi"]}'
      const kind = String(json.kind ?? 'echo')
      const job = await api<{ job_id?: string; status?: string }>(`/v1/projects/${encodeURIComponent(activeProjectId)}/jobs`, {
        method: 'POST',
        body: JSON.stringify({
          idempotency_key: String(json.idempotency_key ?? `chat-${Date.now()}`),
          kind,
          command: json.command.map(String),
          payload: { message: `chat /research run ${kind}` },
          contract_id: typeof json.contract_id === 'string' ? json.contract_id : null,
        }),
      })
      if (job === null || job.job_id === undefined) return 'job submission failed'
      return `Job **${job.job_id}** [${kind}] submitted (${job.status}). Watch it in the Runs tab.`
    }
    case 'evidence': {
      if (activeProjectId === undefined) return 'No project selected'
      const json = chatJsonArg(rest)
      if (json === null || typeof json.analysis_method !== 'string') {
        return 'usage: /research evidence {"analysis_method":"bootstrap_95_mean_difference","result":{"primary_metric":"acc","value":0.9,"baseline_value":0.8,"effect_size":0.1,"ci_low":0.05,"ci_high":0.15,"n_seeds":3}}'
      }
      const ev = await api<{ evidence_id?: string }>(`/v1/projects/${encodeURIComponent(activeProjectId)}/evidence`, {
        method: 'POST',
        body: JSON.stringify({
          source_type: 'analysis',
          run_ids: Array.isArray(json.run_ids) ? json.run_ids.map(String) : [],
          artifact_refs: Array.isArray(json.artifact_refs) ? json.artifact_refs.map(String) : [],
          analysis_method: json.analysis_method,
          result: (json.result ?? {}) as Record<string, unknown>,
          provenance_status: 'draft_unverified',
        }),
      })
      if (ev === null || ev.evidence_id === undefined) return 'evidence ingestion failed'
      return `Evidence **${ev.evidence_id}** ingested (draft_unverified — only the Analysis Worker can verify).`
    }
    case 'claims': {
      const id = parts[1] ?? activeProjectId
      if (id === undefined) return 'No project selected'
      const claims = (await api<ClaimRow[]>(`/v1/projects/${encodeURIComponent(id)}/claims`)) ?? []
      if (claims.length === 0) return 'No claims yet.'
      return `Claims:\n${claims.map(c => `- \`${c.claim_id}\` [${c.status}] ${(c.statement ?? '').slice(0, 70)}`).join('\n')}`
    }
    case 'write': {
      if (activeProjectId === undefined) return 'No project selected'
      const draft = await api<{ manuscript_id?: string; claims_used?: number }>(`/v1/projects/${encodeURIComponent(activeProjectId)}/manuscripts/build`, {
        method: 'POST',
        body: JSON.stringify({ format: 'markdown', include_limitations: true }),
      })
      if (draft === null || draft.manuscript_id === undefined) return 'manuscript build failed'
      return `Manuscript **${draft.manuscript_id}** built (${draft.claims_used ?? 0} supported claims).`
    }
    case 'review': {
      if (activeProjectId === undefined) return 'No project selected'
      const review = await api<{ pass?: boolean; checks?: Array<{ check?: string; status?: string; detail?: string }> }>(`/v1/projects/${encodeURIComponent(activeProjectId)}/manuscript-review`)
      if (review === null) return 'review failed'
      const checks = (review.checks ?? []).map(c => `- [${c.status}] ${c.check}: ${c.detail}`).join('\n')
      return `Reviewer: ${review.pass === true ? 'PASS' : 'SEE CHECKS'}\n${checks}`
    }
    case 'export': {
      if (activeProjectId === undefined) return 'No project selected'
      const bundle = await api<{ bundle_id?: string }>(`/v1/projects/${encodeURIComponent(activeProjectId)}/release-bundle`, { method: 'POST' })
      if (bundle === null || bundle.bundle_id === undefined) return 'export failed'
      return `Release bundle **${bundle.bundle_id}** generated (private export, not publication).`
    }
    case 'release': {
      if (activeProjectId === undefined) return 'No project selected'
      const gate = await api<{ gate_id?: string }>(`/v1/projects/${encodeURIComponent(activeProjectId)}/gates`, {
        method: 'POST',
        body: JSON.stringify({ type: 'release', title: 'Release Gate — explicit human decision required', summary: 'Explicit human decision required: authors, licenses, public scope and target platform.' }),
      })
      if (gate === null || gate.gate_id === undefined) return 'release gate creation failed'
      return `Release Gate **${gate.gate_id}** created and left **pending** (human only).`
    }
    default:
      return `Unknown command: /research ${sub}. Try /research help`
  }
}

/** Sidebar search filter (dsh-web "Search sessions" feel). */
let sidebarQuery = ''
/** Sidebar grouping (dsh-web "Group by" feel): all | active | done. */
let sidebarGroup: 'all' | 'active' | 'done' = 'all'

/** Projects considered "active" (still in the research pipeline). */
function isProjectActive(status: string | undefined): boolean {
  return status !== 'RELEASED' && status !== 'ARCHIVED'
}

/**
 * dsh-web-style workspace sidebar: search box + group filter, one row per
 * project (name + status dot/label), the active one highlighted; a ＋
 * button creates a project.
 */
function renderSidebar(
  sidebar: HTMLElement,
  projects: ProjectRow[],
  activeId: string | undefined,
  onPick: (projectId: string) => void,
): void {
  sidebar.replaceChildren()
  const head = el('div', 'sidebar-head')
  head.appendChild(el('span', 'sidebar-title', 'Projects'))
  const newBtn = el('button', 'sidebar-new', '＋')
  newBtn.title = 'new project'
  newBtn.onclick = () => {
    const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
    if (root !== null) openNewProjectModal(root)
  }
  head.appendChild(newBtn)
  sidebar.appendChild(head)

  // Search box: filters the project rows in place (keeps input focus,
  // dsh-web "Search sessions" feel).
  const search = document.createElement('input')
  search.type = 'text'
  search.placeholder = '🔍 Search projects…'
  search.value = sidebarQuery
  search.style.cssText = 'margin:8px 10px 2px;padding:6px 10px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;font:11px/1.4 system-ui,sans-serif;outline:none'
  search.onfocus = () => { search.style.borderColor = 'var(--accent)' }
  search.onblur = () => { search.style.borderColor = 'var(--border)' }
  sidebar.appendChild(search)

  // Group by (dsh-web "Group by"): all / active / done.
  const groupRow = el('div')
  groupRow.style.cssText = 'display:flex;gap:4px;padding:4px 10px 6px'
  const GROUP_DEFS: Array<['all' | 'active' | 'done', string]> = [
    ['all', 'All'], ['active', 'Active'], ['done', 'Done'],
  ]
  for (const [key, label] of GROUP_DEFS) {
    const chip = el('button', 'sidebar-new')
    chip.textContent = label
    chip.style.cssText = 'flex:1;padding:3px 4px;font-size:10px;text-align:center'
    if (sidebarGroup === key) {
      chip.style.cssText += ';border-color:var(--accent);color:var(--accent-text);background:var(--accent-soft)'
    }
    chip.onclick = () => { sidebarGroup = key; renderSidebar(sidebar, projects, activeId, onPick) }
    groupRow.appendChild(chip)
  }
  sidebar.appendChild(groupRow)

  const list = el('div', 'sidebar-list')
  const renderRows = (): void => {
    list.replaceChildren()
    const q = sidebarQuery.trim().toLowerCase()
    let filtered = q === '' ? projects : projects.filter(p => (p.name ?? '').toLowerCase().includes(q) || (p.project_id ?? '').toLowerCase().includes(q))
    if (sidebarGroup === 'active') filtered = filtered.filter(p => isProjectActive(p.status))
    if (sidebarGroup === 'done') filtered = filtered.filter(p => !isProjectActive(p.status))
    if (filtered.length === 0) {
      const empty = el('div', 'empty', projects.length === 0 ? 'No projects yet.' : 'No matches.')
      empty.style.cssText = 'padding:10px 12px'
      list.appendChild(empty)
      return
    }
    for (const p of filtered) {
      const item = el('button', 'ws-item')
      if (p.project_id === activeId) item.classList.add('active')
      const tone = STATUS_META[p.status ?? '']?.tone ?? 'slate'
      const dot = el('span', 'ws-dot')
      dot.style.background = `var(--tone-${tone})`
      item.appendChild(dot)
      item.appendChild(el('span', 'ws-name', p.name ?? p.project_id ?? ''))
      item.appendChild(el('span', 'ws-status', STATUS_META[p.status ?? '']?.label ?? p.status ?? ''))
      item.onclick = () => { if (p.project_id !== undefined) onPick(p.project_id) }
      list.appendChild(item)
    }
  }
  search.oninput = () => { sidebarQuery = search.value; renderRows() }
  renderRows()
  sidebar.appendChild(list)

  const foot = el('div', 'sidebar-foot')
  foot.style.cssText = 'display:flex;align-items:center;gap:8px;justify-content:space-between'
  const footLabel = el('span', '', `${projects.length} projects`)
  const settingsBtn = el('button', 'hbtn', '⚙ Settings')
  settingsBtn.title = 'connection, token and appearance settings'
  settingsBtn.onclick = () => {
    const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
    if (root !== null) openSettingsModal(root)
  }
  foot.append(footLabel, settingsBtn)
  sidebar.appendChild(foot)
}

/**
 * Chat tab: message bubbles (dsh-web style) + a composer that runs
 * /research commands directly against the Kernel bridge. The transcript
 * survives 8s panel refreshes (chatMessages), as does the draft text.
 */
async function renderChat(body: HTMLElement, projectId: string): Promise<void> {
  const shell = el('div')
  shell.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:420px'

  const stream = el('div')
  stream.style.cssText = 'flex:1;overflow-y:auto;padding:4px 2px;display:flex;flex-direction:column;gap:8px'
  if (chatMessages.length === 0) {
    chatPush('assistant', 'Welcome to **Research OS**.\n\nType a command below, e.g. `/research status` or `/research new demo1` — or `/research help` for the full list.')
  }
  for (const msg of chatMessages) {
    const bubble = el('div')
    bubble.style.cssText = msg.role === 'user'
      ? 'align-self:flex-end;background:var(--accent);color:#fff;border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;word-break:break-word;font-size:12px'
      : msg.role === 'error'
        ? 'align-self:flex-start;background:var(--tone-red-bg);color:var(--tone-red);border:1px solid var(--tone-red);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;word-break:break-word;font-size:12px'
        : 'align-self:flex-start;background:var(--bg-2);border:1px solid var(--border);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;word-break:break-word;font-size:12px'
    // Rich line rendering (headings/lists/code/bold) — textContent-safe.
    bubble.replaceChildren(...formatChatText(msg.text))
    stream.appendChild(bubble)
    const stamp = el('div')
    stamp.style.cssText = msg.role === 'user'
      ? 'align-self:flex-end;color:var(--text-3);font-size:9px;margin-top:-4px'
      : 'align-self:flex-start;color:var(--text-3);font-size:9px;margin-top:-4px'
    stamp.textContent = msg.time
    stream.appendChild(stamp)
  }
  shell.appendChild(stream)

  // Composer (persists across refreshes via chatDraft) + session actions.
  const composerRow = el('div')
  composerRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:10px'
  const composer = el('div')
  composer.style.cssText = 'flex:1;display:flex;gap:8px'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = '/research status — type a command'
  input.value = chatDraft
  input.style.cssText = 'flex:1;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:9px;padding:8px 11px;font:12px/1.4 ui-monospace,Menlo,monospace;outline:none'
  input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
  input.onblur = () => { input.style.borderColor = 'var(--border)' }
  input.oninput = () => {
    chatDraft = input.value
    renderCompletions()
  }
  // dsh-web "/" command completion: a small suggestion list under the
  // composer while the draft starts with "/" (or "/research ").
  const completionBox = el('div')
  completionBox.style.cssText = 'display:none;flex-direction:column;margin-top:6px;border:1px solid var(--border);border-radius:8px;background:var(--bg-2);overflow:hidden'
  const renderCompletions = (): void => {
    const draft = input.value.trim()
    const match = /^\/(?:research\s+)?([a-z]*)$/i.exec(draft)
    if (match === null || draft.startsWith('/research ')) {
      completionBox.style.display = 'none'
      return
    }
    const prefix = (match[1] ?? '').toLowerCase()
    const hits = CHAT_COMMANDS.filter(([name]) => name.startsWith(prefix)).slice(0, 7)
    if (hits.length === 0) {
      completionBox.style.display = 'none'
      return
    }
    completionBox.replaceChildren()
    for (const [name, line] of hits) {
      const row = el('button')
      row.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;color:var(--text);text-align:left;padding:6px 10px;cursor:pointer;font:11px/1.4 ui-monospace,Menlo,monospace'
      row.onmouseenter = () => { row.style.background = 'var(--bg-hover)' }
      row.onmouseleave = () => { row.style.background = 'none' }
      row.appendChild(el('span', 'artifact-kind', `/${name}`))
      row.appendChild(el('span', 'grow', line.slice(0, 46)))
      row.onclick = () => {
        input.value = `/${name} `
        chatDraft = input.value
        completionBox.style.display = 'none'
        input.focus()
      }
      completionBox.appendChild(row)
    }
    completionBox.style.display = 'flex'
  }
  const send = el('button', 'btn approve', 'Send')
  send.style.cssText = 'padding:7px 16px;border-radius:9px'
  const run = async (): Promise<void> => {
    const line = input.value.trim()
    if (line === '') return
    input.value = ''
    chatDraft = ''
    completionBox.style.display = 'none'
    chatPush('user', line)
    try {
      const answer = await executeChatCommand(line, projectId)
      chatPush('assistant', answer)
    } catch (error) {
      chatPush('error', `command failed: ${(error as Error).message}`)
    }
    rerender()
  }
  send.onclick = () => { void run() }
  input.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      // Enter while a completion is open fills the highlighted row instead
      // of sending (first row default).
      if (completionBox.style.display === 'flex') {
        const first = completionBox.querySelector('button')
        if (first !== null) {
          first.click()
          return
        }
      }
      void run()
    } else if (event.key === 'Escape') {
      completionBox.style.display = 'none'
    }
  }
  composer.append(input, send)
  // dsh-web "session actions": clear this conversation.
  const clear = el('button', 'hbtn', '🗑')
  clear.title = 'clear conversation'
  clear.onclick = () => {
    chatClear()
    rerender()
  }
  composerRow.append(composer, clear)
  shell.appendChild(composerRow)
  shell.appendChild(completionBox)

  body.appendChild(shell)
}

/**
 * Rich line rendering for chat bubbles: ## headings, - bullets, ``` code
 * fences, **bold** and `code` spans — all built with textContent-only
 * nodes (design §15.4).
 */
function formatChatText(text: string): HTMLElement[] {
  const nodes: HTMLElement[] = []
  const lines = text.split('\n')
  let inFence = false
  let fence: HTMLElement | null = null
  const flushFence = (): void => {
    if (fence !== null) {
      nodes.push(fence)
      fence = null
    }
    inFence = false
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^```/.test(line)) {
      if (inFence) {
        flushFence()
      } else {
        inFence = true
        fence = el('pre')
        fence.style.cssText = 'background:var(--bg-3);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font:10.5px/1.5 ui-monospace,Menlo,monospace;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:4px 0'
        const lang = line.slice(3).trim()
        if (lang !== '') {
          const langTag = el('div', 'artifact-kind', lang.toUpperCase())
          langTag.style.cssText += ';display:inline-block;margin-bottom:4px'
          fence.appendChild(langTag)
        }
      }
      continue
    }
    if (inFence && fence !== null) {
      fence.appendChild(document.createTextNode(line + '\n'))
      continue
    }
    if (/^#{1,3}\s/.test(line)) {
      const h = el('div')
      h.style.cssText = `font:700 ${line.startsWith('###') ? 11.5 : 12.5}px/1.4 system-ui,sans-serif;color:var(--text);margin:6px 0 3px`
      h.append(...inlineChatText(line.replace(/^#{1,3}\s+/, '')))
      nodes.push(h)
      continue
    }
    if (/^[-*•]\s+/.test(line)) {
      const row = el('div')
      row.style.cssText = 'display:flex;gap:7px;padding:1px 0'
      row.appendChild(el('span', '', '•'))
      const content = el('span', '', '')
      content.append(...inlineChatText(line.replace(/^[-*•]\s+/, '')))
      row.appendChild(content)
      nodes.push(row)
      continue
    }
    if (/^\d+\.\s+/.test(line)) {
      const row = el('div')
      row.style.cssText = 'display:flex;gap:7px;padding:1px 0'
      row.appendChild(el('span', '', line.match(/^\d+\./)?.[0] ?? '•'))
      const content = el('span', '', '')
      content.append(...inlineChatText(line.replace(/^\d+\.\s+/, '')))
      row.appendChild(content)
      nodes.push(row)
      continue
    }
    if (line.trim() === '') {
      nodes.push(el('div', '', '\u00a0'))
      continue
    }
    nodes.push(el('div', '', ...inlineChatText(line)))
  }
  flushFence()
  return nodes
}

/** Inline **bold** + `code` spans (shared by every line kind). */
function inlineChatText(text: string): HTMLElement[] {
  const nodes: HTMLElement[] = []
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  for (const part of parts) {
    if (part === '') continue
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      nodes.push(el('strong', '', part.slice(2, -2)))
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const code = el('code', '', part.slice(1, -1))
      code.style.cssText = 'background:var(--bg-3);border:1px solid var(--border);border-radius:4px;padding:0 4px;font:10.5px/1.4 ui-monospace,Menlo,monospace'
      nodes.push(code)
    } else {
      nodes.push(el('span', '', part))
    }
  }
  return nodes
}
