import { useDb } from '../../../../../utils/db'
import { failFrom, ok } from '../../../../../utils/respond'
import { readParam } from '../../../../../utils/params'
import { requireAdmin } from '../../../../../services/session'
import { getBlankCorrections } from '../../../../../services/blank-corrections'

export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    return ok(event, getBlankCorrections(useDb(), readParam(event, 'id'), now))
  } catch (error) { return failFrom(event, error) }
})
