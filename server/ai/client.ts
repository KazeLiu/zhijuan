import { MODEL_REQUEST_TIMEOUT_MS } from '../../shared/constants'
import { THINKING_LEVELS, type ThinkingLevel } from '../../shared/types/admin'
import { ApiFailure, throwApi } from '../utils/respond'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ModelConfig {
  baseUrl: string
  apiKey: string
  modelId: string
  /** 思考强度；缺省按 off 处理（不额外推理，与原行为一致） */
  thinking?: ThinkingLevel
  /**
   * 已保存的思考强度（设置读取 readModelConfig 透出的字段名）。
   * 与 thinking 同义，二者都没给时按 off 处理。
   */
  thinkingLevel?: ThinkingLevel
}

/**
 * 对话补全请求：配置 + 消息 + 可选增量回调。
 * 传了 onDelta 就走 SSE 流式，返回值仍是从正文拼出的完整字符串（供 parseBatchResponse 使用）。
 */
export interface ChatCompletionRequest extends ModelConfig {
  messages: ChatMessage[]
  /**
   * 增量片段回调：正文 delta.content 与推理 delta.reasoning_content 都会转发，
   * 但返回值只包含正文（推理内容不计入返回值）。
   */
  onDelta?: (chunk: string) => void
}

/**
 * 已确认不接受思考参数（reasoning_effort / chat_template_kwargs）的上游。
 * vLLM 对未知字段严格时会直接 400，模块级记住后不再每次先撞一次。
 */
const thinkingUnsupported = new Set<string>()

/** 规范化思考强度：非法/缺省一律回退 off */
export function normalizeThinkingLevel(raw: unknown): ThinkingLevel {
  return typeof raw === 'string' && (THINKING_LEVELS as string[]).includes(raw) ? (raw as ThinkingLevel) : 'off'
}

/**
 * 思考参数（vLLM / Qwen 原生字段）：
 * - off：只发 chat_template_kwargs.enable_thinking=false（明确关闭思考）
 * - 其它：reasoning_effort + enable_thinking=true
 *
 * reasoning_effort 的取值由上游定义，本机 vLLM（Qwen3.8-27B-AWQ-INT4）只认 low / medium / xhigh，
 * 直接发 high 会 400；故 high 映射为上游的 xhigh（含义一致：最大推理开销）。
 */
const REASONING_EFFORT: Record<Exclude<ThinkingLevel, 'off'>, string> = {
  low: 'low',
  medium: 'medium',
  high: 'xhigh',
}

function thinkingFields(level: ThinkingLevel, enabled: boolean): Record<string, unknown> {
  if (!enabled) return {}
  if (level === 'off') return { chat_template_kwargs: { enable_thinking: false } }
  return { reasoning_effort: REASONING_EFFORT[level], chat_template_kwargs: { enable_thinking: true } }
}

/**
 * 鉴权头：内网无鉴权的模型端点可以没有 API Key，
 * 此时不发送 Authorization（避免出现 `Bearer ` 空令牌被上游拒绝）。
 */
function authHeaders(apiKey: string): Record<string, string> {
  const trimmed = apiKey.trim()
  return trimmed === '' ? {} : { Authorization: `Bearer ${trimmed}` }
}

/** Base URL 规范化：去空白、去末尾所有 `/`，必须是 http(s)（§11.5） */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throwApi('INVALID_BASE_URL', '接口地址必须是合法的 http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiFailure('INVALID_BASE_URL', '接口地址必须是合法的 http(s) URL')
  }
  const stripped = trimmed.replace(/\/+$/u, '')
  if (stripped === '') {
    throw new ApiFailure('INVALID_BASE_URL', '接口地址必须是合法的 http(s) URL')
  }
  return stripped
}

function upstreamFailure(error: unknown): never {
  if (error instanceof ApiFailure) throw error
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    throwApi('UPSTREAM_TIMEOUT', '模型服务响应超时，请稍后重试')
  }
  throwApi('UPSTREAM_ERROR', '无法连接模型服务，请检查接口地址与网络')
}

function mapStatus(status: number): never {
  if (status === 401 || status === 403) {
    throwApi('UPSTREAM_AUTH', '模型服务鉴权失败，请检查 API Key')
  }
  if (status === 429) {
    throwApi('UPSTREAM_RATE_LIMIT', '模型服务限流，请稍后重试')
  }
  throwApi('UPSTREAM_ERROR', '模型服务返回异常状态', { status })
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throwApi('UPSTREAM_INVALID_RESPONSE', '模型服务返回的不是合法 JSON')
  }
}

/** 从非流式响应体里取助手正文（空内容一律按上游异常处理） */
function extractContent(body: unknown): string {
  const choices = (body as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '模型服务没有返回任何结果')
  }
  const first = choices[0] as { message?: { content?: unknown } } | undefined
  const content = first?.message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '模型服务返回的内容为空')
  }
  return content
}

