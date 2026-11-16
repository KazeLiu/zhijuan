<script setup lang="ts">
/**
 * 题目编辑（契约 §9.2 / §10.5 / §8.5 #24）：
 * 列表 + 新增 + 编辑 + 上移/下移 + 删除，整体 PUT 保存；配分只读展示服务端结果。
 */
import type {
  AnswerDefinition,
  ExamAdminDTO,
  QuestionAdminDTO,
  QuestionDraftInput,
  QuestionOption,
  QuestionType,
  SourceRef,
  DocumentDTO,
} from '#shared/types'
import {
  MAX_OPTION_TEXT_CHARS,
  MAX_QUESTIONS,
  MAX_QUOTE_CHARS,
  MAX_STEM_CHARS,
  MIN_QUOTE_CHARS,
} from '#shared/constants'
import { QUESTION_TYPE_LABELS } from '#shared/types'

interface Props {
  exam: ExamAdminDTO
  locked?: boolean
  /** 暂停态：题干/选项/答案/解析与排序可改，增删题目与改题型锁定（EXAM_STRUCTURE_LOCKED） */
  structureLocked?: boolean
  externalBusy?: boolean
}
const props = withDefaults(defineProps<Props>(), { locked: false, structureLocked: false, externalBusy: false })
const emit = defineEmits<{ changed: []; 'dirty-change': [dirty: boolean]; 'bank-busy-change': [busy: boolean] }>()

interface DraftQuestion {
  /** 服务端已有题目的 id；新增为 undefined */
  id?: string
  type: QuestionType
  stem: string
  options: QuestionOption[]
  answerDefinition: AnswerDefinition
  explanation: string
  sourceRefs: SourceRef[]
  /** 仅展示：服务端配分 */
  maxScoreUnits: number
}

const drafts = ref<DraftQuestion[]>([])
const originalSignature = ref('')
const saving = ref(false)
const dialogOpen = ref(false)
const saveError = ref('')
const fieldErrors = ref<Record<string, string>>({})
const baseVersion = ref(props.exam.version)
const serverConflict = ref(false)
const selectedIds = ref<string[]>([])
const importOpen = ref(false)
const importedNotice = ref(false)
const importBlocked = computed(() => dirty.value || dialogOpen.value || saving.value || baseVersion.value !== props.exam.version || !!props.exam.activeJob || props.externalBusy)

/** 可入库题目：已保存到服务端的题目（有 id），全选只作用于它们 */
const bankSelectableIds = computed(() => drafts.value.map((question) => question.id).filter((id): id is string => Boolean(id)))
const allBankSelected = computed(() => bankSelectableIds.value.length > 0 && bankSelectableIds.value.every((id) => selectedIds.value.includes(id)))
const someBankSelected = computed(() => !allBankSelected.value && bankSelectableIds.value.some((id) => selectedIds.value.includes(id)))

function toggleAllBank(checked: boolean | string | number): void {
  selectedIds.value = checked ? [...bankSelectableIds.value] : []
}

function toDraft(question: QuestionAdminDTO): DraftQuestion {
  return {
    id: question.id,
    type: question.type,
    stem: question.stem,
    options: question.options.map((option) => ({ ...option })),
    answerDefinition: {
      correctOptionIds: [...question.answerDefinition.correctOptionIds],
      blanks: question.answerDefinition.blanks.map((blank) => ({
        id: blank.id,
        acceptedAnswers: [...blank.acceptedAnswers],
        caseSensitive: blank.caseSensitive,
      })),
    },
    explanation: question.explanation,
    sourceRefs: question.sourceRefs.map((ref) => ({ ...ref })),
    maxScoreUnits: question.maxScoreUnits,
  }
}

function syncFromExam(exam: ExamAdminDTO = props.exam): void {
  drafts.value = exam.questions.map(toDraft)
  selectedIds.value = selectedIds.value.filter((id) => exam.questions.some((question) => question.id === id))
  originalSignature.value = signatureOf(drafts.value)
  baseVersion.value = exam.version
  serverConflict.value = false
  saveError.value = ''
}

function signatureOf(list: DraftQuestion[]): string {
  return JSON.stringify(
    list.map((item) => ({
      id: item.id ?? '',
      type: item.type,
      stem: item.stem,
      options: item.options,
      answerDefinition: item.answerDefinition,
      explanation: item.explanation,
      sourceRefs: item.sourceRefs,
    })),
  )
}

