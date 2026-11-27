import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { BankGenerationIssue, BankGenerationJobDTO, BankGenerationRequest, BankQuestionInput } from '../../shared/types/question-bank'
import type { ApiErrorCode } from '../../shared/types/common'
import { QUESTION_TYPES } from '../../shared/types/question'
import { DIFFICULTIES, MAX_EXTRA_PROMPT_CHARS, MAX_DOCUMENTS_PER_EXAM } from '../../shared/constants'
import { findBankDuplicate, findBankRecord, insertBankRecord, listBankRecords } from '../db/queries/question-bank'
import { saveGenerationSource } from '../db/queries/bank-generation-sources'
import { requestChatCompletion, type ChatMessage, type ModelConfig } from '../ai/client'
import { buildBankAnalysisMessages, buildBankMessages } from '../ai/prompt'
import { normalizeModelQuestionType, parseBatchResponse, stripCodeFence } from '../ai/parser'
import { readModelConfig } from './settings'
import { bankContentKey, bankComparableKey } from './question-bank-stats'
import { knowledgePoints, prepareBankQuestion, validateBankSources } from './question-bank'
import { bankSourceGroupKey } from './bank-selection'
import { bankAnalysisMaterial, generationIssues, generationProgress, generationSourceRefs, normalizeSourceRequests,
  parseBankGenerationPlan, requestSettled, resolveGenerationSourceGroup, sourceOutcomes, sourceRequestCount,
  type BankGenerationPlan, type GenerationSource } from './bank-generation-plan'
import { prepareBankSupplement } from './bank-supplement'
import { markedDocumentPlan, markedBlankTemplates, markedSourceTypes } from './marked-document'
import { ApiFailure } from '../utils/respond'
import { FieldErrors, isPlainObject } from '../utils/validate'
import { withTransaction } from '../utils/db'

/** 每个模型请求最多 3 次尝试：首次 + 2 次重试，超过即记入问题清单并继续后面的请求。 */
const REQUEST_ATTEMPTS = 3
/** 上游超时/限流后的等待间隔逐次递增，仍然有界。 */
const RETRY_DELAY_MS = 1000
/**
 * 只有一次模型输出或上游抖动造成的错误值得重试；鉴权、模型未配置、来源被改这类问题
 * 重试也不会好转，直接结束任务，避免无效地遍历所有来源。
 */
const RETRYABLE_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>(['UPSTREAM_TIMEOUT', 'UPSTREAM_RATE_LIMIT',
  'UPSTREAM_ERROR', 'UPSTREAM_INVALID_RESPONSE', 'QUESTION_SET_INVALID', 'VALIDATION_FAILED'])

function generationErrorMessage(error: unknown): string {
  const fields = error instanceof ApiFailure && isPlainObject(error.details) && isPlainObject(error.details.fields)
    ? Object.values(error.details.fields).filter((value) => typeof value === 'string') : []
  return fields.length ? fields.join('；') : error instanceof ApiFailure ? error.message : '题库生成发生内部错误，请重试'
}

/** 当前执行器已被热重载或手动重试替换：静默退出，不能再把结果写到任务上。 */
class StaleOwner extends Error {}

interface PreparedBatch {
  /** 模型返回的题目条数（含重复跳过与答案冲突） */
  count: number
  questions: BankQuestionInput[]
  reason: string
}

/**
 * 单个模型请求的尝试循环：校验失败时把具体错误反馈给模型促其修正，短暂故障等待后重试。
 * `track` 记录已尝试次数，供重试耗尽后的失败清单使用。
 */
