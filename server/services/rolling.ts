import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { RollingConfig, RollingDTO, RollingRunDTO } from '../../shared/types/rolling'
import { blueprintTotal } from '../../shared/types/exam'
import { MAX_INSTRUCTIONS_CHARS, MAX_TITLE_CHARS, MAX_QUESTIONS } from '../../shared/constants'
import { defaultRollingConfig } from '../../shared/utils/rolling'
import { findExam, insertExam, publishExamRow } from '../db/queries/exams'
import { applyBankQuestionsInTransaction, bankQuestionPool, readBankFilters } from './question-bank'
import { selectBankQuestions, BLUEPRINT_KEYS } from './bank-selection'
import { buildPublishChecklist } from './exams'
import { ApiFailure } from '../utils/respond'
import { FieldErrors, isPlainObject, readExpectedVersion } from '../utils/validate'
import { withTransaction } from '../utils/db'
import { formatDateTime, parseTimeZone, startOfDayInZone, startOfNextDayInZone, zoneParts } from '../utils/time'

function readConfig(db: DatabaseSync): { config: RollingConfig; version: number } {
  const row = db.prepare('SELECT config_json, version FROM rolling_config WHERE id = 1').get() as { config_json: string; version: number } | undefined
  return row ? { config: JSON.parse(row.config_json) as RollingConfig, version: row.version } : { config: defaultRollingConfig(), version: 0 }
}
interface RunRow { date_key: string; exam_id: string | null; status: RollingRunDTO['status']; error_message: string; created_at: number }
function runDTO(row: RunRow): RollingRunDTO {
  return { date: row.date_key, examId: row.exam_id, status: row.status, errorMessage: row.error_message, createdAt: row.created_at }
}
function timeOnDay(day: number, wall: string, zone: string): number {
  const parts = zoneParts(day, zone)
  const [hour, minute] = wall.split(':').map(Number)
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, hour!, minute!)
  const offset = (at: number) => {
    const p = zoneParts(at, zone)
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000
  }
  const first = naive - offset(naive)
  return naive - offset(first)
}
function dailyWindow(config: RollingConfig, now: number) {
  const day = startOfDayInZone(config.timeZone, now)
  const tomorrow = startOfNextDayInZone(config.timeZone, day)
  const startsAt = timeOnDay(day, config.startsAtTime, config.timeZone)
  const endsAt = timeOnDay(config.endsAtTime <= config.startsAtTime ? tomorrow : day, config.endsAtTime, config.timeZone)
  return { date: formatDateTime(day, config.timeZone).slice(0, 10), startsAt, endsAt, tomorrow }
}

export function getRolling(db: DatabaseSync, now: number): RollingDTO {
  const { config, version } = readConfig(db)
  const window = dailyWindow(config, now)
  const rows = db.prepare('SELECT * FROM rolling_runs ORDER BY date_key DESC LIMIT 14').all() as unknown as RunRow[]
  const today = rows.find((row) => row.date_key === window.date)
  const { picked: _, ...counts } = selectBankQuestions(bankQuestionPool(db, config.filters), config.blueprint)
  return { config, version, today: today ? runDTO(today) : null, recent: rows.map(runDTO),
    nextRunAt: !config.enabled ? null : !today && now < window.endsAt ? now : window.tomorrow,
    availability: { examVersion: version, ...counts } }
}

function parseRollingConfig(body: Record<string, unknown>): RollingConfig {
  if (!isPlainObject(body.config) || !isPlainObject(body.config.blueprint) || !isPlainObject(body.config.filters)) throw new ApiFailure('VALIDATION_FAILED', '请提供完整滚动出题规则')
  const raw = body.config
  const errors = new FieldErrors()
  const title = errors.text(raw, 'title', '名称', { required: true, max: MAX_TITLE_CHARS - 13, trim: true })
  const instructions = errors.text(raw, 'instructions', '考试说明', { max: MAX_INSTRUCTIONS_CHARS }) ?? ''
  const answerRevealPolicy = errors.oneOf(raw, 'answerRevealPolicy', '答案公开策略', ['immediate', 'after_exam'] as const, true)
  if (typeof raw.enabled !== 'boolean') errors.add('enabled', '请选择启用或暂停')
  for (const field of ['startsAtTime', 'endsAtTime']) {
    if (typeof raw[field] !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(raw[field] as string)) errors.add(field, '请输入 HH:mm 格式的每日时间')
  }
  const blueprint = { ...defaultRollingConfig().blueprint }
  for (const key of Object.values(BLUEPRINT_KEYS)) blueprint[key] = errors.int(raw.blueprint as Record<string, unknown>, key, key, { required: true, min: 0, max: MAX_QUESTIONS }) ?? 0
  if (blueprintTotal(blueprint) < 1 || blueprintTotal(blueprint) > MAX_QUESTIONS) errors.add('blueprint', '总题数需为 1–100 道')
  errors.throwIfAny()
  const filters = readBankFilters(raw.filters as Record<string, unknown>)
  blueprint.difficulty = filters.difficulty ?? 'normal'
  return { enabled: raw.enabled as boolean, title: title!, instructions,
    timeZone: parseTimeZone(raw.timeZone), startsAtTime: raw.startsAtTime as string, endsAtTime: raw.endsAtTime as string,
    blueprint, filters, answerRevealPolicy: answerRevealPolicy! }
}

