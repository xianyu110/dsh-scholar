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
  type StandaloneShortcut,
} from '../shared/standalone.js'
import { SCHOLAR_SETTINGS_NAMESPACE, type ResearchSettings } from '../shared/settings-rpc.js'
import {
  SCHOLAR_STAGE_IDS,
  normalizeDshSessionId,
  normalizeScholarMethodology,
  type ScholarProjectSummary,
  type ScholarMethodologySummary,
  type ScholarSessionProjection,
  type ScholarSessionWorkspace,
  type ScholarStageId,
  type ScholarStageState,
} from '../shared/research-stage.js'
import { ScholarSettingsScope } from './scholar-settings.js'

const LOCALE_NAMESPACE = 'settings.dshScholar'

type ResearchConfigKey =
  | 'title' | 'description' | 'restart' | 'expand' | 'collapse'
  | 'mode' | 'modeHint' | 'gateOnly' | 'fullAuto'
  | 'automationTitle' | 'automationRunning' | 'automationStopped' | 'automationRestartRequired'
  | 'automationFixtureOnly' | 'automationReleaseHuman' | 'automationLastPark'
  | 'unattended' | 'unattendedHint' | 'overridden' | 'reset'
  | 'standaloneUrl' | 'standaloneUrlHint' | 'shortcut' | 'shortcutHint' | 'shortcutDisabled'
  | 'openStandalone' | 'copyToken' | 'copyingToken' | 'tokenCopied' | 'tokenCopyFailed'
  | 'viewDescription' | 'viewUnavailable'
  | 'sessionTimeline' | 'sessionLoading' | 'sessionUnavailable' | 'sessionUnlinked' | 'refreshStages'
  | 'sessionUnlinkedTitle' | 'sessionUnlinkedHint' | 'chooseProject' | 'chooseProjectPlaceholder'
  | 'bindProject' | 'bindingProject' | 'createProjectTitle' | 'projectName'
  | 'projectNamePlaceholder' | 'createProject' | 'creatingProject' | 'noProjects'
  | 'bindFailed' | 'createFailed' | 'archivedProject'
  | 'projectRevision' | 'nextAction' | 'nextReason' | 'pendingGates' | 'jobsSummary'
  | 'methodologyTitle' | 'protocolStatus' | 'synthesisStatus' | 'assuranceStatus'
  | 'writingStatus' | 'knowledgeStatus' | 'manuscriptMethodStatus' | 'runsStatus' | 'methodologyRecommendation'
  | 'researchGraphStatus' | 'methodologyUnavailable'
  | 'notConfigured' | 'fresh' | 'stale' | 'ready' | 'notReady' | 'blockingFindings'
  | 'recommendConfigureProtocol' | 'recommendRunSynthesis' | 'recommendActivateKnowledge'
  | 'recommendReviewWriting' | 'recommendRunAssurance'
  | 'recommendDirectionGateReview' | 'recommendDirectionDeepen' | 'recommendDirectionBroaden'
  | 'recommendDirectionPivot' | 'recommendDirectionConclude' | 'recommendDirectionPause'
  | 'recommendDirectionStale' | 'recommendDirectionInvalid'
  | 'protocolDraft' | 'protocolFrozen' | 'intentExploratory' | 'intentConfirmatory' | 'activePackages'
  | 'knowledgeDeliveryReady' | 'knowledgeSuppressed' | 'knowledgeInactive' | 'suppressedPackages'
  | 'methodTriadReady' | 'methodTriadGap' | 'sectionGuideActive' | 'sectionGuideGap'
  | 'reviewerPanelComplete' | 'reviewerPanelPartial' | 'reviewerPanelMissing'
  | 'patchProposals' | 'patchApplications' | 'runCount' | 'negativeFindings' | 'claimProposals'
  | 'graphNodes' | 'graphEdges'
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
  modeHint: 'Automatic approval requires an exact registered FixtureProfile and RunnerProfile. Release always stays human-controlled.',
  gateOnly: 'Gate only',
  fullAuto: 'Automatic approval (Fixture only)',
  automationTitle: 'Automation runtime',
  automationRunning: 'Worker running',
  automationStopped: 'Worker stopped',
  automationRestartRequired: 'Restart DSH to apply the selected mode.',
  automationFixtureOnly: 'Only exact registered fixture projects with an explicit Runner profile are eligible.',
  automationReleaseHuman: 'Release always requires human approval.',
  automationLastPark: 'Latest parked reason',
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
  viewDescription: 'A focused view of the research project linked to this DSH conversation.',
  viewUnavailable: 'The full Scholar URL is unavailable. Check Plugin config.',
  sessionTimeline: 'Research stages for this DSH session',
  sessionLoading: 'Loading the session research stages…',
  sessionUnavailable: 'The session research stages are temporarily unavailable.',
  sessionUnlinked: 'This DSH conversation has no linked research project.',
  sessionUnlinkedTitle: 'Connect this conversation to research',
  sessionUnlinkedHint: 'Choose an existing Scholar project or create a name-only project. The link is exclusive and cannot silently replace another project.',
  chooseProject: 'Existing project',
  chooseProjectPlaceholder: 'Choose a project…',
  bindProject: 'Link project',
  bindingProject: 'Linking…',
  createProjectTitle: 'Create a project',
  projectName: 'Project name',
  projectNamePlaceholder: 'Enter a research project name',
  createProject: 'Create and link',
  creatingProject: 'Creating…',
  noProjects: 'No existing projects are available. Create one below.',
  bindFailed: 'The project could not be linked. Refresh to check whether this conversation was linked elsewhere.',
  createFailed: 'The project could not be created and linked.',
  archivedProject: 'archived',
  refreshStages: 'Refresh stages',
  projectRevision: 'Revision',
  nextAction: 'Next action',
  nextReason: 'Reason',
  pendingGates: 'Pending gates',
  jobsSummary: 'Jobs',
  methodologyTitle: 'Research method',
  protocolStatus: 'Protocol',
  synthesisStatus: 'Synthesis',
  assuranceStatus: 'Assurance',
  writingStatus: 'Writing',
  knowledgeStatus: 'Knowledge',
  manuscriptMethodStatus: 'Manuscript methodology',
  runsStatus: 'Research outcomes',
  researchGraphStatus: 'Research graph',
  methodologyRecommendation: 'Method recommendation',
  methodologyUnavailable: 'Unavailable from this server response',
  notConfigured: 'Not configured',
  fresh: 'Fresh',
  stale: 'Stale',
  ready: 'Ready',
  notReady: 'Not ready',
  blockingFindings: 'blocking findings',
  recommendConfigureProtocol: 'Freeze the research protocol',
  recommendRunSynthesis: 'Synthesize the latest research cycle',
  recommendActivateKnowledge: 'Activate an approved knowledge package',
  recommendReviewWriting: 'Resolve the writing review',
  recommendRunAssurance: 'Complete the assurance review',
  recommendDirectionGateReview: 'Review the research direction Gate',
  recommendDirectionDeepen: 'Deepen research inside the approved boundary',
  recommendDirectionBroaden: 'Propose broader research through Intake',
  recommendDirectionPivot: 'Propose the adopted pivot through Intake',
  recommendDirectionConclude: 'Prepare evidence and writing for conclusion',
  recommendDirectionPause: 'Review the adopted pause',
  recommendDirectionStale: 'Refresh the stale research direction proposal',
  recommendDirectionInvalid: 'Inspect the invalid research direction binding',
  protocolDraft: 'Draft',
  protocolFrozen: 'Frozen',
  intentExploratory: 'Exploratory',
  intentConfirmatory: 'Confirmatory',
  activePackages: 'active',
  knowledgeDeliveryReady: 'delivery ready',
  knowledgeSuppressed: 'suppressed',
  knowledgeInactive: 'inactive',
  suppressedPackages: 'suppressed',
  methodTriadReady: 'method triad ready',
  methodTriadGap: 'method triad gap',
  sectionGuideActive: 'section guide active',
  sectionGuideGap: 'section guide gap',
  reviewerPanelComplete: 'review panel complete',
  reviewerPanelPartial: 'review panel partial',
  reviewerPanelMissing: 'review panel missing',
  patchProposals: 'patch proposals',
  patchApplications: 'patch applications',
  runCount: 'runs',
  negativeFindings: 'negative findings',
  claimProposals: 'claim proposals',
  graphNodes: 'nodes',
  graphEdges: 'edges',
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
  modeHint: '自动审批要求项目精确绑定已注册的 FixtureProfile 和 RunnerProfile；Release 始终由人工审批。',
  gateOnly: 'Gate only',
  fullAuto: '自动审批（仅 Fixture）',
  automationTitle: '自动审批运行状态',
  automationRunning: '执行器运行中',
  automationStopped: '执行器已停止',
  automationRestartRequired: '需要重启 DSH 才会应用所选模式。',
  automationFixtureOnly: '仅精确绑定已注册 Fixture 和明确 Runner 配置的项目可用。',
  automationReleaseHuman: 'Release 始终需要人工审批。',
  automationLastPark: '最近暂停原因',
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
  viewDescription: '只显示当前 DSH 对话关联项目的阶段、下一步和执行摘要。',
  viewUnavailable: '完整 Scholar 地址不可用，请检查 Plugin config。',
  sessionTimeline: '当前 DSH 会话的研究阶段',
  sessionLoading: '正在加载会话研究阶段…',
  sessionUnavailable: '暂时无法读取当前会话的研究阶段。',
  sessionUnlinked: '当前 DSH 对话尚未关联研究项目。',
  sessionUnlinkedTitle: '把当前对话接入研究',
  sessionUnlinkedHint: '选择已有 Scholar 项目，或只填写名称创建项目。关联是唯一且不可静默换绑的。',
  chooseProject: '已有项目',
  chooseProjectPlaceholder: '选择一个项目…',
  bindProject: '关联项目',
  bindingProject: '关联中…',
  createProjectTitle: '新建项目',
  projectName: '项目名称',
  projectNamePlaceholder: '输入研究项目名称',
  createProject: '新建并关联',
  creatingProject: '创建中…',
  noProjects: '目前没有可选项目，请在下方新建。',
  bindFailed: '无法关联项目。请刷新确认当前对话是否已在别处完成关联。',
  createFailed: '无法创建并关联项目。',
  archivedProject: '已归档',
  refreshStages: '刷新阶段',
  projectRevision: '版本',
  nextAction: '下一步',
  nextReason: '原因',
  pendingGates: '待审批',
  jobsSummary: '任务',
  methodologyTitle: '研究方法',
  protocolStatus: '研究协议',
  synthesisStatus: '研究综合',
  assuranceStatus: '可信度',
  writingStatus: '写作',
  knowledgeStatus: '知识包',
  manuscriptMethodStatus: '论文方法',
  runsStatus: '研究运行结果',
  researchGraphStatus: '研究图谱',
  methodologyRecommendation: '方法建议',
  methodologyUnavailable: '此服务端响应中的该项不可用',
  notConfigured: '未配置',
  fresh: '最新',
  stale: '已过期',
  ready: '就绪',
  notReady: '未就绪',
  blockingFindings: '项阻塞问题',
  recommendConfigureProtocol: '冻结研究协议',
  recommendRunSynthesis: '综合最新研究循环',
  recommendActivateKnowledge: '启用已批准的知识包',
  recommendReviewWriting: '处理写作评审问题',
  recommendRunAssurance: '完成可信度审查',
  recommendDirectionGateReview: '人工审查研究方向 Gate',
  recommendDirectionDeepen: '在已批准边界内深化研究',
  recommendDirectionBroaden: '通过 Intake 提议扩大研究范围',
  recommendDirectionPivot: '通过 Intake 提议已采纳的研究转向',
  recommendDirectionConclude: '为研究结论准备证据与写作',
  recommendDirectionPause: '人工复核已采纳的暂停',
  recommendDirectionStale: '刷新已过期的研究方向提案',
  recommendDirectionInvalid: '检查无效的研究方向绑定',
  protocolDraft: '草稿',
  protocolFrozen: '已冻结',
  intentExploratory: '探索性',
  intentConfirmatory: '验证性',
  activePackages: '个已启用',
  knowledgeDeliveryReady: '可交付',
  knowledgeSuppressed: '已抑制',
  knowledgeInactive: '未启用',
  suppressedPackages: '个被抑制',
  methodTriadReady: '方法三元组就绪',
  methodTriadGap: '方法三元组有缺口',
  sectionGuideActive: '章节指南已启用',
  sectionGuideGap: '章节指南有缺口',
  reviewerPanelComplete: '评审面板完整',
  reviewerPanelPartial: '评审面板部分完成',
  reviewerPanelMissing: '评审面板缺失',
  patchProposals: '个补丁提案',
  patchApplications: '个已应用补丁',
  runCount: '次运行',
  negativeFindings: '个负向发现',
  claimProposals: '个主张提案',
  graphNodes: '个节点',
  graphEdges: '条边',
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
  readSessionWorkspace: (sessionId: string, signal?: AbortSignal) => Promise<ScholarSessionWorkspace>
  bindSessionProject: (sessionId: string, projectId: string, signal?: AbortSignal) => Promise<ScholarSessionWorkspace>
  createSessionProject: (sessionId: string, name: string, signal?: AbortSignal) => Promise<ScholarSessionWorkspace>
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
  automation: {
    display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4, padding: '10px 12px',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  automationHead: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  automationTitle: { flex: 1, fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
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
  view: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-layer-1)', overflow: 'hidden' },
  viewHeader: {
    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
  },
  viewText: { flex: 1, minWidth: 0, margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
  viewBody: { flex: 1, minHeight: 0, overflow: 'auto', padding: '20px clamp(16px, 4vw, 48px)' },
  sessionPanel: { width: '100%', maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 },
  sessionHeading: { display: 'flex', alignItems: 'center', gap: 10 },
  sessionTitle: { flex: 1, margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  projectMeta: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  stages: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))', gap: 6 },
  stage: { minWidth: 64, borderRadius: 8, padding: '7px 6px', textAlign: 'center', fontSize: 11, border: '1px solid var(--dsw-alias-border-l2)', display: 'flex', flexDirection: 'column', gap: 2 },
  stageName: { fontWeight: 600 },
  stageState: { fontSize: 10, opacity: 0.82 },
  stageDone: { background: 'color-mix(in srgb, var(--dsw-alias-label-success) 12%, transparent)', color: 'var(--dsw-alias-label-success)' },
  stageCurrent: { background: 'color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent)', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
  stageUpcoming: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-tertiary)' },
  stageBlocked: { background: 'color-mix(in srgb, var(--dsw-alias-label-error) 10%, transparent)', color: 'var(--dsw-alias-label-error)', fontWeight: 600 },
  nextLine: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
  workspaceCard: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 14, background: 'var(--dsw-alias-bg-layer-2)', padding: 18, display: 'flex', flexDirection: 'column', gap: 14 },
  emptyTitle: { margin: 0, fontSize: 18, fontWeight: 650, color: 'var(--dsw-alias-label-primary)' },
  choiceGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 },
  choiceCard: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-3)', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 },
  choiceTitle: { margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  input: { width: '100%', boxSizing: 'border-box', height: 38, padding: '0 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', font: 'inherit' },
  primary: { alignSelf: 'flex-start', border: 0, borderRadius: 8, padding: '8px 14px', cursor: 'pointer', background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)' },
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 },
  summaryItem: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: 10, background: 'var(--dsw-alias-bg-layer-2)' },
  unavailable: { margin: 0, color: 'var(--dsw-alias-label-error)', lineHeight: 1.5 },
} satisfies Record<string, CSSProperties>

