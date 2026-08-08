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
  :root { color-scheme: light; }
  :root[data-theme="dark"] { color-scheme: dark; }
  body { margin:0; background:#f7f9fc; color:#1a2333; font:14px/1.5 system-ui,sans-serif; }
  :root[data-theme="dark"] body { background:#0a0e18; color:#dbe2ee; }
  #boot-screen { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; z-index:9998; }
  .card { background:#ffffff; border:1px solid #d9e1ee; border-radius:14px; padding:28px 34px; width:min(420px, 90vw); box-shadow:0 18px 60px rgba(30,45,80,.18); }
  :root[data-theme="dark"] .card { background:#111726; border-color:#263049; box-shadow:0 18px 60px rgba(0,0,0,.5); }
  .card h1 { margin:0 0 6px; font-size:18px; color:#1a2333; }
  :root[data-theme="dark"] .card h1 { color:#eef2fa; }
  .card p { margin:0 0 16px; color:#4a5a78; font-size:12.5px; }
  :root[data-theme="dark"] .card p { color:#8b97b0; }
  .card input { width:100%; box-sizing:border-box; background:#ffffff; color:#1a2333; border:1px solid #d9e1ee; border-radius:8px; padding:9px 12px; font:13px/1.4 ui-monospace,Menlo,monospace; outline:none; margin-bottom:12px; }
  :root[data-theme="dark"] .card input { background:#151b2c; color:#dbe2ee; border-color:#2b3652; }
  .card input:focus { border-color:#2563eb; }
  :root[data-theme="dark"] .card input:focus { border-color:#4d9fff; }
  .card button { width:100%; background:linear-gradient(180deg,#2f9e44,#238636); color:#fff; border:0; border-radius:8px; padding:10px 14px; font:700 13px/1 system-ui,sans-serif; cursor:pointer; }
  .card button:hover { filter:brightness(1.12); }
  .err { color:#dc2626; font-size:12px; margin-top:10px; min-height:16px; }
  :root[data-theme="dark"] .err { color:#f87171; }
  .hint { margin-top:14px; color:#6b7a99; font-size:11px; }
  :root[data-theme="dark"] .hint { color:#55627e; }
  .theme-toggle { position:fixed; top:14px; right:16px; z-index:9999; background:#ffffff; color:#1a2333; border:1px solid #d9e1ee; border-radius:8px; padding:5px 12px; cursor:pointer; font:600 12px/1.6 system-ui,sans-serif; }
  :root[data-theme="dark"] .theme-toggle { background:#151b2c; color:#dbe2ee; border-color:#2b3652; }
</style>
</head>
<body>
<button id="theme-toggle" class="theme-toggle">🌙 Dark</button>
<div id="boot-screen">
  <div class="card">
    <h1>🧪 Research OS</h1>
    <p>Standalone DSH Scholar web plugin — gate decisions here are recorded with your operator identity.</p>
    <input id="token-input" type="password" placeholder="Access token" autocomplete="off">
    <button id="token-submit">Unlock</button>
    <div class="err" id="token-err"></div>
    <div class="hint">Token: generated on server start, printed to its log / saved under the data dir.</div>
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
      toggle.textContent = dark ? '☀️ Light' : '🌙 Dark';
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
