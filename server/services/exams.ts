import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import type {
  AnswerRevealPolicy,
  CurrentExamDTO,
  ExamAdminDTO,
  ExamListRowDTO,
  ExamPublicDTO,
  MyAttemptBriefDTO,
  PublishChecklistItem,
} from '../../shared/types/exam'
import { EMPTY_BLUEPRINT, blueprintTotal } from '../../shared/types/exam'
import type { BlueprintDTO } from '../../shared/types/exam'
import {
  DIFFICULTIES,
  MAX_INSTRUCTIONS_CHARS,
  MAX_QUESTIONS,
  MAX_TITLE_CHARS,
  MAX_EXTRA_PROMPT_CHARS,
  SCORE_TOTAL_UNITS,
} from '../../shared/constants'
import {
  countAttemptsOfExam,
  countQuestionsOfExam,
  deleteExamRow,
  findExam,
  findLatestClosedExam,
  findNextExam,
  findOpenExam,
  findOverlappingPublished,
  examPhase,
  insertExam,
  listExams,
  publishExamRow,
  unpublishExamRow,
  updateExamDraft,
  type ExamListRow,
  type ExamRow,
  type ExamWrite,
} from '../db/queries/exams'
import { findActiveJob, findLatestJob, toJobDTO } from '../db/queries/jobs'
import { listDocuments, toDocumentDTO } from '../db/queries/documents'
import { listQuestions, toQuestionAdminDTO } from '../db/queries/questions'
import { findAttemptByName, type AttemptRecord } from '../db/queries/attempts'
import { ApiFailure, throwApi } from '../utils/respond'
import { withTransaction } from '../utils/db'
import { FieldErrors, isPlainObject, readExpectedVersion } from '../utils/validate'
import { parseIsoInstant, parseTimeZone, processTimeZone, startOfDayInZone, startOfNextDayInZone } from '../utils/time'
import { getUploadsDir } from '../utils/paths'
import { countByType, findStoredQuestionIssue, questionCountValid } from './questions'
import { validateSourceRefs } from './documents'

/* ------------------------------ DTO 映射 ------------------------------ */

export function toExamPublicDTO(exam: ExamRow): ExamPublicDTO {
  return {
    id: exam.id,
    title: exam.title,
    instructions: exam.instructions,
    timeZone: exam.timeZone,
    startsAt: exam.startsAt,
    endsAt: exam.endsAt,
    answerRevealPolicy: exam.answerRevealPolicy,
  }
}

export function toExamListRowDTO(row: ExamListRow): ExamListRowDTO {
  return {
    id: row.exam.id,
    title: row.exam.title,
    status: row.exam.status,
    phase: examPhase(row.exam, Date.now()),
    startsAt: row.exam.startsAt,
    endsAt: row.exam.endsAt,
    timeZone: row.exam.timeZone,
    answerRevealPolicy: row.exam.answerRevealPolicy,
    questionCount: row.questionCount,
    attemptCount: row.attemptCount,
    submittedCount: row.submittedCount,
    version: row.exam.version,
    updatedAt: row.exam.updatedAt,
  }
}

/* ------------------------------ 发布预检（§8.5 25） ------------------------------ */

function refsValid(db: DatabaseSync, examId: string, questionIndex: number, refs: unknown): boolean {
  try {
    validateSourceRefs(db, examId, refs as never, questionIndex)
    return true
  } catch {
    return false
  }
}

