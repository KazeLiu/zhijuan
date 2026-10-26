<script setup lang="ts">
/**
 * 题目编辑（契约 §9.2 / §10.5 / §8.5 #24）：
 * 列表 + 新增 + 编辑 + 上移/下移 + 删除，整体 PUT 保存；配分只读展示服务端结果。
 */
import type {
  AnswerDefinition,
  BlankDefinition,
  ExamAdminDTO,
  QuestionAdminDTO,
  QuestionDraftInput,
  QuestionOption,
  QuestionType,
  SourceRef,
  DocumentDTO,
} from '#shared/types'
import {
  CHOICE_OPTION_IDS,
  MAX_EXPLANATION_CHARS,
  MAX_OPTION_TEXT_CHARS,
  MAX_QUESTIONS,
  MAX_QUOTE_CHARS,
  MAX_STEM_CHARS,
  MIN_QUOTE_CHARS,
  TRUE_FALSE_OPTIONS,
} from '#shared/constants'
import { QUESTION_TYPE_LABELS } from '#shared/types'

interface Props {
  exam: ExamAdminDTO
  locked?: boolean
}
const props = withDefaults(defineProps<Props>(), { locked: false })
const emit = defineEmits<{ changed: [] }>()

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
const saveError = ref('')
const fieldErrors = ref<Record<string, string>>({})

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

function syncFromExam(): void {
  drafts.value = props.exam.questions.map(toDraft)
  originalSignature.value = signatureOf(drafts.value)
}

watch(() => props.exam.version, syncFromExam, { immediate: true })

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
const documents = computed<DocumentDTO[]>(() => props.exam.documents.filter((doc) => doc.status === 'parsed'))

const dialogOpen = ref(false)
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

function buildOptions(type: QuestionType): QuestionOption[] {
  if (type === 'true_false') return TRUE_FALSE_OPTIONS.map((option) => ({ ...option }))
  if (type === 'fill_blank') return []
  return CHOICE_OPTION_IDS.map((id) => ({ id, text: '' }))
}

function resetAnswerForType(type: QuestionType): void {
  form.answerDefinition = {
    correctOptionIds: [],
    blanks: type === 'fill_blank' ? [newBlank(1)] : [],
  }
}

function newBlank(index: number): BlankDefinition {
  return { id: `b${index}`, acceptedAnswers: [''], caseSensitive: true }
}

function handleTypeChange(type: QuestionType): void {
  form.options = buildOptions(type)
  resetAnswerForType(type)
}

