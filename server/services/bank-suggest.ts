import type { DatabaseSync } from 'node:sqlite'
import { MAX_KNOWLEDGE_POINT_CHARS } from '../../shared/constants'
import type { QuestionRow } from '../db/queries/questions'
import { listQuestions } from '../db/queries/questions'
import { findExam } from '../db/queries/exams'
import { requestChatCompletion } from '../ai/client'
import { buildKnowledgePointMessages, type KnowledgePointQuestion } from '../ai/prompt'
import { stripCodeFence } from '../ai/parser'
import { knowledgePoints, normalizeKnowledgePoint } from './question-bank'
import { readModelConfig } from './settings'
import { throwApi } from '../utils/respond'
import { isPlainObject } from '../utils/validate'

/** 单次建议的题目上限（契约 §4.1） */
const MAX_SUGGEST_QUESTIONS = 50
/** 兜底知识点的最后防线：场次标题也取不到时使用 */
const LAST_RESORT_KNOWLEDGE_POINT = '未分类'

export interface KnowledgeSuggestItem {
  questionId: string
  knowledgePoint: string
  /** ai=模型建议；fallback=模型未配置/失败时的默认值 */
  source: 'ai' | 'fallback'
}

export interface SuggestKnowledgePointsResult {
  items: KnowledgeSuggestItem[]
  /** true 表示模型未配置或调用失败，knowledgePoint 为兜底值 */
  degraded: boolean
  /** 可直接展示给用户的中文提示；无异常时为空串 */
  message: string
}

function toPromptQuestion(question: QuestionRow): KnowledgePointQuestion {
  return {
    questionId: question.id,
    type: question.type,
    stem: question.stem,
    options: question.options,
    answerDefinition: question.answerDefinition,
    explanation: question.explanation,
  }
}

/** 同场次或相同来源资料使用过的知识点优先列给模型，避免只看到字母排序靠前的分类。 */
function relatedKnowledgePoints(db: DatabaseSync, examId: string): string[] {
  return (db
    .prepare(
      `SELECT b.knowledge_point
         FROM question_bank_items b
        WHERE b.origin_exam_id = ? OR EXISTS (
          SELECT 1 FROM question_bank_sources s
          JOIN documents d ON d.library_file_id = s.library_file_id
          WHERE s.bank_item_id = b.id AND d.exam_id = ?
        )
     GROUP BY b.knowledge_point
     ORDER BY MAX(CASE WHEN b.origin_exam_id = ? THEN 1 ELSE 0 END) DESC,
              COUNT(*) DESC, b.knowledge_point ASC`,
    )
    .all(examId, examId, examId) as Array<{ knowledge_point: string }>).map((row) => row.knowledge_point)
}

/** 无法调用模型时优先沿用相关资料已有的知识点，否则用场次标题。 */
function resolveFallbackKnowledgePoint(related: string[], examTitle: string): string {
  for (const candidate of [related[0] ?? '', examTitle]) {
    if (candidate === '') continue
    try {
      return normalizeKnowledgePoint(candidate)
    } catch {
      // 超长或空白，截断后再试一次；仍失败就继续用下一个候选
      const clipped = Array.from(candidate).slice(0, MAX_KNOWLEDGE_POINT_CHARS).join('')
      try {
        return normalizeKnowledgePoint(clipped)
      } catch {
        continue
      }
    }
  }
  return LAST_RESORT_KNOWLEDGE_POINT
}

/**
 * 解析模型返回的知识点数组，按 questionId 对齐。
 * 模型偶尔漏填 questionId，此时按出现顺序补到还没分配的题目上。
 */
function mapAiKnowledgePoints(payload: unknown, questions: KnowledgePointQuestion[], existing: string[]): Map<string, string> {
  const byId = new Map(questions.map((question) => [question.questionId, question]))
  const used = new Set<string>()
  const points = new Map<string, string>()
  const unmatched: string[] = []
  const elements = Array.isArray(payload) ? payload : []
  for (const element of elements) {
    if (!isPlainObject(element)) continue
    const index = element.existingKnowledgePointIndex
    if (index !== undefined && index !== null
      && (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > existing.length)) continue
    const rawPoint = typeof index === 'number' ? existing[index - 1] : element.knowledgePoint
    if (typeof rawPoint !== 'string') continue
    const rawId = typeof element.questionId === 'string' ? element.questionId : ''
    if (rawId !== '' && byId.has(rawId) && !used.has(rawId)) {
      used.add(rawId)
      points.set(rawId, rawPoint)
      continue
    }
    unmatched.push(rawPoint)
  }
  for (const point of unmatched) {
    const next = questions.find((question) => !used.has(question.questionId))
    if (!next) break
    used.add(next.questionId)
    points.set(next.questionId, point)
  }
  return points
}

