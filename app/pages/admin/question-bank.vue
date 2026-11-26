<script setup lang="ts">
import type { BankFilters, BankItemSummary, BankListDTO, BankStatus, QuestionType, BankGenerationJobDTO } from '#shared/types'
import { BANK_STATUS_LABELS, DIFFICULTY_LABELS, QUESTION_TYPE_LABELS } from '#shared/types'
import { BANK_MISTAKE_MIN_SAMPLE, DEFAULT_PAGE_SIZE, MAX_BANK_PAGE_SIZE } from '#shared/constants'
definePageMeta({ layout: 'admin' })
useHead({ title: '知卷 · 题库' })
const route = useRoute()
const page = ref(1)
const pageSize = ref(DEFAULT_PAGE_SIZE)
const filters = reactive({ query: '', type: '' as QuestionType | '', status: '' as BankStatus | '', errorProneOnly: false })
const scope = ref<BankFilters>({ libraryFileIds: typeof route.query.libraryFileId === 'string' ? [route.query.libraryFileId] : [] })
const applied = ref({ ...filters, scope: { ...scope.value } })
const { data: catalog, error: catalogError, refresh: reloadCatalog } = await useBankCatalog()
const { data, pending, error, refresh } = await useAsyncData<BankListDTO>('zj-admin-bank', () => apiFetch<BankListDTO>('/api/admin/question-bank', {
  query: { page: page.value, pageSize: pageSize.value, query: applied.value.query || undefined, type: applied.value.type || undefined,
    status: applied.value.status || undefined, errorProneOnly: applied.value.errorProneOnly, ...bankFilterQuery(applied.value.scope) }, silent: true,
}), { server: false, watch: [page, pageSize, applied] })
const drawer = reactive({ open: false, id: '', intent: 'view' as 'view' | 'edit' | 'create' })
function openItem(id = '', intent: 'view' | 'edit' | 'create' = 'view') { drawer.id = id; drawer.intent = intent; drawer.open = true }
watch(() => route.query.itemId, (id, previous) => {
  if (typeof id === 'string' && id) openItem(id)
  else if (previous) drawer.open = false
}, { immediate: true })
watch(() => route.query.libraryFileId, (id) => { if (typeof id === 'string' && id) { scope.value = { ...scope.value, libraryFileIds: [id] }; search() } })
function search() { page.value = 1; applied.value = { ...filters, query: filters.query.trim(), scope: JSON.parse(JSON.stringify(scope.value)) as BankFilters } }
function reset() { Object.assign(filters, { query: '', type: '', status: '', errorProneOnly: false }); scope.value = {}; search() }
function changePageSize(size: number) { pageSize.value = size; page.value = 1 }
async function reload() {
  await Promise.all([refresh(), reloadCatalog()])
  if (data.value && page.value > data.value.totalPages) page.value = data.value.totalPages
}
function rate(item: BankItemSummary) { return item.mistakeStats.errorRate === null ? '—' : `${(item.mistakeStats.errorRate * 100).toFixed(1)}%` }
const selected = ref<BankItemSummary[]>([])
const deleting = ref(false)
const operationError = ref('')
const generationOpen = ref(false)
const generationIssuesOnly = ref(false)
const { data: generationJob, error: generationError, refresh: refreshGeneration } = await useAsyncData<BankGenerationJobDTO | null>('zj-bank-generation', () => apiFetch<BankGenerationJobDTO | null>('/api/admin/question-bank/generation', { silent: true }), { server: false })
const generationActive = computed(() => generationJob.value?.status === 'queued' || generationJob.value?.status === 'running')
const generationNeedsAttention = computed(() => generationJob.value?.status === 'succeeded' && (generationJob.value.conflicts.length > 0
  || generationJob.value.requestedCount !== null && generationJob.value.createdCount < generationJob.value.requestedCount))
