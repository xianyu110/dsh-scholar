/** Shared, browser-safe configuration contract for the DSH standalone launcher. */

export const DEFAULT_STANDALONE_URL = 'http://127.0.0.1:18610/'
export const DEFAULT_STANDALONE_SHORTCUT = 'Alt+Shift+S' as const
export const DISABLED_STANDALONE_SHORTCUT = 'disabled' as const

export type StandaloneShortcut =
  | typeof DEFAULT_STANDALONE_SHORTCUT
  | typeof DISABLED_STANDALONE_SHORTCUT

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (match === null) return false
  const octets = match.slice(1).map(Number)
  return octets.every(octet => octet >= 0 && octet <= 255) && octets[0] === 127
}

/** Chat data may cross only to the separately served loopback workbench. */
export function standaloneChatBridgeOrigin(value: string, parentOrigin?: string): string | null {
  let parsed: URL
  try { parsed = new URL(normalizeStandaloneUrl(value)) } catch { return null }
  if (!isLoopbackHostname(parsed.hostname) || parsed.origin === parentOrigin) return null
  return parsed.origin
}

/** Normalize a launcher URL while rejecting credential and token-bearing forms. */
export function normalizeStandaloneUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('standalone URL must be an absolute URL')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('standalone URL must not contain credentials')
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('standalone URL must not contain query parameters or a fragment')
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname))) {
    throw new Error('standalone URL must use HTTPS or loopback HTTP')
  }
  return parsed.toString()
}

export function normalizeStandaloneShortcut(value: string): StandaloneShortcut {
  if (value === DEFAULT_STANDALONE_SHORTCUT || value === DISABLED_STANDALONE_SHORTCUT) return value
  throw new Error('standalone shortcut must be Alt+Shift+S or disabled')
}
