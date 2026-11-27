import type { DatabaseSync } from 'node:sqlite'
import type { Difficulty, QuestionType } from '../../shared/types/question'
import { QUESTION_TYPES } from '../../shared/types/question'
import type { BankGenerationSourceSummary, BankSupplementRequest, BankSupplementQuantity } from '../../shared/types/question-bank'
import { MAX_QUESTIONS } from '../../shared/constants'
import { listGenerationSources } from '../db/queries/bank-generation-sources'
import { listBankRecords, type BankRecord } from '../db/queries/question-bank'
import { generationSourceRefs, resolveGenerationSourceGroup, type GenerationSource, type BankGenerationPlan } from './bank-generation-plan'
import { bankSourceGroupKey } from './bank-selection'
import { validateBankSources } from './question-bank'
import { ApiFailure } from '../utils/respond'
import { FieldErrors, isPlainObject } from '../utils/validate'
import { shuffle } from '../utils/shuffle'
import { markedBlankTemplates, markedSourceTypes } from './marked-document'
import { bankContentKey } from './question-bank-stats'

function questionCounts(items: BankRecord[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const key = bankSourceGroupKey(item)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function sourceKey(source: GenerationSource): string {
  return bankSourceGroupKey({ id: '', sourceGroup: source.sourceGroup, sourceRefs: generationSourceRefs(source) })
}

export function listBankGenerationSources(db: DatabaseSync): BankGenerationSourceSummary[] {
  const counts = questionCounts(listBankRecords(db, {}))
  return listGenerationSources(db).map<BankGenerationSourceSummary>((source) => ({ id: source.id!, title: source.title, knowledgePoint: source.knowledgePoint,
    fileName: source.segments[0]!.fileName, locators: [...new Set(source.segments.map((segment) => segment.locator))],
    questionCount: counts.get(sourceKey(source)) ?? 0, documentMode: source.markedRules ? 'marked' : undefined }))
}

export function prepareBankSupplement(db: DatabaseSync, body: Record<string, unknown>, difficulty: Difficulty, extraPrompt: string): { input: BankSupplementRequest; plan: BankGenerationPlan } {
  const ids = body.sourceIds
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new ApiFailure('VALIDATION_FAILED', '请选择 1–100 个不重复的来源')
  const raw = body.quantity
  if (!isPlainObject(raw)) throw new ApiFailure('VALIDATION_FAILED', '请设置本次新增题量')
  const errors = new FieldErrors()
  const mode = errors.oneOf(raw, 'mode', '题量模式', ['auto', 'by_type'] as const, true)
  let quantity: BankSupplementQuantity
  const slots: Array<QuestionType | null> = []
  if (mode === 'by_type') {
    if (!isPlainObject(raw.counts)) throw new ApiFailure('VALIDATION_FAILED', '请设置各题型新增题量')
    const counts = {} as Record<QuestionType, number>
    for (const type of QUESTION_TYPES) {
      counts[type] = errors.int(raw.counts, type, '新增题量', { min: 0, max: MAX_QUESTIONS, required: true }) ?? 0
      slots.push(...Array.from({ length: counts[type] }, () => type))
    }
    quantity = { mode: 'by_type', counts }
  } else {
    const total = errors.int(raw, 'total', '新增题量', { min: 1, max: MAX_QUESTIONS, required: true }) ?? 0
    slots.push(...Array.from({ length: total }, () => null))
    quantity = { mode: 'auto', total }
  }
  errors.throwIfAny()
  if (!slots.length || slots.length > MAX_QUESTIONS) throw new ApiFailure('VALIDATION_FAILED', '本次新增题量合计需为 1–100 道')
  const byId = new Map(listGenerationSources(db).map((source) => [source.id, source]))
  const existing = listBankRecords(db, {})
  const counts = questionCounts(existing)
  const sources = shuffle(ids.map((id) => {
    const source = byId.get(id)
    if (!source) throw new ApiFailure('QUESTION_SET_INVALID', '所选来源已不存在或资料不可用，请刷新来源清单')
    validateBankSources(db, generationSourceRefs(source))
    source.sourceGroup = resolveGenerationSourceGroup(source, existing)
    source.batches = []
    return source
  })).sort((a, b) => (counts.get(sourceKey(a)) ?? 0) - (counts.get(sourceKey(b)) ?? 0))
  // 题量属于本次范围的总数，轮流分给所选来源；每次请求只生成一道题。
  slots.forEach((type, index) => {
    const eligible = sources.filter((source) => type === null || !source.markedRules || markedSourceTypes(source).includes(type))
    if (!eligible.length) throw new ApiFailure('VALIDATION_FAILED', '所选标记来源没有熟记内容中的 <> 填空位置；普通内容只出判断和选择，请调整来源或题型')
    const source = eligible[index % eligible.length]!
    const types = source.markedRules ? markedSourceTypes(source) : null
    const actualType = type ?? (types ? types[source.batches!.length % types.length]! : null)
    const counts = actualType === null ? undefined : { single_choice: 0, multiple_choice: 0, true_false: 0, fill_blank: 0 }
    if (counts && actualType !== null) counts[actualType] = 1
    let blankTemplateIndex: number | undefined
    if (source.markedRules && actualType === 'fill_blank') {
      const existingKeys = new Set(existing.filter((item) => bankSourceGroupKey(item) === sourceKey(source)).map(bankContentKey))
      const assigned = new Set(source.batches!.map((batch) => batch.blankTemplateIndex))
      blankTemplateIndex = markedBlankTemplates(source).findIndex((question, index) => !assigned.has(index) && !existingKeys.has(bankContentKey(question)))
    }
    source.batches!.push({ total: 1, ...(counts ? { counts } : {}), ...(blankTemplateIndex === undefined ? {} : { blankTemplateIndex }) })
  })
  return { input: { mode: 'supplement', sourceIds: ids as string[], difficulty, extraPrompt, quantity },
    plan: { sources: sources.filter((source) => source.batches!.length), ignored: [], conflicts: [] } }
}
