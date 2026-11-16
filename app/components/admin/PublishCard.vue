<script setup lang="ts">
/**
 * 公开策略 + 发布预检 + 发布/撤回（契约 §9.2 / §8.5 #25、#26 / §10.5）：
 * 发布前逐条渲染 publishChecklist；预检失败按错误码展示（时间重叠已不再是阻止项，契约 §10.1）。
 */
import type { AnswerRevealPolicy, ExamAdminDTO, ExamUpdateRequest } from '#shared/types'
import { EXAM_PHASE_LABELS, EXAM_PHASE_TAG_TYPES, REVEAL_POLICY_LABELS } from '~/utils/exam'

interface Props {
  exam: ExamAdminDTO
  externalBusy?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{ changed: []; 'dirty-change': [dirty: boolean] }>()

const policy = ref<AnswerRevealPolicy>(props.exam.answerRevealPolicy)
watch(
  () => props.exam.version,
  () => {
    policy.value = props.exam.answerRevealPolicy
  },
)

const busy = ref(false)
const errorMessage = ref('')
const failedChecks = ref<string[]>([])

const checklist = computed(() => props.exam.publishChecklist)
const allChecksOk = computed(() => checklist.value.length > 0 && checklist.value.every((item) => item.ok))
const isPublished = computed(() => props.exam.status === 'published')
const canUnpublish = computed(
  () => isPublished.value && props.exam.phase === 'upcoming' && props.exam.attemptCount === 0,
)
const policyDirty = computed(() => policy.value !== props.exam.answerRevealPolicy)
watch(() => policyDirty.value || busy.value, (value) => emit('dirty-change', value), { immediate: true })
const jobActive = computed(() => isJobActive(props.exam.activeJob?.status))

/** 暂停/继续/结束考试（契约 §5.1）：二次确认与错误文案统一在 composable 内 */
const {
  paused: isPaused,
  canPause,
  canResume,
  canEnd,
  busy: lifecycleBusy,
  pause: pauseExam,
  resume: resumeExam,
  end: endExam,
} = useExamLifecycle({ exam: computed(() => props.exam), onChanged: () => emit('changed') })

async function savePolicy(): Promise<void> {
  busy.value = true
  errorMessage.value = ''
  try {
    const payload: ExamUpdateRequest = {
      expectedVersion: props.exam.version,
      answerRevealPolicy: policy.value,
    }
    await apiFetch<ExamAdminDTO>(`/api/admin/exams/${props.exam.id}`, {
      method: 'PATCH',
      body: payload,
      silent: true,
    })
    ElMessage.success('公开策略已保存')
    emit('changed')
  } catch (error) {
    errorMessage.value = describeApiError(error, '保存公开策略失败')
  } finally {
    busy.value = false
  }
}

async function publish(): Promise<void> {
  busy.value = true
  errorMessage.value = ''
  failedChecks.value = []
  try {
    await apiFetch<ExamAdminDTO>(`/api/admin/exams/${props.exam.id}/publish`, { method: 'POST', silent: true })
    ElMessage.success('场次已发布，考生可在开放时间内作答')
    emit('changed')
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'PUBLISH_PRECHECK_FAILED') {
      const raw = (error.details as { checks?: unknown } | undefined)?.checks
      if (Array.isArray(raw)) {
        failedChecks.value = raw.map((item) =>
          typeof item === 'object' && item !== null
            ? String((item as { message?: string; code?: string }).message ?? (item as { code?: string }).code ?? '')
            : String(item),
        )
      }
      errorMessage.value = '发布预检未通过，请按清单补齐'
      emit('changed')
    } else {
      errorMessage.value = describeApiError(error, '发布失败')
    }
  } finally {
    busy.value = false
  }
}

