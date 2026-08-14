# Schema migrations

The Research Kernel owns its schema version and ordered migration steps in
`packages/research-kernel/src/migrations.ts` (storage-migrations.md §8):

- `SCHEMA_VERSION` — the current database schema version (integer, currently 21
  after migrations 0001–0024).
- `MIGRATIONS` — the ordered, checksummed, idempotent migration steps
  (`0001_schema_v2_initial` … `0024_topology_cancelled_state`). Each step records
  `(id, checksum, applied_at, report_json)` in `schema_migrations`; re-running
  the same id+checksum is a no-op, a different checksum fails loud.
- The legacy v1 fixture for upgrade drills lives at
  `tests/fixtures/databases/v1-kernel.db` (rebuilt by
  `tests/fixtures/databases/build-v1-fixture.mjs`).

Open behavior (design §9.3): `openDatabase` (`packages/research-kernel/src/store.ts`)
runs WAL + foreign_keys + bounded busy_timeout, then runs pending migrations in
order and rejects a stored `schema_version` above the supported version loudly
(downgrade requires an explicit script).

## Adding a migration (v2+)

1. Append a new step to `MIGRATIONS` in `packages/research-kernel/src/migrations.ts`
   (`id: '0024_...'`, runnable body, checksum auto-derived).
   Note (STORE-08): a released step's canonical `body` must bind the DDL it
   actually executes — migrations that run shared DDL constants embed a FROZEN
   inline snapshot (see 0003's `TERMINAL_DDL_0003`/`TEX_DDL_0003`); never
   reference the evolving shared constants from a released step.
   Note (0017): a step may receive an optional `MigrationContext`
   (`{ casRoot }` via `runMigrations(db, log, casRoot)` / `openDatabase(path,
   log, casRoot)`) to materialize real CAS blobs; released steps must keep
   working when it is absent.
2. Bump `SCHEMA_VERSION` to the next integer.
3. Never edit an already-released step; new changes are new versions
   (storage-migrations.md §8.1).
4. Add/refresh an upgrade-drill test under `tests/unit/migrations.test.ts`.

## Policy

- No in-place edits to a released migration; new changes are new versions.
- Kernel DB is the authority; DSH session format changes never migrate it
  (design §2.2).
