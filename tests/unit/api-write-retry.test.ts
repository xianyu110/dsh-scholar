/** Shared UI request helpers must never replay non-idempotent writes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UI API write retry policy', () => {
  it('attempts a JSON write only once after a transport failure', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('network down') })
    vi.stubGlobal('fetch', fetchMock)
    const { apiResult } = await import('../../packages/dsh-research-ui/src/client/api')

    const result = await apiResult('/v1/providers', { method: 'POST', body: '{}' })

    expect(result).toMatchObject({ ok: false, status: 0, error: { code: 'network_error' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/session/csrf')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/v1/providers')
  })

  it('attempts a multipart POST only once after a transport failure', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('network down') })
    vi.stubGlobal('fetch', fetchMock)
    const { apiMultipart } = await import('../../packages/dsh-research-ui/src/client/api')

    const result = await apiMultipart('/v1/projects/rsp_1/uploads', new FormData())

    expect(result).toMatchObject({ ok: false, status: 0, error: { code: 'network_error' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/session/csrf')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/v1/projects/rsp_1/uploads')
  })
})