function readAiKnowledgePoints(raw: string, questions: KnowledgePointQuestion[], existing: string[]): Map<string, string> {
  const text = stripCodeFence(raw).trim()
  const payload: unknown = JSON.parse(text)
  return mapAiKnowledgePoints(payload, questions, existing)
}

/** 只消除全半角、大小写与空白差异，不把不同含义的知识点强行合并。 */
function knowledgePointKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
}

/** 把模型的原始字符串过 normalizeKnowledgePoint；不合格返回 null 走兜底 */
function normalizeOrNull(raw: string): string | null {
  try {
    return normalizeKnowledgePoint(raw)
  } catch {
    return null
  }
}

/**
 * 为题目建议知识点（契约 §4.1）。降级不报错：
 * 模型未配置或调用失败时返回 degraded=true + 兜底知识点 + 中文 message。
 */
export async function suggestKnowledgePoints(
  db: DatabaseSync,
  examId: string,
  questionIds: string[] | undefined,
): Promise<SuggestKnowledgePointsResult> {
  const exam = findExam(db, examId)
  if (!exam) throwApi('NOT_FOUND', '考试场次不存在')

  const allQuestions = listQuestions(db, examId)
  let selected = allQuestions
  if (questionIds && questionIds.length > 0) {
    const known = new Map(allQuestions.map((question) => [question.id, question]))
    const missing = questionIds.filter((id) => !known.has(id))
    if (missing.length > 0) {
      throwApi('NOT_FOUND', '部分题目不存在', { questionIds: missing })
    }
    selected = questionIds.map((id) => known.get(id) as QuestionRow)
  }

  const truncated = selected.length > MAX_SUGGEST_QUESTIONS
  const questions = selected.slice(0, MAX_SUGGEST_QUESTIONS).map(toPromptQuestion)
  const related = relatedKnowledgePoints(db, examId)
  const existing = [...new Set([...related, ...knowledgePoints(db)])]
  const canonical = new Map<string, string>()
  for (const point of existing) {
    const key = knowledgePointKey(point)
    if (!canonical.has(key)) canonical.set(key, point)
  }
  const fallback = resolveFallbackKnowledgePoint(related, exam.title)
  const fallbackPoint = canonical.get(knowledgePointKey(fallback)) ?? fallback
  const fallbackItems = (): KnowledgeSuggestItem[] =>
    questions.map((question) => ({
      questionId: question.questionId,
      knowledgePoint: fallbackPoint,
      source: 'fallback' as const,
    }))

  if (questions.length === 0) {
    return { items: [], degraded: false, message: '' }
  }

  const truncationNote = truncated ? `单次最多建议 ${MAX_SUGGEST_QUESTIONS} 题，已只处理前 ${MAX_SUGGEST_QUESTIONS} 题` : ''
  const withTruncation = (message: string): string =>
    truncationNote === '' ? message : message === '' ? truncationNote : `${message}；${truncationNote}`

  const { config, missing } = readModelConfig(db)
  if (!config) {
    return {
      items: fallbackItems(),
      degraded: true,
      message: withTruncation(`未配置模型（缺少 ${missing.join('、')}），已填入默认知识点，可手动修改`),
    }
  }

  let aiPoints: Map<string, string>
  try {
    const raw = await requestChatCompletion({
      ...config,
      messages: buildKnowledgePointMessages({
        examTitle: exam.title,
        existingKnowledgePoints: existing,
        questions,
      }),
    })
    aiPoints = readAiKnowledgePoints(raw, questions, existing)
  } catch (error) {
    const reason = error instanceof Error && error.message !== '' ? error.message : '未知错误'
    return {
      items: fallbackItems(),
      degraded: true,
      message: withTruncation(`模型调用失败（${reason}），已填入默认知识点，可手动修改`),
    }
  }

  if (aiPoints.size === 0) {
    return {
      items: fallbackItems(),
      degraded: true,
      message: withTruncation('模型没有返回可用的知识点，已填入默认知识点，可手动修改'),
    }
  }

  const items = questions.map((question): KnowledgeSuggestItem => {
    const raw = aiPoints.get(question.questionId)
    const normalized = raw === undefined ? null : normalizeOrNull(raw)
    return normalized === null
      ? { questionId: question.questionId, knowledgePoint: fallbackPoint, source: 'fallback' }
      : { questionId: question.questionId, knowledgePoint: canonical.get(knowledgePointKey(normalized)) ?? normalized, source: 'ai' }
  })
  // 有题目回退到兜底值时整体仍算降级，前端据此提示
  const degraded = items.some((item) => item.source === 'fallback')
  return {
    items,
    degraded,
    message: degraded ? withTruncation('部分题目未能取得模型建议，已填入默认知识点，可手动修改') : withTruncation(''),
  }
}
