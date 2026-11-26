/** 答卷与结果 DTO（docs/impl-contract.md §8.3、§8.4） */
import type { EpochMs } from './common'
import type { AnswerMap, CandidateAnswer, CandidateQuestion, QuestionResultDTO } from './question'
import type { AnswerRevealPolicy, ExamPublicDTO } from './exam'

export type AttemptStatus = 'in_progress' | 'submitted'
export type SubmitReason = 'manual' | 'deadline'

export interface AttemptStartResult {
  attemptId: string
  examId: string
  status: AttemptStatus
  startedAt: EpochMs
  /** true = 复用已有的进行中/已提交答卷；false = 本次新建 */
  resumed: boolean
}

/** 考生答题页数据；不含任何答案、解析或评分信息 */
export interface AttemptDetailDTO {
  attemptId: string
  examId: string
  status: AttemptStatus
  startedAt: EpochMs
  submittedAt: EpochMs | null
  submitReason: SubmitReason | null
  /** 版本号；每次保存 +1 */
  version: number
  serverNow: EpochMs
  exam: ExamPublicDTO
  questions: CandidateQuestion[]
  /** 已保存答案 */
  answers: AnswerMap
}

export interface AnswerSaveRequest {
  expectedVersion: number
  answer: CandidateAnswer | null
}

export interface AnswerSaveResult {
  version: number
  savedAt: EpochMs
}

export interface SubmitRequest {
  expectedVersion: number
  /** 完整答案快照：questionId → 答案 */
  answers: AnswerMap
}

export interface SubmitResult {
  attemptId: string
  status: 'submitted'
  submittedAt: EpochMs
  submitReason: SubmitReason
  /** false = 已过截止时间，服务端只采用最后保存的答案（设计 §6.4） */
  acceptedSnapshot: boolean
  totalScoreUnits: number
  version: number
  /** true = 重复交卷，返回已有提交结果 */
  duplicate: boolean
}

export interface AttemptResultDTO {
  attemptId: string
  examId: string
  status: 'submitted'
  totalScoreUnits: number
  maxScoreUnits: number
  passed: boolean
  startedAt: EpochMs
  submittedAt: EpochMs
  submitReason: SubmitReason
  durationMs: number
  serverNow: EpochMs
  canReveal: boolean
  /** 答案与解析公开时刻（immediate 为交卷时刻，after_exam 为本场截止时刻） */
  revealAt: EpochMs
  revealMode: AnswerRevealPolicy
  /** 本人答案始终返回 */
  answers: AnswerMap
  /** canReveal = false 时为 null，服务端不下发逐题内容 */
  questions: QuestionResultDTO[] | null
}

/** 个人错题集单题：本人已公开的未满分题目（含部分得分、零分与未作答） */
export interface MyMistakeQuestionDTO extends Omit<QuestionResultDTO, 'blanks' | 'sourceRefs'> {
  attemptId: string
  examId: string
  examTitle: string
  examTimeZone: string
  submittedAt: EpochMs
}

/** 「我的记录」列表行 */
export interface MyAttemptRowDTO {
  attemptId: string
  examId: string
  examTitle: string
  examTimeZone: string
  examStartsAt: EpochMs
  examEndsAt: EpochMs
  status: AttemptStatus
  startedAt: EpochMs
  submittedAt: EpochMs | null
  totalScoreUnits: number | null
}
