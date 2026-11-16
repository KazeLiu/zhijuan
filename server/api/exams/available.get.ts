import { useDb } from '../../utils/db'
import { failFrom, ok } from '../../utils/respond'
import { requireSession } from '../../services/session'
import { buildAvailableExams } from '../../services/exams'

/** 考生可选场次列表（契约 §10.2）：开放中在前、未开始在后，各按开始时间升序 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    const session = requireSession(event, now)
    const db = useDb()
    return ok(event, buildAvailableExams(db, session.name, now))
  } catch (error) {
    return failFrom(event, error)
  }
})
