import type { SecretRefViewLite } from './types'

export type RunnerTargetSecretRefScheme = SecretRefViewLite['scheme']

/** Browser-editable SecretRef metadata. Secret values are intentionally not
 * part of this model: the runner resolves them server-side. */
export interface RunnerTargetSecretRefDraft {
  scheme: RunnerTargetSecretRefScheme
  name: string
  version: string
  scope: string
}

export interface RunnerTargetSecretRefPayload {
  scheme: RunnerTargetSecretRefScheme
  name: string
  version?: string
  scope?: string
}

/** Create a lossless form draft from the server's safe metadata view. */
export function runnerTargetSecretRefDraft(
  ref?: Pick<SecretRefViewLite, 'scheme' | 'name' | 'version' | 'scope'>,
): RunnerTargetSecretRefDraft {
  return {
    scheme: ref?.scheme ?? 'file',
    name: ref?.name ?? '',
    version: ref?.version ?? '',
    scope: ref?.scope ?? '',
  }
}

/** Normalize a form draft for the strict kernel schema. Blank optional
 * metadata is omitted; a missing required name fails closed. */
export function runnerTargetSecretRefPayload(
  draft: RunnerTargetSecretRefDraft,
): RunnerTargetSecretRefPayload | null {
  const name = draft.name.trim()
  if (name === '') return null
  const version = draft.version.trim()
  const scope = draft.scope.trim()
  return {
    scheme: draft.scheme,
    name,
    ...(version === '' ? {} : { version }),
    ...(scope === '' ? {} : { scope }),
  }
}
