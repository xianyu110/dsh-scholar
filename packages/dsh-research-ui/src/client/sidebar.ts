import type { ContextMenuItem, ProjectRow } from './types'
import { api } from './api'
import { openNewProjectModal, openProjectDetailModal, openRenameModal } from './modals/project'
import { openCompareModal } from './modals/search'
import { openSettingsModal } from './modals/settings'
import { favProjectToggle, favProjects, state, tabSave } from './state'
import { STATUS_META, copyText, el, openContextMenu, rootHost, showToast } from './ui'
/** Sidebar search filter (dsh-web "Search sessions" feel). */
export let sidebarQuery = ''
/** Sidebar grouping (dsh-web "Group by" feel): all | active | done. */
export let sidebarGroup: 'all' | 'active' | 'done' | 'archived' = 'all'
/** Sidebar sort order (dsh-web sort toggle), persisted. */
export let sidebarSort: 'recent' | 'name' = 'recent'
export const SIDEBAR_SORT_KEY = 'dsh-scholar-ui-sidebar-sort'
export function sidebarSortLoad(): void {
  try {
    const v = localStorage.getItem(SIDEBAR_SORT_KEY)
    if (v === 'name' || v === 'recent') sidebarSort = v
  } catch { /* private mode */ }
}
export function sidebarSortPersist(): void {
  try { localStorage.setItem(SIDEBAR_SORT_KEY, sidebarSort) } catch { /* private mode */ }
}

/** Projects considered "active" (still in the research pipeline). */
export function isProjectActive(status: string | undefined): boolean {
  return status !== 'RELEASED' && status !== 'ARCHIVED'
}

/**
 * dsh-web-style workspace sidebar: search box + group filter, one row per
 * project (name + status dot/label), the active one highlighted; the
 * workspace header owns project creation.
 */

