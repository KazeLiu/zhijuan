import { useDb } from '../../utils/db'
import { failFrom, ok } from '../../utils/respond'
import { requireSession } from '../../services/session'
import { buildCurrentExam } from '../../services/exams'

/** 考生当前场次（§8.3 4） */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    const session = requireSession(event, now)
    const db = useDb()
    return ok(event, buildCurrentExam(db, session.name, now))
  } catch (error) {
    return failFrom(event, error)
  }
})
