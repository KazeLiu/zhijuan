import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  CHOICE_OPTION_IDS,
  MAX_QUESTIONS,
  MIN_QUESTIONS,
  SCORE_TOTAL_UNITS,
  TRUE_FALSE_OPTIONS,
} from '../../shared/constants'
import type { ExamRow } from '../db/queries/exams'
import { findExam, touchExamVersion } from '../db/queries/exams'
import { findActiveJob } from '../db/queries/jobs'
import { deleteQuestionsNotIn, findQuestion, insertQuestion, listQuestions, type QuestionRow } from '../db/queries/questions'
import type { AnswerDefinition, BlankDefinition, QuestionDraftInput, QuestionOption, QuestionType, SourceRef } from '../../shared/types/question'
import { allocateUnits, findQuestionStructureIssue, normalizeBlank } from './grading'
import { validateSourceRefs } from './documents'
import { ApiFailure, throwApi } from '../utils/respond'
import { withTransaction } from '../utils/db'
import { isPlainObject } from '../utils/validate'
import { bankContentKey } from './question-bank-stats'
import { findBankDuplicate } from '../db/queries/question-bank'
import { regradeSubmittedAttempts } from './regrading'

/** 规范化后的题目（id / position / 分值由服务端决定） */
export interface PreparedQuestion {
  /** 输入里带的既有 id（新建时为空） */
  existingId: string | null
  type: QuestionType
  stem: string
  options: QuestionOption[]
  answerDefinition: AnswerDefinition
  explanation: string
  sourceRefs: SourceRef[]
}

function asObject(value: unknown, index: number, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throwApi('QUESTION_SET_INVALID', `第 ${index + 1} 题的 ${field} 格式不正确`, {
      index,
      reason: `${field} 必须是对象`,
    })
  }
  return value
}

function asText(value: unknown, index: number, field: string, label: string): string {
  if (typeof value !== 'string') {
    throwApi('QUESTION_SET_INVALID', `第 ${index + 1} 题的${label}必须是文本`, {
      index,
      reason: `${field} 不是文本`,
    })
  }
  return value
}

function normalizeOptions(raw: unknown, type: QuestionType, index: number): QuestionOption[] {
  if (type === 'fill_blank') return []
  if (type === 'true_false') return TRUE_FALSE_OPTIONS.map((option) => ({ ...option }))
  if (!Array.isArray(raw)) {
    throwApi('QUESTION_SET_INVALID', `第 ${index + 1} 题缺少选项`, { index, reason: 'options 不是数组' })
  }
  if (raw.length !== CHOICE_OPTION_IDS.length) {
    throwApi('QUESTION_SET_INVALID', `第 ${index + 1} 题必须恰好 4 个选项`, {
      index,
      reason: `实际 ${raw.length} 个`,
    })
  }
  return raw.map((item, optionIndex) => {
    const option = asObject(item, index, 'options')
    const text = asText(option.text, index, 'options', '选项文本')
    const id = CHOICE_OPTION_IDS[optionIndex]
    if (!id) throw new ApiFailure('QUESTION_SET_INVALID', '选项 ID 分配失败')
    return { id, text: text.trim() }
  })
}

/** 题干里的临时空位编号 → {{bK}}（§11.2：{{1}} / [1] / __1__ 三种写法都接受） */
function normalizeStemPlaceholders(stem: string, mapping: Map<string, string>): string {
  const replaceKey = (rawKey: string, fallback: string): string => {
    const key = rawKey.trim()
    const mapped = mapping.get(key)
    return mapped ? `{{${mapped}}}` : fallback
  }
  let output = stem.replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (match, key: string) => replaceKey(key, match))
  output = output.replace(/\[\s*([\w-]+)\s*\]/gu, (match, key: string) => replaceKey(key, match))
  output = output.replace(/_{2}\s*([\w-]+)\s*_{2}/gu, (match, key: string) => replaceKey(key, match))
  return output
}

