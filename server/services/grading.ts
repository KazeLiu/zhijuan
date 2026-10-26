import {
  CHOICE_OPTION_IDS,
  MAX_BLANK_ANSWER_CHARS,
  MAX_EXPLANATION_CHARS,
  MAX_OPTION_TEXT_CHARS,
  MAX_QUOTE_CHARS,
  MAX_STEM_CHARS,
  TRUE_FALSE_OPTIONS,
} from '../../shared/constants'
import type {
  AnswerDefinition,
  CandidateAnswer,
  QuestionOption,
  QuestionType,
  SourceRef,
} from '../../shared/types/question'
import { ApiFailure } from '../utils/respond'

/* ------------------------------ 计分单位与配分（§7.2） ------------------------------ */

/**
 * 配分算法唯一实现：把 totalUnits 尽量均分到 count 份，余数从前往后各加 1。
 * 合计恒等于 totalUnits。
 */
export function allocateUnits(totalUnits: number, count: number): number[] {
  if (!Number.isInteger(totalUnits) || totalUnits <= 0) throw new Error('totalUnits 非法')
  if (!Number.isInteger(count) || count <= 0) throw new Error('count 非法')
  const base = Math.floor(totalUnits / count)
  const remainder = totalUnits % count
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0))
}

/** 填空题各空分值：按空位顺序均分该题满分 */
export function blankScoreUnits(maxScoreUnits: number, blankCount: number): number[] {
  if (blankCount <= 0) return []
  if (maxScoreUnits <= 0) return Array.from({ length: blankCount }, () => 0)
  return allocateUnits(maxScoreUnits, blankCount)
}

/** Unicode 码点计数（与前端 maxlength 口径一致） */
export function countTextChars(value: string): number {
  return Array.from(value).length
}

/* ------------------------------ 填空归一化与判分（§7.3） ------------------------------ */

export function normalizeBlank(input: string, caseSensitive: boolean): string {
  const base = input.normalize('NFC').trim().replace(/\s+/gu, ' ')
  return caseSensitive ? base : base.toLowerCase()
}

