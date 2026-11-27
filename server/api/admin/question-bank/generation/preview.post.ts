import { useDb } from '../../../../utils/db'
import { ApiFailure, failFrom, ok } from '../../../../utils/respond'
import { requireAdmin } from '../../../../services/session'
import { readJsonObject } from '../../../../utils/validate'
import { markedDocumentPreview } from '../../../../services/marked-document'
import { MAX_DOCUMENTS_PER_EXAM } from '../../../../../shared/constants'

export default defineEventHandler(async (event) => {
  try {
    requireAdmin(event, Date.now())
    const { libraryFileIds: ids } = await readJsonObject(event)
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_DOCUMENTS_PER_EXAM || ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
      throw new ApiFailure('VALIDATION_FAILED', '请选择 1–5 份不重复的资料')
    }
    return ok(event, markedDocumentPreview(useDb(), ids as string[]))
  } catch (error) { return failFrom(event, error) }
})
