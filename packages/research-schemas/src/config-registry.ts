/**
 * CONFIG-01 — canonical Config Registry (hardening-v0.2-status.md §3 CONFIG-01,
 * docs/config-registry.md).
 *
 * Every runtime configuration item of the Research OS is declared ONCE here:
 * a dotted canonical key, a ConfigScope, a Zod schema, a default, secret and
 * security-floor markers, and the allowed sources (CLI/env/file/HTTP/UI).
 * The registry GENERATES the derived artifacts (JSON Schema, defaults
 * template, CLI help text) so they can never drift from the Zod schema, and
 * it VALIDATES effective configs: merge defaults, reject unknown keys,
 * enforce the security floor and pin the result with a sha256 hash that
 * changes whenever the effective config changes.
 *
 * Security floor (security-baseline.md §5, execution-runtime.md §5): Docker
 * socket mounts, `--privileged` containers and host networking are forbidden;
 * `execution.network_policy=none` forbids any container network other than
 * `none`; tokenless standalone mode is loopback-only; pinned image digests
 * must equal the committed images.lock entries.
 *
 * Secrets never leak into plaintext output: `validateConfig().redacted`
 * replaces secret values with `<redacted>` while the one-way `pinHash` still
 * commits them (a config change — including a secret change — changes the
 * pin).
 * @module @dsh-scholar/research-schemas/config-registry
 */

import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'

/**
 * ConfigScope of a canonical key. `global`/`project`/`job`/`runner-profile`
 * are the hierarchy layers (project < job < runner-profile); `kernel` and
 * `standalone` scope the two binaries that own their own CLI surface.
 */
export const ConfigScope = z.enum(['global', 'project', 'job', 'runner-profile', 'kernel', 'standalone'])
export type ConfigScope = z.infer<typeof ConfigScope>

export const CONFIG_SCOPES: readonly ConfigScope[] = ['global', 'project', 'job', 'runner-profile', 'kernel', 'standalone']

/** Where a key may be set. */
export type ConfigSource = 'cli' | 'env' | 'file' | 'http' | 'ui'

export interface ConfigCliFlag {
  /** CLI flag without leading dashes, e.g. 'poll-ms'. */
  flag: string
}

/**
 * One canonical config key. `key` is the dotted identifier used in
 * validateConfig() inputs, generated templates and the JSON Schema.
 */
export interface ConfigKeyDefinition {
  key: string
  scope: ConfigScope
  /** Zod schema of the VALUE (never includes `.default()` — defaults live
   * in `default` so generators can render them). */
  schema: z.ZodTypeAny
  default: unknown
  /** When true the value is a secret: redacted from all plaintext output
   * (only the one-way pin hash commits it). */
  secret?: boolean
  /** When true the key relaxes or pins part of the execution security floor
   * (container isolation, image digests, tokenless bind). Relaxing keys are
   * rejected by validateConfig() when the floor rule fires. */
  securityFloor?: boolean
  /** Allowed configuration sources (CLI/env/file/HTTP/UI). */
  sources: readonly ConfigSource[]
  /** Environment variable read when the key is not provided (when set). */
  env?: string
  /** CLI flag exposed by the binary owning this scope (when set). */
  cli?: ConfigCliFlag
  description: string
}

/** Digest shape of pinned image entries: `<image>@sha256:<64 hex>`. */
export const LOCKED_DIGEST_RE = /^[^\s@]+@sha256:[0-9a-f]{64}$/

/** Non-negative integer (millisecond / port style values). */
const ms = (max?: number): z.ZodNumber => {
  const base = z.number().int().nonnegative()
  return max === undefined ? base : base.max(max)
}

/**
 * The full canonical registry — every runtime config item the Research OS
 * actually runs today (ExecutionConfig + IntegrityConfig fields, kernel CLI,
 * runner CLI, standalone CLI, images.lock path/digests, network policy).
 * `job` scope is reserved for per-job policy keys and intentionally has no
 * entries yet: per-job timeouts/retention are currently derived from the
 * runner-profile scope and the job payload.
 */
