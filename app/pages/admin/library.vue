<script setup lang="ts">
/**
 * 资料库（docs/library-feature.md §L1 / §L7.2）：
 * 上传、搜索、格式筛选、分页浏览、正文预览、删除；展示来源场次与被场次引用情况。
 * 资料库是物理文件的唯一持有者，场次资料从资料库挂载（§L3）。
 */
import type {
  DocumentFormat,
  DocumentPreviewDTO,
  LibraryDeleteResultDTO,
  LibraryFileDTO,
  Paginated,
} from '#shared/types'
import {
  DEFAULT_PAGE_SIZE,
  DOCUMENT_PREVIEW_CHARS,
  MAX_DOCUMENT_BYTES,
  MAX_LIBRARY_FILES,
} from '#shared/constants'

definePageMeta({ layout: 'admin' })
useHead({ title: '知卷 · 资料库' })

const page = ref(1)
const pageSize = ref(DEFAULT_PAGE_SIZE)
const formatFilter = ref<'' | DocumentFormat>('')
const keyword = ref('')
const appliedKeyword = ref('')

const { data, error, pending, refresh } = await useAsyncData<Paginated<LibraryFileDTO>>(
  'zj-admin-library',
  () =>
    apiFetch<Paginated<LibraryFileDTO>>('/api/admin/library', {
      query: {
        page: page.value,
        pageSize: pageSize.value,
        query: appliedKeyword.value || undefined,
        format: formatFilter.value || undefined,
      },
      silent: true,
    }),
  { server: false, watch: [page, pageSize, formatFilter, appliedKeyword] },
)

const forbidden = computed(() => error.value instanceof ApiClientError && error.value.code === 'FORBIDDEN')
const rows = computed(() => data.value?.items ?? [])
const total = computed(() => data.value?.total ?? 0)
const hasFilters = computed(() => Boolean(appliedKeyword.value) || Boolean(formatFilter.value))
const limitReached = computed(() => total.value >= MAX_LIBRARY_FILES)

const headerDescription = computed(
  () => `资料库是资料的唯一存放位置：这里的文件可被任意场次挂载，场次里上传的资料也会自动存入这里。共 ${total.value} / ${MAX_LIBRARY_FILES} 份。`,
)

function applyFilters(): void {
  page.value = 1
  appliedKeyword.value = keyword.value.trim()
}

function resetFilters(): void {
  keyword.value = ''
  appliedKeyword.value = ''
  formatFilter.value = ''
  page.value = 1
}

function handleFormatChange(): void {
  page.value = 1
}

function handlePageChange(next: number): void {
  page.value = next
}

function handleSizeChange(next: number): void {
  pageSize.value = next
  page.value = 1
}

/* ------------------------------ 上传 ------------------------------ */
const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadError = ref('')

function pickFile(): void {
  uploadError.value = ''
  if (limitReached.value) {
    uploadError.value = `资料库最多 ${MAX_LIBRARY_FILES} 份，请先删除不再需要的资料`
    return
  }
  fileInput.value?.click()
}

async function handleFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  if (file.size > MAX_DOCUMENT_BYTES) {
    uploadError.value = `文件超过 ${formatBytes(MAX_DOCUMENT_BYTES)} 上限`
    return
  }

  uploading.value = true
  uploadError.value = ''
  try {
    const created = await apiUpload<LibraryFileDTO>('/api/admin/library', file)
    ElMessage.success(created.status === 'parsed' ? '已上传并解析完成' : '已上传，但解析失败')
    page.value = 1
    await refresh()
  } catch (error) {
    uploadError.value = describeApiError(error, '上传失败')
  } finally {
    uploading.value = false
  }
}

/* ------------------------------ 删除 ------------------------------ */
const deletingId = ref('')
const actionError = ref('')

