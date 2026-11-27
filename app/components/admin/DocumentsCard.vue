<script setup lang="ts">
/**
 * 场次资料卡片（契约 §9.2 / §8.5 #20–#22，docs/library-feature.md §L7.4）：
 * 上传 pdf/docx/txt/md（同时存入资料库）、展示解析状态与字数、正文分页预览、删除、
 * 从资料库多选挂载已有资料。
 */
import type {
  DocumentDTO,
  DocumentPreviewDTO,
  ExamAdminDTO,
  LibraryAttachResultDTO,
} from '#shared/types'
import { DOCUMENT_PREVIEW_CHARS, MAX_DOCUMENTS_PER_EXAM, MAX_DOCUMENT_BYTES } from '#shared/constants'

interface Props {
  exam: ExamAdminDTO
  /** 已发布场次不允许改资料（服务端返回 EXAM_LOCKED） */
  locked?: boolean
}
const props = withDefaults(defineProps<Props>(), { locked: false })
const emit = defineEmits<{ changed: [] }>()

const fileInput = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadError = ref('')
const deletingId = ref('')

const documents = computed(() => props.exam.documents)
const canUpload = computed(() => !props.locked && documents.value.length < MAX_DOCUMENTS_PER_EXAM)
const parsedCount = computed(() => documents.value.filter((doc) => doc.status === 'parsed').length)

/** 已挂在当前场次的库文件 id（选择器里置灰） */
const attachedLibraryIds = computed(() =>
  documents.value
    .map((doc) => doc.libraryFileId)
    .filter((id): id is string => Boolean(id)),
)
/** 本场还能再添加的资料份数 */
const remainingSlots = computed(() => Math.max(0, MAX_DOCUMENTS_PER_EXAM - documents.value.length))
const canAttachFromLibrary = computed(() => !props.locked && remainingSlots.value > 0)

const pickerOpen = ref(false)
const attaching = ref(false)
const attachError = ref('')

function openPicker(): void {
  attachError.value = ''
  pickerOpen.value = true
}

async function attachFromLibrary(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  attaching.value = true
  attachError.value = ''
  try {
    const result = await apiFetch<LibraryAttachResultDTO>(
      `/api/admin/exams/${props.exam.id}/documents/from-library`,
      { method: 'POST', body: { libraryFileIds: ids }, silent: true },
    )
    pickerOpen.value = false
    ElMessage.success(`已添加 ${result.added.length} 份资料`)
    emit('changed')
  } catch (error) {
    const fields = readFieldErrors(error)
    attachError.value = fields.libraryFileIds || describeApiError(error, '从资料库添加失败')
  } finally {
    attaching.value = false
  }
}

const previewOpen = ref(false)
const previewLoading = ref(false)
const previewError = ref('')
const preview = ref<DocumentPreviewDTO | null>(null)
const previewDocId = ref('')

function pickFile(): void {
  uploadError.value = ''
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
    await apiUpload<DocumentDTO>(`/api/admin/exams/${props.exam.id}/documents`, file)
    ElMessage.success('已上传并存入资料库')
    emit('changed')
  } catch (error) {
    uploadError.value = describeApiError(error, '上传失败')
  } finally {
    uploading.value = false
  }
}

