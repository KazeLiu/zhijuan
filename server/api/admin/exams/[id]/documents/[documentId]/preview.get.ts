import { DOCUMENT_PREVIEW_CHARS } from '../../../../../../../shared/constants'
import { useDb } from '../../../../../../utils/db'
import { failFrom, ok } from '../../../../../../utils/respond'
import { readIntQuery, readParam } from '../../../../../../utils/params'
import { requireAdmin } from '../../../../../../services/session'
import { previewDocument } from '../../../../../../services/documents'

/** 资料预览（§8.5 21）：offset ≥ 0，limit 1..4000（缺省 4000） */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const documentId = readParam(event, 'documentId')
    const query = getQuery(event)
    const offset = readIntQuery(query.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = readIntQuery(query.limit, 'limit', DOCUMENT_PREVIEW_CHARS, 1, DOCUMENT_PREVIEW_CHARS)
    const db = useDb()
    return ok(event, previewDocument(db, examId, documentId, offset, limit))
  } catch (error) {
    return failFrom(event, error)
  }
})