export const CONFIG_REGISTRY: readonly ConfigKeyDefinition[] = [
  // ── global ───────────────────────────────────────────────────────────────
  {
    key: 'global.images_lock.path',
    scope: 'global',
    schema: z.string().min(1),
    default: 'configs/runner-profiles/images.lock.json',
    env: 'DSH_IMAGES_LOCK',
    sources: ['env', 'file'],
    description: 'Trusted image digest lock file (RUN-02): overridable via DSH_IMAGES_LOCK.',
  },
  {
    key: 'global.images_lock.node_fixture',
    scope: 'global',
    schema: z.string().regex(LOCKED_DIGEST_RE, 'image digest must be <image>@sha256:<64 hex>'),
    default: 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32',
    securityFloor: true,
    sources: ['file'],
    description: 'Pinned node fixture digest — must equal the images.lock node_fixture entry.',
  },
  {
    key: 'global.images_lock.texlive',
    scope: 'global',
    schema: z.string().regex(LOCKED_DIGEST_RE, 'image digest must be <image>@sha256:<64 hex>'),
    default: 'texlive/texlive@sha256:8957c916b8160049f89c24d362a6d86c09d8a04095acde37e88404c4afed85b4',
    securityFloor: true,
    sources: ['file'],
    description: 'Pinned TeX Live digest — must equal the images.lock texlive entry.',
  },

  // ── project (ExecutionConfig + IntegrityConfig, design §6.2) ─────────────
  {
    key: 'execution.runner_profile',
    scope: 'project',
    schema: z.enum(['local-docker-gpu', 'local-docker-cpu', 'isolated-subprocess']),
    default: 'local-docker-cpu',
    sources: ['http', 'ui', 'file'],
    description: 'Execution profile of the project.',
  },
  {
    key: 'execution.network_policy',
    scope: 'project',
    schema: z.enum(['allowlist', 'none']),
    default: 'allowlist',
    securityFloor: true,
    sources: ['http', 'ui', 'file'],
    description: 'Runner network policy; `none` forbids any container network other than none.',
  },
  {
    key: 'execution.artifact_store',
    scope: 'project',
    schema: z.enum(['local-cas']),
    default: 'local-cas',
    sources: ['http', 'ui', 'file'],
    description: 'Artifact store backing the project.',
  },
  {
    key: 'integrity.require_baseline_reproduction',
    scope: 'project',
    schema: z.boolean(),
    default: true,
    sources: ['http', 'ui', 'file'],
    description: 'Baseline reproduction is required before experiments.',
  },
  {
    key: 'integrity.require_experiment_contract',
    scope: 'project',
    schema: z.boolean(),
    default: true,
    sources: ['http', 'ui', 'file'],
    description: 'Approved experiment contracts are required for formal runs.',
  },
  {
    key: 'integrity.require_claim_evidence_links',
    scope: 'project',
    schema: z.boolean(),
    default: true,
    sources: ['http', 'ui', 'file'],
    description: 'Claims must link accepted evidence.',
  },
  {
    key: 'integrity.require_clean_room_rerun',
    scope: 'project',
    schema: z.boolean(),
    default: false,
    sources: ['http', 'ui', 'file'],
    description: 'Release requires a clean-room rerun.',
  },
  {
    key: 'integrity.allow_automatic_public_release',
    scope: 'project',
    schema: z.boolean(),
    default: false,
    securityFloor: true,
    sources: ['http', 'ui', 'file'],
    description: 'Automatic public release is forbidden by the security baseline (§1); the Release Gate is the only path.',
  },
  {
    key: 'integrity.require_signed_manifest',
    scope: 'project',
    schema: z.boolean(),
    default: false,
    sources: ['http', 'ui', 'file'],
    description: 'Project-level manifest signature requirement (§12.7); the kernel-level default is true.',
  },

  // ── job (reserved) ────────────────────────────────────────────────────────
  // No job-scope keys yet: per-job policy (timeout, log retention) is derived
  // from the runner-profile scope and the JobSpec payload. Reserved so the
  // scope layer and generated surfaces exist before the keys land.

  // ── runner-profile (runner-gateway CLI, design §12.6/§12.7) ───────────────
  {
    key: 'runner.kernel',
    scope: 'runner-profile',
    schema: z.string().min(1),
    default: 'http://127.0.0.1:7412',
    cli: { flag: 'kernel' },
    sources: ['cli', 'env', 'file'],
    description: 'Kernel endpoint the runner claims jobs from.',
  },
  {
    key: 'runner.mode',
    scope: 'runner-profile',
    schema: z.enum(['subprocess', 'docker']),
    default: 'subprocess',
    cli: { flag: 'mode' },
    securityFloor: true,
    sources: ['cli', 'env', 'file'],
    description: 'Execution mode; formal kinds are container-only (runtime enforced, execution-runtime.md §1).',
  },
  {
    key: 'runner.poll_ms',
    scope: 'runner-profile',
    schema: ms(),
    default: 2000,
    cli: { flag: 'poll-ms' },
    sources: ['cli', 'env', 'file'],
    description: 'Poll interval between claim cycles.',
  },
  {
    key: 'runner.timeout_ms',
    scope: 'runner-profile',
    schema: ms(),
    default: 60000,
    cli: { flag: 'timeout-ms' },
    sources: ['cli', 'env', 'file'],
    description: 'Per-job execution timeout.',
  },
  {
    key: 'runner.heartbeat_ms',
    scope: 'runner-profile',
    schema: ms(),
    default: 15000,
    cli: { flag: 'heartbeat-ms' },
    sources: ['cli', 'env', 'file'],
    description: 'Lease heartbeat interval while a job executes.',
  },
  {
    key: 'runner.cancel_poll_ms',
    scope: 'runner-profile',
    schema: ms(),
    default: 5000,
    cli: { flag: 'cancel-poll-ms' },
    sources: ['cli', 'env', 'file'],
    description: 'Cancel-watcher poll interval (terminates the real execution).',
  },
  {
    key: 'runner.owner',
    scope: 'runner-profile',
    schema: z.string(),
    default: '',
    cli: { flag: 'owner' },
    sources: ['cli', 'env', 'file'],
    description: 'Lease owner identity; a random runner-<id> is generated when empty.',
  },
  {
    key: 'runner.key_file',
    scope: 'runner-profile',
    schema: z.string(),
    default: '',
    cli: { flag: 'key-file' },
    sources: ['cli', 'env', 'file'],
    description: 'Ed25519 signing key file (0600); an ephemeral key is generated when absent.',
  },
  {
    key: 'runner.token',
    scope: 'runner-profile',
    schema: z.string(),
    default: '',
    secret: true,
    cli: { flag: 'token' },
    sources: ['cli', 'env', 'file'],
    description: 'Kernel bearer token for the runner client.',
  },
  {
    key: 'runner.service_token',
    scope: 'runner-profile',
    schema: z.string(),
    default: '',
    secret: true,
    cli: { flag: 'service-token' },
    env: 'DSH_SCHOLAR_SERVICE_TOKEN',
    sources: ['cli', 'env', 'file'],
    description: 'Service identity for internal kernel routes.',
  },
  {
    key: 'runner.network',
    scope: 'runner-profile',
    schema: z.enum(['none', 'bridge', 'host']),
    default: 'none',
    securityFloor: true,
    sources: ['file', 'http', 'ui'],
    description: 'Container network mode; `host` is forbidden by the security floor and `network_policy=none` allows only `none`.',
  },
  {
    key: 'runner.privileged',
    scope: 'runner-profile',
    schema: z.boolean(),
    default: false,
    securityFloor: true,
    sources: ['file', 'http', 'ui'],
    description: 'Privileged containers are forbidden by the security floor.',
  },
  {
    key: 'runner.docker_socket',
    scope: 'runner-profile',
    schema: z.boolean(),
    default: false,
    securityFloor: true,
    sources: ['file', 'http', 'ui'],
    description: 'Docker socket mounts are forbidden by the security floor.',
  },

  // ── kernel (research-kernel CLI / sidecar) ────────────────────────────────
  {
    key: 'kernel.host',
    scope: 'kernel',
    schema: z.string().min(1),
    default: '127.0.0.1',
    cli: { flag: 'host' },
    sources: ['cli', 'env', 'file'],
    description: 'Kernel HTTP listen host.',
  },
  {
    key: 'kernel.port',
    scope: 'kernel',
    schema: ms(65535),
    default: 7412,
    cli: { flag: 'port' },
    sources: ['cli', 'env', 'file'],
    description: 'Kernel HTTP listen port (0 = ephemeral, published via endpoint file).',
  },
  {
    key: 'kernel.token',
    scope: 'kernel',
    schema: z.string(),
    default: '',
    secret: true,
    cli: { flag: 'token' },
    env: 'DSH_SCHOLAR_KERNEL_TOKEN',
    sources: ['cli', 'env', 'file'],
    description: 'Kernel bearer token; never logged, never in argv when the env path is used.',
  },
  {
    key: 'kernel.service_token',
    scope: 'kernel',
    schema: z.string(),
    default: '',
    secret: true,
    cli: { flag: 'service-token' },
    env: 'DSH_SCHOLAR_SERVICE_TOKEN',
    sources: ['cli', 'env', 'file'],
    description: 'Internal-route service identity (x-service-token).',
  },
  {
    key: 'kernel.db',
    scope: 'kernel',
    schema: z.string(),
    default: '',
    cli: { flag: 'db' },
    sources: ['cli', 'env', 'file'],
    description: 'SQLite database path; empty = ephemeral temp database.',
  },
  {
    key: 'kernel.cas',
    scope: 'kernel',
    schema: z.string(),
    default: '.research-cas',
    cli: { flag: 'cas' },
    sources: ['cli', 'env', 'file'],
    description: 'CAS root for immutable artifacts.',
  },
  {
    key: 'kernel.endpoint_file',
    scope: 'kernel',
    schema: z.string(),
    default: '',
    cli: { flag: 'endpoint-file' },
    env: 'DSH_SCHOLAR_KERNEL_ENDPOINT_FILE',
    sources: ['cli', 'env', 'file'],
    description: '0600 endpoint identity file written after bind (SIDE-01).',
  },
  {
    key: 'kernel.require_signed_manifest',
    scope: 'kernel',
    schema: z.boolean(),
    default: true,
    securityFloor: true,
    sources: ['file', 'http', 'ui'],
    description: 'Reject unsigned run manifests at completion (RUN-01: default true).',
  },

  // ── standalone (research-ui BFF, design §15.2/§15.3) ─────────────────────
  {
    key: 'standalone.host',
    scope: 'standalone',
    schema: z.string().min(1),
    default: '127.0.0.1',
    cli: { flag: 'host' },
    sources: ['cli', 'file'],
    description: 'Standalone BFF listen host.',
  },
  {
    key: 'standalone.port',
    scope: 'standalone',
    schema: ms(65535),
    default: 18610,
    cli: { flag: 'port' },
    sources: ['cli', 'file'],
    description: 'Standalone BFF listen port.',
  },
  {
    key: 'standalone.kernel_port',
    scope: 'standalone',
    schema: ms(65535),
    default: 17413,
    cli: { flag: 'kernel-port' },
    sources: ['cli', 'file'],
    description: 'Research Kernel sidecar port spawned by the BFF.',
  },
  {
    key: 'standalone.data_dir',
    scope: 'standalone',
    schema: z.string(),
    default: '',
    cli: { flag: 'data-dir' },
    sources: ['cli', 'file'],
    description: 'Data directory (token/session/endpoint files); empty = DSH_HOME or ~/.dsh-scholar-standalone.',
  },
  {
    key: 'standalone.token',
    scope: 'standalone',
    schema: z.string(),
    default: '',
    secret: true,
    cli: { flag: 'token' },
    sources: ['cli', 'file'],
    description: 'Loopback bearer token; auto-generated and persisted 0600 when empty.',
  },
  {
    key: 'standalone.principal',
    scope: 'standalone',
    schema: z.string(),
    default: '',
    cli: { flag: 'principal' },
    sources: ['cli', 'file'],
    description: 'Operator principal identity (GOV-01 local resolver).',
  },
  {
    key: 'standalone.no_token',
    scope: 'standalone',
    schema: z.boolean(),
    default: false,
    cli: { flag: 'no-token' },
    securityFloor: true,
    sources: ['cli', 'file'],
    description: 'Tokenless mode — loopback bind only (127.0.0.0/8, ::1, localhost).',
  },
]

