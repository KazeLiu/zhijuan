import type { DatabaseSync } from 'node:sqlite'
import type { BankSourceRef, BankGenerationConflict, BankGenerationIssue } from '../../shared/types/question-bank'
import { QUESTION_TYPES, type QuestionType } from '../../shared/types/question'
import { MAX_QUOTE_CHARS, MIN_QUOTE_CHARS, MAX_TOTAL_DOCUMENT_CHARS } from '../../shared/constants'
import type { BankAnalysisSegment } from '../ai/prompt'
import { stripCodeFence } from '../ai/parser'
import { findLibraryFilesByIds, listLibrarySegments } from '../db/queries/library'
import type { BankRecord } from '../db/queries/question-bank'
import { normalizeDocText } from './documents'
import { normalizeKnowledgePoint } from './question-bank'
import { bankSourceGroupKey } from './bank-selection'
import { ApiFailure } from '../utils/respond'
import { isPlainObject } from '../utils/validate'

export interface SourceSegment extends BankAnalysisSegment {
  fileId: string
  offset: number
}

/** 资料模式每个来源最多请求 6 道候选题，逐题生成，内容不足时提前结束。 */
const SOURCE_QUESTION_LIMIT = 6

/** 单个模型请求的处理结果；新请求只生成一道题，已成功的旧批次也不重发。 */
export interface SourceRequestResult {
  /** skipped 表示来源已按原语义定论（模型没凑满且不追加），该请求不再发送 */
  status: 'pending' | 'succeeded' | 'failed' | 'skipped'
  attempts: number
  message?: string
}

export interface GenerationSource {
  id?: string
  title: string
  knowledgePoint: string
  sourceGroup: string
  segments: SourceSegment[]
  /** 该来源的全部请求都已处理（含失败），不再有待处理请求 */
  completed: boolean
  generatedCount: number
  createdCount: number
  batches?: Array<{ total: number; counts?: Record<QuestionType, number> }>
  /** 旧任务的连续成功前缀；新任务改用 requests 逐请求记录 */
  completedBatches?: number
  requests?: SourceRequestResult[]
  shortfallReason?: string
}

export interface BankGenerationPlan {
  sources: GenerationSource[]
  ignored: Array<{ fileName: string; locators: string[]; reason: string }>
  conflicts?: BankGenerationConflict[]
}

export function sourceRequestCount(source: GenerationSource): number {
  return Math.max(1, source.batches?.length ?? 1)
}

/** 允许“先失败后成功”：旧任务用 completedBatches 连续前缀，新任务逐请求记录，都按此契约读。 */
function sourceRequestResult(source: GenerationSource, index: number): SourceRequestResult {
  const prefix = source.completedBatches ?? (source.completed ? sourceRequestCount(source) : 0)
  return source.requests?.[index] ?? { status: index < prefix ? 'succeeded' : source.completed ? 'skipped' : 'pending', attempts: 0 }
}

export function sourceOutcomes(source: GenerationSource): SourceRequestResult[] {
  return Array.from({ length: sourceRequestCount(source) }, (_, index) => sourceRequestResult(source, index))
}

/** 已定论的请求（成功或按原语义跳过）不再发送模型请求。 */
export function requestSettled(source: GenerationSource, index: number): boolean {
  const status = sourceRequestResult(source, index).status
  return status === 'succeeded' || status === 'skipped'
}

/** 展开成逐请求状态（落库用）；retrying 时把失败项退回待处理，只重跑失败和未处理的请求。 */
export function normalizeSourceRequests(source: GenerationSource, retrying: boolean): void {
  const outcomes = sourceOutcomes(source)
  const originalBatches: NonNullable<GenerationSource['batches']> = source.batches ?? [{ total: SOURCE_QUESTION_LIMIT }]
  const batches: NonNullable<GenerationSource['batches']> = []
  const requests: SourceRequestResult[] = []
  for (const [index, batch] of originalBatches.entries()) {
    const previous = outcomes[index]!
    // 已成功或已停止追加的旧批次保持原样，只拆分尚未完成的题量。
    if (previous.status === 'succeeded' || previous.status === 'skipped') {
      batches.push(batch)
      requests.push(previous)
      continue
    }
    const types = batch.counts
      ? QUESTION_TYPES.flatMap((type) => Array.from({ length: batch.counts![type] }, () => type))
      : Array.from({ length: batch.total }, () => null)
    for (const type of types) {
      const counts = type === null ? undefined : { single_choice: 0, multiple_choice: 0, true_false: 0, fill_blank: 0 }
      if (counts && type !== null) counts[type] = 1
      batches.push({ total: 1, ...(counts ? { counts } : {}) })
      requests.push(retrying && previous.status === 'failed' ? { status: 'pending', attempts: 0 } : { ...previous })
    }
  }
  source.batches = batches
  source.requests = requests
  source.completed = requests.every((result) => result.status !== 'pending')
}

