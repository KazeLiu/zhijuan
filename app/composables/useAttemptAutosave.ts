/**
 * 作答自动保存（契约 §10.3）：
 * - 600ms 防抖后入队；**串行**发送，同一时刻只有一个 PATCH 在飞
 * - 同一题多次变更合并为最新值，旧响应不会覆盖新输入（version 由服务端串行递增保证）
 * - 409 VERSION_CONFLICT 时不静默覆盖：暂停队列并抛出冲突信息，由页面弹窗二选一
 */
import type { AnswerSaveResult, AttemptDetailDTO, CandidateAnswer } from '#shared/types'
import { AUTOSAVE_DEBOUNCE_MS } from '#shared/constants'

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
  let idleWaiters: Array<() => void> = []

  function isIdle(): boolean {
    return pendingOrder.length === 0 && !draining
  }

  function notifyIfIdle(): void {
    if (!isIdle()) return
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  function waitForIdle(): Promise<void> {
    if (isIdle()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      idleWaiters.push(resolve)
    })
  }

  /** 是否有未落地的变更（含防抖等待中） */
  function hasPending(): boolean {
    return pendingOrder.length > 0 || draining || debounceTimers.size > 0
  }

  function setVersion(nextVersion: number): void {
    version.value = nextVersion
  }

  function scheduleSave(questionId: string, answer: CandidateAnswer | null): void {
    scheduledValues.set(questionId, answer)
    const existing = debounceTimers.get(questionId)
    if (existing) clearTimeout(existing)
    debounceTimers.set(
      questionId,
      setTimeout(() => {
        debounceTimers.delete(questionId)
        enqueue(questionId, scheduledValues.get(questionId) ?? null)
      }, AUTOSAVE_DEBOUNCE_MS),
    )
    if (state.value !== 'saving' && state.value !== 'conflict') state.value = 'pending'
  }

  function enqueue(questionId: string, answer: CandidateAnswer | null): void {
    if (!pendingValues.has(questionId)) pendingOrder.push(questionId)
    pendingValues.set(questionId, answer)
    pendingCount.value = pendingOrder.length
    if (state.value !== 'conflict') state.value = 'pending'
    void drain()
  }

  async function drain(): Promise<void> {
    if (draining) return
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
          state.value = pendingOrder.length > 0 ? 'pending' : 'saved'
        } catch (error) {
          const apiError = error instanceof ApiClientError ? error : null
          if (apiError?.code === 'VERSION_CONFLICT') {
            // 放回队首，暂停；等页面弹窗决定
            pendingOrder.unshift(questionId)
            pendingValues.set(questionId, answer)
            pendingCount.value = pendingOrder.length
            await loadConflict(questionId, answer)
            break
          }
          if (apiError?.code === 'EXAM_CLOSED' || apiError?.code === 'ALREADY_SUBMITTED') {
            errorMessage.value = apiError.message
            state.value = 'conflict'
            pendingOrder.unshift(questionId)
            pendingValues.set(questionId, answer)
            pendingCount.value = pendingOrder.length
            break
          }
          // 网络抖动/服务端错误：保留该项等待重试
          pendingOrder.unshift(questionId)
          pendingValues.set(questionId, answer)
          pendingCount.value = pendingOrder.length
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
      version.value = detail.version
      conflict.value = {
        questionId,
        localAnswer: local,
        serverAnswer: detail.answers[questionId] ?? null,
        serverVersion: detail.version,
      }
      state.value = 'conflict'
    } catch (error) {
      errorMessage.value = describeApiError(error, '无法获取服务器最新答案')
      state.value = 'error'
    }
  }

  /**
   * 冲突处理：
   * - 'server' 用服务器版本刷新（丢弃本地该项，页面需重新 GET 详情）
   * - 'local' 仅用于「已复制到剪贴板」后重新提交本地值？——契约禁止用我的覆盖服务器，
   *   因此 'local' 不提供；页面只应传 'server'，或调用 discardConflict() 自行重载。
   */
  function resolveConflict(strategy: 'server'): void {
    const current = conflict.value
    conflict.value = null
    if (current) {
      pendingValues.delete(current.questionId)
      const index = pendingOrder.indexOf(current.questionId)
      if (index >= 0) pendingOrder.splice(index, 1)
      pendingCount.value = pendingOrder.length
      scheduledValues.delete(current.questionId)
    }
    state.value = pendingOrder.length > 0 ? 'pending' : 'idle'
    void drain()
  }

  /** 立即把防抖中的变更入队（切题/交卷前调用） */
  async function flushNow(): Promise<void> {
    for (const [questionId, timer] of [...debounceTimers.entries()]) {
      clearTimeout(timer)
      debounceTimers.delete(questionId)
      enqueue(questionId, scheduledValues.get(questionId) ?? null)
    }
    await waitForIdle()
  }

  function retry(): void {
    errorMessage.value = null
    if (state.value === 'error') state.value = pendingOrder.length > 0 ? 'pending' : 'idle'
    void drain()
  }

  /** 页面卸载时清理定时器（不保证落库，交卷前必须 flushNow） */
  function dispose(): void {
    for (const timer of debounceTimers.values()) clearTimeout(timer)
    debounceTimers.clear()
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
    setVersion,
    resolveConflict,
    retry,
    dispose,
  }
}
