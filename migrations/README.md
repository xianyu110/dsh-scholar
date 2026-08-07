# Schema migrations

The Research Kernel owns its schema version in `packages/research-kernel/src/store.ts`:

- `SCHEMA_VERSION` — the current database schema version (integer).
- `MIGRATION_V1` — the initial schema: projects, gates, decisions, ideas,
  contracts, corpus_snapshots, artifacts, jobs, evidence, claims, events,
  session_links, budget, manuscripts, meta.

Open behavior (design §9.3): `openDatabase` verifies the stored
`schema_version` matches `SCHEMA_VERSION` and rejects mismatches loudly.

## Adding a migration (v2+)

1. Append `MIGRATION_V2 = \`ALTER TABLE ...\`` (plus indexes) in `store.ts`.
2. Bump `SCHEMA_VERSION` to 2.
3. In `openDatabase`, run the pending migrations in order after `MIGRATION_V1`,
   then update `meta.schema_version`.
4. Add a fixture + upgrade drill test under `tests/unit/`.

## Policy

- No in-place edits to a released migration; new changes are new versions.
- Kernel DB is the authority; DSH session format changes never migrate it
  (design §2.2).
