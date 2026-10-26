/**
 * 考生答案的规范化、比较与可读描述（契约 §7.3 / §8.3）。
 * 前端只做展示与基本校验，判分一律以服务端为准。
 */
import type { AnswerMap, CandidateAnswer, CandidateQuestion, QuestionOption, QuestionType } from '#shared/types'
import { TRUE_FALSE_OPTIONS } from '#shared/constants'

/** 填空标识只用于数据关联，题面统一显示下划线。 */
export function formatQuestionStem(stem: string, type: QuestionType): string {
  return type === 'fill_blank' ? stem.replace(/\{\{\s*b\d+\s*\}\}/gu, '_____') : stem
}

/** 该题型是否从固定选项里选（判断题也算） */
export function isChoiceQuestion(type: QuestionType): boolean {
  return type !== 'fill_blank'
}

/** 答案是否等价于「未作答」：null / 空选择 / 填空全空 */
export function isAnswerEmpty(answer: CandidateAnswer | null | undefined): boolean {
  if (!answer) return true
  if (answer.type === 'fill_blank') {
    const values = answer.values ?? {}
    return Object.values(values).every((value) => !String(value ?? '').trim())
  }
  return (answer.selectedOptionIds ?? []).length === 0
}

/** 提交前规范化：空答案统一成 null（契约 §8.3 的空答案语义） */
export function normalizeAnswerForSubmit(answer: CandidateAnswer | null | undefined): CandidateAnswer | null {
  if (isAnswerEmpty(answer) || !answer) return null
  if (answer.type === 'fill_blank') {
    const values: Record<string, string> = {}
    for (const [blankId, value] of Object.entries(answer.values ?? {})) {
      const text = String(value ?? '')
      if (text.trim().length > 0) values[blankId] = text
    }
    return { type: 'fill_blank', values }
  }
  const ids = [...new Set(answer.selectedOptionIds ?? [])]
  ids.sort()
  return { type: answer.type, selectedOptionIds: ids }
}

/** 两个答案是否等价（用于本地脏检查） */
export function isSameAnswer(a: CandidateAnswer | null | undefined, b: CandidateAnswer | null | undefined): boolean {
  const left = normalizeAnswerForSubmit(a)
  const right = normalizeAnswerForSubmit(b)
  if (!left || !right) return left === right
  if (left.type === 'fill_blank' && right.type === 'fill_blank') {
    const leftKeys = Object.keys(left.values)
    const rightKeys = Object.keys(right.values)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key) => (left.values[key] ?? '') === (right.values[key] ?? ''))
  }
  if (left.type !== 'fill_blank' && right.type !== 'fill_blank') {
    if (left.selectedOptionIds.length !== right.selectedOptionIds.length) return false
    return left.selectedOptionIds.every((id) => right.selectedOptionIds.includes(id))
  }
  return false
}

/** 选项文本；找不到时回退到选项 ID */
export function optionText(options: QuestionOption[], optionId: string): string {
  return options.find((option) => option.id === optionId)?.text ?? optionId
}

/** 判断题没有下发选项时的兜底文本 */
function trueFalseText(optionId: string): string {
  const matched = TRUE_FALSE_OPTIONS.find((option) => option.id === optionId)
  return matched?.text ?? optionId
}

export interface AnswerQuestionLike {
  type: QuestionType
  options: QuestionOption[]
}

/** 答案的可读描述：单选题选项文本 / 多选顿号连接 / 填空按空位列出 */
export function describeAnswer(question: AnswerQuestionLike, answer: CandidateAnswer | null | undefined): string {
  if (isAnswerEmpty(answer) || !answer) return '未作答'
  if (answer.type === 'fill_blank') {
    const entries = Object.entries(answer.values ?? {}).filter(([, value]) => String(value ?? '').trim().length > 0)
    if (entries.length === 0) return '未作答'
    entries.sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    return entries.map(([blankId, value]) => `第${blankId.slice(1)}空：${value}`).join('；')
  }
  const ids = answer.selectedOptionIds ?? []
  if (ids.length === 0) return '未作答'
  return ids
    .map((optionId) =>
      question.type === 'true_false' && question.options.length === 0
        ? trueFalseText(optionId)
        : optionText(question.options, optionId),
    )
    .join('、')
}

/** 正确答案的可读描述（结果页、管理端共用） */
export function describeCorrectAnswer(
  type: QuestionType,
  options: QuestionOption[],
  correctOptionIds: string[],
  blanks: { id: string; acceptedAnswers: string[] }[],
): string {
  if (type === 'fill_blank') {
    if (blanks.length === 0) return '—'
    return blanks
      .map((blank, index) => `第${index + 1}空：${blank.acceptedAnswers.length > 0 ? blank.acceptedAnswers.join(' / ') : '—'}`)
      .join('；')
  }
  if (correctOptionIds.length === 0) return '—'
  return correctOptionIds
    .map((optionId) =>
      type === 'true_false' && options.length === 0 ? trueFalseText(optionId) : optionText(options, optionId),
    )
    .join('、')
}

/** 已作答题数 */
export function countAnswered(questions: CandidateQuestion[], answers: AnswerMap): number {
  return questions.filter((question) => !isAnswerEmpty(answers[question.id] ?? null)).length
}

/** 生成提交用的完整快照：每道题都出现，未作答为 null */
export function buildSubmitSnapshot(questions: CandidateQuestion[], answers: AnswerMap): AnswerMap {
  const snapshot: AnswerMap = {}
  for (const question of questions) {
    snapshot[question.id] = normalizeAnswerForSubmit(answers[question.id] ?? null)
  }
  return snapshot
}
