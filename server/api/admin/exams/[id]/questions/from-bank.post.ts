import { useDb } from '../../../../../utils/db'
import { failFrom, ok } from '../../../../../utils/respond'
import { readParam } from '../../../../../utils/params'
import { readJsonObject } from '../../../../../utils/validate'
import { requireAdmin } from '../../../../../services/session'
import { applyBankQuestions } from '../../../../../services/question-bank'
import { getExamAdminDTO } from '../../../../../services/exams'
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const db = useDb()
    const exam = applyBankQuestions(db, readParam(event, 'id'), await readJsonObject(event), now)
    return ok(event, getExamAdminDTO(db, exam.id, now))
  } catch (error) { return failFrom(event, error) }
})
