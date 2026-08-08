/**
 * common namespace (gui-plugin-plan §13.1): UI chrome shared across views.
 * keyof zh is the key type; en must be exactly complete.
 */
export const zh = {
  'common.action.cancel': '取消',
  'common.action.save': '保存',
  'common.action.close': '关闭',
  'common.action.copy': '复制',
  'common.action.refresh': '刷新',
  'common.action.retry': '重试',
  'common.action.download': '下载',
  'common.action.delete': '删除',
  'common.action.clear': '清空',
  'common.action.open': '打开',
  'common.action.rename': '重命名',
  'common.action.archive': '归档',
  'common.action.restore': '恢复',
  'common.action.details': '详情',
  'common.action.previous': '上一步',
  'common.action.next': '下一步',
  'common.status.connected': '已连接',
  'common.status.unreachable': '不可达',
  'common.status.loading': '加载中…',
  'common.status.empty': '暂无数据',
  'common.status.noMatches': '无匹配',
  'common.error.generic': '出错了',
  'common.error.bridge': '通信桥错误',
} as const

export type CommonKey = keyof typeof zh

export const en: Record<CommonKey, string> = {
  'common.action.cancel': 'Cancel',
  'common.action.save': 'Save',
  'common.action.close': 'Close',
  'common.action.copy': 'Copy',
  'common.action.refresh': 'Refresh',
  'common.action.retry': 'Retry',
  'common.action.download': 'Download',
  'common.action.delete': 'Delete',
  'common.action.clear': 'Clear',
  'common.action.open': 'Open',
  'common.action.rename': 'Rename',
  'common.action.archive': 'Archive',
  'common.action.restore': 'Restore',
  'common.action.details': 'Details',
  'common.action.previous': 'Previous',
  'common.action.next': 'Next',
  'common.status.connected': 'Connected',
  'common.status.unreachable': 'Unreachable',
  'common.status.loading': 'Loading…',
  'common.status.empty': 'Nothing here yet',
  'common.status.noMatches': 'No matches',
  'common.error.generic': 'Something went wrong',
  'common.error.bridge': 'Bridge error',
}
