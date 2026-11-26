import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { BlankCorrectionInput, BlankCorrectionPageDTO, BlankCorrectionPreviewDTO, BlankCorrectionSelection } from '../../shared/types/blank-correction'
import { MAX_BLANK_ANSWER_CHARS, MAX_GRADE_REASON_CHARS, PASS_SCORE_UNITS } from '../../shared/constants'
import { effectiveEndsAt } from '../../shared/utils/exam'
import { findExam, touchExamVersion, type ExamRow } from '../db/queries/exams'
import { findActiveJob } from '../db/queries/jobs'
import { listQuestions, type QuestionRow } from '../db/queries/questions'
import { findBankRecord, type BankRecord } from '../db/queries/question-bank'
import { bankContentKey } from './question-bank-stats'
import { normalizeBlank } from './grading'
import { buildRegradePlan, applyRegradePlan, type RegradeAttemptPlan } from './regrading'
import { FieldErrors, isPlainObject, readExpectedVersion } from '../utils/validate'
import { ApiFailure } from '../utils/respond'
import { withTransaction } from '../utils/db'

interface Snapshot { examVersion: number; attempts: Array<[string, number]>; banks: Array<[string, number]> }
interface CorrectionRow {
  id: string; input_json: string; snapshot_json: string; result_json: string; applied_at: number | null
}

function requireExam(db: DatabaseSync, id: string, expectedVersion?: number) {
  const exam = findExam(db, id)
  if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
  if (expectedVersion !== undefined && exam.version !== expectedVersion) throw new ApiFailure('VERSION_CONFLICT', '本场题目已变化，请刷新并重新预览')
  return exam
}

function correctionBlock(db: DatabaseSync, exam: ExamRow, now: number): string {
  if (findActiveJob(db, exam.id)) return '本场正在出题，请等待完成后纠正答案'
  if (exam.status === 'published' && !exam.pausedAt && now < effectiveEndsAt(exam.endsAt, exam.endedAt)) return '本场尚未结束，请先暂停考试，再纠正答案'
  return ''
}

function blankGroups(questions: QuestionRow[], plans: RegradeAttemptPlan[]): BlankCorrectionPageDTO['questions'] {
  return questions.filter((question) => question.type === 'fill_blank').map((question) => ({
    id: question.id, position: question.position, stem: question.stem,
    blanks: question.answerDefinition.blanks.map((blank, index) => {
      const accepted = new Set(blank.acceptedAnswers.map(normalizeBlank))
      const groups = new Map<string, { value: string; label: string; spellings: Set<string>; people: number }>()
      for (const plan of plans) {
        const answer = plan.answers[question.id]
        if (answer?.type !== 'fill_blank') continue
        const raw = answer.values[blank.id] ?? ''
        const value = normalizeBlank(raw)
        if (!value || accepted.has(value)) continue
        const group = groups.get(value) ?? { value, label: raw.normalize('NFC').trim(), spellings: new Set<string>(), people: 0 }
        group.people++
        group.spellings.add(raw)
        groups.set(value, group)
      }
      return { id: blank.id, position: index + 1, acceptedAnswers: blank.acceptedAnswers,
        groups: [...groups.values()].sort((a, b) => b.people - a.people || a.value.localeCompare(b.value))
          .map((group) => ({ ...group, spellings: [...group.spellings] })) }
    }),
  }))
}

function impacted(plans: RegradeAttemptPlan[]): RegradeAttemptPlan[] {
  return plans.filter((plan) => plan.needsUpdate)
}

export function getBlankCorrections(db: DatabaseSync, examId: string, now: number): BlankCorrectionPageDTO {
  const exam = requireExam(db, examId)
  const questions = listQuestions(db, examId)
  const plans = buildRegradePlan(db, examId, questions)
  const history = db.prepare('SELECT result_json FROM blank_corrections WHERE exam_id = ? AND applied_at IS NOT NULL ORDER BY applied_at DESC, id DESC LIMIT 20')
    .all(examId) as Array<{ result_json: string }>
  const lockReason = correctionBlock(db, exam, now)
  return { exam: { id: exam.id, title: exam.title, version: exam.version }, canCorrect: !lockReason, lockReason, questions: blankGroups(questions, plans),
    submittedCount: plans.length, policyRegradeCount: impacted(plans).length,
    history: history.map((row) => JSON.parse(row.result_json) as BlankCorrectionPreviewDTO) }
}

