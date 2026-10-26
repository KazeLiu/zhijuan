import type { DatabaseSync } from 'node:sqlite'
import type { AnswerMap, CandidateAnswer } from '../../../shared/types/question'
import type { AttemptStatus, MyAttemptRowDTO, SubmitReason } from '../../../shared/types/attempt'

/** attempts 表行 */
export interface AttemptRecord {
  id: string
  examId: string
  name: string
  nameKey: string
  status: AttemptStatus
  startedAt: number
  submittedAt: number | null
  submitReason: SubmitReason | null
  totalScoreUnits: number | null
  version: number
  createdAt: number
  updatedAt: number
}

/** answers 表行（answer_json 保持原始文本，按需解析） */
export interface AnswerRow {
  attemptId: string
  questionId: string
  answerJson: string | null
  autoScoreUnits: number
  overrideScoreUnits: number | null
  updatedAt: number
}

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

const ATTEMPT_COLUMNS = `id, exam_id, name, name_key, status, started_at, submitted_at,
  submit_reason, total_score_units, version, created_at, updated_at`

function mapAttemptRow(row: RawAttemptRow): AttemptRecord {
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

export function findAttempt(db: DatabaseSync, attemptId: string): AttemptRecord | undefined {
  const row = db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE id = ?`).get(attemptId) as
    | RawAttemptRow
    | undefined
  return row ? mapAttemptRow(row) : undefined
}

/** 同一场内同一规范化姓名只允许一份答卷 */
export function findAttemptByName(db: DatabaseSync, examId: string, nameKey: string): AttemptRecord | undefined {
  const row = db
    .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE exam_id = ? AND name_key = ?`)
    .get(examId, nameKey) as RawAttemptRow | undefined
  return row ? mapAttemptRow(row) : undefined
}

export function findAttemptByIdAndName(
  db: DatabaseSync,
  attemptId: string,
  nameKey: string,
): AttemptRecord | undefined {
  const row = db
    .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE id = ? AND name_key = ?`)
    .get(attemptId, nameKey) as RawAttemptRow | undefined
  return row ? mapAttemptRow(row) : undefined
}

export function insertAttempt(
  db: DatabaseSync,
  input: { id: string; examId: string; name: string; nameKey: string; startedAt: number },
): void {
  db.prepare(
    `INSERT INTO attempts (id, exam_id, name, name_key, status, started_at, submitted_at,
      submit_reason, total_score_units, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'in_progress', ?, NULL, NULL, NULL, 1, ?, ?)`,
  ).run(input.id, input.examId, input.name, input.nameKey, input.startedAt, input.startedAt, input.startedAt)
}

const ANSWER_COLUMNS = 'attempt_id, question_id, answer_json, auto_score_units, override_score_units, updated_at'

export function listAnswerRows(db: DatabaseSync, attemptId: string): AnswerRow[] {
  const rows = db
    .prepare(`SELECT ${ANSWER_COLUMNS} FROM answers WHERE attempt_id = ?`)
    .all(attemptId) as Array<{
    attempt_id: string
    question_id: string
    answer_json: string | null
    auto_score_units: number
    override_score_units: number | null
    updated_at: number
  }>
  return rows.map((row) => ({
    attemptId: row.attempt_id,
    questionId: row.question_id,
    answerJson: row.answer_json,
    autoScoreUnits: Number(row.auto_score_units),
    overrideScoreUnits: row.override_score_units === null ? null : Number(row.override_score_units),
    updatedAt: Number(row.updated_at),
  }))
}

/** 答案行 → AnswerMap（损坏的 JSON 视为未作答，不让一条脏数据拖垮整卷） */
export function answerMapFromRows(rows: AnswerRow[]): AnswerMap {
  const map: AnswerMap = {}
  for (const row of rows) {
    if (row.answerJson === null) {
      map[row.questionId] = null
      continue
    }
    try {
      map[row.questionId] = JSON.parse(row.answerJson) as CandidateAnswer
    } catch {
      map[row.questionId] = null
    }
  }
  return map
}

/** 单题 UPSERT：answer 为 null 时写 NULL（未作答） */
export function upsertAnswerRow(
  db: DatabaseSync,
  input: {
    attemptId: string
    questionId: string
    answer: CandidateAnswer | null
    autoScoreUnits: number
    now: number
  },
): void {
  db.prepare(
    `INSERT INTO answers (attempt_id, question_id, answer_json, auto_score_units, override_score_units, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT (attempt_id, question_id) DO UPDATE SET
       answer_json = excluded.answer_json,
       auto_score_units = excluded.auto_score_units,
       updated_at = excluded.updated_at`,
  ).run(
    input.attemptId,
    input.questionId,
    input.answer === null ? null : JSON.stringify(input.answer),
    input.autoScoreUnits,
    input.now,
  )
}

export function deleteAnswersNotIn(db: DatabaseSync, attemptId: string, keepQuestionIds: string[]): void {
  if (keepQuestionIds.length === 0) {
    db.prepare('DELETE FROM answers WHERE attempt_id = ?').run(attemptId)
    return
  }
  const placeholders = keepQuestionIds.map(() => '?').join(', ')
  db.prepare(`DELETE FROM answers WHERE attempt_id = ? AND question_id NOT IN (${placeholders})`).run(
    attemptId,
    ...keepQuestionIds,
  )
}

/** 交卷落库：状态、时间、原因、总分、版本一次写入 */
export function markAttemptSubmitted(
  db: DatabaseSync,
  input: {
    attemptId: string
    submittedAt: number
    submitReason: SubmitReason
    totalScoreUnits: number
    now: number
  },
): void {
  db.prepare(
    `UPDATE attempts SET status = 'submitted', submitted_at = ?, submit_reason = ?, total_score_units = ?,
      version = version + 1, updated_at = ?
     WHERE id = ? AND status = 'in_progress'`,
  ).run(input.submittedAt, input.submitReason, input.totalScoreUnits, input.now, input.attemptId)
}

/** 人工改分：写 override（null 表示回到自动分，§8.7 30） */
export function setAnswerOverride(
  db: DatabaseSync,
  input: { attemptId: string; questionId: string; overrideScoreUnits: number | null; now: number },
): void {
  db.prepare(
    'UPDATE answers SET override_score_units = ?, updated_at = ? WHERE attempt_id = ? AND question_id = ?',
  ).run(input.overrideScoreUnits, input.now, input.attemptId, input.questionId)
}

export function touchAttempt(db: DatabaseSync, attemptId: string, now: number): void {
  db.prepare('UPDATE attempts SET version = version + 1, updated_at = ? WHERE id = ?').run(now, attemptId)
}

export function updateAttemptTotal(
  db: DatabaseSync,
  input: { attemptId: string; totalScoreUnits: number; now: number },
): void {
  db.prepare(
    'UPDATE attempts SET total_score_units = ?, version = version + 1, updated_at = ? WHERE id = ?',
  ).run(input.totalScoreUnits, input.now, input.attemptId)
}

/** 截止结算扫描：所有已过期且仍在作答的答卷（§11.3） */
export function findExpiredInProgressAttempts(db: DatabaseSync, now: number): Array<{ id: string; endsAt: number }> {
  const rows = db
    .prepare(
      `SELECT a.id AS id, e.ends_at AS ends_at
       FROM attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.status = 'in_progress' AND e.ends_at <= ?
       ORDER BY e.ends_at ASC, a.id ASC`,
    )
    .all(now) as Array<{ id: string; ends_at: number }>
  return rows.map((row) => ({ id: row.id, endsAt: Number(row.ends_at) }))
}

export function countAttempts(db: DatabaseSync, examId: string): { total: number; inProgress: number; submitted: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
              SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS submitted
       FROM attempts WHERE exam_id = ?`,
    )
    .get(examId) as { total: number; in_progress: number | null; submitted: number | null } | undefined
  return {
    total: Number(row?.total ?? 0),
    inProgress: Number(row?.in_progress ?? 0),
    submitted: Number(row?.submitted ?? 0),
  }
}

