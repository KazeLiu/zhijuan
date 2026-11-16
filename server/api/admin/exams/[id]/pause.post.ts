import { useDb } from '../../../../utils/db'
import { failFrom, ok } from '../../../../utils/respond'
import { readParam } from '../../../../utils/params'
import { readOptionalJsonObject } from '../../../../utils/validate'
import { requireAdmin } from '../../../../services/session'
import { getExamAdminDTO, pauseExam } from '../../../../services/exams'

/** 暂停场次（契约 §3.1）：已发布且未结束、未暂停才能暂停；暂停后不接受新答卷 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    // 请求体可省略：仅用于可选的 expectedVersion 乐观锁
    const body = await readOptionalJsonObject(event)
    const db = useDb()
    const exam = pauseExam(db, examId, body, now)
    return ok(event, getExamAdminDTO(db, exam.id, now))
  } catch (error) {
    return failFrom(event, error)
  }
})
