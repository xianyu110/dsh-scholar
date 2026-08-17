import { t } from './i18n/index'

export type RunsEmptyStateKind = 'survey-ready' | 'baseline-setup' | 'empty' | 'no-match'

export interface RunsEmptyStateModel {
  kind: RunsEmptyStateKind
  showOverviewCta: boolean
}

const RUN_FILTER_KEYS = ['all', 'queued', 'running', 'retryable', 'succeeded', 'failed', 'cancelled'] as const

/** Resolve labels at render time so an open Runs panel follows locale changes. */
export function runsFilterDefinitions(): Array<[string, string]> {
  return RUN_FILTER_KEYS.map(key => [key, t('runs', `runs.filter.${key}`)])
}

/** Pure empty-state contract: research phases are not fabricated as Jobs. */
export function runsEmptyStateModel(
  projectStatus: string | undefined,
  corpusSnapshotCount: number,
  hasIdeaGenerateAction: boolean,
  hasBaselineReproduceAction: boolean,
  allJobsCount: number,
  visibleJobsCount: number,
): RunsEmptyStateModel | null {
  if (visibleJobsCount > 0) return null
  if (allJobsCount > 0) return { kind: 'no-match', showOverviewCta: false }
  if (projectStatus === 'CONTRACT_APPROVED' && hasBaselineReproduceAction) {
    return { kind: 'baseline-setup', showOverviewCta: false }
  }
  if (projectStatus === 'SURVEYING' && corpusSnapshotCount > 0 && hasIdeaGenerateAction) {
    return { kind: 'survey-ready', showOverviewCta: true }
  }
  return { kind: 'empty', showOverviewCta: false }
}
