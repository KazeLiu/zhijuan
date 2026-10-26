import { DEFAULT_EXAM_TIME_ZONE } from '../constants'

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
