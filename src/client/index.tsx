/** DSH browser half: contributes Settings plus the Scholar conversation view. */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  DEFAULT_STANDALONE_SHORTCUT,
  DEFAULT_STANDALONE_URL,
  DISABLED_STANDALONE_SHORTCUT,
  normalizeStandaloneUrl,
  standaloneChatBridgeOrigin,
  type StandaloneShortcut,
} from '../shared/standalone.js'
import type { ResearchSettings } from '../shared/settings-rpc.js'
import {
  SCHOLAR_STAGE_IDS,
  normalizeDshSessionId,
  type ScholarSessionProjection,
  type ScholarStageId,
  type ScholarStageState,
} from '../shared/research-stage.js'
import { ScholarSettingsScope } from './scholar-settings.js'

const LOCALE_NAMESPACE = 'settings.dshScholar'

type ResearchConfigKey =
  | 'title' | 'description' | 'restart' | 'expand' | 'collapse'
  | 'mode' | 'modeHint' | 'gateOnly' | 'fullAuto'
  | 'unattended' | 'unattendedHint' | 'overridden' | 'reset'
  | 'standaloneUrl' | 'standaloneUrlHint' | 'shortcut' | 'shortcutHint' | 'shortcutDisabled'
  | 'openStandalone' | 'copyToken' | 'copyingToken' | 'tokenCopied' | 'tokenCopyFailed'
  | 'viewDescription' | 'viewFrameTitle' | 'viewUnavailable' | 'frameLoading' | 'frameLoadFailed'
  | 'retryFrame' | 'resetStandalone'
  | 'sessionTimeline' | 'sessionLoading' | 'sessionUnavailable' | 'sessionUnlinked' | 'refreshStages'
  | 'projectRevision' | 'nextAction' | 'nextReason' | 'pendingGates' | 'jobsSummary'
  | 'stageInit' | 'stageSurvey' | 'stageIdea' | 'stageReproduce' | 'stageContract'
  | 'stageExperiment' | 'stageEvidence' | 'stageWriting' | 'stageReview' | 'stageRelease'
  | 'stageDone' | 'stageCurrent' | 'stageUpcoming' | 'stageBlocked'
  | 'save' | 'saving' | 'saveFailed'

const en: Record<ResearchConfigKey, string> = {
  title: 'dsh Scholar',
  description: 'Scientific-research orchestration and its managed kernel.',
  restart: 'Changes apply after DSH restarts.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  mode: 'Default governance mode',
  modeHint: 'Gate-only keeps human approval gates; full-auto is intended for low-risk sandboxes.',
  gateOnly: 'Gate only',
  fullAuto: 'Full auto',
  unattended: 'Unattended runs',
  unattendedHint: 'Park work at human gates instead of waiting for an interactive answer.',
  standaloneUrl: 'Standalone URL',
  standaloneUrlHint: 'HTTPS or loopback HTTP only; credentials, query parameters and fragments are rejected.',
  shortcut: 'Open-page shortcut',
  shortcutHint: 'The shortcut is ignored while you are typing or using an IME.',
  shortcutDisabled: 'Disabled',
  openStandalone: 'Open in new page',
  copyToken: 'Copy standalone access token',
  copyingToken: 'Copying…',
  tokenCopied: 'Access token copied.',
  tokenCopyFailed: 'The access token could not be copied safely.',
  viewDescription: 'The standalone Scholar workbench is displayed here.',
  viewFrameTitle: 'dsh Scholar standalone workbench',
  viewUnavailable: 'The standalone workbench URL is unavailable. Check Plugin config.',
  frameLoading: 'Connecting to the standalone Scholar workbench…',
  frameLoadFailed: 'Scholar could not be loaded safely. Open it in a new page to inspect the certificate, or check the URL and allowed frame origins.',
  retryFrame: 'Retry',
  resetStandalone: 'Use local default',
  sessionTimeline: 'Research stages for this DSH session',
  sessionLoading: 'Loading the session research stages…',
  sessionUnavailable: 'The session research stages are temporarily unavailable.',
  sessionUnlinked: 'This DSH session has no linked research project. Start in Chat with a project name or /new <project name>.',
  refreshStages: 'Refresh stages',
  projectRevision: 'Revision',
  nextAction: 'Next action',
  nextReason: 'Reason',
  pendingGates: 'Pending gates',
  jobsSummary: 'Jobs',
  stageInit: 'Init',
  stageSurvey: 'Survey',
  stageIdea: 'Idea',
  stageReproduce: 'Reproduce',
  stageContract: 'Contract',
  stageExperiment: 'Experiment',
  stageEvidence: 'Evidence',
  stageWriting: 'Writing',
  stageReview: 'Review',
  stageRelease: 'Release',
  stageDone: 'done',
  stageCurrent: 'current',
  stageUpcoming: 'upcoming',
  stageBlocked: 'blocked',
  overridden: 'Overridden',
  reset: 'Reset to deployment default',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these settings.',
}