async function requestWithRetry<T>(config: ModelConfig, messages: ChatMessage[], ownsJob: () => boolean,
  read: (raw: string) => T, track?: { attempts: number }): Promise<T> {
  let conversation = messages
  let lastError: ApiFailure | null = null
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt++) {
    if (track) track.attempts = attempt
    let raw = ''
    try {
      raw = await requestChatCompletion({ ...config, messages: conversation })
      if (!ownsJob()) throw new StaleOwner()
      return read(raw)
    } catch (error) {
      if (error instanceof StaleOwner || !(error instanceof ApiFailure) || !RETRYABLE_CODES.has(error.code)) throw error
      lastError = error
      if (attempt === REQUEST_ATTEMPTS) break
      // 拿得到上次输出才能把校验错误具体反馈回去；连不上上游时只等待后重试。
      if (raw) conversation = [...messages, { role: 'assistant', content: raw.slice(0, 6000) },
        { role: 'user', content: `上一次输出未通过校验：${generationErrorMessage(error)}\n请修正后重新输出 JSON，只输出 JSON。` }]
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt))
      if (!ownsJob()) throw new StaleOwner()
    }
  }
  throw lastError!
}

/** 本轮已遍历结束但仍有失败请求：用既有 failed 状态与汇总说明表达，不伪报全部成功。 */
function failureSummary(issues: BankGenerationIssue[]): string {
  const first = issues[0]!
  const summary = issues.every((issue) => issue.attempts === REQUEST_ATTEMPTS)
    ? `${issues.length} 个模型请求尝试 ${REQUEST_ATTEMPTS} 次仍失败` : `${issues.length} 个出题请求仍失败`
  return `本轮已遍历全部来源，${summary}（首个：来源「${first.sourceTitle}」`
    + `第 ${first.requestIndex} 个请求：${first.message}）。已成功的请求保留，可只重试失败部分。`
}

interface JobRow {
  id: string; status: BankGenerationJobDTO['status']; input_json: string; progress_done: number
  progress_total: number; created_count: number; error_message: string; created_at: number
  plan_json: string | null
}
function jobDTO(row: JobRow): BankGenerationJobDTO {
  const input = JSON.parse(row.input_json) as BankGenerationRequest
  const plan = row.plan_json ? JSON.parse(row.plan_json) as BankGenerationPlan : null
  const generatedCount = plan ? plan.sources.reduce((sum, source) => sum + source.generatedCount, 0) : row.created_count
  const createdCount = plan !== null || row.status === 'succeeded' ? row.created_count : 0
  const conflicts = plan?.conflicts ?? []
  const issues = plan ? generationIssues(plan) : []
  if (row.status === 'failed' && row.error_message && (!issues.length || row.error_message !== failureSummary(issues))) {
    issues.push({ sourceTitle: plan ? '任务执行' : '全文梳理', requestIndex: null, attempts: null, message: row.error_message })
  }
  return { id: row.id, status: row.status,
    input: input.mode === 'supplement' ? input : { libraryFileIds: input.libraryFileIds, documentMode: input.documentMode ?? 'standard', difficulty: input.difficulty, extraPrompt: input.extraPrompt },
    stage: plan !== null || row.status === 'succeeded' ? 'generation' : 'analysis',
    progressDone: row.progress_done, progressTotal: row.progress_total, generatedCount, createdCount,
    duplicateCount: plan ? generatedCount - createdCount - conflicts.length : 0,
    requestedCount: input.mode === 'supplement' ? input.quantity.mode === 'auto' ? input.quantity.total : Object.values(input.quantity.counts).reduce((sum, count) => sum + count, 0)
      : input.documentMode === 'marked' && plan ? generationProgress(plan).total : null,
    conflicts,
    sources: plan?.sources.map((source) => ({ id: source.id ?? null, title: source.title, knowledgePoint: source.knowledgePoint,
      fileName: source.segments[0]!.fileName, locators: [...new Set(source.segments.map((segment) => segment.locator))],
      completed: source.completed, failedCount: sourceOutcomes(source).filter((result) => result.status === 'failed').length,
      generatedCount: source.generatedCount, createdCount: source.createdCount,
      requestedCount: input.mode === 'supplement' || source.markedRules ? source.batches?.reduce((sum, batch) => sum + batch.total, 0) ?? null : null,
      shortfallReason: source.shortfallReason ?? '', markedRules: source.markedRules })) ?? [],
    ignored: plan?.ignored ?? [],
    issues,
    errorMessage: row.error_message, createdAt: row.created_at }
}
export function latestBankGeneration(db: DatabaseSync): BankGenerationJobDTO | null {
  const row = db.prepare(`SELECT * FROM bank_generation_jobs
    ORDER BY CASE WHEN status IN ('queued', 'running') THEN 0 ELSE 1 END, updated_at DESC, created_at DESC, id DESC LIMIT 1`).get() as JobRow | undefined
  return row ? jobDTO(row) : null
}