const dirty = computed(() => signatureOf(drafts.value) !== originalSignature.value)
watch(() => dirty.value || dialogOpen.value || saving.value, (value) => emit('dirty-change', value), { immediate: true })
watch(() => props.exam.version, (version, previousVersion) => {
  if (previousVersion === undefined || (!dirty.value && !dialogOpen.value)) {
    syncFromExam()
  } else if (signatureOf(props.exam.questions.map(toDraft)) !== originalSignature.value) {
    serverConflict.value = true
    saveError.value = '服务器题目已发生变化，本地修改已保留。请先复制需要的内容，再放弃修改以载入服务器题目。'
  } else {
    // 其他卡片只改了场次信息，题目草稿继续保留。
    baseVersion.value = version
  }
}, { immediate: true })
const documents = computed<DocumentDTO[]>(() => props.exam.documents.filter((doc) => doc.status === 'parsed'))

const editingIndex = ref(-1)
const dialogError = ref('')
const dialogFieldErrors = ref<Record<string, string>>({})
const form = reactive<DraftQuestion>({
  type: 'single_choice',
  stem: '',
  options: [],
  answerDefinition: { correctOptionIds: [], blanks: [] },
  explanation: '',
  sourceRefs: [],
  maxScoreUnits: 0,
})

const isEditing = computed(() => editingIndex.value >= 0)
const dialogTitle = computed(() => (isEditing.value ? `编辑第 ${editingIndex.value + 1} 题` : '新增题目'))

function openCreate(): void {
  editingIndex.value = -1
  dialogError.value = ''
  dialogFieldErrors.value = {}
  form.id = undefined
  form.type = 'single_choice'
  form.stem = ''
  form.options = newQuestionContent().options
  form.answerDefinition = { correctOptionIds: [], blanks: [] }
  form.explanation = ''
  form.sourceRefs = [newSourceRef()]
  form.maxScoreUnits = 0
  dialogOpen.value = true
}

function openEdit(index: number): void {
  const target = drafts.value[index]
  if (!target) return
  editingIndex.value = index
  dialogError.value = ''
  dialogFieldErrors.value = {}
  form.id = target.id
  form.type = target.type
  form.stem = target.stem
  form.options = target.options.map((option) => ({ ...option }))
  form.answerDefinition = {
    correctOptionIds: [...target.answerDefinition.correctOptionIds],
    blanks: target.answerDefinition.blanks.map((blank) => ({
      id: blank.id,
      acceptedAnswers: [...blank.acceptedAnswers],
      caseSensitive: blank.caseSensitive,
    })),
  }
  form.explanation = target.explanation
  form.sourceRefs = target.sourceRefs.length ? target.sourceRefs.map((ref) => ({ ...ref })) : [newSourceRef()]
  form.maxScoreUnits = target.maxScoreUnits
  dialogOpen.value = true
}

function newSourceRef(): SourceRef {
  return { documentId: documents.value[0]?.id ?? '', locator: '', quote: '' }
}

function addSourceRef(): void {
  form.sourceRefs.push(newSourceRef())
}

function removeSourceRef(index: number): void {
  if (form.sourceRefs.length <= 1) return
  form.sourceRefs.splice(index, 1)
}

function validateForm(): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!form.stem.trim()) errors.stem = '题干不能为空'
  if (form.stem.trim().length > MAX_STEM_CHARS) errors.stem = `题干最多 ${MAX_STEM_CHARS} 字`
  if (!form.explanation.trim()) errors.explanation = '解析不能为空'

  if (form.type === 'single_choice' || form.type === 'multiple_choice' || form.type === 'true_false') {
    if (form.options.some((option) => !option.text.trim())) errors.options = '选项内容不能为空'
    if (form.options.some((option) => option.text.trim().length > MAX_OPTION_TEXT_CHARS)) {
      errors.options = `每个选项最多 ${MAX_OPTION_TEXT_CHARS} 字`
    }
    const correct = form.answerDefinition.correctOptionIds
    if (form.type === 'single_choice' && correct.length !== 1) errors.correct = '单选题需恰好 1 个正确选项'
    if (form.type === 'true_false' && correct.length !== 1) errors.correct = '判断题需选择「正确」或「错误」'
    if (form.type === 'multiple_choice' && (correct.length < 2 || correct.length > 3)) {
      errors.correct = '多选题正确答案需 2–3 项'
    }
  }

  if (form.type === 'fill_blank') {
    if (form.answerDefinition.blanks.length === 0) errors.blanks = '填空题至少 1 个空'
    form.answerDefinition.blanks.forEach((blank, index) => {
      const answers = blank.acceptedAnswers.map((item) => item.trim()).filter(Boolean)
      if (answers.length === 0) errors.blanks = `第 ${index + 1} 空至少需要一个可接受答案`
      if (answers.some((item) => item.length > 20)) errors.blanks = `第 ${index + 1} 空的答案最多 20 字`
    })
  }

  const refs = form.sourceRefs.filter((ref) => ref.documentId && ref.locator.trim() && ref.quote.trim())
  if (refs.length === 0) errors.sourceRefs = '至少需要 1 条完整资料引用（资料 + 定位 + 摘录）'
  form.sourceRefs.forEach((ref, index) => {
    const quote = ref.quote.replace(/\s+/g, '')
    if (quote && quote.length < MIN_QUOTE_CHARS) errors.sourceRefs = `第 ${index + 1} 条摘录归一化后至少 ${MIN_QUOTE_CHARS} 字`
    if (ref.quote.length > MAX_QUOTE_CHARS) errors.sourceRefs = `第 ${index + 1} 条摘录最多 ${MAX_QUOTE_CHARS} 字`
  })

  return errors
}