export function generationProgress(plan: BankGenerationPlan): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const source of plan.sources) {
    for (const result of sourceOutcomes(source)) {
      total++
      // 已处理 = 成功、按原语义跳过、或重试耗尽。失败的请求也算本轮已遍历，进度不会卡在 100% 之前。
      if (result.status !== 'pending') done++
    }
  }
  return { done, total }
}

/** 重试耗尽仍失败的请求；成功即从清单消失，页面关闭或服务重启后仍可读。 */
export function generationIssues(plan: BankGenerationPlan): BankGenerationIssue[] {
  return plan.sources.flatMap((source) => sourceOutcomes(source).flatMap((result, requestIndex) => result.status === 'failed'
    ? [{ sourceTitle: source.title, requestIndex: requestIndex + 1, attempts: result.attempts, message: result.message ?? '' }]
    : []))
}

/** 分段编号只供模型引用；快照始终保留实际文件和定位，不让模型重写标识。 */
export function bankAnalysisMaterial(db: DatabaseSync, ids: string[]): SourceSegment[] {
  const files = findLibraryFilesByIds(db, ids)
  if (files.length !== ids.length || files.some((file) => file.status !== 'parsed')) throw new ApiFailure('QUESTION_SET_INVALID', '所选资料不存在或未解析成功')
  if (files.reduce((sum, file) => sum + file.charCount, 0) > MAX_TOTAL_DOCUMENT_CHARS) throw new ApiFailure('DOCUMENT_CHARS_EXCEEDED', '所选资料超过 40000 字，请缩小范围')
  const result: SourceSegment[] = []
  for (const file of files) {
    for (const segment of listLibrarySegments(db, file.id)) {
      // PDF 一段可能是一整页；先分行、分句，模型才能把同页的多道原题分成多个来源。
      for (const part of segment.text.matchAll(/[^\n。]+[。\n]*/gu)) {
        for (let start = 0; start < part[0].length; start += MAX_QUOTE_CHARS) {
          const text = part[0].slice(start, start + MAX_QUOTE_CHARS)
          if (text.trim()) result.push({ id: result.length + 1, fileId: file.id, fileName: file.originalName,
            locator: segment.locator, offset: part.index + start, text })
        }
      }
    }
  }
  if (!result.length) throw new ApiFailure('QUESTION_SET_INVALID', '所选资料没有可用于出题的正文')
  return result
}

export function generationSourceRefs(source: GenerationSource): BankSourceRef[] {
  const quotes: Array<BankSourceRef & { end: number }> = []
  for (const segment of source.segments) {
    const previous = quotes[quotes.length - 1]
    if (previous && previous.locator === segment.locator && previous.end === segment.offset && previous.quote.length + segment.text.length <= MAX_QUOTE_CHARS) {
      previous.quote += segment.text
      previous.end += segment.text.length
    } else {
      quotes.push({ libraryFileId: segment.fileId, locator: segment.locator, quote: segment.text, end: segment.offset + segment.text.length })
    }
  }
  // 不跨原始定位拼接摘录；单独一行的短答案仍随完整快照交给模型。
  return quotes.filter((ref) => Array.from(normalizeDocText(ref.quote)).length >= MIN_QUOTE_CHARS)
    .map(({ libraryFileId, locator, quote }) => ({ libraryFileId, locator, quote }))
}

