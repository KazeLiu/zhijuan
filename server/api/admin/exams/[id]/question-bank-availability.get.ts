import { useDb } from '../../../../utils/db'
import { failFrom, ok } from '../../../../utils/respond'
import { readParam } from '../../../../utils/params'
import { requireAdmin } from '../../../../services/session'
import { getBankAvailability, readBankFilters } from '../../../../services/question-bank'
export default defineEventHandler((event) => {
  try {
    requireAdmin(event, Date.now())
    return ok(event, getBankAvailability(useDb(), readParam(event, 'id'), readBankFilters(getQuery(event), true)))
  } catch (error) { return failFrom(event, error) }
})
