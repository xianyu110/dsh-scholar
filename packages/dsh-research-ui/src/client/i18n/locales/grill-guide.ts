/**
 * INIT-GRILL-02 conversational Brief intake copy (zh). Keys mirror `en`
 * exactly (localeParityReport gates drift). Questions render as assistant
 * turns and answers use the ordinary project Chat composer.
 */
export const zh: Record<string, string> = {
  'grill-guide.title': '完善研究 Brief — 按顺序回答以创建项目',
  'grill-guide.chatTitle': '完善研究 Brief',
  'grill-guide.chatAnswerPlaceholder': '回答上面的 Brief 问题…',
  'grill-guide.chatAnswerRecorded': '已记录你的回答，下一题已显示在对话末尾。',
  'grill-guide.chatSkipped': '跳过这个 Brief 问题',
  'grill-guide.chatUnknown': '这个 Brief 问题暂时未知',
  'grill-guide.progress': '已答 {answered} / {total}',
  'grill-guide.skip': '跳过',
  'grill-guide.markUnknown': '标记未知',
  'grill-guide.confirm': '确认 Brief',
  'grill-guide.next.answer': 'answer',
  'grill-guide.next.confirm': 'confirm',
  'grill-guide.next.done': 'done',
  'grill-guide.error.http': '服务端错误 — 请刷新后重试。',
  'grill-guide.error.revisionConflict': '项目已变更 — 请刷新后重试。',
  'grill-guide.error.intakeRevisionConflict': '接入会话已变更 — 请刷新后重试。',
  'grill-guide.error.briefConfirmed': '该项目的 Brief 已确认(可能在其他窗口完成)— 刷新查看最新状态。',
  'grill-guide.error.unknown': '请求失败({code})— 请刷新后重试。',
}

/** INIT-GRILL-02 conversational Brief intake copy (en). Keys mirror `zh` exactly
 *  (localeParityReport gates drift). */
export const en: Record<string, string> = {
  'grill-guide.title': 'Refine the Research Brief — answer in order to create the project',
  'grill-guide.chatTitle': 'Refine the Research Brief',
  'grill-guide.chatAnswerPlaceholder': 'Answer the Brief question above…',
  'grill-guide.chatAnswerRecorded': 'Your answer was recorded. The next question is now at the end of the conversation.',
  'grill-guide.chatSkipped': 'Skip this Brief question',
  'grill-guide.chatUnknown': 'This Brief question is currently unknown',
  'grill-guide.progress': 'Answered {answered} / {total}',
  'grill-guide.skip': 'Skip',
  'grill-guide.markUnknown': 'Mark unknown',
  'grill-guide.confirm': 'Confirm Brief',
  'grill-guide.next.answer': 'answer',
  'grill-guide.next.confirm': 'confirm',
  'grill-guide.next.done': 'done',
  'grill-guide.error.http': 'Server error — refresh and retry.',
  'grill-guide.error.revisionConflict': 'The project changed — refresh and retry.',
  'grill-guide.error.intakeRevisionConflict': 'The intake session changed — refresh and retry.',
  'grill-guide.error.briefConfirmed': "This project's Brief is already confirmed (maybe in another window) — refresh to see the latest state.",
  'grill-guide.error.unknown': 'Request failed ({code}) — refresh and retry.',
}
