import type { DatabaseSync } from 'node:sqlite'
import type {
  AnswerDefinition,
  CandidateQuestion,
  QuestionAdminDTO,
  QuestionOption,
  QuestionType,
  SourceRef,
} from '../../../shared/types/question'
import { QUESTION_TYPES } from '../../../shared/types/question'
import { allocateUnits } from '../../services/grading'

/** questions 表行（JSON 列已解析） */
export interface QuestionRow {
  id: string
  examId: string
  position: number
  type: QuestionType
  stem: string
  options: QuestionOption[]
  answerDefinition: AnswerDefinition
  explanation: string
  sourceRefs: SourceRef[]
  maxScoreUnits: number
  bankOrigin: { itemId: string; version: number } | null
}

interface RawQuestionRow {
  id: string
  exam_id: string
  position: number
  type: string
  stem: string
  options_json: string
  answer_definition_json: string
  explanation: string
  source_refs_json: string
  max_score_units: number
  source_bank_item_id: string | null
  source_bank_item_version: number | null
}

function parseArray<T>(raw: string): T[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? (value as T[]) : []
  } catch {
    return []
  }
}

function parseAnswerDefinition(raw: string): AnswerDefinition {
  try {
    const value = JSON.parse(raw) as Partial<AnswerDefinition> | null
    if (!value || typeof value !== 'object') return { correctOptionIds: [], blanks: [] }
    return {
      correctOptionIds: Array.isArray(value.correctOptionIds)
        ? value.correctOptionIds.filter((item): item is string => typeof item === 'string')
        : [],
      blanks: Array.isArray(value.blanks)
        ? value.blanks
            .filter((blank) => typeof blank === 'object' && blank !== null && typeof blank.id === 'string')
            .map((blank) => ({
              id: blank.id,
              acceptedAnswers: Array.isArray(blank.acceptedAnswers)
                ? blank.acceptedAnswers.filter((item): item is string => typeof item === 'string')
                : [],
              caseSensitive: blank.caseSensitive !== false,
            }))
        : [],
    }
  } catch {
    return { correctOptionIds: [], blanks: [] }
  }
}

function mapQuestionRow(row: RawQuestionRow): QuestionRow {
  const type = (QUESTION_TYPES as readonly string[]).includes(row.type)
    ? (row.type as QuestionType)
    : 'single_choice'
  return {
    id: row.id,
    examId: row.exam_id,
    position: Number(row.position),
    type,
    stem: row.stem,
    options: parseArray<QuestionOption>(row.options_json).filter(
      (option) => typeof option?.id === 'string' && typeof option?.text === 'string',
    ),
    answerDefinition: parseAnswerDefinition(row.answer_definition_json),
    explanation: row.explanation,
    sourceRefs: parseArray<SourceRef>(row.source_refs_json).filter(
      (ref) =>
        typeof ref?.documentId === 'string' && typeof ref?.locator === 'string' && typeof ref?.quote === 'string',
    ),
    maxScoreUnits: Number(row.max_score_units),
    bankOrigin: row.source_bank_item_id === null ? null : {
      itemId: row.source_bank_item_id,
      version: row.source_bank_item_version!,
    },
  }
}

const QUESTION_COLUMNS = `id, exam_id, position, type, stem, options_json, answer_definition_json,
  explanation, source_refs_json, max_score_units, source_bank_item_id, source_bank_item_version`

/** 按 position 升序读取整卷题目 */
export function listQuestions(db: DatabaseSync, examId: string): QuestionRow[] {
  const rows = db
    .prepare(`SELECT ${QUESTION_COLUMNS} FROM questions WHERE exam_id = ? ORDER BY position ASC`)
    .all(examId) as unknown as RawQuestionRow[]
  return rows.map(mapQuestionRow)
}

export function findQuestion(db: DatabaseSync, examId: string, questionId: string): QuestionRow | undefined {
  const row = db
    .prepare(`SELECT ${QUESTION_COLUMNS} FROM questions WHERE exam_id = ? AND id = ?`)
    .get(examId, questionId) as RawQuestionRow | undefined
  return row ? mapQuestionRow(row) : undefined
}

