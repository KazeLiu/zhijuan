import { useDb } from '../../../../../utils/db'
import { failFrom, ok } from '../../../../../utils/respond'
import { readParam } from '../../../../../utils/params'
import { requireAdmin } from '../../../../../services/session'
import { loadResultsPage } from '../../../../../services/results'

/** 场次成绩汇总（§8.6 27）：summary 统计全量，items 按筛选分页 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const db = useDb()
    return ok(event, loadResultsPage(db, examId, getQuery(event), now))
  } catch (error) {
    return failFrom(event, error)
  }
})
