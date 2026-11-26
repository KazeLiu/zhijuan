/** 管理端 DTO（docs/impl-contract.md §8.6–§8.9） */
import type { EpochMs, Paginated } from './common'
import type { AnswerMap, CandidateAnswer, QuestionAdminDTO } from './question'
import type { ExamPublicDTO } from './exam'

/* ------------------------------ 模型设置 ------------------------------ */

/** 思考强度：off=关闭思考（最快），high=最充分 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

export const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high']

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: '关闭（最快）',
  low: '低',
  medium: '中',
  high: '高（最充分）',
}

export interface SettingsDTO {
  baseUrl: string
  modelId: string | null
  hasApiKey: boolean
  /** 思考强度；只影响出题请求的推理开销，不改变提示词 */
  thinkingLevel: ThinkingLevel
  updatedAt: EpochMs | null
}

export interface SettingsUpdateRequest {
  baseUrl?: string
  /** 省略 = 保持原值；null = 清除；非空字符串 = 替换。禁止提交掩码字符 */
  apiKey?: string | null
  modelId?: string | null
  /** 省略 = 保持原值 */
  thinkingLevel?: ThinkingLevel
}

export interface ModelRefreshResult {
  models: string[]
  /** 当前已选模型（刷新不自动更换） */
  selectedModelId: string | null
}

export interface ModelTestResult {
  modelId: string
  durationMs: number
}

/* ------------------------------ 概览 ------------------------------ */

export interface OverviewExamDTO {
  id: string
  title: string
  startsAt: EpochMs
  endsAt: EpochMs
  timeZone: string
  questionCount: number
  startedCount: number
  inProgressCount: number
  submittedCount: number
}

export interface AdminOverviewDTO {
  serverNow: EpochMs
  serverTimeZone: string
  /** 当前开放中的场次 */
  currentExam: OverviewExamDTO | null
  /** 下一场未开始的已发布场次 */
  nextExam: OverviewExamDTO | null
  draftCount: number
  publishedCount: number
  /** 失败且可重试的出题任务数 */
  failedJobCount: number
}

/* ------------------------------ 场次汇总 ------------------------------ */

export interface QuestionStatDTO {
  questionId: string
  position: number
  type: string
  stem: string
  maxScoreUnits: number
  /** 满分人数、部分得分人数、零分人数 */
  correctCount: number
  partialCount: number
  zeroCount: number
  /** 样本数 = 已交卷答卷数 */
  sampleSize: number
  /** 比例为 0–1 的小数；样本为 0 时为 null */
  correctRate: number | null
  partialRate: number | null
  zeroRate: number | null
}

export interface ResultsSummaryDTO {
  totalAttempts: number
  inProgressCount: number
  submittedCount: number
  /** 以下统计只基于已交卷答卷；没有数据时为 null，界面显示「—」 */
  averageScoreUnits: number | null
  highestScoreUnits: number | null
  lowestScoreUnits: number | null
  passRate: number | null
  questionStats: QuestionStatDTO[]
  serverNow: EpochMs
}

export interface CandidateResultRowDTO {
  attemptId: string
  name: string
  status: 'in_progress' | 'submitted'
  startedAt: EpochMs
  submittedAt: EpochMs | null
  /** 进行中为 null */
  durationMs: number | null
  totalScoreUnits: number | null
  /** 未交卷为 null */
  passed: boolean | null
  manualReviewed: boolean
}

export interface ResultsPageDTO extends Paginated<CandidateResultRowDTO> {
  exam: ExamPublicDTO
  summary: ResultsSummaryDTO
}

/** 汇总查询参数（列表与导出共用，导出跟随当前筛选） */
export interface ResultsQuery {
  page?: number
  /** 姓名模糊匹配（NFC 后包含匹配） */
  name?: string
  /** 'true' 及格 / 'false' 不及格；省略 = 全部 */
  passed?: 'true' | 'false'
  /** 'true' 仅人工复核；省略 = 全部 */
  manual?: 'true' | 'false'
}

/* ------------------------------ 答卷详情与改分 ------------------------------ */

export interface AnswerGradeDTO {
  questionId: string
  userAnswer: CandidateAnswer | null
  autoScoreUnits: number
  overrideScoreUnits: number | null
  finalScoreUnits: number
  manualReviewed: boolean
}

export interface GradeChangeDTO {
  id: string
  questionId: string
  previousScoreUnits: number
  newScoreUnits: number
  reason: string
  adminName: string
  createdAt: EpochMs
}

export interface AttemptAdminDTO {
  attemptId: string
  examId: string
  name: string
  status: 'in_progress' | 'submitted'
  startedAt: EpochMs
  submittedAt: EpochMs | null
  submitReason: 'manual' | 'deadline' | null
  totalScoreUnits: number | null
  version: number
  exam: ExamPublicDTO & { questionCount: number }
  /** 管理端可见完整题目（含标准答案与解析） */
  questions: QuestionAdminDTO[]
  answers: AnswerMap
  grades: AnswerGradeDTO[]
  gradeChanges: GradeChangeDTO[]
  serverNow: EpochMs
}

export interface GradeRequest {
  expectedVersion: number
  /** 十进制字符串，最多两位小数，如 "3.50"；范围 0 ~ 该题满分 */
  score: string
  reason: string
}

export interface GradeResult {
  attempt: { attemptId: string; totalScoreUnits: number; version: number }
  answer: AnswerGradeDTO
  change: GradeChangeDTO
}

/* ------------------------------ 资料预览 ------------------------------ */

export interface DocumentPreviewDTO {
  documentId: string
  originalName: string
  format: string
  status: 'parsed' | 'failed'
  errorMessage: string | null
  /** 该资料提取全文的字符数 */
  totalChars: number
  offset: number
  limit: number
  /** 本次返回的正文片段 */
  text: string
  truncated: boolean
  /** 资料库预览额外提供本页覆盖的定位段片段，便于人工填写引用。 */
  segments?: Array<{ locator: string; text: string }>
}
