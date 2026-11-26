import type { EpochMs } from './common'

export interface BlankCorrectionSelection {
  questionId: string
  blankId: string
  answers: string[]
}

export interface BlankCorrectionInput {
  expectedVersion: number
  selections: BlankCorrectionSelection[]
  syncToBank: boolean
  reason: string
}

export interface BlankCorrectionImpact {
  attemptId: string
  name: string
  autoBefore: number
  autoAfter: number
  totalBefore: number
  totalAfter: number
  passedBefore: boolean
  passedAfter: boolean
  manualPreserved: number
}

export interface BlankCorrectionPreviewDTO {
  id: string
  examVersion: number
  reason: string
  createdBy: string
  appliedBy: string | null
  createdAt: EpochMs
  appliedAt: EpochMs | null
  changes: Array<{ questionId: string; position: number; blankId: string; before: string[]; added: string[]; after: string[] }>
  impacts: BlankCorrectionImpact[]
  scoreChangedCount: number
  manualPreservedCount: number
  bankSyncedCount: number
  warnings: string[]
}

export interface BlankCorrectionPageDTO {
  exam: { id: string; title: string; version: number }
  canCorrect: boolean
  lockReason: string
  questions: Array<{
    id: string
    position: number
    stem: string
    blanks: Array<{
      id: string
      position: number
      acceptedAnswers: string[]
      groups: Array<{ value: string; label: string; spellings: string[]; people: number }>
    }>
  }>
  submittedCount: number
  policyRegradeCount: number
  history: BlankCorrectionPreviewDTO[]
}