function normalizeBlanks(raw: unknown, type: QuestionType, stem: string, index: number): { stem: string; blanks: BlankDefinition[] } {
  if (type !== 'fill_blank') return { stem, blanks: [] }
  if (!Array.isArray(raw) || raw.length === 0) {
    throwApi('QUESTION_SET_INVALID', `第 ${index + 1} 题缺少空位定义`, { index, reason: 'blanks 不是非空数组' })
  }
  const mapping = new Map<string, string>()
  const blanks: BlankDefinition[] = raw.map((item, blankIndex) => {
    const blank = asObject(item, index, 'answerDefinition.blanks')
    const newId = `b${blankIndex + 1}`
    if (typeof blank.id === 'string' && blank.id.trim() !== '') {
      mapping.set(blank.id.trim(), newId)
    }
    const acceptedRaw = blank.acceptedAnswers
    if (!Array.isArray(acceptedRaw)) {
      throwApi('QUESTION_SET_INVALID', `第 ${index + 1} 题空位 ${newId} 缺少可接受答案`, {
        index,
        reason: 'acceptedAnswers 不是数组',
      })
    }
    const acceptedAnswers: string[] = []
    const seen = new Set<string>()
    for (const answer of acceptedRaw) {
      const text = asText(answer, index, 'answerDefinition.blanks.acceptedAnswers', '可接受答案').normalize('NFC').trim()
      // 判分不区分大小写，大小写变体互为重复，保留首个即可
      const key = normalizeBlank(text)
      if (key === '' || seen.has(key)) continue
      seen.add(key)
      acceptedAnswers.push(text)
    }
    return { id: newId, acceptedAnswers, caseSensitive: false }
  })
  // 默认按顺序补齐空位编号，同时把题干里的临时占位符统一成 {{bK}}
  for (let blankIndex = 0; blankIndex < blanks.length; blankIndex += 1) {
    const key = String(blankIndex + 1)
    if (!mapping.has(key)) mapping.set(key, `b${blankIndex + 1}`)
  }
  return { stem: normalizeStemPlaceholders(stem, mapping), blanks }
}

function normalizeCorrectOptionIds(raw: unknown, inputOptions: unknown, type: QuestionType, index: number): string[] {
  if (type === 'fill_blank') return []
  if (!Array.isArray(raw)) {
    throwApi('QUESTION_SET_INVALID', `第 ${index + 1} 题缺少标准答案`, { index, reason: 'correctOptionIds 不是数组' })
  }
  const ids = raw.filter((item): item is string => typeof item === 'string')
  if (type === 'true_false') {
    return ids.map((id) => id.trim().toLowerCase()).filter((id) => id === 'true' || id === 'false')
  }
  // 单选/多选：按输入选项顺序映射到 A/B/C/D，兼容模型给出非标准 ID 的情况
  const inputIds = Array.isArray(inputOptions)
    ? inputOptions.map((item) => (isPlainObject(item) && typeof item.id === 'string' ? item.id : ''))
    : []
  const mapped: string[] = []
  for (const id of ids) {
    const trimmed = id.trim()
    const inputIndex = inputIds.indexOf(trimmed)
    const target = inputIndex >= 0 ? CHOICE_OPTION_IDS[inputIndex] : trimmed.toUpperCase()
    if (target && !mapped.includes(target)) mapped.push(target)
  }
  return mapped
}

/**
 * 规范化两种编辑器共享的题目内容。调用方负责完整结构及各自作用域的引用校验。
 */
export function prepareQuestionContent(input: Record<string, unknown>, index: number): Omit<PreparedQuestion, 'sourceRefs'> {
  const type = input.type as QuestionType
  if (type !== 'single_choice' && type !== 'multiple_choice' && type !== 'true_false' && type !== 'fill_blank') {
    throwApi('QUESTION_SET_INVALID', `第 ${index + 1} 题的题型不合法`, { index, reason: 'unknown type' })
  }
  const rawStem = asText(input.stem, index, 'stem', '题干').trim()
  const explanation = asText(input.explanation, index, 'explanation', '解析').trim()
  const options = normalizeOptions(input.options, type, index)
  const answerDefinitionRaw = asObject(input.answerDefinition, index, 'answerDefinition')
  const { stem, blanks } = normalizeBlanks(answerDefinitionRaw.blanks, type, rawStem, index)
  const correctOptionIds = normalizeCorrectOptionIds(
    answerDefinitionRaw.correctOptionIds,
    input.options,
    type,
    index,
  )
  const existingId = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : null
  return {
    existingId, type, stem, options,
    answerDefinition: { correctOptionIds, blanks }, explanation,
  }
}

