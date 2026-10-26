import type { H3Event } from 'h3'
import { API_ERROR_STATUS, type ApiErrorCode, type ApiErrorBody, type ApiSuccess } from '../../shared/types/common'

/**
 * 统一响应外壳（docs/impl-contract.md §5）：
 *   成功 → { data: T }，错误 → { error: { code, message, details? } }
 * 所有 /api 响应都带 Cache-Control: no-store（设计 §3.2）。
 */
export function ok<T>(event: H3Event, data: T, status = 200): ApiSuccess<T> {
  setResponseStatus(event, status)
  setHeader(event, 'Cache-Control', 'no-store')
  return { data }
}

export function fail(event: H3Event, code: ApiErrorCode, message: string, details?: unknown): ApiErrorBody {
  setResponseStatus(event, API_ERROR_STATUS[code])
  setHeader(event, 'Cache-Control', 'no-store')
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } }
}

/** 业务异常载体：抛出后由各 handler 用 catch + fail() 转成统一错误体 */
export class ApiFailure extends Error {
  readonly code: ApiErrorCode
  readonly details?: unknown

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiFailure'
    this.code = code
    this.details = details
  }
}

export function throwApi(code: ApiErrorCode, message: string, details?: unknown): never {
  throw new ApiFailure(code, message, details)
}

/** 在 handler 的 catch 中统一收口：已知业务错误原样返回，未知错误脱敏为 INTERNAL_ERROR */
export function failFrom(event: H3Event, error: unknown): ApiErrorBody {
  if (error instanceof ApiFailure) {
    return fail(event, error.code, error.message, error.details)
  }
  console.error('[api] 未处理异常', error)
  return fail(event, 'INTERNAL_ERROR', '服务器内部错误')
}
