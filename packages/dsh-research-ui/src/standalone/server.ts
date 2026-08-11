/**
 * DSH Scholar — standalone web application server.
 *
 * Serves the Research OS UI at its own origin, completely independent of
 * the `dsh web` host: it spawns (or reuses) the Research Kernel sidecar,
 * serves the built client bundle plus a minimal bootstrap page, proxies
 * `/v1/*` to the kernel and protects every state-changing call with a
 * loopback bearer token (design §15.2/§15.3).
 *
 * Usage:
 *   node lib/standalone/server.js [--port 18610] [--kernel-port 17413]
 *     [--data-dir <dir>] [--token <secret>] [--host 127.0.0.1]
 *
 * On first start a token is generated and persisted under the data dir
 * (`standalone-token`); the browser asks for it once and keeps it
 * in localStorage. Token mode can be disabled with `--no-token` (loopback
 * only, not recommended).
 * @module @dsh-scholar/research-ui/standalone
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { UiKernelSidecar } from './sidecar.js'
import { validateConfig, parseCli, generateCliHelp } from '@dsh-scholar/research-schemas'
import {
  MAX_BODY_BYTES,
  SlidingWindowRateLimiter,
  constantTimeEqual,
  createCsrfToken,
  isAllowedOrigin,
  isLoopbackHost,
  verifyCsrfToken,
  withinBodyLimit,
} from './security.js'
import { multiSourceSearch } from '@dsh-scholar/scholar-connectors'

const DEFAULT_PORT = 18610
const DEFAULT_KERNEL_PORT = 17413

/**
 * GOV-01/ONBOARD-01 (hardening §5 P1): explicit capability ROUTE TABLE for
 * PI-only writes, matched against the RAW pathname (segment-anchored, no
 * query params — the previous substring regex, made explicit). Governance
 * writes: transitions, gates, decisions, budget, approve, accept (existing)
 * PLUS intake ADOPT (POST /v1/projects/{id}/intake/{iid}/adopt — the PI
 * decision that converts a proposal into project state) and project
 * archive/unarchive. researcher/viewer/auditor → 403 role forbidden;
 * pi/operator are the only permitted roles. The same table is shared with
 * the kernel (research-kernel server.ts isPiOnlyWrite) so the two layers
 * can never drift apart.
 */
const PI_ONLY_WRITE_ROUTES: ReadonlyArray<RegExp> = [
  /(?:^|\/)transitions(?:\/|$)/,
  /(?:^|\/)gates(?:\/|$)/,
  /(?:^|\/)decisions(?:\/|$)/,
  /(?:^|\/)budget(?:\/|$)/,
  /(?:^|\/)approve(?:\/|$)/,
  /(?:^|\/)accept(?:\/|$)/,
  /(?:^|\/)intake\/[^/]+\/adopt(?:\/|$)/,
  /(?:^|\/)archive(?:\/|$)/,
  /(?:^|\/)unarchive(?:\/|$)/,
]

function isPiOnlyWrite(pathname: string): boolean {
  return PI_ONLY_WRITE_ROUTES.some(re => re.test(pathname))
}

function isProjectDelete(method: string, pathname: string): boolean {
  return method === 'DELETE' && /^\/v(?:1|2)\/projects\/[^/]+\/?$/.test(pathname)
}

/** The subset of PI-only routes the KERNEL re-enforces from its own
 * project_members table (defense in depth): the BFF injects its
 * server-derived x-principal-id/x-principal-role on these forwards so the
 * kernel second layer can resolve the acting principal's role itself. */
const KERNEL_PI_ONLY_FORWARD_ROUTES: ReadonlyArray<RegExp> = [
  /(?:^|\/)intake\/[^/]+\/adopt(?:\/|$)/,
  /(?:^|\/)archive(?:\/|$)/,
  /(?:^|\/)unarchive(?:\/|$)/,
]

function isKernelPiOnlyForward(pathname: string): boolean {
  return KERNEL_PI_ONLY_FORWARD_ROUTES.some(re => re.test(pathname))
}

/** The v1 SSE real-time stream routes (api-contracts.md §22) that sit under
 * a PATH project and demand the authenticated principal at the kernel
 * (requireProjectMember fail-closed): the BFF injects its server-derived
 * operator identity on these forwards exactly like /v1/topology. The pty
 * frames stream (/v1/pty/sessions/{id}/frames/stream) is already covered
 * by the /v1/pty/sessions prefix rule below. */
const SSE_STREAM_FORWARD_ROUTES: ReadonlyArray<RegExp> = [
  /^\/v1\/projects\/[^/]+\/workspaces\/[^/]+\/watch\/stream$/,
  /^\/v1\/projects\/[^/]+\/trajectory\/stream$/,
]

function isSseStreamForward(pathname: string): boolean {
  return SSE_STREAM_FORWARD_ROUTES.some(re => re.test(pathname))
}

/** Models this Scholar surface may route the research agent onto. Mirrors the
 * DSH harness advisory catalog (llm-deepseek): ''/auto = agent default. */
const MODEL_CATALOG = ['deepseek-v4-flash', 'deepseek-v4-pro']

const MODEL_FILE = 'model.json'

/** Current model preference ('' = agent default / no override). */
function readModelPreference(dataDir: string): string {
  try {
    const raw = readFileSync(join(dataDir, MODEL_FILE), 'utf8')
    const parsed = JSON.parse(raw) as { model?: unknown }
    return typeof parsed.model === 'string' ? parsed.model : ''
  } catch {
    return ''
  }
}

/** Persist the model preference (0600, never logged). */
function writeModelPreference(dataDir: string, model: string): void {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, MODEL_FILE)
  writeFileSync(file, JSON.stringify({ model, updated_at: new Date().toISOString() }, null, 2), { mode: 0o600 })
  chmodSync(file, 0o600)
}

const SESSION_FILE = 'session.json'

export interface OperatorSession {
  session_id: string
  principal_id: string
  tenant_id: string | null
  auth_method: 'dsh-session'
  created_at: string
  updated_at: string
}

/**
 * GOV-01 principal resolver (local scope): derive the operator's DURABLE
 * session identity from the loopback bearer credential. The session id is
 * deterministic (sha256 of principal + a per-data-dir secret), persisted
 * 0600 under the data dir, and stable across standalone restarts — the
 * "Session link 在重启后恢复" property. An external IdP can replace this
 * resolver later; the durable principal/tenant/auth_method/session shape is
 * the contract the kernel already persists on decisions.
 */
export function operatorSession(dataDir: string, principalId: string): OperatorSession {
  const file = join(dataDir, SESSION_FILE)
  const now = new Date().toISOString()
  const existing = ((): OperatorSession | null => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<OperatorSession>
      if (typeof parsed.session_id === 'string' && typeof parsed.principal_id === 'string') {
        return { session_id: parsed.session_id, principal_id: parsed.principal_id, tenant_id: null, auth_method: 'dsh-session', created_at: parsed.created_at ?? now, updated_at: parsed.updated_at ?? now }
      }
    } catch { /* absent or malformed — recreate */ }
    return null
  })()
  if (existing !== null && existing.principal_id === principalId) {
    return existing
  }
  const session: OperatorSession = {
    session_id: `sess_${createHash('sha256').update(`${principalId}:${dataDir}`).digest('hex').slice(0, 16)}`,
    principal_id: principalId,
    tenant_id: null,
    auth_method: 'dsh-session',
    created_at: now,
    updated_at: now,
  }
  try {
    mkdirSync(dataDir, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  } catch { /* read-only data dir — session still derived deterministically */ }
  return session
}

interface StandaloneOptions {
  host: string
  port: number
  kernelPort: number
  dataDir: string
  token: string | null
  /** API-01: loopback operator identity. When set, the BFF enforces project
   * membership on project-scoped /v1 routes (non-member -> 404). */
  principal: string | null
}

/** Constant-time token comparison (values never appear in logs). */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  return constantTimeEqual(provided, expected)
}

