<script setup lang="ts">
/**
 * 题数与难度 + 出题（契约 §9.2 / §8.5 #23、#31、#32）：
 * 保存 blueprint、发起出题任务、1 秒轮询进度、失败展示 errorMessage + 重试。
 */
import type { BlueprintDTO, ExamAdminDTO, ExamUpdateRequest, GenerateRequest, JobDTO } from '#shared/types'
import {
  DIFFICULTIES,
  MAX_EXTRA_PROMPT_CHARS,
  MAX_QUESTIONS,
  MIN_QUESTIONS,
} from '#shared/constants'
import { DIFFICULTY_LABELS } from '#shared/types'

interface Props {
  exam: ExamAdminDTO
  /** 模型是否已配置（未配置时禁止出题并提示去设置） */
  modelReady: boolean
  locked?: boolean
}
const props = withDefaults(defineProps<Props>(), { locked: false })
const emit = defineEmits<{ changed: []; addListen: [jobId: string]; 'dirty-change': [dirty: boolean] }>()

const blueprint = reactive<BlueprintDTO>({ ...props.exam.blueprint })
const saving = ref(false)
const saveError = ref('')
const generateError = ref('')
const generating = ref(false)
const retrying = ref(false)

watch(
  () => props.exam.version,
  () => {
    Object.assign(blueprint, props.exam.blueprint)
  },
)

const total = computed(
  () => blueprint.singleChoice + blueprint.multipleChoice + blueprint.trueFalse + blueprint.fillBlank,
)

// 展示用任务：优先活动任务；任务结束（含失败/中断）后 activeJob 为空，回退到最近一次任务，
// 否则「出题失败」会从界面上消失，用户只看到进度条停在某一批。
const job = ref<JobDTO | null>(props.exam.activeJob ?? props.exam.latestJob)
watch(
  () => props.exam.activeJob ?? props.exam.latestJob,
  (next) => {
    job.value = next
  },
)

const { job: trackedJob, polling, track, refresh: refreshJob } = useJobPolling({
  onSettled: (settled) => {
    if (settled.status === 'succeeded') {
      ElMessage.success('出题完成，请检查题目后保存')
    } else {
      ElMessage.error(settled.errorMessage || '出题失败，可重试')
    }
    emit('changed')
  },
  onError: (message) => {
    ElMessage.warning(message)
  },
})

watch(
  trackedJob,
  (next) => {
    if (next) job.value = next
  },
)

onMounted(() => {
  if (job.value && isJobActive(job.value.status)) track(job.value)
})

const activeJob = computed(() => job.value)
const jobRunning = computed(() => isJobActive(job.value?.status))
const jobPercent = computed(() => {
  const current = job.value
  if (!current || current.progressTotal <= 0) return 0
  return Math.min(100, Math.round((current.progressDone / current.progressTotal) * 100))
})

const parsedDocumentCount = computed(() => props.exam.documents.filter((doc) => doc.status === 'parsed').length)

const generateBlockers = computed<string[]>(() => {
  const blockers: string[] = []
  if (props.locked) blockers.push('场次已发布或已有答卷，不能再出题')
  if (!props.modelReady) blockers.push('尚未配置模型，请先到「模型设置」填写 Base URL 与模型（API Key 可选）')
  if (parsedDocumentCount.value === 0) blockers.push('还没有解析成功的资料')
  if (total.value < MIN_QUESTIONS || total.value > MAX_QUESTIONS) {
    blockers.push(`题数合计需在 ${MIN_QUESTIONS}–${MAX_QUESTIONS} 之间（当前 ${total.value}）`)
  }
  if (jobRunning.value) blockers.push('已有出题任务在执行')
  return blockers
})

const blueprintDirty = computed(() => {
  const before = props.exam.blueprint
  return (
    before.singleChoice !== blueprint.singleChoice
    || before.multipleChoice !== blueprint.multipleChoice
    || before.trueFalse !== blueprint.trueFalse
    || before.fillBlank !== blueprint.fillBlank
    || before.difficulty !== blueprint.difficulty
    || before.extraPrompt !== blueprint.extraPrompt
  )
})

function clampCount(key: 'singleChoice' | 'multipleChoice' | 'trueFalse' | 'fillBlank'): void {
  const value = Number(blueprint[key])
  blueprint[key] = Number.isFinite(value) ? Math.max(0, Math.min(MAX_QUESTIONS, Math.trunc(value))) : 0
}
watch(() => blueprintDirty.value || saving.value || generating.value || retrying.value, (value) => emit('dirty-change', value), { immediate: true })

