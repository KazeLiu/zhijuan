import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { requireAdmin } from '../../../services/session'
import { readParam } from '../../../utils/params'
import { readJsonObject } from '../../../utils/validate'
import { saveBankItem } from '../../../services/question-bank'
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    return ok(event, saveBankItem(useDb(), readParam(event, 'itemId'), await readJsonObject(event), now))
  } catch (error) { return failFrom(event, error) }
})
