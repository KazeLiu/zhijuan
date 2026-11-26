import type { DatabaseSync } from 'node:sqlite'
import { JOB_OUTPUT_CHUNK_CHARS, JOB_OUTPUT_MAX_CHARS } from '../../../shared/constants'
import type { BlueprintDTO } from '../../../shared/types/exam'
import type { JobDTO, JobStatus } from '../../../shared/types/exam'
import type { Difficulty, QuestionType } from '../../../shared/types/question'
import { EMPTY_BLUEPRINT } from '../../../shared/types/exam'

/** jobs.input_json 的结构快照（§7.6） */
export interface JobInputSnapshot {
  blueprint: BlueprintDTO
  documentIds: string[]
  difficulty: Difficulty
  extraPrompt: string
}

/** jobs 表行 */
export interface JobRecord {
  id: string
  type: 'generation'
  examId: string
  status: JobStatus
  inputVersion: number
  input: JobInputSnapshot
  progressTotal: number
  progressDone: number
  modelId: string | null
  baseUrl: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

interface RawJobRow {
  id: string
  type: string
  exam_id: string
  status: string
  input_version: number
  input_json: string
  progress_total: number
  progress_done: number
  model_id: string | null
  base_url: string | null
  error_code: string | null
  error_message: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}

const JOB_COLUMNS = `id, type, exam_id, status, input_version, input_json, progress_total, progress_done,
  model_id, base_url, error_code, error_message, created_at, started_at, finished_at`

function parseJobInput(raw: string): JobInputSnapshot {
  try {
    const value = JSON.parse(raw) as Partial<JobInputSnapshot> | null
    if (!value || typeof value !== 'object') {
      return { blueprint: { ...EMPTY_BLUEPRINT }, documentIds: [], difficulty: 'normal', extraPrompt: '' }
    }
    const blueprint = value.blueprint as Partial<BlueprintDTO> | undefined
    return {
      blueprint: {
        singleChoice: Number(blueprint?.singleChoice ?? 0) || 0,
        multipleChoice: Number(blueprint?.multipleChoice ?? 0) || 0,
        trueFalse: Number(blueprint?.trueFalse ?? 0) || 0,
        fillBlank: Number(blueprint?.fillBlank ?? 0) || 0,
        difficulty:
          blueprint?.difficulty === 'easy' || blueprint?.difficulty === 'hard' ? blueprint.difficulty : 'normal',
        extraPrompt: typeof blueprint?.extraPrompt === 'string' ? blueprint.extraPrompt : '',
      },
      documentIds: Array.isArray(value.documentIds)
        ? value.documentIds.filter((item): item is string => typeof item === 'string')
        : [],
      difficulty: value.difficulty === 'easy' || value.difficulty === 'hard' ? value.difficulty : 'normal',
      extraPrompt: typeof value.extraPrompt === 'string' ? value.extraPrompt : '',
    }
  } catch {
    return { blueprint: { ...EMPTY_BLUEPRINT }, documentIds: [], difficulty: 'normal', extraPrompt: '' }
  }
}

function mapJobRow(row: RawJobRow): JobRecord {
  const status = (['queued', 'running', 'succeeded', 'failed'] as string[]).includes(row.status)
    ? (row.status as JobStatus)
    : 'failed'
  return {
    id: row.id,
    type: 'generation',
    examId: row.exam_id,
    status,
    inputVersion: Number(row.input_version),
    input: parseJobInput(row.input_json),
    progressTotal: Number(row.progress_total),
    progressDone: Number(row.progress_done),
    modelId: row.model_id,
    baseUrl: row.base_url,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null ? null : Number(row.started_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
  }
}

export function findJob(db: DatabaseSync, jobId: string): JobRecord | undefined {
  const row = db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).get(jobId) as RawJobRow | undefined
  return row ? mapJobRow(row) : undefined
}

/** 场次当前的活动任务（queued|running），由部分唯一索引保证至多一条 */
export function findActiveJob(db: DatabaseSync, examId: string): JobRecord | undefined {
  const row = db
    .prepare(
      `SELECT ${JOB_COLUMNS} FROM jobs WHERE exam_id = ? AND status IN ('queued', 'running')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(examId) as RawJobRow | undefined
  return row ? mapJobRow(row) : undefined
}

/** 场次最近一次任务（任意状态），用于展示失败信息 */
export function findLatestJob(db: DatabaseSync, examId: string): JobRecord | undefined {
  const row = db
    .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE exam_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(examId) as RawJobRow | undefined
  return row ? mapJobRow(row) : undefined
}

export function countRunningJobs(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM jobs WHERE status = 'running'").get() as
    | { total: number }
    | undefined
  return Number(row?.total ?? 0)
}

/** 失败任务数（概览「待处理」指标） */
export function countFailedJobs(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM jobs WHERE status = 'failed'").get() as
    | { total: number }
    | undefined
  return Number(row?.total ?? 0)
}

export interface JobInsert {
  id: string
  examId: string
  inputVersion: number
  input: JobInputSnapshot
  progressTotal: number
}

export function insertJob(db: DatabaseSync, input: JobInsert, now: number): void {
  db.prepare(
    `INSERT INTO jobs (id, type, exam_id, status, input_version, input_json, progress_total, progress_done,
      model_id, base_url, error_code, error_message, created_at, started_at, finished_at)
     VALUES (?, 'generation', ?, 'queued', ?, ?, ?, 0, NULL, NULL, NULL, NULL, ?, NULL, NULL)`,
  ).run(
    input.id,
    input.examId,
    input.inputVersion,
    JSON.stringify(input.input),
    input.progressTotal,
    now,
  )
}

/** 原子领取：只有把 queued 改成 running 的那一次才返回 true（§11.2） */
export function claimNextQueuedJob(
  db: DatabaseSync,
  claimed: { modelId: string; baseUrl: string; now: number },
): string | null {
  const row = db
    .prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1")
    .get() as { id: string } | undefined
  if (!row) return null
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'running', started_at = ?, model_id = ?, base_url = ?
       WHERE id = ? AND status = 'queued'`,
    )
    .run(claimed.now, claimed.modelId, claimed.baseUrl, row.id)
  return Number(result.changes) === 1 ? row.id : null
}

export function markJobProgress(db: DatabaseSync, jobId: string, progressDone: number): void {
  db.prepare("UPDATE jobs SET progress_done = ? WHERE id = ? AND status = 'running'").run(progressDone, jobId)
}

export function markJobSucceeded(db: DatabaseSync, jobId: string, now: number): void {
  db.prepare(
    `UPDATE jobs SET status = 'succeeded', progress_done = progress_total, finished_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(now, jobId)
}

export function markJobFailed(
  db: DatabaseSync,
  jobId: string,
  failure: { errorCode: string; errorMessage: string; now: number },
): void {
  db.prepare(
    `UPDATE jobs SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?
     WHERE id = ? AND status IN ('running', 'queued')`,
  ).run(failure.errorCode, failure.errorMessage.slice(0, 500), failure.now, jobId)
}

/**
 * 出题批次（契约 §10.3）：每批的生成结果与状态单独持久化，重试只重跑 pending / failed 批次。
 * 批次的 questionIndex 依赖批顺序，因此 batch_index 与 planGeneration 的批次下标一一对应。
 */
export type JobBatchStatus = 'pending' | 'succeeded' | 'failed'

export interface JobBatchRecord {
  jobId: string
  batchIndex: number
  type: QuestionType
  size: number
  status: JobBatchStatus
  /** status='succeeded' 时为 PreparedQuestion[] 的 JSON 快照，重试直接复用 */
  questionsJson: string | null
  errorCode: string | null
  errorMessage: string | null
  /** 累计请求模型的次数（批内重试也计数），用于证明重试没有二次请求已成功批次 */
  attempts: number
  updatedAt: number
}

export interface JobBatchPlanItem {
  batchIndex: number
  type: QuestionType
  size: number
}

interface RawJobBatchRow {
  job_id: string
  batch_index: number
  type: string
  size: number
  status: string
  questions_json: string | null
  error_code: string | null
  error_message: string | null
  attempts: number
  updated_at: number
}

const JOB_BATCH_COLUMNS = `job_id, batch_index, type, size, status, questions_json,
  error_code, error_message, attempts, updated_at`

function mapJobBatchRow(row: RawJobBatchRow): JobBatchRecord {
  const status = (['pending', 'succeeded', 'failed'] as string[]).includes(row.status)
    ? (row.status as JobBatchStatus)
    : 'failed'
  return {
    jobId: row.job_id,
    batchIndex: Number(row.batch_index),
    type: row.type as QuestionType,
    size: Number(row.size),
    status,
    questionsJson: row.questions_json,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    attempts: Number(row.attempts),
    updatedAt: Number(row.updated_at),
  }
}

/** 创建任务时写入批次计划：幂等，已存在的批次行（含 succeeded 结果）一律不动 */
export function planJobBatches(
  db: DatabaseSync,
  jobId: string,
  batches: ReadonlyArray<JobBatchPlanItem>,
  now: number,
): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO job_batches
       (job_id, batch_index, type, size, status, questions_json, error_code, error_message, attempts, updated_at)
     VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, 0, ?)`,
  )
  let inserted = 0
  for (const batch of batches) {
    inserted += Number(insert.run(jobId, batch.batchIndex, batch.type, batch.size, now).changes)
  }
  return inserted
}

export function listJobBatches(db: DatabaseSync, jobId: string): JobBatchRecord[] {
  const rows = db
    .prepare(`SELECT ${JOB_BATCH_COLUMNS} FROM job_batches WHERE job_id = ? ORDER BY batch_index ASC`)
    .all(jobId) as unknown as RawJobBatchRow[]
  return rows.map(mapJobBatchRow)
}

/** 本批成功：写入题目内容快照，attempts 记录本次请求模型（重试不再请求已成功批次，故不会再加） */
export function markBatchSucceeded(
  db: DatabaseSync,
  jobId: string,
  batchIndex: number,
  questionsJson: string,
  now: number,
): void {
  db.prepare(
    `UPDATE job_batches
        SET status = 'succeeded', questions_json = ?, error_code = NULL, error_message = NULL,
            attempts = attempts + 1, updated_at = ?
      WHERE job_id = ? AND batch_index = ?`,
  ).run(questionsJson, now, jobId, batchIndex)
}

/** 本批失败：保留错误码与信息，attempts 记为本批累计请求次数 */
export function markBatchFailed(
  db: DatabaseSync,
  jobId: string,
  batchIndex: number,
  code: string,
  message: string,
  attempts: number,
  now: number,
): void {
  db.prepare(
    `UPDATE job_batches
        SET status = 'failed', error_code = ?, error_message = ?, attempts = ?, updated_at = ?
      WHERE job_id = ? AND batch_index = ?`,
  ).run(code, message.slice(0, 500), attempts, now, jobId, batchIndex)
}

/**
 * 把指定题型（缺省为全部题型）的批次改回 pending，供 QUESTION_SET_INVALID 后的重试真正补量。
 * 保留 questions_json：重跑失败时仍能看到上一次生成过什么；status=pending 的批次不会被复用。
 */
export function resetFailedBatchesToPending(
  db: DatabaseSync,
  jobId: string,
  types: QuestionType[] | undefined,
  now: number,
): number {
  if (types && types.length === 0) return 0
  const placeholders = types ? ` AND type IN (${types.map(() => '?').join(', ')})` : ''
  const result = db
    .prepare(
      `UPDATE job_batches
          SET status = 'pending', error_code = NULL, error_message = NULL, updated_at = ?
        WHERE job_id = ?${placeholders}`,
    )
    .run(now, jobId, ...(types ?? []))
  return Number(result.changes)
}

/** 本次重试会真正请求模型的批次数（pending + failed）；已成功批次不计入 */
export function countRetryableBatches(db: DatabaseSync, jobId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM job_batches WHERE job_id = ? AND status IN ('pending', 'failed')`)
    .get(jobId) as { total: number } | undefined
  return Number(row?.total ?? 0)
}

/** 进程重启：遗留 running 一律视为中断失败（§11.2） */
export function failInterruptedJobs(db: DatabaseSync, now: number): number {
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'failed', error_code = 'INTERRUPTED', error_message = ?, finished_at = ?
       WHERE status = 'running'`,
    )
    .run('服务重启导致出题任务中断，请重试', now)
  return Number(result.changes)
}

