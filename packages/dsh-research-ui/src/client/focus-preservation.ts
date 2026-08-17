export type RenderReason = 'interactive' | 'background'

export interface FocusIdentity {
  tagName: string
  id: string
  name: string
  type: string
  classes: string[]
  data: Record<string, string>
  ariaLabel: string
  placeholder: string
  path: number[]
}

export interface FocusSnapshot {
  identity: FocusIdentity
  selectionStart: number | null
  selectionEnd: number | null
  selectionDirection: 'forward' | 'backward' | 'none' | null
  scrollTop: number
  scrollLeft: number
}

export function shouldDeferBackgroundRefresh(tagName: string, isContentEditable: boolean): boolean {
  const tag = tagName.toLowerCase()
  return isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select'
}

function isEditableEventNode(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false
  const candidate = target as EventTarget & { tagName?: unknown, isContentEditable?: unknown }
  const tagName = typeof candidate.tagName === 'string' ? candidate.tagName.toLowerCase() : ''
  return candidate.isContentEditable === true
    || tagName === 'input'
    || tagName === 'textarea'
    || tagName === 'select'
}

/**
 * Keyboard events observed outside a ShadowRoot expose the host as
 * `event.target`. The composed path retains the actual editor, so global
 * shortcuts must inspect it before deciding that the user is not typing.
 */
export function eventComesFromEditable(event: Pick<Event, 'target' | 'composedPath'>): boolean {
  const path = event.composedPath()
  return (path.length > 0 ? path : [event.target]).some(isEditableEventNode)
}

/** Coalesce re-entrant renders and defer polling while a user edits. */
export class RenderCoordinator {
  private active: Promise<void> | null = null
  private trailing = false
  private deferredBackground = false

  constructor(
    private readonly renderOnce: () => Promise<void>,
    private readonly shouldDeferBackground: () => boolean,
  ) {}

  request(reason: RenderReason): Promise<void> {
    if (reason === 'background' && this.shouldDeferBackground()) {
      this.deferredBackground = true
      return Promise.resolve()
    }
    if (this.active !== null) {
      this.trailing = true
      return this.active
    }
    // An interactive repaint fetches the same authoritative projection and
    // therefore subsumes any poll that was deferred while typing.
    this.deferredBackground = false
    const run = async (): Promise<void> => {
      do {
        this.trailing = false
        await this.renderOnce()
      } while (this.trailing)
    }
    this.active = run().finally(() => { this.active = null })
    return this.active
  }

  hasDeferredBackgroundRefresh(): boolean {
    return this.deferredBackground
  }

  releaseDeferredBackgroundRefresh(): Promise<void> {
    if (!this.deferredBackground || this.shouldDeferBackground()) return Promise.resolve()
    this.deferredBackground = false
    return this.request('background')
  }
}

function elementPath(root: ShadowRoot, element: Element): number[] {
  const path: number[] = []
  let current: Element | null = element
  while (current !== null) {
    const parentNode: ParentNode | null = current.parentNode
    if (parentNode === null) break
    path.unshift([...parentNode.children].indexOf(current))
    if (parentNode === root) break
    current = parentNode instanceof Element ? parentNode : null
  }
  return path
}

function elementIdentity(root: ShadowRoot, element: HTMLElement): FocusIdentity {
  const data: Record<string, string> = {}
  for (const [key, value] of Object.entries(element.dataset)) {
    if (value !== undefined) data[key] = value
  }
  return {
    tagName: element.tagName,
    id: element.id,
    name: element.getAttribute('name') ?? '',
    type: element.getAttribute('type') ?? '',
    classes: [...element.classList],
    data,
    ariaLabel: element.getAttribute('aria-label') ?? '',
    placeholder: element.getAttribute('placeholder') ?? '',
    path: elementPath(root, element),
  }
}

function samePath(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Pure scoring seam used when structural DOM changed during a repaint. */
export function focusCandidateScore(expected: FocusIdentity, candidate: FocusIdentity): number {
  if (expected.tagName !== candidate.tagName) return Number.NEGATIVE_INFINITY
  let score = 1
  if (expected.id !== '' && expected.id === candidate.id) score += 100
  if (expected.name !== '' && expected.name === candidate.name) score += 30
  if (expected.type !== '' && expected.type === candidate.type) score += 8
  for (const [key, value] of Object.entries(expected.data)) {
    if (candidate.data[key] === value) score += 32
  }
  for (const cls of expected.classes) if (candidate.classes.includes(cls)) score += 5
  if (expected.ariaLabel !== '' && expected.ariaLabel === candidate.ariaLabel) score += 12
  if (expected.placeholder !== '' && expected.placeholder === candidate.placeholder) score += 10
  if (samePath(expected.path, candidate.path)) score += 8
  return score
}

export function captureFocus(root: ShadowRoot): FocusSnapshot | null {
  const active = root.activeElement
  if (!(active instanceof HTMLElement)) return null
  const textControl = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
  return {
    identity: elementIdentity(root, active),
    selectionStart: textControl ? active.selectionStart : null,
    selectionEnd: textControl ? active.selectionEnd : null,
    selectionDirection: textControl ? active.selectionDirection : null,
    scrollTop: active.scrollTop,
    scrollLeft: active.scrollLeft,
  }
}

function resolvePath(root: ShadowRoot, path: readonly number[]): HTMLElement | null {
  let parent: ParentNode = root
  let current: Element | null = null
  for (const index of path) {
    const child = parent.children.item(index)
    if (child === null) return null
    current = child
    parent = child
  }
  return current instanceof HTMLElement ? current : null
}

export function restoreFocus(root: ShadowRoot, snapshot: FocusSnapshot | null): boolean {
  if (snapshot === null) return false
  // A user can move focus to standalone chrome outside the app ShadowRoot
  // while an async panel render is awaiting data. Never steal it back.
  if (document.activeElement !== root.host && document.activeElement !== document.body) return false
  const currentlyFocused = root.activeElement
  if (currentlyFocused instanceof HTMLElement && currentlyFocused.isConnected) return false

  const candidates = [...root.querySelectorAll(snapshot.identity.tagName.toLowerCase())]
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
  let target = resolvePath(root, snapshot.identity.path)
  if (target === null || target.tagName !== snapshot.identity.tagName) target = null
  let bestScore = target === null
    ? Number.NEGATIVE_INFINITY
    : focusCandidateScore(snapshot.identity, elementIdentity(root, target))
  for (const candidate of candidates) {
    const score = focusCandidateScore(snapshot.identity, elementIdentity(root, candidate))
    if (score > bestScore) {
      target = candidate
      bestScore = score
    }
  }
  if (target === null || bestScore <= 1) return false
  target.focus({ preventScroll: true })
  target.scrollTop = snapshot.scrollTop
  target.scrollLeft = snapshot.scrollLeft
  if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
      && snapshot.selectionStart !== null && snapshot.selectionEnd !== null) {
    target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd, snapshot.selectionDirection ?? undefined)
  }
  return root.activeElement === target
}
