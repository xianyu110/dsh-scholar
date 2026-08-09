/**
 * artifacts namespace (gui-plugin-plan §13.1): Artifacts tab + preview modal
 * chrome. Artifact kind labels, hashes and content stay raw.
 */
export const zh = {
  'artifacts.section': '产物 ({count},点击预览)',
  'artifacts.select': '☑ 选择',
  'artifacts.selecting': '☑ 选择中…',
  'artifacts.select.title': '多选产物(批量下载)',
  'artifacts.selecting.title': '退出多选',
  'artifacts.empty': '暂无产物——运行与分析会产生它们。',
  'artifacts.filterPlaceholder': '🔍 过滤产物…',
  'artifacts.downloadSelected': '⬇ 下载选中',
  'artifacts.done': '完成',
  'artifacts.all': '☑ 全选',
  'artifacts.all.title': '选择全部产物',
  'artifacts.showingNewest': '显示最新 15 个(共 {count} 个)——其余请使用全局搜索或导出。',
  'artifacts.noMatch': '没有匹配 "{query}" 的产物{kind}。',
  'artifacts.rowTitle': '点击预览 · 双击查看详情',
  'artifacts.detail.title': '产物',
  'artifacts.detail.metadata': '元数据',
  'artifacts.detail.preview': '⧉ 预览',
  'artifacts.detail.openTab': '⧉ 在新标签页打开',
  'artifacts.detail.openTab.title': '在新浏览器标签页中打开该产物',
  'artifacts.kindAll': '全部 ({count})',
  'artifacts.downloadedToast': '⬇ 已下载 {count} 个产物',
  'artifacts.detailModal': '📦 产物详情',
  'artifacts.previewDisabled': '⚠️ 出于安全原因,HTML 预览已禁用(design §15.4)— 请下载文件。',
  'artifacts.truncated': '…(已截断)',


  'artifacts.detailArtifact': '产物',
  'artifacts.detailKind': '类型',
  'artifacts.detailSize': '大小',
}


export const en: Record<keyof typeof zh, string> = {
  'artifacts.section': 'Artifacts ({count}, click to preview)',
  'artifacts.select': '☑ Select',
  'artifacts.selecting': '☑ Selecting…',
  'artifacts.select.title': 'multi-select artifacts (bulk download)',
  'artifacts.selecting.title': 'exit multi-select',
  'artifacts.empty': 'No artifacts yet — runs and analysis produce them.',
  'artifacts.filterPlaceholder': '🔍 Filter artifacts…',
  'artifacts.downloadSelected': '⬇ Download selected',
  'artifacts.done': 'Done',
  'artifacts.all': '☑ all',
  'artifacts.all.title': 'select all artifacts',
  'artifacts.showingNewest': 'Showing the newest 15 of {count} artifacts — use the global search or export for the rest.',
  'artifacts.noMatch': 'No artifacts match "{query}"{kind}.',
  'artifacts.rowTitle': 'click to preview · double-click for details',
  'artifacts.detail.title': 'Artifact',
  'artifacts.detail.metadata': 'Metadata',
  'artifacts.detail.preview': '⧉ preview',
  'artifacts.detail.openTab': '⧉ open in tab',
  'artifacts.detail.openTab.title': 'open the artifact in a new browser tab',
  'artifacts.kindAll': 'All ({count})',
  'artifacts.downloadedToast': '⬇ Downloaded {count} artifact(s)',
  'artifacts.detailModal': '📦 Artifact details',
  'artifacts.previewDisabled': '⚠️ HTML preview is disabled for security (design §15.4) — download the file instead.',
  'artifacts.truncated': '… (truncated)',


  'artifacts.detailArtifact': 'Artifact',
  'artifacts.detailKind': 'Kind',
  'artifacts.detailSize': 'Size',
}

