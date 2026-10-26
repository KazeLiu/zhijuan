import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { BankAvailabilityDTO, BankFilters, BankItemDTO, BankItemSummary,
  BankListDTO, BankListQuery, BankQuestionInput, BankSourceRef } from '../../shared/types/question-bank'
import type { QuestionType } from '../../shared/types/question'
import { QUESTION_TYPES } from '../../shared/types/question'
import { DEFAULT_PAGE_SIZE, DIFFICULTIES, MAX_DOCUMENTS_PER_EXAM, MAX_KNOWLEDGE_POINT_CHARS,
  MAX_QUESTIONS, MAX_QUOTE_CHARS, MAX_TOTAL_DOCUMENT_CHARS, MIN_QUOTE_CHARS, SCORE_TOTAL_UNITS } from '../../shared/constants'
import { blueprintTotal } from '../../shared/types/exam'
import { bankContentKey, bankMistakeStats } from './question-bank-stats'
import { countBankRecords, findBankDuplicate, findBankRecord, findBankRecords,
  insertBankRecord, listBankRecords, updateBankRecord, type BankRecord } from '../db/queries/question-bank'
import { countAttemptsOfExam, findExam, touchExamVersion, updateExamDraft, type ExamRow } from '../db/queries/exams'
import { findActiveJob } from '../db/queries/jobs'
import { deleteQuestionsNotIn, insertQuestion, listQuestions, type QuestionInsert } from '../db/queries/questions'
import { findLibraryFile, findLibraryFilesByIds, listLibrarySegments } from '../db/queries/library'
import { listDocuments } from '../db/queries/documents'
import { copyLibraryFileToExam } from './library'
import { prepareQuestionContent, countByType } from './questions'
import { allocateUnits, countTextChars, findQuestionContentIssue } from './grading'
import { normalizeDocText, validateSourceRefs } from './documents'
import { ApiFailure, throwApi } from '../utils/respond'
import { withTransaction } from '../utils/db'
import { shuffle } from '../utils/shuffle'
import { FieldErrors, isPlainObject, parsePageValue, queryValue, readExpectedVersion } from '../utils/validate'

export function normalizeKnowledgePoint(raw: unknown): string {
  if (typeof raw !== 'string') throw new ApiFailure('VALIDATION_FAILED', '请填写主要知识点')
  const value = raw.normalize('NFC').trim()
  if (!value || countTextChars(value) > MAX_KNOWLEDGE_POINT_CHARS) {
    throw new ApiFailure('VALIDATION_FAILED', `知识点需为 1–${MAX_KNOWLEDGE_POINT_CHARS} 个字符`)
  }
  return value
}

function readStringList(raw: unknown, field: string, query = false): string[] {
  if (raw === undefined) return []
  const list = query && typeof raw === 'string' ? [raw] : raw
  if (!Array.isArray(list) || list.length > 100 || list.some((value) => typeof value !== 'string' || !value.trim() || countTextChars(value) > 200)) {
    throw new ApiFailure('VALIDATION_FAILED', `${field} 必须是最多 100 项的非空文本数组`)
  }
  return [...new Set((list as string[]).map((value) => value.normalize('NFC').trim()))]
}

export function readBankFilters(body: Record<string, unknown>, query = false): BankFilters {
  const errors = new FieldErrors()
  const difficulty = errors.oneOf(body, 'difficulty', '难度', DIFFICULTIES)
  const knowledgePoints = readStringList(query ? body.knowledgePoint : body.knowledgePoints, '知识点', query).map(normalizeKnowledgePoint)
  const libraryFileIds = readStringList(query ? body.libraryFileId : body.libraryFileIds, '资料', query)
  errors.throwIfAny()
  return { knowledgePoints, libraryFileIds, difficulty }
}