export function prepareQuestionInput(raw: unknown, index: number): PreparedQuestion {
  const input = asObject(raw, index, 'question')
  const content = prepareQuestionContent(input, index)
  const sourceRefsRaw = input.sourceRefs
  if (!Array.isArray(sourceRefsRaw)) {
    throwApi('QUESTION_SET_INVALID', `第 ${index + 1} 题缺少资料引用`, { index, reason: 'sourceRefs 不是数组' })
  }
  const sourceRefs: SourceRef[] = sourceRefsRaw.map((item) => {
    const ref = asObject(item, index, 'sourceRefs')
    return {
      documentId: asText(ref.documentId, index, 'sourceRefs', '引用资料'),
      locator: asText(ref.locator, index, 'sourceRefs', '引用定位').trim(),
      quote: asText(ref.quote, index, 'sourceRefs', '引用摘录'),
    }
  })

  const candidate = { ...content, sourceRefs }
  const issue = findQuestionStructureIssue(candidate)
  if (issue) {
    throwApi('QUESTION_SET_INVALID', `第 ${index + 1} 题不符合题目规则：${issue.reason}`, {
      index,
      questionId: content.existingId ?? undefined,
      field: issue.field,
      reason: issue.reason,
    })
  }
  return candidate
}

/** 仅做结构校验（发布预检用，已入库题目） */
export function findStoredQuestionIssue(question: QuestionRow): string | null {
  const issue = findQuestionStructureIssue({
    type: question.type,
    stem: question.stem,
    options: question.options,
    answerDefinition: question.answerDefinition,
    explanation: question.explanation,
    sourceRefs: question.sourceRefs,
  })
  return issue ? issue.reason : null
}

export interface SaveQuestionsResult {
  exam: ExamRow
  /** 同步成功的题库条目数（origin_question_id 口径） */
  syncedBankItems: number
  /** 因 status='disabled' 被跳过的题库条目数 */
  skippedBankItems: number
}

/** 可同步到来源题库条目的题目内容。 */
interface BankSyncSource {
  id: string
  type: QuestionType
  stem: string
  options: QuestionOption[]
  answerDefinition: AnswerDefinition
  explanation: string
}

/**
 * 同步题库条目（契约 §3.3）：只同步「这道题被存入题库过」的条目，
 * 依据 question_bank_items.origin_question_id = questions.id。
 * 从题库复制进场的题（questions.source_bank_item_id 非空）不反向改题库——题库条目可能被多个场次共用。
 * 内容键随题目更新；重复冲突会回滚本次场次保存，不覆盖其他题库条目。
 */
function syncBankItems(
  db: DatabaseSync,
  questions: BankSyncSource[],
  now: number,
): { synced: number; skipped: number } {
  const find = db.prepare(`SELECT id, status, type, stem, options_json, answer_definition_json, explanation
    FROM question_bank_items WHERE origin_question_id = ?`)
  const update = db.prepare(
    `UPDATE question_bank_items
        SET type = ?, stem = ?, options_json = ?, answer_definition_json = ?, explanation = ?,
            content_key = ?, status = 'active',
            version = version + 1, updated_at = ?
      WHERE id = ?`,
  )
  let synced = 0
  let skipped = 0
  const changes: Array<{ id: string; question: BankSyncSource; options: string; definition: string }> = []
  for (const question of questions) {
    const options = JSON.stringify(question.options)
    const definition = JSON.stringify(question.answerDefinition)
    const rows = find.all(question.id) as Array<{
      id: string; status: string; type: QuestionType; stem: string; options_json: string; answer_definition_json: string; explanation: string
    }>
    for (const row of rows) {
      if (row.status === 'disabled') {
        skipped += 1
        continue
      }
      if (row.type !== question.type || row.stem !== question.stem || row.options_json !== options
        || row.answer_definition_json !== definition || row.explanation !== question.explanation) {
        changes.push({ id: row.id, question, options, definition })
      }
    }
  }
  // 同一事务内先释放待修改条目的旧键，允许两道题交换内容；最终键仍受唯一约束保护。
  const releaseKey = db.prepare('UPDATE question_bank_items SET content_key = ? WHERE id = ?')
  for (const change of changes) releaseKey.run(JSON.stringify(['bank-sync', change.id]), change.id)
  for (const change of changes) {
    const key = bankContentKey(change.question)
    const duplicate = findBankDuplicate(db, key, change.id)
    if (duplicate) {
      throw new ApiFailure('QUESTION_BANK_DUPLICATE', '同步后与已有题库题目重复，本次题目修改未保存', { itemId: duplicate.id })
    }
    update.run(change.question.type, change.question.stem, change.options, change.definition, change.question.explanation, key, now, change.id)
    synced += 1
  }
  return { synced, skipped }
}

