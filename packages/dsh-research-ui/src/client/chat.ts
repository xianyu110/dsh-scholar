import type { ChatSession, ClaimRow, ContextMenuItem, GateRow, Projection } from './types'
import { api, authHeaders, base, ensureCsrfToken } from './api'
import { getLocale, t } from './i18n/index'
import { CHAT_COMMANDS } from './modals/commands'
import { openCommandHistoryModal, openGlobalSearchModal, openSessionSearchModal } from './modals/search'
import { CHAT_MAX, chatClear, chatPersist, chatPush, chatSessionArchive, chatSessionClose, chatSessionEnsure, chatSessionNew, chatSessionRename, chatSessionSelect, chatSessionsPersist, chatSyncActive, favCommands, historyPush, state, tabSave } from './state'
import { copyText, el, fmtId, openContextMenu, pill, rootHost, showToast } from './ui'
export let dragSessionId: string | null = null

/**
 * Chat transcript + built-in /research command executor. Mirrors the dsh web
 * dialogue feel (message bubbles + composer) while talking straight to the
 * Kernel API through the same bridge the panels use — no agent loop needed.
 * The composer persists across 8s panel refreshes via state.chatDraft.
 */

export function fmtProjectRow(p: { project_id?: string; name?: string; status?: string }): string {
  return `- **${p.name ?? '?'}** (\`${p.project_id ?? '?'}\`) — ${p.status ?? '?'}`
}

