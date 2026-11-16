import { useDb } from '../../../../utils/db'
import { failFrom, ok } from '../../../../utils/respond'
import { readParam } from '../../../../utils/params'
import { readOptionalJsonObject } from '../../../../utils/validate'
import { requireAdmin } from '../../../../services/session'
import { getExamAdminDTO, endExam } from '../../../../services/exams'

/** 提前结束场次（契约 §3.1）：任意阶段（未开始/开放中/暂停中）都可结束 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const body = await readOptionalJsonObject(event)
    const db = useDb()
    const exam = endExam(db, examId, body, now)
    return ok(event, getExamAdminDTO(db, exam.id, now))
  } catch (error) {
    return failFrom(event, error)
  }
})
