<script setup lang="ts">
/**
 * 资料库选择器（docs/library-feature.md §L7.3）：
 * 在场次详情里打开，搜索 + 分页 + 多选资料库文件，确认后把库文件 id 交回父组件挂到当前场次。
 * 已在当前场次的库文件置灰并标注「已添加」；选择份数受本场剩余名额限制。
 */
import type { LibraryFileDTO, Paginated } from '#shared/types'
import { DEFAULT_PAGE_SIZE } from '#shared/constants'

interface Props {
  modelValue: boolean
  /** 当前场次已挂载的库文件 id（置灰显示，不可再选） */
  attachedIds: string[]
  /** 本场还能再添加的份数（= 上限 - 已有资料数） */
  remainingSlots: number
  /** 父组件提交中：确定按钮显示 loading */
  confirming?: boolean
}

const props = withDefaults(defineProps<Props>(), { confirming: false })
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  confirm: [ids: string[]]
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

const page = ref(1)
const keyword = ref('')
const appliedKeyword = ref('')
const pageSize = ref(DEFAULT_PAGE_SIZE)

const loading = ref(false)
const loadError = ref('')
const rows = ref<LibraryFileDTO[]>([])
const total = ref(0)

const selectedRows = ref<LibraryFileDTO[]>([])
const selectedIds = computed(() => selectedRows.value.map((row) => row.id))

const attachedSet = computed(() => new Set(props.attachedIds))
const maxSelectable = computed(() => Math.max(0, props.remainingSlots))
const overLimit = computed(() => selectedIds.value.length > maxSelectable.value)
const remainingAfterSelect = computed(() => Math.max(0, maxSelectable.value - selectedIds.value.length))
const canConfirm = computed(() => selectedIds.value.length > 0 && !overLimit.value && !props.confirming)

/** el-table 插槽 row 为 DefaultRow，统一在脚本内收窄类型 */
function isAttached(record: unknown): boolean {
  const row = record as LibraryFileDTO
  return attachedSet.value.has(row.id)
}

/** 已添加或解析失败的库文件不可选（服务端也要求 status=parsed） */
function isSelectable(record: unknown): boolean {
  const row = record as LibraryFileDTO
  return !isAttached(row) && row.status === 'parsed'
}

function rowClassName(data: { row: LibraryFileDTO }): string {
  return isAttached(data.row) ? 'picker__row--added' : ''
}

async function loadList(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const data = await apiFetch<Paginated<LibraryFileDTO>>('/api/admin/library', {
      query: {
        page: page.value,
        pageSize: pageSize.value,
        query: appliedKeyword.value || undefined,
      },
      silent: true,
    })
    rows.value = data.items
    total.value = data.total
    selectedRows.value = []
  } catch (error) {
    rows.value = []
    total.value = 0
    loadError.value = describeApiError(error, '加载资料库失败')
  } finally {
    loading.value = false
  }
}

function applySearch(): void {
  page.value = 1
  appliedKeyword.value = keyword.value.trim()
  void loadList()
}

function resetSearch(): void {
  keyword.value = ''
  appliedKeyword.value = ''
  page.value = 1
  void loadList()
}

function handlePageChange(next: number): void {
  page.value = next
  void loadList()
}

function handleSelectionChange(selection: LibraryFileDTO[]): void {
  selectedRows.value = selection
}

function submit(): void {
  if (!canConfirm.value) return
  emit('confirm', [...selectedIds.value])
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    page.value = 1
    keyword.value = ''
    appliedKeyword.value = ''
    selectedRows.value = []
    loadError.value = ''
    void loadList()
  },
  { immediate: true },
)
</script>

<template>
  <el-dialog
    v-model="visible"
    title="从资料库添加资料"
    width="min(960px, 96vw)"
    :close-on-click-modal="!confirming"
  >
    <div class="picker">
      <div class="picker__filters">
        <el-input
          v-model="keyword"
          placeholder="按文件名搜索"
          clearable
          class="picker__keyword"
          @keyup.enter="applySearch"
          @clear="resetSearch"
        />
        <el-button type="primary" plain @click="applySearch">查询</el-button>
        <el-button text @click="resetSearch">重置</el-button>
      </div>

      <el-alert
        v-if="loadError"
        type="error"
        :closable="false"
        show-icon
        :title="loadError"
        class="picker__alert"
      />

      <el-table
        v-loading="loading"
        :data="rows"
        row-key="id"
        :row-class-name="rowClassName"
        class="picker__table"
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="46" :selectable="isSelectable" />

        <el-table-column label="名称" min-width="240">
          <template #default="{ row }">
            <div class="picker__name-line">
              <span class="picker__name">{{ row.originalName }}</span>
              <el-tag v-if="isAttached(row)" type="info" effect="plain" size="small">已添加</el-tag>
              <el-tag v-else-if="row.status === 'failed'" type="danger" effect="plain" size="small">
                解析失败
              </el-tag>
            </div>
            <p v-if="row.status === 'failed' && row.errorMessage" class="picker__error">
              {{ row.errorMessage }}
            </p>
          </template>
        </el-table-column>

        <el-table-column label="格式" width="80">
          <template #default="{ row }">{{ row.format.toUpperCase() }}</template>
        </el-table-column>

        <el-table-column label="大小" width="100" align="right">
          <template #default="{ row }">
            <span class="zj-tabular">{{ formatBytes(row.byteSize) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="字数" width="100" align="right">
          <template #default="{ row }">
            <span class="zj-tabular">{{ row.charCount }}</span>
          </template>
        </el-table-column>

        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">
            <span class="zj-tabular zj-muted">{{ formatDateTime(row.createdAt) }}</span>
          </template>
        </el-table-column>

        <template #empty>
          <el-empty
            :description="appliedKeyword ? '没有匹配的资料' : '资料库还是空的，先去资料库上传一份 PDF/DOCX/TXT/MD 试试'"
            :image-size="72"
          />
        </template>
      </el-table>

      <div class="picker__pager">
        <el-pagination
          background
          layout="prev, pager, next, total"
          :current-page="page"
          :page-size="pageSize"
          :total="total"
          @current-change="handlePageChange"
        />
      </div>
    </div>

    <template #footer>
      <div class="picker__foot">
        <span class="zj-muted picker__foot-text">
          已选 {{ selectedIds.length }} 份 / 本场还可添加 {{ remainingAfterSelect }} 份
          <span v-if="overLimit" class="picker__over">
            · 本场最多只能再添加 {{ maxSelectable }} 份，请取消多余的选择
          </span>
        </span>
        <div class="picker__foot-actions">
          <el-button :disabled="confirming" @click="visible = false">取消</el-button>
          <el-button type="primary" :disabled="!canConfirm" :loading="confirming" @click="submit">
            确定添加
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.picker__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.picker__keyword {
  max-width: 280px;
}

.picker__alert {
  margin: 0;
}

.picker__table {
  width: 100%;
}

.picker__name-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.picker__name {
  font-weight: 600;
  word-break: break-all;
}

.picker__error {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--zj-danger);
}

.picker__pager {
  display: flex;
  justify-content: flex-end;
}

.picker__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.picker__foot-text {
  font-size: 14px;
}

.picker__over {
  color: var(--zj-danger);
}

.picker__foot-actions {
  display: flex;
  gap: 8px;
}

:deep(.picker__row--added) {
  color: var(--zj-text-muted);
  background: var(--zj-bg);
}
</style>
