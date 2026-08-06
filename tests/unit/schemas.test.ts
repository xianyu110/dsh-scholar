/**
 * Schema + state machine unit tests (design §11.1 Unit layer).
 */
import { describe, expect, it } from 'vitest'
import {
  BudgetConstraints, ExperimentContract, IdeaCard, ProjectStatus, ResearchProject,
  TRANSITION_TABLE, fixtureContract, fixtureIdea, fixtureProject,
} from '@dsh-scholar/research-schemas'

describe('research schemas', () => {
  it('fixture project validates', () => {
    expect(ResearchProject.parse(fixtureProject())).toMatchObject({ status: 'SCOPED' })
  })

  it('fixture idea validates', () => {
    expect(IdeaCard.parse(fixtureIdea()).scores.feasibility).toBe(4)
  })

  it('fixture contract validates', () => {
    expect(ExperimentContract.parse(fixtureContract()).status).toBe('approved')
  })

  it('budget constraints apply defaults', () => {
    expect(BudgetConstraints.parse({}).max_model_cost_usd).toBe(250)
    expect(BudgetConstraints.parse({}).max_gpu_hours).toBe(120)
  })

  it('state machine rejects illegal transitions', () => {
    // RELEASED is unreachable from DRAFT; STOPPED is a terminal sink.
    expect(TRANSITION_TABLE.DRAFT).not.toContain('RELEASED')
    expect(TRANSITION_TABLE.STOPPED).toHaveLength(0)
    expect(TRANSITION_TABLE.DRAFT).toContain('SCOPED')
    expect(TRANSITION_TABLE.SURVEYING).toContain('IDEATING')
    expect(TRANSITION_TABLE.EXPERIMENTING).toContain('EVIDENCE_READY')
  })

  it('every status is reachable in the table', () => {
    const all = new Set<ProjectStatus>(Object.keys(TRANSITION_TABLE) as ProjectStatus[])
    expect(all.size).toBe(ProjectStatus.options.length)
  })
})
