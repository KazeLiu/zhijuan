import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { readJsonObject } from '../../../utils/validate'
import { requireAdmin } from '../../../services/session'
import { createExam, getExamAdminDTO } from '../../../services/exams'

/** 新建草稿场次（§8.5 16）：缺省当天 00:00 至次日 00:00 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const body = await readJsonObject(event)
    const db = useDb()
    const exam = createExam(db, body, now)
    return ok(event, getExamAdminDTO(db, exam.id, now), 201)
  } catch (error) {
    return failFrom(event, error)
  }
})
