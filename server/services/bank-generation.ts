import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { BankGenerationJobDTO, BankGenerationRequest } from '../../shared/types/question-bank'
import { QUESTION_TYPES } from '../../shared/types/question'
import { DIFFICULTIES, MAX_BATCH_QUESTIONS, MAX_EXTRA_PROMPT_CHARS, MAX_DOCUMENTS_PER_EXAM } from '../../shared/constants'
import { findBankDuplicate, findBankRecord, insertBankRecord, listBankRecords } from '../db/queries/question-bank'
import { saveGenerationSource } from '../db/queries/bank-generation-sources'
import { requestChatCompletion } from '../ai/client'
import { buildBankAnalysisMessages, buildBankMessages } from '../ai/prompt'
import { normalizeModelQuestionType, parseBatchResponse, stripCodeFence } from '../ai/parser'
import { readModelConfig } from './settings'
import { bankContentKey, bankComparableKey } from './question-bank-stats'
import { knowledgePoints, prepareBankQuestion, validateBankSources } from './question-bank'
import { bankSourceGroupKey } from './bank-selection'
import { bankAnalysisMaterial, generationSourceRefs, parseBankGenerationPlan, resolveGenerationSourceGroup, type BankGenerationPlan } from './bank-generation-plan'
import { prepareBankSupplement } from './bank-supplement'
import { ApiFailure } from '../utils/respond'
import { FieldErrors, isPlainObject } from '../utils/validate'
import { withTransaction } from '../utils/db'

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
  return { id: row.id, status: row.status,
    input: input.mode === 'supplement' ? input : { libraryFileIds: input.libraryFileIds, difficulty: input.difficulty, extraPrompt: input.extraPrompt },
    stage: plan !== null || row.status === 'succeeded' ? 'generation' : 'analysis',
    progressDone: row.progress_done, progressTotal: row.progress_total, generatedCount, createdCount,
    duplicateCount: plan ? generatedCount - createdCount - conflicts.length : 0,
    requestedCount: input.mode === 'supplement' ? input.quantity.mode === 'auto' ? input.quantity.total : Object.values(input.quantity.counts).reduce((sum, count) => sum + count, 0) : null,
    conflicts,
    sources: plan?.sources.map((source) => ({ id: source.id ?? null, title: source.title, knowledgePoint: source.knowledgePoint,
      fileName: source.segments[0]!.fileName, locators: [...new Set(source.segments.map((segment) => segment.locator))],
      completed: source.completed, generatedCount: source.generatedCount, createdCount: source.createdCount,
      requestedCount: source.batches?.reduce((sum, batch) => sum + batch.total, 0) ?? null, shortfallReason: source.shortfallReason ?? '' })) ?? [],
    ignored: plan?.ignored ?? [],
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
    bankAnalysisMaterial(db, ids as string[])
    input = { libraryFileIds: ids as string[], difficulty, extraPrompt }
  }
  if (!readModelConfig(db).config) throw new ApiFailure('MODEL_NOT_CONFIGURED', '请先完成模型设置')
  withTransaction(db, () => {
    if (db.prepare("SELECT id FROM bank_generation_jobs WHERE status IN ('queued', 'running')").get()) throw new ApiFailure('JOB_BUSY', '已有题库生成任务，请等待完成')
    if (plan) for (const source of plan.sources) source.id = saveGenerationSource(db, source, now)
    db.prepare("INSERT INTO bank_generation_jobs(id, status, input_json, plan_json, progress_total, created_at, updated_at) VALUES (?, 'queued', ?, ?, ?, ?, ?)")
      .run(randomUUID(), JSON.stringify(input), plan ? JSON.stringify(plan) : null, plan?.sources.length ?? 0, now, now)
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
    if (input.mode === 'supplement') {
      const plan = JSON.parse(job.plan_json!) as BankGenerationPlan
      for (const source of plan.sources.filter((entry) => !entry.completed)) validateBankSources(db, generationSourceRefs(source))
    } else bankAnalysisMaterial(db, input.libraryFileIds)
    db.prepare("UPDATE bank_generation_jobs SET status = 'queued', error_message = '', run_token = NULL, progress_done = ?, progress_total = ?, created_count = ?, updated_at = ? WHERE id = ?")
      .run(job.plan_json ? job.progress_done : 0, job.plan_json ? job.progress_total : 0, job.plan_json ? job.created_count : 0, now, id)
    return jobDTO(db.prepare('SELECT * FROM bank_generation_jobs WHERE id = ?').get(id) as JobRow)
  })
}

