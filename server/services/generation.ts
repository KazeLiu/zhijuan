import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { BlueprintDTO } from '../../shared/types/exam'
import type { QuestionType } from '../../shared/types/question'
import { QUESTION_TYPE_LABELS } from '../../shared/types/question'
import {
  CANDIDATE_FACTOR,
  MAX_BATCH_QUESTIONS,
  MAX_CANDIDATES_PER_TYPE,
  MAX_QUESTIONS,
  SCORE_TOTAL_UNITS,
} from '../../shared/constants'
import { blueprintTotal } from '../../shared/types/exam'
import { findExam, touchExamVersion } from '../db/queries/exams'
import { deleteQuestionsNotIn, insertQuestion, normalizeStem } from '../db/queries/questions'
import {
  countRetryableBatches,
  countRunningJobs,
  findActiveJob,
  findJob,
  insertJob,
  listJobBatches,
  markBatchFailed,
  markBatchSucceeded,
  markJobFailed,
  markJobProgress,
  markJobSucceeded,
  planJobBatches,
  requeueJob,
  resetFailedBatchesToPending,
  type JobBatchRecord,
  type JobRecord,
} from '../db/queries/jobs'
import { findDocumentById, listDocuments } from '../db/queries/documents'
import { findProviderSettings } from '../db/queries/settings'
import { ApiFailure, throwApi } from '../utils/respond'
import { withTransaction } from '../utils/db'
import { shuffle } from '../utils/shuffle'
import { FieldErrors, isPlainObject, readExpectedVersion } from '../utils/validate'
import { buildBatchMessages } from '../ai/prompt'
import { parseBatchResponse } from '../ai/parser'
import { requestChatCompletion } from '../ai/client'
import { documentTexts, repairSourceRefs, validateSourceRefs } from './documents'
import { prepareQuestionInput, type PreparedQuestion } from './questions'
import { allocateUnits } from './grading'
import { readModelConfig } from './settings'
import { createJobOutputWriter } from './job-output'

export const TYPE_ORDER: QuestionType[] = ['single_choice', 'multiple_choice', 'true_false', 'fill_blank']

const BLUEPRINT_KEY: Record<QuestionType, keyof BlueprintDTO> = {
  single_choice: 'singleChoice',
  multiple_choice: 'multipleChoice',
  true_false: 'trueFalse',
  fill_blank: 'fillBlank',
}

export interface PlannedBatch {
  type: QuestionType
  size: number
}

export interface GenerationPlan {
  counts: Record<QuestionType, number>
  batches: PlannedBatch[]
  totalBatches: number
}

/** 按 §11.2 分批：扩充候选至多 60 题，但不少于目标题数；单批数量受常量限制。 */
export function planGeneration(blueprint: BlueprintDTO): GenerationPlan {
  const counts: Record<QuestionType, number> = {
    single_choice: blueprint.singleChoice,
    multiple_choice: blueprint.multipleChoice,
    true_false: blueprint.trueFalse,
    fill_blank: blueprint.fillBlank,
  }
  const batches: PlannedBatch[] = []
  for (const type of TYPE_ORDER) {
    const need = counts[type]
    if (need <= 0) continue
    const candidates = Math.max(need, Math.min(Math.ceil(need * CANDIDATE_FACTOR), MAX_CANDIDATES_PER_TYPE))
    let remaining = candidates
    while (remaining > 0) {
      const size = Math.min(MAX_BATCH_QUESTIONS, remaining)
      batches.push({ type, size })
      remaining -= size
    }
  }
  return { counts, batches, totalBatches: batches.length }
}

function blueprintCountsValid(blueprint: BlueprintDTO): boolean {
  const values = [blueprint.singleChoice, blueprint.multipleChoice, blueprint.trueFalse, blueprint.fillBlank]
  if (values.some((value) => !Number.isInteger(value) || value < 0)) return false
  const total = blueprintTotal(blueprint)
  return total >= 1 && total <= MAX_QUESTIONS
}

/**
 * 读取任务的批次行；006 之前创建的老任务没有行时按当前计划补写 pending 行。
 * 补写幂等，不会覆盖已有的 succeeded 结果。
 */
function ensureJobBatches(db: DatabaseSync, jobId: string, plan: GenerationPlan, now: number): JobBatchRecord[] {
  const rows = listJobBatches(db, jobId)
  if (rows.length > 0) return rows
  planJobBatches(db, jobId, toBatchPlan(plan), now)
  return listJobBatches(db, jobId)
}

