<script setup lang="ts">
/**
 * 逐题作答页（设计 §6.2/§6.3、契约 §9.1/§10.2/§10.3）：
 * 单题卡片 + 题号面板；600ms 防抖、串行保存、409 冲突二选一；正计时只显示已用时间。
 */
import type {
  AnswerMap,
  AttemptDetailDTO,
  AttemptStartResult,
  CandidateAnswer,
  SubmitResult,
} from '#shared/types'

useHead({ title: '知卷 · 答题' })

const route = useRoute()
const examIdParam = computed(() => String(route.params.examId ?? ''))

const attempt = ref<AttemptDetailDTO | null>(null)
const loading = ref(true)
const loadError = ref('')
const answers = ref<AnswerMap>({})
const currentIndex = ref(0)
const switching = ref(false)
const submitting = ref(false)
const submitError = ref('')
const navDrawer = ref(false)
const conflictCopied = ref(false)
const deadlineHandled = ref(false)
const resyncing = ref(false)

const autosave = useAttemptAutosave({ attemptId: () => attempt.value?.attemptId ?? '' })
const clock = useServerClock()

const questions = computed(() => attempt.value?.questions ?? [])
const total = computed(() => questions.value.length)
const currentQuestion = computed(() => questions.value[currentIndex.value] ?? null)
const conflictQuestion = computed(() => questions.value.find((item) => item.id === autosave.conflict.value?.questionId))
const currentAnswer = computed<CandidateAnswer | null>(() => {
  const question = currentQuestion.value
  if (!question) return null
  return answers.value[question.id] ?? null
})
const answeredCount = computed(() => countAnswered(questions.value, answers.value))
const unansweredCount = computed(() => Math.max(0, total.value - answeredCount.value))
const elapsedMs = computed(() => (attempt.value ? Math.max(0, clock.now.value - attempt.value.startedAt) : 0))
const deadlineReached = computed(() => (attempt.value ? clock.now.value >= attempt.value.exam.endsAt : false))
const isLast = computed(() => currentIndex.value >= total.value - 1)
const isReadOnly = computed(() => deadlineReached.value || submitting.value)
const examTitle = computed(() => attempt.value?.exam.title ?? '答题')
const examTimeZone = computed(() => attempt.value?.exam.timeZone ?? browserTimeZone())

const saveStateText = computed(() => {
  switch (autosave.state.value) {
    case 'pending':
      return '待保存…'
    case 'saving':
      return '保存中…'
    case 'saved':
      return '已保存'
    case 'error':
      return '保存失败'
    case 'conflict':
      return '存在冲突'
    default:
      return '已同步'
  }
})

const saveStateType = computed(() => {
  if (autosave.state.value === 'error' || autosave.state.value === 'conflict') return 'danger'
  if (autosave.state.value === 'saved') return 'success'
  return 'info'
})

function applyDetail(detail: AttemptDetailDTO): void {
  attempt.value = detail
  answers.value = { ...detail.answers }
  autosave.setVersion(detail.version)
  clock.sync(detail.serverNow)
  if (currentIndex.value >= detail.questions.length) {
    currentIndex.value = Math.max(0, detail.questions.length - 1)
  }
}

async function goResult(attemptId: string): Promise<void> {
  await navigateTo(`/attempts/${attemptId}/result`, { replace: true })
}

