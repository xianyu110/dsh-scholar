/**
 * ART-UI-01: the Artifact panel must preserve project scope and the
 * server-registered download name.  These helpers stay DOM-free so the
 * browser behavior can be pinned without a synthetic DOM environment.
 */
import { describe, expect, it } from 'vitest'
import {
  artifactContentPath,
  artifactDownloadName,
} from '../../packages/dsh-research-ui/src/client/artifact-transfer'

describe('Artifact panel transfer model', () => {
  it('always scopes artifact bytes to the selected project', () => {
    expect(artifactContentPath('rsp_a/b', 'sha256:aa/bb')).toBe(
      '/v1/artifacts/sha256%3Aaa%2Fbb?project_id=rsp_a%2Fb',
    )
  })

  it('uses a safe Content-Disposition file name before registry fallbacks', () => {
    const row = {
      artifact_id: 'sha256:abcdef',
      kind: 'pdf',
      file_name: 'registry.pdf',
    }
    expect(artifactDownloadName(row, 'inline; filename="served.pdf"')).toBe('served.pdf')
    expect(artifactDownloadName(row, null)).toBe('registry.pdf')
  })

  it('decodes filename* and strips any path supplied by a response header', () => {
    const row = { artifact_id: 'sha256:abcdef', kind: 'data', file_name: null }
    expect(artifactDownloadName(row, "attachment; filename*=UTF-8''%E8%AE%BA%E6%96%87.pdf")).toBe('论文.pdf')
    expect(artifactDownloadName(row, 'attachment; filename="../escape.bin"')).toBe('escape.bin')
    expect(artifactDownloadName(row, 'attachment; filename="bad\r\nname.bin"')).toBe('badname.bin')
  })

  it('falls back to a stable kind/id name with a useful extension', () => {
    expect(artifactDownloadName({
      artifact_id: 'sha256:abcdef1234567890',
      kind: 'pdf',
      file_name: null,
    }, null)).toBe('pdf-abcdef123456.pdf')
    expect(artifactDownloadName({ artifact_id: 'sha256:abcdef1234567890', kind: 'data', media_type: 'audio/mpeg' }, null)).toBe('data-abcdef123456.mp3')
    expect(artifactDownloadName({ artifact_id: 'sha256:abcdef1234567890', kind: 'data', media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, null)).toBe('data-abcdef123456.xlsx')
    expect(artifactDownloadName({ artifact_id: 'sha256:abcdef1234567890', kind: 'code', media_type: 'application/octet-stream' }, 'attachment; filename="code-sha256abcdef"')).toBe('code-sha256abcdef.json')
    expect(artifactDownloadName({ artifact_id: 'sha256:abcdef1234567890', kind: 'pdf', media_type: 'application/pdf' }, 'inline; filename="pdf-sha256abcdef"')).toBe('pdf-sha256abcdef.pdf')
  })
})
