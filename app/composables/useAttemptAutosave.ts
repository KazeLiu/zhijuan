/**
 * 作答自动保存（契约 §10.3）：
 * - 600ms 防抖后入队；**串行**发送，同一时刻只有一个 PATCH 在飞
 * - 同一题多次变更合并为最新值，旧响应不会覆盖新输入（version 由服务端串行递增保证）
 * - 409 VERSION_CONFLICT 时不静默覆盖：暂停队列并抛出冲突信息，由页面弹窗二选一
 */
import type { AnswerSaveResult, AttemptDetailDTO, CandidateAnswer } from '#shared/types'
import { AUTOSAVE_DEBOUNCE_MS } from '#shared/constants'
import { ApiClientError } from './useApi'

export type AutosaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict'

export interface SaveConflict {
  questionId: string
  localAnswer: CandidateAnswer | null
  serverAnswer: CandidateAnswer | null
  serverVersion: number
}

export interface AttemptAutosaveOptions {
  /** 延迟提供 attemptId：页面先 POST /attempts/start 才能拿到 id */
  attemptId: () => string
  initialVersion?: number
}

export function useAttemptAutosave(options: AttemptAutosaveOptions) {
  const version = ref(options.initialVersion ?? 0)
  const state = ref<AutosaveState>('idle')
  const lastSavedAt = ref<number | null>(null)
  const errorMessage = ref<string | null>(null)
  const conflict = ref<SaveConflict | null>(null)
  const pendingCount = ref(0)

  const pendingValues = new Map<string, CandidateAnswer | null>()
  const pendingOrder: string[] = []
  const scheduledValues = new Map<string, CandidateAnswer | null>()
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let draining = false
  let failure: ApiClientError | null = null
  let idleWaiters: Array<{ resolve: () => void; reject: (error: ApiClientError) => void }> = []

  function paused(): boolean {
    return state.value === 'error' || state.value === 'conflict'
  }

  function isIdle(): boolean {
    return pendingOrder.length === 0 && !draining && debounceTimers.size === 0
  }

  function notifyIfIdle(): void {
    if (draining || (!isIdle() && !paused())) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const waiter of waiters) {
      if (failure) waiter.reject(failure)
      else waiter.resolve()
    }
  }

  function waitForIdle(): Promise<void> {
    if (paused() && failure) return Promise.reject(failure)
    if (isIdle()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      idleWaiters.push({ resolve, reject })
    })
  }

  /** 是否有未落地的变更（含防抖等待中） */
  function hasPending(): boolean {
    return pendingOrder.length > 0 || draining || debounceTimers.size > 0
  }

  function setVersion(nextVersion: number): void {
    version.value = nextVersion
  }

  function pendingQuestionIds(): string[] {
    return [...new Set([...pendingOrder, ...scheduledValues.keys()])]
  }

  function scheduleSave(questionId: string, answer: CandidateAnswer | null): void {
    scheduledValues.set(questionId, answer)
    const existing = debounceTimers.get(questionId)
    if (existing) clearTimeout(existing)
    debounceTimers.set(
      questionId,
      setTimeout(() => {
        debounceTimers.delete(questionId)
        const latest = scheduledValues.get(questionId) ?? null
        scheduledValues.delete(questionId)
        enqueue(questionId, latest)
      }, AUTOSAVE_DEBOUNCE_MS),
    )
    if (state.value !== 'saving' && !paused()) state.value = 'pending'
  }

  function enqueue(questionId: string, answer: CandidateAnswer | null): void {
    if (!pendingValues.has(questionId)) pendingOrder.push(questionId)
    pendingValues.set(questionId, answer)
    pendingCount.value = pendingOrder.length
    if (!paused()) state.value = 'pending'
    void drain()
  }

  async function drain(): Promise<void> {
    if (draining || paused()) return
    draining = true
    try {
      while (pendingOrder.length > 0) {
        const questionId = pendingOrder[0]
        if (questionId === undefined) break
        const answer = pendingValues.get(questionId) ?? null
        pendingValues.delete(questionId)
        pendingOrder.shift()
        pendingCount.value = pendingOrder.length
        state.value = 'saving'

        try {
          const result = await apiFetch<AnswerSaveResult>(
            `/api/attempts/${options.attemptId()}/answers/${questionId}`,
            {
              method: 'PATCH',
              body: { expectedVersion: version.value, answer },
              silent: true,
            },
          )
          version.value = result.version
          lastSavedAt.value = result.savedAt
          errorMessage.value = null
          state.value = pendingOrder.length > 0 || debounceTimers.size > 0 ? 'pending' : 'saved'
        } catch (error) {
          const apiError = error instanceof ApiClientError ? error : null
          failure = apiError ?? new ApiClientError('UNKNOWN', describeApiError(error, '答案保存失败'), 0)
          // 请求期间可能继续输入，失败恢复时保留最新值而不是旧请求的快照。
          const latest = scheduledValues.has(questionId)
            ? scheduledValues.get(questionId) ?? null
            : pendingValues.has(questionId) ? pendingValues.get(questionId) ?? null : answer
          const timer = debounceTimers.get(questionId)
          if (timer) clearTimeout(timer)
          debounceTimers.delete(questionId)
          scheduledValues.delete(questionId)
          const queuedIndex = pendingOrder.indexOf(questionId)
          if (queuedIndex >= 0) pendingOrder.splice(queuedIndex, 1)
          pendingOrder.unshift(questionId)
          pendingValues.set(questionId, latest)
          pendingCount.value = pendingOrder.length
          if (apiError?.code === 'VERSION_CONFLICT') {
            state.value = 'conflict'
            await loadConflict(questionId, latest)
            break
          }
          if (apiError?.code === 'EXAM_CLOSED' || apiError?.code === 'ALREADY_SUBMITTED') {
            errorMessage.value = apiError.message
            state.value = 'conflict'
            break
          }
          // 网络抖动/服务端错误：保留该项等待重试
          errorMessage.value = describeApiError(error, '答案保存失败')
          state.value = 'error'
          break
        }
      }
    } finally {
      draining = false
      notifyIfIdle()
    }
  }

  async function loadConflict(questionId: string, local: CandidateAnswer | null): Promise<void> {
    try {
      const detail = await apiFetch<AttemptDetailDTO>(`/api/attempts/${options.attemptId()}`, { silent: true })
      conflict.value = {
        questionId,
        localAnswer: local,
        serverAnswer: detail.answers[questionId] ?? null,
        serverVersion: detail.version,
      }
      state.value = 'conflict'
    } catch (error) {
      failure = error instanceof ApiClientError ? error : new ApiClientError('UNKNOWN', describeApiError(error), 0)
      errorMessage.value = describeApiError(error, '无法获取服务器最新答案')
      state.value = 'error'
    }
  }

  /** 用户确认刷新整份服务器答卷后，丢弃旧版本队列，禁止其自动覆盖其他窗口。 */
  function resolveConflict(strategy: 'server', serverVersion: number): void {
    conflict.value = null
    for (const timer of debounceTimers.values()) clearTimeout(timer)
    debounceTimers.clear()
    scheduledValues.clear()
    pendingValues.clear()
    pendingOrder.length = 0
    pendingCount.value = 0
    version.value = serverVersion
    failure = null
    errorMessage.value = null
    state.value = 'idle'
    void drain()
  }

  /** 立即把防抖中的变更入队（切题/交卷前调用） */
  async function flushNow(): Promise<void> {
    for (const [questionId, timer] of [...debounceTimers.entries()]) {
      clearTimeout(timer)
      debounceTimers.delete(questionId)
      const latest = scheduledValues.get(questionId) ?? null
      scheduledValues.delete(questionId)
      enqueue(questionId, latest)
    }
    void drain()
    await waitForIdle()
  }

  function retry(): void {
    if (state.value !== 'error') return
    failure = null
    errorMessage.value = null
    if (state.value === 'error') state.value = pendingOrder.length > 0 ? 'pending' : 'idle'
    void drain()
  }

  /** 页面卸载时清理定时器（不保证落库，交卷前必须 flushNow） */
  function dispose(): void {
    for (const timer of debounceTimers.values()) clearTimeout(timer)
    debounceTimers.clear()
    scheduledValues.clear()
  }

  return {
    version,
    state,
    lastSavedAt,
    errorMessage,
    conflict,
    pendingCount,
    scheduleSave,
    flushNow,
    waitForIdle,
    hasPending,
    pendingQuestionIds,
    setVersion,
    resolveConflict,
    retry,
    dispose,
  }
}