/** 八项预检：前端按 code 渲染预检面板，不通过时不落库 */
export function buildPublishChecklist(db: DatabaseSync, exam: ExamRow, now: number): PublishChecklistItem[] {
  const questions = listQuestions(db, exam.id)
  const counts = countByType(questions)
  const blueprint = exam.blueprint
  const totalUnits = questions.reduce((sum, question) => sum + question.maxScoreUnits, 0)
  const conflicts = findOverlappingPublished(db, exam.startsAt, exam.endsAt, exam.id)
  const activeJob = findActiveJob(db, exam.id)

  const structureProblems: string[] = []
  const answerProblems: string[] = []
  questions.forEach((question, index) => {
    const issue = findStoredQuestionIssue(question)
    const refsOk = issue === null && refsValid(db, exam.id, index, question.sourceRefs)
    if (!refsOk) structureProblems.push(`第 ${index + 1} 题：${issue ?? '资料引用无效'}`)
    const hasAnswer =
      question.type === 'fill_blank'
        ? question.answerDefinition.blanks.length > 0
        : question.answerDefinition.correctOptionIds.length > 0
    const hasRefs = question.sourceRefs.length > 0
    const hasExplanation = question.explanation.trim() !== ''
    if (!hasAnswer || !hasRefs || !hasExplanation) {
      answerProblems.push(`第 ${index + 1} 题缺少${!hasAnswer ? '标准答案' : !hasExplanation ? '解析' : '资料引用'}`)
    }
  })

  const typeCountsOk =
    counts.single_choice === blueprint.singleChoice &&
    counts.multiple_choice === blueprint.multipleChoice &&
    counts.true_false === blueprint.trueFalse &&
    counts.fill_blank === blueprint.fillBlank

  return [
    {
      code: 'title_and_time',
      ok: exam.title.trim() !== '' && exam.endsAt > now,
      message: exam.title.trim() === '' ? '标题不能为空' : exam.endsAt > now ? '标题与时间有效' : '结束时间必须晚于当前时间',
      hint: exam.endsAt <= now ? '请把结束时间调整到未来' : undefined,
    },
    {
      code: 'question_count',
      ok: questionCountValid(questions.length),
      message: questionCountValid(questions.length)
        ? `共 ${questions.length} 题`
        : `题数必须在 1..${MAX_QUESTIONS} 之间，当前 ${questions.length} 题`,
      hint: questions.length === 0 ? '先出题或手动录题' : undefined,
    },
    {
      code: 'type_counts',
      ok: typeCountsOk,
      message: typeCountsOk
        ? '各题型数量与出题设定一致'
        : `与出题设定不一致（单选 ${counts.single_choice}/${blueprint.singleChoice}，多选 ${counts.multiple_choice}/${blueprint.multipleChoice}，判断 ${counts.true_false}/${blueprint.trueFalse}，填空 ${counts.fill_blank}/${blueprint.fillBlank}）`,
      hint: typeCountsOk ? undefined : '调整题目或修改出题设定',
    },
    {
      code: 'question_structure',
      ok: structureProblems.length === 0,
      message: structureProblems.length === 0 ? '题目结构合法' : structureProblems.slice(0, 3).join('；'),
      hint: structureProblems.length > 0 ? '检查选项、标准答案与引用摘录' : undefined,
    },
    {
      code: 'answer_and_refs',
      ok: answerProblems.length === 0,
      message: answerProblems.length === 0 ? '标准答案、解析与引用齐备' : answerProblems.slice(0, 3).join('；'),
    },
    {
      code: 'score_total',
      ok: totalUnits === SCORE_TOTAL_UNITS,
      message:
        totalUnits === SCORE_TOTAL_UNITS
          ? '分值合计 10000 单位'
          : `分值合计 ${totalUnits} 单位，应为 ${SCORE_TOTAL_UNITS}`,
    },
    {
      code: 'no_active_job',
      ok: !activeJob,
      message: activeJob ? '出题任务进行中，请等待完成' : '无进行中的出题任务',
    },
    {
      code: 'time_conflict',
      ok: conflicts.length === 0,
      message:
        conflicts.length === 0
          ? '与其他场次无时间冲突'
          : `与 ${conflicts.length} 场已发布考试时间重叠：${conflicts.map((item) => item.title).join('、')}`,
      hint: conflicts.length > 0 ? '调整本场时间或先撤回冲突场次' : undefined,
    },
  ]
}

