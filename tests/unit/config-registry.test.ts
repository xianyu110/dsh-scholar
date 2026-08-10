/**
 * CONFIG-01 — canonical Config Registry unit tests (hardening-v0.2-status.md
 * §3 CONFIG-01; docs/config-registry.md; acceptance-tests.md §11 config-*).
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  CONFIG_REGISTRY, CONFIG_SCOPES, ConfigRegistryError, ExecutionConfig, IntegrityConfig,
  configKeysForScope, defaultConfigForScopes, generateCliHelp, generateJsonSchema,
  generateTemplateYaml, getConfigKey, isLoopbackHost, pinConfig, validateConfig,
  zodToJsonSchema,
} from '@dsh-scholar/research-schemas'

describe('config registry — key coverage', () => {
  it('registry covers every current runtime config item', () => {
    const keys = new Set(CONFIG_REGISTRY.map(def => def.key))
    // ExecutionConfig + IntegrityConfig full field coverage.
    for (const key of Object.keys(ExecutionConfig.shape)) expect(keys.has(`execution.${key}`)).toBe(true)
    for (const key of Object.keys(IntegrityConfig.shape)) expect(keys.has(`integrity.${key}`)).toBe(true)
    // kernel CLI (port/host/token/service-token/db/cas/endpoint-file).
    for (const key of ['kernel.host', 'kernel.port', 'kernel.token', 'kernel.service_token', 'kernel.db', 'kernel.cas', 'kernel.endpoint_file']) {
      expect(keys.has(key)).toBe(true)
    }
    // runner CLI (poll/heartbeat/timeout/cancel/owner/mode/kernel/key-file).
    for (const key of ['runner.poll_ms', 'runner.heartbeat_ms', 'runner.timeout_ms', 'runner.cancel_poll_ms', 'runner.owner', 'runner.mode', 'runner.kernel', 'runner.key_file']) {
      expect(keys.has(key)).toBe(true)
    }
    // standalone CLI (--host/--port/--token/--principal/--data-dir/--kernel-port/--no-token).
    for (const key of ['standalone.host', 'standalone.port', 'standalone.token', 'standalone.principal', 'standalone.data_dir', 'standalone.kernel_port', 'standalone.no_token']) {
      expect(keys.has(key)).toBe(true)
    }
    // images.lock path + digests + network_policy.
    for (const key of ['global.images_lock.path', 'global.images_lock.node_fixture', 'global.images_lock.texlive', 'execution.network_policy']) {
      expect(keys.has(key)).toBe(true)
    }
  })

  it('registry invariants: unique keys, valid scopes, schema+default present', () => {
    const seen = new Set<string>()
    for (const def of CONFIG_REGISTRY) {
      expect(seen.has(def.key)).toBe(false)
      seen.add(def.key)
      expect(CONFIG_SCOPES).toContain(def.scope)
      expect(def.schema).toBeDefined()
      expect(def.default).toBeDefined()
      expect(def.description.length).toBeGreaterThan(0)
      expect(def.sources.length).toBeGreaterThan(0)
      if (def.secret === true) expect(typeof def.default).toBe('string')
    }
    // every key is reachable through the lookups
    expect(CONFIG_REGISTRY.length).toBe(configKeysForScope('global').length + configKeysForScope('project').length +
      configKeysForScope('job').length + configKeysForScope('runner-profile').length +
      configKeysForScope('kernel').length + configKeysForScope('standalone').length)
    for (const def of CONFIG_REGISTRY) expect(getConfigKey(def.key)?.key).toBe(def.key)
    expect(getConfigKey('does.not.exist')).toBeUndefined()
    expect(CONFIG_SCOPES).toEqual(['global', 'project', 'job', 'runner-profile', 'kernel', 'standalone'])
  })

  it('every zod schema accepts its own default and rejects a wrong type', () => {
    for (const def of CONFIG_REGISTRY) {
      expect(def.schema.safeParse(def.default).success).toBe(true)
      if (typeof def.default === 'number') {
        expect(def.schema.safeParse('nope').success).toBe(false)
      } else if (typeof def.default === 'boolean') {
        expect(def.schema.safeParse('nope').success).toBe(false)
      } else if (typeof def.default === 'string') {
        expect(def.schema.safeParse(42).success).toBe(false)
      }
    }
  })
})

describe('config registry — validateConfig', () => {
  it('merges defaults for the requested scopes', () => {
    const resolved = validateConfig({}, { scopes: ['project'] })
    expect(resolved.effective['execution.runner_profile']).toBe('local-docker-cpu')
    expect(resolved.effective['execution.network_policy']).toBe('allowlist')
    expect(resolved.effective['execution.artifact_store']).toBe('local-cas')
    expect(resolved.effective['integrity.require_baseline_reproduction']).toBe(true)
    expect(resolved.effective['integrity.require_clean_room_rerun']).toBe(false)
    expect(resolved.effective['integrity.require_signed_manifest']).toBe(false)
    // out-of-scope keys are NOT merged in
    expect(resolved.effective['kernel.port']).toBeUndefined()
    expect(resolved.effective['runner.poll_ms']).toBeUndefined()
  })

  it('overrides win over defaults and are validated', () => {
    const resolved = validateConfig({ 'execution.runner_profile': 'local-docker-gpu', 'runner.poll_ms': 3000 })
    expect(resolved.effective['execution.runner_profile']).toBe('local-docker-gpu')
    expect(resolved.effective['runner.poll_ms']).toBe(3000)
    expect(() => validateConfig({ 'runner.poll_ms': -5 })).toThrow(ConfigRegistryError)
    expect(() => validateConfig({ 'execution.runner_profile': 'not-a-profile' })).toThrow(/invalid value/)
    expect(() => validateConfig({ 'kernel.port': 99999 })).toThrow(ConfigRegistryError)
  })

  it('rejects unknown keys (and out-of-scope keys)', () => {
    expect(() => validateConfig({ 'execution.bogus': 1 })).toThrowError(/unknown config key/)
    try {
      validateConfig({ 'execution.bogus': 1 })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigRegistryError)
      expect((error as ConfigRegistryError).code).toBe('unknown_config_key')
      expect((error as ConfigRegistryError).key).toBe('execution.bogus')
    }
    expect(() => validateConfig({ 'runner.poll_ms': 2000 }, { scopes: ['project'] })).toThrowError(/unknown config key/)
  })

  it('groups effective values by scope', () => {
    const resolved = validateConfig({}, { scopes: ['project', 'kernel'] })
    expect(resolved.byScope.project['execution.runner_profile']).toBe('local-docker-cpu')
    expect(resolved.byScope.kernel['kernel.port']).toBe(7412)
    expect(Object.keys(resolved.byScope)).toEqual(CONFIG_SCOPES)
  })

  it('zod schemas of project keys agree with ExecutionConfig/IntegrityConfig defaults', () => {
    const resolved = validateConfig({}, { scopes: ['project'] })
    const execution = ExecutionConfig.parse({})
    const integrity = IntegrityConfig.parse({})
    for (const [key, value] of Object.entries(execution)) {
      expect(resolved.effective[`execution.${key}`]).toEqual(value)
    }
    for (const [key, value] of Object.entries(integrity)) {
      expect(resolved.effective[`integrity.${key}`]).toEqual(value)
    }
  })
})

describe('config registry — secrets and pin hash', () => {
  it('redacts secret values from plaintext output but commits them in the pin', () => {
    const secret = 'dsh-super-secret-token-123'
    const resolved = validateConfig({ 'kernel.service_token': secret })
    expect(resolved.redacted['kernel.service_token']).toBe('<redacted>')
    expect(resolved.effective['kernel.service_token']).toBe(secret)
    expect(JSON.stringify(resolved.redacted)).not.toContain(secret)
    // the pin commits the secret one-way: identical config → identical pin
    const again = validateConfig({ 'kernel.service_token': secret })
    expect(again.pinHash).toBe(resolved.pinHash)
    // changing the secret changes the pin
    const changed = validateConfig({ 'kernel.service_token': `${secret}-x` })
    expect(changed.pinHash).not.toBe(resolved.pinHash)
    // defaults for secret keys are redacted too
    expect(validateConfig({}).redacted['kernel.token']).toBe('<redacted>')
    expect(validateConfig({}).redacted['standalone.token']).toBe('<redacted>')
    expect(validateConfig({}).redacted['runner.service_token']).toBe('<redacted>')
  })

  it('pin hash is stable and sensitive to any change', () => {
    expect(pinConfig({ a: 1, b: 'x' })).toBe(pinConfig({ b: 'x', a: 1 }))
    expect(pinConfig({ a: 1, b: 'x' })).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(pinConfig({ a: 1, b: 'x' })).not.toBe(pinConfig({ a: 1, b: 'y' }))
    expect(pinConfig({ a: 1, b: 'x' })).not.toBe(pinConfig({ a: 1 }))
    const base = validateConfig({}).pinHash
    const tweaked = validateConfig({ 'runner.poll_ms': 3000 }).pinHash
    expect(tweaked).not.toBe(base)
    // revalidation is deterministic
    expect(validateConfig({ 'runner.poll_ms': 3000 }).pinHash).toBe(tweaked)
  })
})

describe('config registry — security floor', () => {
  it('forbids privileged containers, docker socket and host networking', () => {
    for (const bad of [
      { 'runner.privileged': true },
      { 'runner.docker_socket': true },
      { 'runner.network': 'host' },
    ]) {
      try {
        validateConfig(bad)
        expect.unreachable(`should reject ${JSON.stringify(bad)}`)
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigRegistryError)
        expect((error as ConfigRegistryError).code).toBe('security_floor_violation')
      }
    }
    // safe defaults pass
    expect(validateConfig({}).pinHash).toMatch(/^sha256:/)
  })

  it('forbids automatic public release (security-baseline.md §1)', () => {
    try {
      validateConfig({ 'integrity.allow_automatic_public_release': true })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigRegistryError)
      expect((error as ConfigRegistryError).code).toBe('security_floor_violation')
      expect((error as Error).message).toContain('automatic public release')
    }
    // the schema default (false) passes
    expect(validateConfig({ 'integrity.allow_automatic_public_release': false }).pinHash).toMatch(/^sha256:/)
  })

  it('network_policy=none forbids any container network other than none', () => {
    // 'bridge' is legal under allowlist but a violation under network_policy=none
    expect(validateConfig({ 'execution.network_policy': 'allowlist', 'runner.network': 'bridge' }).pinHash).toMatch(/^sha256:/)
    try {
      validateConfig({ 'execution.network_policy': 'none', 'runner.network': 'bridge' })
      expect.unreachable()
    } catch (error) {
      expect((error as ConfigRegistryError).code).toBe('security_floor_violation')
      expect((error as Error).message).toContain('network_policy=none')
    }
    // host networking is a violation regardless of policy
    try {
      validateConfig({ 'execution.network_policy': 'allowlist', 'runner.network': 'host' })
      expect.unreachable()
    } catch (error) {
      expect((error as ConfigRegistryError).code).toBe('security_floor_violation')
    }
    // none + none is legal
    expect(validateConfig({ 'execution.network_policy': 'none', 'runner.network': 'none' }).pinHash).toMatch(/^sha256:/)
  })

  it('tokenless standalone mode is loopback-only', () => {
    try {
      validateConfig({ 'standalone.no_token': true, 'standalone.host': '0.0.0.0' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigRegistryError)
      expect((error as ConfigRegistryError).code).toBe('security_floor_violation')
      expect((error as Error).message).toMatch(/loopback/)
    }
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(validateConfig({ 'standalone.no_token': true, 'standalone.host': host }).pinHash).toMatch(/^sha256:/)
    }
    expect(isLoopbackHost('127.8.9.10')).toBe(true)
    expect(isLoopbackHost('192.168.1.1')).toBe(false)
    expect(isLoopbackHost('::1')).toBe(true)
  })

  it('image digests must match the trusted images.lock entries when a lock is supplied', () => {
    const lock = { node_fixture: 'node@sha256:' + 'a'.repeat(64), texlive: 'texlive/texlive@sha256:' + 'b'.repeat(64) }
    // shape-only validation passes a well-formed digest
    expect(validateConfig({ 'global.images_lock.node_fixture': 'node@sha256:' + 'c'.repeat(64) }).pinHash).toMatch(/^sha256:/)
    expect(() => validateConfig({ 'global.images_lock.node_fixture': 'node:22-alpine' })).toThrow(/digest/)
    // with a lock, a foreign digest is a security-floor violation
    try {
      validateConfig({ 'global.images_lock.node_fixture': 'node@sha256:' + 'c'.repeat(64) }, { imagesLock: lock })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigRegistryError)
      expect((error as ConfigRegistryError).code).toBe('security_floor_violation')
      expect((error as Error).message).toContain('images.lock node_fixture')
    }
    // exact lock entries pass
    const ok = validateConfig({ 'global.images_lock.node_fixture': lock.node_fixture, 'global.images_lock.texlive': lock.texlive }, { imagesLock: lock })
    expect(ok.pinHash).toMatch(/^sha256:/)
  })

  it('registers the floor keys as security-floor flagged', () => {
    const floor = CONFIG_REGISTRY.filter(def => def.securityFloor === true).map(def => def.key)
    for (const key of ['runner.privileged', 'runner.docker_socket', 'runner.network', 'execution.network_policy',
      'standalone.no_token', 'global.images_lock.node_fixture', 'global.images_lock.texlive',
      'kernel.require_signed_manifest', 'integrity.allow_automatic_public_release', 'runner.mode']) {
      expect(floor).toContain(key)
    }
  })
})

describe('config registry — generated artifacts', () => {
  it('JSON Schema nests every registry key with type/enum/default and parity annotations', () => {
    const schema = generateJsonSchema()
    const text = JSON.stringify(schema)
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#')
    expect(schema.additionalProperties).toBe(false)
    const rootProps = (schema.properties as Record<string, { properties?: Record<string, unknown> }>)
    for (const def of CONFIG_REGISTRY) {
      // JSON Schema nests by SCOPE first; inner segments are the key minus
      // the scope name when the key starts with it (execution.*/integrity.*
      // are subgroups of the project scope and keep their prefix).
      const keySegments = def.key.split('.')
      const segments = keySegments[0] === def.scope ? keySegments.slice(1) : keySegments
      let node = rootProps[def.scope]
      expect(node, `scope ${def.scope} for ${def.key}`).toBeDefined()
      for (const segment of segments) {
        node = (node?.properties ?? {})[segment] as typeof node
      }
      expect(node, `leaf ${def.key}`).toBeDefined()
      expect(node?.type).toBeDefined()
      expect(node?.description).toBe(def.description)
      expect(node?.default).toEqual(def.default)
      expect(node?.['x-dsh-scope']).toBe(def.scope)
      if (def.secret === true) expect(node?.['x-dsh-secret']).toBe(true)
      if (def.securityFloor === true) expect(node?.['x-dsh-security-floor']).toBe(true)
    }
    // enum keys carry an enum; the network enum lists the floor modes
    const net = rootProps['runner-profile']?.properties?.runner?.properties?.network as { enum?: string[] }
    expect(net.enum).toEqual(['none', 'bridge', 'host'])
    expect(text).not.toContain('<redacted>')
  })

  it('template YAML lists every key with its default and markers', () => {
    const yaml = generateTemplateYaml()
    for (const def of CONFIG_REGISTRY) {
      const segments = def.key.split('.')
      const last = segments.at(-1) as string
      expect(yaml).toContain(`${last}: ${def.default}`)
      expect(yaml).toContain(def.description)
    }
    for (const scope of CONFIG_SCOPES) expect(yaml).toContain(`${scope}:`)
    expect(yaml).toContain('GENERATED from packages/research-schemas/src/config-registry.ts')
    // secret keys carry the marker and appear as leaf lines (no dotted key in YAML)
    expect(yaml).toContain('kernel:')
    expect(yaml).toContain('token: ')
    expect(yaml).toContain('secret')
    // scope filter works
    const projectOnly = generateTemplateYaml({ scopes: ['project'] })
    expect(projectOnly).toContain('execution:')
    expect(projectOnly).toContain('integrity:')
    expect(projectOnly).not.toContain('poll_ms')
  })

  it('CLI help text is generated per scope from the registry flags', () => {
    const kernelHelp = generateCliHelp('kernel')
    expect(kernelHelp).toContain('--port')
    expect(kernelHelp).toContain('--service-token')
    expect(kernelHelp).toContain('[secret]')
    const runnerHelp = generateCliHelp('runner-profile')
    for (const flag of ['--poll-ms', '--heartbeat-ms', '--timeout-ms', '--cancel-poll-ms', '--mode', '--owner']) {
      expect(runnerHelp).toContain(flag)
    }
    const standaloneHelp = generateCliHelp('standalone')
    for (const flag of ['--host', '--port', '--token', '--principal', '--no-token']) {
      expect(standaloneHelp).toContain(flag)
    }
  })

  it('zodToJsonSchema fails loud on unsupported types', () => {
    expect(() => zodToJsonSchema(z.record(z.unknown()))).toThrow(/unsupported zod type/)
  })
})
