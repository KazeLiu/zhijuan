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
import { deleteQuestionsNotIn, findQuestion, insertQuestion, listQuestions, type QuestionRow } from '../db/queries/questions'
import type { AnswerDefinition, BlankDefinition, QuestionDraftInput, QuestionOption, QuestionType, SourceRef } from '../../shared/types/question'
import { allocateUnits, findQuestionStructureIssue } from './grading'
import { validateSourceRefs } from './documents'
import { ApiFailure, throwApi } from '../utils/respond'
import { withTransaction } from '../utils/db'
import { isPlainObject } from '../utils/validate'

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
    const acceptedAnswers = acceptedRaw
      .map((answer) => asText(answer, index, 'answerDefinition.blanks.acceptedAnswers', '可接受答案').normalize('NFC').trim())
      .filter((answer) => answer !== '')
    const caseSensitive = blank.caseSensitive === undefined ? true : blank.caseSensitive === true
    return { id: newId, acceptedAnswers, caseSensitive }
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
 * 校验并规范化一题（§7.4）：只做结构校验与 ID 归一化，
 * 不做资料引用校验（需要数据库）。
 */
export function prepareQuestionInput(raw: unknown, index: number): PreparedQuestion {
  const input = asObject(raw, index, 'question')
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

  const existingId = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : null
  const candidate = {
    type,
    stem,
    options,
    answerDefinition: { correctOptionIds, blanks } satisfies AnswerDefinition,
    explanation,
    sourceRefs,
  }
  const issue = findQuestionStructureIssue(candidate)
  if (issue) {
    throwApi('QUESTION_SET_INVALID', `第 ${index + 1} 题不符合题目规则：${issue.reason}`, {
      index,
      questionId: existingId ?? undefined,
      field: issue.field,
      reason: issue.reason,
    })
  }
  return { existingId, ...candidate }
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
}

/**
 * 整体替换题目（§8.5 24）：事务内校验版本与状态、重算配分、清理旧题、写新题。
 */
export function saveQuestions(
  db: DatabaseSync,
  examId: string,
  expectedVersion: number,
  inputs: unknown[],
  now: number,
): ExamRow {
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
    if (exam.status !== 'draft') {
      throw new ApiFailure('EXAM_LOCKED', '已发布场次不能修改题目', { reason: 'published' })
    }
    if (exam.version !== expectedVersion) {
      throw new ApiFailure('VERSION_CONFLICT', '场次已被更新，请刷新后重试', { serverVersion: exam.version })
    }
    prepared.forEach((question, index) => {
      validateSourceRefs(db, examId, question.sourceRefs, index)
    })
    const units = prepared.length > 0 ? allocateUnits(SCORE_TOTAL_UNITS, prepared.length) : []
    // 既有题目 id 集合：保留传入的 id 以免前端持有的引用失效，其余一律新建
    const existingIds = new Set(listQuestions(db, examId).map((question) => question.id))
    // 整体替换：先清空旧题（草稿阶段不可能存在答卷，answers 无残留），再按顺序重写
    deleteQuestionsNotIn(db, examId, [])
    const keepIds: string[] = []
    prepared.forEach((question, index) => {
      const existing = question.existingId && existingIds.has(question.existingId) ? question.existingId : null
      const id = existing ?? randomUUID()
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
        },
        now,
      )
      keepIds.push(id)
    })
    deleteQuestionsNotIn(db, examId, keepIds)
    touchExamVersion(db, examId, now)
    const updated = findExam(db, examId)
    if (!updated) throw new ApiFailure('INTERNAL_ERROR', '题目保存后无法读取场次')
    return updated
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
