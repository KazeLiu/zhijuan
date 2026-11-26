import type { BankFilters, QuestionContentInput, QuestionType } from '#shared/types'
import { CHOICE_OPTION_IDS, TRUE_FALSE_OPTIONS } from '#shared/constants'

export function newQuestionContent(type: QuestionType = 'single_choice'): QuestionContentInput {
  return { type, stem: '', explanation: '',
    options: type === 'fill_blank' ? [] : type === 'true_false'
      ? TRUE_FALSE_OPTIONS.map((option) => ({ ...option })) : CHOICE_OPTION_IDS.map((id) => ({ id, text: '' })),
    answerDefinition: { correctOptionIds: [], blanks: type === 'fill_blank'
      ? [{ id: 'b1', acceptedAnswers: [''], caseSensitive: false }] : [] },
  }
}

export function bankFilterQuery(filters: BankFilters) {
  return { knowledgePoint: filters.knowledgePoints?.length ? filters.knowledgePoints : undefined,
    libraryFileId: filters.libraryFileIds?.length ? filters.libraryFileIds : undefined,
    difficulty: filters.difficulty, mistakeTopN: filters.mistakeTopN }
}
