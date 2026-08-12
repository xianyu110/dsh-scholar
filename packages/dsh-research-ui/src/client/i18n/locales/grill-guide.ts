/**
 * INIT-GRILL-02 chat guide card copy (zh). Keys mirror `en` exactly
 * (localeParityReport gates drift). The card renders above the chat composer
 * while a project is still collecting its Brief and walks the user through
 * the 7 deterministic Init Grill questions → PI confirm.
 */
export const zh: Record<string, string> = {
  'grill-guide.title': '完善研究 Brief — 按顺序回答以创建项目',
  'grill-guide.progress': '已答 {answered} / {total}',
  'grill-guide.answerPlaceholder': '输入你的回答…',
  'grill-guide.answerEmpty': '请先输入回答内容,或选择「跳过」/「标记未知」。',
  'grill-guide.submit': '提交',
  'grill-guide.skip': '跳过',
  'grill-guide.markUnknown': '标记未知',
  'grill-guide.confirm': '确认 Brief',
  'grill-guide.readyHint': '全部问题已处理,可确认 Brief 并创建 Scope Gate。',
  'grill-guide.answeredList': '已答 {count} 题',
  'grill-guide.disposition.answered': '已答',
  'grill-guide.disposition.skipped': '跳过',
  'grill-guide.disposition.unknown': '未知',
  'grill-guide.projectReady': '项目已就绪 — 输入 /help 查看命令。',
  'grill-guide.next.answer': 'answer',
  'grill-guide.next.confirm': 'confirm',
  'grill-guide.next.done': 'done',
  'grill-guide.error.http': '服务端错误 — 请刷新后重试。',
  'grill-guide.error.revisionConflict': '项目已变更 — 请刷新后重试。',
  'grill-guide.error.intakeRevisionConflict': '接入会话已变更 — 请刷新后重试。',
  'grill-guide.error.briefConfirmed': '该项目的 Brief 已确认(可能在其他窗口完成)— 刷新查看最新状态。',
  'grill-guide.error.unknown': '请求失败({code})— 请刷新后重试。',
}

/** INIT-GRILL-02 chat guide card copy (en). Keys mirror `zh` exactly
 *  (localeParityReport gates drift). */
export const en: Record<string, string> = {
  'grill-guide.title': 'Refine the Research Brief — answer in order to create the project',
  'grill-guide.progress': 'Answered {answered} / {total}',
  'grill-guide.answerPlaceholder': 'Type your answer…',
  'grill-guide.answerEmpty': 'Enter an answer, or choose Skip / Mark unknown.',
  'grill-guide.submit': 'Submit',
  'grill-guide.skip': 'Skip',
  'grill-guide.markUnknown': 'Mark unknown',
  'grill-guide.confirm': 'Confirm Brief',
  'grill-guide.readyHint': 'All questions are handled — you can confirm the Brief and create the Scope Gate.',
  'grill-guide.answeredList': 'Answered {count}',
  'grill-guide.disposition.answered': 'answered',
  'grill-guide.disposition.skipped': 'skipped',
  'grill-guide.disposition.unknown': 'unknown',
  'grill-guide.projectReady': 'Project ready — type /help to see commands.',
  'grill-guide.next.answer': 'answer',
  'grill-guide.next.confirm': 'confirm',
  'grill-guide.next.done': 'done',
  'grill-guide.error.http': 'Server error — refresh and retry.',
  'grill-guide.error.revisionConflict': 'The project changed — refresh and retry.',
  'grill-guide.error.intakeRevisionConflict': 'The intake session changed — refresh and retry.',
  'grill-guide.error.briefConfirmed': "This project's Brief is already confirmed (maybe in another window) — refresh to see the latest state.",
  'grill-guide.error.unknown': 'Request failed ({code}) — refresh and retry.',
}
