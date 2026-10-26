import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type {
  AnswerGradeDTO,
  AttemptAdminDTO,
  CandidateResultRowDTO,
  QuestionStatDTO,
  ResultsPageDTO,
  ResultsSummaryDTO,
  GradeResult,
} from '../../shared/types/admin'
import { DEFAULT_PAGE_SIZE, MAX_GRADE_REASON_CHARS, PASS_SCORE_UNITS } from '../../shared/constants'
import { findExam, type ExamRow } from '../db/queries/exams'
import { findQuestion, listQuestions, toQuestionAdminDTO } from '../db/queries/questions'
import {
  answerMapFromRows,
  countAttempts,
  findAttempt,
  listAnswerRows,
  setAnswerOverride,
  updateAttemptTotal,
  upsertAnswerRow,
  type AnswerRow,
} from '../db/queries/attempts'
import {
  insertGradeChange,
  listGradeChanges,
  listQuestionAnswerStats,
  listResultAttempts,
  listSubmittedScores,
  type ResultAttemptRow,
  type ResultFilter,
} from '../db/queries/results'
import { ApiFailure, throwApi } from '../utils/respond'
import { withTransaction } from '../utils/db'
import { FieldErrors, paginate, parsePageValue, queryValue, readExpectedVersion } from '../utils/validate'
import { toExamPublicDTO } from './exams'

/** 单人成绩行（进行中的答卷也算一行，§8.6 27） */
export function toCandidateResultRow(row: ResultAttemptRow, now: number): CandidateResultRowDTO {
  const { attempt } = row
  const submitted = attempt.status === 'submitted'
  const submittedAt = attempt.submittedAt
  const durationMs = submitted ? (submittedAt === null ? null : Math.max(0, submittedAt - attempt.startedAt)) : Math.max(0, now - attempt.startedAt)
  return {
    attemptId: attempt.id,
    name: attempt.name,
    status: attempt.status,
    startedAt: attempt.startedAt,
    submittedAt,
    durationMs,
    totalScoreUnits: submitted ? (attempt.totalScoreUnits ?? 0) : null,
    passed: submitted ? (attempt.totalScoreUnits ?? 0) >= PASS_SCORE_UNITS : null,
    manualReviewed: row.manualReviewed,
  }
}

/** 场次汇总：统计全量答卷，不受筛选影响（§8.6 27） */
export function buildResultsSummary(db: DatabaseSync, exam: ExamRow, now: number): ResultsSummaryDTO {
  const counts = countAttempts(db, exam.id)
  const scores = listSubmittedScores(db, exam.id).map((row) => row.totalScoreUnits)
  const submittedCount = counts.submitted
  const total = scores.reduce((sum, value) => sum + value, 0)
  const averageScoreUnits = submittedCount > 0 ? Math.round(total / submittedCount) : null
  const highestScoreUnits = submittedCount > 0 ? Math.max(...scores) : null
  const lowestScoreUnits = submittedCount > 0 ? Math.min(...scores) : null
  const passedCount = scores.filter((value) => value >= PASS_SCORE_UNITS).length
  const passRate = submittedCount > 0 ? Math.round((passedCount / submittedCount) * 10000) / 10000 : null

  const questions = listQuestions(db, exam.id)
  const maxById = new Map(questions.map((question) => [question.id, question.maxScoreUnits]))
  const buckets = new Map<string, { correct: number; partial: number; zero: number }>()
  for (const stat of listQuestionAnswerStats(db, exam.id)) {
    const maxScoreUnits = maxById.get(stat.questionId)
    if (maxScoreUnits === undefined) continue
    const bucket = buckets.get(stat.questionId) ?? { correct: 0, partial: 0, zero: 0 }
    const finalScoreUnits = stat.overrideScoreUnits ?? stat.autoScoreUnits
    if (finalScoreUnits <= 0) bucket.zero += 1
    else if (finalScoreUnits >= maxScoreUnits) bucket.correct += 1
    else bucket.partial += 1
    buckets.set(stat.questionId, bucket)
  }

  const questionStats: QuestionStatDTO[] = questions.map((question) => {
    const bucket = buckets.get(question.id) ?? { correct: 0, partial: 0, zero: 0 }
    const sampleSize = submittedCount
    const zeroCount = Math.max(bucket.zero, sampleSize - bucket.correct - bucket.partial)
    return {
      questionId: question.id,
      position: question.position,
      type: question.type,
      stem: question.stem,
      maxScoreUnits: question.maxScoreUnits,
      correctCount: bucket.correct,
      partialCount: bucket.partial,
      zeroCount,
      sampleSize,
      correctRate: sampleSize > 0 ? Math.round((bucket.correct / sampleSize) * 10000) / 10000 : null,
      partialRate: sampleSize > 0 ? Math.round((bucket.partial / sampleSize) * 10000) / 10000 : null,
      zeroRate: sampleSize > 0 ? Math.round((zeroCount / sampleSize) * 10000) / 10000 : null,
    }
  })

  return {
    totalAttempts: counts.total,
    inProgressCount: counts.inProgress,
    submittedCount,
    averageScoreUnits,
    highestScoreUnits,
    lowestScoreUnits,
    passRate,
    questionStats,
    serverNow: now,
  }
}