/** 草稿：整体替换（保留传入的现有 id，其余新建），重算配分 */
function replaceQuestions(
  db: DatabaseSync,
  examId: string,
  prepared: PreparedQuestion[],
  existingQuestions: QuestionRow[],
  now: number,
): BankSyncSource[] {
  const units = prepared.length > 0 ? allocateUnits(SCORE_TOTAL_UNITS, prepared.length) : []
  // 既有题目 id 集合：保留传入的 id 以免前端持有的引用失效，其余一律新建
  const existingById = new Map(existingQuestions.map((question) => [question.id, question]))
  // 整体替换：先清空旧题（草稿阶段不可能存在答卷，answers 无残留），再按顺序重写
  deleteQuestionsNotIn(db, examId, [])
  const keepIds: string[] = []
  const written: BankSyncSource[] = []
  prepared.forEach((question, index) => {
    const prior = question.existingId ? existingById.get(question.existingId) : undefined
    const id = prior?.id ?? randomUUID()
    insertQuestion(
      db,
      {
        id,
        examId,
        position: index + 1,
        type: question.type,
        stem: question.stem,
        options: question.options,
        answerDefinition: question.answerDefinition,
        explanation: question.explanation,
        sourceRefs: question.sourceRefs,
        maxScoreUnits: units[index] ?? 0,
        bankOrigin: prior?.bankOrigin ?? null,
        bankGroupKey: prior?.bankGroupKey ?? null,
      },
      now,
    )
    keepIds.push(id)
    written.push({
      id,
      type: question.type,
      stem: question.stem,
      options: question.options,
      answerDefinition: question.answerDefinition,
      explanation: question.explanation,
    })
  })
  deleteQuestionsNotIn(db, examId, keepIds)
  return written
}

/**
 * 暂停态：内容级更新（契约 §3.3）。题目 id 集合、每题题型、题目总数必须与库内一致，
 * 否则 EXAM_STRUCTURE_LOCKED；只更新 stem / options / answerDefinition / explanation / sourceRefs。
 */
function updateQuestionContents(
  db: DatabaseSync,
  examId: string,
  prepared: PreparedQuestion[],
  existingQuestions: QuestionRow[],
  now: number,
): BankSyncSource[] {
  const existingById = new Map(existingQuestions.map((question) => [question.id, question]))
  const seen = new Set<string>()
  prepared.forEach((question, index) => {
    const id = question.existingId
    if (!id) {
      throwApi('EXAM_STRUCTURE_LOCKED', `第 ${index + 1} 题缺少题目 id，暂停期间不能新增题目`, {
        index,
        reason: 'missing id',
      })
    }
    if (seen.has(id)) {
      throwApi('EXAM_STRUCTURE_LOCKED', `第 ${index + 1} 题题目 id 重复`, { index, questionId: id, reason: 'duplicate id' })
    }
    seen.add(id)
    const prior = existingById.get(id)
    if (!prior) {
      throwApi('EXAM_STRUCTURE_LOCKED', `第 ${index + 1} 题不属于本场次，暂停期间不能新增题目`, {
        index,
        questionId: id,
        reason: 'unknown id',
      })
    }
    if (prior.type !== question.type) {
      throwApi('EXAM_STRUCTURE_LOCKED', `第 ${index + 1} 题暂停期间不能修改题型`, {
        index,
        questionId: id,
        field: 'type',
      })
    }
  })
  if (seen.size !== existingQuestions.length) {
    throwApi('EXAM_STRUCTURE_LOCKED', '暂停期间不能增删题目', {
      expected: existingQuestions.length,
      actual: seen.size,
    })
  }
  const update = db.prepare(
    `UPDATE questions
        SET stem = ?, options_json = ?, answer_definition_json = ?, explanation = ?,
            source_refs_json = ?, updated_at = ?
      WHERE id = ? AND exam_id = ?`,
  )
  return prepared.map((question) => {
    const id = question.existingId ?? ''
    update.run(
      question.stem,
      JSON.stringify(question.options),
      JSON.stringify(question.answerDefinition),
      question.explanation,
      JSON.stringify(question.sourceRefs),
      now,
      id,
      examId,
    )
    return {
      id,
      type: question.type,
      stem: question.stem,
      options: question.options,
      answerDefinition: question.answerDefinition,
      explanation: question.explanation,
    }
  })
}

