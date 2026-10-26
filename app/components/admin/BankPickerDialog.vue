<script setup lang="ts">
import type { BankFilters, BankItemSummary, BankListDTO, ExamAdminDTO, QuestionType } from '#shared/types'
import { QUESTION_TYPE_LABELS } from '#shared/types'
const open = defineModel<boolean>({ required: true })
const props = defineProps<{ exam: ExamAdminDTO; initialFilters: BankFilters; busy: boolean; blocked: boolean; error: string; conflictItemId: string }>()
const emit = defineEmits<{ confirm: [items: Array<{ itemId: string; expectedVersion: number }>]; clearError: [] }>()
const { data: catalog, error: catalogError, refresh: reloadCatalog } = await useBankCatalog()
const filters = ref<BankFilters>({})
const query = ref('')
const type = ref<QuestionType | ''>('')
const page = ref(1)
const items = ref<BankListDTO | null>(null)
const loading = ref(false)
const loadError = ref('')
const selected = ref<Record<string, { itemId: string; expectedVersion: number; stem: string; type: QuestionType }>>({})
const preview = reactive({ open: false, id: '' })
const selectedList = computed(() => Object.values(selected.value))
const imported = computed(() => new Set(props.exam.questions.map((question) => question.bankOrigin?.itemId)))
let request = 0
async function load() {
  const token = ++request; loading.value = true; loadError.value = ''
  try {
    const result = await apiFetch<BankListDTO>('/api/admin/question-bank', { query: { page: page.value, pageSize: 20,
      status: 'active', type: type.value || undefined, query: query.value.trim() || undefined, ...bankFilterQuery(filters.value) }, silent: true })
    if (token === request) items.value = result
  } catch (cause) { if (token === request) loadError.value = describeApiError(cause, '读取题库失败') }
  finally { if (token === request) loading.value = false }
}
watch(open, (visible) => {
  if (visible) {
    selected.value = {}; filters.value = JSON.parse(JSON.stringify(props.initialFilters)) as BankFilters
    query.value = ''; type.value = ''; page.value = 1; void load()
  }
})
function search() { page.value = 1; void load() }
function toggle(row: BankItemSummary, checked: boolean) {
  if (checked) selected.value[row.id] = { itemId: row.id, expectedVersion: row.version, stem: row.stem, type: row.type }
  else delete selected.value[row.id]
}
function removeConflict() { delete selected.value[props.conflictItemId]; emit('clearError'); void load() }
</script>
<template>
  <el-dialog v-model="open" title="手动挑题 · 追加到本场" width="min(1040px, 96vw)" :close-on-click-modal="false" :show-close="!busy" :close-on-press-escape="!busy">
    <el-alert v-if="catalogError" type="error" :closable="false" title="筛选选项加载失败"><el-button @click="reloadCatalog()">重试</el-button></el-alert>
    <AdminBankFilters v-model="filters" :knowledge-points="catalog?.knowledgePoints ?? []" :files="catalog?.files ?? []" />
    <div class="bank-picker__search">
      <el-input v-model="query" placeholder="题干关键词" aria-label="题干关键词" @keyup.enter="search" />
      <el-select v-model="type" aria-label="题型"><el-option label="全部题型" value="" /><el-option v-for="(label, key) in QUESTION_TYPE_LABELS" :key="key" :label="label" :value="key" /></el-select>
      <el-button :loading="loading" @click="search">查询 / 刷新</el-button>
    </div>
    <el-alert v-if="error" type="error" :closable="false" :title="error"><el-button v-if="conflictItemId" @click="removeConflict">移除冲突题并刷新</el-button></el-alert>
    <StatePanel v-if="loadError" state="error" title="题库读取失败" :description="loadError" @retry="load" />
    <StatePanel v-else-if="loading" state="loading" title="正在读取可用题目…" />
    <el-table v-else :data="items?.items ?? []" row-key="id" empty-text="没有符合条件的已启用题目">
      <el-table-column width="65" label="选择"><template #default="{ row }">
        <el-checkbox :aria-label="`选择题目：${row.stem}`" :disabled="busy || imported.has(row.id) || (!selected[row.id] && selectedList.length >= 100)"
          :model-value="Boolean(selected[row.id])" @update:model-value="toggle(row, Boolean($event))" />
      </template></el-table-column>
      <el-table-column label="题目" min-width="280"><template #default="{ row }">
        <p class="bank-picker__stem">{{ formatQuestionStem(row.stem, row.type) }}</p>
        <span class="zj-muted">{{ QUESTION_TYPE_LABELS[row.type as QuestionType] }} · {{ row.knowledgePoint }}</span>
        <el-tag v-if="imported.has(row.id)" size="small" type="info">已添加</el-tag>
      </template></el-table-column>
      <el-table-column label="操作" width="90"><template #default="{ row }"><el-button text type="primary" :disabled="busy" @click="preview.id = row.id; preview.open = true">预览</el-button></template></el-table-column>
    </el-table>
    <el-pagination :current-page="page" :page-size="20" :total="items?.total ?? 0" layout="prev, pager, next, total" @current-change="page = $event; load()" />
    <p>已选 {{ selectedList.length }} 题 · 本场原有 {{ exam.questions.length }} 题</p>
    <div v-if="selectedList.length" class="bank-picker__selected">
      <el-tag v-for="item in selectedList" :key="item.itemId" :closable="!busy" @close="delete selected[item.itemId]">{{ formatQuestionStem(item.stem, item.type).slice(0, 28) }}</el-tag>
    </div>
    <template #footer>
      <el-button :disabled="busy" @click="open = false">取消</el-button>
      <el-button type="primary" :loading="busy" :disabled="blocked || !selectedList.length || exam.questions.length + selectedList.length > 100"
        @click="emit('confirm', selectedList.map(({ itemId, expectedVersion }) => ({ itemId, expectedVersion })))">追加 {{ selectedList.length }} 题并重新配分</el-button>
    </template>
    <AdminBankItemDrawer v-model="preview.open" :item-id="preview.id" read-only />
  </el-dialog>
</template>
<style scoped>
.bank-picker__search { display: flex; gap: 12px; margin: 12px 0; flex-wrap: wrap; }
.bank-picker__search > .el-input, .bank-picker__search > .el-select { flex: 1; min-width: 160px; }
.bank-picker__stem { line-height: 1.6; margin: 4px 0; white-space: pre-wrap; }
.bank-picker__selected { display: flex; gap: 8px; flex-wrap: wrap; }
.el-pagination { margin-top: 16px; }
</style>
