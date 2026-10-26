import { useDb } from '../../../../utils/db'
import { ApiFailure, failFrom, ok } from '../../../../utils/respond'
import { readParam } from '../../../../utils/params'
import { readExpectedVersion, readJsonObject } from '../../../../utils/validate'
import { requireAdmin } from '../../../../services/session'
import { getExamAdminDTO } from '../../../../services/exams'
import { saveQuestions } from '../../../../services/questions'

/** 整体保存题目（§8.5 24）：服务端分配 id/position/分值，事务内替换并 +version */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const body = await readJsonObject(event)
    const expectedVersion = readExpectedVersion(body)
    const questions = body.questions
    if (!Array.isArray(questions)) {
      throw new ApiFailure('VALIDATION_FAILED', '题目列表格式不正确', { fields: { questions: '必须是数组' } })
    }
    const db = useDb()
    const exam = saveQuestions(db, examId, expectedVersion, questions, now)
    return ok(event, getExamAdminDTO(db, exam.id, now))
  } catch (error) {
    return failFrom(event, error)
  }
})
