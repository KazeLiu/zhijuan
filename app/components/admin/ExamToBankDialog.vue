<script setup lang="ts">
import type { BankItemDTO, Difficulty, ExamAdminDTO, QuestionAdminDTO } from '#shared/types'
import { DIFFICULTY_LABELS } from '#shared/types'
const open = defineModel<boolean>({ required: true })
const props = defineProps<{ exam: ExamAdminDTO; questionIds: string[] }>()
const emit = defineEmits<{ completed: []; 'busy-change': [busy: boolean] }>()
const { data: catalog, error: catalogError, refresh: reloadCatalog } = await useBankCatalog()
const items = ref<Array<{ question: QuestionAdminDTO; knowledgePoint: string; difficulty: Difficulty }>>([])
const bulk = reactive({ knowledgePoint: '', difficulty: 'normal' as Difficulty })
const busy = ref(false)
const error = ref('')
const duplicateId = ref('')
const version = ref(0)
const preview = reactive({ open: false, id: '' })
watch(open, (visible) => {
  if (!visible) return
  version.value = props.exam.version; error.value = ''; duplicateId.value = ''
  bulk.knowledgePoint = ''; bulk.difficulty = props.exam.blueprint.difficulty
  items.value = props.questionIds.map((id) => ({ question: JSON.parse(JSON.stringify(props.exam.questions.find((question) => question.id === id)!)) as QuestionAdminDTO,
    knowledgePoint: '', difficulty: props.exam.blueprint.difficulty }))
})
function applyBulk() { for (const item of items.value) { item.knowledgePoint = bulk.knowledgePoint; item.difficulty = bulk.difficulty } }
async function submit() {
  if (busy.value) return
  busy.value = true; emit('busy-change', true); error.value = ''; duplicateId.value = ''
  try {
    await apiFetch<BankItemDTO[]>(`/api/admin/exams/${props.exam.id}/questions/to-bank`, { method: 'POST', body: {
      expectedExamVersion: version.value, items: items.value.map((item) => ({ questionId: item.question.id, knowledgePoint: item.knowledgePoint, difficulty: item.difficulty })),
    }, silent: true })
    ElMessage.success('已存入题库，待审核'); open.value = false; emit('completed'); await reloadCatalog()
  } catch (cause) {
    error.value = describeApiError(cause, '入库失败，整批未写入')
    if (cause instanceof ApiClientError && cause.code === 'QUESTION_BANK_DUPLICATE') duplicateId.value = String((cause.details as { itemId?: string })?.itemId ?? '')
  } finally { busy.value = false; emit('busy-change', false) }
}
</script>
<template>
  <el-dialog v-model="open" title="存入题库 · 待审核" width="min(900px, 96vw)" :show-close="!busy" :close-on-click-modal="false" :close-on-press-escape="!busy">
    <el-alert v-if="catalogError" type="error" :closable="false" title="知识点候选加载失败，仍可手动输入"><el-button @click="reloadCatalog()">重试</el-button></el-alert>
    <div class="to-bank__bulk">
      <el-select v-model="bulk.knowledgePoint" filterable allow-create default-first-option placeholder="批量填写知识点" aria-label="批量知识点"><el-option v-for="point in catalog?.knowledgePoints ?? []" :key="point" :label="point" :value="point" /></el-select>
      <el-select v-model="bulk.difficulty" aria-label="批量难度"><el-option v-for="(label, level) in DIFFICULTY_LABELS" :key="level" :label="label" :value="level" /></el-select>
      <el-button :disabled="busy" @click="applyBulk">应用到全部</el-button>
    </div>
    <el-alert v-if="error" type="error" :title="error" :closable="false" show-icon />
    <NuxtLink v-if="duplicateId" :to="`/admin/question-bank?itemId=${duplicateId}`" target="_blank" rel="noopener">查看已有题目</NuxtLink>
    <el-form :disabled="busy" label-position="top">
      <section v-for="item in items" :key="item.question.id" class="to-bank__item">
        <h3>第 {{ item.question.position }} 题</h3>
        <AdminQuestionContentView :question="item.question" />
        <div v-for="(ref, index) in item.question.sourceRefs" :key="index" class="to-bank__ref">
          <el-button text type="primary" :disabled="!exam.documents.find(doc => doc.id === ref.documentId)?.libraryFileId"
            @click="preview.id = exam.documents.find(doc => doc.id === ref.documentId)!.libraryFileId!; preview.open = true">
            {{ exam.documents.find(doc => doc.id === ref.documentId)?.originalName }} · {{ ref.locator }}
          </el-button>
          <blockquote>{{ ref.quote }}</blockquote>
        </div>
        <el-form-item label="主要知识点" required><el-select v-model="item.knowledgePoint" filterable allow-create default-first-option><el-option v-for="point in catalog?.knowledgePoints ?? []" :key="point" :label="point" :value="point" /></el-select></el-form-item>
        <el-form-item label="难度"><el-radio-group v-model="item.difficulty"><el-radio v-for="(label, level) in DIFFICULTY_LABELS" :key="level" :value="level">{{ label }}</el-radio></el-radio-group></el-form-item>
      </section>
    </el-form>
    <template #footer><el-button :disabled="busy" @click="open = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="items.some(item => !item.knowledgePoint.trim())" @click="submit">存入 {{ items.length }} 题，待审核</el-button></template>
    <AdminLibrarySourcePreview v-model="preview.open" :file-id="preview.id" />
  </el-dialog>
</template>
<style scoped>
.to-bank__bulk { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.to-bank__bulk .el-select { flex: 1; min-width: 180px; }
.to-bank__item { padding: 16px 0; border-bottom: 1px solid var(--zj-border); }
.to-bank__ref { margin-bottom: 16px; }
.to-bank__ref blockquote { margin: 6px 0; white-space: pre-wrap; line-height: 1.6; }
</style>
