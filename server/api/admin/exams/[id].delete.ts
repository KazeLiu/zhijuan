import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { readParam } from '../../../utils/params'
import { requireAdmin } from '../../../services/session'
import { deleteExam } from '../../../services/exams'

/** 删除草稿（§8.5 19）：已发布或有答卷 409；级联删资料与上传目录 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const db = useDb()
    await deleteExam(db, examId)
    return ok(event, { ok: true })
  } catch (error) {
    return failFrom(event, error)
  }
})
