import { useDb } from '../../utils/db'
import { ApiFailure, failFrom, ok } from '../../utils/respond'
import { requireSession } from '../../services/session'
import { startAttempt } from '../../services/attempts'
import { readOptionalJsonObject } from '../../utils/validate'

/**
 * 开始/续答（§8.3 6）：新建 201，续答或已交卷 200；先结算本人过期答卷。
 * 请求体可省略；带 `examId` 时只针对该场次作答（契约 §10.2），不可作答返回 409 EXAM_NOT_OPEN。
 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    const session = requireSession(event, now)
    const db = useDb()
    const body = await readOptionalJsonObject(event)
    const rawExamId = body.examId
    if (rawExamId !== undefined && rawExamId !== null && typeof rawExamId !== 'string') {
      throw new ApiFailure('VALIDATION_FAILED', '请求参数校验失败', { fields: { examId: '场次 ID 必须是字符串' } })
    }
    const examId = typeof rawExamId === 'string' && rawExamId.trim() !== '' ? rawExamId.trim() : null
    const { result, created } = startAttempt(db, session.name, examId, now)
    return ok(event, result, created ? 201 : 200)
  } catch (error) {
    return failFrom(event, error)
  }
})
