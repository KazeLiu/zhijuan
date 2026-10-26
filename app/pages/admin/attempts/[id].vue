<script setup lang="ts">
import type { AttemptAdminDTO, GradeResult, QuestionAdminDTO } from '#shared/types'
import { QUESTION_TYPE_LABELS } from '#shared/types'
import { MAX_GRADE_REASON_CHARS, PASS_SCORE_UNITS, SCORE_TOTAL_UNITS } from '#shared/constants'
import { describeAnswer, describeCorrectAnswer, isAnswerEmpty } from '~/utils/answer'
import { isPassed } from '~/utils/exam'
import { browserTimeZone, formatDateTime, formatDuration, formatScoreUnits } from '~/utils/format'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const attemptId = computed(() => String(route.params.id ?? ''))

const attempt = ref<AttemptAdminDTO | null>(null)
const loading = ref(true)
const loadError = ref('')
const forbidden = ref(false)

const SCORE_PATTERN = /^\d+(\.\d{1,2})?$/

async function load() {
  if (!attemptId.value) return
  loading.value = true
  loadError.value = ''
  forbidden.value = false
  try {
    attempt.value = await apiFetch<AttemptAdminDTO>(`/api/admin/attempts/${attemptId.value}`)
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 403) {
      forbidden.value = true
    } else {
      attempt.value = null
      loadError.value = describeApiError(error, '无法加载答卷详情')
    }
  } finally {
    loading.value = false
  }
}

onMounted(load)

const examTimeZone = computed(() => attempt.value?.exam.timeZone ?? browserTimeZone())

const submitReasonLabel = computed(() => {
  if (!attempt.value) return ''
  return attempt.value.submitReason === 'deadline' ? '截止自动交卷' : '本人交卷'
})

const questions = computed<QuestionAdminDTO[]>(() => {
  const list = attempt.value?.questions ?? []
  return [...list].sort((left, right) => left.position - right.position)
})

const gradeMap = computed(() => {
  const map = new Map<string, AttemptAdminDTO['grades'][number]>()
  for (const grade of attempt.value?.grades ?? []) map.set(grade.questionId, grade)
  return map
})

const answeredCount = computed(() => {
  const data = attempt.value
  if (!data) return 0
  return (data.grades ?? []).filter((grade) => !isAnswerEmpty(grade.userAnswer)).length
})

const isSubmitted = computed(() => attempt.value?.status === 'submitted')

/* ---------------- 改分弹窗 ---------------- */

const gradeDialogVisible = ref(false)
const gradeTarget = ref<QuestionAdminDTO | null>(null)
const gradeScore = ref('')
const gradeReason = ref('')
const gradeError = ref('')
const gradeSubmitting = ref(false)

function openGrade(question: QuestionAdminDTO) {
  const grade = gradeMap.value.get(question.id)
  gradeTarget.value = question
  gradeScore.value = formatScoreUnits(grade?.finalScoreUnits ?? grade?.autoScoreUnits ?? 0)
  gradeReason.value = ''
  gradeError.value = ''
  gradeDialogVisible.value = true
}

const gradeMaxScore = computed(() => {
  const question = gradeTarget.value
  if (!question) return '0.00'
  return (question.maxScoreUnits / 100).toFixed(2)
})

const gradeAutoScore = computed(() => {
  const question = gradeTarget.value
  if (!question) return '—'
  const grade = gradeMap.value.get(question.id)
  return formatScoreUnits(grade?.autoScoreUnits ?? 0)
})

const gradeCurrentScore = computed(() => {
  const question = gradeTarget.value
  if (!question) return '—'
  const grade = gradeMap.value.get(question.id)
  return formatScoreUnits(grade?.finalScoreUnits ?? grade?.autoScoreUnits ?? 0)
})

function validateGrade(): string {
  const question = gradeTarget.value
  if (!question) return '未选择题'
  const score = gradeScore.value.trim()
  if (!score) return '请填写分数'
  if (!SCORE_PATTERN.test(score)) return '分数最多两位小数，且不能为负数'
  const units = Math.round(Number(score) * 100)
  if (units > question.maxScoreUnits) return `分数不能超过本题满分 ${gradeMaxScore.value}`
  return ''
}

