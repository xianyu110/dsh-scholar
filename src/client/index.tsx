/** DSH browser half: contributes Settings plus the Scholar conversation view. */
import { useState, type CSSProperties } from 'react'
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
import type { ResearchSettings } from '../shared/settings-rpc.js'
import { ScholarSettingsScope } from './scholar-settings.js'

const LOCALE_NAMESPACE = 'settings.dshScholar'

type ResearchConfigKey =
  | 'title' | 'description' | 'restart' | 'expand' | 'collapse'
  | 'mode' | 'modeHint' | 'gateOnly' | 'fullAuto'
  | 'unattended' | 'unattendedHint' | 'overridden' | 'reset'
  | 'standaloneUrl' | 'standaloneUrlHint' | 'shortcut' | 'shortcutHint' | 'shortcutDisabled'
  | 'openStandalone' | 'copyToken' | 'copyingToken' | 'tokenCopied' | 'tokenCopyFailed'
  | 'viewDescription' | 'viewFrameTitle' | 'viewUnavailable'
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
  frame: { flex: 1, width: '100%', minHeight: 0, border: 0, background: '#fff' },
  unavailable: { margin: 24, color: 'var(--dsw-alias-label-error)' },
} satisfies Record<string, CSSProperties>

type RpcCaller = {
  call(channel: string, endpoint: string, payload: unknown): Promise<unknown>
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
      {url === null
        ? <p role="alert" style={style.unavailable}>{props.t('viewUnavailable')}</p>
        : (
          <iframe
            src={url}
            title={props.t('viewFrameTitle')}
            style={style.frame}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-forms allow-same-origin allow-downloads allow-modals"
          />
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