async function saveBlueprint(): Promise<number | null> {
  saving.value = true
  saveError.value = ''
  try {
    const payload: ExamUpdateRequest = {
      expectedVersion: props.exam.version,
      blueprint: { ...blueprint },
    }
    const updated = await apiFetch<ExamAdminDTO>(`/api/admin/exams/${props.exam.id}`, {
      method: 'PATCH',
      body: payload,
      silent: true,
    })
    ElMessage.success('出题设定已保存')
    emit('changed')
    return updated.version
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'VERSION_CONFLICT') {
      saveError.value = '场次数据已被其他操作更新，请刷新后重试'
      emit('changed')
    } else {
      saveError.value = describeApiError(error, '保存失败')
    }
    return null
  } finally {
    saving.value = false
  }
}

async function generate(): Promise<void> {
  if (props.exam.questions.length > 0) {
    try {
      await ElMessageBox.confirm('重新生成成功后将替换本场已有题目；生成失败保留服务器上的原题目。确定继续吗？', '重新出题', {
        confirmButtonText: '重新生成', cancelButtonText: '取消', type: 'warning',
      })
    } catch {
      return
    }
  }
  generateError.value = ''
  let version = props.exam.version
  if (blueprintDirty.value) {
    const saved = await saveBlueprint()
    if (saved === null) return
    version = saved
  }
  generating.value = true
  try {
    const payload: GenerateRequest = { expectedVersion: version }
    const created = await apiFetch<JobDTO>(`/api/admin/exams/${props.exam.id}/generate`, {
      method: 'POST',
      body: payload,
      silent: true,
    })
    job.value = created
    track(created)
    emit('changed')
    emit('addListen', created.id)
    ElMessage.success('已开始出题，完成后会提示')
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'VERSION_CONFLICT') {
      generateError.value = '场次数据已更新，请刷新后重新发起'
      emit('changed')
    } else {
      generateError.value = describeApiError(error, '发起出题失败')
    }
  } finally {
    generating.value = false
  }
}

async function retryJob(): Promise<void> {
  const current = job.value
  if (!current) return
  retrying.value = true
  generateError.value = ''
  try {
    const next = await apiFetch<JobDTO>(`/api/admin/jobs/${current.id}/retry`, {
      method: 'POST',
      silent: true,
    })
    job.value = next
    track(next)
    emit('changed')
    ElMessage.success('已重新提交出题任务')
  } catch (error) {
    generateError.value = describeApiError(error, '重试失败')
  } finally {
    retrying.value = false
  }
}

const STATUS_LABELS: Record<JobDTO['status'], string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
}

const statusTag: Record<JobDTO['status'], 'info' | 'warning' | 'success' | 'danger'> = {
  queued: 'info',
  running: 'warning',
  succeeded: 'success',
  failed: 'danger',
}

defineExpose({ refreshJob })
</script>

