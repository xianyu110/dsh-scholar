import { readFile } from 'node:fs/promises'
import { Script } from 'node:vm'

const repositoryRoot = new URL('../packages/dsh-research-ui/', import.meta.url)
const packageJson = JSON.parse(await readFile(new URL('package.json', repositoryRoot), 'utf8'))
if (packageJson.name !== '@dsh-scholar/research-ui') throw new Error('verify script ran against the wrong package')
const clientPath = packageJson.exports?.['./client']?.default

if (typeof clientPath !== 'string' || !clientPath.startsWith('./')) {
  throw new Error('package exports["./client"].default must be a package-relative path')
}

const bundleUrl = new URL(clientPath.slice(2), repositoryRoot)
const bundle = await readFile(bundleUrl, 'utf8')

// §15.4: untrusted artifacts must never be rendered through HTML-string
// sinks; the bundle must not contain the innerHTML pattern at all (client
// renders with textContent and blob-URL <img>/<embed> only).
if (bundle.includes('innerHTML')) {
  throw new Error(`${clientPath} uses innerHTML (design §15.4 forbids rendering untrusted artifacts via innerHTML)`)
}

let handoff
const window = {
  __ModuleLoader__: {
    load(value) {
      handoff = value
    },
  },
}

try {
  new Script(bundle, { filename: bundleUrl.pathname }).runInNewContext({ window })
} catch (cause) {
  throw new Error(`${clientPath} is not executable as a classic browser bundle`, { cause })
}

if (handoff?.id !== packageJson.name || typeof handoff.factory !== 'function') {
  throw new Error(`${clientPath} did not register ${packageJson.name} via window.__ModuleLoader__.load`)
}

const surface = handoff.factory((specifier) => {
  throw new Error(`unexpected client bundle dependency: ${specifier}`)
})

if (typeof surface?.apply !== 'function') {
  throw new Error(`${clientPath} did not materialize an apply() export`)
}

console.log(`research-ui client bundle verified: ${packageJson.name} -> ${clientPath}`)
