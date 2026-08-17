import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const standaloneUrl = process.env.DSH_SCHOLAR_STANDALONE_URL ?? 'http://127.0.0.1:18610/'
const widthFlag = process.argv.indexOf('--width')
const viewportWidth = widthFlag >= 0 ? Number(process.argv[widthFlag + 1]) : 1280
if (!Number.isInteger(viewportWidth) || viewportWidth < 320) throw new Error('--width must be an integer >= 320')
const tokenPath = process.env.DSH_SCHOLAR_STANDALONE_TOKEN_FILE
  ?? join(homedir(), '.dsh-scholar-standalone/research-ui-standalone/standalone-token')
const chrome = process.env.CHROME_BIN
  ?? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(existsSync)

if (chrome === undefined) throw new Error('Chrome was not found; set CHROME_BIN')
if (!existsSync(tokenPath)) throw new Error(`Standalone token file not found: ${tokenPath}`)

const token = readFileSync(tokenPath, 'utf8').trim()
const profile = mkdtempSync(join(tmpdir(), 'dsh-scholar-ocr-layout-'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const reservePort = async () => await new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close()
      reject(new Error('Could not reserve a Chrome debugging port'))
      return
    }
    server.close(error => error === undefined ? resolve(address.port) : reject(error))
  })
})

const waitFor = async (probe, description, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value) return value
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

const port = await reservePort()
const child = spawn(chrome, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--hide-scrollbars',
  `--window-size=${viewportWidth},900`,
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' })

let socket
try {
  const target = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      return targets.find(candidate => candidate.type === 'page')
    } catch {
      return undefined
    }
  }, 'Chrome DevTools target')

  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id === undefined) return
    const waiter = pending.get(message.id)
    if (waiter === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.text ?? 'Browser evaluation failed')
    }
    return result.result.value
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: standaloneUrl })
  await waitFor(() => evaluate('document.readyState === "complete"'), 'standalone page load')
  await evaluate(`localStorage.setItem('dsh-scholar-ui-token', ${JSON.stringify(token)}); location.reload()`)
  await waitFor(() => evaluate('document.readyState === "complete"'), 'authenticated page reload')
  await waitFor(() => evaluate(`(() => {
    const host = [...document.querySelectorAll('*')].find(node => node.shadowRoot)
    const dot = host?.shadowRoot?.querySelector('.kernel-dot')
    if (!(dot instanceof HTMLElement)) return false
    dot.click()
    return true
  })()`), 'Scholar shell')
  await waitFor(() => evaluate(`(() => {
    const root = [...document.querySelectorAll('*')].find(node => node.shadowRoot)?.shadowRoot
    const section = root?.querySelector('.settings-section[data-section="models-ocr"]')
    const head = section?.querySelector('.settings-section-head')
    if (!(head instanceof HTMLElement)) return false
    if (section.dataset.open !== 'true') head.click()
    return true
  })()`), 'OCR settings accordion')

  const metrics = await waitFor(() => evaluate(`(() => {
    const root = [...document.querySelectorAll('*')].find(node => node.shadowRoot)?.shadowRoot
    const provider = root?.querySelector('input[aria-label="OCR 服务商"], input[aria-label="OCR provider"]')
    const form = provider?.closest('.settings-ocr-form') ?? provider?.parentElement
    if (!(form instanceof HTMLElement)) return null
    const formStyle = getComputedStyle(form)
    const formRect = form.getBoundingClientRect()
    const grid = form.querySelector('.settings-ocr-grid')
    const controls = [...form.querySelectorAll('input:not([type="checkbox"]),select,button')]
      .filter(control => {
        if (!(control instanceof HTMLElement) || getComputedStyle(control).display === 'none') return false
        const rect = control.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      })
      .map(control => {
        const rect = control.getBoundingClientRect()
        return { width: Math.round(rect.width), right: Math.round(rect.right) }
      })
    const children = [...form.children]
      .filter(child => child instanceof HTMLElement && getComputedStyle(child).display !== 'none')
      .map(child => {
        const rect = child.getBoundingClientRect()
        return { className: child.className, width: Math.round(rect.width), right: Math.round(rect.right) }
      })
    return {
      className: form.className,
      display: formStyle.display,
      flexDirection: formStyle.flexDirection,
      viewportWidth: window.innerWidth,
      formWidth: Math.round(formRect.width),
      gridColumnCount: grid instanceof HTMLElement
        ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length
        : 0,
      minChildWidth: Math.min(...children.map(child => child.width)),
      overflowCount: children.filter(child => child.right > formRect.right + 1).length,
      minControlWidth: Math.min(...controls.map(control => control.width)),
      controlOverflowCount: controls.filter(control => control.right > formRect.right + 1).length,
      children,
    }
  })()`), 'OCR settings form')

  const horizontallyPacked = metrics.display === 'flex' && metrics.flexDirection === 'row'
  const hasCollapsedControls = metrics.minChildWidth < 160
    || metrics.minControlWidth < 120
  const hasOverflow = metrics.overflowCount > 0 || metrics.controlOverflowCount > 0
  const expectedColumns = metrics.viewportWidth <= 720 ? 1 : 2
  const wrongResponsiveColumns = metrics.gridColumnCount !== expectedColumns
  console.log(JSON.stringify(metrics, null, 2))
  if (horizontallyPacked || hasCollapsedControls || hasOverflow || wrongResponsiveColumns) {
    throw new Error('OCR settings controls are horizontally packed, collapsed, or overflowing')
  }
  console.log('OCR settings layout: PASS')
} finally {
  if (socket !== undefined) socket.close()
  child.kill('SIGTERM')
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