/**
 * 重试：failed → queued（条件更新保证幂等），并清空上一轮的模型输出。
 * progressDone 传已成功批次数：复用批次不再请求模型，进度条直接从续跑位置继续。
 */
export function requeueJob(db: DatabaseSync, jobId: string, progressDone = 0): boolean {
  // output_* 的重置与状态变更放在同一条 UPDATE 里，保证原子（等价于再调一次 clearJobOutput）
  const result = db
    .prepare(
      `UPDATE jobs SET status = 'queued', progress_done = ?, error_code = NULL, error_message = NULL,
        started_at = NULL, finished_at = NULL, output_text = NULL, output_chars = 0
       WHERE id = ? AND status = 'failed'`,
    )
    .run(progressDone, jobId)
  return Number(result.changes) === 1
}

/** 出题任务的模型原始输出分片（§11.8） */
export interface JobOutputSlice {
  /** 从请求 offset 开始的新增文本 */
  text: string
  /** 本次返回内容的结束位置，下次请求带上它 */
  offset: number
  /** 当前存储的正文总长度 */
  total: number
  /** 超出保留上限被丢弃的前缀字符数 */
  truncated: number
  runId: string
  startOffset: number
}

/**
 * 追加模型原始输出（流式增量落库）。
 * 只保留最近 JOB_OUTPUT_MAX_CHARS 字符：长任务的输出可能远超上限，超出即丢最前面的内容；
 * output_chars 记录累计写入量，供前端提示「已截断」。
 * 注意：output_text 刻意不进 JOB_COLUMNS —— 轮询任务状态时不需要把大文本一起拉出来。
 */
