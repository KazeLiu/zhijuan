import type { DatabaseSync } from 'node:sqlite'
import type { BankMistakeStats, QuestionContentInput } from '../../shared/types/question-bank'
import type { CandidateAnswer } from '../../shared/types/question'
import { listBankSamples, type BankRecord } from '../db/queries/question-bank'
import { isEmptyAnswer, normalizeBlank } from './grading'

const normalize = (text: string): string => text.normalize('NFC').trim().replace(/\s+/gu, ' ')

export function bankContentKey(question: Pick<QuestionContentInput, 'type' | 'stem' | 'options'>): string {
  return JSON.stringify([question.type, normalize(question.stem), question.options.map((option) => [option.id, normalize(option.text)])])
}

/** 内容键不包含答案，统计可比性另行比较完整判分定义。 */
export function bankComparableKey(question: Pick<QuestionContentInput, 'type' | 'stem' | 'options' | 'answerDefinition'>): string {
  const definition = question.answerDefinition
  return JSON.stringify([
    bankContentKey(question), [...definition.correctOptionIds].sort(),
    definition.blanks.map((blank) => [blank.id,
      [...new Set(blank.acceptedAnswers.map((answer) => normalizeBlank(answer)))].sort()]),
  ])
}

export function bankMistakeStats(db: DatabaseSync, items: BankRecord[]): Map<string, BankMistakeStats> {
  const expected = new Map(items.map((item) => [item.id, bankComparableKey(item)]))
  const knownQuestions = new Map<string, string>()
  const attempts = new Map(items.map((item) => [item.id, new Map<string, 'unanswered' | 'correct' | 'partial' | 'zero'>()]))
  for (const row of listBankSamples(db, items.map((item) => item.id))) {
    let content = knownQuestions.get(row.question_id)
    if (content === undefined) {
      content = bankComparableKey({ type: row.type, stem: row.stem,
        options: JSON.parse(row.options_json) as QuestionContentInput['options'],
        answerDefinition: JSON.parse(row.answer_definition_json) as QuestionContentInput['answerDefinition'] })
      knownQuestions.set(row.question_id, content)
    }
    if (content !== expected.get(row.bank_id)) continue
    const samples = attempts.get(row.bank_id)!
    if (samples.has(row.attempt_id)) continue
    const answer = row.answer_json === null ? null : JSON.parse(row.answer_json) as CandidateAnswer
    samples.set(row.attempt_id, row.final_score === row.max_score_units ? 'correct'
      : row.final_score > 0 ? 'partial' : isEmptyAnswer(answer) ? 'unanswered' : 'zero')
  }
  const result = new Map<string, BankMistakeStats>()
  for (const [id, samples] of attempts) {
    const stats: BankMistakeStats = { sampleSize: samples.size, correctCount: 0, partialCount: 0, zeroCount: 0,
      errorCount: 0, unansweredCount: 0, errorRate: null, isErrorProne: false }
    for (const state of samples.values()) {
      if (state === 'unanswered') stats.unansweredCount += 1
      else if (state === 'correct') stats.correctCount += 1
      else if (state === 'partial') stats.partialCount += 1
      else stats.zeroCount += 1
    }
    stats.errorCount = stats.sampleSize - stats.correctCount
    stats.errorRate = stats.sampleSize ? stats.errorCount / stats.sampleSize : null
    stats.isErrorProne = stats.errorCount > 0
    result.set(id, stats)
  }
  return result
}

/** 先筛选有错误记录的题再排名，列表分页与错题组卷共用同一顺序。 */
export function rankBankMistakes(items: BankRecord[], stats: Map<string, BankMistakeStats>): BankRecord[] {
  return items.filter((item) => stats.get(item.id)!.isErrorProne).sort((a, b) => {
    const left = stats.get(a.id)!, right = stats.get(b.id)!
    return right.errorRate! - left.errorRate! || right.sampleSize - left.sampleSize || a.id.localeCompare(b.id)
  })
}
