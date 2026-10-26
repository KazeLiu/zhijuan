import type { EpochMs, Paginated } from './common'
import type { AnswerDefinition, Difficulty, QuestionOption, QuestionType } from './question'

export type BankStatus = 'draft' | 'active' | 'disabled'
export const BANK_STATUS_LABELS: Record<BankStatus, string> = {
  draft: '待审核', active: '已启用', disabled: '已停用',
}

export interface BankSourceRef {
  libraryFileId: string
  locator: string
  quote: string
}

/** 两种编辑器实际共享的题目内容，不含不同作用域的资料引用。 */
export interface QuestionContentInput {
  type: QuestionType
  stem: string
  options: QuestionOption[]
  answerDefinition: AnswerDefinition
  explanation: string
}

export interface BankQuestionInput extends QuestionContentInput {
  knowledgePoint: string
  difficulty: Difficulty
  sourceRefs: BankSourceRef[]
}

export interface BankMistakeStats {
  sampleSize: number
  correctCount: number
  partialCount: number
  zeroCount: number
  errorCount: number
  unansweredCount: number
  errorRate: number | null
  isErrorProne: boolean
}

export interface BankItemSummary {
  id: string
  version: number
  status: BankStatus
  type: QuestionType
  stem: string
  knowledgePoint: string
  difficulty: Difficulty
  sources: Array<{ libraryFileId: string; originalName: string }>
  createdAt: EpochMs
  updatedAt: EpochMs
  mistakeStats: BankMistakeStats
}

export interface BankItemDTO extends BankItemSummary, BankQuestionInput {
  originExamId: string | null
  originQuestionId: string | null
  reviewedBy: string | null
  reviewedAt: EpochMs | null
}

export interface BankFilters {
  knowledgePoints?: string[]
  libraryFileIds?: string[]
  difficulty?: Difficulty
}

export interface BankListQuery extends BankFilters {
  page: number
  pageSize: number
  query?: string
  type?: QuestionType
  status?: BankStatus
  errorProneOnly?: boolean
}
export type BankListDTO = Paginated<BankItemSummary>

export interface BankAvailabilityDTO {
  examVersion: number
  required: Record<QuestionType, number>
  available: Record<QuestionType, number>
  missing: Record<QuestionType, number>
}

export type BankApplyRequest =
  | { expectedVersion: number; mode: 'random'; filters: BankFilters }
  | { expectedVersion: number; mode: 'manual'; items: Array<{ itemId: string; expectedVersion: number }> }

export interface QuestionsToBankRequest {
  expectedExamVersion: number
  items: Array<{ questionId: string; knowledgePoint: string; difficulty: Difficulty }>
}