/** 解析筛选参数（name 规范化后包含匹配，§8.6 27） */
export function parseResultFilter(query: Record<string, unknown>): Omit<ResultFilter, 'limit' | 'offset'> {
  const errors = new FieldErrors()
  const rawName = queryValue(query.name)
  const name = typeof rawName === 'string' ? rawName.normalize('NFC').trim() : undefined
  if (name !== undefined && Array.from(name).length > 64) {
    errors.add('name', '姓名筛选不能超过 64 字')
  }
  const passed = parseFilterBool(query.passed, 'passed', errors)
  const manual = parseFilterBool(query.manual, 'manual', errors)
  errors.throwIfAny()
  return { nameKey: name === '' ? undefined : name, passed, manual }
}

function parseFilterBool(raw: unknown, field: string, errors: FieldErrors): boolean | undefined {
  const value = queryValue(raw)
  if (value === undefined || value === '') return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  errors.add(field, `${field} 只接受 true 或 false`)
  return undefined
}

export function loadResultsPage(
  db: DatabaseSync,
  examId: string,
  query: Record<string, unknown>,
  now: number,
): ResultsPageDTO {
  const exam = findExam(db, examId)
  if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
  const page = parsePageValue(query.page)
  const filter = parseResultFilter(query)
  const { rows, total } = listResultAttempts(db, exam.id, {
    ...filter,
    limit: DEFAULT_PAGE_SIZE,
    offset: (page - 1) * DEFAULT_PAGE_SIZE,
  })
  return {
    ...paginate(
      rows.map((row) => toCandidateResultRow(row, now)),
      page,
      total,
    ),
    exam: toExamPublicDTO(exam),
    summary: buildResultsSummary(db, exam, now),
  }
}

/** 导出用：同筛选、不分页（§8.6 28） */
export function loadResultsForExport(
  db: DatabaseSync,
  examId: string,
  query: Record<string, unknown>,
  now: number,
): { exam: ExamRow; rows: CandidateResultRowDTO[] } {
  const exam = findExam(db, examId)
  if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
  const filter = parseResultFilter(query)
  const { rows } = listResultAttempts(db, exam.id, { ...filter, limit: null, offset: 0 })
  return { exam, rows: rows.map((row) => toCandidateResultRow(row, now)) }
}

/* ------------------------------ 答卷详情与人工改分（§8.7 29/30） ------------------------------ */

function toAnswerGrade(question: { id: string; maxScoreUnits: number }, row: AnswerRow | undefined, userAnswer: unknown): AnswerGradeDTO {
  const autoScoreUnits = row?.autoScoreUnits ?? 0
  const overrideScoreUnits = row?.overrideScoreUnits ?? null
  return {
    questionId: question.id,
    userAnswer: userAnswer as AnswerGradeDTO['userAnswer'],
    autoScoreUnits,
    overrideScoreUnits,
    finalScoreUnits: overrideScoreUnits ?? autoScoreUnits,
    manualReviewed: overrideScoreUnits !== null,
  }
}

export function loadAttemptAdminDetail(db: DatabaseSync, attemptId: string, now: number): AttemptAdminDTO {
  const attempt = findAttempt(db, attemptId)
  if (!attempt) throw new ApiFailure('NOT_FOUND', '答卷不存在')
  if (attempt.status !== 'submitted') {
    throwApi('ATTEMPT_NOT_SUBMITTED', '答卷尚未提交，不能查看')
  }
  const exam = findExam(db, attempt.examId)
  if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
  const questions = listQuestions(db, exam.id)
  const rows = listAnswerRows(db, attempt.id)
  const byQuestion = new Map(rows.map((row) => [row.questionId, row]))
  const answers = answerMapFromRows(rows)
  const grades = questions.map((question) =>
    toAnswerGrade(question, byQuestion.get(question.id), answers[question.id] ?? null),
  )
  return {
    attemptId: attempt.id,
    examId: attempt.examId,
    name: attempt.name,
    status: attempt.status,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    submitReason: attempt.submitReason,
    totalScoreUnits: attempt.totalScoreUnits,
    version: attempt.version,
    exam: { ...toExamPublicDTO(exam), questionCount: questions.length },
    questions: questions.map(toQuestionAdminDTO),
    answers,
    grades,
    gradeChanges: listGradeChanges(db, attempt.id),
    serverNow: now,
  }
}

