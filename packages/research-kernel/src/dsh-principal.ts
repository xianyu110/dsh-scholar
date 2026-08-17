import { createHmac } from 'node:crypto'

/**
 * Stable local Human Principal shared by the DSH plugin and Scholar BFF.
 *
 * The route credential is instance-scoped and persisted beside kernel.db.
 * Deriving the principal from it gives every DSH session in that instance
 * one durable operator identity without exposing the credential itself.
 */
export function dshOperatorPrincipal(dshPluginToken: string): string {
  const token = dshPluginToken.trim()
  if (token === '') throw new Error('DSH plugin token must not be empty')
  const digest = createHmac('sha256', token)
    .update('dsh-scholar-local-operator-v1')
    .digest('hex')
    .slice(0, 32)
  return `dsh:${digest}`
}
