import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { readJsonObject } from '../../../utils/validate'
import { requireAdmin } from '../../../services/session'
import { deleteBankItems } from '../../../services/question-bank'
export default defineEventHandler(async (event) => {
  try {
    requireAdmin(event, Date.now())
    return ok(event, { deletedCount: deleteBankItems(useDb(), await readJsonObject(event)) })
  } catch (error) { return failFrom(event, error) }
})