export function renderSidebar(
  sidebar: HTMLElement,
  projects: ProjectRow[],
  activeId: string | undefined,
  onPick: (projectId: string) => void,
): void {
  sidebar.replaceChildren()

  const brandRow = el('div', 'sidebar-brand-row')
  brandRow.append(el('span', 'sidebar-wordmark', 'dsh'), el('span', 'sidebar-product', 'research'))
  sidebar.appendChild(brandRow)

  const head = el('div', 'sidebar-head')
  head.appendChild(el('span', 'sidebar-title', 'Workspaces'))
  // dsh-web sort toggle: recent activity vs alphabetical.
  const sortBtn = el('button', 'sidebar-new', sidebarSort === 'name' ? 'A–Z' : 'Recent')
  sortBtn.title = sidebarSort === 'name' ? 'sort by name (click for recent)' : 'sort by recent activity (click for A–Z)'
  sortBtn.style.cssText = 'padding:1px 8px;font-size:10px'
  sortBtn.onclick = () => {
    sidebarSort = sidebarSort === 'recent' ? 'name' : 'recent'
    sidebarSortPersist()
    renderSidebar(sidebar, projects, activeId, onPick)
  }
  head.appendChild(sortBtn)
  const newBtn = el('button', 'sidebar-new', '＋')
  newBtn.title = 'new project'
  newBtn.setAttribute('aria-label', 'New project')
  newBtn.onclick = () => {
    const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
    if (root != null) openNewProjectModal(root)
  }
  head.appendChild(newBtn)
  sidebar.appendChild(head)

  // Search box: filters the project rows in place (keeps input focus,
  // dsh-web "Search sessions" feel).
  const search = document.createElement('input')
  search.className = 'sidebar-search'
  search.type = 'text'
  search.placeholder = 'Search workspaces…'
  search.value = sidebarQuery
  // dsh-web search box: Escape clears the filter in place.
  search.onkeydown = (event) => {
    if (event.key === 'Escape' && search.value !== '') {
      event.stopPropagation()
      search.value = ''
      sidebarQuery = ''
      renderRows()
    }
  }
  sidebar.appendChild(search)

  // Group by (dsh-web "Group by"): all / active / done.
  const groupRow = el('div', 'sidebar-groups')
  const GROUP_DEFS: Array<['all' | 'active' | 'done' | 'archived', string]> = [
    ['all', 'All'], ['active', 'Active'], ['done', 'Done'], ['archived', 'Archived'],
  ]
  for (const [key, label] of GROUP_DEFS) {
    const chip = el('button', 'sidebar-filter')
    chip.textContent = label
    chip.classList.toggle('active', sidebarGroup === key)
    chip.onclick = () => { sidebarGroup = key; renderSidebar(sidebar, projects, activeId, onPick) }
    groupRow.appendChild(chip)
  }
  sidebar.appendChild(groupRow)

  const list = el('div', 'sidebar-list')
  list.setAttribute('role', 'tree')
  list.setAttribute('aria-label', 'Research workspaces')
  // dsh-web counts: the footer shows the filtered/total project counts.
  const footLabel = el('span', '', `${projects.length} projects`)
  const renderRows = (): void => {
    list.replaceChildren()
    const q = sidebarQuery.trim().toLowerCase()
    const base = sidebarSort === 'name'
      ? [...projects].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      : projects
    let filtered = q === '' ? base : base.filter(p => (p.name ?? '').toLowerCase().includes(q) || (p.project_id ?? '').toLowerCase().includes(q) || (p.status ?? '').toLowerCase().includes(q))
    if (sidebarGroup === 'active') filtered = filtered.filter(p => isProjectActive(p.status))
    if (sidebarGroup === 'done') filtered = filtered.filter(p => !isProjectActive(p.status))
    if (sidebarGroup === 'archived') filtered = filtered.filter(p => p.status === 'ARCHIVED')
    // dsh-web starred projects: favourites sort to the top.
    if (favProjects.size > 0) {
      filtered = [...filtered].sort((a, b) => (favProjects.has(b.project_id ?? '') ? 1 : 0) - (favProjects.has(a.project_id ?? '') ? 1 : 0))
    }
    // dsh-web counts: reflect the active filter in the footer.
    footLabel.textContent = q === '' && sidebarGroup === 'all'
      ? `${projects.length} projects`
      : `${filtered.length}/${projects.length} projects`
    if (filtered.length === 0) {
      const empty = el('div', 'empty', projects.length === 0 ? 'No projects yet — create one with ＋ above or /research new in Chat.' : 'No matches for the current filter.')
      empty.style.cssText = 'padding:10px 12px'
      list.appendChild(empty)
      return
    }
    for (const p of filtered) {
      const item = el('button', 'ws-item')
      item.setAttribute('role', 'treeitem')
      item.setAttribute('aria-label', `project ${p.name ?? p.project_id ?? ''}`)
      // dsh-web starred projects: ★ toggles the favourite (sorted first).
      const isFav = p.project_id !== undefined && favProjects.has(p.project_id)
      const favStar = el('span', '', isFav ? '★' : '☆')
      favStar.style.cssText = `cursor:pointer;color:${isFav ? 'var(--tone-amber)' : 'var(--text-3)'};font-size:10px;flex-shrink:0`
      favStar.title = isFav ? 'unfavourite project' : 'favourite project (pinned first)'
      favStar.onclick = (event) => {
        event.stopPropagation()
        if (p.project_id === undefined) return
        favProjectToggle(p.project_id)
        renderSidebar(sidebar, projects, activeId, onPick)
      }
      item.appendChild(favStar)
      if (p.project_id === activeId) {
        item.classList.add('active')
        item.setAttribute('aria-current', 'page')
      }
      if (sidebarSelecting && p.project_id !== undefined) {
        if (sidebarSelected.has(p.project_id)) item.classList.add('selected')
        const box = el('span', 'ws-check', sidebarSelected.has(p.project_id) ? '☑' : '☐')
        box.title = 'toggle selection'
        box.onclick = (event) => {
          event.stopPropagation()
          if (p.project_id === undefined) return
          if (sidebarSelected.has(p.project_id)) sidebarSelected.delete(p.project_id)
          else sidebarSelected.add(p.project_id)
          renderSidebar(sidebar, projects, activeId, onPick)
        }
        item.prepend(box)
      }
      // dsh-web "attention" feel: BLOCKED_GATE projects get a red ring and
      // an ⏳ badge so a parked project is visible in the sidebar.
      const blocked = p.status === 'BLOCKED_GATE'
      if (blocked) item.classList.add('blocked')
      const tone = STATUS_META[p.status ?? '']?.tone ?? 'slate'
      const dot = el('span', 'ws-dot')
      dot.style.background = `var(--tone-${tone})`
      item.appendChild(dot)
      const itemText = el('span', 'ws-text')
      itemText.append(
        el('span', 'ws-name', p.name ?? p.project_id ?? ''),
        el('span', 'ws-status', STATUS_META[p.status ?? '']?.label ?? p.status ?? ''),
      )
      item.appendChild(itemText)
      if (blocked) {
        const badge = el('span', 'ws-status', '!')
        badge.title = 'blocked on a human gate decision — click to open Approvals'
        badge.style.cssText = 'color:var(--tone-amber);font-weight:700;cursor:pointer'
        badge.onclick = (event) => {
          event.stopPropagation()
          if (p.project_id !== undefined) onPick(p.project_id)
          state.activeTab = 'gates'
          tabSave()
          state.rerender()
        }
        item.appendChild(badge)
      }
      item.onclick = () => { if (p.project_id !== undefined) onPick(p.project_id) }
      // dsh-web tooltip: full identity of the project on hover.
      item.title = `${p.name ?? ''} · ${p.status ?? ''} · ${p.project_id ?? ''}`
      // dsh-web context menu: right-click on a project row.
      item.oncontextmenu = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
        if (root == null || p.project_id === undefined) return
        const id = p.project_id
        const isArchived = p.status === 'ARCHIVED'
        const ctxItems: ContextMenuItem[] = [
          { label: 'Open', hint: p.status ?? '', onPick: () => onPick(id) },
          { label: '✎ Rename', onPick: () => openRenameModal(root, id, p.name ?? '', () => state.rerender()) },
          { label: 'Copy name', hint: p.name ?? '', onPick: () => copyText(p.name ?? id) },
        ]
        if (isArchived) {
          ctxItems.push({
            label: '↩ Restore',
            divider: true,
            onPick: () => { void api(`/v1/projects/${encodeURIComponent(id)}/unarchive`, { method: 'POST' }).then(() => state.rerender()) },
          })
        } else {
          ctxItems.push({
            label: '🗄 Archive',
            hint: 'data kept',
            divider: true,
            onPick: () => { void api(`/v1/projects/${encodeURIComponent(id)}/archive`, { method: 'POST' }).then(() => state.rerender()) },
          })
        }
        ctxItems.push(
          { label: '⧉ Details', onPick: () => { void openProjectDetailModal(root, id) } },
          { label: 'Copy project ID', hint: id, onPick: () => copyText(id) },
        )
        openContextMenu(root, event.clientX, event.clientY, ctxItems)
      }
      // dsh-web project drawer: double-click opens the full detail modal.
      item.ondblclick = (event) => {
        event.stopPropagation()
        if (p.project_id === undefined) return
        const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
        if (root != null) void openProjectDetailModal(root, p.project_id)
      }
      // dsh-web "session actions": rename + archive/restore (hover only).
      const actionsWrap = el('span')
      actionsWrap.style.cssText = 'display:none;align-items:center;gap:2px;flex-shrink:0'
      const renameBtn = el('span', 'ws-rename', '✎')
      renameBtn.title = 'rename project'
      renameBtn.onclick = (event) => {
        event.stopPropagation()
        if (p.project_id === undefined) return
        const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
        if (root != null) openRenameModal(root, p.project_id, p.name ?? '', () => state.rerender())
      }
      const archived = p.status === 'ARCHIVED'
      const arcBtn = el('span', 'ws-rename', archived ? '↩' : '🗄')
      arcBtn.title = archived ? 'restore project' : 'archive project (data kept)'
      arcBtn.onclick = async (event) => {
        event.stopPropagation()
        if (p.project_id === undefined) return
        if (!archived) {
          const ok = await api(`/v1/projects/${encodeURIComponent(p.project_id)}/archive`, { method: 'POST' })
          if (ok === null) { state.lastError = 'archive failed (bridge error)'; return }
          showToast(rootHost(), `🗄 Archived ${p.name ?? p.project_id}`)
        } else {
          const ok = await api(`/v1/projects/${encodeURIComponent(p.project_id)}/unarchive`, { method: 'POST' })
          if (ok === null) { state.lastError = 'restore failed (bridge error)'; return }
          showToast(rootHost(), `↩ Restored ${p.name ?? p.project_id}`)
        }
        state.rerender()
      }
      actionsWrap.append(renameBtn, arcBtn)
      item.appendChild(actionsWrap)
      list.appendChild(item)
    }
  }
  search.oninput = () => { sidebarQuery = search.value; renderRows() }
  renderRows()
  sidebar.appendChild(list)

  const foot = el('div', 'sidebar-foot')
  foot.style.cssText = 'display:flex;align-items:center;gap:8px;justify-content:space-between'
  // dsh-web overview: activity snapshot under the project list.
  const activeCount = projects.filter(p => isProjectActive(p.status)).length
  const blockedCount = projects.filter(p => p.status === 'BLOCKED_GATE').length
  const footStats = el('span', 'muted', `${activeCount} active · ${blockedCount} blocked`)
  footStats.style.cssText = 'font-size:9.5px;flex-shrink:0'
  const settingsBtn = el('button', 'hbtn', '⚙ Settings')
  settingsBtn.title = 'connection, token and appearance settings'
  settingsBtn.onclick = () => {
    const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
    if (root != null) openSettingsModal(root)
  }
  if (!sidebarSelecting) {
    const selectBtn = el('button', 'hbtn', '☑ Select')
    selectBtn.title = 'multi-select projects (bulk actions)'
    selectBtn.setAttribute('aria-pressed', 'false')
    selectBtn.onclick = () => {
      sidebarSelecting = true
      sidebarSelected.clear()
      renderSidebar(sidebar, projects, activeId, onPick)
    }
    foot.append(footLabel, footStats, selectBtn, settingsBtn)
  } else {
    const doneBtn = el('button', 'hbtn', 'Done')
    doneBtn.onclick = () => {
      sidebarSelecting = false
      sidebarSelected.clear()
      renderSidebar(sidebar, projects, activeId, onPick)
    }
    const countLabel = el('span', '', `${sidebarSelected.size} selected`)
    const archiveSel = el('button', 'hbtn', '🗄 Archive')
    archiveSel.disabled = sidebarSelected.size === 0
    archiveSel.onclick = async () => {
      for (const id of sidebarSelected) {
        await api(`/v1/projects/${encodeURIComponent(id)}/archive`, { method: 'POST' })
      }
      showToast(rootHost(), `🗄 Archived ${sidebarSelected.size} project(s)`)
      sidebarSelecting = false
      sidebarSelected.clear()
      state.rerender()
    }
    // dsh-web compare: side-by-side view of the selected projects.
    const compareBtn = el('button', 'hbtn', '⇄ Compare')
    compareBtn.disabled = sidebarSelected.size < 2
    compareBtn.onclick = () => {
      const root = sidebar.getRootNode() instanceof ShadowRoot ? sidebar.getRootNode() as ShadowRoot : null
      if (root !== null && sidebarSelected.size >= 2) {
        void openCompareModal(root, [...sidebarSelected])
      }
    }
    foot.append(countLabel, footStats, archiveSel, compareBtn, doneBtn)
  }
  sidebar.appendChild(foot)
}

/** Multi-select mode for the sidebar (dsh-web bulk session actions). */
let sidebarSelecting = false
let sidebarSelected = new Set<string>()