export interface GradableQuestion {
  id: string
  type: QuestionType
  maxScoreUnits: number
  options: QuestionOption[]
  answerDefinition: AnswerDefinition
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 空答案：null、选中为空、填空全部空串（§8.3 8） */
export function isEmptyAnswer(answer: CandidateAnswer | null): boolean {
  if (answer === null) return true
  if (answer.type === 'fill_blank') {
    return Object.values(answer.values).every((value) => value.trim() === '')
  }
  return answer.selectedOptionIds.length === 0
}

/**
 * 校验并规范化一份答案；结构非法抛 422 ANSWER_INVALID，空答案返回 null。
 * 服务端只接受题型匹配、选项/空位存在的答案，不做任何自动修正。
 */
export function normalizeCandidateAnswer(question: GradableQuestion, raw: unknown): CandidateAnswer | null {
  if (raw === null || raw === undefined) return null
  if (!isObject(raw)) throw new ApiFailure('ANSWER_INVALID', '答案格式不正确')
  if (raw.type !== question.type) throw new ApiFailure('ANSWER_INVALID', '答案题型与题目不一致')

  if (question.type === 'fill_blank') {
    const values = raw.values
    if (!isObject(values)) throw new ApiFailure('ANSWER_INVALID', '填空题答案必须是空位映射')
    const blankIds = new Set(question.answerDefinition.blanks.map((blank) => blank.id))
    const normalized: Record<string, string> = {}
    for (const [blankId, value] of Object.entries(values)) {
      if (!blankIds.has(blankId)) throw new ApiFailure('ANSWER_INVALID', `空位不存在：${blankId}`)
      if (typeof value !== 'string') throw new ApiFailure('ANSWER_INVALID', '空位作答必须是文本')
      if (countTextChars(value) > MAX_BLANK_ANSWER_CHARS) {
        throw new ApiFailure('ANSWER_INVALID', `每空作答不能超过 ${MAX_BLANK_ANSWER_CHARS} 字`)
      }
      normalized[blankId] = value
    }
    for (const blankId of blankIds) {
      if (!(blankId in normalized)) normalized[blankId] = ''
    }
    const answer: CandidateAnswer = { type: 'fill_blank', values: normalized }
    return isEmptyAnswer(answer) ? null : answer
  }

  const selected = raw.selectedOptionIds
  if (!Array.isArray(selected)) throw new ApiFailure('ANSWER_INVALID', '选择题答案必须是选项 ID 数组')
  const optionIds = new Set(question.options.map((option) => option.id))
  const unique: string[] = []
  for (const item of selected) {
    if (typeof item !== 'string' || !optionIds.has(item)) {
      throw new ApiFailure('ANSWER_INVALID', '选项不存在')
    }
    if (!unique.includes(item)) unique.push(item)
  }
  const answer: CandidateAnswer = {
    type: question.type === 'multiple_choice' ? 'multiple_choice' : question.type === 'true_false' ? 'true_false' : 'single_choice',
    selectedOptionIds: unique,
  }
  return isEmptyAnswer(answer) ? null : answer
}

/** 逐题判分：返回该题得分（整数单位），未作答为 0 */
export function gradeAnswer(question: GradableQuestion, answer: CandidateAnswer | null): number {
  if (answer === null) return 0

  if (question.type === 'fill_blank') {
    if (answer.type !== 'fill_blank') return 0
    const blanks = question.answerDefinition.blanks
    const units = blankScoreUnits(question.maxScoreUnits, blanks.length)
    let total = 0
    blanks.forEach((blank, index) => {
      const submitted = answer.values[blank.id] ?? ''
      const candidate = normalizeBlank(submitted, blank.caseSensitive)
      if (candidate === '') return
      const hit = blank.acceptedAnswers.some(
        (accepted) => normalizeBlank(accepted, blank.caseSensitive) === candidate,
      )
      if (hit) total += units[index] ?? 0
    })
    return total
  }

  if (answer.type === 'fill_blank') return 0
  const selected = answer.selectedOptionIds
  const correct = question.answerDefinition.correctOptionIds
  if (question.type === 'multiple_choice') {
    if (selected.length !== correct.length) return 0
    const correctSet = new Set(correct)
    return selected.every((id) => correctSet.has(id)) ? question.maxScoreUnits : 0
  }
  // 单选与判断：必须恰好选中唯一正确项
  if (selected.length !== 1) return 0
  return correct.length === 1 && selected[0] === correct[0] ? question.maxScoreUnits : 0
}

/** 整卷判分：返回逐题得分与总分 */
export function gradeAttempt(
  questions: GradableQuestion[],
  answers: Record<string, CandidateAnswer | null>,
): { total: number; perQuestion: Record<string, number> } {
  const perQuestion: Record<string, number> = {}
  let total = 0
  for (const question of questions) {
    const score = gradeAnswer(question, answers[question.id] ?? null)
    perQuestion[question.id] = score
    total += score
  }
  return { total, perQuestion }
}

/* ------------------------------ 题目结构校验（§7.4） ------------------------------ */

export interface QuestionStructureCandidate {
  type: QuestionType
  stem: string
  options: QuestionOption[]
  answerDefinition: AnswerDefinition
  explanation: string
  sourceRefs: SourceRef[]
}

export interface StructureIssue {
  field: string
  reason: string
}

function checkChoiceOptions(options: QuestionOption[]): StructureIssue | null {
  if (options.length !== CHOICE_OPTION_IDS.length) {
    return { field: 'options', reason: '选择题必须恰好 4 个选项' }
  }
  for (let index = 0; index < CHOICE_OPTION_IDS.length; index += 1) {
    const expectedId = CHOICE_OPTION_IDS[index]
    const option = options[index]
    if (!option || option.id !== expectedId) {
      return { field: 'options', reason: '选项 ID 必须依次为 A、B、C、D' }
    }
    if (option.text.trim() === '') return { field: 'options', reason: '选项文本不能为空' }
    if (countTextChars(option.text) > MAX_OPTION_TEXT_CHARS) {
      return { field: 'options', reason: `选项文本不能超过 ${MAX_OPTION_TEXT_CHARS} 字` }
    }
  }
  return null
}

function checkStemPlaceholders(stem: string, blanks: Array<{ id: string }>): StructureIssue | null {
  const placeholders = Array.from(stem.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/gu)).map((match) => match[1] ?? '')
  if (placeholders.length === 0) return null
  const blankIds = new Set(blanks.map((blank) => blank.id))
  const seen = new Set<string>()
  for (const placeholder of placeholders) {
    if (!blankIds.has(placeholder)) {
      return { field: 'stem', reason: `题干占位符 {{${placeholder}}} 没有对应的空位` }
    }
    if (seen.has(placeholder)) {
      return { field: 'stem', reason: `题干占位符 {{${placeholder}}} 重复出现` }
    }
    seen.add(placeholder)
  }
  if (seen.size !== blankIds.size) {
    return { field: 'stem', reason: '题干占位符必须与全部空位一一对应' }
  }
  return null
}