function applyForm(): void {
  const errors = validateForm()
  dialogFieldErrors.value = errors
  if (Object.keys(errors).length > 0) return

  const normalized: DraftQuestion = {
    id: form.id,
    type: form.type,
    stem: form.stem.trim(),
    options: form.options.map((option) => ({ id: option.id, text: option.text.trim() })),
    answerDefinition: {
      correctOptionIds: form.type === 'fill_blank' ? [] : [...form.answerDefinition.correctOptionIds].sort(),
      blanks:
        form.type === 'fill_blank'
          ? form.answerDefinition.blanks.map((blank, index) => ({
              id: `b${index + 1}`,
              acceptedAnswers: Array.from(
                new Set(blank.acceptedAnswers.map((item) => item.trim()).filter(Boolean)),
              ),
              caseSensitive: blank.caseSensitive,
            }))
          : [],
    },
    explanation: form.explanation.trim(),
    sourceRefs: form.sourceRefs
      .filter((ref) => ref.documentId && ref.locator.trim() && ref.quote.trim())
      .map((ref) => ({ documentId: ref.documentId, locator: ref.locator.trim(), quote: ref.quote.trim() })),
    maxScoreUnits: form.maxScoreUnits,
  }

  if (editingIndex.value >= 0) {
    drafts.value.splice(editingIndex.value, 1, normalized)
  } else {
    if (drafts.value.length >= MAX_QUESTIONS) {
      dialogError.value = `单场次最多 ${MAX_QUESTIONS} 题`
      return
    }
    drafts.value.push(normalized)
  }
  dialogOpen.value = false
}

function moveUp(index: number): void {
  if (index <= 0) return
  const list = drafts.value
  const current = list[index]
  const previous = list[index - 1]
  if (!current || !previous) return
  list.splice(index - 1, 2, current, previous)
}

function moveDown(index: number): void {
  const list = drafts.value
  if (index >= list.length - 1) return
  const current = list[index]
  const next = list[index + 1]
  if (!current || !next) return
  list.splice(index, 2, next, current)
}

