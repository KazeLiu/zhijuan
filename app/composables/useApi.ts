/**
 * 统一 API 调用层（契约 §10.1）：
 * - 同源 Cookie（credentials: same-origin）
 * - 解析 `{ data }` 与 `{ error }` 外壳
 * - 抛 `ApiClientError { code, message, details, status }`
 * - 401 统一跳回入口提示重新登录；VERSION_CONFLICT 交给页面弹窗处理
 */
import type { ApiErrorBody, ApiErrorCode, ApiSuccess } from '#shared/types'

export type ApiClientCode = ApiErrorCode | 'NETWORK_ERROR' | 'UNKNOWN'

export class ApiClientError extends Error {
  readonly code: ApiClientCode
  readonly status: number
  readonly details: unknown

  constructor(code: ApiClientCode, message: string, status: number, details?: unknown) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Record<string, string | number | boolean | null | undefined>
  body?: unknown
  /** true = 不自动弹全局错误提示（页面自行展示内联错误或冲突弹窗） */
  silent?: boolean
}

function toApiClientError(error: unknown): ApiClientError {
  if (error instanceof ApiClientError) return error
  const candidate = error as { status?: number; statusCode?: number; data?: unknown; message?: string } | null
  const status = candidate?.status ?? candidate?.statusCode ?? 0
  const body = candidate?.data as ApiErrorBody | undefined
  if (body && typeof body === 'object' && body.error && typeof body.error === 'object') {
    return new ApiClientError(
      body.error.code ?? 'UNKNOWN',
      body.error.message || '请求失败',
      status,
      body.error.details,
    )
  }
  if (status === 0) {
    return new ApiClientError('NETWORK_ERROR', '网络异常，请检查网络连接后重试', 0)
  }
  return new ApiClientError('UNKNOWN', candidate?.message || `请求失败（HTTP ${status}）`, status)
}

function resolveFetch(): typeof $fetch {
  // SSR 时转发请求 Cookie，客户端用全局 $fetch
  if (import.meta.server) return useRequestFetch() as typeof $fetch
  return $fetch
}

/** 统一处理非业务分支：401 回入口，其余弹全局提示 */
function handleGlobalError(error: ApiClientError): void {
  if (!import.meta.client) return
  if (error.code === 'UNAUTHORIZED') {
    ElMessage.error('登录已失效，请重新输入姓名进入')
    void navigateTo('/')
    return
  }
  if (error.code === 'VERSION_CONFLICT') return
  if (error.code === 'CSRF_ORIGIN_REJECTED') {
    ElMessage.error('请求来源校验失败，请刷新页面后重试')
    return
  }
  ElMessage.error(error.message)
}

export async function apiFetch<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const fetcher = resolveFetch()
  try {
    const response = await fetcher<ApiSuccess<T>>(path, {
      method: options.method ?? 'GET',
      query: options.query,
      body: options.body as never,
      credentials: 'same-origin',
    })
    return response.data
  } catch (error) {
    const apiError = toApiClientError(error)
    if (!options.silent) handleGlobalError(apiError)
    throw apiError
  }
}

/** 上传单个文件（multipart，字段名固定为 file，契约 §8.5） */
export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const fetcher = resolveFetch()
  const form = new FormData()
  form.append('file', file)
  try {
    const response = await fetcher<ApiSuccess<T>>(path, {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
    })
    return response.data
  } catch (error) {
    const apiError = toApiClientError(error)
    throw apiError
  }
}

/** 错误 → 可展示文案：优先服务端 message，其次兜底文案 */
export function describeApiError(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (error instanceof ApiClientError) return error.message || fallback
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/** 从 details 里读取服务端给出的字段级错误（表单用） */
export function readFieldErrors(error: unknown): Record<string, string> {
  const apiError = error instanceof ApiClientError ? error : null
  const details = apiError?.details
  if (!details || typeof details !== 'object') return {}
  const fields = (details as { fields?: unknown }).fields
  if (!fields || typeof fields !== 'object') return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof value === 'string' && value) result[key] = value
  }
  return result
}
