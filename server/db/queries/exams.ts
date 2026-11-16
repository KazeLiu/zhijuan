import type { DatabaseSync } from 'node:sqlite'
import { EMPTY_BLUEPRINT } from '../../../shared/types/exam'
import type { AnswerRevealPolicy, BlueprintDTO, ExamPhase, ExamStatus } from '../../../shared/types/exam'
import { computeExamPhase } from '../../../shared/utils/exam'

/** exams 表行（列名 → 驼峰映射后的领域对象） */
export interface ExamRow {
  id: string
  title: string
  instructions: string
  status: ExamStatus
  startsAt: number
  endsAt: number
  /** 暂停时刻；非空 = 已暂停（契约 §1） */
  pausedAt: number | null
  /** 管理员提前结束时刻；非空 = 已结束（契约 §1） */
  endedAt: number | null
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
  paused_at: number | null
  ended_at: number | null
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
    pausedAt: row.paused_at === null || row.paused_at === undefined ? null : Number(row.paused_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    timeZone: row.time_zone,
    answerRevealPolicy: row.answer_reveal_policy === 'after_exam' ? 'after_exam' : 'immediate',
    blueprint: parseBlueprint(row.blueprint_json),
    version: Number(row.version),
    publishedAt: row.published_at === null ? null : Number(row.published_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/**
 * 场次阶段（§7.5）：upcoming/open/paused/closed 是计算值，不入库。
 * 统一委托 shared/utils/exam.ts 的 computeExamPhase，保证「已结束优先于已暂停」只有一处实现。
 */
export function examPhase(
  exam: {
    status: ExamStatus
    startsAt: number
    endsAt: number
    pausedAt: number | null
    endedAt: number | null
  },
  now: number,
): ExamPhase {
  return computeExamPhase(exam.status, exam.startsAt, exam.endsAt, now, exam.pausedAt, exam.endedAt)
}

const EXAM_COLUMNS = `id, title, instructions, status, starts_at, ends_at, paused_at, ended_at, time_zone,
  answer_reveal_policy, blueprint_json, version, published_at, created_at, updated_at`

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

/** 已发布且当前开放中的场次（§7.5：startsAt <= now < endsAt；暂停/已结束不算开放） */
export function findOpenExam(db: DatabaseSync, now: number): ExamRow | undefined {
  const row = db
    .prepare(
      `SELECT ${EXAM_COLUMNS} FROM exams
       WHERE status = 'published' AND paused_at IS NULL AND ended_at IS NULL
         AND starts_at <= ? AND ends_at > ?
       ORDER BY starts_at ASC, id ASC LIMIT 1`,
    )
    .get(now, now) as RawExamRow | undefined
  return row ? mapExamRow(row) : undefined
}

/** 下一场未开始的已发布场次（暂停/提前结束的不作为推荐） */
export function findNextExam(db: DatabaseSync, now: number): ExamRow | undefined {
  const row = db
    .prepare(
      `SELECT ${EXAM_COLUMNS} FROM exams
       WHERE status = 'published' AND paused_at IS NULL AND ended_at IS NULL AND starts_at > ?
       ORDER BY starts_at ASC, id ASC LIMIT 1`,
    )
    .get(now) as RawExamRow | undefined
  return row ? mapExamRow(row) : undefined
}

/** 最近刚结束的已发布场次（按实际结束时刻，含管理员提前结束） */
export function findLatestClosedExam(db: DatabaseSync, now: number): ExamRow | undefined {
  const row = db
    .prepare(
      `SELECT ${EXAM_COLUMNS} FROM exams
       WHERE status = 'published' AND (ended_at IS NOT NULL OR ends_at <= ?)
       ORDER BY CASE WHEN ended_at IS NOT NULL AND ended_at < ends_at THEN ended_at ELSE ends_at END DESC,
         id DESC
       LIMIT 1`,
    )
    .get(now) as RawExamRow | undefined
  return row ? mapExamRow(row) : undefined
}

/** 考生可选场次行（契约 §10.2） */
export interface AvailableExamRow {
  exam: ExamRow
  questionCount: number
  attempt: { id: string; status: 'in_progress' | 'submitted'; submittedAt: number | null } | null
}

/**
 * 考生可选场次：已发布、未暂停、未提前结束、未截止；open 在前、upcoming 在后，各按 starts_at 升序。
 * 同一时段允许多场（契约 §10.1 取消时间重叠校验），靠考生自选区分。
 */
export function listAvailableExams(db: DatabaseSync, now: number, nameKey: string): AvailableExamRow[] {
  const columns = EXAM_COLUMNS.split(',')
    .map((column) => `e.${column.trim()}`)
    .join(', ')
  const rows = db
    .prepare(
      `SELECT ${columns},
        (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) AS question_count,
        a.id AS attempt_id, a.status AS attempt_status, a.submitted_at AS attempt_submitted_at
       FROM exams e
       LEFT JOIN attempts a ON a.exam_id = e.id AND a.name_key = ?
       WHERE e.status = 'published' AND e.paused_at IS NULL AND e.ended_at IS NULL AND e.ends_at > ?
       ORDER BY CASE WHEN e.starts_at <= ? THEN 0 ELSE 1 END, e.starts_at ASC, e.id ASC`,
    )
    .all(nameKey, now, now) as unknown as (RawExamRow & {
      attempt_id?: string | null
      attempt_status?: string | null
      attempt_submitted_at?: number | null
    })[]
  return rows.map((row) => {
    const attemptId = row.attempt_id ?? null
    const submittedAt = row.attempt_submitted_at ?? null
    return {
      exam: mapExamRow(row),
      questionCount: Number(row.question_count ?? 0),
      attempt: attemptId
        ? {
            id: attemptId,
            status: row.attempt_status === 'submitted' ? 'submitted' : 'in_progress',
            submittedAt: submittedAt === null ? null : Number(submittedAt),
          }
        : null,
    }
  })
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

/** 撤回：回到草稿；生命周期标记一并清空，否则重新发布后会直接变成「暂停中/已结束」 */
export function unpublishExamRow(db: DatabaseSync, id: string, now: number): void {
  db.prepare(
    "UPDATE exams SET status = 'draft', published_at = NULL, paused_at = NULL, ended_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'published'",
  ).run(now, id)
}

/** 仅递增版本（题目/资料等从属写入后同步场次版本） */
export function touchExamVersion(db: DatabaseSync, id: string, now: number): void {
  db.prepare('UPDATE exams SET version = version + 1, updated_at = ? WHERE id = ?').run(now, id)
}

/**
 * 生命周期动作（契约 §3.1）：状态前置条件与版本校验都在 SQL 的 WHERE 里，
 * 返回受影响行数，0 表示前置条件不满足或版本已过期（调用方区分后抛错）。
 */
function runLifecycleUpdate(
  db: DatabaseSync,
  sql: string,
  params: Array<string | number | null>,
): number {
  const result = db.prepare(sql).run(...params)
  return Number(result.changes)
}

/** 暂停：published 且未结束、未暂停 */
export function pauseExamRow(db: DatabaseSync, id: string, expectedVersion: number, now: number): number {
  return runLifecycleUpdate(
    db,
    `UPDATE exams SET paused_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND status = 'published' AND paused_at IS NULL AND ended_at IS NULL`,
    [now, now, id, expectedVersion],
  )
}

/** 继续：published 且已暂停、未结束 */
export function resumeExamRow(db: DatabaseSync, id: string, expectedVersion: number, now: number): number {
  return runLifecycleUpdate(
    db,
    `UPDATE exams SET paused_at = NULL, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND status = 'published' AND paused_at IS NOT NULL AND ended_at IS NULL`,
    [now, id, expectedVersion],
  )
}

/** 提前结束：published 且未结束（任意阶段，含暂停中）；保留 paused_at 作为历史 */
export function endExamRow(db: DatabaseSync, id: string, expectedVersion: number, now: number): number {
  return runLifecycleUpdate(
    db,
    `UPDATE exams SET ended_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND status = 'published' AND ended_at IS NULL`,
    [now, now, id, expectedVersion],
  )
}

export function deleteExamRow(db: DatabaseSync, id: string): void {
  db.prepare('DELETE FROM exams WHERE id = ?').run(id)
}
