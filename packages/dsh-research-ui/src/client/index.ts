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
    brief?: { problem?: string; primary_metrics?: string[] }
    constraints?: { max_model_cost_usd?: number; max_gpu_hours?: number; max_parallel_jobs?: number; datasets?: string; external_model_upload?: string }
    execution?: { runner_profile?: string; network_policy?: string; artifact_store?: string }
    integrity?: { require_baseline_reproduction?: boolean; require_experiment_contract?: boolean; require_claim_evidence_links?: boolean; require_clean_room_rerun?: boolean; allow_automatic_public_release?: boolean }
    history?: string[]
  }
  pending_gates?: Array<{ gate_id?: string; type?: string; title?: string; summary?: string; status?: string }>
  jobs?: Array<{ job_id?: string; kind?: string; status?: string; error?: string; contract_id?: string | null }>
  budget?: { model_cost_usd?: number; gpu_hours?: number; api_requests?: number }
  counts?: { ideas?: number; contracts?: number; claims?: number; evidence?: number; artifacts?: number; corpus_snapshots?: number }
  next_actions?: string[]
}

interface ClaimRow { claim_id?: string; statement?: string; status?: string; confidence?: string; scope?: { dataset?: string; split?: string }; evidence?: { evidence_ids?: string[]; analysis_artifact?: string }; limitations?: string[]; history?: Array<{ status?: string; at?: string; reason?: string }> }
interface EvidenceRow { evidence_id?: string; analysis_method?: string; result?: { primary_metric?: string; value?: number; effect_size?: number; ci_low?: number; ci_high?: number; n_seeds?: number }; artifact_refs?: string[]; run_ids?: string[] }
interface ArtifactRow { artifact_id?: string; kind?: string; size_bytes?: number; metadata?: Record<string, unknown> }
interface GateRow { gate_id?: string; type?: string; title?: string; status?: string; summary?: string }
interface ProjectRow { project_id?: string; name?: string; status?: string; updated_at?: string }

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
const TAB_KEY = 'dsh-scholar-ui-tab'

/** Restore the last active tab (dsh-web session restore feel). */
function tabLoad(): void {
  try {
    const saved = localStorage.getItem(TAB_KEY)
    if (saved !== null) activeTab = saved
  } catch { /* private mode */ }
}

function tabSave(): void {
  try { localStorage.setItem(TAB_KEY, activeTab) } catch { /* private mode */ }
}

const REFRESH_KEY = 'dsh-scholar-ui-refresh'

/** Auto-refresh toggle (8s polling), persisted. */
function autoRefreshEnabled(): boolean {
  try { return localStorage.getItem(REFRESH_KEY) !== 'off' } catch { return true }
}
function autoRefreshSet(on: boolean): void {
  try { localStorage.setItem(REFRESH_KEY, on ? 'on' : 'off') } catch { /* private mode */ }
}

const ACCENT_KEY = 'dsh-scholar-ui-accent'
const ACCENTS: Record<string, string> = {
  blue: '#2563eb', violet: '#7c3aed', green: '#16a34a', amber: '#b45309',
}

/** Custom accent colour (dsh-web theming), persisted. */
function accentColor(): string {
  try { return ACCENTS[localStorage.getItem(ACCENT_KEY) ?? 'blue'] ?? ACCENTS.blue! } catch { return ACCENTS.blue! }
}
function accentSet(name: string): void {
  try { localStorage.setItem(ACCENT_KEY, name in ACCENTS ? name : 'blue') } catch { /* private mode */ }
}

const RADIUS_KEY = 'dsh-scholar-ui-radius'
const RADII: Record<string, string> = { small: '6px', normal: '12px', large: '18px' }

/** Panel corner radius (dsh-web appearance preference), persisted. */
function radiusValue(): string {
  try { return RADII[localStorage.getItem(RADIUS_KEY) ?? 'normal'] ?? RADII.normal! } catch { return RADII.normal! }
}
function radiusSet(name: string): void {
  try { localStorage.setItem(RADIUS_KEY, name in RADII ? name : 'normal') } catch { /* private mode */ }
}

const TEXTURE_KEY = 'dsh-scholar-ui-texture'
const TEXTURES: Record<string, string> = { plain: 'plain', grid: 'grid', dots: 'dots' }

/** Panel background texture (dsh-web appearance), persisted. */
function textureValue(): string {
  try { return TEXTURES[localStorage.getItem(TEXTURE_KEY) ?? 'plain'] ?? 'plain' } catch { return 'plain' }
}
function textureSet(name: string): void {
  try { localStorage.setItem(TEXTURE_KEY, name in TEXTURES ? name : 'plain') } catch { /* private mode */ }
}

const FAV_KEY = 'dsh-scholar-ui-favs'

function tabFavs(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_KEY)
    if (raw === null) return new Set()
    const parsed = JSON.parse(raw) as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function tabPinned(key: string): boolean {
  return tabFavs().has(key)
}

function tabTogglePin(key: string): void {
  const favs = tabFavs()
  if (favs.has(key)) favs.delete(key)
  else favs.add(key)
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...favs])) } catch { /* private mode */ }
  rerender()
}
let projectId: string | undefined
let lastError: string | undefined
/** Kernel reachability (dsh-web offline indicator). */
let kernelOnline = true
let lastKernelCheck = 0
/** First-paint skeleton (dsh-web loading feel). */
let booting = true

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

/** Density preference (dsh-web density selector), shared across UI. */
const DENSITY_KEY = 'dsh-scholar-ui-density'
let density: 'compact' | 'normal' = 'normal'
function densityLoad(): void {
  try {
    density = localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'normal'
  } catch { /* private mode */ }
}
function densityApply(panel: HTMLElement): void {
  panel.classList.toggle('density-compact', density === 'compact')
  try { localStorage.setItem(DENSITY_KEY, density) } catch { /* private mode */ }
}

/** Project favourites (dsh-web starred projects), persisted. */
const FAV_PROJECTS_KEY = 'dsh-scholar-ui-fav-projects'
let favProjects = new Set<string>()
function favProjectsLoad(): void {
  try {
    const raw = localStorage.getItem(FAV_PROJECTS_KEY)
    if (raw !== null) favProjects = new Set(JSON.parse(raw) as string[])
  } catch { /* private mode */ }
}
function favProjectsPersist(): void {
  try { localStorage.setItem(FAV_PROJECTS_KEY, JSON.stringify([...favProjects])) } catch { /* private mode */ }
}
function favProjectToggle(id: string): void {
  if (favProjects.has(id)) favProjects.delete(id)
  else favProjects.add(id)
  favProjectsPersist()
}

/** Artifact list filter (dsh-web search-as-you-type), persisted per render. */
let artifactsQuery = ''

/** Claims & evidence filter on the Evidence tab (dsh-web search-as-you-type). */
let evidenceQuery = ''

/** Phase tab audit history: newest-10 by default, toggle reveals all. */
let phaseHistoryAll = false

/** Central a11y decorator for modal overlays (see apply). */
let modalObserver: MutationObserver | null = null

export function apply(options: ApplyOptions = {}): void {
  const fullscreen = options.fullscreen === true
  const host = document.createElement('div')
  host.id = 'dsh-scholar-ui'
  host.style.cssText = fullscreen
    ? 'position:fixed;inset:0;z-index:9999;font:14px/1.5 system-ui,sans-serif'
    : 'position:fixed;right:12px;bottom:64px;width:430px;max-height:min(76vh,760px);z-index:9999;font:12px/1.5 system-ui,sans-serif'
  const root = host.attachShadow({ mode: 'open' })
  // Theme: LIGHT is the default; persisted per browser. Accent: custom.
  host.dataset.theme = readTheme()
  host.style.setProperty('--panel-radius', radiusValue())
  host.dataset.texture = textureValue()
  // Custom accent (dsh-web theming): override the CSS variable directly.
  // Dark-theme accent variants (dsh-web theming): brighter in dark mode.
  const ACCENT_DARK: Record<string, string> = {
    blue: '#4d9fff', violet: '#a78bfa', green: '#34d399', amber: '#fbbf24',
  }
  const applyAccent = (): void => {
    const name = (Object.entries(ACCENTS).find(([, v]) => v === accentColor())?.[0] ?? 'blue')
    const c = host.dataset.theme === 'dark' ? (ACCENT_DARK[name] ?? accentColor()) : accentColor()
    // Custom properties live on the host element (ShadowRoot has no .style).
    host.style.setProperty('--accent', c)
    host.style.setProperty('--accent-soft', `${c}1f`)
    host.style.setProperty('--accent-text', c)
  }
  applyAccent()

  // dsh-web a11y: every modal overlay gets role=dialog + aria-modal + a
  // label derived from its header. One central observer keeps new modals
  // compliant automatically (Escape already closes .overlay globally).
  if (modalObserver !== null) modalObserver.disconnect()
  modalObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        const overlays = node.classList.contains('overlay') ? [node] : [...node.querySelectorAll('.overlay')]
        for (const overlay of overlays) {
          overlay.setAttribute('role', 'dialog')
          overlay.setAttribute('aria-modal', 'true')
          const header = overlay.querySelector('.modal-header')
          const label = header?.textContent?.replace('×', '').trim()
          overlay.setAttribute('aria-label', label !== undefined && label !== '' ? label : 'dialog')
        }
      }
    }
  })
  modalObserver.observe(root, { childList: true, subtree: true })

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
.panel { display:flex; flex-direction:column; height:100%; max-height:inherit; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:${fullscreen ? 0 : 'var(--panel-radius)'}; overflow:hidden; box-shadow:${fullscreen ? 'none' : 'var(--shadow)'}; font:12px/1.5 system-ui,sans-serif; }
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
.tab.pinned { color:var(--tone-amber); }
.tab.pinned.active { color:var(--tone-amber); border-bottom-color:var(--tone-amber); }
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
.ws-rename { color:var(--text-3); font-size:12px; padding:0 4px; cursor:pointer; flex-shrink:0; }
.ws-rename:hover { color:var(--accent); }
.ws-item:hover .ws-rename { display:inline; }
.ws-item:hover .ws-item > span[style*="display:none"] { display:flex; }
.ws-item.blocked { border:1px solid var(--tone-red); background:var(--tone-red-bg); }
.ws-item.blocked .ws-name { color:var(--tone-red); font-weight:700; }
.ws-item.selected { outline:1px solid var(--accent); background:var(--accent-soft); }
.ws-check { font-size:12px; color:var(--text-2); flex-shrink:0; }
.sidebar-foot { padding:10px 12px; border-top:1px solid var(--border); color:var(--text-3); font-size:10px; }
.sidebar.collapsed { width:44px; }
.sidebar.collapsed .sidebar-head { justify-content:center; padding:12px 6px; }
.sidebar.collapsed .sidebar-title, .sidebar.collapsed .sidebar-new, .sidebar.collapsed .sidebar input,
.sidebar.collapsed .ws-name, .sidebar.collapsed .ws-status, .sidebar.collapsed .sidebar-foot { display:none; }
.sidebar.collapsed .ws-item { justify-content:center; padding:8px 0; }
.sidebar.collapsed .ws-dot { width:10px; height:10px; }
.main.expanded { flex:1; }
/* dsh-web density: Compact tightens fonts and paddings. */
.panel.density-compact { font-size:11px; }
.panel.density-compact .body { padding:10px 12px 8px; }
.panel.density-compact .card { padding:7px 9px; margin:4px 0; }
.panel.density-compact .tab { padding:7px 2px 6px; }
.panel.density-compact .section-label { margin:10px 0 4px; }
.panel.density-compact .pstep .lbl { font-size:7px; }
/* dsh-web background texture preferences. */
:host([data-texture="grid"]) .panel { background-image: linear-gradient(var(--border-2) 1px, transparent 1px), linear-gradient(90deg, var(--border-2) 1px, transparent 1px); background-size: 22px 22px; }
:host([data-texture="dots"]) .panel { background-image: radial-gradient(var(--border-2) 1px, transparent 1px); background-size: 18px 18px; }
/* dsh-web a11y: visible keyboard focus everywhere. */
:host(:focus-visible), .panel :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 4px; }
/* dsh-web mobile: full-viewport panel, scrollable tabs, compact chrome. */
@media (max-width: 640px) {
  :host { position: fixed; inset: 0; }
  .panel { border-radius: 0; border: 0; }
  .sidebar { width: 180px; }
  .sidebar.collapsed { width: 36px; }
  .tabs { overflow-x: auto; }
  .tab { flex: 0 0 auto; padding-left: 10px; padding-right: 10px; }
  .header .hbtn { padding-left: 6px; padding-right: 6px; }
  .header select.picker { display: none; }
  .body { padding: 12px 10px 8px; }
  .chat-table { font-size: 9.5px; }
}
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
    sidebar.setAttribute('role', 'navigation')
    sidebar.setAttribute('aria-label', 'projects')
    panel.appendChild(sidebar)
    panel.appendChild(main)
  }

  // ── header ──
  const header = el('div', 'header')
  header.appendChild(el('span', 'logo', '🧪'))
  header.appendChild(el('span', 'title', 'Research OS'))
  // dsh-web kernel status: live dot (green when the kernel answers, red
  // when the bridge is down; amber while checking).
  const kernelDot = el('span')
  kernelDot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:var(--tone-amber);display:inline-block;flex-shrink:0'
  kernelDot.title = 'kernel status: checking…'
  kernelDot.setAttribute('aria-label', 'kernel status')
  header.appendChild(kernelDot)
  const spacer = el('span', 'spacer')
  header.appendChild(spacer)
  const themeBtn = el('button', 'hbtn')
  themeBtn.setAttribute('aria-label', 'Toggle theme')
  themeBtn.setAttribute('aria-keyshortcuts', 'Control+Shift+T Meta+Shift+T')
  const paintTheme = (): void => {
    const dark = host.dataset.theme === 'dark'
    themeBtn.textContent = dark ? '☀️ Light' : '🌙 Dark'
    themeBtn.title = dark ? 'switch to light theme' : 'switch to dark theme'
  }
  themeBtn.onclick = () => {
    host.dataset.theme = host.dataset.theme === 'dark' ? 'light' : 'dark'
    writeTheme(host.dataset.theme)
    paintTheme()
    applyAccent()
  }
  paintTheme()
  const refresh = el('button', 'hbtn', '⟳ Refresh')
  refresh.title = 'refresh now'
  refresh.setAttribute('aria-label', 'Refresh')
  const close = el('button', 'hbtn ghost', '×')
  close.title = 'collapse'
  close.setAttribute('aria-label', 'Collapse panel')
  close.onclick = () => { panel.style.display = 'none' }
  const commandsBtn = el('button', 'hbtn', '⌘ Commands')
  commandsBtn.title = 'browse /research commands'
  commandsBtn.setAttribute('aria-keyshortcuts', 'Control+K Meta+K')
  commandsBtn.onclick = () => { openCommandsModal(root) }
  const shortcutsBtn = el('button', 'hbtn', '⌨ Shortcuts')
  shortcutsBtn.title = 'keyboard shortcuts'
  shortcutsBtn.onclick = () => { openShortcutsModal(root) }
  const bellBtn = el('button', 'hbtn', '🔔')
  bellBtn.title = 'notifications'
  bellBtn.onclick = () => { openNotificationsModal(root) }
  const modeBadge = el('span', 'hbtn')
  modeBadge.textContent = '🧭 gate-only'
  modeBadge.title = 'research mode: every gate requires a human decision'
  modeBadge.style.cssText = 'cursor:default;opacity:.9'
  // dsh-web "Collapse sidebar": toggles the workspace sidebar width
  // (persisted, dsh-web layout memory).
  const SIDEBAR_KEY = 'dsh-scholar-ui-sidebar'
  let sidebarCollapsed = false
  try { sidebarCollapsed = localStorage.getItem(SIDEBAR_KEY) === 'collapsed' } catch { /* private mode */ }
  const sidebarPersist = (): void => {
    try { localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? 'collapsed' : 'expanded') } catch { /* private mode */ }
  }
  const sidebarToggle = el('button', 'hbtn', '◧')
  sidebarToggle.title = 'collapse / expand sidebar'
  sidebarToggle.setAttribute('aria-expanded', 'true')
  sidebarToggle.setAttribute('aria-label', 'Toggle sidebar')
  sidebarToggle.onclick = () => {
    sidebarCollapsed = !sidebarCollapsed
    sidebarPersist()
    if (sidebar !== null) sidebar.classList.toggle('collapsed', sidebarCollapsed)
    if (main !== null) main.classList.toggle('expanded', sidebarCollapsed)
    sidebarToggle.textContent = sidebarCollapsed ? '◨' : '◧'
    sidebarToggle.setAttribute('aria-expanded', String(!sidebarCollapsed))
    void render()
  }
  // dsh-web density selector (the model dropdown's visual slot): Compact /
  // Normal controls the panel font scale.
  densityLoad()
  const densitySelect = el('select', 'picker')
  densitySelect.style.cssText = 'width:auto;margin:0;padding:3px 6px;font-size:10.5px;border-radius:7px'
  const dOptCompact = el('option', '', 'Compact')
  dOptCompact.value = 'compact'
  const dOptNormal = el('option', '', 'Normal')
  dOptNormal.value = 'normal'
  densitySelect.append(dOptCompact, dOptNormal)
  densitySelect.value = density
  densitySelect.onchange = () => {
    density = densitySelect.value === 'compact' ? 'compact' : 'normal'
    densityApply(panel)
  }
  densityApply(panel)
  if (fullscreen) {
    // Standalone mode: project creation lives in the sidebar.
    header.append(sidebarToggle, modeBadge, commandsBtn, shortcutsBtn, bellBtn, densitySelect, themeBtn, refresh)
  } else {
    header.append(themeBtn, refresh, close)
  }
  main.appendChild(header)

  // ── tabs ──
  const tabs = el('div', 'tabs')
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', 'panel sections')
  const TAB_DEFS = [
    ['chat', '💬 Chat'], ['phase', 'Phase'], ['gates', 'Gates'], ['runs', 'Runs'],
    ['artifacts', 'Artifacts'], ['evidence', 'Evidence'], ['budget', 'Budget'],
  ] as const
  const tabButtons = new Map<string, HTMLElement>()
  for (const [key, label] of TAB_DEFS) {
    const button = el('button', 'tab', label)
    button.dataset.tab = key
    button.id = `tab-${key}`
    button.setAttribute('aria-controls', 'panel-body')
    button.setAttribute('aria-keyshortcuts', `Alt+${TAB_DEFS.findIndex(t => t[0] === key) + 1}`)
    button.setAttribute('role', 'tab')
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', key === activeTab ? 'true' : 'false')
    // dsh-web "pin view": ★ marks a favourite tab (persisted).
    const pinned = tabPinned(key)
    if (pinned) {
      button.classList.add('pinned')
      const pin = el('span', '', '★ ')
      pin.style.cssText = 'color:var(--tone-amber);font-size:10px'
      button.prepend(pin)
    }
    button.title = pinned ? `${label} (pinned · click ☆ to unpin)` : `${label} · Alt+${TAB_DEFS.findIndex(t => t[0] === key) + 1}`
    button.onclick = (event) => {
      // A click on the pin glyph toggles the favourite instead of switching.
      const target = event.target as HTMLElement
      if (target.textContent === '★ ' || target.textContent === '☆ ') {
        tabTogglePin(key)
        return
      }
      activeTab = key
      tabSave()
      void render()
    }
    button.oncontextmenu = (event) => {
      event.preventDefault()
      tabTogglePin(key)
    }
    tabButtons.set(key, button)
    tabs.appendChild(button)
  }
  main.appendChild(tabs)

  // ── body + picker ──
  const body = el('div', 'body')
  body.id = 'panel-body'
  body.setAttribute('role', 'tabpanel')
  body.setAttribute('aria-label', 'active panel content')
  main.appendChild(body)
  const picker = el('select', 'picker')
  picker.style.cssText = 'margin:10px 12px 0;width:calc(100% - 24px)'
  picker.onchange = () => { projectId = picker.value || undefined; void render() }
  if (!fullscreen) main.insertBefore(picker, body)

  const styleTabs = (): void => {
    for (const [key, button] of tabButtons) {
      button.classList.toggle('active', key === activeTab)
      if (key === activeTab) button.setAttribute('aria-current', 'page')
      else button.removeAttribute('aria-current')
      // dsh-web pinned tabs: keep the ★ marker in sync (buttons are built
      // once, so the pin class must be refreshed on every render).
      const pinned = tabPinned(key)
      button.classList.toggle('pinned', pinned)
      button.setAttribute('aria-pressed', pinned ? 'true' : 'false')
      const hasStar = button.querySelector('span') !== null
      if (pinned && !hasStar) {
        const pin = el('span', '', '★ ')
        pin.style.cssText = 'color:var(--tone-amber);font-size:10px'
        button.prepend(pin)
      } else if (!pinned && hasStar) {
        button.querySelector('span')?.remove()
      }
    }
  }

  // dsh-web document title: reflect the active tab + project in the tab
  // title so the plugin is identifiable among many tabs (ignored when the
  // plugin runs inside a sandboxed iframe where the title is read-only).
  const syncTitle = (projectName: string | undefined): void => {
    try {
      const tabLabel = TAB_DEFS.find(t => t[0] === activeTab)?.[1] ?? 'overview'
      document.title = `dsh-scholar${projectName !== undefined && projectName !== '' ? ` · ${projectName}` : ''} — ${tabLabel}`
    } catch { /* sandboxed iframe */ }
  }

  const render = async (): Promise<void> => {
    styleTabs()
    // dsh-web skeleton: placeholders while the first paint loads.
    if (booting) {
      const skel = el('div')
      skel.style.cssText = 'display:flex;flex-direction:column;gap:10px;padding:14px'
      for (let i = 0; i < 4; i++) {
        const bar = el('div')
        bar.style.cssText = `height:14px;border-radius:6px;background:var(--bg-3);animation:pulse 1.6s ease-in-out infinite;width:${92 - i * 12}%`
        skel.appendChild(bar)
      }
      body.replaceChildren(skel)
    }
    // dsh-web offline indicator: throttled kernel health probe.
    const now = Date.now()
    if (now - lastKernelCheck > 5000) {
      lastKernelCheck = now
      const health = await api<{ ok?: boolean }>('/v1/health')
      kernelOnline = health !== null && health.ok === true
      // dsh-web status dot: reflect bridge health immediately.
      kernelDot.style.background = kernelOnline ? 'var(--tone-green)' : 'var(--tone-red)'
      kernelDot.title = kernelOnline ? `kernel connected · ${health.instance ?? ''}` : 'kernel unreachable'
    }
    // Project list: drives the sidebar (fullscreen) or the picker (float).
    const projects = (await api<ProjectRow[]>('/v1/projects')) ?? []
    // dsh-web session ordering: most recently active first (by updated_at).
    projects.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
    if (!kernelOnline) {
      const banner = el('div')
      banner.style.cssText = 'position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:center;gap:8px;padding:6px 12px;background:var(--tone-red-bg);border-bottom:1px solid var(--tone-red);color:var(--tone-red);font:600 11px/1.4 system-ui,sans-serif'
      banner.appendChild(el('span', '', '⚠'))
      const text = el('span', '', 'Research kernel unreachable — reconnecting…')
      banner.appendChild(text)
      const retry = el('button', 'hbtn', 'Retry now')
      retry.style.cssText = 'padding:1px 8px'
      retry.onclick = () => {
        lastKernelCheck = 0
        void render()
      }
      banner.appendChild(retry)
      body.prepend(banner)
    }
    const target = projectId ?? projects[0]?.project_id
    let projection: Projection | null = null
    if (target !== undefined) {
      projection = await api<Projection>(`/v1/projects/${encodeURIComponent(target)}/projection`)
      if (projection === null || projection.project === undefined) projection = null
      else projectId = projection.project.project_id
    }
    if (projection !== null && booting) booting = false
    syncTitle(projection?.project?.name)
    if (fullscreen && sidebar !== null) {
      // dsh-web sidebar stats: counts of the active project under its row.
      renderSidebar(sidebar, projects, projectId, (id) => { projectId = id; void render() }, projection?.counts)
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
    if (target === undefined) {
      syncTitle(undefined)
      // dsh-web hero: a guided empty state instead of a bare message.
      const hero = el('div')
      hero.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:14px;padding:60px 20px;text-align:center'
      hero.appendChild(el('div', '', '🧪'))
      hero.appendChild(el('div', '', 'Welcome to **Research OS**'))
      hero.appendChild(el('div', 'muted', 'A fully standalone DSH Scholar web plugin: plan, run and review research with human-gated decisions. Start by creating your first project.'))
      const steps = el('div')
      steps.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:4px;font-size:11.5px;color:var(--text-2)'
      const addStep = (t: string): void => {
        const row = el('div', 'row')
        row.style.cssText = 'justify-content:center'
        row.appendChild(el('span', '', '·'))
        row.appendChild(el('span', '', t))
        steps.appendChild(row)
      }
      addStep('＋ New Project in the sidebar, or /research new demo1 in Chat')
      addStep('Approve the Scope Gate in the Gates tab (human only)')
      addStep('Survey literature, pre-register a contract, run container experiments')
      addStep('Build the manuscript, review it, export the Release Bundle')
      hero.appendChild(steps)
      // dsh-web overview: how many projects live on this kernel.
      if (projects.length > 0) {
        const stat = el('div', 'muted', `${projects.length} project(s) on this kernel — pick one in the sidebar, or switch with Ctrl/Cmd+P.`)
        stat.style.cssText = 'font-size:11px;margin-top:10px'
        hero.appendChild(stat)
        // dsh-web quick open: the most recently active projects as chips.
        const chipRow = el('div', 'row')
        chipRow.style.cssText = 'gap:6px;flex-wrap:wrap;justify-content:center;margin-top:6px'
        for (const rp of projects.slice(0, 4)) {
          if (rp.project_id === undefined) continue
          const chip = el('button', 'hbtn', `📁 ${rp.name ?? rp.project_id}`)
          chip.style.cssText = 'padding:4px 12px;font-size:10.5px'
          chip.onclick = () => {
            projectId = rp.project_id!
            void render()
          }
          chipRow.appendChild(chip)
        }
        hero.appendChild(chipRow)
      }
      const go = el('button', 'btn approve', '＋ Create your first project')
      go.style.cssText = 'padding:9px 20px;margin-top:6px'
      go.onclick = () => { openNewProjectModal(root) }
      hero.appendChild(go)
      body.replaceChildren(hero)
      return
    }
    if (projection === null) {
      body.replaceChildren(el('div', 'error-banner', `Research kernel unreachable (project ${target}).`))
      return
    }
    if (!fullscreen) {
      // Keep the picker in sync with the active project (the chat /research
      // new command switches it outside the picker's own onchange).
      picker.value = projectId ?? ''
    }
    body.replaceChildren()

    const title = el('div', 'project-title')
    const pname = el('span', 'pname', projection.project.name ?? projectId)
    // dsh-web affordance: click the project id to copy it.
    const pid = el('span', 'pid', `${projectId} · rev ${projection.project.revision ?? 0}`)
    pid.style.cssText += ';cursor:pointer;border-radius:6px;padding:1px 4px'
    pid.title = 'click to copy project ID'
    pid.onclick = () => { if (projectId !== undefined) copyText(projectId) }
    const statusPill = pill(projection.project.status)
    title.append(pname, statusPill, pid)
    body.appendChild(title)

    switch (activeTab) {
      case 'chat': await renderChat(body, target); break
      case 'phase': await renderPhase(body, projection, target); break
      case 'gates': await renderGates(body, target); break
      case 'runs': renderRuns(body, projection); break
      case 'artifacts': await renderArtifacts(body, target); break
      case 'evidence': await renderEvidence(body, target); break
      case 'budget': renderBudget(body, projection); break
    }
    const stamp = el('div', 'stamp', `updated ${new Date().toLocaleTimeString()}${lastError !== undefined ? ` · ⚠ ${lastError}` : ''}`)
    body.appendChild(stamp)
    paintBell()
  }

  refresh.onclick = () => { void render() }
  // dsh-web notification dot: unread count on the bell.
  const paintBell = (): void => {
    bellBtn.textContent = notifUnread > 0 ? `🔔 ${notifUnread}` : '🔔'
    bellBtn.title = notifUnread > 0 ? `${notifUnread} unread notifications` : 'notifications'
  }
  paintBell()
  rerender = () => { void render() }
  chatLoad()
  historyLoad()
  tabLoad()
  notifLoad()
  favProjectsLoad()
  void render()
  const startTimer = (): number | null => {
    if (!autoRefreshEnabled()) return null
    return window.setInterval(() => {
      // dsh-web behaviour: pause background refreshes while the tab is
      // hidden (CPU/battery friendly); one refresh fires on return.
      if (document.hidden) return
      void render()
    }, 8000)
  }
  let timer: number | null = startTimer()
  // dsh-web behaviour: catch up immediately when the tab becomes visible
  // again (the interval above skips while hidden).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void render()
  })
  // dsh-web global shortcuts: Cmd/Ctrl+K opens the command palette (when
  // not typing in an input/textarea); Cmd/Ctrl+Shift+T toggles the theme;
  // a bare "/" (not typing) focuses the chat composer.
  const onKey = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null
    const typing = target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    if (event.metaKey || event.ctrlKey) {
      if (event.key.toLowerCase() === 'k' && !typing) {
        event.preventDefault()
        openCommandsModal(root)
      } else if (event.key.toLowerCase() === 'p' && !typing) {
        // dsh-web quick project switcher: Ctrl/Cmd+P.
        event.preventDefault()
        openProjectSwitcherModal(root)
      } else if (event.key.toLowerCase() === 't' && event.shiftKey && !typing) {
        event.preventDefault()
        host.dataset.theme = host.dataset.theme === 'dark' ? 'light' : 'dark'
        writeTheme(host.dataset.theme)
        paintTheme()
        applyAccent()
      } else if (/^[1-9]$/.test(event.key) && !typing && activeTab === 'chat') {
        // dsh-web session navigation: Ctrl+1..9 selects the Nth session.
        event.preventDefault()
        const idx = Number(event.key) - 1
        const target = chatSessions[idx]
        if (target !== undefined) {
          chatActiveId = target.id
          chatDraft = ''
          chatSyncActive()
          rerender()
        }
      } else if (event.key === 'Tab' && !typing && activeTab === 'chat' && chatSessions.length > 1) {
        // dsh-web session navigation: Ctrl+Tab cycles chat sessions.
        event.preventDefault()
        const idx = chatSessions.findIndex(s => s.id === chatActiveId)
        const next = chatSessions[(idx + 1) % chatSessions.length]
        if (next !== undefined) {
          chatActiveId = next.id
          chatDraft = ''
          chatSyncActive()
          rerender()
        }
      } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !typing && activeTab === 'chat' && chatMessages.length > 0) {
        // dsh-web keyboard navigation: Ctrl+ArrowUp/Down walks messages
        // and selects them into the details panel.
        event.preventDefault()
        const dir = event.key === 'ArrowUp' ? -1 : 1
        const next = chatDetailIndex < 0
          ? (dir < 0 ? chatMessages.length - 1 : 0)
          : Math.min(chatMessages.length - 1, Math.max(0, chatDetailIndex + dir))
        chatDetailIndex = next
        rerender()
      }
      return
    }
    // dsh-web transcript nav: Home/End select the first/last message.
    if ((event.key === 'Home' || event.key === 'End') && !typing && activeTab === 'chat' && chatMessages.length > 0) {
      event.preventDefault()
      chatDetailIndex = event.key === 'Home' ? 0 : chatMessages.length - 1
      rerender()
      return
    }
    // dsh-web help: '?' opens the shortcut reference.
    if (event.key === '?' && !typing) {
      event.preventDefault()
      openShortcutsModal(root)
      return
    }
    // dsh-web behavior: typing "/" anywhere (not already typing) jumps to
    // the chat composer with a leading slash.
    if (event.key === '/' && !typing && fullscreen) {
      event.preventDefault()
      activeTab = 'chat'
      chatDraft = '/'
      rerender()
      // Focus the composer once the chat tab has rendered.
      setTimeout(() => {
        const ta = root.querySelector('textarea[placeholder*="research"]') as HTMLTextAreaElement | null
        ta?.focus()
      }, 120)
    }
    // dsh-web behavior: Escape closes any open modal/overlay, the message
    // details panel and any pending quote.
    if (event.key === 'Escape' && !typing) {
      const ctx = root.querySelectorAll('.ctx-scrim')
      if (ctx.length > 0) {
        ctx[ctx.length - 1]?.remove()
        return
      }
      const overlays = root.querySelectorAll('.overlay')
      if (overlays.length > 0) {
        overlays[overlays.length - 1]?.remove()
      } else if (chatDetailIndex >= 0) {
        chatDetailIndex = -1
        rerender()
      } else if (chatQuoteTarget !== null) {
        chatQuoteTarget = null
        rerender()
      }
      return
    }
    // dsh-web keyboard navigation: Alt+1..7 switches tabs.
    if (event.altKey && /^[1-7]$/.test(event.key) && !typing) {
      event.preventDefault()
      const idx = Number(event.key) - 1
      const tab = TAB_DEFS[idx]
      if (tab !== undefined) {
        activeTab = tab[0]
        tabSave()
        rerender()
      }
    }
  }
  window.addEventListener('keydown', onKey)
  // Responsive: narrow viewports auto-collapse the sidebar (dsh-web shell).
  const onResize = (): void => {
    if (!fullscreen || sidebar === null) return
    const narrow = window.innerWidth < 920
    // Narrow viewports force-collapse; wide ones keep the user's choice
    // (persisted layout memory).
    if (narrow && !sidebarCollapsed) {
      sidebarCollapsed = true
      sidebar.classList.add('collapsed')
      if (main !== null) main.classList.add('expanded')
      sidebarToggle.textContent = '◨'
    }
  }
  if (sidebarCollapsed && sidebar !== null) {
    sidebar.classList.add('collapsed')
    if (main !== null) main.classList.add('expanded')
    sidebarToggle.textContent = '◨'
  }
  onResize()
  window.addEventListener('resize', onResize)
  window.addEventListener('beforeunload', () => {
    if (timer !== null) window.clearInterval(timer)
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', onResize)
  }, { once: true })
  document.body.appendChild(host)
}