/** Parse `key=value` pairs from a JSON-ish argument string. */
export function chatJsonArg(rest: string): Record<string, unknown> | null {
  const start = rest.indexOf('{')
  if (start < 0) return null
  try {
    const parsed = JSON.parse(rest.slice(start)) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * Execute one chat line: either a /research subcommand or a bare word that
 * maps to one. Returns the assistant answer text.
 */
export async function executeChatCommand(line: string, activeProjectId: string | undefined): Promise<string> {
  const trimmed = line.trim().replace(/^\/research\s+/i, '').replace(/^\//, '')
  const parts = trimmed.split(/\s+/)
  const sub = (parts[0] ?? '').toLowerCase()
  const rest = trimmed.slice(sub.length).trim()

  switch (sub) {
    case '':
    case 'help': {
      return 'Commands:\n'
        + '  /research new <name> [json]      create project + Scope Gate\n'
        + '  /research list                   all projects\n'
        + '  /research status [project_id]    phase, gates, jobs, budget\n'
        + '  /research survey <query>         multi-source search + snapshot\n'
        + '  /research ideas                  IdeaCards\n'
        + '  /research gates [project_id]     gate list + decisions\n'
        + '  /research jobs [project_id]      job list\n'
        + '  /research contract <json>        pre-register a contract\n'
        + '  /research run <json>             submit a job\n'
        + '  /research evidence <json>        ingest evidence\n'
        + '  /research claims [project_id]    claims + verification status\n'
        + '  /research write / review / export / release\n'
        + '\nTry: /research new demo1 or /research status'
    }
    case 'new': {
      const name = parts[1] ?? ''
      if (name === '') return 'usage: /research new <name> [json]'
      const json = chatJsonArg(rest)
      const brief = {
        problem: String(json?.problem ?? 'To be specified in the Scope Gate.'),
        scope: String(json?.scope ?? 'To be specified in the Scope Gate.'),
        questions: Array.isArray(json?.questions) ? json.questions.map(String) : [],
        primary_metrics: Array.isArray(json?.primary_metrics) ? json.primary_metrics.map(String) : [],
        resources: String(json?.resources ?? ''),
        risks: [],
        target_outputs: ['conference-paper'],
        target_venue: null,
        baseline_repo: null,
        domain: 'machine-learning',
      }
      const project = await api<{ project_id?: string; name?: string; status?: string }>('/v1/projects', {
        method: 'POST',
        body: JSON.stringify({ name, workspace: `/research/${name}`, brief, mode: 'gate-only' }),
      })
      if (project === null || project.project_id === undefined) return 'create failed — kernel unreachable?'
      await api(`/v1/projects/${encodeURIComponent(project.project_id)}/gates`, {
        method: 'POST',
        body: JSON.stringify({ type: 'scope', title: `Scope Gate — ${name}`, summary: 'Approve the research scope, data policy, budget and target venue.' }),
      })
      state.projectId = project.project_id
      void state.rerender()
      return `Project **${project.project_id}** (${name}) created — DRAFT.\nScope Gate opened: approve it in Execution → Approvals (human only).`
    }
    case 'list': {
      const projects = (await api<Array<{ project_id?: string; name?: string; status?: string }>>('/v1/projects')) ?? []
      if (projects.length === 0) return 'No projects yet — try /research new demo1'
      return `Projects (${projects.length}):\n${projects.map(fmtProjectRow).join('\n')}`
    }
    case 'status': {
      const id = parts[1] ?? activeProjectId
      if (id === undefined) return 'No project selected — /research new <name> or /research status <project_id>'
      const p = await api<Projection>(`/v1/projects/${encodeURIComponent(id)}/projection`)
      if (p === null || p.project === undefined) return `project ${id} not found`
      const pending = (p.pending_gates ?? []).map(g => `- ${g.type} gate ${g.gate_id}: ${g.title} (${g.status})`).join('\n') || 'none'
      const jobs = (p.jobs ?? []).slice(-5).map(j => `- ${j.job_id} [${j.kind}] ${j.status}`).join('\n') || 'none'
      return `**${p.project.name}** (\`${id}\`) — phase \`${p.project.status}\` rev ${p.project.revision ?? 0}\n\n`
        + `Next actions:\n${(p.next_actions ?? []).map(a => `- ${a}`).join('\n') || 'none'}\n\n`
        + `Pending gates:\n${pending}\n\n`
        + `Recent jobs:\n${jobs}\n\n`
        + `Budget: $${p.budget?.model_cost_usd ?? 0} / ${p.project.constraints?.max_model_cost_usd ?? '∞'} max, `
        + `${p.budget?.gpu_hours ?? 0} / ${p.project.constraints?.max_gpu_hours ?? '∞'} GPU-h`
    }
    case 'survey': {
      const query = rest.trim()
      if (query === '') return 'usage: /research survey <query>'
      if (activeProjectId === undefined) return 'No project selected — /research new <name> first'
      const response = await fetch(`${base()}/api/chat/survey`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await authHeaders()), 'x-csrf-token': (await ensureCsrfToken()) ?? '' },
        body: JSON.stringify({ project_id: activeProjectId, query }),
      })
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '')
        return `survey unavailable on this host (${response.status} ${bodyText.slice(0, 120)})`
      }
      const result = (await response.json()) as { snapshot_id?: string; papers?: number; removed?: number; top?: Array<{ paper_id: string; title: string; year?: number }> }
      const top = (result.top ?? []).slice(0, 5).map(h => `- ${h.paper_id}: ${h.title} (${h.year ?? 'n.d.'})`).join('\n')
      return `Survey complete: **${result.snapshot_id}** — ${result.papers ?? 0} papers after dedup (${result.removed ?? 0} removed).\n\nTop hits:\n${top}\n\nNext: /research ideas`
    }
    case 'ideas': {
      if (activeProjectId === undefined) return 'No project selected — /research new <name> first'
      const ideas = (await api<Array<Record<string, unknown>>>(`/v1/projects/${encodeURIComponent(activeProjectId)}/ideas`)) ?? []
      if (ideas.length === 0) return 'No IdeaCards yet — create them with the idea_create tool, then novelty_audit before the Idea Gate.'
      return `IdeaCards:\n${ideas.map(i => `- \`${String(i.idea_id)}\` [${String(i.status ?? '')}] ${String(i.title ?? '')}`).join('\n')}`
    }
    case 'gates': {
      const id = parts[1] ?? activeProjectId
      if (id === undefined) return 'No project selected'
      const gates = (await api<GateRow[]>(`/v1/projects/${encodeURIComponent(id)}/gates`)) ?? []
      if (gates.length === 0) return 'No gates yet.'
      return `Gates:\n${gates.map(g => `- ${g.type} \`${g.gate_id}\` [${g.status}] ${g.title ?? ''}`).join('\n')}`
    }
    case 'jobs': {
      const id = parts[1] ?? activeProjectId
      if (id === undefined) return 'No project selected'
      const jobs = (await api<Array<{ job_id?: string; kind?: string; status?: string }>>(`/v1/projects/${encodeURIComponent(id)}/jobs`)) ?? []
      if (jobs.length === 0) return 'No jobs yet.'
      return `Jobs:\n${jobs.map(j => `- \`${j.job_id}\` [${j.kind}] ${j.status}`).join('\n')}`
    }
    case 'contract': {
      if (activeProjectId === undefined) return 'No project selected'
      const json = chatJsonArg(rest)
      if (json === null) return 'usage: /research contract {"idea_id":"...","dataset_id":"...","baseline":"b","treatment":"a","primary_metric":"m","seeds":[11,23,47]}'
      const seeds = Array.isArray(json.seeds) ? json.seeds.map(Number) : [11, 23, 47]
      const c = await api<{ contract_id?: string; status?: string }>(`/v1/projects/${encodeURIComponent(activeProjectId)}/contracts`, {
        method: 'POST',
        body: JSON.stringify({
          idea_id: String(json.idea_id ?? ''),
          data: { dataset_id: String(json.dataset_id ?? ''), version: 'official', split: 'official' },
          methods: { baseline: String(json.baseline ?? ''), treatment: String(json.treatment ?? '') },
          metrics: { primary: String(json.primary_metric ?? ''), secondary: [] },
          seeds,
          analysis: { effect_size: 'mean_difference', interval: 'bootstrap_95', multiple_testing: 'holm' },
          ablations: [],
          stop_conditions: { max_gpu_hours: 48, min_completed_seeds: seeds.length, stop_on_data_leakage: true },
        }),
      })
      if (c === null || c.contract_id === undefined) return 'contract registration failed'
      return `Contract **${c.contract_id}** registered — approve it in Execution → Approvals (human).`
    }
    case 'run': {
      if (activeProjectId === undefined) return 'No project selected'
      const json = chatJsonArg(rest)
      if (json === null || !Array.isArray(json.command)) return 'usage: /research run {"kind":"echo","command":["echo","hi"]}'
      const kind = String(json.kind ?? 'echo')
      const job = await api<{ job_id?: string; status?: string }>(`/v1/projects/${encodeURIComponent(activeProjectId)}/jobs`, {
        method: 'POST',
        body: JSON.stringify({
          idempotency_key: String(json.idempotency_key ?? `chat-${Date.now()}`),
          kind,
          command: json.command.map(String),
          payload: { message: `chat /research run ${kind}` },
          contract_id: typeof json.contract_id === 'string' ? json.contract_id : null,
        }),
      })
      if (job === null || job.job_id === undefined) return 'job submission failed'
      return `Job **${job.job_id}** [${kind}] submitted (${job.status}). Watch it in the Runs tab.`
    }
    case 'evidence': {
      if (activeProjectId === undefined) return 'No project selected'
      const json = chatJsonArg(rest)
      if (json === null || typeof json.analysis_method !== 'string') {
        return 'usage: /research evidence {"analysis_method":"bootstrap_95_mean_difference","result":{"primary_metric":"acc","value":0.9,"baseline_value":0.8,"effect_size":0.1,"ci_low":0.05,"ci_high":0.15,"n_seeds":3}}'
      }
      const ev = await api<{ evidence_id?: string }>(`/v1/projects/${encodeURIComponent(activeProjectId)}/evidence`, {
        method: 'POST',
        body: JSON.stringify({
          source_type: 'analysis',
          run_ids: Array.isArray(json.run_ids) ? json.run_ids.map(String) : [],
          artifact_refs: Array.isArray(json.artifact_refs) ? json.artifact_refs.map(String) : [],
          analysis_method: json.analysis_method,
          result: (json.result ?? {}) as Record<string, unknown>,
          provenance_status: 'draft_unverified',
        }),
      })
      if (ev === null || ev.evidence_id === undefined) return 'evidence ingestion failed'
      return `Evidence **${ev.evidence_id}** ingested (draft_unverified — only the Analysis Worker can verify).`
    }
    case 'claims': {
      const id = parts[1] ?? activeProjectId
      if (id === undefined) return 'No project selected'
      const claims = (await api<ClaimRow[]>(`/v1/projects/${encodeURIComponent(id)}/claims`)) ?? []
      if (claims.length === 0) return 'No claims yet.'
      return `Claims:\n${claims.map(c => `- \`${c.claim_id}\` [${c.status}] ${(c.statement ?? '').slice(0, 70)}`).join('\n')}`
    }
    case 'write': {
      if (activeProjectId === undefined) return 'No project selected'
      const draft = await api<{ manuscript_id?: string; claims_used?: number }>(`/v1/projects/${encodeURIComponent(activeProjectId)}/manuscripts/build`, {
        method: 'POST',
        body: JSON.stringify({ format: 'markdown', include_limitations: true }),
      })
      if (draft === null || draft.manuscript_id === undefined) return 'manuscript build failed'
      return `Manuscript **${draft.manuscript_id}** built (${draft.claims_used ?? 0} supported claims).`
    }
    case 'review': {
      if (activeProjectId === undefined) return 'No project selected'
      const review = await api<{ pass?: boolean; checks?: Array<{ check?: string; status?: string; detail?: string }> }>(`/v1/projects/${encodeURIComponent(activeProjectId)}/manuscript-review`)
      if (review === null) return 'review failed'
      const checks = (review.checks ?? []).map(c => `- [${c.status}] ${c.check}: ${c.detail}`).join('\n')
      return `Reviewer: ${review.pass === true ? 'PASS' : 'SEE CHECKS'}\n${checks}`
    }
    case 'export': {
      if (activeProjectId === undefined) return 'No project selected'
      const bundle = await api<{ bundle_id?: string }>(`/v1/projects/${encodeURIComponent(activeProjectId)}/release-bundle`, { method: 'POST' })
      if (bundle === null || bundle.bundle_id === undefined) return 'export failed'
      return `Release bundle **${bundle.bundle_id}** generated (private export, not publication).`
    }
    case 'release': {
      if (activeProjectId === undefined) return 'No project selected'
      const gate = await api<{ gate_id?: string }>(`/v1/projects/${encodeURIComponent(activeProjectId)}/gates`, {
        method: 'POST',
        body: JSON.stringify({ type: 'release', title: 'Release Gate — explicit human decision required', summary: 'Explicit human decision required: authors, licenses, public scope and target platform.' }),
      })
      if (gate === null || gate.gate_id === undefined) return 'release gate creation failed'
      return `Release Gate **${gate.gate_id}** created and left **pending** (human only).`
    }
    default:
      return `Unknown command: /research ${sub}. Try /research help`
  }
}


/**
 * Chat tab: message bubbles (dsh-web style) + a composer that runs
 * /research commands directly against the Kernel bridge. The transcript
 * survives 8s panel refreshes (state.chatMessages), as does the draft text.
 * Clicking a message opens the dsh-web "details" side panel.
 */

export let chatSearchQuery = ''
/** dsh-web quote-reply: pending quote attached to the next user message. */

export let chatCommandsOnly = false
/** Global search state (dsh-web cross-session search). */

export async function renderChat(body: HTMLElement, dock: HTMLElement, projectId: string): Promise<void> {
  // Rebuild the persistent footer synchronously. Its old geometry stays in
  // place throughout async refresh work, and this swap cannot paint halfway.
  dock.replaceChildren()
  const shell = el('div', 'chat-shell')

  const column = el('div', 'chat-column')
  shell.appendChild(column)

  // dsh-web session tabs: switch / create / close chat sessions (the row
  // scrolls horizontally instead of wrapping with many sessions).
  const sessionTabs = el('div', 'chat-session-tabs')
  for (const s of state.chatSessions) {
    const tab = el('button', 'hbtn')
    tab.textContent = s.name
    tab.style.cssText = 'padding:3px 10px;font-size:10.5px'
    // dsh-web pinned sessions: ★ marker on the chip.
    if (s.pinned === true) {
      const pinStar = el('span', '', '★ ')
      pinStar.style.cssText = 'color:var(--tone-amber);font-size:9px'
      tab.prepend(pinStar)
    }
    // dsh-web session depth: message count on the chip.
    if ((s.messages ?? []).length > 0) {
      const cnt = el('span', 'muted', ` ${s.messages.length}`)
      cnt.style.cssText = 'font-size:9px;opacity:.75'
      tab.appendChild(cnt)
    }
    if (s.id !== state.chatActiveId && (s.unread ?? 0) > 0) {
      const badge = el('span', 'artifact-kind', `${s.unread}${(s.unread ?? 0) > 99 ? '+' : ''}`)
      badge.style.cssText += ';margin-left:4px;color:var(--tone-amber);font-weight:700'
      tab.appendChild(badge)
    }
    if (s.id === state.chatActiveId) {
      tab.style.cssText += ';border-color:var(--accent);color:var(--accent-text);background:var(--accent-soft)'
    }
    tab.onclick = () => { chatSessionSelect(s.id) }
    // dsh-web session tabs: middle-click closes the session.
    tab.onmousedown = (event) => {
      if (event.button === 1) {
        event.preventDefault()
        chatSessionClose(s.id)
      }
    }
    tab.ondblclick = (event) => {
      event.stopPropagation()
      chatSessionRename(s.id)
    }
    tab.title = t('shell', 'shell.chat.tabTitle', { name: s.name })
    sessionTabs.appendChild(tab)
    // dsh-web session actions: archive/restore.
    const arch = el('button', 'hbtn ghost', s.archived === true ? '↩' : '🗄')
    arch.title = s.archived === true ? t('shell', 'shell.chat.sessionRestore') : t('shell', 'shell.chat.sessionArchive')
    arch.style.cssText = 'padding:0 4px;font-size:10px'
    arch.onclick = (event) => {
      event.stopPropagation()
      chatSessionArchive(s.id)
    }
    const close = el('button', 'hbtn ghost', '×')
    close.style.cssText = 'padding:0 4px;font-size:10px'
    close.title = t('shell', 'shell.chat.closeTabTitle', { name: s.name })
    close.onclick = (event) => {
      event.stopPropagation()
      chatSessionClose(s.id)
    }
    const wrap = el('span')
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:2px;border:1px solid var(--border);border-radius:8px;padding:1px 4px'
    if (s.id === state.chatActiveId) {
      wrap.style.cssText += ';border-color:var(--accent);background:var(--accent-soft)'
      wrap.setAttribute('aria-current', 'true')
    } else {
      wrap.removeAttribute('aria-current')
    }
    if (s.archived === true) wrap.style.cssText += ';opacity:.45'
    // dsh-web session tabs: drag to reorder the session list.
    wrap.draggable = true
    wrap.title = t('shell', 'shell.chat.tabDragTitle')
    wrap.addEventListener('dragstart', (event) => {
      dragSessionId = s.id
      event.dataTransfer?.setData('text/plain', s.id)
      wrap.style.opacity = '0.4'
    })
    wrap.addEventListener('dragend', () => { wrap.style.opacity = '' })
    wrap.addEventListener('dragover', (event) => { event.preventDefault() })
    wrap.addEventListener('drop', (event) => {
      event.preventDefault()
      const from = dragSessionId
      if (from === null || from === s.id) return
      const fromIdx = state.chatSessions.findIndex(x => x.id === from)
      const toIdx = state.chatSessions.findIndex(x => x.id === s.id)
      if (fromIdx < 0 || toIdx < 0) return
      const [moved] = state.chatSessions.splice(fromIdx, 1)
      state.chatSessions.splice(toIdx, 0, moved!)
      dragSessionId = null
      chatSessionsPersist()
      state.rerender()
    })
    // dsh-web context menu: right-click on a session chip.
    wrap.oncontextmenu = (event) => {
      event.preventDefault()
      event.stopPropagation()
      const root = rootHost()
      if (root == null) return
      const ctxItems: ContextMenuItem[] = [
        { label: t('common', 'common.action.open'), onPick: () => chatSessionSelect(s.id) },
        { label: `✎ ${t('common', 'common.action.rename')}`, onPick: () => chatSessionRename(s.id) },
        {
          label: s.pinned === true ? `★ ${t('shell', 'shell.chat.unpinTitle')}` : `☆ ${t('shell', 'shell.chat.pinTitle')}`,
          onPick: () => {
            s.pinned = !s.pinned
            chatSessionsPersist()
            chatSyncActive()
            state.rerender()
          },
        },
        {
          label: t('shell', 'shell.chat.duplicate'),
          onPick: () => {
            const copy: ChatSession = {
              ...s,
              id: `s${Date.now()}`,
              name: `${s.name} copy`,
              messages: s.messages.map(m => ({ ...m })),
              unread: 0,
              archived: false,
            }
            state.chatSessions.push(copy)
            state.chatActiveId = copy.id
            state.chatDraft = ''
            chatSyncActive()
            chatSessionsPersist()
            state.rerender()
            showToast(rootHost(), t('shell', 'shell.chat.duplicated', { name: s.name }))
          },
        },
        { label: s.archived === true ? `↩ ${t('common', 'common.action.restore')}` : `🗄 ${t('common', 'common.action.archive')}`, onPick: () => chatSessionArchive(s.id) },
        { label: t('common', 'common.action.copyId'), hint: s.id, onPick: () => copyText(s.id) },
        {
          label: t('shell', 'shell.chat.searchHere'),
          onPick: () => {
            chatSessionSelect(s.id)
            state.activeTab = 'chat'
            tabSave()
            state.rerender()
            setTimeout(() => {
              const rootEl = rootHost()
              const searchInput = rootEl?.querySelector('input[placeholder*="Search conversation"]') as HTMLInputElement | null
              searchInput?.focus()
            }, 120)
          },
        },
        {
          label: t('common', 'common.action.exportJson'),
          divider: true,
          onPick: () => {
            const payload = JSON.stringify({
              name: s.name,
              session_id: s.id,
              exported_at: new Date().toISOString(),
              messages: s.messages,
            }, null, 2)
            const blob = new Blob([payload], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const a = el('a', 'dl', t('common', 'common.action.download'))
            a.href = url
            a.download = `research-session-${new Date().toISOString().slice(0, 10)}.json`
            document.body.appendChild(a)
            a.click()
            a.remove()
            setTimeout(() => URL.revokeObjectURL(url), 4000)
            showToast(rootHost(), t('shell', 'shell.chat.exported', { name: s.name }))
          },
        },
        {
          label: t('shell', 'shell.chat.clearConversation'),
          onPick: () => {
            chatClear()
            state.rerender()
          },
        },
        {
          label: t('common', 'common.action.exportMd'),
          onPick: () => {
            const lines = [`# Research OS conversation — ${s.name}`, '', ...s.messages.map(m => {
              const role = m.role === 'user' ? '**You**' : m.role === 'error' ? '**Error**' : '**Research OS**'
              return `## ${role} · ${m.time}\n\n${m.text}\n`
            })]
            const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
            const url = URL.createObjectURL(blob)
            const a = el('a', 'dl', t('common', 'common.action.download'))
            a.href = url
            a.download = `research-session-${s.name.replaceAll(' ', '-').slice(0, 24)}-${new Date().toISOString().slice(0, 10)}.md`
            document.body.appendChild(a)
            a.click()
            a.remove()
            setTimeout(() => URL.revokeObjectURL(url), 4000)
            showToast(rootHost(), t('shell', 'shell.chat.exportedMd', { name: s.name }))
          },
        },
        { label: `× ${t('common', 'common.action.close')}`, danger: true, divider: true, onPick: () => chatSessionClose(s.id) },
      ]
      openContextMenu(root, event.clientX, event.clientY, ctxItems)
    }
    wrap.appendChild(tab)
    wrap.appendChild(arch)
    wrap.appendChild(close)
    sessionTabs.appendChild(wrap)
  }
  const newSession = el('button', 'hbtn', '＋')
  newSession.title = t('shell', 'shell.chat.newSessionTitle')
  newSession.style.cssText = 'padding:3px 9px;font-size:11px'
  newSession.onclick = () => { chatSessionNew() }
  sessionTabs.appendChild(newSession)
  // dsh-web backup: export every session (transcripts included) as JSON.
  const backupBtn = el('button', 'hbtn', '💾')
  backupBtn.title = t('shell', 'shell.chat.backupTitle')
  backupBtn.setAttribute('aria-label', t('shell', 'shell.chat.backupAria'))
  backupBtn.style.cssText = 'padding:3px 9px;font-size:11px'
  backupBtn.onclick = () => {
    const payload = JSON.stringify({
      exported_at: new Date().toISOString(),
      sessions: state.chatSessions.map(s => ({ ...s, messages: s.messages.slice(-CHAT_MAX) })),
    }, null, 2)
    const blob = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = el('a', 'dl', t('common', 'common.action.download'))
    a.href = url
    a.download = `research-sessions-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    showToast(rootHost(), t('shell', 'shell.chat.backedUp', { count: String(state.chatSessions.length) }))
  }
  sessionTabs.appendChild(backupBtn)
  // dsh-web restore: import sessions back from a backup JSON file.
  const restoreBtn = el('button', 'hbtn', '⬆')
  restoreBtn.title = t('shell', 'shell.chat.restoreTitle')
  restoreBtn.setAttribute('aria-label', t('shell', 'shell.chat.restoreAria'))
  restoreBtn.style.cssText = 'padding:3px 9px;font-size:11px'
  const fileInput = document.createElement('input')
  fileInput.type = 'file'
  fileInput.accept = 'application/json,.json'
  fileInput.style.display = 'none'
  fileInput.onchange = () => {
    const file = fileInput.files?.[0]
    if (file === undefined) return
    void file.text().then((raw) => {
      try {
        const parsed = JSON.parse(raw) as { sessions?: unknown }
        const list = Array.isArray(parsed.sessions) ? parsed.sessions : null
        if (list === null || list.length === 0) throw new Error('no sessions')
        const cleaned = list.filter((s): s is ChatSession => typeof s === 'object' && s !== null
          && typeof (s as ChatSession).id === 'string' && Array.isArray((s as ChatSession).messages))
        if (cleaned.length === 0) throw new Error('invalid shape')
        state.chatSessions = cleaned
        chatSessionEnsure()
        chatSessionsPersist()
        state.rerender()
        showToast(rootHost(), t('shell', 'shell.chat.restored', { count: String(cleaned.length) }))
      } catch {
        showToast(rootHost(), t('shell', 'shell.chat.restoreFailed'))
      }
    })
    fileInput.value = ''
  }
  restoreBtn.onclick = () => fileInput.click()
  document.body.appendChild(fileInput)
  sessionTabs.appendChild(restoreBtn)
  // dsh-web session memory: keep the active chip visible when the tab row
  // scrolls (many sessions).
  requestAnimationFrame(() => {
    const activeWrap = [...sessionTabs.querySelectorAll('span')].find(w => w.getAttribute('aria-current') === 'true')
    activeWrap?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  })
  column.appendChild(sessionTabs)

  // Transcript search box (dsh-web "Search sessions" on the chat itself):
  // filters which messages are shown; matches are highlighted.
  const searchRow = el('div', 'chat-search-row')
  const searchInput = document.createElement('input')
  searchInput.type = 'text'
  searchInput.placeholder = t('shell', 'shell.chat.searchPlaceholder')
  searchInput.value = chatSearchQuery
  searchInput.style.cssText = 'flex:1;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:5px 10px;font:11px/1.4 system-ui,sans-serif;outline:none'
  searchInput.onfocus = () => { searchInput.style.borderColor = 'var(--accent)' }
  searchInput.onblur = () => { searchInput.style.borderColor = 'var(--border)' }
  searchInput.oninput = () => { chatSearchQuery = searchInput.value; state.rerender() }
  const clearSearch = el('button', 'hbtn', '×')
  clearSearch.title = t('shell', 'shell.chat.clearSearchTitle')
  clearSearch.style.cssText = 'padding:0 7px'
  clearSearch.onclick = () => {
    chatSearchQuery = ''
    state.rerender()
  }
  searchRow.append(searchInput, clearSearch)
  // dsh-web cross-session search: search claims/evidence across projects.
  const globalBtn = el('button', 'hbtn', t('shell', 'shell.chat.globalSearch'))
  globalBtn.title = t('shell', 'shell.chat.globalSearchTitle')
  globalBtn.style.cssText = 'padding:0 8px;flex-shrink:0'
  globalBtn.onclick = () => {
    const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
    if (root != null) openGlobalSearchModal(root)
  }
  // dsh-web cross-session search: every chat session's transcript.
  const allBtn = el('button', 'hbtn', t('shell', 'shell.chat.all'))
  allBtn.title = t('shell', 'shell.chat.allTitle')
  allBtn.style.cssText = 'padding:0 8px;flex-shrink:0'
  allBtn.onclick = () => {
    const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
    if (root != null) openSessionSearchModal(root)
  }
  searchRow.appendChild(globalBtn)
  searchRow.appendChild(allBtn)
  // dsh-web "commands only" filter: a compact list of just the commands.
  const commandsOnlyBtn = el('button', 'hbtn', chatCommandsOnly ? t('shell', 'shell.chat.commandsOnlyOn') : t('shell', 'shell.chat.commandsOnly'))
  commandsOnlyBtn.title = t('shell', 'shell.chat.commandsOnlyTitle')
  commandsOnlyBtn.setAttribute('aria-pressed', chatCommandsOnly ? 'true' : 'false')
  commandsOnlyBtn.style.cssText = 'padding:0 8px;flex-shrink:0'
  commandsOnlyBtn.onclick = () => {
    chatCommandsOnly = !chatCommandsOnly
    state.rerender()
  }
  searchRow.appendChild(commandsOnlyBtn)
  // dsh-web match counter: how many messages the current filter shows.
  const matchLabel = el('span', 'muted', '')
  matchLabel.style.cssText = 'font-size:9.5px;flex-shrink:0'
  searchRow.appendChild(matchLabel)
  // dsh-web command history panel: all executed commands in one view.
  const historyBtn = el('button', 'hbtn', t('shell', 'shell.chat.history'))
  historyBtn.title = t('shell', 'shell.chat.historyTitle')
  historyBtn.style.cssText = 'padding:0 8px;flex-shrink:0'
  historyBtn.onclick = () => {
    const root = document.querySelector('#dsh-scholar-ui')?.shadowRoot
    if (root != null) openCommandHistoryModal(root)
  }
  searchRow.appendChild(historyBtn)
  // dsh-web share: export the whole transcript as markdown.
  const exportChatBtn = el('button', 'hbtn', t('shell', 'shell.chat.exportMd'))
  exportChatBtn.title = t('shell', 'shell.chat.exportMdTitle')
  exportChatBtn.style.cssText = 'padding:0 8px;flex-shrink:0'
  exportChatBtn.onclick = () => {
    const activeName = state.chatSessions.find(x => x.id === state.chatActiveId)?.name ?? 'conversation'
    const lines = [`# Research OS conversation — ${activeName}`, '', ...state.chatMessages.map(m => {
      const role = m.role === 'user' ? '**You**' : m.role === 'error' ? '**Error**' : '**Research OS**'
      return `## ${role} · ${m.time}\n\n${m.text}\n`
    })]
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = el('a', 'dl', t('common', 'common.action.download'))
    a.href = url
    a.download = `research-conversation-${new Date().toISOString().slice(0, 10)}.md`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }
  searchRow.appendChild(exportChatBtn)
  // dsh-web export: the same transcript as JSON (session metadata included).
  const exportJsonBtn = el('button', 'hbtn', t('shell', 'shell.chat.exportJson'))
  exportJsonBtn.title = t('shell', 'shell.chat.exportJsonTitle')
  exportJsonBtn.style.cssText = 'padding:0 8px;flex-shrink:0'
  exportJsonBtn.onclick = () => {
    const active = state.chatSessions.find(x => x.id === state.chatActiveId)
    const payload = JSON.stringify({
      name: active?.name ?? 'conversation',
      session_id: state.chatActiveId,
      exported_at: new Date().toISOString(),
      messages: state.chatMessages,
    }, null, 2)
    const blob = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = el('a', 'dl', t('common', 'common.action.download'))
    a.href = url
    a.download = `research-conversation-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }
  searchRow.appendChild(exportJsonBtn)
  // dsh-web quick commands: favourite commands as one-tap chips.
  const favs = favCommands()
  for (const [name, line] of CHAT_COMMANDS) {
    if (!favs.has(name)) continue
    const chip = el('button', 'hbtn', `★ ${name}`)
    chip.title = t('shell', 'shell.chat.quickRunTitle', { line })
    chip.style.cssText = 'padding:0 8px;flex-shrink:0;color:var(--tone-amber)'
    chip.onclick = () => {
      state.chatDraft = line
      state.activeTab = 'chat'
      tabSave()
      state.rerender()
      setTimeout(() => {
        const rootEl = rootHost()
        const ta = rootEl?.querySelector('textarea[placeholder*="research"]') as HTMLTextAreaElement | null
        ta?.focus()
      }, 120)
    }
    searchRow.appendChild(chip)
  }
  column.appendChild(searchRow)

  // dsh-web scroll affordance: wrap the transcript so a "jump to bottom"
  // button can float over it while the user scrolls up.
  const streamWrap = el('div', 'chat-stream-wrap')
  const stream = el('div', 'chat-stream')
  // dsh-web a11y: announce assistant replies as they land.
  stream.setAttribute('aria-live', 'polite')
  stream.setAttribute('aria-label', t('shell', 'shell.chat.conversationAria'))
  const jumpBottom = el('button', 'hbtn', '↓')
  jumpBottom.title = t('shell', 'shell.chat.jumpNewest')
  jumpBottom.setAttribute('aria-label', t('shell', 'shell.chat.jumpNewestAria'))
  jumpBottom.style.cssText = 'position:absolute;right:10px;bottom:10px;padding:2px 10px;font-size:12px;display:none;box-shadow:0 4px 16px rgba(0,0,0,.25)'
  jumpBottom.onclick = () => { stream.scrollTop = stream.scrollHeight }
  stream.onscroll = () => {
    const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120
    jumpBottom.style.display = nearBottom ? 'none' : 'inline-block'
  }
  streamWrap.append(stream, jumpBottom)
  if (state.chatMessages.length === 0) {
    chatPush('assistant', t('shell', 'shell.chat.welcome'))
    // dsh-web starter chips: one-tap quick commands for a fresh session.
    const starters = el('div')
    starters.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;padding:2px'
    const starterDefs: Array<[string, string]> = [
      [t('shell', 'shell.chat.starterNew'), '/research new demo1'],
      [t('shell', 'shell.chat.starterList'), '/research list'],
      [t('shell', 'shell.chat.starterStatus'), '/research status'],
      [t('shell', 'shell.chat.starterClaims'), '/research claims'],
      [t('shell', 'shell.chat.starterWrite'), '/research write'],
      [t('shell', 'shell.chat.starterExport'), '/research export'],
    ]
    for (const [label, line] of starterDefs) {
      const chip = el('button', 'hbtn', label)
      chip.style.cssText = 'padding:3px 10px;font-size:10.5px'
      chip.onclick = () => {
        state.chatDraft = line
        state.rerender()
        setTimeout(() => {
          const rootEl = rootHost()
          const ta = rootEl?.querySelector('textarea[placeholder*="research"]') as HTMLTextAreaElement | null
          ta?.focus()
        }, 120)
      }
      starters.appendChild(chip)
    }
    stream.appendChild(starters)
  }
  const searchQ = chatSearchQuery.trim().toLowerCase()
  // dsh-web virtualized feel: window the transcript to the newest 80
  // messages (search/commands-only views render everything).
  const windowed = searchQ === '' && !chatCommandsOnly && state.chatMessages.length > 80
  const startIdx = windowed ? state.chatMessages.length - 80 : 0
  if (windowed) {
    const notice = el('div', 'muted', t('shell', 'shell.chat.showingNewest', { count: String(state.chatMessages.length) }))
    notice.style.cssText = 'font-size:10px;padding:2px;text-align:center'
    stream.appendChild(notice)
  }
  // dsh-web pinned: starred messages surface in a 📌 box (click to jump).
  const pinnedMsgs = state.chatMessages.filter(m => m.pinned === true)
  if (pinnedMsgs.length > 0 && searchQ === '' && !chatCommandsOnly) {
    const pinBox = el('div')
    pinBox.style.cssText = 'border:1px dashed var(--tone-amber);border-radius:10px;padding:6px 10px;display:flex;flex-direction:column;gap:4px;background:var(--tone-amber-bg)'
    pinBox.appendChild(el('div', 'muted', t('shell', 'shell.chat.pinned', { count: String(pinnedMsgs.length) })))
    for (const pm of pinnedMsgs) {
      const idx = state.chatMessages.indexOf(pm)
      const prow = el('div')
      prow.style.cssText = 'display:flex;gap:8px;align-items:center;cursor:pointer;font-size:11px;color:var(--text)'
      prow.title = t('shell', 'shell.chat.pinnedJump')
      // raw session-role marker on the pinned row (user/OS), kept verbatim
      const roleTag = el('span', 'artifact-kind', pm.role === 'user' ? 'YOU' : 'OS')
      const preview = el('span', 'grow', pm.text.slice(0, 90) + (pm.text.length > 90 ? '…' : ''))
      preview.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
      prow.append(roleTag, preview)
      prow.onclick = () => { state.chatDetailIndex = idx; state.rerender() }
      pinBox.appendChild(prow)
    }
    stream.appendChild(pinBox)
  }
  let shownCount = 0
  for (let i = startIdx; i < state.chatMessages.length; i++) {
    const msg = state.chatMessages[i]!
    if (searchQ !== '' && !msg.text.toLowerCase().includes(searchQ)) continue
    if (chatCommandsOnly && msg.role !== 'user') continue
    shownCount += 1
    // dsh-web quote-reply: quoted message preview above the bubble.
    if (msg.quote !== undefined) {
      const quoteBox = el('div')
      quoteBox.style.cssText = msg.role === 'user'
        ? 'align-self:flex-end;max-width:85%;background:var(--accent-soft);border-left:3px solid var(--accent);border-radius:6px;padding:4px 10px;font-size:10.5px;color:var(--text-2);margin-bottom:-4px;cursor:pointer'
        : 'align-self:flex-start;max-width:90%;background:var(--bg-3);border-left:3px solid var(--border-strong);border-radius:6px;padding:4px 10px;font-size:10.5px;color:var(--text-2);margin-bottom:-4px;cursor:pointer'
      const quotedIndex = msg.quote.index
      const quoted = state.chatMessages[quotedIndex]
      const quoteLabel = el('span', '', quoted !== undefined
        // raw role marker in the quote preview (you/assistant), kept verbatim
        ? `↩ ${quoted.role === 'user' ? 'you' : 'assistant'}: ${quoted.text.slice(0, 60)}${quoted.text.length > 60 ? '…' : ''}`
        : `↩ #${quotedIndex + 1}`)
      quoteBox.appendChild(quoteLabel)
      quoteBox.title = t('shell', 'shell.chat.quoteJump')
      quoteBox.onclick = () => {
        state.chatDetailIndex = quotedIndex >= 0 && quotedIndex < state.chatMessages.length ? quotedIndex : -1
        state.rerender()
      }
      stream.appendChild(quoteBox)
    }
    const bubble = el('div', `chat-message ${msg.role}`)
    if (state.chatDetailIndex === i) {
      bubble.classList.add('selected')
    }
    // Rich line rendering (headings/lists/code/bold) — textContent-safe.
    // /research status answers render as a field-card grid (dsh-web
    // structured results) instead of raw text.
    const isStatus = msg.role === 'assistant' && /^\*\*.*\*\* \(`rsp_/.test(msg.text) && msg.text.includes('Next actions:')
    const isSurvey = msg.role === 'assistant' && msg.text.startsWith('Survey complete:')
    const isRun = msg.role === 'assistant' && /Job \*\*[^*]+\*\* \[[^\]]+\] submitted/.test(msg.text)
    const isEvidence = msg.role === 'assistant' && /Evidence \*\*[^*]+\*\* ingested/.test(msg.text)
    const isGate = msg.role === 'assistant' && /Gate \*\*[^*]+\*\* (?:created|opened)/.test(msg.text)
    const isContract = msg.role === 'assistant' && /Contract \*\*[^*]+\*\* registered/.test(msg.text)
    const isWrite = msg.role === 'assistant' && /Manuscript \*\*[^*]+\*\* built/.test(msg.text)
    const isReview = msg.role === 'assistant' && msg.text.startsWith('Reviewer:')
    const isExport = msg.role === 'assistant' && /Release bundle \*\*[^*]+\*\* generated/.test(msg.text)
    const isIdeas = msg.role === 'assistant' && /^IdeaCards:/m.test(msg.text)
    const isList = msg.role === 'assistant' && /^Projects \(\d+\):/m.test(msg.text)
    const isJobs = msg.role === 'assistant' && /^Jobs:/m.test(msg.text)
    const isGatesList = msg.role === 'assistant' && /^Gates:/m.test(msg.text)
    const isClaims = msg.role === 'assistant' && /^Claims:/m.test(msg.text)
    let structured: HTMLElement | null = null
    if (isStatus && searchQ === '') {
      const phaseMatch = /phase `([^`]+)` rev (\d+)/.exec(msg.text)
      const pendingMatch = msg.text.match(/Pending gates:\n([\s\S]*?)\n\n/)
      const jobsMatch = msg.text.match(/Recent jobs:\n([\s\S]*?)\n\n/)
      const budgetMatch = /Budget: \$([\d.]+) \/ ([\d.]+|\S+) max, ([\d.]+) \/ ([\d.]+|\S+) GPU-h/.exec(msg.text)
      const grid = el('div')
      grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:4px 0'
      if (phaseMatch !== null) {
        grid.appendChild(chatFieldCell(t('shell', 'shell.chat.fieldPhase'), `${phaseMatch[1]} · rev ${phaseMatch[2]}`))
      }
      const next = msg.text.split('Next actions:')[1]?.split('\n\n')[0]?.split('\n').filter(l => l.trim().startsWith('- ')).map(l => l.trim().slice(2)).slice(0, 3).join('; ') ?? '—'
      grid.appendChild(chatFieldCell(t('shell', 'shell.chat.fieldNext'), next || '—'))
      const pending = pendingMatch !== null ? (pendingMatch[1] ?? '').split('\n').filter(l => l.trim() !== '').slice(0, 3).map(l => l.trim()).join('; ') : 'none'
      grid.appendChild(chatFieldCell(t('shell', 'shell.chat.fieldPendingGates'), pending || 'none'))
      const jobs = jobsMatch !== null ? (jobsMatch[1] ?? '').split('\n').filter(l => l.trim() !== '').slice(0, 3).map(l => l.trim()).join('; ') : 'none'
      grid.appendChild(chatFieldCell(t('shell', 'shell.chat.fieldJobs'), jobs || 'none'))
      if (budgetMatch !== null) {
        grid.appendChild(chatFieldCell(t('shell', 'shell.chat.fieldBudget'), `$${budgetMatch[1]} / ${budgetMatch[2]} max · ${budgetMatch[3]} / ${budgetMatch[4]} GPU-h`))
      }
      // dsh-web depth: pending gates get a one-click jump to the Gates tab.
      if (pending !== 'none') {
        const goGates = el('button', 'hbtn', t('shell', 'shell.openApprovalsShort'))
        goGates.style.cssText = 'grid-column:1 / -1;align-self:flex-start'
        goGates.onclick = () => {
          state.activeTab = 'gates'
          tabSave()
          state.rerender()
        }
        grid.appendChild(goGates)
      }
      structured = grid
    } else if (isSurvey && searchQ === '') {
      // dsh-web survey result card: snapshot + dedup + top hits.
      const snap = /Survey complete: \*\*([^*]+)\*\* — (\d+) papers after dedup \((\d+) removed\)/.exec(msg.text)
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const headRow = el('div', 'row')
      headRow.style.cssText = 'align-items:center;gap:8px'
      headRow.appendChild(el('span', '', '📚'))
      const snapName = el('span', 'pname', snap?.[1] ?? t('shell', 'shell.chat.cardSnapshot'))
      snapName.style.cssText = 'font-size:12px'
      headRow.appendChild(snapName)
      headRow.appendChild(el('span', 'grow'))
      if (snap !== null) headRow.appendChild(el('span', 'muted', t('shell', 'shell.chat.corpusStat', { papers: snap[2] ?? '0', dedup: snap[3] ?? '0' })))
      card.appendChild(headRow)
      const hits = msg.text.split('Top hits:')[1]?.split('\n').filter(l => /^- /.test(l.trim())).slice(0, 5) ?? []
      for (const h of hits) {
        card.appendChild(el('div', 'muted', h.trim()))
      }
      // dsh-web depth: jump to the artifacts tab (snapshot lives there).
      const goArtifacts = el('button', 'hbtn', t('shell', 'shell.viewArtifacts'))
      goArtifacts.style.cssText = 'align-self:flex-start;margin-top:4px'
      goArtifacts.onclick = () => {
        state.activeTab = 'artifacts'
        tabSave()
        state.rerender()
      }
      card.appendChild(goArtifacts)
      structured = card
    } else if (isRun && searchQ === '') {
      // dsh-web run result card: job id, kind, status.
      const jobMatch = /Job \*\*([^*]+)\*\* \[([^\]]+)\] submitted \(([^)]+)\)/.exec(msg.text)
      const grid = el('div')
      grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:4px 0'
      if (jobMatch !== null) {
        grid.appendChild(chatFieldCell(t('shell', 'shell.chat.fieldJob'), jobMatch[1] ?? ''))
        grid.appendChild(chatFieldCell(t('shell', 'shell.chat.fieldKind'), jobMatch[2] ?? ''))
        grid.appendChild(chatFieldCell(t('shell', 'shell.chat.fieldStatus'), jobMatch[3] ?? ''))
      } else {
        grid.appendChild(chatFieldCell(t('shell', 'shell.chat.fieldJob'), t('shell', 'shell.chat.fieldSubmitted')))
      }
      // dsh-web depth: jump to the Runs tab to watch progress.
      const goRuns = el('button', 'hbtn', t('shell', 'shell.watchRuns'))
      goRuns.style.cssText = 'align-self:flex-start;margin-top:4px'
      goRuns.onclick = () => {
        state.activeTab = 'runs'
        tabSave()
        state.rerender()
      }
      grid.appendChild(goRuns)
      structured = grid
    } else if (isEvidence && searchQ === '') {
      // dsh-web evidence card: id + provenance status.
      const evMatch = /Evidence \*\*([^*]+)\*\* ingested \(([^)]+)\)/.exec(msg.text)
      const grid = el('div')
      grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:4px 0'
      if (evMatch !== null) {
        grid.appendChild(chatFieldCell(t('shell', 'shell.chat.fieldEvidence'), evMatch[1] ?? ''))
        grid.appendChild(chatFieldCell(t('shell', 'shell.chat.fieldStatus'), evMatch[2] ?? ''))
      }
      const goEv = el('button', 'hbtn', t('shell', 'shell.openEvidence'))
      goEv.style.cssText = 'align-self:flex-start;margin-top:4px'
      goEv.onclick = () => {
        state.activeTab = 'evidence'
        tabSave()
        state.rerender()
      }
      grid.appendChild(goEv)
      structured = grid
    } else if (isGate && searchQ === '') {
      // dsh-web gate card: gate id + a jump-to-Gates action.
      const gateMatch = /Gate \*\*([^*]+)\*\*/.exec(msg.text)
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '⛩️'))
      head.appendChild(el('span', 'pname', gateMatch?.[1] ?? t('shell', 'shell.chat.cardGate')))
      head.appendChild(el('span', 'grow'))
      head.appendChild(pill('pending'))
      card.appendChild(head)
      const go = el('button', 'hbtn', t('shell', 'shell.openApprovals'))
      go.style.cssText = 'align-self:flex-start'
      go.onclick = () => {
        state.activeTab = 'gates'
        tabSave()
        state.rerender()
      }
      card.appendChild(go)
      structured = card
    } else if (isContract && searchQ === '') {
      // dsh-web contract card: id + jump to Gates for approval.
      const cMatch = /Contract \*\*([^*]+)\*\* registered/.exec(msg.text)
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '📋'))
      head.appendChild(el('span', 'pname', cMatch?.[1] ?? t('shell', 'shell.chat.cardContract')))
      head.appendChild(el('span', 'grow'))
      head.appendChild(pill('pending'))
      card.appendChild(head)
      const goGates = el('button', 'hbtn', t('shell', 'shell.openApprovals'))
      goGates.style.cssText = 'align-self:flex-start'
      goGates.onclick = () => {
        state.activeTab = 'gates'
        tabSave()
        state.rerender()
      }
      card.appendChild(goGates)
      structured = card
    } else if (isClaims && searchQ === '') {
      // dsh-web claims card: count + jump to Evidence.
      const count = msg.text.split('\n').filter(l => /^- /m.test(l)).length
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '🧾'))
      head.appendChild(el('span', 'pname', t('shell', 'shell.chat.claimsCount', { count: String(count) })))
      head.appendChild(el('span', 'grow'))
      const goEv = el('button', 'hbtn', t('shell', 'shell.viewEvidence'))
      goEv.style.cssText = 'align-self:flex-start;margin-top:4px'
      goEv.onclick = () => {
        state.activeTab = 'evidence'
        tabSave()
        state.rerender()
      }
      card.appendChild(goEv)
      structured = card
    } else if (isWrite && searchQ === '') {
      // dsh-web write card: manuscript id + jump to Phase.
      const mMatch = /Manuscript \*\*([^*]+)\*\* built/.exec(msg.text)
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '📄'))
      head.appendChild(el('span', 'pname', mMatch?.[1] ?? t('shell', 'shell.chat.cardManuscript')))
      head.appendChild(el('span', 'grow'))
      head.appendChild(pill('built'))
      card.appendChild(head)
      const goPhase = el('button', 'hbtn', t('shell', 'shell.openOverview'))
      goPhase.style.cssText = 'align-self:flex-start'
      goPhase.onclick = () => {
        state.activeTab = 'phase'
        tabSave()
        state.rerender()
      }
      card.appendChild(goPhase)
      structured = card
    } else if (isReview && searchQ === '') {
      // dsh-web review card: PASS/SEE CHECKS + jump to Evidence.
      const pass = msg.text.startsWith('Reviewer: PASS')
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '🔍'))
      head.appendChild(el('span', 'pname', pass ? t('shell', 'shell.chat.reviewPass') : t('shell', 'shell.chat.reviewSeeChecks')))
      head.appendChild(el('span', 'grow'))
      head.appendChild(pill(pass ? 'supported' : 'inconclusive'))
      card.appendChild(head)
      const goEv = el('button', 'hbtn', t('shell', 'shell.viewClaims'))
      goEv.style.cssText = 'align-self:flex-start;margin-top:4px'
      goEv.onclick = () => {
        state.activeTab = 'evidence'
        tabSave()
        state.rerender()
      }
      card.appendChild(goEv)
      structured = card
    } else if (isExport && searchQ === '') {
      // dsh-web export card: bundle id + jump to Phase (release gate).
      const bMatch = /Release bundle \*\*([^*]+)\*\* generated/.exec(msg.text)
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '📦'))
      head.appendChild(el('span', 'pname', bMatch?.[1] ?? t('shell', 'shell.chat.cardRelease')))
      head.appendChild(el('span', 'grow'))
      head.appendChild(pill('exported'))
      card.appendChild(head)
      const goPhase = el('button', 'hbtn', t('shell', 'shell.openOverview'))
      goPhase.style.cssText = 'align-self:flex-start;margin-top:4px'
      goPhase.onclick = () => {
        state.activeTab = 'phase'
        tabSave()
        state.rerender()
      }
      card.appendChild(goPhase)
      structured = card
    } else if (isIdeas && searchQ === '') {
      // dsh-web ideas card: count + jump to Phase (Idea panel).
      const ideaLines = msg.text.split('\n').filter(l => /^- /.test(l.trim()))
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '💡'))
      head.appendChild(el('span', 'pname', t('shell', 'shell.chat.ideaCount', { count: String(ideaLines.length) })))
      head.appendChild(el('span', 'grow'))
      card.appendChild(head)
      for (const l of ideaLines.slice(0, 4)) {
        card.appendChild(el('div', 'muted', l.trim()))
      }
      const goPhase = el('button', 'hbtn', t('shell', 'shell.openOverview'))
      goPhase.style.cssText = 'align-self:flex-start;margin-top:4px'
      goPhase.onclick = () => {
        state.activeTab = 'phase'
        tabSave()
        state.rerender()
      }
      card.appendChild(goPhase)
      structured = card
    } else if (isList && searchQ === '') {
      // dsh-web projects card: count + first rows.
      const countMatch = /^Projects \((\d+)\):/m.exec(msg.text)
      const rows = msg.text.split('\n').filter(l => /^- /.test(l.trim()))
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '📁'))
      head.appendChild(el('span', 'pname', t('shell', 'shell.chat.projectCount', { count: String(countMatch?.[1] ?? rows.length) })))
      head.appendChild(el('span', 'grow'))
      card.appendChild(head)
      for (const r of rows.slice(0, 6)) {
        // dsh-web depth: each project row jumps to that project.
        const idMatch = /`([^`]+)`/.exec(r)
        const row = el('div')
        row.style.cssText = 'font-size:11px;color:var(--text-2);cursor:pointer;border-radius:6px;padding:2px 4px'
        row.textContent = r.trim().replace(/^- /, '· ')
        if (idMatch !== null) {
          const pid = idMatch[1]!
          row.title = t('shell', 'shell.chat.switchTo', { pid })
          row.onmouseenter = () => { row.style.background = 'var(--bg-hover)' }
          row.onmouseleave = () => { row.style.background = 'none' }
          row.onclick = () => {
            projectId = pid
            state.rerender()
            showToast(rootHost(), t('shell', 'shell.chat.switched', { pid: pid.slice(0, 22) }))
          }
        }
        card.appendChild(row)
      }
      if (rows.length > 6) card.appendChild(el('div', 'muted', t('shell', 'shell.chat.more', { count: String(rows.length - 6) })))
      structured = card
    } else if (isJobs && searchQ === '') {
      // dsh-web runs card: job rows with status pills + jump to Runs.
      const jobLines = msg.text.split('\n').filter(l => /^- /.test(l.trim()))
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '⚙️'))
      head.appendChild(el('span', 'pname', t('shell', 'shell.chat.runCount', { count: String(jobLines.length) })))
      head.appendChild(el('span', 'grow'))
      card.appendChild(head)
      for (const l of jobLines.slice(0, 8)) {
        const m = /`([^`]+)` \[([^\]]+)\] (\S+)/.exec(l)
        const row = el('div', 'row')
        if (m !== null) {
          row.appendChild(el('span', 'artifact-kind', String(m[2]).toUpperCase()))
          const text = el('span', 'grow mono', fmtId(m[1] ?? '', 26))
          text.style.cssText = 'font-size:10px'
          row.appendChild(text)
          row.appendChild(pill(m[3] ?? ''))
        } else {
          row.appendChild(el('span', 'muted', l.trim().replace(/^- /, '· ')))
        }
        card.appendChild(row)
      }
      if (jobLines.length > 8) card.appendChild(el('div', 'muted', t('shell', 'shell.chat.more', { count: String(jobLines.length - 8) })))
      const goRuns = el('button', 'hbtn', t('shell', 'shell.openRuns'))
      goRuns.style.cssText = 'align-self:flex-start;margin-top:4px'
      goRuns.onclick = () => {
        state.activeTab = 'runs'
        tabSave()
        state.rerender()
      }
      card.appendChild(goRuns)
      structured = card
    } else if (isGatesList && searchQ === '') {
      // dsh-web gates card: pending/decided counts.
      const rows = msg.text.split('\n').filter(l => /^- /.test(l.trim()))
      const pendingCount = rows.filter(r => /\[pending\]/.test(r)).length
      const decidedCount = rows.length - pendingCount
      const card = el('div')
      card.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin:4px 0'
      const head = el('div', 'row')
      head.style.cssText = 'align-items:center;gap:8px'
      head.appendChild(el('span', '', '⛩️'))
      head.appendChild(el('span', 'pname', t('shell', 'shell.chat.gateStats', { total: String(rows.length), pending: String(pendingCount), decided: String(decidedCount) })))
      head.appendChild(el('span', 'grow'))
      card.appendChild(head)
      for (const r of rows.slice(0, 5)) {
        const isPending = /\[pending\]/.test(r)
        const row = el('div', 'muted', r.trim().replace(/^- /, isPending ? '⏳ ' : '✅ '))
        card.appendChild(row)
      }
      if (rows.length > 5) card.appendChild(el('div', 'muted', t('shell', 'shell.chat.more', { count: String(rows.length - 5) })))
      const goGates = el('button', 'hbtn', t('shell', 'shell.openApprovals'))
      goGates.style.cssText = 'align-self:flex-start;margin-top:4px'
      goGates.onclick = () => {
        state.activeTab = 'gates'
        tabSave()
        state.rerender()
      }
      card.appendChild(goGates)
      structured = card
    }
    const lineCount = msg.text.split('\n').length
    const collapsed = msg.role === 'assistant' && lineCount > 8 && searchQ === '' && structured === null
    const renderBubble = (): void => {
      if (structured !== null) {
        bubble.replaceChildren(structured)
      } else {
        bubble.replaceChildren(...formatChatText(collapsed ? msg.text.split('\n').slice(0, 6).join('\n') + '\n…' : msg.text, searchQ === '' ? undefined : searchQ))
      }
    }
    renderBubble()
    if (collapsed) {
      const toggle = el('button', 'hbtn', t('common', 'common.action.showMore'))
      toggle.style.cssText = 'padding:0 8px;font-size:9px;margin-top:4px;align-self:flex-start'
      toggle.setAttribute('aria-expanded', 'false')
      let expanded = false
      toggle.onclick = (event) => {
        event.stopPropagation()
        expanded = !expanded
        if (expanded) {
          bubble.replaceChildren(...formatChatText(msg.text))
          toggle.textContent = t('common', 'common.action.showLess')
          bubble.appendChild(toggle)
        } else {
          renderBubble()
          bubble.appendChild(toggle)
        }
      }
      bubble.appendChild(toggle)
    }
    // dsh-web "details": click a message to inspect it in the side panel.
    bubble.title = t('common', 'common.clickForDetails')
    bubble.onclick = () => {
      state.chatDetailIndex = state.chatDetailIndex === i ? -1 : i
      state.rerender()
    }
    // dsh-web context menu: copy / reply / pin / details.
    bubble.oncontextmenu = (event) => {
      event.preventDefault()
      event.stopPropagation()
      const root = rootHost()
      if (root == null) return
      const items: ContextMenuItem[] = [
        { label: t('common', 'common.action.copyText'), onPick: () => copyText(msg.text) },
        { label: t('common', 'common.action.copyMd'), onPick: () => copyText(textToMarkdown(msg.text)) },
        {
          label: t('common', 'common.action.reply'),
          divider: true,
          onPick: () => {
            state.chatDraft = ''
            state.chatQuoteTarget = { index: i, text: msg.text }
            state.rerender()
            setTimeout(() => {
              const hostEl = document.querySelector('#dsh-scholar-ui')
              const rootEl = hostEl !== null ? hostEl.shadowRoot : null
              const ta = rootEl?.querySelector('textarea[placeholder*="research"]') as HTMLTextAreaElement | null
              ta?.focus()
            }, 120)
          },
        },
        {
          label: msg.pinned === true ? `★ ${t('shell', 'shell.chat.unpinTitle')}` : `☆ ${t('shell', 'shell.chat.pinTitle')}`,
          onPick: () => {
            msg.pinned = !msg.pinned
            chatPersist()
            chatSessionsPersist()
            state.rerender()
          },
        },
        { label: `⧉ ${t('common', 'common.action.details')}`, onPick: () => { state.chatDetailIndex = i; state.rerender() } },
      ]
      openContextMenu(root, event.clientX, event.clientY, items)
    }
    stream.appendChild(bubble)
    // dsh-web message actions: user messages get a copy button too (the
    // assistant/error actions below add copy + quote-reply).
    if (msg.role === 'user') {
      const actionsRow = el('div')
      actionsRow.style.cssText = 'align-self:flex-end;display:flex;gap:6px;margin-top:2px'
      const copy = el('button', 'hbtn', t('common', 'common.action.copyText'))
      copy.style.cssText = 'padding:0 6px;font-size:9px'
      copy.onclick = () => {
        void navigator.clipboard.writeText(msg.text).then(
          () => { copy.textContent = t('common', 'common.action.copied') },
          () => { copy.textContent = t('common', 'common.action.copyFailed') },
        )
        setTimeout(() => { copy.textContent = t('common', 'common.action.copyText') }, 1600)
      }
      actionsRow.appendChild(copy)
      // dsh-web pin: star the message (📌 section at the top of the chat).
      const pin = el('button', 'hbtn', msg.pinned === true ? '★' : '☆')
      pin.title = msg.pinned === true ? t('shell', 'shell.chat.unpinTitle') : t('shell', 'shell.chat.pinTitle')
      pin.style.cssText = `padding:0 6px;font-size:9px;${msg.pinned === true ? 'color:var(--tone-amber)' : ''}`
      pin.onclick = () => {
        msg.pinned = !msg.pinned
        chatPersist()
        chatSessionsPersist()
        state.rerender()
      }
      actionsRow.appendChild(pin)
      stream.appendChild(actionsRow)
    }
    if (msg.role === 'assistant' || msg.role === 'error') {
      const actionsRow = el('div')
      actionsRow.style.cssText = 'align-self:flex-start;display:flex;gap:6px;margin-top:2px'
      const copy = el('button', 'hbtn', t('common', 'common.action.copyText'))
      copy.style.cssText = 'padding:0 6px;font-size:9px'
      copy.onclick = () => {
        void navigator.clipboard.writeText(msg.text).then(
          () => { copy.textContent = t('common', 'common.action.copied') },
          () => { copy.textContent = t('common', 'common.action.copyFailed') },
        )
        setTimeout(() => { copy.textContent = t('common', 'common.action.copyText') }, 1600)
      }
      actionsRow.appendChild(copy)
      // dsh-web quote-reply: reply quoting this message.
      const quote = el('button', 'hbtn', t('common', 'common.action.reply'))
      quote.style.cssText = 'padding:0 6px;font-size:9px'
      quote.onclick = () => {
        state.chatDraft = ''
        state.activeTab = 'chat'
        tabSave()
        state.chatQuoteTarget = { index: i, text: msg.text }
        state.rerender()
        setTimeout(() => {
          const hostEl = document.querySelector('#dsh-scholar-ui')
          const rootEl = hostEl !== null ? hostEl.shadowRoot : null
          const ta = rootEl?.querySelector('textarea[placeholder*="research"]') as HTMLTextAreaElement | null
          ta?.focus()
        }, 120)
      }
      actionsRow.appendChild(quote)
      // dsh-web pin: star the message (📌 section at the top of the chat).
      const pin = el('button', 'hbtn', msg.pinned === true ? '★' : '☆')
      pin.title = msg.pinned === true ? t('shell', 'shell.chat.unpinTitle') : t('shell', 'shell.chat.pinTitle')
      pin.style.cssText = `padding:0 6px;font-size:9px;${msg.pinned === true ? 'color:var(--tone-amber)' : ''}`
      pin.onclick = () => {
        msg.pinned = !msg.pinned
        chatPersist()
        chatSessionsPersist()
        state.rerender()
      }
      actionsRow.appendChild(pin)
      stream.appendChild(actionsRow)
    }
    const stamp = el('div')
    stamp.style.cssText = msg.role === 'user'
      ? 'align-self:flex-end;color:var(--text-3);font-size:9px;margin-top:-4px'
      : 'align-self:flex-start;color:var(--text-3);font-size:9px;margin-top:-4px'
    stamp.textContent = msg.time
    stream.appendChild(stamp)
  }
  // dsh-web match counter: reflect the active filter.
  if (searchQ !== '' || chatCommandsOnly) {
    matchLabel.textContent = t('shell', 'shell.chat.shown', { shown: String(shownCount), total: String(state.chatMessages.length) })
  }
  if (stream.childElementCount === 0 && (searchQ !== '' || chatCommandsOnly)) {
    const empty = el('div', 'empty', chatCommandsOnly
      ? t('shell', 'shell.chat.emptyCommands')
      : t('shell', 'shell.chat.emptyNoMatch', { query: chatSearchQuery.trim() }))
    empty.style.cssText = 'padding:10px 2px'
    stream.appendChild(empty)
  }
  // dsh-web behavior: always scroll to the newest message.
  stream.scrollTop = stream.scrollHeight
  column.appendChild(streamWrap)

  // dsh-web "details" side panel: raw transcript of the selected message.
  const detailMsg = state.chatDetailIndex >= 0 && state.chatDetailIndex < state.chatMessages.length ? state.chatMessages[state.chatDetailIndex] : null
  if (detailMsg != null) {
    const panel = el('div')
    panel.style.cssText = 'width:240px;flex-shrink:0;margin-left:10px;border-left:1px solid var(--border);padding-left:12px;display:flex;flex-direction:column;gap:8px;overflow-y:auto'
    const headRow = el('div', 'row')
    headRow.style.cssText = 'justify-content:space-between;align-items:center'
    headRow.appendChild(el('div', 'section-label', t('shell', 'shell.chat.detailsTitle')))
    const closeDetail = el('button', 'hbtn ghost', '×')
    closeDetail.title = t('shell', 'shell.chat.detailsClose')
    closeDetail.setAttribute('aria-label', t('shell', 'shell.chat.detailsCloseAria'))
    closeDetail.style.cssText = 'padding:0 4px;font-size:11px'
    closeDetail.onclick = () => { state.chatDetailIndex = -1; state.rerender() }
    headRow.appendChild(closeDetail)
    panel.appendChild(headRow)
    const meta = el('div')
    meta.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:10.5px'
    const roleRow = el('div', 'row')
    roleRow.appendChild(el('span', 'muted', t('shell', 'shell.chat.detailRole')))
    roleRow.appendChild(pill(detailMsg.role))
    const idxRow = el('div', 'row')
    idxRow.appendChild(el('span', 'muted', t('shell', 'shell.chat.detailMessage')))
    idxRow.appendChild(el('span', 'mono', `#${state.chatDetailIndex + 1} / ${state.chatMessages.length}`))
    const timeRow = el('div', 'row')
    timeRow.appendChild(el('span', 'muted', t('shell', 'shell.chat.detailTime')))
    timeRow.appendChild(el('span', 'mono', detailMsg.time))
    const linesRow = el('div', 'row')
    linesRow.appendChild(el('span', 'muted', t('shell', 'shell.chat.detailLines')))
    linesRow.appendChild(el('span', 'mono', String(detailMsg.text.split('\n').length)))
    const charsRow = el('div', 'row')
    charsRow.appendChild(el('span', 'muted', t('shell', 'shell.chat.detailChars')))
    charsRow.appendChild(el('span', 'mono', String(detailMsg.text.length)))
    // dsh-web depth: pin state and quote presence in the metadata.
    const pinnedRow = el('div', 'row')
    pinnedRow.appendChild(el('span', 'muted', t('shell', 'shell.chat.detailPinned')))
    pinnedRow.appendChild(el('span', 'mono', detailMsg.pinned === true ? t('shell', 'shell.chat.detailYes') : t('shell', 'shell.chat.detailNo')))
    const quoteRow = el('div', 'row')
    quoteRow.appendChild(el('span', 'muted', t('shell', 'shell.chat.detailQuote')))
    quoteRow.appendChild(el('span', 'mono', detailMsg.quote !== undefined ? `#${detailMsg.quote.index + 1}` : '—'))
    meta.append(roleRow, idxRow, timeRow, linesRow, charsRow, pinnedRow, quoteRow)
    panel.appendChild(meta)
    // dsh-web "copy command": quick re-run for user messages.
    if (detailMsg.role === 'user') {
      const rerun = el('button', 'hbtn', t('common', 'common.action.rerunCommand'))
      rerun.style.cssText = 'align-self:flex-start'
      rerun.onclick = () => {
        state.chatDraft = detailMsg.text
        state.activeTab = 'chat'
        tabSave()
        state.rerender()
        setTimeout(() => {
          const hostEl = document.querySelector('#dsh-scholar-ui')
          const rootEl = hostEl !== null ? hostEl.shadowRoot : null
          const ta = rootEl?.querySelector('textarea[placeholder*="research"]') as HTMLTextAreaElement | null
          ta?.focus()
        }, 120)
      }
      panel.appendChild(rerun)
    }
    const rawLabel = el('div', 'section-label', t('shell', 'shell.chat.rawText'))
    panel.appendChild(rawLabel)
    const pre = el('pre', '')
    pre.style.cssText = 'white-space:pre-wrap;word-break:break-all;font:10.5px/1.5 ui-monospace,Menlo,monospace;color:var(--text-2);margin:0'
    pre.textContent = detailMsg.text
    panel.appendChild(pre)
    // dsh-web share: copy raw or as markdown.
    const copyRow = el('div', 'row')
    copyRow.style.cssText = 'gap:6px'
    const copyRaw = el('button', 'hbtn', t('common', 'common.action.copyRaw'))
    copyRaw.style.cssText = 'padding:0 8px;font-size:9px'
    copyRaw.onclick = () => {
      void navigator.clipboard.writeText(detailMsg.text).then(
        () => { copyRaw.textContent = t('common', 'common.action.copied') },
        () => { copyRaw.textContent = t('common', 'common.action.copyFailed') },
      )
      setTimeout(() => { copyRaw.textContent = t('common', 'common.action.copyRaw') }, 1600)
    }
    copyRow.appendChild(copyRaw)
    const copyMd = el('button', 'hbtn', t('common', 'common.action.copyMd'))
    copyMd.title = t('common', 'common.action.copyMd.title')
    copyMd.style.cssText = 'padding:0 8px;font-size:9px'
    copyMd.onclick = () => {
      const md = textToMarkdown(detailMsg.text)
      void navigator.clipboard.writeText(md).then(
        () => { copyMd.textContent = t('common', 'common.action.copied') },
        () => { copyMd.textContent = t('common', 'common.action.copyFailed') },
      )
      setTimeout(() => { copyMd.textContent = t('common', 'common.action.copyMd') }, 1600)
    }
    copyRow.appendChild(copyMd)
    panel.appendChild(copyRow)
    shell.appendChild(panel)
  }
  // The composer is rendered into the main-level dock, outside both the
  // transcript shell and the scrollable panel body.
  const composerRow = el('div', 'chat-composer-row')
  // dsh-web quote-reply: pending quote banner above the composer.
  if (state.chatQuoteTarget !== null) {
    const quoteBanner = el('div', 'chat-quote')
    quoteBanner.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;background:var(--accent-soft);border:1px solid var(--accent);border-radius:8px;padding:5px 10px;font-size:10.5px;color:var(--text)'
    const qText = el('span', 'grow', t('shell', 'shell.chat.replyingTo', { text: `${state.chatQuoteTarget.text.slice(0, 70)}${state.chatQuoteTarget.text.length > 70 ? '…' : ''}` }))
    quoteBanner.appendChild(qText)
    const cancelQuote = el('button', 'hbtn', '×')
    cancelQuote.style.cssText = 'padding:0 6px'
    cancelQuote.onclick = () => {
      state.chatQuoteTarget = null
      state.rerender()
    }
    quoteBanner.appendChild(cancelQuote)
    dock.appendChild(quoteBanner)
  }
  const composer = el('div', 'chat-composer')
  // dsh-web composer: fixed-height input; longer drafts scroll internally so
  // the dock never moves when its content changes.
  const input = document.createElement('textarea')
  input.rows = 2
  input.className = 'chat-composer-input'
  // dsh-web context: the placeholder shows the active project.
  input.placeholder = projectId !== '' && projectId !== undefined
    ? t('shell', 'shell.chat.composerPlaceholderActive', { id: projectId.slice(0, 16) })
    : t('shell', 'shell.chat.composerPlaceholderNone')
  input.setAttribute('aria-label', t('shell', 'shell.chat.composerAria'))
  input.value = state.chatDraft
  const autosize = (): void => {
    input.style.height = '48px'
  }
  input.onfocus = () => {
    if (input.value.trim().startsWith('/')) renderCompletions(true)
  }
  input.onblur = () => {
    completionBox.style.display = 'none'
    completionOpen = false
  }
  input.oninput = () => {
    state.chatDraft = input.value
    autosize()
    renderCompletions()
  }
  // dsh-web "/" command completion: typing "/" (or focusing with "/")
  // opens the command palette under the composer; typing filters it.
  const completionBox = el('div', 'chat-completions')
  completionBox.style.cssText = 'display:none;flex-direction:column;margin-top:6px;border:1px solid var(--border);border-radius:8px;background:var(--bg-2);overflow:hidden;max-height:40vh;overflow-y:auto'
  let completionOpen = false
  const renderCompletions = (force = false): void => {
    const draft = input.value.trim()
    const match = /^\/(?:research\s+)?([a-z]*)$/i.exec(draft)
    const shouldOpen = (force || completionOpen) && (match !== null || draft.startsWith('/research '))
    if (!shouldOpen) {
      completionBox.style.display = 'none'
      completionOpen = false
      return
    }
    const prefix = (match?.[1] ?? '').toLowerCase()
    // With no prefix show the whole palette; with a prefix filter it.
    const hits = prefix === ''
      ? CHAT_COMMANDS.slice(0, 10)
      : CHAT_COMMANDS.filter(([name]) => name.startsWith(prefix)).slice(0, 10)
    if (hits.length === 0) {
      completionBox.style.display = 'none'
      completionOpen = false
      return
    }
    completionOpen = true
    completionBox.replaceChildren()
    for (const [name, line] of hits) {
      const row = el('button')
      row.style.cssText = 'display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;color:var(--text);text-align:left;padding:6px 10px;cursor:pointer;font:11px/1.4 ui-monospace,Menlo,monospace'
      row.onmouseenter = () => { row.style.background = 'var(--bg-hover)' }
      row.onmouseleave = () => { row.style.background = 'none' }
      row.appendChild(el('span', 'artifact-kind', `/${name}`))
      row.appendChild(el('span', 'grow', line.slice(0, 46)))
      row.onclick = () => {
        input.value = `/${name} `
        state.chatDraft = input.value
        completionBox.style.display = 'none'
        input.focus()
      }
      completionBox.appendChild(row)
    }
    completionBox.style.display = 'flex'
  }
  const send = el('button', 'chat-send', '↑')
  send.setAttribute('aria-label', t('shell', 'shell.chat.sendAria'))
  const run = async (): Promise<void> => {
    const line = input.value.trim()
    if (line === '') return
    historyPush(line)
    input.value = ''
    state.chatDraft = ''
    completionBox.style.display = 'none'
    // dsh-web quote-reply: attach a pending quote to this message.
    const quote = state.chatQuoteTarget
    state.chatQuoteTarget = null
    // The session that launched this command (the reply lands back here
    // even if the user switched sessions while it ran).
    const originSessionId = state.chatActiveId
    chatPush('user', line, quote ?? undefined)
    input.disabled = true
    send.disabled = true
    // dsh-web streaming feel: a "running…" bubble while the command works.
    const runningBubble = el('div', 'chat-running')
    const spinner = el('span')
    spinner.textContent = '⏳'
    const runningText = el('span', '', t('shell', 'shell.chat.running'))
    runningBubble.append(spinner, runningText)
    const streamEl = stream
    streamEl.appendChild(runningBubble)
    streamEl.scrollTop = streamEl.scrollHeight
    try {
      const answer = await executeChatCommand(line, projectId)
      input.disabled = false
      send.disabled = false
      runningBubble.remove()
      // dsh-web streaming feel: reveal the answer progressively in chunks
      // (line-by-line for multi-line answers, word-wise for single lines).
      const answerBubble = el('div', 'chat-message assistant')
      const lines = answer.split('\n')
      const chunkMs = lines.length > 4 ? 14 : 10
      const reveal = (): void => {
        const done = answerBubble.getAttribute('data-lines') !== null
          ? Number(answerBubble.getAttribute('data-lines')) : 0
        const next = done + 1
        if (next >= lines.length) {
          answerBubble.replaceChildren(...formatChatText(answer))
          // dsh-web session unread: if the user switched sessions while
          // the command ran, the reply lands in the origin session and the
          // current session gets no unread.
          if (originSessionId !== null && originSessionId !== state.chatActiveId) {
            const origin = state.chatSessions.find(x => x.id === originSessionId)
            if (origin !== undefined) {
              origin.messages.push({ role: 'assistant' as const, text: answer, time: new Date().toLocaleTimeString(getLocale()) })
              origin.unread = (origin.unread ?? 0) + 1
            }
            chatSessionsPersist()
          } else {
            state.chatMessages.push({ role: 'assistant' as const, text: answer, time: new Date().toLocaleTimeString(getLocale()) })
            chatPersist()
          }
          state.rerender()
          showToast(rootHost(), `✓ ${line.slice(0, 40)}${line.length > 40 ? '…' : ''}`)
          return
        }
        answerBubble.replaceChildren(...formatChatText(lines.slice(0, next).join('\n') + '\n'))
        answerBubble.setAttribute('data-lines', String(next))
        streamEl.scrollTop = streamEl.scrollHeight
        setTimeout(reveal, chunkMs)
      }
      streamEl.appendChild(answerBubble)
      reveal()
    } catch (error) {
      input.disabled = false
      send.disabled = false
      runningBubble.remove()
      chatPush('error', t('shell', 'shell.chat.commandFailedDetail', { detail: (error as Error).message }))
      state.rerender()
      showToast(rootHost(), t('shell', 'shell.chat.commandFailed'))
    }
  }
  send.onclick = () => { void run() }
  input.onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      // Enter while a completion is open fills the highlighted row instead
      // of sending (first row default).
      if (completionBox.style.display === 'flex') {
        const first = completionBox.querySelector('button')
        if (first !== null) {
          first.click()
          return
        }
      }
      void run()
    } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      // dsh-web composer: Ctrl/Cmd+Enter also sends.
      event.preventDefault()
      void run()
    } else if (event.key === 'Escape') {
      completionBox.style.display = 'none'
    } else if (event.key === 'ArrowUp' && state.chatHistory.length > 0) {
      // dsh-web shell feel: ↑ always walks the command history.
      event.preventDefault()
      if (state.historyIndex < 0) state.historyIndex = state.chatHistory.length
      state.historyIndex = Math.max(0, state.historyIndex - 1)
      input.value = state.chatHistory[state.historyIndex] ?? ''
      state.chatDraft = input.value
      autosize()
      input.setSelectionRange(input.value.length, input.value.length)
    } else if (event.key === 'ArrowDown' && state.historyIndex >= 0) {
      event.preventDefault()
      state.historyIndex += 1
      if (state.historyIndex >= state.chatHistory.length) {
        state.historyIndex = -1
        input.value = ''
      } else {
        input.value = state.chatHistory[state.historyIndex] ?? ''
      }
      state.chatDraft = input.value
      autosize()
      input.setSelectionRange(input.value.length, input.value.length)
    } else if (event.key === 'Tab') {
      // dsh-web keyboard navigation: Tab completes the command name.
      const draft = input.value.trim()
      const match = /^\/(?:research\s+)?([a-z]*)$/i.exec(draft)
      if (match !== null) {
        event.preventDefault()
        const prefix = (match[1] ?? '').toLowerCase()
        // 'research' itself is a valid completion (→ /research <sub>).
        if (prefix !== '' && 'research'.startsWith(prefix) && prefix.length < 8) {
          input.value = draft.replace(/[a-z]*$/i, 'research ')
          state.chatDraft = input.value
          autosize()
        } else {
          const hit = CHAT_COMMANDS.find(([name]) => name.startsWith(prefix))
          if (hit !== undefined && prefix !== hit[0]) {
            input.value = draft.replace(/[a-z]*$/i, hit[0] + ' ')
            state.chatDraft = input.value
            autosize()
          }
        }
      }
    }
  }
  composer.appendChild(input)
  // dsh-web "session actions": clear this conversation.
  const clear = el('button', 'hbtn', '×')
  clear.title = t('shell', 'shell.chat.clearTitle')
  clear.setAttribute('aria-label', t('shell', 'shell.chat.clearAria'))
  clear.onclick = () => {
    chatClear()
    state.rerender()
  }
  // dsh-web composer toolbar: markdown quick-inserts at the cursor.
  const toolbar = el('div', 'chat-composer-tools')
  const mkBtn = (label: string, title: string): HTMLButtonElement => {
    const b = el('button', 'hbtn', label)
    b.title = title
    b.style.cssText = 'padding:1px 8px;font-size:10px'
    return b
  }
  const insertMarkdown = (before: string, after: string, placeholder: string): void => {
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    const selected = input.value.slice(start, end) || placeholder
    input.value = input.value.slice(0, start) + before + selected + after + input.value.slice(end)
    state.chatDraft = input.value
    input.focus()
    input.setSelectionRange(start + before.length, start + before.length + selected.length)
    autosize()
  }
  const boldBtn = mkBtn('**B**', t('shell', 'shell.chat.toolBold'))
  boldBtn.onclick = () => insertMarkdown('**', '**', 'text')
  const codeBtn = mkBtn('`<>`', t('shell', 'shell.chat.toolCode'))
  codeBtn.onclick = () => insertMarkdown('`', '`', 'code')
  const linkBtn = mkBtn('🔗', t('shell', 'shell.chat.toolLink'))
  linkBtn.onclick = () => insertMarkdown('[', '](https://)', 'text')
  const listBtn = mkBtn('•', t('shell', 'shell.chat.toolList'))
  listBtn.onclick = () => insertMarkdown('\n- ', '', 'item')
  toolbar.append(boldBtn, codeBtn, linkBtn, listBtn, clear)
  const composerActions = el('div', 'chat-composer-actions')
  composerActions.append(toolbar, send)
  composer.appendChild(composerActions)
  composerRow.appendChild(composer)
  dock.append(completionBox, composerRow)
  dock.hidden = false

  body.appendChild(shell)
}

