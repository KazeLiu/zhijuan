import { useDb } from '../../../../../utils/db'
import { failFrom, ok } from '../../../../../utils/respond'
import { readParam } from '../../../../../utils/params'
import { requireAdmin } from '../../../../../services/session'
import { deleteDocument } from '../../../../../services/documents'

/** 删除资料（§8.5 22）：被题目引用 409，已发布 409；成功删文件与库行 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const documentId = readParam(event, 'documentId')
    const db = useDb()
    await deleteDocument(db, examId, documentId)
    return ok(event, { ok: true })
  } catch (error) {
    return failFrom(event, error)
  }
})
