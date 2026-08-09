/**
 * P0 trusted image digest lock (acceptance-tests.md §4).
 *
 * Secure job kinds (baseline/pilot/formal/reproduce/latex-compile) must bind
 * an `image_digest` that equals the trusted images.lock entry EXACTLY
 * (`<image>@sha256:<64 hex>`); tags (`node:22-alpine`), `latest`, missing
 * digests and post-commit digest swaps are all rejected with 422.
 *
 * The lock is read from `<repo>/configs/runner-profiles/images.lock.json`
 * (override the path at runtime with `DSH_IMAGES_LOCK`). When the file cannot
 * be read, the two hardcoded constants below are the ONLY allowed entries.
 * @module @dsh-scholar/research-kernel/images-lock
 */

import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KernelError } from './kernel.js'

/** Secure job kinds bound to the trusted image lock (acceptance-tests.md §4). */
export type SecureJobKind = 'baseline' | 'pilot' | 'formal' | 'reproduce' | 'latex-compile'

/** Image identities pinned by the lock. */
export type LockedImageKind = 'node_fixture' | 'texlive'

/** Hardcoded fallback entries — used ONLY when the lock file cannot be read. */
const FALLBACK_LOCK: Record<LockedImageKind, string> = {
  node_fixture: 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32',
  texlive: 'texlive/texlive@sha256:8957c916b8160049f89c24d362a6d86c09d8a04095acde37e88404c4afed85b4',
}

/** `<image>@sha256:<64 hex>` — the only digest shape a lock entry may pin. */
const LOCKED_DIGEST_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/

export interface ImagesLock {
  schema_version: number
  node_fixture: string
  texlive: string
}

/**
 * Repo-relative lock path, anchored at the compiled `lib/bin` directory:
 * ../../../../configs/runner-profiles/images.lock.json (documented in
 * reconstruction-contracts.md §13). The same anchor resolves from `lib`
 * (one level shallower than `lib/bin`) and from `src`/`src/bin` under tsx.
 */
function defaultLockPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const binDir = here.endsWith(`${sep}bin`) ? here : join(here, 'bin')
  return join(binDir, '..', '..', '..', '..', 'configs', 'runner-profiles', 'images.lock.json')
}

function lockPath(): string {
  const override = process.env.DSH_IMAGES_LOCK
  return override !== undefined && override !== '' ? override : defaultLockPath()
}

/**
 * Resolve the lock file. Only the two pinned entries (node_fixture, texlive)
 * are ever honored; a missing/unreadable file or a malformed entry falls back
 * to the hardcoded constants — never to extra caller-supplied entries.
 */
function loadLock(): ImagesLock {
  let raw: string | null = null
  try {
    raw = readFileSync(lockPath(), 'utf8')
  } catch {
    raw = null
  }
  const fileEntry = (key: LockedImageKind): string | undefined => {
    if (raw === null) return undefined
    try {
      const value = (JSON.parse(raw) as Record<string, unknown>)[key]
      return typeof value === 'string' && LOCKED_DIGEST_RE.test(value) ? value : undefined
    } catch {
      return undefined
    }
  }
  return {
    schema_version: 1,
    node_fixture: fileEntry('node_fixture') ?? FALLBACK_LOCK.node_fixture,
    texlive: fileEntry('texlive') ?? FALLBACK_LOCK.texlive,
  }
}

/** The resolved trusted image lock (exactly the two pinned entries). */
export const IMAGES_LOCK: ImagesLock = loadLock()

/** Locked digest for one image identity. */
export function getLockedDigest(kind: LockedImageKind): string {
  return IMAGES_LOCK[kind]
}

/**
 * Validate a submitted image_digest against the trusted lock and return the
 * digest that will be bound to the job (acceptance-tests.md §4).
 *
 * - baseline/pilot/formal/reproduce (strict): missing/empty digest →
 *   422 `image_digest_required`; anything that is not EXACTLY the locked
 *   node_fixture entry (tag, `latest`, well-formed foreign digest) →
 *   422 `image_digest_untrusted`. Equality is character-for-character.
 * - latex-compile: a missing digest is injected with the locked texlive entry
 *   (the kernel owns the TeX pipeline, so injection is not a "missing
 *   digest"); an explicitly provided digest must equal the lock exactly,
 *   otherwise 422 `image_digest_untrusted`.
 */
export function validateImageDigest(kind: SecureJobKind, digest: string | undefined | null): string {
  if (kind === 'latex-compile') {
    if (digest === undefined || digest === null || digest === '') return IMAGES_LOCK.texlive
    if (digest !== IMAGES_LOCK.texlive) {
      throw new KernelError(422, 'image_digest_untrusted',
        `image_digest ${JSON.stringify(digest)} is not the trusted texlive entry of images.lock (expected ${IMAGES_LOCK.texlive})`)
    }
    return digest
  }
  // Strict mode (CONTRACT_BOUND_KINDS + latex-compile handled above): the
  // digest must be present and byte-for-byte the locked node_fixture entry.
  if (digest === undefined || digest === null || digest === '') {
    throw new KernelError(422, 'image_digest_required',
      `job kind ${kind} requires image_digest pinned to the trusted node_fixture entry of images.lock (acceptance-tests.md §4)`)
  }
  if (digest !== IMAGES_LOCK.node_fixture) {
    throw new KernelError(422, 'image_digest_untrusted',
      `image_digest ${JSON.stringify(digest)} is not the trusted node_fixture entry of images.lock (expected ${IMAGES_LOCK.node_fixture})`)
  }
  return digest
}