const generationIssues = computed(() => generationJob.value?.issues ?? [])
let poll: ReturnType<typeof setInterval> | undefined
let polling = false
watch(generationActive, (active) => {
  if (poll) clearInterval(poll)
  if (active) poll = setInterval(async () => {
    if (polling) return
    polling = true
    try { await refreshGeneration() } finally { polling = false }
  }, 2000)
}, { immediate: true })
watch(() => generationJob.value?.status, (status, previous) => {
  // 只有本次会话里从排队/运行结束时才自动弹一次明细；刷新页面看到的旧错误只留结果入口。
  const justFinished = previous === 'queued' || previous === 'running'
  if (status === 'succeeded' && justFinished) {
    if (generationNeedsAttention.value) ElMessage.warning(`已入库 ${generationJob.value!.createdCount} 道题目，请查看未足量或答案冲突的结果`)
    else ElMessage.success(`已入库 ${generationJob.value!.createdCount} 道题目`)
    void reload()
  } else if (status === 'failed' && justFinished) {
    // 错误汇总里已含失败请求与已入库数量，明细在弹窗里列。
    ElMessage.error(generationJob.value!.errorMessage)
    // 结束时带错误就自动弹出一次明细（未打开过窗口也能看到）；刷新后只留下面的结果入口，不重复弹。
    generationIssuesOnly.value = true
    generationOpen.value = true
    if (generationJob.value!.createdCount > 0) void reload()
  }
})
watch([data, page, pageSize], () => { selected.value = [] })
onBeforeUnmount(() => { if (poll) clearInterval(poll) })
async function deleteSelected() {
  if (!selected.value.length || deleting.value || pending.value) return
  const snapshot = selected.value.map((item) => ({ itemId: item.id, expectedVersion: item.version }))
  try { await ElMessageBox.confirm(`确定删除选中的 ${snapshot.length} 道题目？删除不可恢复，已生成的试卷与答卷不受影响。`, '批量删除题目', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }) }
  catch { return }
  deleting.value = true; operationError.value = ''
  try {
    const result = await apiFetch<{ deletedCount: number }>('/api/admin/question-bank/batch-delete', { method: 'POST', body: { items: snapshot }, silent: true })
    ElMessage.success(`已删除 ${result.deletedCount} 道题目`)
    await reload()
  } catch (cause) { operationError.value = describeApiError(cause, '删除失败，本次没有删除任何题目') }
  finally { deleting.value = false }
}
</script>
<template>
  <section class="bank-page">
    <PageHeader title="题库" description="入库即可用于组卷；修改题目不会影响已创建的考试。">
      <template #actions>
        <el-button type="primary" @click="generationIssuesOnly = false; generationOpen = true">AI 生成</el-button>
        <el-button @click="openItem('', 'create')">人工新增</el-button>
        <el-button :loading="pending" @click="reload">刷新</el-button>
      </template>
    </PageHeader>
    <el-alert v-if="generationActive" type="info" :closable="false" title="题库生成任务进行中" class="bank-page__notice"><el-button text type="primary" @click="generationIssuesOnly = false; generationOpen = true">查看进度</el-button></el-alert>
    <el-alert v-else-if="generationJob?.status === 'failed'" type="error" :closable="false" :title="generationJob.errorMessage" class="bank-page__notice"><el-button text type="primary" @click="generationIssuesOnly = true; generationOpen = true">{{ generationIssues.length ? '查看失败明细并重试' : '查看并继续' }}</el-button></el-alert>
    <el-alert v-else-if="generationNeedsAttention" type="warning" :closable="false" :title="`题库任务已入库 ${generationJob?.createdCount} 道，存在未足量或答案冲突的结果`" class="bank-page__notice"><el-button text type="primary" @click="generationIssuesOnly = false; generationOpen = true">查看结果</el-button></el-alert>
    <el-alert v-if="generationError" type="error" :closable="false" title="生成任务状态读取失败" class="bank-page__notice"><el-button @click="refreshGeneration()">重新加载</el-button></el-alert>
    <el-alert v-if="operationError" type="error" :closable="false" :title="operationError" class="bank-page__notice" />
    <el-card shadow="never" class="bank-page__filters">
      <div class="bank-page__row">
        <el-input v-model="filters.query" placeholder="搜索题干" clearable aria-label="题干关键词" @keyup.enter="search" />
        <el-select v-model="filters.type" aria-label="题型筛选"><el-option label="全部题型" value="" /><el-option v-for="(label, type) in QUESTION_TYPE_LABELS" :key="type" :label="label" :value="type" /></el-select>
        <el-select v-model="filters.status" aria-label="状态筛选"><el-option label="全部状态" value="" /><el-option label="已启用" value="active" /><el-option label="已停用" value="disabled" /></el-select>
      </div>
      <AdminBankFilters v-model="scope" :knowledge-points="catalog?.knowledgePoints ?? []" :files="catalog?.files ?? []" />
      <div class="bank-page__row bank-page__controls">
        <el-checkbox v-model="filters.errorProneOnly">仅看易错题</el-checkbox>
        <el-button type="primary" plain @click="search">查询</el-button><el-button text @click="reset">重置</el-button>
      </div>
      <el-alert v-if="catalogError" title="筛选选项加载失败" type="error" :closable="false"><el-button @click="reloadCatalog()">重试</el-button></el-alert>
    </el-card>
    <StatePanel v-if="error" state="error" title="无法加载题库" :description="describeApiError(error, '请稍后重试')" @retry="refresh()" />
    <StatePanel v-else-if="pending && !data" state="loading" title="正在读取题库…" />
    <StatePanel v-else-if="!data?.total" state="empty" title="暂无题目" description="可用 AI 根据资料生成、人工新增，或从已有场次入库。" action-text="清除筛选" @action="reset" />
    <template v-else>
      <div class="bank-page__selection"><span>已选 {{ selected.length }} 道</span><el-button type="danger" plain :disabled="pending || !selected.length" :loading="deleting" @click="deleteSelected">删除所选</el-button></div>
      <el-table v-loading="pending" :data="data.items" row-key="id" @selection-change="selected = $event">
        <el-table-column type="selection" width="48" :selectable="() => !pending && !deleting" />
        <el-table-column label="题目" min-width="300"><template #default="{ row }">
          <el-button link type="primary" class="bank-page__stem" @click="openItem(row.id, 'edit')">{{ formatQuestionStem(row.stem, row.type) }}</el-button>
          <div class="bank-page__meta"><el-tag size="small" effect="plain">{{ QUESTION_TYPE_LABELS[row.type as QuestionType] }}</el-tag><span>{{ row.knowledgePoint }}</span><span>{{ DIFFICULTY_LABELS[row.difficulty as keyof typeof DIFFICULTY_LABELS] }}</span></div>
          <div v-if="row.sourceGroup" class="zj-muted">{{ row.sourceGroup }}</div>
        </template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : row.status === 'disabled' ? 'info' : 'warning'">{{ BANK_STATUS_LABELS[row.status as BankStatus] }}</el-tag></template></el-table-column>
        <el-table-column label="来源资料" min-width="160"><template #default="{ row }"><span v-for="source in row.sources" :key="source.libraryFileId" class="bank-page__file">{{ source.originalName }}</span></template></el-table-column>
        <el-table-column label="已作答" width="90"><template #default="{ row }">{{ row.mistakeStats.sampleSize }} 人</template></el-table-column>
        <el-table-column width="155"><template #header><el-tooltip content="按未满分统计，含部分得分，不含未作答"><span>错误率</span></el-tooltip></template><template #default="{ row }">
          <span class="zj-tabular">{{ rate(row as BankItemSummary) }}</span>
          <div v-if="row.mistakeStats.sampleSize === 0" class="zj-muted">暂无作答数据</div>
          <div v-else-if="row.mistakeStats.sampleSize < BANK_MISTAKE_MIN_SAMPLE" class="zj-muted">样本不足：{{ row.mistakeStats.sampleSize }} 人</div>
          <el-tag v-else-if="row.mistakeStats.isErrorProne" size="small" type="danger">易错</el-tag>
        </template></el-table-column>
        <el-table-column label="更新时间" width="165"><template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template></el-table-column>
        <el-table-column label="操作" width="130" fixed="right"><template #default="{ row }"><el-button text type="primary" @click="openItem(row.id)">详情</el-button><el-button text @click="openItem(row.id, 'edit')">编辑</el-button></template></el-table-column>
      </el-table>
      <el-pagination class="bank-page__pager" background layout="total, sizes, prev, pager, next" :current-page="page" :page-size="pageSize" :page-sizes="[20, 50, 100, 200, MAX_BANK_PAGE_SIZE]" :total="data.total" :disabled="pending || deleting" @current-change="page = $event" @size-change="changePageSize" />
    </template>
    <AdminBankItemDrawer v-model="drawer.open" :item-id="drawer.id" :intent="drawer.intent" @changed="reload" />
    <AdminBankGenerateDialog v-model="generationOpen" :job="generationJob ?? null" :issues-only="generationIssuesOnly" @created="generationJob = $event; generationIssuesOnly = false" />
  </section>
</template>
<style scoped>
.bank-page__filters { margin-bottom: 20px; }
.bank-page__notice { margin-bottom: 16px; }
.bank-page__selection { display: flex; gap: 16px; align-items: center; margin-bottom: 12px; }
.bank-page__row { display: grid; grid-template-columns: 1.3fr 1fr 1.5fr; gap: 12px; margin-bottom: 12px; }
.bank-page__controls { display: flex; align-items: center; flex-wrap: wrap; margin: 12px 0 0; }
.bank-page__meta { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; color: var(--zj-text-muted); }
.bank-page__stem { white-space: normal; height: auto; text-align: left; justify-content: flex-start; line-height: 1.6; }
.bank-page__file { display: block; line-height: 1.7; }
.bank-page__pager { margin-top: 20px; justify-content: flex-end; }
@media(max-width:650px) { .bank-page__row { grid-template-columns: 1fr; } }
</style>
