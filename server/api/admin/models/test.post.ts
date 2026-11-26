import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { readJsonObject } from '../../../utils/validate'
import { requireAdmin } from '../../../services/session'
import { testModelConnection } from '../../../services/settings'

export default defineEventHandler(async (event) => {
  try {
    requireAdmin(event, Date.now())
    return ok(event, await testModelConnection(useDb(), await readJsonObject(event)))
  } catch (error) { return failFrom(event, error) }
})
