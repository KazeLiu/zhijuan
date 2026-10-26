<script setup lang="ts">
import type { QuestionContentInput, QuestionType } from '#shared/types'
import { MAX_BLANK_ANSWER_CHARS, MAX_STEM_CHARS, MAX_OPTION_TEXT_CHARS, MAX_EXPLANATION_CHARS } from '#shared/constants'
const props = withDefaults(defineProps<{ modelValue: QuestionContentInput; errors?: Record<string, string> }>(), { errors: () => ({}) })
const emit = defineEmits<{ 'update:modelValue': [value: QuestionContentInput] }>()
function update(patch: Partial<QuestionContentInput>) { emit('update:modelValue', { ...props.modelValue, ...patch }) }
function changeType(type: QuestionType) {
  const next = newQuestionContent(type)
  update({ type, options: next.options, answerDefinition: next.answerDefinition })
}
function optionText(index: number, text: string) {
  update({ options: props.modelValue.options.map((option, position) => position === index ? { ...option, text } : option) })
}
function select(id: string, checked: boolean) {
  const form = props.modelValue
  const ids = form.answerDefinition.correctOptionIds
  const selected = form.type === 'multiple_choice' ? checked ? [...new Set([...ids, id])] : ids.filter((value) => value !== id) : [id]
  update({ answerDefinition: { ...form.answerDefinition, correctOptionIds: selected } })
}
function updateBlank(index: number, patch: Partial<QuestionContentInput['answerDefinition']['blanks'][number]>) {
  update({ answerDefinition: { ...props.modelValue.answerDefinition,
    blanks: props.modelValue.answerDefinition.blanks.map((blank, position) => position === index ? { ...blank, ...patch } : blank) } })
}
function addBlank() {
  const blanks = props.modelValue.answerDefinition.blanks
  update({ answerDefinition: { correctOptionIds: [], blanks: [...blanks, { id: `b${blanks.length + 1}`, acceptedAnswers: [''], caseSensitive: true }] } })
}
function removeBlank(index: number) {
  update({ answerDefinition: { correctOptionIds: [], blanks: props.modelValue.answerDefinition.blanks.filter((_, position) => position !== index)
    .map((blank, position) => ({ ...blank, id: `b${position + 1}` })) } })
}
</script>

<template>
  <el-form-item label="题型">
    <el-select :model-value="modelValue.type" @update:model-value="changeType">
      <el-option v-for="(label, type) in QUESTION_TYPE_LABELS" :key="type" :label="label" :value="type" />
    </el-select>
  </el-form-item>
  <el-form-item label="题干" :error="errors.stem">
    <el-input :model-value="modelValue.stem" type="textarea" :rows="3" :maxlength="MAX_STEM_CHARS" show-word-limit
      @update:model-value="update({ stem: $event })" />
    <p v-if="modelValue.type === 'fill_blank'" class="content-fields__hint zj-muted">
      用 <code v-text="'{{b1}}'" />、<code v-text="'{{b2}}'" /> 对应下方空位；题面会显示为下划线。
    </p>
  </el-form-item>
  <el-form-item v-if="modelValue.type !== 'fill_blank'" :label="modelValue.type === 'multiple_choice' ? '选项（勾选 2–3 个正确答案）' : '选项（选中 1 个正确答案）'"
    :error="errors.options || errors.correct || errors.answerDefinition">
    <div class="content-fields__options">
      <div v-for="(option, index) in modelValue.options" :key="option.id" class="content-fields__option">
        <el-checkbox v-if="modelValue.type === 'multiple_choice'" :aria-label="`正确选项 ${option.id}`"
          :model-value="modelValue.answerDefinition.correctOptionIds.includes(option.id)" @update:model-value="select(option.id, Boolean($event))" />
        <el-radio v-else :model-value="modelValue.answerDefinition.correctOptionIds[0]" :value="option.id"
          @update:model-value="select(option.id, true)">{{ modelValue.type === 'true_false' ? option.text : option.id }}</el-radio>
        <el-input :model-value="option.text" :aria-label="`选项 ${option.id}`" :maxlength="MAX_OPTION_TEXT_CHARS"
          :disabled="modelValue.type === 'true_false'" @update:model-value="optionText(index, $event)" />
      </div>
    </div>
  </el-form-item>
  <el-form-item v-else label="空位与可接受答案（一行一个）" :error="errors.blanks || errors.answerDefinition">
    <div class="content-fields__options">
      <div v-for="(blank, index) in modelValue.answerDefinition.blanks" :key="blank.id" class="content-fields__blank">
        <div class="content-fields__blank-head"><strong>第 {{ index + 1 }} 空</strong>
          <el-button text type="danger" :disabled="modelValue.answerDefinition.blanks.length <= 1" @click="removeBlank(index)">删除此空</el-button></div>
        <el-input :model-value="blank.acceptedAnswers.join('\n')" type="textarea" :rows="2" :aria-label="`第 ${index + 1} 空可接受答案`"
          @update:model-value="updateBlank(index, { acceptedAnswers: $event.split('\n') })" />
        <el-checkbox :model-value="blank.caseSensitive" @update:model-value="updateBlank(index, { caseSensitive: Boolean($event) })">区分大小写</el-checkbox>
      </div>
      <el-button text type="primary" @click="addBlank">添加空位</el-button>
      <span class="zj-muted">每个可接受答案最多 {{ MAX_BLANK_ANSWER_CHARS }} 字。</span>
    </div>
  </el-form-item>
  <el-form-item label="解析" :error="errors.explanation">
    <el-input :model-value="modelValue.explanation" type="textarea" :rows="3" :maxlength="MAX_EXPLANATION_CHARS" show-word-limit
      @update:model-value="update({ explanation: $event })" />
  </el-form-item>
</template>

<style scoped>
.content-fields__options { width: 100%; display: grid; gap: 12px; }
.content-fields__option, .content-fields__blank-head { display: flex; align-items: center; gap: 12px; }
.content-fields__blank-head { justify-content: space-between; }
.content-fields__option .el-input { flex: 1; min-width: 0; }
.content-fields__blank { padding: 12px; border: 1px solid var(--zj-border); border-radius: var(--zj-radius); }
.content-fields__hint { margin: 6px 0 0; line-height: 1.6; }
</style>