/* ─────────────────────────── tab renderers ─────────────────────────── */

async function renderPhase(body: HTMLElement, p: Projection, projectId?: string): Promise<void> {
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
  // dsh-web progress: completion % of the pipeline.
  const statusIdx2 = statusIdx >= 0 ? statusIdx : PHASE_PIPELINE.length
  const pct = Math.round((statusIdx2 / PHASE_PIPELINE.length) * 100)
  const pctRow = el('div', 'muted')
  pctRow.style.cssText = 'font-size:10px;margin-top:6px;text-align:right'
  pctRow.textContent = `${pct}% complete`
  pipeline.appendChild(pctRow)
  body.appendChild(pipeline)

  // dsh-web summary row: problem + primary metrics.
  const brief = p.project?.brief
  if (brief !== undefined) {
    const sum = el('div', 'muted')
    sum.style.cssText = 'font-size:11px;margin-top:8px;line-height:1.5'
    const problem = typeof brief.problem === 'string' && brief.problem !== '' ? brief.problem : null
    const metrics = Array.isArray(brief.primary_metrics) && brief.primary_metrics.length > 0 ? brief.primary_metrics.join(', ') : null
    const parts: string[] = []
    if (problem !== null) parts.push(problem)
    if (metrics !== null) parts.push(`📊 ${metrics}`)
    if (parts.length > 0) sum.textContent = parts.join(' · ')
    body.appendChild(sum)
  }

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

  // history (audit ledger: transitions, gate decisions, renames, archives)
  const history = (p.project?.history ?? [])
  // dsh-web timeline: show the newest 10 entries; a toggle reveals the rest.
  const historyShown = phaseHistoryAll ? history : history.slice(-10)
  // dsh-web quick-nav: jump to the relevant panel from the pipeline view.
  body.appendChild(el('div', 'section-label', 'Quick view'))
  const quick = el('div', 'row')
  quick.style.cssText = 'gap:6px;flex-wrap:wrap'
  const jump = (label: string, tab: string): void => {
    const b = el('button', 'hbtn', label)
    b.style.cssText = 'padding:2px 10px;font-size:10.5px'
    b.onclick = () => {
      activeTab = tab
      tabSave()
      rerender()
    }
    quick.appendChild(b)
  }
  jump('⛩️ Gates', 'gates')
  jump('⚙️ Runs', 'runs')
  jump('📦 Artifacts', 'artifacts')
  jump('📊 Evidence', 'evidence')
  jump('💰 Budget', 'budget')
  body.appendChild(quick)
  // dsh-web data panel: budget usage of this project.
  const budget = p.budget
  const maxUsd = p.project?.constraints?.max_model_cost_usd
  const maxGpu = p.project?.constraints?.max_gpu_hours
  if (budget !== undefined) {
    body.appendChild(el('div', 'section-label', 'Budget usage'))
    const bcard = el('div', 'card')
    const addBar = (label: string, used: number, max: number | undefined, unit: string): void => {
      const row = el('div', 'budget-row')
      row.appendChild(el('span', 'blabel', label))
      const track = el('div', 'budget-track')
      const fill = el('div', 'budget-fill')
      const ratio = max !== undefined && max > 0 ? Math.min(used / max, 1) : 0
      const color = ratio >= 1 ? 'var(--tone-red)' : ratio >= 0.8 ? 'var(--tone-amber)' : 'var(--accent)'
      fill.style.cssText = `width:${Math.max(ratio * 100, used > 0 ? 4 : 0)}%;background:${color};box-shadow:0 0 6px ${color}`
      track.appendChild(fill)
      row.appendChild(track)
      const val = el('span', 'budget-val', `${used}${unit}${max !== undefined ? ` / ${max}${unit}` : ''}`)
      row.appendChild(val)
      bcard.appendChild(row)
    }
    addBar('Model', budget.model_cost_usd ?? 0, maxUsd, '$')
    addBar('GPU', budget.gpu_hours ?? 0, maxGpu, 'h')
    body.appendChild(bcard)
  }
  // dsh-web data panel: IdeaCards of this project.
  if (projectId !== undefined && (p.counts?.ideas ?? 0) > 0) {
    const ideas = (await api<Array<Record<string, unknown>>>(`/v1/projects/${encodeURIComponent(projectId)}/ideas`)) ?? []
    body.appendChild(el('div', 'section-label', `IdeaCards (${ideas.length})`))
    const card = el('div', 'card')
    for (const idea of ideas.slice(0, 5)) {
      const row = el('div', 'row')
      row.style.cssText = 'padding:4px 0;align-items:flex-start'
      row.appendChild(el('span', 'artifact-kind', String(idea.status ?? '?')))
      const bodyEl = el('div', 'grow')
      bodyEl.style.cssText = 'min-width:0'
      const title = el('div', '', String(idea.title ?? ''))
      title.style.cssText = 'font-size:11.5px;color:var(--text)'
      const id = el('div', 'muted mono', fmtId(String(idea.idea_id ?? '')))
      id.style.cssText = 'font-size:9px'
      bodyEl.append(title, id)
      row.appendChild(bodyEl)
      row.title = 'double-click for idea details'
      row.ondblclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root !== null) openIdeaDetailModal(root, idea)
      }
      // dsh-web drawer: one-click idea details.
      const ideaBtn = el('button', 'hbtn', '⧉')
      ideaBtn.title = 'idea details'
      ideaBtn.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      ideaBtn.onclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root !== null) openIdeaDetailModal(root, idea)
      }
      row.appendChild(ideaBtn)
      card.appendChild(row)
    }
    if (ideas.length > 5) card.appendChild(el('div', 'muted', `… and ${ideas.length - 5} more`))
    body.appendChild(card)
  }
  // dsh-web data panel: ExperimentContracts of this project.
  if (projectId !== undefined && (p.counts?.contracts ?? 0) > 0) {
    const contracts = (await api<Array<Record<string, unknown>>>(`/v1/projects/${encodeURIComponent(projectId)}/contracts`)) ?? []
    body.appendChild(el('div', 'section-label', `Contracts (${contracts.length})`))
    const card = el('div', 'card')
    for (const c of contracts.slice(0, 5)) {
      const row = el('div', 'row')
      row.style.cssText = 'padding:4px 0;align-items:flex-start'
      row.appendChild(el('span', 'artifact-kind', String(c.status ?? '?')))
      const bodyEl = el('div', 'grow')
      bodyEl.style.cssText = 'min-width:0'
      const cRecord = c as Record<string, unknown>
      const title = el('div', '', `${String(cRecord.methods?.baseline ?? '?')} vs ${String(cRecord.methods?.treatment ?? '?')}${typeof cRecord.version === 'number' ? ` · v${cRecord.version}` : ''}`)
      title.style.cssText = 'font-size:11.5px;color:var(--text)'
      const id = el('div', 'muted mono', fmtId(String(c.contract_id ?? '')))
      id.style.cssText = 'font-size:9px'
      bodyEl.append(title, id)
      row.appendChild(bodyEl)
      row.title = 'double-click for contract details'
      row.ondblclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root !== null) openContractDetailModal(root, c)
      }
      // dsh-web drawer: one-click contract details.
      const contractBtn = el('button', 'hbtn', '⧉')
      contractBtn.title = 'contract details'
      contractBtn.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      contractBtn.onclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root !== null) openContractDetailModal(root, c)
      }
      row.appendChild(contractBtn)
      card.appendChild(row)
    }
    if (contracts.length > 5) card.appendChild(el('div', 'muted', `… and ${contracts.length - 5} more`))
    body.appendChild(card)
  }
  if (history.length > 0) {
    body.appendChild(el('div', 'section-label', 'Audit history'))
    for (const h of historyShown) {
      const row = el('div', 'row')
      row.style.cssText = 'padding:2px 0;align-items:flex-start'
      // Pick an icon by the audit kind (dsh-web timeline feel).
      let icon = '·'
      if (h.includes('->')) icon = '➡️'
      else if (h.includes('renamed')) icon = '✎'
      else if (h.includes('archived')) icon = '🗄'
      else if (h.includes('approved')) icon = '✅'
      else if (h.includes('rejected')) icon = '⛔'
      row.appendChild(el('span', 'muted', icon))
      row.appendChild(el('span', 'grow muted', h))
      body.appendChild(row)
    }
    if (history.length > 10) {
      const toggleBtn = el('button', 'hbtn', phaseHistoryAll ? '⤴ show last 10' : `⤵ show all (${history.length})`)
      toggleBtn.style.cssText = 'padding:1px 10px;margin-top:6px'
      toggleBtn.onclick = () => { phaseHistoryAll = !phaseHistoryAll; rerender() }
      body.appendChild(toggleBtn)
    }
  }
}

/** Gates multi-select (dsh-web bulk decisions). */
let gatesSelecting = false
let gatesSelected = new Set<string>()

/** Gates filter (dsh-web search-as-you-type), persisted per render. */
let gatesQuery = ''
/** Decided-gates section folded by default on busy projects. */
let gatesDecidedOpen = true

async function renderGates(body: HTMLElement, projectId: string): Promise<void> {
  const gates = (await api<GateRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/gates`)) ?? []
  // dsh-web decision provenance: who decided each gate, when, and why.
  const decisions = (await api<Array<Record<string, unknown>>>(`/v1/projects/${encodeURIComponent(projectId)}/decisions`)) ?? []
  const pending = gates.filter(g => g.status === 'pending')
  const decided = gates.filter(g => g.status !== 'pending')
  // dsh-web search-as-you-type: filters both sections; only the list
  // container is rebuilt so the input keeps focus.
  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = '🔍 Filter gates…'
  searchInput.value = gatesQuery
  searchInput.style.cssText = 'flex:1;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font:11px/1.4 system-ui,sans-serif;outline:none;margin:2px 0 6px'
  searchInput.onfocus = () => { searchInput.style.borderColor = 'var(--accent)' }
  searchInput.onblur = () => { searchInput.style.borderColor = 'var(--border)' }
  body.appendChild(searchInput)
  const listEl = el('div')
  body.appendChild(listEl)

  const renderList = (): void => {
    listEl.replaceChildren()
    const q = gatesQuery.trim().toLowerCase()
    const matches = (g: GateRow): boolean =>
      q === '' ||
      (g.type ?? '').toLowerCase().includes(q) ||
      (g.title ?? '').toLowerCase().includes(q) ||
      (g.status ?? '').toLowerCase().includes(q) ||
      (g.summary ?? '').toLowerCase().includes(q) ||
      (g.gate_id ?? '').toLowerCase().includes(q)
    const pFiltered = pending.filter(matches)
    const dFiltered = decided.filter(matches)
    const labelRow = el('div', 'row')
    labelRow.style.cssText = 'justify-content:space-between;align-items:center'
    labelRow.appendChild(el('div', 'section-label', `Awaiting your decision (${pFiltered.length})`))
    if (pFiltered.length > 0) {
      const selBtn = el('button', 'hbtn', gatesSelecting ? '☑ Selecting…' : '☑ Select')
      selBtn.title = gatesSelecting ? 'exit multi-select' : 'multi-select gates (bulk decide)'
      selBtn.setAttribute('aria-pressed', gatesSelecting ? 'true' : 'false')
      selBtn.style.cssText = 'padding:1px 10px;margin-bottom:2px'
      selBtn.onclick = () => {
        gatesSelecting = !gatesSelecting
        gatesSelected.clear()
        rerender()
      }
      labelRow.appendChild(selBtn)
    }
    listEl.appendChild(labelRow)
    if (pFiltered.length === 0) {
      listEl.appendChild(el('div', 'empty', q === ''
        ? 'No pending gates. All decisions are made — or nothing was requested yet.'
        : `No pending gates match "${gatesQuery.trim()}".`))
    }
  // Bulk decide bar.
  if (gatesSelecting && pending.length > 0) {
    const bar = el('div', 'card border-amber')
    bar.style.cssText = 'padding:8px 10px;margin:4px 0;display:flex;align-items:center;gap:10px'
    const count = el('span', 'mono', `${gatesSelected.size} selected`)
    count.style.cssText = 'font-size:11px;color:var(--text)'
    const approveSel = el('button', 'btn approve', '✓ Approve selected')
    approveSel.disabled = gatesSelected.size === 0
    approveSel.onclick = async () => {
      for (const id of gatesSelected) {
        const g = gates.find(x => x.gate_id === id)
        await api(`/v1/gates/${encodeURIComponent(id)}/decisions`, {
          method: 'POST',
          body: JSON.stringify({
            actor: 'web-user',
            decision: 'approved',
            reason: 'bulk approved from Research OS panel',
            ...(g?.type === 'budget' ? { resume_to: 'EXPERIMENTING' } : {}),
          }),
        })
      }
      showToast(rootHost(), `✓ ${gatesSelected.size} gate(s) approved`)
      gatesSelecting = false
      gatesSelected.clear()
      rerender()
    }
    const rejectSel = el('button', 'btn reject', '✕ Reject selected')
    rejectSel.disabled = gatesSelected.size === 0
    rejectSel.onclick = async () => {
      for (const id of gatesSelected) {
        await api(`/v1/gates/${encodeURIComponent(id)}/decisions`, {
          method: 'POST',
          body: JSON.stringify({ actor: 'web-user', decision: 'rejected', reason: 'bulk rejected from Research OS panel' }),
        })
      }
      showToast(rootHost(), `✕ ${gatesSelected.size} gate(s) rejected`)
      gatesSelecting = false
      gatesSelected.clear()
      rerender()
    }
    const doneSel = el('button', 'hbtn', 'Done')
    doneSel.onclick = () => {
      gatesSelecting = false
      gatesSelected.clear()
      rerender()
    }
    const allBtn = el('button', 'hbtn', '☑ all')
    allBtn.title = 'select all pending gates'
    allBtn.onclick = () => {
      for (const g of pFiltered) if (g.gate_id !== undefined) gatesSelected.add(g.gate_id)
      renderList()
    }
    bar.append(count, allBtn, approveSel, rejectSel, doneSel)
    listEl.appendChild(bar)
  }
  for (const gate of pFiltered) {
    const card = el('div', 'card border-amber')
    const top = el('div', 'row')
    // Multi-select checkbox (pending gates only).
    if (gatesSelecting && gate.gate_id !== undefined) {
      const box = el('span', 'ws-check', gatesSelected.has(gate.gate_id) ? '☑' : '☐')
      box.style.cssText += ';cursor:pointer'
      box.onclick = (event) => {
        event.stopPropagation()
        if (gate.gate_id === undefined) return
        if (gatesSelected.has(gate.gate_id)) gatesSelected.delete(gate.gate_id)
        else gatesSelected.add(gate.gate_id)
        rerender()
      }
      top.prepend(box)
      if (gatesSelected.has(gate.gate_id)) card.style.outline = '1px solid var(--tone-amber)'
    }
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
    // dsh-web traceability: the gate id (support / ledger lookups), copyable.
    if (gate.gate_id !== undefined && gate.gate_id !== '') {
      const gid = el('div', 'muted mono', fmtId(gate.gate_id, 26))
      gid.style.cssText = 'margin-top:3px;font-size:9px;cursor:pointer'
      gid.title = 'click to copy gate ID'
      gid.onclick = (event) => {
        event.stopPropagation()
        if (gate.gate_id !== undefined) copyText(gate.gate_id)
      }
      card.appendChild(gid)
    }
    const actions = el('div', 'gate-actions')
    actions.style.cssText = 'margin-top:10px;display:flex;gap:8px'
    const approve = el('button', 'btn approve', '✓ Approve')
    const reject = el('button', 'btn reject', '✕ Reject')
    // dsh-web decision reason: optional free-text recorded in the ledger.
    const reasonRow = el('div')
    reasonRow.style.cssText = 'display:none;margin-top:8px;gap:6px;align-items:center'
    const reasonInput = document.createElement('input')
    reasonInput.type = 'text'
    reasonInput.placeholder = 'Optional decision reason (recorded in the ledger)…'
    reasonInput.maxLength = 200
    reasonInput.style.cssText = 'flex:1;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font:11px/1.4 system-ui,sans-serif;outline:none'
    reasonInput.onfocus = () => { reasonInput.style.borderColor = 'var(--accent)' }
    reasonInput.onblur = () => { reasonInput.style.borderColor = 'var(--border)' }
    reasonRow.appendChild(reasonInput)
    const reasonToggle = el('button', 'hbtn', '✎ reason')
    reasonToggle.title = 'add a decision reason'
    reasonToggle.style.cssText = 'padding:0 8px;font-size:10px'
    reasonToggle.onclick = () => {
      const open = reasonRow.style.display === 'none'
      reasonRow.style.display = open ? 'flex' : 'none'
      if (open) reasonInput.focus()
    }
    const act = async (decision: 'approved' | 'rejected', label: string): Promise<void> => {
      const reason = reasonInput.value.trim()
      const ok = await api(`/v1/gates/${encodeURIComponent(gate.gate_id ?? '')}/decisions`, {
        method: 'POST',
        body: JSON.stringify({
          actor: 'web-user',
          decision,
          reason: reason !== '' ? reason : `${label} from Research OS panel`,
          // dsh-web resume: approving a budget gate on a BLOCKED_GATE project
          // must pin the resume target (kernel §6.6 default: EXPERIMENTING),
          // otherwise the project stays parked after approval.
          ...(gate.type === 'budget' ? { resume_to: 'EXPERIMENTING' } : {}),
        }),
      })
      if (ok === null) {
        lastError = `gate ${label.toLowerCase()} failed (bridge error)`
      } else {
        lastError = undefined
        // dsh-web confirmation: toast the decision outcome.
        showToast(rootHost(), `${decision === 'approved' ? '✓' : '✕'} ${shortType(gate.type)} gate ${decision}`)
      }
      rerender()
    }
    approve.onclick = () => { void act('approved', 'approved') }
    reject.onclick = () => { void act('rejected', 'rejected') }
    if (!gatesSelecting) {
      actions.append(approve, reject, reasonToggle)
      card.appendChild(actions)
      card.appendChild(reasonRow)
    }
    listEl.appendChild(card)
  }
  if (dFiltered.length > 0) {
    // dsh-web collapsible sections: the decided list can be folded away.
    const decHeader = el('button')
    decHeader.setAttribute('aria-expanded', gatesDecidedOpen ? 'true' : 'false')
    decHeader.style.cssText = 'display:flex;align-items:center;gap:6px;border:0;background:none;cursor:pointer;color:var(--text);padding:2px 0'
    decHeader.appendChild(el('span', 'section-label', `${gatesDecidedOpen ? '▾' : '▸'} Decided (${dFiltered.length})`))
    decHeader.onclick = () => { gatesDecidedOpen = !gatesDecidedOpen; rerender() }
    listEl.appendChild(decHeader)
    if (gatesDecidedOpen) {
      const card = el('div', 'card')
      for (const gate of dFiltered) {
        const row = el('div', 'gate-row')
        const info = el('div', 'grow')
        const name = el('div', 'pname', `${shortType(gate.type)} Gate`)
        name.style.cssText = 'font-size:11.5px'
        info.appendChild(name)
        if (gate.title !== undefined && gate.title !== '') info.appendChild(el('div', 'muted', gate.title))
        // dsh-web decision provenance: actor + timestamp (+ reason on hover).
        const dec = decisions.find(d => d.gate_id === gate.gate_id)
        if (dec !== undefined) {
          const when = String(dec.decided_at ?? '').replace('T', ' ').slice(0, 16)
          const meta = el('div', 'muted', `${String(dec.actor ?? '?')} · ${String(dec.decision ?? '?')}${when !== '' ? ` · ${when}` : ''}`)
          meta.style.cssText = 'font-size:9.5px;margin-top:2px;color:var(--text-3)'
          const reason = String(dec.reason ?? '')
          if (reason !== '') meta.title = reason
          info.appendChild(meta)
        }
        row.appendChild(info)
        row.appendChild(pill(gate.status))
        card.appendChild(row)
      }
      listEl.appendChild(card)
    }
  }
  }
  searchInput.oninput = () => { gatesQuery = searchInput.value; renderList() }
  renderList()
}

/** Runs multi-select (dsh-web bulk cancel). */
let runsSelecting = false
let runsSelected = new Set<string>()
/** Runs status filter (dsh-web filter chips). */
let runsFilter = 'all'
const RUNS_FILTERS: Array<[string, string]> = [
  ['all', 'All'], ['queued', 'Queued'], ['running', 'Running'],
  ['succeeded', 'Succeeded'], ['failed', 'Failed'], ['cancelled', 'Cancelled'],
]

function renderRuns(body: HTMLElement, p: Projection): void {
  const allJobs = p.jobs ?? []
  const jobs = (runsFilter === 'all' ? allJobs : allJobs.filter(j => j.status === runsFilter)).slice(-12).reverse()
  const cancellable = new Set(['queued', 'running', 'retryable'])
  const labelRow = el('div', 'row')
  labelRow.style.cssText = 'justify-content:space-between;align-items:center'
  labelRow.appendChild(el('div', 'section-label', `Runs (${allJobs.length})`))
  if (jobs.length > 0) {
    const selBtn = el('button', 'hbtn', runsSelecting ? '☑ Selecting…' : '☑ Select')
    selBtn.title = runsSelecting ? 'exit multi-select' : 'multi-select runs (bulk cancel)'
    selBtn.setAttribute('aria-pressed', runsSelecting ? 'true' : 'false')
    selBtn.style.cssText = 'padding:1px 10px;margin-bottom:2px'
    selBtn.onclick = () => {
      runsSelecting = !runsSelecting
      runsSelected.clear()
      rerender()
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
    chip.onclick = () => { runsFilter = key; rerender() }
    chipsRow.appendChild(chip)
  }
  body.appendChild(chipsRow)
  if (jobs.length === 0) {
    body.appendChild(el('div', 'empty', allJobs.length === 0 ? 'No experiment runs yet.' : `No runs with status "${runsFilter}".`))
    return
  }
  if (allJobs.length > 12) {
    const notice = el('div', 'muted', `Showing the newest 12 of ${allJobs.length} runs.`)
    notice.style.cssText = 'font-size:10px;padding:2px;text-align:center'
    body.appendChild(notice)
  }
  // Bulk cancel bar when selecting.
  if (runsSelecting) {
    const bar = el('div', 'card border-red')
    bar.style.cssText = 'padding:8px 10px;margin:4px 0;display:flex;align-items:center;gap:10px'
    const count = el('span', 'mono', `${runsSelected.size} selected`)
    count.style.cssText = 'font-size:11px;color:var(--text)'
    const cancelSel = el('button', 'btn cancel', '✕ Cancel selected')
    cancelSel.disabled = runsSelected.size === 0
    cancelSel.onclick = async () => {
      for (const id of runsSelected) {
        await api(`/v1/jobs/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ actor: 'web-user', reason: 'bulk cancelled from Research OS panel' }),
        })
      }
      showToast(rootHost(), `✕ Cancelled ${runsSelected.size} run(s)`)
      runsSelecting = false
      runsSelected.clear()
      rerender()
    }
    const doneSel = el('button', 'hbtn', 'Done')
    doneSel.setAttribute('aria-label', 'Exit runs multi-select')
    doneSel.onclick = () => {
      runsSelecting = false
      runsSelected.clear()
      rerender()
    }
    const allBtn = el('button', 'hbtn', '☑ all')
    allBtn.title = 'select all cancellable runs'
    allBtn.onclick = () => {
      for (const j of jobs) if (j.job_id !== undefined && cancellable.has(j.status ?? '')) runsSelected.add(j.job_id)
      rerender()
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
      const chip = el('span', 'artifact-kind', `ctr ${fmtId(job.contract_id, 12)}`)
      chip.title = `contract ${job.contract_id}`
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
        rerender()
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
      pulse.title = 'running'
      row.appendChild(pulse)
    }
    row.appendChild(pill(job.status))
    // dsh-web drawer: one-click job details (double-click still works).
    if (job.job_id !== undefined) {
      const detailsBtn = el('button', 'hbtn', '⧉')
      detailsBtn.title = 'job details'
      detailsBtn.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      detailsBtn.onclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root !== null) void openJobDetailModal(root, job.job_id!)
      }
      row.appendChild(detailsBtn)
    }
    card.appendChild(row)
    // dsh-web job drawer: double-click opens the full detail modal.
    card.title = 'double-click for job details'
    card.ondblclick = (event) => {
      event.stopPropagation()
      if (job.job_id === undefined) return
      const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
      if (root !== null) void openJobDetailModal(root, job.job_id)
    }
    if (job.error !== undefined && job.error !== '') {
      const err = el('div', 'muted', job.error)
      err.style.cssText = 'margin-top:4px;color:var(--tone-red);font-size:10.5px;word-break:break-all'
      card.appendChild(err)
    }
    if (job.job_id !== undefined && cancellable.has(job.status ?? '') && !runsSelecting) {
      const cancel = el('button', 'btn cancel', '✕ Cancel')
      cancel.onclick = async () => {
        const ok = await api(`/v1/jobs/${encodeURIComponent(job.job_id ?? '')}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ actor: 'web-user', reason: 'cancelled from Research OS panel' }),
        })
        if (ok === null) {
          lastError = 'cancel failed (bridge error)'
        } else {
          lastError = undefined
          showToast(rootHost(), `✕ Cancelled run ${fmtId(job.job_id, 18)}`)
        }
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

/** Artifacts multi-select (dsh-web bulk download). */
let artifactsSelecting = false
let artifactsSelected = new Set<string>()

async function renderArtifacts(body: HTMLElement, projectId: string): Promise<void> {
  const artifacts = (await api<ArtifactRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/artifacts`)) ?? []
  const labelRow = el('div', 'row')
  labelRow.style.cssText = 'justify-content:space-between;align-items:center'
  labelRow.appendChild(el('div', 'section-label', `Artifacts (${artifacts.length}, click to preview)`))
  if (artifacts.length > 0) {
    const selBtn = el('button', 'hbtn', artifactsSelecting ? '☑ Selecting…' : '☑ Select')
    selBtn.title = artifactsSelecting ? 'exit multi-select' : 'multi-select artifacts (bulk download)'
    selBtn.setAttribute('aria-pressed', artifactsSelecting ? 'true' : 'false')
    selBtn.style.cssText = 'padding:1px 10px;margin-bottom:2px'
    selBtn.onclick = () => {
      artifactsSelecting = !artifactsSelecting
      artifactsSelected.clear()
      rerender()
    }
    labelRow.appendChild(selBtn)
  }
  body.appendChild(labelRow)
  if (artifacts.length === 0) {
    body.appendChild(el('div', 'empty', 'No artifacts yet — runs and analysis produce them.'))
    return
  }
  // dsh-web search-as-you-type: filter the artifact list in place. Only
  // the list below is rebuilt, so the input keeps focus while typing.
  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = '🔍 Filter artifacts…'
  searchInput.value = artifactsQuery
  searchInput.style.cssText = 'flex:1;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font:11px/1.4 system-ui,sans-serif;outline:none;margin:2px 0 4px'
  searchInput.onfocus = () => { searchInput.style.borderColor = 'var(--accent)' }
  searchInput.onblur = () => { searchInput.style.borderColor = 'var(--border)' }
  body.appendChild(searchInput)

  const listEl = el('div')
  body.appendChild(listEl)

  const renderList = (): void => {
    listEl.replaceChildren()
    // Bulk download bar.
    if (artifactsSelecting) {
      const bar = el('div', 'card')
      bar.style.cssText = 'padding:8px 10px;margin:4px 0;display:flex;align-items:center;gap:10px;border-color:var(--accent)'
      const count = el('span', 'mono', `${artifactsSelected.size} selected`)
      count.style.cssText = 'font-size:11px;color:var(--text)'
      const downloadSel = el('button', 'btn approve', '⬇ Download selected')
      downloadSel.disabled = artifactsSelected.size === 0
      downloadSel.onclick = async () => {
        let downloaded = 0
        for (const id of artifactsSelected) {
          const response = await fetch(`${base()}/v1/artifacts/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`, {
            headers: { accept: 'application/octet-stream', ...(await authHeaders()) },
          })
          if (!response.ok) continue
          downloaded += 1
          const blob = await response.blob()
          const url = URL.createObjectURL(blob)
          const a = el('a', 'dl', 'download')
          a.href = url
          a.download = `${id.slice(0, 24)}.bin`
          document.body.appendChild(a)
          a.click()
          a.remove()
          setTimeout(() => URL.revokeObjectURL(url), 4000)
        }
        showToast(rootHost(), `⬇ Downloaded ${downloaded} artifact(s)`)
        artifactsSelecting = false
        artifactsSelected.clear()
        rerender()
      }
      const doneSel = el('button', 'hbtn', 'Done')
      doneSel.onclick = () => {
        artifactsSelecting = false
        artifactsSelected.clear()
        rerender()
      }
      const allBtn = el('button', 'hbtn', '☑ all')
      allBtn.title = 'select all artifacts'
      allBtn.onclick = () => {
        for (const a of artifacts) if (a.artifact_id !== undefined) artifactsSelected.add(a.artifact_id)
        renderList()
      }
      bar.append(count, allBtn, downloadSel, doneSel)
      listEl.appendChild(bar)
    }
    // dsh-web virtualized feel: window artifacts to the newest 15.
    const shownArtifacts = artifacts.slice(-15).reverse()
    if (artifacts.length > 15) {
      const notice = el('div', 'muted', `Showing the newest 15 of ${artifacts.length} artifacts — use the global search or export for the rest.`)
      notice.style.cssText = 'font-size:10px;padding:2px;text-align:center'
      listEl.appendChild(notice)
    }
    const q = artifactsQuery.trim().toLowerCase()
    const filtered = q === '' ? shownArtifacts : shownArtifacts.filter(a =>
      (a.kind ?? '').toLowerCase().includes(q) ||
      (a.artifact_id ?? '').toLowerCase().includes(q) ||
      String(a.metadata?.kind ?? '').toLowerCase().includes(q) ||
      String(a.metadata?.name ?? '').toLowerCase().includes(q),
    )
    if (filtered.length === 0) {
      listEl.appendChild(el('div', 'empty', `No artifacts match "${artifactsQuery.trim()}".`))
      return
    }
    for (const artifact of filtered) {
      const row = el('div', 'artifact-row')
      if (artifactsSelecting && artifact.artifact_id !== undefined) {
        const box = el('span', 'ws-check', artifactsSelected.has(artifact.artifact_id) ? '☑' : '☐')
        box.style.cssText += ';cursor:pointer'
        box.onclick = (event) => {
          event.stopPropagation()
          if (artifact.artifact_id === undefined) return
          if (artifactsSelected.has(artifact.artifact_id)) artifactsSelected.delete(artifact.artifact_id)
          else artifactsSelected.add(artifact.artifact_id)
          renderList()
        }
        row.prepend(box)
        if (artifactsSelected.has(artifact.artifact_id)) row.style.outline = '1px solid var(--accent)'
      }
      row.appendChild(el('span', 'artifact-kind', (artifact.kind ?? '?').toUpperCase()))
      // dsh-web metadata: a human-readable name when the artifact has one.
      if (typeof artifact.metadata?.name === 'string' && artifact.metadata.name !== '') {
        const nameChip = el('span', 'artifact-kind', String(artifact.metadata.name).slice(0, 24))
        nameChip.style.cssText += ';color:var(--text-3)'
        row.appendChild(nameChip)
      }
      const name = el('span', 'grow mono', fmtId(artifact.artifact_id, 22))
      row.appendChild(name)
      // dsh-web metadata: show the artifact kind detail (e.g. code-snapshot-archive).
      const metaKind = typeof artifact.metadata?.kind === 'string' && artifact.metadata.kind !== artifact.kind ? artifact.metadata.kind : ''
      if (metaKind !== '') {
        const chip = el('span', 'artifact-kind', metaKind.slice(0, 22))
        chip.style.cssText += ';color:var(--text-3)'
        row.appendChild(chip)
      }
      row.appendChild(el('span', 'muted', fmtBytes(artifact.size_bytes)))
      row.title = 'click to preview · double-click for details'
      row.onclick = () => { void previewArtifact(artifact.artifact_id ?? '') }
      row.ondblclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root !== null) openArtifactDetailModal(root, artifact)
      }
      listEl.appendChild(row)
    }
  }
  searchInput.oninput = () => { artifactsQuery = searchInput.value; renderList() }
  renderList()
}

