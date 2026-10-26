<script setup lang="ts">
/**
 * 出题任务的模型原始输出（契约 §11.8）：
 * 按 offset 增量拉取，只把新增文本追加到本地；active 期间每 JOB_OUTPUT_POLL_INTERVAL_MS 拉一次，
 * 任务结束后补拉一次收尾。请求失败只在面板内展示文案，不弹全局错误提示。
 */
import type { JobOutputDTO } from '#shared/types'
import { JOB_OUTPUT_POLL_INTERVAL_MS } from '#shared/constants'

interface Props {
  /** 出题任务 id；null 表示还没有任务 */
  jobId: string | null
  /** 任务是否仍在执行（queued / running） */
  active: boolean
  /** 面板标题 */
  title?: string
  /** 当前任务的模型 ID，展示在状态栏 */
  modelId?: string | null
}

const props = withDefaults(defineProps<Props>(), { title: '模型输出', modelId: null })

/** 距底部小于该像素数视为「贴着底部」，避免亚像素误差误判 */
const BOTTOM_TOLERANCE_PX = 16
/** 任务已结束时，单次最多返回 JOB_OUTPUT_CHUNK_CHARS 字符，需要连续拉几轮 */
const DRAIN_MAX_ROUNDS = 20

const text = ref('')
const offset = ref(0)
const runId = ref<string | undefined>()
let bufferStart = 0
const total = ref(0)
const truncatedCount = ref(0)
const done = ref(false)
const errorText = ref('')
const autoScroll = ref(true)
const atBottom = ref(true)
const bodyEl = ref<HTMLElement | null>(null)

let timer: ReturnType<typeof setTimeout> | null = null
/** 正在进行的拉取；非空表示上一次请求还没回来 */
let inflight: Promise<boolean> | null = null
let disposed = false

/** 已收集字符数：服务端 total 优先，没拿到时退回本地文本长度 */
const charCount = computed(() => (total.value > 0 ? total.value : text.value.length))
const charCountLabel = computed(() => groupDigits(charCount.value))
const truncatedLabel = computed(() => groupDigits(truncatedCount.value))
const running = computed(() => Boolean(props.jobId) && props.active && !done.value)
const statusText = computed(() => {
  if (!props.jobId) return '未开始'
  return running.value ? '输出中' : '已结束'
})

/** 千分位分组：不用 toLocaleString，保证 SSR 与浏览器输出一致 */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

function reset(): void {
  clearTimer()
  text.value = ''
  offset.value = 0
  runId.value = undefined
  bufferStart = 0
  total.value = 0
  truncatedCount.value = 0
  done.value = false
  errorText.value = ''
  autoScroll.value = true
  atBottom.value = true
}

/** 拉取一段增量；返回本次是否拿到新文本 */
function pull(): Promise<boolean> {
  if (inflight) return inflight
  const jobId = props.jobId
  if (!jobId) return Promise.resolve(false)
  const requestedOffset = offset.value

  inflight = (async (): Promise<boolean> => {
    try {
      const chunk = await apiFetch<JobOutputDTO>(`/api/admin/jobs/${jobId}/output`, {
        query: { offset: requestedOffset, runId: runId.value },
        silent: true,
      })
      // 期间切换了任务或组件已卸载：丢弃旧响应，避免串台
      if (disposed || jobId !== props.jobId) return false
      const start = chunk.startOffset ?? requestedOffset
      if (chunk.runId !== runId.value || start > offset.value) {
        text.value = ''
        bufferStart = start
      } else if (chunk.truncated > bufferStart) {
        text.value = Array.from(text.value).slice(chunk.truncated - bufferStart).join('')
        bufferStart = chunk.truncated
      }
      runId.value = chunk.runId
      const grew = chunk.text.length > 0
      if (grew) text.value += chunk.text
      offset.value = chunk.offset
      total.value = chunk.total
      truncatedCount.value = chunk.truncated
      done.value = chunk.done
      errorText.value = ''
      return grew
    } catch (error) {
      if (disposed || jobId !== props.jobId) return false
      // 只把内部错误文案放在面板里，不弹 ElMessage
      errorText.value = describeApiError(error, '读取模型输出失败，稍后会自动重试')
      return false
    } finally {
      inflight = null
    }
  })()

  return inflight
}

/** 连续拉取直到没有新增（任务已结束时一次可能取不完） */
async function drain(): Promise<void> {
  for (let round = 0; round < DRAIN_MAX_ROUNDS; round += 1) {
    const grew = await pull()
    if (disposed || !grew || !props.jobId || props.active) return
  }
}

function scheduleNext(): void {
  clearTimer()
  if (disposed || !props.jobId || !props.active) return
  timer = setTimeout(() => {
    timer = null
    void pollOnce()
  }, JOB_OUTPUT_POLL_INTERVAL_MS)
}

async function pollOnce(): Promise<void> {
  if (disposed || !props.jobId || !props.active) return
  if (inflight) {
    // 上一次还没回来：跳过本次，避免请求叠加
    scheduleNext()
    return
  }
  await pull()
  if (disposed || !props.jobId || !props.active) return
  // 以父组件的任务状态决定轮询，避免同 ID 重试时旧响应提前结束新一轮拉取。
  scheduleNext()
}

