import type { AnswerSaveResult } from '../../../../../shared/types/attempt'
import { useDb } from '../../../../utils/db'
import { failFrom, ok } from '../../../../utils/respond'
import { readParam } from '../../../../utils/params'
import { readExpectedVersion, readJsonObject } from '../../../../utils/validate'
import { requireSession } from '../../../../services/session'
import { saveAnswer } from '../../../../services/attempts'

/** 单题保存（§8.3 8）：事务内校验归属/状态/截止/版本后 UPSERT 并 version+1 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    const session = requireSession(event, now)
    const attemptId = readParam(event, 'id')
    const questionId = readParam(event, 'questionId')
    const body = await readJsonObject(event)
    const expectedVersion = readExpectedVersion(body)
    const db = useDb()
    const result: AnswerSaveResult = saveAnswer(db, {
      attemptId,
      questionId,
      nameKey: session.name,
      expectedVersion,
      rawAnswer: body.answer,
      now,
    })
    return ok(event, result)
  } catch (error) {
    return failFrom(event, error)
  }
})