export interface AttemptHistoryRow {
  attempt: AttemptRecord
  examTitle: string
  examTimeZone: string
  examStartsAt: number
  examEndsAt: number
}

/** 「我的记录」：仅本人，started_at DESC, id DESC（§8.3 5） */
export function listAttemptHistory(
  db: DatabaseSync,
  nameKey: string,
  limit: number,
  offset: number,
): { rows: AttemptHistoryRow[]; total: number } {
  const totalRow = db.prepare('SELECT COUNT(*) AS total FROM attempts WHERE name_key = ?').get(nameKey) as
    | { total: number }
    | undefined
  const rows = db
    .prepare(
      `SELECT a.id, a.exam_id, a.name, a.name_key, a.status, a.started_at, a.submitted_at, a.submit_reason,
              a.total_score_units, a.version, a.created_at, a.updated_at,
              e.title AS exam_title, e.time_zone AS exam_time_zone, e.starts_at AS exam_starts_at, e.ends_at AS exam_ends_at
       FROM attempts a JOIN exams e ON e.id = a.exam_id
       WHERE a.name_key = ?
       ORDER BY a.started_at DESC, a.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(nameKey, limit, offset) as unknown as Array<RawAttemptRow & {
    exam_title: string
    exam_time_zone: string
    exam_starts_at: number
    exam_ends_at: number
  }>
  return {
    total: Number(totalRow?.total ?? 0),
    rows: rows.map((row) => ({
      attempt: mapAttemptRow(row),
      examTitle: row.exam_title,
      examTimeZone: row.exam_time_zone,
      examStartsAt: Number(row.exam_starts_at),
      examEndsAt: Number(row.exam_ends_at),
    })),
  }
}

export function toMyAttemptRowDTO(row: AttemptHistoryRow): MyAttemptRowDTO {
  return {
    attemptId: row.attempt.id,
    examId: row.attempt.examId,
    examTitle: row.examTitle,
    examTimeZone: row.examTimeZone,
    examStartsAt: row.examStartsAt,
    examEndsAt: row.examEndsAt,
    status: row.attempt.status,
    startedAt: row.attempt.startedAt,
    submittedAt: row.attempt.submittedAt,
    totalScoreUnits: row.attempt.totalScoreUnits,
  }
}
