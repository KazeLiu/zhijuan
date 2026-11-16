import type { BlueprintDTO } from '../../shared/types/exam'
import type { BankSourceRef } from '../../shared/types/question-bank'
import type { BankRecord } from '../db/queries/question-bank'
import { QUESTION_TYPES, type QuestionType } from '../../shared/types/question'
import { shuffle } from '../utils/shuffle'

export const BLUEPRINT_KEYS = { single_choice: 'singleChoice', multiple_choice: 'multipleChoice', true_false: 'trueFalse', fill_blank: 'fillBlank' } as const

export function bankSourceGroupKey(item: { id: string; sourceGroup?: string; sourceRefs: BankSourceRef[] }): string {
  if (!item.sourceGroup) return `item:${item.id}`
  const files = [...new Set(item.sourceRefs.map((ref) => ref.libraryFileId))].sort()
  return JSON.stringify([files, item.sourceGroup.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()])
}

/** 题型名额与考点组做二分匹配，允许重分配先前名额，避免贪心抽取造成假缺题。 */
export function selectBankQuestions(items: BankRecord[], blueprint: BlueprintDTO, lastUsed = new Map<string, number>()) {
  const groups = new Map<string, BankRecord[]>()
  for (const item of shuffle(items)) {
    const key = bankSourceGroupKey(item)
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  const keys = [...groups.keys()].sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0))
  const candidates = new Map(QUESTION_TYPES.map((type) => [type, keys.filter((key) => groups.get(key)!.some((item) => item.type === type))]))
  const slots = QUESTION_TYPES.flatMap((type) => Array.from({ length: blueprint[BLUEPRINT_KEYS[type]] }, () => type))
  const owners = new Map<string, number>()
  const assigned: Array<string | undefined> = []
  function match(index: number, visited: Set<string>): boolean {
    for (const key of candidates.get(slots[index]!)!) {
      if (visited.has(key)) continue
      visited.add(key)
      const previous = owners.get(key)
      if (previous === undefined || match(previous, visited)) {
        owners.set(key, index)
        assigned[index] = key
        return true
      }
    }
    return false
  }
  slots.forEach((_, index) => match(index, new Set()))
  const picked = slots.flatMap((type, index) => {
    const key = assigned[index]
    return key === undefined ? [] : [groups.get(key)!.find((item) => item.type === type)!]
  })
  const required = {} as Record<QuestionType, number>
  const available = {} as Record<QuestionType, number>
  const missing = {} as Record<QuestionType, number>
  for (const type of QUESTION_TYPES) {
    required[type] = blueprint[BLUEPRINT_KEYS[type]]
    available[type] = candidates.get(type)!.length
    missing[type] = required[type] - picked.filter((item) => item.type === type).length
  }
  return { picked, required, available, missing, groupCount: groups.size }
}
