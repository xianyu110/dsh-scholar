/**
 * Editor dirty semantics (acceptance-tests.md §7 dirty-before-compile,
 * §4 row 95 TEX-01): the dirty baseline is the last content KNOWN SAVED on
 * the server. Clearing a non-empty file ('') is a change → dirty=true;
 * reverting to the saved bytes (including '') → dirty=false. The baseline
 * must never come from the tree/GET entry, which carries no content.
 */
import { describe, expect, it } from 'vitest'
import { isEditorDirty } from '../../packages/dsh-research-ui/src/client/manuscript-dirty'

describe('manuscript editor dirty semantics (§7 dirty-before-compile)', () => {
  it('clearing a non-empty file reads dirty ("" !== saved)', () => {
    expect(isEditorDirty('', '\\documentclass{article}\n')).toBe(true)
  })

  it('untouched content reads clean', () => {
    const saved = '\\documentclass{article}\n'
    expect(isEditorDirty(saved, saved)).toBe(false)
  })

  it('revert to the saved content reads clean (including revert to "")', () => {
    expect(isEditorDirty('', '')).toBe(false)
    const saved = '\\section{Intro}\n'
    expect(isEditorDirty(saved, saved)).toBe(false)
  })

  it('any edit away from the saved bytes reads dirty', () => {
    const saved = ''
    expect(isEditorDirty('x', saved)).toBe(true)
    expect(isEditorDirty('ab', 'a')).toBe(true)
  })
})