export function readBankListQuery(query: Record<string, unknown>): BankListQuery {
  const errors = new FieldErrors()
  const status = errors.oneOf(query, 'status', '状态', ['draft', 'active', 'disabled'] as const)
  const type = errors.oneOf(query, 'type', '题型', QUESTION_TYPES)
  const errorProne = queryValue(query.errorProneOnly)
  if (errorProne !== undefined && errorProne !== 'true' && errorProne !== 'false') errors.add('errorProneOnly', '只接受 true 或 false')
  const keyword = errors.text(query, 'query', '关键词', { max: 200, trim: true })
  const size = queryValue(query.pageSize)
  if (size !== undefined && !/^\d+$/u.test(size)) errors.add('pageSize', '每页数量必须是正整数')
  errors.throwIfAny()
  const parsed = size === undefined ? DEFAULT_PAGE_SIZE : Number(size)
  const pageSize = Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : DEFAULT_PAGE_SIZE
  return { ...readBankFilters(query, true), page: parsePageValue(query.page), pageSize,
    query: keyword, type, status, errorProneOnly: errorProne === 'true' }
}

function requireItem(db: DatabaseSync, id: string, version?: number): BankRecord {
  const item = findBankRecord(db, id)
  if (!item) throw new ApiFailure('NOT_FOUND', '题库题目不存在', { itemId: id })
  if (version !== undefined && item.version !== version) {
    throw new ApiFailure('VERSION_CONFLICT', '题库题目已变化，本地内容已保留，请查看最新版本后再操作', { itemId: id, serverVersion: item.version })
  }
  return item
}

function toSummary(item: BankRecord, stats: BankItemDTO['mistakeStats']): BankItemSummary {
  return { id: item.id, version: item.version, status: item.status, type: item.type, stem: item.stem,
    knowledgePoint: item.knowledgePoint, difficulty: item.difficulty, sources: item.sources,
    createdAt: item.createdAt, updatedAt: item.updatedAt, mistakeStats: stats }
}

function details(db: DatabaseSync, items: BankRecord[]): BankItemDTO[] {
  const stats = bankMistakeStats(db, items)
  return items.map((item) => ({ ...toSummary(item, stats.get(item.id)!), options: item.options,
    answerDefinition: item.answerDefinition, explanation: item.explanation, sourceRefs: item.sourceRefs,
    originExamId: item.originExamId, originQuestionId: item.originQuestionId,
    reviewedBy: item.reviewedBy, reviewedAt: item.reviewedAt }))
}

export function getBankItem(db: DatabaseSync, id: string): BankItemDTO {
  return details(db, [requireItem(db, id)])[0]!
}

export function listBankItems(db: DatabaseSync, query: BankListQuery): BankListDTO {
  const offset = (query.page - 1) * query.pageSize
  const items = listBankRecords(db, query, query.errorProneOnly ? undefined : { limit: query.pageSize, offset })
  const stats = bankMistakeStats(db, items)
  const filtered = query.errorProneOnly ? items.filter((item) => stats.get(item.id)!.isErrorProne) : items
  const total = query.errorProneOnly ? filtered.length : countBankRecords(db, query)
  const page = query.errorProneOnly ? filtered.slice(offset, offset + query.pageSize) : filtered
  return { items: page.map((item) => ({ ...toSummary(item, stats.get(item.id)!),
    stem: item.stem.length > 240 ? `${item.stem.slice(0, 240).replace(/\{\{[^}]*$/u, '')}…` : item.stem })), total, page: query.page,
    pageSize: query.pageSize, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) }
}

