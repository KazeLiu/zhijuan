<script setup lang="ts">
/**
 * 入口页（设计 §6.1、契约 §9.1 + docs/lifecycle-contract.md §10.2）：
 * 未登录 → 姓名登录卡片；考生登录后展示「可参加的场次列表」，自己选场次后才开始答题。
 * 已暂停、已结束、已截止的场次由服务端过滤，不会出现在列表中。
 */
import type {
  AttemptStartResult,
  AvailableExamItemDTO,
  AvailableExamsDTO,
  LoginResultDTO,
  SessionDTO,
} from '#shared/types'

useHead({ title: '知卷 · 姓名进入' })

/** 考生可选场次列表中的单场次（GET /api/exams/available，契约 §10.2） */
type AvailableExamItem = AvailableExamItemDTO
type AvailableExamAttempt = NonNullable<AvailableExamItemDTO['myAttempt']>

const { session, logout } = useAuthSession()
/** 正在开始的场次 id：只锁当前卡片，其余卡片保持可点 */
const startingId = ref('')
const startError = ref('')

const { data: sessionData, error: sessionError, pending: sessionPending, refresh: reloadSession } =
  await useAsyncData<SessionDTO>('zj-session-entry', () => apiFetch<SessionDTO>('/api/auth/session', { silent: true }), {
    // 会话依赖 Cookie，首屏交给服务端取一次即可
    server: true,
  })

watchEffect(() => {
  if (sessionData.value) session.value = sessionData.value
})

const authenticated = computed(() => session.value?.authenticated === true)
const isCandidate = computed(() => authenticated.value && session.value?.role === 'candidate')

const {
  data: available,
  error: availableError,
  pending: availablePending,
  refresh: reloadAvailable,
} = await useAsyncData<AvailableExamsDTO>(
  'zj-available-exams',
  () => apiFetch<AvailableExamsDTO>('/api/exams/available', { silent: true }),
  { server: true, immediate: isCandidate.value },
)

const exams = computed<AvailableExamItem[]>(() => available.value?.items ?? [])
const availableErrorText = computed(() =>
  availableError.value ? describeApiError(availableError.value, '无法获取考试列表') : '',
)

function phaseText(phase: AvailableExamItem['phase']): string {
  return phase === 'open' ? '开放中' : '未开始'
}

function phaseTagType(phase: AvailableExamItem['phase']): 'success' | 'warning' {
  return phase === 'open' ? 'success' : 'warning'
}

function attemptText(status: AvailableExamAttempt['status']): string {
  return status === 'submitted' ? '已交卷' : '作答中'
}

function windowText(item: AvailableExamItem): string {
  return `${formatDateTime(item.startsAt, item.timeZone)} — ${formatDateTime(item.endsAt, item.timeZone)}`
}

function upcomingHint(item: AvailableExamItem): string {
  return `未开始，将于 ${formatDateTime(item.startsAt, item.timeZone)} 开放（${item.timeZone}）`
}

/** 登录/切换身份后重新取会话与场次列表，避免旧缓存 */
async function reloadAll(): Promise<void> {
  clearNuxtData()
  await reloadSession()
  session.value = sessionData.value ?? null
  if (session.value?.role === 'candidate') await reloadAvailable()
}

async function handleLoggedIn(result: LoginResultDTO): Promise<void> {
  clearNuxtData()
  sessionData.value = {
    authenticated: true,
    name: result.name,
    role: result.role,
    serverNow: result.serverNow,
  }
  if (result.role === 'admin') {
    await navigateTo(result.landing)
    return
  }
  await reloadAvailable()
}

async function handleLogout(): Promise<void> {
  await logout()
  await reloadAll()
}

