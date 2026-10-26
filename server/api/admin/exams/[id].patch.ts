import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { readParam } from '../../../utils/params'
import { readJsonObject } from '../../../utils/validate'
import { requireAdmin } from '../../../services/session'
import { getExamAdminDTO, updateExam } from '../../../services/exams'

/** 修改草稿（§8.5 18）：已发布或出题中 409，版本冲突 409 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const body = await readJsonObject(event)
    const db = useDb()
    const exam = updateExam(db, examId, body, now)
    return ok(event, getExamAdminDTO(db, exam.id, now))
  } catch (error) {
    return failFrom(event, error)
  }
})
