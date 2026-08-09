/** Standalone BFF bridge: same-origin /api + /v1 fetch helpers, bearer
 * auth, CSRF session token, and the standalone bootstrap hook. */

export let apiBase = ''
export let tokenProvider: (() => Promise<string | undefined>) | undefined
export let overlayRoot: ShadowRoot | null = null
/** SEC-UI-01: process-scoped CSRF session token, fetched once at startup and
 * echoed back on every state-changing /api request (x-csrf-token). */
export let csrfToken: string | undefined
export let csrfFetch: Promise<string | undefined> | undefined

export function setStandaloneBridge(options: {
  base: string
  token: () => Promise<string | undefined>
  overlay?: ShadowRoot
}): void {
  apiBase = options.base
  tokenProvider = options.token
  overlayRoot = options.overlay ?? null
  // Fetch the CSRF session token right away so the first write never has to
  // wait on it (cached for the lifetime of this page).
  void ensureCsrfToken()
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await tokenProvider?.()
  return token !== undefined && token !== '' ? { authorization: `Bearer ${token}` } : {}
}

/** Lazily fetch and cache the CSRF session token (same-origin, bearer-auth). */
export async function ensureCsrfToken(): Promise<string | undefined> {
  if (csrfToken !== undefined) return csrfToken
  if (csrfFetch === undefined) {
    csrfFetch = (async () => {
      try {
        const response = await fetch(`${base()}/api/session/csrf`, {
          headers: { ...(await authHeaders()), accept: 'application/json' },
        })
        if (!response.ok) return undefined
        const payload = (await response.json()) as { csrf_token?: unknown }
        csrfToken = typeof payload.csrf_token === 'string' ? payload.csrf_token : undefined
        return csrfToken
      } catch {
        return undefined
      }
    })()
  }
  return csrfFetch
}

export function base(): string {
  return apiBase
}


export async function api<T>(path: string, init?: RequestInit): Promise<T | null> {
  // SEC-UI-01: state-changing requests must carry the session CSRF token.
  const method = (init?.method ?? 'GET').toUpperCase()
  const isWrite = method !== 'GET' && method !== 'HEAD'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${base()}${path}`, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          accept: 'application/json',
          ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(await authHeaders()),
          ...(isWrite ? { 'x-csrf-token': (await ensureCsrfToken()) ?? '' } : {}),
        },
      })
      if (response.status === 401) return null
      if (!response.ok) return null
      return (await response.json()) as T
    } catch {
      return null
    }
  }
  return null
}