export interface QuestionInsert {
  id: string
  examId: string
  position: number
  type: QuestionType
  stem: string
  options: QuestionOption[]
  answerDefinition: AnswerDefinition
  explanation: string
  sourceRefs: SourceRef[]
  maxScoreUnits: number
  bankOrigin?: { itemId: string; version: number } | null
}

export function insertQuestion(db: DatabaseSync, question: QuestionInsert, now: number): void {
  db.prepare(
    `INSERT INTO questions (id, exam_id, position, type, stem, options_json, answer_definition_json,
      explanation, source_refs_json, max_score_units, created_at, updated_at, source_bank_item_id, source_bank_item_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    question.id,
    question.examId,
    question.position,
    question.type,
    question.stem,
    JSON.stringify(question.options),
    JSON.stringify(question.answerDefinition),
    question.explanation,
    JSON.stringify(question.sourceRefs),
    question.maxScoreUnits,
    now,
    now,
    question.bankOrigin?.itemId ?? null,
    question.bankOrigin?.version ?? null,
  )
}

/** 整体替换时清理未出现在新列表中的旧题 */
export function deleteQuestionsNotIn(db: DatabaseSync, examId: string, keepIds: string[]): void {
  if (keepIds.length === 0) {
    db.prepare('DELETE FROM questions WHERE exam_id = ?').run(examId)
    return
  }
  const placeholders = keepIds.map(() => '?').join(', ')
  db.prepare(`DELETE FROM questions WHERE exam_id = ? AND id NOT IN (${placeholders})`).run(examId, ...keepIds)
}

/** 引用某资料的全部题目 id（删除资料前校验） */
export function findQuestionsReferencingDocument(db: DatabaseSync, examId: string, documentId: string): string[] {
  const rows = db
    .prepare("SELECT id, source_refs_json FROM questions WHERE exam_id = ? AND source_refs_json LIKE '%' || ? || '%'")
    .all(examId, documentId) as Array<{ id: string; source_refs_json: string }>
  return rows
    .filter((row) =>
      parseArray<SourceRef>(row.source_refs_json).some((ref) => ref?.documentId === documentId),
    )
    .map((row) => row.id)
}

/** 管理端题目 DTO（含标准答案与解析） */
export function toQuestionAdminDTO(row: QuestionRow): QuestionAdminDTO {
  return {
    id: row.id,
    position: row.position,
    type: row.type,
    stem: row.stem,
    options: row.options,
    answerDefinition: row.answerDefinition,
    explanation: row.explanation,
    sourceRefs: row.sourceRefs,
    maxScoreUnits: row.maxScoreUnits,
    bankOrigin: row.bankOrigin ? { ...row.bankOrigin, deleted: false } : null,
  }
}

/** 只有管理端需要核对来源是否删除，考生读取和评分不查询题库。 */
export function toQuestionAdminDTOs(db: DatabaseSync, rows: QuestionRow[]): QuestionAdminDTO[] {
  const ids = [...new Set(rows.flatMap((row) => row.bankOrigin ? [row.bankOrigin.itemId] : []))]
  const existing = new Set(ids.length ? (db.prepare(`SELECT id FROM question_bank_items WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as Array<{ id: string }>).map((row) => row.id) : [])
  return rows.map((row) => {
    const dto = toQuestionAdminDTO(row)
    if (dto.bankOrigin) dto.bankOrigin.deleted = !existing.has(dto.bankOrigin.itemId)
    return dto
  })
}

/** 考生题目 DTO：不含答案、解析、资料原文（§8.3 7） */
export function toCandidateQuestionDTO(row: QuestionRow): CandidateQuestion {
  const blanks = row.answerDefinition.blanks
  const blankUnits = blanks.length > 0 ? allocateUnits(row.maxScoreUnits, blanks.length) : []
  return {
    id: row.id,
    position: row.position,
    type: row.type,
    stem: row.stem,
    maxScoreUnits: row.maxScoreUnits,
    multiple: row.type === 'multiple_choice',
    options: row.options,
    blanks: blanks.map((blank, index) => ({ id: blank.id, maxScoreUnits: blankUnits[index] ?? 0 })),
    caseSensitive: row.type === 'fill_blank' ? (blanks[0]?.caseSensitive ?? true) : false,
  }
}

/** 用于题干归一化去重（§11.2 去重口径） */
export function normalizeStem(stem: string): string {
  return stem.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase()
}
