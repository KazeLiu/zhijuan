<script setup lang="ts">
import type { BankAvailabilityDTO, RollingConfig, RollingDTO } from '#shared/types'
import { QUESTION_TYPES, QUESTION_TYPE_LABELS, blueprintTotal } from '#shared/types'
import { defaultRollingConfig } from '#shared/utils/rolling'
import { MAX_INSTRUCTIONS_CHARS, MAX_TITLE_CHARS } from '#shared/constants'

definePageMeta({ layout: 'admin' })
useHead({ title: '知卷 · 滚动出题' })
const { data, error: loadError, pending, refresh } = await useAsyncData<RollingDTO>('zj-rolling', () => apiFetch<RollingDTO>('/api/admin/rolling', { silent: true }), { server: false })
const { data: catalog, error: catalogError, refresh: reloadCatalog } = await useBankCatalog()
const form = reactive<RollingConfig>(defaultRollingConfig())
const baseline = ref(JSON.stringify(form))
const version = ref(0)
const dirty = computed(() => JSON.stringify(form) !== baseline.value)
const busy = ref(false)
const checking = ref(false)
const error = ref('')
const counts = ref<BankAvailabilityDTO | null>(null)
const keys = { single_choice: 'singleChoice', multiple_choice: 'multipleChoice', true_false: 'trueFalse', fill_blank: 'fillBlank' } as const
const total = computed(() => blueprintTotal(form.blueprint))
const missing = computed(() => counts.value && Object.values(counts.value.missing).some((count) => count > 0))
const rows = computed(() => QUESTION_TYPES.map((type) => ({ type, label: QUESTION_TYPE_LABELS[type], required: counts.value?.required[type], available: counts.value?.available[type], missing: counts.value?.missing[type] })))
function apply(value: RollingDTO) {
  Object.assign(form, JSON.parse(JSON.stringify(value.config)) as RollingConfig)
  version.value = value.version
  baseline.value = JSON.stringify(form)
  counts.value = value.availability
}
watch(data, (value) => { if (value && !dirty.value) apply(value) }, { immediate: true })
watch(() => JSON.stringify([form.blueprint, form.filters]), () => { counts.value = null }, { flush: 'sync' })
function describe(cause: unknown, fallback: string) {
  const fields = Object.values(readFieldErrors(cause))
  return fields.length ? fields.join('；') : describeApiError(cause, fallback)
}
async function save() {
  busy.value = true; error.value = ''
  try {
    const result = await apiFetch<RollingDTO>('/api/admin/rolling', { method: 'PUT', body: { expectedVersion: version.value, config: form }, silent: true })
    apply(result); data.value = result
    ElMessage.success(result.config.enabled ? '规则已保存，每日自动组卷并发布' : '规则已保存，滚动出题已暂停')
  } catch (cause) { error.value = describe(cause, '保存规则失败') }
  finally { busy.value = false }
}
async function restore() {
  try { await ElMessageBox.confirm('放弃本地修改并载入最新保存的规则？', '还原规则', { confirmButtonText: '还原', cancelButtonText: '继续编辑', type: 'warning' }) }
  catch { return }
  busy.value = true; error.value = ''
  try {
    const result = await apiFetch<RollingDTO>('/api/admin/rolling', { silent: true })
    apply(result); data.value = result
  } catch (cause) { error.value = describe(cause, '读取最新规则失败，本地修改已保留') }
  finally { busy.value = false }
}
async function preview() {
  checking.value = true; error.value = ''
  const snapshot = JSON.stringify(form)
  try {
    const result = await apiFetch<BankAvailabilityDTO>('/api/admin/rolling/preview', { method: 'POST', body: { config: form }, silent: true })
    if (snapshot === JSON.stringify(form)) counts.value = result
  } catch (cause) { error.value = describe(cause, '检查题量失败') }
  finally { checking.value = false }
}
async function generateToday() {
  busy.value = true; error.value = ''
  try {
    const result = await apiFetch<RollingDTO>('/api/admin/rolling/generate', { method: 'POST', silent: true })
    data.value = result
    ElMessage.success('今日试卷已生成并发布')
  } catch (cause) { error.value = describe(cause, '今日组卷失败'); await refresh() }
  finally { busy.value = false }
}
async function allowLeave() {
  if (busy.value) return false
  if (!dirty.value) return true
  try { await ElMessageBox.confirm('离开将放弃尚未保存的滚动规则。', '未保存的修改', { confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning' }); return true }
  catch { return false }
}
onBeforeRouteLeave(allowLeave)
let timer: ReturnType<typeof setInterval> | undefined
let polling = false
onMounted(() => {
  timer = setInterval(async () => {
    if (polling || busy.value) return
    polling = true
    try { await refresh() } finally { polling = false }
  }, 15_000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <section class="rolling-page">
    <PageHeader title="滚动出题">
      <template #actions>
        <el-tag v-if="data" :type="data.config.enabled ? 'success' : 'info'" effect="plain">{{ data.config.enabled ? '已启用' : '已暂停' }}</el-tag>
        <el-button type="primary" :loading="busy" :disabled="!data || checking || (!dirty && data.version > 0)" @click="save">保存规则</el-button>
        <el-button v-if="dirty" :disabled="busy || checking" @click="restore">还原已保存规则</el-button>
        <el-button :loading="pending" :disabled="busy" @click="refresh()">刷新状态</el-button>
      </template>
    </PageHeader>
    <StatePanel v-if="loadError && !data" state="error" title="无法加载滚动规则" :description="describeApiError(loadError)" @retry="refresh()" />
    <StatePanel v-else-if="!data" state="loading" title="正在读取滚动规则…" />
    <template v-else>
      <el-alert v-if="error" type="error" :closable="false" show-icon :title="error" />
      <el-alert v-if="loadError" type="warning" :closable="false" title="状态刷新失败，页面保留原有内容，请重新刷新" />
      <el-card shadow="never">
        <div class="rolling-page__status">
          <div><span class="zj-muted">今日试卷</span><div class="rolling-page__value">{{ data.today?.status === 'succeeded' ? data.today.examId ? '已生成并发布' : '场次已删除' : data.today?.status === 'failed' ? '生成失败' : '尚未生成' }}</div></div>
          <div><span class="zj-muted">下次生成</span><div class="rolling-page__value">{{ data.nextRunAt ? (data.today || data.nextRunAt > Date.now() + 60_000 ? formatDateTime(data.nextRunAt, data.config.timeZone) : '等待自动生成') : '已暂停' }}</div></div>
          <div class="rolling-page__actions">
            <NuxtLink v-if="data.today?.examId" :to="`/admin/exams/${data.today.examId}`"><el-button type="primary" plain>查看今日试卷</el-button></NuxtLink>
            <el-button v-if="data.today?.status !== 'succeeded'" :disabled="dirty || !data.config.enabled || busy" @click="generateToday">{{ data.today?.status === 'failed' ? '重试今日组卷' : '立即生成今日试卷' }}</el-button>
          </div>
        </div>
        <el-alert v-if="data.today?.status === 'failed'" type="error" :closable="false" :title="data.today.errorMessage" class="rolling-page__notice" />
      </el-card>

      <el-card shadow="never">
        <template #header><div class="rolling-page__card-head"><span>基本信息</span><el-switch v-model="form.enabled" active-text="每天自动组卷并发布" :disabled="busy" /></div></template>
        <el-form label-position="top" :disabled="busy">
          <el-form-item label="试卷名称" required><el-input v-model="form.title" :maxlength="MAX_TITLE_CHARS - 13" placeholder="每日测试" /><span class="zj-muted">生成时自动附加日期。</span></el-form-item>
          <el-form-item label="考试说明"><el-input v-model="form.instructions" type="textarea" :rows="3" :maxlength="MAX_INSTRUCTIONS_CHARS" /></el-form-item>
          <div class="rolling-page__window">
            <el-form-item label="场次时区"><el-select v-model="form.timeZone" filterable allow-create><el-option v-for="zone in COMMON_TIME_ZONES" :key="zone.value" :label="zone.label" :value="zone.value" /></el-select></el-form-item>
            <el-form-item label="每日开放"><el-input v-model="form.startsAtTime" type="time" /></el-form-item>
            <el-form-item :label="form.endsAtTime <= form.startsAtTime ? '次日截止' : '当日截止'"><el-input v-model="form.endsAtTime" type="time" /></el-form-item>
          </div>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><div class="rolling-page__card-head"><span>题数与抽题范围</span><span class="zj-muted">合计 {{ total }} 题 · 每个同源考点最多一道</span></div></template>
        <el-form label-position="top" :disabled="busy">
          <div class="rolling-page__counts"><el-form-item v-for="type in QUESTION_TYPES" :key="type" :label="QUESTION_TYPE_LABELS[type]"><el-input-number v-model="form.blueprint[keys[type]]" :min="0" :max="100" :precision="0" /></el-form-item></div>
          <AdminBankFilters v-model="form.filters" :knowledge-points="catalog?.knowledgePoints ?? []" :files="catalog?.files ?? []" />
          <AdminBankMistakeRange v-model="form.filters.mistakeTopN" :disabled="busy" />
        </el-form>
        <el-alert v-if="catalogError" type="error" :closable="false" title="筛选选项加载失败"><el-button @click="reloadCatalog()">重新加载</el-button></el-alert>
        <el-table :data="rows" class="rolling-page__table">
          <el-table-column prop="label" label="题型" />
          <el-table-column label="每日所需"><template #default="{ row }">{{ row.required ?? '—' }}</template></el-table-column>
          <el-table-column label="可用考点"><template #default="{ row }">{{ row.available ?? '—' }}</template></el-table-column>
          <el-table-column label="互斥后缺少"><template #default="{ row }"><span :class="{ 'rolling-page__short': row.missing > 0 }">{{ row.missing ?? '—' }}</span></template></el-table-column>
        </el-table>
        <div class="rolling-page__actions"><el-button :loading="checking" :disabled="busy || total < 1 || total > 100" @click="preview">检查可用题数</el-button><NuxtLink to="/admin/question-bank"><el-button text type="primary">管理题库</el-button></NuxtLink><span v-if="counts" class="zj-muted">{{ counts.groupCount }} 个独立考点</span></div>
        <p v-if="missing" class="rolling-page__short">{{ form.filters.mistakeTopN === undefined ? '同源互斥后不足以组成完整试卷，请补充独立考点或调整题数与范围。' : '错题范围不足以满足题型数量；可扩大排名范围、调整题数或关闭错题集选项。' }}</p>
      </el-card>

      <el-card shadow="never">
        <template #header>答案公开策略</template>
        <el-radio-group v-model="form.answerRevealPolicy" :disabled="busy"><el-radio value="immediate">交卷后立即公开</el-radio><el-radio value="after_exam">场次结束后公开</el-radio></el-radio-group>
      </el-card>
      <el-card v-if="data.recent.length" shadow="never">
        <template #header>最近生成记录</template>
        <el-table :data="data.recent" row-key="date">
          <el-table-column prop="date" label="日期" width="140" />
          <el-table-column label="结果" min-width="200"><template #default="{ row }"><span v-if="row.status === 'failed'" class="rolling-page__short">{{ row.errorMessage }}</span><span v-else>{{ row.examId ? '已发布' : '场次已删除' }}</span></template></el-table-column>
          <el-table-column class-name="zj-table-actions" label="操作" width="100" align="right"><template #default="{ row }"><NuxtLink v-if="row.examId" :to="`/admin/exams/${row.examId}`"><el-button link type="primary">查看试卷</el-button></NuxtLink></template></el-table-column>
        </el-table>
      </el-card>
      <p class="zj-muted">每天按所选时区生成独立场次；修改规则只影响后续生成，暂停不影响已有试卷。自动生成需要服务持续运行。</p>
    </template>
  </section>
</template>

<style scoped>
.rolling-page > :not(.page-header) + * { margin-top: var(--zj-section-gap); }
.rolling-page__card-head, .rolling-page__status, .rolling-page__actions { display: flex; align-items: center; gap: 16px; }
.rolling-page__card-head { justify-content: space-between; flex-wrap: wrap; }
.rolling-page__status { justify-content: space-between; flex-wrap: wrap; }
.rolling-page__value { margin-top: 8px; font-size: 18px; font-weight: 500; }
.rolling-page__window { display: grid; grid-template-columns: minmax(0, 2fr) repeat(2, minmax(0, 1fr)); gap: 24px; }
.rolling-page__window .el-select { width: 100%; }
.rolling-page__counts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.rolling-page__counts .el-input-number { width: 100%; }
.rolling-page__table, .rolling-page__notice { margin: 16px 0; }
.rolling-page__actions .el-button { margin-left: 0; }
.rolling-page__actions { max-width: 100%; overflow-x: auto; gap: 12px; }
.rolling-page__actions > * { flex-shrink: 0; }
.rolling-page__short { color: var(--zj-danger); }
@media(max-width: 760px) { .rolling-page__counts { grid-template-columns: repeat(2, 1fr); } .rolling-page__window { grid-template-columns: 1fr; gap: 0; } .rolling-page__card-head { flex-wrap: wrap; } }
</style>
