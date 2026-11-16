import type { DatabaseSync } from 'node:sqlite'
import { answerMapFromRows, listAnswerRows, updateAttemptTotal, upsertAnswerRow } from '../db/queries/attempts'
import { listQuestions } from '../db/queries/questions'
import { gradeAttempt } from './grading'

/** 调用方已开启事务。按当前评分标准重判已交卷答卷，保留人工复核分和原始作答。 */
export function regradeSubmittedAttempts(db: DatabaseSync, examId: string, now: number): void {
  const questions = listQuestions(db, examId)
  const attempts = db.prepare("SELECT id, total_score_units FROM attempts WHERE exam_id = ? AND status = 'submitted'")
    .all(examId) as Array<{ id: string; total_score_units: number }>
  for (const attempt of attempts) {
    const rows = listAnswerRows(db, attempt.id)
    const byId = new Map(rows.map((row) => [row.questionId, row]))
    const answers = answerMapFromRows(rows)
    const graded = gradeAttempt(questions, answers)
    let changed = false
    let total = 0
    for (const question of questions) {
      const row = byId.get(question.id)
      const autoScoreUnits = graded.perQuestion[question.id]!
      if ((row?.autoScoreUnits ?? 0) !== autoScoreUnits) {
        upsertAnswerRow(db, {
          attemptId: attempt.id,
          questionId: question.id,
          answer: answers[question.id] ?? null,
          autoScoreUnits,
          now,
        })
        changed = true
      }
      total += row?.overrideScoreUnits ?? autoScoreUnits
    }
    if (changed || total !== attempt.total_score_units) {
      updateAttemptTotal(db, { attemptId: attempt.id, totalScoreUnits: total, now })
    }
  }
}
