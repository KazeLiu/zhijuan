import { useDb } from '../../../../../utils/db'
import { failFrom, ok } from '../../../../../utils/respond'
import { readParam } from '../../../../../utils/params'
import { readJsonObject } from '../../../../../utils/validate'
import { requireAdmin } from '../../../../../services/session'
import { importExamQuestions } from '../../../../../services/question-bank'
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    return ok(event, importExamQuestions(useDb(), readParam(event, 'id'), await readJsonObject(event), now), 201)
  } catch (error) { return failFrom(event, error) }
})