/** dsh-web artifact drawer: metadata of one CAS artifact. */
function openArtifactDetailModal(root: ShadowRoot, artifact: ArtifactRow): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:540px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', 'Artifact details')
  const header = el('div', 'modal-header', '📦 Artifact details')
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
    v.style.cssText = 'font-size:11px;color:var(--text);word-break:break-all'
    r.append(l, v)
    modal.appendChild(r)
  }
  const titleRow = el('div', 'row')
  titleRow.style.cssText = 'align-items:center;gap:8px;margin-bottom:8px'
  titleRow.appendChild(el('span', 'artifact-kind', (artifact.kind ?? '?').toUpperCase()))
  titleRow.appendChild(el('span', 'pname', fmtId(artifact.artifact_id ?? '', 30)))
  modal.appendChild(titleRow)

  modal.appendChild(el('div', 'section-label', 'Artifact'))
  row('Artifact', String(artifact.artifact_id ?? '—'))
  row('Kind', String(artifact.kind ?? '—'))
  row('Size', fmtBytes(artifact.size_bytes))
  const meta = artifact.metadata
  if (meta !== undefined && Object.keys(meta).length > 0) {
    modal.appendChild(el('div', 'section-label', 'Metadata'))
    for (const [k, v] of Object.entries(meta)) {
      row(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
  }
  const previewBtn = el('button', 'hbtn', '⧉ preview')
  previewBtn.style.cssText = 'margin-top:12px'
  previewBtn.onclick = () => {
    overlay.remove()
    void previewArtifact(artifact.artifact_id ?? '')
  }
  modal.appendChild(previewBtn)
  overlay.appendChild(modal)
  root.appendChild(overlay)
  trapFocus(overlay, null)
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
    const contentType = (blob.type ?? '').toLowerCase()
    const header = el('div', 'modal-header', `📦 ${artifactId.slice(0, 28)}${artifactId.length > 28 ? '…' : ''}`)
    if (contentType !== '') {
      // dsh-web metadata: show the served content type in the header.
      const chip = el('span', 'artifact-kind', contentType.slice(0, 24))
      chip.style.cssText += ';color:var(--text-3);font-size:9px'
      header.appendChild(chip)
    }
    const closeBtn = el('button', 'hbtn ghost', '×')
    closeBtn.onclick = () => { revoke(); overlay.remove() }
    header.appendChild(closeBtn)
    modal.appendChild(header)
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
      modal.appendChild(downloadLink(blob, artifactId))
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
      modal.appendChild(downloadLink(blob, artifactId))
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
      modal.appendChild(downloadLink(blob, artifactId))
    }
    // dsh-web depth: open blob-backed previews in their own browser tab.
    if (blobUrls.length > 0) {
      const openTab = el('button', 'hbtn', '⧉ open in tab')
      openTab.title = 'open the artifact in a new browser tab'
      openTab.style.cssText = 'margin-top:10px'
      openTab.onclick = () => {
        const url = blobUrls[blobUrls.length - 1]!
        window.open(url, '_blank', 'noopener')
      }
      modal.appendChild(openTab)
    }
    overlay.appendChild(modal)
    root.appendChild(overlay)
  } catch { /* bridge unreachable */ }
}

async function renderEvidence(body: HTMLElement, projectId: string): Promise<void> {
  const claims = (await api<ClaimRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/claims`)) ?? []
  const evidence = (await api<EvidenceRow[]>(`/v1/projects/${encodeURIComponent(projectId)}/evidence`)) ?? []
  // dsh-web search-as-you-type: filters both sections in place; only the
  // list container is rebuilt so the input keeps focus.
  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = '🔍 Filter claims & evidence…'
  searchInput.value = evidenceQuery
  searchInput.style.cssText = 'flex:1;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font:11px/1.4 system-ui,sans-serif;outline:none;margin:2px 0 6px'
  searchInput.onfocus = () => { searchInput.style.borderColor = 'var(--accent)' }
  searchInput.onblur = () => { searchInput.style.borderColor = 'var(--border)' }
  body.appendChild(searchInput)
  const listEl = el('div')
  body.appendChild(listEl)
  const renderList = (): void => {
    listEl.replaceChildren()
    const q = evidenceQuery.trim().toLowerCase()
    const cq = q === '' ? claims : claims.filter(c =>
      (c.statement ?? '').toLowerCase().includes(q) ||
      (c.claim_id ?? '').toLowerCase().includes(q) ||
      (c.status ?? '').toLowerCase().includes(q) ||
      (c.confidence ?? '').toLowerCase().includes(q),
    )
    const eq = q === '' ? evidence : evidence.filter(e =>
      (e.result?.primary_metric ?? '').toLowerCase().includes(q) ||
      String(e.result?.value ?? '').includes(q) ||
      (e.evidence_id ?? '').toLowerCase().includes(q) ||
      (e.analysis_method ?? '').toLowerCase().includes(q) ||
      (Array.isArray(e.run_ids) ? e.run_ids.join(' ') : '').toLowerCase().includes(q),
    )
    listEl.appendChild(el('div', 'section-label', `Claims (${cq.length})`))
    if (cq.length === 0) {
      listEl.appendChild(el('div', 'empty', q === '' ? 'No claims yet.' : `No claims match "${evidenceQuery.trim()}".`))
    }
    if (cq.length > 8) {
      const notice = el('div', 'muted', `Showing the newest 8 of ${cq.length} claims — use 🌐 global search for the rest.`)
      notice.style.cssText = 'font-size:10px;padding:2px;text-align:center'
      listEl.appendChild(notice)
    }
    for (const claim of cq.slice(-8).reverse()) {
      const card = el('div', 'evidence-card')
      const top = el('div', 'row')
      top.appendChild(pill(claim.status))
      const conf = el('span', 'muted', claim.confidence !== undefined && claim.confidence !== '' ? claim.confidence : '')
      top.appendChild(conf)
      top.appendChild(el('span', 'grow'))
      // dsh-web drawer: one-click claim details (double-click too).
      const claimBtn = el('button', 'hbtn', '⧉')
      claimBtn.title = 'claim details'
      claimBtn.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      claimBtn.onclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root !== null) openClaimDetailModal(root, claim)
      }
      top.appendChild(claimBtn)
      card.appendChild(top)
      card.title = 'double-click for claim details'
      card.ondblclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root !== null) openClaimDetailModal(root, claim)
      }
      const stmt = el('div', 'grow', claim.statement ?? '')
      stmt.style.cssText = 'margin-top:5px;color:var(--text);font-size:11.5px'
      card.appendChild(stmt)
      const id = el('div', 'muted mono', fmtId(claim.claim_id))
      id.style.cssText = 'margin-top:4px;font-size:10px'
      card.appendChild(id)
      listEl.appendChild(card)
    }
    listEl.appendChild(el('div', 'section-label', `Evidence (${eq.length})`))
    if (eq.length === 0) {
      listEl.appendChild(el('div', 'empty', q === '' ? 'No verified evidence yet — only the Analysis Worker can create it.' : `No evidence matches "${evidenceQuery.trim()}".`))
    }
    if (eq.length > 8) {
      const notice = el('div', 'muted', `Showing the newest 8 of ${eq.length} evidence items — use 🌐 global search for the rest.`)
      notice.style.cssText = 'font-size:10px;padding:2px;text-align:center'
      listEl.appendChild(notice)
    }
    for (const item of eq.slice(-8).reverse()) {
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
      // dsh-web drawer: one-click evidence details (double-click still works).
      const detailsBtn = el('button', 'hbtn', '⧉')
      detailsBtn.title = 'evidence details'
      detailsBtn.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      detailsBtn.onclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root !== null) openEvidenceDetailModal(root, item)
      }
      row.appendChild(detailsBtn)
      card.appendChild(row)
      const refsCount = Array.isArray(item.artifact_refs) ? item.artifact_refs.length : 0
      const runsCount = Array.isArray(item.run_ids) ? item.run_ids.length : 0
      const meta = el('div', 'muted', `CI [${r?.ci_low ?? '?'}, ${r?.ci_high ?? '?'}] · n=${r?.n_seeds ?? '?'} · ${item.analysis_method ?? '?'} · ${runsCount} run(s) · ${refsCount} artifact ref(s)`)
      meta.style.cssText = 'margin-top:4px'
      card.appendChild(meta)
      // dsh-web analysis depth: an effect-size bar (0-centred) per evidence.
      if (r?.effect_size !== undefined && r.ci_low !== undefined && r.ci_high !== undefined) {
        const bar = el('div')
        bar.style.cssText = 'position:relative;height:14px;margin-top:6px;background:var(--bg-3);border:1px solid var(--border);border-radius:6px;overflow:hidden'
        const lo = r.ci_low
        const hi = r.ci_high
        const eff = r.effect_size
        const span = Math.max(Math.abs(hi - lo), 0.0001)
        const zeroX = (0 - lo) / span * 100
        const effX = (eff - lo) / span * 100
        const width = Math.abs(effX - zeroX)
        const fill = el('div')
        fill.style.cssText = `position:absolute;top:0;bottom:0;left:${Math.min(zeroX, effX)}%;width:${width}%;background:${eff >= 0 ? 'var(--tone-green)' : 'var(--tone-red)'}`
        bar.appendChild(fill)
        const zero = el('div')
        zero.style.cssText = `position:absolute;top:0;bottom:0;left:${zeroX}%;width:1px;background:var(--text-3)`
        bar.appendChild(zero)
        const label = el('div', 'muted', `effect ${eff >= 0 ? '+' : ''}${eff}  (0 ─────────── CI bounds)`)
        label.style.cssText = 'font-size:9px;margin-top:2px;color:var(--text-3)'
        card.appendChild(bar)
        card.appendChild(label)
      }
      const id = el('div', 'muted mono', fmtId(item.evidence_id))
      id.style.cssText = 'margin-top:3px;font-size:10px'
      card.appendChild(id)
      card.title = 'double-click for evidence details'
      card.ondblclick = (event) => {
        event.stopPropagation()
        const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
        if (root !== null) openEvidenceDetailModal(root, item)
      }
      listEl.appendChild(card)
    }
  }
  searchInput.oninput = () => { evidenceQuery = searchInput.value; renderList() }
  renderList()
}

/** dsh-web claim drawer: statement, scope, evidence links and history. */
function openClaimDetailModal(root: ShadowRoot, claim: ClaimRow): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:540px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', 'Claim details')
  const header = el('div', 'modal-header', '🧾 Claim details')
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
  titleRow.appendChild(el('span', 'artifact-kind', (claim.status ?? '?').toUpperCase()))
  titleRow.appendChild(el('span', 'pname', fmtId(claim.claim_id ?? '', 30)))
  modal.appendChild(titleRow)

  const stmt = el('div', 'grow', claim.statement ?? '')
  stmt.style.cssText = 'font-size:12px;color:var(--text);line-height:1.55;margin-bottom:8px'
  modal.appendChild(stmt)

  modal.appendChild(el('div', 'section-label', 'Claim'))
  row('Claim', String(claim.claim_id ?? '—'))
  row('Status', String(claim.status ?? '—'))
  row('Confidence', String(claim.confidence ?? '—'))
  const scope = claim.scope
  if (scope !== undefined) {
    row('Dataset', String(scope.dataset ?? '—'))
    row('Split', String(scope.split ?? '—'))
  }
  const ev = claim.evidence
  if (ev !== undefined && (ev.evidence_ids ?? []).length > 0) {
    modal.appendChild(el('div', 'section-label', 'Supporting evidence'))
    for (const id of ev.evidence_ids ?? []) row('Evidence', fmtId(id, 40))
    if (typeof ev.analysis_artifact === 'string' && ev.analysis_artifact !== '') row('Analysis artifact', fmtId(ev.analysis_artifact, 40))
  }
  const limitations = claim.limitations ?? []
  if (limitations.length > 0) {
    modal.appendChild(el('div', 'section-label', 'Limitations'))
    for (const l of limitations) modal.appendChild(el('div', 'muted', `· ${l}`))
  }
  const history = claim.history ?? []
  if (history.length > 0) {
    modal.appendChild(el('div', 'section-label', 'Verification history'))
    for (const h of history) {
      const hrow = el('div', 'row')
      hrow.style.cssText = 'padding:2px 0;align-items:flex-start'
      hrow.appendChild(el('span', 'artifact-kind', String(h.status ?? '?')))
      const when = String(h.at ?? '').replace('T', ' ').slice(0, 16)
      const meta = el('div', 'grow muted', `${when}${h.reason !== undefined && h.reason !== '' ? ` — ${h.reason}` : ''}`)
      hrow.appendChild(meta)
      modal.appendChild(hrow)
    }
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  trapFocus(overlay, null)
}

/** dsh-web evidence drawer: provenance + result of one evidence item. */
function openEvidenceDetailModal(root: ShadowRoot, item: EvidenceRow): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:540px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', 'Evidence details')
  const header = el('div', 'modal-header', '📊 Evidence details')
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
  const r = item.result
  modal.appendChild(el('div', 'section-label', 'Result'))
  row('Metric', r?.primary_metric ?? '—')
  row('Value', String(r?.value ?? '—'))
  row('Effect', r?.effect_size !== undefined ? `Δ${r.effect_size >= 0 ? '+' : ''}${r.effect_size}` : '—')
  row('CI', `[${r?.ci_low ?? '—'}, ${r?.ci_high ?? '—'}]`)
  row('n seeds', String(r?.n_seeds ?? '—'))
  modal.appendChild(el('div', 'section-label', 'Provenance'))
  row('Evidence', String(item.evidence_id ?? '—'))
  row('Method', item.analysis_method ?? '—')
  row('Runs', Array.isArray(item.run_ids) ? item.run_ids.join(', ') : '—')
  row('Artifacts', Array.isArray(item.artifact_refs) ? item.artifact_refs.map(a => fmtId(a, 18)).join(', ') : '—')
  overlay.appendChild(modal)
  root.appendChild(overlay)
  trapFocus(overlay, null)
}

/** dsh-web budget drawer: constraints/execution/integrity of a project. */
function openBudgetDetailModal(root: ShadowRoot, p: Projection): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:540px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', 'Budget details')
  const header = el('div', 'modal-header', '💰 Budget & policy details')
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
  modal.appendChild(el('div', 'section-label', 'Usage'))
  row('Model cost', `$${b?.model_cost_usd ?? 0}${c?.max_model_cost_usd !== undefined ? ` / $${c.max_model_cost_usd}` : ''}`)
  row('GPU hours', `${b?.gpu_hours ?? 0}${c?.max_gpu_hours !== undefined ? ` / ${c.max_gpu_hours}` : ''}`)
  row('API requests', String(b?.api_requests ?? 0))
  modal.appendChild(el('div', 'section-label', 'Constraints'))
  row('Datasets', String(c?.datasets ?? '—'))
  row('Model upload', String(c?.external_model_upload ?? '—'))
  row('Parallel jobs', String(c?.max_parallel_jobs ?? '—'))
  modal.appendChild(el('div', 'section-label', 'Execution'))
  if (exec !== undefined) {
    row('Runner', String(exec.runner_profile ?? '—'))
    row('Network', String(exec.network_policy ?? '—'))
    row('Artifacts', String(exec.artifact_store ?? '—'))
  }
  modal.appendChild(el('div', 'section-label', 'Integrity'))
  if (integ !== undefined) {
    row('Baseline repro', String(integ.require_baseline_reproduction ?? '—'))
    row('Contract', String(integ.require_experiment_contract ?? '—'))
    row('Claim links', String(integ.require_claim_evidence_links ?? '—'))
    row('Clean-room', String(integ.require_clean_room_rerun ?? '—'))
    row('Auto release', String(integ.allow_automatic_public_release ?? '—'))
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  trapFocus(overlay, null)
}

function renderBudget(body: HTMLElement, p: Projection): void {
  const c = p.project?.constraints
  const b = p.budget
  const model = b?.model_cost_usd ?? 0
  const gpu = b?.gpu_hours ?? 0
  const modelMax = c?.max_model_cost_usd
  const gpuMax = c?.max_gpu_hours
  const labelRow = el('div', 'row')
  labelRow.style.cssText = 'justify-content:space-between;align-items:center'
  labelRow.appendChild(el('div', 'section-label', 'Budget'))
  const detailBtn = el('button', 'hbtn', 'ℹ details')
  detailBtn.style.cssText = 'padding:1px 10px;margin-bottom:2px'
  detailBtn.onclick = () => {
    const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
    if (root !== null) openBudgetDetailModal(root, p)
  }
  labelRow.appendChild(detailBtn)
  body.appendChild(labelRow)
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
  trapFocus(overlay, nameInput)
  nameInput.focus()
}

/* ─────────────────────────── rename modal ─────────────────────────── */

/**
 * dsh-web "session actions" rename: PATCH /v1/projects/:id {name}, audited
 * in the kernel history ledger.
 */
function openRenameModal(root: ShadowRoot, projectId: string, currentName: string, onDone: () => void): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:440px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', 'Rename project')
  const header = el('div', 'modal-header', '✎ Rename Project')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const hint = el('div', 'muted', `Current name: ${currentName} · rename is audited in the project history.`)
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
  const cancel = el('button', 'hbtn', 'Cancel')
  cancel.onclick = () => overlay.remove()
  const save = el('button', 'btn approve', 'Rename')
  save.style.cssText = 'padding:7px 18px'
  save.onclick = async () => {
    const name = input.value.trim()
    if (name === '') {
      err.textContent = 'Name must not be empty.'
      err.style.display = 'block'
      return
    }
    err.style.display = 'none'
    save.disabled = true
    save.textContent = 'Saving…'
    const result = await api<{ project_id?: string; name?: string }>(`/v1/projects/${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    })
    if (result === null || result.project_id === undefined) {
      err.textContent = 'Rename failed — is the kernel reachable?'
      err.style.display = 'block'
      save.disabled = false
      save.textContent = 'Rename'
      return
    }
    overlay.remove()
    onDone()
  }
  actions.append(cancel, save)
  modal.appendChild(actions)

  overlay.appendChild(modal)
  root.appendChild(overlay)
  input.focus()
  input.select()
}

/* ─────────────────────────── project detail modal ─────────────────────────── */

/**
 * dsh-web project drawer: full detail of one project (brief, constraints,
 * counts, pending gates, recent jobs, audit history).
 */
