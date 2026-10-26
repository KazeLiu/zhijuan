import { DEFAULT_PAGE_SIZE } from '../../../../shared/constants'
import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { FieldErrors, countChars, paginate, parsePageValue, queryValue } from '../../../utils/validate'
import { requireAdmin } from '../../../services/session'
import { listExamRows, toExamListRowDTO } from '../../../services/exams'

/** 场次列表（§8.5 15）：可筛选状态与标题关键词，按更新时间倒序 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const db = useDb()
    const query = getQuery(event)
    const page = parsePageValue(query.page)
    const errors = new FieldErrors()
    const statusRaw = queryValue(query.status)
    let status: 'draft' | 'published' | undefined
    if (statusRaw !== undefined && statusRaw !== '') {
      if (statusRaw === 'draft' || statusRaw === 'published') status = statusRaw
      else errors.add('status', 'status 只接受 draft 或 published')
    }
    const keyword = queryValue(query.keyword)
    if (keyword !== undefined && countChars(keyword) > 100) {
      errors.add('keyword', '搜索关键词不能超过 100 字')
    }
    errors.throwIfAny()
    const { rows, total } = listExamRows(db, {
      status,
      keyword,
      limit: DEFAULT_PAGE_SIZE,
      offset: (page - 1) * DEFAULT_PAGE_SIZE,
    })
    return ok(event, paginate(rows.map(toExamListRowDTO), page, total))
  } catch (error) {
    return failFrom(event, error)
  }
})
