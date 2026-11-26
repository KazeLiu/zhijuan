import { DEFAULT_PAGE_SIZE } from '../../../shared/constants'
import { QUESTION_TYPES } from '../../../shared/types/question'
import { useDb } from '../../utils/db'
import { failFrom, ok } from '../../utils/respond'
import { FieldErrors, paginate, parsePageValue } from '../../utils/validate'
import { requireSession } from '../../services/session'
import { listMyMistakes } from '../../db/queries/mistakes'

/** 个人错题集（§8.3 5）：姓名只认会话，答案未公开的场次在 SQL 里就被排除，不泄露题目与数量 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    const session = requireSession(event, now)
    const query = getQuery(event)
    const errors = new FieldErrors()
    const keyword = errors.text(query, 'query', '关键词', { max: 200, trim: true })
    const type = errors.oneOf(query, 'type', '题型', QUESTION_TYPES)
    errors.throwIfAny()
    const page = parsePageValue(query.page)
    const { rows, total } = listMyMistakes(useDb(), {
      nameKey: session.name,
      now,
      query: keyword,
      type,
      limit: DEFAULT_PAGE_SIZE,
      offset: (page - 1) * DEFAULT_PAGE_SIZE,
    })
    return ok(event, paginate(rows, page, total))
  } catch (error) {
    return failFrom(event, error)
  }
})