/** Registry index by canonical key. */
const BY_KEY: ReadonlyMap<string, ConfigKeyDefinition> = new Map(CONFIG_REGISTRY.map(def => [def.key, def]))

/** Look up one canonical key definition (undefined when unknown). */
export function getConfigKey(key: string): ConfigKeyDefinition | undefined {
  return BY_KEY.get(key)
}

/** All keys of one scope, in registry order. */
export function configKeysForScope(scope: ConfigScope): readonly ConfigKeyDefinition[] {
  return CONFIG_REGISTRY.filter(def => def.scope === scope)
}

/** The Zod schema of one canonical key (undefined when unknown). */
export function configKeySchema(key: string): z.ZodTypeAny | undefined {
  return BY_KEY.get(key)?.schema
}

/** Defaults for the given scopes (all scopes when omitted), as flat keys. */
export function defaultConfigForScopes(scopes?: readonly ConfigScope[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const def of CONFIG_REGISTRY) {
    if (scopes === undefined || scopes.includes(def.scope)) out[def.key] = def.default
  }
  return out
}

/** Error raised by validateConfig(). `key` is set for unknown/validation
 * errors; security-floor violations name the rule key. Messages never echo
 * secret values. */
export class ConfigRegistryError extends Error {
  readonly code: 'unknown_config_key' | 'validation_error' | 'security_floor_violation'
  readonly key?: string
  constructor(code: ConfigRegistryError['code'], key: string | undefined, message: string) {
    super(message)
    this.name = 'ConfigRegistryError'
    this.code = code
    this.key = key
  }
}