export function validateBankSources(db: DatabaseSync, refs: BankSourceRef[]): void {
  if (!refs.length) throw new ApiFailure('QUESTION_SET_INVALID', '题库题目至少需要一条资料引用')
  const segments = new Map<string, ReturnType<typeof listLibrarySegments>>()
  for (const ref of refs) {
    if (!segments.has(ref.libraryFileId)) {
      const file = findLibraryFile(db, ref.libraryFileId)
      if (!file || file.status !== 'parsed') throw new ApiFailure('QUESTION_SET_INVALID', '引用资料不存在或未解析成功', { libraryFileId: ref.libraryFileId })
      segments.set(ref.libraryFileId, listLibrarySegments(db, ref.libraryFileId))
    }
    const segment = segments.get(ref.libraryFileId)!.find((part) => part.locator === ref.locator)
    const quote = normalizeDocText(ref.quote)
    const length = countTextChars(quote)
    if (!segment || length < MIN_QUOTE_CHARS || length > MAX_QUOTE_CHARS || countTextChars(ref.quote) > MAX_QUOTE_CHARS
      || !normalizeDocText(segment.text).includes(quote)) {
      throw new ApiFailure('QUESTION_SET_INVALID', `资料引用无效：${ref.locator}。请核对定位段和原文摘录`, { libraryFileId: ref.libraryFileId, locator: ref.locator })
    }
  }
}

function prepareBankQuestion(db: DatabaseSync, raw: unknown): BankQuestionInput {
  if (!isPlainObject(raw)) throw new ApiFailure('VALIDATION_FAILED', '题目内容必须是对象')
  const content = prepareQuestionContent(raw, 0)
  const issue = findQuestionContentIssue(content)
  if (issue) throw new ApiFailure('QUESTION_SET_INVALID', issue.reason, { field: issue.field })
  const errors = new FieldErrors()
  const difficulty = errors.oneOf(raw, 'difficulty', '难度', DIFFICULTIES) ?? 'normal'
  errors.throwIfAny()
  if (!Array.isArray(raw.sourceRefs)) throw new ApiFailure('QUESTION_SET_INVALID', '请填写资料引用')
  const sourceRefs = raw.sourceRefs.map((value): BankSourceRef => {
    if (!isPlainObject(value) || typeof value.libraryFileId !== 'string' || !value.libraryFileId
      || typeof value.locator !== 'string' || typeof value.quote !== 'string') {
      throw new ApiFailure('QUESTION_SET_INVALID', '每条引用需填写资料、定位和原文摘录')
    }
    return { libraryFileId: value.libraryFileId, locator: value.locator.trim(), quote: value.quote }
  })
  validateBankSources(db, sourceRefs)
  return { type: content.type, stem: content.stem, options: content.options, answerDefinition: content.answerDefinition,
    explanation: content.explanation, sourceRefs, knowledgePoint: normalizeKnowledgePoint(raw.knowledgePoint), difficulty }
}

function assertUnique(db: DatabaseSync, question: BankQuestionInput, exceptId?: string, index?: number): string {
  const key = bankContentKey(question)
  const existing = findBankDuplicate(db, key, exceptId)
  if (existing) throw new ApiFailure('QUESTION_BANK_DUPLICATE', `${index === undefined ? '' : `所选第 ${index + 1} 项：`}题库中已有相同题干和选项，请查看已有题目`, { index, itemId: existing.id, status: existing.status })
  return key
}

export function createBankItem(db: DatabaseSync, raw: unknown, now: number): BankItemDTO {
  const id = withTransaction(db, () => {
    const question = prepareBankQuestion(db, raw)
    const key = assertUnique(db, question)
    const id = randomUUID()
    insertBankRecord(db, id, question, key, now)
    return id
  })
  return getBankItem(db, id)
}

export function saveBankItem(db: DatabaseSync, id: string, body: Record<string, unknown>, now: number): BankItemDTO {
  const version = readExpectedVersion(body)
  withTransaction(db, () => {
    requireItem(db, id, version)
    const question = prepareBankQuestion(db, body.question)
    updateBankRecord(db, id, question, assertUnique(db, question, id), now)
  })
  return getBankItem(db, id)
}