async function submitGrade() {
  const question = gradeTarget.value
  const data = attempt.value
  if (!question || !data) return
  gradeError.value = validateGrade()
  if (gradeError.value) return
  const reason = gradeReason.value.trim()
  if (!reason) {
    gradeError.value = '请填写改分原因'
    return
  }
  if (reason.length > MAX_GRADE_REASON_CHARS) {
    gradeError.value = `改分原因最多 ${MAX_GRADE_REASON_CHARS} 字`
    return
  }

  gradeSubmitting.value = true
  try {
    const result = await apiFetch<GradeResult>(
      `/api/admin/attempts/${data.attemptId}/answers/${question.id}/grade`,
      {
        method: 'PATCH',
        body: {
          expectedVersion: data.version,
          score: gradeScore.value.trim(),
          reason,
        },
      },
    )

    const index = data.grades.findIndex((grade) => grade.questionId === question.id)
    if (index >= 0) {
      data.grades[index] = result.answer
    } else {
      data.grades.push(result.answer)
    }
    data.version = result.attempt.version
    data.totalScoreUnits = result.attempt.totalScoreUnits
    data.gradeChanges = [result.change, ...(data.gradeChanges ?? [])]
    gradeDialogVisible.value = false
    ElMessage.success('改分已保存')
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'VERSION_CONFLICT') {
      gradeError.value = '答卷已被其他操作更新，正在刷新最新数据，请重新操作'
      gradeDialogVisible.value = false
      await load()
      return
    }
    gradeError.value = describeApiError(error, '改分失败')
  } finally {
    gradeSubmitting.value = false
  }
}
</script>