async function bootstrap(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    // 契约 §10.2：start 必须带 examId（同时段可能有多场考试，由考生自选场次进入）；刷新时沿用原开始时间。
    const started = await apiFetch<AttemptStartResult>('/api/attempts/start', {
      method: 'POST',
      body: { examId: examIdParam.value },
      silent: true,
    })
    if (started.status === 'submitted') {
      await goResult(started.attemptId)
      return
    }
    if (started.examId !== examIdParam.value) {
      await navigateTo(`/exams/${started.examId}/attempt`, { replace: true })
      return
    }
    const detail = await apiFetch<AttemptDetailDTO>(`/api/attempts/${started.attemptId}`, { silent: true })
    if (detail.status === 'submitted') {
      await goResult(detail.attemptId)
      return
    }
    applyDetail(detail)
    clock.start(1000)
  } catch (error) {
    const apiError = error instanceof ApiClientError ? error : null
    if (apiError?.code === 'EXAM_NOT_OPEN') {
      const details = apiError.details as { nextExam?: { startsAt: number; timeZone: string } | null } | undefined
      const next = details?.nextExam
      loadError.value = next
        ? `当前没有开放中的考试。下一场开始时间：${formatDateTime(next.startsAt, next.timeZone)}（${next.timeZone}）`
        : '当前没有开放中的考试。'
      return
    }
    loadError.value = describeApiError(error, '无法进入考试，请返回入口重试')
  } finally {
    loading.value = false
  }
}

async function reloadDetail(silent = true, replaceAnswers = false): Promise<void> {
  const attemptId = attempt.value?.attemptId
  if (!attemptId) return
  resyncing.value = true
  const requestedVersion = autosave.version.value
  const hadPending = autosave.hasPending()
  try {
    const detail = await apiFetch<AttemptDetailDTO>(`/api/attempts/${attemptId}`, { silent })
    if (detail.status === 'submitted') {
      await goResult(detail.attemptId)
      return
    }
    clock.sync(detail.serverNow)
    if (replaceAnswers || (!hadPending && !autosave.hasPending() && requestedVersion === autosave.version.value)) {
      applyDetail(detail)
    }
  } catch (error) {
    if (!silent) ElMessage.error(describeApiError(error, '刷新答卷失败'))
  } finally {
    resyncing.value = false
  }
}

function handleAnswerChange(questionId: string, answer: CandidateAnswer): void {
  if (isReadOnly.value) return
  answers.value = { ...answers.value, [questionId]: answer }
  autosave.scheduleSave(questionId, normalizeAnswerForSubmit(answer))
}

async function goTo(index: number): Promise<void> {
  const attemptId = attempt.value?.attemptId
  if (!attemptId || index < 0 || index >= total.value) return
  if (switching.value) return
  if (autosave.hasPending()) {
    switching.value = true
    try {
      await autosave.flushNow()
    } catch (error) {
      if (error instanceof ApiClientError && (error.code === 'EXAM_CLOSED' || error.code === 'ALREADY_SUBMITTED')) {
        await goResult(attemptId)
      }
      return
    } finally {
      switching.value = false
    }
  }
  currentIndex.value = index
  navDrawer.value = false
}

async function handleConflictUseServer(): Promise<void> {
  const current = autosave.conflict.value
  const attemptId = attempt.value?.attemptId
  if (!current || !attemptId) return
  try {
    const detail = await apiFetch<AttemptDetailDTO>(`/api/attempts/${attemptId}`, { silent: true })
    if (detail.status === 'submitted') {
      await goResult(attemptId)
      return
    }
    applyDetail(detail)
    autosave.resolveConflict('server', detail.version)
    conflictCopied.value = false
    ElMessage.success('已载入服务器最新答卷')
  } catch (error) {
    ElMessage.error(describeApiError(error, '刷新失败，请重试'))
  }
}

async function handleConflictCopy(): Promise<void> {
  const conflict = autosave.conflict.value
  if (!conflict) return
  const text = conflictDraftText.value
  try {
    await navigator.clipboard.writeText(text)
    conflictCopied.value = true
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.error('复制失败，请手动记录答案后再刷新')
  }
}

const conflictDraftText = computed(() => {
  const localAnswers = answers.value
  if (!autosave.conflict.value) return ''
  return autosave.pendingQuestionIds().map((id) => {
    const question = questions.value.find((item) => item.id === id)
    return question ? `第 ${question.position} 题：${describeAnswer(question, localAnswers[id] ?? null)}` : ''
  }).filter(Boolean).join('\n')
})

