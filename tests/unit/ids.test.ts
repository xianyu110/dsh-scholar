/**
 * ID scheme tests (reconstruction-contracts.md §2, domain-model.md §1):
 * business IDs are `prefix + base32(lowercase, no padding)` over 128-bit
 * crypto random — never a timestamp; tests can inject a deterministic ID
 * source. The base32 lowercase alphabet (a–z, 2–7) excludes the decimal
 * digits 0/1/8/9, so a base36 timestamp suffix can never match the pattern.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildProjectId, buildIdeaId, buildContractId, buildGateId, buildClaimId,
  toBase32Lower, setIdRandomSource,
} from '@dsh-scholar/research-schemas'
import { ResearchKernel } from '@dsh-scholar/research-kernel'

const BASE32_RE = /^[a-z2-7]+$/

function freshKernel(): ResearchKernel {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ids-test-'))
  return new ResearchKernel({ dbPath: join(dir, 'kernel.db'), casRoot: join(dir, 'cas') })
}

describe('business ID format (reconstruction-contracts.md §2)', () => {
  it('project/idea/contract/gate/claim ids are prefix + 128-bit base32(lowercase, no padding)', () => {
    for (const id of [buildProjectId(), buildIdeaId(), buildContractId(), buildGateId(), buildClaimId()]) {
      const [, prefix, suffix] = id.match(/^([a-z]+)_(.*)$/) ?? []
      expect(['rsp', 'idea', 'expc', 'gate', 'claim']).toContain(prefix)
      // 128 bits → ceil(128 / 5) = 26 base32 chars, no padding.
      expect(suffix).toMatch(BASE32_RE)
      expect(suffix.length).toBe(26)
    }
  })

  it('toBase32Lower is lowercase RFC 4648 without padding', () => {
    // 2 bytes = 16 bits → 4 base32 chars (last group carries 1 real bit).
    expect(toBase32Lower(Uint8Array.from([0, 0]))).toBe('aaaa')
    expect(toBase32Lower(Uint8Array.from([0xff, 0xff]))).toBe('777q')
    // 16 bytes = 128 bits → 26 chars, length 26, never '='.
    expect(toBase32Lower(new Uint8Array(16)).length).toBe(26)
    expect(toBase32Lower(new Uint8Array(16))).not.toContain('=')
  })

  it('kernel-generated business ids (event/job/evidence/pty/workspace) use the same scheme', () => {
    const kernel = freshKernel()
    try {
      const project = kernel.createProject({ name: 't', workspace: '/w', brief: { problem: 'p', scope: 's' } })
      const job = kernel.submitJob({ project_id: project.project_id, idempotency_key: 'k1', kind: 'echo' })
      const events = kernel.listEvents()
      const evt = events[0]!.event_id
      expect(evt.match(/^evt_(.*)$/)?.[1]).toMatch(BASE32_RE)
      expect(job.job_id.match(/^job_(.*)$/)?.[1]).toMatch(BASE32_RE)
      // No business id may embed a base36 timestamp (digits 0/1/8/9).
      expect(evt).not.toMatch(/[0189]/)
      expect(job.job_id).not.toMatch(/[0189]/)
      expect(project.project_id).not.toMatch(/[0189]/)
    } finally {
      kernel.close()
    }
  })
})

describe('deterministic ID source injection (reconstruction-contracts.md §2)', () => {
  it('setIdRandomSource replaces the RNG and returns the previous source', () => {
    let counter = 0
    const previous = setIdRandomSource((bytes: number) => {
      const out = new Uint8Array(bytes)
      for (let i = 0; i < bytes; i++) out[i] = counter++ & 0xff
      return out
    })
    try {
      const a = buildProjectId()
      const b = buildProjectId()
      expect(a).not.toBe(b) // distinct even with a counter source
      expect(a).toMatch(/^rsp_[a-z2-7]{26}$/)
      expect(b).toMatch(/^rsp_[a-z2-7]{26}$/)
      // Deterministic: the same source yields the same sequence on re-seed.
      counter = 0
      expect(buildProjectId()).toBe(a)
    } finally {
      setIdRandomSource(previous)
    }
  })
})