const SCORE_PATTERN = /^\d+(\.\d{1,2})?$/

export function gradeAnswerManually(
  db: DatabaseSync,
  input: { attemptId: string; questionId: string; body: Record<string, unknown>; adminName: string; now: number },
): GradeResult {
  const expectedVersion = readExpectedVersion(input.body)
  const errors = new FieldErrors()
  const rawScore = input.body.score
  let scoreUnits: number | null = null
  if (typeof rawScore !== 'string' || !SCORE_PATTERN.test(rawScore.trim())) {
    errors.add('score', '得分必须是最多两位小数的非负数')
  } else {
    scoreUnits = Math.round(Number.parseFloat(rawScore.trim()) * 100)
  }
  const reason = errors.text(input.body, 'reason', '改分理由', {
    required: true,
    trim: true,
    max: MAX_GRADE_REASON_CHARS,
  })
  errors.throwIfAny()

  return withTransaction(db, () => {
    const attempt = findAttempt(db, input.attemptId)
    if (!attempt) throw new ApiFailure('NOT_FOUND', '答卷不存在')
    if (attempt.status !== 'submitted') {
      throwApi('ATTEMPT_NOT_SUBMITTED', '答卷尚未提交，不能改分')
    }
    if (attempt.version !== expectedVersion) {
      throwApi('VERSION_CONFLICT', '答卷已被更新，请刷新后重试', { serverVersion: attempt.version })
    }
    const question = findQuestion(db, attempt.examId, input.questionId)
    if (!question) throw new ApiFailure('NOT_FOUND', '题目不存在')
    const targetUnits = scoreUnits ?? 0
    if (targetUnits > question.maxScoreUnits) {
      errors.add('score', `得分不能超过该题满分 ${(question.maxScoreUnits / 100).toFixed(2)} 分`)
      errors.throwIfAny()
    }

    const rows = listAnswerRows(db, attempt.id)
    const row = rows.find((item) => item.questionId === question.id)
    if (!row) {
      upsertAnswerRow(db, {
        attemptId: attempt.id,
        questionId: question.id,
        answer: null,
        autoScoreUnits: 0,
        now: input.now,
      })
    }
    const autoScoreUnits = row?.autoScoreUnits ?? 0
    const previousScoreUnits = row?.overrideScoreUnits ?? autoScoreUnits
    // 改回自动分则清空 override
    const overrideScoreUnits = targetUnits === autoScoreUnits ? null : targetUnits
    setAnswerOverride(db, {
      attemptId: attempt.id,
      questionId: question.id,
      overrideScoreUnits,
      now: input.now,
    })

    const changeId = randomUUID()
    insertGradeChange(db, {
      id: changeId,
      attemptId: attempt.id,
      questionId: question.id,
      previousScoreUnits,
      newScoreUnits: targetUnits,
      reason: reason ?? '',
      adminName: input.adminName,
      now: input.now,
    })

    const updatedRows = listAnswerRows(db, attempt.id)
    const totalScoreUnits = updatedRows.reduce(
      (sum, item) => sum + (item.overrideScoreUnits ?? item.autoScoreUnits),
      0,
    )
    updateAttemptTotal(db, { attemptId: attempt.id, totalScoreUnits, now: input.now })
    const updatedAttempt = findAttempt(db, attempt.id)
    const answers = answerMapFromRows(updatedRows)

    return {
      attempt: {
        attemptId: attempt.id,
        totalScoreUnits,
        version: updatedAttempt?.version ?? attempt.version + 1,
      },
      answer: toAnswerGrade(question, updatedRows.find((item) => item.questionId === question.id), answers[question.id] ?? null),
      change: {
        id: changeId,
        questionId: question.id,
        previousScoreUnits,
        newScoreUnits: targetUnits,
        reason: reason ?? '',
        adminName: input.adminName,
        createdAt: input.now,
      },
    }
  })
}