export function createBankGeneration(db: DatabaseSync, body: Record<string, unknown>, now: number): BankGenerationJobDTO {
  const errors = new FieldErrors()
  const difficulty = errors.oneOf(body, 'difficulty', '难度', DIFFICULTIES) ?? 'normal'
  const extraPrompt = errors.text(body, 'extraPrompt', '补充要求', { max: MAX_EXTRA_PROMPT_CHARS, trim: true }) ?? ''
  const mode = errors.oneOf(body, 'mode', '生成模式', ['files', 'supplement'] as const) ?? 'files'
  errors.throwIfAny()
  let input: BankGenerationRequest
  let plan: BankGenerationPlan | null = null
  if (mode === 'supplement') {
    const prepared = prepareBankSupplement(db, body, difficulty, extraPrompt)
    input = prepared.input
    plan = prepared.plan
  } else {
    const ids = body.libraryFileIds
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_DOCUMENTS_PER_EXAM || ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new ApiFailure('VALIDATION_FAILED', '请选择 1–5 份不重复的资料')
    const documentMode = errors.oneOf(body, 'documentMode', '资料规则', ['standard', 'marked'] as const) ?? 'standard'
    errors.throwIfAny()
    if (documentMode === 'marked') plan = markedDocumentPlan(db, ids as string[])
    else bankAnalysisMaterial(db, ids as string[])
    input = { libraryFileIds: ids as string[], documentMode, difficulty, extraPrompt }
  }
  if (!readModelConfig(db).config) throw new ApiFailure('MODEL_NOT_CONFIGURED', '请先完成模型设置')
  withTransaction(db, () => {
    if (db.prepare("SELECT id FROM bank_generation_jobs WHERE status IN ('queued', 'running')").get()) throw new ApiFailure('JOB_BUSY', '已有题库生成任务，请等待完成')
    if (plan) for (const source of plan.sources) {
      normalizeSourceRequests(source, false)
      source.id = saveGenerationSource(db, source, now)
    }
    db.prepare("INSERT INTO bank_generation_jobs(id, status, input_json, plan_json, progress_total, created_at, updated_at) VALUES (?, 'queued', ?, ?, ?, ?, ?)")
      .run(randomUUID(), JSON.stringify(input), plan ? JSON.stringify(plan) : null, plan ? generationProgress(plan).total : 0, now, now)
  })
  return latestBankGeneration(db)!
}

export function retryBankGeneration(db: DatabaseSync, id: string, now: number): BankGenerationJobDTO {
  return withTransaction(db, () => {
    const job = db.prepare('SELECT * FROM bank_generation_jobs WHERE id = ?').get(id) as JobRow | undefined
    if (!job) throw new ApiFailure('NOT_FOUND', '题库生成任务不存在')
    if (job.status !== 'failed') throw new ApiFailure('VERSION_CONFLICT', '任务状态已变化，请刷新后操作')
    if (db.prepare("SELECT id FROM bank_generation_jobs WHERE status IN ('queued', 'running')").get()) throw new ApiFailure('JOB_BUSY', '已有题库生成任务，请等待完成')
    if (!readModelConfig(db).config) throw new ApiFailure('MODEL_NOT_CONFIGURED', '请先完成模型设置')
    const input = jobDTO(job).input
    const plan = job.plan_json ? JSON.parse(job.plan_json) as BankGenerationPlan : null
    // 只把失败请求退回待处理：成功的请求保留结果，不重复生成；成功项的未解决错误随之清除。
    // 先展开逐请求状态，下面只校验这次真要重跑的来源。
    if (plan) for (const source of plan.sources) normalizeSourceRequests(source, true)
    if (input.mode === 'supplement') {
      if (plan) for (const source of plan.sources.filter((entry) => !entry.completed)) validateBankSources(db, generationSourceRefs(source))
    } else bankAnalysisMaterial(db, input.libraryFileIds)
    const progress = plan ? generationProgress(plan) : { done: 0, total: 0 }
    db.prepare("UPDATE bank_generation_jobs SET status = 'queued', error_message = '', run_token = NULL, plan_json = ?, progress_done = ?, progress_total = ?, created_count = ?, updated_at = ? WHERE id = ?")
      .run(plan ? JSON.stringify(plan) : null, progress.done, progress.total, plan ? job.created_count : 0, now, id)
    return jobDTO(db.prepare('SELECT * FROM bank_generation_jobs WHERE id = ?').get(id) as JobRow)
  })
}

