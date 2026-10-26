import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { requireAdmin } from '../../../services/session'
import { readParam } from '../../../utils/params'
import { readExpectedVersion, queryValue } from '../../../utils/validate'
import { changeBankState } from '../../../services/question-bank'
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    const admin = requireAdmin(event, now)
    const version = readExpectedVersion({ expectedVersion: Number(queryValue(getQuery(event).expectedVersion)) })
    changeBankState(useDb(), readParam(event, 'itemId'), version, 'delete', admin.name, now)
    return ok(event, { ok: true })
  } catch (error) { return failFrom(event, error) }
})
