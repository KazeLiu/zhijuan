import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { requireAdmin } from '../../../services/session'
import { readJsonObject } from '../../../utils/validate'
import { previewRolling } from '../../../services/rolling'
export default defineEventHandler(async (event) => {
  try {
    requireAdmin(event, Date.now())
    return ok(event, previewRolling(useDb(), await readJsonObject(event)))
  } catch (error) { return failFrom(event, error) }
})