async function submit(reason: 'manual' | 'deadline'): Promise<void> {
  if (submitting.value) return
  const attemptId = attempt.value?.attemptId
  if (!attemptId) return
  submitting.value = true
  submitError.value = ''
  try {
    await autosave.flushNow()
    const result = await apiFetch<SubmitResult>(`/api/attempts/${attemptId}/submit`, {
      method: 'POST',
      body: {
        expectedVersion: autosave.version.value,
        answers: buildSubmitSnapshot(questions.value, answers.value),
      },
      silent: true,
    })
    if (!result.acceptedSnapshot) {
      ElMessage.warning('已过截止时间，服务端仅采用最后保存的答案')
    }
    await goResult(attemptId)
  } catch (error) {
    const apiError = error instanceof ApiClientError ? error : null
    if (apiError?.code === 'VERSION_CONFLICT') {
      if (autosave.conflict.value) return
      ElMessage.warning('答卷已被更新，正在刷新后重新确认交卷')
      await reloadDetail(false, true)
      return
    }
    if (apiError?.code === 'EXAM_CLOSED' || apiError?.code === 'ALREADY_SUBMITTED') {
      ElMessage.warning('考试已截止，服务端已按最后保存的答案结算')
      await goResult(attemptId)
      return
    }
    submitError.value = describeApiError(error, reason === 'deadline' ? '截止自动交卷失败' : '交卷失败，请重试')
  } finally {
    submitting.value = false
  }
}

async function confirmSubmit(): Promise<void> {
  if (!attempt.value || submitting.value) return
  try {
    await ElMessageBox.confirm(
      `已答 ${answeredCount.value} 题，未答 ${unansweredCount.value} 题。交卷后不可修改，确定交卷吗？`,
      '确认交卷',
      {
        confirmButtonText: '交卷',
        cancelButtonText: '继续答题',
        type: 'warning',
      },
    )
  } catch {
    return
  }
  await submit('manual')
}

/** 到期自动交卷（只执行一次） */
watch(deadlineReached, async (reached) => {
  if (!reached || deadlineHandled.value || !attempt.value) return
  deadlineHandled.value = true
  ElMessage.warning('已到考试结束时间，正在提交答卷')
  await submit('deadline')
})

/** 每 60 秒或页面重新可见时同步服务端（契约 §10.3） */
let resyncTimer: ReturnType<typeof setInterval> | null = null

function handleVisibility(): void {
  if (typeof document === 'undefined') return
  if (document.visibilityState === 'visible' && attempt.value) void reloadDetail()
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (!autosave.hasPending()) return
  event.preventDefault()
  event.returnValue = ''
}

