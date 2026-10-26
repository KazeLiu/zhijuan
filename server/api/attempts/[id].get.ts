import { useDb } from '../../utils/db'
import { failFrom, ok } from '../../utils/respond'
import { readParam } from '../../utils/params'
import { requireSession } from '../../services/session'
import { loadAttemptDetail } from '../../services/attempts'

/** 答题页数据（§8.3 7）：仅本人答卷，过期先结算 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    const session = requireSession(event, now)
    const attemptId = readParam(event, 'id')
    const db = useDb()
    return ok(event, loadAttemptDetail(db, attemptId, session.name, now))
  } catch (error) {
    return failFrom(event, error)
  }
})