async function unpublish(): Promise<void> {
  try {
    await ElMessageBox.confirm('撤回后考生将看不到该场次，可再次修改并重新发布。', '撤回发布', {
      type: 'warning',
      confirmButtonText: '撤回',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  busy.value = true
  errorMessage.value = ''
  try {
    await apiFetch<ExamAdminDTO>(`/api/admin/exams/${props.exam.id}/unpublish`, { method: 'POST', silent: true })
    ElMessage.success('已撤回发布')
    emit('changed')
  } catch (error) {
    errorMessage.value = describeApiError(error, '撤回失败')
  } finally {
    busy.value = false
  }
}

async function removeExam(): Promise<void> {
  try {
    await ElMessageBox.confirm('删除草稿场次将同时删除资料与题目，且不可恢复。', '删除场次', {
      type: 'error',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  busy.value = true
  try {
    await apiFetch<{ ok: true }>(`/api/admin/exams/${props.exam.id}`, { method: 'DELETE', silent: true })
    ElMessage.success('场次已删除')
    await navigateTo('/admin/exams')
  } catch (error) {
    errorMessage.value = describeApiError(error, '删除场次失败')
  } finally {
    busy.value = false
  }
}

</script>

<template>
  <el-card shadow="never" class="pub">
    <template #header>
      <div class="pub__head">
        <span class="pub__title">公开策略与发布</span>
        <el-tag :type="EXAM_PHASE_TAG_TYPES[exam.phase]" effect="plain" size="small">
          {{ EXAM_PHASE_LABELS[exam.phase] }}
        </el-tag>
      </div>
    </template>

    <section class="pub__section">
      <h3 class="pub__subtitle">答案公开策略</h3>
      <el-radio-group v-model="policy" :disabled="isPublished || busy || jobActive || externalBusy">
        <el-radio value="immediate" class="pub__radio">{{ REVEAL_POLICY_LABELS.immediate }}</el-radio>
        <el-radio value="after_exam" class="pub__radio">{{ REVEAL_POLICY_LABELS.after_exam }}</el-radio>
      </el-radio-group>
      <div class="pub__inline">
        <el-button :loading="busy" :disabled="!policyDirty || isPublished || jobActive || externalBusy" @click="savePolicy">
          保存公开策略
        </el-button>
        <span class="zj-muted pub__hint">
          after_exam 时，考生交卷后只能看到总分与自己的答案，结束时间 {{ formatDateTime(exam.endsAt, exam.timeZone) }} 后才公开标准答案与解析。
        </span>
      </div>
    </section>

    <section class="pub__section">
      <h3 class="pub__subtitle">发布预检</h3>
      <ul v-if="checklist.length" class="pub__checklist">
        <li v-for="item in checklist" :key="item.code" :class="{ 'pub__check--fail': !item.ok }">
          <span class="pub__check-icon" aria-hidden="true">{{ item.ok ? '✓' : '✕' }}</span>
          <span class="pub__check-text">
            {{ item.message }}
            <span v-if="!item.ok && item.hint" class="zj-muted pub__check-hint">{{ item.hint }}</span>
          </span>
        </li>
      </ul>
      <el-empty v-else description="暂无预检结果，刷新后可重新获取" :image-size="80" />
    </section>

    <section class="pub__section">
      <h3 class="pub__subtitle">考试生命周期</h3>
      <p class="zj-muted pub__hint">
        当前阶段：{{ EXAM_PHASE_LABELS[exam.phase] }}
        <template v-if="exam.endedAt"> · 结束于 {{ formatDateTime(exam.endedAt, exam.timeZone) }}</template>
        <template v-else-if="exam.pausedAt"> · 暂停于 {{ formatDateTime(exam.pausedAt, exam.timeZone) }}</template>
      </p>
      <p v-if="isPaused" class="zj-muted pub__hint">
        暂停中只能修改基本信息与题目内容，组卷与出题不可编辑；考生暂时不能进入作答，进行中的答卷仍可提交。
      </p>
      <div class="pub__inline">
        <el-button v-if="canPause" :loading="lifecycleBusy" :disabled="externalBusy" @click="pauseExam">暂停考试</el-button>
        <el-button v-if="canResume" type="primary" :loading="lifecycleBusy" :disabled="externalBusy" @click="resumeExam">继续考试</el-button>
        <el-button v-if="canEnd" type="danger" plain :loading="lifecycleBusy" :disabled="externalBusy" @click="endExam">结束考试</el-button>
        <span v-if="!canPause && !canResume && !canEnd" class="zj-muted pub__hint">
          草稿场次没有暂停/继续/结束操作；发布后可在这里控制考试进程。
        </span>
        <span v-else-if="canEnd" class="zj-muted pub__hint">
          结束考试在任何已发布阶段都可用：结束后考生不能再进入，进行中的答卷仍可提交。
        </span>
      </div>
    </section>

    <el-alert v-if="errorMessage" type="error" :closable="false" show-icon :title="errorMessage" class="pub__alert">
      <template v-if="failedChecks.length" #default>
        <ul class="pub__conflicts">
          <li v-for="(item, index) in failedChecks" :key="index">{{ item }}</li>
        </ul>
      </template>
    </el-alert>

    <div class="pub__actions">
      <el-button
        v-if="!isPublished"
        type="primary"
        :loading="busy"
        :disabled="!allChecksOk || externalBusy"
        @click="publish"
      >
        发布场次
      </el-button>
      <el-button v-else type="warning" plain :loading="busy" :disabled="!canUnpublish || externalBusy" @click="unpublish">
        撤回发布
      </el-button>
      <el-button v-if="!isPublished" text type="danger" :disabled="busy || jobActive || externalBusy" @click="removeExam">删除场次</el-button>
      <span v-if="!isPublished && !allChecksOk" class="zj-muted pub__hint">预检全部通过后才能发布。</span>
      <span v-else-if="isPublished && !canUnpublish" class="zj-muted pub__hint">
        已开始、已过开放时间或已有答卷时不能撤回（当前答卷 {{ exam.attemptCount }} 份）。
      </span>
    </div>
  </el-card>
</template>

<style scoped>
.pub__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.pub__title {
  font-size: 17px;
  font-weight: 600;
}

.pub__section {
  padding-bottom: 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--zj-border);
}

.pub__section:last-of-type {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}

.pub__subtitle {
  margin: 0 0 10px;
  font-size: 15px;
  font-weight: 600;
}

.pub__radio {
  display: flex;
  align-items: flex-start;
  height: auto;
  margin-right: 0;
  margin-bottom: 8px;
  white-space: normal;
}

.pub__inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.pub__hint {
  font-size: 13px;
  max-width: 640px;
}

.pub__checklist {
  list-style: none;
  margin: 0;
  padding: 0;
}

.pub__checklist li {
  display: flex;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px dashed var(--zj-border);
  font-size: 15px;
}

.pub__checklist li:last-child {
  border-bottom: none;
}

.pub__check-icon {
  color: var(--zj-primary);
  font-weight: 700;
}

.pub__check--fail .pub__check-icon {
  color: var(--zj-danger);
}

.pub__check-text {
  flex: 1;
  min-width: 0;
}

.pub__check-hint {
  display: block;
  font-size: 13px;
  margin-top: 2px;
}

.pub__alert {
  margin-bottom: 12px;
}

.pub__conflicts {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 14px;
}

.pub__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
</style>
