/** Configurable execution targets (EXEC-ENV-02). */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { SecretRef } from './provider.js'
import { DockerRuntime, type DockerRuntime as DockerRuntimeType } from './runner-environment.js'

export const RunnerTargetKind = z.enum(['local-process', 'local-docker', 'remote-ssh'])
export type RunnerTargetKind = z.infer<typeof RunnerTargetKind>

export const RunnerTargetConnection = z.object({
  /** Server-side JSON containing host, port and user; never returned inline. */
  endpoint: SecretRef,
  /** Private key/certificate reference. */
  credential: SecretRef,
  /** Pinned known_hosts/host CA reference; StrictHostKeyChecking is mandatory. */
  known_hosts: SecretRef,
}).strict()
export type RunnerTargetConnection = z.infer<typeof RunnerTargetConnection>

function validateKindConnection(
  value: { kind: RunnerTargetKind; connection?: RunnerTargetConnection | null; runtime?: DockerRuntimeType | null },
  ctx: z.RefinementCtx,
): void {
  if (value.kind === 'remote-ssh' && value.connection === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['connection'], message: 'remote-ssh requires endpoint, credential and known_hosts SecretRefs' })
  }
  if (value.kind !== 'remote-ssh' && value.connection !== undefined && value.connection !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['connection'], message: 'local targets cannot carry remote connection metadata' })
  }
  if (value.kind === 'local-process' && value.runtime !== undefined && value.runtime !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['runtime'], message: 'local-process cannot carry Docker runtime configuration' })
  }
}

export const RunnerTargetCreateInput = z.object({
  target_id: z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  display_name: z.string().min(1).max(120),
  kind: RunnerTargetKind,
  enabled: z.boolean().default(true),
  draining: z.boolean().default(false),
  capabilities: z.array(z.string().min(1).max(120)).max(128).default([]),
  runtime: DockerRuntime.optional(),
  connection: RunnerTargetConnection.optional(),
}).strict().superRefine((value, ctx) => {
  validateKindConnection(value, ctx)
})
export type RunnerTargetCreateInput = z.infer<typeof RunnerTargetCreateInput>

export const RunnerTargetUpdateInput = z.object({
  expected_revision: z.number().int().positive(),
  display_name: z.string().min(1).max(120).optional(),
  kind: RunnerTargetKind.optional(),
  enabled: z.boolean().optional(),
  draining: z.boolean().optional(),
  capabilities: z.array(z.string().min(1).max(120)).max(128).optional(),
  runtime: DockerRuntime.nullable().optional(),
  connection: RunnerTargetConnection.nullable().optional(),
}).strict()
export type RunnerTargetUpdateInput = z.infer<typeof RunnerTargetUpdateInput>

export const RunnerTargetDescriptor = z.object({
  target_id: z.string().min(1),
  display_name: z.string().min(1),
  kind: RunnerTargetKind,
  enabled: z.boolean(),
  draining: z.boolean(),
  capabilities: z.array(z.string()),
  runtime: DockerRuntime.optional(),
  connection: RunnerTargetConnection.optional(),
  health: z.enum(['unknown', 'online', 'offline']).default('unknown'),
  last_seen_at: z.string().nullable().default(null),
  revision: z.number().int().positive(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict().superRefine((value, ctx) => {
  validateKindConnection(value, ctx)
})
export type RunnerTargetDescriptor = z.infer<typeof RunnerTargetDescriptor>

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function runnerTargetConfigHash(target: RunnerTargetDescriptor): string {
  return `sha256:${createHash('sha256').update(canonical({
    target_id: target.target_id,
    display_name: target.display_name,
    kind: target.kind,
    enabled: target.enabled,
    draining: target.draining,
    capabilities: target.capabilities,
    connection: target.connection,
    ...(target.runtime === undefined ? {} : { runtime: target.runtime }),
    revision: target.revision,
  })).digest('hex')}`
}

export type RunnerTargetSafeView = Omit<RunnerTargetDescriptor, 'connection'> & {
  config_hash: string
  connection?: {
    endpoint: z.infer<typeof SecretRef> & { available: boolean }
    credential: z.infer<typeof SecretRef> & { available: boolean }
    known_hosts: z.infer<typeof SecretRef> & { available: boolean }
  }
}

export function runnerTargetSafeView(
  target: RunnerTargetDescriptor,
  available: (ref: z.infer<typeof SecretRef>) => boolean,
): RunnerTargetSafeView {
  const connection = target.connection === undefined ? undefined : {
    endpoint: { ...target.connection.endpoint, available: available(target.connection.endpoint) },
    credential: { ...target.connection.credential, available: available(target.connection.credential) },
    known_hosts: { ...target.connection.known_hosts, available: available(target.connection.known_hosts) },
  }
  return { ...target, connection, config_hash: runnerTargetConfigHash(target) }
}

export const BUILTIN_RUNNER_TARGETS: readonly RunnerTargetDescriptor[] = [
  RunnerTargetDescriptor.parse({
    target_id: 'target_local_process_v1', display_name: 'Local process (trusted dev/smoke only)', kind: 'local-process',
    enabled: true, draining: false, capabilities: ['trusted-smoke-fixture-only'], revision: 1,
    created_by: 'builtin', created_at: '1970-01-01T00:00:00.000Z', updated_at: '1970-01-01T00:00:00.000Z',
  }),
  RunnerTargetDescriptor.parse({
    target_id: 'target_local_docker_v1', display_name: 'Local Docker', kind: 'local-docker',
    enabled: true, draining: false, capabilities: ['linux', 'docker', 'cpu'], revision: 1,
    created_by: 'builtin', created_at: '1970-01-01T00:00:00.000Z', updated_at: '1970-01-01T00:00:00.000Z',
  }),
]