export function changeBankState(db: DatabaseSync, id: string, version: number, action: 'approve' | 'disable' | 'delete', admin: string, now: number): void {
  withTransaction(db, () => {
    const item = requireItem(db, id, version)
    const allowed = action === 'disable' ? item.status === 'active' : item.status !== 'active'
    if (!allowed) throw new ApiFailure('QUESTION_BANK_STATE_CONFLICT', action === 'delete' ? '请先停用题目再删除' : '题目状态已变化，请刷新后操作', { itemId: id, status: item.status })
    if (action === 'delete') {
      db.prepare('DELETE FROM question_bank_items WHERE id = ?').run(id)
    } else if (action === 'approve') {
      prepareBankQuestion(db, item)
      db.prepare("UPDATE question_bank_items SET status = 'active', reviewed_by = ?, reviewed_at = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(admin, now, now, id)
    } else {
      db.prepare("UPDATE question_bank_items SET status = 'disabled', version = version + 1, updated_at = ? WHERE id = ?").run(now, id)
    }
  })
}

function requireExam(db: DatabaseSync, id: string, version?: number, editable = false): ExamRow {
  const exam = findExam(db, id)
  if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
  if (version !== undefined && exam.version !== version) throw new ApiFailure('VERSION_CONFLICT', '场次已变化，请保存或放弃本地修改后刷新', { serverVersion: exam.version })
  if (findActiveJob(db, id)) throw new ApiFailure('EXAM_HAS_ACTIVE_JOB', '本场 AI 任务进行中，暂不能操作题库试题')
  if (editable) {
    if (exam.status !== 'draft') throw new ApiFailure('EXAM_LOCKED', '已发布场次不能组卷')
    if (countAttemptsOfExam(db, id)) throw new ApiFailure('EXAM_HAS_ATTEMPTS', '已有答卷的场次不能组卷')
  }
  return exam
}

/** 已发布、已结束场次也可以入库；只读来源，整批失败不留下部分题。 */
export function importExamQuestions(db: DatabaseSync, examId: string, body: Record<string, unknown>, now: number): BankItemDTO[] {
  const version = readExpectedVersion({ expectedVersion: body.expectedExamVersion })
  const ids = withTransaction(db, () => {
    const exam = requireExam(db, examId, version)
    const rows = body.items
    if (!Array.isArray(rows) || !rows.length || rows.length > MAX_QUESTIONS) throw new ApiFailure('VALIDATION_FAILED', '请选择 1–100 道题目')
    const questions = new Map(listQuestions(db, examId).map((question) => [question.id, question]))
    const documents = new Map(listDocuments(db, examId).map((document) => [document.id, document]))
    const seen = new Set<string>()
    const keys = new Map<string, number>()
    const prepared = rows.map((raw, index) => {
      if (!isPlainObject(raw) || typeof raw.questionId !== 'string' || !raw.questionId || seen.has(raw.questionId)) throw new ApiFailure('VALIDATION_FAILED', '题目 ID 缺失或重复', { index })
      seen.add(raw.questionId)
      const original = questions.get(raw.questionId)
      if (!original) throw new ApiFailure('QUESTION_SET_INVALID', '所选题目不属于本场次', { index, questionId: raw.questionId })
      validateSourceRefs(db, examId, original.sourceRefs, index)
      const sourceRefs = original.sourceRefs.map((ref): BankSourceRef => {
        const libraryFileId = documents.get(ref.documentId)?.libraryFileId
        if (!libraryFileId) throw new ApiFailure('QUESTION_SET_INVALID', '来源资料缺少有效资料库记录，无法入库', { index, questionId: original.id, documentId: ref.documentId })
        return { libraryFileId, locator: ref.locator, quote: ref.quote }
      })
      const question = prepareBankQuestion(db, { ...original, sourceRefs, knowledgePoint: raw.knowledgePoint, difficulty: raw.difficulty ?? exam.blueprint.difficulty })
      const key = assertUnique(db, question, undefined, index)
      const duplicateIndex = keys.get(key)
      if (duplicateIndex !== undefined) throw new ApiFailure('QUESTION_BANK_DUPLICATE', `所选第 ${duplicateIndex + 1} 项与第 ${index + 1} 项题干和选项重复，整批未写入`, { index, duplicateIndex })
      keys.set(key, index)
      return { question, key, questionId: original.id }
    })
    return prepared.map(({ question, key, questionId }) => {
      const id = randomUUID()
      insertBankRecord(db, id, question, key, now, { examId, questionId })
      return id
    })
  })
  return details(db, findBankRecords(db, ids))
}

const blueprintKeys = { single_choice: 'singleChoice', multiple_choice: 'multipleChoice', true_false: 'trueFalse', fill_blank: 'fillBlank' } as const
function availability(exam: ExamRow, items: BankRecord[]): BankAvailabilityDTO {
  const required = {} as Record<QuestionType, number>
  const available = {} as Record<QuestionType, number>
  const missing = {} as Record<QuestionType, number>
  for (const type of QUESTION_TYPES) {
    required[type] = exam.blueprint[blueprintKeys[type]]
    available[type] = items.filter((item) => item.type === type).length
    missing[type] = Math.max(0, required[type] - available[type])
  }
  return { examVersion: exam.version, required, available, missing }
}

export function getBankAvailability(db: DatabaseSync, examId: string, filters: BankFilters): BankAvailabilityDTO {
  const exam = requireExam(db, examId)
  return availability(exam, listBankRecords(db, { ...filters, status: 'active' }))
}

function attachSources(db: DatabaseSync, examId: string, items: BankRecord[], now: number): Map<string, string> {
  const documents = listDocuments(db, examId)
  const mapping = new Map(documents.filter((document) => document.libraryFileId).map((document) => [document.libraryFileId!, document.id]))
  const incoming = [...new Set(items.flatMap((item) => item.sourceRefs.map((ref) => ref.libraryFileId)))].filter((id) => !mapping.has(id))
  const files = findLibraryFilesByIds(db, incoming)
  if (files.length !== incoming.length || files.some((file) => file.status !== 'parsed')) throw new ApiFailure('QUESTION_SET_INVALID', '题库来源资料不存在或未解析成功')
  if (documents.length + incoming.length > MAX_DOCUMENTS_PER_EXAM) throw new ApiFailure('FILE_LIMIT_EXCEEDED', '组卷后资料数量超限，请缩小范围或先移除无用资料', { currentCount: documents.length, incomingCount: incoming.length, limit: MAX_DOCUMENTS_PER_EXAM })
  const currentChars = documents.reduce((sum, document) => sum + document.charCount, 0)
  const incomingChars = files.reduce((sum, file) => sum + file.charCount, 0)
  if (currentChars + incomingChars > MAX_TOTAL_DOCUMENT_CHARS) throw new ApiFailure('DOCUMENT_CHARS_EXCEEDED', '组卷后资料字数超限，请缩小范围或先移除无用资料', { currentChars, incomingChars, limit: MAX_TOTAL_DOCUMENT_CHARS })
  for (const file of files) mapping.set(file.id, copyLibraryFileToExam(db, examId, file, now).id)
  return mapping
}

export function applyBankQuestions(db: DatabaseSync, examId: string, body: Record<string, unknown>, now: number): ExamRow {
  const version = readExpectedVersion(body)
  return withTransaction(db, () => {
    const exam = requireExam(db, examId, version, true)
    let picked: BankRecord[]
    let existing: QuestionInsert[] = []
    if (body.mode === 'random') {
      if (!isPlainObject(body.filters)) throw new ApiFailure('VALIDATION_FAILED', '请传入组卷筛选条件')
      const total = blueprintTotal(exam.blueprint)
      if (total < 1 || total > MAX_QUESTIONS) throw new ApiFailure('VALIDATION_FAILED', '请先保存合计 1–100 道题的题数设定')
      const pool = listBankRecords(db, { ...readBankFilters(body.filters), status: 'active' })
      const counts = availability(exam, pool)
      if (QUESTION_TYPES.some((type) => counts.missing[type] > 0)) throw new ApiFailure('QUESTION_BANK_SHORTAGE', '可用题目不足，请调整范围、题数或主动补题', counts)
      picked = QUESTION_TYPES.flatMap((type) => shuffle(pool.filter((item) => item.type === type)).slice(0, counts.required[type]))
    } else if (body.mode === 'manual') {
      const rows = body.items
      if (!Array.isArray(rows) || !rows.length || rows.length > MAX_QUESTIONS) throw new ApiFailure('VALIDATION_FAILED', '请选择 1–100 道题目')
      const seen = new Set<string>()
      picked = rows.map((raw) => {
        if (!isPlainObject(raw) || typeof raw.itemId !== 'string' || !raw.itemId || seen.has(raw.itemId)) throw new ApiFailure('VALIDATION_FAILED', '题库 ID 缺失或重复')
        seen.add(raw.itemId)
        const expectedVersion = readExpectedVersion(raw)
        const item = findBankRecord(db, raw.itemId)
        if (!item || item.status !== 'active') throw new ApiFailure('QUESTION_BANK_ITEM_UNAVAILABLE', '所选题目已删除、停用或待审核，请调整选择', { itemId: raw.itemId, reason: item?.status ?? 'deleted' })
        if (item.version !== expectedVersion) throw new ApiFailure('VERSION_CONFLICT', '所选题目已编辑，请重新预览后选择', { itemId: item.id, serverVersion: item.version })
        return item
      })
      existing = listQuestions(db, examId)
      if (existing.length + picked.length > MAX_QUESTIONS) throw new ApiFailure('VALIDATION_FAILED', `追加后不能超过 ${MAX_QUESTIONS} 题`)
      const origins = new Set(existing.map((question) => question.bankOrigin?.itemId))
      const keys = new Set(existing.map(bankContentKey))
      for (const item of picked) {
        if (origins.has(item.id) || keys.has(item.contentKey)) throw new ApiFailure('QUESTION_BANK_ALREADY_ADDED', '本场已有相同来源或相同题干和选项，不能重复追加', { itemId: item.id })
        keys.add(item.contentKey)
      }
    } else throw new ApiFailure('VALIDATION_FAILED', '组卷方式必须是 random 或 manual')

    const mapping = attachSources(db, examId, picked, now)
    const additions: QuestionInsert[] = picked.map((item) => ({
      id: randomUUID(), examId, position: 0, maxScoreUnits: 0, type: item.type, stem: item.stem,
      options: item.options, answerDefinition: item.answerDefinition, explanation: item.explanation,
      bankOrigin: { itemId: item.id, version: item.version },
      sourceRefs: item.sourceRefs.map((ref) => ({ documentId: mapping.get(ref.libraryFileId)!, locator: ref.locator, quote: ref.quote })),
    }))
    const final = [...existing, ...additions]
    const units = allocateUnits(SCORE_TOTAL_UNITS, final.length)
    final.forEach((question, index) => validateSourceRefs(db, examId, question.sourceRefs, index))
    deleteQuestionsNotIn(db, examId, [])
    final.forEach((question, index) => insertQuestion(db, { ...question, position: index + 1, maxScoreUnits: units[index]! }, now))
    if (body.mode === 'manual') {
      const counts = countByType(listQuestions(db, examId))
      const blueprint = { ...exam.blueprint }
      for (const type of QUESTION_TYPES) blueprint[blueprintKeys[type]] = counts[type]
      updateExamDraft(db, examId, { ...exam, blueprint }, now)
    } else touchExamVersion(db, examId, now)
    return findExam(db, examId)!
  })
}

export function knowledgePoints(db: DatabaseSync): string[] {
  return (db.prepare('SELECT DISTINCT knowledge_point FROM question_bank_items ORDER BY knowledge_point').all() as Array<{ knowledge_point: string }>).map((row) => row.knowledge_point)
}
