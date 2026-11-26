import { useDb } from '../../../../../utils/db'
import { failFrom, ok } from '../../../../../utils/respond'
import { readParam } from '../../../../../utils/params'
import { readJsonObject } from '../../../../../utils/validate'
import { requireAdmin } from '../../../../../services/session'
import { previewBlankCorrection } from '../../../../../services/blank-corrections'

export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    const session = requireAdmin(event, now)
    return ok(event, previewBlankCorrection(useDb(), readParam(event, 'id'), await readJsonObject(event), session.name, now))
  } catch (error) { return failFrom(event, error) }
})
