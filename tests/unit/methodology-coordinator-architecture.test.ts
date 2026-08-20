import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  KnowledgeMethodologyCoordinator,
  SynthesisMethodologyCoordinator,
  WritingMethodologyCoordinator,
} from '../../packages/research-kernel/src/methodology-coordinator.js'

describe('methodology coordination module boundary', () => {
  it('exports concrete coordinators rather than keeping policy branches in ResearchKernel', () => {
    expect(KnowledgeMethodologyCoordinator).toBeTypeOf('function')
    expect(SynthesisMethodologyCoordinator).toBeTypeOf('function')
    expect(WritingMethodologyCoordinator).toBeTypeOf('function')

    const kernel = readFileSync(new URL('../../packages/research-kernel/src/kernel.ts', import.meta.url), 'utf8')
    expect(kernel).toMatch(/activateKnowledgePackageFromAuthority[\s\S]*?this\.knowledgeMethodology\.activate\(input\)/)
    expect(kernel).toMatch(/recordResearchSynthesis[\s\S]*?this\.synthesisMethodology\.record\(input\)/)
    expect(kernel).toMatch(/recordMethodTriad[\s\S]*?this\.writingMethodology\.recordMethodTriad\(input\)/)
    expect(kernel).toMatch(/runWritingAssurance[\s\S]*?this\.writingMethodology\.runAssurance\(input\)/)
    expect(kernel).not.toMatch(/assertSynthesisRequestAdmission/)
    expect(kernel).not.toMatch(/dispatchDeterministicAssuranceProducer/)
    expect(kernel).not.toMatch(/assertWritingSemanticReview/)
    expect(kernel).not.toMatch(/resolveKnowledgeActivation/)
  })
})
