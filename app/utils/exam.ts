/**
 * 场次相关的展示与时间换算（契约 §6.1 / §8.5）。
 * 时区换算集中在这里，页面只负责取 IANA 时区名与展示。
 */
import type {
  AnswerRevealPolicy,
  CandidateExamPhase,
  ExamPhase,
  ExamStatus,
  EpochMs,
} from '#shared/types'
import { PASS_SCORE_UNITS } from '#shared/constants'
import { ApiClientError, describeApiError } from '~/composables/useApi'
import type { ApiClientCode } from '~/composables/useApi'
import { browserTimeZone, formatDateTime, timeZoneOffsetMinutes, toIsoWithOffset } from './format'

export type TagType = 'primary' | 'success' | 'info' | 'warning' | 'danger'

export const EXAM_PHASE_LABELS: Record<ExamPhase, string> = {
  draft: '草稿',
  upcoming: '未开始',
  open: '开放中',
  paused: '已暂停',
  closed: '已结束',
}

/** 阶段标签配色：未开始=蓝、开放中=绿、已暂停=橙、草稿与已结束=灰，避免「未开始」与「已暂停」撞色 */
export const EXAM_PHASE_TAG_TYPES: Record<ExamPhase, TagType> = {
  draft: 'info',
  upcoming: 'primary',
  open: 'success',
  paused: 'warning',
  closed: 'info',
}

/** 场次生命周期错误码的固定中文文案（契约 §7） */
export const LIFECYCLE_ERROR_MESSAGES: Partial<Record<ApiClientCode, string>> = {
  EXAM_ALREADY_PAUSED: '场次已暂停',
  EXAM_NOT_PAUSED: '场次当前不是暂停状态',
  EXAM_ALREADY_ENDED: '场次已结束',
  EXAM_STRUCTURE_LOCKED: '暂停状态只能修改题干、选项、答案与解析，不能增删题目或改题型',
}

/** 错误 → 可展示文案：命中生命周期错误码用固定中文，否则回落到服务端 message */
export function describeLifecycleError(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) {
    const fixed = LIFECYCLE_ERROR_MESSAGES[error.code]
    if (fixed) return fixed
  }
  return describeApiError(error, fallback)
}

export const CANDIDATE_PHASE_LABELS: Record<CandidateExamPhase, string> = {
  open: '正在开放',
  upcoming: '尚未开始',
  closed: '已结束',
  none: '暂无考试',
}

export const REVEAL_POLICY_LABELS: Record<AnswerRevealPolicy, string> = {
  immediate: '交卷后立即公开答案与解析',
  after_exam: '考试结束后公开答案与解析',
}

/** 常用时区选项（可自行输入其它 IANA 时区） */
export const COMMON_TIME_ZONES = [
  { label: 'Asia/Shanghai（北京时间 UTC+8）', value: 'Asia/Shanghai' },
  { label: 'Asia/Hong_Kong（香港 UTC+8）', value: 'Asia/Hong_Kong' },
  { label: 'Asia/Singapore（新加坡 UTC+8）', value: 'Asia/Singapore' },
  { label: 'Asia/Tokyo（东京 UTC+9）', value: 'Asia/Tokyo' },
  { label: 'UTC（协调世界时）', value: 'UTC' },
  { label: 'Europe/London（伦敦）', value: 'Europe/London' },
  { label: 'America/New_York（纽约）', value: 'America/New_York' },
] as const

/** 用服务端时间本地推算阶段；服务端时间仍是权威（契约 §2：已结束优先于已暂停） */
export function computeExamPhase(
  status: ExamStatus,
  startsAt: EpochMs,
  endsAt: EpochMs,
  now: EpochMs,
  pausedAt: EpochMs | null = null,
  endedAt: EpochMs | null = null,
): ExamPhase {
  if (status === 'draft') return 'draft'
  const effectiveEnd = endedAt !== null && endedAt < endsAt ? endedAt : endsAt
  if (endedAt !== null || now >= effectiveEnd) return 'closed'
  if (pausedAt !== null) return 'paused'
  if (now < startsAt) return 'upcoming'
  return 'open'
}

/** 是否及格（6000 单位 = 60.00 分） */
export function isPassed(totalScoreUnits: number | null | undefined): boolean {
  if (totalScoreUnits === null || totalScoreUnits === undefined) return false
  return totalScoreUnits >= PASS_SCORE_UNITS
}

/** "2026-10-24 00:00 ~ 2026-10-25 00:00" */
export function formatExamWindow(startsAt: EpochMs, endsAt: EpochMs, timeZone = browserTimeZone()): string {
  return `${formatDateTime(startsAt, timeZone)} ~ ${formatDateTime(endsAt, timeZone)}`
}

/** 把 datetime-local 的墙上时间按指定时区解释为 UTC 毫秒 */
export function wallClockToEpoch(wall: string, timeZone: string): EpochMs | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(wall.trim())
  if (!matched) return null
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  const hour = Number(matched[4])
  const minute = Number(matched[5])
  const second = matched[6] ? Number(matched[6]) : 0
  if (![year, month, day, hour, minute, second].every((value) => Number.isFinite(value))) return null
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  // 先按该瞬间的偏移猜一次，再用猜出的瞬间的偏移校正（处理夏令时切换）
  const firstGuess = asUtc - timeZoneOffsetMinutes(asUtc, timeZone) * 60_000
  const corrected = asUtc - timeZoneOffsetMinutes(firstGuess, timeZone) * 60_000
  return Number.isFinite(corrected) ? corrected : null
}

/** datetime-local 值 → 带偏移 ISO 字符串；非法输入返回 null */
export function wallClockToIso(wall: string, timeZone: string): string | null {
  const epoch = wallClockToEpoch(wall, timeZone)
  if (epoch === null) return null
  return toIsoWithOffset(epoch, timeZone)
}

/** 校验 IANA 时区名是否可用 */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}
