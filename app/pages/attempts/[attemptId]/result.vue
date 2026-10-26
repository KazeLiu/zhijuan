<script setup lang="ts">
/**
 * 结果页（设计 §7.2、契约 §9.1/§10.4）：
 * - 立即展示总分、用时、是否及格、本人答案
 * - canReveal=true 才展示逐题标准答案与解析；否则显示公开时刻并在到时自动重新请求
 */
import type { AttemptDetailDTO, AttemptResultDTO, CandidateQuestion } from '#shared/types'
import { PASS_SCORE_UNITS } from '#shared/constants'

useHead({ title: '知卷 · 成绩' })

const route = useRoute()
const attemptId = computed(() => String(route.params.attemptId ?? ''))

const result = ref<AttemptResultDTO | null>(null)
const detailQuestions = ref<CandidateQuestion[]>([])
const loading = ref(true)
const loadError = ref('')
const notSubmitted = ref(false)
const refreshing = ref(false)
const detailWarning = ref('')

const examTimeZone = ref(browserTimeZone())
const revealText = computed(() => {
  if (!result.value) return ''
  return formatDateTimeSeconds(result.value.revealAt, examTimeZone.value)
})

const questionsForAnswers = computed<CandidateQuestion[]>(() => {
  if (result.value?.questions) {
    return result.value.questions.map((question) => ({
      id: question.id,
      position: question.position,
      type: question.type,
      stem: question.stem,
      maxScoreUnits: question.maxScoreUnits,
      multiple: question.type === 'multiple_choice',
      options: question.options,
      blanks: question.blanks,
      caseSensitive: false,
    }))
  }
  return detailQuestions.value
})

