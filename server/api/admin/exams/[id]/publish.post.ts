import { useDb } from '../../../../utils/db'
import { failFrom, ok } from '../../../../utils/respond'
import { readParam } from '../../../../utils/params'
import { requireAdmin } from '../../../../services/session'
import { getExamAdminDTO, publishExam } from '../../../../services/exams'

/** 发布场次（§8.5 25）：8 项预检全过才落库 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const db = useDb()
    const exam = publishExam(db, examId, now)
    return ok(event, getExamAdminDTO(db, exam.id, now))
  } catch (error) {
    return failFrom(event, error)
  }
})
