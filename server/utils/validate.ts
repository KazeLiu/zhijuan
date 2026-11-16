import type { H3Event } from 'h3'
import { DEFAULT_PAGE_SIZE } from '../../shared/constants'
import { ApiFailure } from './respond'

/**
 * 请求体解析与字段校验（docs/impl-contract.md §6）：
 * - body 非法 JSON → 400 INVALID_JSON；非对象 → 400 BAD_REQUEST。
 * - 字段超限/取值非法 → 收集后统一 422 VALIDATION_FAILED（details.fields）。
 */

/** 读取 JSON 对象请求体 */
export async function readJsonObject(event: H3Event): Promise<Record<string, unknown>> {
  let raw = ''
  try {
    raw = (await readRawBody(event, 'utf8')) ?? ''
  } catch {
    throw new ApiFailure('BAD_REQUEST', '无法读取请求体')
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiFailure('BAD_REQUEST', '请求体不能为空')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ApiFailure('INVALID_JSON', '请求体不是合法的 JSON')
  }
  if (!isPlainObject(parsed)) {
    throw new ApiFailure('BAD_REQUEST', '请求体必须是 JSON 对象')
  }
  return parsed
}

/** 读取 JSON 对象请求体；空请求体当作 {}（用于无必填参数的 POST，如生命周期动作） */
export async function readOptionalJsonObject(event: H3Event): Promise<Record<string, unknown>> {
  let raw = ''
  try {
    raw = (await readRawBody(event, 'utf8')) ?? ''
  } catch {
    throw new ApiFailure('BAD_REQUEST', '无法读取请求体')
  }
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ApiFailure('INVALID_JSON', '请求体不是合法的 JSON')
  }
  if (!isPlainObject(parsed)) {
    throw new ApiFailure('BAD_REQUEST', '请求体必须是 JSON 对象')
  }
  return parsed
}

/** 是否为普通对象（排除数组与 null） */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Unicode 码点计数（与前端 maxlength 口径一致） */
export function countChars(value: string): number {
  return Array.from(value).length
}

/** 参数化 LIKE 中的通配符按字面量查询。 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (char) => `\\${char}`)
}

export interface TextRule {
  /** 最大字符数（Unicode 码点） */
  max?: number
  /** 最小字符数（按 trim 后计） */
  min?: number
  /** 是否必填：缺失、null、空串都算错误 */
  required?: boolean
  /** 是否先 trim（去首尾空白） */
  trim?: boolean
}

/** 字段错误收集器：一次性返回全部字段问题，避免前端逐个试错 */
export class FieldErrors {
  readonly fields: Record<string, string> = {}

  add(field: string, message: string): void {
    if (!(field in this.fields)) this.fields[field] = message
  }

  has(field: string): boolean {
    return field in this.fields
  }

  throwIfAny(): void {
    if (Object.keys(this.fields).length > 0) {
      throw new ApiFailure('VALIDATION_FAILED', '请求参数校验失败', { fields: this.fields })
    }
  }

  /** 读取文本字段；缺失且非必填时返回 undefined */
  text(body: Record<string, unknown>, field: string, label: string, rule: TextRule = {}): string | undefined {
    const raw = body[field]
    if (raw === undefined || raw === null) {
      if (rule.required) this.add(field, `${label}不能为空`)
      return undefined
    }
    if (typeof raw !== 'string') {
      this.add(field, `${label}必须是文本`)
      return undefined
    }
    const value = rule.trim ? raw.trim() : raw
    if (rule.required && value.trim() === '') {
      this.add(field, `${label}不能为空`)
      return undefined
    }
    if (rule.min !== undefined && value.trim() !== '' && countChars(value.trim()) < rule.min) {
      this.add(field, `${label}不能少于 ${rule.min} 字`)
      return undefined
    }
    if (rule.max !== undefined && countChars(value) > rule.max) {
      this.add(field, `${label}不能超过 ${rule.max} 字`)
      return undefined
    }
    return value
  }

  /** 读取整数（可限定取值范围） */
  int(
    body: Record<string, unknown>,
    field: string,
    label: string,
    rule: { min?: number; max?: number; required?: boolean } = {},
  ): number | undefined {
    const raw = body[field]
    if (raw === undefined || raw === null) {
      if (rule.required) this.add(field, `${label}不能为空`)
      return undefined
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw)) {
      this.add(field, `${label}必须是整数`)
      return undefined
    }
    if (rule.min !== undefined && raw < rule.min) {
      this.add(field, `${label}不能小于 ${rule.min}`)
      return undefined
    }
    if (rule.max !== undefined && raw > rule.max) {
      this.add(field, `${label}不能大于 ${rule.max}`)
      return undefined
    }
    return raw
  }

  /** 读取枚举值 */
  oneOf<T extends string>(
    body: Record<string, unknown>,
    field: string,
    label: string,
    allowed: readonly T[],
    required = false,
  ): T | undefined {
    const raw = body[field]
    if (raw === undefined || raw === null) {
      if (required) this.add(field, `${label}不能为空`)
      return undefined
    }
    if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
      this.add(field, `${label}取值不合法`)
      return undefined
    }
    return raw as T
  }
}

/** 页码：正整数，缺省 1，非法 400 BAD_REQUEST（§6.3） */
export function parsePageValue(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 1
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new ApiFailure('BAD_REQUEST', 'page 必须是正整数')
  }
  const page = Number.parseInt(value.trim(), 10)
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new ApiFailure('BAD_REQUEST', 'page 必须是正整数')
  }
  return page
}

/** 只取单个查询参数值（忽略数组重复传参） */
export function queryValue(raw: unknown): string | undefined {
  if (Array.isArray(raw)) {
    const first = raw[0]
    return typeof first === 'string' ? first : undefined
  }
  return typeof raw === 'string' ? raw : undefined
}

/** 布尔型查询参数：只接受 'true' / 'false'，其余 400 BAD_REQUEST */
export function parseBooleanQuery(raw: unknown, field: string): boolean | undefined {
  const value = queryValue(raw)
  if (value === undefined || value === '') return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new ApiFailure('BAD_REQUEST', `${field}只接受 true 或 false`)
}

/** 生成分页外壳（totalPages 至少为 1） */
export function paginate<T>(items: T[], page: number, total: number) {
  return {
    items,
    page,
    pageSize: DEFAULT_PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE)),
  }
}

/** 读取并校验 expectedVersion（乐观锁） */
export function readExpectedVersion(body: Record<string, unknown>): number {
  const raw = body.expectedVersion
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new ApiFailure('BAD_REQUEST', 'expectedVersion 缺失或不合法')
  }
  return raw
}

/** SQLite 唯一约束冲突（用于并发插入时回读已有行） */
export function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /UNIQUE constraint failed/i.test(message)
}