function toBatchPlan(plan: GenerationPlan): Array<{ batchIndex: number; type: QuestionType; size: number }> {
  return plan.batches.map((batch, index) => ({ batchIndex: index, type: batch.type, size: batch.size }))
}

/**
 * 反序列化已成功批次的题目快照（契约 §10.3）。
 * 结构不符一律返回 null：宁可重新请求模型，也不把脏数据写进试卷。
 */
function decodeBatchQuestions(raw: string | null, expectedType: QuestionType): PreparedQuestion[] | null {
  if (raw === null || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const questions: PreparedQuestion[] = []
  for (const item of parsed) {
    if (!isPlainObject(item)) return null
    const type = item.type
    const stem = item.stem
    const explanation = item.explanation
    if (typeof type !== 'string' || !TYPE_ORDER.includes(type as QuestionType) || type !== expectedType) return null
    if (typeof stem !== 'string' || stem === '') return null
    if (typeof explanation !== 'string') return null
    if (!Array.isArray(item.options) || !Array.isArray(item.sourceRefs)) return null
    if (!isPlainObject(item.answerDefinition)) return null
    questions.push({
      existingId: typeof item.existingId === 'string' ? item.existingId : null,
      type: type as QuestionType,
      stem,
      options: item.options as PreparedQuestion['options'],
      answerDefinition: item.answerDefinition as unknown as PreparedQuestion['answerDefinition'],
      explanation,
      sourceRefs: item.sourceRefs as PreparedQuestion['sourceRefs'],
    })
  }
  return questions
}

/** 创建出题任务（§8.5 23） */
export function createGenerationJob(
  db: DatabaseSync,
  examId: string,
  body: Record<string, unknown>,
  now: number,
): JobRecord {
  const exam = findExam(db, examId)
  if (!exam) throwApi('NOT_FOUND', '考试场次不存在')
  if (exam.status !== 'draft') throwApi('EXAM_LOCKED', '已发布的考试不能重新出题', { reason: 'published' })
  const expectedVersion = readExpectedVersion(body)
  if (exam.version !== expectedVersion) {
    throwApi('VERSION_CONFLICT', '考试已被修改，请刷新后重试', { serverVersion: exam.version })
  }
  if (findActiveJob(db, exam.id)) {
    throwApi('EXAM_HAS_ACTIVE_JOB', '该场次已有进行中的出题任务')
  }
  const { config, missing } = readModelConfig(db)
  if (!config) throwApi('MODEL_NOT_CONFIGURED', '请先完成模型配置', { missing })
  const parsedDocuments = listDocuments(db, exam.id).filter((document) => document.status === 'parsed')
  const errors = new FieldErrors()
  if (parsedDocuments.length === 0) errors.add('documents', '请先上传并解析至少 1 份资料')
  if (!blueprintCountsValid(exam.blueprint)) errors.add('blueprint', '题量合计需在 1 到 100 道之间，且各题型数量不能为负')
  errors.throwIfAny()
  if (countRunningJobs(db) > 0) throwApi('JOB_BUSY', '已有出题任务正在执行，请稍后重试')

  const plan = planGeneration(exam.blueprint)
  const jobId = randomUUID()
  withTransaction(db, () => {
    if (findActiveJob(db, exam.id)) throwApi('EXAM_HAS_ACTIVE_JOB', '该场次已有进行中的出题任务')
    if (countRunningJobs(db) > 0) throwApi('JOB_BUSY', '已有出题任务正在执行，请稍后重试')
    insertJob(
      db,
      {
        id: jobId,
        examId: exam.id,
        inputVersion: exam.version,
        input: {
          blueprint: exam.blueprint,
          documentIds: parsedDocuments.map((document) => document.id),
          difficulty: exam.blueprint.difficulty,
          extraPrompt: exam.blueprint.extraPrompt,
        },
        progressTotal: plan.totalBatches,
      },
      now,
    )
    // 批次计划随任务一起落库（契约 §10.3）：重试时按行复用已成功批次
    planJobBatches(db, jobId, toBatchPlan(plan), now)
  })
  const created = findJob(db, jobId)
  if (!created) throw new ApiFailure('INTERNAL_ERROR', '出题任务创建失败')
  return created
}

/** 单批最多尝试次数：模型输出不稳定（超时/格式漂移/引用改写）时重试一次 */
const BATCH_MAX_ATTEMPTS = 2

const RETRYABLE_BATCH_CODES = new Set<string>(['UPSTREAM_TIMEOUT', 'UPSTREAM_BAD_RESPONSE', 'UPSTREAM_INVALID_RESPONSE', 'QUESTION_SET_INVALID'])

function isRetryableBatchError(error: unknown): boolean {
  return error instanceof ApiFailure && RETRYABLE_BATCH_CODES.has(error.code)
}

function failJob(db: DatabaseSync, jobId: string, error: unknown): void {
  const code = error instanceof ApiFailure ? error.code : 'INTERNAL_ERROR'
  const message = error instanceof ApiFailure ? error.message : '出题任务执行失败，请重试'
  markJobFailed(db, jobId, { errorCode: code, errorMessage: message, now: Date.now() })
}

/** 执行已领取的出题任务（§11.2）：全部批次成功才一次性写入题目 */
export async function executeGenerationJob(db: DatabaseSync, jobId: string): Promise<void> {
  const job = findJob(db, jobId)
  if (!job || job.status !== 'running') return
  // 模型原始输出实时落库（节流写入），供管理端轮询展示
  const output = createJobOutputWriter(db, jobId)
  try {
    const exam = findExam(db, job.examId)
    if (!exam) {
      markJobFailed(db, jobId, { errorCode: 'NOT_FOUND', errorMessage: '考试场次已不存在', now: Date.now() })
      return
    }
    if (exam.status !== 'draft') throw new ApiFailure('EXAM_LOCKED', '场次已发布，出题任务自动取消')
    if (exam.version !== job.inputVersion) {
      throw new ApiFailure('JOB_INPUT_STALE', '草稿在出题过程中被修改，请重新生成')
    }
    const settings = findProviderSettings(db)
    const modelId = job.modelId ?? settings.modelId
    const baseUrl = job.baseUrl ?? settings.baseUrl
    if (!modelId || !baseUrl) {
      throw new ApiFailure('MODEL_NOT_CONFIGURED', '模型配置不完整，请重新配置后重试')
    }

    const documents = job.input.documentIds.map((id) => findDocumentById(db, id))
    if (
      documents.length === 0 ||
      documents.some((document) => !document || document.examId !== exam.id || document.status !== 'parsed')
    ) {
      throw new ApiFailure('JOB_INPUT_STALE', '资料集合已变化，请重新生成')
    }
    const materials = documentTexts(
      db,
      documents.filter((document) => document !== undefined).map((document) => document.id),
    )
    const plan = planGeneration(job.input.blueprint)
    // 批次行是重试复用的依据；老任务（006 之前创建）缺行时按当前计划补写 pending 行
    const savedBatches = new Map(
      ensureJobBatches(db, jobId, plan, Date.now()).map((savedBatch) => [savedBatch.batchIndex, savedBatch]),
    )
    const collected = new Map<QuestionType, PreparedQuestion[]>()
    let progress = 0
    let questionIndex = 0

    for (const batch of plan.batches) {
      // 每轮进度恰好加一，故 progress 就是当前批次下标（与 plan.batches 一一对应）
      const batchIndex = progress
      // 已成功的批次直接复用上次落库的题目，不再请求模型（契约 §10.3）
      const saved = savedBatches.get(batchIndex)
      if (saved && saved.status === 'succeeded') {
        const reused = decodeBatchQuestions(saved.questionsJson, batch.type)
        if (reused !== null) {
          questionIndex += reused.length
          const bucket = collected.get(batch.type) ?? []
          bucket.push(...reused)
          collected.set(batch.type, bucket)
          progress += 1
          markJobProgress(db, jobId, progress)
          output.push(
            `\n\n──── 第 ${progress}/${plan.batches.length} 批（${QUESTION_TYPE_LABELS[batch.type]} ×${batch.size}）复用上次成功结果 ────\n`,
          )
          output.flush()
          continue
        }
        console.warn(`[generation] 第 ${progress + 1} 批的批次快照不可用，重新请求模型`)
      }
      const messages = buildBatchMessages({
        examTitle: exam.title,
        type: batch.type,
        count: batch.size,
        difficulty: job.input.difficulty,
        extraPrompt: job.input.extraPrompt,
        materials,
      })
      const runBatch = async (): Promise<PreparedQuestion[]> => {
        const raw = await requestChatCompletion({
          baseUrl,
          apiKey: settings.apiKey ?? '',
          modelId,
          thinking: settings.thinkingLevel,
          messages,
          // 增量片段直接进节流写入器，前端轮询即可看到模型原始输出
          onDelta: (chunk) => output.push(chunk),
        })
        const items = parseBatchResponse(raw, batch.type, batch.size)
        const prepared: PreparedQuestion[] = []
        for (const item of items) {
          const index = questionIndex + prepared.length
          const question = prepareQuestionInput(item, index)
          // 模型偶尔改写摘录或错标 locator：先回退到资料原文，再按 §7.4 严格校验
          const repair = repairSourceRefs(db, exam.id, question.sourceRefs)
          if (repair.repaired > 0) {
            console.warn(`[generation] 第 ${index + 1} 题引用摘录已回退为资料原文（${repair.repaired} 处）`)
          }
          validateSourceRefs(db, exam.id, repair.refs, index)
          prepared.push({ ...question, sourceRefs: repair.refs })
        }
        return prepared
      }
      let prepared: PreparedQuestion[] | null = null
      let lastError: unknown = null
      let attemptsMade = 0
      for (let attempt = 0; attempt < BATCH_MAX_ATTEMPTS; attempt += 1) {
        // 批次分隔标题（管理端展示用）：立即落库，让轮询马上看到进度变化
        output.push(
          attempt === 0
            ? `\n\n──── 第 ${progress + 1}/${plan.batches.length} 批（${QUESTION_TYPE_LABELS[batch.type]} ×${batch.size}）────\n`
            : `\n──── 第 ${progress + 1} 批重试 ${attempt + 1}/${BATCH_MAX_ATTEMPTS} ────\n`,
        )
        output.flush()
        attemptsMade += 1
        try {
          prepared = await runBatch()
          lastError = null
          break
        } catch (error) {
          lastError = error
          // 模型输出不稳定：超时、格式错误、引用未命中都值得重试一次
          if (!isRetryableBatchError(error) || attempt === BATCH_MAX_ATTEMPTS - 1) break
          console.warn(`[generation] 第 ${progress + 1} 批重试（${attempt + 1}/${BATCH_MAX_ATTEMPTS}）`)
        }
      }
      if (prepared === null) {
        // 失败也要留证据：批次行记 failed + 错误码，attempts 记本批实际请求次数
        const code = lastError instanceof ApiFailure ? lastError.code : 'INTERNAL_ERROR'
        const message = lastError instanceof ApiFailure ? lastError.message : '出题任务执行失败，请重试'
        markBatchFailed(db, jobId, batchIndex, code, message, attemptsMade, Date.now())
        if (lastError instanceof ApiFailure) {
          throw new ApiFailure(
            lastError.code,
            `第 ${progress + 1} 批${QUESTION_TYPE_LABELS[batch.type]}生成失败：${lastError.message}`,
            lastError.details,
          )
        }
        throw lastError ?? new ApiFailure('INTERNAL_ERROR', '出题任务执行失败，请重试')
      }
      questionIndex += prepared.length
      const bucket = collected.get(batch.type) ?? []
      bucket.push(...prepared)
      collected.set(batch.type, bucket)
      progress += 1
      markJobProgress(db, jobId, progress)
      // 成功即落库：后续批次失败也不影响这批结果，重试时直接复用
      markBatchSucceeded(db, jobId, batchIndex, JSON.stringify(prepared), Date.now())
    }

    const picked: PreparedQuestion[] = []
    const seenStems = new Set<string>()
    for (const type of TYPE_ORDER) {
      const need = plan.counts[type]
      if (need <= 0) continue
      const candidates = shuffle(collected.get(type) ?? [])
      const chosen: PreparedQuestion[] = []
      for (const candidate of candidates) {
        const key = normalizeStem(candidate.stem)
        if (seenStems.has(key)) continue
        seenStems.add(key)
        chosen.push(candidate)
        if (chosen.length === need) break
      }
      if (chosen.length < need) {
        // 该题型有效题不足：把它所有批次标回 pending，重试时整型重新生成才有机会补量（契约 §10.3）
        resetFailedBatchesToPending(db, jobId, [type], Date.now())
        throw new ApiFailure(
          'QUESTION_SET_INVALID',
          `${QUESTION_TYPE_LABELS[type]}有效题目不足：需要 ${need} 道，仅得到 ${chosen.length} 道，请重试`,
        )
      }
      picked.push(...chosen)
    }

    const units = allocateUnits(SCORE_TOTAL_UNITS, picked.length)
    withTransaction(db, () => {
      const fresh = findExam(db, exam.id)
      if (!fresh) throw new ApiFailure('NOT_FOUND', '考试场次已不存在')
      if (fresh.status !== 'draft') throw new ApiFailure('EXAM_LOCKED', '场次已发布，出题结果未写入')
      if (fresh.version !== job.inputVersion) {
        throw new ApiFailure('JOB_INPUT_STALE', '草稿已被修改，出题结果未写入')
      }
      deleteQuestionsNotIn(db, exam.id, [])
      picked.forEach((question, index) => {
        insertQuestion(
          db,
          {
            id: randomUUID(),
            examId: exam.id,
            position: index + 1,
            type: question.type,
            stem: question.stem,
            options: question.options,
            answerDefinition: question.answerDefinition,
            explanation: question.explanation,
            sourceRefs: question.sourceRefs,
            maxScoreUnits: units[index] ?? 0,
          },
          Date.now(),
        )
      })
      touchExamVersion(db, exam.id, Date.now())
    })
    markJobSucceeded(db, jobId, Date.now())
  } catch (error) {
    failJob(db, jobId, error)
  } finally {
    // 成功/失败都落库：失败时同样保留已收集的模型原始输出（不清空）
    output.dispose()
  }
}

export interface RetryGenerationJobResult {
  job: JobRecord
  /** 本次会真正请求模型的批次数：已成功批次复用落库结果，不计入（契约 §10.3） */
  retriedBatches: number
}

/**
 * 重试失败的出题任务（§8.7 32 / §10.3）：仅 failed、草稿与资料未变化、无活动任务。
 * 不清空已成功批次：它们保留在 job_batches 里，执行时直接复用，重试只补失败/未完成的批次。
 */
export function retryGenerationJob(db: DatabaseSync, jobId: string, now: number): RetryGenerationJobResult {
  const job = findJob(db, jobId)
  if (!job) throwApi('NOT_FOUND', '出题任务不存在')
  if (job.status !== 'failed') throwApi('JOB_NOT_RETRYABLE', '只有失败的任务可以重试')
  const exam = findExam(db, job.examId)
  if (!exam) throwApi('NOT_FOUND', '考试场次不存在')
  if (exam.status !== 'draft') throwApi('EXAM_LOCKED', '已发布的考试不能重新出题', { reason: 'published' })
  if (exam.version !== job.inputVersion) throwApi('JOB_INPUT_STALE', '草稿已修改，请重新发起出题')
  const currentIds = listDocuments(db, exam.id)
    .filter((document) => document.status === 'parsed')
    .map((document) => document.id)
    .sort()
  const snapshotIds = [...job.input.documentIds].sort()
  if (
    currentIds.length !== snapshotIds.length ||
    currentIds.some((documentId, index) => documentId !== snapshotIds[index])
  ) {
    throwApi('JOB_INPUT_STALE', '资料集合已变化，请重新发起出题')
  }
  if (findActiveJob(db, exam.id)) throwApi('JOB_BUSY', '该场次已有进行中的出题任务')
  if (countRunningJobs(db) > 0) throwApi('JOB_BUSY', '已有出题任务正在执行，请稍后重试')
  // 老任务可能没有批次行：先按当前计划补写，保证「只重跑未成功批次」对历史任务同样成立
  const batches = ensureJobBatches(db, jobId, planGeneration(job.input.blueprint), now)
  const succeeded = batches.filter((batch) => batch.status === 'succeeded').length
  const retriedBatches = countRetryableBatches(db, jobId)
  // progress_done 从已成功批次续跑，前端进度条不会回退到 0
  if (!requeueJob(db, jobId, succeeded)) throwApi('JOB_BUSY', '任务状态已变化，请刷新后重试')
  const fresh = findJob(db, jobId)
  if (!fresh) throwApi('NOT_FOUND', '出题任务不存在')
  return { job: fresh, retriedBatches }
}
