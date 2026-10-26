import type { AttemptResultDTO } from '../../../../shared/types/attempt'
import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { readParam } from '../../../utils/params'
import { requireSession } from '../../../services/session'
import { loadAttemptResult } from '../../../services/attempts'

/** 成绩页（§8.3 10）：未交卷 409；未到公开时刻不下发题目与答案 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    const session = requireSession(event, now)
    const attemptId = readParam(event, 'id')
    const db = useDb()
    const result: AttemptResultDTO = loadAttemptResult(db, attemptId, session.name, now)
    return ok(event, result)
  } catch (error) {
    return failFrom(event, error)
  }
})