export function parseBankGenerationPlan(raw: string, material: SourceSegment[], existing: BankRecord[], classifications: string[]): BankGenerationPlan {
  let parsed: unknown
  try { parsed = JSON.parse(stripCodeFence(raw)) as unknown }
  catch { throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '全文梳理未返回合法 JSON，尚未开始出题') }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.knowledgePoints) || !Array.isArray(parsed.ignored)) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '全文梳理缺少 knowledgePoints 或 ignored 数组')
  const assigned = new Set<number>()
  function readSegments(value: unknown): SourceSegment[] {
    if (!Array.isArray(value) || !value.length) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '来源必须包含原文段编号')
    return value.map((id: unknown) => {
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id > material.length || assigned.has(id)) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', `全文梳理的段编号无效或重复：${String(id).slice(0, 40)}`)
      assigned.add(id)
      return material[id - 1]!
    }).sort((a, b) => a.id - b.id)
  }
  const pointKey = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()
  const plan: BankGenerationPlan = { sources: [], ignored: [] }
  for (const point of parsed.knowledgePoints) {
    if (!isPlainObject(point) || !Array.isArray(point.sources) || !point.sources.length) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '每个知识点必须包含来源数组')
    const name = normalizeKnowledgePoint(point.name)
    const knowledgePoint = classifications.find((value) => pointKey(value) === pointKey(name)) ?? name
    for (const entry of point.sources) {
      if (!isPlainObject(entry) || typeof entry.title !== 'string' || !entry.title.trim() || Array.from(entry.title.trim()).length > 100) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '来源名称需为 1–100 字')
      const segments = readSegments(entry.segments)
      const first = segments[0]!, last = segments[segments.length - 1]!
      if (segments.some((segment) => segment.fileId !== first.fileId)) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', `来源「${entry.title}」合并了不同文件，请重新梳理`)
      // 旧任务已有分组时按真实引用沿用；新来源用原文位置命名，避免模型改标题后变成另一组。
      const source: GenerationSource = { title: entry.title.trim(), knowledgePoint,
        sourceGroup: `原文 ${first.locator}:${first.offset}${first === last ? '' : `–${last.locator}:${last.offset}`}`,
        segments, completed: false, generatedCount: 0, createdCount: 0 }
      source.sourceGroup = resolveGenerationSourceGroup(source, existing)
      if (!generationSourceRefs(source).length) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', `来源「${source.title}」原文太短，不能形成有效资料引用`)
      plan.sources.push(source)
    }
  }
  for (const entry of parsed.ignored) {
    if (!isPlainObject(entry) || typeof entry.reason !== 'string' || !entry.reason.trim() || entry.reason.length > 200) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '忽略片段必须给出 1–200 字的原因')
    const segments = readSegments(entry.segments)
    for (const fileId of new Set(segments.map((segment) => segment.fileId))) {
      const parts = segments.filter((segment) => segment.fileId === fileId)
      plan.ignored.push({ fileName: parts[0]!.fileName, locators: [...new Set(parts.map((segment) => segment.locator))], reason: entry.reason.trim() })
    }
  }
  const missing = material.filter((segment) => !assigned.has(segment.id))
  if (missing.length) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', `全文梳理遗漏 ${missing.length} 段（${missing.slice(0, 5).map((segment) => `${segment.fileName} ${segment.locator}`).join('、')}），尚未开始出题，请重试`)
  if (!plan.sources.length) throw new ApiFailure('QUESTION_SET_INVALID', `全文未找到可出题的完整来源：${plan.ignored.slice(0, 3).map((entry) => entry.reason).join('；')}`)
  plan.sources.sort((a, b) => a.segments[0]!.id - b.segments[0]!.id)
  return plan
}

export function resolveGenerationSourceGroup(source: GenerationSource, existing: BankRecord[]): string {
  const byLocator = new Map<string, string>()
  for (const segment of source.segments) byLocator.set(segment.locator, (byLocator.get(segment.locator) ?? '') + segment.text)
  const groups = new Map(existing.filter((item) => item.sourceGroup && item.sourceRefs.length && item.sourceRefs.every((ref) =>
    ref.libraryFileId === source.segments[0]!.fileId && normalizeDocText(byLocator.get(ref.locator) ?? '').includes(normalizeDocText(ref.quote)),
  )).map((item) => [bankSourceGroupKey(item), item.sourceGroup] as const))
  if (groups.size > 1) throw new ApiFailure('QUESTION_SET_INVALID', `来源「${source.title}」已有多个同源标记，请先在题库中统一：${[...groups.values()].join('、')}`)
  return [...groups.values()][0] ?? source.sourceGroup
}