/** 解析单行 SSE：`data: {...}` / `data: [DONE]`，其余行忽略 */
function handleStreamLine(
  line: string,
  onDelta: (chunk: string) => void,
  pushContent: (chunk: string) => void,
): boolean {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith(':') || !trimmed.startsWith('data:')) return false
  const payload = trimmed.slice('data:'.length).trim()
  if (payload === '') return false
  if (payload === '[DONE]') return true

  let parsed: unknown
  try {
    parsed = JSON.parse(payload) as unknown
  } catch {
    // 单行坏片段不中断整条流（部分上游会插入空行/心跳）
    return false
  }
  const choices = (parsed as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return false
  const delta = (choices[0] as {
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }
  } | undefined)?.delta
  // 推理内容也展示给管理员，但不计入正文返回值。
  // vLLM 0.27 / Qwen 实际下发的是 delta.reasoning，兼容旧版 reasoning_content。
  for (const reasoning of [delta?.reasoning, delta?.reasoning_content]) {
    if (typeof reasoning === 'string' && reasoning !== '') onDelta(reasoning)
  }
  const piece = delta?.content
  if (typeof piece === 'string' && piece !== '') {
    pushContent(piece)
    onDelta(piece)
  }
  return false
}

/**
 * 读取 SSE 流式响应：逐行解析，正文累积为返回值。
 * 流中途断开时按上游异常抛出——已收到的片段由调用方的 onDelta 落库，不会丢。
 */
async function readStreamContent(response: Response, onDelta: (chunk: string) => void): Promise<string> {
  const body = response.body
  if (!body) throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '模型服务没有返回任何结果')

  let content = ''
  const pushContent = (chunk: string): void => {
    content += chunk
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let finished = false

  const drain = (): void => {
    let index = pending.indexOf('\n')
    while (index >= 0 && !finished) {
      const line = pending.slice(0, index)
      pending = pending.slice(index + 1)
      if (handleStreamLine(line, onDelta, pushContent)) finished = true
      index = pending.indexOf('\n')
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      drain()
    }
    pending += decoder.decode()
    if (!finished && pending.trim() !== '') handleStreamLine(pending, onDelta, pushContent)
  } catch (error) {
    if (error instanceof ApiFailure) throw error
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throwApi('UPSTREAM_TIMEOUT', '模型服务响应超时，请稍后重试')
    }
    // 流被截断：已收到的内容已在调用方手里，这里只回报上游异常
    throwApi('UPSTREAM_INVALID_RESPONSE', '模型输出流被中断，已保留已接收的内容')
  } finally {
    try {
      await reader.cancel()
    } catch {
      // reader 已关闭时取消失败可忽略
    }
  }

  if (content.trim() === '') {
    throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '模型服务返回的内容为空')
  }
  return content
}

/** 读取可用模型列表：GET {baseUrl}/models，取 data[].id 去重排序（§8.4 14 / §11.5） */
export async function listModels(config: { baseUrl: string; apiKey: string }): Promise<string[]> {
  let response: Response
  try {
    response = await fetch(`${config.baseUrl}/models`, {
      method: 'GET',
      headers: {
        ...authHeaders(config.apiKey),
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    upstreamFailure(error)
  }
  if (!response.ok) mapStatus(response.status)
  const body = await readJsonBody(response)
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) {
    throw new ApiFailure('UPSTREAM_INVALID_RESPONSE', '模型服务返回的数据结构不正确')
  }
  const ids = new Set<string>()
  for (const item of data) {
    if (item && typeof item === 'object') {
      const id = (item as { id?: unknown }).id
      if (typeof id === 'string' && id.trim() !== '') ids.add(id)
    }
  }
  return Array.from(ids).sort((a, b) => a.localeCompare(b))
}

/**
 * 调用对话补全：POST {baseUrl}/chat/completions，返回助手文本（§11.5）。
 * 传入 onDelta 时改用 SSE 流式，逐片回传（推理内容也回传但不计入返回值）。
 * 上游若对未知字段严格（400），自动去思考参数重试一次并记住这个上游。
 */
export async function requestChatCompletion(config: ChatCompletionRequest): Promise<string> {
  const level = normalizeThinkingLevel(config.thinking ?? config.thinkingLevel)
  const onDelta = config.onDelta
  const streaming = onDelta !== undefined
  const includeThinking = !thinkingUnsupported.has(config.baseUrl)

  const send = async (withThinking: boolean): Promise<Response> => {
    const body: Record<string, unknown> = {
      model: config.modelId,
      messages: config.messages,
      stream: streaming,
      ...thinkingFields(level, withThinking),
    }
    try {
      return await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          ...authHeaders(config.apiKey),
          'Content-Type': 'application/json',
          Accept: streaming ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      upstreamFailure(error)
    }
  }

  let response = await send(includeThinking)
  if (response.status === 400 && includeThinking) {
    // 上游不认识 reasoning_effort / chat_template_kwargs：去参重试一次并记住
    thinkingUnsupported.add(config.baseUrl)
    console.warn(
      `[ai] 上游 ${config.baseUrl} 不接受思考参数（reasoning_effort/chat_template_kwargs），已去参数重试，后续请求不再附带`,
    )
    try {
      await response.body?.cancel()
    } catch {
      // 丢弃首个响应体失败可忽略
    }
    response = await send(false)
  }
  if (!response.ok) mapStatus(response.status)

  if (!streaming || onDelta === undefined) {
    return extractContent(await readJsonBody(response))
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.includes('text/event-stream')) {
    // 上游忽略了 stream：按普通 JSON 处理，整段内容一次性交给 onDelta
    const content = extractContent(await readJsonBody(response))
    onDelta(content)
    return content
  }
  return readStreamContent(response, onDelta)
}