async function removeFile(record: unknown): Promise<void> {
  const row = record as LibraryFileDTO
  actionError.value = ''
  try {
    await ElMessageBox.confirm(
      `将从资料库删除《${row.originalName}》及其物理文件，删除后不可恢复。`,
      '删除资料',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  deletingId.value = row.id
  try {
    await apiFetch<LibraryDeleteResultDTO>(`/api/admin/library/${row.id}`, {
      method: 'DELETE',
      silent: true,
    })
    ElMessage.success('已删除')
    if (rows.value.length === 1 && page.value > 1) page.value -= 1
    else await refresh()
  } catch (error) {
    actionError.value = describeApiError(error, '删除失败')
  } finally {
    deletingId.value = ''
  }
}

/* ------------------------------ 预览 ------------------------------ */
const previewOpen = ref(false)
const previewLoading = ref(false)
const previewError = ref('')
const preview = ref<DocumentPreviewDTO | null>(null)
const previewFileId = ref('')

async function loadPreview(offset: number): Promise<void> {
  previewLoading.value = true
  previewError.value = ''
  try {
    preview.value = await apiFetch<DocumentPreviewDTO>(
      `/api/admin/library/${previewFileId.value}/preview`,
      { query: { offset, limit: DOCUMENT_PREVIEW_CHARS }, silent: true },
    )
  } catch (error) {
    previewError.value = describeApiError(error, '加载正文预览失败')
  } finally {
    previewLoading.value = false
  }
}

function openPreview(record: unknown): void {
  const row = record as LibraryFileDTO
  previewFileId.value = row.id
  preview.value = null
  previewOpen.value = true
  void loadPreview(0)
}

const previewRange = computed(() => {
  const current = preview.value
  if (!current) return ''
  const from = current.offset + 1
  const to = Math.min(current.offset + current.text.length, current.totalChars)
  return `第 ${from}–${to} 字 / 共 ${current.totalChars} 字`
})

const canPrevPage = computed(() => (preview.value?.offset ?? 0) > 0)
const canNextPage = computed(() => {
  const current = preview.value
  if (!current) return false
  return current.offset + current.text.length < current.totalChars
})

function prevPage(): void {
  const current = preview.value
  if (!current) return
  void loadPreview(Math.max(0, current.offset - DOCUMENT_PREVIEW_CHARS))
}

function nextPage(): void {
  const current = preview.value
  if (!current) return
  void loadPreview(current.offset + DOCUMENT_PREVIEW_CHARS)
}

/* ------------------------------ 来源展示 ------------------------------ */
/** 引用提示：列出最多 3 个引用场次标题 */
function usageTip(record: unknown): string {
  const row = record as LibraryFileDTO
  const titles = row.usedByExamTitles.filter(Boolean)
  if (titles.length === 0) return `被 ${row.usageCount} 个场次引用，先到场次里移除`
  return `被 ${row.usageCount} 个场次引用：${titles.join('、')}。先到场次里移除资料后才能删除。`
}
</script>

<template>
  <section class="library">
    <PageHeader title="资料库" :description="headerDescription">
      <template #actions>
        <el-button type="primary" :loading="uploading" :disabled="limitReached" @click="pickFile">
          上传资料
        </el-button>
        <el-button :loading="pending" @click="refresh()">刷新</el-button>
      </template>
    </PageHeader>

    <el-card shadow="never" class="library__filters">
      <div class="library__filter-row">
        <el-input
          v-model="keyword"
          placeholder="按文件名搜索"
          clearable
          class="library__keyword"
          @keyup.enter="applyFilters"
          @clear="applyFilters"
        />
        <el-select v-model="formatFilter" placeholder="全部格式" class="library__format" @change="handleFormatChange">
          <el-option label="全部格式" value="" />
          <el-option label="PDF" value="pdf" />
          <el-option label="DOCX" value="docx" />
          <el-option label="TXT" value="txt" />
          <el-option label="MD" value="md" />
        </el-select>
        <el-button type="primary" plain @click="applyFilters">查询</el-button>
        <el-button text @click="resetFilters">重置</el-button>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept=".pdf,.docx,.txt,.md"
        class="library__file"
        @change="handleFileChange"
      >
    </el-card>

    <el-alert
      v-if="uploadError"
      type="error"
      :closable="false"
      show-icon
      :title="uploadError"
      class="library__notice"
    />
    <el-alert
      v-if="actionError"
      type="error"
      show-icon
      :title="actionError"
      class="library__notice"
      @close="actionError = ''"
    />
    <el-alert
      v-if="limitReached"
      type="info"
      :closable="false"
      show-icon
      :title="`资料库已达 ${MAX_LIBRARY_FILES} 份上限，删除不再需要的资料后才能继续上传。`"
      class="library__notice"
    />

    <StatePanel
      v-if="error"
      :state="forbidden ? 'forbidden' : 'error'"
      :title="forbidden ? '需要管理员权限' : '加载资料库失败'"
      :description="forbidden ? '当前登录身份不是管理员，请用管理员姓名登录。' : describeApiError(error, '请稍后重试')"
      :action-to="forbidden ? '/' : undefined"
      :action-text="forbidden ? '重新登录' : ''"
      @retry="refresh()"
    />

    <StatePanel v-else-if="pending && !data" state="loading" title="正在加载资料库…" :loading-rows="6" />

    <StatePanel
      v-else-if="rows.length === 0"
      state="empty"
      :title="hasFilters ? '没有匹配的资料' : '资料库还是空的'"
      :description="hasFilters ? '换个关键词或清空格式筛选再试。' : '上传一份 PDF/DOCX/TXT/MD 试试'"
      :action-text="hasFilters ? '' : '上传资料'"
      @action="pickFile"
    />

    <template v-else>
      <el-table :data="rows" row-key="id" class="library__table">
        <el-table-column label="名称" min-width="240">
          <template #default="{ row }">
            <div class="library__name-line">
              <span class="library__name">{{ row.originalName }}</span>
              <el-tag :type="row.status === 'parsed' ? 'success' : 'danger'" effect="plain" size="small">
                {{ row.status === 'parsed' ? '已解析' : '解析失败' }}
              </el-tag>
            </div>
            <p v-if="row.status === 'failed' && row.errorMessage" class="library__error">
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

        <el-table-column label="片段数" width="90" align="right">
          <template #default="{ row }">
            <span class="zj-tabular">{{ row.segmentCount }}</span>
          </template>
        </el-table-column>

        <el-table-column label="来源" min-width="200">
          <template #default="{ row }">
            <NuxtLink
              v-if="row.source === 'exam' && row.originExamId"
              :to="`/admin/exams/${row.originExamId}`"
              class="library__source-link"
            >
              来自场次「{{ row.originExamTitle || '已删除的场次' }}」
            </NuxtLink>
            <span v-else-if="row.source === 'exam'">
              来自场次「{{ row.originExamTitle || '已删除的场次' }}」
            </span>
            <span v-else class="zj-muted">资料库直传</span>
          </template>
        </el-table-column>

        <el-table-column label="被引用次数" width="120" align="right">
          <template #default="{ row }">
            <el-tooltip v-if="row.usageCount > 0" :content="usageTip(row)" placement="top">
              <el-tag type="warning" effect="plain" size="small">{{ row.usageCount }} 个场次</el-tag>
            </el-tooltip>
            <span v-else class="zj-muted">未被引用</span>
          </template>
        </el-table-column>

        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">
            <span class="zj-tabular zj-muted">{{ formatDateTime(row.createdAt) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="150" align="right" fixed="right">
          <template #default="{ row }">
            <el-button text type="primary" @click="openPreview(row)">预览</el-button>
            <el-tooltip :disabled="row.usageCount === 0" content="被场次引用，先到场次里移除" placement="top">
              <span class="library__delete-wrap">
                <el-button
                  text
                  type="danger"
                  :disabled="row.usageCount > 0"
                  :loading="deletingId === row.id"
                  @click="removeFile(row)"
                >
                  删除
                </el-button>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>

      <div class="library__pager">
        <el-pagination
          background
          layout="sizes, prev, pager, next, total"
          :current-page="data?.page ?? page"
          :page-size="data?.pageSize ?? pageSize"
          :page-sizes="[10, 20, 50]"
          :total="total"
          @current-change="handlePageChange"
          @size-change="handleSizeChange"
        />
      </div>
    </template>

    <el-dialog v-model="previewOpen" :title="preview?.originalName ?? '正文预览'" width="min(860px, 94vw)">
      <div v-if="previewLoading" class="library__preview-loading">
        <el-skeleton :rows="8" animated />
      </div>
      <el-alert v-else-if="previewError" type="error" :closable="false" show-icon :title="previewError" />
      <template v-else-if="preview">
        <p class="zj-muted library__preview-meta">
          {{ previewRange }}<span v-if="preview.truncated"> · 本次为分页片段</span>
        </p>
        <pre class="library__preview-text">{{ preview.text || '（该资料没有提取到正文）' }}</pre>
      </template>

      <template #footer>
        <div class="library__preview-foot">
          <el-button :disabled="!canPrevPage || previewLoading" @click="prevPage">上一段</el-button>
          <el-button :disabled="!canNextPage || previewLoading" @click="nextPage">下一段</el-button>
          <el-button @click="previewOpen = false">关闭</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.library__filters {
  margin-bottom: 16px;
}

.library__filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.library__keyword {
  max-width: 280px;
}

.library__format {
  width: 150px;
}

.library__file {
  display: none;
}

.library__notice {
  margin-bottom: 12px;
}

.library__table {
  width: 100%;
}

.library__name-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.library__name {
  font-weight: 600;
  word-break: break-all;
}

.library__error {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--zj-danger);
}

.library__source-link {
  text-decoration: none;
}

.library__delete-wrap {
  display: inline-block;
}

.library__pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

.library__preview-meta {
  margin: 0 0 10px;
  font-size: 13px;
}

.library__preview-text {
  margin: 0;
  max-height: 56vh;
  overflow: auto;
  padding: 14px;
  background: #fff;
  border: 1px solid var(--zj-border);
  border-radius: var(--zj-radius);
  font-family: var(--zj-font);
  font-size: 15px;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
}

.library__preview-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