type RpcCaller = {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasSensitiveOwnKey(value: Record<string, unknown>): boolean {
  return Object.keys(value).some(key => /token|secret|payload|content/i.test(key))
}

function normalizeScholarProjection(value: unknown, expectedSessionId: string): ScholarSessionProjection | null {
  if (!isRecord(value) || typeof value.linked !== 'boolean' || value.session_id !== expectedSessionId) return null
  if (hasSensitiveOwnKey(value)) return null
  if (!Array.isArray(value.stages) || value.stages.length !== SCHOLAR_STAGE_IDS.length || !isRecord(value.summary)) return null
  const nonnegativeInteger = (candidate: unknown): candidate is number => Number.isInteger(candidate) && (candidate as number) >= 0
  if (!nonnegativeInteger(value.summary.pending_gates) || !isRecord(value.summary.jobs) || !isRecord(value.summary.counts)) return null
  for (const key of ['total', 'queued', 'running', 'succeeded', 'failed']) {
    if (!nonnegativeInteger(value.summary.jobs[key])) return null
  }
  if (!Object.values(value.summary.counts).every(nonnegativeInteger)) return null
  if (value.linked && (!isRecord(value.project) || hasSensitiveOwnKey(value.project)
    || typeof value.project.project_id !== 'string'
    || typeof value.project.name !== 'string' || typeof value.project.status !== 'string'
    || !nonnegativeInteger(value.project.revision)
    || (value.project.brief_status !== undefined && typeof value.project.brief_status !== 'string'))) return null
  if (!value.linked && (value.project !== undefined || value.next_action !== undefined || value.methodology !== undefined)) return null
  let methodology: ScholarMethodologySummary | undefined
  if (value.methodology !== undefined && value.methodology !== null) {
    if (!value.linked || !isRecord(value.project)) return null
    try {
      methodology = normalizeScholarMethodology(value.methodology, value.project.project_id as string)
    } catch {
      return null
    }
  }
  let nextAction: ScholarSessionProjection['next_action']
  if (value.next_action !== undefined) {
    if (!isRecord(value.next_action)
      || typeof value.next_action.code !== 'string'
      || typeof value.next_action.label !== 'string' || typeof value.next_action.reason !== 'string'
      || typeof value.next_action.route !== 'string'
      || (value.next_action.state !== 'ready' && value.next_action.state !== 'blocked' && value.next_action.state !== 'done')
      || typeof value.next_action.blocking !== 'boolean'
      || (value.next_action.required_by !== 'human' && value.next_action.required_by !== 'agent' && value.next_action.required_by !== 'runner')
      || (value.next_action.required !== true && (!Array.isArray(value.next_action.required)
        || !value.next_action.required.every(item => typeof item === 'string')))
      || (value.next_action.revision !== null && !nonnegativeInteger(value.next_action.revision))) return null
    nextAction = {
      code: value.next_action.code,
      label: value.next_action.label,
      reason: value.next_action.reason,
      route: value.next_action.route,
      state: value.next_action.state,
      blocking: value.next_action.blocking,
      required_by: value.next_action.required_by,
      required: value.next_action.required as true | string[],
      revision: value.next_action.revision,
    }
  }
  const validStages = value.stages.every((stage, index) => isRecord(stage)
    && stage.id === SCHOLAR_STAGE_IDS[index]
    && (stage.state === 'done' || stage.state === 'current' || stage.state === 'upcoming' || stage.state === 'blocked'))
  if (!validStages) return null
  const project = value.linked && isRecord(value.project) ? {
    project_id: value.project.project_id as string,
    name: value.project.name as string,
    status: value.project.status as string,
    revision: value.project.revision as number,
    ...(value.project.brief_status === undefined ? {} : { brief_status: value.project.brief_status as string }),
  } : undefined
  return {
    linked: value.linked,
    session_id: expectedSessionId,
    ...(project === undefined ? {} : { project }),
    stages: value.stages.map(stage => ({
      id: (stage as Record<string, unknown>).id as ScholarStageId,
      state: (stage as Record<string, unknown>).state as ScholarStageState,
    })),
    ...(nextAction === undefined ? {} : { next_action: nextAction }),
    ...(methodology === undefined ? {} : { methodology }),
    summary: {
      pending_gates: value.summary.pending_gates,
      jobs: {
        total: value.summary.jobs.total as number,
        queued: value.summary.jobs.queued as number,
        running: value.summary.jobs.running as number,
        succeeded: value.summary.jobs.succeeded as number,
        failed: value.summary.jobs.failed as number,
      },
      counts: Object.fromEntries(Object.entries(value.summary.counts).map(([key, count]) => [key, count as number])),
    },
  }
}

function normalizeProjectSummary(value: unknown): ScholarProjectSummary | null {
  if (!isRecord(value) || hasSensitiveOwnKey(value)
    || typeof value.project_id !== 'string' || !/^rsp_[a-z0-9_]+$/.test(value.project_id)
    || typeof value.name !== 'string' || typeof value.status !== 'string'
    || !Number.isInteger(value.revision) || (value.revision as number) < 0
    || (value.brief_status !== undefined && typeof value.brief_status !== 'string')) return null
  return {
    project_id: value.project_id,
    name: value.name,
    status: value.status,
    revision: value.revision as number,
    ...(value.brief_status === undefined ? {} : { brief_status: value.brief_status }),
  }
}

function normalizeScholarWorkspace(value: unknown, expectedSessionId: string): ScholarSessionWorkspace | null {
  if (!isRecord(value) || hasSensitiveOwnKey(value) || value.session_id !== expectedSessionId
    || !Array.isArray(value.available_projects)) return null
  const projection = normalizeScholarProjection(value.projection, expectedSessionId)
  if (projection === null) return null
  const projects = value.available_projects.map(normalizeProjectSummary)
  if (projects.some(project => project === null) || (projection.linked && projects.length !== 0)) return null
  return { session_id: expectedSessionId, projection, available_projects: projects as ScholarProjectSummary[] }
}

async function callScholarWorkspaceEndpoint(
  rpc: RpcCaller,
  endpoint: 'session-workspace' | 'session-bind' | 'session-create',
  sessionId: string,
  detail: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ScholarSessionWorkspace> {
  const normalized = normalizeDshSessionId(sessionId)
  if (normalized === undefined) throw new Error('Scholar session workspace is unavailable')
  const payload = { session_id: normalized, ...detail }
  const response = signal === undefined
    ? await rpc.call('/dsh-scholar-view', endpoint, payload)
    : await rpc.call('/dsh-scholar-view', endpoint, payload, signal)
  const workspace = !isRecord(response) || response.ok !== true
    ? null
    : normalizeScholarWorkspace(response.value, normalized)
  if (workspace === null) {
    throw new Error('Scholar session workspace is unavailable')
  }
  return workspace
}

export function callScholarSessionWorkspace(
  rpc: RpcCaller, sessionId: string, signal?: AbortSignal,
): Promise<ScholarSessionWorkspace> {
  return callScholarWorkspaceEndpoint(rpc, 'session-workspace', sessionId, {}, signal)
}

export function callScholarSessionBind(
  rpc: RpcCaller, sessionId: string, projectId: string, signal?: AbortSignal,
): Promise<ScholarSessionWorkspace> {
  if (!/^rsp_[a-z0-9_]+$/.test(projectId)) return Promise.reject(new Error('Scholar session workspace is unavailable'))
  return callScholarWorkspaceEndpoint(rpc, 'session-bind', sessionId, { project_id: projectId }, signal)
}

export function callScholarSessionCreate(
  rpc: RpcCaller, sessionId: string, name: string, signal?: AbortSignal,
): Promise<ScholarSessionWorkspace> {
  const normalizedName = name.trim()
  if (normalizedName === '' || normalizedName.length > 120) return Promise.reject(new Error('Scholar session workspace is unavailable'))
  return callScholarWorkspaceEndpoint(rpc, 'session-create', sessionId, { name: normalizedName }, signal)
}

const STAGE_KEYS: Record<ScholarStageId, ResearchConfigKey> = {
  init: 'stageInit', survey: 'stageSurvey', idea: 'stageIdea', reproduce: 'stageReproduce', contract: 'stageContract',
  experiment: 'stageExperiment', evidence: 'stageEvidence', writing: 'stageWriting', review: 'stageReview', release: 'stageRelease',
}
const STAGE_STATE_KEYS: Record<ScholarStageState, ResearchConfigKey> = {
  done: 'stageDone', current: 'stageCurrent', upcoming: 'stageUpcoming', blocked: 'stageBlocked',
}
const METHODOLOGY_RECOMMENDATION_KEYS: Record<string, ResearchConfigKey> = {
  configure_protocol: 'recommendConfigureProtocol',
  run_synthesis: 'recommendRunSynthesis',
  activate_knowledge: 'recommendActivateKnowledge',
  review_writing: 'recommendReviewWriting',
  run_assurance: 'recommendRunAssurance',
  direction_gate_review: 'recommendDirectionGateReview',
  direction_deepen_continue: 'recommendDirectionDeepen',
  direction_broaden_intake: 'recommendDirectionBroaden',
  direction_pivot_intake: 'recommendDirectionPivot',
  direction_conclude_prepare: 'recommendDirectionConclude',
  direction_pause_review: 'recommendDirectionPause',
  direction_overlay_stale: 'recommendDirectionStale',
  direction_overlay_invalid: 'recommendDirectionInvalid',
}
const KNOWLEDGE_STATUS_KEYS: Record<ScholarMethodologySummary['knowledge']['status'], ResearchConfigKey> = {
  'delivery-ready': 'knowledgeDeliveryReady', suppressed: 'knowledgeSuppressed', inactive: 'knowledgeInactive',
}
const TRIAD_STATUS_KEYS: Record<NonNullable<ScholarMethodologySummary['manuscript']['method_triad']>['status'], ResearchConfigKey> = {
  ready: 'methodTriadReady', diagnostic_gap: 'methodTriadGap',
}
const GUIDE_STATUS_KEYS: Record<NonNullable<ScholarMethodologySummary['manuscript']['section_guide']>['state'], ResearchConfigKey> = {
  active: 'sectionGuideActive', diagnostic_gap: 'sectionGuideGap',
}
const REVIEWER_STATUS_KEYS: Record<NonNullable<ScholarMethodologySummary['manuscript']['reviewer_panel']>['state'], ResearchConfigKey> = {
  complete: 'reviewerPanelComplete', partial: 'reviewerPanelPartial', missing: 'reviewerPanelMissing',
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

/** Focused DSH conversation panel; the full Scholar workbench opens separately. */
function ScholarView(props: ScholarViewProps) {
  const snapshot = props.useResearchSettings(value => value)
  const url = resolvedStandaloneUrl(snapshot.status === 'ready' ? snapshot.value : undefined)
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId.trim() : ''
  const actionController = useRef<AbortController | null>(null)
  const [workspace, setWorkspace] = useState<ScholarSessionWorkspace | null>(null)
  const [sessionState, setSessionState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [projectName, setProjectName] = useState('')
  const [actionState, setActionState] = useState<'idle' | 'binding' | 'creating'>('idle')
  const [actionError, setActionError] = useState<'bind' | 'create' | null>(null)
  const busy = actionState !== 'idle'

  useEffect(() => {
    actionController.current?.abort()
    actionController.current = null
    setWorkspace(null)
    setSessionState('loading')
    setSelectedProjectId('')
    setProjectName('')
    setActionState('idle')
    setActionError(null)
  }, [sessionId])

  useEffect(() => {
    if (busy) return
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
        if (active) setSessionState('failed')
        return
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        schedule()
        return
      }
      if (inFlight) return
      inFlight = true
      try {
        const value = await props.readSessionWorkspace(sessionId, controller.signal)
        if (!active || controller.signal.aborted) return
        setWorkspace(value)
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
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    void read()
    return () => {
      active = false
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [busy, props.readSessionWorkspace, refreshGeneration, sessionId])

  useEffect(() => () => { actionController.current?.abort() }, [])

  const runAction = async (kind: 'bind' | 'create'): Promise<void> => {
    if (busy || sessionId === '') return
    const controller = new AbortController()
    actionController.current?.abort()
    actionController.current = controller
    setActionState(kind === 'bind' ? 'binding' : 'creating')
    setActionError(null)
    try {
      const value = kind === 'bind'
        ? await props.bindSessionProject(sessionId, selectedProjectId, controller.signal)
        : await props.createSessionProject(sessionId, projectName, controller.signal)
      if (controller.signal.aborted) return
      setWorkspace(value)
      setSessionState('ready')
      setProjectName('')
    } catch {
      if (!controller.signal.aborted) setActionError(kind)
    } finally {
      if (actionController.current === controller) actionController.current = null
      if (!controller.signal.aborted) setActionState('idle')
    }
  }

  const projection = workspace?.projection ?? null
  const methodology = projection?.methodology
  const unavailableMethodologyBlocks = new Set(methodology?.unavailable_blocks ?? [])
  const options = workspace?.available_projects ?? []
  return (
    <section style={style.view} aria-label={props.t('title')}>
      <header style={style.viewHeader}>
        <p style={style.viewText}>{props.t('viewDescription')}</p>
        <button type="button" style={style.secondary} disabled={url === null} onClick={() => { if (url !== null) props.openStandalone(url) }}>
          {props.t('openStandalone')}
        </button>
      </header>
      <div style={style.viewBody}>
        <section style={style.sessionPanel} aria-label={props.t('sessionTimeline')}>
          <div style={style.sessionHeading}>
            <h2 style={style.sessionTitle}>{props.t('sessionTimeline')}</h2>
            <button type="button" style={style.secondary} disabled={busy} onClick={() => { setRefreshGeneration(value => value + 1) }}>
              {props.t('refreshStages')}
            </button>
          </div>
          {url === null ? <p role="alert" style={style.unavailable}>{props.t('viewUnavailable')}</p> : null}
          {sessionState === 'loading' ? <p role="status" style={style.projectMeta}>{props.t('sessionLoading')}</p> : null}
          {sessionState === 'failed' ? <p role="alert" style={style.error}>{props.t('sessionUnavailable')}</p> : null}
          {sessionState === 'ready' && projection?.linked === false ? (
            <div style={style.workspaceCard}>
              <div>
                <h3 style={style.emptyTitle}>{props.t('sessionUnlinkedTitle')}</h3>
                <p style={style.hint}>{props.t('sessionUnlinkedHint')}</p>
              </div>
              <div style={style.choiceGrid}>
                <form style={style.choiceCard} onSubmit={(event) => { event.preventDefault(); void runAction('bind') }}>
                  <h4 style={style.choiceTitle}>{props.t('chooseProject')}</h4>
                  {options.length === 0 ? <p style={style.hint}>{props.t('noProjects')}</p> : (
                    <select
                      aria-label={props.t('chooseProject')}
                      style={style.input}
                      value={selectedProjectId}
                      disabled={busy}
                      onChange={(event) => { setSelectedProjectId(event.target.value); setActionError(null) }}
                    >
                      <option value="">{props.t('chooseProjectPlaceholder')}</option>
                      {options.map(project => (
                        <option key={project.project_id} value={project.project_id} disabled={project.status === 'ARCHIVED'}>
                          {project.name} · {project.status}{project.status === 'ARCHIVED' ? ` (${props.t('archivedProject')})` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                  <button type="submit" style={style.primary} disabled={busy || selectedProjectId === ''}>
                    {props.t(actionState === 'binding' ? 'bindingProject' : 'bindProject')}
                  </button>
                  {actionError === 'bind' ? <p role="alert" style={style.error}>{props.t('bindFailed')}</p> : null}
                </form>
                <form style={style.choiceCard} onSubmit={(event) => { event.preventDefault(); void runAction('create') }}>
                  <h4 style={style.choiceTitle}>{props.t('createProjectTitle')}</h4>
                  <label style={style.label} htmlFor="dsh-scholar-project-name">{props.t('projectName')}</label>
                  <input
                    id="dsh-scholar-project-name"
                    style={style.input}
                    value={projectName}
                    maxLength={120}
                    disabled={busy}
                    placeholder={props.t('projectNamePlaceholder')}
                    onChange={(event) => { setProjectName(event.target.value); setActionError(null) }}
                  />
                  <button type="submit" style={style.primary} disabled={busy || projectName.trim() === ''}>
                    {props.t(actionState === 'creating' ? 'creatingProject' : 'createProject')}
                  </button>
                  {actionError === 'create' ? <p role="alert" style={style.error}>{props.t('createFailed')}</p> : null}
                </form>
              </div>
            </div>
          ) : null}
          {sessionState === 'ready' && projection?.linked === true && projection.project !== undefined ? (
            <div style={style.workspaceCard}>
              <p style={style.projectMeta}>
                {projection.project.name} · {projection.project.status} · {props.t('projectRevision')} {projection.project.revision}
              </p>
              <div style={style.stages} role="list">
                {projection.stages.map(stage => (
                  <span
                    key={stage.id}
                    role="listitem"
                    style={{ ...style.stage, ...style[`stage${stage.state[0]!.toUpperCase()}${stage.state.slice(1)}` as 'stageDone' | 'stageCurrent' | 'stageUpcoming' | 'stageBlocked'] }}
                    aria-label={`${props.t(STAGE_KEYS[stage.id])}: ${props.t(STAGE_STATE_KEYS[stage.state])}`}
                    aria-current={stage.state === 'current' || stage.state === 'blocked' ? 'step' : undefined}
                  >
                    <span style={style.stageName}>{props.t(STAGE_KEYS[stage.id])}</span>
                    <span style={style.stageState}>{props.t(STAGE_STATE_KEYS[stage.state])}</span>
                  </span>
                ))}
              </div>
              <div style={style.summaryGrid}>
                <div style={style.summaryItem}><p style={style.nextLine}>{props.t('pendingGates')}</p><strong>{projection.summary.pending_gates}</strong></div>
                <div style={style.summaryItem}><p style={style.nextLine}>{props.t('jobsSummary')}</p><strong>{projection.summary.jobs.total}</strong></div>
                <div style={style.summaryItem}><p style={style.nextLine}>{props.t('nextAction')}</p><strong>{projection.next_action?.label ?? '—'}</strong></div>
              </div>
              {projection.next_action === undefined ? null : (
                <p style={style.nextLine}>{props.t('nextReason')}: {projection.next_action.reason}</p>
              )}
              {methodology === undefined ? null : (
                <section aria-label={props.t('methodologyTitle')}>
                  <h3 style={style.choiceTitle}>{props.t('methodologyTitle')}</h3>
                  <div style={style.summaryGrid}>
                    <div style={style.summaryItem}>
                      <p style={style.nextLine}>{props.t('protocolStatus')}</p>
                      <strong>{unavailableMethodologyBlocks.has('protocol')
                        ? props.t('methodologyUnavailable')
                        : methodology.protocol === null
                        ? props.t('notConfigured')
                        : `${props.t(methodology.protocol.intent === 'exploratory' ? 'intentExploratory' : 'intentConfirmatory')} · ${props.t(methodology.protocol.status === 'frozen' ? 'protocolFrozen' : 'protocolDraft')}`}</strong>
                    </div>
                    <div style={style.summaryItem}>
                      <p style={style.nextLine}>{props.t('synthesisStatus')}</p>
                      <strong>{unavailableMethodologyBlocks.has('synthesis')
                        ? props.t('methodologyUnavailable')
                        : methodology.synthesis === null
                        ? props.t('notConfigured')
                        : props.t(methodology.synthesis.fresh ? 'fresh' : 'stale')}</strong>
                    </div>
                    <div style={style.summaryItem}>
                      <p style={style.nextLine}>{props.t('assuranceStatus')}</p>
                      <strong>{unavailableMethodologyBlocks.has('assurance')
                        ? props.t('methodologyUnavailable')
                        : methodology.assurance === null
                        ? props.t('notConfigured')
                        : props.t(methodology.assurance.ready ? 'ready' : 'notReady')}</strong>
                    </div>
                    <div style={style.summaryItem}>
                      <p style={style.nextLine}>{props.t('writingStatus')}</p>
                      <strong>{unavailableMethodologyBlocks.has('writing')
                        ? props.t('methodologyUnavailable')
                        : methodology.writing === null
                        ? props.t('notConfigured')
                        : `${methodology.writing.stale === null ? props.t('notConfigured') : props.t(methodology.writing.stale ? 'stale' : 'fresh')} · ${methodology.writing.blocking_count} ${props.t('blockingFindings')}`}</strong>
                    </div>
                    <div style={style.summaryItem}>
                      <p style={style.nextLine}>{props.t('knowledgeStatus')}</p>
                      <strong>
                        {unavailableMethodologyBlocks.has('knowledge')
                          ? props.t('methodologyUnavailable')
                          : <>{methodology.knowledge.active_count} {props.t('activePackages')} · {props.t(KNOWLEDGE_STATUS_KEYS[methodology.knowledge.status])}
                            {' · '}{methodology.knowledge.suppressed_count} {props.t('suppressedPackages')}</>}
                      </strong>
                    </div>
                    <div style={style.summaryItem}>
                      <p style={style.nextLine}>{props.t('manuscriptMethodStatus')}</p>
                      <strong>
                        {unavailableMethodologyBlocks.has('manuscript')
                          ? props.t('methodologyUnavailable')
                          : <>{methodology.manuscript.method_triad === null
                          ? props.t('notConfigured')
                          : props.t(TRIAD_STATUS_KEYS[methodology.manuscript.method_triad.status])}
                        {' · '}{methodology.manuscript.section_guide === null
                          ? props.t('notConfigured')
                          : props.t(GUIDE_STATUS_KEYS[methodology.manuscript.section_guide.state])}
                        {' · '}{methodology.manuscript.reviewer_panel === null
                          ? props.t('notConfigured')
                          : props.t(REVIEWER_STATUS_KEYS[methodology.manuscript.reviewer_panel.state])}
                        {' · '}{methodology.manuscript.patches.proposal_count} {props.t('patchProposals')}
                        {' · '}{methodology.manuscript.patches.application_count} {props.t('patchApplications')}</>}
                      </strong>
                    </div>
                    <div style={style.summaryItem}>
                      <p style={style.nextLine}>{props.t('runsStatus')}</p>
                      <strong>
                        {unavailableMethodologyBlocks.has('runs')
                          ? props.t('methodologyUnavailable')
                          : <>{methodology.runs.count} {props.t('runCount')}
                        {' · '}{methodology.runs.negative_finding_count} {props.t('negativeFindings')}
                        {' · '}{methodology.runs.claim_proposal_count} {props.t('claimProposals')}</>}
                      </strong>
                    </div>
                    <div style={style.summaryItem}>
                      <p style={style.nextLine}>{props.t('researchGraphStatus')}</p>
                      <strong>{unavailableMethodologyBlocks.has('topology')
                        ? props.t('methodologyUnavailable')
                        : <>{methodology.topology.research_node_count} {props.t('graphNodes')} · {methodology.topology.research_edge_count} {props.t('graphEdges')}</>}</strong>
                    </div>
                  </div>
                  {methodology.next_recommendation === null ? null : (
                    <p style={style.nextLine}>
                      {props.t('methodologyRecommendation')}: {props.t(
                        METHODOLOGY_RECOMMENDATION_KEYS[methodology.next_recommendation.code] ?? 'notConfigured',
                      )}
                    </p>
                  )}
                </section>
              )}
            </div>
          ) : null}
        </section>
      </div>
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
              {mode === 'full-auto' ? (
                <section style={style.automation} aria-label={t('automationTitle')}>
                  <div style={style.automationHead}>
                    <strong style={style.automationTitle}>{t('automationTitle')}</strong>
                    <span style={style.badge}>{t(snapshot.value.automation?.worker === 'running' ? 'automationRunning' : 'automationStopped')}</span>
                  </div>
                  {snapshot.value.automation?.restart_required === true
                    ? <p role="status" style={style.error}>{t('automationRestartRequired')}</p>
                    : null}
                  <p style={style.hint}>{t('automationFixtureOnly')}</p>
                  <p style={style.hint}>{t('automationReleaseHuman')}</p>
                  {snapshot.value.automation?.last_park === null || snapshot.value.automation?.last_park === undefined
                    ? null
                    : (
                      <p role="status" style={style.hint}>
                        {t('automationLastPark')}: {snapshot.value.automation.last_park.code} — {snapshot.value.automation.last_park.reason}
                      </p>
                    )}
                </section>
              ) : null}
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
  const readSessionWorkspace = (sessionId: string, signal?: AbortSignal): Promise<ScholarSessionWorkspace> =>
    callScholarSessionWorkspace(connection.rpc, sessionId, signal)
  const bindSessionProject = (sessionId: string, projectId: string, signal?: AbortSignal): Promise<ScholarSessionWorkspace> =>
    callScholarSessionBind(connection.rpc, sessionId, projectId, signal)
  const createSessionProject = (sessionId: string, projectName: string, signal?: AbortSignal): Promise<ScholarSessionWorkspace> =>
    callScholarSessionCreate(connection.rpc, sessionId, projectName, signal)
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }), 'dsh-scholar: configuration dictionaries')
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: SCHOLAR_SETTINGS_NAMESPACE,
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
      readSessionWorkspace,
      bindSessionProject,
      createSessionProject,
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
