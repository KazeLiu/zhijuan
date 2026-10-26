/**
 * 展示层格式化：分值单位、时刻、时长、字节数（契约 §6.2 / §10.3）。
 * 所有纯函数不依赖 Nuxt 上下文，便于在页面与组件内复用。
 */
import type { EpochMs } from '#shared/types'

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** 10000 单位 → "100.00"；null/NaN → "—" */
export function formatScoreUnits(units: number | null | undefined): string {
  if (units === null || units === undefined || !Number.isFinite(units)) return '—'
  return (units / 100).toFixed(2)
}

/** 单位 → 改分输入框默认值（如 "3.50"） */
export function scoreUnitsToInput(units: number | null | undefined): string {
  if (units === null || units === undefined || !Number.isFinite(units)) return ''
  return (units / 100).toFixed(2)
}

/** 浏览器 IANA 时区；取不到时回退到 Asia/Shanghai（契约 §8.5 要求前端必须传） */
export function browserTimeZone(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
    return resolved || 'Asia/Shanghai'
  } catch {
    return 'Asia/Shanghai'
  }
}

interface ZonedWallClock {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  second: string
}

function zonedWallClock(ms: EpochMs, timeZone: string): ZonedWallClock {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return {
    year: parts.year ?? '0000',
    month: parts.month ?? '00',
    day: parts.day ?? '00',
    // Safari/旧版 ICU 会把午夜给成 "24"，统一归零
    hour: parts.hour === '24' ? '00' : parts.hour ?? '00',
    minute: parts.minute ?? '00',
    second: parts.second ?? '00',
  }
}

/** UTC 毫秒 → 目标时区偏移（分钟，东为正） */
export function timeZoneOffsetMinutes(ms: EpochMs, timeZone: string): number {
  const wall = zonedWallClock(ms, timeZone)
  const asUtc = Date.UTC(
    Number(wall.year),
    Number(wall.month) - 1,
    Number(wall.day),
    Number(wall.hour),
    Number(wall.minute),
    Number(wall.second),
  )
  return Math.round((asUtc - ms) / 60_000)
}

/** 时刻 → "YYYY-MM-DD HH:mm" */
export function formatDateTime(ms: EpochMs | null | undefined, timeZone = browserTimeZone()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const wall = zonedWallClock(ms, timeZone)
  return `${wall.year}-${wall.month}-${wall.day} ${wall.hour}:${wall.minute}`
}

/** 时刻 → "YYYY-MM-DD HH:mm:ss" */
export function formatDateTimeSeconds(ms: EpochMs | null | undefined, timeZone = browserTimeZone()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const wall = zonedWallClock(ms, timeZone)
  return `${wall.year}-${wall.month}-${wall.day} ${wall.hour}:${wall.minute}:${wall.second}`
}

/** 时刻 → "YYYY-MM-DD" */
export function formatDate(ms: EpochMs | null | undefined, timeZone = browserTimeZone()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const wall = zonedWallClock(ms, timeZone)
  return `${wall.year}-${wall.month}-${wall.day}`
}

/** 时刻 → "HH:mm" */
export function formatTime(ms: EpochMs | null | undefined, timeZone = browserTimeZone()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const wall = zonedWallClock(ms, timeZone)
  return `${wall.hour}:${wall.minute}`
}

/** 时刻 → datetime-local 输入值 "YYYY-MM-DDTHH:mm" */
export function toDateTimeInputValue(ms: EpochMs | null | undefined, timeZone = browserTimeZone()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return ''
  const wall = zonedWallClock(ms, timeZone)
  return `${wall.year}-${wall.month}-${wall.day}T${wall.hour}:${wall.minute}`
}

/** 时刻 → 带时区偏移的 ISO 8601（契约 §6.1 的时间入参格式） */
export function toIsoWithOffset(ms: EpochMs, timeZone = browserTimeZone()): string {
  const wall = zonedWallClock(ms, timeZone)
  const offset = timeZoneOffsetMinutes(ms, timeZone)
  const sign = offset >= 0 ? '+' : '-'
  const absolute = Math.abs(offset)
  return `${wall.year}-${wall.month}-${wall.day}T${wall.hour}:${wall.minute}:${wall.second}${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
}

/** 正计时展示：HH:MM:SS（不显示倒计时，契约 §10.3） */
export function formatClock(ms: number | null | undefined): string {
  const safe = ms === null || ms === undefined || !Number.isFinite(ms) ? 0 : Math.max(0, ms)
  const totalSeconds = Math.floor(safe / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
}

/** 人类可读时长："3 分 20 秒" / "1 小时 5 分" / "0 秒" */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  if (minutes > 0) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  return `${seconds} 秒`
}

/** 字节数 → "1.2 MB" */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 剩余时长的人类描述："2 天 3 小时后开始" */
export function formatRelativeToNow(target: EpochMs, now: EpochMs): string {
  const diff = target - now
  if (!Number.isFinite(diff)) return '—'
  if (diff <= 0) return '已到期'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟后`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时后`
  const days = Math.floor(hours / 24)
  return `${days} 天 ${hours % 24} 小时后`
}
