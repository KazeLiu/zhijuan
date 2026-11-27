<script setup lang="ts">
/**
 * 基本信息（契约 §9.2 / §8.5 #18）：标题、说明、开放时间（场次时区墙上时间）、时区。
 * PATCH 发送带偏移的 ISO 字符串；同时段允许多场，时间重叠不再视为冲突（契约 §10.1）。
 */
import type { ExamAdminDTO, ExamUpdateRequest } from '#shared/types'
import {
  COMMON_TIME_ZONES,
  isValidTimeZone,
  wallClockToIso,
} from '~/utils/exam'
import { MAX_INSTRUCTIONS_CHARS, MAX_TITLE_CHARS } from '#shared/constants'

interface Props {
  exam: ExamAdminDTO
  locked?: boolean
}
const props = withDefaults(defineProps<Props>(), { locked: false })
const emit = defineEmits<{ changed: []; 'dirty-change': [dirty: boolean] }>()

const form = reactive({
  title: '',
  instructions: '',
  timeZone: '',
  startsAt: '',
  endsAt: '',
})

const saving = ref(false)
const saveError = ref('')
const fieldErrors = ref<Record<string, string>>({})

function fromExam(exam: ExamAdminDTO): void {
  form.title = exam.title
  form.instructions = exam.instructions
  form.timeZone = exam.timeZone
  form.startsAt = toDateTimeInputValue(exam.startsAt, exam.timeZone)
  form.endsAt = toDateTimeInputValue(exam.endsAt, exam.timeZone)
}

watch(
  () => props.exam.version,
  () => fromExam(props.exam),
  { immediate: true },
)

const dirty = computed(() => {
  const base = props.exam
  return (
    form.title !== base.title
    || form.instructions !== base.instructions
    || form.timeZone !== base.timeZone
    || form.startsAt !== toDateTimeInputValue(base.startsAt, base.timeZone)
    || form.endsAt !== toDateTimeInputValue(base.endsAt, base.timeZone)
  )
})

const previewWindow = computed(() => {
  const zone = form.timeZone || props.exam.timeZone
  const startIso = form.startsAt ? wallClockToIso(form.startsAt, zone) : null
  const endIso = form.endsAt ? wallClockToIso(form.endsAt, zone) : null
  if (!startIso || !endIso) return ''
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return ''
  return `${formatDateTime(start, zone)} ~ ${formatDateTime(end, zone)}（${zone}）`
})
watch(() => dirty.value || saving.value, (value) => emit('dirty-change', value), { immediate: true })

const localErrors = computed<Record<string, string>>(() => {
  const errors: Record<string, string> = {}
  if (!form.title.trim()) errors.title = '标题不能为空'
  if (form.title.trim().length > MAX_TITLE_CHARS) errors.title = `标题最多 ${MAX_TITLE_CHARS} 字`
  if (!isValidTimeZone(form.timeZone)) errors.timeZone = '请选择有效的 IANA 时区'
  if (!form.startsAt) errors.startsAt = '请选择开放时间'
  if (!form.endsAt) errors.endsAt = '请选择截止时间'
  const startIso = form.startsAt ? wallClockToIso(form.startsAt, form.timeZone) : null
  const endIso = form.endsAt ? wallClockToIso(form.endsAt, form.timeZone) : null
  if (startIso && endIso && Date.parse(startIso) >= Date.parse(endIso)) {
    errors.endsAt = '截止时间必须晚于开放时间'
  }
  return errors
})

const mergedErrors = computed(() => ({ ...localErrors.value, ...fieldErrors.value }))
const canSave = computed(() => dirty.value && Object.keys(localErrors.value).length === 0 && !props.locked)

async function save(): Promise<void> {
  if (!canSave.value) return
  fieldErrors.value = {}
  saveError.value = ''

  const zone = form.timeZone
  const startsAt = wallClockToIso(form.startsAt, zone)
  const endsAt = wallClockToIso(form.endsAt, zone)
  if (!startsAt || !endsAt) {
    fieldErrors.value = { startsAt: '时间格式无法解析，请重新选择' }
    return
  }

  saving.value = true
  try {
    const payload: ExamUpdateRequest = {
      expectedVersion: props.exam.version,
      title: form.title.trim(),
      instructions: form.instructions,
      timeZone: zone,
      startsAt,
      endsAt,
    }
    await apiFetch<ExamAdminDTO>(`/api/admin/exams/${props.exam.id}`, {
      method: 'PATCH',
      body: payload,
      silent: true,
    })
    ElMessage.success('基本信息已保存')
    emit('changed')
  } catch (error) {
    handleError(error)
  } finally {
    saving.value = false
  }
}