async function openProjectDetailModal(root: ShadowRoot, projectId: string): Promise<void> {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:600px;max-width:94vw'
  const header = el('div', 'modal-header', '📁 Project details')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const loading = el('div', 'muted', 'Loading…')
  modal.appendChild(loading)
  overlay.appendChild(modal)
  root.appendChild(overlay)

  const p = await api<Projection>(`/v1/projects/${encodeURIComponent(projectId)}/projection`)
  if (p === null || p.project === undefined) {
    loading.textContent = 'Project unavailable.'
    return
  }
  modal.removeChild(loading)
  const proj = p.project
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
  copyId.title = 'copy project ID'
  copyId.style.cssText = 'padding:1px 8px'
  copyId.onclick = () => copyText(projectId)
  titleRow.appendChild(copyId)
  modal.appendChild(titleRow)

  modal.appendChild(el('div', 'section-label', 'Overview'))
  row('Project', `\`${projectId}\` · rev ${proj.revision ?? 0}`)
  row('Problem', proj.brief?.problem ?? '—')
  row('Metrics', (proj.brief?.primary_metrics ?? []).join(', ') || '—')
  row('Workspace', proj.workspace ?? '—')

  const c = proj.constraints
  modal.appendChild(el('div', 'section-label', 'Constraints'))
  row('Budget', `$${c?.max_model_cost_usd ?? '∞'} max`)
  row('GPU hours', `${c?.max_gpu_hours ?? '∞'} max`)
  row('Parallel jobs', String(c?.max_parallel_jobs ?? '—'))

  const counts = p.counts
  if (counts !== undefined) {
    modal.appendChild(el('div', 'section-label', 'Contents'))
    row('Corpus snapshots', String(counts.corpus_snapshots ?? 0))
    row('Ideas / Contracts', `${counts.ideas ?? 0} / ${counts.contracts ?? 0}`)
    row('Claims / Evidence', `${counts.claims ?? 0} / ${counts.evidence ?? 0}`)
    row('Artifacts', String(counts.artifacts ?? 0))
  }

  const pending = p.pending_gates ?? []
  modal.appendChild(el('div', 'section-label', 'Pending gates'))
  if (pending.length === 0) {
    modal.appendChild(el('div', 'empty', 'none'))
  }
  for (const g of pending) {
    modal.appendChild(el('div', '', `- ${g.type} gate \`${g.gate_id}\`: ${g.title} (${g.status})`))
  }
  if (pending.length > 0) {
    // dsh-web depth: jump from the drawer to the Gates tab.
    const goGates = el('button', 'hbtn', '→ open Gates tab')
    goGates.style.cssText = 'margin-top:8px'
    goGates.onclick = () => {
      overlay.remove()
      activeTab = 'gates'
      tabSave()
      rerender()
    }
    modal.appendChild(goGates)
  }

  const jobs = (p.jobs ?? []).slice(-5)
  modal.appendChild(el('div', 'section-label', 'Recent jobs'))
  if (jobs.length === 0) {
    modal.appendChild(el('div', 'empty', 'none'))
  }
  for (const j of jobs) {
    modal.appendChild(el('div', '', `- \`${j.job_id}\` [${j.kind}] ${j.status}`))
  }

  // dsh-web guidance: next actions of the kernel for this project.
  const nextActions = (p.next_actions ?? []).filter(Boolean)
  if (nextActions.length > 0) {
    modal.appendChild(el('div', 'section-label', 'Next actions'))
    for (const a of nextActions) {
      modal.appendChild(el('div', '', `➡️ ${a}`))
    }
  }

  const history = (proj.history ?? []).slice(-6)
  modal.appendChild(el('div', 'section-label', 'Audit history'))
  for (const h of history) {
    modal.appendChild(el('div', 'muted', `· ${h}`))
  }

  // dsh-web export: full project JSON (projection + gates + jobs + ideas
  // + contracts + evidence + artifacts) as a downloadable file.
  const exportRow = el('div', 'row')
  exportRow.style.cssText = 'justify-content:flex-end;gap:8px;margin-top:16px'
  const exportBtn = el('button', 'btn approve', '⬇ Export JSON')
  exportBtn.style.cssText = 'padding:7px 16px'
  exportBtn.onclick = async () => {
    exportBtn.textContent = 'Exporting…'
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
    const a = el('a', 'dl', 'download')
    a.href = url
    a.download = `${proj.name ?? projectId}.research.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    exportBtn.textContent = '✓ exported'
    setTimeout(() => { exportBtn.textContent = '⬇ Export JSON' }, 2000)
  }
  exportRow.appendChild(exportBtn)
  modal.appendChild(exportRow)
}

/* ─────────────────────────── job detail modal ─────────────────────────── */

/**
 * dsh-web job drawer: full record of one run (kind, status, error,
 * contract, run manifest digest) plus a cancel action when cancellable.
 */
async function openJobDetailModal(root: ShadowRoot, jobId: string): Promise<void> {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:560px;max-width:94vw'
  const header = el('div', 'modal-header', '⚙️ Job details')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const loading = el('div', 'muted', 'Loading…')
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
    loading.textContent = 'Job not found.'
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

  modal.appendChild(el('div', 'section-label', 'Run'))
  row('Job', `\`${String(job.job_id)}\``)
  row('Kind', String(job.kind ?? '—'))
  row('Status', String(job.status ?? '—'))
  if (typeof job.contract_id === 'string' && job.contract_id !== '') row('Contract', job.contract_id)
  if (typeof job.failure_class === 'string' && job.failure_class !== '') row('Failure', job.failure_class)
  if (typeof job.error === 'string' && job.error !== '') row('Error', job.error)

  const manifest = job.run_manifest
  if (typeof manifest === 'object' && manifest !== null) {
    modal.appendChild(el('div', 'section-label', 'RunManifest'))
    const m = manifest as Record<string, unknown>
    if (typeof m.run_id === 'string') row('Run', m.run_id)
    if (typeof m.exit_code === 'number') row('Exit code', String(m.exit_code))
    if (typeof m.container_digest === 'string' && m.container_digest !== '') row('Container', m.container_digest)
    if (typeof m.runner_key_id === 'string') row('Signer', m.runner_key_id)
    if (typeof m.metrics_artifact === 'string') row('Metrics', fmtId(m.metrics_artifact, 24))
    // dsh-web depth: copy the signed manifest for external verification.
    const copyManifest = el('button', 'hbtn', '⧉ copy manifest')
    copyManifest.title = 'copy the full RunManifest as JSON'
    copyManifest.style.cssText = 'margin-top:8px'
    copyManifest.onclick = () => {
      void navigator.clipboard.writeText(JSON.stringify(m, null, 2)).then(
        () => { copyManifest.textContent = '✓ copied' },
        () => { copyManifest.textContent = 'copy failed' },
      )
      setTimeout(() => { copyManifest.textContent = '⧉ copy manifest' }, 1600)
    }
    modal.appendChild(copyManifest)
  }

  const status = String(job.status ?? '')
  if (['queued', 'running', 'retryable'].includes(status)) {
    const cancelRow = el('div', 'row')
    cancelRow.style.cssText = 'justify-content:flex-end;margin-top:12px'
    const cancel = el('button', 'btn cancel', '✕ Cancel job')
    cancel.onclick = async () => {
      const ok = await api(`/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ actor: 'web-user', reason: 'cancelled from job details' }),
      })
      if (ok !== null) overlay.remove()
      rerender()
    }
    cancelRow.appendChild(cancel)
    modal.appendChild(cancelRow)
  }
}

/* ─────────────────────────── contract detail modal ─────────────────────────── */

/** dsh-web contract drawer: full record of an ExperimentContract. */
function openContractDetailModal(root: ShadowRoot, contract: Record<string, unknown>): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', 'Contract details')
  const header = el('div', 'modal-header', '📋 Contract details')
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
  modal.appendChild(el('div', 'section-label', 'Contract'))
  row('Contract', String(contract.contract_id ?? '—'))
  row('Status', String(contract.status ?? '—'))
  if (typeof contract.version === 'string') row('Version', contract.version)
  if (typeof contract.idea_id === 'string') row('Idea', contract.idea_id)
  if (data !== undefined) {
    modal.appendChild(el('div', 'section-label', 'Data'))
    if (typeof data.dataset_id === 'string') row('Dataset', data.dataset_id)
    if (typeof data.split === 'string') row('Split', data.split)
    if (typeof data.version === 'string') row('Version', data.version)
  }
  if (methods !== undefined) {
    modal.appendChild(el('div', 'section-label', 'Methods'))
    row('Baseline', String(methods.baseline ?? '—'))
    row('Treatment', String(methods.treatment ?? '—'))
  }
  if (metrics !== undefined) {
    modal.appendChild(el('div', 'section-label', 'Metrics'))
    row('Primary', String(metrics.primary ?? '—'))
    const secondary = Array.isArray(metrics.secondary) ? (metrics.secondary as string[]).join(', ') : '—'
    row('Secondary', secondary)
  }
  const seeds = Array.isArray(contract.seeds) ? (contract.seeds as number[]).join(', ') : '—'
  modal.appendChild(el('div', 'section-label', 'Analysis'))
  row('Seeds', seeds)
  if (analysis !== undefined) {
    row('Effect', String(analysis.effect_size ?? '—'))
    row('Interval', String(analysis.interval ?? '—'))
    row('Correction', String(analysis.multiple_testing ?? '—'))
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  trapFocus(overlay, null)
}

/* ─────────────────────────── idea detail modal ─────────────────────────── */

/** dsh-web idea drawer: full record of an IdeaCard. */
function openIdeaDetailModal(root: ShadowRoot, idea: Record<string, unknown>): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:540px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', 'Idea details')
  const header = el('div', 'modal-header', '💡 Idea details')
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
  titleRow.appendChild(el('span', 'pname', String(idea.title ?? 'untitled')))
  titleRow.appendChild(el('span', 'grow'))
  titleRow.appendChild(pill(String(idea.status ?? '')))
  modal.appendChild(titleRow)

  const mve = idea.minimum_viable_experiment as Record<string, unknown> | undefined
  const fals = idea.falsification as Record<string, unknown> | undefined
  const scores = idea.scores as Record<string, unknown> | undefined
  modal.appendChild(el('div', 'section-label', 'Idea'))
  row('Idea', String(idea.idea_id ?? '—'))
  row('Status', String(idea.status ?? '—'))
  if (typeof idea.hypothesis === 'string') row('Hypothesis', idea.hypothesis)
  if (typeof idea.exact_delta === 'string') row('Delta', idea.exact_delta)
  if (fals !== undefined) row('Falsification', String(fals.observation ?? '—'))
  if (mve !== undefined) {
    modal.appendChild(el('div', 'section-label', 'Minimum viable experiment'))
    row('Dataset', String(mve.dataset ?? '—'))
    row('Baseline', String(mve.baseline ?? '—'))
    row('Metric', String(mve.primary_metric ?? '—'))
    if (typeof mve.estimated_gpu_hours === 'number') row('GPU hours', String(mve.estimated_gpu_hours))
  }
  if (scores !== undefined) {
    modal.appendChild(el('div', 'section-label', 'Scores'))
    row('Feasibility', String(scores.feasibility ?? '—'))
    row('Information', String(scores.information_gain ?? '—'))
    row('Reproducibility', String(scores.reproducibility ?? '—'))
    row('Cost', String(scores.cost ?? '—'))
  }
  const novelty = idea.novelty_audit as Record<string, unknown> | undefined
  if (novelty !== undefined) {
    modal.appendChild(el('div', 'section-label', 'Novelty audit'))
    row('Result', String(novelty.result ?? '—'))
    if (typeof novelty.unresolved_risk === 'string') row('Risk', novelty.unresolved_risk)
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  trapFocus(overlay, null)
}

/* ─────────────────────────── commands modal ─────────────────────────── */

const FAV_CMDS_KEY = 'dsh-scholar-ui-favcmds'

/** Favourite command names (dsh-web quick commands), persisted. */
function favCommands(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_CMDS_KEY)
    if (raw === null) return new Set()
    const parsed = JSON.parse(raw) as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function favCommandToggle(name: string): void {
  const favs = favCommands()
  if (favs.has(name)) favs.delete(name)
  else favs.add(name)
  try { localStorage.setItem(FAV_CMDS_KEY, JSON.stringify([...favs])) } catch { /* private mode */ }
}

/** Execute a command line in the Chat tab (fill + run). */
function runChatLine(line: string): void {
  chatDraft = line
  activeTab = 'chat'
  rerender()
}

/* ─────────────────────────── shortcuts modal ─────────────────────────── */

const SHORTCUTS: Array<[string, string]> = [
  ['Alt+1..7', 'switch tab (Chat, Phase, Gates, Runs, Artifacts, Evidence, Budget)'],
  ['Ctrl/Cmd+K', 'open the command palette'],
  ['Ctrl/Cmd+P', 'quick project switcher'],
  ['Ctrl/Cmd+Shift+T', 'toggle light/dark theme'],
  ['Ctrl+1..9', 'select the Nth chat session'],
  ['Ctrl+Tab', 'cycle chat sessions'],
  ['Ctrl+↑ / Ctrl+↓', 'walk chat messages (details panel)'],
  ['Home / End', 'jump to the first / last message'],
  ['/ (not typing)', 'focus the chat composer with a leading slash'],
  ['↑ / ↓ (composer)', 'walk command history'],
  ['Tab (composer)', 'complete the command name'],
  ['Shift+Enter (composer)', 'newline without sending'],
  ['Enter (composer)', 'send / fill completion'],
  ['Esc', 'close modal / context menu / details / quote'],
  ['?', 'open this shortcut reference'],
  ['Double-click project', 'open the project detail drawer'],
  ['Double-click run / artifact', 'open the job / artifact detail drawer'],
  ['Right-click project / session', 'context menu (open, rename, archive, copy)'],
  ['Right-click tab', 'pin / unpin a favourite tab'],
  ['↑ / ↓ + Enter (global search)', 'walk hits and jump to the selected one'],
]

/** dsh-web shortcut reference modal. */
function openShortcutsModal(root: ShadowRoot): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'
  const header = el('div', 'modal-header', '⌨ Keyboard Shortcuts')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)
  for (const [keys, desc] of SHORTCUTS) {
    const row = el('div', 'row')
    row.style.cssText = 'padding:5px 0;align-items:flex-start'
    const k = el('span', 'artifact-kind', keys)
    k.style.cssText += ';min-width:150px;text-align:center'
    const d = el('span', 'grow', desc)
    d.style.cssText = 'font-size:11.5px;color:var(--text)'
    row.append(k, d)
    modal.appendChild(row)
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
}

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
/** Command palette filter (dsh-web search-as-you-type), persisted across
 * reopenings of the palette. */
let paletteQuery = ''

function openCommandsModal(root: ShadowRoot): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:560px;max-width:92vw'
  modal.setAttribute('aria-describedby', 'cmd-desc')
  const header = el('div', 'modal-header', '⌘ Research Commands')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const hint = el('div', 'muted', `${CHAT_COMMANDS.length} commands — click one to run it in the Chat tab (or type it there directly).`)
  hint.id = 'cmd-desc'
  hint.style.cssText = 'margin-bottom:10px;font-size:11.5px'
  modal.appendChild(hint)

  // dsh-web command palette: filter-as-you-type over name/line/description.
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = '🔍 Filter commands…'
  input.value = paletteQuery
  input.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 11px;font:12px/1.4 system-ui,sans-serif;outline:none;margin-bottom:10px'
  input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
  input.onblur = () => { input.style.borderColor = 'var(--border)' }
  modal.appendChild(input)

  const list = el('div')
  list.style.cssText = 'max-height:46vh;overflow-y:auto'
  modal.appendChild(list)

  const renderList = (): void => {
    list.replaceChildren()
    const q = paletteQuery.trim().toLowerCase()
    const matches = q === '' ? CHAT_COMMANDS : CHAT_COMMANDS.filter(([name, line, desc]) =>
      name.toLowerCase().includes(q) || line.toLowerCase().includes(q) || desc.toLowerCase().includes(q),
    )
    // dsh-web favourites: ★ commands sort to the top of the palette.
    const favsSet = favCommands()
    const ordered = q === ''
      ? [...matches].sort((a, b) => (favsSet.has(b[0]) ? 1 : 0) - (favsSet.has(a[0]) ? 1 : 0))
      : matches
    if (ordered.length === 0) {
      list.appendChild(el('div', 'empty', `No commands match "${paletteQuery.trim()}".`))
      return
    }
    for (const [name, line, desc] of ordered) {
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
      const favBtn = el('span', 'artifact-kind', favCommands().has(name) ? '★' : '☆')
      favBtn.title = favCommands().has(name) ? 'unfavourite command' : 'favourite command (quick run)'
      favBtn.style.cssText += ';cursor:pointer;color:' + (favCommands().has(name) ? 'var(--tone-amber)' : 'var(--text-3)')
      favBtn.onclick = (event) => {
        event.stopPropagation()
        favCommandToggle(name)
        overlay.remove()
        openCommandsModal(root)
      }
      row.append(nameEl, bodyEl, favBtn)
      row.onclick = () => {
        overlay.remove()
        chatDraft = line
        activeTab = 'chat'
        rerender()
      }
      list.appendChild(row)
    }
  }
  input.oninput = () => { paletteQuery = input.value; renderList() }
  renderList()
  // dsh-web palette navigation: ↑/↓ move through the command rows (the
  // rows are buttons, so Enter on a focused row runs it natively).
  modal.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = [...list.querySelectorAll('button')] as HTMLElement[]
    if (rows.length === 0) return
    event.preventDefault()
    const cur = rows.indexOf(root.activeElement as HTMLElement)
    const next = cur < 0
      ? (event.key === 'ArrowDown' ? 0 : rows.length - 1)
      : (cur + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
    rows[next]?.focus()
  })
  overlay.appendChild(modal)
  root.appendChild(overlay)
  input.focus()
  trapFocus(overlay, null)
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
  // dsh-web connection details: the exact bridge endpoint, copyable.
  const bridgeEnd = `${location.origin}${base()}/v1`
  const bridgeRow = el('div', 'row')
  bridgeRow.style.cssText = 'padding:4px 0'
  const bridgeLabel = el('span', '', 'Endpoint')
  bridgeLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const bridgeValue = el('span', 'mono', bridgeEnd)
  bridgeValue.style.cssText = 'font-size:11px;color:var(--text);word-break:break-all;flex:1'
  const bridgeCopy = el('button', 'hbtn', '⧉')
  bridgeCopy.title = 'copy endpoint'
  bridgeCopy.style.cssText = 'padding:1px 8px'
  bridgeCopy.onclick = () => copyText(bridgeEnd)
  bridgeRow.append(bridgeLabel, bridgeValue, bridgeCopy)
  modal.appendChild(bridgeRow)

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
    const copyTok = el('button', 'hbtn', '⧉')
    copyTok.title = 'copy token'
    copyTok.style.cssText = 'padding:1px 8px'
    copyTok.onclick = async () => {
      const t = await tokenProvider()
      if (t !== null && t !== undefined) copyText(t)
    }
    tokRow.append(tokLabel, tokValue, reveal, copyTok)
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

  // Preferences: density, auto-refresh (dsh-web settings feel).
  modal.appendChild(section('Preferences'))
  const densRow = el('div', 'row')
  densRow.style.cssText = 'padding:4px 0'
  const densLabel = el('span', '', 'Density')
  densLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const densValue = el('span', 'mono', density === 'compact' ? 'compact' : 'normal')
  densValue.style.cssText = 'font-size:11px'
  const densToggle = el('button', 'hbtn', 'Toggle')
  densToggle.style.cssText = 'padding:1px 8px'
  densToggle.onclick = () => {
    density = density === 'compact' ? 'normal' : 'compact'
    const hostEl = document.querySelector('#dsh-scholar-ui')
    const panelEl = hostEl !== null ? hostEl.shadowRoot?.querySelector('.panel') as HTMLElement | null : null
    if (panelEl !== null) densityApply(panelEl)
    densValue.textContent = density
    rerender()
  }
  densRow.append(densLabel, densValue, densToggle)
  modal.appendChild(densRow)

  const refreshRow = el('div', 'row')
  refreshRow.style.cssText = 'padding:4px 0'
  const refreshLabel = el('span', '', 'Auto refresh')
  refreshLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const refreshValue = el('span', 'mono', autoRefreshEnabled() ? '8s polling' : 'off')
  refreshValue.style.cssText = 'font-size:11px'
  const refreshToggle = el('button', 'hbtn', 'Toggle')
  refreshToggle.style.cssText = 'padding:1px 8px'
  refreshToggle.onclick = () => {
    const next = !autoRefreshEnabled()
    autoRefreshSet(next)
    if (next && timer === null) timer = startTimer()
    if (!next && timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
    refreshValue.textContent = next ? '8s polling' : 'off'
  }
  refreshRow.append(refreshLabel, refreshValue, refreshToggle)
  modal.appendChild(refreshRow)

  // Accent colour (dsh-web theming).
  const accentRow = el('div', 'row')
  accentRow.style.cssText = 'padding:4px 0'
  const accentLabel = el('span', '', 'Accent')
  accentLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const accentSelect = el('select', 'picker')
  accentSelect.style.cssText = 'flex:1;padding:3px 6px;font-size:11px;border-radius:7px'
  const currentAccent = (Object.entries(ACCENTS).find(([, v]) => v === accentColor())?.[0] ?? 'blue')
  for (const [name, color] of Object.entries(ACCENTS)) {
    const opt = el('option', '', `${name} (${color})`)
    opt.value = name
    accentSelect.appendChild(opt)
  }
  accentSelect.value = currentAccent
  accentSelect.onchange = () => {
    accentSet(accentSelect.value)
    const hostEl = document.querySelector('#dsh-scholar-ui')
    const dark = hostEl?.dataset.theme === 'dark'
    const name = accentSelect.value
    const c = dark ? (ACCENT_DARK[name] ?? accentColor()) : accentColor()
    hostEl?.style.setProperty('--accent', c)
    hostEl?.style.setProperty('--accent-soft', `${c}1f`)
    hostEl?.style.setProperty('--accent-text', c)
    rerender()
  }
  accentRow.append(accentLabel, accentSelect)
  modal.appendChild(accentRow)

  // Corner radius (dsh-web appearance).
  const radiusRow = el('div', 'row')
  radiusRow.style.cssText = 'padding:4px 0'
  const radiusLabel = el('span', '', 'Corners')
  radiusLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const radiusSelect = el('select', 'picker')
  radiusSelect.style.cssText = 'flex:1;padding:3px 6px;font-size:11px;border-radius:7px'
  const currentRadius = Object.entries(RADII).find(([, v]) => v === radiusValue())?.[0] ?? 'normal'
  for (const [name, val] of Object.entries(RADII)) {
    const opt = el('option', '', `${name} (${val})`)
    opt.value = name
    radiusSelect.appendChild(opt)
  }
  radiusSelect.value = currentRadius
  radiusSelect.onchange = () => {
    radiusSet(radiusSelect.value)
    const hostEl = document.querySelector('#dsh-scholar-ui')
    hostEl?.style.setProperty('--panel-radius', radiusValue())
    rerender()
  }
  radiusRow.append(radiusLabel, radiusSelect)
  modal.appendChild(radiusRow)

  // Background texture (dsh-web appearance).
  const textureRow = el('div', 'row')
  textureRow.style.cssText = 'padding:4px 0'
  const textureLabel = el('span', '', 'Texture')
  textureLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const textureSelect = el('select', 'picker')
  textureSelect.style.cssText = 'flex:1;padding:3px 6px;font-size:11px;border-radius:7px'
  const currentTexture = textureValue()
  for (const name of Object.keys(TEXTURES)) {
    const opt = el('option', '', name)
    opt.value = name
    textureSelect.appendChild(opt)
  }
  textureSelect.value = currentTexture
  textureSelect.onchange = () => {
    textureSet(textureSelect.value)
    const hostEl = document.querySelector('#dsh-scholar-ui')
    if (hostEl !== null) hostEl.dataset.texture = textureValue()
    rerender()
  }
  textureRow.append(textureLabel, textureSelect)
  modal.appendChild(textureRow)

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

  // dsh-web share/summary: copy a markdown summary of the active project.
  modal.appendChild(section('Project'))
  const projRow = el('div', 'row')
  projRow.style.cssText = 'padding:4px 0'
  const projLabel = el('span', '', 'Summary')
  projLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const summaryBtn = el('button', 'hbtn', 'Copy markdown')
  summaryBtn.style.cssText = 'padding:2px 10px'
  summaryBtn.onclick = async () => {
    const id = projectId
    if (id === undefined) return
    const p = await api<Projection>(`/v1/projects/${encodeURIComponent(id)}/projection`)
    if (p === null || p.project === undefined) {
      summaryBtn.textContent = 'unavailable'
      return
    }
    const counts = p.counts ?? {}
    const lines = [
      `# ${p.project.name}`,
      '',
      `- Project: \`${id}\``,
      `- Phase: \`${p.project.status}\` (rev ${p.project.revision ?? 0})`,
      `- Problem: ${p.project.brief?.problem ?? '—'}`,
      `- Primary metrics: ${(p.project.brief?.primary_metrics ?? []).join(', ') || '—'}`,
      `- Corpus snapshots: ${counts.corpus_snapshots ?? 0} · Ideas: ${counts.ideas ?? 0} · Contracts: ${counts.contracts ?? 0}`,
      `- Claims: ${counts.claims ?? 0} · Evidence: ${counts.evidence ?? 0} · Artifacts: ${counts.artifacts ?? 0}`,
      `- Pending gates: ${(p.pending_gates ?? []).map(g => `${g.type} (${g.status})`).join(', ') || 'none'}`,
      `- Next: ${(p.next_actions ?? []).join('; ') || '—'}`,
    ]
    await navigator.clipboard.writeText(lines.join('\n'))
    summaryBtn.textContent = '✓ copied'
    setTimeout(() => { summaryBtn.textContent = 'Copy markdown' }, 1800)
  }
  projRow.append(projLabel, summaryBtn)
  modal.appendChild(projRow)

  const about = el('button', 'hbtn', 'ℹ About this plugin')
  about.style.cssText = 'margin-top:16px;padding:3px 12px;align-self:flex-start'
  about.onclick = () => { openAboutModal(root) }
  modal.appendChild(about)

  // dsh-web data management: clear every local preference/transcript.
  modal.appendChild(section('Help'))
  const helpRow = el('div', 'row')
  helpRow.style.cssText = 'padding:4px 0'
  const helpBtn = el('button', 'hbtn', '⌨ Keyboard shortcuts')
  helpBtn.style.cssText = 'padding:2px 10px'
  helpBtn.onclick = () => { overlay.remove(); openShortcutsModal(root) }
  helpRow.appendChild(helpBtn)
  modal.appendChild(helpRow)

  modal.appendChild(section('Data'))
  const resetRow = el('div', 'row')
  resetRow.style.cssText = 'padding:4px 0'
  const resetLabel = el('span', '', 'Local data')
  resetLabel.style.cssText = 'width:130px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
  const resetBtn = el('button', 'btn cancel', '🗑 Reset preferences')
  resetBtn.style.cssText = 'padding:3px 10px;font-size:11px'
  resetBtn.title = 'clear theme, tabs, sessions, history and notifications (reload to apply)'
  resetBtn.onclick = () => {
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      // The access token survives a preference reset (no forced re-login).
      if (k !== null && k.startsWith('dsh-scholar-ui-') && k !== 'dsh-scholar-ui-token') toRemove.push(k)
    }
    for (const k of toRemove) localStorage.removeItem(k)
    overlay.remove()
    showToast(rootHost(), '🗑 Local preferences cleared — reload the page to apply')
  }
  resetRow.append(resetLabel, resetBtn)
  modal.appendChild(resetRow)

  overlay.appendChild(modal)
  root.appendChild(overlay)
  trapFocus(overlay, null)
}

/* ─────────────────────────── about modal ─────────────────────────── */