/** 出错后手动重试：运行中重新起轮询，已结束则再补拉一轮 */
function retryPull(): void {
  if (!props.jobId) return
  errorText.value = ''
  if (props.active) scheduleNext()
  else void drain()
}

function scrollToBottom(): void {
  const el = bodyEl.value
  if (!el) return
  el.scrollTop = el.scrollHeight
}

function handleScroll(): void {
  const el = bodyEl.value
  if (!el) return
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  atBottom.value = distance <= BOTTOM_TOLERANCE_PX
  // 用户手动往上滚：暂停自动滚动，不要强行拽回底部
  if (!atBottom.value && autoScroll.value) autoScroll.value = false
}

function jumpToLatest(): void {
  autoScroll.value = true
  scrollToBottom()
  atBottom.value = true
}

/** 选中面板正文，供 clipboard 不可用时手动复制 */
function selectContent(): void {
  const el = bodyEl.value
  if (!el) return
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(el)
  selection.removeAllRanges()
  selection.addRange(range)
}

async function copyAll(): Promise<void> {
  if (!text.value) return
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      throw new Error('clipboard unavailable')
    }
    await navigator.clipboard.writeText(text.value)
    ElMessage.success('已复制模型输出全文')
  } catch {
    // 非安全上下文或权限被拒：选出正文让用户手动复制
    selectContent()
    ElMessage.warning('浏览器不允许直接写剪贴板，已选中输出内容，请按 Ctrl+C 复制')
  }
}

watch(
  () => props.jobId,
  (jobId) => {
    reset()
    if (!jobId) return
    if (props.active) scheduleNext()
    else void drain()
  },
  { immediate: true },
)

watch(
  () => props.active,
  (active) => {
    if (!props.jobId) return
    if (active) {
      scheduleNext()
      return
    }
    // 任务结束：停定时器并补拉一次，把最后一段拿全
    clearTimer()
    void drain()
  },
)

watch(autoScroll, (enabled) => {
  if (enabled) jumpToLatest()
})

watch(
  () => text.value,
  async () => {
    if (!autoScroll.value) return
    await nextTick()
    scrollToBottom()
    atBottom.value = true
  },
)

onBeforeUnmount(() => {
  disposed = true
  clearTimer()
})
</script>

<template>
  <el-card shadow="never" class="job-output">
    <template #header>
      <div class="job-output__head">
        <span class="job-output__title">{{ title }}</span>
        <span class="job-output__meta">
          <el-tag :type="running ? 'warning' : 'info'" effect="plain" size="small">{{ statusText }}</el-tag>
          <span v-if="modelId" class="zj-muted job-output__model" :title="modelId">{{ modelId }}</span>
          <span class="zj-muted job-output__count zj-tabular">{{ charCountLabel }} 字符</span>
        </span>
      </div>
    </template>

    <div class="job-output__toolbar">
      <!-- 不用 label 包裹，避免点击开关时被 label 激活二次触发 -->
      <span class="job-output__toggle">
        <span class="zj-muted job-output__toggle-text">自动滚动</span>
        <el-switch v-model="autoScroll" size="small" />
      </span>
      <el-button size="small" :disabled="!text" @click="copyAll">复制全文</el-button>
      <el-button v-if="errorText" size="small" @click="retryPull">重试拉取</el-button>
      <el-button v-if="!atBottom" size="small" type="primary" plain @click="jumpToLatest">回到最新</el-button>
    </div>

    <el-alert
      v-if="truncatedCount > 0"
      class="job-output__truncated"
      type="warning"
      :closable="false"
      show-icon
      :title="`已截断前 ${truncatedLabel} 字符，仅保留最近的输出`"
    />

    <div ref="bodyEl" class="job-output__body" @scroll.passive="handleScroll">
      <p v-if="errorText" class="job-output__error">{{ errorText }}</p>
      <p v-if="!jobId" class="job-output__empty zj-muted">
        还没有出题任务。点击「开始 AI 出题」后，这里会实时显示模型的原始输出。
      </p>
      <p v-else-if="!text && !errorText" class="job-output__empty zj-muted">等待模型输出…</p>
      <div v-if="text" class="job-output__text">{{ text }}</div>
    </div>
  </el-card>
</template>

<style scoped>
.job-output {
  --job-output-max-height: 360px;
}

.job-output__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.job-output__title {
  font-size: 15px;
  font-weight: 600;
}

.job-output__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.job-output__model {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.job-output__count {
  font-size: 13px;
}

.job-output__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.job-output__toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: 4px;
}

.job-output__toggle-text {
  font-size: 13px;
}

.job-output__truncated {
  margin-bottom: 8px;
}

.job-output__body {
  max-height: var(--job-output-max-height);
  min-height: 120px;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px 12px;
  border: 1px solid var(--zj-border);
  border-radius: var(--zj-radius);
  background: var(--zj-bg);
  scrollbar-gutter: stable;
}

.job-output__text {
  margin: 0;
  font-family: var(--zj-mono);
  font-size: 13px;
  line-height: 1.55;
  color: var(--zj-text);
  white-space: pre-wrap;
  word-break: break-word;
}

.job-output__empty {
  margin: 0;
  font-size: 13px;
}

.job-output__error {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--zj-danger);
}
</style>