/** 题目结构合法性（§7.4）：通过返回 null，否则返回具体问题 */
export function findQuestionStructureIssue(question: QuestionStructureCandidate): StructureIssue | null {
  if (question.stem.trim() === '') return { field: 'stem', reason: '题干不能为空' }
  if (countTextChars(question.stem) > MAX_STEM_CHARS) {
    return { field: 'stem', reason: `题干不能超过 ${MAX_STEM_CHARS} 字` }
  }
  if (question.explanation.trim() === '') return { field: 'explanation', reason: '解析不能为空' }
  if (countTextChars(question.explanation) > MAX_EXPLANATION_CHARS) {
    return { field: 'explanation', reason: `解析不能超过 ${MAX_EXPLANATION_CHARS} 字` }
  }
  if (question.sourceRefs.length === 0) return { field: 'sourceRefs', reason: '至少需要一条资料引用' }
  for (const [index, ref] of question.sourceRefs.entries()) {
    if (typeof ref.documentId !== 'string' || ref.documentId === '') {
      return { field: 'sourceRefs', reason: `第 ${index + 1} 条引用缺少资料` }
    }
    if (typeof ref.locator !== 'string' || ref.locator === '') {
      return { field: 'sourceRefs', reason: `第 ${index + 1} 条引用缺少定位` }
    }
    if (typeof ref.quote !== 'string') {
      return { field: 'sourceRefs', reason: `第 ${index + 1} 条引用摘录必须是文本` }
    }
    if (countTextChars(ref.quote) > MAX_QUOTE_CHARS) {
      return { field: 'sourceRefs', reason: `引用摘录不能超过 ${MAX_QUOTE_CHARS} 字` }
    }
  }

  const correctOptionIds = question.answerDefinition.correctOptionIds
  const blanks = question.answerDefinition.blanks

  if (question.type === 'single_choice' || question.type === 'multiple_choice') {
    const optionIssue = checkChoiceOptions(question.options)
    if (optionIssue) return optionIssue
    if (blanks.length > 0) return { field: 'answerDefinition', reason: '选择题不应包含填空空位' }
    const optionIds = new Set(question.options.map((option) => option.id))
    if (new Set(correctOptionIds).size !== correctOptionIds.length) {
      return { field: 'answerDefinition', reason: '正确选项不能重复' }
    }
    for (const id of correctOptionIds) {
      if (!optionIds.has(id)) return { field: 'answerDefinition', reason: '正确选项必须来自选项列表' }
    }
    if (question.type === 'single_choice') {
      if (correctOptionIds.length !== 1) {
        return { field: 'answerDefinition', reason: '单选题必须恰好一个正确选项' }
      }
      return null
    }
    if (correctOptionIds.length < 2 || correctOptionIds.length > 3) {
      return { field: 'answerDefinition', reason: '多选题正确选项必须是 2 到 3 个' }
    }
    return null
  }

  if (question.type === 'true_false') {
    const expected = TRUE_FALSE_OPTIONS
    const ok =
      question.options.length === expected.length &&
      expected.every((option, index) => {
        const actual = question.options[index]
        return actual !== undefined && actual.id === option.id && actual.text === option.text
      })
    if (!ok) return { field: 'options', reason: '判断题选项固定为「正确 / 错误」' }
    if (blanks.length > 0) return { field: 'answerDefinition', reason: '判断题不应包含填空空位' }
    if (correctOptionIds.length !== 1) {
      return { field: 'answerDefinition', reason: '判断题必须恰好一个正确选项' }
    }
    const only = correctOptionIds[0]
    if (only !== 'true' && only !== 'false') {
      return { field: 'answerDefinition', reason: '判断题正确选项只能是 true 或 false' }
    }
    return null
  }

  // fill_blank
  if (question.options.length > 0) return { field: 'options', reason: '填空题不应包含选项' }
  if (correctOptionIds.length > 0) return { field: 'answerDefinition', reason: '填空题不应包含正确选项' }
  if (blanks.length === 0) return { field: 'answerDefinition', reason: '填空题至少需要一个空位' }
  const blankIds = new Set<string>()
  for (const blank of blanks) {
    if (typeof blank.id !== 'string' || blank.id.trim() === '') {
      return { field: 'answerDefinition', reason: '空位 ID 不能为空' }
    }
    if (blankIds.has(blank.id)) return { field: 'answerDefinition', reason: '空位 ID 不能重复' }
    blankIds.add(blank.id)
    const accepted = blank.acceptedAnswers.map((item) => item.trim()).filter((item) => item !== '')
    if (accepted.length === 0) {
      return { field: 'answerDefinition', reason: '每个空位至少需要一个可接受答案' }
    }
    if (new Set(accepted).size !== accepted.length) {
      return { field: 'answerDefinition', reason: '同一空位的可接受答案不能重复' }
    }
    for (const item of accepted) {
      if (countTextChars(item) > MAX_BLANK_ANSWER_CHARS) {
        return { field: 'answerDefinition', reason: `每个可接受答案不能超过 ${MAX_BLANK_ANSWER_CHARS} 字` }
      }
    }
    if (typeof blank.caseSensitive !== 'boolean') {
      return { field: 'answerDefinition', reason: '空位必须显式标注是否区分大小写' }
    }
  }
  return checkStemPlaceholders(question.stem, blanks)
}