/** dsh-web "About": version, architecture and feature-surface summary. */
function openAboutModal(root: ShadowRoot): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'
  const header = el('div', 'modal-header', 'ℹ About Research OS')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const intro = el('div', 'muted', 'DSH Scholar — Research OS standalone web plugin. A fully self-contained research workspace: plan, run and review experiments with human-gated decisions.')
  intro.style.cssText = 'font-size:12px;line-height:1.6'
  modal.appendChild(intro)

  const row = (label: string, value: string): void => {
    const r = el('div', 'row')
    r.style.cssText = 'padding:4px 0'
    const l = el('span', '', label)
    l.style.cssText = 'width:150px;color:var(--text-2);font-size:11.5px;flex-shrink:0'
    const v = el('span', 'mono', value)
    v.style.cssText = 'font-size:11px;color:var(--text);word-break:break-all'
    r.append(l, v)
    modal.appendChild(r)
  }
  modal.appendChild(el('div', 'section-label', 'Version'))
  row('Plugin', 'v0.2 (hardening branch)')
  row('Surface', 'Chat · Phase · Gates · Runs · Artifacts · Evidence · Budget')
  row('Kernel', 'Research Kernel (SQLite + CAS)')
  row('Runner', 'docker isolation (baseline/pilot/formal/reproduce)')

  modal.appendChild(el('div', 'section-label', 'Architecture'))
  const arch = el('div', 'muted', 'The plugin serves its own origin with a bundled kernel sidecar. The browser talks to a same-origin /v1 proxy protected by a bearer token and CSRF origin checks (design §15.2/§15.3). Every gate decision is recorded in the kernel ledger with the operator identity; experiment jobs run in disposable containers with Ed25519-signed run manifests.')
  arch.style.cssText = 'font-size:11.5px;line-height:1.6'
  modal.appendChild(arch)

  modal.appendChild(el('div', 'section-label', 'Safety model'))
  const safety = el('div', 'muted', 'gate-only mode: scope / idea / contract / release gates always require a human decision (Approve/Reject in the Gates tab or the sidebar). Budget overruns park the project as BLOCKED_GATE until a human Budget Gate approves.')
  safety.style.cssText = 'font-size:11.5px;line-height:1.6'
  modal.appendChild(safety)

  const footer = el('div', 'muted', 'DSH Scholar · standalone Research OS · BSD-3-Clause')
  footer.style.cssText = 'margin-top:16px;font-size:10.5px'
  modal.appendChild(footer)

  overlay.appendChild(modal)
  root.appendChild(overlay)
}

/* ─────────────────────────── toast notifications ─────────────────────────── */

/** Resolve the panel's shadow root from anywhere. */
function rootHost(): ShadowRoot | null {
  const hostEl = document.querySelector('#dsh-scholar-ui')
  return hostEl !== null ? hostEl.shadowRoot : null
}

/** dsh-web notification centre: toast history (persisted, 30 max). */
const NOTIF_KEY = 'dsh-scholar-ui-notifs'
const NOTIF_READ_KEY = 'dsh-scholar-ui-notifs-read'
interface NotifEntry { text: string; time: string; ts?: number; count?: number }
let notifHistory: Array<NotifEntry> = []
/** Unread badge count (dsh-web notification dot). */
let notifUnread = 0
function notifLoad(): void {
  try {
    const raw = localStorage.getItem(NOTIF_KEY)
    if (raw === null) return
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      notifHistory = parsed.filter((n): n is NotifEntry => typeof n === 'object' && n !== null && typeof (n as { text?: unknown }).text === 'string').slice(-30)
    }
    const readRaw = localStorage.getItem(NOTIF_READ_KEY)
    notifUnread = readRaw === null ? 0 : Math.max(0, notifHistory.length - Number(readRaw))
  } catch { /* private mode */ }
}
function notifPersist(): void {
  try { localStorage.setItem(NOTIF_KEY, JSON.stringify(notifHistory.slice(-30))) } catch { /* private mode */ }
}
function notifClear(): void {
  notifHistory = []
  notifUnread = 0
  notifPersist()
  try { localStorage.setItem(NOTIF_READ_KEY, '0') } catch { /* private mode */ }
}
function notifMarkRead(): void {
  notifUnread = 0
  try { localStorage.setItem(NOTIF_READ_KEY, String(notifHistory.length)) } catch { /* private mode */ }
}

/** dsh-web a11y: trap Tab focus inside a modal; Escape already handled
 * globally. Returns a cleanup that restores focus to the trigger. */
function trapFocus(overlay: HTMLElement, trigger: HTMLElement | null): () => void {
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return
    const focusables = [...overlay.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')] as HTMLElement[]
    if (focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  overlay.addEventListener('keydown', onKey)
  return () => {
    overlay.removeEventListener('keydown', onKey)
    trigger?.focus()
  }
}

/** dsh-web context menu: a right-click popup menu with keyboard support
 * (↑/↓ navigate, Enter picks, Esc closes, click-away closes). The scrim is
 * transparent so the page stays visible; Escape is also handled globally. */
interface ContextMenuItem {
  label: string
  hint?: string
  danger?: boolean
  onPick: () => void
}
function openContextMenu(root: ShadowRoot, x: number, y: number, items: ContextMenuItem[]): void {
  const scrim = el('div', 'ctx-scrim')
  scrim.style.cssText = 'position:fixed;inset:0;z-index:10001;background:transparent'
  const menu = el('div')
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', 'context menu')
  menu.style.cssText = 'position:fixed;min-width:200px;background:var(--bg-2);border:1px solid var(--border-strong);border-radius:10px;padding:4px;box-shadow:0 12px 40px rgba(0,0,0,.35);z-index:10002;font:12px/1.4 system-ui,sans-serif;color:var(--text)'
  const menuButtons: HTMLButtonElement[] = []
  for (const it of items) {
    const btn = el('button')
    btn.setAttribute('role', 'menuitem')
    btn.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:14px;width:100%;border:0;background:none;color:var(--text);text-align:left;padding:6px 10px;border-radius:7px;cursor:pointer;font:inherit'
    if (it.danger === true) btn.style.color = 'var(--tone-red)'
    const label = el('span', '', it.label)
    btn.appendChild(label)
    if (it.hint !== undefined) {
      const hint = el('span', 'muted', it.hint)
      hint.style.cssText = 'font-size:10px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      btn.appendChild(hint)
    }
    btn.onmouseenter = () => { btn.style.background = 'var(--bg-hover)' }
    btn.onmouseleave = () => { btn.style.background = 'none' }
    btn.onclick = () => { scrim.remove(); it.onPick() }
    menu.appendChild(btn)
    menuButtons.push(btn)
  }
  scrim.onclick = () => scrim.remove()
  scrim.oncontextmenu = (event) => { event.preventDefault(); scrim.remove() }
  scrim.appendChild(menu)
  root.appendChild(scrim)
  // Position near the cursor, flipping at the right/bottom viewport edges.
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - mw - 8))}px`
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - mh - 8))}px`
  // Keyboard navigation (dsh-web menu feel).
  let idx = 0
  menuButtons[0]?.focus()
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      idx = (idx + (event.key === 'ArrowDown' ? 1 : -1) + menuButtons.length) % menuButtons.length
      menuButtons[idx]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      scrim.remove()
    }
  })
}

/** Copy text to the clipboard with a toast confirmation and a fallback for
 * non-secure contexts (dsh-web "copy" affordance). */
function copyText(text: string): void {
  const confirm = (): void => {
    const root = rootHost()
    if (root !== null) showToast(root, `Copied: ${text.length > 48 ? `${text.slice(0, 48)}…` : text}`)
  }
  const fallback = (): void => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    ta.remove()
    confirm()
  }
  if (navigator.clipboard !== undefined && navigator.clipboard.writeText !== undefined) {
    navigator.clipboard.writeText(text).then(confirm).catch(fallback)
  } else {
    fallback()
  }
}

/** dsh-web toast: a transient status pill bottom-center (2.4s), recorded.
 * Identical toasts inside a 60s window aggregate into a ×N counter (dsh-web
 * notification aggregation) instead of flooding the history. */
function showToast(root: ShadowRoot | null, text: string): void {
  const now = Date.now()
  const last = notifHistory[notifHistory.length - 1]
  if (last !== undefined && last.text === text && (last.ts ?? 0) > now - 60000) {
    last.count = (last.count ?? 1) + 1
    last.time = new Date().toLocaleTimeString()
  } else {
    notifHistory.push({ text, time: new Date().toLocaleTimeString(), ts: now })
  }
  notifPersist()
  notifUnread += 1
  if (root === null) return
  const existing = root.querySelector('.toast')
  existing?.remove()
  const toast = el('div', 'toast', text)
  toast.setAttribute('role', 'status')
  toast.setAttribute('aria-live', 'polite')
  // dsh-web toast: click to dismiss it early.
  toast.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:10001;background:var(--bg-2);border:1px solid var(--border-strong);color:var(--text);border-radius:99px;padding:6px 16px;font:600 11.5px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3);cursor:pointer;max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
  toast.onclick = () => toast.remove()
  root.appendChild(toast)
  setTimeout(() => toast.remove(), 2400)
}

/** dsh-web notification centre modal. */
function openNotificationsModal(root: ShadowRoot): void {
  notifMarkRead()
  rerender()
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:480px;max-width:92vw'
  const header = el('div', 'modal-header', '🔔 Notifications')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)
  const list = el('div')
  list.setAttribute('role', 'log')
  list.setAttribute('aria-live', 'polite')
  list.style.cssText = 'max-height:46vh;overflow-y:auto'
  if (notifHistory.length === 0) {
    const emptyWrap = el('div')
    emptyWrap.style.cssText = 'padding:28px 10px;text-align:center;display:flex;flex-direction:column;gap:8px;align-items:center'
    emptyWrap.appendChild(el('div', '', '🎉'))
    emptyWrap.appendChild(el('div', 'muted', 'You’re all caught up.'))
    emptyWrap.appendChild(el('div', 'muted', 'Gate decisions, job results and exports land here.'))
    list.appendChild(emptyWrap)
  }
  for (let i = notifHistory.length - 1; i >= 0; i--) {
    const n = notifHistory[i]!
    const row = el('div')
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:6px 4px;border-bottom:1px dashed var(--border-2)'
    const count = n.count ?? 1
    const text = el('div', 'grow', count > 1 ? `${n.text} ×${count}` : n.text)
    if (count > 1) text.style.cssText += ';font-weight:600'
    text.style.cssText = 'font-size:11.5px;color:var(--text);word-break:break-word'
    const time = el('span', 'muted', n.time)
    time.style.cssText = 'font-size:9px;flex-shrink:0'
    // dsh-web notification management: dismiss a single entry.
    const del = el('button', 'hbtn ghost', '×')
    del.title = 'dismiss notification'
    del.setAttribute('aria-label', 'Dismiss notification')
    del.style.cssText = 'padding:0 4px;font-size:10px;flex-shrink:0'
    del.onclick = () => {
      notifHistory.splice(i, 1)
      notifPersist()
      notifMarkRead()
      overlay.remove()
      openNotificationsModal(root)
    }
    row.append(text, time, del)
    list.appendChild(row)
  }
  modal.appendChild(list)
  const clearBtn = el('button', 'hbtn', '🗑 Clear all')
  clearBtn.style.cssText = 'margin-top:10px'
  clearBtn.onclick = () => {
    notifClear()
    overlay.remove()
  }
  modal.appendChild(clearBtn)
  overlay.appendChild(modal)
  root.appendChild(overlay)
}

/* ─────────────────────────── command history modal ─────────────────────────── */

/**
 * dsh-web command history: every executed command (from the persisted
 * history) in a compact list; clicking one re-fills the composer.
 */
function openCommandHistoryModal(root: ShadowRoot): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'
  const header = el('div', 'modal-header', '🕘 Command History')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const hintRow = el('div', 'row')
  hintRow.style.cssText = 'justify-content:space-between;align-items:center;margin-bottom:10px'
  const hint = el('div', 'muted', `${chatHistory.length} commands · click one to re-run it in Chat (↑/↓ also walk this list in the composer).`)
  hint.style.cssText = 'font-size:11.5px'
  hintRow.appendChild(hint)
  // dsh-web history management: clear the persisted command list.
  const clearBtn = el('button', 'hbtn', '🗑 Clear')
  clearBtn.title = 'clear command history'
  clearBtn.style.cssText = 'padding:1px 10px;flex-shrink:0'
  clearBtn.onclick = () => {
    chatHistory = []
    historyIndex = -1
    try { localStorage.setItem(HISTORY_KEY, '[]') } catch { /* private mode */ }
    overlay.remove()
    openCommandHistoryModal(root)
  }
  hintRow.appendChild(clearBtn)
  modal.appendChild(hintRow)

  const list = el('div')
  list.style.cssText = 'max-height:46vh;overflow-y:auto'
  if (chatHistory.length === 0) {
    list.appendChild(el('div', 'empty', 'No commands executed yet.'))
  }
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const line = chatHistory[i]!
    const row = el('button')
    row.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;border:0;background:none;color:var(--text);text-align:left;padding:7px 10px;border-radius:8px;cursor:pointer'
    row.onmouseenter = () => { row.style.background = 'var(--bg-hover)' }
    row.onmouseleave = () => { row.style.background = 'none' }
    const idx = el('span', 'artifact-kind', `#${i + 1}`)
    const text = el('span', 'grow mono', line)
    text.style.cssText = 'font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    row.append(idx, text)
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

/* ─────────────────────────── global search modal ─────────────────────────── */

/**
 * dsh-web cross-session search: queries every project's claims and
 * evidence for a keyword and lists the hits.
 */
function openGlobalSearchModal(root: ShadowRoot): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:560px;max-width:92vw'
  const header = el('div', 'modal-header', '🌐 Global Search')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Search claims, evidence & artifacts across all projects…'
  input.value = globalSearchQuery
  input.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 11px;font:12px/1.4 system-ui,sans-serif;outline:none;margin-bottom:10px'
  input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
  input.onblur = () => { input.style.borderColor = 'var(--border)' }
  modal.appendChild(input)

  // dsh-web filter chips: restrict hits by kind (All / Claims / Evidence /
  // Artifacts).
  const chipsRow = el('div')
  chipsRow.style.cssText = 'display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap'
  const GS_KINDS: Array<['all' | 'claim' | 'evidence' | 'artifact', string]> = [
    ['all', 'All'], ['claim', 'Claims'], ['evidence', 'Evidence'], ['artifact', 'Artifacts'],
  ]
  for (const [key, label] of GS_KINDS) {
    const chip = el('button', 'hbtn', label)
    chip.style.cssText = 'padding:2px 10px;font-size:10px'
    const paintChip = (): void => {
      const active = gsKind === key
      chip.setAttribute('aria-pressed', active ? 'true' : 'false')
      chip.style.cssText = `padding:2px 10px;font-size:10px${active ? ';border-color:var(--accent);color:var(--accent-text);background:var(--accent-soft)' : ''}`
    }
    paintChip()
    chip.onclick = () => {
      gsKind = key
      // Re-paint every chip so only the active one is highlighted.
      chipsRow.querySelectorAll('button').forEach((b, i) => {
        const gsKey = GS_KINDS[i]![0]
        const active = gsKey === key
        b.setAttribute('aria-pressed', active ? 'true' : 'false')
        b.style.cssText = `padding:2px 10px;font-size:10px${active ? ';border-color:var(--accent);color:var(--accent-text);background:var(--accent-soft)' : ''}`
      })
      if (input.value.trim() !== '') void runSearch()
    }
    chipsRow.appendChild(chip)
  }
  modal.appendChild(chipsRow)

  const results = el('div')
  results.style.cssText = 'max-height:46vh;overflow-y:auto'
  results.setAttribute('role', 'listbox')
  results.setAttribute('aria-label', 'search results')
  results.appendChild(el('div', 'muted', 'Type a query and press Enter.'))
  modal.appendChild(results)

  // dsh-web keyboard nav: ↑/↓ walk the hits, Enter opens the selected one.
  let selIdx = -1
  const rowEls: HTMLElement[] = []
  const paintSelection = (): void => {
    for (let i = 0; i < rowEls.length; i++) {
      rowEls[i]!.style.background = i === selIdx ? 'var(--bg-hover)' : 'none'
      rowEls[i]!.setAttribute('aria-selected', i === selIdx ? 'true' : 'false')
    }
    rowEls[selIdx]?.scrollIntoView({ block: 'nearest' })
  }

  const runSearch = async (): Promise<void> => {
    const q = input.value.trim().toLowerCase()
    if (q === '') return
    globalSearchQuery = q
    results.replaceChildren(el('div', 'muted', 'Searching…'))
    const projects = (await api<ProjectRow[]>('/v1/projects')) ?? []
    const hits: Array<{ projectId: string; project: string; status?: string; kind: string; text: string }> = []
    for (const p of projects) {
      if (p.project_id === undefined) continue
      const claims = (await api<ClaimRow[]>(`/v1/projects/${encodeURIComponent(p.project_id)}/claims`)) ?? []
      for (const c of claims) {
        if ((c.statement ?? '').toLowerCase().includes(q)) {
          hits.push({ projectId: p.project_id, project: p.name ?? p.project_id, status: p.status, kind: 'claim', text: c.statement ?? '' })
        }
      }
      const evidence = (await api<EvidenceRow[]>(`/v1/projects/${encodeURIComponent(p.project_id)}/evidence`)) ?? []
      for (const e of evidence) {
        const label = `${e.result?.primary_metric ?? 'metric'} = ${e.result?.value ?? '?'} (Δ${e.result?.effect_size ?? '?'})`
        if (label.toLowerCase().includes(q)) {
          hits.push({ projectId: p.project_id, project: p.name ?? p.project_id, status: p.status, kind: 'evidence', text: label })
        }
      }
      const artifacts = (await api<ArtifactRow[]>(`/v1/projects/${encodeURIComponent(p.project_id)}/artifacts`)) ?? []
      for (const a of artifacts) {
        const label = `${a.kind ?? 'artifact'} ${a.artifact_id ?? ''}${typeof a.metadata?.name === 'string' && a.metadata.name !== '' ? ` · ${a.metadata.name}` : ''}`
        if (label.toLowerCase().includes(q)) {
          hits.push({ projectId: p.project_id, project: p.name ?? p.project_id, status: p.status, kind: 'artifact', text: label })
        }
      }
    }
    const kindHits = gsKind === 'all' ? hits : hits.filter(h => h.kind === gsKind)
    globalSearchResults = kindHits
    results.replaceChildren()
    rowEls.length = 0
    selIdx = -1
    if (kindHits.length === 0) {
      results.appendChild(el('div', 'empty', gsKind === 'all'
        ? `No matches for "${input.value.trim()}" across projects.`
        : `No ${gsKind} matches for "${input.value.trim()}" across projects.`))
      return
    }
    const count = el('div', 'muted', `${kindHits.length} hit(s) across ${projects.length} project(s) — ↑/↓ to select, Enter to open.`)
    count.style.cssText = 'margin-bottom:8px;font-size:11px'
    results.appendChild(count)
    for (let i = 0; i < kindHits.length; i++) {
      const h = kindHits[i]!
      const row = el('div')
      row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:6px 4px;border-bottom:1px dashed var(--border-2);border-radius:6px;cursor:pointer'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', 'false')
      row.appendChild(el('span', 'artifact-kind', h.kind.toUpperCase()))
      const bodyEl = el('div', 'grow')
      bodyEl.style.cssText = 'min-width:0'
      const projEl = el('div', 'muted', h.status !== undefined ? `${h.project} · ${STATUS_META[h.status]?.label ?? h.status}` : h.project)
      projEl.style.cssText = 'font-size:10px'
      const textEl = el('div', '', h.text)
      textEl.style.cssText = 'font-size:11.5px;color:var(--text);word-break:break-word'
      bodyEl.append(projEl, textEl)
      row.appendChild(bodyEl)
      // dsh-web depth: copy the hit text straight from the result row.
      const copyHit = el('button', 'hbtn', '⧉')
      copyHit.title = 'copy hit text'
      copyHit.style.cssText = 'padding:0 6px;font-size:9px;flex-shrink:0'
      copyHit.onclick = (event) => {
        event.stopPropagation()
        void navigator.clipboard.writeText(h.text).then(
          () => { copyHit.textContent = '✓' },
          () => { copyHit.textContent = '✗' },
        )
        setTimeout(() => { copyHit.textContent = '⧉' }, 1600)
      }
      row.appendChild(copyHit)
      row.onmouseenter = () => { selIdx = i; paintSelection() }
      row.onclick = () => {
        overlay.remove()
        projectId = h.projectId
        // dsh-web jump: artifacts open the Artifacts tab, everything else
        // the Evidence tab.
        activeTab = h.kind === 'artifact' ? 'artifacts' : 'evidence'
        tabSave()
        rerender()
      }
      rowEls.push(row)
      results.appendChild(row)
    }
  }
  input.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (selIdx >= 0 && rowEls[selIdx] !== undefined) {
        // dsh-web jump: open the selected hit's project on the Evidence tab.
        rowEls[selIdx]!.click()
      } else {
        void runSearch()
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rowEls.length === 0) return
      event.preventDefault()
      selIdx = (selIdx + (event.key === 'ArrowDown' ? 1 : -1) + rowEls.length) % rowEls.length
      paintSelection()
    }
  }
  // dsh-web search-as-you-type: live search with a 350ms debounce (Enter
  // still triggers an immediate search).
  let debounceTimer: number | undefined
  input.oninput = () => {
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => { void runSearch() }, 350)
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  input.focus()
}

/* ─────────────────────────── project switcher modal ─────────────────────────── */

/** Quick project switcher (dsh-web Ctrl/Cmd+P): filter + ↑/↓ + Enter. */
let projectSwitchQuery = ''

function openProjectSwitcherModal(root: ShadowRoot): void {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:520px;max-width:92vw'
  const header = el('div', 'modal-header', '⇥ Switch Project')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Search projects…'
  input.value = projectSwitchQuery
  input.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 11px;font:12px/1.4 system-ui,sans-serif;outline:none;margin-bottom:10px'
  input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
  input.onblur = () => { input.style.borderColor = 'var(--border)' }
  modal.appendChild(input)

  const list = el('div')
  list.style.cssText = 'max-height:46vh;overflow-y:auto'
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'projects')
  modal.appendChild(list)

  let selIdx = -1
  const rows: HTMLElement[] = []
  const paint = (): void => {
    for (let i = 0; i < rows.length; i++) {
      rows[i]!.style.background = i === selIdx ? 'var(--bg-hover)' : 'none'
      rows[i]!.setAttribute('aria-selected', i === selIdx ? 'true' : 'false')
    }
    rows[selIdx]?.scrollIntoView({ block: 'nearest' })
  }

  const renderList = (projects: ProjectRow[]): void => {
    list.replaceChildren()
    rows.length = 0
    selIdx = -1
    const q = projectSwitchQuery.trim().toLowerCase()
    const filtered = q === '' ? projects : projects.filter(p =>
      (p.name ?? '').toLowerCase().includes(q) || (p.project_id ?? '').toLowerCase().includes(q),
    )
    if (filtered.length === 0) {
      list.appendChild(el('div', 'empty', `No projects match "${projectSwitchQuery.trim()}".`))
      return
    }
    for (const p of filtered) {
      if (p.project_id === undefined) continue
      const row = el('div')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', 'false')
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;cursor:pointer'
      const tone = STATUS_META[p.status ?? '']?.tone ?? 'slate'
      const dot = el('span')
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:var(--tone-${tone});flex-shrink:0`
      const name = el('span', 'grow', p.name ?? p.project_id)
      name.style.cssText = 'font-size:11.5px;color:var(--text)'
      const meta = el('span', 'muted mono', `${STATUS_META[p.status ?? '']?.label ?? p.status ?? ''} · ${p.project_id.slice(0, 14)}`)
      meta.style.cssText = 'font-size:9.5px'
      row.append(dot, name, meta)
      row.onmouseenter = () => { selIdx = rows.indexOf(row); paint() }
      row.onclick = () => {
        overlay.remove()
        projectId = p.project_id
        rerender()
        showToast(rootHost(), `⇥ Switched to ${p.name ?? p.project_id}`)
      }
      rows.push(row)
      list.appendChild(row)
    }
  }
  input.oninput = () => {
    projectSwitchQuery = input.value
    void api<ProjectRow[]>('/v1/projects').then((projects) => { renderList(projects ?? []) })
  }
  input.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (selIdx >= 0 && rows[selIdx] !== undefined) {
        rows[selIdx]!.click()
      } else if (rows.length > 0) {
        // dsh-web default: Enter with no selection picks the first row.
        rows[0]!.click()
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rows.length === 0) return
      event.preventDefault()
      selIdx = (selIdx + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
      paint()
    }
  }
  overlay.appendChild(modal)
  root.appendChild(overlay)
  input.focus()
  void api<ProjectRow[]>('/v1/projects').then((projects) => { renderList(projects ?? []) })
}

/* ─────────────────────────── compare modal ─────────────────────────── */

/**
 * dsh-web compare: side-by-side status/budget/counts table for selected
 * projects.
 */
async function openCompareModal(root: ShadowRoot, projectIds: string[]): Promise<void> {
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:720px;max-width:96vw'
  const header = el('div', 'modal-header', '⇄ Compare Projects')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)

  const loading = el('div', 'muted', 'Loading…')
  modal.appendChild(loading)
  overlay.appendChild(modal)
  root.appendChild(overlay)

  const rows: Array<{ label: string; values: string[] }> = []
  const projections = await Promise.all(projectIds.map(id => api<Projection>(`/v1/projects/${encodeURIComponent(id)}/projection`)))
  const valid = projections.filter((p): p is Projection => p !== null && p.project !== undefined)
  if (valid.length < 2) {
    loading.textContent = 'Need at least two readable projects.'
    return
  }
  modal.removeChild(loading)

  const labels = valid.map(p => p.project!.name ?? p.project!.project_id!)
  const cell = (text: string, head = false): HTMLElement => {
    const c = el('div', head ? 'pname' : '')
    c.style.cssText = `padding:5px 10px;font-size:11px;color:var(--text);border-bottom:1px solid var(--border-2);${head ? 'font-weight:700' : ''}`
    c.textContent = text
    return c
  }
  const addRow = (label: string, get: (p: Projection) => string): void => {
    rows.push({ label, values: valid.map(get) })
  }
  addRow('Phase', p => `${p.project!.status ?? '?'} (rev ${p.project!.revision ?? 0})`)
  addRow('Budget', p => `$${p.budget?.model_cost_usd ?? 0} / ${p.project!.constraints?.max_model_cost_usd ?? '∞'}`)
  addRow('GPU hours', p => `${p.budget?.gpu_hours ?? 0} / ${p.project!.constraints?.max_gpu_hours ?? '∞'}`)
  addRow('Ideas', p => String(p.counts?.ideas ?? 0))
  addRow('Contracts', p => String(p.counts?.contracts ?? 0))
  addRow('Claims', p => String(p.counts?.claims ?? 0))
  addRow('Evidence', p => String(p.counts?.evidence ?? 0))
  addRow('Artifacts', p => String(p.counts?.artifacts ?? 0))
  addRow('Runs', p => String((p.jobs ?? []).length))
  addRow('Pending gates', p => String((p.pending_gates ?? []).length))

  const table = el('div')
  table.style.cssText = `display:grid;grid-template-columns:140px repeat(${valid.length}, 1fr);gap:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;max-height:60vh;overflow-y:auto`
  // header row
  table.appendChild(cell('', true))
  for (let i = 0; i < labels.length; i++) {
    const headCell = cell(labels[i]!, true)
    // dsh-web depth: click a column header to open that project.
    const pid = valid[i]!.project!.project_id
    if (pid !== undefined) {
      headCell.style.cursor = 'pointer'
      headCell.title = `open ${labels[i]}`
      headCell.onclick = () => {
        overlay.remove()
        projectId = pid
        rerender()
      }
    }
    table.appendChild(headCell)
  }
  for (const r of rows) {
    table.appendChild(cell(r.label))
    for (const v of r.values) table.appendChild(cell(v))
  }
  modal.appendChild(table)
  // dsh-web data viz: highlight the best (max) and worst (min) numeric
  // cell per row (only pure-number cells count, e.g. Ideas/Claims counts).
  const numeric = (s: string): number | null => /^-?\d+(\.\d+)?$/.test(s.trim()) ? Number(s.trim()) : null
  const gridCells = [...table.querySelectorAll('div')] as HTMLElement[]
  const perRow = valid.length + 1
  for (let r = 0; r < rows.length; r++) {
    const values: Array<number | null> = []
    for (let c = 1; c < perRow; c++) values.push(numeric(gridCells[(r + 1) * perRow + c]?.textContent ?? ''))
    const nums = values.filter((v): v is number => v !== null)
    if (nums.length < 2) continue
    const max = Math.max(...nums)
    const min = Math.min(...nums)
    for (let c = 1; c < perRow; c++) {
      const v = values[c - 1]
      if (v === null) continue
      const cellEl = gridCells[(r + 1) * perRow + c]!
      if (v === max) cellEl.style.color = 'var(--tone-green)'
      else if (v === min) cellEl.style.color = 'var(--tone-red)'
    }
  }
  // dsh-web export: download the comparison as CSV, or copy as markdown.
  const exportRow = el('div', 'row')
  exportRow.style.cssText = 'margin-top:10px;gap:8px'
  const exportCsv = el('button', 'hbtn', '⬇ Export CSV')
  exportCsv.title = 'download the comparison table as CSV'
  exportCsv.onclick = () => {
    const lines = [
      ['Label', ...labels],
      ...rows.map(r => [r.label, ...r.values]),
    ]
    const csv = lines.map(line => line.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = el('a', 'dl', 'download')
    a.href = url
    a.download = `compare-${labels.join('-').replaceAll(' ', '-').slice(0, 60)}-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }
  const copyMd = el('button', 'hbtn', '⧉ copy md')
  copyMd.title = 'copy the comparison as a markdown table'
  copyMd.onclick = () => {
    const lines = [
      ['Label', ...labels],
      ...rows.map(r => [r.label, ...r.values]),
    ]
    const md = lines.map(line => `| ${line.join(' | ')} |`).join('\n')
    void navigator.clipboard.writeText(md).then(
      () => { copyMd.textContent = '✓ copied' },
      () => { copyMd.textContent = 'copy failed' },
    )
    setTimeout(() => { copyMd.textContent = '⧉ copy md' }, 1600)
  }
  exportRow.append(exportCsv, copyMd)
  modal.appendChild(exportRow)
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
  /** dsh-web quote-reply: the quoted message, shown above the bubble. */
  quote?: { index: number; text: string }
  /** dsh-web pin: starred messages surface in a 📌 section at the top. */
  pinned?: boolean
}