const zh: Record<ResearchConfigKey, string> = {
  title: 'dsh Scholar',
  description: '科学研究编排及其托管的 Research Kernel。',
  restart: '修改将在 DSH 重启后生效。',
  expand: '展开设置',
  collapse: '收起设置',
  mode: '默认治理模式',
  modeHint: 'Gate only 保留人工审批关卡；Full auto 仅适合低风险沙箱。',
  gateOnly: 'Gate only',
  fullAuto: 'Full auto',
  unattended: '无人值守运行',
  unattendedHint: '遇到人工关卡时暂停项目，而不是等待交互回答。',
  standaloneUrl: 'Standalone 地址',
  standaloneUrlHint: '仅允许 HTTPS 或 loopback HTTP；拒绝凭据、查询参数和片段。',
  shortcut: '新页面快捷键',
  shortcutHint: '正在输入或使用输入法时不会触发快捷键。',
  shortcutDisabled: '已禁用',
  openStandalone: '在新页面打开',
  copyToken: '复制 standalone 访问令牌',
  copyingToken: '复制中…',
  tokenCopied: '访问令牌已复制。',
  tokenCopyFailed: '无法安全复制访问令牌。',
  viewDescription: '这里显示独立运行的 Scholar 工作台。',
  viewFrameTitle: 'dsh Scholar 独立工作台',
  viewUnavailable: 'Standalone 工作台地址不可用，请检查 Plugin config。',
  frameLoading: '正在连接独立运行的 Scholar 工作台…',
  frameLoadFailed: '无法安全加载 Scholar。请在新页面检查证书，或检查地址与允许嵌入的来源。',
  retryFrame: '重试',
  resetStandalone: '恢复本机默认地址',
  sessionTimeline: '当前 DSH 会话的研究阶段',
  sessionLoading: '正在加载会话研究阶段…',
  sessionUnavailable: '暂时无法读取当前会话的研究阶段。',
  sessionUnlinked: '当前 DSH 会话尚未关联研究项目。请在 Chat 中输入项目名，或使用 /new <项目名>。',
  refreshStages: '刷新阶段',
  projectRevision: '版本',
  nextAction: '下一步',
  nextReason: '原因',
  pendingGates: '待审批',
  jobsSummary: '任务',
  stageInit: '初始化',
  stageSurvey: '调研',
  stageIdea: '想法',
  stageReproduce: '复现',
  stageContract: '合同',
  stageExperiment: '实验',
  stageEvidence: '证据',
  stageWriting: '写作',
  stageReview: '评审',
  stageRelease: '发布',
  stageDone: '已完成',
  stageCurrent: '当前',
  stageUpcoming: '未开始',
  stageBlocked: '受阻',
  overridden: '已覆盖',
  reset: '恢复部署默认值',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些设置。',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the Scholar plugin configuration card. */
    'settings.dshScholar': ResearchConfigKey
  }
}

interface ResearchCardFace {
  hooks: { researchSettings: SettingsScope<ResearchSettings> }
  setDefaultMode: (value: 'gate-only' | 'full-auto') => Promise<void>
  setUnattended: (value: boolean) => Promise<void>
  setStandalone: (value: NonNullable<ResearchSettings['standalone']>) => Promise<void>
  openStandalone: (url: string) => void
  copyStandaloneToken: () => Promise<boolean>
  reset: (field: keyof ResearchSettings) => Promise<void>
}

type ResearchCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<typeof LOCALE_NAMESPACE>
  & InjectFace<ResearchCardFace>

interface ScholarViewFace {
  hooks: { researchSettings: SettingsScope<ResearchSettings> }
  openStandalone: (url: string) => void
  resetStandalone: () => Promise<void>
  callHostChatTurn: (payload: unknown, signal?: AbortSignal) => Promise<unknown>
  readSessionProjection: (sessionId: string, signal?: AbortSignal) => Promise<ScholarSessionProjection>
}

type ScholarViewProps = ConvViewProps
  & PropsLocale<typeof LOCALE_NAMESPACE>
  & InjectFace<ScholarViewFace>

const style = {
  card: {
    listStyle: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-3)', overflow: 'hidden',
  },
  header: {
    width: '100%', border: 0, background: 'none', color: 'inherit', textAlign: 'left',
    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px',
  },
  headText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  title: { fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary)' },
  description: { fontSize: 13, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
  body: { borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0 16px', padding: '12px 0' },
  restart: { margin: '0 0 12px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  field: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0' },
  fieldHead: { display: 'flex', alignItems: 'center', gap: 8 },
  label: { flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
  hint: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
  select: {
    height: 34, padding: '0 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', font: 'inherit',
  },
  badge: {
    borderRadius: 999, padding: '1px 8px', fontSize: 11,
    background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-secondary)',
  },
  reset: { border: 0, background: 'none', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 0' },
  secondary: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer',
    background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)',
  },
  status: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  footer: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
    borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 12, marginTop: 8,
  },
  error: { flex: 1, margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-error)' },
  save: {
    border: 0, borderRadius: 8, padding: '6px 14px', cursor: 'pointer',
    background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)',
  },
  view: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-layer-1)' },
  viewHeader: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
  },
  viewText: { flex: 1, minWidth: 0, margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
  sessionPanel: { padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l2)', display: 'flex', flexDirection: 'column', gap: 10 },
  sessionHeading: { display: 'flex', alignItems: 'center', gap: 10 },
  sessionTitle: { flex: 1, margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  projectMeta: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  stages: { display: 'grid', gridTemplateColumns: 'repeat(10, minmax(64px, 1fr))', gap: 6, overflowX: 'auto' },
  stage: { minWidth: 64, borderRadius: 8, padding: '7px 6px', textAlign: 'center', fontSize: 11, border: '1px solid var(--dsw-alias-border-l2)', display: 'flex', flexDirection: 'column', gap: 2 },
  stageName: { fontWeight: 600 },
  stageState: { fontSize: 10, opacity: 0.82 },
  stageDone: { background: 'color-mix(in srgb, var(--dsw-alias-label-success) 12%, transparent)', color: 'var(--dsw-alias-label-success)' },
  stageCurrent: { background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent)', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
  stageUpcoming: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-tertiary)' },
  stageBlocked: { background: 'color-mix(in srgb, var(--dsw-alias-label-error) 10%, transparent)', color: 'var(--dsw-alias-label-error)', fontWeight: 600 },
  nextLine: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
  frameRegion: { flex: 1, minHeight: 240, position: 'relative', overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-1)' },
  frame: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: '#fff' },
  frameStatus: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  frameFailure: { maxWidth: 600, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' },
  frameActions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
  unavailable: { margin: 0, color: 'var(--dsw-alias-label-error)', lineHeight: 1.5 },
} satisfies Record<string, CSSProperties>

