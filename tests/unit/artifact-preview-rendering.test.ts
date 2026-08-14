/** ART-PREVIEW-01 — renderer/CSP wiring invariants that do not need a browser. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

const artifacts = source('../../packages/dsh-research-ui/src/client/panels/artifacts.ts')
const manuscript = source('../../packages/dsh-research-ui/src/client/panels/manuscript.ts')
const client = source('../../packages/dsh-research-ui/src/client/index.ts')
const ui = source('../../packages/dsh-research-ui/src/client/ui.ts')
const pluginClient = source('../../src/client/index.tsx')

describe('Artifact preview renderer safety wiring', () => {
  it('uses CSP-compatible PDF iframes and never restores embed/innerHTML sinks', () => {
    expect(artifacts).toContain("document.createElement('iframe')")
    expect(manuscript).toContain("document.createElement('iframe')")
    expect(artifacts).not.toContain("document.createElement('embed')")
    expect(manuscript).not.toContain("document.createElement('embed')")
    expect(artifacts).not.toMatch(/\.innerHTML\s*=/)
  })

  it('defers download-only/oversized bodies and exposes native decode errors', () => {
    expect(artifacts).toContain("plan.mode === 'download'")
    expect(artifacts).toContain('response.body?.cancel()')
    expect(artifacts).toContain('readArtifactTextStream(response.body, controller.signal)')
    expect(artifacts).toContain('authenticatedArtifactDownloadButton')
    expect(artifacts).toContain('attachNativePreviewError')
    expect(artifacts).toContain("artifacts.preview.errorDecode")
    expect(artifacts).toContain('activeController?.abort()')
    expect(artifacts).toContain('signal: controller.signal')
    expect(artifacts).toContain('artifactBulkDownload?.controller.abort()')
  })

  it('keeps download links keyboard reachable and permits only sandboxed popups', () => {
    expect(ui).toContain('button, a[href], input, select, textarea')
    expect(ui).toContain('root.activeElement ?? document.activeElement')
    // The child needs the origin-only referrer to authenticate the optional
    // loopback Host chat bridge; paths, queries and fragments remain hidden.
    expect(pluginClient).toContain('referrerPolicy="origin"')
    expect(pluginClient).toMatch(/sandbox="[^"]*allow-popups[^"]*"/)
    expect(pluginClient).not.toContain('allow-popups-to-escape-sandbox')
    expect(artifacts).toContain("overlay.dataset.overlayDismiss = 'event'")
    expect(client).toContain("latest.dispatchEvent(new Event('dsh-overlay-dismiss'))")
  })

  it('invalidates Manuscript PDF work across documents and panel disposal', () => {
    expect(manuscript).toContain('msContextIsCurrent(generation, documentId, projectId)')
    expect(manuscript).toContain('for (const controller of msControllers) controller.abort()')
    expect(manuscript).toContain('msReleasePdfUrls()')
    expect(manuscript).toContain('if (msBuildPollToken !== null) return')
    expect(manuscript).toContain('if (msPreviewPollToken !== null) return')
    expect(manuscript).toContain("latestSucceededManuscriptBuild(msBuilds, 'authoritative')")
    expect(manuscript).toContain("latestSucceededManuscriptBuild(msPreviews, 'preview')")
    expect(manuscript).toContain('msReleaseMainPdfUrl()')
    expect(manuscript).toContain('msReleasePreviewPdfUrl()')
    expect(manuscript).toContain('msPdfBuildId !== ok.build_id')
    expect(manuscript).toContain('signal: previewController.signal')
    expect(manuscript).toContain("stale.dataset.manuscriptMainPdfStale = 'true'")
    expect(manuscript).toContain("displayedManuscriptPdfIsStale(msPreviews, msPreviewPdfBuildId")
    expect(manuscript).toContain('!msContextIsCurrent(generation, documentId, projectId)')
    expect(manuscript).toContain('existing.status !== 404')
    expect(client).toContain("if (!panelVisible('manuscript')) msCleanup(true)")
    expect(client).toContain("if (!panelVisible('artifacts')) closeArtifactPreview()")
    expect(client).toContain('msCleanup(true)')
  })

  it('restores Artifact overlay focus after a same-project list redraw', () => {
    expect(artifacts).toContain('row.dataset.artifactId = artifact.artifact_id')
    expect(ui).toContain("querySelectorAll<HTMLElement>('[data-artifact-id]')")
    expect(ui).toContain('trigger?.isConnected === true')
  })
})
