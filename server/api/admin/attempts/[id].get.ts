import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { readParam } from '../../../utils/params'
import { requireAdmin } from '../../../services/session'
import { loadAttemptAdminDetail } from '../../../services/results'

/** 管理端查看答卷（§8.7 29）：仅已交卷可看，含标准答案与改分记录 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const attemptId = readParam(event, 'id')
    const db = useDb()
    return ok(event, loadAttemptAdminDetail(db, attemptId, now))
  } catch (error) {
    return failFrom(event, error)
  }
})
