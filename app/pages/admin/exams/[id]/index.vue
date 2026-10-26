<script setup lang="ts">
/**
 * 场次详情（契约 §9.2 / §10.5）：基本信息 → 资料 → 题数与难度 → 出题 → 题目编辑 → 公开策略 → 发布。
 */
import type { ExamAdminDTO, SettingsDTO } from '#shared/types'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const examId = computed(() => String(route.params.id ?? ''))
const bankBusy = ref(false)
const edits = reactive({ basics: false, blueprint: false, questions: false, policy: false })
const hasUnsaved = computed(() => Object.values(edits).some(Boolean))
useHead({ title: '知卷 · 场次详情' })

const { data: exam, error, pending, refresh } = await useAsyncData<ExamAdminDTO>(
  'zj-admin-exam-detail',
  () => apiFetch<ExamAdminDTO>(`/api/admin/exams/${examId.value}`, { silent: true }),
  { server: false, watch: [examId] },
)

const { data: settings } = await useAsyncData<SettingsDTO | null>(
  'zj-admin-settings-for-exam',
  async () => {
    try {
      return await apiFetch<SettingsDTO>('/api/admin/settings', { silent: true })
    } catch {
      return null
    }
  },
  { server: false },
)

const forbidden = computed(() => error.value instanceof ApiClientError && error.value.code === 'FORBIDDEN')
const notFound = computed(() => error.value instanceof ApiClientError && error.value.code === 'NOT_FOUND')

const modelReady = computed(() => {
  const current = settings.value
  if (!current) return false
  // API Key 可选：内网无鉴权的模型端点只需 Base URL 与模型
  return Boolean(current.baseUrl) && Boolean(current.modelId)
})

const locked = computed(() => {
  const current = exam.value
  if (!current) return true
  return current.status === 'published' || current.attemptCount > 0
})

const jobActive = computed(() => {
  const job = exam.value?.activeJob
  return Boolean(job && isJobActive(job.status))
})

function reload(): void {
  void refresh()
}
</script>

<template>
  <section class="exam-detail">
    <PageHeader
      :title="exam?.title || '场次详情'"
      :description="exam ? `${EXAM_PHASE_LABELS[exam.phase]} · v${exam.version} · ${exam.questionCount} 题 · 答卷 ${exam.attemptCount} 份` : ''"
      back-to="/admin/exams"
      back-text="返回场次列表"
    >
      <template #actions>
        <NuxtLink v-if="exam" :to="`/admin/exams/${exam.id}/results`">
          <el-button type="primary">成绩汇总</el-button>
        </NuxtLink>
        <el-button :loading="pending" :disabled="bankBusy" @click="reload">刷新</el-button>
      </template>
    </PageHeader>

    <StatePanel
      v-if="error"
      :state="forbidden || notFound ? (forbidden ? 'forbidden' : 'error') : 'error'"
      :title="forbidden ? '需要管理员权限' : notFound ? '场次不存在' : '加载场次失败'"
      :description="forbidden ? '当前登录身份不是管理员，请用管理员姓名登录。' : describeApiError(error, '请稍后重试')"
      :action-to="forbidden ? '/' : '/admin/exams'"
      :action-text="forbidden ? '重新登录' : '返回列表'"
      @retry="reload"
    />

    <StatePanel v-else-if="pending && !exam" state="loading" title="正在加载场次…" :loading-rows="8" />

    <template v-else-if="exam">
      <div v-if="jobActive" class="exam-detail__banner">
        <el-alert type="info" :closable="false" show-icon title="出题任务进行中，可在下方「题数与难度」卡片查看实时进度。" />
      </div>

      <AdminBasicsCard :exam="exam" :locked="locked || jobActive || bankBusy" @changed="reload" @dirty-change="edits.basics = $event" />
      <AdminDocumentsCard :exam="exam" :locked="locked || jobActive || bankBusy" @changed="reload" />
      <AdminBlueprintCard :exam="exam" :model-ready="modelReady" :locked="locked || bankBusy" @changed="reload" @dirty-change="edits.blueprint = $event">
        <template #question-bank>
          <AdminBankApplyCard :exam="exam" :locked="locked || jobActive || pending" :unsaved="hasUnsaved" @applied="exam = $event" @busy-change="bankBusy = $event" />
        </template>
      </AdminBlueprintCard>
      <AdminQuestionsCard :exam="exam" :locked="locked || jobActive || bankBusy" :external-busy="bankBusy || pending" @changed="reload" @dirty-change="edits.questions = $event" @bank-busy-change="bankBusy = $event" />
      <AdminPublishCard :exam="exam" :external-busy="bankBusy" @changed="reload" @dirty-change="edits.policy = $event" />
    </template>
  </section>
</template>

<style scoped>
.exam-detail > * + * {
  margin-top: 16px;
}

.exam-detail__banner {
  margin-bottom: 4px;
}
</style>
