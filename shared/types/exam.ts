/** 考试场次 DTO 与阶段（docs/impl-contract.md §6、§8.5） */
import type { EpochMs } from './common'
import type { Difficulty, QuestionDraftInput } from './question'

/** 数据库只存两种发布状态 */
export type ExamStatus = 'draft' | 'published'

/** 页面阶段由服务端时间实时计算 */
export type ExamPhase = 'draft' | 'upcoming' | 'open' | 'closed'

export type AnswerRevealPolicy = 'immediate' | 'after_exam'

/** 出题设定：各题型题数分别填写，总题数由系统汇总 */
export interface BlueprintDTO {
  singleChoice: number
  multipleChoice: number
  trueFalse: number
  fillBlank: number
  difficulty: Difficulty
  /** 出题补充说明，可为空字符串 */
  extraPrompt: string
}

export const EMPTY_BLUEPRINT: BlueprintDTO = {
  singleChoice: 0,
  multipleChoice: 0,
  trueFalse: 0,
  fillBlank: 0,
  difficulty: 'normal',
  extraPrompt: '',
}

export function blueprintTotal(blueprint: BlueprintDTO): number {
  return blueprint.singleChoice + blueprint.multipleChoice + blueprint.trueFalse + blueprint.fillBlank
}

/** 考生可见的场次信息 */
export interface ExamPublicDTO {
  id: string
  title: string
  instructions: string
  timeZone: string
  startsAt: EpochMs
  endsAt: EpochMs
  answerRevealPolicy: AnswerRevealPolicy
}

export type DocumentFormat = 'pdf' | 'docx' | 'txt' | 'md'

export interface DocumentDTO {
  id: string
  examId: string
  /** 来源库条目；从资料库挂载或上传后自动入库时非空（docs/library-feature.md） */
  libraryFileId: string | null
  originalName: string
  format: DocumentFormat
  byteSize: number
  charCount: number
  segmentCount: number
  status: 'parsed' | 'failed'
  errorMessage: string | null
  createdAt: EpochMs
}

export interface PublishChecklistItem {
  code: string
  ok: boolean
  message: string
  /** 未通过时给的修正提示，可为空 */
  hint?: string
}

/** 管理端完整场次（草稿或已发布） */
export interface ExamAdminDTO {
  id: string
  title: string
  instructions: string
  status: ExamStatus
  phase: ExamPhase
  startsAt: EpochMs
  endsAt: EpochMs
  timeZone: string
  answerRevealPolicy: AnswerRevealPolicy
  blueprint: BlueprintDTO
  version: number
  questionCount: number
  /** 已存在答卷（含进行中）时不允许撤回/删除 */
  attemptCount: number
  documents: DocumentDTO[]
  questions: QuestionAdminDTO[]
  /** 进行中的出题任务（queued|running），没有则为 null */
  activeJob: JobDTO | null
  /** 最近一次出题任务（任意状态），用于展示失败的出题结果 */
  latestJob: JobDTO | null
  publishChecklist: PublishChecklistItem[]
  createdAt: EpochMs
  updatedAt: EpochMs
  serverNow: EpochMs
}

/** 管理端场次列表行 */
export interface ExamListRowDTO {
  id: string
  title: string
  status: ExamStatus
  phase: ExamPhase
  startsAt: EpochMs
  endsAt: EpochMs
  timeZone: string
  answerRevealPolicy: AnswerRevealPolicy
  questionCount: number
  attemptCount: number
  submittedCount: number
  version: number
  updatedAt: EpochMs
}

/** 新建场次入参 */
export interface ExamCreateRequest {
  title?: string
  /** 场次 IANA 时区；省略时默认 Asia/Shanghai */
  timeZone?: string
}

/** 修改场次入参：仅未锁定的草稿可改 */
export interface ExamUpdateRequest {
  expectedVersion: number
  title?: string
  instructions?: string
  /** 带时区偏移的 ISO 8601 字符串（设计 §4.1） */
  startsAt?: string
  endsAt?: string
  timeZone?: string
  answerRevealPolicy?: AnswerRevealPolicy
  blueprint?: BlueprintDTO
}

/** 创建出题任务 */
export interface GenerateRequest {
  expectedVersion: number
}

/** 题目整体保存（服务端重新配分） */
export interface QuestionsSaveRequest {
  expectedVersion: number
  questions: QuestionDraftInput[]
}

/* ------------------------------ 考生端场次 ------------------------------ */

export type CandidateExamPhase = 'open' | 'upcoming' | 'closed' | 'none'

export interface MyAttemptBriefDTO {
  attemptId: string
  status: 'in_progress' | 'submitted'
  startedAt: EpochMs
  submittedAt: EpochMs | null
  totalScoreUnits: number | null
}

export interface CurrentExamDTO {
  serverNow: EpochMs
  phase: CandidateExamPhase
  /** 开放中的场次；phase 为 closed 时是最近结束的一场，其余为 null */
  exam: ExamPublicDTO | null
  /** 下一场未开始的已发布场次 */
  nextExam: ExamPublicDTO | null
  myAttempt: MyAttemptBriefDTO | null
}

/* ------------------------------ 出题任务 ------------------------------ */

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface JobDTO {
  id: string
  type: 'generation'
  examId: string
  status: JobStatus
  /** 批次总数与已完成批次数 */
  progressTotal: number
  progressDone: number
  modelId: string | null
  baseUrl: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: EpochMs
  startedAt: EpochMs | null
  finishedAt: EpochMs | null
}

/**
 * 出题任务的模型原始输出（契约 §11.8）：
 * 按 offset 增量拉取，前端只追加新增部分，避免每次轮询重传整段文本。
 */
export interface JobOutputDTO {
  /** 从累计输出游标开始的新增文本，已截断的部分跳到最早保留位置。 */
  text: string
  /** 累计输出中的结束位置，下次请求带上它，不随缓冲区截断回退。 */
  offset: number
  /** 当前保留窗口的字符数，最多 JOB_OUTPUT_MAX_CHARS。 */
  total: number
  /** 任务是否已结束（succeeded/failed），结束且取完即可停止轮询 */
  done: boolean
  /** 因超出上限被丢弃的前缀字符数（>0 时界面提示「已截断」） */
  truncated: number
  /** 当前执行轮次标识；重试同一任务时变化，下次请求原样带上。 */
  runId?: string
  /** 返回片段在累计输出中的起始位置，用于处理截断与重试。 */
  startOffset?: number
}
