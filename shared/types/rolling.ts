import type { AnswerRevealPolicy, BlueprintDTO } from './exam'
import type { BankAvailabilityDTO, BankFilters } from './question-bank'

export interface RollingConfig {
  enabled: boolean
  title: string
  instructions: string
  timeZone: string
  startsAtTime: string
  endsAtTime: string
  blueprint: BlueprintDTO
  filters: BankFilters
  answerRevealPolicy: AnswerRevealPolicy
}

export interface RollingRunDTO {
  date: string
  examId: string | null
  status: 'succeeded' | 'failed'
  errorMessage: string
  createdAt: number
}

export interface RollingDTO {
  config: RollingConfig
  version: number
  today: RollingRunDTO | null
  recent: RollingRunDTO[]
  nextRunAt: number | null
  availability: BankAvailabilityDTO
}
