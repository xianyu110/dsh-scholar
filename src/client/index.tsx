/** DSH browser half: contributes the Scholar card to Settings → Plugin config. */
import { useState, type CSSProperties } from 'react'
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-config/client'

/** Must match the Host plugin's settings namespace without importing Host code into the browser bundle. */
const RESEARCH_SETTINGS_NAMESPACE = 'research-plugin'

const LOCALE_NAMESPACE = 'settings.dshScholar'

type ResearchConfigKey =
  | 'title' | 'description' | 'restart' | 'expand' | 'collapse'
  | 'mode' | 'modeHint' | 'gateOnly' | 'fullAuto'
  | 'unattended' | 'unattendedHint' | 'overridden' | 'reset'
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

interface ResearchSettings {
  defaultMode?: 'gate-only' | 'full-auto'
  unattended?: boolean
}

interface ResearchCardFace {
  hooks: { researchSettings: SettingsScope<ResearchSettings> }
  setDefaultMode: (value: 'gate-only' | 'full-auto') => Promise<void>
  setUnattended: (value: boolean) => Promise<void>
  reset: (field: keyof ResearchSettings) => Promise<void>
}

type ResearchCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<typeof LOCALE_NAMESPACE>
  & InjectFace<ResearchCardFace>

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
  footer: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
    borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 12, marginTop: 8,
  },
  error: { flex: 1, margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-error)' },
  save: {
    border: 0, borderRadius: 8, padding: '6px 14px', cursor: 'pointer',
    background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)',
  },
} satisfies Record<string, CSSProperties>

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
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  if (snapshot.status !== 'ready' || snapshot.value === undefined) return null
  const mode = modeDraft ?? snapshot.value.defaultMode ?? 'gate-only'
  const unattended = unattendedDraft ?? snapshot.value.unattended ?? false
  const dirty = modeDraft !== undefined || unattendedDraft !== undefined
  const disabled = !snapshot.writable || saving

  const save = async (): Promise<void> => {
    if (!dirty || saving) return
    setSaving(true)
    setFailed(false)
    try {
      if (modeDraft !== undefined) await props.setDefaultMode(modeDraft)
      if (unattendedDraft !== undefined) await props.setUnattended(unattendedDraft)
      setModeDraft(undefined)
      setUnattendedDraft(undefined)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
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

/** Browser services required by the Scholar configuration card. */
export const inject = ['slots', 'locale', 'settingsScope']

/** Register the Scholar configuration card into DSH's plugin configuration slot. */
export function apply(ctx: ClientContext): void {
  const scope = ctx.settingsScope.bind<ResearchSettings>({ namespace: RESEARCH_SETTINGS_NAMESPACE })
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
      reset: field => scope.unset(field),
    }),
  }, ResearchConfigCard))
}
