/** 题目结构与考生作答 DTO（docs/impl-contract.md §7、§8） */

export const QUESTION_TYPES = ['single_choice', 'multiple_choice', 'true_false', 'fill_blank'] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  single_choice: '单选题',
  multiple_choice: '多选题',
  true_false: '判断题',
  fill_blank: '填空题',
}

export const DIFFICULTY_LABELS = {
  easy: '简单',
  normal: '适中',
  hard: '困难',
} as const
export type Difficulty = keyof typeof DIFFICULTY_LABELS

export interface QuestionOption {
  id: string
  text: string
}

export interface BlankDefinition {
  /** 稳定空位 ID，如 b1 / b2；由服务端分配 */
  id: string
  /** 可接受答案，至少一项，已 NFC 规范化 */
  acceptedAnswers: string[]
  /** 是否区分大小写，默认 true */
  caseSensitive: boolean
}

/** 题目答案定义：选择类用 correctOptionIds，填空类用 blanks，另一侧为空数组 */
export interface AnswerDefinition {
  correctOptionIds: string[]
  blanks: BlankDefinition[]
}

/** 题目引用的资料定位 */
export interface SourceRef {
  documentId: string
  /** 定位标识：pdf 用页 `p12`，docx 用段 `para7`，txt/md 用行段 `line3-9` */
  locator: string
  /** 引用摘录，需在归一化后命中同一页/同一段（设计 §8.3） */
  quote: string
}

/* ------------------------------ 管理端题目 ------------------------------ */

export interface QuestionAdminDTO {
  id: string
  position: number
  type: QuestionType
  stem: string
  options: QuestionOption[]
  answerDefinition: AnswerDefinition
  explanation: string
  sourceRefs: SourceRef[]
  /** 服务端配分结果，整数单位 */
  maxScoreUnits: number
  /** 从题库复制时的来源；已有场次内容不随题库变化。 */
  bankOrigin: { itemId: string; version: number; deleted: boolean; groupKey?: string | null } | null
}

/** PUT /admin/exams/:id/questions 的输入项；position 由数组顺序决定 */
export interface QuestionDraftInput {
  /** 传已有题目的 id 表示更新，省略表示新增 */
  id?: string
  type: QuestionType
  stem: string
  options: QuestionOption[]
  answerDefinition: AnswerDefinition
  explanation: string
  sourceRefs: SourceRef[]
}

/* ------------------------------ 考生作答 DTO ------------------------------ */

export interface CandidateBlank {
  id: string
  /** 该空的分值（整数单位），按 §7.3 均分到各空 */
  maxScoreUnits: number
}

/** 考生题目：不包含标准答案、解析、资料原文 */
export interface CandidateQuestion {
  id: string
  position: number
  type: QuestionType
  stem: string
  maxScoreUnits: number
  /** 是否可多选（仅 multiple_choice 为 true） */
  multiple: boolean
  /** 单选/多选/判断的选项；填空题为空数组 */
  options: QuestionOption[]
  /** 填空题空位；其他题型为空数组 */
  blanks: CandidateBlank[]
  /** 仅填空：是否区分大小写，需在界面提示 */
  caseSensitive: boolean
}

export type CandidateAnswer =
  | { type: 'single_choice' | 'multiple_choice' | 'true_false'; selectedOptionIds: string[] }
  | { type: 'fill_blank'; values: Record<string, string> }

/** questionId → 答案；未作答为 null 或不出现 */
export type AnswerMap = Record<string, CandidateAnswer | null>

/* ------------------------------ 结果页题目 ------------------------------ */

export interface QuestionResultDTO {
  id: string
  position: number
  type: QuestionType
  stem: string
  maxScoreUnits: number
  /** 最终得分（人工复核优先） */
  earnedScoreUnits: number
  autoScoreUnits: number
  overrideScoreUnits: number | null
  manualReviewed: boolean
  userAnswer: CandidateAnswer | null
  /** 未作答（不是答错） */
  unanswered: boolean
  options: QuestionOption[]
  blanks: CandidateBlank[]
  correctAnswer: {
    optionIds: string[]
    blanks: BlankDefinition[]
  }
  explanation: string
  sourceRefs: SourceRef[]
}

