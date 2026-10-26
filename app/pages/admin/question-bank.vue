<script setup lang="ts">
import type { BankFilters, BankItemSummary, BankListDTO, BankStatus, QuestionType } from '#shared/types'
import { BANK_STATUS_LABELS, DIFFICULTY_LABELS, QUESTION_TYPE_LABELS } from '#shared/types'
import { BANK_MISTAKE_MIN_SAMPLE } from '#shared/constants'
definePageMeta({ layout: 'admin' })
useHead({ title: '知卷 · 题库' })
const route = useRoute()
const page = ref(1)
const filters = reactive({ query: '', type: '' as QuestionType | '', status: '' as BankStatus | '', errorProneOnly: false })
const scope = ref<BankFilters>({ libraryFileIds: typeof route.query.libraryFileId === 'string' ? [route.query.libraryFileId] : [] })
const applied = ref({ ...filters, scope: { ...scope.value } })
const { data: catalog, error: catalogError, refresh: reloadCatalog } = await useBankCatalog()
const { data, pending, error, refresh } = await useAsyncData<BankListDTO>('zj-admin-bank', () => apiFetch<BankListDTO>('/api/admin/question-bank', {
  query: { page: page.value, pageSize: 20, query: applied.value.query || undefined, type: applied.value.type || undefined,
    status: applied.value.status || undefined, errorProneOnly: applied.value.errorProneOnly, ...bankFilterQuery(applied.value.scope) }, silent: true,
}), { server: false, watch: [page, applied] })
const drawer = reactive({ open: false, id: '', intent: 'view' as 'view' | 'edit' | 'create' })
function openItem(id = '', intent: 'view' | 'edit' | 'create' = 'view') { drawer.id = id; drawer.intent = intent; drawer.open = true }
watch(() => route.query.itemId, (id, previous) => {
  if (typeof id === 'string' && id) openItem(id)
  else if (previous) drawer.open = false
}, { immediate: true })
watch(() => route.query.libraryFileId, (id) => { if (typeof id === 'string' && id) { scope.value = { ...scope.value, libraryFileIds: [id] }; search() } })
function search() { page.value = 1; applied.value = { ...filters, query: filters.query.trim(), scope: JSON.parse(JSON.stringify(scope.value)) as BankFilters } }
function reset() { Object.assign(filters, { query: '', type: '', status: '', errorProneOnly: false }); scope.value = {}; search() }
async function reload() {
  await Promise.all([refresh(), reloadCatalog()])
  if (data.value && page.value > data.value.totalPages) page.value = data.value.totalPages
}
function rate(item: BankItemSummary) { return item.mistakeStats.errorRate === null ? '—' : `${(item.mistakeStats.errorRate * 100).toFixed(1)}%` }
</script>
<template>
  <section class="bank-page">
    <PageHeader title="题库" description="审核启用后可用于组卷；修改题目不会影响已创建的考试。">
      <template #actions>
        <el-button type="primary" @click="openItem('', 'create')">新增题目</el-button>
        <NuxtLink to="/admin/exams"><el-button>去场次出题</el-button></NuxtLink>
        <el-button :loading="pending" @click="reload">刷新</el-button>
      </template>
    </PageHeader>
    <el-card shadow="never" class="bank-page__filters">
      <div class="bank-page__row">
        <el-input v-model="filters.query" placeholder="搜索题干" clearable aria-label="题干关键词" @keyup.enter="search" />
        <el-select v-model="filters.type" aria-label="题型筛选"><el-option label="全部题型" value="" /><el-option v-for="(label, type) in QUESTION_TYPE_LABELS" :key="type" :label="label" :value="type" /></el-select>
        <el-select v-model="filters.status" aria-label="状态筛选"><el-option label="全部状态" value="" /><el-option v-for="(label, status) in BANK_STATUS_LABELS" :key="status" :label="label" :value="status" /></el-select>
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
    <StatePanel v-else-if="!data?.total" state="empty" title="暂无题目" description="可以人工新增，或从场次中选择已保存的题目入库。" action-text="清除筛选" @action="reset" />
    <template v-else>
      <el-table :data="data.items" row-key="id">
        <el-table-column label="题目" min-width="300"><template #default="{ row }">
          <el-button link type="primary" class="bank-page__stem" @click="openItem(row.id)">{{ formatQuestionStem(row.stem, row.type) }}</el-button>
          <div class="bank-page__meta"><el-tag size="small" effect="plain">{{ QUESTION_TYPE_LABELS[row.type as QuestionType] }}</el-tag><span>{{ row.knowledgePoint }}</span><span>{{ DIFFICULTY_LABELS[row.difficulty as keyof typeof DIFFICULTY_LABELS] }}</span></div>
        </template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : row.status === 'disabled' ? 'info' : 'warning'">{{ BANK_STATUS_LABELS[row.status as BankStatus] }}</el-tag></template></el-table-column>
        <el-table-column label="来源资料" min-width="160"><template #default="{ row }"><span v-for="source in row.sources" :key="source.libraryFileId" class="bank-page__file">{{ source.originalName }}</span></template></el-table-column>
        <el-table-column label="已作答" width="90"><template #default="{ row }">{{ row.mistakeStats.sampleSize }} 人</template></el-table-column>
        <el-table-column width="155"><template #header><el-tooltip content="按未满分统计，含部分得分，不含未作答"><span>错误率</span></el-tooltip></template><template #default="{ row }">
          <span class="zj-tabular">{{ rate(row) }}</span>
          <div v-if="row.mistakeStats.sampleSize === 0" class="zj-muted">暂无作答数据</div>
          <div v-else-if="row.mistakeStats.sampleSize < BANK_MISTAKE_MIN_SAMPLE" class="zj-muted">样本不足：{{ row.mistakeStats.sampleSize }} 人</div>
          <el-tag v-else-if="row.mistakeStats.isErrorProne" size="small" type="danger">易错</el-tag>
        </template></el-table-column>
        <el-table-column label="更新时间" width="165"><template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template></el-table-column>
        <el-table-column label="操作" width="130" fixed="right"><template #default="{ row }"><el-button text type="primary" @click="openItem(row.id)">详情</el-button><el-button text @click="openItem(row.id, 'edit')">编辑</el-button></template></el-table-column>
      </el-table>
      <el-pagination class="bank-page__pager" background layout="prev, pager, next, total" :current-page="page" :page-size="20" :total="data.total" @current-change="page = $event" />
    </template>
    <AdminBankItemDrawer v-model="drawer.open" :item-id="drawer.id" :intent="drawer.intent" @changed="reload" />
  </section>
</template>
<style scoped>
.bank-page__filters { margin-bottom: 20px; }
.bank-page__row { display: grid; grid-template-columns: 1.3fr 1fr 1.5fr; gap: 12px; margin-bottom: 12px; }
.bank-page__controls { display: flex; align-items: center; flex-wrap: wrap; margin: 12px 0 0; }
.bank-page__meta { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 8px; color: var(--zj-text-muted); }
.bank-page__stem { white-space: normal; height: auto; text-align: left; justify-content: flex-start; line-height: 1.6; }
.bank-page__file { display: block; line-height: 1.7; }
.bank-page__pager { margin-top: 20px; justify-content: flex-end; }
@media(max-width:650px) { .bank-page__row { grid-template-columns: 1fr; } }
</style>
