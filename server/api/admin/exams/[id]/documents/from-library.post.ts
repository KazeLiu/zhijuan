import { useDb } from '../../../../../utils/db'
import { failFrom, ok } from '../../../../../utils/respond'
import { readParam } from '../../../../../utils/params'
import { FieldErrors, readJsonObject } from '../../../../../utils/validate'
import { requireAdmin } from '../../../../../services/session'
import { attachLibraryFilesToExam } from '../../../../../services/library'

/** 从资料库添加资料到场次（§L4.5）：七步校验后单事务写入，成功 201 {added} */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const db = useDb()
    const body = await readJsonObject(event)
    const errors = new FieldErrors()
    const raw = body.libraryFileIds
    let libraryFileIds: string[] = []
    if (!Array.isArray(raw) || raw.length === 0) {
      errors.add('libraryFileIds', '请至少选择一个资料库文件')
    } else if (raw.some((item) => typeof item !== 'string' || item.trim() === '')) {
      errors.add('libraryFileIds', 'libraryFileIds 必须是非空字符串数组')
    } else {
      libraryFileIds = Array.from(new Set((raw as string[]).map((item) => item.trim())))
    }
    errors.throwIfAny()

    return ok(event, attachLibraryFilesToExam(db, examId, libraryFileIds, now), 201)
  } catch (error) {
    return failFrom(event, error)
  }
})
