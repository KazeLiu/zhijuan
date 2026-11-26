import { useDb } from '../../../../../utils/db'
import { ApiFailure, failFrom, ok } from '../../../../../utils/respond'
import { readParam } from '../../../../../utils/params'
import { readJsonObject } from '../../../../../utils/validate'
import { requireAdmin } from '../../../../../services/session'
import { applyBlankCorrection } from '../../../../../services/blank-corrections'

export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    const session = requireAdmin(event, now)
    const body = await readJsonObject(event)
    if (typeof body.previewId !== 'string' || !body.previewId) throw new ApiFailure('VALIDATION_FAILED', '请先预览纠错影响')
    return ok(event, applyBlankCorrection(useDb(), readParam(event, 'id'), body.previewId, session.name, now))
  } catch (error) { return failFrom(event, error) }
})
