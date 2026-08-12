/** Host-only reader for the standalone browser access token. */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TOKEN_FILE = 'standalone-token'
const MAX_TOKEN_BYTES = 4096

export function standaloneDataDir(): string {
  return process.env.DSH_SCHOLAR_STANDALONE_DATA
    ?? join(homedir(), '.dsh-scholar-standalone', 'research-ui-standalone')
}

/**
 * Read the fixed standalone token without following symlinks. The returned
 * string is intentionally only consumed by the loopback RPC clipboard seam.
 */
export function readStandaloneAccessToken(dataDir = standaloneDataDir()): string {
  const path = join(dataDir, TOKEN_FILE)
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  const fd = openSync(path, constants.O_RDONLY | noFollow)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('standalone token is not a regular file')
    if ((stat.mode & 0o777) !== 0o600) throw new Error('standalone token permissions must be 0600')
    if (stat.size <= 0 || stat.size > MAX_TOKEN_BYTES) throw new Error('standalone token size is invalid')
    // Bound the actual read as well as the pre-read stat: a concurrent local
    // writer cannot turn a small checked file into an unbounded allocation.
    const buffer = Buffer.alloc(MAX_TOKEN_BYTES + 1)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    if (bytesRead <= 0 || bytesRead > MAX_TOKEN_BYTES) throw new Error('standalone token size is invalid')
    const token = buffer.subarray(0, bytesRead).toString('utf8').trim()
    if (token === '' || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
      throw new Error('standalone token is invalid')
    }
    return token
  } finally {
    closeSync(fd)
  }
}
