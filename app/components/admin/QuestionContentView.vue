<script setup lang="ts">
import type { QuestionContentInput } from '#shared/types'
defineProps<{ question: QuestionContentInput }>()
</script>
<template>
  <div class="question-view">
    <el-tag size="small" effect="plain">{{ QUESTION_TYPE_LABELS[question.type] }}</el-tag>
    <p class="question-view__stem">{{ formatQuestionStem(question.stem, question.type) }}</p>
    <ul v-if="question.type !== 'fill_blank'">
      <li v-for="option in question.options" :key="option.id">
        <strong v-if="question.type !== 'true_false'">{{ option.id }}.</strong> {{ option.text }}
      </li>
    </ul>
    <p><strong>正确答案：</strong>{{ describeCorrectAnswer(question.type, question.options, question.answerDefinition.correctOptionIds, question.answerDefinition.blanks) }}</p>
    <p v-for="(blank, index) in question.answerDefinition.blanks" :key="blank.id" class="zj-muted">
      第 {{ index + 1 }} 空：{{ blank.caseSensitive ? '区分大小写' : '不区分大小写' }}
    </p>
    <p><strong>解析：</strong>{{ question.explanation }}</p>
  </div>
</template>
<style scoped>
.question-view { line-height: 1.7; overflow-wrap: anywhere; }
.question-view p { white-space: pre-wrap; margin: 10px 0; }
.question-view__stem { font-size: 17px; font-weight: 600; }
.question-view ul { padding-left: 22px; }
</style>
