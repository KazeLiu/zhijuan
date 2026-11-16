import { useDb } from '../../../../utils/db'
import { failFrom, ok } from '../../../../utils/respond'
import { readParam } from '../../../../utils/params'
import { readOptionalJsonObject } from '../../../../utils/validate'
import { requireAdmin } from '../../../../services/session'
import { getExamAdminDTO, resumeExam } from '../../../../services/exams'

/** 继续场次（契约 §3.1）：仅暂停中的已发布场次可继续；进行中的答卷不受暂停影响 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const body = await readOptionalJsonObject(event)
    const db = useDb()
    const exam = resumeExam(db, examId, body, now)
    return ok(event, getExamAdminDTO(db, exam.id, now))
  } catch (error) {
    return failFrom(event, error)
  }
})
