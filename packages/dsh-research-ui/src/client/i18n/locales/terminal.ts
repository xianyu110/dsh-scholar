/**
 * terminal namespace (gui-plugin-plan §13.1): Terminal tab chrome.
 * Terminal bytes themselves are raw execution data and never translated.
 */
export const zh = {
  'terminal.status.idle': '空闲',
  'terminal.status.connecting': '连接中…',
  'terminal.status.live': '实时',
  'terminal.status.reconnecting': '重连中…',
  'terminal.status.exited': '已退出',
  'terminal.channel.all': '全部',
  'terminal.channel.stdout': '标准输出',
  'terminal.channel.stderr': '标准错误',
  'terminal.action.copyVisible': '复制可见',
  'terminal.action.downloadLog': '下载日志',
  'terminal.action.jumpLatest': '↓ 最新',
  'terminal.filterPlaceholder': '🔍 过滤输出…',
  'terminal.selectRun': '选择运行',
  'terminal.empty': '暂无运行——任务出现后会实时显示输出。',
  'terminal.gapWarning': '— 缺口:已丢弃 {dropped} 字节;保留自 seq {retained} —',
  'terminal.exitLine': '— 退出{code}{signal}{truncated} · {bytes} 字节{dropped} —',
  'terminal.lines': '{shown}/{max} 行',
} as const

export type TerminalKey = keyof typeof zh

export const en: Record<TerminalKey, string> = {
  'terminal.status.idle': 'idle',
  'terminal.status.connecting': 'connecting…',
  'terminal.status.live': 'live',
  'terminal.status.reconnecting': 'reconnecting…',
  'terminal.status.exited': 'exited',
  'terminal.channel.all': 'All',
  'terminal.channel.stdout': 'stdout',
  'terminal.channel.stderr': 'stderr',
  'terminal.action.copyVisible': 'copy',
  'terminal.action.downloadLog': 'download log',
  'terminal.action.jumpLatest': '↓ latest',
  'terminal.filterPlaceholder': '🔍 filter output…',
  'terminal.selectRun': 'select run',
  'terminal.empty': 'No runs yet — jobs appear here with their live output.',
  'terminal.gapWarning': '— gap: {dropped} byte(s) dropped; retained from seq {retained} —',
  'terminal.exitLine': '— exit{code}{signal}{truncated} · {bytes} byte(s){dropped} —',
  'terminal.lines': '{shown}/{max} lines',
}
