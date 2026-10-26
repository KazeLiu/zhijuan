import { DEFAULT_PAGE_SIZE } from '../../../shared/constants'
import { useDb } from '../../utils/db'
import { failFrom, ok } from '../../utils/respond'
import { paginate, parsePageValue } from '../../utils/validate'
import { requireSession } from '../../services/session'
import { listAttemptHistory, toMyAttemptRowDTO } from '../../db/queries/attempts'

/** 我的记录（§8.3 5）：仅本人答卷，按开始时间倒序分页 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    const session = requireSession(event, now)
    const db = useDb()
    const page = parsePageValue(getQuery(event).page)
    const { rows, total } = listAttemptHistory(db, session.name, DEFAULT_PAGE_SIZE, (page - 1) * DEFAULT_PAGE_SIZE)
    return ok(event, paginate(rows.map(toMyAttemptRowDTO), page, total))
  } catch (error) {
    return failFrom(event, error)
  }
})
