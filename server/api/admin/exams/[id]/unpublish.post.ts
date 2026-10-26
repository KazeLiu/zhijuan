import { useDb } from '../../../../utils/db'
import { failFrom, ok } from '../../../../utils/respond'
import { readParam } from '../../../../utils/params'
import { requireAdmin } from '../../../../services/session'
import { getExamAdminDTO, unpublishExam } from '../../../../services/exams'

/** 撤回发布（§8.5 26）：仅发布后未开始且无答卷 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const db = useDb()
    const exam = unpublishExam(db, examId, now)
    return ok(event, getExamAdminDTO(db, exam.id, now))
  } catch (error) {
    return failFrom(event, error)
  }
})
