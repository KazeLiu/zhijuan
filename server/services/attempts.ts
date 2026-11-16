import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { AnswerMap, CandidateQuestion, QuestionResultDTO } from '../../shared/types/question'
import type {
  AnswerSaveResult,
  AttemptDetailDTO,
  AttemptResultDTO,
  AttemptStartResult,
  SubmitResult,
} from '../../shared/types/attempt'
import { PASS_SCORE_UNITS, SCORE_TOTAL_UNITS } from '../../shared/constants'
import { effectiveEndsAt } from '../../shared/utils/exam'
import {
  answerMapFromRows,
  deleteAnswersNotIn,
  findAttempt,
  findAttemptByIdAndName,
  findAttemptByName,
  findExpiredInProgressAttempts,
  insertAttempt,
  listAnswerRows,
  markAttemptSubmitted,
  touchAttempt,
  upsertAnswerRow,
  type AnswerRow,
  type AttemptRecord,
} from '../db/queries/attempts'
import { findExam, findNextExam, findOpenExam, type ExamRow } from '../db/queries/exams'
import { findQuestion, listQuestions, toCandidateQuestionDTO, type QuestionRow } from '../db/queries/questions'
import { ApiFailure, throwApi } from '../utils/respond'
import { withTransaction } from '../utils/db'
import { isPlainObject, isUniqueViolation } from '../utils/validate'
import { gradeAnswer, gradeAttempt, blankScoreUnits, isEmptyAnswer, normalizeCandidateAnswer } from './grading'
import { toExamPublicDTO } from './exams'

/* ------------------------------ 截止结算（§11.3） ------------------------------ */

/**
 * 单份答卷的截止结算：把它按「最后保存的答案」判分并提交。
 * 已在事务内调用时不能再套一层事务，因此这里自己开事务、调用方在事务外调用。
 */
export function settleAttemptAtDeadline(db: DatabaseSync, attemptId: string, now: number): boolean {
  return withTransaction(db, () => {
    const attempt = findAttempt(db, attemptId)
    if (!attempt || attempt.status !== 'in_progress') return false
    const exam = findExam(db, attempt.examId)
    if (!exam || exam.endsAt > now) return false
    const questions = listQuestions(db, exam.id)
    const rows = listAnswerRows(db, attemptId)
    const answers = answerMapFromRows(rows)
    const graded = gradeAttempt(questions, answers)
    for (const question of questions) {
      upsertAnswerRow(db, {
        attemptId,
        questionId: question.id,
        answer: answers[question.id] ?? null,
        autoScoreUnits: graded.perQuestion[question.id] ?? 0,
        now,
      })
    }
    markAttemptSubmitted(db, {
      attemptId,
      submittedAt: exam.endsAt,
      submitReason: 'deadline',
      totalScoreUnits: graded.total,
      now,
    })
    return true
  })
}

/** 扫描所有过期进行中答卷并逐条结算，返回结算条数 */
export function sweepExpiredAttempts(db: DatabaseSync, now: number): number {
  const expired = findExpiredInProgressAttempts(db, now)
  let settled = 0
  for (const item of expired) {
    if (settleAttemptAtDeadline(db, item.id, now)) settled += 1
  }
  return settled
}

/* ------------------------------ 开始/续答（§8.3 6） ------------------------------ */

/** 指定场次的可作答校验（契约 §10.2）：已发布、未暂停、未提前结束、在开放窗口内 */
function findStartableExam(db: DatabaseSync, examId: string, now: number): ExamRow | undefined {
  const exam = findExam(db, examId)
  if (!exam) return undefined
  if (exam.status !== 'published') return undefined
  if (exam.pausedAt !== null || exam.endedAt !== null) return undefined
  if (now < exam.startsAt || now >= exam.endsAt) return undefined
  return exam
}