let chatMessages: ChatMessage[] = []
let chatDraft = ''
const CHAT_STORAGE_KEY = 'dsh-scholar-ui-chat'
const CHAT_MAX = 200
/** Multi-session chats (dsh-web session tabs), persisted. */
const SESSIONS_KEY = 'dsh-scholar-ui-sessions'
interface ChatSession { id: string; name: string; messages: ChatMessage[]; lastActive?: number; archived?: boolean; unread?: number }
let chatSessions: ChatSession[] = []
let chatActiveId: string | null = null

/** Current session's messages (chatMessages mirrors the active session). */
let dragSessionId: string | null = null
function chatSyncActive(): void {
  const active = chatSessions.find(s => s.id === chatActiveId)
  chatMessages = active !== undefined ? active.messages : []
  if (active !== undefined) {
    active.lastActive = Date.now()
    chatSessions.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
  }
}
function chatSessionsPersist(): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(chatSessions.map(s => ({ ...s, messages: s.messages.slice(-CHAT_MAX) }))))
    // dsh-web session memory: remember the active session across reloads.
    if (chatActiveId !== null) localStorage.setItem('dsh-scholar-ui-active-session', chatActiveId)
  } catch { /* private mode */ }
}
function chatSessionEnsure(): void {
  if (chatSessions.length === 0) {
    chatSessions = [{ id: 'default', name: 'Chat 1', messages: [] }]
    chatActiveId = 'default'
  }
  if (chatActiveId === null || !chatSessions.some(s => s.id === chatActiveId)) {
    chatActiveId = chatSessions[0]!.id
  }
  chatSyncActive()
}
function chatSessionNew(): void {
  const id = `s${Date.now()}`
  chatSessions.push({ id, name: `Chat ${chatSessions.length + 1}`, messages: [] })
  chatActiveId = id
  chatDraft = ''
  chatSyncActive()
  chatSessionsPersist()
  rerender()
}
function chatSessionClose(id: string): void {
  const idx = chatSessions.findIndex(s => s.id === id)
  if (idx < 0) return
  chatSessions.splice(idx, 1)
  if (chatSessions.length === 0) chatSessionEnsure()
  if (chatActiveId === id) {
    chatActiveId = chatSessions[Math.min(idx, chatSessions.length - 1)]!.id
    chatDraft = ''
  }
  chatSyncActive()
  chatSessionsPersist()
  rerender()
}
function chatSessionSelect(id: string): void {
  if (chatSessions.some(s => s.id === id)) {
    chatActiveId = id
    chatDraft = ''
    const session = chatSessions.find(s => s.id === id)
    if (session !== undefined) session.unread = 0
    chatSyncActive()
    rerender()
  }
}

/** Rename a chat session via an in-app dialog (dsh-web dialogs — no
 * browser prompts), persisted. */
function chatSessionRename(id: string): void {
  const session = chatSessions.find(s => s.id === id)
  if (session === undefined) return
  const root = rootHost()
  if (root === null) return
  const overlay = el('div', 'overlay')
  overlay.onclick = (event) => { if (event.target === overlay) overlay.remove() }
  const modal = el('div', 'modal')
  modal.style.cssText = 'width:440px;max-width:92vw'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-label', 'Rename session')
  const header = el('div', 'modal-header', '✎ Rename Session')
  const closeBtn = el('button', 'hbtn ghost', '×')
  closeBtn.onclick = () => overlay.remove()
  header.appendChild(closeBtn)
  modal.appendChild(header)
  const hint = el('div', 'muted', `Rename "${session.name}" — session messages are kept.`)
  hint.style.cssText = 'margin-bottom:10px;font-size:11.5px'
  modal.appendChild(hint)
  const input = document.createElement('input')
  input.type = 'text'
  input.value = session.name
  input.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 11px;font:12px/1.4 system-ui,sans-serif;outline:none'
  input.onfocus = () => { input.style.borderColor = 'var(--accent)' }
  input.onblur = () => { input.style.borderColor = 'var(--border)' }
  modal.appendChild(input)
  const err = el('div', 'error-banner')
  err.style.cssText = 'display:none;margin-top:10px'
  modal.appendChild(err)
  const actions = el('div', 'row')
  actions.style.cssText = 'justify-content:flex-end;gap:8px;margin-top:14px'
  const cancel = el('button', 'hbtn', 'Cancel')
  cancel.onclick = () => overlay.remove()
  const save = el('button', 'btn approve', 'Save')
  save.style.cssText = 'padding:7px 18px'
  const saveName = (): void => {
    const clean = input.value.trim()
    if (clean === '') {
      err.textContent = 'Name must not be empty.'
      err.style.display = 'block'
      return
    }
    session.name = clean.slice(0, 40)
    chatSessionsPersist()
    overlay.remove()
    rerender()
  }
  save.onclick = saveName
  input.onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); saveName() } }
  actions.append(cancel, save)
  modal.appendChild(actions)
  overlay.appendChild(modal)
  root.appendChild(overlay)
  input.focus()
  input.select()
  trapFocus(overlay, null)
}

/** Archive a chat session (dsh-web session actions); messages are kept. */
function chatSessionArchive(id: string): void {
  const session = chatSessions.find(s => s.id === id)
  if (session === undefined) return
  session.archived = !session.archived
  if (!session.archived) {
    // dsh-web restore: a restored session is no longer unread.
    session.unread = 0
  }
  if (session.archived && chatActiveId === id) {
    const next = chatSessions.find(s => s.id !== id && !s.archived) ?? chatSessions.find(s => s.id !== id)
    if (next !== undefined) {
      chatActiveId = next.id
      chatDraft = ''
    }
  }
  chatSyncActive()
  chatSessionsPersist()
  rerender()
}
/** Command history for ↑/↓ navigation (dsh-web shell feel), persisted. */
const HISTORY_KEY = 'dsh-scholar-ui-history'
let chatHistory: string[] = []
let historyIndex = -1

function historyLoad(): void {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (raw === null) return
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      chatHistory = parsed.filter((h): h is string => typeof h === 'string').slice(-50)
    }
  } catch { /* private mode */ }
}

function historyPush(line: string): void {
  if (line === '') return
  if (chatHistory[chatHistory.length - 1] === line) return
  chatHistory.push(line)
  chatHistory = chatHistory.slice(-50)
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(chatHistory)) } catch { /* private mode */ }
  historyIndex = -1
}

/** Restore transcripts persisted in localStorage (dsh-web session tabs). */
function chatLoad(): void {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY)
    const parsed = raw !== null ? JSON.parse(raw) as unknown : null
    if (Array.isArray(parsed) && parsed.length > 0) {
      chatSessions = parsed
        .filter((s): s is ChatSession => typeof s === 'object' && s !== null
          && typeof (s as ChatSession).id === 'string'
          && typeof (s as ChatSession).name === 'string'
          && Array.isArray((s as ChatSession).messages))
        .map(s => ({ ...s, messages: s.messages.filter((m): m is ChatMessage => typeof m === 'object' && m !== null && typeof (m as ChatMessage).role === 'string' && (m as ChatMessage).role in { user: 1, assistant: 1, error: 1 } && typeof (m as ChatMessage).text === 'string').slice(-CHAT_MAX) }))
      // dsh-web session memory: restore the last active session if it exists.
      const lastActive = localStorage.getItem('dsh-scholar-ui-active-session')
      chatActiveId = lastActive !== null && chatSessions.some(s => s.id === lastActive)
        ? lastActive
        : (chatSessions[0]?.id ?? null)
      chatSyncActive()
      return
    }
  } catch { /* corrupt or private mode */ }
  // Legacy single-transcript key.
  chatSessionEnsure()
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
      chatSyncActive()
    }
  } catch { /* corrupt or private mode */ }
}

function chatPersist(): void {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatMessages.slice(-CHAT_MAX)))
  } catch { /* private mode */ }
  chatSessionsPersist()
}

function chatClear(): void {
  chatMessages = []
  chatSyncActive()
  chatPersist()
}

function chatPush(role: ChatMessage['role'], text: string, quote?: { index: number; text: string }): void {
  const msg: ChatMessage = { role, text, time: new Date().toLocaleTimeString() }
  if (quote !== undefined) msg.quote = quote
  chatMessages.push(msg)
  // dsh-web session unread: bump every session other than the active one
  // (assistant replies that land while the user is elsewhere).
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
let sidebarGroup: 'all' | 'active' | 'done' | 'archived' = 'all'

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
  activeCounts?: { ideas?: number; contracts?: number; claims?: number; evidence?: number; artifacts?: number; corpus_snapshots?: number },
): void {
  sidebar.replaceChildren()
  const head = el('div', 'sidebar-head')
  head.appendChild(el('span', 'sidebar-title', 'Projects'))
  const newBtn = el('button', 'sidebar-new', '＋')
  newBtn.title = 'new project'
  newBtn.setAttribute('aria-label', 'New project')
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
  const GROUP_DEFS: Array<['all' | 'active' | 'done' | 'archived', string]> = [
    ['all', 'All'], ['active', 'Active'], ['done', 'Done'], ['archived', 'Archived'],
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
  // dsh-web counts: the footer shows the filtered/total project counts.
  const footLabel = el('span', '', `${projects.length} projects`)
  const renderRows = (): void => {
    list.replaceChildren()
    const q = sidebarQuery.trim().toLowerCase()
    let filtered = q === '' ? projects : projects.filter(p => (p.name ?? '').toLowerCase().includes(q) || (p.project_id ?? '').toLowerCase().includes(q) || (p.status ?? '').toLowerCase().includes(q))
    if (sidebarGroup === 'active') filtered = filtered.filter(p => isProjectActive(p.status))
    if (sidebarGroup === 'done') filtered = filtered.filter(p => !isProjectActive(p.status))
    if (sidebarGroup === 'archived') filtered = filtered.filter(p => p.status === 'ARCHIVED')
    // dsh-web starred projects: favourites sort to the top.
    if (favProjects.size > 0) {
      filtered = [...filtered].sort((a, b) => (favProjects.has(b.project_id ?? '') ? 1 : 0) - (favProjects.has(a.project_id ?? '') ? 1 : 0))
    }
    // dsh-web counts: reflect the active filter in the footer.
    footLabel.textContent = q === '' && sidebarGroup === 'all'
      ? `${projects.length} projects`
      : `${filtered.length}/${projects.length} projects`
    if (filtered.length === 0) {
      const empty = el('div', 'empty', projects.length === 0 ? 'No projects yet — create one with ＋ above or /research new in Chat.' : 'No matches for the current filter.')
      empty.style.cssText = 'padding:10px 12px'
      list.appendChild(empty)
      return
    }
    for (const p of filtered) {
      const item = el('button', 'ws-item')
      item.setAttribute('role', 'listitem')
      item.setAttribute('aria-label', `project ${p.name ?? p.project_id ?? ''}`)
      // dsh-web starred projects: ★ toggles the favourite (sorted first).
      const isFav = p.project_id !== undefined && favProjects.has(p.project_id)
      const favStar = el('span', '', isFav ? '★' : '☆')
      favStar.style.cssText = `cursor:pointer;color:${isFav ? 'var(--tone-amber)' : 'var(--text-3)'};font-size:10px;flex-shrink:0`
      favStar.title = isFav ? 'unfavourite project' : 'favourite project (pinned first)'
      favStar.onclick = (event) => {
        event.stopPropagation()
        if (p.project_id === undefined) return
        favProjectToggle(p.project_id)
        renderSidebar(sidebar, projects, activeId, onPick, activeCounts)
      }
      item.appendChild(favStar)
      if (p.project_id === activeId) {
        item.classList.add('active')
        item.setAttribute('aria-current', 'page')
      }
      if (sidebarSelecting && p.project_id !== undefined) {
        if (sidebarSelected.has(p.project_id)) item.classList.add('selected')
        const box = el('span', 'ws-check', sidebarSelected.has(p.project_id) ? '☑' : '☐')
        box.title = 'toggle selection'
        box.onclick = (event) => {
          event.stopPropagation()
          if (p.project_id === undefined) return
          if (sidebarSelected.has(p.project_id)) sidebarSelected.delete(p.project_id)
          else sidebarSelected.add(p.project_id)
          renderSidebar(sidebar, projects, activeId, onPick, activeCounts)
        }
        item.prepend(box)
      }
      // dsh-web "attention" feel: BLOCKED_GATE projects get a red ring and
      // an ⏳ badge so a parked project is visible in the sidebar.
      const blocked = p.status === 'BLOCKED_GATE'
      if (blocked) item.classList.add('blocked')
      const tone = STATUS_META[p.status ?? '']?.tone ?? 'slate'
      const dot = el('span', 'ws-dot')
      dot.style.background = `var(--tone-${tone})`
      item.appendChild(dot)
      item.appendChild(el('span', 'ws-name', p.name ?? p.project_id ?? ''))
      if (blocked) {
        const badge = el('span', 'ws-status', '⏳')
        badge.title = 'blocked on a human gate decision — click to open Gates'
        badge.style.cssText = 'color:var(--tone-amber);font-weight:700;cursor:pointer'
        badge.onclick = (event) => {
          event.stopPropagation()
          if (p.project_id !== undefined) onPick(p.project_id)
          activeTab = 'gates'
          tabSave()
          rerender()
        }
        item.appendChild(badge)
      }
      item.appendChild(el('span', 'ws-status', STATUS_META[p.status ?? '']?.label ?? p.status ?? ''))
      item.onclick = () => { if (p.project_id !== undefined) onPick(p.project_id) }
      // dsh-web context menu: right-click on a project row.
      item.oncontextmenu = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
        if (root === null || p.project_id === undefined) return
        const id = p.project_id
        const isArchived = p.status === 'ARCHIVED'
        const ctxItems: ContextMenuItem[] = [
          { label: 'Open', hint: p.status ?? '', onPick: () => onPick(id) },
          { label: '✎ Rename', onPick: () => openRenameModal(root, id, p.name ?? '', () => rerender()) },
        ]
        if (isArchived) {
          ctxItems.push({
            label: '↩ Restore',
            onPick: () => { void api(`/v1/projects/${encodeURIComponent(id)}/unarchive`, { method: 'POST' }).then(() => rerender()) },
          })
        } else {
          ctxItems.push({
            label: '🗄 Archive',
            hint: 'data kept',
            onPick: () => { void api(`/v1/projects/${encodeURIComponent(id)}/archive`, { method: 'POST' }).then(() => rerender()) },
          })
        }
        ctxItems.push(
          { label: '⧉ Details', onPick: () => { void openProjectDetailModal(root, id) } },
          { label: 'Copy project ID', hint: id, onPick: () => copyText(id) },
        )
        openContextMenu(root, event.clientX, event.clientY, ctxItems)
      }
      // dsh-web project drawer: double-click opens the full detail modal.
      item.ondblclick = (event) => {
        event.stopPropagation()
        if (p.project_id === undefined) return
        const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
        if (root !== null) void openProjectDetailModal(root, p.project_id)
      }
      // dsh-web sidebar stats: counts of the active project under its row.
      if (p.project_id === activeId && activeCounts !== undefined) {
        const stats = el('div')
        stats.style.cssText = 'display:flex;gap:8px;padding:2px 10px 6px 26px;font-size:9px;color:var(--text-3)'
        const parts: string[] = []
        if ((activeCounts.corpus_snapshots ?? 0) > 0) parts.push(`📚${activeCounts.corpus_snapshots}`)
        if ((activeCounts.ideas ?? 0) > 0) parts.push(`💡${activeCounts.ideas}`)
        if ((activeCounts.contracts ?? 0) > 0) parts.push(`📋${activeCounts.contracts}`)
        if ((activeCounts.claims ?? 0) > 0) parts.push(`🧾${activeCounts.claims}`)
        if ((activeCounts.evidence ?? 0) > 0) parts.push(`📊${activeCounts.evidence}`)
        if ((activeCounts.artifacts ?? 0) > 0) parts.push(`📦${activeCounts.artifacts}`)
        if (parts.length === 0) parts.push('empty project')
        stats.textContent = parts.join(' · ')
        list.appendChild(stats)
      }
      // dsh-web "session actions": rename + archive/restore (hover only).
      const actionsWrap = el('span')
      actionsWrap.style.cssText = 'display:none;align-items:center;gap:2px;flex-shrink:0'
      const renameBtn = el('span', 'ws-rename', '✎')
      renameBtn.title = 'rename project'
      renameBtn.onclick = (event) => {
        event.stopPropagation()
        if (p.project_id === undefined) return
        const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
        if (root !== null) openRenameModal(root, p.project_id, p.name ?? '', () => rerender())
      }
      const archived = p.status === 'ARCHIVED'
      const arcBtn = el('span', 'ws-rename', archived ? '↩' : '🗄')
      arcBtn.title = archived ? 'restore project' : 'archive project (data kept)'
      arcBtn.onclick = async (event) => {
        event.stopPropagation()
        if (p.project_id === undefined) return
        if (!archived) {
          const ok = await api(`/v1/projects/${encodeURIComponent(p.project_id)}/archive`, { method: 'POST' })
          if (ok === null) { lastError = 'archive failed (bridge error)'; return }
          showToast(rootHost(), `🗄 Archived ${p.name ?? p.project_id}`)
        } else {
          const ok = await api(`/v1/projects/${encodeURIComponent(p.project_id)}/unarchive`, { method: 'POST' })
          if (ok === null) { lastError = 'restore failed (bridge error)'; return }
          showToast(rootHost(), `↩ Restored ${p.name ?? p.project_id}`)
        }
        rerender()
      }
      actionsWrap.append(renameBtn, arcBtn)
      item.appendChild(actionsWrap)
      list.appendChild(item)
    }
  }
  search.oninput = () => { sidebarQuery = search.value; renderRows() }
  renderRows()
  sidebar.appendChild(list)

  const foot = el('div', 'sidebar-foot')
  foot.style.cssText = 'display:flex;align-items:center;gap:8px;justify-content:space-between'
  const settingsBtn = el('button', 'hbtn', '⚙ Settings')
  settingsBtn.title = 'connection, token and appearance settings'
  settingsBtn.onclick = () => {
    const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
    if (root !== null) openSettingsModal(root)
  }
  if (!sidebarSelecting) {
    const selectBtn = el('button', 'hbtn', '☑ Select')
    selectBtn.title = 'multi-select projects (bulk actions)'
    selectBtn.setAttribute('aria-pressed', 'false')
    selectBtn.onclick = () => {
      sidebarSelecting = true
      sidebarSelected.clear()
      renderSidebar(sidebar, projects, activeId, onPick, activeCounts)
    }
    foot.append(footLabel, selectBtn, settingsBtn)
  } else {
    const doneBtn = el('button', 'hbtn', 'Done')
    doneBtn.onclick = () => {
      sidebarSelecting = false
      sidebarSelected.clear()
      renderSidebar(sidebar, projects, activeId, onPick, activeCounts)
    }
    const countLabel = el('span', '', `${sidebarSelected.size} selected`)
    const archiveSel = el('button', 'hbtn', '🗄 Archive')
    archiveSel.disabled = sidebarSelected.size === 0
    archiveSel.onclick = async () => {
      for (const id of sidebarSelected) {
        await api(`/v1/projects/${encodeURIComponent(id)}/archive`, { method: 'POST' })
      }
      showToast(rootHost(), `🗄 Archived ${sidebarSelected.size} project(s)`)
      sidebarSelecting = false
      sidebarSelected.clear()
      rerender()
    }
    // dsh-web compare: side-by-side view of the selected projects.
    const compareBtn = el('button', 'hbtn', '⇄ Compare')
    compareBtn.disabled = sidebarSelected.size < 2
    compareBtn.onclick = () => {
      const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
      if (root !== null && sidebarSelected.size >= 2) {
        void openCompareModal(root, [...sidebarSelected])
      }
    }
    foot.append(countLabel, archiveSel, compareBtn, doneBtn)
  }
  sidebar.appendChild(foot)
}

/**
 * Chat tab: message bubbles (dsh-web style) + a composer that runs
 * /research commands directly against the Kernel bridge. The transcript
 * survives 8s panel refreshes (chatMessages), as does the draft text.
 * Clicking a message opens the dsh-web "details" side panel.
 */
let chatDetailIndex = -1
/** Chat transcript search (dsh-web session search feel). */
let chatSearchQuery = ''
/** dsh-web quote-reply: pending quote attached to the next user message. */
let chatQuoteTarget: { index: number; text: string } | null = null
/** Commands-only view: show just the user command messages. */
let chatCommandsOnly = false
/** Global search state (dsh-web cross-session search). */
let globalSearchOpen = false
let globalSearchQuery = ''
let globalSearchResults: Array<{ project: string; kind: string; text: string }> = []
/** Global search kind filter (dsh-web filter chips). */
let gsKind: 'all' | 'claim' | 'evidence' | 'artifact' = 'all'
/** Multi-select mode for the sidebar (dsh-web bulk session actions). */
let sidebarSelecting = false
let sidebarSelected = new Set<string>()

