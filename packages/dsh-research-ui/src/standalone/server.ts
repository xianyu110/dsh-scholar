/**
 * DSH Research OS — fully standalone web plugin server.
 *
 * Serves the Research OS UI at its own origin, completely independent of
 * the `dsh web` host: it spawns (or reuses) the Research Kernel sidecar,
 * serves the built client bundle plus a minimal bootstrap page, proxies
 * `/v1/*` to the kernel and protects every state-changing call with a
 * loopback bearer token (the same posture as the DSH-hosted bridge,
 * design §15.2/§15.3).
 *
 * Usage:
 *   node lib/standalone/server.js [--port 18610] [--kernel-port 17413]
 *     [--data-dir <dir>] [--token <secret>] [--host 127.0.0.1]
 *
 * On first start a token is generated and printed + persisted under the
 * data dir (`standalone-token`); the browser asks for it once and keeps it
 * in localStorage. Token mode can be disabled with `--no-token` (loopback
 * only, not recommended).
 * @module @dsh-scholar/research-ui/standalone
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { UiKernelSidecar } from '../host/sidecar.js'
import { multiSourceSearch } from '@dsh-scholar/scholar-connectors'

const DEFAULT_PORT = 18610
const DEFAULT_KERNEL_PORT = 17413

interface StandaloneOptions {
  host: string
  port: number
  kernelPort: number
  dataDir: string
  token: string | null
}

/** Constant-time token comparison (values never appear in logs). */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined || provided.length === 0) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** 16 MiB request body cap (matches the DSH bridge, §15.2). */
const MAX_BODY_BYTES = 16 * 1024 * 1024

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
      if (total > MAX_BODY_BYTES) {
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

/** JSON error responses never carry internal paths/env (design §15.2). */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

/** CSRF: non-GET same-origin writes must come from our own host/port. */
function isAllowedOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (origin === undefined) return true
  if (hostHeader === undefined) return false
  try {
    const o = new URL(origin)
    if (o.protocol !== 'http:' && o.protocol !== 'https:') return false
    if (o.hostname !== '127.0.0.1' && o.hostname !== 'localhost' && o.hostname !== '[::1]') return false
    const oPort = o.port === '' ? (o.protocol === 'https:' ? '443' : '80') : o.port
    const h = new URL(`http://${hostHeader}`)
    const hPort = h.port === '' ? '80' : h.port
    return oPort === hPort
  } catch {
    return false
  }
}

const BOOTSTRAP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Research OS — DSH Scholar</title>
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
    <div class="brand"><span class="brand-mark">dsh</span><span class="brand-name">Research</span><span class="brand-meta">Workspace</span></div>
    <div class="eyebrow">Operator access</div>
    <h1>Welcome back.</h1>
    <p>Open your evidence workspace. Human gate decisions are recorded with your operator identity.</p>
    <label class="field-label" for="token-input">Access token</label>
    <input id="token-input" type="password" placeholder="Access token" autocomplete="off">
    <button id="token-submit">Open workspace</button>
    <div class="err" id="token-err"></div>
    <div class="hint"><span class="hint-dot"></span><span>Your token is generated when the local server starts and remains on this machine.</span></div>
  </div>
</div>
<script>
  // The client bundle registers itself via window.__ModuleLoader__.load
  // (the same handoff the DSH host uses); the standalone page provides a
  // minimal loader that captures the factory's exports.
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
      toggle.textContent = dark ? 'Light' : 'Dark';
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
            err.textContent = j.error || 'Invalid token';
          }
        })
        .catch(function () { err.textContent = 'Server unreachable'; });
    }
    function startPanel(token) {
      if (window.__DSH_SCHOLAR_UI__ && window.__DSH_SCHOLAR_UI__.apply) {
        window.__DSH_SCHOLAR_UI__.setStandaloneBridge({
          base: '',
          token: function () { return Promise.resolve(token); },
        });
        window.__DSH_SCHOLAR_UI__.apply({ fullscreen: true });
      } else {
        err.textContent = 'Client bundle failed to load';
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
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: String(DEFAULT_PORT) },
      'kernel-port': { type: 'string', default: String(DEFAULT_KERNEL_PORT) },
      'data-dir': { type: 'string' },
      token: { type: 'string' },
      'no-token': { type: 'boolean', default: false },
    },
  })
  const dataDir = values['data-dir'] ?? join(process.env.DSH_HOME ?? process.cwd(), 'research-ui-standalone')
  let token: string | null = null
  if (values['no-token'] !== true) {
    const tokenFile = join(dataDir, 'standalone-token')
    if (values.token !== undefined && values.token !== '') {
      token = values.token
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(tokenFile, token, { mode: 0o600 })
    } else if (existsSync(tokenFile)) {
      token = readFileSync(tokenFile, 'utf8').trim()
    } else {
      token = `dsh-${randomBytes(18).toString('hex')}`
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(tokenFile, token, { mode: 0o600 })
    }
  }
  return {
    host: values.host ?? '127.0.0.1',
    port: Number(values.port ?? DEFAULT_PORT),
    kernelPort: Number(values['kernel-port'] ?? DEFAULT_KERNEL_PORT),
    dataDir,
    token,
  }
}

