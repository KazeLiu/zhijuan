<script setup lang="ts">
/**
 * 场次详情（契约 §9.2 / §10.5 + docs/lifecycle-contract.md §3）：
 * 基本信息 → 资料 → 题数与难度 → 出题 → 题目编辑 → 公开策略 → 发布 → 暂停/继续/结束。
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

/** 草稿可编辑全部内容 */
const isDraft = computed(() => exam.value?.status === 'draft')
/** 暂停中（暂停未结束） */
const isPaused = computed(() => Boolean(exam.value?.pausedAt) && !exam.value?.endedAt)
const isEnded = computed(() => Boolean(exam.value?.endedAt))
/** 开放中：只读视图，要改内容必须先暂停（契约 §3.3） */
const isOpen = computed(() => exam.value?.phase === 'open')
/** 基本信息与题目内容：草稿或暂停中可改 */
const contentEditable = computed(() => isDraft.value || isPaused.value)
/** 资料、组卷与出题（含题目结构）：只有草稿可改（契约 §3.3） */
const structureEditable = computed(() => isDraft.value)

const jobActive = computed(() => {
  const job = exam.value?.activeJob
  return Boolean(job && isJobActive(job.status))
})

const {
  canPause,
  canResume,
  canEnd,
  busy: lifecycleBusy,
  pause: pauseExam,
  resume: resumeExam,
  end: endExam,
} = useExamLifecycle({ exam, onChanged: reload })

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
        <el-tag v-if="exam" :type="EXAM_PHASE_TAG_TYPES[exam.phase]" effect="plain" size="large">
          {{ EXAM_PHASE_LABELS[exam.phase] }}
        </el-tag>
        <el-button v-if="canPause" :loading="lifecycleBusy" :disabled="bankBusy" @click="pauseExam">暂停考试</el-button>
        <el-button v-if="canResume" type="primary" :loading="lifecycleBusy" :disabled="bankBusy" @click="resumeExam">继续考试</el-button>
        <el-button v-if="canEnd" type="danger" plain :loading="lifecycleBusy" :disabled="bankBusy" @click="endExam">结束考试</el-button>
        <NuxtLink v-if="exam" :to="`/admin/exams/${exam.id}/results`">
          <el-button type="primary">成绩汇总</el-button>
        </NuxtLink>
        <NuxtLink v-if="exam" :to="`/admin/exams/${exam.id}/blank-corrections`"><el-button>填空答案纠错</el-button></NuxtLink>
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
      <div v-if="isPaused" class="exam-detail__banner">
        <el-alert type="warning" :closable="false" show-icon title="场次已暂停：考生暂时不能进入作答，进行中的答卷仍可提交。">
          <template #default>暂停中只能修改基本信息与题目内容，组卷与出题不可编辑。</template>
        </el-alert>
      </div>
      <div v-else-if="isOpen" class="exam-detail__banner">
        <el-alert
          type="success"
          :closable="false"
          show-icon
          title="场次开放中：本页只读，考生正在作答，不能修改题目与基本信息。"
        >
          <template #default>需要修改内容请先点上方「暂停考试」；暂停期间可以改基本信息与题目，组卷与出题仍不可编辑。</template>
        </el-alert>
      </div>
      <div v-else-if="isEnded" class="exam-detail__banner">
        <el-alert type="info" :closable="false" show-icon title="场次已结束：考生不能再进入，进行中的答卷仍可提交，成绩汇总仍可导出。" />
      </div>
      <div v-if="jobActive" class="exam-detail__banner">
        <el-alert type="info" :closable="false" show-icon title="出题任务进行中，可在下方「题数与难度」卡片查看实时进度。" />
      </div>

      <AdminBasicsCard :exam="exam" :locked="!contentEditable || jobActive || bankBusy" @changed="reload" @dirty-change="edits.basics = $event" />
      <AdminDocumentsCard :exam="exam" :locked="!structureEditable || jobActive || bankBusy" @changed="reload" />
      <AdminBlueprintCard :exam="exam" :model-ready="modelReady" :locked="!structureEditable || bankBusy" @changed="reload" @dirty-change="edits.blueprint = $event">
        <template #question-bank>
          <AdminBankApplyCard :exam="exam" :locked="!structureEditable || jobActive || pending" :unsaved="hasUnsaved" @applied="exam = $event" @busy-change="bankBusy = $event" />
        </template>
      </AdminBlueprintCard>
      <AdminQuestionsCard
        :exam="exam"
        :locked="!contentEditable || jobActive || bankBusy"
        :structure-locked="isPaused"
        :external-busy="bankBusy || pending"
        @changed="reload"
        @dirty-change="edits.questions = $event"
        @bank-busy-change="bankBusy = $event"
      />
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
