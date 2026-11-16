<script setup lang="ts">
import type { QuestionContentInput } from '#shared/types'

const props = withDefaults(
  defineProps<{
    question: QuestionContentInput
    /** 列表场景下标记正确选项；编辑器内不标记 */
    highlightCorrect?: boolean
  }>(),
  { highlightCorrect: false },
)

const correctOptionIds = computed(() => new Set(props.question.answerDefinition.correctOptionIds))
const blanks = computed(() => props.question.answerDefinition.blanks)

function isCorrectOption(optionId: string): boolean {
  return correctOptionIds.value.has(optionId)
}
</script>

<template>
  <div class="question-view">
    <div class="question-view__head">
      <el-tag size="small" effect="plain">{{ QUESTION_TYPE_LABELS[question.type] }}</el-tag>
      <span v-if="question.type === 'fill_blank'" class="zj-muted">共 {{ blanks.length }} 空</span>
      <span v-else-if="question.type !== 'true_false'" class="zj-muted">共 {{ question.options.length }} 个选项</span>
    </div>

    <p class="question-view__stem">{{ formatQuestionStem(question.stem, question.type) }}</p>

    <ul v-if="question.type !== 'fill_blank'" class="question-view__options">
      <li
        v-for="option in question.options"
        :key="option.id"
        :class="{ 'is-correct': highlightCorrect && isCorrectOption(option.id) }"
      >
        <strong v-if="question.type !== 'true_false'">{{ option.id }}.</strong>
        <span>{{ option.text || '（空）' }}</span>
        <el-tag
          v-if="highlightCorrect && isCorrectOption(option.id)"
          size="small"
          type="success"
          effect="plain"
          class="question-view__mark"
        >
          正确项
        </el-tag>
      </li>
    </ul>
    <p v-else-if="question.options.length > 0" class="zj-muted question-view__options-hint">
      填空空位：{{ question.options.map((option) => option.id).join('、') }}
    </p>

    <p>
      <strong>正确答案：</strong>
      {{ describeCorrectAnswer(question.type, question.options, question.answerDefinition.correctOptionIds, blanks) }}
    </p>

    <ul v-if="question.type === 'fill_blank' && blanks.length > 0" class="question-view__blanks">
      <li v-for="(blank, index) in blanks" :key="blank.id">
        <span>
          第 {{ index + 1 }} 空：{{ blank.acceptedAnswers.length > 0 ? blank.acceptedAnswers.join(' / ') : '未设置答案' }}
        </span>
        <span class="zj-muted">（{{ blank.caseSensitive ? '区分大小写' : '不区分大小写' }}）</span>
      </li>
    </ul>

    <p><strong>解析：</strong>{{ question.explanation || '—' }}</p>
  </div>
</template>

<style scoped>
.question-view { line-height: 1.7; overflow-wrap: anywhere; }
.question-view p { white-space: pre-wrap; margin: 10px 0; }
.question-view__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.question-view__stem { font-size: 17px; font-weight: 600; }
.question-view ul { padding-left: 22px; margin: 0; }
.question-view__options li { padding: 2px 6px; border-radius: 4px; }
.question-view__options li.is-correct { background: var(--el-color-success-light-9); }
.question-view__mark { margin-left: 8px; }
.question-view__blanks li { list-style: none; }
.question-view__options-hint { padding-left: 0; }
</style>
