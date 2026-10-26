import type { DatabaseSync } from 'node:sqlite'
import { EMPTY_BLUEPRINT } from '../../../shared/types/exam'
import type { AnswerRevealPolicy, BlueprintDTO, ExamPhase, ExamStatus } from '../../../shared/types/exam'

/** exams 表行（列名 → 驼峰映射后的领域对象） */
export interface ExamRow {
  id: string
  title: string
  instructions: string
  status: ExamStatus
  startsAt: number
  endsAt: number
  timeZone: string
  answerRevealPolicy: AnswerRevealPolicy
  blueprint: BlueprintDTO
  version: number
  publishedAt: number | null
  createdAt: number
  updatedAt: number
}

/** 场次列表行（附带三处计数） */
export interface ExamListRow {
  exam: ExamRow
  questionCount: number
  attemptCount: number
  submittedCount: number
}

interface RawExamRow {
  id: string
  title: string
  instructions: string
  status: string
  starts_at: number
  ends_at: number
  time_zone: string
  answer_reveal_policy: string
  blueprint_json: string
  version: number
  published_at: number | null
  created_at: number
  updated_at: number
  question_count?: number
  attempt_count?: number
  submitted_count?: number
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** blueprint_json → BlueprintDTO（损坏时回退空蓝图，不抛错） */
export function parseBlueprint(raw: string): BlueprintDTO {
  try {
    const value = JSON.parse(raw) as Partial<BlueprintDTO> | null
    if (!value || typeof value !== 'object') return { ...EMPTY_BLUEPRINT }
    return {
      singleChoice: toCount(value.singleChoice),
      multipleChoice: toCount(value.multipleChoice),
      trueFalse: toCount(value.trueFalse),
      fillBlank: toCount(value.fillBlank),
      difficulty: value.difficulty === 'easy' || value.difficulty === 'hard' ? value.difficulty : 'normal',
      extraPrompt: typeof value.extraPrompt === 'string' ? value.extraPrompt : '',
    }
  } catch {
    return { ...EMPTY_BLUEPRINT }
  }
}

function mapExamRow(row: RawExamRow): ExamRow {
  return {
    id: row.id,
    title: row.title,
    instructions: row.instructions,
    status: row.status === 'published' ? 'published' : 'draft',
    startsAt: Number(row.starts_at),
    endsAt: Number(row.ends_at),
    timeZone: row.time_zone,
    answerRevealPolicy: row.answer_reveal_policy === 'after_exam' ? 'after_exam' : 'immediate',
    blueprint: parseBlueprint(row.blueprint_json),
    version: Number(row.version),
    publishedAt: row.published_at === null ? null : Number(row.published_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** 场次阶段（§7.5）：upcoming/open/closed 是计算值，不入库 */
export function examPhase(exam: { status: ExamStatus; startsAt: number; endsAt: number }, now: number): ExamPhase {
  if (exam.status === 'draft') return 'draft'
  if (now < exam.startsAt) return 'upcoming'
  if (now < exam.endsAt) return 'open'
  return 'closed'
}

const EXAM_COLUMNS = `id, title, instructions, status, starts_at, ends_at, time_zone, answer_reveal_policy,
  blueprint_json, version, published_at, created_at, updated_at`

/** 按 id 读场次（不存在返回 undefined） */
export function findExam(db: DatabaseSync, id: string): ExamRow | undefined {
  const row = db.prepare(`SELECT ${EXAM_COLUMNS} FROM exams WHERE id = ?`).get(id) as RawExamRow | undefined
  return row ? mapExamRow(row) : undefined
}

export interface ExamListFilter {
  status?: ExamStatus
  keyword?: string
  limit: number
  offset: number
}

/** 管理端场次列表：updated_at DESC, id DESC（§8.5 15） */
export function listExams(db: DatabaseSync, filter: ExamListFilter): { rows: ExamListRow[]; total: number } {
  const where: string[] = []
  const params: Array<string | number> = []
  if (filter.status) {
    where.push('e.status = ?')
    params.push(filter.status)
  }
  if (filter.keyword) {
    where.push('LOWER(e.title) LIKE ?')
    params.push(`%${filter.keyword.toLowerCase()}%`)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM exams e ${whereSql}`).get(...params) as
    | { total: number }
    | undefined
  const rows = db
    .prepare(
      `SELECT ${EXAM_COLUMNS.split(',')
        .map((column) => `e.${column.trim()}`)
        .join(', ')},
        (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) AS question_count,
        (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id) AS attempt_count,
        (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.status = 'submitted') AS submitted_count
       FROM exams e ${whereSql}
       ORDER BY e.updated_at DESC, e.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit, filter.offset) as unknown as RawExamRow[]
  return {
    total: Number(totalRow?.total ?? 0),
    rows: rows.map((row) => ({
      exam: mapExamRow(row),
      questionCount: Number(row.question_count ?? 0),
      attemptCount: Number(row.attempt_count ?? 0),
      submittedCount: Number(row.submitted_count ?? 0),
    })),
  }
}

/** 已发布且当前开放中的场次（§7.5：startsAt <= now < endsAt） */
export function findOpenExam(db: DatabaseSync, now: number): ExamRow | undefined {
  const row = db
    .prepare(
      `SELECT ${EXAM_COLUMNS} FROM exams
       WHERE status = 'published' AND starts_at <= ? AND ends_at > ?
       ORDER BY starts_at ASC, id ASC LIMIT 1`,
    )
    .get(now, now) as RawExamRow | undefined
  return row ? mapExamRow(row) : undefined
}

/** 下一场未开始的已发布场次 */
export function findNextExam(db: DatabaseSync, now: number): ExamRow | undefined {
  const row = db
    .prepare(
      `SELECT ${EXAM_COLUMNS} FROM exams
       WHERE status = 'published' AND starts_at > ?
       ORDER BY starts_at ASC, id ASC LIMIT 1`,
    )
    .get(now) as RawExamRow | undefined
  return row ? mapExamRow(row) : undefined
}

/** 最近刚结束的已发布场次（endsAt <= now） */
export function findLatestClosedExam(db: DatabaseSync, now: number): ExamRow | undefined {
  const row = db
    .prepare(
      `SELECT ${EXAM_COLUMNS} FROM exams
       WHERE status = 'published' AND ends_at <= ?
       ORDER BY ends_at DESC, id DESC LIMIT 1`,
    )
    .get(now) as RawExamRow | undefined
  return row ? mapExamRow(row) : undefined
}

/** 与给定时间窗重叠的已发布场次（半开区间，§7.5） */
export function findOverlappingPublished(
  db: DatabaseSync,
  startsAt: number,
  endsAt: number,
  excludeId: string,
): ExamRow[] {
  const rows = db
    .prepare(
      `SELECT ${EXAM_COLUMNS} FROM exams
       WHERE status = 'published' AND id <> ? AND starts_at < ? AND ends_at > ?
       ORDER BY starts_at ASC, id ASC`,
    )
    .all(excludeId, endsAt, startsAt) as unknown as RawExamRow[]
  return rows.map(mapExamRow)
}

/** 已发布场次总数（概览用） */
export function countExamsByStatus(db: DatabaseSync, status: ExamStatus): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM exams WHERE status = ?').get(status) as
    | { total: number }
    | undefined
  return Number(row?.total ?? 0)
}

export function countQuestionsOfExam(db: DatabaseSync, examId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM questions WHERE exam_id = ?').get(examId) as
    | { total: number }
    | undefined
  return Number(row?.total ?? 0)
}

export function countAttemptsOfExam(db: DatabaseSync, examId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM attempts WHERE exam_id = ?').get(examId) as
    | { total: number }
    | undefined
  return Number(row?.total ?? 0)
}

export function countSubmittedAttemptsOfExam(db: DatabaseSync, examId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM attempts WHERE exam_id = ? AND status = 'submitted'")
    .get(examId) as { total: number } | undefined
  return Number(row?.total ?? 0)
}

/** 写场次（调用方负责事务与 version 递增） */
export interface ExamWrite {
  title: string
  instructions: string
  startsAt: number
  endsAt: number
  timeZone: string
  answerRevealPolicy: AnswerRevealPolicy
  blueprint: BlueprintDTO
}

export function insertExam(db: DatabaseSync, id: string, write: ExamWrite, now: number): void {
  db.prepare(
    `INSERT INTO exams (id, title, instructions, status, starts_at, ends_at, time_zone,
      answer_reveal_policy, blueprint_json, version, published_at, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
  ).run(
    id,
    write.title,
    write.instructions,
    write.startsAt,
    write.endsAt,
    write.timeZone,
    write.answerRevealPolicy,
    JSON.stringify(write.blueprint),
    now,
    now,
  )
}

/** 更新草稿内容并 version += 1 */
export function updateExamDraft(db: DatabaseSync, id: string, write: ExamWrite, now: number): void {
  db.prepare(
    `UPDATE exams SET title = ?, instructions = ?, starts_at = ?, ends_at = ?, time_zone = ?,
      answer_reveal_policy = ?, blueprint_json = ?, version = version + 1, updated_at = ?
     WHERE id = ?`,
  ).run(
    write.title,
    write.instructions,
    write.startsAt,
    write.endsAt,
    write.timeZone,
    write.answerRevealPolicy,
    JSON.stringify(write.blueprint),
    now,
    id,
  )
}

/** 发布：status/published_at/version 一次性写入 */
export function publishExamRow(db: DatabaseSync, id: string, now: number): void {
  db.prepare(
    "UPDATE exams SET status = 'published', published_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = 'draft'",
  ).run(now, now, id)
}

/** 撤回：回到草稿 */
export function unpublishExamRow(db: DatabaseSync, id: string, now: number): void {
  db.prepare(
    "UPDATE exams SET status = 'draft', published_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'published'",
  ).run(now, id)
}

/** 仅递增版本（题目/资料等从属写入后同步场次版本） */
export function touchExamVersion(db: DatabaseSync, id: string, now: number): void {
  db.prepare('UPDATE exams SET version = version + 1, updated_at = ? WHERE id = ?').run(now, id)
}

export function deleteExamRow(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM exams WHERE id = ?').run(id)
}