<template>
  <div class="zj-attempt-admin">
    <PageHeader
      :title="attempt ? `${attempt.name} 的答卷` : '答卷详情'"
      :description="attempt ? `${attempt.exam.title} · ${formatScoreUnits(attempt.totalScoreUnits)} / ${(SCORE_TOTAL_UNITS / 100).toFixed(2)} 分` : '逐题查看作答并人工改分'"
      :back-to="attempt ? `/admin/exams/${attempt.examId}/results` : '/admin/exams'"
      back-text="返回成绩汇总"
    />

    <StatePanel v-if="loading" state="loading" :loading-rows="6" />
    <StatePanel
      v-else-if="forbidden"
      state="forbidden"
      title="需要管理员权限"
      description="当前登录身份无法访问答卷详情，请用管理员姓名重新登录。"
      action-text="重新登录"
      action-to="/"
      @action="navigateTo('/')"
    />
    <StatePanel
      v-else-if="loadError"
      state="error"
      title="加载失败"
      :description="loadError"
      retry-text="重新加载"
      @retry="load()"
    />
    <StatePanel
      v-else-if="!attempt"
      state="empty"
      title="没有这份答卷"
      description="答卷可能已被删除，请返回成绩汇总查看。"
      action-text="返回成绩汇总"
      action-to="/admin/exams"
    />

    <template v-else>
      <el-alert
        v-if="!isSubmitted"
        type="warning"
        :closable="false"
        show-icon
        title="该答卷尚未交卷"
        description="未交卷答卷不产生分数，也不能人工改分；请等待考生交卷或截止自动交卷后再处理。"
        class="zj-attempt-admin__alert"
      />

      <div class="zj-attempt-admin__summary">
        <el-descriptions :column="3" border>
          <el-descriptions-item label="考生姓名">{{ attempt.name }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="isSubmitted ? 'success' : 'warning'" size="small">
              {{ isSubmitted ? '已交卷' : '进行中' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="总分">
            <span class="zj-tabular">{{ formatScoreUnits(attempt.totalScoreUnits) }}</span>
            <el-tag v-if="isPassed(attempt.totalScoreUnits)" type="success" size="small" class="zj-attempt-admin__pass">及格</el-tag>
            <el-tag v-else type="info" size="small" class="zj-attempt-admin__pass">未及格</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="开始时间">
            {{ formatDateTime(attempt.startedAt, examTimeZone) }}
          </el-descriptions-item>
          <el-descriptions-item label="交卷时间">
            {{ attempt.submittedAt ? formatDateTime(attempt.submittedAt, examTimeZone) : '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="用时">
            <span class="zj-tabular">
              {{ attempt.submittedAt ? formatDuration(attempt.submittedAt - attempt.startedAt) : '进行中' }}
            </span>
          </el-descriptions-item>
          <el-descriptions-item label="交卷方式">{{ isSubmitted ? submitReasonLabel : '—' }}</el-descriptions-item>
          <el-descriptions-item label="作答题数">
            <span class="zj-tabular">{{ answeredCount }} / {{ questions.length }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="及格线">
            <span class="zj-tabular">≥ {{ (PASS_SCORE_UNITS / 100).toFixed(2) }}</span>
          </el-descriptions-item>
        </el-descriptions>
        <p class="zj-muted zj-attempt-admin__tz">时间按考试时区 {{ examTimeZone }} 展示。</p>
      </div>

      <el-card shadow="never" class="zj-attempt-admin__card">
        <template #header>
          <div class="zj-attempt-admin__card-header">
            <span>逐题作答与改分</span>
            <span class="zj-muted">每题自动分由系统判定，人工改分以最终分为准</span>
          </div>
        </template>

        <StatePanel
          v-if="questions.length === 0"
          state="empty"
          title="这份答卷没有题目"
          description="场次题目可能已被清空，无法改分。"
        />

        <div v-else class="zj-attempt-admin__questions">
          <article v-for="question in questions" :key="question.id" class="zj-attempt-admin__question">
            <header class="zj-attempt-admin__question-head">
              <div class="zj-attempt-admin__question-meta">
                <span class="zj-attempt-admin__position">第 {{ question.position }} 题</span>
                <el-tag size="small" type="info">{{ QUESTION_TYPE_LABELS[question.type] }}</el-tag>
                <span class="zj-muted">满分 <span class="zj-tabular">{{ formatScoreUnits(question.maxScoreUnits) }}</span></span>
                <el-tag v-if="gradeMap.get(question.id)?.manualReviewed" size="small" type="warning">已人工复核</el-tag>
              </div>
              <el-button
                size="small"
                :disabled="!isSubmitted"
                @click="openGrade(question)"
              >
                改分
              </el-button>
            </header>

            <p class="zj-attempt-admin__stem">{{ question.stem }}</p>

            <dl class="zj-attempt-admin__answers">
              <div>
                <dt>考生答案</dt>
                <dd>{{ describeAnswer(question, attempt.answers[question.id] ?? null) }}</dd>
              </div>
              <div>
                <dt>正确答案</dt>
                <dd>
                  {{
                    describeCorrectAnswer(
                      question.type,
                      question.options,
                      question.answerDefinition.correctOptionIds,
                      question.answerDefinition.blanks,
                    )
                  }}
                </dd>
              </div>
              <div>
                <dt>得分</dt>
                <dd>
                  最终 <span class="zj-tabular">{{ formatScoreUnits(gradeMap.get(question.id)?.finalScoreUnits ?? 0) }}</span>
                  <span class="zj-muted">
                    （自动 <span class="zj-tabular">{{ formatScoreUnits(gradeMap.get(question.id)?.autoScoreUnits ?? 0) }}</span>
                    <template v-if="gradeMap.get(question.id)?.overrideScoreUnits != null">
                      ，人工 <span class="zj-tabular">{{ formatScoreUnits(gradeMap.get(question.id)?.overrideScoreUnits ?? 0) }}</span>
                    </template>）
                  </span>
                </dd>
              </div>
              <div v-if="question.explanation">
                <dt>解析</dt>
                <dd class="zj-muted">{{ question.explanation }}</dd>
              </div>
            </dl>
          </article>
        </div>
      </el-card>

      <el-card shadow="never" class="zj-attempt-admin__card">
        <template #header>
          <div class="zj-attempt-admin__card-header">
            <span>改分记录</span>
            <span class="zj-muted">共 {{ attempt.gradeChanges?.length ?? 0 }} 条</span>
          </div>
        </template>

        <StatePanel
          v-if="!attempt.gradeChanges || attempt.gradeChanges.length === 0"
          state="empty"
          title="暂无改分记录"
          description="该答卷的所有得分均来自系统自动判定。"
        />

        <el-table v-else :data="attempt.gradeChanges" size="small" style="width: 100%">
          <el-table-column label="题号" width="80">
            <template #default="{ row }">
              第 {{ questions.find((item) => item.id === row.questionId)?.position ?? '—' }} 题
            </template>
          </el-table-column>
          <el-table-column label="分数线" width="140">
            <template #default="{ row }">
              <span class="zj-tabular">{{ formatScoreUnits(row.previousScoreUnits) }} → {{ formatScoreUnits(row.newScoreUnits) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="原因" min-width="200" prop="reason" />
          <el-table-column label="操作人" width="120" prop="adminName" />
          <el-table-column label="时间" width="180">
            <template #default="{ row }">
              <span class="zj-tabular">{{ formatDateTime(row.createdAt, examTimeZone) }}</span>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <el-dialog v-model="gradeDialogVisible" title="人工改分" width="min(520px, 92vw)" :close-on-click-modal="!gradeSubmitting">
      <el-form label-position="top" @submit.prevent="submitGrade">
        <el-form-item label="题目">
          <div class="zj-attempt-admin__grade-stem">
            第 {{ gradeTarget?.position }} 题 · {{ gradeTarget ? QUESTION_TYPE_LABELS[gradeTarget.type] : '' }}
            <p>{{ gradeTarget?.stem }}</p>
          </div>
        </el-form-item>
        <el-form-item label="分数（满分 {{ gradeMaxScore }}）" required>
          <el-input v-model="gradeScore" placeholder="例如 3.50" inputmode="decimal" />
          <p class="zj-muted zj-attempt-admin__hint">
            自动分 <span class="zj-tabular">{{ gradeAutoScore }}</span> ·
            当前最终分 <span class="zj-tabular">{{ gradeCurrentScore }}</span>
          </p>
        </el-form-item>
        <el-form-item label="改分原因（必填）" required>
          <el-input
            v-model="gradeReason"
            type="textarea"
            :rows="3"
            :maxlength="MAX_GRADE_REASON_CHARS"
            show-word-limit
            placeholder="说明本次改分依据，例如：填空同义答案被误判"
          />
        </el-form-item>
        <el-alert v-if="gradeError" type="error" :closable="false" :title="gradeError" show-icon />
      </el-form>
      <template #footer>
        <el-button :disabled="gradeSubmitting" @click="gradeDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="gradeSubmitting" @click="submitGrade">保存改分</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.zj-attempt-admin {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.zj-attempt-admin__alert {
  margin-bottom: 4px;
}

.zj-attempt-admin__pass {
  margin-left: 8px;
}

.zj-attempt-admin__tz {
  margin: 8px 0 0;
  font-size: 14px;
}

.zj-attempt-admin__card-header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-weight: 600;
}

.zj-attempt-admin__questions {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.zj-attempt-admin__question {
  border: 1px solid var(--zj-border);
  border-radius: var(--zj-radius);
  padding: 16px;
  background: #fff;
}

.zj-attempt-admin__question-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.zj-attempt-admin__question-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 15px;
}

.zj-attempt-admin__position {
  font-weight: 600;
}

.zj-attempt-admin__stem {
  margin: 12px 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.zj-attempt-admin__answers {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
}

.zj-attempt-admin__answers dt {
  font-weight: 600;
  color: var(--zj-text-muted);
  font-size: 14px;
}

.zj-attempt-admin__answers dd {
  margin: 2px 0 0;
  word-break: break-word;
}

.zj-attempt-admin__grade-stem p {
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.zj-attempt-admin__hint {
  margin: 6px 0 0;
  font-size: 14px;
}
</style>
