<script setup lang="ts">
import type { BankApplyRequest, BankAvailabilityDTO, BankFilters, ExamAdminDTO, QuestionType } from '#shared/types'
import { QUESTION_TYPES, QUESTION_TYPE_LABELS } from '#shared/types'
const props = defineProps<{ exam: ExamAdminDTO; locked: boolean; unsaved: boolean }>()
const emit = defineEmits<{ applied: [exam: ExamAdminDTO]; 'busy-change': [busy: boolean] }>()
const { data: catalog, error: catalogError, refresh: reloadCatalog } = await useBankCatalog()
const filters = ref<BankFilters>({})
const counts = ref<BankAvailabilityDTO | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const conflictItemId = ref('')
const pickerOpen = ref(false)
const manualVersion = ref(0)
const blocked = computed(() => props.locked || props.unsaved || busy.value)
const requiredTotal = computed(() => Object.values(counts.value?.required ?? {}).reduce((sum, value) => sum + value, 0))
const shortage = computed(() => Object.values(counts.value?.missing ?? {}).some((value) => value > 0))
const rows = computed(() => QUESTION_TYPES.map((type) => ({ type, label: QUESTION_TYPE_LABELS[type], required: counts.value?.required[type], available: counts.value?.available[type], missing: counts.value?.missing[type] })))
let request = 0
async function load() {
  const token = ++request
  loading.value = true; error.value = ''
  try {
    const result = await apiFetch<BankAvailabilityDTO>(`/api/admin/exams/${props.exam.id}/question-bank-availability`, { query: bankFilterQuery(filters.value), silent: true })
    if (token === request) {
      if (result.examVersion !== props.exam.version) {
        counts.value = null
        error.value = '场次已更新，请先刷新完整场次，再确认组卷。本地未保存内容仍保留。'
      } else counts.value = result
    }
  } catch (cause) { if (token === request) error.value = describeApiError(cause, '无法读取可用题数') }
  finally { if (token === request) loading.value = false }
}
watch([() => props.exam.version, filters], () => { ++request; counts.value = null; loading.value = false }, { deep: true })
onMounted(() => { if (!props.locked) void load() })
async function apply(payload: BankApplyRequest) {
  if (blocked.value) return
  busy.value = true; emit('busy-change', true); error.value = ''; conflictItemId.value = ''
  try {
    const updated = await apiFetch<ExamAdminDTO>(`/api/admin/exams/${props.exam.id}/questions/from-bank`, { method: 'POST', body: payload, silent: true })
    emit('applied', updated); pickerOpen.value = false
    ElMessage.success(payload.mode === 'random' ? '已从题库组成固定试卷' : '已追加题目并重新配分')
  } catch (cause) {
    error.value = describeApiError(cause, '组卷失败，原试题与所选条件已保留')
    if (cause instanceof ApiClientError) {
      const detail = cause.details as (BankAvailabilityDTO & { itemId?: string }) | undefined
      if (cause.code === 'QUESTION_BANK_SHORTAGE' && detail) counts.value = detail
      conflictItemId.value = detail?.itemId ?? ''
    }
  } finally { busy.value = false; emit('busy-change', false) }
}
async function random() {
  const snapshot = counts.value
  if (blocked.value || !snapshot) return
  if (props.exam.questions.length) {
    try { await ElMessageBox.confirm('将替换本场全部试题，已有资料保留。确定随机组卷？', '替换整份试卷', { confirmButtonText: '替换整份试卷', cancelButtonText: '取消', type: 'warning' }) }
    catch { return }
  }
  await apply({ mode: 'random', expectedVersion: snapshot.examVersion, filters: filters.value })
}
function openPicker() { error.value = ''; conflictItemId.value = ''; manualVersion.value = props.exam.version; pickerOpen.value = true }
</script>
<template>
  <section class="bank-apply">
    <h3>从题库组卷</h3>
    <AdminBankFilters v-model="filters" :knowledge-points="catalog?.knowledgePoints ?? []" :files="catalog?.files ?? []" />
    <el-alert v-if="catalogError" type="error" :closable="false" title="筛选选项加载失败"><el-button @click="reloadCatalog()">重试</el-button></el-alert>
    <el-table :data="rows" size="small">
      <el-table-column prop="label" label="题型" />
      <el-table-column label="所需"><template #default="{ row }">{{ row.required ?? '—' }}</template></el-table-column>
      <el-table-column label="可用考点"><template #default="{ row }">{{ row.available ?? '—' }}</template></el-table-column>
      <el-table-column label="互斥后缺少"><template #default="{ row }"><span :class="{ 'bank-apply__short': row.missing > 0 }">{{ row.missing ?? '—' }}</span></template></el-table-column>
    </el-table>
    <p v-if="unsaved" class="bank-apply__short">请先保存或放弃页面中的未保存修改，再进行组卷。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <div class="bank-apply__actions">
      <el-button :loading="loading" :disabled="locked || busy" @click="load">查看可用题数</el-button>
      <el-button type="primary" :loading="busy" :disabled="blocked || loading || !counts || shortage || requiredTotal < 1" @click="random">随机组卷 · 替换整卷</el-button>
      <el-button :disabled="blocked" @click="openPicker">手动挑题 · 追加</el-button>
      <NuxtLink to="/admin/question-bank"><el-button text>管理题库</el-button></NuxtLink>
    </div>
    <p v-if="counts && shortage" class="zj-muted">同源题每卷最多选一道；独立考点不足，可调整范围或题数，或去题库用 AI 补题。</p>
    <AdminBankPickerDialog v-model="pickerOpen" :exam="exam" :initial-filters="filters" :busy="busy" :blocked="blocked" :error="error" :conflict-item-id="conflictItemId"
      @clear-error="error = ''; conflictItemId = ''" @confirm="apply({ mode: 'manual', expectedVersion: manualVersion, items: $event })" />
  </section>
</template>
<style scoped>
.bank-apply { margin: 20px 0; padding-top: 16px; border-top: 1px solid var(--zj-border); }
.bank-apply h3 { font-size: 17px; margin: 0 0 16px; }
.bank-apply .el-table { margin: 12px 0; }
.bank-apply__actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; align-items: center; }
.bank-apply__actions .el-button { margin-left: 0; }
.bank-apply__short { color: var(--zj-danger); }
</style>
