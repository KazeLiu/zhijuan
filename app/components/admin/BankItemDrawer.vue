<script setup lang="ts">
import type { BankItemDTO, BankQuestionInput, QuestionContentInput } from '#shared/types'
import { BANK_STATUS_LABELS, DIFFICULTY_LABELS } from '#shared/types'
import { BANK_MISTAKE_MIN_SAMPLE, MAX_KNOWLEDGE_POINT_CHARS, MAX_QUOTE_CHARS } from '#shared/constants'
const open = defineModel<boolean>({ required: true })
const props = withDefaults(defineProps<{ itemId?: string; intent?: 'view' | 'edit' | 'create'; readOnly?: boolean }>(), { itemId: '', intent: 'view', readOnly: false })
const emit = defineEmits<{ changed: [] }>()
const { data: catalog, error: catalogError, refresh: reloadCatalog } = await useBankCatalog()
const record = ref<BankItemDTO | null>(null)
const mode = ref<'view' | 'edit' | 'create'>('view')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const conflict = ref(false)
const duplicateId = ref('')
const baseline = ref('')
const form = reactive<BankQuestionInput>({ ...newQuestionContent(), knowledgePoint: '', difficulty: 'normal', sourceRefs: [] })
const dirty = computed(() => open.value && mode.value !== 'view' && JSON.stringify(form) !== baseline.value)
const preview = reactive({ open: false, fileId: '' })
let request = 0

function fill(item: BankItemDTO) {
  Object.assign(form, JSON.parse(JSON.stringify({ type: item.type, stem: item.stem, options: item.options,
    answerDefinition: item.answerDefinition, explanation: item.explanation, knowledgePoint: item.knowledgePoint,
    difficulty: item.difficulty, sourceRefs: item.sourceRefs })) as BankQuestionInput)
  baseline.value = JSON.stringify(form)
}
function handleError(cause: unknown, fallback: string) {
  error.value = describeApiError(cause, fallback)
  if (cause instanceof ApiClientError) {
    conflict.value = cause.code === 'VERSION_CONFLICT'
    duplicateId.value = cause.code === 'QUESTION_BANK_DUPLICATE' ? String((cause.details as { itemId?: string })?.itemId ?? '') : ''
  }
}
async function load(id = props.itemId, intent = props.intent) {
  const token = ++request
  loading.value = true; error.value = ''; conflict.value = false; duplicateId.value = ''; record.value = null
  mode.value = intent
  if (intent === 'create') {
    Object.assign(form, { ...newQuestionContent(), knowledgePoint: '', difficulty: 'normal',
      sourceRefs: [{ libraryFileId: '', locator: '', quote: '' }] })
    baseline.value = JSON.stringify(form); loading.value = false
    return
  }
  try {
    const result = await apiFetch<BankItemDTO>(`/api/admin/question-bank/${encodeURIComponent(id)}`, { silent: true })
    if (token !== request) return
    record.value = result; fill(result)
  } catch (cause) { if (token === request) handleError(cause, '无法加载题目') }
  finally { if (token === request) loading.value = false }
}
watch([open, () => props.itemId], ([visible]) => {
  if (visible) void load()
  else { ++request; loading.value = false }
}, { immediate: true })