/** 点击具体场次的「进入考试」才创建答卷并计时（契约 §10.2：必须带 examId） */
async function enterExam(item: AvailableExamItem): Promise<void> {
  if (startingId.value) return
  startingId.value = item.id
  startError.value = ''
  try {
    const started = await apiFetch<AttemptStartResult>('/api/attempts/start', {
      method: 'POST',
      body: { examId: item.id },
      silent: true,
    })
    if (started.status === 'submitted') {
      await navigateTo(`/attempts/${started.attemptId}/result`)
      return
    }
    await navigateTo(`/exams/${started.examId}/attempt`)
  } catch (error) {
    startError.value = describeApiError(error, '无法开始考试，请稍后重试')
  } finally {
    startingId.value = ''
  }
}
</script>

<template>
  <section class="entry">
    <header class="entry__head">
      <h1 class="entry__title">知卷</h1>
      <p class="entry__subtitle zj-muted">AI 出题 · 在线答题 · 交卷即出分</p>
    </header>

    <div v-if="sessionPending && !sessionData" class="entry__card">
      <StatePanel state="loading" title="正在确认登录状态…" :loading-rows="2" />
    </div>

    <el-alert
      v-else-if="sessionError && !authenticated"
      type="error"
      :closable="false"
      show-icon
      title="无法确认登录状态"
      class="entry__alert"
    >
      <p class="entry__alert-body">{{ describeApiError(sessionError, '请刷新页面重试') }}</p>
      <el-button size="small" @click="reloadSession()">重试</el-button>
    </el-alert>

    <template v-if="!authenticated">
      <candidate-name-login-card @logged-in="handleLoggedIn" />
      <p class="entry__foot zj-muted">
        管理员请使用管理员姓名进入，登录后自动进入管理端。
      </p>
    </template>

    <template v-else>
      <el-card shadow="never" class="entry__card">
        <template #header>
          <div class="entry__identity">
            <span>当前身份：<strong>{{ session?.name }}</strong></span>
            <div class="entry__identity-actions">
              <el-tag size="small" effect="plain">{{ session?.role === 'admin' ? '管理员' : '考生' }}</el-tag>
              <el-button text size="small" @click="handleLogout">切换姓名</el-button>
            </div>
          </div>
        </template>

        <div v-if="session?.role === 'admin'" class="entry__panel">
          <p class="entry__panel-text">管理员账号用于管理场次、出题与成绩汇总。</p>
          <div class="entry__actions">
            <NuxtLink to="/admin">
              <el-button type="primary" size="large">进入管理端</el-button>
            </NuxtLink>
            <NuxtLink to="/my-attempts">
              <el-button size="large">我的记录</el-button>
            </NuxtLink>
          </div>
          <p class="entry__hint zj-muted">
            如要以考生身份参加考试，请换用另一个姓名登录（管理端不提供以管理身份作答的入口）。
          </p>
        </div>
      </el-card>

      <el-card v-if="session?.role !== 'admin'" shadow="never" class="entry__card">
        <template #header>
          <div class="entry__list-head">
            <span class="entry__list-title">可参加的考试</span>
            <div class="entry__identity-actions">
              <NuxtLink to="/my-attempts">
                <el-button text size="small">我的记录</el-button>
              </NuxtLink>
              <el-button text size="small" :loading="availablePending" @click="reloadAvailable()">刷新</el-button>
            </div>
          </div>
        </template>

        <el-alert
          v-if="startError"
          type="error"
          :closable="false"
          show-icon
          :title="startError"
          class="entry__inline-alert"
        />

        <StatePanel
          v-if="availableError"
          state="error"
          title="无法获取考试列表"
          :description="availableErrorText"
          @retry="reloadAvailable()"
        />

        <StatePanel
          v-else-if="availablePending && !available"
          state="loading"
          title="正在获取考试列表…"
          :loading-rows="3"
        />

        <StatePanel
          v-else-if="exams.length === 0"
          state="empty"
          title="暂无进行中的考试"
          description="管理员发布场次后会出现在这里；已暂停或已结束的场次不再显示。"
        >
          <template #default>
            <NuxtLink to="/my-attempts">
              <el-button size="large">查看我的记录</el-button>
            </NuxtLink>
          </template>
        </StatePanel>

        <ul v-else class="entry__exams">
          <li
            v-for="item in exams"
            :key="item.id"
            class="entry__exam"
            :class="{ 'is-upcoming': item.phase === 'upcoming' }"
          >
            <div class="entry__exam-main">
              <div class="entry__exam-head">
                <h2 class="entry__exam-title">{{ item.title || '未命名考试' }}</h2>
                <div class="entry__exam-tags">
                  <el-tag :type="phaseTagType(item.phase)" effect="plain" size="small">
                    {{ phaseText(item.phase) }}
                  </el-tag>
                  <el-tag
                    v-if="item.myAttempt"
                    :type="item.myAttempt.status === 'submitted' ? 'info' : 'warning'"
                    effect="plain"
                    size="small"
                  >
                    {{ attemptText(item.myAttempt.status) }}
                  </el-tag>
                </div>
              </div>
              <p class="entry__exam-meta zj-muted">
                {{ windowText(item) }}（{{ item.timeZone }}）· 共 {{ item.questionCount }} 题
              </p>
              <p v-if="item.phase === 'upcoming'" class="entry__exam-hint zj-muted">
                {{ upcomingHint(item) }}
              </p>
            </div>

            <div class="entry__exam-actions">
              <NuxtLink
                v-if="item.myAttempt?.status === 'submitted'"
                :to="`/attempts/${item.myAttempt?.id}/result`"
              >
                <el-button type="primary">已交卷 · 查看成绩</el-button>
              </NuxtLink>
              <NuxtLink
                v-else-if="item.myAttempt?.status === 'in_progress'"
                :to="`/exams/${item.id}/attempt`"
              >
                <el-button type="primary">继续作答</el-button>
              </NuxtLink>
              <el-button
                v-else-if="item.phase === 'open'"
                type="primary"
                :loading="startingId === item.id"
                :disabled="Boolean(startingId) && startingId !== item.id"
                @click="enterExam(item)"
              >
                进入考试
              </el-button>
              <el-button v-else disabled>进入考试</el-button>
            </div>
          </li>
        </ul>
      </el-card>
    </template>
  </section>
