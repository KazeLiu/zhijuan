import { useDb } from '../../../utils/db'
import { ApiFailure, failFrom, ok } from '../../../utils/respond'
import { requireAdmin } from '../../../services/session'
import { countLibraryFiles } from '../../../db/queries/library'
import { assertLibraryQuota, uploadLibraryFile } from '../../../services/library'

/** 上传资料库文件（§L4.2）：multipart 字段名固定 file，成功 201 LibraryFileDTO */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const db = useDb()
    assertLibraryQuota(countLibraryFiles(db))

    const parts = await readMultipartFormData(event)
    const filePart = (parts ?? []).find((part) => part.name === 'file' && typeof part.filename === 'string')
    if (!filePart || !filePart.filename) {
      throw new ApiFailure('BAD_REQUEST', '请选择要上传的文件')
    }

    const file = await uploadLibraryFile(
      db,
      { filename: filePart.filename, type: filePart.type, data: filePart.data },
      now,
    )
    return ok(event, file, 201)
  } catch (error) {
    return failFrom(event, error)
  }
})
