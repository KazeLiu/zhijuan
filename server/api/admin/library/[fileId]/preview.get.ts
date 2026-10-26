import { DOCUMENT_PREVIEW_CHARS } from '../../../../../shared/constants'
import { useDb } from '../../../../utils/db'
import { failFrom, ok } from '../../../../utils/respond'
import { readIntQuery, readParam } from '../../../../utils/params'
import { requireAdmin } from '../../../../services/session'
import { previewLibraryFile } from '../../../../services/library'

/** 资料库预览（§L4.3）：DocumentPreviewDTO，documentId 填库文件 id */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const fileId = readParam(event, 'fileId')
    const query = getQuery(event)
    const offset = readIntQuery(query.offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = readIntQuery(query.limit, 'limit', DOCUMENT_PREVIEW_CHARS, 1, DOCUMENT_PREVIEW_CHARS)
    const db = useDb()
    return ok(event, previewLibraryFile(db, fileId, offset, limit))
  } catch (error) {
    return failFrom(event, error)
  }
})
