<script setup lang="ts">
/**
 * 入口页（设计 §6.1、契约 §9.1）：
 * 未登录 → 姓名登录卡片；考生登录后展示考试安排，点击后才开始答题。
 */
import type { AttemptStartResult, CurrentExamDTO, LoginResultDTO, SessionDTO } from '#shared/types'

useHead({ title: '知卷 · 姓名进入' })

const { session, logout } = useAuthSession()
const starting = ref(false)
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

const {
  data: current,
  error: currentError,
  pending: currentPending,
  refresh: reloadCurrent,
} = await useAsyncData<CurrentExamDTO>(
  'zj-current-exam',
  () => apiFetch<CurrentExamDTO>('/api/exams/current', { silent: true }),
  { server: true, immediate: authenticated.value && session.value?.role === 'candidate' },
)

const currentErrorText = computed(() => (currentError.value ? describeApiError(currentError.value, '无法获取考试信息') : ''))

const nextExamText = computed(() => {
  const next = current.value?.nextExam
  if (!next) return ''
  return `${formatDateTime(next.startsAt, next.timeZone)} — ${formatDateTime(next.endsAt, next.timeZone)}`
})

const closedExamText = computed(() => {
  const exam = current.value?.exam
  if (!exam) return ''
  return `${exam.title}（已于 ${formatDateTime(exam.endsAt, exam.timeZone)} 结束）`
})

const myAttempt = computed(() => current.value?.myAttempt ?? null)

/** 登录/切换身份后重新取会话与场次，避免旧缓存 */
async function reloadAll(): Promise<void> {
  clearNuxtData()
  await reloadSession()
  session.value = sessionData.value ?? null
  if (session.value?.role === 'candidate') await reloadCurrent()
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
  await reloadCurrent()
}

async function handleLogout(): Promise<void> {
  await logout()
  await reloadAll()
}

/** 点击开始后才创建答卷并计时。 */
async function startAttempt(): Promise<void> {
  const exam = current.value?.exam
  if (!exam || starting.value) return
  starting.value = true
  startError.value = ''
  try {
    // 契约 §8.3：POST /api/attempts/start 无请求体
    const started = await apiFetch<AttemptStartResult>('/api/attempts/start', {
      method: 'POST',
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
    starting.value = false
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
        <StatePanel
          v-if="currentError"
          state="error"
          title="无法获取考试信息"
          :description="currentErrorText"
          @retry="reloadCurrent()"
        />

        <StatePanel v-else-if="currentPending || !current" state="loading" title="正在获取考试安排…" :loading-rows="3" />

        <div v-else class="entry__panel">
          <!-- 开放中 -->
          <template v-if="current?.phase === 'open' && current.exam">
            <h2 class="entry__panel-title">{{ current.exam.title }}</h2>
            <p class="entry__panel-meta zj-muted">
              {{ formatDateTime(current.exam.startsAt, current.exam.timeZone) }} —
              {{ formatDateTime(current.exam.endsAt, current.exam.timeZone) }}
              （{{ current.exam.timeZone }}）
            </p>
            <p class="entry__panel-text zj-muted">
              {{ current.exam.instructions || '点击“开始答题”后计时，交卷后立即出分。' }}
            </p>

            <el-alert
              v-if="startError"
              type="error"
              :closable="false"
              show-icon
              :title="startError"
              class="entry__inline-alert"
            />

            <div class="entry__actions">
              <template v-if="!myAttempt">
                <el-button type="primary" size="large" :loading="starting" @click="startAttempt">
                  开始答题
                </el-button>
              </template>
              <template v-else-if="myAttempt.status === 'in_progress'">
                <NuxtLink :to="`/exams/${current.exam.id}/attempt`">
                  <el-button type="primary" size="large">继续答题</el-button>
                </NuxtLink>
                <span class="entry__hint zj-muted">
                  已于 {{ formatDateTimeSeconds(myAttempt.startedAt, current.exam.timeZone) }} 开始计时
                </span>
              </template>
              <template v-else>
                <NuxtLink :to="`/attempts/${myAttempt.attemptId}/result`">
                  <el-button type="primary" size="large">查看成绩</el-button>
                </NuxtLink>
                <span class="entry__hint zj-muted">
                  已交卷 · 得分 {{ formatScoreUnits(myAttempt.totalScoreUnits) }} 分
                </span>
              </template>
              <NuxtLink to="/my-attempts">
                <el-button size="large">我的记录</el-button>
              </NuxtLink>
            </div>
          </template>

          <!-- 未开始 -->
          <template v-else-if="current?.phase === 'upcoming'">
            <h2 class="entry__panel-title">暂无进行中的考试</h2>
            <p v-if="current.nextExam" class="entry__panel-text">
              下一场：<strong>{{ current.nextExam.title }}</strong><br >
              <span class="zj-muted">{{ nextExamText }}（{{ current.nextExam.timeZone }}）</span>
            </p>
            <p v-else class="entry__panel-text zj-muted">暂时没有已安排的场次，请稍后再来。</p>
          </template>

          <!-- 已结束 -->
          <template v-else-if="current?.phase === 'closed'">
            <h2 class="entry__panel-title">本场考试已结束</h2>
            <p class="entry__panel-text zj-muted">{{ closedExamText }}</p>
            <div class="entry__actions">
              <NuxtLink to="/my-attempts">
                <el-button type="primary" size="large">查看我的记录</el-button>
              </NuxtLink>
            </div>
          </template>

          <!-- 无场次 -->
          <template v-else>
            <h2 class="entry__panel-title">暂无考试安排</h2>
            <p class="entry__panel-text zj-muted">管理员还没有发布可参加的场次，请稍后再来。</p>
            <div class="entry__actions">
              <NuxtLink to="/my-attempts">
                <el-button size="large">我的记录</el-button>
              </NuxtLink>
            </div>
          </template>
        </div>
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