export async function startStandalone(options: StandaloneOptions): Promise<void> {
  const sidecar = new UiKernelSidecar({
    host: '127.0.0.1',
    port: options.kernelPort,
    dataDir: options.dataDir,
    log: line => console.error(line),
  })
  await sidecar.start()
  const endpoint = sidecar.endpoint

  // The client bundle ships from this package's lib/client.js.
  const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
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
      // Client bundle (the same build the DSH host uses; standalone config
      // is applied by the bootstrap script before apply()).
      if (method === 'GET' && url.pathname === '/client.js') {
        const bundle = readFileSync(bundlePath)
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(bundle)
        return
      }
      // Token verification for the unlock screen.
      if (method === 'POST' && url.pathname === '/api/token-check') {
        const { body } = await readBody(req)
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
          sendJson(res, 401, { ok: false, error: 'invalid token' })
        }
        return
      }

      // Chat /research survey: the browser client cannot run the scholar
      // connectors (OpenAlex/Crossref/arXiv fetchers), so the standalone
      // server performs the multi-source search + corpus snapshot on its
      // behalf (same surface as the DSH-hosted /research survey command).
      if (method === 'POST' && url.pathname === '/api/chat/survey') {
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, { ok: false, error: 'unauthorized' })
            return
          }
        }
        const { body } = await readBody(req)
        let projectId = ''
        let query = ''
        try {
          const parsed = JSON.parse(body) as { project_id?: unknown; query?: unknown }
          projectId = typeof parsed.project_id === 'string' ? parsed.project_id : ''
          query = typeof parsed.query === 'string' ? parsed.query : ''
        } catch {
          sendJson(res, 400, { ok: false, error: 'bad request' })
          return
        }
        if (projectId === '' || query === '') {
          sendJson(res, 400, { ok: false, error: 'project_id and query required' })
          return
        }
        try {
          const result = await multiSourceSearch(query, { limit: 20 })
          const snapshotResponse = await fetch(`${endpoint}/v1/projects/${encodeURIComponent(projectId)}/corpus`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              queries: result.queries,
              papers: result.hits.map(h => h.paper),
            }),
          })
          if (!snapshotResponse.ok) {
            sendJson(res, 502, { ok: false, error: 'corpus snapshot failed' })
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
        } catch (error) {
          sendJson(res, 502, { ok: false, error: `survey failed: ${(error as Error).message}` })
        }
        return
      }

      // Kernel proxy: everything under /v1/*.
      if (url.pathname.startsWith('/v1/')) {
        // Auth: bearer token required when token mode is on.
        if (options.token !== null) {
          const auth = req.headers.authorization
          const match = typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth) : null
          if (!tokenMatches(match?.[1], options.token)) {
            sendJson(res, 401, { ok: false, error: 'unauthorized' })
            return
          }
        }
        // CSRF: state-changing same-origin writes.
        if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
          if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
            sendJson(res, 403, { ok: false, error: 'cross-origin write rejected' })
            return
          }
        }
        let body: string | undefined
        if (method !== 'GET' && method !== 'HEAD') {
          const read = await readBody(req)
          if (read.tooLarge) {
            sendJson(res, 413, { ok: false, error: 'payload too large' })
            return
          }
          body = read.body
        }
        const upstream = await fetch(`${endpoint}${url.pathname}${url.search}`, {
          method,
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body,
        })
        const text = await upstream.text()
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.end(text)
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch {
      sendJson(res, 502, { ok: false, error: 'research kernel unavailable' })
    }
  })

  await new Promise<void>(resolve => server.listen(options.port, options.host, resolve))
  console.log(`[research-ui-standalone] serving at http://${options.host}:${options.port}`)
  console.log(`[research-ui-standalone] kernel at ${endpoint}`)
  if (options.token !== null) {
    console.log(`[research-ui-standalone] access token: ${options.token}`)
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
  const options = loadOptions(process.argv.slice(2))
  void startStandalone(options).catch(error => {
    console.error(`[research-ui-standalone] fatal: ${(error as Error).message}`)
    process.exit(1)
  })
}
