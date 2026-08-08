/**
 * shell namespace (gui-plugin-plan §13.1): top-level chrome — settings,
 * shortcuts, about and global labels.
 */
export const zh = {
  'shell.settings.title': '⚙ 设置',
  'shell.settings.connection': '连接',
  'shell.settings.access': '访问',
  'shell.settings.appearance': '外观',
  'shell.settings.preferences': '偏好',
  'shell.settings.conversation': '对话',
  'shell.settings.project': '项目',
  'shell.settings.help': '帮助',
  'shell.settings.data': '数据',
  'shell.settings.kernel': '内核',
  'shell.settings.language': '语言',
  'shell.shortcuts.title': '⌨ 键盘快捷键',
  'shell.about.title': 'ℹ 关于 Research OS',
  'shell.theme.light': '浅色',
  'shell.theme.dark': '深色',
  'shell.theme.toggle': '切换主题',
} as const

export type ShellKey = keyof typeof zh

export const en: Record<ShellKey, string> = {
  'shell.settings.title': '⚙ Settings',
  'shell.settings.connection': 'Connection',
  'shell.settings.access': 'Access',
  'shell.settings.appearance': 'Appearance',
  'shell.settings.preferences': 'Preferences',
  'shell.settings.conversation': 'Conversation',
  'shell.settings.project': 'Project',
  'shell.settings.help': 'Help',
  'shell.settings.data': 'Data',
  'shell.settings.kernel': 'Kernel',
  'shell.settings.language': 'Language',
  'shell.shortcuts.title': '⌨ Keyboard Shortcuts',
  'shell.about.title': 'ℹ About Research OS',
  'shell.theme.light': 'Light',
  'shell.theme.dark': 'Dark',
  'shell.theme.toggle': 'Toggle theme',
}