export function previewRolling(db: DatabaseSync, body: Record<string, unknown>) {
  const config = parseRollingConfig(body)
  const { picked: _, ...counts } = selectBankQuestions(bankQuestionPool(db, config.filters), config.blueprint)
  return { examVersion: 0, ...counts }
}

export function saveRolling(db: DatabaseSync, body: Record<string, unknown>, now: number): RollingDTO {
  const version = body.expectedVersion === 0 ? 0 : readExpectedVersion(body)
  const config = parseRollingConfig(body)
  withTransaction(db, () => {
    if (readConfig(db).version !== version) throw new ApiFailure('VERSION_CONFLICT', '滚动规则已被修改，请刷新后再保存')
    db.prepare(`INSERT INTO rolling_config(id, version, config_json, updated_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version, config_json = excluded.config_json, updated_at = excluded.updated_at`)
      .run(version + 1, JSON.stringify(config), now)
  })
  // 保存只更新规则；后台巡守负责生成，已有场次不变。
  return getRolling(db, now)
}

export function generateRollingToday(db: DatabaseSync, now: number, retry = false): void {
  const { config, version } = readConfig(db)
  if (!config.enabled) {
    if (retry) throw new ApiFailure('VALIDATION_FAILED', '请先启用并保存滚动出题规则')
    return
  }
  const window = dailyWindow(config, now)
  const previous = db.prepare('SELECT * FROM rolling_runs WHERE date_key = ?').get(window.date) as RunRow | undefined
  if (previous?.status === 'succeeded' || (previous && !retry)) return
  if (now >= window.endsAt) {
    if (retry) throw new ApiFailure('VALIDATION_FAILED', '今天的开放时段已结束，下一次会在明天生成')
    return
  }
  try {
    for (const [instant, wall] of [[window.startsAt, config.startsAtTime], [window.endsAt, config.endsAtTime]] as const) {
      if (formatDateTime(instant, config.timeZone).slice(11, 16) !== wall) throw new ApiFailure('VALIDATION_FAILED', '当日设定时刻因夏令时切换不存在，请调整开放时间后重试')
    }
    if (window.endsAt <= window.startsAt) throw new ApiFailure('VALIDATION_FAILED', '截止时刻必须晚于开放时刻，请调整每日时间')
    withTransaction(db, () => {
      const id = randomUUID()
      insertExam(db, id, { ...config, title: `${config.title} ${window.date}`, startsAt: window.startsAt, endsAt: window.endsAt }, now)
      const exam = findExam(db, id)!
      applyBankQuestionsInTransaction(db, id, { mode: 'random', expectedVersion: exam.version, filters: config.filters }, now, true)
      const checks = buildPublishChecklist(db, findExam(db, id)!, now)
      if (checks.some((check) => !check.ok)) throw new ApiFailure('PUBLISH_PRECHECK_FAILED', checks.filter((check) => !check.ok).map((check) => check.message).join('；'))
      publishExamRow(db, id, now)
      db.prepare(`INSERT INTO rolling_runs(date_key, exam_id, config_version, status, created_at) VALUES (?, ?, ?, 'succeeded', ?)
        ON CONFLICT(date_key) DO UPDATE SET exam_id = excluded.exam_id, config_version = excluded.config_version,
          status = 'succeeded', error_message = '', created_at = excluded.created_at`).run(window.date, id, version, now)
    })
  } catch (error) {
    if (!(error instanceof ApiFailure)) console.error('[rolling] 自动组卷失败', error)
    const message = error instanceof ApiFailure ? error.message : '自动组卷发生内部错误，请检查服务日志'
    withTransaction(db, () => {
      db.prepare(`INSERT INTO rolling_runs(date_key, config_version, status, error_message, created_at) VALUES (?, ?, 'failed', ?, ?)
        ON CONFLICT(date_key) DO UPDATE SET config_version = excluded.config_version, status = 'failed', error_message = excluded.error_message, created_at = excluded.created_at`)
        .run(window.date, version, message, now)
    })
    if (retry) throw error
  }
}