async function removeQuestion(index: number): Promise<void> {
  if (props.structureLocked) return
  const target = drafts.value[index]
  if (!target) return
  try {
    await ElMessageBox.confirm(`删除第 ${index + 1} 题？保存后不可恢复。`, '删除题目', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  drafts.value.splice(index, 1)
}

async function discardChanges(): Promise<void> {
  if (!dirty.value && !serverConflict.value) return
  try {
    await ElMessageBox.confirm('放弃本次未保存的题目修改？', '放弃修改', {
      type: 'warning',
      confirmButtonText: '放弃',
      cancelButtonText: '继续编辑',
    })
  } catch {
    return
  }
  syncFromExam()
}

async function save(): Promise<void> {
  if (serverConflict.value || props.locked) return
  saving.value = true
  saveError.value = ''
  fieldErrors.value = {}
  try {
    const payload = {
      expectedVersion: baseVersion.value,
      questions: drafts.value.map<QuestionDraftInput>((item) => ({
        ...(item.id ? { id: item.id } : {}),
        type: item.type,
        stem: item.stem,
        options: item.options,
        answerDefinition: item.answerDefinition,
        explanation: item.explanation,
        sourceRefs: item.sourceRefs,
      })),
    }
    const updated = await apiFetch<ExamAdminDTO & { syncedBankItems: number; skippedBankItems: number }>(`/api/admin/exams/${props.exam.id}/questions`, {
      method: 'PUT',
      body: payload,
      silent: true,
    })
    syncFromExam(updated)
    ElMessage.success(props.structureLocked
      ? '题目已保存，已交卷成绩已重新核算，人工复核分保留'
      : '题目已保存，分值已按整卷 100 分重新分配')
    if (updated.syncedBankItems > 0) ElMessage.info(`已同步 ${updated.syncedBankItems} 条题库题目`)
    emit('changed')
  } catch (error) {
    fieldErrors.value = readFieldErrors(error)
    if (error instanceof ApiClientError && error.code === 'VERSION_CONFLICT') {
      saveError.value = '场次数据已被其他操作更新，请刷新后重试'
      emit('changed')
    } else {
      saveError.value = describeLifecycleError(error, '保存题目失败')
    }
  } finally {
    saving.value = false
  }
}

const typeTag: Record<QuestionType, 'primary' | 'success' | 'warning' | 'info'> = {
  single_choice: 'primary',
  multiple_choice: 'success',
  true_false: 'warning',
  fill_blank: 'info',
}

function toggleBankSelection(id: string, checked: boolean) {
  selectedIds.value = checked ? [...selectedIds.value, id] : selectedIds.value.filter((item) => item !== id)
}
function bankOrigin(question: DraftQuestion) { return props.exam.questions.find((item) => item.id === question.id)?.bankOrigin }
function imported() { importOpen.value = false; selectedIds.value = []; importedNotice.value = true }
</script>

<template>
  <el-card shadow="never" class="qs">
    <template #header>
      <div class="qs__head">
        <div>
          <span class="qs__title">题目编辑</span>
          <span class="zj-muted qs__meta">共 {{ drafts.length }} 题 · 配分由服务端按整卷 100 分自动分配（只读）</span>
        </div>
        <div class="qs__actions">
          <div class="qs__select-all">
            <el-checkbox
              :model-value="allBankSelected"
              :indeterminate="someBankSelected"
              :disabled="importBlocked || bankSelectableIds.length === 0"
              @update:model-value="toggleAllBank"
            >
              全选可入库题目
            </el-checkbox>
            <span class="zj-muted zj-tabular">已选 {{ selectedIds.length }} / {{ bankSelectableIds.length }}</span>
          </div>
          <el-button :disabled="importBlocked || !selectedIds.length" @click="importOpen = true">存入题库（{{ selectedIds.length }}）</el-button>
          <el-button type="primary" :disabled="locked || structureLocked || saving || !!exam.activeJob" @click="openCreate">新增题目</el-button>
          <el-button :disabled="(!dirty && !serverConflict) || saving" @click="discardChanges">放弃修改</el-button>
          <el-button type="primary" plain :loading="saving" :disabled="locked || !dirty || serverConflict" @click="save">
            保存全部题目
          </el-button>
        </div>
      </div>
    </template>

    <p v-if="importedNotice">已存入题库，可直接用于组卷。<NuxtLink to="/admin/question-bank">查看题库</NuxtLink></p>

    <el-alert
      v-if="locked"
      type="info"
      :closable="false"
      show-icon
      class="qs__alert"
      title="场次已发布、已有答卷或正在出题，题目暂不可修改。"
    />
    <el-alert
      v-if="structureLocked && !locked"
      type="info"
      :closable="false"
      show-icon
      class="qs__alert"
      title="场次已暂停：只能修改题干、选项、答案与解析，不能增删题目或改题型。"
    />
    <el-alert
      v-if="exam.activeJob && isJobActive(exam.activeJob.status)"
      type="warning"
      :closable="false"
      show-icon
      class="qs__alert"
      title="出题任务进行中，暂时不能编辑题目。"
    />
    <el-alert v-if="dirty" type="warning" :closable="false" show-icon class="qs__alert"
      title="题目有未保存的修改，保存后才对考生生效。" />
    <el-alert v-if="saveError" type="error" :closable="false" show-icon :title="saveError" class="qs__alert" />
    <el-alert v-if="Object.keys(fieldErrors).length" type="error" :closable="false" class="qs__alert">
      <template #title><span>服务端校验未通过</span></template>
      <ul class="qs__field-errors">
        <li v-for="(message, field) in fieldErrors" :key="field">{{ field }}：{{ message }}</li>
      </ul>
    </el-alert>

    <el-empty v-if="drafts.length === 0" description="还没有题目。先保存出题设定并让 AI 出题，或手动新增题目。" />

    <ol v-else class="qs__list">
      <li v-for="(question, index) in drafts" :key="question.id ?? `new-${index}`" class="qs__item">
        <div class="qs__item-main">
          <div class="qs__item-title">
            <el-checkbox v-if="question.id" :model-value="selectedIds.includes(question.id)" :disabled="importBlocked" :aria-label="`选择第 ${index + 1} 题入库`"
              @update:model-value="toggleBankSelection(question.id!, Boolean($event))" />
            <span class="qs__index zj-tabular">{{ index + 1 }}</span>
            <el-tag :type="typeTag[question.type]" effect="plain" size="small">
              {{ QUESTION_TYPE_LABELS[question.type] }}
            </el-tag>
            <span class="zj-muted qs__score zj-tabular">
              满分 {{ question.maxScoreUnits ? formatScoreUnits(question.maxScoreUnits) : '保存后分配' }}
            </span>
          </div>
          <AdminQuestionContentView :question="question" highlight-correct class="qs__content" />
          <p v-if="bankOrigin(question)" class="zj-muted">
            <span v-if="bankOrigin(question)?.deleted">来源题库题目已删除</span>
            <NuxtLink v-else :to="`/admin/question-bank?itemId=${bankOrigin(question)?.itemId}`">来源题库 · v{{ bankOrigin(question)?.version }}</NuxtLink>
            · 本场修改不会同步到题库
          </p>
        </div>
        <div class="qs__item-actions">
          <el-button text type="primary" :disabled="locked || saving" @click="openEdit(index)">编辑</el-button>
          <el-button text :disabled="locked || structureLocked || saving || index === 0" @click="moveUp(index)">上移</el-button>
          <el-button text :disabled="locked || structureLocked || saving || index === drafts.length - 1" @click="moveDown(index)">下移</el-button>
          <el-button text type="danger" :disabled="locked || structureLocked || saving" @click="removeQuestion(index)">删除</el-button>
        </div>
      </li>
    </ol>

    <el-dialog v-model="dialogOpen" :title="dialogTitle" width="min(760px, 95vw)" top="6vh">
      <el-form label-position="top" class="qs__form">
        <AdminQuestionContentFields :model-value="form" :errors="dialogFieldErrors" :type-locked="structureLocked" @update:model-value="Object.assign(form, $event)" />

        <el-form-item label="资料引用（至少 1 条：资料 + 定位 + 摘录）" :error="dialogFieldErrors.sourceRefs">
          <div class="qs__refs">
            <div v-for="(ref, refIndex) in form.sourceRefs" :key="refIndex" class="qs__ref">
              <el-select v-model="ref.documentId" placeholder="选择资料" class="qs__ref-doc">
                <el-option v-for="doc in documents" :key="doc.id" :label="doc.originalName" :value="doc.id" />
              </el-select>
              <el-input v-model="ref.locator" placeholder="定位，如 p12 / para7 / line3-9" class="qs__ref-locator" />
              <el-input
                v-model="ref.quote"
                type="textarea"
                :rows="2"
                :maxlength="MAX_QUOTE_CHARS"
                show-word-limit
                placeholder="原文摘录，须能在该定位内命中"
              />
              <el-button text type="danger" :disabled="form.sourceRefs.length <= 1" @click="removeSourceRef(refIndex)">
                删除引用
              </el-button>
            </div>
            <el-button text type="primary" @click="addSourceRef">添加引用</el-button>
          </div>
        </el-form-item>
      </el-form>

      <el-alert v-if="dialogError" type="error" :closable="false" show-icon :title="dialogError" />

      <template #footer>
        <el-button @click="dialogOpen = false">取消</el-button>
        <el-button type="primary" @click="applyForm">确定</el-button>
      </template>
    </el-dialog>
    <AdminExamToBankDialog v-model="importOpen" :exam="exam" :question-ids="selectedIds" @completed="imported" @busy-change="emit('bank-busy-change', $event)" />
  </el-card>
</template>

<style scoped>
.qs__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.qs__title {
  font-size: 17px;
  font-weight: 600;
  margin-right: 10px;
}

.qs__meta {
  font-size: 13px;
}

.qs__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.qs__alert {
  margin-bottom: 12px;
}

.qs__field-errors {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: 14px;
}

.qs__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.qs__item {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: space-between;
  padding: 14px 0;
  border-bottom: 1px solid var(--zj-border);
}

.qs__item:last-child {
  border-bottom: none;
}

.qs__item-main {
  flex: 1 1 320px;
  min-width: 0;
}

.qs__item-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.qs__index {
  font-weight: 700;
}

.qs__score {
  font-size: 13px;
}

.qs__content {
  margin-top: 8px;
}

.qs__select-all {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.qs__item-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: flex-start;
}

.qs__refs {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}

.qs__ref {
  border: 1px solid var(--zj-border);
  border-radius: var(--zj-radius);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.qs__ref-doc {
  width: 100%;
}

.qs__ref-locator {
  width: 100%;
}
</style>
