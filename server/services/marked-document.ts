import type { DatabaseSync } from 'node:sqlite'
import type { BankMarkedPreviewDTO, MarkedSourceRules, QuestionContentInput } from '../../shared/types/question-bank'
import type { QuestionType } from '../../shared/types/question'
import { MAX_QUOTE_CHARS, MIN_QUOTE_CHARS } from '../../shared/constants'
import { listLibrarySegments } from '../db/queries/library'
import { ApiFailure } from '../utils/respond'
import { bankGenerationFiles, generationSourceRefs, type BankGenerationPlan, type GenerationSource, type SourceSegment } from './bank-generation-plan'

interface OutlineNode {
  level: number
  heading: boolean
  starred: boolean
  lines: SourceSegment[]
  children: OutlineNode[]
}

const cleanStar = (text: string) => text.trim().replace(/^★\s*/u, '')
const blankPattern = () => /<([^<>\n]+)>|＜([^＜＞\n]+)＞/gu
const reveal = (text: string) => text.replace(blankPattern(), (_, ascii: string | undefined, full: string | undefined) => ascii ?? full ?? '')
const clip = (text: string, limit: number) => Array.from(text).slice(0, limit).join('')

function outlineKind(text: string, starred: boolean): { level: number; heading: boolean } | null {
  if (/^第[一二三四五六七八九十百零〇\d]+[编篇]/u.test(text)) return { level: 0, heading: true }
  if (/^第[一二三四五六七八九十百零〇\d]+章/u.test(text)) return { level: 1, heading: true }
  if (/^第[一二三四五六七八九十百零〇\d]+节/u.test(text)) return { level: 2, heading: true }
  if (/^[一二三四五六七八九十百]+[、.．]/u.test(text)) return { level: 3, heading: true }
  if (/^[（(][一二三四五六七八九十百]+[）)]/u.test(text)) return { level: 4, heading: true }
  if (/^\d+[.．、](?!\d)/u.test(text)) return { level: 5, heading: false }
  if (/^[（(]\d+[）)]/u.test(text)) return { level: 6, heading: false }
  if (/^[①②③④⑤⑥⑦⑧⑨⑩]/u.test(text)) return { level: 7, heading: false }
  return starred ? { level: 5, heading: false } : null
}

function nodeText(node: OutlineNode): string {
  let text = ''
  let previous: SourceSegment | undefined
  for (const line of node.lines) {
    if (previous && (previous.locator !== line.locator || previous.offset + previous.text.length !== line.offset)) text += '\n'
    text += line.text
    previous = line
  }
  return cleanStar(text)
}

function sourceFromNode(node: OutlineNode, context: string[], inheritedStar: boolean): GenerationSource {
  const sections: MarkedSourceRules['sections'] = []
  const segments: SourceSegment[] = []
  function collect(current: OutlineNode, parents: string[], parentStar: boolean) {
    const text = nodeText(current)
    const memorize = parentStar || current.starred
    sections.push({ context: parents, text, memorize })
    segments.push(...current.lines)
    for (const child of current.children) collect(child, [...parents, reveal(text)], memorize)
  }
  collect(node, context, inheritedStar)
  const first = segments[0]!
  return { title: clip(reveal(cleanStar(first.text)), 100), knowledgePoint: clip(context.at(-1) ?? first.fileName, 100),
    sourceGroup: `标记 ${first.locator}:${first.offset}`, segments, markedRules: { sections },
    completed: false, generatedCount: 0, createdCount: 0 }
}

