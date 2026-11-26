import type { DatabaseSync } from 'node:sqlite'
import { PASS_SCORE_UNITS } from '../../../shared/constants'
import type { AnswerMap } from '../../../shared/types/question'
import type { GradeChangeDTO } from '../../../shared/types/admin'
import type { AttemptRecord } from './attempts'
import { answerMapFromRows, listAnswerRows } from './attempts'

interface RawAttemptRow {
  id: string
  exam_id: string
  name: string
  name_key: string
  status: string
  started_at: number
  submitted_at: number | null
  submit_reason: string | null
  total_score_units: number | null
  version: number
  created_at: number
  updated_at: number
}

const ATTEMPT_COLUMNS = `a.id, a.exam_id, a.name, a.name_key, a.status, a.started_at, a.submitted_at,
  a.submit_reason, a.total_score_units, a.version, a.created_at, a.updated_at`

function mapAttempt(row: RawAttemptRow): AttemptRecord {
  return {
    id: row.id,
    examId: row.exam_id,
    name: row.name,
    nameKey: row.name_key,
    status: row.status === 'submitted' ? 'submitted' : 'in_progress',
    startedAt: Number(row.started_at),
    submittedAt: row.submitted_at === null ? null : Number(row.submitted_at),
    submitReason: row.submit_reason === 'manual' || row.submit_reason === 'deadline' ? row.submit_reason : null,
    totalScoreUnits: row.total_score_units === null ? null : Number(row.total_score_units),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export interface ResultFilter {
  nameKey?: string
  passed?: boolean
  manual?: boolean
  /** null = 不分页（导出） */
  limit: number | null
  offset: number
}

export interface ResultAttemptRow {
  attempt: AttemptRecord
  manualReviewed: boolean
  answers: AnswerMap
}

const MANUAL_EXISTS = `EXISTS (SELECT 1 FROM answers an WHERE an.attempt_id = a.id AND an.override_score_units IS NOT NULL)`

function buildWhere(examId: string, filter: ResultFilter): { sql: string; params: Array<string | number> } {
  const parts: string[] = ['a.exam_id = ?']
  const params: Array<string | number> = [examId]
  if (filter.nameKey !== undefined && filter.nameKey !== '') {
    parts.push('a.name LIKE ?')
    params.push(`%${filter.nameKey}%`)
  }
  if (filter.passed !== undefined) {
    parts.push(
      filter.passed
        ? `a.status = 'submitted' AND a.total_score_units >= ${PASS_SCORE_UNITS}`
        : `a.status = 'submitted' AND a.total_score_units < ${PASS_SCORE_UNITS}`,
    )
  }
  if (filter.manual === true) {
    parts.push("a.status = 'submitted'")
    parts.push(MANUAL_EXISTS)
  } else if (filter.manual === false) {
    parts.push("a.status = 'submitted'")
    parts.push(`NOT ${MANUAL_EXISTS}`)
  }
  return { sql: `WHERE ${parts.join(' AND ')}`, params }
}

/** 场次内答卷列表（筛选只作用于已交卷，§8.6 27） */
export function listResultAttempts(
  db: DatabaseSync,
  examId: string,
  filter: ResultFilter,
): { rows: ResultAttemptRow[]; total: number } {
  const where = buildWhere(examId, filter)
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total FROM attempts a ${where.sql}`)
    .get(...where.params) as { total: number } | undefined
  const limitSql = filter.limit === null ? '' : 'LIMIT ? OFFSET ?'
  const params: Array<string | number> = [...where.params]
  if (filter.limit !== null) params.push(filter.limit, filter.offset)
  const rows = db
    .prepare(
      `SELECT ${ATTEMPT_COLUMNS}, ${MANUAL_EXISTS} AS manual_reviewed
       FROM attempts a ${where.sql}
       ORDER BY a.started_at DESC, a.id DESC ${limitSql}`,
    )
    .all(...params) as unknown as Array<RawAttemptRow & { manual_reviewed: number }>
  return {
    total: Number(totalRow?.total ?? 0),
    rows: rows.map((row) => {
      const attempt = mapAttempt(row)
      return {
        attempt,
        manualReviewed: Number(row.manual_reviewed) === 1,
        answers: answerMapFromRows(listAnswerRows(db, attempt.id)),
      }
    }),
  }
}

export interface QuestionAnswerStatRow {
  questionId: string
  autoScoreUnits: number
  overrideScoreUnits: number | null
  unanswered: boolean
}

/** 逐题统计样本：仅已交卷答卷（§8.6 27） */
export function listQuestionAnswerStats(db: DatabaseSync, examId: string): QuestionAnswerStatRow[] {
  const rows = db
    .prepare(
      `SELECT an.question_id AS question_id, an.auto_score_units AS auto_score_units,
              an.override_score_units AS override_score_units, an.answer_json AS answer_json
       FROM answers an JOIN attempts a ON a.id = an.attempt_id
       WHERE a.exam_id = ? AND a.status = 'submitted'`,
    )
    .all(examId) as Array<{
    question_id: string
    auto_score_units: number
    override_score_units: number | null
    answer_json: string | null
  }>
  return rows.map((row) => ({
    questionId: row.question_id,
    autoScoreUnits: Number(row.auto_score_units),
    overrideScoreUnits: row.override_score_units === null ? null : Number(row.override_score_units),
    unanswered: row.answer_json === null,
  }))
}

/** 已交卷答卷的总分序列（汇总统计用，未交卷不计入） */
export function listSubmittedScores(
  db: DatabaseSync,
  examId: string,
): Array<{ totalScoreUnits: number; manualReviewed: boolean }> {
  const rows = db
    .prepare(
      `SELECT a.total_score_units AS total_score_units, ${MANUAL_EXISTS} AS manual_reviewed
       FROM attempts a WHERE a.exam_id = ? AND a.status = 'submitted'`,
    )
    .all(examId) as Array<{ total_score_units: number; manual_reviewed: number }>
  return rows.map((row) => ({
    totalScoreUnits: Number(row.total_score_units ?? 0),
    manualReviewed: Number(row.manual_reviewed) === 1,
  }))
}

/** 追加一条改分审计记录（§8.7 30） */
export function insertGradeChange(
  db: DatabaseSync,
  input: {
    id: string
    attemptId: string
    questionId: string
    previousScoreUnits: number
    newScoreUnits: number
    reason: string
    adminName: string
    now: number
  },
): void {
  db.prepare(
    `INSERT INTO grade_changes (id, attempt_id, question_id, previous_score_units, new_score_units, reason, admin_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.attemptId,
    input.questionId,
    input.previousScoreUnits,
    input.newScoreUnits,
    input.reason,
    input.adminName,
    input.now,
  )
}

export function listGradeChanges(db: DatabaseSync, attemptId: string): GradeChangeDTO[] {
  const rows = db
    .prepare(
      `SELECT id, question_id, previous_score_units, new_score_units, reason, admin_name, created_at
       FROM grade_changes WHERE attempt_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(attemptId) as Array<{
    id: string
    question_id: string
    previous_score_units: number
    new_score_units: number
    reason: string
    admin_name: string
    created_at: number
  }>
  return rows.map((row) => ({
    id: row.id,
    questionId: row.question_id,
    previousScoreUnits: Number(row.previous_score_units),
    newScoreUnits: Number(row.new_score_units),
    reason: row.reason,
    adminName: row.admin_name,
    createdAt: Number(row.created_at),
  }))
}
