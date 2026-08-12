/** DOM-free Artifact transfer helpers shared by preview and downloads. */

export interface ArtifactTransferRecord {
  artifact_id?: string
  kind?: string
  file_name?: string | null
  media_type?: string
}

/** Artifact bytes are always read in the currently selected project scope. */
export function artifactContentPath(projectId: string, artifactId: string): string {
  return `/v1/artifacts/${encodeURIComponent(artifactId)}?project_id=${encodeURIComponent(projectId)}`
}

function safeBaseName(value: string): string | null {
  const clean = value.replaceAll('\0', '').replaceAll('\\', '/').split('/').pop()?.trim() ?? ''
  if (clean === '' || clean === '.' || clean === '..') return null
  return clean.slice(0, 255)
}

function dispositionName(value: string | null): string | null {
  if (value === null) return null
  const encoded = /(?:^|;)\s*filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value)?.[1]?.trim()
  if (encoded !== undefined) {
    try {
      const decoded = safeBaseName(decodeURIComponent(encoded.replace(/^"|"$/g, '')))
      if (decoded !== null) return decoded
    } catch { /* malformed filename* falls through to filename= */ }
  }
  const quoted = /(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"])*)"/i.exec(value)?.[1]
  if (quoted !== undefined) return safeBaseName(quoted.replace(/\\([\\"])/g, '$1'))
  const plain = /(?:^|;)\s*filename\s*=\s*([^;]+)/i.exec(value)?.[1]?.trim()
  return plain === undefined ? null : safeBaseName(plain)
}

function fallbackExtension(record: ArtifactTransferRecord): string {
  const media = record.media_type?.split(';', 1)[0]?.trim().toLowerCase()
  if (record.kind === 'pdf' || media === 'application/pdf') return '.pdf'
  if (record.kind === 'log' || record.kind === 'compile-log' || media?.startsWith('text/')) return '.txt'
  if (record.kind === 'bib') return '.bib'
  if (record.kind === 'tex-source') return '.tex'
  if (media === 'image/png') return '.png'
  if (media === 'image/jpeg') return '.jpg'
  if (media === 'image/svg+xml') return '.svg'
  return '.bin'
}

/** Prefer the server's Content-Disposition, then the registry file_name. */
export function artifactDownloadName(record: ArtifactTransferRecord, contentDisposition: string | null): string {
  const served = dispositionName(contentDisposition)
  if (served !== null) return served
  const registered = safeBaseName(record.file_name ?? '')
  if (registered !== null) return registered
  const digest = (record.artifact_id ?? 'artifact').replace(/^sha256:/, '').slice(0, 12) || 'artifact'
  return `${record.kind ?? 'artifact'}-${digest}${fallbackExtension(record)}`
}