function readInput(body: Record<string, unknown>): BlankCorrectionInput {
  const expectedVersion = readExpectedVersion(body)
  const errors = new FieldErrors()
  const reason = errors.text(body, 'reason', '纠错原因', { required: true, max: MAX_GRADE_REASON_CHARS, trim: true }) ?? ''
  if (body.syncToBank !== undefined && typeof body.syncToBank !== 'boolean') errors.add('syncToBank', '同步题库必须为 true 或 false')
  errors.throwIfAny()
  if (!Array.isArray(body.selections)) throw new ApiFailure('VALIDATION_FAILED', '请传入选中的同义写法')
  const seen = new Set<string>()
  const selections = body.selections.map((raw): BlankCorrectionSelection => {
    if (!isPlainObject(raw) || typeof raw.questionId !== 'string' || typeof raw.blankId !== 'string'
      || !Array.isArray(raw.answers) || !raw.answers.length || raw.answers.some((answer) => typeof answer !== 'string' || !answer.trim() || Array.from(answer).length > MAX_BLANK_ANSWER_CHARS)) {
      throw new ApiFailure('VALIDATION_FAILED', '每项需指定题目、空位和有效的同义写法')
    }
    const key = JSON.stringify([raw.questionId, raw.blankId])
    if (seen.has(key)) throw new ApiFailure('VALIDATION_FAILED', '同一题目的同一空位不能重复提交')
    seen.add(key)
    return { questionId: raw.questionId, blankId: raw.blankId, answers: [...new Set((raw.answers as string[]).map(normalizeBlank))] }
  })
  return { expectedVersion, selections, reason, syncToBank: body.syncToBank === true }
}

function prepareCorrection(db: DatabaseSync, examId: string, input: BlankCorrectionInput, now: number) {
  const exam = requireExam(db, examId, input.expectedVersion)
  const block = correctionBlock(db, exam, now)
  if (block) throw new ApiFailure('EXAM_STRUCTURE_LOCKED', block)
  const questions = listQuestions(db, examId)
  if (!questions.some((question) => question.type === 'fill_blank')) throw new ApiFailure('VALIDATION_FAILED', '本场没有填空题，无需纠正填空答案')
  const priorPlans = buildRegradePlan(db, examId, questions)
  const groups = blankGroups(questions, priorPlans)
  const proposed = structuredClone(questions)
  const changes: BlankCorrectionPreviewDTO['changes'] = []
  for (const selection of input.selections) {
    const question = proposed.find((item) => item.id === selection.questionId && item.type === 'fill_blank')
    const blank = question?.answerDefinition.blanks.find((item) => item.id === selection.blankId)
    const group = groups.find((item) => item.id === selection.questionId)?.blanks.find((item) => item.id === selection.blankId)
    if (!question || !blank || !group) throw new ApiFailure('VALIDATION_FAILED', '所选填空题或空位不属于本场次')
    const added = selection.answers.map((value) => {
      const variant = group.groups.find((item) => item.value === value)
      if (!variant) throw new ApiFailure('VERSION_CONFLICT', '所选写法已被认可或作答记录已变化，请刷新并重新选择')
      return variant.label
    })
    const before = [...blank.acceptedAnswers]
    blank.acceptedAnswers.push(...added)
    changes.push({ questionId: question.id, position: question.position, blankId: blank.id, before, added, after: [...blank.acceptedAnswers] })
  }
  const banks = new Map<string, { original: BankRecord; definition: BankRecord['answerDefinition'] }>()
  const warnings: string[] = []
  if (input.syncToBank) for (const question of questions.filter((item) => changes.some((change) => change.questionId === item.id))) {
    const origins = db.prepare('SELECT id FROM question_bank_items WHERE origin_exam_id = ? AND origin_question_id = ? ORDER BY id')
      .all(examId, question.id) as Array<{ id: string }>
    const ids = [...new Set([...origins.map((row) => row.id), ...(question.bankOrigin ? [question.bankOrigin.itemId] : [])])]
    if (!ids.length) warnings.push(`第 ${question.position} 题未关联题库，本次只修正本场`)
    for (const id of ids) {
      const original = findBankRecord(db, id)
      if (!original) { warnings.push(`第 ${question.position} 题的源题库题已删除，本次只修正本场`); continue }
      if (bankContentKey(original) !== bankContentKey(question) || original.answerDefinition.blanks.length !== question.answerDefinition.blanks.length) {
        throw new ApiFailure('VERSION_CONFLICT', `第 ${question.position} 题的源题库内容已变化，请关闭同步题库后重试，或先核对题库`)
      }
      const entry = banks.get(id) ?? { original, definition: structuredClone(original.answerDefinition) }
      for (const change of changes.filter((item) => item.questionId === question.id)) {
        const oldBlank = question.answerDefinition.blanks.find((item) => item.id === change.blankId)!
        const target = entry.definition.blanks.find((item) => item.id === change.blankId)
        if (!target || oldBlank.acceptedAnswers.some((answer) => !target.acceptedAnswers.some((value) => normalizeBlank(value) === normalizeBlank(answer)))) {
          throw new ApiFailure('VERSION_CONFLICT', `第 ${question.position} 题与源题库的标准答案不一致，请关闭同步并核对`)
        }
        for (const answer of change.added) if (!target.acceptedAnswers.some((value) => normalizeBlank(value) === normalizeBlank(answer))) target.acceptedAnswers.push(answer)
        target.caseSensitive = false
      }
      banks.set(id, entry)
    }
  }
  const plans = buildRegradePlan(db, examId, proposed)
  const affected = impacted(plans)
  if (!changes.length && !affected.length) throw new ApiFailure('VALIDATION_FAILED', '未选择新的同义答案，当前也没有需要更新的自动分')
  const snapshot: Snapshot = { examVersion: exam.version, attempts: priorPlans.map((plan): [string, number] => [plan.id, plan.version]),
    banks: [...banks.values()].map(({ original }): [string, number] => [original.id, original.version]).sort(([a], [b]) => a.localeCompare(b)) }
  const bankChanges = [...banks.entries()].filter(([, bank]) => JSON.stringify(bank.original.answerDefinition) !== JSON.stringify(bank.definition))
  return { changes, warnings, banks, bankChanges, proposed, plans, snapshot,
    impacts: affected.map((plan) => ({ attemptId: plan.id, name: plan.name, autoBefore: plan.autoBefore, autoAfter: plan.autoAfter,
      totalBefore: plan.before, totalAfter: plan.after, passedBefore: plan.before >= PASS_SCORE_UNITS, passedAfter: plan.after >= PASS_SCORE_UNITS,
      manualPreserved: plan.manualCount })) }
}