/**
 * API-01/GOV-01 (hardening §4 P0): JSON write bodies are normalized so the
 * kernel only ever records the SESSION-derived operator principal. Identity
 * fields the client supplies are overwritten with the BFF-resolved identity
 * or removed — a client can never claim another creator, actor, tenant or
 * session. `principal_id` is deliberately NOT in the set: project member
 * routes legitimately add OTHER principals (e.g. POST /v1/projects/{id}/members).
 * Applied to POST/PATCH/PUT bodies only; non-JSON bodies pass through untouched.
 */
function normalizeIdentityBody(raw: string, principalId: string, sessionId: string, seedCreator: boolean): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return raw
  const body = parsed as Record<string, unknown>
  let changed = false
  if ('creator_principal_id' in body) {
    body.creator_principal_id = principalId
    changed = true
  }
  if ('creator_tenant_id' in body) {
    // The tenant comes from the session only (operatorSession tenant_id is
    // null) — a client-forged tenant is dropped, never forwarded.
    delete body.creator_tenant_id
    changed = true
  }
  if ('actor' in body) {
    body.actor = principalId
    changed = true
  }
  if ('principal' in body) {
    // Full session-derived principal; the client's claimed tenant_id,
    // auth_method and session_id are never forwarded. tenant_id is '' on
    // the wire (kernel decisionSchema requires a string; operatorSession
    // keeps tenant_id null — an empty tenant is the session truth).
    body.principal = { principal_id: principalId, tenant_id: '', auth_method: 'dsh-session', session_id: sessionId }
    changed = true
  }
  if ('session_id' in body) {
    // A forged session is dropped; the kernel binds the BFF-forwarded
    // x-principal-session instead (server.ts GOV-01 resolver).
    delete body.session_id
    changed = true
  }
  if (seedCreator && !('creator_principal_id' in body)) {
    // Project create: the BFF seeds the creator PI membership from the
    // authenticated session even when the client omits the field.
    body.creator_principal_id = principalId
    changed = true
  }
  return changed ? JSON.stringify(body) : raw
}

function secureExistingTokenFile(tokenFile: string): void {
  const stat = lstatSync(tokenFile)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('standalone token path must be a regular file')
  }
  chmodSync(tokenFile, 0o600)
}

function readBody(req: IncomingMessage): Promise<{ body: string; tooLarge: boolean }> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const done = (value: { body: string; tooLarge: boolean }): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (!withinBodyLimit(total)) {
        done({ body: '', tooLarge: true })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done({ body: Buffer.concat(chunks).toString('utf8'), tooLarge: false }))
    req.on('error', () => done({ body: '', tooLarge: false }))
    req.on('close', () => done({ body: '', tooLarge: false }))
  })
}

/**
 * UPLOAD-01: raw-bytes body reader for multipart passthrough — a string
 * conversion would corrupt binary file content. `limit` is the kernel's
 * upload body cap (32 MiB file + bounded multipart envelope overhead), so
 * the BFF rejects oversized uploads with 413 before forwarding; the kernel
 * enforces the same cap again (defense in depth).
 */
function readBodyBytes(req: IncomingMessage, limit: number): Promise<{ buffer: Buffer; tooLarge: boolean }> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const done = (value: { buffer: Buffer; tooLarge: boolean }): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return // past the cap: keep draining (bounded memory) so
      // the client can still read our 413 response — destroying the socket
      // here would surface as a client-side connection error instead.
      total += chunk.length
      if (!withinBodyLimit(total, limit)) {
        done({ buffer: Buffer.alloc(0), tooLarge: true })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done({ buffer: Buffer.concat(chunks), tooLarge: false }))
    req.on('error', () => done({ buffer: Buffer.alloc(0), tooLarge: false }))
    req.on('close', () => done({ buffer: Buffer.alloc(0), tooLarge: false }))
  })
}

/**
 * UPLOAD-01: multipart uploads are capped at the kernel's 32 MiB file limit
 * plus a bounded envelope allowance (headers + boundaries) — same budget as
 * the kernel's uploads.ts UPLOAD_MAX_BODY_BYTES.
 */
const UPLOAD_MAX_BODY_BYTES = (32 + 1) * 1024 * 1024

/** JSON error responses never carry internal paths/env (design §15.2). */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

/**
 * BFF-native error body (api-contracts.md §2 envelope): stable machine
 * `code` + safe English `message`, `ok:false` at the surface. Kernel-proxied
 * responses keep their own wire envelope (`{error:{code,message,...}}` per
 * reconstruction-contracts.md) — the BFF never rewrites upstream bodies.
 * Message texts are preserved so surface consumers (and the security test
 * suite's substring assertions) see the same copy as before.
 */
export function bffError(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } }
}

const BOOTSTRAP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title data-i18n="standalone.pageTitle">Research OS — DSH Scholar</title>
<script>
  // Unlock-page locale (gui-plugin-plan §13.4 / acceptance §8): pick BEFORE
  // first paint, same choice order as the client adapter: persisted
  // dsh.locale → navigator.languages → navigator.language → zh.
  (function () {
    var LOCALE_KEY = 'dsh.locale';
    function pickLocale() {
      try {
        var saved = localStorage.getItem(LOCALE_KEY);
        if (saved === 'zh' || saved === 'en') return saved;
      } catch (e) {}
      var candidates = [];
      if (typeof navigator !== 'undefined') {
        if (Array.isArray(navigator.languages)) candidates = candidates.concat(navigator.languages);
        if (typeof navigator.language === 'string' && navigator.language !== '') candidates.push(navigator.language);
      }
      for (var i = 0; i < candidates.length; i++) {
        var base = String(candidates[i]).toLowerCase().split('-')[0] || '';
        if (base === 'zh') return 'zh';
        if (base === 'en') return 'en';
      }
      return 'zh';
    }
    window.__BOOT_LOCALE__ = pickLocale();
    document.documentElement.lang = window.__BOOT_LOCALE__;
    // Inline zh/en dictionaries for the token gate (server-rendered page).
    // Keys mirror the client standalone namespace (i18n/locales/standalone.ts)
    // so the unlock page and the locale dictionaries stay in lockstep.
    var ZH = {
      'standalone.pageTitle': '研究 OS — DSH Scholar',
      'standalone.brand.name': '研究',
      'standalone.brand.meta': '工作区',
      'standalone.operatorAccess': '操作员访问',
      'standalone.welcomeBack': '欢迎回来。',
      'standalone.intro': '打开你的证据工作区。人类门控决策将记录你的操作员身份。',
      'standalone.accessToken': '访问令牌',
      'standalone.openWorkspace': '打开工作区',
      'standalone.invalidToken': '令牌无效',
      'standalone.serverUnreachable': '服务器不可达',
      'standalone.bundleFailed': '客户端加载失败',
      'standalone.tokenHint': '你的令牌在本地服务器启动时生成,只保留在本机。',
      'standalone.theme.dark': '深色',
      'standalone.theme.light': '浅色',
    };
    var EN = {
      'standalone.pageTitle': 'Research OS — DSH Scholar',
      'standalone.brand.name': 'Research',
      'standalone.brand.meta': 'Workspace',
      'standalone.operatorAccess': 'Operator access',
      'standalone.welcomeBack': 'Welcome back.',
      'standalone.intro': 'Open your evidence workspace. Human gate decisions are recorded with your operator identity.',
      'standalone.accessToken': 'Access token',
      'standalone.openWorkspace': 'Open workspace',
      'standalone.invalidToken': 'Invalid token',
      'standalone.serverUnreachable': 'Server unreachable',
      'standalone.bundleFailed': 'Client bundle failed to load',
      'standalone.tokenHint': 'Your token is generated when the local server starts and remains on this machine.',
      'standalone.theme.dark': 'Dark',
      'standalone.theme.light': 'Light',
    };
    var DICT = window.__BOOT_LOCALE__ === 'zh' ? ZH : EN;
    window.__BOOT_DICT__ = DICT;
    window.__BOOT_MSG__ = function (key) { return DICT[key] || key; };
    // The swap needs the body; run now if present, else on first paint.
    function applyI18n() {
      document.querySelectorAll('[data-i18n]').forEach(function (n) {
        var key = n.getAttribute('data-i18n');
        if (key && DICT[key]) n.textContent = DICT[key];
      });
      var ph = document.getElementById('token-input');
      if (ph) ph.placeholder = DICT['standalone.accessToken'];
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', applyI18n);
    } else {
      applyI18n();
    }
  })();
