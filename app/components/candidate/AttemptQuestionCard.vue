<script setup lang="ts">
/**
 * 单题卡片（设计 §6.2、契约 §10.2）：
 * 选项单击只选中不跳题；切题由上一题/下一题或题号面板完成。
 */
import type { CandidateAnswer, CandidateQuestion } from '#shared/types'
import { MAX_BLANK_ANSWER_CHARS } from '#shared/constants'
import { Check, Close } from '@element-plus/icons-vue'

interface Props {
  question: CandidateQuestion
  index: number
  total: number
  modelValue: CandidateAnswer | null
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), { disabled: false })
const emit = defineEmits<{
  'update:modelValue': [answer: CandidateAnswer]
  change: [questionId: string, answer: CandidateAnswer]
}>()

const typeLabel = computed(() => (props.question.type ? QUESTION_TYPE_LABELS[props.question.type] : ''))
const selectedIds = computed<string[]>(() => {
  const value = props.modelValue
  if (!value || value.type === 'fill_blank') return []
  return value.selectedOptionIds
})

function emitAnswer(answer: CandidateAnswer): void {
  emit('update:modelValue', answer)
  emit('change', props.question.id, answer)
}

function optionSelected(optionId: string): boolean {
  return selectedIds.value.includes(optionId)
}

function toggleOption(optionId: string): void {
  if (props.disabled) return
  if (props.question.type === 'multiple_choice') {
    const next = optionSelected(optionId)
      ? selectedIds.value.filter((id) => id !== optionId)
      : [...selectedIds.value, optionId]
    next.sort()
    emitAnswer({ type: 'multiple_choice', selectedOptionIds: next })
    return
  }
  if (props.question.type === 'true_false') {
    emitAnswer({ type: 'true_false', selectedOptionIds: [optionId] })
    return
  }
  emitAnswer({ type: 'single_choice', selectedOptionIds: [optionId] })
}

function blankValue(blankId: string): string {
  const value = props.modelValue
  if (!value || value.type !== 'fill_blank') return ''
  return value.values[blankId] ?? ''
}

function updateBlank(blankId: string, next: string): void {
  if (props.disabled) return
  const values: Record<string, string> = {}
  if (props.modelValue?.type === 'fill_blank') {
    Object.assign(values, props.modelValue.values)
  }
  values[blankId] = next
  emitAnswer({ type: 'fill_blank', values })
}
</script>

<template>
  <article class="q-card" :class="{ 'q-card--disabled': disabled }">
    <header class="q-card__head">
      <div class="q-card__meta">
        <span class="q-card__position zj-tabular">第 {{ index + 1 }} / {{ total }} 题</span>
        <el-tag size="small" effect="plain" type="success">{{ typeLabel }}</el-tag>
        <el-tag v-if="question.multiple" size="small" effect="plain" type="warning">可多选</el-tag>
        <span class="q-card__score zj-muted">{{ formatScoreUnits(question.maxScoreUnits) }} 分</span>
      </div>
    </header>

    <h2 class="q-card__stem">{{ formatQuestionStem(question.stem, question.type) }}</h2>

    <div v-if="question.type === 'fill_blank'" class="q-card__blanks">
      <div v-for="(blank, blankIndex) in question.blanks" :key="blank.id" class="q-blank">
        <label class="q-blank__label" :for="`blank-${question.id}-${blank.id}`">
          第 {{ blankIndex + 1 }} 空
          <span class="q-blank__score zj-muted">（{{ formatScoreUnits(blank.maxScoreUnits) }} 分）</span>
        </label>
        <el-input
          :id="`blank-${question.id}-${blank.id}`"
          :model-value="blankValue(blank.id)"
          :maxlength="MAX_BLANK_ANSWER_CHARS"
          :disabled="disabled"
          size="large"
          show-word-limit
          placeholder="填写答案"
          @update:model-value="updateBlank(blank.id, $event)"
        />
      </div>
      <p class="q-card__hint zj-muted">
        每空最多 {{ MAX_BLANK_ANSWER_CHARS }} 字{{ question.caseSensitive ? '，区分大小写' : '，不区分大小写' }}。
      </p>
    </div>

    <ul v-else class="q-card__options">
      <li v-for="option in question.options" :key="option.id">
        <button
          type="button"
          class="q-option"
          :class="{ 'q-option--selected': optionSelected(option.id) }"
          :aria-pressed="optionSelected(option.id)"
          :disabled="disabled"
          @click="toggleOption(option.id)"
        >
          <span
            v-if="question.type === 'true_false'"
            class="q-option__mark q-option__mark--judgment"
            :class="{ 'q-option__mark--false': option.id === 'false' }"
            aria-hidden="true"
          >
            <Check v-if="option.id === 'true'" />
            <Close v-else />
          </span>
          <span v-else class="q-option__mark">{{ option.id }}</span>
          <span class="q-option__text">{{ option.text }}</span>
        </button>
      </li>
    </ul>

    <p v-if="question.type === 'multiple_choice'" class="q-card__hint zj-muted">
      多选题：少选、多选、错选均不得分，请选全正确选项。
    </p>
  </article>
</template>

<style scoped>
.q-card {
  background: #fff;
  border: 1px solid var(--zj-border);
  border-radius: var(--zj-radius);
  padding: clamp(18px, 3vw, 28px);
}

.q-card__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 14px;
}

.q-card__position {
  font-weight: 600;
}

.q-card__score {
  margin-left: auto;
}

.q-card__stem {
  margin: 16px 0 20px;
  font-size: clamp(18px, 2.2vw, 21px);
  line-height: 1.6;
  font-weight: 600;
  white-space: pre-wrap;
  word-break: break-word;
}

.q-card__options {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.q-option {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  min-height: 48px;
  padding: 12px 16px;
  text-align: left;
  font: inherit;
  font-size: 16px;
  color: var(--zj-text);
  background: #fff;
  border: 1.5px solid var(--zj-border);
  border-radius: var(--zj-radius);
  cursor: pointer;
  transition: border-color 150ms ease, background-color 150ms ease, transform 150ms ease;
}

.q-option:hover:not(:disabled) {
  border-color: var(--zj-primary);
  background: var(--zj-primary-weak);
}

.q-option:focus-visible {
  outline: 2px solid var(--zj-primary);
  outline-offset: 2px;
}

.q-option--selected {
  border-color: var(--zj-primary);
  background: var(--zj-primary-weak);
}

.q-option:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.q-option__mark {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  font-weight: 600;
  font-size: 14px;
  color: var(--zj-primary);
}

.q-option__text {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-word;
}

.q-option__mark--judgment {
  border: none;
}

.q-option__mark--judgment svg {
  width: 24px;
  height: 24px;
  stroke: currentColor;
  stroke-width: 1;
}

.q-option__mark--false {
  color: var(--zj-danger);
}

.q-card__blanks {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.q-blank__label {
  display: block;
  margin-bottom: 6px;
  font-size: 15px;
  font-weight: 600;
}

.q-blank__score {
  font-weight: 400;
}

.q-card__hint {
  margin: 16px 0 0;
  font-size: 14px;
}

.q-card--disabled .q-card__stem {
  color: var(--zj-text-muted);
}
</style>
