import type { DatabaseSync } from 'node:sqlite'
import { answerMapFromRows, listAnswerRows, updateAttemptTotal, upsertAnswerRow } from '../db/queries/attempts'
import { listQuestions } from '../db/queries/questions'
import type { QuestionRow } from '../db/queries/questions'
import type { CandidateAnswer } from '../../shared/types/question'
import { gradeAttempt } from './grading'

export interface RegradeAttemptPlan {
  id: string
  name: string
  version: number
  before: number
  after: number
  autoBefore: number
  autoAfter: number
  manualCount: number
  needsUpdate: boolean
  answers: Record<string, CandidateAnswer | null>
  changes: Array<{ questionId: string; before: number; after: number; override: number | null; hasRow: boolean; answer: CandidateAnswer | null }>
}

/** 只计算，不写分数。纠错预览与实际重判使用同一计算结果。 */
export function buildRegradePlan(db: DatabaseSync, examId: string, questions: QuestionRow[] = listQuestions(db, examId)): RegradeAttemptPlan[] {
  const attempts = db.prepare("SELECT id, name, version, total_score_units FROM attempts WHERE exam_id = ? AND status = 'submitted' ORDER BY id")
    .all(examId) as Array<{ id: string; name: string; version: number; total_score_units: number | null }>
  return attempts.map((attempt) => {
    const rows = listAnswerRows(db, attempt.id)
    const byId = new Map(rows.map((row) => [row.questionId, row]))
    const answers = answerMapFromRows(rows)
    const graded = gradeAttempt(questions, answers)
    const plan: RegradeAttemptPlan = { id: attempt.id, name: attempt.name, version: attempt.version, before: attempt.total_score_units ?? 0,
      after: 0, autoBefore: 0, autoAfter: 0, manualCount: 0, needsUpdate: false, answers, changes: [] }
    for (const question of questions) {
      const row = byId.get(question.id)
      const autoScoreUnits = graded.perQuestion[question.id]!
      if ((row?.autoScoreUnits ?? 0) !== autoScoreUnits) {
        plan.changes.push({ questionId: question.id, before: row?.autoScoreUnits ?? 0, after: autoScoreUnits,
          override: row?.overrideScoreUnits ?? null, hasRow: row !== undefined, answer: answers[question.id] ?? null })
      }
      plan.autoBefore += row?.autoScoreUnits ?? 0
      plan.autoAfter += autoScoreUnits
      plan.after += row?.overrideScoreUnits ?? autoScoreUnits
      if (row?.overrideScoreUnits != null) plan.manualCount++
    }
    plan.needsUpdate = plan.changes.length > 0 || plan.after !== attempt.total_score_units
    return plan
  })
}

/** 调用方持有事务；只更新自动分，既有原始作答 JSON 与人工分保持不变。 */
export function applyRegradePlan(db: DatabaseSync, plans: RegradeAttemptPlan[], now: number): void {
  const update = db.prepare('UPDATE answers SET auto_score_units = ?, updated_at = ? WHERE attempt_id = ? AND question_id = ?')
  for (const plan of plans) {
    for (const change of plan.changes) {
      if (change.hasRow) update.run(change.after, now, plan.id, change.questionId)
      else upsertAnswerRow(db, { attemptId: plan.id, questionId: change.questionId, answer: change.answer, autoScoreUnits: change.after, now })
    }
    if (plan.needsUpdate) updateAttemptTotal(db, { attemptId: plan.id, totalScoreUnits: plan.after, now })
  }
}

/** 调用方已开启事务。按当前评分标准重判已交卷答卷。 */
export function regradeSubmittedAttempts(db: DatabaseSync, examId: string, now: number): void {
  applyRegradePlan(db, buildRegradePlan(db, examId), now)
}
