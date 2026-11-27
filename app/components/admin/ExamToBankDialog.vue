<script setup lang="ts">
import type { BankItemDTO, Difficulty, ExamAdminDTO, QuestionAdminDTO } from '#shared/types'
import { DIFFICULTY_LABELS } from '#shared/types'

/** 契约 §5.5：AI 知识点建议（degraded=true 表示用了兜底值） */
interface KnowledgeSuggestionItem {
  questionId: string
  knowledgePoint: string
  source: 'ai' | 'fallback'
}
interface KnowledgeSuggestionResponse {
  items: KnowledgeSuggestionItem[]
  degraded: boolean
  message: string
}

const open = defineModel<boolean>({ required: true })
const props = defineProps<{ exam: ExamAdminDTO; questionIds: string[] }>()
const emit = defineEmits<{ completed: []; 'busy-change': [busy: boolean] }>()
const { data: catalog, error: catalogError, refresh: reloadCatalog } = await useBankCatalog()
const items = ref<Array<{ question: QuestionAdminDTO; knowledgePoint: string; difficulty: Difficulty; source?: 'ai' | 'fallback' }>>([])
const bulk = reactive({ knowledgePoint: '', difficulty: 'normal' as Difficulty })
const busy = ref(false)
const suggesting = ref(false)
const error = ref('')
const duplicateId = ref('')
const version = ref(0)
const suggestion = reactive({ degraded: false, message: '', error: '' })
const preview = reactive({ open: false, id: '' })
const suggestionBatchSize = 50
let suggestionRun = 0

watch(open, (visible) => {
  if (!visible) {
    suggestionRun += 1
    suggesting.value = false
    return
  }
  version.value = props.exam.version; error.value = ''; duplicateId.value = ''
  bulk.knowledgePoint = ''; bulk.difficulty = props.exam.blueprint.difficulty
  suggestion.degraded = false; suggestion.message = ''; suggestion.error = ''
  items.value = props.questionIds.map((id) => ({ question: JSON.parse(JSON.stringify(props.exam.questions.find((question) => question.id === id)!)) as QuestionAdminDTO,
    knowledgePoint: '', difficulty: props.exam.blueprint.difficulty }))
  // 打开即请求 AI 知识点建议并填入，随后仍可逐题修改或「应用到全部」
  void suggestKnowledgePoints()
})

/** 请求 AI 知识点建议：成功后按 questionId 回填，失败只提示不阻塞手动填写 */
async function suggestKnowledgePoints(): Promise<void> {
  const ids = items.value.map((item) => item.question.id)
  if (ids.length === 0) return
  const run = ++suggestionRun
  const examId = props.exam.id
  const initialPoints = new Map(items.value.map((item) => [item.question.id, item.knowledgePoint]))
  suggesting.value = true
  suggestion.error = ''
  suggestion.degraded = false
  suggestion.message = ''
  const messages = new Set<string>()
  try {
    for (let offset = 0; offset < ids.length; offset += suggestionBatchSize) {
      const result = await apiFetch<KnowledgeSuggestionResponse>(
        `/api/admin/exams/${examId}/questions/suggest-knowledge-points`,
        { method: 'POST', body: { questionIds: ids.slice(offset, offset + suggestionBatchSize) }, silent: true },
      )
      if (run !== suggestionRun) return
      const byId = new Map(result.items.map((entry) => [entry.questionId, entry]))
      for (const item of items.value) {
        const entry = byId.get(item.question.id)
        if (!entry || item.knowledgePoint !== initialPoints.get(item.question.id)) continue
        if (entry.knowledgePoint) item.knowledgePoint = entry.knowledgePoint
        item.source = entry.source
      }
      suggestion.degraded ||= result.degraded
      if (result.message) messages.add(result.message)
      suggestion.message = [...messages].join('；')
    }
  } catch (cause) {
    if (run !== suggestionRun) return
    suggestion.error = describeApiError(cause, 'AI 知识点建议获取失败，请手动填写')
  } finally {
    if (run === suggestionRun) suggesting.value = false
  }
}

function applyBulk() { for (const item of items.value) { item.knowledgePoint = bulk.knowledgePoint; item.difficulty = bulk.difficulty } }

