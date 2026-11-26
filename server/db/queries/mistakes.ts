import type { DatabaseSync } from 'node:sqlite'
import type { AnswerDefinition, CandidateAnswer, QuestionOption, QuestionType } from '../../../shared/types/question'
import type { MyMistakeQuestionDTO } from '../../../shared/types/attempt'
import { isEmptyAnswer } from '../../services/grading'
import { escapeLike } from '../../utils/validate'

/**
 * 个人错题集（契约 §8.3 5）：本人已交卷、答案已公开、最终得分未满分的题目。
 * 一次 JOIN 批量取题，不按答卷逐份读整卷；姓名与公开条件都在 SQL 里成立，
 * 因此隐藏场次的错题既不会出列表，也不会进 COUNT。
 */
export interface MyMistakeFilter {
  /** 会话姓名（已规范化，与 attempts.name_key 同值） */
  nameKey: string
  /** 服务端当前时刻，参与 after_exam 的延迟公开判定 */
  now: number
  query?: string
  type?: QuestionType
  limit: number
  offset: number
}

interface RawMistakeRow {
  question_id: string
  position: number
  type: QuestionType
  stem: string
  options_json: string
  answer_definition_json: string
  explanation: string
  max_score_units: number
  attempt_id: string
  exam_id: string
  exam_title: string
  exam_time_zone: string
  submitted_at: number
  answer_json: string | null
  auto_score_units: number | null
  override_score_units: number | null
}

const FROM = `FROM attempts a
  JOIN exams e ON e.id = a.exam_id
  JOIN questions q ON q.exam_id = a.exam_id
  LEFT JOIN answers ans ON ans.attempt_id = a.id AND ans.question_id = q.id`

/** 本人 + 已交卷 + 未满分 + 已公开（immediate，或 after_exam 的 min(ends_at, ended_at) 已到） */
function buildWhere(filter: MyMistakeFilter): { sql: string; params: Array<string | number> } {
  const parts = [
    'a.name_key = ?',
    "a.status = 'submitted'",
    'COALESCE(ans.override_score_units, ans.auto_score_units, 0) < q.max_score_units',
    "(e.answer_reveal_policy = 'immediate' OR ? >= MIN(e.ends_at, COALESCE(e.ended_at, e.ends_at)))",
  ]
  const params: Array<string | number> = [filter.nameKey, filter.now]
  if (filter.query) {
    parts.push("q.stem LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(filter.query)}%`)
  }
  if (filter.type) {
    parts.push('q.type = ?')
    params.push(filter.type)
  }
  return { sql: `WHERE ${parts.join(' AND ')}`, params }
}

/** 与答卷结果接口保持一致：历史损坏的作答 JSON 按未作答展示。 */
function readStoredAnswer(raw: string | null): CandidateAnswer | null {
  if (raw === null) return null
  try {
    return JSON.parse(raw) as CandidateAnswer
  } catch {
    return null
  }
}

function mapRow(row: RawMistakeRow): MyMistakeQuestionDTO {
  const definition = JSON.parse(row.answer_definition_json) as AnswerDefinition
  for (const blank of definition.blanks) blank.caseSensitive = false
  const userAnswer = readStoredAnswer(row.answer_json)
  const autoScoreUnits = Number(row.auto_score_units ?? 0)
  const overrideScoreUnits = row.override_score_units === null ? null : Number(row.override_score_units)
  return {
    attemptId: row.attempt_id,
    examId: row.exam_id,
    examTitle: row.exam_title,
    examTimeZone: row.exam_time_zone,
    submittedAt: Number(row.submitted_at),
    id: row.question_id,
    position: Number(row.position),
    type: row.type,
    stem: row.stem,
    options: JSON.parse(row.options_json) as QuestionOption[],
    userAnswer,
    unanswered: userAnswer === null || isEmptyAnswer(userAnswer),
    maxScoreUnits: Number(row.max_score_units),
    earnedScoreUnits: overrideScoreUnits ?? autoScoreUnits,
    autoScoreUnits,
    overrideScoreUnits,
    manualReviewed: overrideScoreUnits !== null,
    correctAnswer: { optionIds: definition.correctOptionIds, blanks: definition.blanks },
    explanation: row.explanation,
  }
}

/** 交卷时间倒序，再按答卷、题号、题 ID 固定顺序，翻页不跳题 */
export function listMyMistakes(
  db: DatabaseSync,
  filter: MyMistakeFilter,
): { rows: MyMistakeQuestionDTO[]; total: number } {
  const where = buildWhere(filter)
  const totalRow = db.prepare(`SELECT COUNT(*) AS total ${FROM} ${where.sql}`).get(...where.params) as
    | { total: number }
    | undefined
  const rows = db
    .prepare(
      `SELECT q.id AS question_id, q.position, q.type, q.stem, q.options_json, q.answer_definition_json,
              q.explanation, q.max_score_units,
              a.id AS attempt_id, a.exam_id, COALESCE(a.submitted_at, a.started_at) AS submitted_at,
              e.title AS exam_title, e.time_zone AS exam_time_zone,
              ans.answer_json, ans.auto_score_units, ans.override_score_units
       ${FROM} ${where.sql}
       ORDER BY COALESCE(a.submitted_at, a.started_at) DESC, a.id DESC, q.position ASC, q.id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...where.params, filter.limit, filter.offset) as unknown as RawMistakeRow[]
  return { total: Number(totalRow?.total ?? 0), rows: rows.map(mapRow) }
}
