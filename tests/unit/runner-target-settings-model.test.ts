/**
 * EXEC-ENV-02 Settings SecretRef form contract.
 *
 * The browser edits metadata only: all four supported fields must survive an
 * edit round-trip, while blank optional values are omitted from the request.
 * Secret values are deliberately absent from both the draft and payload.
 */
import { describe, expect, it } from 'vitest'
import {
  runnerTargetSecretRefDraft,
  runnerTargetSecretRefPayload,
} from '../../packages/dsh-research-ui/src/client/runner-target-settings-model'

describe('runner target Settings SecretRef model', () => {
  it('preserves scheme/name/version/scope when editing an existing safe view', () => {
    const draft = runnerTargetSecretRefDraft({
      scheme: 'vault',
      name: 'research/lab-a/ssh-key',
      version: '42',
      scope: 'project:alpha',
      available: true,
    })

    expect(draft).toEqual({
      scheme: 'vault',
      name: 'research/lab-a/ssh-key',
      version: '42',
      scope: 'project:alpha',
    })
    expect(runnerTargetSecretRefPayload(draft)).toEqual(draft)
  })

  it('trims fields and omits blank optional metadata', () => {
    expect(runnerTargetSecretRefPayload({
      scheme: 'file',
      name: '  lab-a/endpoint.json  ',
      version: '   ',
      scope: '',
    })).toEqual({ scheme: 'file', name: 'lab-a/endpoint.json' })
  })

  it('rejects an empty reference name', () => {
    expect(runnerTargetSecretRefPayload({
      scheme: 'keyring',
      name: '   ',
      version: 'v1',
      scope: 'runner',
    })).toBeNull()
  })
})