async function load(options: { silent?: boolean } = {}): Promise<void> {
  if (!options.silent) {
    loading.value = true
    loadError.value = ''
    notSubmitted.value = false
  } else {
    refreshing.value = true
  }
  try {
    const data = await apiFetch<AttemptResultDTO>(`/api/attempts/${attemptId.value}/result`, { silent: true })
    result.value = data
    detailQuestions.value = []
    detailWarning.value = ''

    // 结果 DTO 不含 exam.timeZone，用答卷详情补时区（格式化公开时刻要用考试时区）
    try {
      const detail = await apiFetch<AttemptDetailDTO>(`/api/attempts/${attemptId.value}`, { silent: true })
      examTimeZone.value = detail.exam.timeZone
      if (!data.canReveal) detailQuestions.value = detail.questions
    } catch {
      if (!data.canReveal) {
        detailWarning.value = '暂时无法展示题目原文，你的作答已保存在服务器。'
      }
    }
    scheduleRevealRefresh()
  } catch (error) {
    const apiError = error instanceof ApiClientError ? error : null
    if (apiError?.code === 'ATTEMPT_NOT_SUBMITTED') {
      notSubmitted.value = true
      loadError.value = apiError.message || '这份答卷还没有交卷'
      return
    }
    loadError.value = describeApiError(error, '无法获取成绩，请稍后重试')
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

let revealTimer: ReturnType<typeof setTimeout> | null = null

function clearRevealTimer(): void {
  if (revealTimer) {
    clearTimeout(revealTimer)
    revealTimer = null
  }
}

/** 公开时刻到了就自动重新请求（契约 §10.4） */
function scheduleRevealRefresh(): void {
  clearRevealTimer()
  const data = result.value
  if (!data || data.canReveal) return
  const delay = data.revealAt - Date.now()
  if (delay <= 0) {
    void load({ silent: true })
    return
  }
  // setTimeout 上限约 24.8 天，超过则先按上限等待
  revealTimer = setTimeout(() => {
    void load({ silent: true })
  }, Math.min(delay + 1000, 2_147_000_000))
}

function handleVisibility(): void {
  if (typeof document === 'undefined') return
  if (document.visibilityState !== 'visible') return
  const data = result.value
  if (!data) return
  if (!data.canReveal && Date.now() >= data.revealAt) void load({ silent: true })
}

async function backToAttempt(): Promise<void> {
  const data = result.value
  if (!data) {
    await navigateTo('/my-attempts')
    return
  }
  await navigateTo(`/exams/${data.examId}/attempt`)
}

function scoreTagType(): 'success' | 'danger' {
  return result.value?.passed ? 'success' : 'danger'
}

onMounted(async () => {
  await load()
  document.addEventListener('visibilitychange', handleVisibility)
})

onBeforeUnmount(() => {
  clearRevealTimer()
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibility)
})
</script>

<template>
  <section class="result">
    <PageHeader title="考试成绩" description="交卷后立即判分；答案与解析按本场公开策略展示。" back-to="/my-attempts" back-text="我的记录">
      <template #actions>
        <el-button :loading="refreshing" @click="load({ silent: true })">刷新</el-button>
        <NuxtLink to="/">
          <el-button>返回入口</el-button>
        </NuxtLink>
      </template>
    </PageHeader>

    <StatePanel v-if="loading" state="loading" title="正在获取成绩…" :loading-rows="4" />

    <StatePanel
      v-else-if="loadError"
      :state="notSubmitted ? 'empty' : 'error'"
      :title="notSubmitted ? '这份答卷还未交卷' : '无法获取成绩'"
      :description="loadError"
      retry-text="重新获取"
      :action-text="notSubmitted ? '回到作答页' : '返回我的记录'"
      :action-to="notSubmitted ? undefined : '/my-attempts'"
      @retry="load()"
      @action="backToAttempt"
    />

    <template v-else-if="result">
      <div class="result__hero">
        <div class="result__score">
          <span class="result__score-value zj-tabular">{{ formatScoreUnits(result.totalScoreUnits) }}</span>
          <span class="result__score-unit zj-muted">/ {{ formatScoreUnits(result.maxScoreUnits) }} 分</span>
        </div>
        <div class="result__facts">
          <div class="result__fact">
            <span class="zj-muted">是否及格</span>
            <el-tag :type="scoreTagType()" effect="dark">{{ result.passed ? '及格' : '未及格' }}</el-tag>
            <span class="zj-muted result__fact-hint">及格线 {{ formatScoreUnits(PASS_SCORE_UNITS) }} 分</span>
          </div>
          <div class="result__fact">
            <span class="zj-muted">用时</span>
            <strong>{{ formatDuration(result.durationMs) }}</strong>
            <span class="zj-muted result__fact-hint">
              {{ formatDateTimeSeconds(result.startedAt, examTimeZone) }} —
              {{ formatDateTimeSeconds(result.submittedAt, examTimeZone) }}
            </span>
          </div>
          <div class="result__fact">
            <span class="zj-muted">交卷方式</span>
            <strong>{{ result.submitReason === 'deadline' ? '截止自动交卷' : '本人交卷' }}</strong>
          </div>
        </div>
      </div>

      <el-alert
        v-if="!result.canReveal"
        type="info"
        :closable="false"
        show-icon
        class="result__reveal"
        :title="`答案与解析将在 ${revealText}（${examTimeZone}）公开`"
      >
        <template #default>
          <p class="result__reveal-body">
            本场采用「考试结束后公开」策略。到达公开时刻后本页会自动刷新；也可以手动点「刷新」。
          </p>
          <p class="result__reveal-body zj-muted">
            {{ refreshing ? '正在刷新…' : '总分、用时与你的作答现在就可以查看。' }}
          </p>
        </template>
      </el-alert>

      <el-alert
        v-if="detailWarning"
        type="warning"
        :closable="false"
        show-icon
        :title="detailWarning"
        class="result__reveal"
      />

      <!-- 逐题 -->
      <el-card v-if="result.questions" shadow="never" class="result__card">
        <template #header>
          <div class="result__card-head">
            <span>逐题详情</span>
            <span class="zj-muted result__card-hint">共 {{ result.questions.length }} 题</span>
          </div>
        </template>

        <article v-for="question in result.questions" :key="question.id" class="rq">
          <header class="rq__head">
            <span class="rq__position">第 {{ question.position }} 题</span>
            <el-tag size="small" effect="plain">{{ QUESTION_TYPE_LABELS[question.type] }}</el-tag>
            <el-tag v-if="question.manualReviewed" size="small" type="warning" effect="plain">人工复核</el-tag>
            <span class="rq__score zj-tabular">
              {{ formatScoreUnits(question.earnedScoreUnits) }} / {{ formatScoreUnits(question.maxScoreUnits) }} 分
            </span>
          </header>

          <p class="rq__stem">{{ question.stem }}</p>

          <dl class="rq__rows">
            <div class="rq__row">
              <dt>我的答案</dt>
              <dd :class="{ 'rq__unanswered': question.unanswered }">
                {{ question.unanswered ? '未作答' : describeAnswer(question, question.userAnswer) }}
              </dd>
            </div>
            <div class="rq__row">
              <dt>正确答案</dt>
              <dd>{{ describeCorrectAnswer(question.type, question.options, question.correctAnswer.optionIds, question.correctAnswer.blanks) }}</dd>
            </div>
            <div v-if="question.manualReviewed" class="rq__row">
              <dt>自动判分</dt>
              <dd>{{ formatScoreUnits(question.autoScoreUnits) }} 分（已人工改为 {{ formatScoreUnits(question.earnedScoreUnits) }} 分）</dd>
            </div>
            <div v-if="question.explanation" class="rq__row">
              <dt>解析</dt>
              <dd class="rq__explanation">{{ question.explanation }}</dd>
            </div>
            <div v-if="question.sourceRefs.length > 0" class="rq__row">
              <dt>资料引用</dt>
              <dd>
                <ul class="rq__refs">
                  <li v-for="(ref, index) in question.sourceRefs" :key="`${ref.documentId}-${index}`">
                    <span class="zj-muted">{{ ref.locator }}</span> {{ ref.quote }}
                  </li>
                </ul>
              </dd>
            </div>
          </dl>
        </article>
      </el-card>

      <!-- 未公开：只展示本人答案 -->
      <el-card v-else shadow="never" class="result__card">
        <template #header>
          <div class="result__card-head">
            <span>我的作答</span>
            <span class="zj-muted result__card-hint">标准答案与逐题得分在公开后可见</span>
          </div>
        </template>

        <p v-if="questionsForAnswers.length === 0" class="zj-muted result__hint">
          逐题内容暂不可用，你的答案已记录在服务器，公开后可在本页查看。
        </p>

        <el-table v-else :data="questionsForAnswers" row-key="id" size="default">
          <el-table-column label="题号" width="80">
            <template #default="{ row }">第 {{ row.position }} 题</template>
          </el-table-column>
          <el-table-column label="题型" width="100">
            <template #default="{ row }">{{ QUESTION_TYPE_LABELS[row.type as keyof typeof QUESTION_TYPE_LABELS] }}</template>
          </el-table-column>
          <el-table-column label="题干" min-width="240">
            <template #default="{ row }">
              <span class="result__stem-cell">{{ row.stem }}</span>
            </template>
          </el-table-column>
          <el-table-column label="我的答案" min-width="220">
            <template #default="{ row }">
              {{ describeAnswer(row as CandidateQuestion, result?.answers?.[row.id] ?? null) }}
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>
  </section>
</template>

<style scoped>
.result {
  max-width: 960px;
  margin: 0 auto;
}

.result__hero {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: clamp(16px, 4vw, 40px);
  padding: clamp(18px, 3vw, 28px);
  background: #fff;
  border: 1px solid var(--zj-border);
  border-radius: var(--zj-radius);
  margin-bottom: 16px;
}

.result__score {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.result__score-value {
  font-size: clamp(40px, 8vw, 56px);
  font-weight: 700;
  color: var(--zj-primary);
  line-height: 1;
}

.result__score-unit {
  font-size: 15px;
}

.result__facts {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 32px;
}

.result__fact {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
}

.result__fact-hint {
  font-size: 13px;
}

.result__reveal {
  margin-bottom: 16px;
}

.result__reveal-body {
  margin: 6px 0 0;
  font-size: 15px;
}

.result__card {
  margin-bottom: 16px;
}

.result__card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-weight: 600;
}

.result__card-hint {
  font-size: 14px;
  font-weight: 400;
}

.result__hint {
  margin: 0;
  font-size: 15px;
}

.result__stem-cell {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.rq {
  padding: 16px 0;
  border-bottom: 1px solid var(--zj-border);
}

.rq:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.rq:first-of-type {
  padding-top: 0;
}

.rq__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 14px;
}

.rq__position {
  font-weight: 600;
}

.rq__score {
  margin-left: auto;
  font-weight: 600;
}

.rq__stem {
  margin: 10px 0 12px;
  font-size: 17px;
  font-weight: 600;
  white-space: pre-wrap;
}

.rq__rows {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rq__row {
  display: flex;
  gap: 12px;
  font-size: 15px;
}

.rq__row dt {
  flex: 0 0 84px;
  color: var(--zj-text-muted);
}

.rq__row dd {
  margin: 0;
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

.rq__unanswered {
  color: var(--zj-text-muted);
}

.rq__explanation {
  white-space: pre-wrap;
}

.rq__refs {
  margin: 0;
  padding-left: 18px;
}

@media (max-width: 640px) {
  .rq__row {
    flex-direction: column;
    gap: 2px;
  }

  .rq__row dt {
    flex: none;
    font-size: 13px;
  }
}
</style>
