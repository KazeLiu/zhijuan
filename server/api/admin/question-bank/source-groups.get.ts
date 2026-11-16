import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { requireAdmin } from '../../../services/session'
import { sourceGroups } from '../../../services/question-bank'
export default defineEventHandler((event) => {
  try {
    requireAdmin(event, Date.now())
    return ok(event, sourceGroups(useDb()))
  } catch (error) { return failFrom(event, error) }
})
