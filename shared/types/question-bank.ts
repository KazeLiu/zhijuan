import type { EpochMs, Paginated } from './common'
import type { AnswerDefinition, Difficulty, QuestionOption, QuestionType } from './question'

export type BankStatus = 'active' | 'disabled'
export const BANK_STATUS_LABELS: Record<BankStatus, string> = {
  active: '已启用', disabled: '已停用',
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
  /** 同一原始来源的所有题目使用同名分组；省略时为独立题。 */
  sourceGroup?: string
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
  sourceGroup: string
  sourceGroupKey: string
  knowledgePoint: string
  difficulty: Difficulty
  sources: Array<{ libraryFileId: string; originalName: string }>
  createdAt: EpochMs
  updatedAt: EpochMs
  mistakeStats: BankMistakeStats
}

export interface BankItemDTO extends BankItemSummary, Omit<BankQuestionInput, 'sourceGroup'> {
  originExamId: string | null
  originQuestionId: string | null
}

export interface BankFilters {
  knowledgePoints?: string[]
  libraryFileIds?: string[]
  difficulty?: Difficulty
  /** 限定为当前筛选范围内、按错误率排名的前 N 道易错题；省略时使用普通题库。 */
  mistakeTopN?: number
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
  groupCount: number
}

export interface BankFileGenerationRequest {
  mode?: 'files'
  libraryFileIds: string[]
  difficulty: Difficulty
  extraPrompt: string
}

export type BankSupplementQuantity =
  | { mode: 'auto'; total: number }
  | { mode: 'by_type'; counts: Record<QuestionType, number> }

export interface BankSupplementRequest {
  mode: 'supplement'
  sourceIds: string[]
  quantity: BankSupplementQuantity
  difficulty: Difficulty
  extraPrompt: string
}

export type BankGenerationRequest = BankFileGenerationRequest | BankSupplementRequest

export interface BankGenerationSourceSummary {
  id: string
  title: string
  knowledgePoint: string
  fileName: string
  locators: string[]
  questionCount: number
}

export interface BankGenerationConflict {
  itemId: string
  sourceTitle: string
  type: QuestionType
  stem: string
  existingAnswer: AnswerDefinition
  generatedAnswer: AnswerDefinition
}

/** 未解决问题：请求错误带序号与次数，任务级错误使用 null 并在 message 中说明阶段。 */
export interface BankGenerationIssue {
  sourceTitle: string
  /** 来源内的第几个请求（1 基）；任务级错误为 null。 */
  requestIndex: number | null
  attempts: number | null
  message: string
}

export interface BankGenerationJobDTO {
  id: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  input: BankGenerationRequest
  stage: 'analysis' | 'generation'
  /** 已处理（成功 + 失败）的请求数 */
  progressDone: number
  progressTotal: number
  generatedCount: number
  createdCount: number
  duplicateCount: number
  requestedCount: number | null
  conflicts: BankGenerationConflict[]
  sources: Array<{
    id: string | null
    title: string
    knowledgePoint: string
    fileName: string
    locators: string[]
    /** 该来源的请求全部处理完（含失败），不再有待处理请求 */
    completed: boolean
    failedCount: number
    generatedCount: number
    createdCount: number
    requestedCount: number | null
    shortfallReason: string
  }>
  ignored: Array<{ fileName: string; locators: string[]; reason: string }>
  /** 重试耗尽仍失败的请求，成功后移除；任务可 failed 但仍有部分成功结果 */
  issues: BankGenerationIssue[]
  errorMessage: string
  createdAt: EpochMs
}

export type BankApplyRequest =
  | { expectedVersion: number; mode: 'random'; filters: BankFilters }
  | { expectedVersion: number; mode: 'manual'; items: Array<{ itemId: string; expectedVersion: number }> }

export interface QuestionsToBankRequest {
  expectedExamVersion: number
  items: Array<{ questionId: string; knowledgePoint: string; difficulty: Difficulty }>
}
