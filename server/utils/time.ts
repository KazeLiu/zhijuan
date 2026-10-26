import { ApiFailure } from './respond'

/**
 * 时间工具（docs/impl-contract.md §6.2）：
 * - 传输与存储一律 UTC 毫秒整数；场次时间入参必须是带偏移的 ISO 8601。
 * - 时区一律 IANA 名；展示与"当天 00:00"计算都在服务端按 IANA 时区完成。
 * - 是否开始/是否截止的判定只用 Date.now()。
 */

/** 带偏移的 ISO 8601 后缀：Z、+08:00、-05:30 */
const OFFSET_SUFFIX = /(?:[zZ]|[+-]\d{2}:\d{2})$/

/** 解析入参时间：必须是带偏移的 ISO 8601，否则 400 BAD_REQUEST */
export function parseIsoInstant(raw: unknown, field: string): number {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiFailure('BAD_REQUEST', `${field}不能为空`)
  }
  const value = raw.trim()
  if (!OFFSET_SUFFIX.test(value)) {
    throw new ApiFailure('BAD_REQUEST', `${field}必须带时区偏移，例如 2026-10-24T09:00:00+08:00`)
  }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    throw new ApiFailure('BAD_REQUEST', `${field}不是合法的时间`)
  }
  return ms
}

/** 校验 IANA 时区名（用 Intl 试构造），返回规范化后的名字 */
export function parseTimeZone(raw: unknown, field = 'timeZone'): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiFailure('BAD_REQUEST', `${field}不能为空`)
  }
  const zone = raw.trim()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
  } catch {
    throw new ApiFailure('BAD_REQUEST', `${field}不是合法的 IANA 时区`)
  }
  return zone
}

/** 进程时区（缺省时区来源） */
export function processTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

interface ZoneParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(zone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  formatterCache.set(zone, formatter)
  return formatter
}

/** 取某个 UTC 毫秒在指定时区下的本地日期时间分量 */
export function zoneParts(ms: number, zone: string): ZoneParts {
  const parts = zoneFormatter(zone).formatToParts(new Date(ms))
  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type)
    if (!found) return 0
    const value = Number.parseInt(found.value, 10)
    return Number.isFinite(value) ? value : 0
  }
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

/** 该瞬间在指定时区的偏移量（毫秒），东八区为 +28800000 */
function zoneOffsetMs(ms: number, zone: string): number {
  const parts = zoneParts(ms, zone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** 指定时区下"当天 00:00"对应的 UTC 毫秒 */
export function startOfDayInZone(zone: string, atMs: number): number {
  const parts = zoneParts(atMs, zone)
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day)
  const firstGuess = naive - zoneOffsetMs(naive, zone)
  // 跨夏令时切换时用第一次结果再修正一次
  return naive - zoneOffsetMs(firstGuess, zone)
}

/** 指定时区下"次日 00:00"对应的 UTC 毫秒（入参为当天 00:00） */
export function startOfNextDayInZone(zone: string, dayStartMs: number): number {
  return startOfDayInZone(zone, dayStartMs + 36 * 3600_000)
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** YYYY-MM-DD HH:mm:ss（按指定时区渲染，导出与汇总展示用） */
export function formatDateTime(ms: number, zone: string): string {
  const parts = zoneParts(ms, zone)
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`
}

/** yyyyMMddHHmm（导出文件名用） */
export function formatCompactStamp(ms: number, zone: string): string {
  const parts = zoneParts(ms, zone)
  return `${parts.year}${pad2(parts.month)}${pad2(parts.day)}${pad2(parts.hour)}${pad2(parts.minute)}`
}
