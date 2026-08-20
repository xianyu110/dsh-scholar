import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  MethodologyRolloutConsumptionKind,
  MethodologyRolloutConsumptionPin,
  MethodologyRolloutPolicy,
  MethodologyRolloutPolicyUpdate,
  ProjectMethodologyRolloutPin,
  ProjectMethodologyRolloutPinRequest,
  type MethodologyRolloutConsumptionKind as MethodologyRolloutConsumptionKindValue,
  type MethodologyRolloutConsumptionPin as MethodologyRolloutConsumptionPinValue,
  type MethodologyRolloutMode,
  type MethodologyRolloutPolicy as MethodologyRolloutPolicyValue,
  type MethodologyRolloutPolicyUpdate as MethodologyRolloutPolicyUpdateValue,
  type ProjectMethodologyRolloutPin as ProjectMethodologyRolloutPinValue,
  type ProjectMethodologyRolloutPinRequest as ProjectMethodologyRolloutPinRequestValue,
} from '@dsh-scholar/research-schemas'

function policyHash(revision: number, mode: MethodologyRolloutMode): `sha256:${string}` {
  const canonical = JSON.stringify({ mode, revision })
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export const DEFAULT_METHODOLOGY_ROLLOUT_POLICY = MethodologyRolloutPolicy.parse({
  revision: 1,
  mode: 'internal-fixture',
  policy_hash: policyHash(1, 'internal-fixture'),
  actor_ref: 'system:bootstrap',
  created_at: '2026-08-20T00:00:00.000Z',
})

export const METHODOLOGY_ROLLOUT_DDL = `
CREATE TABLE IF NOT EXISTS methodology_rollout_policies (
  policy_revision INTEGER PRIMARY KEY CHECK (policy_revision > 0),
  mode TEXT NOT NULL CHECK (mode IN ('internal-fixture', 'opt-in-dev', 'opt-in-user')),
  policy_hash TEXT NOT NULL UNIQUE CHECK (policy_hash GLOB 'sha256:[0-9a-f]*' AND length(policy_hash) = 71),
  actor_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS methodology_project_rollout_events (
  project_id TEXT NOT NULL,
  project_pin_revision INTEGER NOT NULL CHECK (project_pin_revision > 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  policy_hash TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('internal-fixture', 'opt-in-dev', 'opt-in-user')),
  actor_ref TEXT NOT NULL,
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (project_id, project_pin_revision),
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (policy_revision) REFERENCES methodology_rollout_policies(policy_revision)
);
CREATE INDEX IF NOT EXISTS idx_methodology_project_rollout_current
  ON methodology_project_rollout_events(project_id, project_pin_revision DESC);

CREATE TABLE IF NOT EXISTS methodology_rollout_consumptions (
  project_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('knowledge-activation', 'assurance-execution')),
  subject_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  policy_hash TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('internal-fixture', 'opt-in-dev', 'opt-in-user')),
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (project_id, subject_kind, subject_id),
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (policy_revision) REFERENCES methodology_rollout_policies(policy_revision)
);

CREATE TRIGGER IF NOT EXISTS methodology_rollout_policies_no_update
BEFORE UPDATE ON methodology_rollout_policies BEGIN
  SELECT RAISE(ABORT, 'methodology_rollout_policies_append_only');
END;
CREATE TRIGGER IF NOT EXISTS methodology_rollout_policies_no_delete
BEFORE DELETE ON methodology_rollout_policies BEGIN
  SELECT RAISE(ABORT, 'methodology_rollout_policies_append_only');
END;
CREATE TRIGGER IF NOT EXISTS methodology_project_rollout_events_no_update
BEFORE UPDATE ON methodology_project_rollout_events BEGIN
  SELECT RAISE(ABORT, 'methodology_project_rollout_events_append_only');
END;
CREATE TRIGGER IF NOT EXISTS methodology_project_rollout_events_no_delete
BEFORE DELETE ON methodology_project_rollout_events BEGIN
  SELECT RAISE(ABORT, 'methodology_project_rollout_events_append_only');
END;
CREATE TRIGGER IF NOT EXISTS methodology_rollout_consumptions_no_update
BEFORE UPDATE ON methodology_rollout_consumptions BEGIN
  SELECT RAISE(ABORT, 'methodology_rollout_consumptions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS methodology_rollout_consumptions_no_delete
BEFORE DELETE ON methodology_rollout_consumptions BEGIN
  SELECT RAISE(ABORT, 'methodology_rollout_consumptions_append_only');
END;

INSERT OR IGNORE INTO methodology_rollout_policies
  (policy_revision, mode, policy_hash, actor_ref, created_at)
VALUES
  (${DEFAULT_METHODOLOGY_ROLLOUT_POLICY.revision}, '${DEFAULT_METHODOLOGY_ROLLOUT_POLICY.mode}', '${DEFAULT_METHODOLOGY_ROLLOUT_POLICY.policy_hash}', '${DEFAULT_METHODOLOGY_ROLLOUT_POLICY.actor_ref}', '${DEFAULT_METHODOLOGY_ROLLOUT_POLICY.created_at}');

INSERT INTO methodology_project_rollout_events
  (project_id, project_pin_revision, policy_revision, policy_hash, mode, actor_ref, pinned_at)
SELECT project_id, 1, ${DEFAULT_METHODOLOGY_ROLLOUT_POLICY.revision}, '${DEFAULT_METHODOLOGY_ROLLOUT_POLICY.policy_hash}', '${DEFAULT_METHODOLOGY_ROLLOUT_POLICY.mode}', 'system:migration-0032', updated_at
FROM projects
WHERE NOT EXISTS (
  SELECT 1 FROM methodology_project_rollout_events pin WHERE pin.project_id = projects.project_id
);

INSERT OR IGNORE INTO methodology_rollout_consumptions
  (project_id, subject_kind, subject_id, policy_revision, policy_hash, mode, pinned_at)
SELECT event.project_id, 'knowledge-activation', event.record_id,
  pin.policy_revision, pin.policy_hash, pin.mode, event.created_at
FROM methodology_project_events AS event
JOIN methodology_project_rollout_events AS pin ON pin.project_id = event.project_id
WHERE event.event_kind = 'knowledge_activation'
  AND pin.project_pin_revision = (
    SELECT MAX(current.project_pin_revision)
    FROM methodology_project_rollout_events AS current
    WHERE current.project_id = event.project_id
  );

INSERT OR IGNORE INTO methodology_rollout_consumptions
  (project_id, subject_kind, subject_id, policy_revision, policy_hash, mode, pinned_at)
SELECT event.project_id, 'assurance-execution', event.audit_id,
  pin.policy_revision, pin.policy_hash, pin.mode, event.created_at
FROM assurance_events AS event
JOIN methodology_project_rollout_events AS pin ON pin.project_id = event.project_id
WHERE event.event_type = 'audit_recorded'
  AND pin.project_pin_revision = (
    SELECT MAX(current.project_pin_revision)
    FROM methodology_project_rollout_events AS current
    WHERE current.project_id = event.project_id
  );

CREATE TRIGGER IF NOT EXISTS methodology_project_rollout_on_create
AFTER INSERT ON projects BEGIN
  INSERT INTO methodology_project_rollout_events
    (project_id, project_pin_revision, policy_revision, policy_hash, mode, actor_ref, pinned_at)
  SELECT NEW.project_id, 1, policy_revision, policy_hash, mode, 'system:project-create', NEW.created_at
  FROM methodology_rollout_policies ORDER BY policy_revision DESC LIMIT 1;
END;

CREATE TRIGGER IF NOT EXISTS methodology_rollout_policy_revision_contiguous
BEFORE INSERT ON methodology_rollout_policies
WHEN NEW.policy_revision != COALESCE((SELECT MAX(policy_revision) FROM methodology_rollout_policies), 0) + 1 BEGIN
  SELECT RAISE(ABORT, 'methodology_rollout_policy_revision_conflict');
END;
CREATE TRIGGER IF NOT EXISTS methodology_project_rollout_revision_contiguous
BEFORE INSERT ON methodology_project_rollout_events
WHEN NEW.project_pin_revision != COALESCE((
  SELECT MAX(project_pin_revision) FROM methodology_project_rollout_events WHERE project_id = NEW.project_id
), 0) + 1 BEGIN
  SELECT RAISE(ABORT, 'methodology_project_rollout_revision_conflict');
END;
CREATE TRIGGER IF NOT EXISTS methodology_project_rollout_policy_match
BEFORE INSERT ON methodology_project_rollout_events
WHEN NOT EXISTS (
  SELECT 1 FROM methodology_rollout_policies
  WHERE policy_revision = NEW.policy_revision AND policy_hash = NEW.policy_hash AND mode = NEW.mode
) BEGIN
  SELECT RAISE(ABORT, 'methodology_project_rollout_policy_mismatch');
END;
CREATE TRIGGER IF NOT EXISTS methodology_rollout_consumption_project_pin_match
BEFORE INSERT ON methodology_rollout_consumptions
WHEN NOT EXISTS (
  SELECT 1 FROM methodology_project_rollout_events
  WHERE project_id = NEW.project_id
    AND policy_revision = NEW.policy_revision
    AND policy_hash = NEW.policy_hash
    AND mode = NEW.mode
) BEGIN
  SELECT RAISE(ABORT, 'methodology_rollout_consumption_policy_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS methodology_activation_requires_rollout_pin
BEFORE INSERT ON methodology_project_events
WHEN NEW.event_kind = 'knowledge_activation' AND NOT EXISTS (
  SELECT 1 FROM methodology_project_rollout_events WHERE project_id = NEW.project_id
) BEGIN
  SELECT RAISE(ABORT, 'methodology_rollout_project_pin_missing');
END;
CREATE TRIGGER IF NOT EXISTS methodology_activation_rollout_consumption
AFTER INSERT ON methodology_project_events
WHEN NEW.event_kind = 'knowledge_activation' BEGIN
  INSERT INTO methodology_rollout_consumptions
    (project_id, subject_kind, subject_id, policy_revision, policy_hash, mode, pinned_at)
  SELECT NEW.project_id, 'knowledge-activation', NEW.record_id, policy_revision, policy_hash, mode, NEW.created_at
  FROM methodology_project_rollout_events
  WHERE project_id = NEW.project_id ORDER BY project_pin_revision DESC LIMIT 1;
END;

CREATE TRIGGER IF NOT EXISTS assurance_execution_requires_rollout_pin
BEFORE INSERT ON assurance_events
WHEN NEW.event_type = 'audit_recorded' AND NOT EXISTS (
  SELECT 1 FROM methodology_project_rollout_events WHERE project_id = NEW.project_id
) BEGIN
  SELECT RAISE(ABORT, 'methodology_rollout_project_pin_missing');
END;
CREATE TRIGGER IF NOT EXISTS assurance_execution_rollout_consumption
AFTER INSERT ON assurance_events
WHEN NEW.event_type = 'audit_recorded' BEGIN
  INSERT INTO methodology_rollout_consumptions
    (project_id, subject_kind, subject_id, policy_revision, policy_hash, mode, pinned_at)
  SELECT NEW.project_id, 'assurance-execution', NEW.audit_id, policy_revision, policy_hash, mode, NEW.created_at
  FROM methodology_project_rollout_events
  WHERE project_id = NEW.project_id ORDER BY project_pin_revision DESC LIMIT 1;
END;
`

export class MethodologyRolloutStoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'MethodologyRolloutStoreError'
  }
}

