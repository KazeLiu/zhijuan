import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { readParam } from '../../../utils/params'
import { requireAdmin } from '../../../services/session'
import { getExamAdminDTO } from '../../../services/exams'

/** 场次详情（§8.5 17）：含题目、资料、活动任务与发布预检 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const db = useDb()
    return ok(event, getExamAdminDTO(db, examId, now))
  } catch (error) {
    return failFrom(event, error)
  }
})
