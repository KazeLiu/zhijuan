/**
 * 合同常量：前后端共用，值为冻结口径，见 docs/impl-contract.md §7.3。
 * 任何改动都属于契约变更，必须同步登记到 docs/impl-contract.md 的变更记录。
 */

/** 满分计分单位：1 单位 = 0.01 分，整卷合计必须是 10000 */
export const SCORE_TOTAL_UNITS = 10000

/** 及格线：6000 单位 = 60.00 分，仅用于统计与结果展示 */
export const PASS_SCORE_UNITS = 6000

/** 单场题数上下限 */
export const MIN_QUESTIONS = 1
export const MAX_QUESTIONS = 100

/** 候选题倍数与扩充上限；目标题数超过上限时，仍至少生成目标题数。 */
export const CANDIDATE_FACTOR = 1.5
export const MAX_CANDIDATES_PER_TYPE = 60

/**
 * 单批模型请求题目数上限。
 * 27B 级本地模型实测约 25-40 秒/题，单批过大必然撞上请求超时；
 * 控制在 6 题以内（约 2-4 分钟/批），配合 BATCH_MAX_ATTEMPTS 重试。
 */
export const MAX_BATCH_QUESTIONS = 6

/** 资料限制 */
export const MAX_DOCUMENTS_PER_EXAM = 5
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
export const MAX_TOTAL_DOCUMENT_CHARS = 40000

/** 资料库条目总数上限（docs/library-feature.md §L4.2） */
export const MAX_LIBRARY_FILES = 100

/** 填空题每个空的输入上限（字符数） */
export const MAX_BLANK_ANSWER_CHARS = 20

/** 固定选项题型（单选/多选）的选项数，选项 ID 固定为 A/B/C/D */
export const CHOICE_OPTION_IDS = ['A', 'B', 'C', 'D'] as const

/** 判断题固定选项 */
export const TRUE_FALSE_OPTIONS = [
  { id: 'true', text: '正确' },
  { id: 'false', text: '错误' },
] as const

/** 分页：考生列表、我的记录固定每页 20 */
export const DEFAULT_PAGE_SIZE = 20

/** 会话有效期（天）——与 runtimeConfig.sessionTtlDays 默认值一致 */
export const DEFAULT_SESSION_TTL_DAYS = 7

/** 新建场次默认使用中国标准时间。 */
export const DEFAULT_EXAM_TIME_ZONE = 'Asia/Shanghai'

/** 前端交互参数：自动保存防抖、任务轮询、模型请求超时 */
export const AUTOSAVE_DEBOUNCE_MS = 600
export const JOB_POLL_INTERVAL_MS = 1000
/**
 * 单次模型请求超时。
 * 27B 级本地模型连续输出 3-6 道题需要 2-4 分钟，原 120s 会在半途 Abort，
 * 表现为「批次失败但界面看着还在跑」。
 */
export const MODEL_REQUEST_TIMEOUT_MS = 300_000

/** 姓名长度上限（Unicode 字符数） */
export const MAX_NAME_LENGTH = 64

/** 文本长度上限（Unicode 字符数），服务端与前端输入框共用 */
export const MAX_TITLE_CHARS = 200
export const MAX_INSTRUCTIONS_CHARS = 4000
export const MAX_STEM_CHARS = 2000
export const MAX_OPTION_TEXT_CHARS = 500
export const MAX_EXPLANATION_CHARS = 2000
export const MAX_EXTRA_PROMPT_CHARS = 2000
export const MAX_GRADE_REASON_CHARS = 500

/** 引用摘录：归一化后至少 10 字符、原文最多 500 字符 */
export const MIN_QUOTE_CHARS = 10
export const MAX_QUOTE_CHARS = 500

/** 资料预览单次最多返回字符数 */
export const DOCUMENT_PREVIEW_CHARS = 4000

/**
 * 出题任务保留的模型原始输出上限（字符）。
 * 只用于人工观察模型行为：超出后丢弃最前面的内容，保留最近的输出。
 */
export const JOB_OUTPUT_MAX_CHARS = 60_000

/** 输出展示框的增量拉取间隔（毫秒），比进度轮询更密，视觉上接近实时 */
export const JOB_OUTPUT_POLL_INTERVAL_MS = 800

/** 单次增量拉取最多返回的字符数 */
export const JOB_OUTPUT_CHUNK_CHARS = 20_000

/** 出题难度取值（中文标签见 shared/types/question.ts 的 DIFFICULTY_LABELS） */
export const DIFFICULTIES = ['easy', 'normal', 'hard'] as const

/** 题库易错标记：至少 10 人已作答，未满分率至少 50%。 */
export const BANK_MISTAKE_MIN_SAMPLE = 10
export const BANK_MISTAKE_RATE_THRESHOLD = 0.5
export const MAX_KNOWLEDGE_POINT_CHARS = 100