<template>
  <el-card shadow="never" class="bp">
    <template #header>
      <div class="bp__head">
        <span class="bp__title">组卷与出题</span>
        <span class="zj-muted bp__total">合计 <strong class="zj-tabular">{{ total }}</strong> 题</span>
      </div>
    </template>

    <div class="bp__counts">
      <label class="bp__field">
        <span class="bp__label">单选题</span>
        <el-input-number
          v-model="blueprint.singleChoice"
          :min="0"
          :max="MAX_QUESTIONS"
          :step="1"
          :disabled="locked || jobRunning"
          @change="clampCount('singleChoice')"
        />
      </label>
      <label class="bp__field">
        <span class="bp__label">多选题</span>
        <el-input-number
          v-model="blueprint.multipleChoice"
          :min="0"
          :max="MAX_QUESTIONS"
          :step="1"
          :disabled="locked || jobRunning"
          @change="clampCount('multipleChoice')"
        />
      </label>
      <label class="bp__field">
        <span class="bp__label">判断题</span>
        <el-input-number
          v-model="blueprint.trueFalse"
          :min="0"
          :max="MAX_QUESTIONS"
          :step="1"
          :disabled="locked || jobRunning"
          @change="clampCount('trueFalse')"
        />
      </label>
      <label class="bp__field">
        <span class="bp__label">填空题</span>
        <el-input-number
          v-model="blueprint.fillBlank"
          :min="0"
          :max="MAX_QUESTIONS"
          :step="1"
          :disabled="locked || jobRunning"
          @change="clampCount('fillBlank')"
        />
      </label>
    </div>

    <div class="bp__row">
      <label class="bp__field bp__field--inline">
        <span class="bp__label">难度</span>
        <el-radio-group v-model="blueprint.difficulty" :disabled="locked || jobRunning">
          <el-radio-button v-for="level in DIFFICULTIES" :key="level" :value="level">
            {{ DIFFICULTY_LABELS[level] }}
          </el-radio-button>
        </el-radio-group>
      </label>
    </div>

    <label class="bp__field bp__field--block">
      <span class="bp__label">出题补充说明（可选）</span>
      <el-input
        v-model="blueprint.extraPrompt"
        type="textarea"
        :rows="3"
        :maxlength="MAX_EXTRA_PROMPT_CHARS"
        show-word-limit
        :disabled="locked || jobRunning"
        placeholder="例如：侧重第三章的应急处置流程，避免出现日期类记忆题"
      />
    </label>

    <el-alert v-if="saveError" type="error" :closable="false" show-icon :title="saveError" class="bp__alert" />

    <div class="bp__actions">
      <el-button :loading="saving" :disabled="locked || jobRunning || !blueprintDirty" @click="saveBlueprint">
        保存出题设定
      </el-button>
      <span v-if="blueprintDirty" class="zj-muted bp__dirty">设定已修改但未保存，出题前会自动保存</span>
    </div>

    <slot name="question-bank" />
    <el-divider />
    <h3>AI 出题</h3>
    <el-button type="primary" plain :loading="generating" :disabled="generateBlockers.length > 0" @click="generate">
      {{ jobRunning ? '出题进行中…' : '开始 AI 出题' }}
    </el-button>

    <el-alert v-if="generateBlockers.length" type="info" :closable="false" class="bp__alert">
      <template #title>
        <span>发起出题前还需：</span>
      </template>
      <ul class="bp__blockers">
        <li v-for="item in generateBlockers" :key="item">{{ item }}</li>
      </ul>
      <NuxtLink v-if="!modelReady" to="/admin/settings">
        <el-button size="small" class="bp__settings-link">去模型设置</el-button>
      </NuxtLink>
    </el-alert>

    <el-alert v-if="generateError" type="error" :closable="false" show-icon :title="generateError" class="bp__alert" />

    <div v-if="activeJob" class="bp__job">
      <div class="bp__job-head">
        <span class="bp__job-title">出题任务</span>
        <el-tag :type="statusTag[activeJob.status]" effect="plain" size="small">
          {{ STATUS_LABELS[activeJob.status] }}
        </el-tag>
        <span v-if="polling" class="zj-muted bp__job-poll">每秒刷新进度</span>
      </div>

      <el-progress
        v-if="activeJob.status === 'queued' || activeJob.status === 'running'"
        :percentage="jobPercent"
        :status="activeJob.status === 'queued' ? undefined : 'success'"
        :stroke-width="12"
      />
      <p class="zj-muted bp__job-meta">
        已完成 {{ activeJob.progressDone }} / {{ activeJob.progressTotal }} 批
        <span v-if="activeJob.modelId"> · 模型 {{ activeJob.modelId }}</span>
        <span v-if="activeJob.startedAt"> · 开始 {{ formatDateTimeSeconds(activeJob.startedAt, exam.timeZone) }}</span>
        <span v-if="activeJob.finishedAt"> · 结束 {{ formatDateTimeSeconds(activeJob.finishedAt, exam.timeZone) }}</span>
      </p>

      <el-alert
        v-if="activeJob.status === 'failed'"
        type="error"
        :closable="false"
        show-icon
        :title="activeJob.errorMessage || '出题失败'"
      >
        <template #default>
          <p class="bp__job-err">
            {{ activeJob.errorCode ? `错误码：${activeJob.errorCode}` : '请检查模型设置与资料后重试。' }}
          </p>
          <el-button size="small" type="primary" :loading="retrying" :disabled="locked" @click="retryJob">重试出题</el-button>
        </template>
      </el-alert>
    </div>

    <!-- 模型原始输出：任务结束后仍保留，可回看上一次输出；切换任务（job.id 变化）时自动清空重拉 -->
    <AdminJobOutputPanel
      class="bp__output"
      :job-id="job?.id ?? null"
      :active="jobRunning"
      :model-id="job?.modelId ?? null"
    />
  </el-card>
</template>

<style scoped>
.bp__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.bp__title {
  font-size: 17px;
  font-weight: 600;
}

.bp__total {
  font-size: 14px;
}

.bp__counts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}

.bp__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bp__field--inline {
  flex-direction: row;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.bp__field--block {
  margin-top: 14px;
}

.bp__label {
  font-size: 15px;
  color: var(--zj-text);
}

.bp__row {
  margin-top: 6px;
}

.bp__alert {
  margin-top: 14px;
}

.bp__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
}

.bp__dirty {
  font-size: 13px;
}

.bp__blockers {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 14px;
}

.bp__settings-link {
  margin-top: 8px;
}

.bp__job {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--zj-border);
}

.bp__job-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.bp__job-title {
  font-weight: 600;
}

.bp__job-poll {
  font-size: 13px;
}

.bp__job-meta {
  margin: 10px 0 0;
  font-size: 13px;
}

.bp__job-err {
  margin: 4px 0 8px;
  font-size: 14px;
}

.bp__output {
  margin-top: 16px;
}
</style>