/** 管理端完整场次 */
export function getExamAdminDTO(db: DatabaseSync, examId: string, now: number): ExamAdminDTO {
  const exam = findExam(db, examId)
  if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
  const activeJob = findActiveJob(db, examId)
  const latestJob = activeJob ?? findLatestJob(db, examId)
  return {
    id: exam.id,
    title: exam.title,
    instructions: exam.instructions,
    status: exam.status,
    phase: examPhase(exam, now),
    startsAt: exam.startsAt,
    endsAt: exam.endsAt,
    timeZone: exam.timeZone,
    answerRevealPolicy: exam.answerRevealPolicy,
    blueprint: exam.blueprint,
    version: exam.version,
    questionCount: countQuestionsOfExam(db, examId),
    attemptCount: countAttemptsOfExam(db, examId),
    documents: listDocuments(db, examId).map(toDocumentDTO),
    questions: listQuestions(db, examId).map(toQuestionAdminDTO),
    activeJob: activeJob ? toJobDTO(activeJob) : null,
    latestJob: latestJob ? toJobDTO(latestJob) : null,
    publishChecklist: buildPublishChecklist(db, exam, now),
    createdAt: exam.createdAt,
    updatedAt: exam.updatedAt,
    serverNow: now,
  }
}

/* ------------------------------ 写操作 ------------------------------ */

function readBlueprint(body: Record<string, unknown>, errors: FieldErrors): BlueprintDTO | undefined {
  const raw = body.blueprint
  if (raw === undefined || raw === null) return undefined
  if (!isPlainObject(raw)) {
    errors.add('blueprint', '出题设定格式不正确')
    return undefined
  }
  const readCount = (field: string, label: string): number =>
    errors.int(raw, field, label, { min: 0, max: MAX_QUESTIONS }) ?? 0
  const singleChoice = readCount('singleChoice', '单选题数量')
  const multipleChoice = readCount('multipleChoice', '多选题数量')
  const trueFalse = readCount('trueFalse', '判断题数量')
  const fillBlank = readCount('fillBlank', '填空题数量')
  const difficultyRaw = raw.difficulty
  let difficulty: BlueprintDTO['difficulty'] = 'normal'
  if (difficultyRaw !== undefined && difficultyRaw !== null) {
    if (typeof difficultyRaw === 'string' && (DIFFICULTIES as readonly string[]).includes(difficultyRaw)) {
      difficulty = difficultyRaw as BlueprintDTO['difficulty']
    } else {
      errors.add('blueprint.difficulty', '难度取值不合法')
    }
  }
  const extraPrompt = errors.text(raw, 'extraPrompt', '出题补充说明', { max: MAX_EXTRA_PROMPT_CHARS }) ?? ''
  const blueprint: BlueprintDTO = { singleChoice, multipleChoice, trueFalse, fillBlank, difficulty, extraPrompt }
  if (blueprintTotal(blueprint) > MAX_QUESTIONS) {
    errors.add('blueprint', `题目合计不能超过 ${MAX_QUESTIONS} 道`)
  }
  return blueprint
}

/** 新建场次：缺省标题、当天 00:00 至次日 00:00（按入参时区，§8.5 16） */
export function createExam(db: DatabaseSync, body: Record<string, unknown>, now: number): ExamRow {
  const errors = new FieldErrors()
  const titleInput = errors.text(body, 'title', '标题', { max: MAX_TITLE_CHARS })
  const timeZone = body.timeZone === undefined || body.timeZone === null || body.timeZone === ''
    ? processTimeZone()
    : parseTimeZone(body.timeZone, 'timeZone')
  errors.throwIfAny()

  const title = (titleInput ?? '').trim() === '' ? '未命名考试' : (titleInput ?? '').trim()
  const startsAt = startOfDayInZone(timeZone, now)
  const endsAt = startOfNextDayInZone(timeZone, startsAt)
  const id = randomUUID()
  const write: ExamWrite = {
    title,
    instructions: '',
    startsAt,
    endsAt,
    timeZone,
    answerRevealPolicy: 'immediate',
    blueprint: { ...EMPTY_BLUEPRINT },
  }
  withTransaction(db, () => insertExam(db, id, write, now))
  const created = findExam(db, id)
  if (!created) throw new ApiFailure('INTERNAL_ERROR', '场次创建后无法读取')
  return created
}

