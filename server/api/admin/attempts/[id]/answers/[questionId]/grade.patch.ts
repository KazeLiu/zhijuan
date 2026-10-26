import { useDb } from '../../../../../../utils/db'
import { failFrom, ok } from '../../../../../../utils/respond'
import { readParam } from '../../../../../../utils/params'
import { readJsonObject } from '../../../../../../utils/validate'
import { requireAdmin } from '../../../../../../services/session'
import { gradeAnswerManually } from '../../../../../../services/results'

/** 人工改分（§8.7 30）：写 override、记审计、重算总分并 +version */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    const session = requireAdmin(event, now)
    const attemptId = readParam(event, 'id')
    const questionId = readParam(event, 'questionId')
    const body = await readJsonObject(event)
    const db = useDb()
    return ok(
      event,
      gradeAnswerManually(db, { attemptId, questionId, body, adminName: session.name, now }),
    )
  } catch (error) {
    return failFrom(event, error)
  }
})