/**
 * 整体保存题目（§8.5 24；暂停态按契约 §3.3 走内容级更新）：
 * - 草稿：事务内校验版本与状态、重算配分、清理旧题、写新题；
 * - 暂停态（published + paused_at 非空 + 未结束）：结构锁 + 只更新题目内容；
 * - 两种模式都把内容变化同步到题库条目（origin_question_id 口径）。
 */
export function saveQuestions(
  db: DatabaseSync,
  examId: string,
  expectedVersion: number,
  inputs: unknown[],
  now: number,
): SaveQuestionsResult {
  if (!Array.isArray(inputs)) {
    throw new ApiFailure('VALIDATION_FAILED', '题目列表格式不正确', { fields: { questions: '必须是数组' } })
  }
  if (inputs.length > MAX_QUESTIONS) {
    throw new ApiFailure('VALIDATION_FAILED', '题目数量超出上限', {
      fields: { questions: `题目不能超过 ${MAX_QUESTIONS} 道` },
    })
  }
  const prepared = inputs.map((input, index) => prepareQuestionInput(input, index))

  return withTransaction(db, () => {
    const exam = findExam(db, examId)
    if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
    // 暂停态：published + paused_at 非空 + 未结束（契约 §3.3）；未暂停的已发布与已结束一律锁定
    const paused = exam.pausedAt !== null && exam.endedAt === null
    if (exam.status !== 'draft' && !paused) {
      const ended = exam.endedAt !== null
      throw new ApiFailure('EXAM_LOCKED', ended ? '已结束场次不能修改题目' : '已发布场次不能修改题目', {
        reason: ended ? 'ended' : 'published',
      })
    }
    if (findActiveJob(db, examId)) {
      throw new ApiFailure('EXAM_HAS_ACTIVE_JOB', '出题任务进行中，暂不能修改题目')
    }
    if (exam.version !== expectedVersion) {
      throw new ApiFailure('VERSION_CONFLICT', '场次已被更新，请刷新后重试', { serverVersion: exam.version })
    }
    prepared.forEach((question, index) => {
      validateSourceRefs(db, examId, question.sourceRefs, index)
    })
    const existingQuestions = listQuestions(db, examId)
    const written =
      exam.status === 'draft'
        ? replaceQuestions(db, examId, prepared, existingQuestions, now)
        : updateQuestionContents(db, examId, prepared, existingQuestions, now)
    touchExamVersion(db, examId, now)
    // 同一事务内同步题库，避免题目内容与题库条目出现中间态
    const sync = syncBankItems(db, written, now)
    if (exam.status === 'published') regradeSubmittedAttempts(db, examId, now)
    const updated = findExam(db, examId)
    if (!updated) throw new ApiFailure('INTERNAL_ERROR', '题目保存后无法读取场次')
    return { exam: updated, syncedBankItems: sync.synced, skippedBankItems: sync.skipped }
  })
}

/** 题数约束（发布预检 2） */
export function questionCountValid(count: number): boolean {
  return count >= MIN_QUESTIONS && count <= MAX_QUESTIONS
}

export function listQuestionsOfExam(db: DatabaseSync, examId: string): QuestionRow[] {
  return listQuestions(db, examId)
}

/** 各题型实际数量与 blueprint 对比（发布预检 3） */
export function countByType(questions: QuestionRow[]): Record<QuestionType, number> {
  const counts: Record<QuestionType, number> = {
    single_choice: 0,
    multiple_choice: 0,
    true_false: 0,
    fill_blank: 0,
  }
  for (const question of questions) counts[question.type] += 1
  return counts
}