async function removeDocument(doc: DocumentDTO): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除后将无法再引用《${doc.originalName}》，已出题目若引用该资料将无法保存。`,
      '删除资料',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  deletingId.value = doc.id
  try {
    await apiFetch<{ ok: true }>(`/api/admin/exams/${props.exam.id}/documents/${doc.id}`, {
      method: 'DELETE',
      silent: true,
    })
    ElMessage.success('已删除')
    emit('changed')
  } catch (error) {
    ElMessage.error(describeApiError(error, '删除失败'))
  } finally {
    deletingId.value = ''
  }
}

async function loadPreview(offset: number): Promise<void> {
  previewLoading.value = true
  previewError.value = ''
  try {
    preview.value = await apiFetch<DocumentPreviewDTO>(
      `/api/admin/exams/${props.exam.id}/documents/${previewDocId.value}/preview`,
      { query: { offset, limit: DOCUMENT_PREVIEW_CHARS }, silent: true },
    )
  } catch (error) {
    previewError.value = describeApiError(error, '加载正文预览失败')
  } finally {
    previewLoading.value = false
  }
}

function openPreview(doc: DocumentDTO): void {
  previewDocId.value = doc.id
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
</script>

<template>
  <el-card shadow="never" class="docs">
    <template #header>
      <div class="docs__head">
        <div>
          <span class="docs__title">资料</span>
          <span class="zj-muted docs__meta">
            最多 {{ MAX_DOCUMENTS_PER_EXAM }} 份，支持 pdf / docx / txt / md，单份 ≤
            {{ formatBytes(MAX_DOCUMENT_BYTES) }}；已解析 {{ parsedCount }} 份
          </span>
        </div>
        <div class="docs__actions">
          <input
            ref="fileInput"
            type="file"
            accept=".pdf,.docx,.txt,.md"
            class="docs__file"
            @change="handleFileChange"
          >
          <el-button :disabled="!canAttachFromLibrary" @click="openPicker">从资料库添加</el-button>
          <el-button type="primary" :loading="uploading" :disabled="!canUpload" @click="pickFile">
            上传资料
          </el-button>
        </div>
      </div>
    </template>

    <el-alert v-if="locked" type="info" :closable="false" show-icon class="docs__notice"
      title="场次已发布、已有答卷或正在出题，资料暂不可修改。" />

    <el-alert v-if="uploadError" type="error" :closable="false" show-icon :title="uploadError" class="docs__notice" />
    <el-alert v-if="attachError" type="error" show-icon :title="attachError" class="docs__notice" @close="attachError = ''" />

    <el-empty
      v-if="documents.length === 0"
      description="还没有资料。上传培训材料，或从资料库添加已有资料，AI 才能据此出题。"
    />

    <ul v-else class="docs__list">
      <li v-for="doc in documents" :key="doc.id" class="docs__item">
        <div class="docs__item-main">
          <div class="docs__item-title">
            <span class="docs__name">{{ doc.originalName }}</span>
            <el-tag v-if="doc.libraryFileId" type="primary" effect="plain" size="small">库</el-tag>
            <el-tag :type="doc.status === 'parsed' ? 'success' : 'danger'" effect="plain" size="small">
              {{ doc.status === 'parsed' ? '已解析' : '解析失败' }}
            </el-tag>
            <el-tag effect="plain" size="small" type="info">{{ doc.format.toUpperCase() }}</el-tag>
          </div>
          <p class="zj-muted docs__item-meta">
            {{ formatBytes(doc.byteSize) }} · {{ doc.charCount }} 字 · {{ doc.segmentCount }} 个片段 ·
            {{ formatDateTime(doc.createdAt, exam.timeZone) }}
          </p>
          <p v-if="doc.status === 'failed' && doc.errorMessage" class="docs__item-error">
            {{ doc.errorMessage }}
          </p>
        </div>
        <div class="docs__item-actions">
          <el-button text type="primary" @click="openPreview(doc)">预览正文</el-button>
          <el-button
            text
            type="danger"
            :disabled="locked"
            :loading="deletingId === doc.id"
            @click="removeDocument(doc)"
          >
            删除
          </el-button>
        </div>
      </li>
    </ul>

    <el-dialog v-model="previewOpen" :title="preview?.originalName ?? '正文预览'" width="min(860px, 94vw)">
      <div v-if="previewLoading" class="docs__preview-loading">
        <el-skeleton :rows="8" animated />
      </div>
      <el-alert v-else-if="previewError" type="error" :closable="false" show-icon :title="previewError" />
      <template v-else-if="preview">
        <p class="zj-muted docs__preview-meta">{{ previewRange }}<span v-if="preview.truncated"> · 本次为分页片段</span></p>
        <pre class="docs__preview-text">{{ preview.text || '（该资料没有提取到正文）' }}</pre>
      </template>

      <template #footer>
        <div class="docs__preview-foot">
          <el-button :disabled="!canPrevPage || previewLoading" @click="prevPage">上一段</el-button>
          <el-button :disabled="!canNextPage || previewLoading" @click="nextPage">下一段</el-button>
          <el-button @click="previewOpen = false">关闭</el-button>
        </div>
      </template>
    </el-dialog>

    <AdminLibraryPickerDialog
      v-model="pickerOpen"
      :attached-ids="attachedLibraryIds"
      :remaining-slots="remainingSlots"
      :confirming="attaching"
      @confirm="attachFromLibrary"
    />
  </el-card>
</template>

<style scoped>
.docs__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.docs__title {
  font-size: 17px;
  font-weight: 600;
  margin-right: 12px;
}

.docs__meta {
  font-size: 13px;
}

.docs__file {
  display: none;
}

.docs__actions { display: flex; align-items: center; gap: 12px; max-width: 100%; overflow-x: auto; }

.docs__notice {
  margin-bottom: 12px;
}

.docs__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.docs__item {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid var(--zj-border);
}

.docs__item:last-child {
  border-bottom: none;
}

.docs__item-main {
  flex: 1 1 320px;
  min-width: 0;
}

.docs__item-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.docs__name {
  font-weight: 600;
  word-break: break-all;
}

.docs__item-meta {
  margin: 4px 0 0;
  font-size: 13px;
}

.docs__item-error {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--zj-danger);
}

.docs__item-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.docs__preview-meta {
  margin: 0 0 12px;
  font-size: 13px;
}

.docs__preview-text {
  margin: 0;
  max-height: 56vh;
  overflow: auto;
  padding: 16px;
  background: #fff;
  border: 1px solid var(--zj-border);
  border-radius: var(--zj-radius);
  font-family: var(--zj-font);
  font-size: 15px;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
}

.docs__preview-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
