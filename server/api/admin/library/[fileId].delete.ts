import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { readParam } from '../../../utils/params'
import { requireAdmin } from '../../../services/session'
import { deleteLibraryFile } from '../../../services/library'

/** 删除资料库文件（§L4.4）：被场次引用 409 LIBRARY_FILE_IN_USE，成功 200 {ok:true} */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const fileId = readParam(event, 'fileId')
    const db = useDb()
    await deleteLibraryFile(db, fileId)
    return ok(event, { ok: true })
  } catch (error) {
    return failFrom(event, error)
  }
})