interface PolicyRow {
  policy_revision: number
  mode: string
  policy_hash: string
  actor_ref: string
  created_at: string
}

interface ProjectPinRow {
  project_id: string
  project_pin_revision: number
  policy_revision: number
  policy_hash: string
  mode: string
  actor_ref: string
  pinned_at: string
}

interface ConsumptionRow {
  project_id: string
  subject_kind: string
  subject_id: string
  policy_revision: number
  policy_hash: string
  mode: string
  pinned_at: string
}

export class MethodologyRolloutStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private parsePolicy(row: PolicyRow): MethodologyRolloutPolicyValue {
    const parsed = MethodologyRolloutPolicy.parse({
      revision: row.policy_revision,
      mode: row.mode,
      policy_hash: row.policy_hash,
      actor_ref: row.actor_ref,
      created_at: row.created_at,
    })
    if (parsed.policy_hash !== policyHash(parsed.revision, parsed.mode)) {
      throw new MethodologyRolloutStoreError(409, 'methodology_rollout_policy_hash_mismatch', 'rollout policy hash does not match its immutable facts')
    }
    return parsed
  }

  currentPolicy(): MethodologyRolloutPolicyValue {
    const row = this.db.prepare(
      'SELECT policy_revision, mode, policy_hash, actor_ref, created_at FROM methodology_rollout_policies ORDER BY policy_revision DESC LIMIT 1',
    ).get() as PolicyRow | undefined
    if (row === undefined) {
      throw new MethodologyRolloutStoreError(503, 'methodology_rollout_policy_missing', 'no methodology rollout policy is installed')
    }
    return this.parsePolicy(row)
  }

  updatePolicy(raw: MethodologyRolloutPolicyUpdateValue): MethodologyRolloutPolicyValue {
    const input = MethodologyRolloutPolicyUpdate.parse(raw)
    return this.transaction(() => {
      const current = this.currentPolicy()
      if (current.revision !== input.expected_revision) {
        throw new MethodologyRolloutStoreError(409, 'methodology_rollout_revision_conflict', `rollout policy revision ${current.revision} does not match expected ${input.expected_revision}`)
      }
      const revision = current.revision + 1
      const policy = MethodologyRolloutPolicy.parse({
        revision,
        mode: input.mode,
        policy_hash: policyHash(revision, input.mode),
        actor_ref: input.actor_ref,
        created_at: this.now(),
      })
      this.db.prepare(`INSERT INTO methodology_rollout_policies
        (policy_revision, mode, policy_hash, actor_ref, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(policy.revision, policy.mode, policy.policy_hash, policy.actor_ref, policy.created_at)
      return policy
    })
  }

  projectPin(projectId: string): ProjectMethodologyRolloutPinValue {
    const row = this.db.prepare(`SELECT project_id, project_pin_revision, policy_revision, policy_hash, mode, actor_ref, pinned_at
      FROM methodology_project_rollout_events WHERE project_id = ? ORDER BY project_pin_revision DESC LIMIT 1`)
      .get(projectId) as ProjectPinRow | undefined
    if (row === undefined) {
      throw new MethodologyRolloutStoreError(409, 'methodology_rollout_project_pin_missing', `project ${projectId} has no rollout policy pin`)
    }
    const pin = ProjectMethodologyRolloutPin.parse(row)
    const policyRow = this.db.prepare(`SELECT policy_revision, mode, policy_hash, actor_ref, created_at
      FROM methodology_rollout_policies WHERE policy_revision = ?`).get(pin.policy_revision) as PolicyRow | undefined
    if (policyRow === undefined || this.parsePolicy(policyRow).policy_hash !== pin.policy_hash || policyRow.mode !== pin.mode) {
      throw new MethodologyRolloutStoreError(409, 'methodology_rollout_project_pin_invalid', `project ${projectId} rollout pin does not match its policy`)
    }
    return pin
  }

  pinProject(raw: ProjectMethodologyRolloutPinRequestValue): ProjectMethodologyRolloutPinValue {
    const input = ProjectMethodologyRolloutPinRequest.parse(raw)
    return this.transaction(() => {
      const currentPin = this.projectPin(input.project_id)
      if (currentPin.project_pin_revision !== input.expected_project_pin_revision) {
        throw new MethodologyRolloutStoreError(409, 'methodology_rollout_project_pin_conflict', `project rollout pin revision ${currentPin.project_pin_revision} does not match expected ${input.expected_project_pin_revision}`)
      }
      const policy = this.currentPolicy()
      if (policy.revision !== input.expected_policy_revision || policy.policy_hash !== input.expected_policy_hash) {
        throw new MethodologyRolloutStoreError(409, 'methodology_rollout_policy_pin_conflict', 'requested rollout policy is not the current immutable policy')
      }
      const pin = ProjectMethodologyRolloutPin.parse({
        project_id: input.project_id,
        project_pin_revision: currentPin.project_pin_revision + 1,
        policy_revision: policy.revision,
        policy_hash: policy.policy_hash,
        mode: policy.mode,
        actor_ref: input.actor_ref,
        pinned_at: this.now(),
      })
      this.db.prepare(`INSERT INTO methodology_project_rollout_events
        (project_id, project_pin_revision, policy_revision, policy_hash, mode, actor_ref, pinned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(pin.project_id, pin.project_pin_revision, pin.policy_revision, pin.policy_hash, pin.mode, pin.actor_ref, pin.pinned_at)
      return pin
    })
  }

  consumptionPin(
    projectId: string,
    kind: MethodologyRolloutConsumptionKindValue,
    subjectId: string,
  ): MethodologyRolloutConsumptionPinValue {
    const parsedKind = MethodologyRolloutConsumptionKind.parse(kind)
    const row = this.db.prepare(`SELECT project_id, subject_kind, subject_id, policy_revision, policy_hash, mode, pinned_at
      FROM methodology_rollout_consumptions WHERE project_id = ? AND subject_kind = ? AND subject_id = ?`)
      .get(projectId, parsedKind, subjectId) as ConsumptionRow | undefined
    if (row === undefined) {
      throw new MethodologyRolloutStoreError(409, 'methodology_rollout_consumption_pin_missing', `${parsedKind} ${subjectId} has no rollout policy pin`)
    }
    const pin = MethodologyRolloutConsumptionPin.parse(row)
    const projectPin = this.db.prepare(`SELECT policy_revision, policy_hash, mode FROM methodology_project_rollout_events
      WHERE project_id = ? AND policy_revision = ? AND policy_hash = ? AND mode = ? LIMIT 1`)
      .get(pin.project_id, pin.policy_revision, pin.policy_hash, pin.mode)
    if (projectPin === undefined) {
      throw new MethodologyRolloutStoreError(409, 'methodology_rollout_consumption_pin_invalid', `${parsedKind} ${subjectId} rollout pin does not match project history`)
    }
    return pin
  }
}