type RpcCaller = {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
}

const CHAT_BRIDGE_REQUEST = 'dsh-scholar/chat-turn-request'
const CHAT_BRIDGE_RESPONSE = 'dsh-scholar/chat-turn-response'
const FRAME_READY = 'dsh-scholar/frame-ready'
const FRAME_READY_QUERY = 'dsh-scholar/frame-ready-query'

export type ScholarFrameState = 'loading' | 'ready' | 'failed'
export type ScholarFrameEvent = 'ready' | 'timeout' | 'error' | 'retry'

/** Small deterministic state machine used by the iframe timeout UI. */
export function nextScholarFrameState(state: ScholarFrameState, event: ScholarFrameEvent): ScholarFrameState {
  if (event === 'retry') return 'loading'
  if (state !== 'loading') return state
  return event === 'ready' ? 'ready' : 'failed'
}

/** URL changes must render a fresh iframe before the effect can bind its ref. */
export function scholarFrameStateForUrl(
  stateUrl: string | null,
  currentUrl: string | null,
  state: ScholarFrameState,
): ScholarFrameState {
  return stateUrl === currentUrl ? state : 'loading'
}

/** A same-URL retry is a distinct iframe/source and must rebind every bridge. */
export function scholarFrameAttemptKey(url: string | null, generation: number): string | null {
  return url === null ? null : `${url}\u0000${generation}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every(key => allowedSet.has(key))
}

export interface ScholarChatBridgeRequest {
  requestId: string
  payload: Record<string, unknown>
}

/** Accept requests only from this exact Scholar iframe and configured origin. */
export function parseScholarChatBridgeRequest(
  event: { source?: unknown; origin?: unknown; data?: unknown },
  expectedSource: unknown,
  expectedOrigin: string,
): ScholarChatBridgeRequest | null {
  if (event.source !== expectedSource || event.origin !== expectedOrigin) return null
  const envelope = isRecord(event.data) ? event.data : null
  if (envelope?.type !== CHAT_BRIDGE_REQUEST || typeof envelope.request_id !== 'string') return null
  const requestId = envelope.request_id
  if (requestId.length === 0 || requestId.length > 256 || !isRecord(envelope.payload)) return null
  return { requestId, payload: envelope.payload }
}

/** Accept readiness only from the exact configured iframe window and origin. */
export function parseScholarFrameReadyMessage(
  event: { source?: unknown; origin?: unknown; data?: unknown },
  expectedSource: unknown,
  expectedOrigin: string,
): boolean {
  if (event.source !== expectedSource || event.origin !== expectedOrigin) return false
  const envelope = isRecord(event.data) ? event.data : null
  return envelope?.type === FRAME_READY && envelope.protocol === 1 && hasOnlyKeys(envelope, ['type', 'protocol'])
}

/** Trusted-host browser seam for the Host-owned, tool-free chat model RPC. */
export async function callScholarChatTurn(
  rpc: RpcCaller,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = signal === undefined
    ? await rpc.call('/dsh-scholar-view', 'chat-turn', payload)
    : await rpc.call('/dsh-scholar-view', 'chat-turn', payload, signal)
  if (!isRecord(response) || response.ok !== true || !('value' in response)) {
    throw new Error('Scholar Chat model is unavailable')
  }
  return response.value
}

function isScholarProjection(value: unknown, expectedSessionId: string): value is ScholarSessionProjection {
  if (!isRecord(value) || typeof value.linked !== 'boolean' || value.session_id !== expectedSessionId) return false
  if (!hasOnlyKeys(value, ['linked', 'session_id', 'project', 'stages', 'next_action', 'summary'])) return false
  if (!Array.isArray(value.stages) || value.stages.length !== SCHOLAR_STAGE_IDS.length || !isRecord(value.summary)) return false
  const nonnegativeInteger = (candidate: unknown): candidate is number => Number.isInteger(candidate) && (candidate as number) >= 0
  if (!hasOnlyKeys(value.summary, ['pending_gates', 'jobs', 'counts'])) return false
  if (!nonnegativeInteger(value.summary.pending_gates) || !isRecord(value.summary.jobs) || !isRecord(value.summary.counts)) return false
  if (!hasOnlyKeys(value.summary.jobs, ['total', 'queued', 'running', 'succeeded', 'failed'])) return false
  for (const key of ['total', 'queued', 'running', 'succeeded', 'failed']) {
    if (!nonnegativeInteger(value.summary.jobs[key])) return false
  }
  if (!Object.values(value.summary.counts).every(nonnegativeInteger)) return false
  if (value.linked && (!isRecord(value.project) || !hasOnlyKeys(value.project, ['project_id', 'name', 'status', 'revision', 'brief_status'])
    || typeof value.project.project_id !== 'string'
    || typeof value.project.name !== 'string' || typeof value.project.status !== 'string'
    || !nonnegativeInteger(value.project.revision)
    || (value.project.brief_status !== undefined && typeof value.project.brief_status !== 'string'))) return false
  if (!value.linked && (value.project !== undefined || value.next_action !== undefined)) return false
  if (value.next_action !== undefined) {
    if (!isRecord(value.next_action)
      || !hasOnlyKeys(value.next_action, ['code', 'label', 'reason', 'route', 'state', 'blocking', 'required_by', 'required', 'revision'])
      || typeof value.next_action.code !== 'string'
      || typeof value.next_action.label !== 'string' || typeof value.next_action.reason !== 'string'
      || typeof value.next_action.route !== 'string'
      || (value.next_action.state !== 'ready' && value.next_action.state !== 'blocked' && value.next_action.state !== 'done')
      || typeof value.next_action.blocking !== 'boolean'
      || (value.next_action.required_by !== 'human' && value.next_action.required_by !== 'agent' && value.next_action.required_by !== 'runner')
      || (value.next_action.required !== true && (!Array.isArray(value.next_action.required)
        || !value.next_action.required.every(item => typeof item === 'string')))
      || (value.next_action.revision !== null && !nonnegativeInteger(value.next_action.revision))) return false
  }
  return value.stages.every((stage, index) => isRecord(stage)
    && hasOnlyKeys(stage, ['id', 'state'])
    && stage.id === SCHOLAR_STAGE_IDS[index]
    && (stage.state === 'done' || stage.state === 'current' || stage.state === 'upcoming' || stage.state === 'blocked'))
}

/** Trusted-host, session-bound phase projection from the plugin Kernel. */
export async function callScholarSessionProjection(
  rpc: RpcCaller,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ScholarSessionProjection> {
  const normalized = normalizeDshSessionId(sessionId)
  if (normalized === undefined) throw new Error('Scholar session projection is unavailable')
  const response = signal === undefined
    ? await rpc.call('/dsh-scholar-view', 'session-projection', { session_id: normalized })
    : await rpc.call('/dsh-scholar-view', 'session-projection', { session_id: normalized }, signal)
  if (!isRecord(response) || response.ok !== true || !isScholarProjection(response.value, normalized)) {
    throw new Error('Scholar session projection is unavailable')
  }
  return response.value
}

const STAGE_KEYS: Record<ScholarStageId, ResearchConfigKey> = {
  init: 'stageInit', survey: 'stageSurvey', idea: 'stageIdea', reproduce: 'stageReproduce', contract: 'stageContract',
  experiment: 'stageExperiment', evidence: 'stageEvidence', writing: 'stageWriting', review: 'stageReview', release: 'stageRelease',
}
const STAGE_STATE_KEYS: Record<ScholarStageState, ResearchConfigKey> = {
  done: 'stageDone', current: 'stageCurrent', upcoming: 'stageUpcoming', blocked: 'stageBlocked',
}

function isEditableTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false
  const candidate = target as { tagName?: unknown; isContentEditable?: unknown; getAttribute?: (name: string) => string | null }
  const tag = typeof candidate.tagName === 'string' ? candidate.tagName.toLowerCase() : ''
  return tag === 'input' || tag === 'textarea' || tag === 'select'
    || candidate.isContentEditable === true
    || candidate.getAttribute?.('role') === 'textbox'
}

/** Global shortcut guard; exported so focus/IME regressions stay unit-testable. */
export function shouldOpenScholarShortcut(event: {
  key: string
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  repeat: boolean
  isComposing?: boolean
  target?: unknown
  composedPath?: () => unknown[]
}, shortcut: StandaloneShortcut): boolean {
  if (shortcut === DISABLED_STANDALONE_SHORTCUT || event.repeat || event.isComposing === true) return false
  if (!(event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 's')) return false
  const path = event.composedPath?.() ?? [event.target]
  return !path.some(isEditableTarget)
}

/** Open without retaining an opener reference or sending a referrer. */
export function openStandaloneWindow(url: string): void {
  const safeUrl = normalizeStandaloneUrl(url)
  if (typeof window === 'undefined') return
  const opened = window.open(safeUrl, '_blank', 'noopener,noreferrer')
  if (opened !== null) opened.opener = null
}

/** Explicit clipboard seam. No textarea/DOM fallback is permitted for tokens. */
export async function copyStandaloneAccessToken(
  rpc: RpcCaller,
  clipboard: Pick<Clipboard, 'writeText'> | undefined,
  isLoopback: boolean,
): Promise<boolean> {
  if (!isLoopback || clipboard === undefined) return false
  try {
    const response = await rpc.call('/dsh-scholar', 'standalone-token', {}) as {
      ok?: unknown
      value?: { token?: unknown }
    }
    if (response.ok !== true || typeof response.value?.token !== 'string' || response.value.token === '') return false
    await clipboard.writeText(response.value.token)
    return true
  } catch {
    return false
  }
}

function resolvedStandaloneUrl(settings: ResearchSettings | undefined): string | null {
  try {
    return normalizeStandaloneUrl(settings?.standalone?.url ?? DEFAULT_STANDALONE_URL)
  } catch {
    return null
  }
}

/** Conversation view: one thin host for the separately running standalone UI. */
function ScholarView(props: ScholarViewProps) {
  const snapshot = props.useResearchSettings(value => value)
  const url = resolvedStandaloneUrl(snapshot.status === 'ready' ? snapshot.value : undefined)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId.trim() : ''
  const [sessionProjection, setSessionProjection] = useState<ScholarSessionProjection | null>(null)
  const [sessionState, setSessionState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const [frameGeneration, setFrameGeneration] = useState(0)
  const [frameState, setFrameState] = useState<ScholarFrameState>('loading')
  const [frameStateUrl, setFrameStateUrl] = useState<string | null>(url)
  const visibleFrameState = scholarFrameStateForUrl(frameStateUrl, url, frameState)
  const frameAttemptKey = scholarFrameAttemptKey(url, frameGeneration)
  const frameFailed = visibleFrameState === 'failed'
  useEffect(() => {
    const controller = new AbortController()
    let timer: number | undefined
    let active = true
    let inFlight = false
    const schedule = (): void => {
      if (!active || controller.signal.aborted) return
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => { void read() }, 4_000)
    }
    const read = async (): Promise<void> => {
      if (!active || sessionId === '') {
        if (active) { setSessionProjection(null); setSessionState('failed') }
        return
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        schedule()
        return
      }
      if (inFlight) return
      inFlight = true
      try {
        const value = await props.readSessionProjection(sessionId, controller.signal)
        if (!active || controller.signal.aborted) return
        setSessionProjection(value)
        setSessionState('ready')
      } catch {
        if (!active || controller.signal.aborted) return
        setSessionState('failed')
      } finally {
        inFlight = false
      }
      schedule()
    }
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible' || inFlight) return
      if (timer !== undefined) window.clearTimeout(timer)
      void read()
    }
    setSessionProjection(null)
    setSessionState('loading')
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    void read()
    return () => {
      active = false
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [props.readSessionProjection, refreshGeneration, sessionId])
  useEffect(() => {
    setFrameStateUrl(url)
    setFrameState('loading')
    if (url === null) return
    const source = frameRef.current?.contentWindow
    if (source === null || source === undefined) return
    let origin: string
    try { origin = new URL(url).origin } catch { return }
    let active = true
    let timer: number | undefined
    const cleanupReady = (): void => {
      if (!active) return
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
    }
    const onMessage = (event: MessageEvent): void => {
      if (!parseScholarFrameReadyMessage(event, source, origin)) return
      cleanupReady()
      setFrameState(state => nextScholarFrameState(state, 'ready'))
    }
    timer = window.setTimeout(() => {
      cleanupReady()
      setFrameState(state => nextScholarFrameState(state, 'timeout'))
    }, 8_000)
    window.addEventListener('message', onMessage)
    try { source.postMessage({ type: FRAME_READY_QUERY, protocol: 1 }, origin) } catch {
      cleanupReady()
      setFrameState(state => nextScholarFrameState(state, 'error'))
    }
    return cleanupReady
  }, [frameAttemptKey, url])
  useEffect(() => {
    if (url === null || frameFailed) return
    const source = frameRef.current?.contentWindow
    if (source === null || source === undefined) return
    const origin = standaloneChatBridgeOrigin(url, window.location.origin)
    if (origin === null) return
    const pending = new Map<string, AbortController>()
    const completed: string[] = []
    const completedSet = new Set<string>()
    const remember = (requestId: string): void => {
      completed.push(requestId)
      completedSet.add(requestId)
      if (completed.length <= 128) return
      const evicted = completed.shift()
      if (evicted !== undefined) completedSet.delete(evicted)
    }
    const replyUnavailable = (requestId: string): void => {
      if (frameRef.current?.contentWindow !== source) return
      source.postMessage({
        type: CHAT_BRIDGE_RESPONSE,
        request_id: requestId,
        error: { code: 'unavailable' },
      }, origin)
    }
    const onMessage = (event: MessageEvent): void => {
      const request = parseScholarChatBridgeRequest(event, source, origin)
      if (request === null) return
      if (pending.has(request.requestId) || completedSet.has(request.requestId)) {
        replyUnavailable(request.requestId)
        return
      }
      if (pending.size >= 1) {
        replyUnavailable(request.requestId)
        return
      }
      const controller = new AbortController()
      pending.set(request.requestId, controller)
      remember(request.requestId)
      const timer = window.setTimeout(() => { controller.abort() }, 20_000)
      void props.callHostChatTurn(request.payload, controller.signal).then(
        value => {
          if (frameRef.current?.contentWindow !== source) return
          source.postMessage({ type: CHAT_BRIDGE_RESPONSE, request_id: request.requestId, value }, origin)
        },
        () => { replyUnavailable(request.requestId) },
      ).finally(() => {
        window.clearTimeout(timer)
        if (pending.get(request.requestId) === controller) pending.delete(request.requestId)
      })
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      for (const controller of pending.values()) controller.abort()
      pending.clear()
    }
  }, [frameAttemptKey, frameFailed, props.callHostChatTurn, url])
  return (
    <section style={style.view} aria-label={props.t('title')}>
      <header style={style.viewHeader}>
        <p style={style.viewText}>{props.t('viewDescription')}</p>
        <button
          type="button"
          style={style.secondary}
          disabled={url === null}
          onClick={() => { if (url !== null) props.openStandalone(url) }}
        >
          {props.t('openStandalone')}
        </button>
      </header>
      <section style={style.sessionPanel} aria-label={props.t('sessionTimeline')}>
        <div style={style.sessionHeading}>
          <h2 style={style.sessionTitle}>{props.t('sessionTimeline')}</h2>
          <button type="button" style={style.secondary} onClick={() => { setRefreshGeneration(value => value + 1) }}>
            {props.t('refreshStages')}
          </button>
        </div>
        {sessionState === 'loading' ? <p role="status" style={style.projectMeta}>{props.t('sessionLoading')}</p> : null}
        {sessionState === 'failed' ? <p role="alert" style={style.error}>{props.t('sessionUnavailable')}</p> : null}
        {sessionState === 'ready' && sessionProjection?.linked === false
          ? <p role="status" style={style.projectMeta}>{props.t('sessionUnlinked')}</p>
          : null}
        {sessionState === 'ready' && sessionProjection?.linked === true && sessionProjection.project !== undefined
          ? (
            <>
              <p style={style.projectMeta}>
                {sessionProjection.project.name} · {sessionProjection.project.status} · {props.t('projectRevision')} {sessionProjection.project.revision}
              </p>
              <div style={style.stages} role="list">
                {sessionProjection.stages.map(stage => (
                  <span
                    key={stage.id}
                    role="listitem"
                    style={{ ...style.stage, ...style[`stage${stage.state[0]!.toUpperCase()}${stage.state.slice(1)}` as 'stageDone' | 'stageCurrent' | 'stageUpcoming' | 'stageBlocked'] }}
                    aria-label={`${props.t(STAGE_KEYS[stage.id])}: ${props.t(STAGE_STATE_KEYS[stage.state])}`}
                    aria-current={stage.state === 'current' || stage.state === 'blocked' ? 'step' : undefined}
                    title={props.t(STAGE_STATE_KEYS[stage.state])}
                  >
                    <span style={style.stageName}>{props.t(STAGE_KEYS[stage.id])}</span>
                    <span style={style.stageState}>{props.t(STAGE_STATE_KEYS[stage.state])}</span>
                  </span>
                ))}
              </div>
              <p style={style.nextLine}>
                {props.t('nextAction')}: {sessionProjection.next_action?.label ?? '—'}
                {sessionProjection.next_action === undefined ? '' : ` (${sessionProjection.next_action.code})`}
                {' · '}{props.t('pendingGates')}: {sessionProjection.summary.pending_gates} · {props.t('jobsSummary')}: {sessionProjection.summary.jobs.total}
              </p>
              {sessionProjection.next_action === undefined ? null : (
                <p style={style.nextLine}>{props.t('nextReason')}: {sessionProjection.next_action.reason}</p>
              )}
            </>
          )
          : null}
      </section>
      {url === null
        ? <div style={style.frameStatus}><p role="alert" style={style.unavailable}>{props.t('viewUnavailable')}</p></div>
        : (
          <div style={style.frameRegion}>
            {visibleFrameState === 'loading'
              ? <div style={style.frameStatus}><p role="status" style={style.projectMeta}>{props.t('frameLoading')}</p></div>
              : null}
            {visibleFrameState === 'failed'
              ? (
                <div style={style.frameStatus}>
                  <div style={style.frameFailure} role="alert">
                    <p style={style.unavailable}>{props.t('frameLoadFailed')}</p>
                    <div style={style.frameActions}>
                      <button
                        type="button"
                        style={style.secondary}
                        onClick={() => {
                          setFrameState(state => nextScholarFrameState(state, 'retry'))
                          setFrameGeneration(value => value + 1)
                        }}
                      >
                        {props.t('retryFrame')}
                      </button>
                      <button type="button" style={style.secondary} onClick={() => { props.openStandalone(url) }}>
                        {props.t('openStandalone')}
                      </button>
                      {url === DEFAULT_STANDALONE_URL ? null : (
                        <button type="button" style={style.secondary} onClick={() => { void props.resetStandalone() }}>
                          {props.t('resetStandalone')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
              : (
                <iframe
                  key={frameAttemptKey ?? url}
                  ref={frameRef}
                  src={url}
                  title={props.t('viewFrameTitle')}
                  style={{ ...style.frame, visibility: visibleFrameState === 'ready' ? 'visible' : 'hidden' }}
                  referrerPolicy="origin"
                  sandbox="allow-scripts allow-forms allow-same-origin allow-downloads allow-modals allow-popups"
                  onLoad={() => {
                    const source = frameRef.current?.contentWindow
                    if (source === null || source === undefined) return
                    try { source.postMessage({ type: FRAME_READY_QUERY, protocol: 1 }, new URL(url).origin) } catch { /* invalid URL already handled */ }
                  }}
                  onError={() => { setFrameState(state => nextScholarFrameState(state, 'error')) }}
                />
              )}
          </div>
        )}
    </section>
  )
}

function userHas(user: unknown, field: keyof ResearchSettings): boolean {
  return typeof user === 'object' && user !== null && field in user
}

/** Scholar configuration card rendered inside DSH's plugin configuration section. */
function ResearchConfigCard(props: ResearchCardProps) {
  const { t } = props
  const snapshot = props.useResearchSettings(value => value)
  const [open, setOpen] = useState(false)
  const [modeDraft, setModeDraft] = useState<'gate-only' | 'full-auto' | undefined>()
  const [unattendedDraft, setUnattendedDraft] = useState<boolean | undefined>()
  const [urlDraft, setUrlDraft] = useState<string | undefined>()
  const [shortcutDraft, setShortcutDraft] = useState<StandaloneShortcut | undefined>()
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [copying, setCopying] = useState(false)
  const [copyStatus, setCopyStatus] = useState<'copied' | 'failed' | null>(null)

  if (snapshot.status !== 'ready' || snapshot.value === undefined) return null
  const mode = modeDraft ?? snapshot.value.defaultMode ?? 'gate-only'
  const unattended = unattendedDraft ?? snapshot.value.unattended ?? false
  const standaloneUrl = urlDraft ?? snapshot.value.standalone?.url ?? DEFAULT_STANDALONE_URL
  const standaloneShortcut = shortcutDraft ?? snapshot.value.standalone?.shortcut ?? DEFAULT_STANDALONE_SHORTCUT
  const dirty = modeDraft !== undefined || unattendedDraft !== undefined
    || urlDraft !== undefined || shortcutDraft !== undefined
  const disabled = !snapshot.writable || saving

  const save = async (): Promise<void> => {
    if (!dirty || saving) return
    setSaving(true)
    setFailed(false)
    try {
      const standaloneValue = urlDraft !== undefined || shortcutDraft !== undefined
        ? { url: normalizeStandaloneUrl(standaloneUrl), shortcut: standaloneShortcut }
        : undefined
      if (modeDraft !== undefined) await props.setDefaultMode(modeDraft)
      if (unattendedDraft !== undefined) await props.setUnattended(unattendedDraft)
      if (standaloneValue !== undefined) await props.setStandalone(standaloneValue)
      setModeDraft(undefined)
      setUnattendedDraft(undefined)
      setUrlDraft(undefined)
      setShortcutDraft(undefined)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const copyToken = async (): Promise<void> => {
    if (copying) return
    setCopying(true)
    setCopyStatus(null)
    const copied = await props.copyStandaloneToken()
    setCopyStatus(copied ? 'copied' : 'failed')
    setCopying(false)
  }

  return (
    <li style={style.card}>
      <button
        type="button"
        style={style.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span style={style.headText}>
          <span style={style.title}>{t('title')}</span>
          <span style={style.description}>{t('description')}</span>
        </span>
        <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>
      {open
        ? (
          <div style={style.body}>
            <p style={style.restart}>{t('restart')}</p>
            <div style={style.field}>
              <div style={style.fieldHead}>
                <label style={style.label} htmlFor="dsh-scholar-default-mode">{t('mode')}</label>
                {userHas(snapshot.user, 'defaultMode') ? <span style={style.badge}>{t('overridden')}</span> : null}
                {userHas(snapshot.user, 'defaultMode')
                  ? <button type="button" style={style.reset} disabled={disabled} onClick={() => { void props.reset('defaultMode') }}>{t('reset')}</button>
                  : null}
              </div>
              <select
                id="dsh-scholar-default-mode"
                style={style.select}
                value={mode}
                disabled={disabled}
                onChange={(event) => { setFailed(false); setModeDraft(event.target.value as 'gate-only' | 'full-auto') }}
              >
                <option value="gate-only">{t('gateOnly')}</option>
                <option value="full-auto">{t('fullAuto')}</option>
              </select>
              <p style={style.hint}>{t('modeHint')}</p>
            </div>
            <div style={style.field}>
              <div style={style.fieldHead}>
                <label style={style.label} htmlFor="dsh-scholar-unattended">{t('unattended')}</label>
                {userHas(snapshot.user, 'unattended') ? <span style={style.badge}>{t('overridden')}</span> : null}
                {userHas(snapshot.user, 'unattended')
                  ? <button type="button" style={style.reset} disabled={disabled} onClick={() => { void props.reset('unattended') }}>{t('reset')}</button>
                  : null}
              </div>
              <input
                id="dsh-scholar-unattended"
                type="checkbox"
                checked={unattended}
                disabled={disabled}
                onChange={(event) => { setFailed(false); setUnattendedDraft(event.target.checked) }}
              />
              <p style={style.hint}>{t('unattendedHint')}</p>
            </div>
            <div style={style.field}>
              <div style={style.fieldHead}>
                <label style={style.label} htmlFor="dsh-scholar-standalone-url">{t('standaloneUrl')}</label>
                {userHas(snapshot.user, 'standalone') ? <span style={style.badge}>{t('overridden')}</span> : null}
                {userHas(snapshot.user, 'standalone')
                  ? <button type="button" style={style.reset} disabled={disabled} onClick={() => { void props.reset('standalone') }}>{t('reset')}</button>
                  : null}
              </div>
              <input
                id="dsh-scholar-standalone-url"
                type="url"
                style={style.select}
                value={standaloneUrl}
                disabled={disabled}
                onChange={(event) => { setFailed(false); setUrlDraft(event.target.value) }}
              />
              <p style={style.hint}>{t('standaloneUrlHint')}</p>
            </div>
            <div style={style.field}>
              <label style={style.label} htmlFor="dsh-scholar-shortcut">{t('shortcut')}</label>
              <select
                id="dsh-scholar-shortcut"
                style={style.select}
                value={standaloneShortcut}
                disabled={disabled}
                onChange={(event) => { setFailed(false); setShortcutDraft(event.target.value as StandaloneShortcut) }}
              >
                <option value={DEFAULT_STANDALONE_SHORTCUT}>{DEFAULT_STANDALONE_SHORTCUT}</option>
                <option value={DISABLED_STANDALONE_SHORTCUT}>{t('shortcutDisabled')}</option>
              </select>
              <p style={style.hint}>{t('shortcutHint')}</p>
            </div>
            <div style={style.actions}>
              <button
                type="button"
                style={style.secondary}
                onClick={() => {
                  try { props.openStandalone(standaloneUrl) } catch { setFailed(true) }
                }}
              >
                {t('openStandalone')}
              </button>
              <button type="button" style={style.secondary} disabled={copying} onClick={() => { void copyToken() }}>
                {t(copying ? 'copyingToken' : 'copyToken')}
              </button>
            </div>
            {copyStatus !== null
              ? <p role="status" style={copyStatus === 'failed' ? style.error : style.status}>{t(copyStatus === 'copied' ? 'tokenCopied' : 'tokenCopyFailed')}</p>
              : null}
            <div style={style.footer}>
              {failed ? <p role="status" style={style.error}>{t('saveFailed')}</p> : null}
              <button type="button" style={style.save} disabled={!dirty || disabled} onClick={() => { void save() }}>
                {t(saving ? 'saving' : 'save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}

/** Browser services required by Settings, the conversation view and token RPC. */
export const inject = ['slots', 'locale', 'connection']

/** Register the Scholar configuration card, conversation view and shortcut. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const scope = new ScholarSettingsScope(connection.rpc, connection.isLoopback)
  ctx.effect(() => {
    void scope.refresh()
    return () => { scope.dispose() }
  }, 'dsh-scholar: settings RPC scope')
  ctx.on('connection/reset', () => { void scope.refresh() })
  const openStandalone = (url: string): void => { openStandaloneWindow(url) }
  const copyToken = (): Promise<boolean> => copyStandaloneAccessToken(
    connection.rpc,
    typeof navigator === 'undefined' ? undefined : navigator.clipboard,
    connection.isLoopback,
  )
  const callHostChatTurn = (payload: unknown, signal?: AbortSignal): Promise<unknown> => callScholarChatTurn(
    connection.rpc,
    payload,
    signal,
  )
  const readSessionProjection = (sessionId: string, signal?: AbortSignal): Promise<ScholarSessionProjection> => callScholarSessionProjection(
    connection.rpc,
    sessionId,
    signal,
  )
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'dsh-scholar: configuration dictionaries')
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'dsh-scholar',
    order: 30,
    locale: LOCALE_NAMESPACE,
    inject: (): ResearchCardFace => ({
      hooks: { researchSettings: scope },
      setDefaultMode: value => scope.set('defaultMode', value),
      setUnattended: value => scope.set('unattended', value),
      setStandalone: value => scope.set('standalone', value),
      openStandalone,
      copyStandaloneToken: copyToken,
      reset: field => scope.unset(field),
    }),
  }, ResearchConfigCard))

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'dsh-scholar',
    order: 20,
    locale: LOCALE_NAMESPACE,
    label: () => 'dsh Scholar',
    inject: (): ScholarViewFace => ({
      hooks: { researchSettings: scope },
      openStandalone,
      resetStandalone: () => scope.unset('standalone'),
      callHostChatTurn,
      readSessionProjection,
    }),
  }, ScholarView))

  if (typeof document !== 'undefined') {
    ctx.effect(() => {
      const onKeyDown = (event: KeyboardEvent): void => {
        const snapshot = scope.getSnapshot()
        const settings = snapshot.status === 'ready' ? snapshot.value : undefined
        const shortcut = settings?.standalone?.shortcut ?? DEFAULT_STANDALONE_SHORTCUT
        if (!shouldOpenScholarShortcut(event, shortcut)) return
        const url = resolvedStandaloneUrl(settings)
        if (url === null) return
        event.preventDefault()
        openStandalone(url)
      }
      document.addEventListener('keydown', onKeyDown)
      return () => { document.removeEventListener('keydown', onKeyDown) }
    }, 'dsh-scholar: open-page shortcut')
  }
}