onMounted(async () => {
  await bootstrap()
  resyncTimer = setInterval(() => {
    if (attempt.value && document.visibilityState === 'visible') void reloadDetail()
  }, 60_000)
  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onBeforeUnmount(() => {
  if (resyncTimer) clearInterval(resyncTimer)
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibility)
  if (typeof window !== 'undefined') window.removeEventListener('beforeunload', handleBeforeUnload)
  void autosave.flushNow().catch(() => {
    // 页面卸载时的保存失败无法提示，交卷前已强制 flush
  })
  autosave.dispose()
})
</script>

<template>
  <section class="attempt">
    <StatePanel
      v-if="loading"
      state="loading"
      title="正在准备你的答卷…"
      :loading-rows="6"
    />

    <StatePanel
      v-else-if="loadError"
      state="error"
      title="无法进入考试"
      :description="loadError"
      retry-text="重新获取"
      action-text="返回入口"
      action-to="/"
      @retry="bootstrap()"
    />

    <template v-else-if="attempt && currentQuestion">
      <header class="attempt__bar">
        <div class="attempt__bar-left">
          <h1 class="attempt__title">{{ examTitle }}</h1>
          <p class="attempt__meta zj-muted">
            截止 {{ formatDateTime(attempt.exam.endsAt, examTimeZone) }}（{{ examTimeZone }}）
          </p>
        </div>
        <div class="attempt__bar-right">
          <span class="attempt__clock">
            <span class="attempt__clock-label zj-muted">已用</span>
            <span class="attempt__clock-value zj-tabular">{{ formatClock(elapsedMs) }}</span>
          </span>
          <el-tag type="success" effect="plain" class="attempt__progress-tag">
            {{ currentIndex + 1 }} / {{ total }}
          </el-tag>
          <el-button class="attempt__nav-toggle" @click="navDrawer = true">题号</el-button>
        </div>
      </header>

      <el-alert
        v-if="deadlineReached"
        type="warning"
        :closable="false"
        show-icon
        title="已到截止时间，答题区已锁定并自动提交。"
        class="attempt__alert"
      />

      <el-alert
        v-else-if="autosave.state.value === 'error'"
        type="error"
        :closable="false"
        show-icon
        :title="autosave.errorMessage.value || '答案未保存'"
        class="attempt__alert"
      >
        <template #default>
          <el-button size="small" @click="autosave.retry()">重试保存</el-button>
        </template>
      </el-alert>

      <div class="attempt__grid">
        <main class="attempt__main">
          <Transition name="q-fade" mode="out-in">
            <candidate-attempt-question-card
              :key="currentQuestion.id"
              :question="currentQuestion"
              :index="currentIndex"
              :total="total"
              :model-value="currentAnswer"
              :disabled="isReadOnly"
              @change="handleAnswerChange"
            />
          </Transition>

          <div class="attempt__actions">
            <div class="attempt__actions-left">
              <el-button size="large" :disabled="currentIndex === 0 || switching" @click="goTo(currentIndex - 1)">
                上一题
              </el-button>
              <el-button v-if="!isLast" size="large" type="primary" :disabled="switching" @click="goTo(currentIndex + 1)">
                下一题
              </el-button>
              <el-button
                v-else
                size="large"
                type="primary"
                :loading="submitting"
                :disabled="isReadOnly && !submitting"
                @click="confirmSubmit"
              >
                交卷
              </el-button>
            </div>
            <div class="attempt__save">
              <el-tag :type="saveStateType" effect="plain" size="small">{{ saveStateText }}</el-tag>
              <span v-if="autosave.lastSavedAt.value" class="zj-muted attempt__saved-at zj-tabular">
                {{ formatTime(autosave.lastSavedAt.value, examTimeZone) }}
              </span>
              <span v-if="resyncing" class="zj-muted attempt__saved-at">同步中…</span>
            </div>
          </div>

          <p v-if="submitError" class="attempt__submit-error">{{ submitError }}</p>

          <div class="attempt__footer-actions">
            <span class="zj-muted">已答 {{ answeredCount }} 题 · 未答 {{ unansweredCount }} 题</span>
            <el-button v-if="!isLast" text type="primary" @click="goTo(total - 1)">跳到最后一题</el-button>
            <el-button v-else text type="primary" :loading="submitting" @click="confirmSubmit">交卷</el-button>
          </div>
        </main>

        <aside class="attempt__aside">
          <candidate-question-navigator
            :questions="questions"
            :answers="answers"
            :current-index="currentIndex"
            :disabled="switching"
            @select="goTo"
          />
          <div class="attempt__aside-actions">
            <el-button
              type="primary"
              size="large"
              class="attempt__submit"
              :loading="submitting"
              :disabled="isReadOnly && !submitting"
              @click="confirmSubmit"
            >
              交卷
            </el-button>
            <p class="zj-muted attempt__aside-hint">切题或交卷前会自动等待保存完成。</p>
          </div>
        </aside>
      </div>
    </template>

    <StatePanel
      v-else
      state="empty"
      title="这份答卷暂时没有题目"
      description="请联系管理员确认本场次的试卷是否已发布。"
      action-text="返回入口"
      action-to="/"
    />

    <el-drawer v-model="navDrawer" title="题号导航" direction="rtl" size="86%">
      <candidate-question-navigator
        :questions="questions"
        :answers="answers"
        :current-index="currentIndex"
        :disabled="switching"
        @select="goTo"
      />
    </el-drawer>

    <el-dialog
      :model-value="autosave.conflict.value !== null"
      title="答案保存冲突"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
      :show-close="false"
      width="min(520px, 92vw)"
    >
      <p class="attempt__conflict-text">
        答卷版本与服务器不一致，保存已暂停。刷新将采用服务器整份答卷并放弃本地未保存内容，请先复制下面的输入。
      </p>
      <el-descriptions v-if="autosave.conflict.value" :column="1" border size="small">
        <el-descriptions-item label="题目">
          {{
            conflictQuestion ? formatQuestionStem(conflictQuestion.stem, conflictQuestion.type).slice(0, 60) : '—'
          }}
        </el-descriptions-item>
        <el-descriptions-item label="服务器上的答案">
          {{
            describeAnswer(
              questions.find((item) => item.id === autosave.conflict.value?.questionId) ?? { type: 'fill_blank', options: [] },
              autosave.conflict.value?.serverAnswer ?? null,
            )
          }}
        </el-descriptions-item>
        <el-descriptions-item label="我刚填的答案">
          {{
            describeAnswer(
              questions.find((item) => item.id === autosave.conflict.value?.questionId) ?? { type: 'fill_blank', options: [] },
              autosave.conflict.value?.localAnswer ?? null,
            )
          }}
        </el-descriptions-item>
      </el-descriptions>
      <el-input :model-value="conflictDraftText" type="textarea" :rows="4" readonly aria-label="本地未保存答案，可手动复制" />
      <template #footer>
        <el-button @click="handleConflictCopy">
          {{ conflictCopied ? '已复制未保存答案' : '复制全部未保存答案' }}
        </el-button>
        <el-button type="primary" @click="handleConflictUseServer">用服务器版本刷新</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.attempt {
  max-width: 1120px;
  margin: 0 auto;
}

.attempt__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.attempt__title {
  margin: 0;
  font-size: clamp(18px, 2.4vw, 22px);
  font-weight: 500;
  line-height: 1.35;
}

.attempt__meta {
  margin: 4px 0 0;
  font-size: 14px;
}

.attempt__bar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.attempt__clock {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 12px;
  background: var(--zj-surface);
  border: 1px solid var(--zj-border);
  border-radius: var(--zj-radius);
}

.attempt__clock-label {
  font-size: 13px;
}

.attempt__clock-value {
  font-size: 18px;
  font-weight: 500;
}

.attempt__nav-toggle {
  display: none;
}

.attempt__alert {
  margin-bottom: 12px;
}

.attempt__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: var(--zj-section-gap);
  align-items: start;
}

.attempt__main {
  max-width: 800px;
  min-width: 0;
}

.attempt__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 16px;
}

.attempt__actions-left {
  display: flex;
  gap: 12px;
}

.attempt__save {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.attempt__saved-at {
  font-size: 13px;
}

.attempt__submit-error {
  margin: 12px 0 0;
  color: var(--zj-danger);
  font-size: 15px;
}

.attempt__footer-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  font-size: 14px;
}

.attempt__aside {
  position: sticky;
  top: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.attempt__submit {
  width: 100%;
  min-height: 44px;
}

.attempt__aside-hint {
  margin: 8px 0 0;
  font-size: 13px;
}

.attempt__conflict-text {
  margin: 0 0 16px;
  font-size: 15px;
}

.q-fade-enter-active,
.q-fade-leave-active {
  transition: opacity 180ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}

.q-fade-enter-from,
.q-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (max-width: 960px) {
  .attempt__grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .attempt__aside {
    display: none;
  }

  .attempt__nav-toggle {
    display: inline-flex;
  }

  .attempt__main {
    max-width: none;
  }
}
</style>
