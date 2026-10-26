import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { requireAdmin } from '../../../services/session'
import { readParam } from '../../../utils/params'
import { getBankItem } from '../../../services/question-bank'
export default defineEventHandler((event) => {
  try {
    requireAdmin(event, Date.now())
    return ok(event, getBankItem(useDb(), readParam(event, 'itemId')))
  } catch (error) { return failFrom(event, error) }
})
