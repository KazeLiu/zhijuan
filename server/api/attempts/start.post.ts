import { useDb } from '../../utils/db'
import { failFrom, ok } from '../../utils/respond'
import { requireSession } from '../../services/session'
import { startAttempt } from '../../services/attempts'

/** 开始/续答（§8.3 6）：新建 201，续答或已交卷 200；先结算本人过期答卷 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    const session = requireSession(event, now)
    const db = useDb()
    const { result, created } = startAttempt(db, session.name, now)
    return ok(event, result, created ? 201 : 200)
  } catch (error) {
    return failFrom(event, error)
  }
})
