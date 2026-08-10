/**
 * Editor dirty semantics (acceptance-tests.md §7 dirty-before-compile):
 * the editor is dirty when its current content differs from the last content
 * KNOWN TO BE SAVED on the server. '' is a real content value — clearing a
 * non-empty file IS a change and must read dirty, and reverting to the saved
 * content must read clean.
 *
 * The baseline must be the content from the file GET / the last successful
 * save — NEVER the tree/GET entry: the tree payload deliberately carries no
 * content (path/kind/media/version only, acceptance-tests.md §7), so a tree
 * lookup would yield undefined and clear-to-'' would compare as "not dirty".
 */
export function isEditorDirty(editorContent: string, savedContent: string): boolean {
  return editorContent !== savedContent
}