async function renderChat(body: HTMLElement, projectId: string): Promise<void> {
  const shell = el('div')
  shell.style.cssText = 'display:flex;flex-direction:row;height:100%;min-height:420px'

  const column = el('div')
  column.style.cssText = 'flex:1;display:flex;flex-direction:column;min-width:0'

  // dsh-web session tabs: switch / create / close chat sessions (the row
  // scrolls horizontally instead of wrapping with many sessions).
  const sessionTabs = el('div')
  sessionTabs.style.cssText = 'display:flex;gap:4px;margin-bottom:8px;align-items:center;overflow-x:auto;flex-wrap:nowrap;max-width:100%;padding-bottom:2px;scrollbar-width:thin'
  for (const s of chatSessions) {
    const tab = el('button', 'hbtn')
    tab.textContent = s.name
    tab.style.cssText = 'padding:3px 10px;font-size:10.5px'
    // dsh-web session depth: message count on the chip.
    if ((s.messages ?? []).length > 0) {
      const cnt = el('span', 'muted', ` ${s.messages.length}`)
      cnt.style.cssText = 'font-size:9px;opacity:.75'
      tab.appendChild(cnt)
    }
    if (s.id !== chatActiveId && (s.unread ?? 0) > 0) {
      const badge = el('span', 'artifact-kind', `${s.unread}`)
      badge.style.cssText += ';margin-left:4px;color:var(--tone-amber);font-weight:700'
      tab.appendChild(badge)
    }
    if (s.id === chatActiveId) {
      tab.style.cssText += ';border-color:var(--accent);color:var(--accent-text);background:var(--accent-soft)'
    }
    tab.onclick = () => { chatSessionSelect(s.id) }
    // dsh-web session tabs: middle-click closes the session.
    tab.onmousedown = (event) => {
      if (event.button === 1) {
        event.preventDefault()
        chatSessionClose(s.id)
      }
    }
    tab.ondblclick = (event) => {
      event.stopPropagation()
      chatSessionRename(s.id)
    }
    tab.title = `${s.name} · double-click to rename`
    sessionTabs.appendChild(tab)
    // dsh-web session actions: archive/restore.
    const arch = el('button', 'hbtn ghost', s.archived === true ? '↩' : '🗄')
    arch.title = s.archived === true ? 'restore session' : 'archive session'
    arch.style.cssText = 'padding:0 4px;font-size:10px'
    arch.onclick = (event) => {
      event.stopPropagation()
      chatSessionArchive(s.id)
    }
    const close = el('button', 'hbtn ghost', '×')
    close.style.cssText = 'padding:0 4px;font-size:10px'
    close.title = `close ${s.name}`
    close.onclick = (event) => {
      event.stopPropagation()
      chatSessionClose(s.id)
    }
    const wrap = el('span')
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:2px;border:1px solid var(--border);border-radius:8px;padding:1px 4px'
    if (s.id === chatActiveId) wrap.style.cssText += ';border-color:var(--accent);background:var(--accent-soft)'
    if (s.archived === true) wrap.style.cssText += ';opacity:.45'
    // dsh-web session tabs: drag to reorder the session list.
    wrap.draggable = true
    wrap.title = 'drag to reorder · right-click for actions'
    wrap.addEventListener('dragstart', (event) => {
      dragSessionId = s.id
      event.dataTransfer?.setData('text/plain', s.id)
      wrap.style.opacity = '0.4'
    })
    wrap.addEventListener('dragend', () => { wrap.style.opacity = '' })
    wrap.addEventListener('dragover', (event) => { event.preventDefault() })
    wrap.addEventListener('drop', (event) => {
      event.preventDefault()
      const from = dragSessionId
      if (from === null || from === s.id) return
      const fromIdx = chatSessions.findIndex(x => x.id === from)
      const toIdx = chatSessions.findIndex(x => x.id === s.id)
      if (fromIdx < 0 || toIdx < 0) return
      const [moved] = chatSessions.splice(fromIdx, 1)
      chatSessions.splice(toIdx, 0, moved!)
      dragSessionId = null
      chatSessionsPersist()
      rerender()
    })
    // dsh-web context menu: right-click on a session chip.
    wrap.oncontextmenu = (event) => {
      event.preventDefault()
      event.stopPropagation()
      const root = rootHost()
      if (root === null) return
      const ctxItems: ContextMenuItem[] = [
        { label: 'Open', onPick: () => chatSessionSelect(s.id) },
        { label: '✎ Rename', onPick: () => chatSessionRename(s.id) },
        {
          label: '⧉ Duplicate',
          onPick: () => {
            const copy: ChatSession = {
              ...s,
              id: `s${Date.now()}`,
              name: `${s.name} copy`,
              messages: s.messages.map(m => ({ ...m })),
              unread: 0,
              archived: false,
            }
            chatSessions.push(copy)
            chatActiveId = copy.id
            chatDraft = ''
            chatSyncActive()
            chatSessionsPersist()
            rerender()
            showToast(rootHost(), `⧉ Duplicated ${s.name}`)
          },
        },
        { label: s.archived === true ? '↩ Restore' : '🗄 Archive', onPick: () => chatSessionArchive(s.id) },
        { label: 'Copy session ID', hint: s.id, onPick: () => copyText(s.id) },
        {
          label: '⬇ Export JSON',
          onPick: () => {
            const payload = JSON.stringify({
              name: s.name,
              session_id: s.id,
              exported_at: new Date().toISOString(),
              messages: s.messages,
            }, null, 2)
            const blob = new Blob([payload], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const a = el('a', 'dl', 'download')
            a.href = url
            a.download = `research-session-${new Date().toISOString().slice(0, 10)}.json`
            document.body.appendChild(a)
            a.click()
            a.remove()
            setTimeout(() => URL.revokeObjectURL(url), 4000)
            showToast(rootHost(), `⬇ Exported ${s.name}`)
          },
        },
        {
          label: '🗑 Clear conversation',
          onPick: () => {
            chatClear()
            rerender()
          },
        },
        { label: '× Close', danger: true, onPick: () => chatSessionClose(s.id) },
      ]
      openContextMenu(root, event.clientX, event.clientY, ctxItems)
    }
    wrap.appendChild(tab)
    wrap.appendChild(arch)
    wrap.appendChild(close)
    sessionTabs.appendChild(wrap)
  }
  const newSession = el('button', 'hbtn', '＋')
  newSession.title = 'new chat session'
  newSession.style.cssText = 'padding:3px 9px;font-size:11px'
  newSession.onclick = () => { chatSessionNew() }
  sessionTabs.appendChild(newSession)
  // dsh-web backup: export every session (transcripts included) as JSON.
  const backupBtn = el('button', 'hbtn', '💾')
  backupBtn.title = 'backup all sessions (JSON)'
  backupBtn.setAttribute('aria-label', 'Backup all sessions as JSON')
  backupBtn.style.cssText = 'padding:3px 9px;font-size:11px'
  backupBtn.onclick = () => {
    const payload = JSON.stringify({
      exported_at: new Date().toISOString(),
      sessions: chatSessions.map(s => ({ ...s, messages: s.messages.slice(-CHAT_MAX) })),
    }, null, 2)
    const blob = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = el('a', 'dl', 'download')
    a.href = url
    a.download = `research-sessions-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    showToast(rootHost(), `💾 Backed up ${chatSessions.length} session(s)`)
  }
  sessionTabs.appendChild(backupBtn)
  // dsh-web restore: import sessions back from a backup JSON file.
  const restoreBtn = el('button', 'hbtn', '⬆')
  restoreBtn.title = 'restore sessions from a backup JSON'
  restoreBtn.setAttribute('aria-label', 'Restore sessions from backup')
  restoreBtn.style.cssText = 'padding:3px 9px;font-size:11px'
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'application/json,.json'
  fileInput.style.display = 'none'
  fileInput.onchange = () => {
    const file = fileInput.files?.[0]
    if (file === undefined) return
    void file.text().then((raw) => {
      try {
        const parsed = JSON.parse(raw) as { sessions?: unknown }
        const list = Array.isArray(parsed.sessions) ? parsed.sessions : null
        if (list === null || list.length === 0) throw new Error('no sessions')
        const cleaned = list.filter((s): s is ChatSession => typeof s === 'object' && s !== null
          && typeof (s as ChatSession).id === 'string' && Array.isArray((s as ChatSession).messages))
        if (cleaned.length === 0) throw new Error('invalid shape')
        chatSessions = cleaned
        chatSessionEnsure()
        chatSessionsPersist()
        rerender()
        showToast(rootHost(), `⬆ Restored ${cleaned.length} session(s)`)
      } catch {
        showToast(rootHost(), '⬆ Restore failed: invalid backup file')
      }
    })
    fileInput.value = ''
  }
  restoreBtn.onclick = () => fileInput.click()
  document.body.appendChild(fileInput)
  sessionTabs.appendChild(restoreBtn)
  column.appendChild(sessionTabs)

  // Transcript search box (dsh-web "Search sessions" on the chat itself):
  // filters which messages are shown; matches are highlighted.
  const searchRow = el('div')
  searchRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px'
  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = '🔍 Search conversation…'
  searchInput.value = chatSearchQuery
  searchInput.style.cssText = 'flex:1;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font:11px/1.4 system-ui,sans-serif;outline:none'
  searchInput.onfocus = () => { searchInput.style.borderColor = 'var(--accent)' }
  searchInput.onblur = () => { searchInput.style.borderColor = 'var(--border)' }
  searchInput.oninput = () => { chatSearchQuery = searchInput.value; rerender() }
  const clearSearch = el('button', 'hbtn', '×')
  clearSearch.title = 'clear search'
  clearSearch.style.cssText = 'padding:0 7px'
  clearSearch.onclick = () => {
    chatSearchQuery = ''
    rerender()
  }
  searchRow.append(searchInput, clearSearch)
  // dsh-web cross-session search: search claims/evidence across projects.
  const globalBtn = el('button', 'hbtn', '🌐 global')
  globalBtn.title = 'search across all projects'
  globalBtn.style.cssText = 'padding:0 8px;flex-shrink:0'
  globalBtn.onclick = () => {
    const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
    if (root !== null) openGlobalSearchModal(root)
  }
  searchRow.appendChild(globalBtn)
  // dsh-web "commands only" filter: a compact list of just the commands.
  const commandsOnlyBtn = el('button', 'hbtn', chatCommandsOnly ? '⌘ commands on' : '⌘ commands')
  commandsOnlyBtn.title = 'show only command messages'
  commandsOnlyBtn.setAttribute('aria-pressed', chatCommandsOnly ? 'true' : 'false')
  commandsOnlyBtn.style.cssText = 'padding:0 8px;flex-shrink:0'
  commandsOnlyBtn.onclick = () => {
    chatCommandsOnly = !chatCommandsOnly
    rerender()
  }
  searchRow.appendChild(commandsOnlyBtn)
  // dsh-web command history panel: all executed commands in one view.
  const historyBtn = el('button', 'hbtn', '🕘 history')
  historyBtn.title = 'command execution history'
  historyBtn.style.cssText = 'padding:0 8px;flex-shrink:0'
  historyBtn.onclick = () => {
    const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
    if (root !== null) openCommandHistoryModal(root)
  }
  searchRow.appendChild(historyBtn)
  // dsh-web share: export the whole transcript as markdown.
  const exportChatBtn = el('button', 'hbtn', '⬇ md')
  exportChatBtn.title = 'export conversation as markdown'
  exportChatBtn.style.cssText = 'padding:0 8px;flex-shrink:0'
  exportChatBtn.onclick = () => {
    const activeName = chatSessions.find(x => x.id === chatActiveId)?.name ?? 'conversation'
    const lines = [`# Research OS conversation — ${activeName}`, '', ...chatMessages.map(m => {
      const role = m.role === 'user' ? '**You**' : m.role === 'error' ? '**Error**' : '**Research OS**'
      return `## ${role} · ${m.time}\n\n${m.text}\n`
    })]
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = el('a', 'dl', 'download')
    a.href = url
    a.download = `research-conversation-${new Date().toISOString().slice(0, 10)}.md`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }
  searchRow.appendChild(exportChatBtn)
  // dsh-web export: the same transcript as JSON (session metadata included).
  const exportJsonBtn = el('button', 'hbtn', '⬇ json')
  exportJsonBtn.title = 'export conversation as JSON'
  exportJsonBtn.style.cssText = 'padding:0 8px;flex-shrink:0'
  exportJsonBtn.onclick = () => {
    const active = chatSessions.find(x => x.id === chatActiveId)
    const payload = JSON.stringify({
      name: active?.name ?? 'conversation',
      session_id: chatActiveId,
      exported_at: new Date().toISOString(),
      messages: chatMessages,
    }, null, 2)
    const blob = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = el('a', 'dl', 'download')
    a.href = url
    a.download = `research-conversation-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }
  searchRow.appendChild(exportJsonBtn)
  // dsh-web quick commands: favourite commands as one-tap chips.
  const favs = favCommands()
  for (const [name, line] of CHAT_COMMANDS) {
    if (!favs.has(name)) continue
    const chip = el('button', 'hbtn', `★ ${name}`)
    chip.title = `quick run: ${line}`
    chip.style.cssText = 'padding:0 8px;flex-shrink:0;color:var(--tone-amber)'
    chip.onclick = () => {
      chatDraft = line
      activeTab = 'chat'
      rerender()
      setTimeout(() => {
        const rootEl = rootHost()
        const ta = rootEl?.querySelector('textarea[placeholder*="research"]') as HTMLTextAreaElement | null
        ta?.focus()
      }, 120)
    }
    searchRow.appendChild(chip)
  }
  column.appendChild(searchRow)

  // dsh-web scroll affordance: wrap the transcript so a "jump to bottom"
  // button can float over it while the user scrolls up.
  const streamWrap = el('div')
  streamWrap.style.cssText = 'flex:1;display:flex;flex-direction:column;position:relative;min-height:0'
  const stream = el('div')
  stream.style.cssText = 'flex:1;overflow-y:auto;padding:4px 2px;display:flex;flex-direction:column;gap:8px'
  // dsh-web a11y: announce assistant replies as they land.
  stream.setAttribute('aria-live', 'polite')
  stream.setAttribute('aria-label', 'conversation')
  const jumpBottom = el('button', 'hbtn', '↓')
  jumpBottom.title = 'jump to the newest message'
  jumpBottom.setAttribute('aria-label', 'Jump to newest message')
  jumpBottom.style.cssText = 'position:absolute;right:10px;bottom:10px;padding:2px 10px;font-size:12px;display:none;box-shadow:0 4px 16px rgba(0,0,0,.25)'
  jumpBottom.onclick = () => { stream.scrollTop = stream.scrollHeight }
  stream.onscroll = () => {
    const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120
    jumpBottom.style.display = nearBottom ? 'none' : 'inline-block'
  }
  streamWrap.append(stream, jumpBottom)
  if (chatMessages.length === 0) {
    chatPush('assistant', 'Welcome to **Research OS**.\n\nType a command below, e.g. `/research status` or `/research new demo1` — or `/research help` for the full list.')
    // dsh-web starter chips: one-tap quick commands for a fresh session.
    const starters = el('div')
    starters.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;padding:2px'
    const starterDefs: Array<[string, string]> = [
      ['🆕 new project', '/research new demo1'],
      ['📋 list projects', '/research list'],
      ['📌 status', '/research status'],
      ['🧾 claims', '/research claims'],
      ['✍️ write manuscript', '/research write'],
      ['📦 export bundle', '/research export'],
    ]
    for (const [label, line] of starterDefs) {
      const chip = el('button', 'hbtn', label)
      chip.style.cssText = 'padding:3px 10px;font-size:10.5px'
      chip.onclick = () => {
        chatDraft = line
        rerender()
        setTimeout(() => {
          const rootEl = rootHost()
          const ta = rootEl?.querySelector('textarea[placeholder*="research"]') as HTMLTextAreaElement | null
          ta?.focus()
        }, 120)
      }
      starters.appendChild(chip)
    }
    stream.appendChild(starters)
  }
  const searchQ = chatSearchQuery.trim().toLowerCase()
  // dsh-web virtualized feel: window the transcript to the newest 80
  // messages (search/commands-only views render everything).
  const windowed = searchQ === '' && !chatCommandsOnly && chatMessages.length > 80
  const startIdx = windowed ? chatMessages.length - 80 : 0
  if (windowed) {
    const notice = el('div', 'muted', `Showing the newest 80 of ${chatMessages.length} messages — ↑/↓ walk history, or search to see more.`)
    notice.style.cssText = 'font-size:10px;padding:2px;text-align:center'
    stream.appendChild(notice)
  }
  // dsh-web pinned: starred messages surface in a 📌 box (click to jump).
  const pinnedMsgs = chatMessages.filter(m => m.pinned === true)
  if (pinnedMsgs.length > 0 && searchQ === '' && !chatCommandsOnly) {
    const pinBox = el('div')
    pinBox.style.cssText = 'border:1px dashed var(--tone-amber);border-radius:10px;padding:6px 10px;display:flex;flex-direction:column;gap:4px;background:var(--tone-amber-bg)'
    pinBox.appendChild(el('div', 'muted', `📌 Pinned (${pinnedMsgs.length})`))
    for (const pm of pinnedMsgs) {
      const idx = chatMessages.indexOf(pm)
      const prow = el('div')
      prow.style.cssText = 'display:flex;gap:8px;align-items:center;cursor:pointer;font-size:11px;color:var(--text)'
      prow.title = 'jump to pinned message'
      const roleTag = el('span', 'artifact-kind', pm.role === 'user' ? 'YOU' : 'OS')
      const preview = el('span', 'grow', pm.text.slice(0, 90) + (pm.text.length > 90 ? '…' : ''))
      preview.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      prow.append(roleTag, preview)
      prow.onclick = () => { chatDetailIndex = idx; rerender() }
      pinBox.appendChild(prow)
    }
    stream.appendChild(pinBox)
  }
  for (let i = startIdx; i < chatMessages.length; i++) {
    const msg = chatMessages[i]!
    if (searchQ !== '' && !msg.text.toLowerCase().includes(searchQ)) continue
    if (chatCommandsOnly && msg.role !== 'user') continue
    // dsh-web quote-reply: quoted message preview above the bubble.
    if (msg.quote !== undefined) {
      const quoteBox = el('div')
      quoteBox.style.cssText = msg.role === 'user'
        ? 'align-self:flex-end;max-width:85%;background:var(--accent-soft);border-left:3px solid var(--accent);border-radius:6px;padding:4px 10px;font-size:10.5px;color:var(--text-2);margin-bottom:-4px;cursor:pointer'
        : 'align-self:flex-start;max-width:90%;background:var(--bg-3);border-left:3px solid var(--border-strong);border-radius:6px;padding:4px 10px;font-size:10.5px;color:var(--text-2);margin-bottom:-4px;cursor:pointer'
      const quotedIndex = msg.quote.index
      const quoted = chatMessages[quotedIndex]
      const quoteLabel = el('span', '', quoted !== undefined
        ? `↩ ${quoted.role === 'user' ? 'you' : 'assistant'}: ${quoted.text.slice(0, 60)}${quoted.text.length > 60 ? '…' : ''}`
        : `↩ #${quotedIndex + 1}`)
      quoteBox.appendChild(quoteLabel)
      quoteBox.title = 'jump to quoted message'
      quoteBox.onclick = () => {
        chatDetailIndex = quotedIndex >= 0 && quotedIndex < chatMessages.length ? quotedIndex : -1
        rerender()
      }
      stream.appendChild(quoteBox)
    }
    const bubble = el('div')
    bubble.style.cssText = msg.role === 'user'
      ? 'align-self:flex-end;background:var(--accent);color:#fff;border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;word-break:break-word;font-size:12px;cursor:pointer'
      : msg.role === 'error'
        ? 'align-self:flex-start;background:var(--tone-red-bg);color:var(--tone-red);border:1px solid var(--tone-red);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;word-break:break-word;font-size:12px;cursor:pointer'
        : 'align-self:flex-start;background:var(--bg-2);border:1px solid var(--border);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;word-break:break-word;font-size:12px;cursor:pointer'
    if (chatDetailIndex === i) {
      bubble.style.outline = '2px solid var(--accent)'
    }
    // Rich line rendering (headings/lists/code/bold) — textContent-safe.
    // /research status answers render as a field-card grid (dsh-web
    // structured results) instead of raw text.
    const isStatus = msg.role === 'assistant' && /^\*\*.*\*\* \(`rsp_/.test(msg.text) && msg.text.includes('Next actions:')
    const isSurvey = msg.role === 'assistant' && msg.text.startsWith('Survey complete:')
    const isRun = msg.role === 'assistant' && /Job \*\*[^*]+\*\* \[[^\]]+\] submitted/.test(msg.text)
    const isEvidence = msg.role === 'assistant' && /Evidence \*\*[^*]+\*\* ingested/.test(msg.text)
    const isGate = msg.role === 'assistant' && /Gate \*\*[^*]+\*\* (?:created|opened)/.test(msg.text)
    const isContract = msg.role === 'assistant' && /Contract \*\*[^*]+\*\* registered/.test(msg.text)
    const isWrite = msg.role === 'assistant' && /Manuscript \*\*[^*]+\*\* built/.test(msg.text)
    const isReview = msg.role === 'assistant' && msg.text.startsWith('Reviewer:')
    const isExport = msg.role === 'assistant' && /Release bundle \*\*[^*]+\*\* generated/.test(msg.text)
    const isIdeas = msg.role === 'assistant' && /^IdeaCards:/m.test(msg.text)
    const isList = msg.role === 'assistant' && /^Projects \(\d+\):/m.test(msg.text)
    const isJobs = msg.role === 'assistant' && /^Jobs:/m.test(msg.text)
    const isGatesList = msg.role === 'assistant' && /^Gates:/m.test(msg.text)
    const isClaims = msg.role === 'assistant' && /^Claims:/m.test(msg.text)
    let structured: HTMLElement | null = null
    if (isStatus && searchQ === '') {
      const phaseMatch = /phase `([^`]+)` rev (\d+)/.exec(msg.text)
      const pendingMatch = msg.text.match(/Pending gates:\n([\s\S]*?)\n\n/)
      const jobsMatch = msg.text.match(/Recent jobs:\n([\s\S]*?)\n\n/)
      const budgetMatch = /Budget: \$([\d.]+) \/ ([\d.]+|\S+) max, ([\d.]+) \/ ([\d.]+|\S+) GPU-h/.exec(msg.text)
      const grid = el('div')
      grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:4px 0'
      if (phaseMatch !== null) {
        grid.appendChild(chatFieldCell('Phase', `${phaseMatch[1]} · rev ${phaseMatch[2]}`))
      }
      const next = msg.text.split('Next actions:')[1]?.split('\n\n')[0]?.split('\n').filter(l => l.trim().startsWith('- ')).map(l => l.trim().slice(2)).slice(0, 3).join('; ') ?? '—'
      grid.appendChild(chatFieldCell('Next', next || '—'))
      const pending = pendingMatch !== null ? pendingMatch[1].split('\n').filter(l => l.trim() !== '').slice(0, 3).map(l => l.trim()).join('; ') : 'none'
      grid.appendChild(chatFieldCell('Pending gates', pending || 'none'))
      const jobs = jobsMatch !== null ? jobsMatch[1].split('\n').filter(l => l.trim() !== '').slice(0, 3).map(l => l.trim()).join('; ') : 'none'
      grid.appendChild(chatFieldCell('Jobs', jobs || 'none'))
      if (budgetMatch !== null) {
        grid.appendChild(chatFieldCell('Budget', `$${budgetMatch[1]} / ${budgetMatch[2]} max · ${budgetMatch[3]} / ${budgetMatch[4]} GPU-h`))
      }
      structured = grid
    } else if (isSurvey && searchQ === '') {
      // dsh-web survey result card: snapshot + dedup + top hits.
      const snap = /Survey complete: \*\*([^*]+)\*\* — (\d+) papers after dedup \((\d+) removed\)/.exec(msg.text)
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const headRow = el('div', 'row')
      headRow.style.cssText = 'align-items:center;gap:8px'
      headRow.appendChild(el('span', '', '📚'))
      const snapName = el('span', 'pname', snap?.[1] ?? 'snapshot')
      snapName.style.cssText = 'font-size:12px'
      headRow.appendChild(snapName)
      headRow.appendChild(el('span', 'grow'))
      if (snap !== null) headRow.appendChild(el('span', 'muted', `${snap[2]} papers · ${snap[3]} dedup`))
      card.appendChild(headRow)
      const hits = msg.text.split('Top hits:')[1]?.split('\n').filter(l => /^- /.test(l.trim())).slice(0, 5) ?? []
      for (const h of hits) {
        card.appendChild(el('div', 'muted', h.trim()))
      }
      // dsh-web depth: jump to the artifacts tab (snapshot lives there).
      const goArtifacts = el('button', 'hbtn', '→ view artifacts')
      goArtifacts.style.cssText = 'align-self:flex-start;margin-top:4px'
      goArtifacts.onclick = () => {
        activeTab = 'artifacts'
        tabSave()
        rerender()
      }
      card.appendChild(goArtifacts)
      structured = card
    } else if (isRun && searchQ === '') {
      // dsh-web run result card: job id, kind, status.
      const jobMatch = /Job \*\*([^*]+)\*\* \[([^\]]+)\] submitted \(([^)]+)\)/.exec(msg.text)
      const grid = el('div')
      grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:4px 0'
      if (jobMatch !== null) {
        grid.appendChild(chatFieldCell('Job', jobMatch[1] ?? ''))
        grid.appendChild(chatFieldCell('Kind', jobMatch[2] ?? ''))
        grid.appendChild(chatFieldCell('Status', jobMatch[3] ?? ''))
      } else {
        grid.appendChild(chatFieldCell('Job', 'submitted'))
      }
      // dsh-web depth: jump to the Runs tab to watch progress.
      const goRuns = el('button', 'hbtn', '→ watch in Runs tab')
      goRuns.style.cssText = 'align-self:flex-start;margin-top:4px'
      goRuns.onclick = () => {
        activeTab = 'runs'
        tabSave()
        rerender()
      }
      grid.appendChild(goRuns)
      structured = grid
    } else if (isEvidence && searchQ === '') {
      // dsh-web evidence card: id + provenance status.
      const evMatch = /Evidence \*\*([^*]+)\*\* ingested \(([^)]+)\)/.exec(msg.text)
      const grid = el('div')
      grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:4px 0'
      if (evMatch !== null) {
        grid.appendChild(chatFieldCell('Evidence', evMatch[1] ?? ''))
        grid.appendChild(chatFieldCell('Status', evMatch[2] ?? ''))
      }
      const goEv = el('button', 'hbtn', '→ open Evidence tab')
      goEv.style.cssText = 'align-self:flex-start;margin-top:4px'
      goEv.onclick = () => {
        activeTab = 'evidence'
        tabSave()
        rerender()
      }
      grid.appendChild(goEv)
      structured = grid
    } else if (isGate && searchQ === '') {
      // dsh-web gate card: gate id + a jump-to-Gates action.
      const gateMatch = /Gate \*\*([^*]+)\*\*/.exec(msg.text)
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '⛩️'))
      head.appendChild(el('span', 'pname', gateMatch?.[1] ?? 'gate'))
      head.appendChild(el('span', 'grow'))
      head.appendChild(pill('pending'))
      card.appendChild(head)
      const go = el('button', 'hbtn', '→ open Gates tab')
      go.style.cssText = 'align-self:flex-start'
      go.onclick = () => {
        activeTab = 'gates'
        tabSave()
        rerender()
      }
      card.appendChild(go)
      structured = card
    } else if (isContract && searchQ === '') {
      // dsh-web contract card: id + jump to Gates for approval.
      const cMatch = /Contract \*\*([^*]+)\*\* registered/.exec(msg.text)
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '📋'))
      head.appendChild(el('span', 'pname', cMatch?.[1] ?? 'contract'))
      head.appendChild(el('span', 'grow'))
      head.appendChild(pill('pending'))
      card.appendChild(head)
      const goGates = el('button', 'hbtn', '→ approve in Gates tab')
      goGates.style.cssText = 'align-self:flex-start'
      goGates.onclick = () => {
        activeTab = 'gates'
        tabSave()
        rerender()
      }
      card.appendChild(goGates)
      structured = card
    } else if (isClaims && searchQ === '') {
      // dsh-web claims card: count + jump to Evidence.
      const count = msg.text.split('\n').filter(l => /^- /m.test(l)).length
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '🧾'))
      head.appendChild(el('span', 'pname', `${count} claim(s)`))
      head.appendChild(el('span', 'grow'))
      const goEv = el('button', 'hbtn', '→ view in Evidence tab')
      goEv.style.cssText = 'align-self:flex-start;margin-top:4px'
      goEv.onclick = () => {
        activeTab = 'evidence'
        tabSave()
        rerender()
      }
      card.appendChild(goEv)
      structured = card
    } else if (isWrite && searchQ === '') {
      // dsh-web write card: manuscript id + jump to Phase.
      const mMatch = /Manuscript \*\*([^*]+)\*\* built/.exec(msg.text)
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '📄'))
      head.appendChild(el('span', 'pname', mMatch?.[1] ?? 'manuscript'))
      head.appendChild(el('span', 'grow'))
      head.appendChild(pill('built'))
      card.appendChild(head)
      const goPhase = el('button', 'hbtn', '→ open Phase tab')
      goPhase.style.cssText = 'align-self:flex-start'
      goPhase.onclick = () => {
        activeTab = 'phase'
        tabSave()
        rerender()
      }
      card.appendChild(goPhase)
      structured = card
    } else if (isReview && searchQ === '') {
      // dsh-web review card: PASS/SEE CHECKS + jump to Evidence.
      const pass = msg.text.startsWith('Reviewer: PASS')
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '🔍'))
      head.appendChild(el('span', 'pname', pass ? 'Review PASS' : 'Review SEE CHECKS'))
      head.appendChild(el('span', 'grow'))
      head.appendChild(pill(pass ? 'supported' : 'inconclusive'))
      card.appendChild(head)
      const goEv = el('button', 'hbtn', '→ view claims in Evidence tab')
      goEv.style.cssText = 'align-self:flex-start;margin-top:4px'
      goEv.onclick = () => {
        activeTab = 'evidence'
        tabSave()
        rerender()
      }
      card.appendChild(goEv)
      structured = card
    } else if (isExport && searchQ === '') {
      // dsh-web export card: bundle id + jump to Phase (release gate).
      const bMatch = /Release bundle \*\*([^*]+)\*\* generated/.exec(msg.text)
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '📦'))
      head.appendChild(el('span', 'pname', bMatch?.[1] ?? 'release bundle'))
      head.appendChild(el('span', 'grow'))
      head.appendChild(pill('exported'))
      card.appendChild(head)
      const goPhase = el('button', 'hbtn', '→ open Phase tab')
      goPhase.style.cssText = 'align-self:flex-start;margin-top:4px'
      goPhase.onclick = () => {
        activeTab = 'phase'
        tabSave()
        rerender()
      }
      card.appendChild(goPhase)
      structured = card
    } else if (isIdeas && searchQ === '') {
      // dsh-web ideas card: count + jump to Phase (Idea panel).
      const ideaLines = msg.text.split('\n').filter(l => /^- /.test(l.trim()))
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '💡'))
      head.appendChild(el('span', 'pname', `${ideaLines.length} IdeaCard(s)`))
      head.appendChild(el('span', 'grow'))
      card.appendChild(head)
      for (const l of ideaLines.slice(0, 4)) {
        card.appendChild(el('div', 'muted', l.trim()))
      }
      const goPhase = el('button', 'hbtn', '→ open Phase tab')
      goPhase.style.cssText = 'align-self:flex-start;margin-top:4px'
      goPhase.onclick = () => {
        activeTab = 'phase'
        tabSave()
        rerender()
      }
      card.appendChild(goPhase)
      structured = card
    } else if (isList && searchQ === '') {
      // dsh-web projects card: count + first rows.
      const countMatch = /^Projects \((\d+)\):/m.exec(msg.text)
      const rows = msg.text.split('\n').filter(l => /^- /.test(l.trim()))
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '📁'))
      head.appendChild(el('span', 'pname', `${countMatch?.[1] ?? rows.length} project(s)`))
      head.appendChild(el('span', 'grow'))
      card.appendChild(head)
      for (const r of rows.slice(0, 6)) {
        // dsh-web depth: each project row jumps to that project.
        const idMatch = /`([^`]+)`/.exec(r)
        const row = el('div')
        row.style.cssText = 'font-size:11px;color:var(--text-2);cursor:pointer;border-radius:6px;padding:2px 4px'
        row.textContent = r.trim().replace(/^- /, '· ')
        if (idMatch !== null) {
          const pid = idMatch[1]!
          row.title = `switch to ${pid}`
          row.onmouseenter = () => { row.style.background = 'var(--bg-hover)' }
          row.onmouseleave = () => { row.style.background = 'none' }
          row.onclick = () => {
            projectId = pid
            rerender()
            showToast(rootHost(), `⇥ Switched to ${pid.slice(0, 22)}…`)
          }
        }
        card.appendChild(row)
      }
      if (rows.length > 6) card.appendChild(el('div', 'muted', `… and ${rows.length - 6} more`))
      structured = card
    } else if (isJobs && searchQ === '') {
      // dsh-web runs card: job rows with status pills + jump to Runs.
      const jobLines = msg.text.split('\n').filter(l => /^- /.test(l.trim()))
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '⚙️'))
      head.appendChild(el('span', 'pname', `${jobLines.length} run(s)`))
      head.appendChild(el('span', 'grow'))
      card.appendChild(head)
      for (const l of jobLines.slice(0, 8)) {
        const m = /`([^`]+)` \[([^\]]+)\] (\S+)/.exec(l)
        const row = el('div', 'row')
        if (m !== null) {
          row.appendChild(el('span', 'artifact-kind', String(m[2]).toUpperCase()))
          const text = el('span', 'grow mono', fmtId(m[1] ?? '', 26))
          text.style.cssText = 'font-size:10px'
          row.appendChild(text)
          row.appendChild(pill(m[3] ?? ''))
        } else {
          row.appendChild(el('span', 'muted', l.trim().replace(/^- /, '· ')))
        }
        card.appendChild(row)
      }
      if (jobLines.length > 8) card.appendChild(el('div', 'muted', `… and ${jobLines.length - 8} more`))
      const goRuns = el('button', 'hbtn', '→ open Runs tab')
      goRuns.style.cssText = 'align-self:flex-start;margin-top:4px'
      goRuns.onclick = () => {
        activeTab = 'runs'
        tabSave()
        rerender()
      }
      card.appendChild(goRuns)
      structured = card
    } else if (isGatesList && searchQ === '') {
      // dsh-web gates card: pending/decided counts.
      const rows = msg.text.split('\n').filter(l => /^- /.test(l.trim()))
      const pendingCount = rows.filter(r => /\[pending\]/.test(r)).length
      const decidedCount = rows.length - pendingCount
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '⛩️'))
      head.appendChild(el('span', 'pname', `${rows.length} gate(s) · ${pendingCount} pending · ${decidedCount} decided`))
      head.appendChild(el('span', 'grow'))
      card.appendChild(head)
      for (const r of rows.slice(0, 5)) {
        const isPending = /\[pending\]/.test(r)
        const row = el('div', 'muted', r.trim().replace(/^- /, isPending ? '⏳ ' : '✅ '))
        card.appendChild(row)
      }
      if (rows.length > 5) card.appendChild(el('div', 'muted', `… and ${rows.length - 5} more`))
      const goGates = el('button', 'hbtn', '→ open Gates tab')
      goGates.style.cssText = 'align-self:flex-start;margin-top:4px'
      goGates.onclick = () => {
        activeTab = 'gates'
        tabSave()
        rerender()
      }
      card.appendChild(goGates)
      structured = card
    }
    const lineCount = msg.text.split('\n').length
    const collapsed = msg.role === 'assistant' && lineCount > 8 && searchQ === '' && structured === null
    const renderBubble = (): void => {
      if (structured !== null) {
        bubble.replaceChildren(structured)
      } else {
        bubble.replaceChildren(...formatChatText(collapsed ? msg.text.split('\n').slice(0, 6).join('\n') + '\n…' : msg.text, searchQ === '' ? undefined : searchQ))
      }
    }
    renderBubble()
    if (collapsed) {
      const toggle = el('button', 'hbtn', '⤵ show more')
      toggle.style.cssText = 'padding:0 8px;font-size:9px;margin-top:4px;align-self:flex-start'
      toggle.setAttribute('aria-expanded', 'false')
      let expanded = false
      toggle.onclick = (event) => {
        event.stopPropagation()
        expanded = !expanded
        if (expanded) {
          bubble.replaceChildren(...formatChatText(msg.text))
          toggle.textContent = '⤴ show less'
          bubble.appendChild(toggle)
        } else {
          renderBubble()
          bubble.appendChild(toggle)
        }
      }
      bubble.appendChild(toggle)
    }
    // dsh-web "details": click a message to inspect it in the side panel.
    bubble.title = 'click for details'
    bubble.onclick = () => {
      chatDetailIndex = chatDetailIndex === i ? -1 : i
      rerender()
    }
    stream.appendChild(bubble)
    // dsh-web message actions: user messages get a copy button too (the
    // assistant/error actions below add copy + quote-reply).
    if (msg.role === 'user') {
      const actionsRow = el('div')
      actionsRow.style.cssText = 'align-self:flex-end;display:flex;gap:6px;margin-top:2px'
      const copy = el('button', 'hbtn', '⧉ copy')
      copy.style.cssText = 'padding:0 6px;font-size:9px'
      copy.onclick = () => {
        void navigator.clipboard.writeText(msg.text).then(
          () => { copy.textContent = '✓ copied' },
          () => { copy.textContent = 'copy failed' },
        )
        setTimeout(() => { copy.textContent = '⧉ copy' }, 1600)
      }
      actionsRow.appendChild(copy)
      // dsh-web pin: star the message (📌 section at the top of the chat).
      const pin = el('button', 'hbtn', msg.pinned === true ? '★' : '☆')
      pin.title = msg.pinned === true ? 'unpin message' : 'pin message'
      pin.style.cssText = `padding:0 6px;font-size:9px;${msg.pinned === true ? 'color:var(--tone-amber)' : ''}`
      pin.onclick = () => {
        msg.pinned = !msg.pinned
        chatPersist()
        chatSessionsPersist()
        rerender()
      }
      actionsRow.appendChild(pin)
      stream.appendChild(actionsRow)
    }
    if (msg.role === 'assistant' || msg.role === 'error') {
      const actionsRow = el('div')
      actionsRow.style.cssText = 'align-self:flex-start;display:flex;gap:6px;margin-top:2px'
      const copy = el('button', 'hbtn', '⧉ copy')
      copy.style.cssText = 'padding:0 6px;font-size:9px'
      copy.onclick = () => {
        void navigator.clipboard.writeText(msg.text).then(
          () => { copy.textContent = '✓ copied' },
          () => { copy.textContent = 'copy failed' },
        )
        setTimeout(() => { copy.textContent = '⧉ copy' }, 1600)
      }
      actionsRow.appendChild(copy)
      // dsh-web quote-reply: reply quoting this message.
      const quote = el('button', 'hbtn', '↩ reply')
      quote.style.cssText = 'padding:0 6px;font-size:9px'
      quote.onclick = () => {
        chatDraft = ''
        activeTab = 'chat'
        chatQuoteTarget = { index: i, text: msg.text }
        rerender()
        setTimeout(() => {
          const hostEl = document.querySelector('#dsh-scholar-ui')
          const rootEl = hostEl !== null ? hostEl.shadowRoot : null
          const ta = rootEl?.querySelector('textarea[placeholder*="research"]') as HTMLTextAreaElement | null
          ta?.focus()
        }, 120)
      }
      actionsRow.appendChild(quote)
      // dsh-web pin: star the message (📌 section at the top of the chat).
      const pin = el('button', 'hbtn', msg.pinned === true ? '★' : '☆')
      pin.title = msg.pinned === true ? 'unpin message' : 'pin message'
      pin.style.cssText = `padding:0 6px;font-size:9px;${msg.pinned === true ? 'color:var(--tone-amber)' : ''}`
      pin.onclick = () => {
        msg.pinned = !msg.pinned
        chatPersist()
        chatSessionsPersist()
        rerender()
      }
      actionsRow.appendChild(pin)
      stream.appendChild(actionsRow)
    }
    const stamp = el('div')
    stamp.style.cssText = msg.role === 'user'
      ? 'align-self:flex-end;color:var(--text-3);font-size:9px;margin-top:-4px'
      : 'align-self:flex-start;color:var(--text-3);font-size:9px;margin-top:-4px'
    stamp.textContent = msg.time
    stream.appendChild(stamp)
  }
  if (stream.childElementCount === 0 && (searchQ !== '' || chatCommandsOnly)) {
    const empty = el('div', 'empty', chatCommandsOnly
      ? 'No commands yet — run one with /research …'
      : `No messages match "${chatSearchQuery.trim()}".`)
    empty.style.cssText = 'padding:10px 2px'
    stream.appendChild(empty)
  }
  // dsh-web behavior: always scroll to the newest message.
  stream.scrollTop = stream.scrollHeight
  column.appendChild(streamWrap)

  // dsh-web "details" side panel: raw transcript of the selected message.
  const detailMsg = chatDetailIndex >= 0 && chatDetailIndex < chatMessages.length ? chatMessages[chatDetailIndex] : null
  if (detailMsg !== null) {
    const panel = el('div')
    panel.style.cssText = 'width:240px;flex-shrink:0;margin-left:10px;border-left:1px solid var(--border);padding-left:12px;display:flex;flex-direction:column;gap:8px;overflow-y:auto'
    const headRow = el('div', 'row')
    headRow.style.cssText = 'justify-content:space-between;align-items:center'
    headRow.appendChild(el('div', 'section-label', 'Message details'))
    const closeDetail = el('button', 'hbtn ghost', '×')
    closeDetail.title = 'close details panel'
    closeDetail.setAttribute('aria-label', 'Close details panel')
    closeDetail.style.cssText = 'padding:0 4px;font-size:11px'
    closeDetail.onclick = () => { chatDetailIndex = -1; rerender() }
    headRow.appendChild(closeDetail)
    panel.appendChild(headRow)
    const meta = el('div')
    meta.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:10.5px'
    const roleRow = el('div', 'row')
    roleRow.appendChild(el('span', 'muted', 'Role'))
    roleRow.appendChild(pill(detailMsg.role))
    const idxRow = el('div', 'row')
    idxRow.appendChild(el('span', 'muted', 'Message'))
    idxRow.appendChild(el('span', 'mono', `#${chatDetailIndex + 1} / ${chatMessages.length}`))
    const timeRow = el('div', 'row')
    timeRow.appendChild(el('span', 'muted', 'Time'))
    timeRow.appendChild(el('span', 'mono', detailMsg.time))
    const linesRow = el('div', 'row')
    linesRow.appendChild(el('span', 'muted', 'Lines'))
    linesRow.appendChild(el('span', 'mono', String(detailMsg.text.split('\n').length)))
    const charsRow = el('div', 'row')
    charsRow.appendChild(el('span', 'muted', 'Chars'))
    charsRow.appendChild(el('span', 'mono', String(detailMsg.text.length)))
    meta.append(roleRow, idxRow, timeRow, linesRow, charsRow)
    panel.appendChild(meta)
    // dsh-web "copy command": quick re-run for user messages.
    if (detailMsg.role === 'user') {
      const rerun = el('button', 'hbtn', '↻ re-run command')
      rerun.style.cssText = 'align-self:flex-start'
      rerun.onclick = () => {
        chatDraft = detailMsg.text
        activeTab = 'chat'
        rerender()
        setTimeout(() => {
          const hostEl = document.querySelector('#dsh-scholar-ui')
          const rootEl = hostEl !== null ? hostEl.shadowRoot : null
          const ta = rootEl?.querySelector('textarea[placeholder*="research"]') as HTMLTextAreaElement | null
          ta?.focus()
        }, 120)
      }
      panel.appendChild(rerun)
    }
    const rawLabel = el('div', 'section-label', 'Raw text')
    panel.appendChild(rawLabel)
    const pre = el('pre', '')
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;font:10.5px/1.5 ui-monospace,Menlo,monospace;color:var(--text-2);margin:0'
    pre.textContent = detailMsg.text
    panel.appendChild(pre)
    // dsh-web share: copy raw or as markdown.
    const copyRow = el('div', 'row')
    copyRow.style.cssText = 'gap:6px'
    const copyRaw = el('button', 'hbtn', '⧉ copy raw')
    copyRaw.style.cssText = 'padding:0 8px;font-size:9px'
    copyRaw.onclick = () => {
      void navigator.clipboard.writeText(detailMsg.text).then(
        () => { copyRaw.textContent = '✓ copied' },
        () => { copyRaw.textContent = 'copy failed' },
      )
      setTimeout(() => { copyRaw.textContent = '⧉ copy raw' }, 1600)
    }
    copyRow.appendChild(copyRaw)
    const copyMd = el('button', 'hbtn', '⧉ copy md')
    copyMd.title = 'copy as markdown (## heading, - bullet, [link](url))'
    copyMd.style.cssText = 'padding:0 8px;font-size:9px'
    copyMd.onclick = () => {
      const md = textToMarkdown(detailMsg.text)
      void navigator.clipboard.writeText(md).then(
        () => { copyMd.textContent = '✓ copied' },
        () => { copyMd.textContent = 'copy failed' },
      )
      setTimeout(() => { copyMd.textContent = '⧉ copy md' }, 1600)
    }
    copyRow.appendChild(copyMd)
    panel.appendChild(copyRow)
    shell.appendChild(panel)
  }
  shell.appendChild(column)

  // Composer (persists across refreshes via chatDraft) + session actions.
  const composerRow = el('div')
  composerRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:10px'
  // dsh-web quote-reply: pending quote banner above the composer.
  if (chatQuoteTarget !== null) {
    const quoteBanner = el('div')
    quoteBanner.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;background:var(--accent-soft);border:1px solid var(--accent);border-radius:8px;padding:5px 10px;font-size:10.5px;color:var(--text)'
    const qText = el('span', 'grow', `Replying to: ${chatQuoteTarget.text.slice(0, 70)}${chatQuoteTarget.text.length > 70 ? '…' : ''}`)
    quoteBanner.appendChild(qText)
    const cancelQuote = el('button', 'hbtn', '×')
    cancelQuote.style.cssText = 'padding:0 6px'
    cancelQuote.onclick = () => {
      chatQuoteTarget = null
      rerender()
    }
    quoteBanner.appendChild(cancelQuote)
    column.appendChild(quoteBanner)
  }
  const composer = el('div')
  composer.style.cssText = 'flex:1;display:flex;gap:8px'
  // dsh-web composer: a multi-line textarea that auto-grows.
  const input = document.createElement('textarea')
  input.rows = 1
  // dsh-web context: the placeholder shows the active project.
  input.placeholder = `/research status — ${projectId !== '' && projectId !== undefined ? `active: ${projectId.slice(0, 16)}` : 'no project selected'} (Enter sends, Shift+Enter newline)`
  input.setAttribute('aria-label', 'Research command composer')
  input.value = chatDraft
  input.style.cssText = 'flex:1;resize:none;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:9px;padding:8px 11px;font:12px/1.5 ui-monospace,Menlo,monospace;outline:none;min-height:34px;max-height:120px;overflow-y:auto'
  const autosize = (): void => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`
  }
  input.onfocus = () => {
    input.style.borderColor = 'var(--accent)'
    if (input.value.trim().startsWith('/')) renderCompletions(true)
  }
  input.onblur = () => {
    input.style.borderColor = 'var(--border)'
    completionBox.style.display = 'none'
    completionOpen = false
  }
  input.oninput = () => {
    chatDraft = input.value
    autosize()
    renderCompletions()
  }
  // dsh-web "/" command completion: typing "/" (or focusing with "/")
  // opens the command palette under the composer; typing filters it.
  const completionBox = el('div')
  completionBox.style.cssText = 'display:none;flex-direction:column;margin-top:6px;border:1px solid var(--border);border-radius:8px;background:var(--bg-2);overflow:hidden;max-height:40vh;overflow-y:auto'
  let completionOpen = false
  const renderCompletions = (force = false): void => {
    const draft = input.value.trim()
    const match = /^\/(?:research\s+)?([a-z]*)$/i.exec(draft)
    const shouldOpen = (force || completionOpen) && (match !== null || draft.startsWith('/research '))
    if (!shouldOpen) {
      completionBox.style.display = 'none'
      completionOpen = false
      return
    }
    const prefix = (match?.[1] ?? '').toLowerCase()
    // With no prefix show the whole palette; with a prefix filter it.
    const hits = prefix === ''
      ? CHAT_COMMANDS.slice(0, 10)
      : CHAT_COMMANDS.filter(([name]) => name.startsWith(prefix)).slice(0, 10)
    if (hits.length === 0) {
      completionBox.style.display = 'none'
      completionOpen = false
      return
    }
    completionOpen = true
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
  send.setAttribute('aria-label', 'Send command')
  const run = async (): Promise<void> => {
    const line = input.value.trim()
    if (line === '') return
    historyPush(line)
    input.value = ''
    chatDraft = ''
    completionBox.style.display = 'none'
    // dsh-web quote-reply: attach a pending quote to this message.
    const quote = chatQuoteTarget
    chatQuoteTarget = null
    // The session that launched this command (the reply lands back here
    // even if the user switched sessions while it ran).
    const originSessionId = chatActiveId
    chatPush('user', line, quote ?? undefined)
    // dsh-web streaming feel: a "running…" bubble while the command works.
    const runningBubble = el('div')
    runningBubble.style.cssText = 'align-self:flex-start;background:var(--bg-2);border:1px solid var(--border);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;font-size:12px;display:flex;align-items:center;gap:8px'
    const spinner = el('span')
    spinner.textContent = '⏳'
    const runningText = el('span', '', 'running…')
    runningBubble.append(spinner, runningText)
    const streamEl = stream
    streamEl.appendChild(runningBubble)
    streamEl.scrollTop = streamEl.scrollHeight
    try {
      const answer = await executeChatCommand(line, projectId)
      runningBubble.remove()
      // dsh-web streaming feel: reveal the answer progressively in chunks
      // (line-by-line for multi-line answers, word-wise for single lines).
      const answerBubble = el('div')
      answerBubble.style.cssText = 'align-self:flex-start;background:var(--bg-2);border:1px solid var(--border);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;word-break:break-word;font-size:12px;cursor:pointer'
      const lines = answer.split('\n')
      const chunkMs = lines.length > 4 ? 14 : 10
      const reveal = (): void => {
        const done = answerBubble.getAttribute('data-lines') !== null
          ? Number(answerBubble.getAttribute('data-lines')) : 0
        const next = done + 1
        if (next >= lines.length) {
          answerBubble.replaceChildren(...formatChatText(answer))
          // dsh-web session unread: if the user switched sessions while
          // the command ran, the reply lands in the origin session and the
          // current session gets no unread.
          if (originSessionId !== null && originSessionId !== chatActiveId) {
            const origin = chatSessions.find(x => x.id === originSessionId)
            if (origin !== undefined) {
              origin.messages.push({ role: 'assistant' as const, text: answer, time: new Date().toLocaleTimeString() })
              origin.unread = (origin.unread ?? 0) + 1
            }
            chatSessionsPersist()
          } else {
            chatMessages.push({ role: 'assistant' as const, text: answer, time: new Date().toLocaleTimeString() })
            chatPersist()
          }
          rerender()
          showToast(rootHost(), `✓ ${line.slice(0, 40)}${line.length > 40 ? '…' : ''}`)
          return
        }
        answerBubble.replaceChildren(...formatChatText(lines.slice(0, next).join('\n') + '\n'))
        answerBubble.setAttribute('data-lines', String(next))
        streamEl.scrollTop = streamEl.scrollHeight
        setTimeout(reveal, chunkMs)
      }
      streamEl.appendChild(answerBubble)
      reveal()
    } catch (error) {
      runningBubble.remove()
      chatPush('error', `command failed: ${(error as Error).message}`)
      rerender()
      showToast(rootHost(), `✗ command failed`)
    }
  }
  send.onclick = () => { void run() }
  input.onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
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
    } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      // dsh-web composer: Ctrl/Cmd+Enter also sends.
      event.preventDefault()
      void run()
    } else if (event.key === 'Escape') {
      completionBox.style.display = 'none'
    } else if (event.key === 'ArrowUp' && chatHistory.length > 0) {
      // dsh-web shell feel: ↑ always walks the command history.
      event.preventDefault()
      if (historyIndex < 0) historyIndex = chatHistory.length
      historyIndex = Math.max(0, historyIndex - 1)
      input.value = chatHistory[historyIndex] ?? ''
      chatDraft = input.value
      autosize()
      input.setSelectionRange(input.value.length, input.value.length)
    } else if (event.key === 'ArrowDown' && historyIndex >= 0) {
      event.preventDefault()
      historyIndex += 1
      if (historyIndex >= chatHistory.length) {
        historyIndex = -1
        input.value = ''
      } else {
        input.value = chatHistory[historyIndex] ?? ''
      }
      chatDraft = input.value
      autosize()
      input.setSelectionRange(input.value.length, input.value.length)
    } else if (event.key === 'Tab') {
      // dsh-web keyboard navigation: Tab completes the command name.
      const draft = input.value.trim()
      const match = /^\/(?:research\s+)?([a-z]*)$/i.exec(draft)
      if (match !== null) {
        event.preventDefault()
        const prefix = (match[1] ?? '').toLowerCase()
        // 'research' itself is a valid completion (→ /research <sub>).
        if (prefix !== '' && 'research'.startsWith(prefix) && prefix.length < 8) {
          input.value = draft.replace(/[a-z]*$/i, 'research ')
          chatDraft = input.value
          autosize()
        } else {
          const hit = CHAT_COMMANDS.find(([name]) => name.startsWith(prefix))
          if (hit !== undefined && prefix !== hit[0]) {
            input.value = draft.replace(/[a-z]*$/i, hit[0] + ' ')
            chatDraft = input.value
            autosize()
          }
        }
      }
    }
  }
  composer.append(input, send)
  // dsh-web "session actions": clear this conversation.
  const clear = el('button', 'hbtn', '🗑')
  clear.title = 'clear conversation'
  clear.setAttribute('aria-label', 'Clear conversation')
  clear.onclick = () => {
    chatClear()
    rerender()
  }
  composerRow.append(composer, clear)
  column.appendChild(composerRow)
  // dsh-web composer toolbar: markdown quick-inserts at the cursor.
  const toolbar = el('div')
  toolbar.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:6px'
  const mkBtn = (label: string, title: string): HTMLButtonElement => {
    const b = el('button', 'hbtn', label)
    b.title = title
    b.style.cssText = 'padding:1px 8px;font-size:10px'
    return b
  }
  const insertMarkdown = (before: string, after: string, placeholder: string): void => {
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    const selected = input.value.slice(start, end) || placeholder
    input.value = input.value.slice(0, start) + before + selected + after + input.value.slice(end)
    chatDraft = input.value
    input.focus()
    input.setSelectionRange(start + before.length, start + before.length + selected.length)
    autosize()
  }
  const boldBtn = mkBtn('**B**', 'bold: wrap the selection in **…**')
  boldBtn.onclick = () => insertMarkdown('**', '**', 'text')
  const codeBtn = mkBtn('`<>`', 'inline code: wrap the selection in `…`')
  codeBtn.onclick = () => insertMarkdown('`', '`', 'code')
  const linkBtn = mkBtn('🔗', 'link: insert [text](url)')
  linkBtn.onclick = () => insertMarkdown('[', '](https://)', 'text')
  const listBtn = mkBtn('•', 'bullet list item')
  listBtn.onclick = () => insertMarkdown('\n- ', '', 'item')
  toolbar.append(boldBtn, codeBtn, linkBtn, listBtn)
  column.appendChild(toolbar)
  column.appendChild(completionBox)

  body.appendChild(shell)
}

/** Convert a chat answer back to markdown source (dsh-web copy-as-md). */
function textToMarkdown(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^```/.test(line) || /^#{1,3}\s/.test(line) || /^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      out.push(line)
      continue
    }
    if (/^\|/.test(line)) {
      const cells = line.split('|').map(c => c.trim()).filter((c, i, arr) => !(i === 0 && c === '') && !(i === arr.length - 1 && c === ''))
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue
      out.push(`| ${cells.join(' | ')} |`)
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/** Structured chat field cell (status/survey cards). */
function chatFieldCell(label: string, value: string): HTMLElement {
  const c = el('div')
  c.style.cssText = 'background:var(--bg-3);border:1px solid var(--border);border-radius:8px;padding:6px 9px'
  const l = el('div', 'muted', label)
  l.style.cssText = 'font-size:9px;text-transform:uppercase;letter-spacing:.5px'
  const v = el('div', 'mono', value)
  v.style.cssText = 'font-size:11px;color:var(--text);margin-top:2px;word-break:break-word'
  c.append(l, v)
  return c
}

/**
 * Rich line rendering for chat bubbles: ## headings, - bullets, ``` code
 * fences, **bold** and `code` spans — all built with textContent-only
 * nodes (design §15.4).
 */
function formatChatText(text: string, highlight?: string): HTMLElement[] {
  const nodes: HTMLElement[] = []
  const lines = text.split('\n')
  let inFence = false
  let fence: HTMLElement | null = null
  let fenceText = ''
  /** Copy the current fence's code content (text nodes only). */
  const fenceCodeText = (): string => fenceText
  const flushFence = (): void => {
    if (fence !== null) {
      nodes.push(fence)
      fence = null
    }
    fenceText = ''
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
        fence.style.cssText = 'position:relative;background:var(--bg-3);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font:10.5px/1.5 ui-monospace,Menlo,monospace;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:4px 0'
        const lang = line.slice(3).trim()
        if (lang !== '') {
          const head = el('div')
          head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px'
          const langTag = el('span', 'artifact-kind', lang.toUpperCase())
          const copyCode = el('button', 'hbtn', '⧉ copy')
          copyCode.style.cssText = 'padding:0 6px;font-size:9px'
          copyCode.onclick = () => {
            void navigator.clipboard.writeText(fenceCodeText()).then(
              () => { copyCode.textContent = '✓' },
              () => { copyCode.textContent = '✗' },
            )
            setTimeout(() => { copyCode.textContent = '⧉ copy' }, 1600)
          }
          head.append(langTag, copyCode)
          fence.appendChild(head)
        }
      }
      continue
    }
    if (inFence && fence !== null) {
      fence.appendChild(document.createTextNode(line + '\n'))
      fenceText += line + '\n'
      continue
    }
    if (/^#{1,3}\s/.test(line)) {
      const h = el('div')
      h.style.cssText = `font:700 ${line.startsWith('###') ? 11.5 : 12.5}px/1.4 system-ui,sans-serif;color:var(--text);margin:6px 0 3px`
      h.append(...inlineChatText(line.replace(/^#{1,3}\s+/, ''), highlight))
      nodes.push(h)
      continue
    }
    if (/^[-*•]\s+/.test(line)) {
      const row = el('div')
      row.style.cssText = 'display:flex;gap:7px;padding:1px 0'
      row.appendChild(el('span', '', '•'))
      const content = el('span', '', '')
      content.append(...inlineChatText(line.replace(/^[-*•]\s+/, ''), highlight))
      row.appendChild(content)
      nodes.push(row)
      continue
    }
    // dsh-web markdown tables: consecutive lines starting with '|'.
    if (/^\|/.test(line)) {
      const table = nodes.find(n => n.classList.contains('chat-table')) as HTMLElement | undefined
      const cells = line.split('|').map(c => c.trim()).filter((c, i, arr) => !(i === 0 && c === '') && !(i === arr.length - 1 && c === ''))
      // Skip the |---| separator row.
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue
      let tbody: HTMLElement
      if (table === undefined) {
        const tbl = el('table', 'chat-table')
        tbl.style.cssText = 'border-collapse:collapse;margin:4px 0;font-size:10.5px;width:100%'
        tbody = el('tbody')
        tbl.appendChild(tbody)
        nodes.push(tbl)
      } else {
        tbody = table.querySelector('tbody') as HTMLElement
      }
      const tr = el('tr')
      tr.style.cssText = 'border-bottom:1px solid var(--border-2)'
      for (const cell of cells) {
        const td = el('td', '', '')
        td.style.cssText = 'padding:2px 8px;border-left:1px solid var(--border-2);vertical-align:top'
        td.append(...inlineChatText(cell, highlight))
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
      continue
    }
    if (/^\d+\.\s+/.test(line)) {
      const row = el('div')
      row.style.cssText = 'display:flex;gap:7px;padding:1px 0'
      row.appendChild(el('span', '', line.match(/^\d+\./)?.[0] ?? '•'))
      const content = el('span', '', '')
      content.append(...inlineChatText(line.replace(/^\d+\.\s+/, ''), highlight))
      row.appendChild(content)
      nodes.push(row)
      continue
    }
    if (line.trim() === '') {
      nodes.push(el('div', '', '\u00a0'))
      continue
    }
    nodes.push(el('div', '', ...inlineChatText(line, highlight)))
  }
  flushFence()
  return nodes
}

/** Inline **bold** + `code` spans (shared by every line kind). */
function inlineChatText(text: string, highlight?: string): HTMLElement[] {
  const nodes: HTMLElement[] = []
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g)
  for (const part of parts) {
    if (part === '') continue
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link !== null) {
      // dsh-web markdown links: [label](url) -> safe anchor (target=_blank,
      // rel noopener; scheme allowlist http/https).
      const url = link[2] ?? ''
      if (/^https?:\/\//i.test(url)) {
        const a = el('a', '', link[1] ?? url)
        a.href = url
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        a.style.cssText = 'color:var(--accent);text-decoration:underline'
        nodes.push(a)
      } else {
        nodes.push(el('span', '', `${link[1] ?? ''} (${url})`))
      }
      continue
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      nodes.push(el('strong', '', part.slice(2, -2)))
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const code = el('code', '', part.slice(1, -1))
      code.style.cssText = 'background:var(--bg-3);border:1px solid var(--border);border-radius:4px;padding:0 4px;font:10.5px/1.4 ui-monospace,Menlo,monospace'
      nodes.push(code)
    } else if (highlight !== undefined && highlight !== '' && part.toLowerCase().includes(highlight)) {
      // dsh-web search feel: highlight every occurrence of the query.
      const low = part.toLowerCase()
      let cursor = 0
      let idx = low.indexOf(highlight)
      while (idx >= 0) {
        if (idx > cursor) nodes.push(el('span', '', part.slice(cursor, idx)))
        const mark = el('mark', '', part.slice(idx, idx + highlight.length))
        mark.style.cssText = 'background:var(--tone-amber);color:var(--text);border-radius:3px;padding:0 2px'
        nodes.push(mark)
        cursor = idx + highlight.length
        idx = low.indexOf(highlight, cursor)
      }
      if (cursor < part.length) nodes.push(el('span', '', part.slice(cursor)))
    } else {
      nodes.push(el('span', '', part))
    }
  }
  return nodes
}
