import { describe, expect, it } from 'vitest'
import { canDeleteArchivedProject, projectDeleteRequest } from '../../packages/dsh-research-ui/src/client/project-delete-model'
import { en as shellEn, zh as shellZh } from '../../packages/dsh-research-ui/src/client/i18n/locales/shell'

describe('PROJECT-DELETE-01 browser model', () => {
  it('requires archived state, exact untrimmed name confirmation and a non-empty reason', () => {
    expect(canDeleteArchivedProject('ARCHIVED', 'Exact Name', 'Exact Name', 'finished')).toBe(true)
    expect(canDeleteArchivedProject('RELEASED', 'Exact Name', 'Exact Name', 'finished')).toBe(false)
    expect(canDeleteArchivedProject('ARCHIVED', 'Exact Name', ' exact name ', 'finished')).toBe(false)
    expect(canDeleteArchivedProject('ARCHIVED', 'Exact Name', 'Exact Name', '   ')).toBe(false)
  })

  it('builds only the public DELETE body and request id header', () => {
    expect(projectDeleteRequest('rsp_x', 7, 'Exact Name', 'finished', 'req_1')).toEqual({
      path: '/v1/projects/rsp_x',
      init: {
        method: 'DELETE',
        headers: { 'x-request-id': 'req_1' },
        body: JSON.stringify({ expected_revision: 7, confirm_name: 'Exact Name', reason: 'finished' }),
      },
    })
  })

  it('ships every project-delete chrome key in zh and en', () => {
    const keys = [
      'shell.deleteProject.title', 'shell.deleteProject.warning', 'shell.deleteProject.retention',
      'shell.deleteProject.confirmLabel', 'shell.deleteProject.reasonLabel', 'shell.deleteProject.submit',
      'shell.deleteProject.failed', 'shell.deleteProject.deleted', 'shell.sidebar.deleteTitle',
    ]
    for (const key of keys) {
      expect(shellZh[key]).toBeTruthy()
      expect(shellEn[key]).toBeTruthy()
    }
  })
})
