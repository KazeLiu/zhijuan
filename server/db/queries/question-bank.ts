import type { DatabaseSync } from 'node:sqlite'
import type { BankItemDTO, BankListQuery, BankQuestionInput, BankStatus } from '../../../shared/types/question-bank'
import type { AnswerDefinition, QuestionOption, QuestionType } from '../../../shared/types/question'
import { escapeLike } from '../../utils/validate'

export interface BankRecord extends BankQuestionInput {
  id: string
  version: number
  status: BankStatus
  contentKey: string
  originExamId: string | null
  originQuestionId: string | null
  sourceGroup: string
  createdAt: number
  updatedAt: number
  sources: BankItemDTO['sources']
}

interface RawBank {
  id: string; version: number; status: BankStatus; type: QuestionType
  knowledge_point: string; difficulty: BankQuestionInput['difficulty']; stem: string
  options_json: string; answer_definition_json: string; explanation: string; content_key: string
  origin_exam_id: string | null; origin_question_id: string | null
  source_group: string; created_at: number; updated_at: number
}

type BankFilter = Partial<BankListQuery>
function conditions(filter: BankFilter): { sql: string; params: Array<string | number> } {
  const clauses: string[] = []
  const params: Array<string | number> = []
  for (const [column, value] of [['status', filter.status], ['type', filter.type], ['difficulty', filter.difficulty]] as const) {
    if (value) { clauses.push(`b.${column} = ?`); params.push(value) }
  }
  if (filter.query) { clauses.push("b.stem LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(filter.query)}%`) }
  if (filter.knowledgePoints?.length) {
    clauses.push(`b.knowledge_point IN (${filter.knowledgePoints.map(() => '?').join(',')})`)
    params.push(...filter.knowledgePoints)
  }
  if (filter.libraryFileIds?.length) {
    clauses.push(`EXISTS (SELECT 1 FROM question_bank_sources s WHERE s.bank_item_id = b.id
      AND s.library_file_id IN (${filter.libraryFileIds.map(() => '?').join(',')}))`)
    params.push(...filter.libraryFileIds)
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

function mapRecords(db: DatabaseSync, rows: RawBank[]): BankRecord[] {
  const result = rows.map((row): BankRecord => ({
    id: row.id, version: row.version, status: row.status, type: row.type,
    knowledgePoint: row.knowledge_point, difficulty: row.difficulty, stem: row.stem,
    options: JSON.parse(row.options_json) as QuestionOption[],
    answerDefinition: JSON.parse(row.answer_definition_json) as AnswerDefinition,
    explanation: row.explanation, contentKey: row.content_key,
    originExamId: row.origin_exam_id, originQuestionId: row.origin_question_id,
    sourceGroup: row.source_group,
    createdAt: row.created_at, updatedAt: row.updated_at, sourceRefs: [], sources: [],
  }))
  const byId = new Map(result.map((item) => [item.id, item]))
  for (let offset = 0; offset < result.length; offset += 500) {
    const ids = result.slice(offset, offset + 500).map((item) => item.id)
    const refs = db.prepare(`SELECT s.*, lf.original_name FROM question_bank_sources s
      JOIN library_files lf ON lf.id = s.library_file_id
      WHERE s.bank_item_id IN (${ids.map(() => '?').join(',')}) ORDER BY s.bank_item_id, s.position`)
      .all(...ids) as Array<{ bank_item_id: string; library_file_id: string; locator: string; quote: string; original_name: string }>
    for (const ref of refs) {
      const item = byId.get(ref.bank_item_id)!
      item.sourceRefs.push({ libraryFileId: ref.library_file_id, locator: ref.locator, quote: ref.quote })
      if (!item.sources.some((source) => source.libraryFileId === ref.library_file_id)) {
        item.sources.push({ libraryFileId: ref.library_file_id, originalName: ref.original_name })
      }
    }
  }
  return result
}

export function listBankRecords(db: DatabaseSync, filter: BankFilter, range?: { limit: number; offset: number }): BankRecord[] {
  const { sql, params } = conditions(filter)
  const paging = range ? 'LIMIT ? OFFSET ?' : ''
  if (range) params.push(range.limit, range.offset)
  return mapRecords(db, db.prepare(`SELECT b.* FROM question_bank_items b ${sql}
    ORDER BY b.updated_at DESC, b.id DESC ${paging}`).all(...params) as unknown as RawBank[])
}

export function countBankRecords(db: DatabaseSync, filter: BankFilter): number {
  const { sql, params } = conditions(filter)
  return (db.prepare(`SELECT COUNT(*) AS n FROM question_bank_items b ${sql}`).get(...params) as { n: number }).n
}

export function findBankRecord(db: DatabaseSync, id: string): BankRecord | undefined {
  const row = db.prepare('SELECT * FROM question_bank_items WHERE id = ?').get(id) as RawBank | undefined
  return row ? mapRecords(db, [row])[0] : undefined
}

export function findBankRecords(db: DatabaseSync, ids: string[]): BankRecord[] {
  if (!ids.length) return []
  const rows = db.prepare(`SELECT * FROM question_bank_items WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as unknown as RawBank[]
  const byId = new Map(mapRecords(db, rows).map((row) => [row.id, row]))
  return ids.flatMap((id) => { const row = byId.get(id); return row ? [row] : [] })
}

export function findBankDuplicate(db: DatabaseSync, contentKey: string, exceptId?: string): { id: string; status: BankStatus } | undefined {
  return db.prepare('SELECT id, status FROM question_bank_items WHERE content_key = ? AND id != ?')
    .get(contentKey, exceptId ?? '') as { id: string; status: BankStatus } | undefined
}

export function writeBankSources(db: DatabaseSync, id: string, refs: BankQuestionInput['sourceRefs']): void {
  db.prepare('DELETE FROM question_bank_sources WHERE bank_item_id = ?').run(id)
  const insert = db.prepare(`INSERT INTO question_bank_sources
    (bank_item_id, position, library_file_id, locator, quote) VALUES (?, ?, ?, ?, ?)`)
  refs.forEach((ref, index) => insert.run(id, index + 1, ref.libraryFileId, ref.locator, ref.quote))
}

export function insertBankRecord(
  db: DatabaseSync, id: string, question: BankQuestionInput, contentKey: string, now: number,
  origin?: { examId: string; questionId: string },
): void {
  db.prepare(`INSERT INTO question_bank_items
    (id, status, type, knowledge_point, difficulty, stem, options_json, answer_definition_json, explanation,
      content_key, origin_exam_id, origin_question_id, created_at, updated_at, source_group)
    VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, question.type, question.knowledgePoint, question.difficulty, question.stem, JSON.stringify(question.options),
      JSON.stringify(question.answerDefinition), question.explanation, contentKey,
      origin?.examId ?? null, origin?.questionId ?? null, now, now, question.sourceGroup ?? '')
  writeBankSources(db, id, question.sourceRefs)
}

export function updateBankRecord(db: DatabaseSync, id: string, question: BankQuestionInput, key: string, now: number): void {
  db.prepare(`UPDATE question_bank_items SET type = ?, knowledge_point = ?, difficulty = ?, stem = ?,
    options_json = ?, answer_definition_json = ?, explanation = ?, content_key = ?,
    status = CASE WHEN status = 'disabled' THEN 'disabled' ELSE 'active' END,
    source_group = ?, version = version + 1, updated_at = ? WHERE id = ?`)
    .run(question.type, question.knowledgePoint, question.difficulty, question.stem, JSON.stringify(question.options),
      JSON.stringify(question.answerDefinition), question.explanation, key, question.sourceGroup ?? '', now, id)
  writeBankSources(db, id, question.sourceRefs)
}

export interface BankSampleRow {
  bank_id: string; question_id: string; type: QuestionType; stem: string; options_json: string
  answer_definition_json: string; max_score_units: number; name_key: string
  answer_json: string | null; final_score: number
}

/** 来源 OR 关系在单次 JOIN 内完成，同一试题同时命中两条来源时不会翻倍。 */
export function listBankSamples(db: DatabaseSync, ids: string[]): BankSampleRow[] {
  const rows: BankSampleRow[] = []
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500)
    rows.push(...db.prepare(`SELECT b.id AS bank_id, q.id AS question_id, q.type, q.stem, q.options_json,
      q.answer_definition_json, q.max_score_units, a.name_key, ans.answer_json,
      COALESCE(ans.override_score_units, ans.auto_score_units, 0) AS final_score
      FROM question_bank_items b JOIN questions q ON (q.source_bank_item_id = b.id
        OR (q.exam_id = b.origin_exam_id AND q.id = b.origin_question_id))
      JOIN attempts a ON a.exam_id = q.exam_id AND a.status = 'submitted'
      LEFT JOIN answers ans ON ans.attempt_id = a.id AND ans.question_id = q.id
      WHERE b.id IN (${batch.map(() => '?').join(',')})
      ORDER BY a.submitted_at ASC, a.id ASC, q.id ASC`).all(...batch) as unknown as BankSampleRow[])
  }
  return rows
}

export function bankReferencesForFile(db: DatabaseSync, fileId: string): { id: string; stem: string }[] {
  return db.prepare(`SELECT DISTINCT b.id, b.stem FROM question_bank_sources s
    JOIN question_bank_items b ON b.id = s.bank_item_id WHERE s.library_file_id = ? ORDER BY b.id`)
    .all(fileId) as Array<{ id: string; stem: string }>
}

export function bankUsageCounts(db: DatabaseSync, ids: string[]): Map<string, number> {
  if (ids.length === 0) return new Map()
  const rows = db.prepare(`SELECT library_file_id, COUNT(DISTINCT bank_item_id) AS n FROM question_bank_sources
    WHERE library_file_id IN (${ids.map(() => '?').join(',')}) GROUP BY library_file_id`).all(...ids) as Array<{ library_file_id: string; n: number }>
  return new Map(rows.map((row) => [row.library_file_id, row.n]))
}