function assertDraftEditable(db: DatabaseSync, exam: ExamRow): void {
  if (exam.status !== 'draft') {
    throwApi('EXAM_LOCKED', '已发布的场次不能修改', { reason: 'published' })
  }
  if (findActiveJob(db, exam.id)) {
    throwApi('EXAM_HAS_ACTIVE_JOB', '出题任务进行中，暂不能修改场次')
  }
}

/** 修改草稿（§8.5 18）：时间冲突允许保存，只在预检中标记 */
export function updateExam(db: DatabaseSync, examId: string, body: Record<string, unknown>, now: number): ExamRow {
  const expectedVersion = readExpectedVersion(body)
  return withTransaction(db, () => {
    const exam = findExam(db, examId)
    if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
    assertDraftEditable(db, exam)
    if (exam.version !== expectedVersion) {
      throwApi('VERSION_CONFLICT', '场次已被更新，请刷新后重试', { serverVersion: exam.version })
    }

    const errors = new FieldErrors()
    const title = errors.text(body, 'title', '标题', { max: MAX_TITLE_CHARS })
    const instructions = errors.text(body, 'instructions', '考试说明', { max: MAX_INSTRUCTIONS_CHARS })
    const policy = errors.oneOf<AnswerRevealPolicy>(
      body,
      'answerRevealPolicy',
      '答案公开策略',
      ['immediate', 'after_exam'],
    )
    const blueprint = readBlueprint(body, errors)
    const timeZone =
      body.timeZone === undefined || body.timeZone === null || body.timeZone === ''
        ? exam.timeZone
        : parseTimeZone(body.timeZone, 'timeZone')
    errors.throwIfAny()

    if (title !== undefined && title.trim() === '') {
      throw new ApiFailure('VALIDATION_FAILED', '请求参数校验失败', { fields: { title: '标题不能为空' } })
    }
    const startsAtRaw = body.startsAt
    const endsAtRaw = body.endsAt
    const startsAt = startsAtRaw === undefined || startsAtRaw === null ? exam.startsAt : parseIsoInstant(startsAtRaw, 'startsAt')
    const endsAt = endsAtRaw === undefined || endsAtRaw === null ? exam.endsAt : parseIsoInstant(endsAtRaw, 'endsAt')
    if (endsAt <= startsAt) {
      throw new ApiFailure('VALIDATION_FAILED', '请求参数校验失败', { fields: { endsAt: '结束时间必须晚于开始时间' } })
    }

    const write: ExamWrite = {
      title: title === undefined ? exam.title : title.trim(),
      instructions: instructions === undefined ? exam.instructions : instructions,
      startsAt,
      endsAt,
      timeZone,
      answerRevealPolicy: policy ?? exam.answerRevealPolicy,
      blueprint: blueprint ?? exam.blueprint,
    }
    updateExamDraft(db, examId, write, now)
    const updated = findExam(db, examId)
    if (!updated) throw new ApiFailure('INTERNAL_ERROR', '场次更新后无法读取')
    return updated
  })
}

/** 删除草稿（§8.5 19）：连库带文件一起清理 */
export async function deleteExam(db: DatabaseSync, examId: string): Promise<void> {
  const exam = findExam(db, examId)
  if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
  if (exam.status !== 'draft') {
    throwApi('EXAM_LOCKED', '已发布的场次不能删除', { reason: 'published' })
  }
  const attemptCount = countAttemptsOfExam(db, examId)
  if (attemptCount > 0) {
    throwApi('EXAM_HAS_ATTEMPTS', '该场次已有答卷，不能删除', { reason: 'has_attempts', attemptCount })
  }
  withTransaction(db, () => deleteExamRow(db, examId))
  await rm(join(getUploadsDir(), examId), { recursive: true, force: true }).catch(() => undefined)
}

