import type { QuestionType } from '../../shared/types/question'
import { ApiFailure } from '../utils/respond'
import { isPlainObject } from '../utils/validate'

/** 只去掉整段 Markdown 代码围栏，其余一律原样解析（§11.2） */
export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```') || trimmed.length < 6) return trimmed
  const opened = trimmed.replace(/^```[A-Za-z0-9_+-]*[ \t]*\r?\n?/u, '')
  return opened.slice(0, Math.max(0, opened.length - 3)).trim()
}

const QUESTION_KEYS = new Set(['type', 'stem', 'options', 'answerDefinition', 'explanation', 'sourceRefs'])
const CHOICE_TYPES = new Set<QuestionType>(['single_choice', 'multiple_choice'])

function invalid(message: string): never {
  throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', message)
}

function normalizeItem(item: unknown, expectedType: QuestionType, index: number): Record<string, unknown> {
  const label = `第 ${index + 1} 道题`
  if (!isPlainObject(item)) invalid(`${label}不是 JSON 对象`)
  for (const key of Object.keys(item)) {
    if (!QUESTION_KEYS.has(key)) invalid(`${label}包含多余字段：${key}`)
  }
  if (item.type !== expectedType) invalid(`${label}的 type 与请求的题型不一致`)
  if (typeof item.stem !== 'string' || item.stem.trim() === '') invalid(`${label}缺少题干 stem`)
  if (typeof item.explanation !== 'string' || item.explanation.trim() === '') invalid(`${label}缺少解析 explanation`)
  if (!isPlainObject(item.answerDefinition)) invalid(`${label}缺少 answerDefinition`)
  if (!Array.isArray(item.sourceRefs) || item.sourceRefs.length === 0) invalid(`${label}缺少资料引用 sourceRefs`)
  if (CHOICE_TYPES.has(expectedType)) {
    if (!Array.isArray(item.options)) invalid(`${label}缺少 options`)
  } else if (item.options !== undefined && !Array.isArray(item.options)) {
    invalid(`${label}的 options 必须是数组`)
  }
  const normalized: Record<string, unknown> = {
    type: item.type,
    stem: item.stem,
    answerDefinition: item.answerDefinition,
    explanation: item.explanation,
    sourceRefs: item.sourceRefs,
  }
  if (Array.isArray(item.options)) normalized.options = item.options
  return normalized
}

/** 解析一批模型输出：数量与题型必须完全匹配（§11.2） */
export function parseBatchResponse(
  raw: string,
  expectedType: QuestionType,
  expectedCount: number,
): Record<string, unknown>[] {
  const content = stripCodeFence(raw)
  if (content === '') invalid('模型返回的内容为空')
  let parsed: unknown
  try {
    parsed = JSON.parse(content) as unknown
  } catch {
    invalid('模型返回的内容不是合法 JSON')
  }
  let list: unknown[]
  if (Array.isArray(parsed)) {
    list = parsed
  } else if (isPlainObject(parsed) && Array.isArray(parsed.questions)) {
    list = parsed.questions
  } else {
    invalid('模型返回的 JSON 结构不正确，应为题目数组')
  }
  if (list.length !== expectedCount) {
    invalid(`模型返回题目数量不符：期望 ${expectedCount} 道，实际 ${list.length} 道`)
  }
  return list.map((item, index) => normalizeItem(item, expectedType, index))
}
