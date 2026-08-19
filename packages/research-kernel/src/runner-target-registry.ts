import type { DatabaseSync } from 'node:sqlite'
import {
  BUILTIN_RUNNER_TARGETS,
  RunnerTargetDescriptor,
  runnerTargetSafeView,
  type RunnerTargetCreateInput,
  type RunnerTargetDescriptor as RunnerTarget,
  type RunnerTargetUpdateInput,
  type SecretRef,
} from '@dsh-scholar/research-schemas'
import { KernelError } from './kernel.js'
import { validateSecretRefInput } from './provider.js'

export const RUNNER_TARGET_DDL = `
CREATE TABLE IF NOT EXISTS runner_targets (
  target_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local-process','local-docker','remote-ssh')),
  enabled INTEGER NOT NULL DEFAULT 1,
  draining INTEGER NOT NULL DEFAULT 0,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  connection_json TEXT,
  health TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown','online','offline')),
  last_seen_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runner_targets_schedulable
  ON runner_targets(enabled, draining, health, kind);
`

interface RunnerTargetRow {
  target_id: string
  display_name: string
  kind: RunnerTarget['kind']
  enabled: number
  draining: number
  capabilities_json: string
  connection_json: string | null
  service_identity_json?: string | null
  runtime_json?: string | null
  health: RunnerTarget['health']
  last_seen_at: string | null
  revision: number
  created_by: string
  created_at: string
  updated_at: string
}

function nowIso(): string { return new Date().toISOString() }

function fromRow(row: RunnerTargetRow): RunnerTarget {
  return RunnerTargetDescriptor.parse({
    target_id: row.target_id,
    display_name: row.display_name,
    kind: row.kind,
    enabled: row.enabled === 1,
    draining: row.draining === 1,
    capabilities: JSON.parse(row.capabilities_json) as unknown,
    connection: row.connection_json === null ? undefined : JSON.parse(row.connection_json) as unknown,
    service_identity: row.service_identity_json === undefined || row.service_identity_json === null
      ? undefined
      : JSON.parse(row.service_identity_json) as unknown,
    runtime: row.runtime_json === undefined || row.runtime_json === null ? undefined : JSON.parse(row.runtime_json) as unknown,
    health: row.health,
    last_seen_at: row.last_seen_at,
    revision: row.revision,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })
}

function validateRefs(target: RunnerTarget): void {
  if (target.connection === undefined) return
  validateSecretRefInput(target.connection.endpoint)
  validateSecretRefInput(target.connection.credential)
  validateSecretRefInput(target.connection.known_hosts)
}

function validateIdentityRef(target: RunnerTarget): void {
  if (target.service_identity !== undefined) validateSecretRefInput(target.service_identity)
}

export function seedBuiltinRunnerTargets(db: DatabaseSync): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO runner_targets
      (target_id,display_name,kind,enabled,draining,capabilities_json,connection_json,health,last_seen_at,revision,created_by,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  for (const target of BUILTIN_RUNNER_TARGETS) {
    insert.run(
      target.target_id, target.display_name, target.kind, target.enabled ? 1 : 0, target.draining ? 1 : 0,
      JSON.stringify(target.capabilities), null, target.health, target.last_seen_at, target.revision,
      target.created_by, target.created_at, target.updated_at,
    )
  }
}

export class RunnerTargetRegistry {
  constructor(
    private readonly db: DatabaseSync,
    private readonly secretAvailable: (ref: SecretRef) => boolean,
    private readonly identityAvailable: (ref: SecretRef) => boolean,
    private readonly identityMatches: (ref: SecretRef, provided: string) => boolean,
  ) {}

  list(): RunnerTarget[] {
    const rows = this.db.prepare('SELECT * FROM runner_targets ORDER BY target_id').all() as unknown as RunnerTargetRow[]
    return rows.map(fromRow)
  }

  get(targetId: string): RunnerTarget {
    const row = this.db.prepare('SELECT * FROM runner_targets WHERE target_id = ?').get(targetId) as RunnerTargetRow | undefined
    if (row === undefined) throw new KernelError(404, 'runner_target_unknown', `runner target ${targetId} is not registered`)
    return fromRow(row)
  }

  view(target: RunnerTarget): ReturnType<typeof runnerTargetSafeView> {
    return runnerTargetSafeView(target, this.secretAvailable, this.identityAvailable)
  }