/** 全文梳理一次，再逐来源生成；每个来源的题目和进度一起提交，可继续未完成部分。 */
export async function executeNextBankGeneration(db: DatabaseSync): Promise<void> {
  const job = db.prepare("SELECT * FROM bank_generation_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as JobRow | undefined
  if (!job) return
  const token = randomUUID()
  const claimed = withTransaction(db, () => db.prepare("UPDATE bank_generation_jobs SET status = 'running', run_token = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(token, Date.now(), job.id).changes)
  if (!claimed) return
  // 热重载或重试后的旧模型响应不能再提交到当前任务。
  const ownsJob = () => Boolean(db.prepare("SELECT id FROM bank_generation_jobs WHERE id = ? AND status = 'running' AND run_token = ?").get(job.id, token))
  const input = jobDTO(job).input
  let currentSource = ''
  try {
    const config = readModelConfig(db).config
    if (!config) throw new ApiFailure('MODEL_NOT_CONFIGURED', '模型设置不完整，请配置后重新生成')
    let plan = job.plan_json ? JSON.parse(job.plan_json) as BankGenerationPlan : null
    if (!plan) {
      if (input.mode === 'supplement') throw new ApiFailure('QUESTION_SET_INVALID', '补题任务缺少来源快照，请重新创建任务')
      const material = bankAnalysisMaterial(db, input.libraryFileIds)
      const raw = await requestChatCompletion({ ...config, messages: buildBankAnalysisMessages(material, knowledgePoints(db)) })
      if (!ownsJob()) return
      plan = parseBankGenerationPlan(raw, material, listBankRecords(db, { libraryFileIds: input.libraryFileIds }), knowledgePoints(db))
      withTransaction(db, () => {
        validateBankSources(db, plan!.sources.flatMap(generationSourceRefs))
        for (const source of plan!.sources) source.id = saveGenerationSource(db, source, Date.now())
        db.prepare('UPDATE bank_generation_jobs SET plan_json = ?, progress_done = 0, progress_total = ?, created_count = 0, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(plan), plan!.sources.length, Date.now(), job.id)
      })
    }
    for (const [index, source] of plan.sources.entries()) {
      if (source.completed) continue
      if (!ownsJob()) return
      currentSource = `第 ${index + 1} 个来源「${source.title}」`
      const sourceRefs = generationSourceRefs(source)
      const batches = source.batches ?? [undefined]
      for (let batchIndex = source.completedBatches ?? 0; batchIndex < batches.length; batchIndex++) {
        if (!ownsJob()) return
        validateBankSources(db, sourceRefs)
        const pool = listBankRecords(db, { libraryFileIds: [source.segments[0]!.fileId] })
        source.sourceGroup = resolveGenerationSourceGroup(source, pool)
        const groupKey = bankSourceGroupKey({ id: '', sourceGroup: source.sourceGroup, sourceRefs })
        const existing = pool.filter((item) => bankSourceGroupKey(item) === groupKey)
        const quota = batches[batchIndex]
        const raw = await requestChatCompletion({ ...config, messages: buildBankMessages({ difficulty: input.difficulty, extraPrompt: input.extraPrompt,
          title: source.title, knowledgePoint: source.knowledgePoint, materials: source.segments, quota,
          existingQuestions: existing.map((item) => ({ type: item.type, stem: item.stem, options: item.options, answerDefinition: item.answerDefinition })),
        }) })
        if (!ownsJob()) return
        let parsed: unknown
        try { parsed = JSON.parse(stripCodeFence(raw)) as unknown }
        catch { throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '模型未返回合法的题目 JSON') }
        const list = isPlainObject(parsed) && Array.isArray(parsed.questions) ? parsed.questions : parsed
        if (!Array.isArray(list) || list.length > (quota?.total ?? MAX_BATCH_QUESTIONS) || (!quota && !list.length && !existing.length)) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', `模型返回的题目格式或数量不正确，本次上限 ${quota?.total ?? MAX_BATCH_QUESTIONS} 道`)
        const counts = { single_choice: 0, multiple_choice: 0, true_false: 0, fill_blank: 0 }
        const prepared = list.map((item: unknown, questionIndex) => {
          if (!isPlainObject(item)) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', `第 ${questionIndex + 1} 题不是题目对象`)
          const type = normalizeModelQuestionType(item.type)
          if (type === null) {
            const returnedType = typeof item.type === 'string' ? JSON.stringify(item.type.slice(0, 60)) : String(item.type)
            throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', `第 ${questionIndex + 1} 题的 type=${returnedType} 不支持；应为 ${QUESTION_TYPES.join(' / ')}`)
          }
          counts[type]++
          if (quota?.counts && counts[type] > quota.counts[type]) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '模型返回的题型数量超过本次补题范围')
          const normalized = parseBatchResponse(JSON.stringify([{ ...item, type, sourceRefs }]), type, 1)[0]!
          return prepareBankQuestion(db, { ...normalized, sourceGroup: source.sourceGroup,
            knowledgePoint: source.knowledgePoint, difficulty: input.difficulty, sourceRefs })
        })
        withTransaction(db, () => {
          validateBankSources(db, sourceRefs)
          // 管理员在模型请求期间改了同源分组时，要求重新发起，不能写回旧分组。
          if (resolveGenerationSourceGroup(source, listBankRecords(db, { libraryFileIds: [source.segments[0]!.fileId] })) !== source.sourceGroup) throw new ApiFailure('VERSION_CONFLICT', '来源分组已被修改，请重新发起补题')
          let created = 0
          for (const question of prepared) {
            const key = bankContentKey(question)
            const duplicate = findBankDuplicate(db, key)
            if (duplicate) {
              const original = findBankRecord(db, duplicate.id)!
              if (bankComparableKey(original) !== bankComparableKey(question)) {
                plan!.conflicts ??= []
                plan!.conflicts.push({ itemId: original.id, sourceTitle: source.title, type: question.type, stem: question.stem,
                  existingAnswer: original.answerDefinition, generatedAnswer: question.answerDefinition })
              }
              continue
            }
            insertBankRecord(db, randomUUID(), question, key, Date.now())
            created++
          }
          source.generatedCount += list.length
          source.createdCount += created
          source.completedBatches = batchIndex + 1
          source.completed = source.completedBatches === batches.length || Boolean(quota && !quota.counts && list.length < quota.total)
          if (quota && list.length < quota.total) source.shortfallReason = isPlainObject(parsed) && typeof parsed.reason === 'string' && parsed.reason.trim()
            ? parsed.reason.trim().slice(0, 500) : '本批未生成足量合适的新题，未强行凑题'
          source.id = saveGenerationSource(db, source, Date.now())
          db.prepare('UPDATE bank_generation_jobs SET plan_json = ?, progress_done = ?, created_count = created_count + ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(plan), plan!.sources.filter((entry) => entry.completed).length, created, Date.now(), job.id)
        })
        if (source.completed) break
      }
    }
    if (!ownsJob()) return
    withTransaction(db, () => {
      db.prepare("UPDATE bank_generation_jobs SET status = 'succeeded', run_token = NULL, updated_at = ? WHERE id = ?").run(Date.now(), job.id)
    })
  } catch (error) {
    if (!(error instanceof ApiFailure)) console.error('[bank-generation] 任务执行失败', error)
    const fields = error instanceof ApiFailure && isPlainObject(error.details) && isPlainObject(error.details.fields) ? Object.values(error.details.fields).filter((value) => typeof value === 'string') : []
    const message = fields.length ? fields.join('；') : error instanceof ApiFailure ? error.message : '题库生成发生内部错误，请重试'
    withTransaction(db, () => {
      db.prepare("UPDATE bank_generation_jobs SET status = 'failed', error_message = ?, run_token = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND run_token = ?")
        .run(currentSource ? `${currentSource}：${message}` : message, Date.now(), job.id, token)
    })
  }
}