</template>

<style scoped>
.entry {
  max-width: 760px;
  margin: 0 auto;
}

.entry__head {
  text-align: center;
  margin-bottom: 24px;
}

.entry__title {
  margin: 0;
  font-size: clamp(28px, 5vw, 36px);
  letter-spacing: 0.08em;
  color: var(--zj-primary);
}

.entry__subtitle {
  margin: 6px 0 0;
  font-size: 15px;
}

.entry__card {
  margin-bottom: 16px;
}

.entry__alert {
  margin-bottom: 16px;
}

.entry__alert-body {
  margin: 6px 0 10px;
  font-size: 15px;
}

.entry__identity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 16px;
}

.entry__identity-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.entry__list-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.entry__list-title {
  font-size: 16px;
  font-weight: 600;
}

.entry__exams {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.entry__exam {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid var(--zj-border);
  border-radius: 8px;
}

.entry__exam.is-upcoming {
  background: var(--el-fill-color-lighter);
}

.entry__exam-main {
  flex: 1 1 300px;
  min-width: 0;
}

.entry__exam-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.entry__exam-title {
  margin: 0;
  font-size: 17px;
}

.entry__exam-tags {
  display: flex;
  align-items: center;
  gap: 6px;
}

.entry__exam-meta {
  margin: 6px 0 0;
  font-size: 14px;
}

.entry__exam-hint {
  margin: 4px 0 0;
  font-size: 14px;
}

.entry__exam-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.entry__panel-title {
  margin: 0 0 8px;
  font-size: 20px;
}

.entry__panel-meta {
  margin: 0 0 10px;
  font-size: 15px;
}

.entry__panel-text {
  margin: 0 0 14px;
  font-size: 16px;
}

.entry__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.entry__hint {
  font-size: 14px;
}

.entry__inline-alert {
  margin-bottom: 12px;
}

.entry__foot {
  margin-top: 18px;
  text-align: center;
  font-size: 14px;
}
</style>