  create(input: RunnerTargetCreateInput, createdBy: string): RunnerTarget {
    if (this.db.prepare('SELECT target_id FROM runner_targets WHERE target_id = ?').get(input.target_id) !== undefined) {
      throw new KernelError(409, 'runner_target_exists', `runner target ${input.target_id} already exists`)
    }
    const now = nowIso()
    const target = RunnerTargetDescriptor.parse({ ...input, health: 'unknown', last_seen_at: null, revision: 1, created_by: createdBy, created_at: now, updated_at: now })
    validateRefs(target)
    validateIdentityRef(target)
    this.db.prepare(
      `INSERT INTO runner_targets
        (target_id,display_name,kind,enabled,draining,capabilities_json,connection_json,service_identity_json,runtime_json,health,last_seen_at,revision,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      target.target_id, target.display_name, target.kind, target.enabled ? 1 : 0, target.draining ? 1 : 0,
      JSON.stringify(target.capabilities), target.connection === undefined ? null : JSON.stringify(target.connection),
      JSON.stringify(target.service_identity),
      target.runtime === undefined ? null : JSON.stringify(target.runtime),
      target.health, target.last_seen_at, target.revision, target.created_by, target.created_at, target.updated_at,
    )
    return target
  }

  update(targetId: string, input: RunnerTargetUpdateInput): RunnerTarget {
    const current = this.get(targetId)
    if (input.expected_revision !== current.revision) {
      throw new KernelError(409, 'runner_target_revision_conflict',
        `runner target ${targetId} revision ${current.revision} does not match expected ${input.expected_revision}`)
    }
    const target = RunnerTargetDescriptor.parse({
      ...current,
      display_name: input.display_name ?? current.display_name,
      kind: input.kind ?? current.kind,
      enabled: input.enabled ?? current.enabled,
      draining: input.draining ?? current.draining,
      capabilities: input.capabilities ?? current.capabilities,
      connection: input.connection === null ? undefined : (input.connection ?? current.connection),
      service_identity: input.service_identity === null ? undefined : (input.service_identity ?? current.service_identity),
      runtime: input.runtime === null ? undefined : (input.runtime ?? current.runtime),
      revision: current.revision + 1,
      updated_at: nowIso(),
      // A configuration change invalidates the previous health observation.
      health: 'unknown',
      last_seen_at: null,
    })
    validateRefs(target)
    validateIdentityRef(target)
    const result = this.db.prepare(
      `UPDATE runner_targets SET display_name=?,kind=?,enabled=?,draining=?,capabilities_json=?,connection_json=?,service_identity_json=?,runtime_json=?,
       health=?,last_seen_at=?,revision=?,updated_at=? WHERE target_id=? AND revision=?`,
    ).run(
      target.display_name, target.kind, target.enabled ? 1 : 0, target.draining ? 1 : 0,
      JSON.stringify(target.capabilities), target.connection === undefined ? null : JSON.stringify(target.connection),
      target.service_identity === undefined ? null : JSON.stringify(target.service_identity),
      target.runtime === undefined ? null : JSON.stringify(target.runtime),
      target.health, target.last_seen_at, target.revision, target.updated_at, targetId, current.revision,
    )
    if (Number(result.changes) !== 1) {
      throw new KernelError(409, 'runner_target_revision_conflict',
        `runner target ${targetId} changed during revision ${current.revision} update`)
    }
    return target
  }

  /** A heartbeat may mutate only the target whose server-side identity ref
   * matches the presented target token. Target ids and principals supplied by
   * the caller are never treated as proof. */
  identityAuthorized(targetId: string, provided: string): boolean {
    const identity = this.get(targetId).service_identity
    return identity !== undefined && this.identityMatches(identity, provided)
  }

  /** Record an authenticated runner observation without changing config revision. */
  observe(targetId: string, input: { expected_revision: number; health: 'online' | 'offline' }): RunnerTarget {
    const current = this.get(targetId)
    if (input.expected_revision !== current.revision) {
      throw new KernelError(409, 'runner_target_revision_conflict',
        `runner target ${targetId} revision ${current.revision} does not match observed revision ${input.expected_revision}`)
    }
    const now = nowIso()
    const result = this.db.prepare(
      'UPDATE runner_targets SET health=?,last_seen_at=?,updated_at=? WHERE target_id=? AND revision=?',
    ).run(input.health, now, now, targetId, current.revision)
    if (Number(result.changes) !== 1) {
      throw new KernelError(409, 'runner_target_revision_conflict',
        `runner target ${targetId} changed during health observation`)
    }
    return this.get(targetId)
  }
}
