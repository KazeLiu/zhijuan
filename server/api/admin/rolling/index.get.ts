import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { requireAdmin } from '../../../services/session'
import { getRolling } from '../../../services/rolling'
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    return ok(event, getRolling(useDb(), now))
  } catch (error) { return failFrom(event, error) }
})