</script>
<style>
  :root { color-scheme: light; --bg:#ffffff; --surface:#ffffff; --border:rgba(0,0,0,.10); --text:#0f1115; --muted:#61666b; --faint:#81858c; --accent:#4176e6; --accent-soft:#edf3fe; }
  :root[data-theme="dark"] { color-scheme: dark; }
  :root[data-theme="dark"] { --bg:#151517; --surface:#232324; --border:rgba(255,255,255,.12); --text:#f9fafb; --muted:#cfd3d6; --faint:#adb2b8; --accent:#679efe; --accent-soft:#34415b; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; overflow:hidden; background:var(--bg); color:var(--text); font:14px/22px -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif; }
  #boot-screen { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; padding:24px; z-index:9998; }
  .card { position:relative; width:min(380px,100%); overflow:hidden; padding:24px; background:var(--surface); border:1px solid var(--border); border-radius:24px; box-shadow:0 0 1px rgba(0,0,0,.2),0 0 4px rgba(0,0,0,.02),0 12px 32px rgba(0,0,0,.08); }
  .brand { display:flex; align-items:baseline; gap:8px; margin-bottom:28px; }
  .brand-mark { color:var(--text); font:700 19px/22px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:-.06em; }
  .brand-name { color:var(--text); font:500 14px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .brand-meta { margin-top:0; color:var(--faint); font:400 12px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .eyebrow { margin-bottom:8px; color:var(--accent); font:500 13px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .card h1 { margin:0 0 8px; color:var(--text); font:500 26px/32px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; letter-spacing:0; }
  .card p { margin:0 0 24px; color:var(--muted); font-size:14px; line-height:22px; }
  .field-label { display:block; margin:0 0 7px; color:var(--text); font:500 13px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .card input { width:100%; height:44px; background:transparent; color:var(--text); border:1px solid var(--border); border-radius:22px; padding:7px 14px; font:400 14px/22px 'SF Mono','JetBrains Mono','Fira Code',Consolas,'Liberation Mono',Menlo,Courier,sans-serif; outline:none; margin-bottom:10px; box-shadow:none; }
  .card input:focus { border-color:var(--border); box-shadow:none; }
  .card button { width:100%; min-height:40px; background:var(--accent); color:#fff; border:0; border-radius:20px; padding:9px 14px; font:500 14px/22px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; cursor:pointer; box-shadow:none; transition:background-color .1s cubic-bezier(.4,0,.2,1),opacity .1s cubic-bezier(.4,0,.2,1); }
  .card button:hover { filter:brightness(1.08); transform:none; }
  .card button:active { transform:none; }
  .err { color:#dc2626; font-size:11px; margin-top:10px; min-height:16px; }
  :root[data-theme="dark"] .err { color:#f87171; }
  .hint { display:flex; align-items:flex-start; gap:8px; margin-top:16px; padding-top:16px; border-top:1px solid var(--border); color:var(--faint); font-size:10.5px; }
  .hint-dot { width:7px; height:7px; flex:0 0 auto; margin-top:5px; border-radius:50%; background:#22c55e; box-shadow:none; }
  .theme-toggle { position:fixed; top:18px; right:20px; z-index:9999; min-height:32px; background:transparent; color:var(--muted); border:0; border-radius:8px; padding:5px 10px; cursor:pointer; font:500 12px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .theme-toggle:hover { color:var(--text); }
  @media (max-width:520px) { .card { padding:28px 22px; border-radius:20px; } .card h1 { font-size:26px; } .theme-toggle { top:10px; right:10px; } }
</style>
</head>
<body>
<button id="theme-toggle" class="theme-toggle">Dark</button>
<div id="boot-screen">
  <div class="card">
    <div class="brand"><span class="brand-mark">dsh</span><span class="brand-name" data-i18n="standalone.brand.name">Research</span><span class="brand-meta" data-i18n="standalone.brand.meta">Workspace</span></div>
    <div class="eyebrow" data-i18n="standalone.operatorAccess">Operator access</div>
    <h1 data-i18n="standalone.welcomeBack">Welcome back.</h1>
    <p data-i18n="standalone.intro">Open your evidence workspace. Human gate decisions are recorded with your operator identity.</p>
    <label class="field-label" for="token-input" data-i18n="standalone.accessToken">Access token</label>
    <input id="token-input" type="password" placeholder="Access token" autocomplete="off">
    <button id="token-submit" data-i18n="standalone.openWorkspace">Open workspace</button>
    <div class="err" id="token-err"></div>
    <div class="hint"><span class="hint-dot"></span><span data-i18n="standalone.tokenHint">Your token is generated when the local server starts and remains on this machine.</span></div>
  </div>
</div>
<script>
  // The client bundle registers through a small classic-script handoff.
  window.__ModuleLoader__ = {
    load: function (mod) {
      window.__DSH_SCHOLAR_UI__ = mod.factory(function (specifier) {
        throw new Error('standalone bundle has no dependencies: ' + specifier);
      });
    },
  };
</script>
<script src="/client.js"></script>
<script>
  (function () {
    var THEME_KEY = 'dsh-scholar-ui-theme';
    var TOKEN_KEY = 'dsh-scholar-ui-token';
    var root = document.documentElement;
    var toggle = document.getElementById('theme-toggle');
    function readTheme() { try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } }
    function paintTheme() {
      var dark = readTheme() === 'dark';
      root.setAttribute('data-theme', dark ? 'dark' : 'light');
      toggle.textContent = dark ? window.__BOOT_MSG__('standalone.theme.light') : window.__BOOT_MSG__('standalone.theme.dark');
    }
    toggle.addEventListener('click', function () {
      var next = readTheme() === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
      paintTheme();
    });
    paintTheme();
    var boot = document.getElementById('boot-screen');
    var input = document.getElementById('token-input');
    var err = document.getElementById('token-err');
    var submit = document.getElementById('token-submit');
    var saved = null;
    try { saved = localStorage.getItem(TOKEN_KEY); } catch (e) {}
    function unlock(token) {
      fetch('/api/token-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: token }) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.ok === true) {
            try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
            boot.style.display = 'none';
            startPanel(token);
          } else {
            // Known server error codes map to the localized dictionary;
            // unknown wire text is shown verbatim (acceptance §8 raw text).
            var errKey = j.error === 'invalid token' ? 'standalone.invalidToken' : null;
            err.textContent = errKey !== null ? window.__BOOT_MSG__(errKey) : (j.error || window.__BOOT_MSG__('standalone.invalidToken'));
          }
        })
        .catch(function () { err.textContent = window.__BOOT_MSG__('standalone.serverUnreachable'); });
    }
    function startPanel(token) {
      if (window.__DSH_SCHOLAR_UI__ && window.__DSH_SCHOLAR_UI__.apply) {
        window.__DSH_SCHOLAR_UI__.setStandaloneBridge({
          base: '',
          token: function () { return Promise.resolve(token); },
        });
        window.__DSH_SCHOLAR_UI__.apply();
      } else {
        err.textContent = window.__BOOT_MSG__('standalone.bundleFailed');
        boot.style.display = 'flex';
      }
    }
    if (saved) { unlock(saved); }
    else { boot.style.display = 'flex'; }
    submit.addEventListener('click', function () { unlock(input.value.trim()); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(input.value.trim()); });
    input.focus();
  })();
</script>
</body>
</html>`

export function loadOptions(argv: string[]): StandaloneOptions {
  // CONFIG-01: the standalone CLI surface is parsed by the canonical Config
  // Registry (parseCli) — flags, defaults and validation are the registry's
  // single source of truth; the --no-token loopback floor is enforced here
  // (identical message to the registry's own check in startStandalone) so
  // CLI behavior is unchanged and rejection still happens before listen.
  const values = parseCli(argv, 'standalone')
  const host = (values['standalone.host'] as string | undefined) ?? '127.0.0.1'
  if (values['standalone.no_token'] === true && !isLoopbackHost(host)) {
    throw new Error('--no-token requires an explicit loopback --host (127.0.0.0/8, ::1, or localhost)')
  }
  const dataDir = (values['standalone.data_dir'] as string | undefined) ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh-scholar-standalone'), 'research-ui-standalone')
  let token: string | null = null
  if (values['standalone.no_token'] !== true) {
    const tokenFile = join(dataDir, 'standalone-token')
    const tokenFileExists = existsSync(tokenFile)
    if (tokenFileExists) secureExistingTokenFile(tokenFile)
    const explicitToken = values['standalone.token'] as string | undefined
    if (explicitToken !== undefined && explicitToken !== '') {
      token = explicitToken
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(tokenFile, token, { mode: 0o600, flag: tokenFileExists ? 'w' : 'wx' })
      chmodSync(tokenFile, 0o600)
    } else if (tokenFileExists) {
      token = readFileSync(tokenFile, 'utf8').trim()
      if (token === '') throw new Error('standalone token file must not be empty')
    } else {
      token = `dsh-${randomBytes(18).toString('hex')}`
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' })
      chmodSync(tokenFile, 0o600)
    }
  }
  return {
    host,
    port: (values['standalone.port'] as number | undefined) ?? DEFAULT_PORT,
    kernelPort: (values['standalone.kernel_port'] as number | undefined) ?? DEFAULT_KERNEL_PORT,
    dataDir,
    token,
    principal: ((values['standalone.principal'] as string | undefined) ?? null) as string | null,
  }
}

export async function startStandalone(options: StandaloneOptions): Promise<void> {
  // CONFIG-01: the standalone effective config is validated through the
  // canonical Config Registry BEFORE anything binds — unknown keys, invalid
  // values and security-floor violations fail fast (the registry enforces
  // the --no-token loopback floor for programmatic callers as well; the
  // error message is identical to loadOptions' so CLI behavior is unchanged).
  const resolvedConfig = validateConfig({
    'standalone.host': options.host,
    'standalone.port': options.port,
    'standalone.kernel_port': options.kernelPort,
    'standalone.data_dir': options.dataDir,
    'standalone.token': options.token ?? '',
    'standalone.no_token': options.token === null,
    'standalone.principal': options.principal ?? '',
  }, { scopes: ['standalone'] })
  const configPin = resolvedConfig.pinHash
  console.error(`[standalone] config pin ${configPin} (${options.host}:${options.port}, kernel=${options.kernelPort})`)
  const sidecar = new UiKernelSidecar({
    host: '127.0.0.1',
    port: options.kernelPort,
    dataDir: options.dataDir,
    log: line => console.error(line),
  })
  try {
    await sidecar.start()
  } catch (error) {
    await sidecar.stop()
    throw error
  }
  const endpoint = sidecar.endpoint
  // §4 P0 (API-01/EVID-01): the kernel's internal-route service identity.
  // The BFF is a service process holding the 0600 dataDir token; it attaches
  // x-service-token to upstream kernel calls so internal routes (claim,
  // runner-keys, recover, verified/accept, approve) keep working through the
  // proxy while the browser never sees or supplies the credential.
  const serviceToken = sidecar.serviceToken
  // §5 P0-1 (hardening API-01/SIDE-01): the kernel's PUBLIC bearer token
  // (0600 <dataDir>/kernel-token, same file the sidecar injected into the
  // kernel). EVERY upstream request — proxy and internal lookups alike —
  // carries `Authorization: Bearer <kernelToken>`; the browser never sees
  // or supplies it (the browser authenticates to the BFF with its own token).
  const kernelToken = sidecar.kernelToken
  /** Headers shared by every upstream kernel request: the BFF's own service
   * identity + public bearer. Never forwarded from the client. */
  const upstreamAuthHeaders: Record<string, string> = {
    authorization: `Bearer ${kernelToken}`,
    'x-service-token': serviceToken,
  }

  // The client bundle ships from this package's lib/client.js.
  const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

  const limiter = new SlidingWindowRateLimiter()

  // SEC-UI-01 CSRF: one in-memory session token per process. Every
  // state-changing /api write must echo it in `x-csrf-token`; the Origin
  // check stays as a second layer. Never logged, never persisted.
  const csrfToken = createCsrfToken()
  function csrfHeader(req: IncomingMessage): string | undefined {
    const value = req.headers['x-csrf-token']
    return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
  }

  // API-01 BFF AuthZ: the loopback operator identity maps to one principal
  // (reconstruction-contracts.md §7 "standalone local identity 仅在 loopback
  // 映射为单一 pi"). Project-scoped routes first resolve membership via the
  // kernel's authoritative project_members table; missing project AND
  // insufficient membership both answer 404 (no enumeration, api-contracts §1).
  // GOV-01/P0-2 (hardening §5): membership is queried FRESH on every request —
  // no Promise/result cache (a revoked member must lose access on the very
  // next request; acceptance-tests.md §21 membership-revocation-no-stale-cache).
  async function projectMembers(projectId: string): Promise<Array<{ principal_id: string; role: string }> | null> {
    return fetch(`${endpoint}/v1/projects/${encodeURIComponent(projectId)}/members`, {
      headers: { accept: 'application/json', ...upstreamAuthHeaders },
    }).then(async (r) => {
      if (!r.ok) return null
      return (await r.json()) as Array<{ principal_id: string; role: string }>
    }).catch(() => null)
  }
  async function isProjectMember(projectId: string): Promise<boolean> {
    if (options.principal === null) return true
    const members = await projectMembers(projectId)
    if (members === null) return false
    return members.some(m => m.principal_id === options.principal)
  }
  /** API-01: the loopback operator's role in a project, or null (not a
   * member / lookup failed). Feeds the role capability layer and the
   * x-principal-role header injected for kernel v2. */
  async function projectRole(projectId: string): Promise<string | null> {
    if (options.principal === null) return null
    const members = await projectMembers(projectId)
    if (members === null) return null
    return members.find(m => m.principal_id === options.principal)?.role ?? null
  }
  // Job-scoped routes (/v1/jobs/:id/*, e.g. the terminal SSE) resolve the
  // job's project through the kernel first — the BFF checks membership
  // BEFORE streaming (api-contracts.md §9: job_log_read + membership).
  const jobProjectCache = new Map<string, Promise<string | null>>()
  async function jobProjectId(jobId: string): Promise<string | null> {
    const key = `j:${jobId}`
    let hit = jobProjectCache.get(key)
    if (hit === undefined) {
      hit = fetch(`${endpoint}/v1/jobs/${encodeURIComponent(jobId)}`, {
        headers: { accept: 'application/json', ...upstreamAuthHeaders },
      }).then(async (r) => {
        if (!r.ok) return null
        const j = await r.json() as { project_id?: string }
        return typeof j.project_id === 'string' ? j.project_id : null
      }).catch(() => null)
      jobProjectCache.set(key, hit)
    }
    return hit
  }
  function jobIdFromPath(pathname: string): string | null {
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts.length >= 3 && parts[0] === 'v1' && parts[1] === 'jobs') return parts[2] ?? null
    return null
  }
  // SUBAGENT-01 (trajectory-subagents.md §7): child-scoped topology routes
  // (/v1/topology/{child_id}*) resolve the child's project through the
  // kernel first — the BFF checks membership BEFORE forwarding, mirroring
  // the job-scoped rule (trajectory/topology reads require project
  // membership; unknown child AND non-member are the same 404).
  const childProjectCache = new Map<string, Promise<string | null>>()
  async function childProjectId(childId: string): Promise<string | null> {
    const key = `c:${childId}`
    let hit = childProjectCache.get(key)
    if (hit === undefined) {
      hit = fetch(`${endpoint}/v1/topology/${encodeURIComponent(childId)}`, {
        headers: { accept: 'application/json', ...upstreamAuthHeaders, ...options.principal !== null ? { 'x-principal-id': options.principal } : {} },
      }).then(async (r) => {
        if (!r.ok) return null
        const detail = await r.json() as { project_id?: string }
        return typeof detail.project_id === 'string' ? detail.project_id : null
      }).catch(() => null)
      childProjectCache.set(key, hit)
    }
    return hit
  }
  function childIdFromPath(pathname: string): string | null {
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts.length >= 3 && parts[0] === 'v1' && parts[1] === 'topology') return parts[2] ?? null
    return null
  }
  function projectIdFromPath(pathname: string): string | null {
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
    // Only /v1|v2/projects/{id} carries a PROJECT id in this position — gate
    // ids and job ids are resolved through the kernel (see gateProjectId
    // below), never misread as projects.
    if (parts.length >= 3 && (parts[0] === 'v1' || parts[0] === 'v2') && parts[1] === 'projects') return parts[2] ?? null
    return null
  }
  // API-01/PTY-01 (hardening §5 P0-2): global-id routes — Artifact,
  // Document/TeX, PTY session and global events carry a resource id (or a
  // query project) instead of a path project. Each class resolves the
  // OWNING project through the kernel BEFORE forwarding (one authoritative
  // resolver per class); unknown ids, resolution failures and foreign
  // projects all answer 404 at the BFF (no enumeration, fail-closed) and
  // the kernel re-validates the actual read/write. Resolution results are
  // NOT cached: the resource→project mapping is immutable, but keeping the
  // round-trip per request keeps revocation semantics identical to the
  // uncached membership lookup above (simple, authoritative).
  /** Artifact: /v1/artifacts/{id} (GET/HEAD). Prefers an explicit
   * ?project_id= (kernel project-scoped lookup, membership checked here);
   * otherwise HEAD the kernel route and read the authoritative
   * x-project-id response header (no body bytes are transferred). A 409
   * ambiguous blob (multiple projects, no query) resolves to null → 404. */
  async function artifactProjectId(artifactId: string, projectQuery: string | null): Promise<string | null> {
    if (projectQuery !== null && projectQuery !== '') return projectQuery
    return fetch(`${endpoint}/v1/artifacts/${encodeURIComponent(artifactId)}`, {
      method: 'HEAD',
      headers: { accept: 'application/json', ...upstreamAuthHeaders },
    }).then(async (r) => {
      if (!r.ok) return null
      const header = r.headers.get('x-project-id')
      return typeof header === 'string' && header !== '' ? header : null
    }).catch(() => null)
  }
  /** Document/TeX: /v1/documents/{id}/* resolves via the kernel's own
   * document projection (GET …/tree → document.project_id). Unknown or
   * malformed document ids resolve to null → 404. */
  async function documentProjectId(documentId: string): Promise<string | null> {
    return fetch(`${endpoint}/v1/documents/${encodeURIComponent(documentId)}/tree`, {
      headers: { accept: 'application/json', ...upstreamAuthHeaders },
    }).then(async (r) => {
      if (!r.ok) return null
      const tree = await r.json() as { document?: { project_id?: unknown } }
      return typeof tree.document?.project_id === 'string' && tree.document.project_id !== '' ? tree.document.project_id : null
    }).catch(() => null)
  }
  /** PTY session: /v1/pty/sessions/{id}* resolves via the kernel session
   * read (project_id is pinned at open). The kernel demands the
   * authenticated principal on the read (fail-closed) and hides foreign
   * sessions (403) — both resolve to null here → 404, so a non-owner
   * member never learns the session's project either. */
  async function ptySessionProjectId(sessionId: string): Promise<string | null> {
    return fetch(`${endpoint}/v1/pty/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { accept: 'application/json', ...upstreamAuthHeaders, ...options.principal !== null ? { 'x-principal-id': options.principal } : {} },
    }).then(async (r) => {
      if (!r.ok) return null
      const session = await r.json() as { project_id?: unknown }
      return typeof session.project_id === 'string' && session.project_id !== '' ? session.project_id : null
    }).catch(() => null)
  }
  /** Global events: /v1/events requires an explicit ?project_id= (the
   * kernel's listEvents is otherwise cross-project); absent scope → null →
   * 404 fail-closed. */
  async function eventsProjectId(search: URLSearchParams): Promise<string | null> {
    const projectId = search.get('project_id')
    return projectId !== null && projectId !== '' ? projectId : null
  }
  /** Dispatch one global-id route class to its authoritative resolver. */
  async function globalResourceProject(pathname: string, search: URLSearchParams, method: string): Promise<string | null> {
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts.length >= 1 && parts[0] === 'v1') {
      if (parts[1] === 'events' && parts.length === 2) {
        return eventsProjectId(search)
      }
      if (parts.length >= 3) {
        if (parts[1] === 'artifacts' && (method === 'GET' || method === 'HEAD')) {
          return artifactProjectId(parts[2] ?? '', search.get('project_id'))
        }
        if (parts[1] === 'documents' && parts[2] !== undefined && parts[2] !== '') {
          return documentProjectId(parts[2]!)
        }
        if (parts[1] === 'pty' && parts[2] === 'sessions' && parts[3] !== undefined && parts[3] !== '') {
          return ptySessionProjectId(parts[3]!)
        }
      }
    }
    return null
  }
  /** True when the path is one of the global-id classes the BFF resolves
   * (mirrors globalResourceProject's match conditions) — used to answer 404
   * for unresolvable ids instead of forwarding. */
  function isGlobalIdRoute(pathname: string, method: string): boolean {
    const parts = pathname.split('/').filter(Boolean)
    if (parts.length >= 1 && parts[0] === 'v1') {
      if (parts[1] === 'events' && parts.length === 2) return true
      if (parts.length >= 3) {
        if (parts[1] === 'artifacts' && (method === 'GET' || method === 'HEAD')) return true
        if (parts[1] === 'documents' && parts[2] !== undefined && parts[2] !== '') return true
        if (parts[1] === 'pty' && parts[2] === 'sessions' && parts[3] !== undefined && parts[3] !== '') return true
      }
    }
    return false
  }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // CONFIG-01: every BFF response carries the effective-config pin so the
      // running object can be correlated with the config that produced it.
      res.setHeader('x-config-pin', configPin)
      if (!limiter.allow(req.socket.remoteAddress ?? 'unknown')) {
        sendJson(res, 429, bffError('rate_limited', 'rate limited'))
        return
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const method = (req.method ?? 'GET').toUpperCase()

      // Bootstrap page.
      if (method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(BOOTSTRAP_HTML)
        return
      }
      // Favicon: 204 so the browser does not log a 404 per request.
      if (method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg')) {
        res.writeHead(204, { 'cache-control': 'no-store' })
        res.end()
        return
      }
      // Standalone client bundle.
      if (method === 'GET' && url.pathname === '/client.js') {
        const bundle = readFileSync(bundlePath)
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(bundle)
        return
      }
      // Token verification for the unlock screen.
      if (method === 'POST' && url.pathname === '/api/token-check') {
        const { body, tooLarge } = await readBody(req)
        if (tooLarge) {
          sendJson(res, 413, bffError('payload_too_large', 'payload too large'))
          return
        }
        if (options.token === null) {
          sendJson(res, 200, { ok: true, tokenless: true })
          return
        }
        let presented: string | undefined
        try {
          presented = (JSON.parse(body) as { token?: unknown }).token as string | undefined
        } catch {
          presented = undefined
        }
        if (tokenMatches(presented, options.token)) {
          sendJson(res, 200, { ok: true })
        } else {
          sendJson(res, 401, bffError('unauthorized', 'invalid token'))
        }
        return
      }

      // CSRF session token (SEC-UI-01): issued after bearer authentication.
      // The client fetches it once at startup and echoes it back on every
      // state-changing /api request via the x-csrf-token header.
      if (method === 'GET' && url.pathname === '/api/session/csrf') {
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, bffError('unauthorized', 'unauthorized'))
            return
          }
        }
        sendJson(res, 200, { ok: true, csrf_token: csrfToken })
        return
      }

      // API-01/GOV-01 (hardening §4 P0): in token mode the loopback operator
      // identity (--principal) is REQUIRED. A token without a principal is a
      // misconfiguration, not an anonymous mode: every surface except the
      // unlock screen, CSRF issuance, static assets and health answers
      // 401 {ok:false,error:'principal required'} — fail-closed, before any
      // kernel contact. --no-token keeps its loopback-dev behavior.
      if (
        options.token !== null &&
        options.principal === null &&
        url.pathname !== '/v1/health' &&
        url.pathname !== '/v2/health'
      ) {
        sendJson(res, 401, bffError('principal_required', 'principal required'))
        return
      }

      // Model preference: the research agent's model seat. The standalone
      // persists the choice under the data dir (`model.json`, 0600) and
      // exposes it to the DSH-side plugin via the same file, so a selection
      // made in this UI is what the research agent uses for the primary role.
      // 'auto' (or empty) means the agent default — no override.
      if (method === 'GET' && url.pathname === '/api/model') {
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, bffError('unauthorized', 'unauthorized'))
            return
          }
        }
        sendJson(res, 200, {
          ok: true,
          model: readModelPreference(options.dataDir),
          models: MODEL_CATALOG,
        })
        return
      }
      if (method === 'PUT' && url.pathname === '/api/model') {
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, bffError('unauthorized', 'unauthorized'))
            return
          }
        }
        // SEC-UI-01: session CSRF token required on /api writes.
        if (!verifyCsrfToken(csrfHeader(req), csrfToken)) {
          sendJson(res, 403, bffError('csrf_rejected', 'missing or invalid csrf token'))
          return
        }
        if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
          sendJson(res, 403, bffError('csrf_rejected', 'cross-origin write rejected'))
          return
        }
        const { body, tooLarge } = await readBody(req)
        if (tooLarge) {
          sendJson(res, 413, bffError('payload_too_large', 'payload too large'))
          return
        }
        let model = ''
        try {
          const parsed = JSON.parse(body) as { model?: unknown }
          model = typeof parsed.model === 'string' ? parsed.model.trim() : ''
        } catch {
          sendJson(res, 400, bffError('invalid_json', 'bad request'))
          return
        }
        if (model !== '' && model !== 'auto' && !MODEL_CATALOG.includes(model)) {
          sendJson(res, 422, bffError('validation_error', `unknown model '${model}'`))
          return
        }
        try {
          writeModelPreference(options.dataDir, model === 'auto' ? '' : model)
          sendJson(res, 200, { ok: true, model: model === 'auto' ? '' : model })
        } catch {
          sendJson(res, 500, bffError('internal_error', 'model preference write failed'))
        }
        return
      }

      // Chat /survey: the browser client cannot run the scholar
      // connectors (OpenAlex/Crossref/arXiv fetchers), so the standalone
      // server performs the multi-source search + corpus snapshot on its
      // behalf (same semantics as the DSH Agent /survey command).
      if (method === 'POST' && url.pathname === '/api/chat/survey') {
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, bffError('unauthorized', 'unauthorized'))
            return
          }
        }
        // SEC-UI-01: session CSRF token required on /api writes.
        if (!verifyCsrfToken(csrfHeader(req), csrfToken)) {
          sendJson(res, 403, bffError('csrf_rejected', 'missing or invalid csrf token'))
          return
        }
        if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
          sendJson(res, 403, bffError('csrf_rejected', 'cross-origin write rejected'))
          return
        }
        const { body } = await readBody(req)
        let projectId = ''
        let query = ''
        try {
          const parsed = JSON.parse(body) as { project_id?: unknown; query?: unknown }
          projectId = typeof parsed.project_id === 'string' ? parsed.project_id : ''
          query = typeof parsed.query === 'string' ? parsed.query : ''
        } catch {
          sendJson(res, 400, bffError('invalid_json', 'bad request'))
          return
        }
        if (projectId === '' || query === '') {
          sendJson(res, 400, bffError('project_required', 'project_id and query required'))
          return
        }
        // SEC-UI-01 fail-closed: with a loopback operator principal, membership
        // is enforced BEFORE the connector runs or the corpus is written —
        // unknown/foreign project -> 404, no side effects.
        if (options.principal !== null && !(await isProjectMember(projectId))) {
          sendJson(res, 404, bffError('project_not_found', 'project not found or access denied'))
          return
        }
        try {
          const result = await multiSourceSearch(query, { limit: 20 })
          const snapshotResponse = await fetch(`${endpoint}/v1/projects/${encodeURIComponent(projectId)}/corpus`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json', ...upstreamAuthHeaders },
            body: JSON.stringify({
              queries: result.queries,
              papers: result.hits.map(h => h.paper),
            }),
          })
          if (!snapshotResponse.ok) {
            sendJson(res, 502, bffError('kernel_unreachable', 'corpus snapshot failed'))
            return
          }
          const snapshot = (await snapshotResponse.json()) as { snapshot_id?: string; papers?: unknown[] }
          sendJson(res, 200, {
            ok: true,
            snapshot_id: snapshot.snapshot_id,
            papers: Array.isArray(snapshot.papers) ? snapshot.papers.length : 0,
            removed: result.dedup_removed,
            top: result.hits.slice(0, 5).map(h => ({ paper_id: h.paper.paper_id, title: h.paper.title, year: h.paper.year })),
          })
      } catch {
        sendJson(res, 502, bffError('connector_unavailable', 'survey connector unavailable'))
        }
        return
      }

      // Kernel proxy: everything under /v1/* and /v2/* (v2 = BFF surface).
      if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v2/')) {
        // Auth: bearer token required when token mode is on.
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, bffError('unauthorized', 'unauthorized'))
            return
          }
        }
        // CSRF: state-changing same-origin writes.
        if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
          if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
            sendJson(res, 403, bffError('csrf_rejected', 'cross-origin write rejected'))
            return
          }
        }
        // API-01 BFF AuthZ: project-scoped routes require membership of the
        // loopback operator identity; unknown project OR non-member -> 404
        // (no enumeration, api-contracts §1). Job-scoped routes resolve the
        // owning project through the kernel first — the BFF checks membership
        // BEFORE streaming (api-contracts.md §9: job_log_read + membership).
        let memberProjectId: string | null = null
        if (options.principal !== null) {
          memberProjectId = projectIdFromPath(url.pathname)
          if (memberProjectId === null) {
            const jobId = jobIdFromPath(url.pathname)
            if (jobId !== null) memberProjectId = await jobProjectId(jobId)
          }
          if (memberProjectId === null) {
            const childId = childIdFromPath(url.pathname)
            if (childId !== null) memberProjectId = await childProjectId(childId)
          }
          if (memberProjectId === null && url.pathname.startsWith('/v1/gates/') && url.pathname.includes('/decisions')) {
            // GOV-01/API-01: a gate DECISION is project-scoped via the gate's
            // owning project — resolve it through the kernel (the gate id is
            // NOT a project id; treating it as one caused false 404s).
            const gateId = url.pathname.split('/').filter(Boolean)[2] ?? ''
            if (gateId !== '') {
              memberProjectId = await fetch(`${endpoint}/v1/gates/${encodeURIComponent(gateId)}`, { headers: { accept: 'application/json', ...upstreamAuthHeaders } })
                .then(async r => (r.ok ? (await r.json() as { project_id?: string }).project_id ?? null : null))
                .catch(() => null)
            }
          }
          if (memberProjectId === null) {
            // API-01/PTY-01 (hardening §5 P0-2): global-id routes — artifact,
            // document/TeX, pty session and global events ids carry no path
            // project; the BFF resolves the owning project through the kernel
            // (per-class authoritative resolver above) and answers 404 for
            // unknown ids AND foreign projects BEFORE forwarding — no
            // enumeration, same fail-closed contract as project-scoped routes.
            memberProjectId = await globalResourceProject(url.pathname, url.searchParams, method)
            if (memberProjectId === null && isGlobalIdRoute(url.pathname, method)) {
              // Unresolvable global-id route → 404, never forwarded: the
              // kernel's GET /v1/events WITHOUT ?project_id= is a CROSS-PROJECT
              // dump, unknown document ids would answer kernel 422, and an
              // ambiguous artifact (409) leaks nothing. Unknown id and foreign
              // project are the same 404 at this surface.
              sendJson(res, 404, { error: { code: 'project_not_found', message: 'project not found or access denied' } })
              return
            }
          }
          if (memberProjectId !== null && !(await isProjectMember(memberProjectId)) && !isProjectDelete(method, url.pathname)) {
            sendJson(res, 404, { error: { code: 'project_not_found', message: 'project not found or access denied' } })
            return
          }
          // The projects LIST is filtered to the operator's memberships.
          if (url.pathname === '/v1/projects' && method === 'GET') {
            const upstreamList = await fetch(`${endpoint}/v1/projects`, { headers: { accept: 'application/json', ...upstreamAuthHeaders } })
            if (!upstreamList.ok) {
              sendJson(res, 502, bffError('kernel_unreachable', 'research kernel unavailable'))
              return
            }
            const all = (await upstreamList.json()) as Array<{ project_id: string }>
            const allowed: Array<Record<string, unknown>> = []
            for (const p of all) {
              const members = await projectMembers(p.project_id)
              if (members !== null && members.some(m => m.principal_id === options.principal)) allowed.push(p as unknown as Record<string, unknown>)
            }
            sendJson(res, 200, allowed)
            return
          }
          // API-01 role capabilities (defense in depth, kernel v2 semantics):
          // viewer/auditor are read-only; researcher cannot perform governance
          // writes — the PI-only capability route table (transitions/gates/
          // decisions/budget/approve/accept PLUS intake adopt and project
          // archive/unarchive, hardening §5 P1 GOV-01/ONBOARD-01);
          // pi/operator are unrestricted. Enforced BEFORE forwarding with a
          // stable body ({ok:false,error:'role forbidden'}) that never leaks
          // internal detail. The role comes from the BFF's own membership
          // lookup — the client never supplies it.
          if (memberProjectId !== null && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
            const role = await projectRole(memberProjectId)
            if (role !== null) {
              const projectDelete = isProjectDelete(method, url.pathname)
              if (role === 'viewer' || role === 'auditor' || (role === 'operator' && projectDelete)
                || (role === 'researcher' && (isPiOnlyWrite(url.pathname) || projectDelete))) {
                sendJson(res, 403, bffError('role_forbidden', 'role forbidden'))
                return
              }
            }
          }
        }
        // UPLOAD-01 (hardening §4 P1): multipart uploads pass through as RAW
        // BYTES with their ORIGINAL content-type (the boundary must survive
        // the proxy). A string conversion would corrupt binary file content
        // and a rewritten content-type would lose the boundary. Everything
        // else keeps the JSON-only path (normalized identity, canonical
        // application/json). The body cap for multipart is the kernel's
        // upload budget (32 MiB file + envelope overhead); oversized
        // uploads are rejected here with 413 before reaching the kernel.
        const incomingContentType = req.headers['content-type']
        const isMultipart = typeof incomingContentType === 'string' && incomingContentType.trim().toLowerCase().startsWith('multipart/form-data')
        let body: string | Buffer | undefined
        if (method !== 'GET' && method !== 'HEAD') {
          if (isMultipart) {
            const read = await readBodyBytes(req, UPLOAD_MAX_BODY_BYTES)
            if (read.tooLarge) {
              sendJson(res, 413, bffError('payload_too_large', 'payload too large'))
              return
            }
            body = read.buffer
          } else {
            const read = await readBody(req)
            if (read.tooLarge) {
              sendJson(res, 413, bffError('payload_too_large', 'payload too large'))
              return
            }
            body = read.body
          }
        }
        // API-01/GOV-01 (hardening §4 P0): the authenticated operator session
        // is derived ONCE per request — it both normalizes identity fields in
        // write bodies and supplies x-principal-session for the kernel.
        // (Multipart bodies are never JSON, so identity normalization is a
        // no-op there; the kernel binds the project from the URL path.)
        const opSession = options.principal !== null ? operatorSession(options.dataDir, options.principal) : null
        if (opSession !== null && typeof body === 'string' && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
          const seedCreator = url.pathname === '/v1/projects' || url.pathname === '/v2/projects'
          body = normalizeIdentityBody(body, opSession.principal_id, opSession.session_id, seedCreator)
        }
        // api-contracts.md §1: mutation/creation headers pass through
        // (Idempotency-Key, X-Request-Id). Client-supplied identity is never
        // trusted on any surface: on /v1 the standalone enforces membership
        // itself, and on /v2 the identity headers below are overwritten with
        // the server-derived principal/role (never taken from the client).
        const proxyHeaders: Record<string, string> = isMultipart
          ? { 'content-type': incomingContentType, accept: 'application/json' }
          : { 'content-type': 'application/json', accept: 'application/json' }
        // §5 P0-1 (hardening API-01/SIDE-01): the BFF's OWN kernel bearer
        // (0600 dataDir/kernel-token) — the kernel demands it on every
        // non-health route. The browser's token never reaches the kernel;
        // the BFF substitutes its service credential here.
        proxyHeaders['authorization'] = `Bearer ${kernelToken}`
        // §4 P0 (API-01/EVID-01): internal routes demand the service token.
        // The BFF injects its OWN credential (server-derived, 0600 file) and
        // never forwards a client-supplied x-service-token; the kernel
        // ignores the header on non-internal routes.
        proxyHeaders['x-service-token'] = serviceToken
        // PTY-01 (hardening §5 P0-2): x-pty-lease (the opaque session lease
        // pinned at open) passes through so control/frames can present it —
        // the KERNEL validates it against the session owner; the BFF never
        // reads or mints it. Idempotency-Key/X-Request-Id keep passing
        // through per api-contracts.md §1.
        for (const name of ['idempotency-key', 'x-request-id', 'x-pty-lease']) {
          const value = req.headers[name]
          if (typeof value === 'string' && value !== '') proxyHeaders[name] = value
        }
        // API-01 v2 identity forwarding: on /v2/* the BFF injects the
        // loopback operator identity (x-principal-id) plus the role it
        // resolved from project membership (x-principal-role:
        // pi|researcher|operator|auditor|viewer) so kernel handleV2 can
        // enforce membership and apply the role policy. Both headers are
        // derived server-side from the BFF's own membership lookup — a
        // client-supplied value is never trusted. Non-project-scoped v2
        // routes (e.g. /v2/health) still pass through; the identity header
        // is inert there and lets the kernel filter the /v2 list.
        if (options.principal !== null && url.pathname.startsWith('/v2/')) {
          proxyHeaders['x-principal-id'] = options.principal
          if (memberProjectId !== null) {
            const role = await projectRole(memberProjectId)
            if (role !== null) proxyHeaders['x-principal-role'] = role
          }
        }
        // v2 shape (domain-model.md §9): job submission records the durable
        // submitter principal (jobs.created_by_principal_id). On the v1 jobs
        // route the BFF injects the loopback operator identity the same way
        // it does for /v2/* — server-derived, never client-supplied; the
        // kernel route falls back to the body override for internal callers
        // and NULL when neither is present.
        if (options.principal !== null && method === 'POST' && /^\/v1\/projects\/[^/]+\/jobs$/.test(url.pathname)) {
          proxyHeaders['x-principal-id'] = options.principal
        }
        // PTY-01 (execution-runtime.md §6.1, hardening §5 P0-2): the kernel
        // demands the authenticated principal on EVERY pty operation — open,
        // session read, control and frames (fail-closed: 422
        // principal_required without it; 403 for a non-owner; control
        // additionally demands the session lease). The BFF injects the
        // loopback operator identity on ALL /v1/pty/sessions/* forwards
        // (server-derived, never a client-supplied value) and passes the
        // client's x-pty-lease through (the kernel validates it). At OPEN
        // the BFF additionally resolves the body's project and enforces
        // membership BEFORE forwarding (unknown/foreign project → 404, no
        // session row, no tty spawned); viewer/auditor are read-only
        // surfaces → 403 (same role policy as project-scoped v2 writes).
        if (options.principal !== null && url.pathname.startsWith('/v1/pty/sessions')) {
          if (method === 'POST' && url.pathname === '/v1/pty/sessions') {
            let ptyProjectId: string | null = null
            if (typeof body === 'string' && body !== '') {
              try {
                const parsed = JSON.parse(body) as { project_id?: unknown }
                if (typeof parsed.project_id === 'string' && parsed.project_id !== '') ptyProjectId = parsed.project_id
              } catch { /* invalid JSON → the kernel answers 422 validation_error */ }
            }
            if (ptyProjectId === null) {
              sendJson(res, 422, bffError('project_required', 'project_id required'))
              return
            }
            if (!(await isProjectMember(ptyProjectId))) {
              sendJson(res, 404, { error: { code: 'project_not_found', message: 'project not found or access denied' } })
              return
            }
            const ptyRole = await projectRole(ptyProjectId)
            if (ptyRole === 'viewer' || ptyRole === 'auditor') {
              sendJson(res, 403, bffError('role_forbidden', 'role forbidden'))
              return
            }
          }
          proxyHeaders['x-principal-id'] = options.principal
        }
        // API-01/PTY-01 (hardening §5 P0-2): POST /v1/artifacts is a
        // global-id WRITE — the target project lives in the body, not the
        // path. Mirror the pty-open rule: membership of the operator in the
        // body's project is enforced BEFORE forwarding (unknown/foreign
        // project → 404, no artifact row, no CAS bytes) and viewer/auditor
        // cannot register artifacts (403, same role policy).
        if (options.principal !== null && method === 'POST' && url.pathname === '/v1/artifacts') {
          let artifactProjectIdBody: string | null = null
          if (typeof body === 'string' && body !== '') {
            try {
              const parsed = JSON.parse(body) as { project_id?: unknown }
              if (typeof parsed.project_id === 'string' && parsed.project_id !== '') artifactProjectIdBody = parsed.project_id
            } catch { /* invalid JSON → the kernel answers 422 validation_error */ }
          }
          if (artifactProjectIdBody !== null) {
            if (!(await isProjectMember(artifactProjectIdBody))) {
              sendJson(res, 404, { error: { code: 'project_not_found', message: 'project not found or access denied' } })
              return
            }
            const artifactRole = await projectRole(artifactProjectIdBody)
            if (artifactRole === 'viewer' || artifactRole === 'auditor') {
              sendJson(res, 403, bffError('role_forbidden', 'role forbidden'))
              return
            }
          }
        }
        // SUBAGENT-01 (trajectory-subagents.md §7): the kernel demands the
        // authenticated principal on /v1/topology/* (fail-closed) — the BFF
        // injects the loopback operator identity (server-derived, never a
        // client-supplied value). Membership was already enforced above via
        // childProjectId; viewer/auditor write attempts (followup) are
        // rejected by the role policy (read-only roles block all writes).
        if (options.principal !== null && url.pathname.startsWith('/v1/topology/')) {
          proxyHeaders['x-principal-id'] = options.principal
        }
        // API-01/§22 (acceptance-tests.md §21 SSE 实时流替代轮询): the new
        // v1 SSE stream routes under a PATH project (workspace watch/stream,
        // trajectory/stream) enforce principal + membership fail-closed at
        // the kernel (requireProjectMember) — inject the loopback operator
        // identity like /v1/topology. BFF membership was already enforced
        // above via projectIdFromPath BEFORE any stream byte; the pty
        // frames stream is covered by the /v1/pty/sessions rule.
        if (options.principal !== null && isSseStreamForward(url.pathname)) {
          proxyHeaders['x-principal-id'] = options.principal
        }
        // GOV-01/ONBOARD-01 (hardening §5 P1): the PI-only v1 routes (intake
        // adopt, project archive/unarchive) are double-checked by the KERNEL,
        // which resolves the acting principal's role from its OWN
        // project_members table (researcher/viewer/auditor → 403
        // role_forbidden, unknown principal → 404, missing identity → 422
        // principal_required — never a single BFF layer). The BFF therefore
        // injects its server-derived operator identity on these forwards;
        // the role header is a hint for the kernel's fast path, the kernel
        // membership lookup is the authority.
        if (options.principal !== null && (method === 'POST' && isKernelPiOnlyForward(url.pathname) || isProjectDelete(method, url.pathname))) {
          proxyHeaders['x-principal-id'] = options.principal
          if (memberProjectId !== null) {
            const role = await projectRole(memberProjectId)
            if (role !== null) proxyHeaders['x-principal-role'] = role
          }
        }
        // GOV-01 principal resolver: the authenticated operator session is a
        // DURABLE identity derived from the bearer token (session.json,
        // 0600, stable across restarts — "Session link 在重启后恢复"). Every
        // forwarded request carries x-principal-session so kernel decisions
        // record the session_id (durable principal, acceptance-tests.md §2).
        if (opSession !== null) {
          proxyHeaders['x-principal-session'] = opSession.session_id
        }
        const upstream = await fetch(`${endpoint}${url.pathname}${url.search}`, {
          method,
          headers: proxyHeaders,
          // Multipart bodies are Buffers — pass a Uint8Array copy (never a
          // string, which would corrupt binary file content).
          body: body === undefined ? undefined
            : typeof body === 'string' ? body
              : new Uint8Array(body),
        })
        if (upstream.status >= 400) {
          let code = upstream.status >= 500 ? 'kernel_error' : 'request_rejected'
          if (upstream.status < 500) {
            try {
              const payload = await upstream.json() as { error?: { code?: unknown } }
              const candidate = payload.error?.code
              if (typeof candidate === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(candidate)) code = candidate
            } catch { /* malformed upstream error stays generic */ }
          }
          sendJson(res, upstream.status, { error: { code, message: 'research request rejected' } })
          return
        }
        const headers: Record<string, string> = {
          'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
          'x-content-type-options': 'nosniff',
        }
        for (const name of ['content-type', 'content-length', 'content-disposition', 'etag', 'last-modified']) {
          const value = upstream.headers.get(name)
          if (value !== null) headers[name] = value
        }
        res.writeHead(upstream.status, headers)
        if (upstream.body === null) {
          res.end()
        } else {
          const source = Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0])
          const abortSource = (): void => { source.destroy() }
          req.once('aborted', abortSource)
          res.once('error', abortSource)
          res.once('close', () => {
            if (!res.writableEnded) abortSource()
          })
          source.once('error', () => {
            if (!res.destroyed) res.destroy()
          })
          source.pipe(res)
        }
        return
      }

      sendJson(res, 404, bffError('not_found', 'not found'))
    } catch {
      sendJson(res, 502, bffError('kernel_unreachable', 'research kernel unavailable'))
    }
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(options.port, options.host, () => {
        server.off('error', onError)
        resolve()
      })
    })
  } catch (error) {
    await sidecar.stop()
    throw error
  }
  console.log(`[research-ui-standalone] serving at http://${options.host}:${options.port}`)
  console.log(`[research-ui-standalone] kernel at ${endpoint}`)
  if (options.token !== null) {
    console.log('[research-ui-standalone] token auth enabled; read the 0600 standalone-token file')
  } else {
    console.log(`[research-ui-standalone] token auth DISABLED (loopback only)`)
  }

  const shutdown = (): void => {
    server.close(() => { void sidecar.stop().then(() => process.exit(0)) })
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// Direct execution: `node lib/standalone/server.js ...`
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  // CONFIG-01: `--help` prints the registry-generated CLI help (no server
  // start, no token file writes).
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`DSH Scholar standalone web application server (design §15.2/§15.3)\nUsage: node lib/standalone/server.js [options]\n\n${generateCliHelp('standalone')}`)
    process.exit(0)
  }
  // SEC-UI-01: startup failures (incl. argument validation) exit non-zero
  // with the STABLE message only — never a raw stack trace that would leak
  // internal paths into the service log.
  let options: StandaloneOptions
  try {
    options = loadOptions(process.argv.slice(2))
  } catch (error) {
    console.error(`[research-ui-standalone] fatal: ${(error as Error).message}`)
    process.exit(1)
  }
  void startStandalone(options).catch(error => {
    console.error(`[research-ui-standalone] fatal: ${(error as Error).message}`)
    process.exit(1)
  })
}