async function submit() {
  if (busy.value) return
  busy.value = true; emit('busy-change', true); error.value = ''; duplicateId.value = ''
  try {
    await apiFetch<BankItemDTO[]>(`/api/admin/exams/${props.exam.id}/questions/to-bank`, { method: 'POST', body: {
      expectedExamVersion: version.value, items: items.value.map((item) => ({ questionId: item.question.id, knowledgePoint: item.knowledgePoint, difficulty: item.difficulty })),
    }, silent: true })
    ElMessage.success('已存入题库，可直接用于组卷'); open.value = false; emit('completed'); await reloadCatalog()
  } catch (cause) {
    error.value = describeApiError(cause, '入库失败，整批未写入')
    if (cause instanceof ApiClientError && cause.code === 'QUESTION_BANK_DUPLICATE') duplicateId.value = String((cause.details as { itemId?: string })?.itemId ?? '')
  } finally { busy.value = false; emit('busy-change', false) }
}
</script>
<template>
  <el-dialog v-model="open" title="存入题库" width="min(900px, 96vw)" :show-close="!busy" :close-on-click-modal="false" :close-on-press-escape="!busy">
    <el-alert v-if="catalogError" type="error" :closable="false" title="知识点候选加载失败，仍可手动输入"><el-button @click="reloadCatalog()">重试</el-button></el-alert>
    <el-alert
      v-if="suggestion.error"
      type="warning"
      :closable="false"
      show-icon
      class="to-bank__suggest-alert"
      :title="suggestion.error"
    />
    <el-alert
      v-else-if="suggestion.message"
      type="warning"
      :closable="false"
      show-icon
      class="to-bank__suggest-alert"
      :title="suggestion.message"
    />
    <p v-else-if="suggesting" class="to-bank__suggesting zj-muted">正在匹配已有知识点…</p>
    <div class="to-bank__bulk">
      <AdminKnowledgePointInput v-model="bulk.knowledgePoint" :suggestions="catalog?.knowledgePoints ?? []" placeholder="批量填写知识点" />
      <el-select v-model="bulk.difficulty" aria-label="批量难度"><el-option v-for="(label, level) in DIFFICULTY_LABELS" :key="level" :label="label" :value="level" /></el-select>
      <el-button :disabled="busy" @click="applyBulk">应用到全部</el-button>
      <el-button :disabled="busy || suggesting" @click="suggestKnowledgePoints">重新匹配知识点</el-button>
    </div>
    <el-alert v-if="error" type="error" :title="error" :closable="false" show-icon />
    <NuxtLink v-if="duplicateId" :to="`/admin/question-bank?itemId=${duplicateId}`" target="_blank" rel="noopener">查看已有题目</NuxtLink>
    <el-form :disabled="busy" label-position="top">
      <section v-for="item in items" :key="item.question.id" class="to-bank__item">
        <h3>第 {{ item.question.position }} 题</h3>
        <AdminQuestionContentView :question="item.question" highlight-correct />
        <div v-for="(ref, index) in item.question.sourceRefs" :key="index" class="to-bank__ref">
          <el-button text type="primary" :disabled="!exam.documents.find(doc => doc.id === ref.documentId)?.libraryFileId"
            @click="preview.id = exam.documents.find(doc => doc.id === ref.documentId)!.libraryFileId!; preview.open = true">
            {{ exam.documents.find(doc => doc.id === ref.documentId)?.originalName }} · {{ ref.locator }}
          </el-button>
          <blockquote>{{ ref.quote }}</blockquote>
        </div>
        <el-form-item label="主要知识点" required>
          <AdminKnowledgePointInput v-model="item.knowledgePoint" :suggestions="catalog?.knowledgePoints ?? []" />
          <el-tag v-if="item.source" size="small" effect="plain" :type="item.source === 'ai' ? 'success' : 'info'" class="to-bank__source">
            {{ item.source === 'ai' ? 'AI 建议' : '兜底建议' }}
          </el-tag>
        </el-form-item>
        <el-form-item label="难度"><el-radio-group v-model="item.difficulty"><el-radio v-for="(label, level) in DIFFICULTY_LABELS" :key="level" :value="level">{{ label }}</el-radio></el-radio-group></el-form-item>
      </section>
    </el-form>
    <template #footer><el-button :disabled="busy" @click="open = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="suggesting || items.some(item => !item.knowledgePoint.trim())" @click="submit">存入 {{ items.length }} 题</el-button></template>
    <AdminLibrarySourcePreview v-model="preview.open" :file-id="preview.id" />
  </el-dialog>
</template>
<style scoped>
.to-bank__bulk { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.to-bank__bulk .el-select { flex: 1; min-width: 180px; }
.to-bank__bulk .zj-kp-input { flex: 1 1 240px; min-width: 0; }
.to-bank__suggest-alert { margin-bottom: 12px; }
.to-bank__suggesting { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; }
.to-bank__item { padding: 16px 0; border-bottom: 1px solid var(--zj-border); }
.to-bank__ref { margin-bottom: 16px; }
.to-bank__ref blockquote { margin: 8px 0; white-space: pre-wrap; line-height: 1.6; }
.to-bank__source { margin-left: 8px; }
</style>