/** 全文梳理一次，再逐来源逐请求生成；每个请求的题目和进度一起提交，可继续失败与未处理部分。 */
export async function executeNextBankGeneration(db: DatabaseSync): Promise<void> {
  const job = db.prepare("SELECT * FROM bank_generation_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as JobRow | undefined
  if (!job) return
  const token = randomUUID()
  const claimed = withTransaction(db, () => db.prepare("UPDATE bank_generation_jobs SET status = 'running', run_token = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(token, Date.now(), job.id).changes)
  if (!claimed) return
  // 每次写库前都确认 run_token 仍属于自己：跨自动重试与等待也不能让旧执行器提交。
  const ownsJob = () => Boolean(db.prepare("SELECT id FROM bank_generation_jobs WHERE id = ? AND status = 'running' AND run_token = ?").get(job.id, token))
  const guard = (): void => { if (!ownsJob()) throw new StaleOwner() }
  const input = jobDTO(job).input
  let currentSource = ''
  const analysisTrack = { attempts: 0 }
  try {
    const config = readModelConfig(db).config
    if (!config) throw new ApiFailure('MODEL_NOT_CONFIGURED', '模型设置不完整，请配置后重新生成')
    let plan = job.plan_json ? JSON.parse(job.plan_json) as BankGenerationPlan : null
    if (!plan) {
      if (input.mode === 'supplement') throw new ApiFailure('QUESTION_SET_INVALID', '补题任务缺少来源快照，请重新创建任务')
      const material = bankAnalysisMaterial(db, input.libraryFileIds)
      // 全文梳理没有可跳过的来源：重试耗尽仍失败就明确结束并显示错误。
      const analyzed = await requestWithRetry(config, buildBankAnalysisMessages(material, knowledgePoints(db)), ownsJob,
        (raw) => parseBankGenerationPlan(raw, material, listBankRecords(db, { libraryFileIds: input.libraryFileIds }), knowledgePoints(db)), analysisTrack)
      plan = analyzed
      withTransaction(db, () => {
        guard()
        validateBankSources(db, analyzed.sources.flatMap(generationSourceRefs))
        for (const source of analyzed.sources) {
          normalizeSourceRequests(source, false)
          source.id = saveGenerationSource(db, source, Date.now())
        }
        const progress = generationProgress(analyzed)
        db.prepare('UPDATE bank_generation_jobs SET plan_json = ?, progress_done = ?, progress_total = ?, created_count = 0, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(analyzed), progress.done, progress.total, Date.now(), job.id)
      })
    }
    const jobPlan: BankGenerationPlan = plan
    // 旧任务保留成功批次，只把失败或未完成的题量拆成单题请求。
    for (const source of jobPlan.sources) normalizeSourceRequests(source, false)
    const commitPlan = (source: GenerationSource | null, created: number): void => {
      guard()
      if (source) source.id = saveGenerationSource(db, source, Date.now())
      const progress = generationProgress(jobPlan)
      db.prepare('UPDATE bank_generation_jobs SET plan_json = ?, progress_done = ?, progress_total = ?, created_count = created_count + ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(jobPlan), progress.done, progress.total, created, Date.now(), job.id)
    }
    // 进度先按逐请求口径落库，旧任务的来源数口径不会让进度停在 100% 之前。
    withTransaction(db, () => commitPlan(null, 0))
    for (const [index, source] of jobPlan.sources.entries()) {
      if (source.completed) continue
      currentSource = `第 ${index + 1} 个来源「${source.title}」`
      const sourceRefs = generationSourceRefs(source)
      for (let requestIndex = 0; requestIndex < sourceRequestCount(source); requestIndex++) {
        guard()
        // 已定论的请求（成功或按原语义跳过）只写一次，重试与继续时不重发。
        if (requestSettled(source, requestIndex)) continue
        const quota = source.batches![requestIndex]!
        // 资料被删等来源侧问题对后续请求同样成立：先校验，不要白跑模型请求。
        validateBankSources(db, sourceRefs)
        const pool = listBankRecords(db, { libraryFileIds: [source.segments[0]!.fileId] })
        source.sourceGroup = resolveGenerationSourceGroup(source, pool)
        const groupKey = bankSourceGroupKey({ id: '', sourceGroup: source.sourceGroup, sourceRefs })
        const existing = pool.filter((item) => bankSourceGroupKey(item) === groupKey)
        const requestedType = quota.counts ? QUESTION_TYPES.find((type) => quota.counts![type] > 0) : undefined
        const allowedTypes = source.markedRules ? markedSourceTypes(source) : QUESTION_TYPES
        const messages = buildBankMessages({ difficulty: input.difficulty, extraPrompt: input.extraPrompt,
          title: source.title, knowledgePoint: source.knowledgePoint, materials: source.segments,
          type: requestedType, allowedTypes, markedRules: source.markedRules,
          existingQuestions: existing.map((item) => ({ type: item.type, stem: item.stem, options: item.options, answerDefinition: item.answerDefinition })),
        })
        const readBatch = (raw: string): PreparedBatch => {
          let parsed: unknown
          try { parsed = JSON.parse(stripCodeFence(raw)) as unknown }
          catch { throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '模型未返回合法的题目 JSON') }
          const list = isPlainObject(parsed) && Array.isArray(parsed.questions) ? parsed.questions : parsed
          if (!Array.isArray(list) || list.length > 1) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '本次只能返回一道题，questions 必须是长度为 0 或 1 的数组')
          const counts = { single_choice: 0, multiple_choice: 0, true_false: 0, fill_blank: 0 }
          const questions = list.map((item: unknown, questionIndex) => {
            if (!isPlainObject(item)) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', `第 ${questionIndex + 1} 题不是题目对象`)
            const type = normalizeModelQuestionType(item.type)
            if (type === null) {
              const returnedType = typeof item.type === 'string' ? JSON.stringify(item.type.slice(0, 60)) : String(item.type)
              throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', `第 ${questionIndex + 1} 题的 type=${returnedType} 不支持；应为 ${QUESTION_TYPES.join(' / ')}`)
            }
            if (!allowedTypes.includes(type) || source.markedRules && type === 'fill_blank') throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '标记资料的填空由程序按 <> 生成，模型只能生成允许的判断或选择题')
            counts[type]++
            if (quota.counts && counts[type] > quota.counts[type]) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '模型返回的题型不符合本次补题要求')
            const normalized = parseBatchResponse(JSON.stringify([{ ...item, type, sourceRefs }]), type, 1)[0]!
            return prepareBankQuestion(db, { ...normalized, sourceGroup: source.sourceGroup,
              knowledgePoint: source.knowledgePoint, difficulty: input.difficulty, sourceRefs })
          })
          const reason = isPlainObject(parsed) && typeof parsed.reason === 'string' && parsed.reason.trim()
            ? parsed.reason.trim().slice(0, 500) : '本次未生成合适的新题，未强行凑题'
          return { count: list.length, questions, reason }
        }
        const track = { attempts: 0 }
        let batch: PreparedBatch
        try {
          if (source.markedRules && requestedType === 'fill_blank') {
            const existingKeys = new Set(existing.map(bankContentKey))
            const template = markedBlankTemplates(source)[quota.blankTemplateIndex ?? -1]
            const content = template && !existingKeys.has(bankContentKey(template)) ? template : undefined
            batch = { count: content ? 1 : 0, questions: content ? [prepareBankQuestion(db, { ...content,
              sourceGroup: source.sourceGroup, knowledgePoint: source.knowledgePoint, difficulty: input.difficulty, sourceRefs })] : [],
              reason: '此来源的指定填空均已入库，没有额外挖空或重复生成' }
          } else batch = await requestWithRetry(config, messages, ownsJob, readBatch, track)
        } catch (error) {
          if (error instanceof StaleOwner) return
          if (!(error instanceof ApiFailure) || !RETRYABLE_CODES.has(error.code)) throw error
          // 重试耗尽：记下来源、请求序号、尝试次数与可读错误，再处理后续请求与来源。
          withTransaction(db, () => {
            const result = source.requests![requestIndex]!
            result.status = 'failed'
            result.attempts = track.attempts
            result.message = generationErrorMessage(error)
            source.completed = source.requests!.every((entry) => entry.status !== 'pending')
            commitPlan(null, 0)
          })
          continue
        }
        withTransaction(db, () => {
          validateBankSources(db, sourceRefs)
          // 管理员在模型请求期间改了同源分组时，要求重新发起，不能写回旧分组。
          if (resolveGenerationSourceGroup(source, listBankRecords(db, { libraryFileIds: [source.segments[0]!.fileId] })) !== source.sourceGroup) throw new ApiFailure('VERSION_CONFLICT', '来源分组已被修改，请重新发起补题')
          let created = 0
          for (const question of batch.questions) {
            const key = bankContentKey(question)
            const duplicate = findBankDuplicate(db, key)
            if (duplicate) {
              const original = findBankRecord(db, duplicate.id)!
              if (bankComparableKey(original) !== bankComparableKey(question)) {
                jobPlan.conflicts ??= []
                jobPlan.conflicts.push({ itemId: original.id, sourceTitle: source.title, type: question.type, stem: question.stem,
                  existingAnswer: original.answerDefinition, generatedAnswer: question.answerDefinition })
              }
              continue
            }
            insertBankRecord(db, randomUUID(), question, key, Date.now())
            created++
          }
          source.generatedCount += batch.count
          source.createdCount += created
          const result = source.requests![requestIndex]!
          result.status = 'succeeded'
          result.attempts = track.attempts
          delete result.message
          if (batch.count === 0) source.shortfallReason = batch.reason
          // 自动题型返回空数组表示来源已无合适新题，停止追加；指定题型继续处理其他单题请求。
          if (!quota.counts && batch.count === 0) {
            for (const rest of source.requests!.slice(requestIndex + 1)) {
              if (rest.status !== 'pending') continue
              rest.status = 'skipped'
              rest.attempts = 0
            }
          }
          source.completed = source.requests!.every((entry) => entry.status !== 'pending')
          commitPlan(source, created)
        })
      }
    }
    const issues = generationIssues(jobPlan)
    withTransaction(db, () => {
      guard()
      // 本轮已遍历结束但仍有未解决请求：保持 failed + 汇总说明，不伪报全部成功。
      if (issues.length) db.prepare("UPDATE bank_generation_jobs SET status = 'failed', error_message = ?, run_token = NULL, updated_at = ? WHERE id = ?")
        .run(failureSummary(issues), Date.now(), job.id)
      else db.prepare("UPDATE bank_generation_jobs SET status = 'succeeded', run_token = NULL, updated_at = ? WHERE id = ?")
        .run(Date.now(), job.id)
    })
  } catch (error) {
    if (error instanceof StaleOwner) return
    if (!(error instanceof ApiFailure)) console.error('[bank-generation] 任务执行失败', error)
    const message = generationErrorMessage(error)
    const prefix = currentSource || (analysisTrack.attempts ? `全文梳理（已尝试 ${analysisTrack.attempts} 次）` : '')
    withTransaction(db, () => {
      db.prepare("UPDATE bank_generation_jobs SET status = 'failed', error_message = ?, run_token = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND run_token = ?")
        .run(prefix ? `${prefix}：${message}` : message, Date.now(), job.id, token)
    })
  }
}