/** 发布（§8.5 25）：八项预检全过才落库；时间冲突优先返回 409 */
export function publishExam(db: DatabaseSync, examId: string, now: number): ExamRow {
  return withTransaction(db, () => {
    const exam = findExam(db, examId)
    if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
    if (exam.status !== 'draft') {
      throwApi('EXAM_LOCKED', '该场次已经发布', { reason: 'published' })
    }
    const conflicts = findOverlappingPublished(db, exam.startsAt, exam.endsAt, examId)
    if (conflicts.length > 0) {
      throwApi('EXAM_TIME_CONFLICT', '与已发布场次时间冲突', {
        conflicts: conflicts.map((item) => ({
          examId: item.id,
          title: item.title,
          startsAt: item.startsAt,
          endsAt: item.endsAt,
          timeZone: item.timeZone,
        })),
      })
    }
    const checks = buildPublishChecklist(db, exam, now)
    if (checks.some((item) => !item.ok)) {
      throw new ApiFailure('PUBLISH_PRECHECK_FAILED', '发布前检查未通过', { checks })
    }
    publishExamRow(db, examId, now)
    const published = findExam(db, examId)
    if (!published) throw new ApiFailure('INTERNAL_ERROR', '发布后无法读取场次')
    return published
  })
}

/** 撤回发布（§8.5 26） */
export function unpublishExam(db: DatabaseSync, examId: string, now: number): ExamRow {
  return withTransaction(db, () => {
    const exam = findExam(db, examId)
    if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
    if (exam.status !== 'published') {
      throwApi('EXAM_NOT_PUBLISHED', '该场次不是已发布状态')
    }
    const attemptCount = countAttemptsOfExam(db, examId)
    if (attemptCount > 0) {
      throwApi('EXAM_HAS_ATTEMPTS', '该场次已有答卷，不能撤回', { reason: 'has_attempts', attemptCount })
    }
    if (now >= exam.startsAt) {
      throwApi('EXAM_HAS_ATTEMPTS', '场次已经开始，不能撤回', { reason: 'started' })
    }
    unpublishExamRow(db, examId, now)
    const updated = findExam(db, examId)
    if (!updated) throw new ApiFailure('INTERNAL_ERROR', '撤回后无法读取场次')
    return updated
  })
}

export function listExamRows(
  db: DatabaseSync,
  filter: { status?: 'draft' | 'published'; keyword?: string; limit: number; offset: number },
): { rows: ExamListRow[]; total: number } {
  return listExams(db, filter)
}

/* ------------------------------ 考生端场次 ------------------------------ */

function attemptBrief(attempt: AttemptRecord): MyAttemptBriefDTO {
  return {
    attemptId: attempt.id,
    status: attempt.status,
    startedAt: attempt.startedAt,
    submittedAt: attempt.submittedAt,
    totalScoreUnits: attempt.totalScoreUnits,
  }
}

/** 当前场次（§8.3 4）：开放 → 已结束 → 下一场 → 无 */
export function buildCurrentExam(db: DatabaseSync, nameKey: string, now: number): CurrentExamDTO {
  const openExam = findOpenExam(db, now)
  const nextExam = findNextExam(db, now)
  if (openExam) {
    const attempt = findAttemptByName(db, openExam.id, nameKey)
    return {
      serverNow: now,
      phase: 'open',
      exam: toExamPublicDTO(openExam),
      nextExam: nextExam ? toExamPublicDTO(nextExam) : null,
      myAttempt: attempt ? attemptBrief(attempt) : null,
    }
  }
  if (nextExam) {
    return {
      serverNow: now,
      phase: 'upcoming',
      exam: null,
      nextExam: toExamPublicDTO(nextExam),
      myAttempt: null,
    }
  }
  const closedExam = findLatestClosedExam(db, now)
  if (closedExam) {
    const attempt = findAttemptByName(db, closedExam.id, nameKey)
    return {
      serverNow: now,
      phase: 'closed',
      exam: toExamPublicDTO(closedExam),
      nextExam: null,
      myAttempt: attempt ? attemptBrief(attempt) : null,
    }
  }
  return { serverNow: now, phase: 'none', exam: null, nextExam: null, myAttempt: null }
}
