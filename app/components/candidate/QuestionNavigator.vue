<script setup lang="ts">
/** 题号面板（契约 §10.2）：当前 / 已答 / 未答三态，窄屏由父级放进抽屉 */
import type { AnswerMap, CandidateQuestion } from '#shared/types'

interface Props {
  questions: CandidateQuestion[]
  answers: AnswerMap
  currentIndex: number
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), { disabled: false })
const emit = defineEmits<{ select: [index: number] }>()

function statusOf(index: number): 'current' | 'answered' | 'unanswered' {
  const question = props.questions[index]
  if (!question) return 'unanswered'
  if (index === props.currentIndex) return 'current'
  return isAnswerEmpty(props.answers[question.id] ?? null) ? 'unanswered' : 'answered'
}
</script>

<template>
  <nav class="q-nav" aria-label="题目导航">
    <p class="q-nav__title">题目导航</p>
    <div class="q-nav__grid">
      <button
        v-for="(question, index) in questions"
        :key="question.id"
        type="button"
        class="q-nav__item"
        :class="[`q-nav__item--${statusOf(index)}`]"
        :aria-current="index === currentIndex ? 'true' : undefined"
        :aria-label="`第 ${index + 1} 题${statusOf(index) === 'answered' ? '，已答' : '，未答'}`"
        :disabled="disabled"
        @click="emit('select', index)"
      >
        {{ index + 1 }}
      </button>
    </div>
    <ul class="q-nav__legend">
      <li><span class="q-nav__dot q-nav__dot--current" />当前</li>
      <li><span class="q-nav__dot q-nav__dot--answered" />已答</li>
      <li><span class="q-nav__dot q-nav__dot--unanswered" />未答</li>
    </ul>
  </nav>
</template>

<style scoped>
.q-nav {
  background: var(--zj-surface);
  border: 1px solid var(--zj-border);
  border-radius: var(--zj-radius);
  padding: 16px;
}

.q-nav__title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 500;
}

.q-nav__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
  gap: 8px;
}

.q-nav__item {
  min-height: 40px;
  font: inherit;
  font-size: 14px;
  border-radius: 8px;
  border: 1px solid var(--zj-border);
  background: var(--zj-surface);
  cursor: pointer;
  transition: background-color 150ms cubic-bezier(0.22, 1, 0.36, 1),
    border-color 150ms cubic-bezier(0.22, 1, 0.36, 1);
}

.q-nav__item:hover:not(:disabled) {
  border-color: var(--zj-primary);
}

.q-nav__item--current {
  border-color: var(--zj-primary);
  box-shadow: 0 0 0 2px var(--zj-primary-weak);
  font-weight: 500;
}

.q-nav__item--answered {
  background: var(--zj-primary-weak);
  border-color: var(--zj-primary);
  color: var(--zj-primary);
}

.q-nav__item--unanswered {
  color: var(--zj-text-muted);
}

.q-nav__item:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.q-nav__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
  color: var(--zj-text-muted);
}

.q-nav__legend li {
  display: flex;
  align-items: center;
  gap: 8px;
}

.q-nav__dot {
  width: 12px;
  height: 12px;
  border-radius: 4px;
  border: 1px solid var(--zj-border);
  display: inline-block;
}

.q-nav__dot--current {
  border-color: var(--zj-primary);
  box-shadow: 0 0 0 2px var(--zj-primary-weak);
}

.q-nav__dot--answered {
  background: var(--zj-primary-weak);
  border-color: var(--zj-primary);
}

.q-nav__dot--unanswered {
  background: var(--zj-surface);
}
</style>