/** sha256 pin of a config object: canonical JSON (sorted keys) → one-way
 * digest. Deterministic: identical config ⇒ identical pin; any value change
 * ⇒ different pin. Secrets may be included — the pin is one-way and the
 * redacted view is what leaves the process. */
export function pinConfig(config: Record<string, unknown>): string {
  const canonical = JSON.stringify(config, Object.keys(config).sort())
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

/** Loopback-only bind test (security-baseline.md §9.2): 127.0.0.0/8, ::1,
 * localhost. Mirrors packages/dsh-research-ui standalone/security.ts. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === 'localhost.') return true
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
  return isIP(normalized) === 4 && normalized.split('.')[0] === '127'
}

/**
 * Security-floor rules over the merged effective config. Each rule returns
 * a violation message or null. Rules fire only when the keys they depend on
 * are part of the validated scope set (both `execution.network_policy` and
 * `runner.network` must be present for the network-policy rule).
 */
const SECURITY_FLOOR_RULES: ReadonlyArray<{ key: string; check: (cfg: Record<string, unknown>) => string | null }> = [
  {
    key: 'integrity.allow_automatic_public_release',
    check: cfg => cfg['integrity.allow_automatic_public_release'] === true
      ? 'integrity.allow_automatic_public_release=true is forbidden: automatic public release is banned by the security baseline (§1); the human Release Gate is the only path'
      : null,
  },
  {
    key: 'runner.privileged',
    check: cfg => cfg['runner.privileged'] === true
      ? 'runner.privileged=true is forbidden: privileged containers break the execution security floor (security-baseline.md §5)'
      : null,
  },
  {
    key: 'runner.docker_socket',
    check: cfg => cfg['runner.docker_socket'] === true
      ? 'runner.docker_socket=true is forbidden: Docker socket mounts break the execution security floor (security-baseline.md §5)'
      : null,
  },
  {
    key: 'runner.network',
    check: cfg => cfg['runner.network'] === 'host'
      ? 'runner.network=host is forbidden: host networking breaks the execution security floor (security-baseline.md §5, execution-runtime.md §5)'
      : null,
  },
  {
    key: 'execution.network_policy',
    check: cfg => cfg['execution.network_policy'] === 'none' && cfg['runner.network'] !== undefined && cfg['runner.network'] !== 'none'
      ? 'execution.network_policy=none forbids any container network other than none (runner.network must be none)'
      : null,
  },
  {
    key: 'standalone.no_token',
    check: cfg => cfg['standalone.no_token'] === true && !isLoopbackHost(String(cfg['standalone.host'] ?? '127.0.0.1'))
      ? '--no-token requires an explicit loopback --host (127.0.0.0/8, ::1, or localhost)'
      : null,
  },
  {
    key: 'global.images_lock.node_fixture',
    check: cfg => imagesLockViolation(cfg, 'node_fixture'),
  },
  {
    key: 'global.images_lock.texlive',
    check: cfg => imagesLockViolation(cfg, 'texlive'),
  },
]

function imagesLockViolation(cfg: Record<string, unknown>, kind: 'node_fixture' | 'texlive'): string | null {
  const key = `global.images_lock.${kind}`
  const value = cfg[key]
  const lock = cfg['__images_lock'] as Record<string, string> | undefined
  if (value === undefined) return null
  if (lock !== undefined && lock[kind] !== undefined && value !== lock[kind]) {
    return `${key} is not the trusted images.lock ${kind} entry (digest pinning, RUN-02)`
  }
  return null
}

/** Result of validateConfig(). `effective`/`byScope` carry real values
 * (secrets included — the caller decides what to persist); `redacted` is the
 * safe plaintext view (secrets replaced with `<redacted>`); `pinHash` is the
 * one-way sha256 of the effective config (changes with ANY config change). */
export interface ResolvedConfig {
  effective: Record<string, unknown>
  redacted: Record<string, unknown>
  byScope: Record<ConfigScope, Record<string, unknown>>
  pinHash: string
}

export interface ValidateConfigOptions {
  /** Restrict the applicable key set to these scopes. Input keys outside the
   * set are rejected as unknown. Defaults to ALL scopes. */
  scopes?: readonly ConfigScope[]
  /** Trusted images.lock entries ({node_fixture, texlive}); when provided,
   * digest keys must equal them exactly (RUN-02 pinning). */
  imagesLock?: Readonly<{ node_fixture?: string; texlive?: string }> | null
}

/**
 * Merge defaults + provided values, validate every value against the key's
 * Zod schema, reject unknown keys, enforce the security floor and pin the
 * effective config (sha256). Throws ConfigRegistryError on any violation.
 */
export function validateConfig(input: Record<string, unknown>, options: ValidateConfigOptions = {}): ResolvedConfig {
  const requestedScopes = options.scopes
  const applicable = requestedScopes === undefined
    ? CONFIG_REGISTRY
    : CONFIG_REGISTRY.filter(def => requestedScopes.includes(def.scope))
  const byKey = new Map(applicable.map(def => [def.key, def]))

  const effective: Record<string, unknown> = {}
  for (const def of applicable) effective[def.key] = def.default
  if (options.imagesLock !== undefined && options.imagesLock !== null) {
    effective['__images_lock'] = { node_fixture: options.imagesLock.node_fixture, texlive: options.imagesLock.texlive }
  }

  for (const [key, value] of Object.entries(input)) {
    const def = byKey.get(key)
    if (def === undefined) {
      throw new ConfigRegistryError('unknown_config_key', key,
        `unknown config key ${JSON.stringify(key)} (canonical registry: config-registry.ts)`)
    }
    const parsed = def.schema.safeParse(value)
    if (!parsed.success) {
      throw new ConfigRegistryError('validation_error', key,
        `invalid value for config key ${key}: ${parsed.error.issues.map(issue => issue.message).join('; ')}`)
    }
    effective[key] = parsed.data
  }

  for (const rule of SECURITY_FLOOR_RULES) {
    const violation = rule.check(effective)
    if (violation !== null) {
      throw new ConfigRegistryError('security_floor_violation', rule.key, violation)
    }
  }

  const pinHash = pinConfig(effective)

  const redacted: Record<string, unknown> = {}
  const byScope = {} as Record<ConfigScope, Record<string, unknown>>
  for (const scope of CONFIG_SCOPES) byScope[scope] = {}
  for (const def of applicable) {
    redacted[def.key] = def.secret === true ? '<redacted>' : effective[def.key]
    byScope[def.scope][def.key] = effective[def.key]
  }
  return { effective, redacted, byScope, pinHash }
}

// ── generated artifacts ────────────────────────────────────────────────────

type JsonSchemaNode = Record<string, unknown>

/** Narrow Zod→JSON Schema (draft-07) converter for the value types the
 * registry uses (string/number/boolean/enum/literal/array/object with
 * optional/default/nullable wrappers). Fails loud on anything else so
 * generated artifacts can never silently diverge from the registry. */
export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchemaNode {
  let s: z.ZodTypeAny = schema
  while (s instanceof z.ZodOptional || s instanceof z.ZodDefault || s instanceof z.ZodNullable) {
    s = (s as z.ZodOptional<z.ZodTypeAny> | z.ZodDefault<z.ZodTypeAny> | z.ZodNullable<z.ZodTypeAny>)._def.innerType
  }
  if (s instanceof z.ZodString) {
    const node: JsonSchemaNode = { type: 'string' }
    for (const check of s._def.checks) {
      if (check.kind === 'regex') node.pattern = String(check.regex)
      if (check.kind === 'min') node.minLength = check.value
      if (check.kind === 'max') node.maxLength = check.value
    }
    return node
  }
  if (s instanceof z.ZodNumber) {
    const node: JsonSchemaNode = { type: 'integer' }
    for (const check of s._def.checks) {
      if (check.kind === 'int') node.type = 'integer'
      if (check.kind === 'min') {
        if (check.inclusive === false) node.exclusiveMinimum = check.value
        else node.minimum = check.value
      }
      if (check.kind === 'max') {
        if (check.inclusive === false) node.exclusiveMaximum = check.value
        else node.maximum = check.value
      }
    }
    return node
  }
  if (s instanceof z.ZodBoolean) return { type: 'boolean' }
  if (s instanceof z.ZodEnum) {
    const values = [...s._def.values]
    const node: JsonSchemaNode = { enum: values }
    if (values.every(v => typeof v === 'string')) node.type = 'string'
    return node
  }
  if (s instanceof z.ZodNativeEnum) return { enum: [...Object.values(s._def.values)] }
  if (s instanceof z.ZodLiteral) return { const: s._def.value }
  if (s instanceof z.ZodArray) return { type: 'array', items: zodToJsonSchema(s._def.type) }
  if (s instanceof z.ZodUnion) return { anyOf: s._def.options.map(zodToJsonSchema) }
  if (s instanceof z.ZodObject) {
    const properties: Record<string, JsonSchemaNode> = {}
    const required: string[] = []
    for (const [name, field] of Object.entries(s.shape)) {
      properties[name] = zodToJsonSchema(field as z.ZodTypeAny)
      const unwrapped = field as z.ZodTypeAny
      const inner = unwrapped instanceof z.ZodOptional || unwrapped instanceof z.ZodDefault || unwrapped instanceof z.ZodNullable
        ? unwrapped._def.innerType
        : unwrapped
      const innerHasDefault = inner instanceof z.ZodDefault
      if (!(unwrapped instanceof z.ZodOptional || unwrapped instanceof z.ZodDefault || innerHasDefault)) required.push(name)
    }
    return { type: 'object', properties, required: required.length > 0 ? required : undefined, additionalProperties: false }
  }
  throw new Error(`zodToJsonSchema: unsupported zod type ${s.constructor.name}`)
}

/** JSON Schema (draft-07) of the whole registry (all scopes), nested by
 * dotted key segments. Leaf annotations: default, description, x-dsh-scope,
 * x-dsh-secret, x-dsh-security-floor. */
export function generateJsonSchema(): JsonSchemaNode {
  const scopeProperties: Record<string, JsonSchemaNode> = {}
  for (const scope of CONFIG_SCOPES) {
    const scopeKeys = CONFIG_REGISTRY.filter(def => def.scope === scope)
    if (scopeKeys.length === 0) {
      scopeProperties[scope] = { type: 'object', description: 'reserved scope — no keys yet', additionalProperties: false }
      continue
    }
    const root: JsonSchemaNode = { type: 'object', properties: {}, additionalProperties: false }
    for (const def of scopeKeys) {
      // The first key segment is the scope name itself (global/kernel/
      // standalone) or a subgroup of the scope (execution/integrity under
      // project, runner under runner-profile). Strip only the scope name.
      const segments = def.key.split('.')
      const inner = segments[0] === def.scope ? segments.slice(1) : segments
      let node = root
      for (const segment of inner.slice(0, -1)) {
        const child = (node.properties as Record<string, JsonSchemaNode>)[segment] ??
          { type: 'object', properties: {}, additionalProperties: false }
        ;(node.properties as Record<string, JsonSchemaNode>)[segment] = child
        node = child
      }
      const leaf = zodToJsonSchema(def.schema)
      leaf.description = def.description
      leaf.default = def.default
      leaf['x-dsh-scope'] = def.scope
      if (def.secret === true) leaf['x-dsh-secret'] = true
      if (def.securityFloor === true) leaf['x-dsh-security-floor'] = true
      if (def.env !== undefined) leaf['x-dsh-env'] = def.env
      ;(node.properties as Record<string, JsonSchemaNode>)[inner.at(-1) as string] = leaf
    }
    scopeProperties[scope] = root
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://dsh-scholar.dev/schemas/config-registry.json',
    title: 'DSH Scholar canonical config registry',
    description: 'Generated from packages/research-schemas/src/config-registry.ts — do not edit by hand.',
    type: 'object',
    properties: scopeProperties,
    additionalProperties: false,
  }
}

function yamlScalar(value: unknown): string {
  if (typeof value === 'string') {
    if (value === '') return "''"
    if (!/^[A-Za-z0-9._:/@-]+$/.test(value)) return JSON.stringify(value)
    return value
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (value === null) return 'null'
  return JSON.stringify(value)
}

/** Defaults template (YAML) of the registry — one canonical `key: default`
 * tree with scope sections. Written to configs/template.yml by generators. */
export function generateTemplateYaml(options: { scopes?: readonly ConfigScope[] } = {}): string {
  const scopes = options.scopes ?? CONFIG_SCOPES
  const lines: string[] = [
    '# DSH Scholar canonical config template (CONFIG-01).',
    '# GENERATED from packages/research-schemas/src/config-registry.ts — do not edit by hand.',
    '# Effective config = defaults + overrides, merged/validated/pinned by validateConfig().',
    '# Secret keys are never echoed in plaintext output; they only enter the one-way pin hash.',
    '',
  ]
  for (const scope of scopes) {
    const keys = CONFIG_REGISTRY.filter(def => def.scope === scope)
    lines.push(`${scope}:`)
    if (keys.length === 0) {
      lines.push('  # reserved scope — no keys yet (per-job policy is derived from runner-profile + job payload).')
      continue
    }
    interface TreeNode { children: Map<string, TreeNode>; leaf?: ConfigKeyDefinition }
    const root: TreeNode = { children: new Map() }
    for (const def of keys) {
      // The first key segment is the scope name itself (global/kernel/
      // standalone) or a subgroup of the scope (execution/integrity under
      // project, runner under runner-profile). Strip only the scope name.
      const segments = def.key.split('.')
      const inner = segments[0] === def.scope ? segments.slice(1) : segments
      let node = root
      for (const segment of inner.slice(0, -1)) {
        let child = node.children.get(segment)
        if (child === undefined) {
          child = { children: new Map() }
          node.children.set(segment, child)
        }
        node = child
      }
      const last = inner.at(-1) as string
      let leaf = node.children.get(last)
      if (leaf === undefined) {
        leaf = { children: new Map() }
        node.children.set(last, leaf)
      }
      leaf.leaf = def
    }
    const emit = (node: TreeNode, depth: number): void => {
      const indent = '  '.repeat(depth)
      for (const [segment, child] of node.children) {
        if (child.leaf !== undefined) {
          const def = child.leaf
          const markers = [
            def.secret === true ? 'secret' : null,
            def.securityFloor === true ? 'security-floor' : null,
          ].filter(Boolean).join(', ')
          lines.push(`${indent}# ${def.description}`)
          lines.push(`${indent}# sources: ${def.sources.join('/')}${markers !== '' ? `; ${markers}` : ''}`)
          lines.push(`${indent}${segment}: ${yamlScalar(def.default)}`)
        } else {
          lines.push(`${indent}${segment}:`)
          emit(child, depth + 1)
        }
      }
    }
    emit(root, 1)
    lines.push('')
  }
  return lines.join('\n')
}

/** CLI help text for one scope, generated from the registry `cli` flags —
 * binaries can print it from --help without a second source of truth. */
export function generateCliHelp(scope: ConfigScope): string {
  const keys = CONFIG_REGISTRY.filter(def => def.scope === scope && def.cli !== undefined)
  const lines: string[] = [`Options (${scope}):`]
  for (const def of keys) {
    const typeHint = def.secret === true ? '<secret>' : typeof def.default === 'number' ? '<number>' : '<string>'
    const defaultHint = typeof def.default === 'string' && def.default !== '' ? ` (default: ${def.default})` : ''
    const envHint = def.env !== undefined ? ` (env: ${def.env})` : ''
    const secretHint = def.secret === true ? ' [secret]' : ''
    lines.push(`  --${def.cli?.flag} ${typeHint}${secretHint} — ${def.description}${defaultHint}${envHint}`)
  }
  return lines.join('\n')
}
