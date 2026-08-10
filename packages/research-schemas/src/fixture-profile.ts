/**
 * FixtureProfile — registered full-auto fixtures (reconstruction-contracts.md
 * §5, security-baseline.md §1 "full-auto | fixture-only").
 *
 * full-auto mode is ONLY valid for deterministic, registered fixtures:
 *
 *  - Project create and Job submit BOTH validate fixture_id (kernel side);
 *  - the profile pins fixed code/data/image/expected outputs;
 *  - secret / private data / external release are FORBIDDEN by construction
 *    (`allow_private_data=false`, `allow_external_release=false`,
 *    `automatic_release=false` are z.literal-forced, never overridable);
 *  - fixture Jobs must not reference Artifacts outside the profile
 *    (data_artifact_ids resolve to profile.data content hashes; image_digest
 *    must equal profile.image).
 * @module @dsh-scholar/research-schemas
 */

import { z } from 'zod'

export const FixtureProfile = z.object({
  fixture_id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  /** Fixed code identity. `commit` is a git commit when available;
   * in-repo fixtures pin the tree instead and declare `commit: 'in-repo'`.
   * `archive_sha256` pins the code snapshot ARCHIVE content hash when the
   * archive is deterministic (null = identity-only, in-project rule still
   * applies via code_snapshot_required). */
  code: z.object({
    repo: z.string().min(1),
    commit: z.string().min(1),
    archive_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'archive sha256 must be sha256:<64 hex>').nullable().default(null),
  }),
  /** Fixed data inputs by CONTENT hash (sha256:<64 hex>); the kernel
   * resolves each full-auto job's data_artifact_ids to blob hashes and
   * requires membership here. Empty = the fixture carries no external data. */
  data: z.array(z.object({
    name: z.string().min(1),
    sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'data sha256 must be sha256:<64 hex>'),
  })).default([]),
  /** Pinned execution image (must equal a trusted images.lock entry). */
  image: z.string().regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/, 'image must be <image>@sha256:<64 hex>'),
  /** Metric names the fixture's MetricsFileV1 is expected to contain. */
  expected_outputs: z.array(z.string()).default([]),
  // ── forced guard rails (never overridable by any project) ────────────────
  automatic_release: z.literal(false),
  allow_private_data: z.literal(false),
  allow_external_release: z.literal(false),
})
export type FixtureProfile = z.infer<typeof FixtureProfile>

/**
 * The registered fixture set. New fixtures are added here ONLY after their
 * acceptance path (deterministic metrics + expected analysis vector + TeX
 * fixture) is committed — acceptance preflight must never auto-download
 * unknown code (reconstruction-contracts.md §13).
 */
export const FIXTURE_PROFILES: readonly FixtureProfile[] = [
  FixtureProfile.parse({
    fixture_id: 'golden-path-v2',
    label: 'Golden Path v2 fixture',
    description: 'Deterministic in-repo fixture (evals/golden-path-v2/fixture-repo): baseline/train scripts over the bundled public data, pinned node image, expected output metric m1.',
    code: {
      repo: 'evals/golden-path-v2/fixture-repo',
      commit: 'in-repo',
    },
    data: [],
    image: 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32',
    expected_outputs: ['m1'],
    // forced guard rails — full-auto fixtures never release, never touch
    // private data, never publish externally.
    automatic_release: false,
    allow_private_data: false,
    allow_external_release: false,
  }),
]

/** Resolve a registered fixture profile by id; null when unregistered. */
export function getFixtureProfile(fixtureId: string): FixtureProfile | null {
  if (fixtureId === '' ) return null
  return FIXTURE_PROFILES.find(f => f.fixture_id === fixtureId) ?? null
}
