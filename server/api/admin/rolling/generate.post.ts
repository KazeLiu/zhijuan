import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { requireAdmin } from '../../../services/session'
import { generateRollingToday, getRolling } from '../../../services/rolling'
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const db = useDb()
    generateRollingToday(db, now, true)
    return ok(event, getRolling(db, now))
  } catch (error) { return failFrom(event, error) }
})
