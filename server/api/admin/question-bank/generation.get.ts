import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { requireAdmin } from '../../../services/session'
import { latestBankGeneration } from '../../../services/bank-generation'
export default defineEventHandler((event) => {
  try {
    requireAdmin(event, Date.now())
    return ok(event, latestBankGeneration(useDb()))
  } catch (error) { return failFrom(event, error) }
})