export function previewBlankCorrection(db: DatabaseSync, examId: string, body: Record<string, unknown>, adminName: string, now: number): BlankCorrectionPreviewDTO {
  const input = readInput(body)
  return withTransaction(db, () => {
    const prepared = prepareCorrection(db, examId, input, now)
    const result: BlankCorrectionPreviewDTO = { id: randomUUID(), examVersion: input.expectedVersion, reason: input.reason,
      createdBy: adminName, appliedBy: null, createdAt: now, appliedAt: null, changes: prepared.changes, impacts: prepared.impacts,
      scoreChangedCount: prepared.impacts.filter((row) => row.totalBefore !== row.totalAfter).length,
      manualPreservedCount: prepared.impacts.reduce((sum, row) => sum + row.manualPreserved, 0),
      bankSyncedCount: prepared.bankChanges.length, warnings: prepared.warnings }
    db.prepare('INSERT INTO blank_corrections(id, exam_id, created_by, created_at, input_json, snapshot_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(result.id, examId, adminName, now, JSON.stringify(input), JSON.stringify(prepared.snapshot), JSON.stringify(result))
    return result
  })
}

export function applyBlankCorrection(db: DatabaseSync, examId: string, previewId: string, adminName: string, now: number): BlankCorrectionPreviewDTO {
  return withTransaction(db, () => {
    const row = db.prepare('SELECT * FROM blank_corrections WHERE id = ? AND exam_id = ?').get(previewId, examId) as CorrectionRow | undefined
    if (!row) throw new ApiFailure('NOT_FOUND', '纠错预览不存在，请重新预览')
    const result = JSON.parse(row.result_json) as BlankCorrectionPreviewDTO
    if (row.applied_at !== null) return result
    const input = JSON.parse(row.input_json) as BlankCorrectionInput
    const prepared = prepareCorrection(db, examId, input, now)
    if (JSON.stringify(prepared.snapshot) !== row.snapshot_json) throw new ApiFailure('VERSION_CONFLICT', '答卷、人工复核或题库在预览后发生变化，请重新预览再确认')
    if (JSON.stringify(prepared.impacts) !== JSON.stringify(result.impacts) || JSON.stringify(prepared.changes) !== JSON.stringify(result.changes)
      || prepared.bankChanges.length !== result.bankSyncedCount || JSON.stringify(prepared.warnings) !== JSON.stringify(result.warnings)) {
      throw new ApiFailure('VERSION_CONFLICT', '当前判分影响已与预览不同，请重新预览再确认')
    }
    const changedIds = new Set(prepared.changes.map((change) => change.questionId))
    const updateQuestion = db.prepare('UPDATE questions SET answer_definition_json = ?, updated_at = ? WHERE id = ? AND exam_id = ?')
    for (const question of prepared.proposed) if (changedIds.has(question.id)) updateQuestion.run(JSON.stringify(question.answerDefinition), now, question.id, examId)
    const updateBank = db.prepare('UPDATE question_bank_items SET answer_definition_json = ?, version = version + 1, updated_at = ? WHERE id = ?')
    for (const [id, bank] of prepared.bankChanges) updateBank.run(JSON.stringify(bank.definition), now, id)
    applyRegradePlan(db, prepared.plans, now)
    touchExamVersion(db, examId, now)
    result.appliedAt = now
    result.appliedBy = adminName
    db.prepare('UPDATE blank_corrections SET applied_at = ?, applied_by = ?, result_json = ? WHERE id = ?')
      .run(now, adminName, JSON.stringify(result), previewId)
    return result
  })
}
