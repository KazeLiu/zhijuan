import { useDb } from '../../../../utils/db'
import { failFrom, ok } from '../../../../utils/respond'
import { requireAdmin } from '../../../../services/session'
import { listBankGenerationSources } from '../../../../services/bank-supplement'

export default defineEventHandler((event) => {
  try {
    requireAdmin(event, Date.now())
    return ok(event, listBankGenerationSources(useDb()))
  } catch (error) { return failFrom(event, error) }
})