export function startAttempt(
  db: DatabaseSync,
  name: string,
  examId: string | null,
  now: number,
): { result: AttemptStartResult; created: boolean } {
  sweepExpiredAttempts(db, now)
  // 暂停和提前结束只阻止新答卷；已有答卷仍能经答题页入口续答或查看结果。
  const prior = examId ? findAttemptByName(db, examId, name) : undefined
  if (prior) {
    return {
      created: false,
      result: {
        attemptId: prior.id,
        examId: prior.examId,
        status: prior.status,
        startedAt: prior.startedAt,
        resumed: true,
      },
    }
  }
  const openExam = examId ? findStartableExam(db, examId, now) : findOpenExam(db, now)
  if (!openExam) {
    if (examId) throwApi('EXAM_NOT_OPEN', '该场次当前不可作答', { examId })
    const nextExam = findNextExam(db, now)
    throwApi('EXAM_NOT_OPEN', '当前没有开放中的考试', {
      nextExam: nextExam ? toExamPublicDTO(nextExam) : null,
    })
  }

  const existing = findAttemptByName(db, openExam.id, name)
  if (existing) {
    return {
      created: false,
      result: {
        attemptId: existing.id,
        examId: existing.examId,
        status: existing.status,
        startedAt: existing.startedAt,
        resumed: true,
      },
    }
  }

  const id = randomUUID()
  try {
    withTransaction(db, () => {
      insertAttempt(db, { id, examId: openExam.id, name, nameKey: name, startedAt: now })
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    // 并发插入：回读已有答卷按续答返回
    const raced = findAttemptByName(db, openExam.id, name)
    if (!raced) throw new ApiFailure('INTERNAL_ERROR', '答卷创建失败，请重试')
    return {
      created: false,
      result: {
        attemptId: raced.id,
        examId: raced.examId,
        status: raced.status,
        startedAt: raced.startedAt,
        resumed: true,
      },
    }
  }
  return {
    created: true,
    result: { attemptId: id, examId: openExam.id, status: 'in_progress', startedAt: now, resumed: false },
  }
}

/* ------------------------------ 答题页数据（§8.3 7） ------------------------------ */

export function loadAttemptDetail(
  db: DatabaseSync,
  attemptId: string,
  nameKey: string,
  now: number,
): AttemptDetailDTO {
  settleAttemptAtDeadline(db, attemptId, now)
  const attempt = findAttemptByIdAndName(db, attemptId, nameKey)
  if (!attempt) throw new ApiFailure('NOT_FOUND', '答卷不存在')
  const exam = findExam(db, attempt.examId)
  if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
  const questions: CandidateQuestion[] = listQuestions(db, exam.id).map(toCandidateQuestionDTO)
  return {
    attemptId: attempt.id,
    examId: attempt.examId,
    status: attempt.status,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    submitReason: attempt.submitReason,
    version: attempt.version,
    serverNow: now,
    exam: toExamPublicDTO(exam),
    questions,
    answers: answerMapFromRows(listAnswerRows(db, attempt.id)),
  }
}

/* ------------------------------ 保存单题（§8.3 8） ------------------------------ */

export function saveAnswer(
  db: DatabaseSync,
  input: {
    attemptId: string
    questionId: string
    nameKey: string
    expectedVersion: number
    rawAnswer: unknown
    now: number
  },
): AnswerSaveResult {
  settleAttemptAtDeadline(db, input.attemptId, input.now)
  return withTransaction(db, () => {
    const attempt = findAttemptByIdAndName(db, input.attemptId, input.nameKey)
    if (!attempt) throw new ApiFailure('NOT_FOUND', '答卷不存在')
    if (attempt.status !== 'in_progress') {
      if (attempt.submitReason === 'deadline') {
        throwApi('EXAM_CLOSED', '本场考试已结束，答案未保存', { submitReason: 'deadline' })
      }
      throwApi('ALREADY_SUBMITTED', '答卷已提交，不能再修改答案')
    }
    const exam = findExam(db, attempt.examId)
    if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
    if (input.now >= exam.endsAt) {
      throwApi('EXAM_CLOSED', '本场考试已结束，答案未保存', { submitReason: 'deadline' })
    }
    if (attempt.version !== input.expectedVersion) {
      throwApi('VERSION_CONFLICT', '答卷已被更新，请刷新后重试', { serverVersion: attempt.version })
    }
    const question = findQuestion(db, exam.id, input.questionId)
    if (!question) throw new ApiFailure('NOT_FOUND', '题目不存在')
    const answer = normalizeCandidateAnswer(question, input.rawAnswer)
    upsertAnswerRow(db, {
      attemptId: attempt.id,
      questionId: question.id,
      answer,
      autoScoreUnits: gradeAnswer(question, answer),
      now: input.now,
    })
    touchAttempt(db, attempt.id, input.now)
    const updated = findAttempt(db, attempt.id)
    return { version: updated?.version ?? attempt.version + 1, savedAt: input.now }
  })
}

/* ------------------------------ 交卷（§8.3 9） ------------------------------ */

function normaliseSnapshot(
  questions: QuestionRow[],
  rawAnswers: unknown,
): { answers: AnswerMap; graded: { total: number; perQuestion: Record<string, number> } } {
  if (!isPlainObject(rawAnswers)) {
    throw new ApiFailure('VALIDATION_FAILED', '请求参数校验失败', { fields: { answers: '必须是对象' } })
  }
  const byId = new Map(questions.map((question) => [question.id, question]))
  const answers: AnswerMap = {}
  for (const [questionId, rawAnswer] of Object.entries(rawAnswers)) {
    const question = byId.get(questionId)
    // 不属于本卷的题目一律忽略（跨场隔离）
    if (!question) continue
    answers[questionId] = normalizeCandidateAnswer(question, rawAnswer)
  }
  return { answers, graded: gradeAttempt(questions, answers) }
}

export function submitAttempt(
  db: DatabaseSync,
  input: {
    attemptId: string
    nameKey: string
    expectedVersion: number
    answers: unknown
    now: number
  },
): SubmitResult {
  const settledNow = settleAttemptAtDeadline(db, input.attemptId, input.now)
  const current = findAttemptByIdAndName(db, input.attemptId, input.nameKey)
  if (!current) throw new ApiFailure('NOT_FOUND', '答卷不存在')

  if (current.status === 'submitted') {
    // 重复提交不是错误：返回既有结果且不重复计分
    return {
      attemptId: current.id,
      status: 'submitted',
      submittedAt: current.submittedAt ?? current.startedAt,
      submitReason: current.submitReason ?? 'manual',
      acceptedSnapshot: false,
      totalScoreUnits: current.totalScoreUnits ?? 0,
      version: current.version,
      duplicate: !settledNow,
    }
  }

  return withTransaction(db, () => {
    const attempt = findAttemptByIdAndName(db, input.attemptId, input.nameKey)
    if (!attempt) throw new ApiFailure('NOT_FOUND', '答卷不存在')
    if (attempt.version !== input.expectedVersion) {
      throwApi('VERSION_CONFLICT', '答卷已被更新，请刷新后重试', { serverVersion: attempt.version })
    }
    const exam = findExam(db, attempt.examId)
    if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
    const questions = listQuestions(db, exam.id)

    if (input.now >= exam.endsAt) {
      // 已过截止：不采纳快照，按最后保存的答案结算
      const graded = gradeAttempt(questions, answerMapFromRows(listAnswerRows(db, attempt.id)))
      markAttemptSubmitted(db, {
        attemptId: attempt.id,
        submittedAt: exam.endsAt,
        submitReason: 'deadline',
        totalScoreUnits: graded.total,
        now: input.now,
      })
      const updated = findAttempt(db, attempt.id)
      return {
        attemptId: attempt.id,
        status: 'submitted',
        submittedAt: exam.endsAt,
        submitReason: 'deadline',
        acceptedSnapshot: false,
        totalScoreUnits: graded.total,
        version: updated?.version ?? attempt.version + 1,
        duplicate: false,
      }
    }

    const { answers, graded } = normaliseSnapshot(questions, input.answers)
    deleteAnswersNotIn(db, attempt.id, questions.map((question) => question.id))
    for (const question of questions) {
      upsertAnswerRow(db, {
        attemptId: attempt.id,
        questionId: question.id,
        answer: answers[question.id] ?? null,
        autoScoreUnits: graded.perQuestion[question.id] ?? 0,
        now: input.now,
      })
    }
    markAttemptSubmitted(db, {
      attemptId: attempt.id,
      submittedAt: input.now,
      submitReason: 'manual',
      totalScoreUnits: graded.total,
      now: input.now,
    })
    const updated = findAttempt(db, attempt.id)
    return {
      attemptId: attempt.id,
      status: 'submitted',
      submittedAt: input.now,
      submitReason: 'manual',
      acceptedSnapshot: true,
      totalScoreUnits: graded.total,
      version: updated?.version ?? attempt.version + 1,
      duplicate: false,
    }
  })
}

/* ------------------------------ 结果（§8.3 10） ------------------------------ */

function questionResults(questions: QuestionRow[], rows: AnswerRow[]): QuestionResultDTO[] {
  const byQuestion = new Map(rows.map((row) => [row.questionId, row]))
  return questions.map((question) => {
    const row = byQuestion.get(question.id)
    const autoScoreUnits = row?.autoScoreUnits ?? 0
    const overrideScoreUnits = row?.overrideScoreUnits ?? null
    const userAnswer = row ? answerMapFromRows([row])[question.id] ?? null : null
    const blanks =
      question.type === 'fill_blank'
        ? blankScoreUnits(question.maxScoreUnits, question.answerDefinition.blanks.length).map((units, index) => ({
            id: question.answerDefinition.blanks[index]?.id ?? `b${index + 1}`,
            maxScoreUnits: units,
          }))
        : []
    return {
      id: question.id,
      position: question.position,
      type: question.type,
      stem: question.stem,
      maxScoreUnits: question.maxScoreUnits,
      earnedScoreUnits: overrideScoreUnits ?? autoScoreUnits,
      autoScoreUnits,
      overrideScoreUnits,
      manualReviewed: overrideScoreUnits !== null,
      userAnswer,
      unanswered: userAnswer === null || isEmptyAnswer(userAnswer),
      options: question.options,
      blanks,
      correctAnswer: {
        optionIds: question.answerDefinition.correctOptionIds,
        blanks: question.answerDefinition.blanks,
      },
      explanation: question.explanation,
      sourceRefs: question.sourceRefs,
    }
  })
}

export function loadAttemptResult(
  db: DatabaseSync,
  attemptId: string,
  nameKey: string,
  now: number,
): AttemptResultDTO {
  settleAttemptAtDeadline(db, attemptId, now)
  const attempt = findAttemptByIdAndName(db, attemptId, nameKey)
  if (!attempt) throw new ApiFailure('NOT_FOUND', '答卷不存在')
  if (attempt.status !== 'submitted') {
    throwApi('ATTEMPT_NOT_SUBMITTED', '答卷尚未提交，不能查看结果')
  }
  const exam = findExam(db, attempt.examId)
  if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
  const questions = listQuestions(db, exam.id)
  const rows = listAnswerRows(db, attempt.id)
  const submittedAt = attempt.submittedAt ?? now
  const totalScoreUnits = attempt.totalScoreUnits ?? 0
  // 契约 §3.2：after_exam 的揭示时刻是 min(endsAt, endedAt ?? endsAt)，提前结束后即可看答案
  const revealAt = exam.answerRevealPolicy === 'immediate'
    ? submittedAt
    : effectiveEndsAt(exam.endsAt, exam.endedAt)
  const canReveal = exam.answerRevealPolicy === 'immediate' || now >= revealAt
  return {
    attemptId: attempt.id,
    examId: attempt.examId,
    status: 'submitted',
    totalScoreUnits,
    maxScoreUnits: SCORE_TOTAL_UNITS,
    passed: totalScoreUnits >= PASS_SCORE_UNITS,
    startedAt: attempt.startedAt,
    submittedAt,
    submitReason: attempt.submitReason ?? 'manual',
    durationMs: Math.max(0, submittedAt - attempt.startedAt),
    serverNow: now,
    canReveal,
    revealAt,
    revealMode: exam.answerRevealPolicy,
    answers: answerMapFromRows(rows),
    questions: canReveal ? questionResults(questions, rows) : null,
  }
}

/** 答卷是否属于该姓名（越权一律 404） */
export function requireOwnAttempt(db: DatabaseSync, attemptId: string, nameKey: string): AttemptRecord & { examId: string } {
  const attempt = findAttemptByIdAndName(db, attemptId, nameKey)
  if (!attempt) throw new ApiFailure('NOT_FOUND', '答卷不存在')
  return attempt
}

export function examOfAttempt(db: DatabaseSync, attempt: AttemptRecord): ExamRow {
  const exam = findExam(db, attempt.examId)
  if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
  return exam
}
