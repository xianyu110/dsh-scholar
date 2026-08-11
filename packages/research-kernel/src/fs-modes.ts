/**
 * Permission contract helpers (WORK-01 / hardening-v0.2-status.md §5).
 *
 * `mkdirSync(path, { recursive: true, mode })` applies `mode & ~umask` to
 * every directory it creates, so under `umask 0077` a requested 0750 chain
 * silently becomes 0700. `mkdirMode` restores the contract mode on exactly
 * the directories it created — pre-existing directories are NEVER chmodded
 * (an existing tree keeps whatever an operator set, including stricter
 * modes). This makes the "0750 chain / 0640 files" contract independent of
 * the calling environment's umask.
 * @module @dsh-scholar/research-kernel/fs-modes
 */

import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * `mkdir -p` with a mode that survives any umask: creates `dir` (and any
 * missing parents) with `mode & ~umask`, then restores `mode` via chmod on
 * exactly the directories this call created. Directories that already
 * existed before the call are left untouched.
 */
export function mkdirMode(dir: string, mode: number): void {
  // Walk up from `dir` to the deepest existing ancestor; every component
  // in between is created by this call (deepest first in `created`).
  const created: string[] = []
  let current = dir
  while (!existsSync(current)) {
    created.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  mkdirSync(dir, { recursive: true, mode })
  // mkdir -p applied mode & ~umask; restore the contract mode on exactly
  // the directories this call created (order is irrelevant for chmod).
  for (const path of created) {
    try {
      chmodSync(path, mode)
    } catch {
      // Best-effort: some filesystems ignore modes (e.g. FAT); the mkdir
      // already applied mode & ~umask there.
    }
  }
}