/** Convert a chat answer back to markdown source (dsh-web copy-as-md). */

export function textToMarkdown(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^```/.test(line) || /^#{1,3}\s/.test(line) || /^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      out.push(line)
      continue
    }
    if (/^\|/.test(line)) {
      const cells = line.split('|').map(c => c.trim()).filter((c, i, arr) => !(i === 0 && c === '') && !(i === arr.length - 1 && c === ''))
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue
      out.push(`| ${cells.join(' | ')} |`)
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/** Structured chat field cell (status/survey cards). */
export function chatFieldCell(label: string, value: string): HTMLElement {
  const c = el('div')
  c.style.cssText = 'background:var(--bg-3);border:1px solid var(--border);border-radius:8px;padding:6px 9px'
  const l = el('div', 'muted', label)
  l.style.cssText = 'font-size:9px;text-transform:uppercase;letter-spacing:.5px'
  const v = el('div', 'mono', value)
  v.style.cssText = 'font-size:11px;color:var(--text);margin-top:2px;word-break:break-word'
  c.append(l, v)
  return c
}

/**
 * Rich line rendering for chat bubbles: ## headings, - bullets, ``` code
 * fences, **bold** and `code` spans — all built with textContent-only
 * nodes (design §15.4).
 */
export function formatChatText(text: string, highlight?: string): HTMLElement[] {
  const nodes: HTMLElement[] = []
  const lines = text.split('\n')
  let inFence = false
  let fence: HTMLElement | null = null
  let fenceText = ''
  /** Copy the current fence's code content (text nodes only). */
  const fenceCodeText = (): string => fenceText
  const flushFence = (): void => {
    if (fence !== null) {
      nodes.push(fence)
      fence = null
    }
    fenceText = ''
    inFence = false
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (/^```/.test(line)) {
      if (inFence) {
        flushFence()
      } else {
        inFence = true
        fence = el('pre')
        fence.style.cssText = 'position:relative;background:var(--bg-3);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font:10.5px/1.5 ui-monospace,Menlo,monospace;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:4px 0'
        const lang = line.slice(3).trim()
        if (lang !== '') {
          const head = el('div')
          head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px'
          const langTag = el('span', 'artifact-kind', lang.toUpperCase())
          const copyCode = el('button', 'hbtn', t('common', 'common.action.copyText'))
          copyCode.style.cssText = 'padding:0 6px;font-size:9px'
          copyCode.onclick = () => {
            void navigator.clipboard.writeText(fenceCodeText()).then(
              () => { copyCode.textContent = '✓' },
              () => { copyCode.textContent = '✗' },
            )
            setTimeout(() => { copyCode.textContent = t('common', 'common.action.copyText') }, 1600)
          }
          head.append(langTag, copyCode)
          fence.appendChild(head)
        }
      }
      continue
    }
    if (inFence && fence !== null) {
      fence.appendChild(document.createTextNode(line + '\n'))
      fenceText += line + '\n'
      continue
    }
    if (/^#{1,3}\s/.test(line)) {
      const h = el('div')
      h.style.cssText = `font:700 ${line.startsWith('###') ? 11.5 : 12.5}px/1.4 system-ui,sans-serif;color:var(--text);margin:6px 0 3px`
      h.append(...inlineChatText(line.replace(/^#{1,3}\s+/, ''), highlight))
      nodes.push(h)
      continue
    }
    if (/^[-*•]\s+/.test(line)) {
      const row = el('div')
      row.style.cssText = 'display:flex;gap:7px;padding:1px 0'
      row.appendChild(el('span', '', '•'))
      const content = el('span', '', '')
      content.append(...inlineChatText(line.replace(/^[-*•]\s+/, ''), highlight))
      row.appendChild(content)
      nodes.push(row)
      continue
    }
    // dsh-web markdown tables: consecutive lines starting with '|'.
    if (/^\|/.test(line)) {
      const table = nodes.find(n => n.classList.contains('chat-table')) as HTMLElement | undefined
      const cells = line.split('|').map(c => c.trim()).filter((c, i, arr) => !(i === 0 && c === '') && !(i === arr.length - 1 && c === ''))
      // Skip the |---| separator row.
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue
      let tbody: HTMLElement
      if (table === undefined) {
        const tbl = el('table', 'chat-table')
        tbl.style.cssText = 'border-collapse:collapse;margin:4px 0;font-size:10.5px;width:100%'
        tbody = el('tbody')
        tbl.appendChild(tbody)
        nodes.push(tbl)
      } else {
        tbody = table.querySelector('tbody') as HTMLElement
      }
      const tr = el('tr')
      tr.style.cssText = 'border-bottom:1px solid var(--border-2)'
      for (const cell of cells) {
        const td = el('td', '', '')
        td.style.cssText = 'padding:2px 8px;border-left:1px solid var(--border-2);vertical-align:top'
        td.append(...inlineChatText(cell, highlight))
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
      continue
    }
    if (/^\d+\.\s+/.test(line)) {
      const row = el('div')
      row.style.cssText = 'display:flex;gap:7px;padding:1px 0'
      row.appendChild(el('span', '', line.match(/^\d+\./)?.[0] ?? '•'))
      const content = el('span', '', '')
      content.append(...inlineChatText(line.replace(/^\d+\.\s+/, ''), highlight))
      row.appendChild(content)
      nodes.push(row)
      continue
    }
    if (line.trim() === '') {
      nodes.push(el('div', '', '\u00a0'))
      continue
    }
    const paragraph = el('div')
    paragraph.append(...inlineChatText(line, highlight))
    nodes.push(paragraph)
  }
  flushFence()
  return nodes
}

/** Inline **bold** + `code` spans (shared by every line kind). */
export function inlineChatText(text: string, highlight?: string): HTMLElement[] {
  const nodes: HTMLElement[] = []
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g)
  for (const part of parts) {
    if (part === '') continue
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)
    if (link !== null) {
      // dsh-web markdown links: [label](url) -> safe anchor (target=_blank,
      // rel noopener; scheme allowlist http/https).
      const url = link[2] ?? ''
      if (/^https?:\/\//i.test(url)) {
        const a = el('a', '', link[1] ?? url)
        a.href = url
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        a.style.cssText = 'color:var(--accent);text-decoration:underline'
        nodes.push(a)
      } else {
        nodes.push(el('span', '', `${link[1] ?? ''} (${url})`))
      }
      continue
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      nodes.push(el('strong', '', part.slice(2, -2)))
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const code = el('code', '', part.slice(1, -1))
      code.style.cssText = 'background:var(--bg-3);border:1px solid var(--border);border-radius:4px;padding:0 4px;font:10.5px/1.4 ui-monospace,Menlo,monospace'
      nodes.push(code)
    } else if (highlight !== undefined && highlight !== '' && part.toLowerCase().includes(highlight)) {
      // dsh-web search feel: highlight every occurrence of the query.
      const low = part.toLowerCase()
      let cursor = 0
      let idx = low.indexOf(highlight)
      while (idx >= 0) {
        if (idx > cursor) nodes.push(el('span', '', part.slice(cursor, idx)))
        const mark = el('mark', '', part.slice(idx, idx + highlight.length))
        mark.style.cssText = 'background:var(--tone-amber);color:var(--text);border-radius:3px;padding:0 2px'
        nodes.push(mark)
        cursor = idx + highlight.length
        idx = low.indexOf(highlight, cursor)
      }
      if (cursor < part.length) nodes.push(el('span', '', part.slice(cursor)))
    } else {
      nodes.push(el('span', '', part))
    }
  }
  return nodes
}

