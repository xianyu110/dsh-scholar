/**
 * budget namespace (gui-plugin-plan §13.1): Budget tab + project modal
 * chrome. Numbers and policy values stay raw.
 */
export const zh = {
  'budget.section': '预算',
  'budget.details': 'ℹ 详情',
  'budget.projectContents': '项目内容',
  'budget.modal.cancel': '取消',
  'budget.modal.create': '创建项目',
  'budget.modal.title': '＋ 新建研究项目',
  'budget.modal.fieldName': '项目名称',
  'budget.modal.fieldProblem': '问题陈述',
  'budget.modal.fieldMetric': '主要指标',
  'budget.modal.placeholderName': '例如 shift-localization',
  'budget.modal.placeholderProblem': '例如 不确定性加权在域偏移下是否有帮助?',
  'budget.modal.placeholderMetric': '例如 mAP@0.5',
  'budget.detailsModal': '💰 预算与策略详情',
}

export const en: Record<keyof typeof zh, string> = {
  'budget.section': 'Budget',
  'budget.details': 'ℹ details',
  'budget.projectContents': 'Project contents',
  'budget.modal.cancel': 'Cancel',
  'budget.modal.create': 'Create Project',
  'budget.modal.title': '＋ New Research Project',
  'budget.modal.fieldName': 'Project name',
  'budget.modal.fieldProblem': 'Problem statement',
  'budget.modal.fieldMetric': 'Primary metric',
  'budget.modal.placeholderName': 'e.g. shift-localization',
  'budget.modal.placeholderProblem': 'e.g. Does uncertainty weighting help under domain shift?',
  'budget.modal.placeholderMetric': 'e.g. mAP@0.5',
  'budget.detailsModal': '💰 Budget & policy details',
}
