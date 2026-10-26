import type { SubmitResult } from '../../../../shared/types/attempt'
import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { readParam } from '../../../utils/params'
import { readExpectedVersion, readJsonObject } from '../../../utils/validate'
import { requireSession } from '../../../services/session'
import { submitAttempt } from '../../../services/attempts'

/** 交卷（§8.3 9）：重复交卷 200 duplicate，过了截止则不采纳快照 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    const session = requireSession(event, now)
    const attemptId = readParam(event, 'id')
    const body = await readJsonObject(event)
    const expectedVersion = readExpectedVersion(body)
    const db = useDb()
    const result: SubmitResult = submitAttempt(db, {
      attemptId,
      nameKey: session.name,
      expectedVersion,
      answers: body.answers,
      now,
    })
    return ok(event, result)
  } catch (error) {
    return failFrom(event, error)
  }
})
