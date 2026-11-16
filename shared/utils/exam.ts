import { DEFAULT_EXAM_TIME_ZONE } from '../constants'
import type { EpochMs } from '../types/common'
import type { ExamPhase, ExamStatus } from '../types/exam'

/** 场次默认名称按所选时区的当天日期生成。 */
export function defaultExamTitle(now: number, timeZone = DEFAULT_EXAM_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now)
  const year = parts.find((part) => part.type === 'year')!.value
  const month = parts.find((part) => part.type === 'month')!.value
  const day = parts.find((part) => part.type === 'day')!.value
  return `${year}年${month}月${day}日 测试`
}

/**
 * 实际结束时刻（契约 §2）：提前结束时取 endedAt 与 endsAt 中较早者。
 * 展示与揭示时刻都走这里，避免 endedAt 晚于 endsAt 时出现「结束后又开放」。
 */
export function effectiveEndsAt(endsAt: EpochMs, endedAt: EpochMs | null): EpochMs {
  return endedAt !== null && endedAt < endsAt ? endedAt : endsAt
}

/**
 * 场次阶段（契约 §2，前后端唯一口径）。
 * 判定顺序：草稿 → 已结束（endedAt 非空或越过实际结束时刻）→ 已暂停 → 未开始 → 开放。
 * 「已结束优先于已暂停」：暂停后被提前结束的场次显示为 closed，而不是 paused。
 */
export function computeExamPhase(
  status: ExamStatus,
  startsAt: EpochMs,
  endsAt: EpochMs,
  now: EpochMs,
  pausedAt: EpochMs | null = null,
  endedAt: EpochMs | null = null,
): ExamPhase {
  if (status === 'draft') return 'draft'
  const effectiveEnd = effectiveEndsAt(endsAt, endedAt)
  if (endedAt !== null || now >= effectiveEnd) return 'closed'
  if (pausedAt !== null) return 'paused'
  if (now < startsAt) return 'upcoming'
  return 'open'
}
