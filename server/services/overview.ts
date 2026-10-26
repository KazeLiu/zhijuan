import type { DatabaseSync } from 'node:sqlite'
import type { AdminOverviewDTO, OverviewExamDTO } from '../../shared/types/admin'
import {
  countExamsByStatus,
  countQuestionsOfExam,
  findNextExam,
  findOpenExam,
  type ExamRow,
} from '../db/queries/exams'
import { countAttempts } from '../db/queries/attempts'
import { countFailedJobs } from '../db/queries/jobs'
import { processTimeZone } from '../utils/time'

function toOverviewExam(db: DatabaseSync, exam: ExamRow): OverviewExamDTO {
  const counts = countAttempts(db, exam.id)
  return {
    id: exam.id,
    title: exam.title,
    startsAt: exam.startsAt,
    endsAt: exam.endsAt,
    timeZone: exam.timeZone,
    questionCount: countQuestionsOfExam(db, exam.id),
    startedCount: counts.total,
    inProgressCount: counts.inProgress,
    submittedCount: counts.submitted,
  }
}

/** 管理端概览（§8.4 11） */
export function loadAdminOverview(db: DatabaseSync, now: number): AdminOverviewDTO {
  const current = findOpenExam(db, now)
  const next = findNextExam(db, now)
  return {
    serverNow: now,
    serverTimeZone: processTimeZone(),
    currentExam: current ? toOverviewExam(db, current) : null,
    nextExam: next ? toOverviewExam(db, next) : null,
    draftCount: countExamsByStatus(db, 'draft'),
    publishedCount: countExamsByStatus(db, 'published'),
    failedJobCount: countFailedJobs(db),
  }
}