/** 编号决定层级，带子项的完整父条目作为同一来源，避免把条件与清单拆散。 */
export function markedDocumentPlan(db: DatabaseSync, ids: string[]): BankGenerationPlan {
  const plan: BankGenerationPlan = { sources: [], ignored: [] }
  let segmentId = 0
  for (const file of bankGenerationFiles(db, ids)) {
    const root: OutlineNode = { level: -1, heading: true, starred: false, lines: [], children: [] }
    const stack = [root]
    let pendingStar = false
    for (const segment of listLibrarySegments(db, file.id)) {
      for (const match of segment.text.matchAll(/[^\n]+/gu)) {
        const raw = match[0]
        if (!raw.trim()) continue
        if (raw.trim() === '★') { pendingStar = true; continue }
        const starred = pendingStar || /^\s*★/u.test(raw)
        pendingStar = false
        const text = cleanStar(raw)
        let emptyBlank = false
        const residue = text.replace(blankPattern(), (_, ascii: string | undefined, full: string | undefined) => {
          if (!(ascii ?? full ?? '').trim()) emptyBlank = true
          return ''
        })
        if (emptyBlank || /[<>＜＞]/u.test(residue)) throw new ApiFailure('QUESTION_SET_INVALID', `${file.originalName} ${segment.locator} 的填空标记未配对、为空或嵌套，请使用 <答案>`)
        const kind = outlineKind(text, starred)
        let node = stack.at(-1)!
        if (kind || node.heading) {
          const next = kind ?? { level: 5, heading: false }
          while (stack.at(-1)!.level >= next.level) stack.pop()
          node = { ...next, starred, lines: [], children: [] }
          stack.at(-1)!.children.push(node)
          stack.push(node)
        }
        for (let offset = 0; offset < raw.length; offset += MAX_QUOTE_CHARS) {
          node.lines.push({ id: ++segmentId, fileId: file.id, fileName: file.originalName, locator: segment.locator,
            offset: match.index + offset, text: raw.slice(offset, offset + MAX_QUOTE_CHARS) })
        }
      }
    }
    if (pendingStar) throw new ApiFailure('QUESTION_SET_INVALID', `${file.originalName} 末尾的 ★ 没有对应内容`)
    function visit(node: OutlineNode, parents: string[], parentStar: boolean) {
      if (!node.heading) {
        const source = sourceFromNode(node, parents, parentStar)
        if (!generationSourceRefs(source).length) throw new ApiFailure('QUESTION_SET_INVALID', `来源「${source.title}」缺少至少 ${MIN_QUOTE_CHARS} 字的完整引用，请保留完整条目后再解析`)
        const blankCount = markedBlankTemplates(source).length
        source.batches = [
          ...Array.from({ length: blankCount }, (_, blankTemplateIndex) => ({ total: 1, blankTemplateIndex,
            counts: { single_choice: 0, multiple_choice: 0, true_false: 0, fill_blank: 1 } })),
          ...(['single_choice', 'multiple_choice', 'true_false'] as const).map((type) => ({ total: 1,
            counts: { single_choice: 0, multiple_choice: 0, true_false: 0, fill_blank: 0, [type]: 1 } })),
        ]
        plan.sources.push(source)
        return
      }
      const text = reveal(nodeText(node))
      if (text) plan.ignored.push({ fileName: file.originalName, locators: [...new Set(node.lines.map((line) => line.locator))], reason: '章节标题，已保留为下级来源上下文' })
      for (const child of node.children) visit(child, text ? [...parents, text] : parents, parentStar || node.starred)
    }
    visit(root, [], false)
  }
  if (!plan.sources.length) throw new ApiFailure('QUESTION_SET_INVALID', '未找到完整条目，请检查解析文本是否保留编号、换行和 ★ 标记')
  return plan
}

/** 每个含标记的小节生成一道原文填空，同句多个标记保留为多个空。 */
export function markedBlankTemplates(source: GenerationSource): QuestionContentInput[] {
  return (source.markedRules?.sections ?? []).flatMap<QuestionContentInput>((section) => {
    if (!section.memorize) return []
    const answers: string[] = []
    const stem = section.text.replace(blankPattern(), (_, ascii: string | undefined, full: string | undefined) => {
      answers.push((ascii ?? full ?? '').trim())
      return `{{b${answers.length}}}`
    })
    if (!answers.length) return []
    return [{ type: 'fill_blank', stem: [...section.context, stem].join('\n'), options: [],
      answerDefinition: { correctOptionIds: [], blanks: answers.map((answer, index) => ({ id: `b${index + 1}`, acceptedAnswers: [answer], caseSensitive: false })) },
      explanation: `原文：${[...section.context, reveal(section.text)].join('\n')}` }]
  })
}

export function markedSourceTypes(source: GenerationSource): QuestionType[] {
  return [...(markedBlankTemplates(source).length ? ['fill_blank' as const] : []), 'single_choice', 'multiple_choice', 'true_false']
}

export function markedDocumentPreview(db: DatabaseSync, ids: string[]): BankMarkedPreviewDTO {
  const plan = markedDocumentPlan(db, ids)
  return { sources: plan.sources.map((source) => ({ title: source.title, fileName: source.segments[0]!.fileName, knowledgePoint: source.knowledgePoint,
    rules: source.markedRules!, blankQuestionCount: markedBlankTemplates(source).length })), ignored: plan.ignored }
}