function openCreate(): void {
  editingIndex.value = -1
  dialogError.value = ''
  dialogFieldErrors.value = {}
  form.id = undefined
  form.type = 'single_choice'
  form.stem = ''
  form.options = buildOptions('single_choice')
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

function addOption(): void {
  if (form.type !== 'multiple_choice') return
  const nextId = String.fromCharCode(65 + form.options.length)
  form.options.push({ id: nextId, text: '' })
}

function removeOption(index: number): void {
  if (form.type !== 'multiple_choice' || form.options.length <= 3) return
  const removed = form.options[index]
  form.options.splice(index, 1)
  form.options.forEach((option, position) => {
    option.id = String.fromCharCode(65 + position)
  })
  if (removed) {
    const removedId = String.fromCharCode(65 + index)
    form.answerDefinition.correctOptionIds = form.answerDefinition.correctOptionIds.filter((id) => id !== removedId)
  }
}

function addBlank(): void {
  form.answerDefinition.blanks.push(newBlank(form.answerDefinition.blanks.length + 1))
}

function removeBlank(index: number): void {
  if (form.answerDefinition.blanks.length <= 1) return
  form.answerDefinition.blanks.splice(index, 1)
  form.answerDefinition.blanks.forEach((blank, position) => {
    blank.id = `b${position + 1}`
  })
}

/** acceptedAnswers 编辑用文本：一行一个可接受答案 */
function blankAnswersText(blank: BlankDefinition): string {
  return blank.acceptedAnswers.join('\n')
}

function setBlankAnswers(blank: BlankDefinition, text: string): void {
  blank.acceptedAnswers = text.split('\n')
}

function toggleCorrectOption(optionId: string, checked: boolean): void {
  const current = form.answerDefinition.correctOptionIds
  if (form.type === 'single_choice' || form.type === 'true_false') {
    form.answerDefinition.correctOptionIds = [optionId]
    return
  }
  if (checked) {
    if (!current.includes(optionId)) current.push(optionId)
  } else {
    form.answerDefinition.correctOptionIds = current.filter((id) => id !== optionId)
  }
}

function isCorrect(optionId: string): boolean {
  return form.answerDefinition.correctOptionIds.includes(optionId)
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
  if (!dirty.value) return
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
  saving.value = true
  saveError.value = ''
  fieldErrors.value = {}
  try {
    const payload = {
      expectedVersion: props.exam.version,
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
    await apiFetch<ExamAdminDTO>(`/api/admin/exams/${props.exam.id}/questions`, {
      method: 'PUT',
      body: payload,
      silent: true,
    })
    ElMessage.success('题目已保存，分值已按整卷 100 分重新分配')
    emit('changed')
  } catch (error) {
    fieldErrors.value = readFieldErrors(error)
    if (error instanceof ApiClientError && error.code === 'VERSION_CONFLICT') {
      saveError.value = '场次数据已被其他操作更新，请刷新后重试'
      emit('changed')
    } else {
      saveError.value = describeApiError(error, '保存题目失败')
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

function answerSummary(question: DraftQuestion): string {
  if (question.type === 'fill_blank') {
    return question.answerDefinition.blanks
      .map((blank, index) => `${index + 1}. ${blank.acceptedAnswers.join(' / ')}`)
      .join('；')
  }
  const maps = new Map(question.options.map((option) => [option.id, option.text]))
  return question.answerDefinition.correctOptionIds
    .map((id) => `${id}. ${maps.get(id) ?? ''}`)
    .join('；')
}
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
          <el-button type="primary" :disabled="locked || !!exam.activeJob" @click="openCreate">新增题目</el-button>
          <el-button :disabled="!dirty || saving" @click="discardChanges">放弃修改</el-button>
          <el-button type="primary" plain :loading="saving" :disabled="locked || !dirty" @click="save">
            保存全部题目
          </el-button>
        </div>
      </div>
    </template>

    <el-alert
      v-if="locked"
      type="info"
      :closable="false"
      show-icon
      class="qs__alert"
      title="场次已发布或已有答卷，题目只读。"
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
            <span class="qs__index zj-tabular">{{ index + 1 }}</span>
            <el-tag :type="typeTag[question.type]" effect="plain" size="small">
              {{ QUESTION_TYPE_LABELS[question.type] }}
            </el-tag>
            <span class="zj-muted qs__score zj-tabular">
              满分 {{ question.maxScoreUnits ? formatScoreUnits(question.maxScoreUnits) : '保存后分配' }}
            </span>
          </div>
          <p class="qs__stem">{{ question.stem }}</p>
          <p class="zj-muted qs__answer">答案：{{ answerSummary(question) }}</p>
        </div>
        <div class="qs__item-actions">
          <el-button text type="primary" :disabled="locked" @click="openEdit(index)">编辑</el-button>
          <el-button text :disabled="locked || index === 0" @click="moveUp(index)">上移</el-button>
          <el-button text :disabled="locked || index === drafts.length - 1" @click="moveDown(index)">下移</el-button>
          <el-button text type="danger" :disabled="locked" @click="removeQuestion(index)">删除</el-button>
        </div>
      </li>
    </ol>

    <el-dialog v-model="dialogOpen" :title="dialogTitle" width="min(760px, 95vw)" top="6vh">
      <el-form label-position="top" class="qs__form">
        <el-form-item label="题型">
          <el-select :model-value="form.type" class="qs__type-select" @update:model-value="handleTypeChange">
            <el-option
              v-for="(label, value) in QUESTION_TYPE_LABELS"
              :key="value"
              :label="label"
              :value="value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="题干" :error="dialogFieldErrors.stem">
          <el-input
            v-model="form.stem"
            type="textarea"
            :rows="3"
            :maxlength="MAX_STEM_CHARS"
            show-word-limit
            placeholder="题目正文"
          />
        </el-form-item>

        <template v-if="form.type !== 'fill_blank'">
          <el-form-item
            :label="form.type === 'true_false' ? '判断项与正确答案' : form.type === 'multiple_choice' ? '选项（勾选 2–3 个正确答案）' : '选项（选中 1 个正确答案）'"
            :error="dialogFieldErrors.options || dialogFieldErrors.correct"
          >
            <div class="qs__options">
              <div v-for="(option, optionIndex) in form.options" :key="option.id" class="qs__option">
                <el-checkbox
                  v-if="form.type === 'multiple_choice'"
                  :model-value="isCorrect(option.id)"
                  @update:model-value="(value) => toggleCorrectOption(option.id, Boolean(value))"
                />
                <el-radio
                  v-else
                  :model-value="isCorrect(option.id) ? option.id : ''"
                  :value="option.id"
                  @update:model-value="toggleCorrectOption(option.id, true)"
                >
                  <span class="qs__option-id">{{ option.id }}</span>
                </el-radio>
                <el-input
                  v-model="option.text"
                  :maxlength="MAX_OPTION_TEXT_CHARS"
                  :placeholder="`选项 ${option.id}`"
                  :disabled="form.type === 'true_false'"
                  class="qs__option-input"
                />
                <el-button
                  v-if="form.type === 'multiple_choice'"
                  text
                  type="danger"
                  :disabled="form.options.length <= 3"
                  @click="removeOption(optionIndex)"
                >
                  删除
                </el-button>
              </div>
              <el-button v-if="form.type === 'multiple_choice'" text type="primary" @click="addOption">
                添加选项
              </el-button>
            </div>
          </el-form-item>
        </template>

        <template v-else>
          <el-form-item label="空位与可接受答案（一行一个答案）" :error="dialogFieldErrors.blanks">
            <div class="qs__blanks">
              <div v-for="(blank, blankIndex) in form.answerDefinition.blanks" :key="blank.id" class="qs__blank">
                <div class="qs__blank-head">
                  <span class="qs__option-id">第 {{ blankIndex + 1 }} 空（{{ blank.id }}）</span>
                  <el-button
                    text
                    type="danger"
                    :disabled="form.answerDefinition.blanks.length <= 1"
                    @click="removeBlank(blankIndex)"
                  >
                    删除此空
                  </el-button>
                </div>
                <el-input
                  :model-value="blankAnswersText(blank)"
                  type="textarea"
                  :rows="2"
                  placeholder="例如：<br>应急照明"
                  @update:model-value="(value) => setBlankAnswers(blank, String(value))"
                />
                <label class="qs__case">
                  <el-switch v-model="blank.caseSensitive" />
                  <span>区分大小写{{ blank.caseSensitive ? '' : '（不区分）' }}</span>
                </label>
              </div>
              <el-button text type="primary" @click="addBlank">添加空位</el-button>
            </div>
          </el-form-item>
        </template>

        <el-form-item label="解析" :error="dialogFieldErrors.explanation">
          <el-input
            v-model="form.explanation"
            type="textarea"
            :rows="2"
            :maxlength="MAX_EXPLANATION_CHARS"
            show-word-limit
          />
        </el-form-item>

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

.qs__stem {
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.qs__answer {
  margin: 4px 0 0;
  font-size: 13px;
  word-break: break-word;
}

.qs__item-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: flex-start;
}

.qs__type-select {
  width: 200px;
}

.qs__options,
.qs__blanks,
.qs__refs {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}

.qs__option {
  display: flex;
  align-items: center;
  gap: 8px;
}

.qs__option-id {
  font-family: var(--zj-mono);
  font-size: 14px;
}

.qs__option-input {
  flex: 1;
}

.qs__blank {
  border: 1px solid var(--zj-border);
  border-radius: var(--zj-radius);
  padding: 10px 12px;
}

.qs__blank-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.qs__case {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  font-size: 14px;
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
