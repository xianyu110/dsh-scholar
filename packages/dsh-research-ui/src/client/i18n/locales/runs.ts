/**
 * runs namespace (gui-plugin-plan §13.1): Runs tab chrome — section label,
 * filter chips, selection affordances. Job status values stay raw.
 */
export const zh = {
  'runs.section': '运行 ({count})',
  'runs.select': '☑ 选择',
  'runs.selecting': '☑ 选择中…',
  'runs.select.title': '多选运行(批量取消)',
  'runs.selecting.title': '退出多选',
  'runs.filter.all': '全部',
  'runs.filter.queued': '排队',
  'runs.filter.running': '运行中',
  'runs.filter.succeeded': '成功',
  'runs.filter.failed': '失败',
  'runs.filter.cancelled': '已取消',
}

export const en: Record<keyof typeof zh, string> = {
  'runs.section': 'Runs ({count})',
  'runs.select': '☑ Select',
  'runs.selecting': '☑ Selecting…',
  'runs.select.title': 'multi-select runs (bulk cancel)',
  'runs.selecting.title': 'exit multi-select',
  'runs.filter.all': 'All',
  'runs.filter.queued': 'Queued',
  'runs.filter.running': 'Running',
  'runs.filter.succeeded': 'Succeeded',
  'runs.filter.failed': 'Failed',
  'runs.filter.cancelled': 'Cancelled',
}