function handleError(error: unknown): void {
  fieldErrors.value = readFieldErrors(error)
  if (error instanceof ApiClientError) {
    if (error.code === 'VERSION_CONFLICT') {
      saveError.value = '场次数据已被其他操作更新，已重新加载最新版本'
      emit('changed')
      return
    }
    if (error.code === 'EXAM_LOCKED') {
      saveError.value = '场次已锁定（已发布或已有答卷），不能修改基本信息'
      return
    }
  }
  saveError.value = describeApiError(error, '保存失败')
}

function reset(): void {
  fromExam(props.exam)
  fieldErrors.value = {}
  saveError.value = ''
}

</script>

<template>
  <el-card shadow="never" class="basics">
    <template #header>
      <div class="basics__head">
        <span class="basics__title">基本信息</span>
        <span class="zj-muted basics__meta">版本 v{{ exam.version }} · 更新于 {{ formatDateTimeSeconds(exam.updatedAt, exam.timeZone) }}</span>
      </div>
    </template>

    <el-alert v-if="locked" type="info" :closable="false" show-icon class="basics__alert"
      title="场次已发布、已有答卷或正在出题，基本信息暂不可修改。" />

    <el-form label-position="top" class="basics__form" @submit.prevent="save">
      <el-form-item label="标题" :error="mergedErrors.title">
        <el-input v-model="form.title" :maxlength="MAX_TITLE_CHARS" show-word-limit :disabled="locked" />
      </el-form-item>

      <el-form-item label="考生须知" :error="mergedErrors.instructions">
        <el-input
          v-model="form.instructions"
          type="textarea"
          :rows="4"
          :maxlength="MAX_INSTRUCTIONS_CHARS"
          show-word-limit
          :disabled="locked"
          placeholder="例如：本场为闭卷考试，共 20 题，满分 100 分，90 分及格。"
        />
      </el-form-item>

      <div class="basics__grid">
        <el-form-item label="场次时区" :error="mergedErrors.timeZone">
          <el-select v-model="form.timeZone" :disabled="locked" class="basics__control">
            <el-option v-for="zone in COMMON_TIME_ZONES" :key="zone.value" :label="zone.label" :value="zone.value" />
          </el-select>
        </el-form-item>

        <el-form-item label="开放时间（该时区的墙上时间）" :error="mergedErrors.startsAt">
          <el-date-picker
            v-model="form.startsAt"
            type="datetime"
            format="YYYY-MM-DD HH:mm"
            value-format="YYYY-MM-DD HH:mm"
            :disabled="locked"
            class="basics__control"
            placeholder="选择开始时间"
          />
        </el-form-item>

        <el-form-item label="截止时间（该时区的墙上时间）" :error="mergedErrors.endsAt">
          <el-date-picker
            v-model="form.endsAt"
            type="datetime"
            format="YYYY-MM-DD HH:mm"
            value-format="YYYY-MM-DD HH:mm"
            :disabled="locked"
            class="basics__control"
            placeholder="选择截止时间"
          />
        </el-form-item>
      </div>

      <p v-if="previewWindow" class="zj-muted basics__preview">保存后：{{ previewWindow }}</p>

      <el-alert
        v-if="saveError"
        type="error"
        :closable="false"
        show-icon
        :title="saveError"
        class="basics__alert"
      />

      <div class="basics__actions">
        <el-button type="primary" :loading="saving" :disabled="!canSave" @click="save">保存基本信息</el-button>
        <el-button :disabled="!dirty || saving" @click="reset">还原</el-button>
        <span v-if="dirty" class="zj-muted basics__dirty">有未保存的修改</span>
      </div>
    </el-form>
  </el-card>
</template>

<style scoped>
.basics__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.basics__title {
  font-size: 17px;
  font-weight: 600;
}

.basics__meta {
  font-size: 13px;
}

.basics__alert {
  margin-bottom: 12px;
}

.basics__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 24px;
}

.basics__control {
  width: 100%;
}
.basics__grid :deep(.el-date-editor.el-input) { width: 100%; }

.basics__preview {
  margin: 0 0 12px;
  font-size: 13px;
}

.basics__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.basics__dirty {
  font-size: 13px;
}
@media (max-width: 1100px) {
  .basics__grid { grid-template-columns: 1fr; gap: 0; }
}
</style>
