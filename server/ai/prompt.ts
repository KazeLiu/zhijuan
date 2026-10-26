import type { ChatMessage } from './client'
import type { Difficulty, QuestionType } from '../../shared/types/question'
import { DIFFICULTY_LABELS, QUESTION_TYPE_LABELS } from '../../shared/types/question'
import { MAX_OPTION_TEXT_CHARS } from '../../shared/constants'

export interface MaterialSnippet {
  id: string
  name: string
  text: string
}

export interface BatchPromptInput {
  examTitle: string
  type: QuestionType
  count: number
  difficulty: Difficulty
  extraPrompt: string
  materials: MaterialSnippet[]
}

const SYSTEM_PROMPT = [
  '你是一名严谨的中文命题老师，负责依据给定资料编写客观题。',
  '必须严格按要求输出 JSON，不得输出解释、思考过程、Markdown 说明或任何 JSON 以外的文字。',
  '所有题目必须能由资料内容直接判定对错，不得依赖资料之外的常识。',
  '引用摘录（sourceRefs[].quote）必须从资料原文逐字复制，不得改写、拼接或跨段摘取。',
].join('\n')

const OUTPUT_RULES: Record<QuestionType, string> = {
  single_choice: [
    '题型：单选题。恰好 4 个选项，id 依次为 "A"、"B"、"C"、"D"，按顺序给出，text 为选项文本。',
    'answerDefinition.correctOptionIds 恰好 1 项，取值为 "A".."D" 之一。',
    'answerDefinition.blanks 必须为空数组 []。',
    'options 数组只能包含 id 与 text 两个字段。',
  ].join('\n'),
  multiple_choice: [
    '题型：多选题。恰好 4 个选项，id 依次为 "A"、"B"、"C"、"D"，按顺序给出，text 为选项文本。',
    'answerDefinition.correctOptionIds 为 2 到 3 项，取值为 "A".."D"。',
    'answerDefinition.blanks 必须为空数组 []。',
    'options 数组只能包含 id 与 text 两个字段。',
  ].join('\n'),
  true_false: [
    '题型：判断题。不需要 options（省略该字段）。',
    'answerDefinition.correctOptionIds 恰好 1 项，取值为 "true"（正确）或 "false"（错误）。',
    'answerDefinition.blanks 必须为空数组 []。',
  ].join('\n'),
  fill_blank: [
    '题型：填空题。不需要 options（省略该字段）。',
    '题干中用 {{1}}、{{2}} 这样的占位符标出空位，序号从 1 开始连续递增，与 answerDefinition.blanks 顺序一一对应。',
    'answerDefinition.correctOptionIds 必须为空数组 []。',
    'answerDefinition.blanks 每项形如 {"acceptedAnswers": ["可接受答案"], "caseSensitive": true}；acceptedAnswers 为 1 到 3 个等价答案，每项不超过 20 个字符；无法确定大小写时 caseSensitive 取 false。',
  ].join('\n'),
}

function buildUserPrompt(input: BatchPromptInput): string {
  const materialBlocks = input.materials
    .map(
      (material) =>
        `### 资料 documentId=${material.id} 文件名=${material.name}\n每个段落以 [locator] 开头，引用时 locator 必须照抄方括号中的值。\n${material.text}`,
    )
    .join('\n\n')

  const example =
    input.type === 'fill_blank'
      ? `[
  {
    "type": "fill_blank",
    "stem": "知卷使用 {{1}} 作为数据库引擎。",
    "answerDefinition": { "correctOptionIds": [], "blanks": [{ "acceptedAnswers": ["SQLite"], "caseSensitive": false }] },
    "explanation": "资料中明确说明数据库为 SQLite。",
    "sourceRefs": [{ "documentId": "资料里的 documentId", "locator": "资料里的 locator", "quote": "从资料中逐字复制的原文片段" }]
  }
]`
      : input.type === 'true_false'
        ? `[
  {
    "type": "true_false",
    "stem": "知卷的满分是 100 分。",
    "answerDefinition": { "correctOptionIds": ["true"], "blanks": [] },
    "explanation": "资料中说明满分精确为 10000 计分单位，即 100 分。",
    "sourceRefs": [{ "documentId": "资料里的 documentId", "locator": "资料里的 locator", "quote": "从资料中逐字复制的原文片段" }]
  }
]`
        : input.type === 'multiple_choice'
          ? `[
  {
    "type": "multiple_choice",
    "stem": "以下哪些属于知卷支持的题型？",
    "options": [
      { "id": "A", "text": "单选题" },
      { "id": "B", "text": "多选题" },
      { "id": "C", "text": "判断题" },
      { "id": "D", "text": "论文题" }
    ],
    "answerDefinition": { "correctOptionIds": ["A", "B", "C"], "blanks": [] },
    "explanation": "资料只列出单选、多选、判断、填空四类客观题，没有论文题。",
    "sourceRefs": [{ "documentId": "资料里的 documentId", "locator": "资料里的 locator", "quote": "从资料中逐字复制的原文片段" }]
  }
]`
          : `[
  {
    "type": "single_choice",
    "stem": "知卷中 1 个计分单位等于多少分？",
    "options": [
      { "id": "A", "text": "0.01 分" },
      { "id": "B", "text": "0.1 分" },
      { "id": "C", "text": "1 分" },
      { "id": "D", "text": "10 分" }
    ],
    "answerDefinition": { "correctOptionIds": ["A"], "blanks": [] },
    "explanation": "资料说明 1 个计分单位等于 0.01 分。",
    "sourceRefs": [{ "documentId": "资料里的 documentId", "locator": "资料里的 locator", "quote": "从资料中逐字复制的原文片段" }]
  }
]`

  return [
    `场次名称：${input.examTitle}`,
    `任务：依据下面资料出 ${input.count} 道${QUESTION_TYPE_LABELS[input.type]}，难度为「${DIFFICULTY_LABELS[input.difficulty]}」。`,
    input.extraPrompt.trim() === '' ? '' : `额外要求：${input.extraPrompt.trim()}`,
    '',
    '资料：',
    materialBlocks,
    '',
    '输出要求：',
    OUTPUT_RULES[input.type],
    '- 每道题都必须包含：type、stem、answerDefinition、explanation、sourceRefs（选择题另需 options）。',
    '- stem 不超过 500 字，选项文本不超过 ' + String(MAX_OPTION_TEXT_CHARS) + ' 字，explanation 不超过 500 字。',
    '- sourceRefs 为 1 到 2 项，每项含 documentId、locator、quote；quote 必须是资料中连续的一段原文（10 到 500 字）。',
    '- 题目之间不得重复，不得只改数字或措辞重复同一考点。',
    `- 顶层直接输出 JSON 数组，数组长度必须恰好为 ${input.count}。`,
    '',
    '输出格式示例（仅示意字段结构，内容不要照抄）：',
    example,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export function buildBatchMessages(input: BatchPromptInput): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(input) },
  ]
}
