import { randomInt } from 'node:crypto'

/** 无放回随机排列，供一次性 AI 候选池与题库组卷共用。 */
export function shuffle<T>(items: T[]): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapWith = randomInt(0, index + 1)
    const current = copy[index]!
    copy[index] = copy[swapWith]!
    copy[swapWith] = current
  }
  return copy
}
