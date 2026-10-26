import type { H3Event } from 'h3'
import { ApiFailure } from './respond'

/** 读取路径参数（路由匹配后必然存在，缺失按 400 处理） */
export function readParam(event: H3Event, name: string): string {
  const value = getRouterParam(event, name)
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiFailure('BAD_REQUEST', `缺少路径参数 ${name}`)
  }
  return value
}

/** 读取查询参数里的整数（页码 / 偏移 / 上限），越界按 400 处理 */
export function readIntQuery(raw: unknown, field: string, fallback: number, min: number, max: number): number {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw new ApiFailure('BAD_REQUEST', `${field} 必须是非负整数`)
  }
  const parsed = Number.parseInt(value.trim(), 10)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ApiFailure('BAD_REQUEST', `${field} 必须在 ${min} 到 ${max} 之间`)
  }
  return parsed
}