async function allowDiscard(): Promise<boolean> {
  if (!dirty.value) return true
  try {
    await ElMessageBox.confirm('放弃这道题尚未保存的修改？', '未保存的内容', { confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning' })
    return true
  } catch { return false }
}
async function beforeClose(done: () => void) { if (!busy.value && await allowDiscard()) done() }
onBeforeRouteLeave(async () => !open.value || (!busy.value && await allowDiscard()))
onBeforeRouteUpdate(async (to, from) => !open.value || (!busy.value && (to.query.itemId === from.query.itemId || await allowDiscard())))

async function save() {
  if (busy.value) return
  busy.value = true; error.value = ''; conflict.value = false; duplicateId.value = ''
  try {
    const id = record.value?.id
    const result = await apiFetch<BankItemDTO>(id ? `/api/admin/question-bank/${id}` : '/api/admin/question-bank', {
      method: id ? 'PUT' : 'POST', body: id ? { expectedVersion: record.value!.version, question: form } : form, silent: true,
    })
    record.value = result; fill(result); mode.value = 'view'
    ElMessage.success(result.status === 'disabled' ? '已保存，题目仍为停用状态' : '已保存为待审核，请核对后审核启用')
    emit('changed'); await reloadCatalog()
  } catch (cause) { handleError(cause, '保存题目失败') }
  finally { busy.value = false }
}
async function changeState(action: 'approve' | 'disable' | 'delete') {
  const item = record.value
  if (!item || busy.value) return
  if (action === 'delete') {
    try { await ElMessageBox.confirm('删除后不可恢复，已复制到考试的试题不受影响。', '删除题库题目', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }) }
    catch { return }
  }
  busy.value = true; error.value = ''; conflict.value = false
  try {
    if (action === 'delete') {
      await apiFetch(`/api/admin/question-bank/${item.id}`, { method: 'DELETE', query: { expectedVersion: item.version }, silent: true })
      open.value = false
    } else {
      const result = await apiFetch<BankItemDTO>(`/api/admin/question-bank/${item.id}/${action}`, { method: 'POST', body: { expectedVersion: item.version }, silent: true })
      record.value = result; fill(result)
    }
    ElMessage.success(action === 'approve' ? '已审核启用，可用于组卷' : action === 'disable' ? '已停用，不再参与组卷' : '已删除')
    emit('changed')
  } catch (cause) { handleError(cause, '操作失败') }
  finally { busy.value = false }
}
async function loadLatest() { if (await allowDiscard()) await load(record.value?.id ?? props.itemId, 'view') }
function showSource(fileId: string) { preview.fileId = fileId; preview.open = true }
function updateContent(value: QuestionContentInput) { Object.assign(form, value) }
</script>

<template>
  <el-drawer v-model="open" :title="mode === 'create' ? '新增题目' : mode === 'edit' ? '编辑题目' : '题目详情'"
    size="min(820px, 96vw)" :before-close="beforeClose" :close-on-click-modal="false" append-to-body>
    <StatePanel v-if="loading" state="loading" title="正在读取题目…" />
    <el-alert v-if="error" type="error" :closable="false" :title="error" show-icon class="bank-drawer__notice" />
    <div v-if="conflict" class="bank-drawer__notice">
      <p>本地表单已保留；可先复制内容，再载入服务器版本。</p>
      <el-input :model-value="JSON.stringify(form, null, 2)" type="textarea" :rows="4" readonly aria-label="可复制的本地题目内容" />
      <el-button @click="loadLatest">载入服务器版本</el-button>
    </div>
    <NuxtLink v-if="duplicateId" :to="`/admin/question-bank?itemId=${duplicateId}`" target="_blank" rel="noopener">查看已有题目</NuxtLink>
    <el-button v-if="!loading && error && !record && mode !== 'create'" @click="load()">重试</el-button>
    <template v-if="!loading && (record || mode === 'create')">
      <template v-if="mode === 'view' && record">
        <div class="bank-drawer__meta"><el-tag>{{ BANK_STATUS_LABELS[record.status] }}</el-tag><span>{{ record.knowledgePoint }}</span><span>{{ DIFFICULTY_LABELS[record.difficulty] }}</span><span>v{{ record.version }}</span></div>
        <AdminQuestionContentView :question="record" />
        <h3>资料出处</h3>
        <section v-for="(ref, index) in record.sourceRefs" :key="index" class="bank-drawer__source">
          <el-button text type="primary" @click="showSource(ref.libraryFileId)">{{ record.sources.find(source => source.libraryFileId === ref.libraryFileId)?.originalName }} · {{ ref.locator }}</el-button>
          <blockquote>{{ ref.quote }}</blockquote>
        </section>
        <p v-if="record.reviewedBy" class="zj-muted">最近审核：{{ record.reviewedBy }} · {{ formatDateTime(record.reviewedAt) }}</p>
        <NuxtLink v-if="record.originExamId" :to="`/admin/exams/${record.originExamId}`">查看来源场次</NuxtLink>
        <h3>作答表现</h3>
        <p class="zj-muted">同一姓名取最早一次可比的已作答记录；未满分包含部分得分，不含未作答。</p>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="已作答人数">{{ record.mistakeStats.sampleSize }}</el-descriptions-item>
          <el-descriptions-item label="未满分率">{{ record.mistakeStats.errorRate === null ? '—' : `${(record.mistakeStats.errorRate * 100).toFixed(1)}%` }}</el-descriptions-item>
          <el-descriptions-item label="满分">{{ record.mistakeStats.correctCount }}</el-descriptions-item>
          <el-descriptions-item label="部分得分">{{ record.mistakeStats.partialCount }}</el-descriptions-item>
          <el-descriptions-item label="已作答零分">{{ record.mistakeStats.zeroCount }}</el-descriptions-item>
          <el-descriptions-item label="仅未作答">{{ record.mistakeStats.unansweredCount }}</el-descriptions-item>
        </el-descriptions>
        <p v-if="record.mistakeStats.sampleSize === 0" class="zj-muted">暂无作答数据</p>
        <p v-else-if="record.mistakeStats.sampleSize < BANK_MISTAKE_MIN_SAMPLE" class="zj-muted">样本不足：{{ record.mistakeStats.sampleSize }} 人</p>
        <el-tag v-else-if="record.mistakeStats.isErrorProne" type="danger">易错</el-tag>
      </template>
      <el-form v-else label-position="top" :disabled="busy">
        <el-form-item label="主要知识点" required>
          <el-select v-model="form.knowledgePoint" filterable allow-create default-first-option placeholder="选择或输入知识点">
            <el-option v-for="point in catalog?.knowledgePoints ?? []" :key="point" :label="point" :value="point" />
          </el-select>
          <span v-if="Array.from(form.knowledgePoint).length > MAX_KNOWLEDGE_POINT_CHARS" class="bank-drawer__error">最多 {{ MAX_KNOWLEDGE_POINT_CHARS }} 字</span>
        </el-form-item>
        <el-form-item label="难度"><el-radio-group v-model="form.difficulty"><el-radio v-for="(label, level) in DIFFICULTY_LABELS" :key="level" :value="level">{{ label }}</el-radio></el-radio-group></el-form-item>
        <AdminQuestionContentFields :model-value="form" @update:model-value="updateContent" />
        <el-form-item label="资料引用" required>
          <div class="bank-drawer__sources">
            <el-alert v-if="catalogError" type="error" :closable="false" title="资料列表加载失败"><el-button @click="reloadCatalog()">重试</el-button></el-alert>
            <p v-if="catalog && !catalog.files.length">还没有可用资料。<NuxtLink to="/admin/library" target="_blank" rel="noopener">去资料库上传</NuxtLink></p>
            <section v-for="(ref, index) in form.sourceRefs" :key="index" class="bank-drawer__source">
              <el-select v-model="ref.libraryFileId" filterable placeholder="选择资料库文件" aria-label="引用资料">
                <el-option v-for="file in catalog?.files ?? []" :key="file.id" :label="file.originalName" :value="file.id" />
              </el-select>
              <el-button text type="primary" :disabled="!ref.libraryFileId" @click="showSource(ref.libraryFileId)">查看原文与定位</el-button>
              <el-input v-model="ref.locator" placeholder="定位，如 line12 / para3 / p2" aria-label="引用定位" />
              <el-input v-model="ref.quote" type="textarea" :rows="3" :maxlength="MAX_QUOTE_CHARS" show-word-limit placeholder="复制该定位段中的原文摘录" aria-label="引用摘录" />
              <el-button text type="danger" :disabled="form.sourceRefs.length <= 1" @click="form.sourceRefs.splice(index, 1)">删除引用</el-button>
            </section>
            <el-button text type="primary" @click="form.sourceRefs.push({ libraryFileId: '', locator: '', quote: '' })">添加引用</el-button>
          </div>
        </el-form-item>
      </el-form>
    </template>
    <template #footer>
      <div class="bank-drawer__actions">
        <el-button :disabled="busy" @click="beforeClose(() => open = false)">关闭</el-button>
        <template v-if="!readOnly && !loading">
          <el-button v-if="mode !== 'view'" type="primary" :loading="busy" @click="save">{{ record?.status === 'disabled' ? '保存并保持停用' : '保存待审核' }}</el-button>
          <template v-else-if="record">
            <el-button :disabled="busy" @click="mode = 'edit'">编辑</el-button>
            <el-button v-if="record.status !== 'active'" :disabled="busy" type="danger" plain @click="changeState('delete')">删除</el-button>
            <el-button v-if="record.status === 'active'" :loading="busy" @click="changeState('disable')">停用</el-button>
            <el-button v-else type="primary" :loading="busy" @click="changeState('approve')">审核并启用</el-button>
          </template>
        </template>
      </div>
    </template>
    <AdminLibrarySourcePreview v-model="preview.open" :file-id="preview.fileId" />
  </el-drawer>
</template>
<style scoped>
.bank-drawer__notice { margin-bottom: 16px; }
.bank-drawer__meta, .bank-drawer__actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.bank-drawer__actions { justify-content: flex-end; }
.bank-drawer__sources { width: 100%; display: grid; gap: 16px; }
.bank-drawer__source { padding: 12px; border: 1px solid var(--zj-border); border-radius: var(--zj-radius); margin: 10px 0; }
.bank-drawer__source > * + * { margin-top: 8px; }
.bank-drawer__source blockquote { margin: 8px 0; white-space: pre-wrap; line-height: 1.6; }
.bank-drawer__error { color: var(--zj-danger); }
</style>
