<script setup lang="ts">
import type { BankFilters, BankItemSummary, BankListDTO, QuestionType } from '#shared/types'
import { DIFFICULTY_LABELS, QUESTION_TYPE_LABELS } from '#shared/types'
definePageMeta({ layout: 'admin' })
useHead({ title: '知卷 · 错题集' })
const page = ref(1)
const filters = reactive({ query: '', type: '' as QuestionType | '' })
const scope = ref<BankFilters>({})
const applied = ref({ ...filters, scope: { ...scope.value } })
const { data: catalog, error: catalogError, refresh: reloadCatalog } = await useBankCatalog()
const { data, pending, error, refresh } = await useAsyncData<BankListDTO>('zj-admin-mistakes', () => apiFetch<BankListDTO>('/api/admin/question-bank', {
  query: { page: page.value, pageSize: 20, status: 'active', errorProneOnly: true, query: applied.value.query || undefined,
    type: applied.value.type || undefined, ...bankFilterQuery(applied.value.scope) }, silent: true,
}), { server: false, watch: [page, applied] })
const drawer = reactive({ open: false, id: '', intent: 'view' as 'view' | 'edit' })
function openItem(id: string, intent: 'view' | 'edit' = 'view') { drawer.id = id; drawer.intent = intent; drawer.open = true }
function search() { page.value = 1; applied.value = { ...filters, query: filters.query.trim(), scope: JSON.parse(JSON.stringify(scope.value)) as BankFilters } }
function reset() { Object.assign(filters, { query: '', type: '' }); scope.value = {}; search() }
async function reload() {
  await Promise.all([refresh(), reloadCatalog()])
}
watch(data, (value) => { if (value && page.value > value.totalPages) page.value = value.totalPages })
function rate(item: BankItemSummary) { return item.mistakeStats.errorRate === null ? '—' : `${(item.mistakeStats.errorRate * 100).toFixed(1)}%` }
</script>
<template>
  <section class="mistakes-page">
    <PageHeader title="错题集">
      <template #actions>
        <NuxtLink to="/admin/question-bank"><el-button text type="primary">管理题库</el-button></NuxtLink>
        <el-button :loading="pending" @click="reload">刷新</el-button>
      </template>
    </PageHeader>
    <el-card shadow="never" class="mistakes-page__filters">
      <div class="mistakes-page__row">
        <el-input v-model="filters.query" placeholder="搜索题干" clearable aria-label="题干关键词" @keyup.enter="search" />
        <el-select v-model="filters.type" placeholder="全部题型" aria-label="题型筛选"><el-option label="全部题型" value="" /><el-option v-for="(label, type) in QUESTION_TYPE_LABELS" :key="type" :label="label" :value="type" /></el-select>
      </div>
      <AdminBankFilters v-model="scope" :knowledge-points="catalog?.knowledgePoints ?? []" :files="catalog?.files ?? []" />
      <div class="mistakes-page__controls">
        <el-button type="primary" plain @click="search">查询</el-button><el-button text @click="reset">重置</el-button>
        <span class="zj-muted">按各场交卷统计 · 有错误即收录</span>
      </div>
      <el-alert v-if="catalogError" title="筛选选项加载失败" type="error" :closable="false"><el-button @click="reloadCatalog()">重试</el-button></el-alert>
    </el-card>
    <StatePanel v-if="error" state="error" title="无法加载错题集" :description="describeApiError(error, '请稍后重试')" @retry="refresh()" />
    <StatePanel v-else-if="!data" state="loading" title="正在读取错题集…" />
    <StatePanel v-else-if="!data?.total" state="empty" title="没有符合条件的错题" description="当前筛选范围内暂无有错误记录的已启用题目。" action-text="清除筛选" @action="reset" />
    <template v-else>
      <el-table :data="data.items" row-key="id">
        <el-table-column label="排名" width="70"><template #default="{ $index }">{{ (data.page - 1) * data.pageSize + $index + 1 }}</template></el-table-column>
        <el-table-column label="题目" min-width="320"><template #default="{ row }">
          <el-button link type="primary" class="mistakes-page__stem" @click="openItem(row.id, 'edit')">{{ formatQuestionStem(row.stem, row.type) }}</el-button>
          <div class="mistakes-page__meta"><el-tag size="small" effect="plain">{{ QUESTION_TYPE_LABELS[row.type as QuestionType] }}</el-tag><span>{{ row.knowledgePoint }}</span><span>{{ DIFFICULTY_LABELS[row.difficulty as keyof typeof DIFFICULTY_LABELS] }}</span></div>
        </template></el-table-column>
        <el-table-column label="来源资料" min-width="160"><template #default="{ row }"><span v-for="source in row.sources" :key="source.libraryFileId" class="mistakes-page__file">{{ source.originalName }}</span></template></el-table-column>
        <el-table-column width="110" align="right"><template #header><el-tooltip content="累计错误人次 ÷ 各场交卷人次；部分得分和零分均算错，包含未作答，人工最终分优先"><span>错误率</span></el-tooltip></template><template #default="{ row }"><span class="mistakes-page__rate zj-tabular">{{ rate(row as BankItemSummary) }}</span></template></el-table-column>
        <el-table-column label="错误 / 交卷人次" width="150" align="right"><template #default="{ row }"><span class="zj-tabular">{{ row.mistakeStats.errorCount }} / {{ row.mistakeStats.sampleSize }}</span></template></el-table-column>
        <el-table-column class-name="zj-table-actions" label="操作" width="90" fixed="right"><template #default="{ row }"><el-button text type="primary" @click="openItem(row.id)">详情</el-button></template></el-table-column>
      </el-table>
      <el-pagination class="mistakes-page__pager" background layout="prev, pager, next, total" :current-page="page" :page-size="20" :total="data.total" @current-change="page = $event" />
    </template>
    <AdminBankItemDrawer v-model="drawer.open" :item-id="drawer.id" :intent="drawer.intent" @changed="reload" />
  </section>
</template>
<style scoped>
.mistakes-page__filters { margin-bottom: 20px; }
.mistakes-page__row { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 12px; margin-bottom: 12px; }
.mistakes-page__controls { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 12px; }
.mistakes-page__controls .zj-muted { margin-left: auto; font-size: 14px; }
.mistakes-page__meta { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; color: var(--zj-text-muted); }
.mistakes-page__stem { white-space: normal; height: auto; text-align: left; justify-content: flex-start; line-height: 1.6; }
.mistakes-page__file { display: block; line-height: 1.7; }
.mistakes-page__rate { font-size: 16px; font-weight: 600; color: var(--zj-danger); }
.mistakes-page__pager { margin-top: 20px; }
@media(max-width:650px) { .mistakes-page__row { grid-template-columns: 1fr; } }
</style>