export function appendJobOutput(db: DatabaseSync, jobId: string, chunk: string): void {
  if (chunk === '') return
  db.prepare(
    `UPDATE jobs SET
       output_text = substr(COALESCE(output_text, '') || ?, -${JOB_OUTPUT_MAX_CHARS}),
       output_chars = output_chars + ?
     WHERE id = ?`,
  ).run(chunk, Array.from(chunk).length, jobId)
}

/** 按 offset 增量读取模型原始输出：单次最多 JOB_OUTPUT_CHUNK_CHARS 字符（§11.8） */
export function readJobOutput(db: DatabaseSync, jobId: string, fromOffset: number, requestedRunId?: string): JobOutputSlice | undefined {
  const safeOffset = Number.isFinite(fromOffset) && fromOffset > 0 ? Math.floor(fromOffset) : 0
  const row = db
    .prepare(
      `SELECT length(COALESCE(output_text, '')) AS total,
              output_chars AS written, created_at, started_at
       FROM jobs WHERE id = ?`,
    )
    .get(jobId) as
    | { total: number; written: number; created_at: number; started_at: number | null }
    | undefined
  if (!row) return undefined
  const total = Number(row.total)
  const written = Number(row.written)
  const truncated = Math.max(0, written - total)
  const runId = `${row.created_at}:${row.started_at ?? 'queued'}`
  const reset = requestedRunId !== undefined && requestedRunId !== runId
  const startOffset = reset ? truncated : Math.min(written, Math.max(truncated, safeOffset))
  const chunk = db.prepare("SELECT substr(COALESCE(output_text, ''), ?, ?) AS text FROM jobs WHERE id = ?")
    .get(startOffset - truncated + 1, JOB_OUTPUT_CHUNK_CHARS, jobId) as { text: string }
  return {
    text: chunk.text,
    offset: startOffset + Array.from(chunk.text).length,
    total,
    truncated,
    runId,
    startOffset,
  }
}

/** 清空某个任务的模型输出（重试/重跑前调用） */
export function clearJobOutput(db: DatabaseSync, jobId: string): void {
  db.prepare('UPDATE jobs SET output_text = NULL, output_chars = 0 WHERE id = ?').run(jobId)
}

export function toJobDTO(job: JobRecord): JobDTO {
  return {
    id: job.id,
    type: job.type,
    examId: job.examId,
    status: job.status,
    progressTotal: job.progressTotal,
    progressDone: job.progressDone,
    modelId: job.modelId,
    baseUrl: job.baseUrl,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}
